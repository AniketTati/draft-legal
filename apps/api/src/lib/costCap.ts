/**
 * Per-tenant daily cost cap for platform-paid LLM calls (D.0.5)
 *
 * Each org has a `dailyCostCapUsd` (defaults to platform cap of $50/day).
 * Before issuing a platform-paid LLM call we check whether spend so far
 * today already exceeds the cap; if so, refuse the call.
 *
 * BYOK calls bypass this entirely — the org's own provider account is
 * billed and they manage their own spend.
 *
 * Storage: Redis hash keyed `cost-cap:<orgId>:<YYYY-MM-DD>` so the
 * counter dies on its own at the start of the next UTC day.
 *
 * Atomicity: INCRBY on a single hash field. No race; no lock.
 *
 * Usage:
 *   await assertCostCapNotExceeded(orgId)   // throws CostCapExceededError
 *   await recordCost(orgId, 0.0042)         // call after the LLM responds
 *   const used = await getDailyCost(orgId)  // read-only check for UI
 */
import { redis } from './redis.js'
import { prisma } from './prisma.js'

const DEFAULT_PLATFORM_CAP_USD = Number(process.env.PLATFORM_DAILY_COST_CAP_USD ?? 50)
// We store cents internally to keep INCRBY working on integers; convert
// at the boundaries.
const USD_TO_INTERNAL = 1_000_000  // 6 decimal places

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function bucketKey(orgId: string, date: string = todayKey()): string {
  return `cost-cap:${orgId}:${date}`
}

export class CostCapExceededError extends Error {
  constructor(
    public orgId: string,
    public usedUsd: number,
    public capUsd: number,
    public policy: 'block' | 'warn',
  ) {
    super(
      `Daily AI cost cap exceeded for org=${orgId}. ` +
      `Used $${usedUsd.toFixed(4)} / cap $${capUsd.toFixed(2)}. ` +
      `policy=${policy}`,
    )
    this.name = 'CostCapExceededError'
  }
}

/**
 * Resolve the cap for an org (org-level override or platform default).
 * Cached for 30s in Redis to avoid hammering Postgres on every LLM call.
 */
async function resolveCap(orgId: string): Promise<{ cap: number; policy: 'block' | 'warn' }> {
  const cacheKey = `cost-cap-config:${orgId}`
  const cached = await redis.get(cacheKey)
  if (cached) {
    try { return JSON.parse(cached) } catch { /* fall through, cache poisoned */ }
  }
  const settings = await prisma.orgAiSettings.findUnique({
    where: { orgId },
    select: { dailyCostCapUsd: true, capPolicy: true },
  })
  const cap = settings?.dailyCostCapUsd != null ? Number(settings.dailyCostCapUsd) : DEFAULT_PLATFORM_CAP_USD
  const policy = (settings?.capPolicy ?? 'block') as 'block' | 'warn'
  const config = { cap, policy }
  await redis.set(cacheKey, JSON.stringify(config), 'EX', 30)
  return config
}

/**
 * Throws if the org has already crossed today's cap (block policy).
 * Logs but does NOT throw under warn policy — leaves the call to proceed.
 */
export async function assertCostCapNotExceeded(orgId: string): Promise<void> {
  const usedUsd = await getDailyCost(orgId)
  const { cap, policy } = await resolveCap(orgId)
  if (usedUsd >= cap) {
    if (policy === 'block') {
      throw new CostCapExceededError(orgId, usedUsd, cap, policy)
    } else {
      // warn-only — log + let through so admin sees the alert without breaking UX
      console.warn(`[costCap] org=${orgId} OVER (warn-only): used $${usedUsd.toFixed(4)} cap $${cap}`)
    }
  }
}

/**
 * Rough cost estimate for an LLM call when the upstream service didn't
 * report exact tokens used. Used by the Python-bound surfaces
 * (extract_obligations, renewal_advice) so we can still track spend
 * even though the cost data isn't echoed back.
 *
 * Heuristic: 1 token ≈ 4 chars (English). $0.000005 per token blended
 * (rough Sonnet 4.5 pricing for input + output). Yields roughly the
 * right order of magnitude for an extract pass on a 30-page contract.
 */
export function estimateCostUsd(charCount: number, multiplierForOutput = 1.5): number {
  const inputTokens = Math.ceil(charCount / 4)
  const outputTokens = Math.ceil(inputTokens * 0.1) // ~10% of input for output
  const blended = (inputTokens + outputTokens * multiplierForOutput) * 0.000005
  return Math.round(blended * 1_000_000) / 1_000_000
}

/**
 * Atomically add a USD cost increment to the org's daily counter.
 * Sets the bucket TTL to 48h on first increment so end-of-day rolls cleanly.
 */
export async function recordCost(orgId: string, costUsd: number): Promise<number> {
  if (costUsd <= 0) return getDailyCost(orgId)
  const key = bucketKey(orgId)
  const internalDelta = Math.round(costUsd * USD_TO_INTERNAL)
  const newInternal = await redis.incrby(key, internalDelta)
  // Set TTL on first write; harmless if already set
  if (newInternal === internalDelta) {
    await redis.expire(key, 60 * 60 * 48)
  }
  return newInternal / USD_TO_INTERNAL
}

/**
 * What an AI call was, for the admin usage dashboard.
 *
 * `provider` and `model` come back from the agents service in its response
 * body, so callers pass what actually ran rather than what was configured.
 */
export interface UsageDetail {
  provider:      string
  model:         string
  tier:          string
  /** null for raw completions that aren't a named agent tool. */
  toolName?:     string | null
  inputChars?:   number
  outputChars?:  number
  /** BYOK calls are the org's own spend and don't count toward the platform cap. */
  isByok?:       boolean
}

/**
 * Record an AI call: increment the daily cap counter AND persist a row for the
 * admin usage dashboard.
 *
 * `GET /admin/ai/usage` aggregates OrgUsageDaily, but nothing ever wrote to it,
 * so the panel reported $0.00 / 0 tokens forever regardless of real traffic —
 * silently wrong, which is worse than empty. This is the writer.
 *
 * Fire-and-forget by design: it runs after the response has been streamed, so a
 * database hiccup must never turn a served request into an error. Both halves
 * swallow their own failures.
 */
export async function recordUsage(
  orgId: string,
  costUsd: number,
  detail: UsageDetail,
): Promise<void> {
  const isByok = detail.isByok ?? false
  // BYOK spend is the org's own; it must not consume the platform cap.
  if (!isByok) {
    await recordCost(orgId, costUsd).catch(() => {})
  }

  const inputTokens  = Math.ceil((detail.inputChars ?? 0) / 4)
  const outputTokens = Math.ceil((detail.outputChars ?? 0) / 4)
  const date = new Date().toISOString().slice(0, 10)

  // toolName is part of the unique key, and Postgres treats NULLs as distinct
  // in a unique index — so a null would create a new row on every call instead
  // of accumulating. Use a sentinel for "not a named tool".
  const toolName = detail.toolName ?? '-'

  await prisma.orgUsageDaily.upsert({
    where: {
      orgId_date_provider_model_tier_toolName_isByok: {
        orgId, date, provider: detail.provider, model: detail.model,
        tier: detail.tier, toolName, isByok,
      },
    },
    update: {
      inputTokens:  { increment: inputTokens },
      outputTokens: { increment: outputTokens },
      costUsd:      { increment: costUsd },
      callCount:    { increment: 1 },
    },
    create: {
      orgId, date, provider: detail.provider, model: detail.model,
      tier: detail.tier, toolName, isByok,
      inputTokens, outputTokens, costUsd, callCount: 1,
    },
  }).catch(() => { /* usage reporting must never break a served request */ })
}

/** Read-only: USD spent today by the org (platform-paid only). */
export async function getDailyCost(orgId: string): Promise<number> {
  const raw = await redis.get(bucketKey(orgId))
  return raw ? Number(raw) / USD_TO_INTERNAL : 0
}

/** Admin/test-only: zero out the org's daily counter + cap config cache. */
export async function resetDailyCost(orgId: string): Promise<void> {
  await redis.del(bucketKey(orgId))
  await redis.del(`cost-cap-config:${orgId}`)
}

/**
 * Invalidate the cap-config cache without touching the day's spend.
 * Called by the admin PUT /settings endpoint so a cap change takes effect
 * on the very next call instead of waiting for the 30s TTL to roll.
 */
export async function invalidateCapConfig(orgId: string): Promise<void> {
  await redis.del(`cost-cap-config:${orgId}`)
}

/** Snapshot for the AI Config UI / cap-status badge. */
export async function getCostCapStatus(orgId: string): Promise<{
  usedUsd: number
  capUsd: number
  remainingUsd: number
  pctUsed: number
  policy: 'block' | 'warn'
  date: string
}> {
  const [usedUsd, { cap, policy }] = await Promise.all([
    getDailyCost(orgId),
    resolveCap(orgId),
  ])
  return {
    usedUsd: Number(usedUsd.toFixed(6)),
    capUsd: cap,
    remainingUsd: Math.max(0, Number((cap - usedUsd).toFixed(6))),
    pctUsed: cap > 0 ? Math.min(1, usedUsd / cap) : 0,
    policy,
    date: todayKey(),
  }
}
