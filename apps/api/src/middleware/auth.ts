import type { FastifyRequest, FastifyReply } from 'fastify'
import crypto from 'node:crypto'
import type { Permission } from '@clm/types'
import { verifyToken, type JwtPayload } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'
import { resolveApiScopePermissions } from '../lib/permissions.js'
import { keyMaker } from '../lib/acting-user.js'

declare module 'fastify' {
  interface FastifyRequest {
    // `apiPermissions` is set only on public-API-key requests (Wave 1.2):
    // the key's scopes resolved to a concrete permission set. When present,
    // requirePermission evaluates it directly instead of role lookup.
    // `keyMakerId` (X46) is the user behind such a key (lib/acting-user.ts).
    user: JwtPayload & { apiPermissions?: Permission[]; keyMakerId?: string }
  }
}

const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET

// API keys carry a `clm_` prefix so we can distinguish them from JWTs
// in the same Authorization: Bearer header.
const API_KEY_PREFIX = 'clm_'

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export { API_KEY_PREFIX }

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  // Allow internal service-to-service calls (agents → api).
  // Trusted callers can pass `x-org-id` to scope queries to a real
  // org (e.g. the draft agent fetching templates for the requesting
  // org's user). When absent, we fall back to the legacy 'system'
  // sentinel which most route handlers special-case.
  if (
    INTERNAL_SECRET &&
    req.headers['x-internal-service'] === 'agents' &&
    req.headers['x-internal-secret'] === INTERNAL_SECRET
  ) {
    const orgIdHeader = (req.headers['x-org-id'] as string | undefined)?.trim()
    req.user = {
      sub: 'system',
      orgId: orgIdHeader || 'system',
      roles: ['ADMIN'],
      type: 'access',
    } as any
    return
  }

  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return reply.status(401).send({
      type: 'https://httpstatuses.com/401',
      title: 'Unauthorized',
      status: 401,
      detail: 'Missing or invalid Authorization header',
    })
  }
  const token = header.slice(7)

  // ── API key path (P10A) ──
  // Public-API customers send their key in the same Authorization: Bearer
  // header. We disambiguate by the `clm_` prefix.
  if (token.startsWith(API_KEY_PREFIX)) {
    try {
      const keyHash = hashApiKey(token)
      const key = await prisma.apiKey.findUnique({
        where: { keyHash },
        select: { id: true, orgId: true, scopes: true, expiresAt: true, revokedAt: true, createdById: true },
      })
      if (!key || key.revokedAt) {
        return reply.status(401).send({ title: 'Unauthorized', detail: 'API key invalid or revoked', status: 401 })
      }
      if (key.expiresAt && key.expiresAt < new Date()) {
        return reply.status(401).send({ title: 'Unauthorized', detail: 'API key expired', status: 401 })
      }
      // X46 — a key works only while the user behind it could still make it:
      // an active member of the org who can manage its API keys. X43 revoked a
      // user's keys when they were deactivated, but not keys of users gone
      // before it, keys made through other keys, or a demoted maker's keys.
      // The holder is told no more than for a revoked key.
      const keyMakerId = await keyMaker(key.orgId, key.createdById)
      if (!keyMakerId) {
        req.log.info({ apiKeyId: key.id }, 'API key refused: no active member who can manage API keys behind it')
        return reply.status(401).send({ title: 'Unauthorized', detail: 'API key invalid or revoked', status: 401 })
      }
      // Best-effort lastUsedAt update.
      prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
        .catch(() => { /* ignore */ })

      // Wave 1.2 — resolve the key's scopes to concrete permissions. Empty
      // scopes → no permissions (previously this silently became org ADMIN).
      // Scope strings are NOT role names; they map via API_SCOPE_PERMISSIONS.
      req.user = {
        sub:   `apikey:${key.id}`,
        orgId: key.orgId,
        roles: [],
        type:  'access',
        apiPermissions: resolveApiScopePermissions(key.scopes),
        keyMakerId,
      }
      return
    } catch {
      return reply.status(401).send({ title: 'Unauthorized', detail: 'API key auth failed', status: 401 })
    }
  }

  // ── JWT path (existing) ──
  try {
    const payload = verifyToken(token)
    if (payload.type !== 'access') throw new Error('Not an access token')
    req.user = payload
  } catch {
    return reply.status(401).send({
      type: 'https://httpstatuses.com/401',
      title: 'Unauthorized',
      status: 401,
      detail: 'Token invalid or expired',
    })
  }
}

export function requireRole(...roles: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply)
    if (reply.sent) return

    const hasRole = roles.some((r) => req.user.roles.includes(r))
    if (!hasRole) {
      return reply.status(403).send({
        type: 'https://httpstatuses.com/403',
        title: 'Forbidden',
        status: 403,
        detail: `Required role: ${roles.join(' or ')}`,
      })
    }
  }
}

// X44 — routes that check no permission, only that someone signed in. A
// public-API key passed them all, a scope-less legacy one included, because a
// key's scopes are evaluated only by requirePermission. Users and the agents
// service (neither carries key permissions) are unaffected by either guard.

/** An API key without the `admin` scope (which grants every permission). */
export function isLimitedApiKey(user: FastifyRequest['user'] | undefined): boolean {
  const keyPermissions = user?.apiPermissions
  return !!keyPermissions && !keyPermissions.some(p => p.action === '*' && p.resource === '*')
}

function refuseKey(reply: FastifyReply, detail: string) {
  return reply.status(403).send({ type: 'https://httpstatuses.com/403', title: 'Forbidden', status: 403, detail })
}

/**
 * A person's own things — their profile, password, notifications, agent
 * threads. No API key has a person behind it here (it authenticates as
 * `apikey:<id>`), so every key is refused, the admin scope included.
 */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply)
  if (reply.sent) return
  if (req.user?.apiPermissions) return refuseKey(reply, 'This endpoint is for signed-in users, not API keys')
}

/**
 * The org's shared data that any member may read — the member list, the org's
 * settings, roles, skills, the dashboard, team workload, the model list. An
 * API key may read it only with the `admin` scope.
 */
export async function requireUserOrAdminKey(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply)
  if (reply.sent) return
  if (isLimitedApiKey(req.user)) return refuseKey(reply, 'This endpoint is not available to API keys without the admin scope')
}
