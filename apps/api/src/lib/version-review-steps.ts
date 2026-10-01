/**
 * docs/41 Parts 9 and 10 — the review steps that follow the findings on every
 * analysed version (presence-rules afterAnalysis, for a full analysis and an
 * incremental one alike), each a step of the version's analysis run:
 *
 *   drafting    the defined-terms checks: deterministic, run in place;
 *   compliance  which frameworks apply (one fast model call for the facts
 *               when the text changed) and the checks of those that do: a
 *               queued job (`compliance-review`), so the analysis never waits
 *               on a model.
 *
 * Both store review findings (kinds `drafting` and `compliance`), which the
 * Review panel lists and the recommendation's policy reads. Neither can fail
 * the contract's analysis.
 */
import { prisma } from './prisma.js'
import { asStep, type StepOutcome } from './analysis-runs.js'
import { computeDraftingFindings } from './drafting-findings.js'
import { runComplianceApplicability } from './compliance-facts.js'
import { storeComplianceFindings } from './compliance-findings.js'

/** The defined-terms checks of a version, as its `drafting` step. A failure is the run's, never the analysis'. */
export async function draftingStep(contractId: string, versionId: string): Promise<void> {
  try {
    await asStep(contractId, versionId, 'drafting', () => computeDraftingFindings(contractId, versionId), {
      counts: issues => ({ findings: issues?.length ?? 0 }),
    })
  } catch (err) {
    console.warn('[review-steps] drafting findings failed contractId=%s: %s', contractId, (err as Error)?.message ?? err)
  }
}

/** The `compliance-review` job: applicability, the checks, and the findings. Recorded by runJobStep. */
export async function complianceStep(contractId: string, versionId: string): Promise<StepOutcome> {
  const out = await runComplianceApplicability(contractId, versionId)
  if (out.skipped === 'not the version the contract stands on' || out.skipped === 'the contract is gone') return { skipped: out.skipped }
  // What applies and what was checked before still make findings when this
  // run's read failed (the text is unchanged, or a person answered).
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { orgId: true } })
  const stored = contract ? await storeComplianceFindings(contract.orgId, contractId) : null
  if (out.skipped) return { skipped: out.skipped, counts: { findings: stored?.findings ?? 0 } }
  return { counts: { frameworks: out.frameworks ?? 0, checked: out.checked ?? 0, findings: stored?.findings ?? 0 } }
}

/** Queue the compliance step of an analysed version. */
export async function queueComplianceStep(contractId: string, versionId: string, opts: { again?: boolean } = {}): Promise<void> {
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { orgId: true } })
  if (!contract) return
  // Imported here: the queue module opens a Redis connection when loaded.
  const { queueComplianceReview } = await import('./queue.js')
  queueComplianceReview({ contractId, orgId: contract.orgId, versionId }, opts)
}
