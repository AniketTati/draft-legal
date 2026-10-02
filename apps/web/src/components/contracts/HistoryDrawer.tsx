/**
 * HistoryDrawer — docs/41 Part 12: one timeline of everything that happened
 * to the contract, read-only, filterable.
 *
 * It replaces the Activity, Versions and Approval tabs, the rail's History
 * and Activity sections and the Overview's version list, which showed the
 * same events five ways and still missed approval decisions and their
 * reasons. GET /contracts/:id/history merges stage moves, versions (with the
 * one before, to compare), approvals with reasons, exceptions, signatures,
 * comments resolved, assistant actions applied or undone and Salesforce
 * syncs; each event once.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, GitCompare, Loader2, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { approvalKeys, serverMessage } from '@/lib/approval-keys'
import { Button } from '@/components/ui/button'

type Filter = 'all' | 'negotiation' | 'approvals' | 'signatures' | 'system'

export interface HistoryItem {
  id: string
  at: string
  group: Exclude<Filter, 'all'>
  kind: string
  title: string
  detail?: string | null
  actor: { id: string | null; name: string | null } | null
  version?: { id: string; number: number; previousId: string | null; previousNumber: number | null; fromCounterparty: boolean }
}

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'negotiation', label: 'Negotiation' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'signatures', label: 'Signatures' },
  { id: 'system', label: 'System' },
]

const DOT: Record<HistoryItem['group'], string> = {
  negotiation: 'bg-info-600',
  approvals: 'bg-attention-600',
  signatures: 'bg-brand-700',
  system: 'bg-ink-350',
}

/** "Today", "Yesterday", "3 Oct 2026": the day an event belongs to. */
function dayOf(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function HistoryDrawer({ contractId, open, onClose, onCompare, onDownload }: {
  contractId: string
  open: boolean
  onClose: () => void
  /** Compare a version with the one before it. */
  onCompare?: (previousId: string, versionId: string) => void
  /** Download a version's file. */
  onDownload?: (versionId: string) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const { data, isLoading, isError, error } = useQuery<{ data: HistoryItem[]; counts: Record<Filter, number> }>({
    queryKey: approvalKeys.history(contractId, filter),
    queryFn: () => api.get(`/contracts/${contractId}/history`, { params: { filter } }).then(r => r.data),
    enabled: open,
    staleTime: 10_000,
  })
  if (!open) return null
  const items = data?.data ?? []
  let lastDay = ''

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="History" data-testid="history-drawer">
      <div className="absolute inset-0 bg-ink-950/20" onClick={onClose} aria-hidden />
      <aside className="relative w-full max-w-md h-full bg-card border-l border-paper-200 shadow-e3 flex flex-col">
        <header className="px-5 py-4 border-b border-paper-200 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-section text-ink-950">History</h2>
            <p className="text-dense text-ink-500 mt-0.5">Everything that happened to this contract, newest first.</p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close history"><X /></Button>
        </header>
        <div className="px-5 py-2 border-b border-paper-200 flex flex-wrap gap-1" role="tablist">
          {FILTERS.map(f => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn('px-2.5 py-1 rounded-md text-dense font-medium transition-colors', filter === f.id ? 'bg-ink-950 text-white' : 'text-ink-500 hover:text-ink-950 hover:bg-paper-100')}
              data-testid={`history-filter-${f.id}`}
            >
              {f.label}{data?.counts?.[f.id] != null && <span className="ml-1 tabular-nums opacity-70">{data.counts[f.id]}</span>}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-ink-400" /></div>
          ) : isError ? (
            <p role="alert" className="text-dense text-risk-700">{serverMessage(error, 'The history could not be loaded.')}</p>
          ) : items.length === 0 ? (
            <p className="text-dense text-ink-400 italic py-8 text-center">Nothing here yet.</p>
          ) : (
            <ol className="space-y-3" data-testid="history-list">
              {items.map(it => {
                const day = dayOf(it.at)
                const header = day !== lastDay ? (lastDay = day) : null
                return (
                  <li key={it.id} data-kind={it.kind}>
                    {header && <div className="text-eyebrow uppercase text-ink-400 mb-2 mt-1">{header}</div>}
                    <div className="flex gap-2.5">
                      <span className={cn('mt-1.5 size-1.5 rounded-full shrink-0', DOT[it.group])} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="text-dense text-ink-950">{it.title}</div>
                        {it.detail && <div className="text-dense text-ink-700 mt-0.5 break-words">“{it.detail}”</div>}
                        <div className="text-[11px] text-ink-400 mt-0.5 flex items-center gap-2">
                          <span className="tabular-nums">{new Date(it.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                          {it.version?.previousId && onCompare && (
                            <button
                              onClick={() => { onCompare(it.version!.previousId!, it.version!.id); onClose() }}
                              className="inline-flex items-center gap-1 font-medium text-ink-700 hover:text-ink-950 hover:underline"
                              data-testid={`history-compare-${it.version.number}`}
                            >
                              <GitCompare className="size-3" />Compare with v{it.version.previousNumber}
                            </button>
                          )}
                          {it.version && onDownload && (
                            <button onClick={() => onDownload(it.version!.id)} className="inline-flex items-center gap-1 font-medium text-ink-700 hover:text-ink-950 hover:underline">
                              <Download className="size-3" />Download v{it.version.number}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </aside>
    </div>
  )
}
