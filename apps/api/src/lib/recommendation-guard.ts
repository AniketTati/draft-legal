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
 *
 * docs/41 P1 (Part 7) — the label itself is now a policy over the version's
 * review findings (lib/review-findings.ts), never a model's choice:
 *   - Can't recommend: the analysis is missing, failed, running or stale,
 *     or found no clauses;
 *   - Escalate: a critical finding, a clause the playbook doesn't allow, or
 *     an exception that was declined;
 *   - Needs exception: a position that needs approval, or an exception
 *     asked for (a required clause confirmed missing);
 *   - Review: anything else open — a deletion, a cut, a change no position
 *     covers, a required clause not detected, text that doesn't read — and
 *     every guard reason above;
 *   - Ready to approve: none of these.
 *
 * docs/41 Parts 9, 10 — drafting findings (a term not defined, defined
 * twice…) never hold the label back: they are listed, not counted. A
 * compliance finding holds it at Review when it is high (a requirement of a
 * framework that applies, missing or at risk); a lesser one is listed only.
 */
import { analysisState, type AnalysisState, type RecommendationLabel } from '@clm/types'
import { prisma } from './prisma.js'
import { analysisStampOf } from './analysis-trigger.js'
import { findingsFor } from './review-findings.js'
import { openChoices } from './open-choices.js'

export type GuardCode =
  | 'analysis_missing' | 'analysis_failed' | 'analysis_running' | 'analysis_stale'
  | 'no_clauses' | 'risk_unknown'
  | 'required_missing' | 'required_deleted' | 'clause_deleted' | 'clause_cut' | 'not_allowed_present'
  | 'unreadable_text' | 'counterparty_version' | 'open_choices'

export interface GuardReason { code: GuardCode; text: string }

export type { RecommendationLabel }

/** A finding as the policy reads it (a ReviewFinding row). */
export interface PolicyFinding { id: string; kind: string; severity: string; status: string; title: string }

export interface RecommendationReason { code: string; text: string; findingIds: string[] }

export interface Recommendation { label: RecommendationLabel; reasons: RecommendationReason[] }

export interface GuardResult {
  /** Every hard guard passed (the label may still be Review on findings). */
  passes: boolean
  reasons: GuardReason[]
  findings: PolicyFinding[]
  recommendation: Recommendation
}

export interface GuardInput {
  analysis: AnalysisState
  /** Clauses on the version the contract stands on (carried ones included). */
  clauseCount: number
  riskScore: number | null
  findings: PolicyFinding[]
  /** The counterparty's newest version, when it arrived after the last analysis. */
  counterpartyVersionAfterAnalysis: { versionNumber: number } | null
  /** Terms the draft still leaves as choices (governing law nobody named…), by label. */
  openChoices?: string[]
}

/** Statuses that still need something from someone. */
const OPEN = new Set(['open', 'exception_requested', 'exception_declined'])
export const isOpen = (f: Pick<PolicyFinding, 'status'>) => OPEN.has(f.status)
/** Findings the recommendation weighs: not drafting, and compliance only when high. */
export const weighs = (f: Pick<PolicyFinding, 'kind' | 'severity'>) =>
  f.kind !== 'drafting' && (f.kind !== 'compliance' || f.severity === 'high' || f.severity === 'critical')
const lower = (t: string) => t.replace(/\.$/, '')

/** Pure: the hard guards — the reasons the label can never be "Ready to approve". */
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
    if (!isOpen(f)) continue
    if (f.kind === 'missing_required') out.push({ code: 'required_missing', text: `${lower(f.title).replace(/ — not detected$/, '')} was not detected (required)` })
    else if (f.kind === 'deleted') out.push({ code: f.severity === 'high' ? 'required_deleted' : 'clause_deleted', text: lower(f.title) })
    else if (f.kind === 'material_cut') out.push({ code: 'clause_cut', text: lower(f.title) })
    else if (f.kind === 'not_allowed_present') out.push({ code: 'not_allowed_present', text: lower(f.title) })
    else if (f.kind === 'unreadable_text') out.push({ code: 'unreadable_text', text: lower(f.title) })
  }
  if (input.counterpartyVersionAfterAnalysis) {
    out.push({ code: 'counterparty_version', text: `the counterparty sent v${input.counterpartyVersionAfterAnalysis.versionNumber} after the last analysis` })
  }
  // A draft that can't be sent can't be ready to approve either: a choice left
  // open (governing law, venue…) is a term nobody has agreed yet.
  const choices = input.openChoices ?? []
  if (choices.length) {
    const list = choices.length <= 3 ? choices.join(', ') : `${choices.slice(0, 3).join(', ')} and ${choices.length - 3} more`
    out.push({ code: 'open_choices', text: `${choices.length === 1 ? '1 choice is' : `${choices.length} choices are`} still open in the draft (${list})` })
  }
  return out
}

const CANT: GuardCode[] = ['analysis_missing', 'analysis_failed', 'analysis_running', 'analysis_stale', 'no_clauses']

/** Pure: the recommendation, from the guards and the open findings. Never a model's. */
export function policy(input: GuardInput): Recommendation {
  const guards = guardReasons(input)
  const open = input.findings.filter(f => isOpen(f) && weighs(f))
  const ids = (fs: PolicyFinding[]) => fs.map(f => f.id)
  const byTitle = (fs: PolicyFinding[], code: string): RecommendationReason[] => fs.map(f => ({ code, text: lower(f.title), findingIds: [f.id] }))

  if (guards.some(g => CANT.includes(g.code))) {
    return { label: 'cant_recommend', reasons: guards.map(g => ({ code: g.code, text: g.text, findingIds: [] })) }
  }
  const critical = open.filter(f => f.severity === 'critical' || f.kind === 'not_allowed_present' || f.status === 'exception_declined')
  if (critical.length) return { label: 'escalate', reasons: byTitle(critical, 'escalate') }

  const exception = open.filter(f => f.kind === 'needs_approval_position' || f.status === 'exception_requested')
  if (exception.length) return { label: 'needs_exception', reasons: byTitle(exception, 'needs_exception') }

  // Anything still open but a fallback position (which your playbook allows).
  const toReview = open.filter(f => f.kind !== 'position_fallback' || f.severity !== 'low')
  const findingCodes = new Set(['required_missing', 'required_deleted', 'clause_deleted', 'clause_cut', 'not_allowed_present', 'unreadable_text'])
  const otherGuards = guards.filter(g => !findingCodes.has(g.code))
  if (toReview.length || otherGuards.length) {
    return {
      label: 'review',
      reasons: [
        ...otherGuards.map(g => ({ code: g.code, text: g.text, findingIds: [] as string[] })),
        ...byTitle(toReview, 'review'),
      ],
    }
  }
  return { label: 'ready_to_approve', reasons: open.length ? [{ code: 'fallback', text: `${open.length} clause${open.length === 1 ? ' is' : 's are'} at a fallback position your playbook allows`, findingIds: ids(open) }] : [] }
}

/** The label stored and shown: the policy's. A model's label is never used. */
export function guardedLabel(_modelLabel: string | null | undefined, guard: Pick<GuardResult, 'recommendation'>): RecommendationLabel {
  return guard.recommendation.label
}

/** Versions made by the counterparty: a portal upload or an emailed redline. */
const COUNTERPARTY = /^(portal|email):/

/** The guard and recommendation for one contract, as it stands now. */
export async function recommendationGuard(contractId: string, orgId: string): Promise<GuardResult> {
  const c = await prisma.contract.findFirst({
    where: { id: contractId, orgId },
    select: { id: true, analysisStatus: true, analysisError: true, currentVersionId: true, metadata: true, riskScore: true },
  })
  if (!c) {
    const reasons: GuardReason[] = [{ code: 'analysis_missing', text: 'the contract was not found' }]
    return { passes: false, reasons, findings: [], recommendation: { label: 'cant_recommend', reasons: reasons.map(r => ({ ...r, findingIds: [] })) } }
  }
  const analysis = analysisState(c)
  const stamp = analysisStampOf(c.metadata)
  const [clauseCount, rows, counterparty, choices] = await Promise.all([
    c.currentVersionId ? prisma.contractClause.count({ where: { versionId: c.currentVersionId, isSubChunk: false } }) : Promise.resolve(0),
    // Findings are only worked out for a version something has read: the
    // analysis's own, or one edited since (its clauses carried).
    c.currentVersionId && analysis.kind !== 'not_analysed' ? findingsFor(contractId, c.currentVersionId) : Promise.resolve([]),
    stamp
      ? prisma.contractVersion.findFirst({
          where: { contractId, createdAt: { gt: new Date(stamp.at) }, OR: [{ createdById: { startsWith: 'portal:' } }, { createdById: { startsWith: 'email:' } }] },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true, createdById: true },
        })
      : Promise.resolve(null),
    openChoices(contractId),
  ])
  const findings: PolicyFinding[] = rows.map(f => ({ id: f.id, kind: f.kind, severity: f.severity, status: f.status, title: f.title }))
  const input: GuardInput = {
    analysis, clauseCount, riskScore: c.riskScore, findings,
    counterpartyVersionAfterAnalysis: counterparty && COUNTERPARTY.test(counterparty.createdById) ? { versionNumber: counterparty.versionNumber } : null,
    openChoices: choices.map(ch => ch.label),
  }
  const reasons = guardReasons(input)
  return { passes: reasons.length === 0, reasons, findings, recommendation: policy(input) }
}

/** The guard for each of several contracts (the approval queues). */
export async function recommendationGuards(contracts: Array<{ id: string; orgId: string }>): Promise<Map<string, GuardResult>> {
  const out = new Map<string, GuardResult>()
  for (const c of contracts) out.set(c.id, await recommendationGuard(c.id, c.orgId))
  return out
}
