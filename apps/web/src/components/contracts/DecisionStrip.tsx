/**
 * DecisionStrip — State 4 in the unified-canvas wireframes (docs/26 §4).
 *
 * Appears above the document when the current user has a PENDING approval
 * step on this contract. Its job: compress the review signal into one row
 * so the approver can Approve / Reject / Delegate without hunting.
 *
 * Layout (left → right):
 *   [AI Confidence]  [Risk score]  [AI Recommendation]  [Top blocker → jump]
 *   + primary CTAs:  [Approve]  [Reject]  [Delegate]
 *
 * Per ChatGPT round-3: approvers don't trust AI blindly. The strip shows
 * all three inputs (confidence, risk, recommendation) side-by-side so the
 * approver can form their own judgement. The "Top blocker → jump" click
 * scrolls the document to the clause that drives the recommendation, so
 * decisions reference the actual text and not just the summary.
 *
 * Reject/Delegate require extra input (comment / delegateTo user); those
 * cases expand into an inline popover. Approve is one click + optional
 * comment.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { UserPicker } from '@/components/common/UserPicker'
import { cn } from '@/lib/utils'
import { MEANING_CLASS, riskMeaning } from '@/lib/status'
import {
  CheckCircle2, XCircle, ArrowRight, AlertTriangle, Loader2, Sparkles,
  ShieldAlert, TrendingUp, ChevronDown,
} from 'lucide-react'

interface KeyRisk {
  title:       string
  description: string
  severity:    string
  clauseId?:   string
}

interface AwaitingMe {
  stepId:     string
  instanceId: string
  stepName:   string
  contract: {
    id:    string
    title: string
    type:  string
  }
  instance: {
    aiSummary?:              string
    keyRisks?:               KeyRisk[]
    approvalRecommendation?: string
  }
}

// A model advising "Approve" is not an approval. Brand means binding, and this
// chip sits inches from the real brand Approve button — colouring the advice
// the same green would read as the decision already being made, so the
// recommendation stays neutral and lets the words carry it. (Same call
// ApprovalCard makes.) "Review required" is genuinely the user's turn and
// "Reject advised" is genuine exposure, so those two keep their meaning.
const REC_TONE: Record<string, { label: string; tone: string; icon: JSX.Element }> = {
  approve:         { label: 'Approve',         tone: 'text-ink-700 bg-paper-100 border-paper-200',              icon: <CheckCircle2 className="size-3.5" /> },
  review_required: { label: 'Review required', tone: 'text-attention-700 bg-attention-50 border-attention-200', icon: <AlertTriangle className="size-3.5" /> },
  reject_advised:  { label: 'Reject advised',  tone: 'text-risk-700 bg-risk-50 border-risk-200',                icon: <XCircle className="size-3.5" /> },
}

export function DecisionStrip({
  awaitingMe,
  riskScore,
  onJumpToClause,
  onDecided,
}: {
  awaitingMe: AwaitingMe
  /** 0–1 risk score from contract.riskScore — shown as a % badge. */
  riskScore?: number | null
  /** Called when user clicks "Jump →" on the top-blocker chip. */
  onJumpToClause?: (clauseId: string) => void
  onDecided?: () => void
}) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<'APPROVED' | 'REJECTED' | 'DELEGATED' | null>(null)
  const [comment, setComment] = useState('')
  const [delegateTo, setDelegateTo] = useState('')

  const decide = useMutation({
    mutationFn: (payload: { decision: string; comment?: string; delegateTo?: string }) =>
      api.post(`/approvals/${awaitingMe.instanceId}/decide`, {
        stepId: awaitingMe.stepId,
        ...payload,
      }).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contract', awaitingMe.contract.id] })
      queryClient.invalidateQueries({ queryKey: ['contract-approval', awaitingMe.contract.id] })
      queryClient.invalidateQueries({ queryKey: ['approval-instance-by-contract', awaitingMe.contract.id] })
      queryClient.invalidateQueries({ queryKey: ['approvals', 'my-queue'] })
      setPending(null)
      setComment('')
      setDelegateTo('')
      onDecided?.()
    },
  })

  const recKey = (awaitingMe.instance.approvalRecommendation ?? 'review_required').toLowerCase()
  const rec = REC_TONE[recKey] ?? REC_TONE.review_required
  const topRisk = awaitingMe.instance.keyRisks?.[0]
  const confidence = Math.max(0, Math.min(100, Math.round(
    // Confidence is derived: strong recommendation + few blockers → high.
    // This is a display heuristic, not a backend score. When the backend
    // produces a proper confidence number we replace this.
    (recKey === 'approve' ? 90
      : recKey === 'reject_advised' ? 75
      : 60) - (awaitingMe.instance.keyRisks?.length ?? 0) * 5
  )))

  const riskPct = riskScore != null ? Math.round(riskScore * 100) : null
  // Route the badge through riskMeaning so this pill and the risk meters
  // elsewhere can never disagree about where amber and red begin.
  const riskKey = riskPct == null ? 'neutral' : riskMeaning(riskPct)
  const riskTone = cn(
    MEANING_CLASS[riskKey].wash,
    MEANING_CLASS[riskKey].washFg,
    MEANING_CLASS[riskKey].washBorder,
  )

  return (
    <div
      id="approval-decision-strip"
      role="region"
      aria-label="Approval decision strip"
      // The one surface in the product that is literally "your turn".
      className="border-b border-attention-200 bg-attention-50"
    >
      <div className="px-6 py-3 flex items-center gap-4 flex-wrap">
        {/* Status label */}
        <div className="flex items-center gap-1.5 shrink-0">
          <ShieldAlert className="size-4 text-attention-600" />
          <span className="text-eyebrow uppercase text-attention-700">
            Awaiting your decision
          </span>
        </div>

        <div className="h-4 w-px bg-attention-200" aria-hidden />

        {/* AI Confidence */}
        <div className="flex items-center gap-1.5 text-dense" title="Higher = AI is more certain about its recommendation">
          {/* A machine-produced number, so the glyph keeps the assist accent. */}
          <Sparkles className="size-3.5 text-assist-600" />
          <span className="text-ink-500">Confidence</span>
          <span className="font-semibold text-ink-950 tabular-nums">{confidence}%</span>
        </div>

        {/* Risk score */}
        <div className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-full border text-dense tabular-nums',
          riskTone,
        )}>
          <TrendingUp className="size-3" />
          <span>Risk {riskPct != null ? `${riskPct}%` : '—'}</span>
        </div>

        {/* AI Recommendation */}
        <div className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-full border text-dense font-medium',
          rec.tone,
        )}>
          {rec.icon}
          <span>AI: {rec.label}</span>
        </div>

        {/* Top blocker — clickable "jump" link */}
        {topRisk && (
          <button
            onClick={() => topRisk.clauseId && onJumpToClause?.(topRisk.clauseId)}
            disabled={!topRisk.clauseId || !onJumpToClause}
            className={cn(
              'flex items-center gap-1 text-dense text-ink-700 truncate max-w-[260px]',
              topRisk.clauseId && onJumpToClause
                ? 'hover:text-attention-700 hover:underline cursor-pointer'
                : 'opacity-70 cursor-default',
            )}
            title={topRisk.description}
          >
            <span className="text-ink-400">Top blocker:</span>
            <span className="font-medium truncate">{topRisk.title}</span>
            {topRisk.clauseId && onJumpToClause && <ArrowRight className="size-3 shrink-0" />}
          </button>
        )}

        {/* Primary CTAs pushed to the right — this is the approval surface, so
            brand and danger are earned here rather than borrowed. */}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <Button
            size="sm"
            variant="brand"
            onClick={() => setPending('APPROVED')}
            className="gap-1"
          >
            <CheckCircle2 className="size-3.5" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setPending('REJECTED')}
            className="gap-1"
          >
            <XCircle className="size-3.5" />
            Reject
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPending('DELEGATED')}
            className="gap-1"
          >
            <ArrowRight className="size-3.5" />
            Delegate
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </div>
      </div>

      {/* Inline confirmation row — appears below the strip once a decision
          is clicked. Collects the required input for the chosen action. */}
      {pending && (
        <div className="px-6 pb-3 pt-0 flex items-start gap-2 border-t border-attention-200 bg-card/50">
          <div className="flex-1 pt-3">
            {pending === 'REJECTED' && (
              <textarea
                autoFocus
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="Reason for rejection (required) — helps the submitter fix and re-submit…"
                className="w-full text-[13px] text-ink-950 bg-card px-2.5 py-1.5 border border-risk-200 rounded-md placeholder:text-ink-400 focus:outline-none focus:border-risk-600 focus:ring-[3px] focus:ring-risk-600/12 resize-y min-h-[52px]"
              />
            )}
            {pending === 'DELEGATED' && (
              <UserPicker
                value={delegateTo}
                onChange={(id) => setDelegateTo(id)}
                placeholder="Delegate to which teammate? Search by name or email…"
                testId="delegate-user-picker"
                autoFocus
              />
            )}
            {pending === 'APPROVED' && (
              <input
                autoFocus
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="Optional note for the audit trail…"
                className="w-full text-[13px] text-ink-950 bg-card px-2.5 py-1.5 border border-brand-200 rounded-md placeholder:text-ink-400 focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/12"
              />
            )}
          </div>
          <div className="flex items-center gap-1.5 pt-3 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setPending(null); setComment(''); setDelegateTo('') }}
              disabled={decide.isPending}
              className="text-ink-500"
            >
              Cancel
            </Button>
            {/* Delegating is a routing action, not a verdict, so it commits in
                ink while approve/reject keep their decision colors. */}
            <Button
              size="sm"
              variant={pending === 'APPROVED' ? 'brand' : pending === 'REJECTED' ? 'danger' : 'default'}
              onClick={() => decide.mutate({
                decision:   pending,
                comment:    comment.trim() || undefined,
                delegateTo: delegateTo.trim() || undefined,
              })}
              disabled={
                decide.isPending
                || (pending === 'REJECTED' && !comment.trim())
                || (pending === 'DELEGATED' && !delegateTo.trim())
              }
              className="gap-1"
            >
              {decide.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Confirm {pending === 'APPROVED' ? 'Approve' : pending === 'REJECTED' ? 'Reject' : 'Delegate'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
