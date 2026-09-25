/**
 * ObligationDrawer — one obligation, opened from the Obligations list or a
 * contract's rail. Rows looked clickable and opened nothing: the record, its
 * source quote and its evidence were served by the API (GET /obligations/:id)
 * and shown nowhere.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X, Loader2, CheckCircle2, RotateCcw, ExternalLink, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/ui/status-pill'
import { useCanRequest } from '@/lib/permissions'
import { CompleteObligationModal } from '@/components/contracts/CompleteObligationModal'

interface ObligationRecord {
  id: string
  type: string
  description: string
  owner: string
  dueDate: string | null
  recurrence: string
  trigger: string | null
  quote: string
  severity: string
  sectionRef: string | null
  status: string
  completedAt: string | null
  completionNote: string | null
  evidenceFilename: string | null
  contract: {
    id: string; title: string; status: string; type: string
    counterpartyName: string | null
    owner: { name: string | null; email: string } | null
  } | null
  completedBy: { name: string | null; email: string } | null
}

/** "§7.1", whether or not the stored reference already carries the sign. */
export function sectionLabel(ref: string | null | undefined): string | null {
  const bare = ref?.replace(/^\s*§\s*/, '').trim()
  return bare ? `§${bare}` : null
}

const PARTY: Record<string, string> = {
  customer: 'The customer', provider: 'The provider', either: 'Either party', unknown: 'Not stated',
}

const overdueDays = (o: { status: string; dueDate: string | null }) => {
  if (o.status !== 'OPEN' && o.status !== 'OVERDUE') return 0
  const days = o.dueDate ? Math.floor((Date.now() - new Date(o.dueDate).getTime()) / 86_400_000) : 0
  return days > 0 ? days : 0
}

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null)

export function ObligationDrawer({ obligationId, onClose }: { obligationId: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [completing, setCompleting] = useState(false)
  const canEdit = useCanRequest('POST /obligations/:id/reopen')

  const { data: o, isLoading, isError } = useQuery<ObligationRecord>({
    queryKey: ['obligation', obligationId],
    queryFn: () => api.get(`/obligations/${obligationId}`).then(r => r.data),
    enabled: !!obligationId,
  })

  useEffect(() => {
    if (!obligationId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !completing) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [obligationId, completing, onClose])

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['obligation', obligationId] })
    qc.invalidateQueries({ queryKey: ['obligations-list'] })
    qc.invalidateQueries({ queryKey: ['obligations-stats'] })
    qc.invalidateQueries({ queryKey: ['contract-obligations'] })
  }
  const reopen = useMutation({
    mutationFn: () => api.post(`/obligations/${obligationId}/reopen`).then(r => r.data),
    onSuccess: refresh,
  })
  const evidence = useMutation({
    mutationFn: () => api.get(`/obligations/${obligationId}/evidence`).then(r => r.data as { url: string }),
    onSuccess: ({ url }) => { window.open(url, '_blank', 'noopener') },
  })

  if (!obligationId) return null
  const section = sectionLabel(o?.sectionRef)
  const sectionParam = o?.sectionRef?.replace(/^\s*§\s*/, '').trim()
  const done = o?.status === 'COMPLETED' || o?.status === 'WAIVED'

  return (
    <>
      <div className="fixed inset-0 bg-ink-950/30 z-40" onClick={onClose} />
      <aside
        className="fixed inset-y-0 right-0 w-full sm:max-w-md bg-card shadow-e3 z-50 flex flex-col"
        role="dialog"
        aria-label="Obligation"
        data-testid="obligation-drawer"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-paper-200">
          <div className="min-w-0">
            <p className="text-eyebrow uppercase text-ink-500">Obligation{o ? ` · ${o.type}` : ''}</p>
            <h2 className="text-section text-ink-950 mt-0.5">{o?.description ?? 'Loading…'}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-paper-100 text-ink-500" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {isLoading && <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-ink-400" /></div>}
          {isError && <p className="text-dense text-risk-700">This obligation couldn't be loaded. It may have been removed.</p>}
          {o && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                {/* As the list does: an open obligation past its date reads as overdue. */}
                <StatusPill status={o.status} meaning={overdueDays(o) ? 'risk' : undefined} />
                {overdueDays(o) ? <span className="text-dense text-risk-700 font-medium">{overdueDays(o)} days overdue</span> : null}
                <span className="text-dense text-ink-500 capitalize">{o.severity} severity</span>
              </div>

              <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-dense">
                <dt className="text-ink-500">Who</dt><dd className="text-ink-950">{PARTY[o.owner] ?? o.owner}</dd>
                <dt className="text-ink-500">Due</dt><dd className="text-ink-950">{date(o.dueDate) ?? (o.trigger ? `When: ${o.trigger}` : 'No date stated')}</dd>
                <dt className="text-ink-500">Repeats</dt><dd className="text-ink-950">{o.recurrence === 'one-time' ? 'Once' : o.recurrence}</dd>
                {o.trigger && o.dueDate && (<><dt className="text-ink-500">Trigger</dt><dd className="text-ink-950">{o.trigger}</dd></>)}
              </dl>

              <div>
                <p className="text-dense font-medium text-ink-700 mb-1.5">From the contract{section ? `, ${section}` : ''}</p>
                <blockquote className="border-l-2 border-paper-300 pl-3 text-dense text-ink-700 italic whitespace-pre-wrap" data-testid="obligation-quote">
                  {o.quote || 'No quote was recorded for this obligation.'}
                </blockquote>
              </div>

              {o.contract && (
                <div className="rounded-md border border-paper-200 p-3">
                  <p className="text-body font-medium text-ink-950">{o.contract.title}</p>
                  <p className="text-dense text-ink-500 mt-0.5">
                    {[o.contract.counterpartyName, o.contract.owner?.name && `Owner: ${o.contract.owner.name}`].filter(Boolean).join(' · ')}
                  </p>
                  <Link
                    to={`/contracts/${o.contract.id}${sectionParam ? `?section=${encodeURIComponent(sectionParam)}` : ''}`}
                    className="mt-2 inline-flex items-center gap-1 text-dense text-ink-700 hover:text-ink-950 underline underline-offset-2"
                    data-testid="obligation-open-contract"
                  >
                    <ExternalLink className="size-3.5" /> Open the contract{section ? ` at ${section}` : ''}
                  </Link>
                </div>
              )}

              {o.status === 'COMPLETED' && (
                <div className="rounded-md border border-brand-200 bg-brand-50 p-3 text-dense text-ink-700 space-y-1">
                  <p className="font-medium text-ink-950">
                    Completed {date(o.completedAt)}{o.completedBy ? ` by ${o.completedBy.name ?? o.completedBy.email}` : ''}
                  </p>
                  {o.completionNote && <p>{o.completionNote}</p>}
                  {o.evidenceFilename && (
                    <button onClick={() => evidence.mutate()} className="inline-flex items-center gap-1 underline underline-offset-2" disabled={evidence.isPending}>
                      <Download className="size-3.5" /> {o.evidenceFilename}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {o && canEdit && (
          <div className="flex gap-2 px-5 py-3 border-t border-paper-200 bg-paper-50">
            {!done && (
              <Button size="sm" onClick={() => setCompleting(true)} data-testid="obligation-drawer-complete">
                <CheckCircle2 /> Mark complete
              </Button>
            )}
            {o.status === 'COMPLETED' && (
              <Button size="sm" variant="outline" onClick={() => reopen.mutate()} disabled={reopen.isPending}>
                {reopen.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reopen
              </Button>
            )}
          </div>
        )}
      </aside>
      {o && (
        <CompleteObligationModal
          obligationId={o.id}
          description={o.description}
          open={completing}
          onClose={() => setCompleting(false)}
          onCompleted={() => { setCompleting(false); refresh() }}
        />
      )}
    </>
  )
}
