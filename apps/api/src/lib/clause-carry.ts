/**
 * DD2 — a version made from an older one keeps the older one's clauses.
 *
 * Clause rows came only from analysis, and only an uploaded file is
 * analysed. An editor save, an applied redline, an assistant change, a
 * sealed signature copy or a Google Docs round trip made a version with no
 * clauses. On it the playbook check had nothing to check, and the Clauses
 * tab, approvals and semantic search fell back to the last analysed version:
 * text the contract no longer had.
 *
 * Each clause of the older version is found in its text, followed through a
 * word diff into the new text, and copied:
 *   - unchanged: as it was, with its type, rating, review state and
 *     embedding;
 *   - changed: with the new words, unrated and unreviewed (what was said
 *     about the old words doesn't hold for the new ones), to be embedded;
 *   - gone: not copied.
 * Analysis, when it runs on the version, replaces them all.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { diffSequences, fold } from './ooxml/sequence-diff.js'

// ── Following text through an edit ──────────────────────────────────────────

export interface Token { key: string; start: number; end: number }

// Words (with their apostrophes and hyphens) and numbers. Punctuation is left
// out of the comparison: a deleted last clause's full stop would otherwise
// pair with the new last sentence's, and 'claim."Excluded' must read the
// same as 'claim.\n"Excluded'. It is put back around a clause's words
// (`spanText`), and counted when judging whether the clause changed.
const TOKEN = /\d+(?:[.,:/]\d+)*%?|[\p{L}\p{N}]+(?:['’\-‐‑][\p{L}\p{N}]+)*/gu

export function tokensOf(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(TOKEN)) out.push({ key: fold(m[0]), start: m.index!, end: m.index! + m[0].length })
  return out
}

const OPENING = new Set(['"', '“', "'", '‘', '(', '[', '{'])
const CLOSING = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '”', '’', '%'])

/** The text of tokens [a, b), with the punctuation that clings to its ends: "(a)", "the claim." */
export function spanText(text: string, tokens: readonly Token[], a: number, b: number): string {
  let s = tokens[a].start, e = tokens[b - 1].end
  while (s > 0 && OPENING.has(text[s - 1])) s--
  for (;;) {
    const c = text[e]
    if (e < text.length && (CLOSING.has(c) || ((c === '"' || c === "'") && !/[\p{L}\p{N}]/u.test(text[e + 1] ?? '')))) e++
    else break
  }
  return text.slice(s, e)
}

/** Where each token of the old text went: its equal in the new text, or the stretch that replaced it. */
export interface TextMap {
  equal: Int32Array     // new index of an unchanged token, else -1
  hunkStart: Int32Array // for a changed token: where its replacement starts in the new text
  hunkEnd: Int32Array   // … and ends (exclusive)
  inserted: Uint8Array  // 1 for a token of the new text with no equal in the old
}

export function mapText(before: readonly Token[], after: readonly Token[]): TextMap {
  const equal = new Int32Array(before.length).fill(-1)
  const hunkStart = new Int32Array(before.length).fill(-1)
  const hunkEnd = new Int32Array(before.length).fill(-1)
  const inserted = new Uint8Array(after.length).fill(1)
  let oi = 0, ni = 0
  let hunk: { o: number; n: number } | null = null
  const close = () => {
    if (!hunk) return
    for (let k = hunk.o; k < oi; k++) { hunkStart[k] = hunk.n; hunkEnd[k] = ni }
    hunk = null
  }
  for (const op of diffSequences(before, after, t => t.key)) {
    if (op.kind === 'equal') { close(); equal[op.ai] = op.bi; inserted[op.bi] = 0; oi = op.ai + 1; ni = op.bi + 1; continue }
    hunk ??= { o: oi, n: ni }
    if (op.kind === 'delete') oi = op.ai + 1
    else ni = op.bi + 1
  }
  close()
  return { equal, hunkStart, hunkEnd, inserted }
}

const ANCHOR = 6

function sequenceAt(tokens: readonly Token[], at: number, keys: readonly string[]): boolean {
  if (at + keys.length > tokens.length) return false
  for (let k = 0; k < keys.length; k++) if (tokens[at + k].key !== keys[k]) return false
  return true
}

function find(tokens: readonly Token[], keys: readonly string[], from: number): number {
  if (!keys.length) return -1
  for (let i = Math.max(0, from); i + keys.length <= tokens.length; i++) if (sequenceAt(tokens, i, keys)) return i
  return -1
}

/**
 * A clause's place in a text, as token indices [start, end): the whole of it,
 * or, when extraction changed a word or two, from its opening words to its
 * closing ones. Searched from `from` first (clauses come in document order).
 */
export function locate(tokens: readonly Token[], clause: string, from = 0): [number, number] | null {
  const keys = tokensOf(clause).map(t => t.key)
  if (!keys.length) return null
  for (const start of [from, 0]) {
    const whole = find(tokens, keys, start)
    if (whole >= 0) return [whole, whole + keys.length]
  }
  if (keys.length < ANCHOR * 2) return null
  // Anchors: the opening words and the closing words, or, where a word there
  // differs, the next stretch in from that end.
  const offsets = [0, ANCHOR, ANCHOR * 2].filter(o => o + ANCHOR * 2 <= keys.length)
  for (const start of [from, 0]) {
    for (const ho of offsets) {
      const at = find(tokens, keys.slice(ho, ho + ANCHOR), start)
      if (at < 0) continue
      const a = Math.max(0, at - ho)
      for (const to of offsets) {
        const t = find(tokens, keys.slice(keys.length - to - ANCHOR, keys.length - to), at + ANCHOR)
        if (t < 0) continue
        const b = Math.min(tokens.length, t + ANCHOR + to)
        // The span must be about the clause's length, or the ends belong to other text.
        if (b - a <= keys.length * 1.5 + 10 && b - a >= keys.length * 0.6) return [a, b]
      }
    }
  }
  return null
}

/**
 * Where old tokens [a, b) are in the new text, and whether they arrived
 * unchanged. Null: deleted. With the new text, words added at either end of
 * the clause join it while its sentence goes on ("…the claim arose.").
 */
export function followSpan(
  map: TextMap, a: number, b: number,
  after?: { text: string; tokens: readonly Token[] },
): { start: number; end: number; unchanged: boolean } | null {
  let start = map.equal[a] >= 0 ? map.equal[a] : map.hunkStart[a]
  let end = map.equal[b - 1] >= 0 ? map.equal[b - 1] + 1 : map.hunkEnd[b - 1]
  // A deleted clause can keep a stray match (a common word, paired with
  // another sentence's): a fifth of its length is not the clause.
  if (start < 0 || end - start < Math.max(1, Math.ceil((b - a) / 5))) return null
  let unchanged = end - start === b - a
  for (let k = a; unchanged && k < b; k++) if (map.equal[k] < 0) unchanged = false
  if (after) {
    const t = after.tokens
    const sentenceEndsAfter = (i: number) => /[.;:!?]["”’)\]]*(?:\s|$)|\n/.test(after.text.slice(t[i].end, t[i + 1]?.start ?? after.text.length))
    while (end < t.length && map.inserted[end] && !sentenceEndsAfter(end - 1)) { end++; unchanged = false }
    while (start > 0 && map.inserted[start - 1] && !sentenceEndsAfter(start - 1)) { start--; unchanged = false }
  }
  return { start, end, unchanged }
}

// ── Copying the rows ────────────────────────────────────────────────────────

export interface CarryResult {
  /** The version the clauses came from; null when there was none to copy. */
  fromVersionId: string | null
  carried: number
  changed: number
  dropped: number
}

const NONE: CarryResult = { fromVersionId: null, carried: 0, changed: 0, dropped: 0 }

/**
 * Give `toVersionId` the clauses of `fromVersionId` (or, if that version has
 * none, of the latest earlier version that has). Does nothing when the new
 * version already has clauses.
 */
export async function carryClauses(opts: { contractId: string; toVersionId: string; fromVersionId?: string | null }): Promise<CarryResult> {
  const to = await prisma.contractVersion.findFirst({
    where: { id: opts.toVersionId, contractId: opts.contractId },
    select: { id: true, versionNumber: true, plainText: true, clauseFlags: true, _count: { select: { clauses: true } } },
  })
  if (!to || to._count.clauses > 0 || !to.plainText.trim()) return NONE

  const hasClauses = { clauses: { some: { isSubChunk: false } } }
  const from = (opts.fromVersionId && opts.fromVersionId !== to.id
    ? await prisma.contractVersion.findFirst({ where: { id: opts.fromVersionId, contractId: opts.contractId, ...hasClauses }, select: { id: true, plainText: true, clauseFlags: true } })
    : null)
    ?? await prisma.contractVersion.findFirst({
      where: { contractId: opts.contractId, versionNumber: { lt: to.versionNumber }, ...hasClauses },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, plainText: true, clauseFlags: true },
    })
  if (!from) return NONE

  const rows = await prisma.contractClause.findMany({
    where: { versionId: from.id },
    orderBy: [{ sortOrder: 'asc' }, { windowIndex: 'asc' }],
  })
  // A long clause is its first window (the primary row) and the windows after
  // it (sub-chunk rows, same type and order): one clause here.
  const groups: Array<{ primary: typeof rows[number]; subs: typeof rows }> = []
  for (const r of rows) {
    if (!r.isSubChunk) { groups.push({ primary: r, subs: [] }); continue }
    const g = [...groups].reverse().find(x => x.primary.sortOrder === r.sortOrder && x.primary.clauseType === r.clauseType)
    g?.subs.push(r)
  }

  const before = tokensOf(from.plainText)
  const after = tokensOf(to.plainText)
  const map = mapText(before, after)

  const created: Prisma.ContractClauseCreateManyInput[] = []
  let cursor = 0, changed = 0, dropped = 0
  for (const { primary, subs } of groups) {
    const first = locate(before, primary.content, cursor)
    const last = subs.length ? locate(before, subs[subs.length - 1].content, first?.[0] ?? cursor) : first
    const span = first && last && last[1] > first[0] ? [first[0], last[1]] as const : null
    let moved = span ? followSpan(map, span[0], span[1], { text: to.plainText, tokens: after }) : null
    // A rewrite too large for the diff reads as one replaced stretch: only a
    // clause found as it was can be trusted then.
    if (span && moved && !moved.unchanged && moved.end - moved.start > (span[1] - span[0]) * 3 + 50) moved = null
    if (span) cursor = span[0]
    if (!moved) {
      const same = subs.length === 0 ? locate(after, primary.content) : null
      if (!same) { dropped++; continue }
      moved = { start: same[0], end: same[1], unchanged: true }
    }
    const text = spanText(to.plainText, after, moved.start, moved.end)
    // Unchanged: the same words in the same order, and the same punctuation.
    if (moved.unchanged && span && fold(spanText(from.plainText, before, span[0], span[1])) !== fold(text)) moved.unchanged = false
    const base = { versionId: to.id, clauseType: primary.clauseType, sectionRef: primary.sectionRef, sortOrder: primary.sortOrder }
    if (moved.unchanged) {
      created.push({
        ...base,
        // As stored, where it is all of the clause; a long clause whole, for re-windowing.
        content: subs.length ? text : primary.content,
        interpretation: primary.interpretation, riskRating: primary.riskRating,
        reviewState: primary.reviewState, reviewedAt: primary.reviewedAt, reviewedById: primary.reviewedById,
      })
    } else {
      changed++
      created.push({ ...base, content: text })
    }
  }
  if (!created.length) return { fromVersionId: from.id, carried: 0, changed: 0, dropped }

  await prisma.$transaction(async tx => {
    // Re-checked inside: an analysis (or another save) may have written the version's clauses meanwhile.
    if (await tx.contractClause.count({ where: { versionId: to.id } }) > 0) throw Object.assign(new Error('already has clauses'), { code: 'HAS_CLAUSES' })
    await tx.contractClause.createMany({ data: created })
    // The clause flags describe the same clauses (C7 indexes them from the current version).
    const flags = to.clauseFlags as Record<string, unknown> | null
    if (!flags || !Object.keys(flags).length) {
      await tx.contractVersion.update({ where: { id: to.id }, data: { clauseFlags: from.clauseFlags as Prisma.InputJsonValue } })
    }
  }).catch(err => {
    if ((err as { code?: string }).code === 'HAS_CLAUSES') return
    throw err
  })
  await copyEmbeddings(from.id, to.id)
  return { fromVersionId: from.id, carried: created.length, changed, dropped }
}

/** Rows of `to` whose words are exactly a row of `from`'s take its embedding: the same text embeds the same. */
export async function copyEmbeddings(fromVersionId: string, toVersionId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE contract_clauses AS n
    SET    embedding = o.embedding, "embeddedAt" = o."embeddedAt"
    FROM   contract_clauses AS o
    WHERE  n."versionId" = ${toVersionId} AND n.embedding IS NULL
      AND  o."versionId" = ${fromVersionId} AND o.embedding IS NOT NULL
      AND  o.content = n.content AND o."clauseType" = n."clauseType"`
}
