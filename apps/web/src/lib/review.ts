/**
 * docs/41 P1 — the shape of GET /contracts/:id/review, and the small pure
 * helpers the Review panel uses (tested in review.test.ts).
 */
import type { Meaning } from '@/lib/status'

export type FindingAction = 'accept' | 'resolve' | 'reopen' | 'tag_clause' | 'insert_standard' | 'redline' | 'request_exception'

export interface ReviewFindingView {
  id: string
  kind: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  status: string
  source: 'deterministic' | 'llm'
  title: string
  explanation: string
  /** relatedQuote: other words it is about (a term's definition, why a compliance framework applies). */
  evidence: { quote?: string; baselineQuote?: string; relatedQuote?: string; sectionRef?: string | null }
  clauseId: string | null
  clauseType: string | null
  /** The clause category: whose clause approver decides an exception. */
  categoryId?: string | null
  reviewStatus: string
  label: string
  definition: string
  resolutionNote: string | null
  actions: FindingAction[]
  /** docs/41 Part 15 — the model's advice on a counterparty's change (lib/change-advice.ts in the API). */
  /** docs/41 Part 16 — the playbook position's suggested note to the counterparty. */
  counterpartyNote?: string | null
  advice?: { recommendation: 'accept' | 'counter' | 'reject'; reasoning: string; counterText?: string | null; counterNote?: string | null } | null
}

export interface ReviewClauseView {
  id: string
  clauseType: string
  clauseLabel: string
  sectionRef: string | null
  excerpt: string
  reviewStatus: string
  label: string
  definition: string
  verdict?: { verdict: string; quote: string; explanation: string }
}

export interface RunView {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'superseded'
  versionNumber: number | null
  failedStepLabel: string | null
  error: string | null
  current: { label: string; index: number; of: number } | null
  stuck: boolean
}

export interface ContractReview {
  versionId: string | null
  versionNumber: number | null
  isCurrent: boolean
  analysis: { kind: 'not_analysed' | 'running' | 'failed' | 'stale' | 'done'; analysedVersionNumber?: number | null; error?: string | null }
  run: RunView | null
  stale: { analysedVersionNumber: number | null; run: RunView | null } | null
  playbook: { id: string | null; name: string | null; why: 'explicit' | 'default_for_type' | 'only_one' | 'ambiguous' | 'none'; explanation: string; candidates: Array<{ id: string; name: string }> }
  baseline: { versionId: string; versionNumber: number | null; reason: string | null; words: string | null } | null
  recommendation: { label: string; text: string; definition: string; reasons: Array<{ code: string; text: string; findingIds: string[] }> } | null
  /** compliance, drafting: docs/41 Parts 9, 10 — gaps of the frameworks that apply, and defined-term problems. */
  groups: { needsAttention: ReviewFindingView[]; notDetected: ReviewFindingView[]; compliance: ReviewFindingView[]; drafting: ReviewFindingView[]; accepted: ReviewFindingView[] }
  clauses: ReviewClauseView[]
  counts: { needsAttention: number; notDetected: number; compliance: number; drafting: number; accepted: number; standard: number; clauses: number; fixable: number }
}

/** How a recommendation reads at a glance. */
export const RECOMMENDATION_MEANING: Record<string, Meaning> = {
  ready_to_approve: 'binding',
  review: 'turn',
  needs_exception: 'turn',
  escalate: 'risk',
  cant_recommend: 'neutral',
}

/** How a status chip reads: risk for what blocks, attention for what needs a look, calm for the rest. */
export function statusMeaning(reviewStatus: string): Meaning {
  if (['deleted', 'not_allowed', 'unreadable', 'not_met'].includes(reviewStatus)) return 'risk'
  if (['changed', 'added', 'not_detected', 'needs_approval', 'fallback', 'compliance_gap'].includes(reviewStatus)) return 'turn'
  if (['standard', 'matches_preferred', 'accepted', 'resolved', 'unchanged'].includes(reviewStatus)) return 'binding'
  return 'neutral'
}

/** One line for where the analysis stands, or null when it is done for this version. */
export function runLine(r: Pick<ContractReview, 'analysis' | 'run' | 'stale' | 'versionNumber'>): { text: string; canRetry: boolean } | null {
  const run = r.stale?.run ?? r.run
  if (r.analysis.kind === 'stale') {
    const busy = run && (run.status === 'queued' || run.status === 'running')
    return {
      text: `Analysis is for v${r.analysis.analysedVersionNumber ?? '?'} — v${r.versionNumber ?? '?'} has changes.${busy ? ' Re-analysing…' : ''}`,
      canRetry: !busy,
    }
  }
  if (r.analysis.kind === 'running' || (run && (run.status === 'queued' || run.status === 'running'))) {
    if (run?.stuck) return { text: 'The analysis stopped moving.', canRetry: true }
    return { text: run?.current ? `Analysing — step ${run.current.index} of ${run.current.of}, ${run.current.label}…` : 'Analysing…', canRetry: false }
  }
  if (r.analysis.kind === 'failed' || run?.status === 'failed') {
    return { text: `The analysis failed${run?.failedStepLabel ? ` while ${run.failedStepLabel}` : ''}${run?.error ? `: ${run.error}` : '.'}`, canRetry: true }
  }
  if (r.analysis.kind === 'not_analysed') return { text: "This version hasn't been analysed yet.", canRetry: true }
  return null
}

/** The findings a batch rewrite can fix. */
export const fixable = (fs: ReviewFindingView[]) => fs.filter(f => f.actions.includes('redline'))

// ─── Clause exceptions (docs/41 Part 7) ───────────────────────────────────────

/** One of GET /contracts/:id/approval's `exceptions` (newest first). */
export interface ExceptionView {
  id: string
  findingId: string | null
  clauseType: string | null
  title: string
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'RESET' | 'SKIPPED'
  requestedBy: string | null
  reason: string | null
  decidedBy: string | null
  comment: string | null
  decidedAt: string | null
  createdAt: string
  /** Who a pending exception waits on (a person, or "anyone with the … role"). */
  waitingFor?: string | null
}

/** The finding statuses an exception gives it. */
export const EXCEPTION_STATUSES = ['exception_requested', 'exception_approved', 'exception_declined'] as const
export const hasException = (f: Pick<ReviewFindingView, 'status'>) => (EXCEPTION_STATUSES as readonly string[]).includes(f.status)

/**
 * Where a finding's exception stands, in a line, or null when none was asked
 * for. `waitingFor` is the approver's name when it is known.
 */
export function exceptionLine(status: string, ex?: Pick<ExceptionView, 'decidedBy' | 'comment'> | null, waitingFor?: string | null): string | null {
  const said = (word: string) => `${word}${ex?.decidedBy ? ` by ${ex.decidedBy}` : ''}${ex?.comment ? `: “${ex.comment}”` : ''}`
  if (status === 'exception_requested') return `Exception requested — waiting for ${waitingFor ?? 'the clause approver'}`
  if (status === 'exception_approved') return said('Exception approved')
  if (status === 'exception_declined') return said('Exception declined')
  return null
}

/** How an exception's line reads at a glance. */
export function exceptionMeaning(status: string): Meaning {
  return status === 'exception_approved' ? 'binding' : status === 'exception_declined' ? 'risk' : 'turn'
}
