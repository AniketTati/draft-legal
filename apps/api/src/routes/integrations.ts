/**
 * Integrations routes (Phase 10A — Public API + Webhooks).
 *
 *   API Keys:
 *     POST   /admin/integrations/api-keys             — create (returns full key once)
 *     GET    /admin/integrations/api-keys             — list (prefix only)
 *     DELETE /admin/integrations/api-keys/:id         — revoke
 *
 *   Webhooks:
 *     POST   /admin/integrations/webhooks             — create
 *     GET    /admin/integrations/webhooks             — list
 *     PATCH  /admin/integrations/webhooks/:id         — update enabled/url/events
 *     DELETE /admin/integrations/webhooks/:id         — soft delete
 *     POST   /admin/integrations/webhooks/:id/test    — fire a synthetic event
 *     GET    /admin/integrations/webhooks/:id/deliveries — recent delivery log
 *
 *   Slack (Phase 10 — Slack bot setup):
 *     GET    /admin/integrations/slack                 — current config (secrets masked)
 *     PUT    /admin/integrations/slack                 — save teamId / signingSecret / botToken
 *     DELETE /admin/integrations/slack                 — disconnect
 *
 *   Health (Phase 10 — integration health dashboard):
 *     GET    /admin/integrations/health               — per-webhook health + delivery aggregates,
 *                                                       and each connected integration's sync health
 *     POST   /admin/integrations/webhooks/:id/deliveries/:deliveryId/retry — requeue a failed delivery
 *
 *   Public:
 *     GET    /admin/integrations/events               — list of webhook event types
 */
import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { mergeOrgSettings, removeOrgSetting } from '../lib/org-settings.js'
import { slackTeamOfToken } from '../lib/slack.js'
import { requirePermission } from '../middleware/permissions.js'
import { hashApiKey, API_KEY_PREFIX, requireUser } from '../middleware/auth.js'
import { keyMaker } from '../lib/acting-user.js'
import { queueWebhookDelivery } from '../lib/queue.js'
import { isTeamsUrl } from '../lib/teams-formatter.js'
import { VALID_API_SCOPES } from '../lib/permissions.js'
import { isUrlShapeAllowed } from '../lib/ssrf-guard.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { integrationHealth } from '../lib/integrations/health.js'

// Wave 1.5 — reject webhook URLs that target private/localhost/metadata hosts
// (only enforced when the SSRF guard is active; self-host/dev pass through).
const publicUrl = (schema: z.ZodString) =>
  schema.refine(isUrlShapeAllowed, 'Webhook URL must be a public http(s) endpoint')

// Canonical list of events a webhook can subscribe to. Keep stable —
// these are part of the public API contract.
export const WEBHOOK_EVENTS = [
  'contract.created',
  'contract.uploaded',
  'contract.updated',
  'contract.executed',
  // 'contract.expired' removed (H2): nothing in the product moves a contract
  // to EXPIRED, so a subscriber would wait for an event that never comes.
  'signature.sent',
  'signature.completed',
  'signature.voided',
  'approval.submitted',
  'approval.decided',
  'obligation.extracted',
  'obligation.completed',
  'obligation.overdue',
  'invoice.created',
  'invoice.reconciled',
  'amendment.created',
] as const

const CreateApiKeySchema = z.object({
  name:       z.string().min(1).max(100),
  // Wave 1.2 — scopes must be a subset of the known vocabulary. An empty
  // list grants NO permissions, so such a key could call nothing (C1: the
  // admin dialog used to create exactly that). Require at least one.
  scopes:     z.array(z.string(), { required_error: 'Choose at least one scope — a key with no scopes cannot call any endpoint.' })
    .min(1, 'Choose at least one scope — a key with no scopes cannot call any endpoint.')
    .refine(
      (arr) => arr.every((s) => VALID_API_SCOPES.includes(s)),
      { message: `scopes must be a subset of: ${VALID_API_SCOPES.join(', ')}` },
    ),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})

const CreateWebhookSchema = z.object({
  name:    z.string().min(1).max(100),
  url:     publicUrl(z.string().url().max(2000)),
  events:  z.array(z.string()).min(1),
  enabled: z.boolean().optional(),
  type:    z.enum(['generic', 'slack', 'teams']).optional(),
})

const PatchWebhookSchema = z.object({
  name:    z.string().min(1).max(100).optional(),
  url:     publicUrl(z.string().url().max(2000)).optional(),
  events:  z.array(z.string()).min(1).optional(),
  enabled: z.boolean().optional(),
})

function generateApiKey(): string {
  // 32 bytes of entropy → 43 base64url chars; prefix flags it as a CLM key.
  const random = crypto.randomBytes(32).toString('base64url')
  return `${API_KEY_PREFIX}live_${random}`
}

function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('base64url')}`
}

export async function integrationsRoutes(app: FastifyInstance) {
  // ── GET /events — list known event types ─────────────────────────────
  app.get('/events', { preHandler: requirePermission('configure', 'organization') }, async (_req, reply) => {
    return reply.send({ events: WEBHOOK_EVENTS })
  })

  // X46 — managing API keys is for signed-in users. An admin-scope key passed
  // configure:organization, so a key could mint keys (recorded as made by
  // `apikey:<id>`) that survive revoking it and its maker's deactivation.

  // ── GET /api-key-scopes — the scope vocabulary for the create dialog ──
  app.get('/api-key-scopes', { preHandler: [requireUser, requirePermission('configure', 'organization')] }, async (_req, reply) => {
    return reply.send({ scopes: VALID_API_SCOPES })
  })

  // ── POST /api-keys — create (returns full key once) ───────────────────
  app.post('/api-keys', { preHandler: [requireUser, requirePermission('configure', 'organization')] }, async (req, reply) => {
    let body
    try { body = CreateApiKeySchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId, sub: userId } = req.user
    // X46 — only someone who could make a key now: a deactivated user's access
    // token outlives the deactivation by its lifetime, and the agents service
    // is no user. A key's access ends with its maker's (keyMaker).
    if (!await keyMaker(orgId, userId)) {
      return reply.status(403).send({ type: 'https://httpstatuses.com/403', title: 'Forbidden', status: 403, detail: 'Only an active member who can manage API keys can create one' })
    }

    const fullKey = generateApiKey()
    const created = await prisma.apiKey.create({
      data: {
        orgId, createdById: userId,
        name:        body.name.trim(),
        keyHash:     hashApiKey(fullKey),
        prefix:      fullKey.slice(0, 12),
        scopes:      body.scopes,
        expiresAt:   body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
          : null,
      },
      select: {
        id: true, name: true, prefix: true, scopes: true,
        expiresAt: true, createdAt: true,
      },
    })

    // X43 — a key is a standing credential: its creation is on the record.
    await createAuditEvent({
      orgId, userId, action: AuditAction.API_KEY_CREATED, resourceType: 'api_key', resourceId: created.id,
      metadata: { name: created.name, scopes: created.scopes, expiresAt: created.expiresAt }, ipAddress: req.ip,
    })

    return reply.status(201).send({
      ...created,
      // Full key is shown ONCE — caller must save it. We never store it.
      key: fullKey,
    })
  })

  // ── GET /api-keys — list ─────────────────────────────────────────────
  app.get('/api-keys', { preHandler: [requireUser, requirePermission('configure', 'organization')] }, async (req, reply) => {
    const { orgId } = req.user
    const keys = await prisma.apiKey.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, prefix: true, scopes: true,
        lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true, createdById: true,
      },
      take: 100,
    })
    // X43 — who made each key, so an admin can tell whose keys are whose.
    const creators = new Map((await prisma.user.findMany({
      where: { orgId, id: { in: [...new Set(keys.map(k => k.createdById))] } }, select: { id: true, name: true, email: true },
    })).map(u => [u.id, u]))
    return reply.send({ data: keys.map(({ createdById, ...k }) => ({ ...k, createdBy: creators.get(createdById) ?? null })) })
  })

  // ── DELETE /api-keys/:id — revoke ─────────────────────────────────────
  app.delete('/api-keys/:id', { preHandler: [requireUser, requirePermission('configure', 'organization')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const updated = await prisma.apiKey.updateMany({
      where: { id, orgId, revokedAt: null },
      data:  { revokedAt: new Date() },
    })
    if (updated.count === 0) return reply.status(404).send({ detail: 'API key not found' })
    await createAuditEvent({ orgId, userId: req.user.sub, action: AuditAction.API_KEY_REVOKED, resourceType: 'api_key', resourceId: id, ipAddress: req.ip })
    return reply.status(204).send()
  })

  // ── POST /webhooks — create ──────────────────────────────────────────
  app.post('/webhooks', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    let body
    try { body = CreateWebhookSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    const invalid = body.events.filter(e => !(WEBHOOK_EVENTS as readonly string[]).includes(e))
    if (invalid.length > 0) {
      return reply.status(400).send({ detail: `Unknown events: ${invalid.join(', ')}` })
    }
    const { orgId, sub: userId } = req.user

    // Auto-detect Slack / Teams URLs if user didn't specify a type. Saves
    // a step for the common case where they paste a known webhook URL.
    let webhookType = body.type ?? 'generic'
    if (!body.type && body.url.startsWith('https://hooks.slack.com/')) {
      webhookType = 'slack'
    } else if (!body.type && isTeamsUrl(body.url)) {
      webhookType = 'teams'
    }

    const created = await prisma.webhook.create({
      data: {
        orgId, createdById: userId,
        name:    body.name.trim(),
        url:     body.url,
        events:  body.events,
        secret:  generateWebhookSecret(),
        enabled: body.enabled ?? true,
        type:    webhookType,
      },
    })
    return reply.status(201).send(created)
  })

  // ── GET /webhooks — list ─────────────────────────────────────────────
  app.get('/webhooks', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const webhooks = await prisma.webhook.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return reply.send({ data: webhooks })
  })

  // ── PATCH /webhooks/:id — update ─────────────────────────────────────
  app.patch('/webhooks/:id', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    let body
    try { body = PatchWebhookSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    if (body.events) {
      const invalid = body.events.filter(e => !(WEBHOOK_EVENTS as readonly string[]).includes(e))
      if (invalid.length > 0) {
        return reply.status(400).send({ detail: `Unknown events: ${invalid.join(', ')}` })
      }
    }
    const updated = await prisma.webhook.updateMany({
      where: { id, orgId, deletedAt: null },
      data: body,
    })
    if (updated.count === 0) return reply.status(404).send({ detail: 'Webhook not found' })
    return reply.send({ ok: true })
  })

  // ── DELETE /webhooks/:id — soft delete ───────────────────────────────
  app.delete('/webhooks/:id', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const updated = await prisma.webhook.updateMany({
      where: { id, orgId, deletedAt: null },
      data:  { deletedAt: new Date(), enabled: false },
    })
    if (updated.count === 0) return reply.status(404).send({ detail: 'Webhook not found' })
    return reply.status(204).send()
  })

  // ── POST /webhooks/:id/test — fire a synthetic event ─────────────────
  app.post('/webhooks/:id/test', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const wh = await prisma.webhook.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    })
    if (!wh) return reply.status(404).send({ detail: 'Webhook not found' })

    await queueWebhookDelivery({
      webhookId: id,
      event:     'webhook.test',
      payload:   {
        message: 'This is a test event from draftLegal',
        firedAt: new Date().toISOString(),
        orgId,
      },
    })
    return reply.send({ ok: true, message: 'Test delivery queued' })
  })

  // ── Slack config (Phase 10 — Slack bot setup wizard) ─────────────────
  // Stored on organization.settings.slack. The signing secret authenticates
  // inbound /slack/commands + /slack/interactions; the optional bot token
  // lets button clicks resolve to CLM users (users:read.email scope).
  app.get('/slack', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } })
    const slack = ((org?.settings as Record<string, unknown> | null)?.slack ?? null) as
      { teamId?: string; signingSecret?: string; botToken?: string; configuredAt?: string; teamVerified?: boolean } | null
    if (!slack?.teamId) return reply.send({ connected: false })
    return reply.send({
      connected:        true,
      teamId:           slack.teamId,
      configuredAt:     slack.configuredAt ?? null,
      hasSigningSecret: Boolean(slack.signingSecret),
      hasBotToken:      Boolean(slack.botToken),
      teamVerified:     slack.teamVerified === true,
    })
  })

  app.put('/slack', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    let body
    try {
      body = z.object({
        teamId:        z.string().min(1).max(50),
        signingSecret: z.string().min(1).max(200),
        botToken:      z.string().max(300).optional(),
      }).parse(req.body)
    } catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    if (body.botToken && !body.botToken.startsWith('xoxb-')) {
      return reply.status(400).send({ detail: 'Bot token must start with xoxb-' })
    }
    // X6 — a bot token proves which workspace this is. Verified claims win when
    // several orgs name the same team id, so a squatter can't displace this one.
    let teamVerified = false
    if (body.botToken) {
      const team = await slackTeamOfToken(body.botToken.trim())
      if (team && !team.ok) {
        return reply.status(400).send({ detail: `Slack rejected the bot token (${team.error}).` })
      }
      if (team?.ok && team.teamId !== body.teamId.trim()) {
        return reply.status(400).send({ detail: `That bot token belongs to Slack workspace ${team.teamId}, not ${body.teamId.trim()}.` })
      }
      teamVerified = Boolean(team?.ok)
    }
    // X4 — set only `slack`, atomically; a whole-blob write undid concurrent changes.
    await mergeOrgSettings(orgId, {
      slack: {
        teamId:        body.teamId.trim(),
        signingSecret: body.signingSecret.trim(),
        ...(body.botToken ? { botToken: body.botToken.trim() } : {}),
        configuredAt:  new Date().toISOString(),
        teamVerified,
      },
    })
    return reply.send({ ok: true, teamVerified })
  })

  app.delete('/slack', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    await removeOrgSetting(orgId, 'slack')   // X4 — atomic, touches only `slack`
    return reply.status(204).send()
  })

  // ── GET /health — integration health dashboard (Phase 10) ────────────
  // Per-webhook health state + 24h/7d delivery aggregates + API key
  // summary, in one call so the dashboard renders from a single query.
  app.get('/health', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const now = Date.now()
    const since24h = new Date(now - 24 * 60 * 60 * 1000)
    const since7d  = new Date(now - 7 * 24 * 60 * 60 * 1000)

    const webhooks = await prisma.webhook.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, name: true, url: true, type: true, enabled: true,
        events: true, lastDeliveryAt: true, lastDeliveryStatus: true,
        failureCount: true, createdAt: true,
      },
    })
    const ids = webhooks.map(w => w.id)

    // 7d delivery counts grouped by webhook × outcome; 24h is a subset
    // filter on the same axis. Two groupBys beat N×4 count queries.
    const [counts7d, counts24h, lastFailures] = await Promise.all([
      prisma.webhookDelivery.groupBy({
        by: ['webhookId', 'succeeded'],
        where: { webhookId: { in: ids }, createdAt: { gte: since7d } },
        _count: { _all: true },
      }),
      prisma.webhookDelivery.groupBy({
        by: ['webhookId', 'succeeded'],
        where: { webhookId: { in: ids }, createdAt: { gte: since24h } },
        _count: { _all: true },
      }),
      // Most recent failed delivery per webhook — powers the "last error"
      // column + the retry button. DISTINCT ON keeps it one round-trip.
      ids.length > 0
        ? prisma.webhookDelivery.findMany({
            where: { webhookId: { in: ids }, succeeded: false },
            orderBy: [{ webhookId: 'asc' }, { createdAt: 'desc' }],
            distinct: ['webhookId'],
            select: { id: true, webhookId: true, event: true, errorMessage: true, responseStatus: true, createdAt: true },
          })
        : Promise.resolve([]),
    ])

    const tally = (rows: typeof counts7d, webhookId: string, succeeded: boolean) =>
      rows.find(r => r.webhookId === webhookId && r.succeeded === succeeded)?._count._all ?? 0

    const webhookHealth = webhooks.map(w => {
      const ok7d = tally(counts7d, w.id, true), fail7d = tally(counts7d, w.id, false)
      const ok24h = tally(counts24h, w.id, true), fail24h = tally(counts24h, w.id, false)
      const lastFailure = lastFailures.find(f => f.webhookId === w.id) ?? null
      // Health state: failing = 3+ consecutive failures (worker resets
      // failureCount to 0 on any success); degraded = recent failures but
      // not a dead endpoint; healthy = no failures in the 7d window.
      const health =
        !w.enabled            ? 'disabled' :
        w.failureCount >= 3   ? 'failing'  :
        (w.failureCount > 0 || fail7d > 0) ? 'degraded' :
        'healthy'
      return {
        id: w.id, name: w.name, url: w.url, type: w.type, enabled: w.enabled,
        events: w.events,
        health,
        lastDeliveryAt: w.lastDeliveryAt, lastDeliveryStatus: w.lastDeliveryStatus,
        consecutiveFailures: w.failureCount,
        deliveries: { ok24h, fail24h, ok7d, fail7d },
        lastFailure: lastFailure
          ? { deliveryId: lastFailure.id, event: lastFailure.event, errorMessage: lastFailure.errorMessage, responseStatus: lastFailure.responseStatus, at: lastFailure.createdAt }
          : null,
      }
    })

    const apiKeys = await prisma.apiKey.findMany({
      where: { orgId, revokedAt: null },
      select: { expiresAt: true, lastUsedAt: true },
    })
    const in30d = new Date(now + 30 * 24 * 60 * 60 * 1000)
    const total7dOk   = counts7d.filter(r => r.succeeded).reduce((s, r) => s + r._count._all, 0)
    const total7dFail = counts7d.filter(r => !r.succeeded).reduce((s, r) => s + r._count._all, 0)

    return reply.send({
      webhooks: webhookHealth,
      // docs/41 Part 20 — connected integrations (Salesforce): syncs, last failure, conflicts.
      integrations: await integrationHealth(orgId),
      summary: {
        healthy:  webhookHealth.filter(w => w.health === 'healthy').length,
        degraded: webhookHealth.filter(w => w.health === 'degraded').length,
        failing:  webhookHealth.filter(w => w.health === 'failing').length,
        disabled: webhookHealth.filter(w => w.health === 'disabled').length,
        deliveries24h: counts24h.reduce((s, r) => s + r._count._all, 0),
        failed24h:     counts24h.filter(r => !r.succeeded).reduce((s, r) => s + r._count._all, 0),
        successRate7d: total7dOk + total7dFail > 0
          ? Math.round((total7dOk / (total7dOk + total7dFail)) * 100)
          : null,
      },
      apiKeys: {
        active:       apiKeys.length,
        expiringSoon: apiKeys.filter(k => k.expiresAt && k.expiresAt <= in30d && k.expiresAt > new Date(now)).length,
        lastUsedAt:   apiKeys.reduce<Date | null>((max, k) =>
          k.lastUsedAt && (!max || k.lastUsedAt > max) ? k.lastUsedAt : max, null),
      },
    })
  })

  // ── POST /webhooks/:id/deliveries/:deliveryId/retry (Phase 10) ───────
  // Requeue a failed delivery with its original event + payload.
  app.post('/webhooks/:id/deliveries/:deliveryId/retry', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { id, deliveryId } = req.params as { id: string; deliveryId: string }
    const { orgId } = req.user
    const wh = await prisma.webhook.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, enabled: true },
    })
    if (!wh) return reply.status(404).send({ detail: 'Webhook not found' })
    if (!wh.enabled) return reply.status(400).send({ detail: 'Webhook is disabled — enable it before retrying' })

    const delivery = await prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, webhookId: id },
      select: { id: true, event: true, payload: true, succeeded: true },
    })
    if (!delivery) return reply.status(404).send({ detail: 'Delivery not found' })
    if (delivery.succeeded) return reply.status(400).send({ detail: 'Delivery already succeeded' })

    await queueWebhookDelivery({
      webhookId: id,
      event:     delivery.event,
      payload:   delivery.payload as Record<string, unknown>,
    })
    return reply.send({ ok: true, message: 'Retry queued' })
  })

  // ── GET /webhooks/:id/deliveries — recent delivery log ──────────────
  app.get('/webhooks/:id/deliveries', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const wh = await prisma.webhook.findFirst({
      where: { id, orgId, deletedAt: null }, select: { id: true },
    })
    if (!wh) return reply.status(404).send({ detail: 'Webhook not found' })

    const items = await prisma.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, event: true, attempts: true, succeeded: true,
        responseStatus: true, errorMessage: true,
        createdAt: true, deliveredAt: true,
      },
    })
    return reply.send({ data: items })
  })
}
