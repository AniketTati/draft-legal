/**
 * Salesforce integration routes — docs/41 Part 17 (S1, S2, and S3's embed).
 *
 * Admin (signed-in admins, configure:organization), at /api/v1/admin/integrations/salesforce:
 *   GET    /                         — connection status (never a token)
 *   POST   /connect                  — start the OAuth flow; returns the Salesforce URL to open
 *   DELETE /                         — disconnect (tokens revoked and wiped)
 *   PATCH  /settings                 — which contract types reps may generate at once
 *   GET    /objects                  — Salesforce objects for the mapping editor (describe)
 *   GET    /objects/:name/fields     — an object's fields (describe)
 *   GET    /targets                  — draftLegal fields a mapping can point at
 *   GET    /mappings  PUT /mappings  — the field map (replaced as a whole)
 *   GET    /sync-log                 — recent sync attempts
 *   POST   /sync-log/:id/retry       — sync that contract again now
 *   POST   /sync-now                 — compare every linked contract now (as the nightly run does)
 *   GET    /conflicts                — Salesforce changes waiting on someone
 *
 * Contract owners, at /api/v1/contracts:
 *   GET    /:id/integration-conflicts                 — changes waiting on this contract
 *   POST   /:id/integration-conflicts/:cid/resolve    — apply or dismiss one
 *
 * Salesforce (an API key with the `salesforce` scope, plus the header
 * `X-Salesforce-Org-Id` matching the connected org), at /api/v1/integrations/salesforce:
 *   GET    /oauth/callback           — public: Salesforce's redirect back (signed state)
 *   GET    /launch-form              — the field map for the native "New contract" form (?all=1: every mapped field)
 *   POST   /requests                 — create a request from an Opportunity / Quote / Account
 *   POST   /changes                  — a mapped record changed (record-triggered Flow)
 *   GET    /contracts/:id/status     — what the status component shows
 *   POST   /embed-token              — a short-lived link to the read-only document preview
 *
 * Public, at /api/v1/embed:
 *   GET    /contracts/:id?token=     — the document preview's data, by embed token only
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { AuditAction, coreField } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { redis } from '../lib/redis.js'
import { encrypt } from '../lib/encryption.js'
import { createAuditEvent } from '../lib/audit.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { requireUser } from '../middleware/auth.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'
import { withoutTenantGuard } from '../lib/tenant-context.js'
import { signToken, verifyToken, pkcePair, type SignedClaims } from '../lib/integrations/signed-token.js'
import { getConnection, connectionTokens, publicConnection } from '../lib/integrations/connection.js'
import { isValidDlField, mappingTargets, mappingsForType, dlFieldType, REQUEST_PRIORITIES } from '../lib/integrations/mapping.js'
import { enqueueContractSync, enqueueReconcile } from '../lib/integrations/sync-queue.js'
import { signEmbedToken, verifyEmbedToken, embedUrl, EMBED_TTL_SECONDS } from '../lib/integrations/embed.js'
import {
  authorizeUrl, exchangeCode, revokeToken, orgIdFromIdentityUrl, normaliseLoginUrl, salesforceAppConfig,
  sameSalesforceId, DEFAULT_LOGIN_URL, SANDBOX_LOGIN_URL,
} from '../lib/salesforce/oauth.js'
import { clientFor, statusFacts } from '../lib/salesforce/sync.js'
import { contractSyncPayload, STAGES, contractLink } from '../lib/salesforce/payload.js'
import {
  InboundRequestSchema, InboundChangeSchema, createRequestFromSalesforce, applySalesforceChange, resolveConflict,
} from '../lib/salesforce/inbound.js'

const STATE_TTL_S = 10 * 60
const verifierKey = (nonce: string) => `salesforce-oauth:${nonce}`
const appBase = () => (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')

const forbidden = (reply: FastifyReply, detail: string) =>
  reply.status(403).send({ type: 'https://httpstatuses.com/403', title: 'Forbidden', status: 403, detail })
const invalid = (reply: FastifyReply, err: unknown) =>
  reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })

const DEFAULT_SELF_SERVE = ['NDA']

function selfServeTypes(config: unknown): string[] {
  const v = (config as { selfServeTypes?: unknown } | null)?.selfServeTypes
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : DEFAULT_SELF_SERVE
}

// ─── Admin ────────────────────────────────────────────────────────────────────

const MappingSchema = z.object({
  contractType:   z.string().min(1).max(64).nullable().optional(),
  externalObject: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, 'Salesforce object API name'),
  externalField:  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}(\.[A-Za-z][A-Za-z0-9_]{0,79}){0,2}$/, 'Salesforce field API name'),
  dlField:        z.string().min(1).max(80).refine(isValidDlField, 'Not a draftLegal field: pick one from the list, or var:<name> for a template variable'),
  direction:      z.enum(['inbound', 'outbound', 'both']),
  locked:         z.boolean().optional(),
})
const MappingsSchema = z.object({ mappings: z.array(MappingSchema).max(300) })

export async function salesforceAdminRoutes(app: FastifyInstance) {
  const admin = requirePermission('configure', 'organization')

  app.get('/', { preHandler: admin }, async (req, reply) => {
    const conn = await getConnection(req.user.orgId, 'salesforce')
    const cfg = salesforceAppConfig()
    return reply.send({
      ...publicConnection(conn),
      appConfigured: !!cfg,
      callbackUrl: cfg?.redirectUri ?? null,
      selfServeTypes: selfServeTypes(conn?.config),
      loginUrls: { production: DEFAULT_LOGIN_URL, sandbox: SANDBOX_LOGIN_URL },
    })
  })

  // Connecting binds the org to a Salesforce org with a standing token: only
  // a signed-in admin, never a key (as API keys themselves, X46).
  app.post('/connect', { preHandler: [requireUser, admin] }, async (req, reply) => {
    const cfg = salesforceAppConfig()
    if (!cfg) return reply.status(503).send({ detail: 'Salesforce is not set up on this server yet (SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET).' })
    let body
    try { body = z.object({ loginUrl: z.string().max(200).optional(), sandbox: z.boolean().optional() }).parse(req.body ?? {}) }
    catch (err) { return invalid(reply, err) }
    const loginUrl = normaliseLoginUrl(body.loginUrl ?? (body.sandbox ? SANDBOX_LOGIN_URL : DEFAULT_LOGIN_URL))
    if (!loginUrl) return reply.status(400).send({ detail: 'Use login.salesforce.com, test.salesforce.com or your My Domain (https://<name>.my.salesforce.com).' })

    const nonce = crypto.randomBytes(16).toString('base64url')
    const { verifier, challenge } = pkcePair()
    await redis.set(verifierKey(nonce), verifier, 'EX', STATE_TTL_S)
    const state = signToken('salesforce-oauth-state', { o: req.user.orgId, u: req.user.sub, n: nonce, l: loginUrl }, STATE_TTL_S)
    return reply.send({ url: authorizeUrl({ loginUrl, clientId: cfg.clientId, redirectUri: cfg.redirectUri, state, codeChallenge: challenge }) })
  })

  app.delete('/', { preHandler: [requireUser, admin] }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const conn = await getConnection(orgId, 'salesforce')
    if (!conn) return reply.status(404).send({ detail: 'Salesforce is not connected' })
    try {
      const { refreshToken } = connectionTokens(conn)
      if (refreshToken) await revokeToken(conn.loginUrl ?? DEFAULT_LOGIN_URL, refreshToken)
    } catch { /* the key changed or Salesforce is down: wiping our copy is what matters */ }
    await prisma.integrationConnection.updateMany({
      where: { id: conn.id, orgId },
      data: { status: 'disconnected', encryptedAccessToken: null, encryptedRefreshToken: null, tokenExpiresAt: null },
    })
    await createAuditEvent({ orgId, userId, action: AuditAction.INTEGRATION_DISCONNECTED, resourceType: 'integration', resourceId: conn.id, metadata: { provider: 'salesforce', salesforceOrgId: conn.externalOrgId }, ipAddress: req.ip })
    return reply.status(204).send()
  })

  app.patch('/settings', { preHandler: admin }, async (req, reply) => {
    let body
    try { body = z.object({ selfServeTypes: z.array(z.string().min(1).max(64)).max(50) }).parse(req.body) }
    catch (err) { return invalid(reply, err) }
    const conn = await getConnection(req.user.orgId, 'salesforce')
    if (!conn) return reply.status(404).send({ detail: 'Connect Salesforce first' })
    await prisma.integrationConnection.updateMany({
      where: { id: conn.id, orgId: req.user.orgId },
      data: { config: { ...((conn.config ?? {}) as Record<string, unknown>), selfServeTypes: body.selfServeTypes } as Prisma.InputJsonValue },
    })
    return reply.send({ ok: true })
  })

  // Describe calls go to Salesforce with the org's token.
  async function liveClient(req: FastifyRequest, reply: FastifyReply) {
    const conn = await getConnection(req.user.orgId, 'salesforce')
    if (!conn || !['connected', 'error'].includes(conn.status)) {
      reply.status(409).send({ detail: 'Connect Salesforce first' })
      return null
    }
    return clientFor(conn)
  }

  app.get('/objects', { preHandler: admin }, async (req, reply) => {
    const client = await liveClient(req, reply)
    if (!client) return
    try {
      const all = await client.describeGlobal()
      // The objects a contract starts from, ours, and custom objects.
      const useful = new Set(['Opportunity', 'Quote', 'Account', 'Contact', 'SBQQ__Quote__c', 'DL_Contract__c', 'DL_Request__c'])
      return reply.send({ data: all.filter(o => o.queryable && (useful.has(o.name) || o.custom)).map(o => ({ name: o.name, label: o.label, custom: o.custom })) })
    } catch (err) {
      return reply.status(502).send({ detail: `Salesforce: ${(err as Error).message}` })
    }
  })

  app.get('/objects/:name/fields', { preHandler: admin }, async (req, reply) => {
    const { name } = req.params as { name: string }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) return reply.status(400).send({ detail: 'Not a Salesforce object name' })
    const client = await liveClient(req, reply)
    if (!client) return
    try {
      const d = await client.describe(name)
      return reply.send({
        object: d.name, label: d.label,
        data: d.fields.map(f => ({
          name: f.name, label: f.label, type: f.type, updateable: f.updateable, custom: f.custom,
          referenceTo: f.referenceTo ?? [], picklistValues: (f.picklistValues ?? []).filter(p => p.active).map(p => p.value),
        })),
      })
    } catch (err) {
      return reply.status(502).send({ detail: `Salesforce: ${(err as Error).message}` })
    }
  })

  app.get('/targets', { preHandler: admin }, async (_req, reply) => reply.send({ data: mappingTargets() }))

  app.get('/mappings', { preHandler: admin }, async (req, reply) => {
    const data = await prisma.integrationFieldMapping.findMany({
      where: { orgId: req.user.orgId, provider: 'salesforce' },
      orderBy: [{ contractType: 'asc' }, { externalObject: 'asc' }, { externalField: 'asc' }],
    })
    return reply.send({ data })
  })

  app.put('/mappings', { preHandler: admin }, async (req, reply) => {
    let body
    try { body = MappingsSchema.parse(req.body) }
    catch (err) { return invalid(reply, err) }
    const { orgId, sub: userId } = req.user
    // One draftLegal field takes one Salesforce field per type and direction:
    // two would leave which one wins to chance.
    const seen = new Set<string>()
    for (const m of body.mappings) {
      const key = `${m.contractType ?? '*'}|${m.dlField}|${m.direction === 'outbound' ? 'out' : 'in'}`
      if (seen.has(key)) return reply.status(400).send({ detail: `${m.dlField} is mapped twice${m.contractType ? ` for ${m.contractType}` : ''}.` })
      seen.add(key)
    }
    await prisma.$transaction([
      prisma.integrationFieldMapping.deleteMany({ where: { orgId, provider: 'salesforce' } }),
      prisma.integrationFieldMapping.createMany({
        data: body.mappings.map(m => ({ orgId, provider: 'salesforce', contractType: m.contractType ?? null, externalObject: m.externalObject, externalField: m.externalField, dlField: m.dlField, direction: m.direction, locked: m.locked ?? false })),
      }),
    ])
    await createAuditEvent({ orgId, userId, action: AuditAction.INTEGRATION_MAPPING_CHANGED, resourceType: 'integration', resourceId: 'salesforce', metadata: { count: body.mappings.length }, ipAddress: req.ip })
    return reply.send({ ok: true, count: body.mappings.length })
  })

  app.get('/sync-log', { preHandler: admin }, async (req, reply) => {
    let q
    try { q = z.object({ status: z.enum(['success', 'failed', 'skipped', 'conflict', 'queued']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query) }
    catch (err) { return invalid(reply, err) }
    const data = await prisma.integrationSyncLog.findMany({
      where: { orgId: req.user.orgId, provider: 'salesforce', ...(q.status ? { status: q.status } : {}) },
      orderBy: { at: 'desc' }, take: q.limit,
      select: { id: true, direction: true, object: true, externalId: true, contractId: true, requestId: true, event: true, status: true, error: true, attempt: true, at: true },
    })
    return reply.send({ data })
  })

  app.post('/sync-log/:id/retry', { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const row = await prisma.integrationSyncLog.findFirst({ where: { id, orgId, provider: 'salesforce' }, select: { contractId: true, direction: true } })
    if (!row) return reply.status(404).send({ detail: 'Sync not found' })
    if (row.direction !== 'outbound' || !row.contractId) return reply.status(400).send({ detail: 'Only a sync to Salesforce can be retried here' })
    const conn = await getConnection(orgId, 'salesforce')
    if (!conn || !['connected', 'error'].includes(conn.status)) return reply.status(409).send({ detail: 'Connect Salesforce first' })
    await enqueueContractSync(orgId, row.contractId, 'retry')
    return reply.send({ ok: true, message: 'Retry queued' })
  })

  app.post('/sync-now', { preHandler: admin }, async (req, reply) => {
    const conn = await getConnection(req.user.orgId, 'salesforce')
    if (!conn || !['connected', 'error'].includes(conn.status)) return reply.status(409).send({ detail: 'Connect Salesforce first' })
    await enqueueReconcile(req.user.orgId)
    return reply.send({ ok: true, message: 'Sync queued' })
  })

  app.get('/conflicts', { preHandler: admin }, async (req, reply) => {
    const data = await prisma.integrationConflict.findMany({
      where: { orgId: req.user.orgId, provider: 'salesforce', status: 'open' },
      orderBy: { createdAt: 'desc' }, take: 100,
    })
    const titles = new Map((await prisma.contract.findMany({
      where: { orgId: req.user.orgId, id: { in: data.map(d => d.contractId) } }, select: { id: true, title: true },
    })).map(c => [c.id, c.title]))
    return reply.send({ data: data.map(d => ({ ...d, contractTitle: titles.get(d.contractId) ?? null, label: coreField(d.dlField)?.label ?? d.dlField })) })
  })

  app.post('/conflicts/:id/resolve', { preHandler: [requireUser, admin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    let body
    try { body = z.object({ action: z.enum(['apply', 'dismiss']) }).parse(req.body) }
    catch (err) { return invalid(reply, err) }
    const r = await resolveConflict({ orgId: req.user.orgId, conflictId: id, userId: req.user.sub, action: body.action, ipAddress: req.ip })
    return r.ok ? reply.send({ ok: true }) : reply.status(r.status).send({ detail: r.detail })
  })
}

// ─── A contract's own conflicts (its owner decides) ───────────────────────────

export async function contractIntegrationConflictRoutes(app: FastifyInstance) {
  /** The contract, when the caller may act on it (own scope: only their own). */
  async function reachable(req: FastifyRequest, contractId: string, action: 'view' | 'edit') {
    const scope = await permissionScopeFor(req, action, 'contract')
    return prisma.contract.findFirst({
      where: { id: contractId, orgId: req.user.orgId, deletedAt: null, ...(scope === 'own' ? { ownerId: req.user.sub } : {}) },
      select: { id: true },
    })
  }

  app.get('/:id/integration-conflicts', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!await reachable(req, id, 'view')) return reply.status(404).send({ detail: 'Contract not found' })
    const data = await prisma.integrationConflict.findMany({ where: { orgId: req.user.orgId, contractId: id, status: 'open' }, orderBy: { createdAt: 'desc' } })
    return reply.send({ data: data.map(d => ({ ...d, label: coreField(d.dlField)?.label ?? d.dlField })) })
  })

  app.post('/:id/integration-conflicts/:conflictId/resolve', { preHandler: [requireUser, requirePermission('edit', 'contract')] }, async (req, reply) => {
    const { id, conflictId } = req.params as { id: string; conflictId: string }
    let body
    try { body = z.object({ action: z.enum(['apply', 'dismiss']) }).parse(req.body) }
    catch (err) { return invalid(reply, err) }
    if (!await reachable(req, id, 'edit')) return reply.status(404).send({ detail: 'Contract not found' })
    const k = await prisma.integrationConflict.findFirst({ where: { id: conflictId, orgId: req.user.orgId, contractId: id }, select: { id: true } })
    if (!k) return reply.status(404).send({ detail: 'Conflict not found' })
    const r = await resolveConflict({ orgId: req.user.orgId, conflictId, userId: req.user.sub, action: body.action, ipAddress: req.ip })
    return r.ok ? reply.send({ ok: true }) : reply.status(r.status).send({ detail: r.detail })
  })
}

// ─── Salesforce → draftLegal ──────────────────────────────────────────────────

/**
 * Calls from Salesforce: an API key holding the `salesforce` scope (or
 * `admin`), from the Salesforce org this org connected — the header
 * `X-Salesforce-Org-Id` must name it. A key leaked to another Salesforce org,
 * or a connected org calling with another org's key, is refused.
 */
async function salesforceCaller(req: FastifyRequest, reply: FastifyReply) {
  if (reply.sent) return
  const keyId = req.user.sub.startsWith('apikey:') ? req.user.sub.slice('apikey:'.length) : null
  if (!keyId) return forbidden(reply, 'This endpoint is for Salesforce, through an API key with the salesforce scope')
  const key = await prisma.apiKey.findFirst({ where: { id: keyId, orgId: req.user.orgId }, select: { scopes: true } })
  if (!key || !(key.scopes.includes('salesforce') || key.scopes.includes('admin'))) {
    return forbidden(reply, 'This API key lacks the salesforce scope')
  }
  const conn = await getConnection(req.user.orgId, 'salesforce')
  if (!conn || !['connected', 'error'].includes(conn.status) || !conn.externalOrgId) {
    return reply.status(409).send({ detail: 'Salesforce is not connected to this draftLegal workspace' })
  }
  const claimed = req.headers['x-salesforce-org-id']
  if (typeof claimed !== 'string' || !sameSalesforceId(claimed, conn.externalOrgId)) {
    req.log.warn({ orgId: req.user.orgId }, 'Salesforce call refused: org id does not match the connected org')
    return forbidden(reply, 'This Salesforce org is not the one connected to this workspace')
  }
}

export async function salesforcePublicRoutes(app: FastifyInstance) {
  // ── OAuth callback (public; authorised by the signed state) ──
  app.get('/oauth/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string }
    const back = (params: Record<string, string>) =>
      reply.redirect(`${appBase()}/admin/integrations?${new URLSearchParams({ tab: 'salesforce', ...params })}`)
    const claims = verifyToken<SignedClaims & { o: string; u: string; n: string; l: string }>('salesforce-oauth-state', q.state)
    if (!claims) return back({ error: 'The sign-in link expired or was changed. Start again from Connect.' })
    // One use only: the verifier goes with the first callback that claims it.
    const verifier = await redis.getdel(verifierKey(claims.n))
    if (!verifier) return back({ error: 'This sign-in was already used. Start again from Connect.' })
    if (q.error || !q.code) return back({ error: q.error_description ?? q.error ?? 'Salesforce did not grant access' })

    const cfg = salesforceAppConfig()
    if (!cfg) return back({ error: 'Salesforce is not set up on this server.' })
    let token
    try {
      token = await exchangeCode({ loginUrl: claims.l, code: q.code, verifier, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri })
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'Salesforce code exchange failed')
      return back({ error: 'Salesforce refused the sign-in. Try again.' })
    }
    const sfOrgId = orgIdFromIdentityUrl(token.id)
    if (!sfOrgId || !token.refresh_token) return back({ error: 'Salesforce did not return an org id and a refresh token. Check the connected app allows refresh tokens.' })

    // One Salesforce org connects to one draftLegal workspace (docs/41 Part 17).
    // Deliberately across orgs; the answer names no other workspace.
    const taken = await withoutTenantGuard(() => prisma.integrationConnection.findFirst({
      where: { provider: 'salesforce', externalOrgId: sfOrgId, status: { in: ['connected', 'error'] }, orgId: { not: claims.o } },
      select: { id: true },
    }))
    if (taken) return back({ error: 'That Salesforce org is already connected to another draftLegal workspace.' })

    const data = {
      status: 'connected', externalOrgId: sfOrgId, instanceUrl: token.instance_url, loginUrl: claims.l,
      encryptedAccessToken: encrypt(token.access_token), encryptedRefreshToken: encrypt(token.refresh_token),
      connectedById: claims.u, connectedAt: new Date(), lastError: null,
    }
    const conn = await withoutTenantGuard(() => prisma.integrationConnection.upsert({
      where: { orgId_provider: { orgId: claims.o, provider: 'salesforce' } },
      create: { orgId: claims.o, provider: 'salesforce', config: { selfServeTypes: DEFAULT_SELF_SERVE }, ...data },
      update: data,
      select: { id: true },
    }))
    await createAuditEvent({ orgId: claims.o, userId: claims.u, action: AuditAction.INTEGRATION_CONNECTED, resourceType: 'integration', resourceId: conn.id, metadata: { provider: 'salesforce', salesforceOrgId: sfOrgId, loginUrl: claims.l }, ipAddress: req.ip })
    return back({ connected: '1' })
  })

  const sf = (action: string, resource: string) => [requirePermission(action, resource), salesforceCaller]

  // ── The launch form: the field map for a contract type ──
  app.get('/launch-form', { preHandler: sf('create', 'request') }, async (req, reply) => {
    // `all=1`: every field Salesforce sends, whatever the type (for the
    // record-change Flow, which must send each mapped field it has).
    const { contractType, all: everyType } = req.query as { contractType?: string; all?: string }
    const { orgId } = req.user
    const conn = await getConnection(orgId, 'salesforce')
    const all = await prisma.integrationFieldMapping.findMany({ where: { orgId, provider: 'salesforce' } })
    // The types this org has templates for, and the self-serve ones.
    const templated = await prisma.template.findMany({ where: { orgId, deletedAt: null, contractType: { not: null } }, select: { contractType: true }, distinct: ['contractType'] })
    const types = [...new Set([...templated.map(t => t.contractType!), ...selfServeTypes(conn?.config)])].sort()
    const mappings = everyType === '1'
      ? all.filter((m, i) => all.findIndex(o => o.externalObject === m.externalObject && o.externalField === m.externalField) === i)
      : contractType ? mappingsForType(all, contractType) : all.filter(m => !m.contractType)
    const fields = mappings.filter(m => m.direction !== 'outbound').map(m => {
      const def = coreField(m.dlField)
      return {
        dlField: m.dlField,
        label: def?.label ?? (m.dlField.startsWith('var:') ? m.dlField.slice(4).replace(/_/g, ' ') : m.dlField),
        type: dlFieldType(m.dlField),
        options: m.dlField === 'priority' ? [...REQUEST_PRIORITIES] : def?.options ? [...def.options] : undefined,
        externalObject: m.externalObject,
        externalField: m.externalField,
        locked: m.locked,
      }
    })
    return reply.send({ contractTypes: types, contractType: contractType ?? null, selfServe: !!contractType && selfServeTypes(conn?.config).includes(contractType), fields })
  })

  // ── Create a request from Salesforce (S2) ──
  app.post('/requests', { preHandler: sf('create', 'request') }, async (req, reply) => {
    let body
    try { body = InboundRequestSchema.parse(req.body) }
    catch (err) { return invalid(reply, err) }
    const acting = actingUserId(req.user)
    if (!acting) return reply.status(422).send(NO_ACTING_USER)
    const conn = (await getConnection(req.user.orgId, 'salesforce'))!

    const created = await createRequestFromSalesforce({ orgId: req.user.orgId, actingUserId: acting, salesforceOrgId: conn.externalOrgId!, body, ipAddress: req.ip })

    // "Generate now" for a self-serve type reuses the request → contract
    // conversion as it is, with this caller's own credentials and checks.
    let contractId: string | null = null
    let generateRefused: string | null = null
    if (body.generateNow) {
      if (!selfServeTypes(conn.config).includes(body.contractType)) {
        generateRefused = `${body.contractType} goes to Legal: it can't be generated straight from Salesforce.`
      } else {
        const res = await app.inject({
          method: 'POST', url: `/api/v1/requests/${created.requestId}/convert`,
          headers: { authorization: req.headers.authorization ?? '' },
        })
        if (res.statusCode === 201) contractId = (res.json() as { contractId: string }).contractId
        else generateRefused = (res.json() as { detail?: string }).detail ?? `Could not generate (${res.statusCode})`
      }
      if (contractId) {
        // The contract carries the deal it came from, for the status sync.
        const reqRow = await prisma.contractRequest.findFirst({ where: { id: created.requestId, orgId: req.user.orgId }, select: { metadata: true } })
        const sfMeta = ((reqRow?.metadata ?? {}) as Record<string, unknown>).salesforce
        const c = await prisma.contract.findFirst({ where: { id: contractId, orgId: req.user.orgId }, select: { metadata: true } })
        await prisma.contract.updateMany({
          where: { id: contractId, orgId: req.user.orgId },
          data: { metadata: { ...((c?.metadata ?? {}) as Record<string, unknown>), salesforce: sfMeta, salesforceRequestId: created.requestId } as Prisma.InputJsonValue },
        })
        await enqueueContractSync(req.user.orgId, contractId, 'contract.created').catch(() => undefined)
      }
    }
    return reply.status(201).send({
      ...created,
      ...(contractId ? { contractId, contractLink: contractLink(contractId) } : {}),
      ...(generateRefused ? { generateRefused } : {}),
    })
  })

  // ── A mapped Salesforce record changed (S2 / S3 reconcile) ──
  app.post('/changes', { preHandler: sf('create', 'request') }, async (req, reply) => {
    let body
    try { body = InboundChangeSchema.parse(req.body) }
    catch (err) { return invalid(reply, err) }
    const acting = actingUserId(req.user)
    if (!acting) return reply.status(422).send(NO_ACTING_USER)
    const result = await applySalesforceChange({ orgId: req.user.orgId, actingUserId: acting, object: body.object, record: body.record, records: body.records as Record<string, Record<string, unknown>> | undefined })
    return reply.send(result)
  })

  // ── What the status component shows (S1) ──
  app.get('/contracts/:id/status', { preHandler: sf('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true, title: true, type: true, status: true, stage: true, stageState: true, turn: true, turnSince: true, contractNumber: true, value: true, currency: true,
        effectiveDate: true, expiryDate: true, counterpartyName: true, metadata: true, updatedAt: true,
        counterparty: { select: { crmId: true } }, owner: { select: { name: true } },
      },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const instance = await prisma.approvalInstance.findFirst({
      where: { orgId, contractId: id }, orderBy: { submittedAt: 'desc' },
      select: { status: true, steps: { select: { stepName: true, status: true } } },
    })
    // Who an approval waits on, and since when the status stands: as the sync sends them.
    const facts = (await statusFacts(orgId, [id])).get(id)
    const approvals = facts?.approvals ?? null
    const payload = contractSyncPayload({ ...c, ...facts })
    const terms = await prisma.contractFieldValue.findMany({
      where: { orgId, contractId: id, rejectedAt: null },
      select: { fieldKey: true, value: true, label: true }, take: 60,
    })
    return reply.send({
      contractId: c.id, title: c.title, type: c.type, status: c.status,
      stages: STAGES, stage: payload.DL_Stage__c, waitingOn: payload.DL_Waiting_On__c,
      approvals, approvalSteps: instance?.steps ?? [],
      keyTerms: terms.filter(t => t.value !== null).map(t => ({ key: t.fieldKey, label: coreField(t.fieldKey)?.label ?? t.label ?? t.fieldKey, value: t.value })),
      link: contractLink(c.id),
    })
  })

  // ── A short-lived link to the read-only document preview (S3) ──
  app.post('/embed-token', { preHandler: sf('view', 'contract') }, async (req, reply) => {
    let body
    try { body = z.object({ contractId: z.string().min(1).max(64) }).parse(req.body) }
    catch (err) { return invalid(reply, err) }
    const c = await prisma.contract.findFirst({ where: { id: body.contractId, orgId: req.user.orgId, deletedAt: null }, select: { id: true } })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const token = signEmbedToken(req.user.orgId, c.id)
    return reply.send({ url: embedUrl(c.id, token), expiresAt: new Date(Date.now() + EMBED_TTL_SECONDS * 1000).toISOString() })
  })
}

// ─── The embedded document preview (public, by token) ─────────────────────────

export async function embedRoutes(app: FastifyInstance) {
  app.get('/contracts/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { token } = req.query as { token?: string }
    const allowed = verifyEmbedToken(token, id)
    reply.header('cache-control', 'no-store')
    if (!allowed) return reply.status(401).send({ title: 'Unauthorized', status: 401, detail: 'This preview link is invalid or has expired. Open it again from Salesforce.' })
    const c = await prisma.contract.findFirst({
      where: { id, orgId: allowed.orgId, deletedAt: null },
      select: { id: true, title: true, type: true, status: true, counterpartyName: true, currentVersionId: true, updatedAt: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const version = c.currentVersionId
      ? await prisma.contractVersion.findFirst({ where: { id: c.currentVersionId, contractId: c.id }, select: { versionNumber: true, htmlContent: true, plainText: true, createdAt: true } })
      : null
    return reply.send({
      contract: { id: c.id, title: c.title, type: c.type, status: c.status, counterpartyName: c.counterpartyName, updatedAt: c.updatedAt },
      version: version ? { versionNumber: version.versionNumber, html: version.htmlContent, text: version.htmlContent ? null : version.plainText, createdAt: version.createdAt } : null,
      expiresAt: allowed.expiresAt,
    })
  })
}
