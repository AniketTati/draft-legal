/**
 * docs/41 Part 10 — the review steps that run on each analysed version: the
 * defined-terms checks (deterministic). Called once from the parse worker's
 * chunk-and-index; a step can never fail the analysis.
 */
import { computeDraftingFindings } from './drafting-findings.js'

export async function runVersionReviewSteps({ contractId, versionId }: { contractId: string; versionId: string }): Promise<void> {
  try {
    await computeDraftingFindings(contractId, versionId)
  } catch (err) {
    console.warn('[review-steps] drafting findings failed contractId=%s: %s', contractId, (err as Error)?.message ?? err)
  }
}
