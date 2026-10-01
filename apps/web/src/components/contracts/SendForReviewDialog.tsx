/**
 * SendForReviewDialog (U.6.1)
 *
 * Replaces the silent state-flip the toolbar's "Send for Review" used
 * to do (audit P1 #5). Users now see:
 *   • Which workflow will run (auto-selected, with override picker)
 *   • Who the first reviewer will be (from the workflow's first step)
 *   • An optional message that goes to the approver
 *
 * The preselected workflow is the one the server would choose
 * (pickWorkflow in @clm/types, Z3): the workflow whose rules fit this
 * contract's type and value most closely, else the default. Users can
 * override via the dropdown. When the workflow's rules approve the contract
 * without a review, the dialog says so before it is sent.
 */
import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { autoApproves, pickWorkflow, workflowApplies } from '@clm/types'
import { api } from '@/lib/api'
import { toast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Loader2, X, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react'

interface WorkflowDef {
  id: string
  name: string
  description?: string | null
  isDefault: boolean
  isActive: boolean
  createdAt: string
  steps: Array<{
    name?: string
    stepName?: string
    approverType?: string
    approverIds?: string[]
    approverRoles?: string[]
  }>
  triggerRules?: unknown
}

export function SendForReviewDialog({
  contractId,
  contractType,
  contractValue,
  contractCurrency,
  open,
  onClose,
  onSent,
}: {
  contractId: string
  contractType?: string
  /** As the API returns it: a decimal string, or null when not set. */
  contractValue?: string | number | null
  contractCurrency?: string | null
  open: boolean
  onClose: () => void
  onSent: () => void
}) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const { data: allWorkflows = [], isLoading: loadingWorkflows } = useQuery<WorkflowDef[]>({
    queryKey: ['workflows-for-review', contractType],
    queryFn: () => api.get('/approvals/workflows').then(r => r.data),
    enabled: open,
    staleTime: 60_000,
  })
  // The server runs only active workflows.
  const workflows = allWorkflows.filter(w => w.isActive)

  const routed = {
    type:     contractType ?? '',
    value:    contractValue == null || contractValue === '' ? null : Number(contractValue),
    currency: contractCurrency ?? null,
  }
  const autoDefault = pickWorkflow(workflows, routed)

  const effectiveWorkflowId = selectedWorkflowId ?? autoDefault?.id ?? null
  const effectiveWorkflow = workflows.find(w => w.id === effectiveWorkflowId) ?? autoDefault

  const submit = useMutation({
    // Shown where it happened; the global error toast stays out (lib/api.ts).
    meta: { errorHandled: true },
    mutationFn: () => api.post(`/contracts/${contractId}/submit-approval`, {
      workflowDefinitionId: effectiveWorkflowId,
      comment: message.trim() || undefined,
    }).then(r => r.data),
    onSuccess: (data: { autoApproved?: boolean }) => {
      if (data?.autoApproved) {
        toast.success('Approved automatically', { description: "The workflow's rules approve this contract without a review." })
      }
      onSent()
      onClose()
      // reset for next time
      setSelectedWorkflowId(null)
      setMessage('')
    },
  })

  if (!open) return null

  const approvesAtOnce = !!effectiveWorkflow && autoApproves(effectiveWorkflow.triggerRules, routed)
  const firstStep = effectiveWorkflow?.steps?.[0]
  const firstStepLabel = firstStep
    ? (firstStep.stepName ?? firstStep.name ?? 'First reviewer')
    : 'First reviewer'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label="Send for review"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="send-for-review-dialog"
        className="bg-card rounded-card shadow-e3 w-full max-w-md mx-4 flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-paper-200 flex items-center justify-between">
          <div>
            <h2 className="text-section text-ink-950">Send for review</h2>
            <p className="text-dense text-ink-500 mt-1">
              Pick a workflow and (optionally) leave a note for the reviewer.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-paper-100 text-ink-500"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          {loadingWorkflows ? (
            <div className="flex items-center justify-center py-6 text-ink-400 gap-2 text-body">
              <Loader2 className="size-4 animate-spin" /> Loading workflows…
            </div>
          ) : workflows.length === 0 ? (
            <div className="text-body text-attention-700 bg-attention-50 border border-attention-200 rounded-md p-3 inline-flex items-start gap-2">
              <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">No workflows configured</p>
                {/* X76 — workflows live under Approvals → Manage Workflows; there is no "Admin → Approvals". */}
                <p className="text-dense mt-1 leading-relaxed">An admin needs to create one first, under Approvals → Manage Workflows.</p>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-dense font-semibold text-ink-700 mb-1.5">Workflow</label>
                <select
                  value={effectiveWorkflowId ?? ''}
                  onChange={e => setSelectedWorkflowId(e.target.value || null)}
                  data-testid="send-for-review-workflow"
                  className="w-full h-8 text-[13px] border border-input rounded-md px-2.5 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
                >
                  {!effectiveWorkflowId && <option value="" disabled>Choose a workflow</option>}
                  {workflows.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.name}{w.isDefault ? ' (default)' : ''}
                      {w === autoDefault && workflowApplies(w.triggerRules, routed) ? ' — fits this contract' : ''}
                    </option>
                  ))}
                </select>
                {!autoDefault && (
                  <p className="text-[11px] text-ink-500 mt-1.5">No workflow's rules cover this contract, and there is no default. Choose one to send it.</p>
                )}
                {effectiveWorkflow?.description && (
                  <p className="text-[11px] text-ink-500 mt-1.5">{effectiveWorkflow.description}</p>
                )}
              </div>

              {approvesAtOnce ? (
                <div className="bg-paper-50 border border-paper-200 rounded-md p-3 text-[13px] text-ink-950" data-testid="send-for-review-auto-approve">
                  This workflow's rules approve this contract as soon as you send it, with no review.
                </div>
              ) : (
              /* Reviewer chain preview */
              <div className="bg-paper-50 border border-paper-200 rounded-md p-3">
                <div className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-ink-700 mb-1.5">
                  First reviewer
                </div>
                {/* Neutral tick: naming the next reviewer is a fact, not an
                    approval that has already happened. */}
                <div className="text-[13px] text-ink-950 inline-flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-ink-400" />
                  {firstStepLabel}
                </div>
                {(effectiveWorkflow?.steps?.length ?? 0) > 1 && (
                  <p className="text-[11px] text-ink-500 mt-1.5">
                    Then {effectiveWorkflow!.steps.length - 1} more {effectiveWorkflow!.steps.length - 1 === 1 ? 'step' : 'steps'} in sequence.
                  </p>
                )}
              </div>
              )}

              <div>
                <label className="block text-dense font-semibold text-ink-700 mb-1.5">
                  Message <span className="text-ink-400 font-normal">(optional)</span>
                </label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={3}
                  placeholder="Anything the reviewer should know? (e.g. urgency, key terms to focus on)"
                  data-testid="send-for-review-message"
                  className="w-full resize-none rounded-md border border-input bg-card px-[11px] py-2 text-[13px] text-ink-950 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
                />
              </div>

              {submit.isError && (
                <div className="text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md p-2.5 inline-flex items-start gap-1.5">
                  <AlertCircle className="size-3.5 mt-0.5 flex-shrink-0" />
                  <span>{(submit.error as { response?: { data?: { error?: string; detail?: string } } })?.response?.data?.error ?? (submit.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Could not submit. Try again.'}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-paper-200 bg-paper-50 rounded-b-card flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submit.isPending}>
            Cancel
          </Button>
          {/* Sending is the dialog's one action, so it is the ink primary —
              the indigo it used to wear belongs to the machine now. */}
          <Button
            size="sm"
            onClick={() => submit.mutate()}
            disabled={!effectiveWorkflowId || submit.isPending || workflows.length === 0}
            data-testid="send-for-review-confirm"
          >
            {submit.isPending
              ? <><Loader2 className="size-3.5 animate-spin" /> Sending…</>
              : <>Send <ArrowRight className="size-3.5" /></>}
          </Button>
        </div>
      </div>
    </div>
  )
}
