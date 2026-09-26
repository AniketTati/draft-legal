/**
 * collab-server.ts (Phase 10C — real-time collab).
 *
 * Runs a Hocuspocus (Yjs-backed) WebSocket server on a dedicated port
 * (default 3030). Clients connect at ws://localhost:3030 with the
 * document name `contract:<id>` and a JWT token in the connection
 * params for tenant isolation + cursor presence.
 *
 * Wave 2.4 (2026-07): the live Y.Doc is now PERSISTED via the Hocuspocus
 * Database extension into the `collab_states` table — concurrent edits survive
 * a server restart instead of evaporating from memory. The canonical HTML
 * version still saves via the editor's existing /html-version flow; this server
 * carries + durably stores the live collaborative ops.
 *
 * Auto-starts on import via startCollabServer().
 */
import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import { verifyToken } from './jwt.js'
import { prisma } from './prisma.js'
import { getPermissionsForRoles, evaluatePermission } from './permissions.js'

const PORT = Number(process.env.COLLAB_PORT ?? 3030)

let server: Server | null = null
/** Each open connection's watcher (X29 follow-up), keyed by its context. */
const stopWatching = new WeakMap<object, () => void>()

/** What a connection was admitted with; re-checked while it stays open (X29). */
export interface CollabContext {
  user:       { id: string; orgId: string }
  roles:      string[]
  contractId: string
  /** The access token's expiry (seconds since epoch). */
  exp:        number
  readOnly:   boolean
  checkedAt:  number
}

/** How often an open connection's rights are re-checked against the database. */
const RECHECK_MS = 60_000

/** view / edit rights on the contract as REST decides them, or null when it can't be opened. */
async function collabRights(user: { id: string; orgId: string }, roles: string[], contractId: string): Promise<{ edit: boolean } | null> {
  const [c, member] = await Promise.all([
    // Tenant check: the contract must live in the user's org.
    prisma.contract.findFirst({ where: { id: contractId, orgId: user.orgId, deletedAt: null }, select: { ownerId: true } }),
    // X29 — a deactivated or deleted user's token stays valid until it
    // expires; their document connection shouldn't.
    prisma.user.count({ where: { id: user.id, orgId: user.orgId, deletedAt: null, status: { not: 'DEACTIVATED' } } }),
  ])
  if (!c || !member) return null
  const permissions = await getPermissionsForRoles(user.orgId, roles)
  const reaches = (action: string) => {
    const r = evaluatePermission(permissions, action, 'contract')
    return r.granted && (r.scope !== 'own' || c.ownerId === user.id)
  }
  return reaches('view') ? { edit: reaches('edit') } : null
}

/**
 * Who may join a contract's live document. X21 — the org check alone let any
 * member join any contract's document, own-scope roles included; now it is
 * what REST decides: view:contract (own scope = the owner), and without
 * edit:contract the connection is read-only.
 */
export async function authenticateCollab({ token, documentName, connectionConfig }: {
  token: string
  documentName: string
  connectionConfig: { readOnly: boolean }
}): Promise<CollabContext> {
  if (!token) throw new Error('Missing token')
  let payload
  try { payload = verifyToken(token) }
  catch { throw new Error('Invalid token') }
  if (payload.type !== 'access') throw new Error('Wrong token type')

  const contractId = documentName.startsWith('contract:')
    ? documentName.slice('contract:'.length)
    : null
  if (!contractId) throw new Error('Bad document name')

  const user = { id: payload.sub, orgId: payload.orgId }
  const rights = await collabRights(user, payload.roles ?? [], contractId)
  if (!rights) throw new Error('Contract not found in your org')
  if (!rights.edit) connectionConfig.readOnly = true

  return {
    user, roles: payload.roles ?? [], contractId,
    exp: (payload as { exp?: number }).exp ?? 0,
    readOnly: connectionConfig.readOnly, checkedAt: Date.now(),
  }
}

/**
 * X29 — before each message on an open connection. Admission was checked once
 * per socket, and a socket outlives the token it opened with: after the token
 * expired, the user was deactivated, the contract was deleted or reassigned,
 * or edit rights were taken away, the connection kept its rights. The token's
 * expiry is checked on every message and the rest at most once a minute; a
 * change closes the connection, and the client's reconnect is judged afresh.
 */
export async function checkCollabMessage(context: CollabContext, now = Date.now()): Promise<void> {
  const closed = (reason: string) => Object.assign(new Error(reason), { code: 4403, reason })
  if (!context.exp || context.exp * 1000 <= now) throw closed('Session expired')
  if (now - context.checkedAt < RECHECK_MS) return
  const rights = await collabRights(context.user, context.roles, context.contractId)
  if (!rights) throw closed('Access revoked')
  if (!context.readOnly && !rights.edit) throw closed('Edit access revoked')
  context.checkedAt = now
}

/** How often an open connection is checked even when it sends nothing (X29 follow-up). */
const WATCH_MS = 15_000

/**
 * X29 follow-up — re-checks an open connection on a timer and calls `close`
 * once its rights lapse; returns a function that stops watching. Hocuspocus
 * sends every document update to every connection, so checking only when a
 * connection sends a message let a silent one (a custom client, or one
 * keeping its socket alive through another document) keep receiving edits
 * after its token expired or its access was revoked.
 */
export function watchCollabConnection(context: CollabContext, close: (reason: string) => void, every = WATCH_MS): () => void {
  const timer = setInterval(() => {
    checkCollabMessage(context).catch((err: Error) => {
      clearInterval(timer)
      close(err.message)
    })
  }, every)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function startCollabServer(): Server {
  if (server) return server
  server = new Server({
    port: PORT,
    name: 'clm-collab',

    // Wave 2.4 — persist the Y.Doc to `collab_states` via v4's document hooks
    // (yjs binary encode/decode). onStoreDocument is debounced by Hocuspocus.
    // (The extension-database package isn't v4-compatible, so we use the hooks
    // directly.)
    async onLoadDocument({ documentName, document }) {
      const row = await prisma.collabState.findUnique({ where: { documentName } })
      if (row?.state) Y.applyUpdate(document, new Uint8Array(row.state))
      return document
    },
    async onStoreDocument({ documentName, document }) {
      const state = Buffer.from(Y.encodeStateAsUpdate(document))
      await prisma.collabState.upsert({
        where: { documentName },
        create: { documentName, state },
        update: { state },
      })
    },

    onAuthenticate: authenticateCollab,
    async beforeHandleMessage({ context }) {
      await checkCollabMessage(context as CollabContext)
    },
    async connected({ connection, context }) {
      stopWatching.set(context, watchCollabConnection(context as CollabContext, reason => connection.close({ code: 4403, reason })))
    },
    async onDisconnect({ context }) {
      stopWatching.get(context)?.()
      stopWatching.delete(context)
    },
  })

  server.listen()
    .then(() => console.info('[collab] Hocuspocus listening on :%d', PORT))
    .catch(err => console.error('[collab] failed to start:', err))

  return server
}
