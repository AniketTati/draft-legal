/**
 * docs/41 P1 — the shape of GET /contracts/:id/review, and the small pure
 * helpers the Review panel uses (tested in review.test.ts).
 */
import type { Meaning } from '@/lib/status'

export type FindingAction = 'accept' | 'resolve' | 'reopen' | 'tag_clause' | 'insert_standard' | 'redline'

export interface ReviewFindingView {
  id: string
  kind: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  status: string
  source: 'deterministic' | 'llm'
  title: string
  explanation: string
  evidence: { quote?: string; baselineQuote?: string; sectionRef?: string | null }
  clauseId: string | null
  clauseType: string | null
  reviewStatus: string
  label: string
  definition: string
  resolutionNote: string | null
  actions: FindingAction[]
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
  groups: { needsAttention: ReviewFindingView[]; notDetected: ReviewFindingView[]; accepted: ReviewFindingView[] }
  clauses: ReviewClauseView[]
  counts: { needsAttention: number; notDetected: number; accepted: number; standard: number; clauses: number; fixable: number }
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
  if (['changed', 'added', 'not_detected', 'needs_approval', 'fallback'].includes(reviewStatus)) return 'turn'
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
