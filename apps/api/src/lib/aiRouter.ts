/**
 * AI Provider Router (D.0.3)
 *
 * Resolves "which model + key should I use for this org's tier-X call?"
 *
 * Resolution order:
 *   1. Look up OrgAiSettings.<tier>Model (admin override). If unset, use
 *      the platform default for that tier.
 *   2. For the chosen provider:
 *        a. Look up OrgAiKey for (org, provider). If present + active,
 *           decrypt it and return the key with source='byok'.
 *        b. Else fall back to the platform env key for that provider.
 *           Return source='platform'.
 *   3. If the chosen provider has neither BYOK nor platform key, try the
 *      next tier candidate. Repeat.
 *   4. If all tier candidates exhaust, throw NoProviderAvailable.
 *
 * Used by:
 *   - The Python agents service via POST /api/internal/ai/resolve
 *     (D.0.4 will register this route)
 *   - Any future Node-side AI call (e.g., LLM-as-reranker workaround)
 *
 * Decryption is lazy + per-call — we never cache plaintext keys.
 */
import { prisma } from './prisma.js'
import { decrypt } from './encryption.js'
import { assertCostCapNotExceeded } from './costCap.js'

// ─── Tier definitions ────────────────────────────────────────────────────────
// Each tier is an ordered list of (provider, model) candidates. The router
// walks the list and uses the first one that has a key available.
//
// Today (OpenAI-only platform keys), every tier resolves to its OpenAI
// candidate. When the platform adds an Anthropic key (or an org adds BYOK),
// the corresponding higher-priority candidates become eligible.

export type Tier = 'reasoning' | 'default' | 'fast' | 'embed' | 'rerank' | 'vision_ocr'
export type Source = 'platform' | 'byok'

interface Candidate {
  provider: string
  model: string
}

const PLATFORM_TIER_DEFAULTS: Record<Tier, Candidate[]> = {
  reasoning: [
    { provider: 'anthropic', model: 'claude-opus-4-7' },
    { provider: 'openai',    model: 'gpt-5' },
    { provider: 'openai',    model: 'gpt-4.1' }, // reliable fallback if gpt-5 unavailable on the account
    { provider: 'google',    model: 'gemini-2.5-flash' },
  ],
  default: [
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    { provider: 'openai',    model: 'gpt-4.1' },
    { provider: 'google',    model: 'gemini-2.5-flash' },
  ],
  fast: [
    { provider: 'anthropic', model: 'claude-haiku-4-5' },
    { provider: 'openai',    model: 'gpt-4.1-mini' },
    { provider: 'google',    model: 'gemini-2.5-flash' },
  ],
  embed: [
    { provider: 'voyage', model: 'voyage-law-2' },
    { provider: 'openai', model: 'text-embedding-3-large' },
    { provider: 'google', model: 'gemini-embedding-001' },
  ],
  rerank: [
    { provider: 'voyage', model: 'voyage-rerank-2.5' },
    { provider: 'cohere', model: 'rerank-english-v3.0' },
    // LLM-as-reranker workaround until a dedicated reranker key arrives:
    { provider: 'openai', model: 'gpt-4.1-mini' },
  ],
  vision_ocr: [
    { provider: 'mistral', model: 'mistral-ocr-3' },
    { provider: 'openai',  model: 'gpt-4.1' }, // GPT-4.1 has vision
  ],
}

// ─── Platform env keys (read once on import, refreshed on demand) ────────────

// Sentinel values that operators seed into Secret Manager when they don't
// have a real key for a provider. Treat them as missing so the router falls
// through to the next tier candidate instead of handing a garbage key to
// the upstream API and 401-ing the user.
const PLACEHOLDER_VALUES = new Set(['', 'placeholder', 'REPLACE', 'TODO', 'unset'])

function platformKey(provider: string): string | undefined {
  let raw: string | undefined
  switch (provider) {
    case 'openai':    raw = process.env.OPENAI_API_KEY;    break
    case 'anthropic': raw = process.env.ANTHROPIC_API_KEY; break
    case 'google':    raw = process.env.GOOGLE_API_KEY;    break
    case 'voyage':    raw = process.env.VOYAGE_API_KEY;    break
    case 'cohere':    raw = process.env.COHERE_API_KEY;    break
    case 'mistral':   raw = process.env.MISTRAL_API_KEY;   break
    default:          return undefined
  }
  if (!raw) return undefined
  if (PLACEHOLDER_VALUES.has(raw.trim())) return undefined
  return raw
}

// ─── Per-org override + BYOK lookups ─────────────────────────────────────────

const TIER_FIELD: Record<Tier, keyof OrgAiSettingsShape> = {
  reasoning:  'reasoningModel',
  default:    'defaultModel',
  fast:       'fastModel',
  embed:      'embedModel',
  rerank:     'rerankModel',
  vision_ocr: 'visionOcrModel',
}

interface OrgAiSettingsShape {
  reasoningModel: string | null
  defaultModel: string | null
  fastModel: string | null
  embedModel: string | null
  rerankModel: string | null
  visionOcrModel: string | null
}

async function getOrgOverride(orgId: string, tier: Tier): Promise<Candidate | null> {
  const settings = await prisma.orgAiSettings.findUnique({
    where: { orgId },
    select: {
      reasoningModel: true, defaultModel: true, fastModel: true,
      embedModel: true, rerankModel: true, visionOcrModel: true,
    },
  })
  if (!settings) return null
  const raw = settings[TIER_FIELD[tier]]
  if (!raw) return null
  // Format: "provider/model"
  const [provider, model] = raw.split('/', 2)
  if (!provider || !model) return null
  return { provider, model }
}

async function getByokKey(orgId: string, provider: string): Promise<string | null> {
  const row = await prisma.orgAiKey.findUnique({
    where: { orgId_provider: { orgId, provider } },
  })
  if (!row || !row.isActive) return null
  try {
    return decrypt(row.encryptedKey)
  } catch (err) {
    // Bad ciphertext (e.g., master key rotated without re-encrypt) — treat as missing.
    // Logged so an admin can investigate; we don't block on it.
    console.error(`[aiRouter] BYOK decrypt failed for org=${orgId} provider=${provider}: ${(err as Error).message}`)
    return null
  }
}

// ─── Public resolver ─────────────────────────────────────────────────────────

export interface ResolvedLlm {
  provider: string
  model: string
  apiKey: string
  /** Whether the key came from the org's BYOK or the platform env */
  source: Source
  tier: Tier
}

export class NoProviderAvailable extends Error {
  constructor(public tier: Tier, public attempted: Candidate[]) {
    super(`No provider available for tier="${tier}". Tried: ${attempted.map(c => `${c.provider}/${c.model}`).join(', ')}`)
    this.name = 'NoProviderAvailable'
  }
}

/**
 * Resolve the best-available (provider, model, apiKey) for the given org + tier.
 *
 * Pure function modulo DB reads — does not mutate any state. Plaintext key is
 * returned ONLY in the response object; never logged, never cached.
 */
export async function resolveLlm(orgId: string, tier: Tier): Promise<ResolvedLlm> {
  const override = await getOrgOverride(orgId, tier)
  const candidates = override ? [override] : PLATFORM_TIER_DEFAULTS[tier]

  for (const cand of candidates) {
    // BYOK first (org owns the cost / rate limit — cost cap doesn't apply)
    const byokKey = await getByokKey(orgId, cand.provider)
    if (byokKey) {
      return { ...cand, apiKey: byokKey, source: 'byok', tier }
    }
    // Else platform key — guarded by daily cost cap (D.0.5)
    const platKey = platformKey(cand.provider)
    if (platKey) {
      // Throws CostCapExceededError under 'block' policy; logs under 'warn'
      await assertCostCapNotExceeded(orgId)
      return { ...cand, apiKey: platKey, source: 'platform', tier }
    }
    // No key for this provider — try the next candidate
  }
  throw new NoProviderAvailable(tier, candidates)
}

// ─── Startup configuration check ─────────────────────────────────────────────

// Set at boot by assertRouterConfigured(). When false, no platform key is
// configured for the critical tiers and AI features should degrade (503)
// rather than 500 — but the app still boots so auth / browse / upload /
// manage all work keyless, matching the README's "boots with no API key".
let _aiConfigured = false
export function isAiConfigured(): boolean {
  return _aiConfigured
}

/**
 * At server boot, log the resolved routing for each tier (using the platform
 * defaults — no org context).
 *
 * Wave 0.4 (2026-07): this used to THROW when a critical tier (default, fast)
 * had no platform key, which crash-looped the API before the login screen and
 * contradicted the README ("The app boots with no API key"). It now logs a
 * loud warning and lets the app boot; AI features check isAiConfigured() and
 * return 503 until a key is set. Orgs can still BYOK per-org at runtime.
 */
export function assertRouterConfigured(): void {
  const critical: Tier[] = ['default', 'fast']
  const lines: string[] = []
  const missingCritical: Tier[] = []
  for (const tier of Object.keys(PLATFORM_TIER_DEFAULTS) as Tier[]) {
    const candidates = PLATFORM_TIER_DEFAULTS[tier]
    const winner = candidates.find(c => platformKey(c.provider))
    if (winner) {
      lines.push(`  ${tier.padEnd(11)} → ${winner.provider}/${winner.model}`)
    } else if (critical.includes(tier)) {
      missingCritical.push(tier)
      lines.push(`  ${tier.padEnd(11)} → (no platform key — AI disabled until a key is set)`)
    } else {
      lines.push(`  ${tier.padEnd(11)} → (no platform key — orgs must BYOK)`)
    }
  }
  console.info('[aiRouter] platform routing table:\n' + lines.join('\n'))
  _aiConfigured = missingCritical.length === 0
  if (!_aiConfigured) {
    console.warn(
      `[aiRouter] ⚠ No platform key for critical tier(s): ${missingCritical.join(', ')}. ` +
      `The app boots and all non-AI features (auth, browse, upload, manage contracts) ` +
      `work normally, but AI features return 503 until you set one of ` +
      `GOOGLE_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY in apps/api/.env and restart. ` +
      `See the README "Quickstart".`
    )
  }
}

// ─── Internal helpers exposed for the REST endpoint (D.0.4) + tests ─────────

export const __internal = {
  PLATFORM_TIER_DEFAULTS,
  platformKey,
  getOrgOverride,
  getByokKey,
}
