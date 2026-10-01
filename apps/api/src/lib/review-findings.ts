/**
 * docs/41 P1 (Workstream A, Part 7) — what the review of a version found,
 * against a baseline, as rows a person can act on (ReviewFinding).
 *
 * The approval recommendation used to be a model's opinion over a risk
 * score read as 0 when unknown, and every check looped over the clauses
 * that exist, so a deleted Governing Law left nothing to flag. Findings are
 * now worked out per (version, baseline) by code, from:
 *
 *   - the clause diff against the baseline — deleted, cut by more than 30%
 *     (material), changed, added — with the words before and after;
 *   - presence rules — a required clause not detected, a clause the
 *     playbook doesn't allow (presence-rules.ts);
 *   - the playbook's structured rules (playbook-rules.ts), on every clause,
 *     not only when someone asks for a redline;
 *   - fingerprints (fingerprint.ts) — a clause still in the words generation
 *     wrote is Standard: not flagged, and not sent to the model;
 *   - the model's position check, run only on clauses that changed or that
 *     no fingerprint matches, which returns a verdict and a quote per clause
 *     (stored on the clause, read here);
 *   - a sense check on text added since the baseline (unreadable-text.ts).
 *
 * The baseline is the latest of: the last version sent to the counterparty,
 * the last approved, the generated original; else the version analysed
 * before. What a person decided about a finding (accepted it, resolved it)
 * carries to the same finding on later versions while its words are the
 * same.
 */
import { createHash } from 'node:crypto'
import { clauseTypeLabel } from '@clm/types'
import { prisma } from './prisma.js'
import { matchCategory, type MatchedCategory } from './clause-category.js'
import { presenceFindings, type PresenceRule } from './presence-rules.js'
import { evaluatePlaybookRules, dedupeViolations, ruleTextsFor, type PlaybookRules } from './playbook-rules.js'
import { diffSequences, fold, likeness, wordBag } from './ooxml/sequence-diff.js'
import { readability } from './unreadable-text.js'
import { generatedSections, standardSpans, standardSourceOf, provenanceOf, normaliseText } from './fingerprint.js'
import { contractPlaybook } from './playbooks.js'

export type FindingKind =
  | 'missing_required' | 'deleted' | 'not_allowed_present' | 'modified' | 'added' | 'material_cut'
  | 'position_not_met' | 'position_fallback' | 'needs_approval_position' | 'unreadable_text' | 'drafting' | 'compliance'
const ALL_KINDS: FindingKind[] = [
  'missing_required', 'deleted', 'not_allowed_present', 'modified', 'added', 'material_cut',
  'position_not_met', 'position_fallback', 'needs_approval_position', 'unreadable_text', 'drafting', 'compliance',
]
export type Severity = 'low' | 'medium' | 'high' | 'critical'
export type FindingStatus = 'open' | 'resolved' | 'accepted' | 'exception_requested' | 'exception_approved' | 'exception_declined'

/**
 * Kinds stored by their own steps (lib/drafting-findings.ts,
 * lib/compliance-findings.ts), not by the clause review: storing one source's
 * findings leaves the others' alone.
 */
export const OWN_STEP_KINDS: FindingKind[] = ['drafting', 'compliance']
const REVIEW_KINDS = (k: string) => !OWN_STEP_KINDS.includes(k as FindingKind)

export interface Evidence {
  /** The words in this version that show it. */
  quote?: string
  /** Other words in this version it is about: a term's definition. */
  relatedQuote?: string
  /** The words in the baseline (what was deleted, what a change replaced). */
  baselineQuote?: string
  /** Where the quote is in this version's text. */
  offsets?: { start: number; end: number }
  sectionRef?: string | null
  ruleId?: string
}

export interface FindingDraft {
  kind: FindingKind
  key: string
  clauseType: string | null
  clauseId: string | null
  categoryId: string | null
  positionId: string | null
  severity: Severity
  title: string
  explanation: string
  evidence: Evidence
  source: 'deterministic' | 'llm'
  /** Set when code settles it on the spot (a change that meets your preferred position). */
  status?: 'open' | 'resolved'
  resolutionNote?: string
}

export type Verdict = 'meets_preferred' | 'meets_fallback' | 'needs_approval' | 'not_met' | 'not_covered'

export interface PositionVerdict {
  positionId: string | null
  verdict: Verdict
  quote: string
  explanation: string
  positionType?: string | null
  at?: string
}

export interface ClauseIn {
  id: string
  clauseType: string
  content: string
  sectionRef: string | null
  sortOrder: number
  positionVerdict?: PositionVerdict | null
  /** The template or library source its words are still, unchanged. */
  standardSource?: string | null
}

export interface CategoryIn extends PresenceRule {}

export interface PositionIn {
  id: string
  clauseCategoryId: string
  positionType: string
  content: string
  rules: unknown
}

export interface ReviewInput {
  contractType: string
  categories: CategoryIn[]
  positions: PositionIn[]
  current: ClauseIn[]
  currentText: string
  baseline: { clauses: ClauseIn[]; text: string; versionNumber: number | null } | null
  /** Deletions found on an earlier version whose clause type is still gone. */
  carriedDeleted?: FindingDraft[]
}

export interface ReviewOutput {
  findings: FindingDraft[]
  /** Clauses changed or added since the baseline (all of them when there is none). */
  changedClauseIds: string[]
}

/** Below this share of a clause's words kept, it was cut, not edited. */
export const CUT_THRESHOLD = 0.7
/** Below this share of words in common, two clauses are about different things. */
const SAME_THING = 0.3
/** Clause types too broad to say anything about when they come and go. */
const NOISE = new Set(['general', 'other', 'unclassified'])
/** Added text shorter than this, outside any clause, is not a finding of its own (a heading, a date). */
const ADDED_MIN_WORDS = 12

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 }
const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const short = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)
const hash8 = (s: string) => createHash('sha256').update(normaliseText(s)).digest('hex').slice(0, 10)

/** The label a clause type goes by on screen. */
function labelOf(clauseType: string | null, category: MatchedCategory | null): string {
  if (category && (!clauseType || NOISE.has(clauseType))) return category.name
  return clauseType ? clauseTypeLabel(clauseType) : 'New text'
}

// ── Clause diff ──────────────────────────────────────────────────────────────

export interface ClausePair { before: ClauseIn; after: ClauseIn; likeness: number }

/**
 * Pair the baseline's clauses with this version's: the same type and the
 * most words in common first; a clause re-typed by a new analysis pairs too
 * when nearly all its words are shared.
 */
export function pairClauses(before: ClauseIn[], after: ClauseIn[]): { pairs: ClausePair[]; gone: ClauseIn[]; added: ClauseIn[] } {
  const bags = new Map<string, Set<string>>()
  const bag = (c: ClauseIn) => { let b = bags.get(c.id); if (!b) { b = wordBag(c.content); bags.set(c.id, b) } return b }
  const cand: Array<ClausePair & { same: boolean }> = []
  for (const b of before) {
    for (const a of after) {
      const same = b.clauseType === a.clauseType
      const sim = fold(b.content) === fold(a.content) ? 1 : likeness(bag(b), bag(a))
      if ((same && sim >= SAME_THING) || sim >= 0.8) cand.push({ before: b, after: a, likeness: sim, same })
    }
  }
  cand.sort((x, y) => (y.likeness - x.likeness) || (Number(y.same) - Number(x.same)) || (x.after.sortOrder - y.after.sortOrder))
  const usedB = new Set<string>(), usedA = new Set<string>()
  const pairs: ClausePair[] = []
  for (const c of cand) {
    if (usedB.has(c.before.id) || usedA.has(c.after.id)) continue
    usedB.add(c.before.id); usedA.add(c.after.id)
    pairs.push({ before: c.before, after: c.after, likeness: c.likeness })
  }
  return { pairs, gone: before.filter(b => !usedB.has(b.id)), added: after.filter(a => !usedA.has(a.id)) }
}

interface TextRun { text: string; start: number; end: number }

const WORD = /[\p{L}\p{N}]+(?:['’\-‐‑][\p{L}\p{N}]+)*/gu

/** The stretches of `after` with no counterpart in `before`, word by word. */
export function insertedRuns(before: string, after: string): TextRun[] {
  const tb = [...before.matchAll(WORD)].map(m => ({ key: fold(m[0]).toLowerCase(), start: m.index!, end: m.index! + m[0].length }))
  const ta = [...after.matchAll(WORD)].map(m => ({ key: fold(m[0]).toLowerCase(), start: m.index!, end: m.index! + m[0].length }))
  const runs: TextRun[] = []
  let cur: { start: number; end: number } | null = null
  for (const op of diffSequences(tb, ta, t => t.key)) {
    if (op.kind === 'insert') {
      const t = ta[op.bi]
      cur = cur ? { start: cur.start, end: t.end } : { start: t.start, end: t.end }
    } else if (op.kind === 'equal') {
      if (cur) { runs.push({ ...cur, text: after.slice(cur.start, cur.end) }); cur = null }
    }
  }
  if (cur) runs.push({ ...cur, text: after.slice(cur.start, cur.end) })
  return runs
}

// ── The findings ─────────────────────────────────────────────────────────────

const RULE_SEVERITY: Record<string, Severity> = { low: 'low', medium: 'medium', high: 'high', critical: 'critical', walkaway: 'critical' }

/** The sentence of `text` around the first place `needle` is (case-insensitive). */
function around(text: string, needle: string): string | null {
  const i = text.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return null
  const s = Math.max(0, text.lastIndexOf('.', i) + 1)
  const e = text.indexOf('.', i + needle.length)
  return text.slice(s, e < 0 ? text.length : e + 1).trim()
}

/** Pure: every finding for a version, given its clauses, the baseline's, the playbook and the model's verdicts. */
export function computeFindings(input: ReviewInput): ReviewOutput {
  const { current, baseline, categories } = input
  const since = baseline?.versionNumber != null ? `v${baseline.versionNumber}` : 'the last version'
  const cats: MatchedCategory[] = categories.map(c => ({ id: c.id, name: c.name }))
  const categoryOf = (t: string | null) => (t ? matchCategory(cats, t) : null)
  const applicable = categories.filter(r => r.presence !== 'optional' && (r.presenceContractTypes.length === 0 || r.presenceContractTypes.includes(input.contractType)))
  const required = new Set(applicable.filter(r => r.presence === 'required').map(r => r.id))
  const out: FindingDraft[] = []
  const changed = new Set<string>()
  const nowText = normaliseText(input.currentText)

  const base = (c: { clauseType: string | null; id?: string | null }) => {
    const category = categoryOf(c.clauseType)
    return { clauseType: c.clauseType, clauseId: c.id ?? null, categoryId: category?.id ?? null, positionId: null, label: labelOf(c.clauseType, category), required: !!category && required.has(category.id) }
  }

  // 1. Against the baseline.
  if (baseline) {
    const thenText = normaliseText(baseline.text)
    const { pairs, gone, added } = pairClauses(baseline.clauses, current)
    const typesNow = new Set(current.map(c => c.clauseType))
    const goneTypes = new Set<string>()
    for (const b of gone) {
      // Its words are still in the document (a new analysis drew the clause's
      // lines differently): not deleted.
      if (nowText.includes(normaliseText(b.content))) continue
      const info = base({ clauseType: b.clauseType })
      const wholeType = !typesNow.has(b.clauseType)
      if (wholeType && goneTypes.has(b.clauseType)) {
        // One finding per clause type gone: its text grows.
        const f = out.find(x => x.kind === 'deleted' && x.key === `deleted|${b.clauseType}`)
        if (f) f.evidence.baselineQuote = short(`${f.evidence.baselineQuote ?? ''}\n\n${b.content}`, 2000)
        continue
      }
      if (wholeType) goneTypes.add(b.clauseType)
      out.push({
        kind: 'deleted',
        key: wholeType ? `deleted|${b.clauseType}` : `deleted|${b.clauseType}|${hash8(b.content)}`,
        clauseType: b.clauseType, clauseId: null, categoryId: info.categoryId, positionId: null,
        severity: info.required ? 'high' : NOISE.has(b.clauseType) ? 'low' : 'medium',
        title: wholeType ? `${info.label} — deleted since ${since}${info.required ? ' (required)' : ''}` : `Part of ${info.label} deleted since ${since}`,
        explanation: wholeType
          ? `This clause was in ${since} and is not in this version.${info.required ? ' Your playbook requires it for this type of contract.' : ''}`
          : `These words were in ${since} and are not in this version.`,
        evidence: { baselineQuote: short(b.content, 2000), sectionRef: b.sectionRef },
        source: 'deterministic',
      })
    }
    for (const { before: b, after: a } of pairs) {
      if (fold(b.content) === fold(a.content)) continue
      // Only where the lines fall changed: both clauses' words are in the other version.
      if (thenText.includes(normaliseText(a.content)) && nowText.includes(normaliseText(b.content))) continue
      changed.add(a.id)
      const info = base(a)
      const was = words(b.content), now = words(a.content)
      const cut = was >= 20 && now < was * CUT_THRESHOLD
      out.push({
        kind: cut ? 'material_cut' : 'modified',
        key: `${cut ? 'cut' : 'modified'}|${a.clauseType}|${hash8(b.content)}`,
        clauseType: a.clauseType, clauseId: a.id, categoryId: info.categoryId, positionId: null,
        severity: cut ? (info.required ? 'high' : 'medium') : 'medium',
        title: cut ? `${info.label} — cut by ${Math.round((1 - now / was) * 100)}% since ${since}` : `${info.label} — changed since ${since}`,
        explanation: cut
          ? `More than ${Math.round((1 - CUT_THRESHOLD) * 100)}% of this clause's words were removed since ${since}. What is left may still read well; check what was taken out.`
          : `The words of this clause changed since ${since}.`,
        evidence: { quote: short(a.content), baselineQuote: short(b.content), sectionRef: a.sectionRef },
        source: 'deterministic',
      })
    }
    for (const a of added) {
      if (thenText.includes(normaliseText(a.content))) continue
      changed.add(a.id)
      const info = base(a)
      out.push({
        kind: 'added', key: `added|${a.clauseType}|${hash8(a.content)}`,
        clauseType: a.clauseType, clauseId: a.id, categoryId: info.categoryId, positionId: null,
        severity: 'low',
        title: `${info.label} — added since ${since}`,
        explanation: `This clause was not in ${since}.`,
        evidence: { quote: short(a.content), sectionRef: a.sectionRef },
        source: 'deterministic',
      })
    }
    // Text added outside any clause, and text that doesn't read as language.
    for (const run of insertedRuns(baseline.text, input.currentText)) {
      const inClause = current.find(c => normaliseText(c.content).includes(normaliseText(run.text)))
      const r = readability(run.text)
      if (!r.readsAsLanguage) {
        const info = base(inClause ?? { clauseType: null })
        out.push({
          kind: 'unreadable_text', key: `unreadable|${hash8(run.text)}`,
          clauseType: inClause?.clauseType ?? null, clauseId: inClause?.id ?? null, categoryId: info.categoryId, positionId: null,
          severity: 'high',
          title: inClause ? `Text that doesn't read as language in ${info.label}` : 'Text that doesn\'t read as language',
          explanation: `Text added since ${since} doesn't read as words (${r.junk.slice(0, 4).map(w => `“${w}”`).join(', ')}). Remove it or rewrite it before this goes anywhere.`,
          evidence: { quote: short(run.text, 400), offsets: { start: run.start, end: run.end }, sectionRef: inClause?.sectionRef ?? null },
          source: 'deterministic',
        })
        if (inClause) changed.add(inClause.id)
      } else if (!inClause && r.words >= ADDED_MIN_WORDS) {
        out.push({
          kind: 'added', key: `added|text|${hash8(run.text)}`,
          clauseType: null, clauseId: null, categoryId: null, positionId: null,
          severity: 'low',
          title: `New text added since ${since}`,
          explanation: `This text was not in ${since}, and no clause of it was found to check against your playbook.`,
          evidence: { quote: short(run.text), offsets: { start: run.start, end: run.end } },
          source: 'deterministic',
        })
      }
    }
  } else {
    // No baseline: everything is new to review.
    for (const c of current) changed.add(c.id)
  }

  // Deleted on an earlier version, still gone.
  const typesNow = new Set(current.map(c => c.clauseType))
  for (const f of input.carriedDeleted ?? []) {
    if (f.kind !== 'deleted' || !f.clauseType || typesNow.has(f.clauseType) || out.some(o => o.key === f.key)) continue
    out.push({ ...f })
  }

  // 2. Presence rules: a required clause never found; a clause not allowed.
  const deletedCategories = new Set(out.filter(f => f.kind === 'deleted' && f.key.split('|').length === 2).map(f => f.categoryId))
  for (const p of presenceFindings({ rules: categories, contractType: input.contractType, current, baseline: null, versionId: '', baselineVersionId: null, baselineVersionNumber: null })) {
    const category = cats.find(c => c.name === p.label) ?? categoryOf(p.clauseType)
    if (p.kind === 'not_detected') {
      if (category && deletedCategories.has(category.id)) continue
      out.push({
        kind: 'missing_required', key: `missing|${category?.id ?? p.clauseType}`,
        clauseType: null, clauseId: null, categoryId: category?.id ?? null, positionId: null,
        severity: 'medium',
        title: `${p.label} — not detected`,
        explanation: `Your playbook requires this clause in this type of contract, and none was found. Find it in the document and tag it, or confirm it's missing.`,
        evidence: {},
        source: 'deterministic',
      })
    } else if (p.kind === 'not_allowed_present') {
      const clause = current.find(c => c.clauseType === p.clauseType)
      out.push({
        kind: 'not_allowed_present', key: `not_allowed|${category?.id ?? p.clauseType}`,
        clauseType: p.clauseType, clauseId: clause?.id ?? null, categoryId: category?.id ?? null, positionId: null,
        severity: 'high',
        title: `${p.label} — not allowed in this type of contract`,
        explanation: 'Your playbook does not allow this clause in this type of contract.',
        evidence: { quote: short(clause?.content ?? p.evidence.text ?? ''), sectionRef: clause?.sectionRef ?? null },
        source: 'deterministic',
      })
    }
  }

  // 3. The playbook's rules, on every clause (standard ones too: a rule may be about a variable's value).
  const byCategory = new Map<string, ClauseIn[]>()
  for (const c of current) {
    const cat = categoryOf(c.clauseType)
    if (cat) byCategory.set(cat.id, [...(byCategory.get(cat.id) ?? []), c])
  }
  for (const [categoryId, group] of byCategory) {
    const positions = input.positions.filter(p => p.clauseCategoryId === categoryId && p.rules)
    if (!positions.length) continue
    const name = cats.find(c => c.id === categoryId)?.name ?? clauseTypeLabel(group[0].clauseType)
    const { lead, texts } = ruleTextsFor(group)
    const seen = new Set<string>()
    for (const clause of group) {
      const t = texts.get(clause.id)!
      const results = dedupeViolations(positions.flatMap(pos =>
        evaluatePlaybookRules(pos.rules as PlaybookRules, t, pos.positionType).map(v => ({ ...v, positionId: pos.id }))))
      for (const v of results) {
        if (v.passed !== false) continue
        const ruleKey = String(v.ruleId ?? v.boundKey ?? v.description ?? v.value ?? '')
        const key = `rule|${categoryId}|${ruleKey}`
        if (seen.has(key)) continue
        seen.add(key)
        const where = v.kind === 'must_not' ? clause : lead
        const value = typeof v.value === 'string' ? v.value : ''
        const quote = v.kind === 'must_not' && value ? around(where.content, value) ?? short(where.content, 300) : short(where.content, 300)
        out.push({
          kind: 'position_not_met', key,
          clauseType: where.clauseType, clauseId: where.id, categoryId, positionId: (v.positionId as string) ?? null,
          severity: RULE_SEVERITY[String(v.severity)] ?? 'high',
          title: `${name}: ${String(v.description ?? 'a playbook rule is not met')}`,
          explanation: v.kind === 'must_have'
            ? `Your playbook requires this clause to say “${value}”, and it doesn't.`
            : v.kind === 'must_not'
              ? `Your playbook says this clause must not say “${value}”, and it does.`
              : String(v.reason ?? `This clause is outside the limit your playbook sets${v.units ? ` (${v.units})` : ''}.`),
          evidence: { quote, sectionRef: where.sectionRef, ruleId: ruleKey },
          source: 'deterministic',
        })
      }
    }
  }

  // 4. The model's position verdicts, and what they settle.
  const verdictOf = new Map(current.filter(c => c.positionVerdict && !c.standardSource).map(c => [c.id, c.positionVerdict!]))
  const positionById = new Map(input.positions.map(p => [p.id, p]))
  for (const c of current) {
    const v = verdictOf.get(c.id)
    if (!v || v.verdict === 'meets_preferred' || v.verdict === 'not_covered') continue
    const info = base(c)
    const pos = v.positionId ? positionById.get(v.positionId) : undefined
    // At or past a walkaway position: stop, not just look again.
    const walkaway = (pos?.positionType ?? v.positionType) === 'walkaway'
    const categoryId = pos?.clauseCategoryId ?? info.categoryId
    const kind: FindingKind = v.verdict === 'meets_fallback' ? 'position_fallback' : v.verdict === 'needs_approval' ? 'needs_approval_position' : 'position_not_met'
    out.push({
      kind, key: `position|${c.clauseType}|${hash8(c.content)}`,
      clauseType: c.clauseType, clauseId: c.id, categoryId, positionId: v.positionId,
      severity: kind === 'position_fallback' ? 'low' : kind === 'position_not_met' && walkaway ? 'critical' : 'high',
      title: kind === 'position_fallback' ? `${info.label}: your fallback position`
        : kind === 'needs_approval_position' ? `${info.label}: a position that needs approval`
        : `${info.label}: not one of your positions`,
      explanation: v.explanation,
      evidence: { quote: v.quote, sectionRef: c.sectionRef },
      source: 'llm',
    })
  }
  // A change that lands on a position you've approved, or back on the
  // template's words, needs nothing more.
  for (const f of out) {
    if ((f.kind !== 'modified' && f.kind !== 'added') || !f.clauseId) continue
    const c = current.find(x => x.id === f.clauseId)
    if (c?.standardSource) { f.status = 'resolved'; f.resolutionNote = 'Same words as the template.'; continue }
    const v = verdictOf.get(f.clauseId)
    if (v?.verdict === 'meets_preferred') { f.status = 'resolved'; f.resolutionNote = 'Matches your preferred position.' }
    else if (v?.verdict === 'meets_fallback') { f.status = 'resolved'; f.resolutionNote = 'Matches your fallback position.' }
  }

  const rank = (f: FindingDraft) => (f.status === 'resolved' ? -10 : 0) + SEVERITY_RANK[f.severity]
  out.sort((a, b) => rank(b) - rank(a))
  return { findings: out, changedClauseIds: [...changed] }
}

/** Which clauses the model's position check should read: changed (or never baselined), not standard, not judged yet. */
export function positionCheckTargets(current: ClauseIn[], changedClauseIds: string[]): ClauseIn[] {
  const changed = new Set(changedClauseIds)
  return current.filter(c => changed.has(c.id) && !c.standardSource && !c.positionVerdict)
}

// ── The baseline ─────────────────────────────────────────────────────────────

export type BaselineReason = 'approved' | 'sent' | 'origin' | 'analysed'

export interface Baseline { versionId: string; versionNumber: number; reason: BaselineReason }

const BASELINE_WORDS: Record<BaselineReason, string> = {
  approved: 'the last approved version',
  sent: 'the last version sent to the counterparty',
  origin: 'the version generated from the template',
  analysed: 'the version analysed before this one',
}
export const baselineWords = (r: BaselineReason) => BASELINE_WORDS[r]

/**
 * The version a version is reviewed against: the latest of the last one
 * sent, approved or generated that came before it and was analysed; else
 * the one analysed before it.
 */
export async function resolveBaseline(contractId: string, version: { id: string; versionNumber: number }): Promise<Baseline | null> {
  const earlier = await prisma.contractVersion.findMany({
    where: { contractId, versionNumber: { lt: version.versionNumber }, clauses: { some: { isSubChunk: false } } },
    select: { id: true, versionNumber: true },
    orderBy: { versionNumber: 'desc' },
  })
  if (!earlier.length) return null
  const byId = new Map(earlier.map(v => [v.id, v]))
  const byNumber = new Map(earlier.map(v => [v.versionNumber, v]))
  const marks: Array<{ id: string; reason: BaselineReason }> = []

  const [approved, signing, shared, exported, origin] = await Promise.all([
    prisma.approvalInstance.findMany({ where: { contractId, status: { in: ['APPROVED', 'AUTO_APPROVED'] }, versionId: { not: null } }, select: { versionId: true } }),
    prisma.signatureRequest.findMany({ where: { contractId }, select: { versionId: true } }),
    prisma.auditEvent.findMany({ where: { resourceType: 'contract', resourceId: contractId, action: 'LINK_SHARED' }, select: { metadata: true } }),
    prisma.auditEvent.findMany({ where: { resourceType: 'contract', resourceId: contractId, action: 'REDLINE_EXPORTED' }, select: { metadata: true } }),
    prisma.contractVersion.findFirst({ where: { contractId, htmlContent: { contains: 'data-fp="' } }, orderBy: { versionNumber: 'asc' }, select: { id: true } }),
  ])
  for (const a of approved) if (a.versionId) marks.push({ id: a.versionId, reason: 'approved' })
  for (const s of signing) marks.push({ id: s.versionId, reason: 'sent' })
  for (const e of shared) { const v = (e.metadata as { versionId?: string } | null)?.versionId; if (v) marks.push({ id: v, reason: 'sent' }) }
  for (const e of exported) { const n = (e.metadata as { versionNumber?: number } | null)?.versionNumber; const v = n != null ? byNumber.get(n) : undefined; if (v) marks.push({ id: v.id, reason: 'sent' }) }
  if (origin) marks.push({ id: origin.id, reason: 'origin' })

  const best = marks
    .filter(m => byId.has(m.id))
    .sort((a, b) => byId.get(b.id)!.versionNumber - byId.get(a.id)!.versionNumber)[0]
  if (best) return { versionId: best.id, versionNumber: byId.get(best.id)!.versionNumber, reason: best.reason }

  // The version analysed before this one: the latest earlier finished run's, else the latest earlier version with clauses.
  const run = await prisma.analysisRun.findFirst({
    where: { contractId, status: 'done', versionId: { in: earlier.map(v => v.id) } },
    orderBy: { startedAt: 'desc' },
    select: { versionId: true },
  })
  const prev = (run && byId.get(run.versionId)) ?? earlier[0]
  return { versionId: prev.id, versionNumber: prev.versionNumber, reason: 'analysed' }
}

// ── Working them out for a version, and keeping them ─────────────────────────

const clausesOf = async (versionId: string): Promise<Array<ClauseIn & { provenance: string | null; sourceRef: string | null }>> => {
  const rows = await prisma.contractClause.findMany({
    where: { versionId, isSubChunk: false },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, clauseType: true, content: true, sectionRef: true, sortOrder: true, positionVerdict: true, provenance: true, sourceRef: true },
  })
  return rows.map(r => ({ ...r, positionVerdict: (r.positionVerdict as PositionVerdict | null) ?? null }))
}

/** Decided by a person: carried to the same finding on a later version while its words are the same. */
const DECIDED: FindingStatus[] = ['accepted', 'resolved', 'exception_requested', 'exception_approved', 'exception_declined']

export interface ComputedReview {
  versionId: string
  baseline: Baseline | null
  findings: FindingDraft[]
  changedClauseIds: string[]
  /** Clause ids whose words are still the template's or library's. */
  standardClauseIds: string[]
}

/**
 * Work out a version's findings and store them (replacing its earlier ones,
 * keeping what people decided), and mark which clauses are standard.
 */
export async function computeAndStoreFindings(contractId: string, versionId: string): Promise<ComputedReview | null> {
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    select: { id: true, orgId: true, type: true, playbookId: true, metadata: true },
  })
  const version = await prisma.contractVersion.findFirst({
    where: { id: versionId, contractId },
    select: { id: true, versionNumber: true, plainText: true, htmlContent: true, createdById: true },
  })
  if (!contract || !version) return null
  const orgId = contract.orgId

  const baseline = await resolveBaseline(contractId, version)
  const [current, baselineClauses, baselineVersion, categories, playbook, origin] = await Promise.all([
    clausesOf(versionId),
    baseline ? clausesOf(baseline.versionId) : Promise.resolve([]),
    baseline ? prisma.contractVersion.findUnique({ where: { id: baseline.versionId }, select: { plainText: true } }) : Promise.resolve(null),
    prisma.clauseCategory.findMany({ where: { orgId }, select: { id: true, name: true, presence: true, presenceContractTypes: true } }),
    contractPlaybook(orgId, contract),
    // The generated versions up to this one: the first is the draft as made;
    // a later one can carry a clause choice made after (routes/draft-origin.ts).
    prisma.contractVersion.findMany({
      where: { contractId, versionNumber: { lte: version.versionNumber }, htmlContent: { contains: 'data-fp="' } },
      orderBy: { versionNumber: 'asc' },
      take: 20,
      select: { htmlContent: true },
    }),
  ])
  const positions = playbook.where
    ? await prisma.playbookPosition.findMany({ where: playbook.where, select: { id: true, clauseCategoryId: true, positionType: true, content: true, rules: true } })
    : []

  // Fingerprints: which clauses are still the generated words.
  // A draft's recorded origin (metadata._origin.sections) is preferred: it
  // names the fingerprints the draft was made with.
  const recorded = (contract.metadata as { _origin?: { sections?: Array<{ fp: string; source: string }> } } | null)?._origin?.sections
  const generated = generatedSections(origin, recorded)
  const spans = generated.length ? standardSpans(generated, version.plainText, version.htmlContent ?? '') : []
  const counterparty = /^(portal|email):/.test(version.createdById)
  const provenance = new Map<string, { provenance: string; sourceRef: string | null }>()
  for (const c of current) {
    const source = spans.length ? standardSourceOf(c.content, spans) : null
    c.standardSource = source
    provenance.set(c.id, source
      ? { provenance: provenanceOf(source), sourceRef: source }
      : { provenance: counterparty ? 'counterparty' : generated.length ? 'internal_edit' : (c.provenance ?? 'unknown'), sourceRef: null })
  }
  for (const c of baselineClauses) c.standardSource = c.sourceRef ?? null

  // Deletions remembered from the version reviewed before, while the clause stays gone.
  const carriedDeleted = await prisma.reviewFinding.findMany({
    where: { contractId, kind: 'deleted', versionId: { not: versionId } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const latestOther = carriedDeleted[0]?.versionId
  const result = computeFindings({
    contractType: contract.type,
    categories,
    positions,
    current,
    currentText: version.plainText,
    baseline: baseline ? { clauses: baselineClauses, text: baselineVersion?.plainText ?? '', versionNumber: baseline.versionNumber } : null,
    carriedDeleted: carriedDeleted.filter(f => f.versionId === latestOther).map(f => ({
      kind: 'deleted', key: f.key, clauseType: f.clauseType, clauseId: null, categoryId: f.categoryId, positionId: null,
      severity: f.severity as Severity, title: f.title, explanation: f.explanation, evidence: f.evidence as Evidence, source: 'deterministic',
    })),
  })

  await storeFindings({ orgId, contractId, versionId, baselineVersionId: baseline?.versionId ?? null, drafts: result.findings })
  const stamp: ReviewStamp = { computedAt: new Date().toISOString(), baselineVersionId: baseline?.versionId ?? null, baselineVersionNumber: baseline?.versionNumber ?? null, baselineReason: baseline?.reason ?? null }
  // jsonb_set: the version's other metadata (its structure, its redline) is written elsewhere.
  await prisma.$executeRaw`UPDATE contract_versions SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_review}', ${JSON.stringify(stamp)}::jsonb) WHERE id = ${versionId}`

  // Provenance on the clauses, grouped into as few writes as there are sources.
  const groups = new Map<string, string[]>()
  for (const [id, p] of provenance) {
    const k = `${p.provenance}\u0000${p.sourceRef ?? ''}`
    groups.set(k, [...(groups.get(k) ?? []), id])
  }
  for (const [k, ids] of groups) {
    const [prov, ref] = k.split('\u0000')
    await prisma.contractClause.updateMany({ where: { id: { in: ids } }, data: { provenance: prov, sourceRef: ref || null } })
  }

  return {
    versionId,
    baseline,
    findings: result.findings,
    changedClauseIds: result.changedClauseIds,
    standardClauseIds: current.filter(c => c.standardSource).map(c => c.id),
  }
}

/**
 * Replace a version's findings of `kinds` with `drafts` (the clause review's
 * kinds by default), keeping each one's decision; a decision on an earlier
 * version carries while the words are the same.
 */
export async function storeFindings(opts: { orgId: string; contractId: string; versionId: string; baselineVersionId: string | null; drafts: FindingDraft[]; kinds?: FindingKind[] }): Promise<void> {
  const { orgId, contractId, versionId, baselineVersionId, drafts } = opts
  const kinds = opts.kinds ?? ALL_KINDS.filter(REVIEW_KINDS)
  const [existing, earlier] = await Promise.all([
    prisma.reviewFinding.findMany({ where: { versionId, kind: { in: kinds } } }),
    prisma.reviewFinding.findMany({
      where: { contractId, versionId: { not: versionId }, key: { in: drafts.map(d => d.key) }, status: { in: DECIDED }, resolvedById: { not: null } },
      orderBy: { updatedAt: 'desc' },
    }),
  ])
  const had = new Map(existing.map(f => [f.key, f]))
  const quoteOf = (e: unknown) => normaliseText(((e as Evidence | null)?.quote ?? (e as Evidence | null)?.baselineQuote ?? ''))
  const keep = new Set(drafts.map(d => d.key))
  await prisma.$transaction(async tx => {
    await tx.reviewFinding.deleteMany({ where: { versionId, kind: { in: kinds }, key: { notIn: [...keep] } } })
    for (const d of drafts) {
      const data = {
        baselineVersionId, kind: d.kind, clauseType: d.clauseType, clauseId: d.clauseId, categoryId: d.categoryId, positionId: d.positionId,
        severity: d.severity, title: d.title, explanation: d.explanation, evidence: d.evidence as object, source: d.source,
      }
      const prior = had.get(d.key)
      // A person's decision on this version stands while the words it was about are the same.
      if (prior && prior.resolvedById && DECIDED.includes(prior.status as FindingStatus) && quoteOf(prior.evidence) === quoteOf(d.evidence)) {
        await tx.reviewFinding.update({ where: { id: prior.id }, data })
        continue
      }
      const carried = earlier.find(f => f.key === d.key && quoteOf(f.evidence) === quoteOf(d.evidence))
      const decision = carried
        ? { status: carried.status, resolvedById: carried.resolvedById, resolvedAt: carried.resolvedAt, resolutionNote: carried.resolutionNote }
        : { status: d.status ?? 'open', resolvedById: null, resolvedAt: d.status === 'resolved' ? new Date() : null, resolutionNote: d.resolutionNote ?? null }
      if (prior) await tx.reviewFinding.update({ where: { id: prior.id }, data: { ...data, ...decision } })
      else await tx.reviewFinding.create({ data: { orgId, contractId, versionId, key: d.key, ...data, ...decision } })
    }
  })
}

/** What `ContractVersion.metadata._review` holds once a version's findings are worked out. */
export interface ReviewStamp { computedAt: string; baselineVersionId: string | null; baselineVersionNumber: number | null; baselineReason: BaselineReason | null }

export function reviewStampOf(metadata: unknown): ReviewStamp | null {
  const r = (metadata as { _review?: ReviewStamp } | null)?._review
  return r && typeof r.computedAt === 'string' ? r : null
}

/**
 * The findings of a version, worked out now if they never were (a version
 * edited since its analysis, or analysed before findings existed: the old
 * `_presence` stamp is not read).
 */
export async function findingsFor(contractId: string, versionId: string) {
  const version = await prisma.contractVersion.findFirst({ where: { id: versionId, contractId }, select: { metadata: true } })
  if (!version) return []
  if (!reviewStampOf(version.metadata)) await computeAndStoreFindings(contractId, versionId)
  return prisma.reviewFinding.findMany({ where: { contractId, versionId }, orderBy: { createdAt: 'asc' } })
}
