/**
 * Apply proposed clause language — splice a rewrite into the document and land
 * it as a new ContractVersion.
 *
 * Extracted out of internal-ai's /tools/redline_apply so a user-facing endpoint
 * can reuse it. That route sits behind the x-internal-secret hook and was only
 * reachable through the agent-thread apply flow, which hard-fails without an
 * existing conversation — so a reviewer looking at proposed language in the
 * review drawer had no way to apply it.
 *
 * Reversible: undo flips currentVersionId back and annotates the reverted
 * version's changeNote; the row itself stays as an audit trail.
 */
import { prisma } from './prisma.js'
import { htmlBlocks } from './ooxml/html-blocks.js'
import { lockOf, lockedBody } from './external-edit.js'
import { statusAfterTermsChange } from './contract-status.js'
import { restorePii, piiRestorer, unresolvedPiiTokens } from './pii-policy.js'
import { afterEdit } from './version-refresh.js'
import { recordStatusChange } from './status-change.js'

/**
 * Minimal HTML escape for splicing text into contract HTML.
 *
 * Deliberately escapes ONLY & < > — do not "improve" this by adding quote
 * escaping. It is used to MATCH existing stored content
 * (htmlContent.replace(escapeHtml(before), …)); escaping more characters than
 * the stored HTML contains makes the match miss, and the splice then silently
 * falls through to appending an amendment block instead of replacing the clause.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** How the clause text was located in the document body. */
export type MatchMode = 'exact' | 'escaped' | 'normalized' | 'edits' | 'none'

export interface ApplyClauseArgs {
  orgId:        string
  userId:       string
  contractId:   string
  clauseId:     string
  proposedText: string
  aggression?:  string
  rationale?:   string
  changes?:     Array<{ before: string; after: string; reason?: string }>
  /**
   * Opt in to appending the proposal as an amendment when the clause text
   * cannot be located. Off by default: appending turns a confirmed clause
   * REPLACEMENT into an addendum, which is a different legal instrument, and
   * doing that silently is how a user ends up with a document they never
   * agreed to. The caller must ask for it.
   */
  allowAppendFallback?: boolean
}

export interface ApplyClausePayload {
  ok:                true
  reversible:        true
  contractId:        string
  previousVersionId: string
  newVersionId:      string
  newVersionNumber:  number
  clauseId:          string
  /** true only when BOTH htmlContent and plainText were spliced. */
  spliced:           boolean
  /** How the text was located — 'none' means it was appended instead. */
  matchMode:         MatchMode
  diff:              Array<{ field: string; before: unknown; after: unknown }>
}

export type ApplyClauseResult =
  | { ok: true;  data: ApplyClausePayload }
  | { ok: false; status: number; detail: string; code?: string }

// ─── Locating the clause text ────────────────────────────────────────────────

/**
 * Formatting inside a paragraph. A clause's text runs straight through it
 * ("within <em>fifteen (15)</em> days", a bold defined term), and treating
 * the tags as text meant no clause with any formatting was ever found.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'del', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'q',
  's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var',
])
const TAG_AT = /^<(\/?)([a-z][a-z0-9]*)\b[^<>]*>/i

/**
 * The HTML that replaces [start, end) of `body` with `text`, keeping the tags
 * around it balanced: formatting that closes inside the span is closed before
 * the new text, and formatting that opens inside it is reopened after, so
 * the text on either side keeps its own. Line breaks stay line breaks where
 * the span had them.
 */
function htmlReplacement(body: string, start: number, end: number, text: string): string {
  const span = body.slice(start, end)
  const lined = /<br\s*\/?>/i.test(span)
  const opened: Array<{ name: string; tag: string }> = []
  const closedEarly: string[] = []
  for (const m of span.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^<>]*>/gi)) {
    const name = m[2].toLowerCase()
    if (!INLINE_TAGS.has(name)) continue
    if (!m[1]) { opened.push({ name, tag: m[0] }); continue }
    const at = opened.map(o => o.name).lastIndexOf(name)
    if (at >= 0) opened.splice(at, 1)
    else closedEarly.push(`</${name}>`)
  }
  // A rewrite's own line breaks stay line breaks, as do the span's.
  const escaped = lined || /\n/.test(text.trim()) ? escapeHtml(text.trim()).replace(/\r?\n/g, '<br />') : escapeHtml(text)
  return closedEarly.join('') + escaped + opened.map(o => o.tag).join('')
}

/** Entity spellings that mean the same character as far as a match is concerned. */
const ENTITIES: Array<[string, string]> = [
  ['&nbsp;', ' '], ['&amp;', '&'], ['&lt;', '<'],
  ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"],
]

/**
 * Normalize a body for comparison while recording, for every normalized
 * character, the span in the ORIGINAL string that produced it — so a match
 * found in normalized space can still be spliced exactly.
 *
 * Collapses the things that legitimately differ between the extracted clause
 * row and the stored HTML without changing the legal text: entity spellings,
 * non-breaking spaces, smart quotes, and the whitespace runs the editor's
 * autosave reflow introduces.
 */
function normalizeWithMap(s: string, html = false, flatten = false): { norm: string; start: number[]; end: number[] } {
  const out: string[] = []
  const start: number[] = []
  const end: number[] = []
  let i = 0
  let lastWasSpace = false

  const push = (ch: string, from: number, to: number) => {
    out.push(ch); start.push(from); end.push(to)
  }

  while (i < s.length) {
    // In HTML, formatting inside a paragraph is not text. `flatten` reads
    // every other tag as a space: for finding a region that spans paragraphs,
    // never for a span to replace.
    if (html && s[i] === '<') {
      const tag = TAG_AT.exec(s.slice(i, i + 300))
      if (tag && INLINE_TAGS.has(tag[2].toLowerCase())) { i += tag[0].length; continue }
      if (tag && flatten) {
        if (!lastWasSpace) { push(' ', i, i + tag[0].length); lastWasSpace = true }
        else { end[end.length - 1] = i + tag[0].length }
        i += tag[0].length
        continue
      }
    }
    // In HTML, a line break inside a paragraph is whitespace: an extracted
    // clause spanning lines ("9. LIMITATION…\n9.1 …") is stored as
    // "…<br />9.1 …" and never matched. Paragraph boundaries are not crossed:
    // a splice across them would leave unbalanced tags.
    if (html && s[i] === '<' && /^<br\s*\/?>/i.test(s.slice(i, i + 6))) {
      const close = s.indexOf('>', i)
      if (!lastWasSpace) { push(' ', i, close + 1); lastWasSpace = true }
      else { end[end.length - 1] = close + 1 }
      i = close + 1
      continue
    }
    if (s[i] === '&') {
      const ent = ENTITIES.find(([e]) => s.startsWith(e, i))
      if (ent) {
        const [text, repl] = ent
        if (repl === ' ') {
          if (!lastWasSpace) { push(' ', i, i + text.length); lastWasSpace = true }
          else { end[end.length - 1] = i + text.length }
        } else {
          push(repl, i, i + text.length); lastWasSpace = false
        }
        i += text.length
        continue
      }
    }
    const ch = s[i]
    if (ch === '\u00a0' || /\s/.test(ch)) {
      if (!lastWasSpace) { push(' ', i, i + 1); lastWasSpace = true }
      else { end[end.length - 1] = i + 1 }
      i++
      continue
    }
    const folded =
      ch === '‘' || ch === '’' ? "'"
      : ch === '“' || ch === '”' ? '"'
      : ch === '–' || ch === '—' ? '-'
      : ch
    push(folded, i, i + 1)
    lastWasSpace = false
    i++
  }
  return { norm: out.join(''), start, end }
}

/**
 * Find `needle` inside `haystack` comparing normalized forms, returning the
 * span in the ORIGINAL haystack.
 *
 * Refuses on ambiguity: if the normalized needle appears more than once we
 * have no way to know which occurrence the user meant, and picking the first
 * would edit an arbitrary clause. A miss is recoverable; the wrong edit to a
 * contract is not.
 */
function findNormalizedSpan(haystack: string, needle: string, html = false, minLength = 24): [number, number] | null {
  const target = normalizeWithMap(needle).norm.trim()
  // Short fragments match too loosely to splice on (in a whole document).
  if (target.length < minLength) return null

  const { norm, start, end } = normalizeWithMap(haystack, html)
  const at = norm.indexOf(target)
  if (at === -1) return null
  if (norm.indexOf(target, at + 1) !== -1) return null

  return [start[at], end[at + target.length - 1]]
}

/**
 * Replace `before` with `proposed` in `body`, trying progressively looser
 * matches. Returns the untouched body with mode 'none' when nothing matched.
 *
 * Splices by index rather than String.replace: with a string pattern, `$&`
 * and `` $` `` in the REPLACEMENT are still substitution patterns, so proposed
 * language containing those sequences would corrupt the document.
 */
/** Where a clause was found, or why it wasn't. */
export type LocateResult =
  | { mode: 'exact' | 'escaped' | 'normalized'; start: number; end: number }
  | { mode: 'none' }
  | { mode: 'ambiguous'; occurrences: number }

/**
 * Find the span of `before` in `body`, refusing when it appears more than once.
 *
 * The ambiguity guard used to exist only on the normalized tier; `exact` and
 * `escaped` took the first `indexOf` hit blindly. That is how applying two
 * clauses in sequence could edit the WRONG one: if clause A's replacement text
 * quotes clause B verbatim — entirely normal, clauses cross-reference each
 * other — then after A is applied, B's wording appears twice. Splicing B then
 * hit the copy inside A and reported `spliced: true, matchMode: 'exact'`.
 * Observed: a governing-law change landed inside the liability clause while
 * the governing-law clause kept its old text, reported as a clean success.
 *
 * Refusing is the only safe answer. A miss is recoverable and visible; the
 * wrong edit to a contract is neither.
 */
function locateSpan(
  body: string,
  before: string,
  escape: (s: string) => string,
  minLength = 24,
): LocateResult {
  const countOf = (needle: string) => {
    let n = 0
    for (let i = body.indexOf(needle); i !== -1; i = body.indexOf(needle, i + 1)) n++
    return n
  }

  const exactCount = countOf(before)
  if (exactCount === 1) {
    const at = body.indexOf(before)
    return { mode: 'exact', start: at, end: at + before.length }
  }
  if (exactCount > 1) return { mode: 'ambiguous', occurrences: exactCount }

  const escapedBefore = escape(before)
  if (escapedBefore !== before) {
    const escCount = countOf(escapedBefore)
    if (escCount === 1) {
      const at = body.indexOf(escapedBefore)
      return { mode: 'escaped', start: at, end: at + escapedBefore.length }
    }
    if (escCount > 1) return { mode: 'ambiguous', occurrences: escCount }
  }

  const span = findNormalizedSpan(body, before, escape === escapeHtml, minLength)
  if (span) return { mode: 'normalized', start: span[0], end: span[1] }

  return { mode: 'none' }
}

// ─── A clause across paragraphs: its edits, one by one ──────────────────────

export interface EditSpan { start: number; end: number; text: string }

/** Where `text` runs in `body`, every tag read as a space: a region to look in, not a span to replace. */
function findRegion(body: string, text: string, html: boolean): [number, number] | null {
  const target = normalizeWithMap(text).norm.trim()
  if (target.length < 24) return null
  const { norm, start, end } = normalizeWithMap(body, html, html)
  const at = norm.indexOf(target)
  if (at === -1 || norm.indexOf(target, at + 1) !== -1) return null
  return [start[at], end[at + target.length - 1]]
}

/**
 * A clause whose text runs across paragraphs (list items, a table) can't be
 * replaced as one span: the splice would cross paragraph tags, so it was
 * skipped. The rewrite's own edits can be placed: each `before` is a verbatim
 * piece of the clause, found inside the clause's region and inside one
 * paragraph. All of them or none: half a rewrite is a clause nobody proposed.
 */
function planEdits(
  body: string, clauseText: string, edits: ReadonlyArray<{ before: string; after: string }>, html: boolean,
): EditSpan[] | null {
  // Inside the clause's region when it runs as one stretch; a clause that
  // skips a paragraph (its list's middle item is another clause) doesn't, and
  // then each edit has to be found once in the whole document.
  const region = findRegion(body, clauseText, html) ?? [0, body.length]
  const whole = region[0] === 0 && region[1] === body.length
  const inRegion = body.slice(region[0], region[1])
  const spans: EditSpan[] = []
  for (const e of edits) {
    if (!e.before?.trim() || e.before === e.after) continue
    const found = locateSpan(inRegion, e.before, html ? escapeHtml : s => s, whole ? 24 : 4)
    if (found.mode === 'ambiguous') return null
    if (found.mode !== 'none') {
      spans.push({ start: region[0] + found.start, end: region[0] + found.end, text: e.after ?? '' })
      continue
    }
    // An edit over neighbouring list items or paragraphs merges them into one.
    const merged = html ? siblingSpan(body, e.before) : null
    if (!merged) return null
    spans.push({ ...merged, text: e.after ?? '' })
  }
  spans.sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) if (spans[i].start < spans[i - 1].end) return null
  return spans.length ? spans : null
}

/**
 * `text` found once across neighbouring paragraphs or list items of one list
 * ("…preceding the claim.</li><li>Customer's liability…"), when those are
 * all the tags it crosses: replacing it merges them into one. Anything else
 * (a table cell, a heading, the end of a list) is not merged.
 */
function siblingSpan(body: string, text: string): { start: number; end: number } | null {
  const span = findRegion(body, text, true)
  if (!span) return null
  const blockTags = (body.slice(span[0], span[1]).match(/<\/?[a-z][a-z0-9]*\b[^<>]*>/gi) ?? [])
    .filter(t => !INLINE_TAGS.has(/^<\/?([a-z][a-z0-9]*)/i.exec(t)![1].toLowerCase()))
  if (!blockTags.length || blockTags.length % 2) return null
  // Pairs of </li><li> or </p><p>, nothing else.
  for (let i = 0; i < blockTags.length; i += 2) {
    const close = /^<\/(li|p)>$/i.exec(blockTags[i])
    const open = /^<(li|p)\b[^>]*>$/i.exec(blockTags[i + 1])
    if (!close || !open || close[1].toLowerCase() !== open[1].toLowerCase()) return null
  }
  return { start: span[0], end: span[1] }
}

/** Both bodies' spans for a clause's edits, or null unless every edit is found in each. */
function planEditsInBoth(html: string, plain: string, clauseText: string, edits?: ReadonlyArray<{ before: string; after: string }>) {
  if (!edits?.length) return null
  const h = planEdits(html, clauseText, edits, true)
  const p = h && planEdits(plain, clauseText, edits, false)
  return h && p && h.length === p.length ? { html: h, plain: p } : null
}

/** Replace spans, back to front so each leaves the offsets before it alone. */
function applySpans(body: string, spans: readonly EditSpan[], html: boolean): string {
  return [...spans].sort((a, b) => b.start - a.start).reduce(
    (acc, s) => acc.slice(0, s.start) + (html ? htmlReplacement(acc, s.start, s.end, s.text) : s.text) + acc.slice(s.end),
    body,
  )
}

function spliceInto(
  body: string,
  before: string,
  proposed: string,
  escape: (s: string) => string,
): { text: string; mode: MatchMode } {
  const found = locateSpan(body, before, escape)
  if (found.mode === 'none' || found.mode === 'ambiguous') {
    return { text: body, mode: 'none' }
  }
  // Where the clause ran across line breaks or formatting, so does its replacement.
  const replacement = escape === escapeHtml ? htmlReplacement(body, found.start, found.end, proposed) : escape(proposed)
  return {
    text: body.slice(0, found.start) + replacement + body.slice(found.end),
    mode: found.mode,
  }
}

// ─── A clause that starts with its section heading ──────────────────────────

const HEADING_LINE = /^\d{1,2}(?:\.\d+)*\.?\s+[A-Z][A-Z0-9 ,;:&'()/\u2014-]{2,}$/

/** `heading` at the start of a text, whatever its spacing and closing punctuation. */
function headingPrefix(heading: string): RegExp {
  const words = heading.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^\\s*${words.join('\\s+')}[\\s.:\\u2014-]*`, 'i')
}

/**
 * Extraction often takes a clause with its section heading ("2. FEES AND
 * PAYMENT Customer shall pay…"), but in the document the heading is a block
 * of its own. That text is not one run of the HTML, so it was never found and
 * the clause was skipped: "Apply 7 changes" applied two. The heading stays as
 * it is, and what's under it is rewritten, with the heading taken off the
 * rewrite too when it repeats it.
 */
export function underHeading(html: string, clauseText: string, proposed: string): { clauseText: string; proposed: string } | null {
  const headings = htmlBlocks(html)
    .filter(b => /^h[1-6]$/.test(b.kind) || HEADING_LINE.test(b.text))
    .map(b => b.text)
    .sort((a, b) => b.length - a.length)
  for (const h of headings) {
    const re = headingPrefix(h)
    if (!re.test(clauseText)) continue
    const rest = clauseText.replace(re, '')
    if (!rest.trim()) return null
    const body = re.test(proposed)
      ? proposed.replace(re, '')
      // The rewrite restated the heading differently ("3. LIABILITY CAP.").
      : proposed.replace(/^\s*\d{1,2}(?:\.\d+)*\.?\s+[A-Z][A-Z0-9 ,;:&'()/-]{2,}?[.:]?\s+(?=[A-Z][a-z])/, '')
    return { clauseText: rest, proposed: body.trim() ? body : proposed }
  }
  return null
}

/** A clause's own version text, when it isn't the current one (X23: a restore source). */
async function versionText(versionId: string, currentVersionId: string): Promise<string> {
  if (versionId === currentVersionId) return ''
  return (await prisma.contractVersion.findUnique({ where: { id: versionId }, select: { plainText: true } }))?.plainText ?? ''
}

/** Pure matching helpers, exported for unit tests only. */
export const __testing = { spliceInto, findNormalizedSpan, normalizeWithMap, locateSpan, planEditsInBoth, applySpans }

export async function applyClauseProposal(args: ApplyClauseArgs): Promise<ApplyClauseResult> {
  const contract = await prisma.contract.findFirst({
    where:  { id: args.contractId, orgId: args.orgId, deletedAt: null },
    select: { id: true, title: true, type: true, currentVersionId: true, status: true, externalEdit: true },
  })
  if (!contract) return { ok: false, status: 404, detail: 'Contract not found' }
  const lock = lockOf(contract.externalEdit)
  if (lock) return { ok: false, status: 409, ...lockedBody(lock) }
  if (!contract.currentVersionId) {
    return { ok: false, status: 400, detail: 'Contract has no current version' }
  }

  const currentVersion = await prisma.contractVersion.findUnique({
    where:  { id: contract.currentVersionId },
    select: { id: true, versionNumber: true, htmlContent: true, plainText: true },
  })
  if (!currentVersion) return { ok: false, status: 404, detail: 'Current version missing' }

  let clause = await prisma.contractClause.findFirst({
    where:  { id: args.clauseId, versionId: currentVersion.id },
    select: { id: true, clauseType: true, content: true, sectionRef: true, versionId: true },
  })

  // P1.6 — resilience to version churn. The caller may hold a clauseId from an
  // earlier version (the editor's autosave creates versions without re-running
  // clause extraction, so the current version can have zero clause rows):
  //   1) match by (clauseType, sectionRef) on the current version;
  //   2) else fall back to the prior clause's own data — the splice runs
  //      against version.htmlContent anyway, and falls through to an amendment
  //      note if the text is no longer present.
  if (!clause) {
    const priorClause = await prisma.contractClause.findFirst({
      where: {
        id: args.clauseId,
        // Scope to THIS contract. A clause id is globally unique but not
        // globally private: an unscoped lookup let a caller name another org's
        // clause and have its text and type written into their own version
        // metadata and changeNote (which GET /:id/versions returns). Harmless
        // while this only ran behind the internal-secret hook; not once a
        // user-facing route reaches it.
        version: { contractId: contract.id },
      },
      select: { id: true, clauseType: true, content: true, sectionRef: true, versionId: true },
    })
    if (priorClause) {
      const byType = await prisma.contractClause.findFirst({
        where: {
          versionId:  currentVersion.id,
          isSubChunk: false,
          clauseType: priorClause.clauseType,
          ...(priorClause.sectionRef ? { sectionRef: priorClause.sectionRef } : {}),
        },
        orderBy: { sortOrder: 'asc' },
        select:  { id: true, clauseType: true, content: true, sectionRef: true, versionId: true },
      })
      clause = byType ?? priorClause
    }
  }
  if (!clause) return { ok: false, status: 404, detail: 'Clause not found on current version' }

  // X23 — a proposal the chat model saw carries round-trip tokens where the
  // contract had personal data (internal-ai redline_propose); put the values
  // back before it is spliced in or stored. The clause's own version is a
  // source too: the word that made a value count as PII may have been edited
  // out of the current one since. Anything placeholder-shaped left over (a
  // token altered by the model, a `[REDACTED:SSN]` copied from a tool result)
  // would replace the value in the document: refuse instead. The rationale is
  // only a note, so it doesn't decide.
  const original = [clause.content, currentVersion.plainText, await versionText(clause.versionId, currentVersion.id)]
  args = restorePii(args, original, contract.id)
  if (unresolvedPiiTokens([args.proposedText, args.changes], original).length) {
    return {
      ok: false, status: 409, code: 'PII_TOKEN_UNRESOLVED',
      detail: 'The proposal contains redacted values that no longer match this contract\'s text. Regenerate the proposal.',
    }
  }

  // Locate the clause in BOTH stored representations. They are two views of
  // one document: if only one of them can be spliced, the contract's HTML and
  // its indexed plain text would describe different agreements, so a partial
  // match counts as a miss.
  const before = clause.content
  let htmlSplice  = spliceInto(currentVersion.htmlContent, before, args.proposedText, escapeHtml)
  let plainSplice = spliceInto(currentVersion.plainText,   before, args.proposedText, s => s)
  if (htmlSplice.mode === 'none') {
    const under = underHeading(currentVersion.htmlContent, before, args.proposedText)
    if (under) {
      const h = spliceInto(currentVersion.htmlContent, under.clauseText, under.proposed, escapeHtml)
      const p = spliceInto(currentVersion.plainText,   under.clauseText, under.proposed, s => s)
      if (h.mode !== 'none' && p.mode !== 'none') { htmlSplice = h; plainSplice = p }
    }
  }

  // A clause across paragraphs: the rewrite's own edits, each in its paragraph.
  const edits = htmlSplice.mode !== 'none' && plainSplice.mode !== 'none'
    ? null
    : planEditsInBoth(currentVersion.htmlContent, currentVersion.plainText, clause.content, args.changes)
  const spliced = (htmlSplice.mode !== 'none' && plainSplice.mode !== 'none') || !!edits
  const matchMode: MatchMode = edits ? 'edits' : spliced ? htmlSplice.mode : 'none'

  // The caller confirmed a replacement. If we can't perform one, say so —
  // appending an amendment instead would apply something they never approved.
  if (!spliced && !args.allowAppendFallback) {
    return {
      ok: false,
      status: 409,
      code: 'CLAUSE_TEXT_NOT_FOUND',
      detail:
        'The clause text could not be located in the current version — it was probably edited since this proposal was generated. ' +
        'Re-open the clause to regenerate the proposal, or re-send with allowAppendFallback to add it as an amendment instead.',
    }
  }

  let nextHtml: string
  let nextPlain: string
  if (edits) {
    nextHtml  = applySpans(currentVersion.htmlContent, edits.html, true)
    nextPlain = applySpans(currentVersion.plainText, edits.plain, false)
  } else if (spliced) {
    nextHtml  = htmlSplice.text
    nextPlain = plainSplice.text
  } else {
    // Explicitly requested: append to both bodies so they stay consistent.
    nextHtml = currentVersion.htmlContent +
      `\n<hr/>\n<p><strong>Amendment (via redline_apply):</strong></p><p>${escapeHtml(args.proposedText)}</p>`
    nextPlain = currentVersion.plainText + '\n\n[Amendment via redline_apply]\n' + args.proposedText
  }

  const aggressionLabel = args.aggression ?? 'custom'

  const newVersion = await prisma.$transaction(async (tx) => {
    // Derived INSIDE the transaction, from the contract's true high-water mark
    // rather than from the version we happened to read earlier. Computing it
    // outside meant two applies landing together both saw the same number and
    // one died on @@unique([contractId, versionNumber]) — and Phase 2 applies
    // several clauses at once, which makes that collision routine rather than
    // rare. Max, not current+1: an apply can race an editor save that has
    // already moved the contract on.
    const highest = await tx.contractVersion.aggregate({
      where: { contractId: contract.id },
      _max:  { versionNumber: true },
    })
    const nextVersionNumber = (highest._max.versionNumber ?? currentVersion.versionNumber) + 1

    const v = await tx.contractVersion.create({
      data: {
        contractId:    contract.id,
        versionNumber: nextVersionNumber,
        htmlContent:   nextHtml,
        plainText:     nextPlain,
        changeNote: args.rationale
          ? `redline_apply (${aggressionLabel}): ${args.rationale}`
          : `redline_apply (${aggressionLabel}) on ${clause!.clauseType}`,
        createdById: args.userId,
        // Kept structured so a future OOXML serializer can emit real Word
        // tracked changes from these rows without re-running the LLM.
        metadata: {
          redline: {
            sourceClauseId: clause!.id,
            clauseType:     clause!.clauseType,
            sectionRef:     clause!.sectionRef,
            originalText:   clause!.content,
            proposedText:   args.proposedText,
            aggression:     aggressionLabel,
            rationale:      args.rationale,
            changes:        args.changes ?? [],
            spliced,
            matchMode,
            generatedBy:    'redline_apply',
            appliedAt:      new Date().toISOString(),
          },
        },
      },
    })
    await tx.contract.update({
      where: { id: contract.id },
      // X42 — a changed clause on an approved contract needs approving again.
      data:  { currentVersionId: v.id, status: statusAfterTermsChange(contract.status) },
    })
    return v
  })

  // Read back off the created row rather than the pre-transaction guess — the
  // number is now decided inside the transaction, so this is the only value
  // that is certainly the one on disk.
  const nextVersionNumber = newVersion.versionNumber
  const resetTo = statusAfterTermsChange(contract.status)
  if (resetTo) await recordStatusChange({ orgId: args.orgId, contractId: contract.id, from: contract.status, to: resetTo, userId: args.userId, source: 'edit', reason: 'a clause was rewritten', versionId: newVersion.id })
  // DD2 — the new version keeps the clauses, the revised one with its new words.
  await afterEdit({ contractId: contract.id, orgId: args.orgId, versionId: newVersion.id, fromVersionId: currentVersion.id })

  return {
    ok: true,
    data: {
      ok:                true,
      reversible:        true,
      contractId:        contract.id,
      previousVersionId: currentVersion.id,
      newVersionId:      newVersion.id,
      newVersionNumber:  nextVersionNumber,
      clauseId:          clause.id,
      spliced,
      matchMode,
      diff: [
        { field: 'currentVersionId', before: currentVersion.id, after: newVersion.id },
        { field: 'versionNumber',    before: currentVersion.versionNumber, after: nextVersionNumber },
      ],
    },
  }
}

// ─── Multi-clause apply ──────────────────────────────────────────────────────

export interface BatchChange {
  clauseId:     string
  proposedText: string
  rationale?:   string
  changes?:     Array<{ before: string; after: string; reason?: string }>
}

export interface AppliedChange {
  clauseId:   string
  clauseType: string | null
  spliced:    boolean
  matchMode:  MatchMode | 'ambiguous'
  /** Present when this clause could not be applied. */
  error?:     string
}

export interface ApplyBatchPayload {
  ok:                true
  reversible:        true
  contractId:        string
  previousVersionId: string
  newVersionId:      string
  newVersionNumber:  number
  applied:           AppliedChange[]
  appliedCount:      number
  skippedCount:      number
}

export type ApplyBatchResult =
  | { ok: true;  data: ApplyBatchPayload }
  | { ok: false; status: number; detail: string; code?: string }

/**
 * Apply many clause rewrites as ONE new version.
 *
 * Looping `applyClauseProposal` is not equivalent, for two reasons:
 *
 *   1. It creates a version per clause. Twelve deviations would mean twelve
 *      rows, twelve `currentVersionId` flips, twelve audit events, and an undo
 *      that has to unwind a chain in the right order.
 *   2. Each apply rewrites the document, so an earlier replacement can change
 *      what a later one matches against. Clauses quote each other routinely —
 *      once clause A's new text contains clause B's wording, locating B is
 *      ambiguous, and before the guard above it silently spliced into A.
 *
 * So every span is located against ONE immutable snapshot of the body, and the
 * splices are applied back-to-front by offset — later edits cannot disturb the
 * offsets of earlier ones. A clause that cannot be located is reported and
 * skipped; the rest still land.
 */
export async function applyClauseBatch(args: {
  orgId:      string
  userId:     string
  contractId: string
  changes:    BatchChange[]
  rationale?: string
}): Promise<ApplyBatchResult> {
  const { orgId, userId, contractId } = args
  if (args.changes.length === 0) {
    return { ok: false, status: 400, detail: 'changes is required' }
  }

  const contract = await prisma.contract.findFirst({
    where:  { id: contractId, orgId, deletedAt: null },
    select: { id: true, currentVersionId: true, status: true, externalEdit: true },
  })
  if (!contract) return { ok: false, status: 404, detail: 'Contract not found' }
  // BB3 — no new version while a Google Docs copy is out.
  const lock = lockOf(contract.externalEdit)
  if (lock) return { ok: false, status: 409, ...lockedBody(lock) }
  if (!contract.currentVersionId) {
    return { ok: false, status: 400, detail: 'Contract has no current version' }
  }

  const currentVersion = await prisma.contractVersion.findUnique({
    where:  { id: contract.currentVersionId },
    select: { id: true, versionNumber: true, htmlContent: true, plainText: true },
  })
  if (!currentVersion) return { ok: false, status: 404, detail: 'Current version missing' }

  // X23 — as applyClauseProposal, each change is restored against its clause
  // and the document below (a token left unresolved fails its clause); the
  // rationale is only a note, so it is stored as it resolves.
  const changes = args.changes
  const rationale = restorePii(args.rationale, currentVersion.plainText, contract.id)

  const clauses = await prisma.contractClause.findMany({
    where:  { id: { in: changes.map(c => c.clauseId) }, versionId: currentVersion.id },
    select: { id: true, clauseType: true, content: true, sectionRef: true, versionId: true },
  })
  const clauseById = new Map(clauses.map(c => [c.id, c]))

  // Resilience to version churn — the same problem applyClauseProposal solves,
  // and the batch is MORE exposed to it: staging happens minutes before the
  // reviewer accepts, and the editor's autosave creates versions WITHOUT
  // re-running clause extraction. So by the time they press apply, the clause
  // ids they were shown can belong to an older version and the current one can
  // have no clause rows at all. Without this the whole batch 409s with "none of
  // the requested clauses could be located", which is both wrong and baffling —
  // the clauses are right there in the document.
  const unresolved = changes.map(c => c.clauseId).filter(id => !clauseById.has(id))
  if (unresolved.length > 0) {
    const priors = await prisma.contractClause.findMany({
      // Scoped to THIS contract: a clause id is globally unique but not
      // globally private, and an unscoped lookup would let a caller name
      // another org's clause and splice its text into their document.
      where:  { id: { in: unresolved }, version: { contractId: contract.id } },
      select: { id: true, clauseType: true, content: true, sectionRef: true, versionId: true },
    })
    for (const prior of priors) {
      const byType = await prisma.contractClause.findFirst({
        where: {
          versionId:  currentVersion.id,
          isSubChunk: false,
          clauseType: prior.clauseType,
          ...(prior.sectionRef ? { sectionRef: prior.sectionRef } : {}),
        },
        orderBy: { sortOrder: 'asc' },
        select:  { id: true, clauseType: true, content: true, sectionRef: true, versionId: true },
      })
      // Prefer the current version's row; otherwise the prior clause's own
      // text, which still has to survive locateSpan against the current body —
      // so a clause genuinely edited away is still reported, not force-applied.
      clauseById.set(prior.id, byType ?? prior)
    }
  }

  // Locate every span against the ORIGINAL body — never against a partially
  // rewritten one. This is the whole point of the batch.
  interface Planned {
    change: BatchChange
    clause: NonNullable<ReturnType<typeof clauseById.get>>
    mode:   MatchMode
    html:   EditSpan[]
    plain:  EditSpan[]
  }
  const planned: Planned[] = []
  const applied: AppliedChange[] = []

  // X23 — as applyClauseProposal; the document's map is built once.
  const restoreDoc = piiRestorer(currentVersion.plainText, contract.id)
  for (const proposed of changes) {
    const clause = clauseById.get(proposed.clauseId)
    const original = clause ? [clause.content, currentVersion.plainText, await versionText(clause.versionId, currentVersion.id)] : []
    let change = clause ? restorePii(restoreDoc(proposed), original.filter(t => t !== currentVersion.plainText), contract.id) : proposed
    if (!clause) {
      applied.push({
        clauseId: change.clauseId, clauseType: null,
        spliced: false, matchMode: 'none', error: 'clause_not_on_current_version',
      })
      continue
    }
    // X23 — as applyClauseProposal: never splice a placeholder.
    if (unresolvedPiiTokens([change.proposedText, change.changes], original).length) {
      applied.push({
        clauseId: clause.id, clauseType: clause.clauseType,
        spliced: false, matchMode: 'none', error: 'pii_token_unresolved',
      })
      continue
    }
    let html  = locateSpan(currentVersion.htmlContent, clause.content, escapeHtml)
    let plain = locateSpan(currentVersion.plainText,   clause.content, s => s)
    if (html.mode === 'none') {
      const under = underHeading(currentVersion.htmlContent, clause.content, change.proposedText)
      if (under) {
        const h = locateSpan(currentVersion.htmlContent, under.clauseText, escapeHtml)
        const p = locateSpan(currentVersion.plainText,   under.clauseText, s => s)
        if (h.mode !== 'none' && p.mode !== 'none') { html = h; plain = p; change = { ...change, proposedText: under.proposed } }
      }
    }

    // Both bodies or neither: they are two views of one document, and letting
    // them diverge means the contract's HTML and its indexed text describe
    // different agreements.
    if (html.mode === 'ambiguous' || plain.mode === 'ambiguous') {
      applied.push({
        clauseId: clause.id, clauseType: clause.clauseType,
        spliced: false, matchMode: 'ambiguous',
        error: 'clause_text_ambiguous',
      })
      continue
    }
    if (html.mode === 'none' || plain.mode === 'none') {
      // A clause across paragraphs: the rewrite's own edits, each in its paragraph.
      const edits = planEditsInBoth(currentVersion.htmlContent, currentVersion.plainText, clause.content, change.changes)
      if (edits) { planned.push({ change, clause, mode: 'edits', ...edits }); continue }
      applied.push({
        clauseId: clause.id, clauseType: clause.clauseType,
        spliced: false, matchMode: 'none', error: 'clause_text_not_found',
      })
      continue
    }
    planned.push({
      change, clause, mode: html.mode,
      html:  [{ start: html.start, end: html.end, text: change.proposedText }],
      plain: [{ start: plain.start, end: plain.end, text: change.proposedText }],
    })
  }

  // Two clauses' changes over the same text can't both be spliced: the later
  // one is reported rather than written into the middle of the other.
  const taken: EditSpan[] = []
  for (const p of [...planned]) {
    if (p.html.some(s => taken.some(t => s.start < t.end && t.start < s.end))) {
      planned.splice(planned.indexOf(p), 1)
      applied.push({ clauseId: p.clause.id, clauseType: p.clause.clauseType, spliced: false, matchMode: 'none', error: 'overlaps_another_change' })
      continue
    }
    taken.push(...p.html)
  }

  if (planned.length === 0) {
    return {
      ok: false, status: 409, code: 'NO_CLAUSE_APPLICABLE',
      detail: 'None of the requested clauses could be located in the current version.',
    }
  }

  // Every span against the original body, back to front.
  const nextHtml  = applySpans(currentVersion.htmlContent, planned.flatMap(p => p.html), true)
  const nextPlain = applySpans(currentVersion.plainText, planned.flatMap(p => p.plain), false)

  for (const p of planned) {
    applied.push({
      clauseId: p.clause.id, clauseType: p.clause.clauseType,
      spliced: true, matchMode: p.mode,
    })
  }

  const newVersion = await prisma.$transaction(async (tx) => {
    const highest = await tx.contractVersion.aggregate({
      where: { contractId: contract.id },
      _max:  { versionNumber: true },
    })
    const nextVersionNumber = (highest._max.versionNumber ?? currentVersion.versionNumber) + 1

    const v = await tx.contractVersion.create({
      data: {
        contractId:    contract.id,
        versionNumber: nextVersionNumber,
        htmlContent:   nextHtml,
        plainText:     nextPlain,
        changeNote: rationale
          ? `redline_apply_batch (${planned.length} clauses): ${rationale}`
          : `redline_apply_batch — ${planned.length} clause${planned.length === 1 ? '' : 's'} revised`,
        createdById: userId,
        metadata: {
          // An ARRAY, unlike the single-clause path's one object: a batch
          // version has to record every clause it changed, or a later OOXML
          // serializer can only reconstruct one of them.
          redline: planned.map(p => ({
            sourceClauseId: p.clause.id,
            clauseType:     p.clause.clauseType,
            sectionRef:     p.clause.sectionRef,
            originalText:   p.clause.content,
            proposedText:   p.change.proposedText,
            rationale:      p.change.rationale,
            changes:        p.change.changes ?? [],
            matchMode:      p.mode,
          })),
          redlineBatch: {
            appliedCount: planned.length,
            skippedCount: applied.filter(a => a.error).length,
            generatedBy:  'redline_apply_batch',
            appliedAt:    new Date().toISOString(),
          },
        },
      },
    })
    await tx.contract.update({ where: { id: contract.id }, data: { currentVersionId: v.id, status: statusAfterTermsChange(contract.status) } })
    return v
  })
  const resetTo = statusAfterTermsChange(contract.status)
  if (resetTo) await recordStatusChange({ orgId, contractId: contract.id, from: contract.status, to: resetTo, userId, source: 'edit', reason: 'clauses were rewritten', versionId: newVersion.id })
  // DD2 — the new version keeps the clauses, the revised ones with their new words.
  await afterEdit({ contractId: contract.id, orgId, versionId: newVersion.id, fromVersionId: currentVersion.id })

  return {
    ok: true,
    data: {
      ok: true,
      reversible: true,
      contractId:        contract.id,
      previousVersionId: currentVersion.id,
      newVersionId:      newVersion.id,
      newVersionNumber:  newVersion.versionNumber,
      applied,
      appliedCount: planned.length,
      skippedCount: applied.filter(a => a.error).length,
    },
  }
}
