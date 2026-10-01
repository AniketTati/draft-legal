/**
 * docs/41 P0.2 — the approval recommendation is never "approve" on what
 * wasn't checked.
 *
 * The approval agent's label came from a model that read a risk score of
 * `null` as 0 and a summary of the first 8,000 characters. On a contract
 * nobody had analysed that is "risk 0, no risks", and it said Approve; after
 * Governing Law was deleted it still said Approve, because nothing looked for
 * what was gone.
 *
 * This guard is code, not a model. The label "Ready to approve" is allowed
 * only when none of these hold; otherwise it becomes "Can't recommend", with
 * the reasons:
 *   - analysis missing, failed, running, or for an older version (stale);
 *   - no clauses found;
 *   - the risk score unknown (null is unknown, never 0);
 *   - a required clause not detected, or deleted (presence-rules.ts);
 *   - any clause deleted, or cut by more than 30%, since the last version
 *     analysed;
 *   - a clause the playbook doesn't allow;
 *   - a counterparty version arriving after the analysis.
 * The model may still write the explanation; it never writes the label.
 */
import { analysisState, type AnalysisState } from '@clm/types'
import { prisma } from './prisma.js'
import { currentPresence, type PresenceFinding } from './presence-rules.js'
import { analysisStampOf } from './analysis-trigger.js'

export type GuardCode =
  | 'analysis_missing' | 'analysis_failed' | 'analysis_running' | 'analysis_stale'
  | 'no_clauses' | 'risk_unknown'
  | 'required_missing' | 'required_deleted' | 'clause_deleted' | 'clause_cut' | 'not_allowed_present'
  | 'counterparty_version'

export interface GuardReason { code: GuardCode; text: string }

export interface GuardResult {
  /** Every check passed: the model's label stands. */
  passes: boolean
  reasons: GuardReason[]
  findings: PresenceFinding[]
}

export interface GuardInput {
  analysis: AnalysisState
  /** Clauses on the version the contract stands on (carried ones included). */
  clauseCount: number
  riskScore: number | null
  findings: PresenceFinding[]
  /** The counterparty's newest version, when it arrived after the last analysis. */
  counterpartyVersionAfterAnalysis: { versionNumber: number } | null
}

/** Pure: the reasons the recommendation can't be "approve". */
export function guardReasons(input: GuardInput): GuardReason[] {
  const out: GuardReason[] = []
  const a = input.analysis
  if (a.kind === 'not_analysed') out.push({ code: 'analysis_missing', text: 'this contract has not been analysed' })
  else if (a.kind === 'failed') out.push({ code: 'analysis_failed', text: 'its analysis failed' })
  else if (a.kind === 'running') out.push({ code: 'analysis_running', text: 'its analysis is still running' })
  else if (a.kind === 'stale') {
    out.push({ code: 'analysis_stale', text: `the document changed after it was analysed${a.analysedVersionNumber != null ? ` (analysis is for v${a.analysedVersionNumber})` : ''}` })
  }
  // Said only of a finished analysis: one missing or running says so already.
  if (input.clauseCount === 0 && (a.kind === 'done' || a.kind === 'stale')) out.push({ code: 'no_clauses', text: 'no clauses were found in it' })
  if (input.riskScore == null) out.push({ code: 'risk_unknown', text: 'its risk score is unknown' })

  for (const f of input.findings) {
    if (f.kind === 'not_detected') out.push({ code: 'required_missing', text: `${f.label} was not detected (required)` })
    else if (f.kind === 'deleted') out.push({ code: f.required ? 'required_deleted' : 'clause_deleted', text: f.message.replace(/\.$/, '') })
    else if (f.kind === 'cut') out.push({ code: 'clause_cut', text: f.message.replace(/\.$/, '') })
    else if (f.kind === 'not_allowed_present') out.push({ code: 'not_allowed_present', text: f.message.replace(/\.$/, '') })
  }
  if (input.counterpartyVersionAfterAnalysis) {
    out.push({ code: 'counterparty_version', text: `the counterparty sent v${input.counterpartyVersionAfterAnalysis.versionNumber} after the last analysis` })
  }
  return out
}

/** The label stored and shown: the model's, unless the guard holds it back. */
export function guardedLabel(modelLabel: string | null | undefined, guard: Pick<GuardResult, 'passes'>): string | null {
  if (!guard.passes) return 'cant_recommend'
  return modelLabel ?? null
}

/** Versions made by the counterparty: a portal upload or an emailed redline. */
const COUNTERPARTY = /^(portal|email):/

/** The guard for one contract, as it stands now. */
export async function recommendationGuard(contractId: string, orgId: string): Promise<GuardResult> {
  const c = await prisma.contract.findFirst({
    where: { id: contractId, orgId },
    select: { id: true, analysisStatus: true, analysisError: true, currentVersionId: true, metadata: true, riskScore: true },
  })
  if (!c) return { passes: false, reasons: [{ code: 'analysis_missing', text: 'the contract was not found' }], findings: [] }
  const analysis = analysisState(c)
  const stamp = analysisStampOf(c.metadata)
  const [clauseCount, findings, counterparty] = await Promise.all([
    c.currentVersionId ? prisma.contractClause.count({ where: { versionId: c.currentVersionId, isSubChunk: false } }) : Promise.resolve(0),
    currentPresence(c),
    stamp
      ? prisma.contractVersion.findFirst({
          where: { contractId, createdAt: { gt: new Date(stamp.at) }, OR: [{ createdById: { startsWith: 'portal:' } }, { createdById: { startsWith: 'email:' } }] },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true, createdById: true },
        })
      : Promise.resolve(null),
  ])
  const reasons = guardReasons({
    analysis, clauseCount, riskScore: c.riskScore, findings,
    counterpartyVersionAfterAnalysis: counterparty && COUNTERPARTY.test(counterparty.createdById) ? { versionNumber: counterparty.versionNumber } : null,
  })
  return { passes: reasons.length === 0, reasons, findings }
}

/** The guard for each of several contracts (the approval queues). */
export async function recommendationGuards(contracts: Array<{ id: string; orgId: string }>): Promise<Map<string, GuardResult>> {
  const out = new Map<string, GuardResult>()
  for (const c of contracts) out.set(c.id, await recommendationGuard(c.id, c.orgId))
  return out
}
