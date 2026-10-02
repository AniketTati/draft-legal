/**
 * DecisionStrip — State 4 in the unified-canvas wireframes (docs/26 §4).
 *
 * Appears above the document when the current user has a PENDING approval
 * step on this contract. Its job: compress the review signal into one row
 * so the approver can Approve / Return / Decline / Delegate without hunting.
 *
 * Layout (left → right):
 *   [AI Confidence]  [Risk score]  [AI Recommendation]  [Top blocker → jump]
 *   + primary CTAs:  [Approve]  [Return for changes]  [Decline]  [Delegate]
 *
 * Per ChatGPT round-3: approvers don't trust AI blindly. The strip shows
 * all three inputs (confidence, risk, recommendation) side-by-side so the
 * approver can form their own judgement. The "Top blocker → jump" click
 * scrolls the document to the clause that drives the recommendation, so
 * decisions reference the actual text and not just the summary.
 *
 * Return/Decline/Delegate require extra input (a reason / a user); those
 * cases expand into an inline popover. Approve is one click + optional
 * comment.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { AssistChip, AssistMark } from '@/components/ui/assist'
import { UserPicker } from '@/components/common/UserPicker'
import { cn } from '@/lib/utils'
import { MEANING_CLASS, normalizeRisk, riskBand } from '@/lib/status'
import { recommendationText } from '@/lib/recommendation'
import { invalidateApproval, serverMessage } from '@/lib/approval-keys'
import { DecisionReason, CONFIRM_LABEL, needsReason, type Decision } from '@/components/approvals/DecisionReason'
import {
  CheckCircle2, XCircle, ArrowRight, Loader2, Undo2,
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
    /** docs/41 P0.2 — why the recommendation is held back, when it is. */
    recommendationReasons?:  string[]
  }
}

/**
 * The recommendation carries NO meaning colour, in any of its three states.
 *
 * This chip sits inches from the real Approve and Reject buttons, and a reader
 * must never be able to mistake what a model advised for what a human recorded:
 * emerald here would read as already-approved, red as already-rejected. Amber
 * for "review required" is the same trap one step down — it claims the workflow
 * has put the ball in your court, when all that happened is that a model was
 * unsure. The assist vocabulary is the whole answer: the diamond says who wrote
 * it, the words say what it advises. (Same call ApprovalCard's REC_LABEL makes.)
 */
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
  const [pending, setPending] = useState<Decision | null>(null)
  const [comment, setComment] = useState('')
  const [findingIds, setFindingIds] = useState<string[]>([])
  const [delegateTo, setDelegateTo] = useState('')

  const decide = useMutation({
    mutationFn: (payload: { decision: string; comment?: string; delegateTo?: string; findingIds?: string[] }) =>
      api.post(`/approvals/${awaitingMe.instanceId}/decide`, {
        stepId: awaitingMe.stepId,
        ...payload,
      }).then(r => r.data),
    onSuccess: () => {
      // docs/41 P0.6 — every place the approval is read from (lib/approval-keys.ts):
      // the keys cleared here used to match none of the ones the pages read.
      invalidateApproval(queryClient, awaitingMe.contract.id, awaitingMe.instanceId)
      setPending(null)
      setComment('')
      setDelegateTo('')
      setFindingIds([])
      onDecided?.()
    },
    // Shown in the strip with the server's reason; handled, so no global toast.
    onError: () => {},
  })

  const recKey = (awaitingMe.instance.approvalRecommendation ?? 'review_required').toLowerCase()
  // docs/41 P0.2 — "Ready to approve" only when the API's checks passed.
  const recLabel = recommendationText(recKey, awaitingMe.instance.recommendationReasons) ?? 'Review required'
  const topRisk = awaitingMe.instance.keyRisks?.[0]
  const confidence = Math.max(0, Math.min(100, Math.round(
    // Confidence is derived: strong recommendation + few blockers → high.
    // This is a display heuristic, not a backend score. When the backend
    // produces a proper confidence number we replace this.
    (recKey === 'approve' ? 90
      : recKey === 'reject_advised' ? 75
      : recKey === 'cant_recommend' ? 30
      : 60) - (awaitingMe.instance.keyRisks?.length ?? 0) * 5
  )))
  // "The mark scales with how sure it is" — a hollow diamond on a shaky
  // recommendation asks to be read rather than trusted.
  const confidenceBand = confidence >= 80 ? 'high' : confidence >= 60 ? 'medium' : 'low'

  const riskPct = normalizeRisk(riskScore)
  // Route the badge through the shared risk bands so this pill and the risk
  // meters elsewhere can never disagree about where amber and red begin.
  const riskKey = riskPct == null
    ? 'neutral' as const
    : ({ low: 'binding', medium: 'turn', high: 'risk' } as const)[riskBand(riskPct)]
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
          {/* A machine-produced number, so it takes the machine's one glyph —
              the diamond — rather than a second sparkle that means the same. */}
          <AssistMark confidence={confidenceBand} />
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

        {/* AI Recommendation — advice, not a verdict. It carries no meaning
            colour: a model advising is not a decision, and emerald or red here
            would read as one. "Ready to approve" appears only when every check
            on the analysis passed (lib/recommendation.ts). */}
        <AssistChip icon={<AssistMark confidence={confidenceBand} className="size-[5px]" />}>
          <span title={awaitingMe.instance.recommendationReasons?.join('; ') || undefined} data-testid="decision-recommendation">AI: {recLabel}</span>
        </AssistChip>

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
            variant="outline"
            onClick={() => setPending('RETURNED')}
            className="gap-1"
            data-testid="strip-return-btn"
          >
            <Undo2 className="size-3.5" />
            Return for changes
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setPending('DECLINED')}
            className="gap-1"
            data-testid="strip-decline-btn"
          >
            <XCircle className="size-3.5" />
            Decline
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

      {/* docs/41 P0.6 — a decision that didn't go through says so, and why:
          the strip used to just stay as it was. */}
      {decide.isError && (
        <div role="alert" className="px-6 pb-2 text-dense text-risk-700" data-testid="decision-error">
          The decision wasn’t recorded: {serverMessage(decide.error)}
        </div>
      )}

      {/* Inline confirmation row — appears below the strip once a decision
          is clicked. Collects the required input for the chosen action. */}
      {pending && (
        <div className="px-6 pb-3 pt-0 flex items-start gap-2 border-t border-attention-200 bg-card/50">
          <div className="flex-1 pt-3">
            {(pending === 'RETURNED' || pending === 'DECLINED') && (
              <DecisionReason
                autoFocus
                contractId={awaitingMe.contract.id}
                decision={pending}
                reason={comment}
                onReason={setComment}
                findingIds={findingIds}
                onFindingIds={setFindingIds}
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
                className="w-full text-[13px] text-ink-950 bg-card px-2.5 py-1.5 border border-brand-200 rounded-md placeholder:text-ink-400 focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/15"
              />
            )}
          </div>
          <div className="flex items-center gap-1.5 pt-3 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setPending(null); setComment(''); setDelegateTo(''); setFindingIds([]) }}
              disabled={decide.isPending}
              className="text-ink-500"
            >
              Cancel
            </Button>
            {/* Delegating is a routing action, not a verdict, so it commits in
                ink while approve/reject keep their decision colors. */}
            <Button
              size="sm"
              variant={pending === 'APPROVED' ? 'brand' : pending === 'DECLINED' ? 'danger' : 'default'}
              onClick={() => decide.mutate({
                decision:   pending,
                comment:    comment.trim() || undefined,
                delegateTo: delegateTo.trim() || undefined,
                ...(needsReason(pending) && findingIds.length && { findingIds }),
              })}
              disabled={
                decide.isPending
                || (needsReason(pending) && !comment.trim())
                || (pending === 'DELEGATED' && !delegateTo.trim())
              }
              className="gap-1"
            >
              {decide.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {CONFIRM_LABEL[pending]}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
