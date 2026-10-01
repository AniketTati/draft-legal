/**
 * docs/41 Parts 9 and 10 — the review steps that run on each analysed
 * version: the defined-terms checks (deterministic) and compliance
 * applicability (one fast model call for the facts when the text changed,
 * then the checks for what applies). Called once from the parse worker's
 * chunk-and-index; neither step can fail the analysis.
 */
import { computeDraftingFindings } from './drafting-findings.js'
import { runComplianceApplicability } from './compliance-facts.js'

export async function runVersionReviewSteps({ contractId, versionId }: { contractId: string; versionId: string }): Promise<void> {
  try {
    await computeDraftingFindings(contractId, versionId)
  } catch (err) {
    console.warn('[review-steps] drafting findings failed contractId=%s: %s', contractId, (err as Error)?.message ?? err)
  }
  await runComplianceApplicability(contractId, versionId)
}
