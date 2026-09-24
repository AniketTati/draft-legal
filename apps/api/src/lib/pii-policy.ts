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
import { randomBytes } from 'node:crypto'
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
// escaped, its hex cut short or lost), a tokenize-mode pseudonym, or redact
// mode's marker with or without its kind.
const PLACEHOLDER_RX = /\[?PII:[A-Za-z_]+(?::[0-9a-fA-F]*)?\]?|\[REDACTED(?::[A-Za-z_]+)?\]/g

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

/**
 * X27 — `restorePii` over a stream of text pieces (an NDJSON rewrite). A
 * token can be split across pieces, so a tail that could still become one is
 * held back until the next piece, or `flush()`.
 */
export function streamRestorer(source: unknown, scope: string): { push(text: string): string; flush(): string } {
  const restore = piiRestorer(source, scope)
  let pending = ''
  return {
    push(text: string): string {
      pending += text
      const open = pending.lastIndexOf('[')
      // A token is at most ~40 chars; an unclosed "[" nearer the end than
      // that may be the start of one.
      const hold = open >= 0 && !pending.includes(']', open) && pending.length - open < 48 ? open : pending.length
      const out = pending.slice(0, hold)
      pending = pending.slice(hold)
      return restore(out)
    },
    flush(): string {
      const out = pending
      pending = ''
      return restore(out)
    },
  }
}

/**
 * X27 — a token cut off at the end of a string (the model's output capped,
 * or the text sliced for a window) is dropped rather than shown or inserted.
 */
export function dropPartialToken<T>(value: T): T {
  return mapStrings(value, s => s.replace(/\[(?:P(?:I(?:I(?::[A-Za-z_]*(?::[0-9a-fA-F]{0,16})?)?)?)?)?$/, '')) as T
}

/**
 * X27 — slice tokenized text without splitting a token: a cut that would land
 * inside one moves to its edge (the start of the window forward past it, the
 * end back before it).
 */
export function sliceOutsideTokens(text: string, start: number, end: number): string {
  let from = Math.max(0, start)
  let to = Math.min(text.length, end)
  for (const m of text.matchAll(TOKEN_RX)) {
    const a = m.index ?? 0
    const b = a + m[0].length
    if (from > a && from < b) from = b
    if (to > a && to < b) to = a
  }
  return from < to ? text.slice(from, to) : ''
}

/**
 * X27 — runs a word-level tool (htmldiff) over tokenized texts with each token
 * standing in as one plain word, then puts the tokens back in its output.
 * htmldiff splits words at ':', so a value changed between two versions came
 * out as `[PII:SSN:<del>1a2b…]</del><ins>9f8e…]</ins>`: neither token whole.
 */
export async function withWholeTokens(texts: string[], fn: (texts: string[]) => string | Promise<string>): Promise<string> {
  const tokens: string[] = []
  const tag = `piitok${randomBytes(6).toString('hex')}x`
  const out = await fn(texts.map(t => t.replace(TOKEN_RX, tok => {
    let i = tokens.indexOf(tok)
    if (i < 0) i = tokens.push(tok) - 1
    return `${tag}${i}x`
  })))
  return out.replace(new RegExp(`${tag}(\\d+)x`, 'g'), (_, i: string) => tokens[Number(i)])
}

/**
 * X27 — HTML with its space entities and every run of whitespace made one
 * plain space, as the extractors make plainText. Word writes a card number as
 * `4111&nbsp;1111…` or with double spaces, which no value found in the plain
 * text matches, so the HTML sent to a model is this one.
 */
export function plainSpacesHtml(html: string): string {
  return html.replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/\s+/g, ' ')
}

/**
 * X27 — the forms of HTML to find values in: the HTML itself, and its text
 * with the tags dropped (joining what markup splits, `123-45-<b>6789</b>`)
 * and as spaces (keeping table cells apart, `<td>Card</td><td>4111…`).
 */
export function htmlTextForms(html: string): string[] {
  const h = plainSpacesHtml(html)
  // `[^<>]`, not `[^>]`: from every `<` with no `>` after it, `[^>]*` scanned
  // to the end of the document (quadratic; X67 review).
  return [h, h.replace(/<[^<>]*>/g, ''), h.replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ')]
}

/**
 * X27 — whether tokenized HTML still shows a value the policy covers once its
 * tags are dropped: one its markup splits, which replacing exact values can't
 * reach.
 */
export function valueLeftInMarkup(html: string): boolean {
  return htmlTextForms(html).slice(1).some(t => redactPii(t, 'redact').total > 0)
}

/**
 * X27 — whether a value the policy covers runs across the join of two
 * tokenized texts (the editor's cursor): neither half matches on its own, so
 * both would go out raw.
 */
export function valueAcross(before: string, after: string): boolean {
  const a = before.slice(-200)
  const b = after.slice(0, 200)
  return redactPii(a + b, 'redact').total > redactPii(a, 'redact').total + redactPii(b, 'redact').total
}

// ─── X36 — pieces cut from longer texts ─────────────────────────────────────
//
// The chat tools send excerpts: the first N characters of a contract, a
// window around a match, a clause's opening. They cut first and redacted each
// excerpt on its own, so a value across a cut went out as a fragment no
// pattern matches (`123-45-6`), and a card number whose "card" was outside
// the excerpt went out whole.

export interface CutText {
  /** The whole text the pieces are cut from. */
  text: string
  /** The pieces, as [start, end) offsets into `text`. */
  cuts: Array<[number, number]>
  /**
   * X40 — a longer text to find values in as well: the document a clause or
   * key term came from, where a card number's "card" may be.
   */
  valuesFrom?: string
}

/** Every value the policy covers in `text`, with its kind. */
function valuesIn(text: string): Map<string, PiiKind> {
  const kinds = new Map<string, PiiKind>()
  redactPii(text, 'redact', { token: (kind, value) => { kinds.set(value, kind); return '' } })
  return kinds
}

/** A regex alternation of `values`, longest first, each matched literally. */
function alternation(values: Iterable<string>): string {
  return [...values].sort((a, b) => b.length - a.length).map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'

/**
 * X40 — whether a value's occurrence at [start, end) is not part of a longer
 * number: a digit at its edge can't touch another digit. So a passport number
 * doesn't take a bite out of an account number, nor a date out of a longer
 * one. Letters may touch: a value can follow its keyword ("passportA1234567").
 * Checked in code rather than as lookarounds in the regex, which would cost
 * V8 its fast literal matching.
 */
function standsAlone(text: string, start: number, end: number): boolean {
  return !(isDigit(text[start]) && isDigit(text[start - 1])) && !(isDigit(text[end - 1]) && isDigit(text[end]))
}

// X40 — the kinds a pattern recognizes only with a keyword nearby (a card, an
// IBAN, a passport number, a date of birth). The rest a piece's own scan
// finds, so only these are worth bringing from its document.
const CONTEXT_KINDS = new Set<PiiKind>(['CC', 'IBAN', 'PASSPORT', 'DOB'])

/** X40 — values found in a document, and a regex that finds them standing alone in a piece of it. */
export interface DocumentValues { kinds: Map<string, PiiKind>; rx: RegExp | null }

export function documentValues(document: string): DocumentValues {
  const kinds = new Map([...valuesIn(document)].filter(([, kind]) => CONTEXT_KINDS.has(kind)))
  return { kinds, rx: kinds.size ? new RegExp(`(?=(${alternation(kinds.keys())}))`, 'g') : null }
}

/**
 * The pieces of `source`, with every value the policy covers found in the
 * whole text and replaced by `placeholder`. A cut that falls inside a value
 * moves to the value's start, so no piece carries part of one.
 */
export function cutAndRedact(
  source: CutText,
  placeholder: (kind: PiiKind, value: string) => string,
  /** Values found in `source.valuesFrom`, when the caller has them already. */
  found: DocumentValues | null = source.valuesFrom ? documentValues(source.valuesFrom) : null,
): { pieces: string[]; counts: Partial<Record<PiiKind, number>> } {
  const { text } = source
  const counts: Partial<Record<PiiKind, number>> = {}
  if (source.cuts.length === 0) return { pieces: [], counts }
  // Every occurrence of every value found in the text, overlapping ones
  // included, in one scan (the lookahead matches, at each position, the
  // longest value starting there)…
  const hits: Array<{ start: number; end: number; kind: PiiKind }> = []
  const kinds = valuesIn(text)
  if (kinds.size) {
    for (const m of text.matchAll(new RegExp(`(?=(${alternation(kinds.keys())}))`, 'g'))) {
      const start = m.index ?? 0
      const end = start + m[1].length
      if (standsAlone(text, start, end)) hits.push({ start, end, kind: kinds.get(m[1])! })
    }
  }
  // …and of each value from the document (X40).
  if (found?.rx) {
    for (const m of text.matchAll(found.rx)) {
      const start = m.index ?? 0
      const end = start + m[1].length
      if (standsAlone(text, start, end)) hits.push({ start, end, kind: found.kinds.get(m[1])! })
    }
  }
  // Merged where they overlap: a merged run is replaced whole, so an overlap
  // can't leave part of a value behind.
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const runs: Array<{ start: number; end: number; kind: PiiKind }> = []
  for (const hit of hits) {
    const last = runs[runs.length - 1]
    if (last && hit.start < last.end) last.end = Math.max(last.end, hit.end)
    else runs.push({ ...hit })
  }
  // The first run that ends after `p` (runs are sorted and disjoint).
  const firstEndingAfter = (p: number): number => {
    let lo = 0
    let hi = runs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (runs[mid].end <= p) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  // A cut strictly inside a run moves to the run's start.
  const snap = (p: number): number => {
    const q = Math.max(0, Math.min(text.length, p))
    const run = runs[firstEndingAfter(q)]
    return run && run.start < q ? run.start : q
  }
  const pieces = source.cuts.map(([a, b]) => {
    const from = snap(a)
    const to = snap(b)
    let out = ''
    let at = from
    for (let i = firstEndingAfter(from); i < runs.length && runs[i].start < to; i++) {
      const run = runs[i]
      out += text.slice(at, run.start) + placeholder(run.kind, text.slice(run.start, run.end))
      counts[run.kind] = (counts[run.kind] ?? 0) + 1
      at = run.end
    }
    return to > from ? out + text.slice(at, to) : ''
  })
  return { pieces, counts }
}

/**
 * X36 — the org's policy over pieces cut from longer texts (see
 * `cutAndRedact`), under one policy read and one audit row. `null` sources
 * come back `null`, so callers keep their positions.
 */
export async function redactCuts(
  orgId: string,
  sources: Array<CutText | null>,
  opts: ApplyOptions,
): Promise<{ pieces: Array<string[] | null>; mode: PiiMode; counts: Partial<Record<PiiKind, number>>; total: number }> {
  const mode: PiiMode = opts.override ?? await getOrgPiiMode(orgId)
  if (mode === 'off') {
    return { pieces: sources.map(src => src && src.cuts.map(([a, b]) => src.text.slice(Math.max(0, a), b))), mode, counts: {}, total: 0 }
  }
  const placeholder = orgToken(orgId, mode) ?? ((kind: PiiKind) => `[REDACTED:${kind}]`)
  const counts: Partial<Record<PiiKind, number>> = {}
  // Each document is searched once, however many pieces come from it.
  const byDocument = new Map<string, DocumentValues>()
  const foundIn = (document: string | undefined): DocumentValues | null => {
    if (!document) return null
    let found = byDocument.get(document)
    if (!found) byDocument.set(document, found = documentValues(document))
    return found
  }
  const out = sources.map(src => {
    if (!src) return null
    const r = cutAndRedact(src, placeholder, foundIn(src.valuesFrom))
    for (const [kind, n] of Object.entries(r.counts)) counts[kind as PiiKind] = (counts[kind as PiiKind] ?? 0) + (n ?? 0)
    return r.pieces
  })
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)
  if (total > 0) {
    createAuditEvent({
      orgId,
      userId: opts.userId,
      action: AuditAction.PII_REDACTED,
      resourceType: opts.contractId ? 'contract' : 'request',
      resourceId: opts.contractId ?? 'system',
      metadata: { surface: opts.surface, mode, counts, total, excerpts: out.reduce((n, p) => n + (p?.length ?? 0), 0) },
    }).catch((err: unknown) => {
      console.error('[pii-policy] failed to write audit event:', err)
    })
  }
  return { pieces: out, mode, counts, total }
}

/**
 * X40 — the org's policy over a JSON value taken from a document (key
 * terms): every string, with values also found in the document, so a card
 * number whose "card" is elsewhere in the contract is caught. Checked one
 * string at a time, a key term like `{ payment: '4111 1111 1111 1111' }`
 * went out whole. One policy read, one audit row.
 */
export async function redactJsonAgainst<T>(orgId: string, value: T, document: string, opts: ApplyOptions): Promise<T> {
  const list = strings(value)
  if (list.length === 0) return value
  const { pieces } = await redactCuts(orgId, list.map(text => ({ text, cuts: [[0, text.length]], valuesFrom: document })), opts)
  let i = 0
  return mapStrings(value, () => pieces[i++]?.[0] ?? '[text withheld: PII redaction unavailable]') as T
}
