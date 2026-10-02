/**
 * StatusBanner — docs/41 Parts 12, 18: where the contract is, whose move it
 * is, and the one thing to do next.
 *
 *   Request → Draft → Negotiate → Approve → Sign → Active
 *   Negotiate · Counterparty's turn · 2 days        Approvals 1 of 2   [Submit for approval]  ⋯
 *
 * It replaces four surfaces that each worked the state out their own way: the
 * negotiation strip (which guessed the turn in the browser), the "returned"
 * banner, the signature revert banner and the header's status buttons.
 * Everything comes from GET /contracts/:id/stage. The progress bar opens the
 * History drawer. Moves by hand (and Cancel) are in the menu; going
 * backwards asks why.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, ChevronRight, History, Loader2, MoreHorizontal, Undo2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { approvalKeys, invalidateApproval, serverMessage } from '@/lib/approval-keys'
import { toast } from '@/components/common/Toaster'
import { agoWords, fetchWorkingCopy, workingCopyKey } from '@/lib/working-copy'

export interface StageView {
  contractId: string
  stage: string
  stageState: string
  turn: string
  status: string
  stageLabel: string
  stateLabel: string
  turnLabel: string | null
  turnSince: string
  turnSinceWords: string | null
  turnOwner: { id: string; name: string | null; isMe: boolean } | null
  line: string
  progress: Array<{ stage: string; label: string; status: 'done' | 'current' | 'todo' | 'skipped' }>
  next: { kind: string; label: string; enabled: boolean; why?: string } | null
  approvals: { approved: number; total: number; status: string; outcome: string | null; instanceId: string; myStepId: string | null } | null
  signatures: { signed: number; total: number; status: string; id: string } | null
  exceptions: { open: number }
  returned: { outcome: 'returned' | 'declined'; by: { id: string; name: string } | null; reason: string | null; at: string | null } | null
  latestVersion: { id: string; number: number; fromCounterparty: boolean; at: string } | null
  /** docs/41 Part 15 — what the counterparty's latest version brought, once its findings are in. */
  counterparty?: { versionNumber: number; changes: number; needAttention: number; missingRequired: number; advised: boolean } | null
  moves: Array<{ to: { stage: string; state: string }; label: string; needsReason: boolean; tone?: 'danger' }>
  canCancel: boolean
  canUndoCancel: boolean
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Counterparty sent v5 — 12 changes, 3 need attention, 1 required clause missing". */
export function counterpartyLine(c: NonNullable<StageView['counterparty']>): string {
  const parts = [plural(c.changes, 'change')]
  if (c.needAttention) parts.push(`${c.needAttention} need${c.needAttention === 1 ? 's' : ''} attention`)
  if (c.missingRequired) parts.push(`${plural(c.missingRequired, 'required clause')} missing`)
  return `Counterparty sent v${c.versionNumber} — ${parts.join(', ')}`
}

type Ask =
  | { kind: 'move'; to: { stage: string; state: string }; label: string; needsReason: boolean }
  | { kind: 'cancel' }
  | { kind: 'uncancel' }
  | { kind: 'revert' }
  | { kind: 'declined' }

export function StatusBanner({
  contractId, onSubmit, onSendForSignature, onReviewChanges, onOpenHistory, pendingSuggestions = 0,
}: {
  contractId: string
  /** C4 — suggestions in the document nobody has accepted or rejected yet. */
  pendingSuggestions?: number
  /** Opens the page's Submit-for-approval dialog. */
  onSubmit: () => void
  onSendForSignature: () => void
  /** Shows the counterparty's changes (the workspace's Changes mode). */
  onReviewChanges: () => void
  onOpenHistory: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [ask, setAsk] = useState<Ask | null>(null)
  const [reason, setReason] = useState('')
  const [revertTo, setRevertTo] = useState<'approve' | 'negotiate' | 'draft' | ''>('')

  const { data: s, isError } = useQuery<StageView>({
    queryKey: approvalKeys.stage(contractId),
    queryFn: () => api.get(`/contracts/${contractId}/stage`).then(r => r.data),
    staleTime: 10_000,
  })
  // docs/41 Part 16 — edits typed but not yet saved as a version.
  const { data: draft } = useQuery({
    queryKey: workingCopyKey(contractId),
    queryFn: () => fetchWorkingCopy(contractId),
    staleTime: 10_000,
  })

  const done = (message: string) => {
    toast.success(message)
    setAsk(null)
    setReason('')
    setRevertTo('')
    invalidateApproval(qc, contractId)
    qc.invalidateQueries({ queryKey: ['contracts'] })
    qc.invalidateQueries({ queryKey: ['signature-requests', contractId] })
  }
  const act = useMutation({
    mutationFn: async (a: Ask) => {
      const why = reason.trim() || undefined
      if (a.kind === 'move') return api.post(`/contracts/${contractId}/stage`, { ...a.to, reason: why }).then(r => r.data)
      if (a.kind === 'cancel') return api.post(`/contracts/${contractId}/cancel`, { reason: why }).then(r => r.data)
      if (a.kind === 'uncancel') return api.post(`/contracts/${contractId}/uncancel`, { reason: why }).then(r => r.data)
      if (a.kind === 'revert') return api.post(`/contracts/${contractId}/revert-signature`, { reason: why, ...(revertTo && { to: revertTo }) }).then(r => r.data)
      return null
    },
    onSuccess: (_r, a) => done(a.kind === 'cancel' ? 'Contract cancelled' : a.kind === 'uncancel' ? 'Contract brought back' : a.kind === 'revert' ? 'Taken back from signature' : 'Moved'),
    // Shown in the banner, with the server's reason.
    onError: () => {},
  })

  if (isError || !s) return null

  const primary = s.next
  const runPrimary = () => {
    if (!primary) return
    switch (primary.kind) {
      case 'submit':
      case 'resubmit': return onSubmit()
      case 'review_changes': return onReviewChanges()
      case 'send_for_signature': return onSendForSignature()
      case 'decide': return document.getElementById('approval-decision-strip')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      case 'revert_signature': return setAsk({ kind: 'revert' })
      case 'declined': return setAsk({ kind: 'declined' })
      case 'sign': return navigate('/signatures')
    }
  }
  const askNeedsReason = ask && (ask.kind === 'cancel' || ask.kind === 'uncancel' || ask.kind === 'revert' || (ask.kind === 'move' && ask.needsReason))
  const backed = s.returned
  const signatureStopped = s.stage === 'sign' && s.stageState !== 'out_for_signature'

  return (
    <div className="border-b border-paper-200 bg-card" data-testid="status-banner" data-stage={s.stage} data-state={s.stageState} data-turn={s.turn}>
      <div className="px-6 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Progress: click for the stage history. */}
        <button
          type="button"
          onClick={onOpenHistory}
          className="flex items-center gap-1 text-[11.5px] rounded-md -ml-1 px-1 py-0.5 hover:bg-paper-100"
          title="Open the history"
          data-testid="stage-progress"
        >
          {s.progress.map((p, i) => (
            <span key={p.stage} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3 text-paper-300" aria-hidden />}
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium',
                  p.status === 'current' && 'bg-ink-950 text-white',
                  p.status === 'done' && 'text-ink-700',
                  p.status === 'skipped' && 'text-ink-400 line-through decoration-paper-300',
                  p.status === 'todo' && 'text-ink-400',
                )}
                data-status={p.status}
              >
                {p.status === 'done' && <Check className="size-3 text-brand-700" aria-hidden />}
                {p.label}
              </span>
            </span>
          ))}
        </button>

        {/* State and turn in words. */}
        <span className={cn('text-dense font-medium', s.turnOwner?.isMe || s.next?.kind === 'decide' ? 'text-attention-700' : 'text-ink-950')} data-testid="stage-line">
          {s.stage === 'closed' ? `${s.stageLabel} · ${s.stateLabel}` : s.line}
          {s.turnOwner?.isMe && <span className="ml-1 font-semibold">(you)</span>}
        </span>

        {s.counterparty && s.next?.kind === 'review_changes' && (
          <span className="text-dense text-ink-950" data-testid="stage-counterparty" title={s.counterparty.advised ? undefined : 'AI advice on their changes is still being worked out.'}>
            {counterpartyLine(s.counterparty)}
          </span>
        )}

        {s.approvals && ['approve', 'sign'].includes(s.stage) && s.approvals.total > 0 && (
          <span className="text-[11.5px] text-ink-500 tabular-nums" data-testid="stage-approvals">Approvals {s.approvals.approved} of {s.approvals.total}</span>
        )}
        {s.signatures && s.stage === 'sign' && (
          <span className="text-[11.5px] text-ink-500 tabular-nums" data-testid="stage-signatures">Signatures {s.signatures.signed} of {s.signatures.total}</span>
        )}
        {draft && (
          <span
            className="inline-flex items-center rounded-full border border-attention-200 bg-attention-50 px-2 py-0.5 text-[11.5px] font-medium text-attention-700"
            title={`Saved by ${draft.updatedBy.name ?? 'someone'} ${agoWords(draft.updatedAt)}. Not a version yet: open Edit to save them as one, or discard them.`}
            data-testid="draft-changes-chip"
          >
            Unsaved draft changes
          </span>
        )}
        {pendingSuggestions > 0 && (
          <span className="text-[11.5px] text-ink-700 tabular-nums" title="Findings read the document as if they were accepted" data-testid="stage-suggestions">
            {pendingSuggestions} suggestion{pendingSuggestions === 1 ? '' : 's'} pending
          </span>
        )}
        {s.exceptions.open > 0 && (
          <span className="text-[11.5px] text-attention-700">{s.exceptions.open} exception{s.exceptions.open === 1 ? '' : 's'} to decide</span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {primary && (
            <Button size="sm" onClick={runPrimary} disabled={!primary.enabled} title={primary.why} data-testid="stage-next">
              {primary.kind === 'revert_signature' && <Undo2 />}
              {primary.label}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onOpenHistory} data-testid="open-history" title="Everything that happened to this contract">
            <History />History
          </Button>
          {(s.moves.length > 0 || s.canCancel || s.canUndoCancel) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label="More stage actions" data-testid="stage-more"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {s.moves.map(m => (
                  <DropdownMenuItem key={`${m.to.stage}/${m.to.state}`} onSelect={() => m.needsReason ? setAsk({ kind: 'move', ...m }) : act.mutate({ kind: 'move', ...m })}>
                    {m.label}{m.needsReason ? '…' : ''}
                  </DropdownMenuItem>
                ))}
                {s.moves.length > 0 && (s.canCancel || s.canUndoCancel) && <DropdownMenuSeparator />}
                {s.canCancel && <DropdownMenuItem onSelect={() => setAsk({ kind: 'cancel' })}>Cancel contract…</DropdownMenuItem>}
                {s.canUndoCancel && <DropdownMenuItem onSelect={() => setAsk({ kind: 'uncancel' })}>Bring it back…</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Why it came back: a return (fix and resubmit) or a decline (decide). */}
      {backed && (
        <div className="px-6 py-2 border-t border-attention-200 bg-attention-50 flex flex-wrap items-center gap-x-2 gap-y-1 text-dense" data-testid="returned-banner" role="status">
          <AlertTriangle className="size-4 flex-shrink-0 text-attention-700" />
          <span className="font-medium text-ink-950">{backed.outcome === 'declined' ? 'Declined' : 'Returned'} by {backed.by?.name ?? 'an approver'}{backed.reason ? ':' : ''}</span>
          {backed.reason && <span className="text-ink-700">“{backed.reason}”</span>}
          <span className="text-ink-500">— {backed.outcome === 'declined' ? 'rework it and submit again, or cancel it.' : 'fix it and submit it for approval again.'}</span>
        </div>
      )}
      {signatureStopped && (
        <div className="px-6 py-2 border-t border-attention-200 bg-attention-50 flex flex-wrap items-center gap-2 text-dense" data-testid="signature-revert-banner">
          <Undo2 className="size-4 flex-shrink-0 text-attention-700" />
          <span className="font-medium text-ink-950">The signature request was {s.stageState === 'declined' ? 'declined' : 'voided'}.</span>
          <span className="text-ink-700">Nothing is out for signature. Take the contract back to change it, or send it again.</span>
        </div>
      )}
      {act.isError && !ask && (
        <div role="alert" className="px-6 pb-2 text-dense text-risk-700">{serverMessage(act.error)}</div>
      )}

      {/* What a move needs: a reason, and for a revert, where it goes back to. */}
      {ask && (
        <div className="px-6 py-3 border-t border-paper-200 bg-paper-50 space-y-2" data-testid="stage-ask">
          {ask.kind === 'declined' ? (
            <div className="flex flex-wrap items-center gap-2 text-dense">
              <span className="text-ink-700">An approver said it should not go ahead as it is.</span>
              <Button size="sm" onClick={() => { setAsk(null); onSubmit() }}>Rework and resubmit</Button>
              <Button size="sm" variant="danger" onClick={() => setAsk({ kind: 'cancel' })}>Cancel contract…</Button>
              <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>Not now</Button>
            </div>
          ) : (
            <>
              <p className="text-dense text-ink-700">
                {ask.kind === 'cancel' ? 'Cancel this contract. It is kept, closed; an admin can bring it back.'
                  : ask.kind === 'uncancel' ? 'Bring this contract back to where it was cancelled from.'
                  : ask.kind === 'revert' ? 'Take the contract back from signature. The voided request stays in the history.'
                  : `${ask.label}.`}
              </p>
              {ask.kind === 'revert' && (
                <div className="flex flex-wrap gap-3 text-dense" role="radiogroup" aria-label="Where it goes back to">
                  {([['', 'Where it was worked on'], ['approve', 'Approved, to send again'], ['negotiate', 'Negotiate'], ['draft', 'Draft']] as const).map(([v, label]) => (
                    <label key={v} className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name="revert-to" className="accent-ink-950" checked={revertTo === v} onChange={() => setRevertTo(v)} />
                      {label}
                    </label>
                  ))}
                </div>
              )}
              {askNeedsReason && (
                <input
                  autoFocus
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="Why (recorded on the contract)…"
                  className="w-full text-[13px] bg-card px-2.5 py-1.5 border border-paper-200 rounded-md focus:outline-none focus:border-ink-950"
                  data-testid="stage-ask-reason"
                />
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={ask.kind === 'cancel' ? 'danger' : 'default'}
                  onClick={() => act.mutate(ask)}
                  disabled={act.isPending || (!!askNeedsReason && reason.trim().length < 3)}
                  data-testid="stage-ask-confirm"
                >
                  {act.isPending && <Loader2 className="animate-spin" />}
                  {ask.kind === 'cancel' ? 'Cancel contract' : ask.kind === 'uncancel' ? 'Bring it back' : ask.kind === 'revert' ? 'Take it back' : ask.label}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setAsk(null); setReason('') }} disabled={act.isPending}>Not now</Button>
                {act.isError && <span role="alert" className="text-dense text-risk-700">{serverMessage(act.error)}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
