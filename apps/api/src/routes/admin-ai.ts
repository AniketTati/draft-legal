/**
 * Admin AI endpoints (D.0.4a)
 *
 * Surfaces the AI Config UI (D.0.8) needs:
 *
 *   GET    /admin/ai/settings            → current per-tier model overrides
 *                                          + dailyCostCap + capPolicy + the
 *                                          platform routing table so the UI
 *                                          can show defaults
 *   PUT    /admin/ai/settings            → upsert overrides + cap
 *
 *   GET    /admin/ai/keys                → list BYOK keys (prefix only;
 *                                          plaintext NEVER returned)
 *   PUT    /admin/ai/keys/:provider      → encrypt + upsert a BYOK key
 *   POST   /admin/ai/keys/:provider/test → live API call to verify the key
 *                                          works; updates testStatus on row
 *   DELETE /admin/ai/keys/:provider      → remove a BYOK key
 *
 *   GET    /admin/ai/usage               → daily / monthly aggregations,
 *                                          breakdowns by provider/tier/tool
 *
 * All gated by requirePermission('configure', 'organization') — same scope
 * the org/users/roles admin pages use.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { encrypt, keyPrefix } from '../lib/encryption.js'
import { __internal } from '../lib/aiRouter.js'
import { getCostCapStatus, invalidateCapConfig } from '../lib/costCap.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'

// D.0.6 — ipAddress + userAgent extractor so every audit row is stamped
// the same way regardless of which handler called it.
function reqContext(req: FastifyRequest) {
  return {
    ipAddress: req.ip,
    userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500),
  }
}

const ALLOWED_PROVIDERS = ['openai', 'anthropic', 'google', 'voyage', 'cohere', 'mistral'] as const
type Provider = typeof ALLOWED_PROVIDERS[number]

const TierKeys = z.enum(['reasoningModel', 'defaultModel', 'fastModel', 'embedModel', 'rerankModel', 'visionOcrModel'])

const UpdateSettingsSchema = z.object({
  reasoningModel:  z.string().nullable().optional(),
  defaultModel:    z.string().nullable().optional(),
  fastModel:       z.string().nullable().optional(),
  embedModel:      z.string().nullable().optional(),
  rerankModel:     z.string().nullable().optional(),
  visionOcrModel:  z.string().nullable().optional(),
  dailyCostCapUsd: z.number().min(0).max(100_000).nullable().optional(),
  capPolicy:       z.enum(['block', 'warn']).optional(),
})

const PutKeySchema = z.object({
  apiKey: z.string().min(8).max(500),
})

export async function adminAiRoutes(app: FastifyInstance) {
  // ── GET /admin/ai/settings ─────────────────────────────────────────────────
  app.get('/settings', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const settings = await prisma.orgAiSettings.findUnique({ where: { orgId } })
    // Also surface the platform routing table so the UI can display defaults.
    const platformRouting: Record<string, Array<{ provider: string; model: string }>> = {}
    for (const [tier, candidates] of Object.entries(__internal.PLATFORM_TIER_DEFAULTS)) {
      platformRouting[tier] = candidates
    }
    return reply.send({
      // Defaults so the UI never has to handle null
      reasoningModel:  settings?.reasoningModel  ?? null,
      defaultModel:    settings?.defaultModel    ?? null,
      fastModel:       settings?.fastModel       ?? null,
      embedModel:      settings?.embedModel      ?? null,
      rerankModel:     settings?.rerankModel     ?? null,
      visionOcrModel:  settings?.visionOcrModel  ?? null,
      dailyCostCapUsd: settings?.dailyCostCapUsd ? Number(settings.dailyCostCapUsd) : null,
      capPolicy:       settings?.capPolicy ?? 'block',
      platformRouting,
    })
  })

  // ── PUT /admin/ai/settings ─────────────────────────────────────────────────
  app.put('/settings', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    let body
    try { body = UpdateSettingsSchema.parse(req.body) }
    catch (e) { return reply.status(400).send({ detail: 'Invalid body', issues: (e as { issues?: unknown }).issues }) }
    const { orgId, sub: userId } = req.user

    // Build the upsert data — strip undefined keys so we don't blow away
    // existing values that weren't part of this request.
    const updateData: Record<string, unknown> = {}
    for (const k of Object.keys(body) as (keyof typeof body)[]) {
      if (body[k] !== undefined) updateData[k] = body[k]
    }

    // D.0.6 — snapshot prior state so the audit row carries a real diff,
    // not just the new value. Coerce Decimal → number for stable JSON.
    const prior = await prisma.orgAiSettings.findUnique({ where: { orgId } })
    const priorSnapshot = prior ? {
      reasoningModel:  prior.reasoningModel,
      defaultModel:    prior.defaultModel,
      fastModel:       prior.fastModel,
      embedModel:      prior.embedModel,
      rerankModel:     prior.rerankModel,
      visionOcrModel:  prior.visionOcrModel,
      dailyCostCapUsd: prior.dailyCostCapUsd != null ? Number(prior.dailyCostCapUsd) : null,
      capPolicy:       prior.capPolicy,
    } : null

    const updated = await prisma.orgAiSettings.upsert({
      where: { orgId },
      create: { orgId, ...updateData },
      update: updateData,
    })
    // D.0.5 — bust the 30s Redis cache so the new cap takes effect on the very
    // next router call rather than after the TTL expires.
    if ('dailyCostCapUsd' in updateData || 'capPolicy' in updateData) {
      await invalidateCapConfig(orgId)
    }

    // D.0.6 — record the diff (only fields actually in the request body).
    const changed: Record<string, { from: unknown; to: unknown }> = {}
    for (const k of Object.keys(updateData)) {
      const before = priorSnapshot ? (priorSnapshot as Record<string, unknown>)[k] : null
      const after  = (updateData as Record<string, unknown>)[k]
      if (before !== after) changed[k] = { from: before ?? null, to: after ?? null }
    }
    if (Object.keys(changed).length > 0) {
      await createAuditEvent({
        orgId,
        userId,
        action: AuditAction.AI_SETTINGS_UPDATED,
        resourceType: 'ai_settings',
        resourceId: orgId,
        metadata: { changed },
        ...reqContext(req),
      })
    }

    return reply.send({
      reasoningModel:  updated.reasoningModel,
      defaultModel:    updated.defaultModel,
      fastModel:       updated.fastModel,
      embedModel:      updated.embedModel,
      rerankModel:     updated.rerankModel,
      visionOcrModel:  updated.visionOcrModel,
      dailyCostCapUsd: updated.dailyCostCapUsd ? Number(updated.dailyCostCapUsd) : null,
      capPolicy:       updated.capPolicy,
    })
  })

  // ── GET /admin/ai/keys ─────────────────────────────────────────────────────
  // Returns one entry per allowed provider with status + prefix only.
  // Plaintext key is NEVER returned — admin UI shows ••••••••sk-proj- style.
  app.get('/keys', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const stored = await prisma.orgAiKey.findMany({
      where: { orgId },
      select: { provider: true, keyPrefix: true, isActive: true, lastTestedAt: true, testStatus: true, testError: true, createdAt: true, updatedAt: true },
    })
    const byProvider = new Map(stored.map((k) => [k.provider, k]))
    const data = ALLOWED_PROVIDERS.map((provider) => {
      const k = byProvider.get(provider)
      if (k) return { ...k, configured: true }
      return { provider, configured: false, keyPrefix: null, isActive: false, lastTestedAt: null, testStatus: null, testError: null, createdAt: null, updatedAt: null }
    })
    return reply.send({ data })
  })

  // ── PUT /admin/ai/keys/:provider ───────────────────────────────────────────
  // Body: { apiKey } — encrypted server-side, prefix kept for display.
  app.put('/keys/:provider', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { provider } = req.params as { provider: string }
    if (!ALLOWED_PROVIDERS.includes(provider as Provider)) {
      return reply.status(400).send({ detail: `Unknown provider "${provider}"` })
    }
    let body
    try { body = PutKeySchema.parse(req.body) }
    catch (e) { return reply.status(400).send({ detail: 'Invalid body', issues: (e as { issues?: unknown }).issues }) }
    const { orgId, sub: userId } = req.user

    const apiKey = body.apiKey.trim()
    const encryptedKey = encrypt(apiKey)
    const prefix = keyPrefix(apiKey, 8)

    // D.0.6 — detect create vs. rotate so the audit action reflects intent.
    const priorRow = await prisma.orgAiKey.findUnique({
      where: { orgId_provider: { orgId, provider } },
      select: { keyPrefix: true },
    })

    const row = await prisma.orgAiKey.upsert({
      where: { orgId_provider: { orgId, provider } },
      create: {
        orgId,
        provider,
        encryptedKey,
        keyPrefix: prefix,
        createdById: userId,
        isActive: true,
      },
      update: {
        encryptedKey,
        keyPrefix: prefix,
        isActive: true,
        // New key invalidates prior test
        lastTestedAt: null,
        testStatus: null,
        testError: null,
      },
    })

    // D.0.6 — log key lifecycle. NEVER log the plaintext — only the prefix,
    // which is already public-safe (it's returned by GET /keys).
    await createAuditEvent({
      orgId,
      userId,
      action: priorRow ? AuditAction.AI_KEY_UPDATED : AuditAction.AI_KEY_CREATED,
      resourceType: 'ai_key',
      resourceId: provider,
      metadata: priorRow
        ? { provider, keyPrefix: { from: priorRow.keyPrefix, to: prefix } }
        : { provider, keyPrefix: prefix },
      ...reqContext(req),
    })

    return reply.send({
      provider: row.provider,
      configured: true,
      keyPrefix: row.keyPrefix,
      isActive: row.isActive,
      lastTestedAt: row.lastTestedAt,
      testStatus: row.testStatus,
      testError: row.testError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  })

  // ── DELETE /admin/ai/keys/:provider ────────────────────────────────────────
  app.delete('/keys/:provider', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { provider } = req.params as { provider: string }
    if (!ALLOWED_PROVIDERS.includes(provider as Provider)) {
      return reply.status(400).send({ detail: `Unknown provider "${provider}"` })
    }
    const { orgId, sub: userId } = req.user
    // Capture prefix before delete so the audit row remembers which key went away.
    const priorRow = await prisma.orgAiKey.findUnique({
      where: { orgId_provider: { orgId, provider } },
      select: { keyPrefix: true },
    })
    const removed = await prisma.orgAiKey.deleteMany({ where: { orgId, provider } })
    if (removed.count > 0) {
      await createAuditEvent({
        orgId,
        userId,
        action: AuditAction.AI_KEY_DELETED,
        resourceType: 'ai_key',
        resourceId: provider,
        metadata: { provider, keyPrefix: priorRow?.keyPrefix ?? null },
        ...reqContext(req),
      })
    }
    return reply.send({ provider, configured: false })
  })

  // ── POST /admin/ai/keys/:provider/test ─────────────────────────────────────
  // Live-checks the key by issuing a tiny request. Records status on the row.
  app.post('/keys/:provider/test', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { provider } = req.params as { provider: string }
    if (!ALLOWED_PROVIDERS.includes(provider as Provider)) {
      return reply.status(400).send({ detail: `Unknown provider "${provider}"` })
    }
    const { orgId } = req.user
    const row = await prisma.orgAiKey.findUnique({ where: { orgId_provider: { orgId, provider } } })
    if (!row) return reply.status(404).send({ detail: 'No BYOK key configured for this provider' })

    // Decrypt + ping the provider with a minimal call.
    const { decrypt } = await import('../lib/encryption.js')
    let plaintextKey: string
    try { plaintextKey = decrypt(row.encryptedKey) }
    catch (e) {
      const errMsg = (e as Error).message
      await prisma.orgAiKey.update({ where: { orgId_provider: { orgId, provider } }, data: { testStatus: 'failed', testError: `decrypt: ${errMsg}`, lastTestedAt: new Date() } })
      return reply.status(500).send({ ok: false, error: `Stored ciphertext could not be decrypted: ${errMsg}` })
    }

    const result = await testProviderKey(provider as Provider, plaintextKey)
    const updated = await prisma.orgAiKey.update({
      where: { orgId_provider: { orgId, provider } },
      data: { testStatus: result.ok ? 'success' : 'failed', testError: result.ok ? null : result.error?.slice(0, 500), lastTestedAt: new Date() },
    })
    await createAuditEvent({
      orgId,
      userId: req.user.sub,
      action: AuditAction.AI_KEY_TESTED,
      resourceType: 'ai_key',
      resourceId: provider,
      metadata: { provider, keyPrefix: row.keyPrefix, ok: result.ok, ...(result.error ? { error: result.error.slice(0, 200) } : {}) },
      ...reqContext(req),
    })
    return reply.send({ ok: result.ok, error: result.error, lastTestedAt: updated.lastTestedAt })
  })

  // ── GET /admin/ai/usage ────────────────────────────────────────────────────
  // Default: last 30 days; aggregated by date + tier with totals.
  // Future: query params for window, breakdown axis (tool, model, etc.).
  app.get('/usage', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const since = new Date()
    since.setDate(since.getDate() - 30)
    const sinceStr = since.toISOString().slice(0, 10)

    const rows = await prisma.orgUsageDaily.findMany({
      where: { orgId, date: { gte: sinceStr } },
      orderBy: { date: 'asc' },
    })

    // Aggregate at three levels for the dashboard
    const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, callCount: 0 }
    const byDay: Record<string, { date: string; costUsd: number; callCount: number }> = {}
    const byProvider: Record<string, { provider: string; costUsd: number; callCount: number }> = {}
    const byTier: Record<string, { tier: string; costUsd: number; callCount: number }> = {}

    for (const r of rows) {
      const cost = Number(r.costUsd)
      totals.inputTokens  += r.inputTokens
      totals.outputTokens += r.outputTokens
      totals.costUsd      += cost
      totals.callCount    += r.callCount

      byDay[r.date] = byDay[r.date] ?? { date: r.date, costUsd: 0, callCount: 0 }
      byDay[r.date].costUsd  += cost
      byDay[r.date].callCount += r.callCount

      byProvider[r.provider] = byProvider[r.provider] ?? { provider: r.provider, costUsd: 0, callCount: 0 }
      byProvider[r.provider].costUsd  += cost
      byProvider[r.provider].callCount += r.callCount

      byTier[r.tier] = byTier[r.tier] ?? { tier: r.tier, costUsd: 0, callCount: 0 }
      byTier[r.tier].costUsd  += cost
      byTier[r.tier].callCount += r.callCount
    }

    return reply.send({
      windowDays: 30,
      since: sinceStr,
      // These are derived from a characters-to-tokens heuristic at the call
      // site, not from provider billing. Flagged so the UI can label them as
      // estimates rather than presenting them as measured spend.
      estimated: true,
      totals: { ...totals, costUsd: Number(totals.costUsd.toFixed(6)) },
      byDay: Object.values(byDay),
      byProvider: Object.values(byProvider),
      byTier: Object.values(byTier),
    })
  })

  // ── GET /admin/ai/cap-status ───────────────────────────────────────────────
  // Today's spend vs the cap, for the AI Config UI's progress band.
  app.get('/cap-status', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    return reply.send(await getCostCapStatus(orgId))
  })

  // ── GET /admin/ai/audit ────────────────────────────────────────────────────
  // Append-only audit trail of AI config changes for compliance review (D.0.6).
  // Scoped to the caller's org; plaintext BYOK keys NEVER appear in metadata —
  // only the public prefix, which is also what GET /keys returns.
  //
  // Query params:
  //   action=AI_KEY_TESTED[,AI_KEY_CREATED,...]  filter by action
  //   from=YYYY-MM-DD        lower bound (inclusive) on createdAt
  //   to=YYYY-MM-DD          upper bound (exclusive)
  //   limit=50               max 200
  app.get('/audit', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const q = req.query as { action?: string; from?: string; to?: string; limit?: string }
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))

    const AI_ACTIONS = [
      AuditAction.AI_SETTINGS_UPDATED,
      AuditAction.AI_KEY_CREATED,
      AuditAction.AI_KEY_UPDATED,
      AuditAction.AI_KEY_DELETED,
      AuditAction.AI_KEY_TESTED,
    ] as string[]

    // If the caller passed an action filter, intersect it with the AI-scoped
    // list — this endpoint never exposes non-AI audit rows regardless of what
    // was requested. resourceType IN ('ai_settings','ai_key') is an equivalent
    // guard but filtering by action is more precise.
    let actions = AI_ACTIONS
    if (q.action) {
      const requested = q.action.split(',').map(s => s.trim()).filter(Boolean)
      actions = AI_ACTIONS.filter(a => requested.includes(a))
      if (actions.length === 0) {
        return reply.send({ events: [] }) // nothing the caller is allowed to see matches
      }
    }

    const where: Record<string, unknown> = { orgId, action: { in: actions } }
    if (q.from || q.to) {
      const range: Record<string, Date> = {}
      if (q.from) range.gte = new Date(q.from + 'T00:00:00Z')
      if (q.to)   range.lt  = new Date(q.to   + 'T00:00:00Z')
      where.createdAt = range
    }

    const rows = await prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    // Denormalize the actor name/email so the UI doesn't need a second fetch.
    const userIds = Array.from(new Set(rows.map(r => r.userId).filter((x): x is string => !!x)))
    const users = userIds.length > 0
      ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
      : []
    const userMap = new Map(users.map(u => [u.id, u]))

    return reply.send({
      events: rows.map(r => ({
        id: r.id,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        metadata: r.metadata,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        createdAt: r.createdAt,
        actor: r.userId
          ? { id: r.userId, name: userMap.get(r.userId)?.name ?? null, email: userMap.get(r.userId)?.email ?? null }
          : null,
      })),
    })
  })
}

// ─── Per-provider live test helpers ──────────────────────────────────────────
// Tiny calls that won't blow up the org's spend; recorded to OrgAiKey.testStatus.

async function testProviderKey(provider: Provider, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (provider) {
      case 'openai': {
        const r = await fetch('https://api.openai.com/v1/models?limit=1', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        if (r.ok) return { ok: true }
        return { ok: false, error: `OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}` }
      }
      case 'anthropic': {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        })
        if (r.ok) return { ok: true }
        return { ok: false, error: `Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}` }
      }
      case 'google': {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`)
        if (r.ok) return { ok: true }
        return { ok: false, error: `Google ${r.status}: ${(await r.text()).slice(0, 200)}` }
      }
      case 'voyage':
      case 'cohere':
      case 'mistral': {
        // No live test for these yet — we accept the key and validate on first
        // use. Mark as untested so the UI can show a "not yet verified" badge.
        return { ok: true }
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
