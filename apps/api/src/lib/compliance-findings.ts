/**
 * Compliance findings (docs/41 Part 9): each requirement of a framework that
 * applies to the contract (lib/compliance-facts.ts) which the check found
 * missing, partly met or at risk, stored as a review finding (kind
 * `compliance`) of the version that was checked. The Review panel lists them
 * under "Compliance"; a high one holds the recommendation at Review.
 *
 * Only results for the version's own text count (the report's text hash), and
 * only for frameworks that apply now: a framework that stops applying (a
 * person answered "no personal data") takes its findings with it.
 */
import { COMPLIANCE_FRAMEWORK_LABELS, type ComplianceFrameworkId } from '@clm/types'
import { prisma } from './prisma.js'
import { textHashOf, type ComplianceCheckItem, type ComplianceReport } from './compliance-check.js'
import type { PolicyEvaluation } from './compliance-policy.js'
import { complianceApplicability } from './compliance-facts.js'
import { storeFindings, type FindingDraft, type Severity } from './review-findings.js'

const SERIOUS = new Set(['high', 'critical'])

/**
 * How serious a requirement not met is, for the review: a missing or risky
 * one the check rates high is high, else medium; a partly met one is medium
 * when it matters, else low. Never critical: the frameworks were worked out
 * from facts the AI read, so a gap is for a person to look at (Review), not a
 * reason to escalate on its own.
 */
export function complianceSeverity(check: Pick<ComplianceCheckItem, 'status' | 'severity'>): Severity | null {
  if (check.status === 'present') return null
  if (check.status === 'partial') return SERIOUS.has(check.severity) ? 'medium' : 'low'
  return SERIOUS.has(check.severity) ? 'high' : 'medium'
}

const STATUS_WORDS: Record<string, string> = { missing: 'missing', partial: 'partly met', risky: 'at risk' }

/** Why a framework applies, in a few words: the facts that decided it. */
function becauseOf(fw: PolicyEvaluation['frameworks'][number]): string {
  if (fw.addedByUser && !fw.because.length) return 'it was added by hand'
  return fw.because.map(b => {
    const label = b.label.charAt(0).toLowerCase() + b.label.slice(1)
    return Array.isArray(b.value) ? `${label}: ${b.value.join(', ')}` : label
  }).join('; ')
}

/**
 * Pure: the findings of a checked text. `report` must be for `textHash`
 * (else there are none: the check is for other words).
 */
export function complianceFindingDrafts(evaluation: Pick<PolicyEvaluation, 'frameworks'>, report: ComplianceReport | null, textHash: string): FindingDraft[] {
  if (!report || report.textHash !== textHash) return []
  const out: FindingDraft[] = []
  for (const fw of evaluation.frameworks) {
    if (fw.applies !== 'yes') continue
    const result = report.frameworks.find(r => r.framework === fw.framework)
    if (!result) continue
    const label = COMPLIANCE_FRAMEWORK_LABELS[fw.framework as ComplianceFrameworkId] ?? fw.framework
    const because = becauseOf(fw)
    const whyQuote = fw.because.find(b => b.quote)?.quote ?? null
    for (const check of result.checks) {
      const severity = complianceSeverity(check)
      if (!severity) continue
      out.push({
        kind: 'compliance',
        key: `compliance|${fw.framework}|${check.id}`,
        clauseType: null, clauseId: null, categoryId: null, positionId: null,
        severity,
        title: `${label}: ${check.requirement} — ${STATUS_WORDS[check.status] ?? check.status}`,
        explanation: [
          check.finding,
          check.recommendation,
          because ? `${label} applies to this contract: ${because}.` : null,
        ].filter(Boolean).join(' '),
        evidence: {
          ...(check.quote && { quote: check.quote }),
          // The words that made the framework apply.
          ...(whyQuote && { relatedQuote: whyQuote }),
          sectionRef: check.sectionRef, ruleId: `${fw.framework}:${check.id}`,
        },
        source: 'llm',
      })
    }
  }
  return out
}

/**
 * Store the compliance findings of the contract's current version, from what
 * applies and the last check. Called after anything that changes either:
 * the analysis step, a person's answer, a framework added, a check run.
 */
export async function storeComplianceFindings(orgId: string, contractId: string): Promise<{ versionId: string; findings: number } | null> {
  const a = await complianceApplicability(orgId, contractId)
  if (!a?.versionId) return null
  const version = await prisma.contractVersion.findUnique({ where: { id: a.versionId }, select: { plainText: true } })
  const drafts = complianceFindingDrafts(a, a.report, textHashOf(version?.plainText ?? ''))
  await storeFindings({ orgId, contractId, versionId: a.versionId, baselineVersionId: null, drafts, kinds: ['compliance'] })
  return { versionId: a.versionId, findings: drafts.length }
}
