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
export type MatchMode = 'exact' | 'escaped' | 'normalized' | 'none'

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
function normalizeWithMap(s: string): { norm: string; start: number[]; end: number[] } {
  const out: string[] = []
  const start: number[] = []
  const end: number[] = []
  let i = 0
  let lastWasSpace = false

  const push = (ch: string, from: number, to: number) => {
    out.push(ch); start.push(from); end.push(to)
  }

  while (i < s.length) {
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
    if (ch === ' ' || /\s/.test(ch)) {
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
function findNormalizedSpan(haystack: string, needle: string): [number, number] | null {
  const target = normalizeWithMap(needle).norm.trim()
  // Short fragments match too loosely to splice on.
  if (target.length < 24) return null

  const { norm, start, end } = normalizeWithMap(haystack)
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
function spliceInto(
  body: string,
  before: string,
  proposed: string,
  escape: (s: string) => string,
): { text: string; mode: MatchMode } {
  const cut = (at: number, len: number) =>
    body.slice(0, at) + escape(proposed) + body.slice(at + len)

  const exact = body.indexOf(before)
  if (exact !== -1) return { text: cut(exact, before.length), mode: 'exact' }

  const escapedBefore = escape(before)
  if (escapedBefore !== before) {
    const esc = body.indexOf(escapedBefore)
    if (esc !== -1) return { text: cut(esc, escapedBefore.length), mode: 'escaped' }
  }

  const span = findNormalizedSpan(body, before)
  if (span) return { text: cut(span[0], span[1] - span[0]), mode: 'normalized' }

  return { text: body, mode: 'none' }
}

/** Pure matching helpers, exported for unit tests only. */
export const __testing = { spliceInto, findNormalizedSpan, normalizeWithMap }

export async function applyClauseProposal(args: ApplyClauseArgs): Promise<ApplyClauseResult> {
  const contract = await prisma.contract.findFirst({
    where:  { id: args.contractId, orgId: args.orgId, deletedAt: null },
    select: { id: true, title: true, type: true, currentVersionId: true },
  })
  if (!contract) return { ok: false, status: 404, detail: 'Contract not found' }
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
    select: { id: true, clauseType: true, content: true, sectionRef: true },
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
      select: { id: true, clauseType: true, content: true, sectionRef: true },
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
        select:  { id: true, clauseType: true, content: true, sectionRef: true },
      })
      clause = byType ?? priorClause
    }
  }
  if (!clause) return { ok: false, status: 404, detail: 'Clause not found on current version' }

  // Locate the clause in BOTH stored representations. They are two views of
  // one document: if only one of them can be spliced, the contract's HTML and
  // its indexed plain text would describe different agreements, so a partial
  // match counts as a miss.
  const before = clause.content
  const htmlSplice  = spliceInto(currentVersion.htmlContent, before, args.proposedText, escapeHtml)
  const plainSplice = spliceInto(currentVersion.plainText,   before, args.proposedText, s => s)

  const spliced = htmlSplice.mode !== 'none' && plainSplice.mode !== 'none'
  const matchMode: MatchMode = spliced ? htmlSplice.mode : 'none'

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
  if (spliced) {
    nextHtml  = htmlSplice.text
    nextPlain = plainSplice.text
  } else {
    // Explicitly requested: append to both bodies so they stay consistent.
    nextHtml = currentVersion.htmlContent +
      `\n<hr/>\n<p><strong>Amendment (via redline_apply):</strong></p><p>${escapeHtml(args.proposedText)}</p>`
    nextPlain = currentVersion.plainText + '\n\n[Amendment via redline_apply]\n' + args.proposedText
  }

  const nextVersionNumber = currentVersion.versionNumber + 1
  const aggressionLabel = args.aggression ?? 'custom'

  const newVersion = await prisma.$transaction(async (tx) => {
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
      data:  { currentVersionId: v.id },
    })
    return v
  })

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
