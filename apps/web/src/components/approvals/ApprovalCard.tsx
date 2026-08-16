/**
 * ApprovalCard — Phase 06
 * Shows contract summary + AI analysis + decision buttons for a pending approval step.
 * Used in the Approvals "My Queue" page and on contract detail.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { UserPicker } from '@/components/common/UserPicker'
import { useNavigate } from 'react-router-dom'
import { Chip, Eyebrow } from '@/components/ui/primitives'
import { AssistMark, AssistChip } from '@/components/ui/assist'
import {
  CheckCircle2, XCircle, ArrowRight, ChevronDown, ChevronUp,
  AlertTriangle, Building2, DollarSign, Calendar, Loader2, ExternalLink,
} from 'lucide-react'

interface Contract {
  id: string
  title: string
  type: string
  value?: number | null
  counterpartyName?: string | null
  status: string
}

interface InstanceContext {
  id: string
  status: string
  submittedAt: string
  submittedByName?: string
  aiSummary?: string
  keyRisks?: Array<{ title: string; description: string; severity: string }>
  nonStandardTerms?: string[]
  approvalRecommendation?: string
}

interface Props {
  stepId:     string
  instanceId: string
  stepName:   string
  /** When this step auto-escalates. Absent on surfaces that don't fetch it. */
  escalateAt?: string | null
  contract:   Contract
  instance:   InstanceContext
  onDecided?: () => void
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days since an ISO timestamp. Negative is impossible for a submission. */
export function waitingDaysSince(iso: string): number {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS))
}

/** Whole days until an ISO timestamp; negative once it has passed. */
function daysUntil(iso: string): number | null {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return Math.round((t - Date.now()) / DAY_MS)
}

/**
 * An AI summary either arrived with the queue or it is never coming.
 *
 * The card used to render a spinner and "AI summary is being generated…"
 * whenever `aiSummary` was null — with no polling behind it. On a seeded org
 * that is eight cards spinning forever, and a reviewer who waits for an
 * analysis that does not exist is a reviewer who does not decide. Analysis runs
 * seconds after submission, so past this grace window the honest reading is
 * "there is none"; the card then says so and gets out of the way.
 */
const SUMMARY_GRACE_MS = 5 * 60 * 1000

// A low-severity finding is a note, not a warning — it stays neutral. Medium is
// the reviewer's call to make; high and critical are real exposure.
const SEVERITY_COLOR: Record<string, string> = {
  low:      'bg-paper-100 border-paper-200 text-ink-700',
  medium:   'bg-attention-50 border-attention-200 text-attention-700',
  high:     'bg-risk-50 border-risk-200 text-risk-700',
  critical: 'bg-risk-100 border-risk-200 text-risk-900',
}

/**
 * The recommendation carries no meaning colour on purpose. A model advising
 * "Approve" is not an approval, and emerald here would read as one; the assist
 * mark says who wrote it and the words say what it advises.
 */
const REC_LABEL: Record<string, string> = {
  approve:         'AI recommends: Approve',
  review_required: 'AI recommends: Review Required',
  reject_advised:  'AI recommends: Reject',
}

export function ApprovalCard({ stepId, instanceId, stepName, escalateAt, contract, instance, onDecided }: Props) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED' | 'DELEGATED' | null>(null)
  const [comment, setComment] = useState('')
  const [delegateTo, setDelegateTo] = useState('')
  const [showRisks, setShowRisks] = useState(false)

  // B.6.11 — UserPicker fetches the roster itself; no need to manage
  // org-user query state here anymore.

  const submitDecision = useMutation({
    mutationFn: (payload: { stepId: string; decision: string; comment?: string; delegateTo?: string }) =>
      api.post(`/approvals/${instanceId}/decide`, payload).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approval-queue'] })
      queryClient.invalidateQueries({ queryKey: ['contract-approval', contract.id] })
      queryClient.invalidateQueries({ queryKey: ['contract', contract.id] })
      queryClient.invalidateQueries({ queryKey: ['approval-instance', instanceId] })
      onDecided?.()
    },
  })

  function handleSubmit() {
    if (!decision) return
    if (decision === 'REJECTED' && !comment.trim()) return
    if (decision === 'DELEGATED' && !delegateTo) return
    submitDecision.mutate({ stepId, decision, comment: comment.trim() || undefined, delegateTo: delegateTo || undefined })
  }

  const hasRisks = (instance.keyRisks?.length ?? 0) > 0 || (instance.nonStandardTerms?.length ?? 0) > 0
  const rec = instance.approvalRecommendation ? REC_LABEL[instance.approvalRecommendation] : null

  const waited = waitingDaysSince(instance.submittedAt)
  const summaryStillLanding =
    !instance.aiSummary && Date.now() - new Date(instance.submittedAt).getTime() < SUMMARY_GRACE_MS
  // Escalation is the only hard deadline on this card. Past it the step is
  // reassigned over the reviewer's head, so it is exposure, not a nicety.
  const escalateIn = escalateAt ? daysUntil(escalateAt) : null

  return (
    <div
      className="bg-card rounded-card border border-paper-200 overflow-hidden"
      data-testid={`approval-card-${stepId}`}
      data-instance-id={instanceId}
      data-contract-id={contract.id}
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-paper-200 bg-paper-50">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-eyebrow uppercase text-ink-500">{stepName}</p>
            <button
              onClick={() => navigate(`/contracts/${contract.id}`)}
              className="text-section text-ink-950 mt-0.5 hover:underline underline-offset-2 decoration-paper-300 transition-colors text-left flex items-center gap-1.5 group"
            >
              {contract.title}
              <ExternalLink className="size-3.5 text-ink-400 group-hover:text-ink-700 transition-colors" />
            </button>
          </div>
          {/* Contract type is a fact about the document, not a state. */}
          <Chip className="shrink-0">{contract.type}</Chip>
        </div>

        {/* Contract meta */}
        <div className="flex flex-wrap gap-3 mt-3">
          {contract.counterpartyName && (
            <span className="flex items-center gap-1 text-[11.5px] text-ink-500">
              <Building2 className="size-3" />{contract.counterpartyName}
            </span>
          )}
          {contract.value != null && (
            <span className="flex items-center gap-1 text-[11.5px] tabular-nums text-ink-500">
              <DollarSign className="size-3" />{Number(contract.value).toLocaleString()}
            </span>
          )}
          <span className="flex items-center gap-1 text-[11.5px] text-ink-500">
            <Calendar className="size-3" />
            Submitted {new Date(instance.submittedAt).toLocaleDateString()} by {instance.submittedByName ?? 'Unknown'}
          </span>
        </div>

        {/* How long this has been sitting with me, and when it stops being mine.
            A date alone makes the reader do the arithmetic on every card; the
            queue's whole job is to make the backlog legible at a glance. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          <span
            className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium tabular-nums ${
              waited >= 7 ? 'text-risk-700' : waited >= 3 ? 'text-attention-700' : 'text-ink-500'
            }`}
          >
            <span className={`size-1.5 rounded-full ${
              waited >= 7 ? 'bg-risk-600' : waited >= 3 ? 'bg-attention-600' : 'bg-ink-350'
            }`} />
            {waited === 0 ? 'Waiting since today' : `Waiting ${waited} day${waited === 1 ? '' : 's'}`}
          </span>
          {escalateIn != null && (
            <span
              className={`inline-flex items-center gap-1 text-[11.5px] tabular-nums ${
                escalateIn <= 2 ? 'text-risk-700 font-medium' : 'text-ink-500'
              }`}
              title={`This step auto-escalates on ${new Date(escalateAt!).toLocaleDateString()} if no decision is recorded.`}
            >
              {escalateIn <= 2 && <AlertTriangle className="size-3 shrink-0" />}
              {escalateIn < 0
                ? `Escalated ${-escalateIn}d ago`
                : escalateIn === 0
                  ? 'Escalates today'
                  : `Escalates in ${escalateIn}d`}
            </span>
          )}
        </div>
      </div>

      {/* AI Summary */}
      {instance.aiSummary ? (
        <div className="px-5 py-4 border-b border-paper-200">
          {/* Machine-authored block. The diamond is the mark — the accent lives
              in <AssistMark/> and <AssistChip/>, not in loose indigo classes. */}
          <div className="flex items-center gap-1.5 mb-2">
            <AssistMark />
            <Eyebrow className="flex-none">AI Summary</Eyebrow>
            {rec && <AssistChip className="ml-auto">{rec}</AssistChip>}
          </div>
          <p className="text-body text-ink-700">{instance.aiSummary}</p>

          {hasRisks && (
            <button
              onClick={() => setShowRisks(v => !v)}
              className="flex items-center gap-1 text-dense text-ink-500 hover:text-ink-950 mt-2"
            >
              <AlertTriangle className="size-3.5 text-risk-600" />
              {instance.keyRisks?.length ?? 0} risk{(instance.keyRisks?.length ?? 0) !== 1 ? 's' : ''} identified
              {showRisks ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
          )}

          {showRisks && hasRisks && (
            <div className="mt-3 space-y-2">
              {instance.keyRisks?.map((risk, i) => (
                <div key={i} className={`rounded-md border px-3 py-2 text-dense ${SEVERITY_COLOR[risk.severity] ?? SEVERITY_COLOR['medium']}`}>
                  <p className="font-semibold">{risk.title}</p>
                  <p className="mt-0.5 opacity-90">{risk.description}</p>
                </div>
              ))}
              {instance.nonStandardTerms && instance.nonStandardTerms.length > 0 && (
                <div className="text-dense text-ink-700 border border-paper-200 rounded-md px-3 py-2 bg-paper-50">
                  <p className="font-semibold mb-1 text-ink-950">Non-standard terms:</p>
                  <ul className="space-y-0.5 list-disc list-inside">
                    {instance.nonStandardTerms.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      ) : summaryStillLanding ? (
        <div className="px-5 py-3 border-b border-paper-200 flex items-center gap-2 text-dense text-ink-400">
          <Loader2 className="size-3.5 animate-spin" />
          AI summary is being generated…
        </div>
      ) : (
        // No spinner: nothing is running. Say what is missing and point at the
        // document, which is the thing the reviewer has to read instead.
        <div className="px-5 py-3 border-b border-paper-200 flex items-center justify-between gap-2 text-dense text-ink-500">
          <span>No AI summary for this submission — review the contract directly.</span>
          <button
            onClick={() => navigate(`/contracts/${contract.id}`)}
            className="shrink-0 font-medium text-ink-950 hover:underline underline-offset-2 decoration-paper-300"
          >
            Open contract →
          </button>
        </div>
      )}

      {/* Decision area */}
      {submitDecision.isSuccess ? (
        <div className="px-5 py-4 flex items-center gap-2 text-body text-brand-700">
          <CheckCircle2 className="size-4" />
          Decision recorded successfully.
        </div>
      ) : (
        <div className="px-5 py-4 space-y-3">
          {/* Decision buttons */}
          <div className="flex gap-2">
            {/* This is a decision surface — the one place emerald and red are
                allowed to fill a button. Unselected they stay outlined so the
                row still has a single visual weight. */}
            <Button
              size="sm"
              variant={decision === 'APPROVED' ? 'brand' : 'outline'}
              className={decision === 'APPROVED' ? undefined : 'text-brand-700 border-brand-200 hover:bg-brand-50'}
              onClick={() => setDecision(d => d === 'APPROVED' ? null : 'APPROVED')}
              data-testid="approval-approve-btn"
            >
              <CheckCircle2 />Approve
            </Button>
            <Button
              size="sm"
              variant={decision === 'REJECTED' ? 'destructive' : 'danger'}
              onClick={() => setDecision(d => d === 'REJECTED' ? null : 'REJECTED')}
              data-testid="approval-reject-btn"
            >
              <XCircle />Reject
            </Button>
            {/* Delegating is a hand-off, not a verdict — it stays neutral. */}
            <Button
              size="sm"
              variant={decision === 'DELEGATED' ? 'outline' : 'ghost'}
              className={decision === 'DELEGATED' ? 'border-ink-950 text-ink-950' : undefined}
              onClick={() => setDecision(d => d === 'DELEGATED' ? null : 'DELEGATED')}
            >
              <ArrowRight />Delegate
            </Button>
          </div>

          {/* Rejection comment */}
          {(decision === 'REJECTED' || decision === 'APPROVED') && (
            <textarea
              placeholder={decision === 'REJECTED' ? 'Reason for rejection (required)…' : 'Optional comment…'}
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-card text-[13px] text-ink-950 px-3 py-1.5 resize-none placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
            />
          )}

          {/* Delegation — B.6.11 type-ahead picker shared with DecisionStrip */}
          {decision === 'DELEGATED' && (
            <div className="space-y-2">
              <UserPicker
                value={delegateTo}
                onChange={(id) => setDelegateTo(id)}
                placeholder="Delegate to which teammate? Search by name or email…"
                testId="delegate-user-picker"
                autoFocus
              />
              <textarea
                placeholder="Reason for delegation (optional)…"
                value={comment}
                onChange={e => setComment(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-input bg-card text-[13px] text-ink-950 px-3 py-1.5 resize-none placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
              />
            </div>
          )}

          {/* Submit */}
          {decision && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={
                  submitDecision.isPending ||
                  (decision === 'REJECTED' && !comment.trim()) ||
                  (decision === 'DELEGATED' && !delegateTo)
                }
                data-testid="approval-confirm-btn"
              >
                {submitDecision.isPending && <Loader2 className="animate-spin" />}
                Confirm {decision === 'APPROVED' ? 'Approval' : decision === 'REJECTED' ? 'Rejection' : 'Delegation'}
              </Button>
              {submitDecision.isError && (
                <span className="text-dense text-risk-700">
                  {(submitDecision.error as Error)?.message ?? 'Failed — try again'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
