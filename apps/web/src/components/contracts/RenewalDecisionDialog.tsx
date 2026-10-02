/**
 * docs/41 Part 14 — "Start renewal": the decision dialog. Three choices,
 * each saying what it does before anyone clicks (the API's own words,
 * lib/renewal-decisions.ts): renew as is, renegotiate, or let it lapse / end
 * it. Confirming records the decision and starts its action; the result
 * links to what it drafted.
 *
 * RenewalDecisionPanel is the dialog's body (rendered on its own in tests);
 * RenewalDecisionDialog puts it in a modal.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { approvalKeys } from '@/lib/approval-keys'
import { Button } from '@/components/ui/button'
import { deadlineWords, dayWords, renewalKey, RENEWAL_TYPE_WORDS, type RenewalDecisionKind, type RenewalState } from '@/lib/renewal'

type Choice = 'renew' | 'renegotiate' | 'stop'

const CHOICES: Array<{ key: Choice; label: string; confirm: string }> = [
  { key: 'renew',       label: 'Renew as is',            confirm: 'Renew' },
  { key: 'renegotiate', label: 'Renegotiate',            confirm: 'Start the renewal draft' },
  { key: 'stop',        label: 'Let it lapse or end it', confirm: 'Draft the notice' },
]

/** The Renewals page's list and figures (and the sidebar's count). */
const invalidateRenewalLists = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['renewals-list'] })
  void qc.invalidateQueries({ queryKey: ['renewals-stats'] })
}

const detail = (e: unknown) => (e as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'Try again.'

export interface DecideResponse {
  ok: boolean
  decision: RenewalDecisionKind
  unchanged: boolean
  decidedInTime: boolean | null
  actionContract: { id: string; title: string; status: string } | null
}

export function RenewalDecisionPanel({
  state, onDecided, onCancel,
}: {
  state: RenewalState
  onDecided?: (r: DecideResponse) => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const standing = state.decision?.decision
  const [choice, setChoice] = useState<Choice | null>(
    standing === 'renew' || standing === 'renegotiate' ? standing : standing ? 'stop' : null,
  )
  const [ending, setEnding] = useState<'let_lapse' | 'terminate'>(standing === 'terminate' ? 'terminate' : 'let_lapse')
  const [reason, setReason] = useState('')
  const decision: RenewalDecisionKind | null = choice === 'stop' ? ending : choice
  const effectOf = (d: RenewalDecisionKind) => state.choices.find(c => c.decision === d)?.effect ?? ''

  const decide = useMutation({
    mutationFn: async () => (await api.post<DecideResponse>(`/contracts/${state.contractId}/renewal-decision`, { decision, reason: reason.trim() || null })).data,
    onSuccess: r => {
      void qc.invalidateQueries({ queryKey: renewalKey(state.contractId) })
      // The decision moves the contract (Active · Renewing, or Expiring): the
      // header's stage line read "Active" until a reload.
      void qc.invalidateQueries({ queryKey: approvalKeys.stage(state.contractId) })
      void qc.invalidateQueries({ queryKey: ['contract', state.contractId] })
      invalidateRenewalLists(qc)
      onDecided?.(r)
    },
  })
  const done = decide.data

  const deadline = deadlineWords(state)
  const type = state.terms.renewalType ? RENEWAL_TYPE_WORDS[state.terms.renewalType] : 'How it renews isn’t known yet'

  if (done) {
    return (
      <div className="px-5 py-4 space-y-2" data-testid="renewal-decision-done">
        <p className="text-body text-ink-950">
          {done.unchanged ? 'That was already the decision.' : 'Decision recorded.'}
          {done.decidedInTime === false && ' It was made after the notice deadline.'}
        </p>
        {done.actionContract ? (
          <Link to={`/contracts/${done.actionContract.id}`} className="text-body text-brand-700 underline" data-testid="renewal-action-link">
            Open {done.actionContract.title}
          </Link>
        ) : <p className="text-dense text-ink-500">Nothing to draft: it renews on its own. The date is in your calendar feed.</p>}
        <div className="pt-2"><Button size="sm" variant="outline" onClick={onCancel}>Close</Button></div>
      </div>
    )
  }

  return (
    <div data-testid="renewal-decision-panel">
      <section className="px-5 py-3 border-b border-paper-100 text-dense text-ink-700 space-y-0.5">
        <div>{type}{state.terms.renewalTermMonths ? `, for ${state.terms.renewalTermMonths} months at a time` : ''}.</div>
        {state.expiryDate && <div>Current term ends {dayWords(state.expiryDate)}.</div>}
        {deadline && <div className={state.daysToDeadline != null && state.daysToDeadline <= 14 ? 'text-risk-700 font-medium' : ''} data-testid="renewal-deadline">{deadline}</div>}
        {!state.terms.confirmed && (state.terms.renewalType || state.terms.noticeDays) && (
          <div className="text-attention-700">These renewal terms were read by the AI and haven’t been checked yet.</div>
        )}
      </section>

      <fieldset className="px-5 py-3 space-y-2">
        <legend className="sr-only">What do you want to do?</legend>
        {CHOICES.map(c => {
          const d: RenewalDecisionKind = c.key === 'stop' ? ending : c.key
          return (
            <label key={c.key} className={`block rounded-card border px-3 py-2 cursor-pointer ${choice === c.key ? 'border-ink-950 bg-paper-50' : 'border-paper-200 hover:bg-paper-50'}`} data-testid={`renewal-choice-${c.key}`}>
              <div className="flex items-center gap-2">
                <input type="radio" name="renewal-choice" checked={choice === c.key} onChange={() => setChoice(c.key)} />
                <span className="text-body font-medium text-ink-950">{c.label}</span>
              </div>
              <p className="text-dense text-ink-500 mt-0.5 ml-5">{effectOf(d)}</p>
              {c.key === 'stop' && choice === 'stop' && (
                <div className="ml-5 mt-1.5 flex gap-3 text-dense text-ink-700">
                  <label className="flex items-center gap-1"><input type="radio" name="renewal-ending" checked={ending === 'let_lapse'} onChange={() => setEnding('let_lapse')} /> At the end of the term</label>
                  <label className="flex items-center gap-1"><input type="radio" name="renewal-ending" checked={ending === 'terminate'} onChange={() => setEnding('terminate')} /> End it (terminate)</label>
                </div>
              )}
            </label>
          )
        })}
        <label className="block pt-1">
          <span className="text-dense text-ink-700">Why (optional)</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={2000}
            className="mt-1 w-full rounded-md border border-input bg-card px-2 py-1.5 text-body" data-testid="renewal-reason" />
        </label>
        {decide.isError && <p className="text-dense text-risk-700" role="alert">{detail(decide.error)}</p>}
      </fieldset>

      <div className="flex justify-end gap-2 px-5 py-3 border-t border-paper-200">
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!decision || decide.isPending || !state.canDecide} onClick={() => decide.mutate()} data-testid="renewal-decide-btn">
          {decide.isPending && <Loader2 className="animate-spin" />}
          {CHOICES.find(c => c.key === choice)?.confirm ?? 'Choose one'}
        </Button>
      </div>
    </div>
  )
}

/** The decision dialog for a contract: loads its renewal, then the panel. */
export function RenewalDecisionDialog({ contractId, title, onClose }: { contractId: string; title?: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: renewalKey(contractId),
    queryFn: async () => (await api.get<RenewalState>(`/contracts/${contractId}/renewal`)).data,
  })
  // Escape closes; focus goes back to the button that opened it.
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>('input')?.focus(), 0)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current() } }
    document.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(t); document.removeEventListener('keydown', onKey); returnTo?.focus?.() }
  }, [])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/50" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="renewal-decision-title" data-testid="renewal-decision-dialog"
        className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-card bg-card border border-paper-200 shadow-e3">
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-paper-200">
          <div className="min-w-0 flex-1">
            <h2 id="renewal-decision-title" className="text-section text-ink-950">Start renewal</h2>
            {title && <p className="text-dense text-ink-500 mt-0.5 truncate">{title}</p>}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" aria-label="Close"><X className="size-4" /></button>
        </div>
        {q.isLoading && <div className="px-5 py-6 text-dense text-ink-500"><Loader2 className="inline size-3.5 animate-spin mr-1" />Loading…</div>}
        {q.isError && <div className="px-5 py-6 text-dense text-risk-700">{detail(q.error)}</div>}
        {q.data && <RenewalDecisionPanel state={q.data} onCancel={onClose} />}
      </div>
    </div>,
    document.body,
  )
}

/** "Mark notice sent": records the day the notice of non-renewal went out (today, or a day picked). */
export function NoticeSentButton({ contractId, onDone }: { contractId: string; onDone?: () => void }) {
  const qc = useQueryClient()
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10))
  const sent = useMutation({
    mutationFn: async () => (await api.post(`/contracts/${contractId}/renewal-decision/notice-sent`, { sentAt: day })).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: renewalKey(contractId) }); invalidateRenewalLists(qc); onDone?.() },
  })
  return (
    <div className="flex items-center gap-1.5" data-testid="renewal-notice-sent">
      <input type="date" value={day} max={new Date().toISOString().slice(0, 10)} onChange={e => setDay(e.target.value)}
        className="h-[26px] rounded-sm border border-input bg-card px-1.5 text-[11.5px]" aria-label="Day the notice was sent" />
      <Button size="xs" variant="outline" disabled={sent.isPending || !day} onClick={() => sent.mutate()} data-testid="renewal-notice-sent-btn">Mark notice sent</Button>
      {sent.isError && <span className="text-[11px] text-risk-700">{detail(sent.error)}</span>}
    </div>
  )
}
