/**
 * docs/41 P0.3 — what is missing, and what was taken out.
 *
 * Every check used to loop over the clauses a contract has, so a clause that
 * isn't there could never be flagged: delete Governing Law and nothing was
 * left to complain about, and the AI recommended approval. Two deterministic
 * checks, no model:
 *
 *   - presence rules: a category the org's playbook marks `required` for this
 *     contract type with no clause of it is "Not detected — find it or
 *     confirm it's missing" (only as reliable as clause detection, so it is
 *     worded as not detected, not as missing, and never blocks on its own);
 *     a `not_allowed` category with a clause of it is flagged;
 *   - against the version analysed before (the baseline): a clause type that
 *     was there and is gone is "Deleted since vN", with the deleted text; a
 *     clause cut by more than 30% is flagged too ("half of Exclusions").
 *
 * docs/41 P1 — these checks are now two of the review-findings service's
 * sources (lib/review-findings.ts), which stores ReviewFinding rows; the
 * deletion and cut checks there work clause by clause, against the version
 * a person relied on.
 */
import { clauseTypeLabel } from '@clm/types'
import { matchCategory, type MatchedCategory } from './clause-category.js'
import { asStep } from './analysis-runs.js'
import { computeAndStoreFindings, type ComputedReview } from './review-findings.js'

export type PresenceFindingKind = 'not_detected' | 'deleted' | 'cut' | 'not_allowed_present'

export interface PresenceFinding {
  kind: PresenceFindingKind
  clauseType: string
  /** What the screens call it: the clause type's name, or the category's for a whole category not found. */
  label: string
  severity: 'medium' | 'high'
  /** The org's playbook requires this clause for the contract's type. */
  required: boolean
  /** One plain sentence. */
  message: string
  /** The words that show it: the deleted text, the text before and after a cut, the clause that isn't allowed. */
  evidence: { text?: string; before?: string; after?: string; sectionRef?: string | null }
  versionId: string
  baselineVersionId: string | null
  baselineVersionNumber: number | null
}

export interface PresenceRule {
  id: string
  name: string
  presence: string
  presenceContractTypes: string[]
}

export interface ClauseLike {
  clauseType: string
  content: string
  sectionRef?: string | null
}

/** Below this share of a clause type's words kept, it was cut, not edited. */
export const CUT_THRESHOLD = 0.7

const words = (s: string) => s.split(/\s+/).filter(Boolean).length
/** Clause types too broad to say anything about when they come and go. */
const NOISE = new Set(['general', 'other'])

/** The rules that apply to a contract of this type, without the optional ones. */
export function applicableRules(rules: PresenceRule[], contractType: string): PresenceRule[] {
  return rules.filter(r => r.presence !== 'optional'
    && (r.presenceContractTypes.length === 0 || r.presenceContractTypes.includes(contractType)))
}

/**
 * The findings for `current` (the version's clauses) against the rules and,
 * when there is one, the version analysed before it. Pure.
 */
export function presenceFindings(input: {
  rules: PresenceRule[]
  contractType: string
  current: ClauseLike[]
  baseline: ClauseLike[] | null
  versionId: string
  baselineVersionId: string | null
  baselineVersionNumber: number | null
}): PresenceFinding[] {
  const { current, baseline, versionId, baselineVersionId, baselineVersionNumber } = input
  const rules = applicableRules(input.rules, input.contractType)
  const categories: MatchedCategory[] = input.rules.map(r => ({ id: r.id, name: r.name }))
  const categoryOf = (clauseType: string) => matchCategory(categories, clauseType)?.id ?? null
  const since = baselineVersionNumber != null ? `v${baselineVersionNumber}` : 'the last analysed version'
  const base = { versionId, baselineVersionId, baselineVersionNumber }
  const out: PresenceFinding[] = []

  const typesNow = new Set(current.map(c => c.clauseType))
  const requiredCategory = new Set(rules.filter(r => r.presence === 'required').map(r => r.id))

  // Gone since the baseline: every clause type, required or not.
  const deletedTypes = new Set<string>()
  if (baseline) {
    const byType = new Map<string, ClauseLike[]>()
    for (const c of baseline) byType.set(c.clauseType, [...(byType.get(c.clauseType) ?? []), c])
    for (const [type, was] of byType) {
      if (NOISE.has(type)) continue
      const cat = categoryOf(type)
      const required = !!cat && requiredCategory.has(cat)
      const label = clauseTypeLabel(type)
      if (!typesNow.has(type)) {
        deletedTypes.add(type)
        out.push({
          ...base, kind: 'deleted', clauseType: type, label, required,
          severity: required ? 'high' : 'medium',
          message: `${label} — deleted since ${since}${required ? ' (required)' : ''}.`,
          evidence: { text: was.map(c => c.content).join('\n\n').slice(0, 2000), sectionRef: was[0].sectionRef ?? null },
        })
        continue
      }
      const before = was.reduce((n, c) => n + words(c.content), 0)
      const nowRows = current.filter(c => c.clauseType === type)
      const after = nowRows.reduce((n, c) => n + words(c.content), 0)
      if (before >= 20 && after < before * CUT_THRESHOLD) {
        out.push({
          ...base, kind: 'cut', clauseType: type, label, required,
          severity: required ? 'high' : 'medium',
          message: `${label} — cut by ${Math.round((1 - after / before) * 100)}% since ${since}.`,
          evidence: { before: was.map(c => c.content).join('\n\n').slice(0, 2000), after: nowRows.map(c => c.content).join('\n\n').slice(0, 2000), sectionRef: nowRows[0]?.sectionRef ?? null },
        })
      }
    }
  }

  for (const r of rules) {
    const here = current.filter(c => categoryOf(c.clauseType) === r.id)
    if (r.presence === 'required' && here.length === 0) {
      // Already said: it was deleted. Otherwise it was never found.
      const deletedHere = [...deletedTypes].some(t => categoryOf(t) === r.id)
      if (deletedHere) continue
      out.push({
        ...base, kind: 'not_detected', clauseType: r.name, label: r.name, required: true, severity: 'medium',
        message: `${r.name} — not detected. Find it in the document or confirm it's missing.`,
        evidence: {},
      })
    }
    if (r.presence === 'not_allowed' && here.length > 0) {
      out.push({
        ...base, kind: 'not_allowed_present', clauseType: here[0].clauseType, label: r.name, required: false, severity: 'high',
        message: `${r.name} — your playbook does not allow this clause in this type of contract.`,
        evidence: { text: here[0].content.slice(0, 2000), sectionRef: here[0].sectionRef ?? null },
      })
    }
  }

  // Required first, then by how serious.
  const rank = (f: PresenceFinding) => (f.required ? 0 : 2) + (f.severity === 'high' ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b))
}

/**
 * docs/41 P1 — run after a version's analysis is stamped (analysis-trigger
 * finishAnalysis): its review findings (lib/review-findings.ts), worked out
 * and stored, as the last step of its analysis run. They used to be stored
 * here as `metadata._presence`; ReviewFinding rows replace that.
 *
 * docs/41 Parts 9, 10 — then the review steps that follow on every analysed
 * version (lib/version-review-steps.ts): the defined-terms checks, in place,
 * and the compliance step, queued. Not after a findings step that failed:
 * reopening its run would hide the failure.
 */
export async function afterAnalysis(contractId: string, versionId: string): Promise<ComputedReview | null> {
  let review: ComputedReview | null
  try {
    review = await asStep(contractId, versionId, 'findings', () => computeAndStoreFindings(contractId, versionId), {
      last: true,
      counts: r => ({ findings: r?.findings.filter(f => f.status !== 'resolved').length ?? 0, standardClauses: r?.standardClauseIds.length ?? 0, changedClauses: r?.changedClauseIds.length ?? 0 }),
    })
  } catch (err) {
    console.warn('[presence] findings not computed contractId=%s: %s', contractId, (err as Error).message)
    return null
  }
  const { draftingStep, queueComplianceStep } = await import('./version-review-steps.js')
  await draftingStep(contractId, versionId)
  await queueComplianceStep(contractId, versionId).catch(err => console.warn('[presence] compliance step not queued contractId=%s: %s', contractId, (err as Error).message))
  // docs/41 Part 15 — a counterparty's version: the model's advice on each of their changes.
  const { queueChangeAdviceStep } = await import('./change-advice.js')
  await queueChangeAdviceStep(contractId, versionId).catch(err => console.warn('[presence] change advice not queued contractId=%s: %s', contractId, (err as Error).message))
  return review
}
