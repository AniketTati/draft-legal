/**
 * FieldFillDialog (docs/39 D1) — try a field on a few contracts, then fill it
 * in on the rest.
 *
 * "Fill in existing contracts" used to run on every contract at once, blind:
 * no way to see what the field would find, to fix a description that reads
 * the wrong thing, or to know what it would cost. Here the admin tries it on
 * five contracts first (nothing is saved), rewords what the AI should look
 * for and tries again, then fills it in knowing how many contracts that reads
 * and about what it costs — and can undo the fill for 30 days.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'

interface Def { id: string; fieldKey: string; fieldLabel: string; fieldType: string; helpText: string | null; contractType: string | null }

interface PreviewRow { contractId: string; title: string; display: string | null; quote: string | null; current: string | null; issue?: string | null; error?: string }
interface Estimate {
  contracts: number; usd: number; model: string | null; byok: boolean
  /** D5 — the AI's values read again too, with the field's wording now. */
  recheck: { contracts: number; aiValues: number; usd: number }
}

const detail = (e: unknown) => (e as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'Try again.'

const money = (usd: number) => (usd < 0.01 ? 'under $0.01' : usd < 10 ? `about $${usd.toFixed(2)}` : `about $${Math.round(usd)}`)

export function FieldFillDialog({ def, onClose }: { def: Def; onClose: () => void }) {
  const qc = useQueryClient()
  const [helpText, setHelpText] = useState(def.helpText ?? '')
  const [savedHelp, setSavedHelp] = useState(def.helpText ?? '')
  const { data: estimate } = useQuery({
    queryKey: ['field-fill-estimate', def.id],
    queryFn: async () => (await api.get<Estimate>(`/field-definitions/${def.id}/backfill/estimate`)).data,
  })
  const preview = useMutation({
    mutationFn: async () => (await api.post<{ results: PreviewRow[]; found: number; tried: number }>(`/field-definitions/${def.id}/preview`, {
      limit: 5, helpText: helpText.trim() || undefined,
    })).data,
    onError: err => toast.error("Couldn't try the field", { description: detail(err) }),
  })
  const saveHelp = useMutation({
    mutationFn: async () => (await api.patch(`/field-definitions/${def.id}`, { helpText: helpText.trim() })).data,
    onSuccess: () => { setSavedHelp(helpText.trim()); qc.invalidateQueries({ queryKey: ['field-definitions'] }); toast.success('Description saved') },
    onError: err => toast.error("Couldn't save the description", { description: detail(err) }),
  })
  const fill = useMutation({
    // A description reworded here is the one the fill uses: saved first.
    mutationFn: async (mode: 'fill' | 'recheck') => {
      if (helpText.trim() !== savedHelp.trim()) await api.patch(`/field-definitions/${def.id}`, { helpText: helpText.trim() })
      return (await api.post(`/field-definitions/${def.id}/backfill`, { mode })).data
    },
    onSuccess: (_, mode) => {
      toast.success(mode === 'recheck' ? `Re-checking ${def.fieldLabel}` : `Filling in ${def.fieldLabel}`, {
        description: `Its progress shows beside the field. You can undo the ${mode === 'recheck' ? 're-check' : 'fill'} for 30 days.`,
      })
      qc.invalidateQueries({ queryKey: ['field-definitions'] })
      onClose()
    },
    onError: err => toast.error("Couldn't start it", { description: detail(err) }),
  })

  // Escape closes; focus lands in the description and goes back to the trigger (as ConfirmDialog).
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>('textarea')?.focus(), 0)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current() } }
    document.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(t); document.removeEventListener('keydown', onKey); returnTo?.focus?.() }
  }, [])

  const changed = helpText.trim() !== savedHelp.trim()
  const scope = def.contractType ? `${def.contractType.replace(/_/g, ' ')} contracts` : 'every contract'
  const tried = preview.data
  const unread = tried?.results.filter(r => r.error).length ?? 0
  // Every contract failed the same way: one line, not five.
  const allFailed = !!tried && tried.tried > 0 && unread === tried.tried

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="field-fill-title" data-testid="field-fill-dialog"
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-card bg-card border border-paper-200 shadow-e3"
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-paper-200">
          <div className="min-w-0 flex-1">
            <h2 id="field-fill-title" className="text-section text-ink-950">Fill in {def.fieldLabel}</h2>
            <p className="text-dense text-ink-500 mt-0.5">On {scope} analysed before the field existed. Try it on a few first.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" aria-label="Close"><X className="size-4" /></button>
        </div>

        <section className="px-5 py-4 space-y-3 border-b border-paper-100">
          <label className="block">
            <span className="text-[11.5px] font-semibold text-ink-950">What the AI looks for</span>
            <textarea
              value={helpText} onChange={e => setHelpText(e.target.value)} rows={2} maxLength={512}
              placeholder={`e.g. The ${def.fieldLabel.toLowerCase()} as the contract states it`}
              className="mt-1 w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-[12.5px] leading-snug focus:outline-none focus:ring-1 focus:ring-ink-950"
              data-testid="field-fill-help"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" variant={tried ? 'outline' : 'default'} disabled={preview.isPending} onClick={() => preview.mutate()} data-testid="field-fill-try">
              {preview.isPending && <Loader2 className="animate-spin" />}
              {tried ? 'Try again' : 'Try on 5 contracts'}
            </Button>
            {changed && (
              <Button size="sm" variant="ghost" disabled={saveHelp.isPending} onClick={() => saveHelp.mutate()}>Save this description</Button>
            )}
            <span className="ml-auto text-[11.5px] text-ink-500">Nothing is saved while you try.</span>
          </div>
          {preview.isPending && <p className="text-dense text-ink-500">Reading five contracts… this takes a few seconds each.</p>}
          {tried && allFailed && (
            <p className="rounded-md border border-risk-200 bg-risk-50 px-3 py-2 text-[12px] text-risk-700" data-testid="field-fill-results">
              Couldn&apos;t read any of the {tried.tried} contracts: {tried.results[0].error}. Try again in a minute.
            </p>
          )}
          {tried && !allFailed && (
            <div className="rounded-md border border-paper-200" data-testid="field-fill-results">
              <p className="px-3 py-2 text-[12px] text-ink-700 border-b border-paper-100">
                {tried.tried === 0
                  ? `No ${scope} analysed yet to try it on.`
                  : <>Found on <span className="font-semibold">{tried.found}</span> of {tried.tried}{unread > 0 && <span className="text-ink-500"> · {unread} couldn&apos;t be read</span>}</>}
              </p>
              <div className="divide-y divide-paper-100">
                {tried.results.map(r => (
                  <div key={r.contractId} className="px-3 py-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 text-[12px]">
                    <Link to={`/contracts/${r.contractId}`} target="_blank" className="text-ink-950 hover:underline underline-offset-2 truncate" title={r.title}>{r.title}</Link>
                    <div className="min-w-0">
                      {r.error ? <span className="text-risk-700">Couldn&apos;t read it: {r.error}</span>
                        : r.display ? <span className="font-medium text-ink-950">{r.display}</span>
                          : <span className="text-ink-400 italic">Not found</span>}
                      {r.current && r.current !== r.display && <span className="ml-2 text-[11px] text-ink-500">currently {r.current}</span>}
                      {r.quote && <p className="text-[11px] italic text-ink-500 truncate" title={r.quote}>“{r.quote}”</p>}
                      {/* A5 — a reading to trust less: its quote isn't in the document. */}
                      {r.issue && <p className="text-[11px] text-attention-700">{r.issue}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 text-[12.5px] text-ink-700" data-testid="field-fill-estimate">
              {!estimate ? 'Counting contracts…'
                : estimate.contracts === 0 ? 'Every contract it applies to already has a value.'
                  : <>
                      <span className="font-semibold text-ink-950">{estimate.contracts}</span> contract{estimate.contracts === 1 ? '' : 's'} without a value yet ·{' '}
                      {estimate.byok ? 'on your own AI key' : money(estimate.usd)}{estimate.model ? ` (${estimate.model})` : ''}
                    </>}
            </div>
            {/* Trying first is the way through: the fill leads once a try found something. */}
            <Button
              size="sm" variant={tried?.found && !changed ? 'default' : 'outline'} disabled={!estimate?.contracts || fill.isPending} onClick={() => fill.mutate('fill')}
              title={changed ? 'Saves the new description, then fills the field in with it' : undefined} data-testid="field-fill-start"
            >
              {fill.isPending && fill.variables === 'fill' && <Loader2 className="animate-spin" />}
              {changed ? 'Save and fill in' : 'Fill in'}{estimate?.contracts ? ` on ${estimate.contracts}` : ''}
            </Button>
          </div>
          {/* D5 — values the AI read with the old wording, read again with this one. */}
          {!!estimate?.recheck.aiValues && (
            <div className="flex items-center gap-3" data-testid="field-recheck">
              <div className="min-w-0 flex-1 text-[12.5px] text-ink-700">
                Read the <span className="font-semibold text-ink-950">{estimate.recheck.aiValues}</span> AI value{estimate.recheck.aiValues === 1 ? '' : 's'} again
                {changed ? ' with the new description' : ''}
                {estimate.recheck.contracts > estimate.recheck.aiValues ? `, and fill the ${estimate.recheck.contracts - estimate.recheck.aiValues} empty` : ''} ·{' '}
                {estimate.byok ? 'on your own AI key' : money(estimate.recheck.usd)}
              </div>
              <Button
                // Leads once the new wording has been tried: try, then re-read everything with it.
                size="sm" variant={changed && tried ? 'default' : 'outline'} disabled={fill.isPending} onClick={() => fill.mutate('recheck')}
                title={changed ? 'Saves the new description, then reads every AI value again with it' : 'Reads every AI value again with the description above'}
                data-testid="field-recheck-start"
              >
                {fill.isPending && fill.variables === 'recheck' && <Loader2 className="animate-spin" />}
                {changed ? 'Save and re-check' : 'Re-check'} {estimate.recheck.contracts}
              </Button>
            </div>
          )}
          <p className="text-[11px] text-ink-500">Values a person set or checked are never overwritten. You can undo either for 30 days.</p>
        </section>
      </div>
    </div>,
    document.body,
  )
}
