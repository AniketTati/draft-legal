/**
 * PII policy helpers (P7.5.1).
 *
 * Wraps `redactPii` with org-level policy lookup + audit-log write.
 * Call this at every boundary where document text leaves our trust
 * zone (i.e. before being sent to an LLM / 3rd-party API).
 *
 * Usage pattern:
 *   const { text, counts } = await applyPiiPolicy(orgId, plainText, {
 *     contractId, surface: 'extract_obligations',
 *   })
 *   await fetch(agentsUrl, { body: JSON.stringify({ plainText: text }) })
 */
import { prisma } from './prisma.js'
import { redactPii, pseudonym, type PiiMode, type PiiKind } from './pii-redactor.js'
import { createAuditEvent } from './audit.js'
import { AuditAction } from '@clm/types'

/** Cache org settings so we don't re-fetch on every LLM call. */
const orgModeCache = new Map<string, { mode: PiiMode; expires: number }>()
const CACHE_TTL_MS = 60_000

export async function getOrgPiiMode(orgId: string): Promise<PiiMode> {
  const cached = orgModeCache.get(orgId)
  if (cached && cached.expires > Date.now()) return cached.mode

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { settings: true },
  })
  const raw = (org?.settings as { piiRedactionMode?: string } | null)?.piiRedactionMode
  // Default flipped to 'redact' for production launch (2026-04-29).
  // Previously 'off', which silently sent SSNs / credit cards / DOBs
  // verbatim to OpenAI. CLM contracts routinely contain PII
  // (employment agreements, healthcare BAAs, financial covenants);
  // the launch posture is privacy-by-default. Orgs that explicitly
  // need raw text (e.g. for extraction quality on government IDs)
  // can set settings.piiRedactionMode = 'off' through the admin
  // panel — opt-out, not opt-in.
  const mode: PiiMode =
    raw === 'redact' || raw === 'tokenize' || raw === 'off'
      ? (raw as PiiMode)
      : 'redact'

  orgModeCache.set(orgId, { mode, expires: Date.now() + CACHE_TTL_MS })
  return mode
}

/**
 * X23 — tokenize mode's pseudonyms, scoped to the org: under one global key
 * the same SSN became the same token in every org's prompts, linking them.
 */
function orgToken(orgId: string, mode: PiiMode): ((kind: PiiKind, value: string) => string) | undefined {
  return mode === 'tokenize' ? (kind, value) => `[PII:${kind}:${pseudonym(`${orgId}\u0000${value}`)}]` : undefined
}

export interface ApplyOptions {
  /** Arbitrary surface label so audit logs can group by call-site. */
  surface: string
  /** When the redaction is for a specific contract. */
  contractId?: string
  /** When the call is on behalf of a specific user. */
  userId?: string
  /** Override the org's policy (e.g. force-redact for a specific path). */
  override?: PiiMode
  /**
   * X23 — `redactJson` only. For text whose model output is stored or spliced
   * into a contract: each value becomes a token scoped to this key (the
   * contract's or the request's id), in either mode, so `restorePii` can put
   * it back.
   */
  roundTrip?: string
  /**
   * X23 — `redactJson` with `roundTrip` only: the text whose personal data is
   * replaced, wherever it appears (default: the value's own strings). Pass
   * the whole document: a card number is only recognised near a word like
   * "card", and a clause or excerpt alone often lacks it.
   */
  valuesFrom?: unknown
}

export interface ApplyResult {
  text: string
  mode: PiiMode
  counts: Partial<Record<PiiKind, number>>
  total: number
}

export async function applyPiiPolicy(
  orgId: string,
  text: string,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const mode: PiiMode = opts.override ?? await getOrgPiiMode(orgId)
  if (mode === 'off') {
    return { text, mode, counts: {}, total: 0 }
  }
  const result = redactPii(text, mode, { token: orgToken(orgId, mode) })
  // Only emit an audit event if anything was actually redacted.
  // Otherwise this would spam the log on every text-free call.
  if (result.total > 0) {
    // Fire-and-forget: don't block the LLM call on the audit write.
    createAuditEvent({
      orgId,
      userId: opts.userId,
      action: AuditAction.PII_REDACTED,
      resourceType: opts.contractId ? 'contract' : 'request',
      resourceId: opts.contractId ?? 'system',
      metadata: {
        surface: opts.surface,
        mode,
        counts: result.counts,
        total: result.total,
      },
    }).catch((err: unknown) => {
      // Audit log failure shouldn't break the request — but log it.
      console.error('[pii-policy] failed to write audit event:', err)
    })
  }
  return { text: result.text, mode, counts: result.counts, total: result.total }
}

/**
 * Redact a batch of excerpts under one policy read and ONE audit event.
 *
 * The search and comparison tools return many excerpts per call — a portfolio
 * search over 20 contracts, a 10x10 comparison matrix. Calling applyPiiPolicy
 * per excerpt would read the policy 20 times and write 20 `PII_REDACTED` audit
 * rows for what is, from the user's point of view, a single action. That buries
 * the audit trail it exists to provide.
 *
 * Returns the redacted texts in input order, plus the combined counts.
 */
export async function applyPiiPolicyBatch(
  orgId: string,
  texts: string[],
  opts: ApplyOptions,
): Promise<{ texts: string[]; mode: PiiMode; counts: Partial<Record<PiiKind, number>>; total: number }> {
  const mode: PiiMode = opts.override ?? await getOrgPiiMode(orgId)
  if (mode === 'off' || texts.length === 0) {
    return { texts, mode, counts: {}, total: 0 }
  }

  const counts: Partial<Record<PiiKind, number>> = {}
  let total = 0
  const token = orgToken(orgId, mode)
  const out = texts.map(t => {
    const r = redactPii(t ?? '', mode, { token })
    for (const [kind, n] of Object.entries(r.counts)) {
      counts[kind as PiiKind] = (counts[kind as PiiKind] ?? 0) + (n ?? 0)
    }
    total += r.total
    return r.text
  })

  if (total > 0) {
    createAuditEvent({
      orgId,
      userId: opts.userId,
      action: AuditAction.PII_REDACTED,
      resourceType: opts.contractId ? 'contract' : 'request',
      resourceId: opts.contractId ?? 'system',
      metadata: { surface: opts.surface, mode, counts, total, excerpts: texts.length },
    }).catch((err: unknown) => {
      console.error('[pii-policy] failed to write audit event:', err)
    })
  }
  return { texts: out, mode, counts, total }
}

/** Test/admin helper: clear the cache when an org's setting changes. */
export function clearOrgPiiModeCache(orgId?: string): void {
  if (orgId) orgModeCache.delete(orgId)
  else orgModeCache.clear()
}

// ─── X23 — round trips ───────────────────────────────────────────────────────
//
// Much of what the models send back is stored or spliced into the contract:
// the extraction's verbatim clause text, a draft, a redline. A `[REDACTED:SSN]`
// there would replace the real value, and the clause would no longer match
// the document it came from. So those paths send tokens instead — keyed (the
// model can't reverse them) and scoped to one contract (they don't link one
// contract's values to another's) — and put the values back in what returns.
//
// Values are found in a source text (ideally the whole document) and then
// replaced exactly, wherever they occur: pattern-matching each string on its
// own misses a card number whose "card" is in another sentence.

// A round-trip token, read leniently (a model may change the hex's case).
const TOKEN_RX = /\[PII:([A-Za-z_]+):([0-9a-fA-F]{16})\]/g
// Anything placeholder-shaped: a token however mangled (brackets dropped or
// escaped, cut short), a tokenize-mode pseudonym, or redact mode's marker.
const PLACEHOLDER_RX = /PII:[A-Za-z_]+:[0-9a-fA-F]{4,}|\[REDACTED:[A-Za-z_]+\]/g

function roundTripToken(scope: string) {
  return (kind: PiiKind, value: string) => `[PII:${kind}:${pseudonym(`${scope}\u0000${value}`, 16)}]`
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach(x => strings(x, out))
  else if (v && typeof v === 'object' && !(v instanceof Date)) Object.values(v).forEach(x => strings(x, out))
  return out
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map(x => mapStrings(x, f))
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]))
  return v
}

/** Every value in `source` the policy covers, with its round-trip token and kind. */
function roundTripValues(source: unknown, scope: string): Map<string, { token: string; kind: PiiKind }> {
  const values = new Map<string, { token: string; kind: PiiKind }>()
  const token = roundTripToken(scope)
  for (const s of strings(source)) {
    redactPii(s, 'redact', { token: (kind, v) => { const t = token(kind, v); values.set(v, { token: t, kind }); return t } })
  }
  return values
}

/**
 * The org's policy over every string in a JSON value (a request body, a tool
 * result), under one policy read and one audit row. Ids and enums can't match
 * a PII pattern, so walking every string is safe. With `roundTrip`, the
 * values of `valuesFrom` become restorable tokens wherever they appear.
 */
export async function redactJson<T>(orgId: string, value: T, opts: ApplyOptions): Promise<T> {
  if (!opts.roundTrip) {
    const redacted = await applyPiiPolicyBatch(orgId, strings(value), opts)
    if (redacted.total === 0) return value
    let i = 0
    return mapStrings(value, () => redacted.texts[i++]) as T
  }

  const mode: PiiMode = opts.override ?? await getOrgPiiMode(orgId)
  if (mode === 'off') return value
  const values = roundTripValues(opts.valuesFrom === undefined ? value : opts.valuesFrom, opts.roundTrip)
  if (values.size === 0) return value
  // One pass, longest value first: a value inside a longer one doesn't split
  // it, and a token already written is never scanned again.
  const rx = new RegExp(
    [...values.keys()].sort((a, b) => b.length - a.length).map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  )
  const counts: Partial<Record<PiiKind, number>> = {}
  const out = mapStrings(value, s => s.replace(rx, m => {
    const hit = values.get(m)!
    counts[hit.kind] = (counts[hit.kind] ?? 0) + 1
    return hit.token
  })) as T
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)
  if (total > 0) {
    createAuditEvent({
      orgId,
      userId: opts.userId,
      action: AuditAction.PII_REDACTED,
      resourceType: opts.contractId ? 'contract' : 'request',
      resourceId: opts.contractId ?? 'system',
      metadata: { surface: opts.surface, mode, counts, total, roundTrip: true },
    }).catch((err: unknown) => {
      console.error('[pii-policy] failed to write audit event:', err)
    })
  }
  return out
}

/**
 * Put back the values that round-trip tokens stand for. The map is rebuilt
 * from `source` (the text that was sent, or the document it came from), so
 * only a value that is in the source comes back; any other token, or one two
 * values would share, stays as it is (see `unresolvedPiiTokens`).
 * Independent of the org's current mode.
 */
export function restorePii<T>(value: T, source: unknown, scope: string): T {
  if (!strings(value).some(s => s.includes('[PII:'))) return value
  return piiRestorer(source, scope)(value)
}

/** `restorePii` with the map built once, for many values against one source (a batch). */
export function piiRestorer(source: unknown, scope: string): <T>(value: T) => T {
  const byToken = new Map<string, string | null>()
  for (const [v, { token }] of roundTripValues(source, scope)) {
    byToken.set(token, byToken.has(token) && byToken.get(token) !== v ? null : v)
  }
  return <T>(value: T): T => {
    if (byToken.size === 0 || !strings(value).some(s => s.includes('[PII:'))) return value
    return mapStrings(value, s => s.includes('[PII:')
      ? s.replace(TOKEN_RX, (t, kind: string, hex: string) => byToken.get(`[PII:${kind.toUpperCase()}:${hex.toLowerCase()}]`) ?? t)
      : s) as T
  }
}

/**
 * Placeholders in `value` that `original` (the text it came from) doesn't
 * itself contain: a round-trip token nothing resolved, one a model mangled,
 * a tokenize-mode pseudonym or redact mode's `[REDACTED:KIND]` that a chat
 * model copied from a tool result. None of them may be written into a
 * contract in place of the value it stands for.
 */
export function unresolvedPiiTokens(value: unknown, original: unknown = []): string[] {
  const originals = strings(original)
  return strings(value)
    .flatMap(s => s.match(PLACEHOLDER_RX) ?? [])
    .filter(p => !originals.some(o => o.includes(p)))
}
