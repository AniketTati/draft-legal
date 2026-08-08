/**
 * ApprovalTimeline — Phase 06
 * Vertical timeline of all steps in an approval instance.
 * Shows: step name, approver, status badge, decision timestamp, comment.
 */
import { CheckCircle2, XCircle, Zap } from 'lucide-react'
import { StatusPill } from '@/components/ui/status-pill'

interface ApprovalStep {
  id: string
  stepOrder: number
  stepName: string
  approverId: string
  approverName?: string
  status: string
  decision?: string
  comment?: string
  delegatedToId?: string
  decidedAt?: string
  escalateAt?: string
}

interface ApprovalInstance {
  id: string
  status: string
  currentStepOrder: number
  submittedAt: string
  decidedAt?: string
  aiSummary?: string
  approvalRecommendation?: string
}

interface Props {
  instance: ApprovalInstance
  steps: ApprovalStep[]
}

// The per-status icon + colour table is gone: every one of these keys already
// lives in lib/status, and <StatusPill/> renders them the one agreed way.

function fmtDate(d?: string) {
  if (!d) return null
  return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function ApprovalTimeline({ instance, steps }: Props) {
  // Auto-approved: single row
  if (instance.status === 'AUTO_APPROVED') {
    return (
      <div className="space-y-1">
        <div className="flex items-start gap-3 p-3 rounded-card bg-brand-50 border border-brand-200">
          <Zap className="size-4 text-brand-700 mt-0.5 shrink-0" />
          <div>
            <p className="text-body font-semibold text-brand-700">Auto-approved</p>
            <p className="text-dense text-ink-700 mt-0.5">
              Approved automatically based on org rules on {fmtDate(instance.submittedAt)}
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (steps.length === 0) {
    return <p className="text-body text-ink-400 py-4 text-center">No approval steps yet.</p>
  }

  // Group by stepOrder to show parallel steps together
  const grouped = steps.reduce<Record<number, ApprovalStep[]>>((acc, s) => {
    ;(acc[s.stepOrder] ??= []).push(s)
    return acc
  }, {})
  const sortedOrders = Object.keys(grouped).map(Number).sort((a, b) => a - b)

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-4 top-2 bottom-2 w-px bg-paper-200" />

      <div className="space-y-4 pl-10">
        {sortedOrders.map(order => {
          const group = grouped[order]
          const isActive = order === instance.currentStepOrder && instance.status === 'PENDING'
          return (
            // The live node is a state, not an action — a timeline node in
            // flight is info, never ink.
            <div key={order} className={`relative ${isActive ? 'rounded-card border border-info-200 bg-info-50 p-3' : ''}`}>
              {/* Dot on the line */}
              <div className={`absolute -left-[26px] top-1.5 size-3 rounded-full border-2 ${
                isActive ? 'border-info-600 bg-info-600' :
                group.some(s => s.status === 'APPROVED') ? 'border-brand-700 bg-brand-700' :
                group.some(s => s.status === 'REJECTED') ? 'border-risk-600 bg-risk-600' :
                'border-paper-300 bg-card'
              }`} />

              {group.length > 1 && (
                <p className="text-dense font-medium text-ink-500 mb-2">Step {order + 1} — Parallel</p>
              )}

              {group.map(step => (
                <div key={step.id} className={`${group.length > 1 ? 'ml-2 border-l-2 pl-3 mb-2' : ''} ${
                  group.length > 1 && step.status === 'APPROVED' ? 'border-brand-700' :
                  group.length > 1 && step.status === 'REJECTED' ? 'border-risk-600' : 'border-paper-200'
                }`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-body font-medium text-ink-950">
                        {step.stepName}
                        {group.length === 1 && <span className="text-ink-400 font-normal"> — Step {step.stepOrder + 1}</span>}
                      </p>
                      <p className="text-dense text-ink-500 mt-0.5">{step.approverName ?? step.approverId}</p>
                    </div>
                    <StatusPill status={step.status} />
                  </div>

                  {step.decidedAt && (
                    <p className="text-[11px] font-mono text-ink-400 mt-1">{fmtDate(step.decidedAt)}</p>
                  )}
                  {step.status === 'PENDING' && step.escalateAt && (
                    // A deadline on a step that is waiting on someone is their turn.
                    <p className="text-dense text-attention-700 mt-1">
                      Due by {fmtDate(step.escalateAt)}
                    </p>
                  )}
                  {step.comment && (
                    <p className="text-dense italic text-ink-500 mt-1 border-l-2 border-paper-200 pl-2">
                      "{step.comment}"
                    </p>
                  )}
                </div>
              ))}
            </div>
          )
        })}

        {/* Final outcome */}
        {(instance.status === 'APPROVED' || instance.status === 'REJECTED') && (
          <div className={`relative rounded-card border p-3 ${
            instance.status === 'APPROVED'
              ? 'bg-brand-50 border-brand-200'
              : 'bg-risk-50 border-risk-200'
          }`}>
            <div className="absolute -left-[26px] top-3 size-3 rounded-full border-2 bg-card border-paper-300" />
            <div className="flex items-center gap-2">
              {instance.status === 'APPROVED'
                ? <CheckCircle2 className="size-4 text-brand-700" />
                : <XCircle className="size-4 text-risk-600" />}
              <p className="text-body font-semibold text-ink-950">
                {instance.status === 'APPROVED' ? 'Contract Approved' : 'Contract Rejected — Returned to Draft'}
              </p>
            </div>
            {instance.decidedAt && (
              <p className="text-[11px] font-mono text-ink-400 mt-1 ml-6">{fmtDate(instance.decidedAt)}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
