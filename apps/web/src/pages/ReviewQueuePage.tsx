/**
 * ReviewQueuePage (P2.5 / Wave F.5)
 *
 * Legal's "low-confidence extractions need your eyes" queue. Shows
 * every AI-extracted field across the org whose confidence is below
 * the threshold. One click verifies (confidence → 1.0) or rejects
 * (confidence → 0 + value cleared).
 *
 * Design reference:
 *   - Hebbia review queue (table + bulk actions)
 *   - Ironclad confidence badges
 *   - Harvey one-click verify/reject
 */
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/primitives'
import { AssistMark } from '@/components/ui/assist'
import {
  AlertTriangle, CheckCircle2, XCircle, ExternalLink, ShieldCheck,
  Search,
} from 'lucide-react'

interface QueueItem {
  contractId:    string
  contractTitle: string
  contractType:  string
  contractStatus: string
  field:         string
  fieldLabel:    string
  value:         string | number | null
  quote:         string | null
  section:       string | null
  confidence:    number
  updatedAt:     string
}

const THRESHOLDS = [
  { value: 0.9, label: 'High bar (<0.9)' },
  { value: 0.7, label: 'Legal bar (<0.7)' },
  { value: 0.5, label: 'Risky only (<0.5)' },
]

export function ReviewQueuePage() {
  const qc = useQueryClient()
  const [threshold, setThreshold] = useState(0.7)
  const [search, setSearch] = useState('')

  const queryKey = ['review-queue', threshold]
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<{ items: QueueItem[]; total: number; threshold: number }>(
      '/review-queue', { params: { threshold } },
    )).data,
  })

  const verify = useMutation({
    mutationFn: (p: { contractId: string; field: string }) =>
      api.post(`/review-queue/${p.contractId}/verify`, { field: p.field }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['review-queue'] }),
  })
  const reject = useMutation({
    mutationFn: (p: { contractId: string; field: string }) =>
      api.post(`/review-queue/${p.contractId}/reject`, { field: p.field }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['review-queue'] }),
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.items ?? []).filter(it => {
      if (!q) return true
      return (
        it.contractTitle.toLowerCase().includes(q) ||
        it.fieldLabel.toLowerCase().includes(q) ||
        String(it.value ?? '').toLowerCase().includes(q) ||
        (it.quote ?? '').toLowerCase().includes(q)
      )
    })
  }, [data, search])

  const byContract = useMemo(() => {
    const map = new Map<string, { title: string; items: QueueItem[] }>()
    for (const it of filtered) {
      const cur = map.get(it.contractId) ?? { title: it.contractTitle, items: [] }
      cur.items.push(it)
      map.set(it.contractId, cur)
    }
    return [...map.entries()]
  }, [filtered])

  return (
    <div className="px-6 py-5 max-w-6xl mx-auto" data-testid="review-queue-page">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-title text-ink-950 flex items-center gap-2">
            <ShieldCheck className="size-4 text-ink-400" />
            Extraction Queue
          </h1>
          <p className="text-dense text-ink-500 mt-1">
            AI-extracted fields below the confidence threshold. Verify (keep the value),
            correct (set a new value), or reject (clear the value) — each contract stops
            carrying a silent low-confidence extraction.
          </p>
        </div>
        <div className="text-[11px] text-ink-400 tabular-nums">
          {data ? `${data.total} items · threshold ${(data.threshold * 100).toFixed(0)}%` : ''}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2 size-3.5 text-ink-400" />
          <Input
            type="text"
            placeholder="Filter by contract, field, value or quote…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            data-testid="review-queue-search"
            className="pl-8"
          />
        </div>
        <select
          value={threshold}
          onChange={e => setThreshold(Number(e.target.value))}
          data-testid="review-queue-threshold"
          className="h-8 text-[13px] text-ink-950 rounded-md border border-input bg-card px-2 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
        >
          {THRESHOLDS.map(t =>
            <option key={t.value} value={t.value}>{t.label}</option>
          )}
        </select>
      </div>

      {isLoading && <div className="text-body text-ink-500 py-6">Loading…</div>}
      {error && (
        <div className="flex items-center gap-2 text-body text-risk-700 bg-risk-50 border border-risk-200 rounded-md p-3">
          <AlertTriangle className="size-4" /> Failed to load the queue.
        </div>
      )}
      {filtered.length === 0 && !isLoading && (
        <EmptyState
          icon={<ShieldCheck />}
          title="Nothing to review at this threshold."
          description="Try widening it to surface more."
        />
      )}

      <div className="space-y-3">
        {byContract.map(([contractId, group]) => (
          <div
            key={contractId}
            data-testid={`review-queue-contract-${contractId}`}
            className="border border-paper-200 rounded-card bg-card overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-paper-200 bg-paper-50">
              <div className="min-w-0 flex items-baseline gap-2">
                <Link
                  to={`/contracts/${contractId}`}
                  className="font-medium text-[13px] text-ink-950 hover:underline underline-offset-2 decoration-paper-300 truncate"
                >
                  {group.title}
                </Link>
                <span className="text-[10.5px] uppercase tracking-[0.08em] text-ink-400 font-mono">
                  {group.items[0].contractType}
                </span>
                <span className="text-[10.5px] tabular-nums text-ink-500">
                  {group.items.length} flagged field{group.items.length === 1 ? '' : 's'}
                </span>
              </div>
              <Link
                to={`/contracts/${contractId}`}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-950 hover:underline underline-offset-2"
              >
                <ExternalLink className="size-3" /> Open contract
              </Link>
            </div>
            <div className="divide-y divide-paper-200">
              {group.items.map(it => (
                <div
                  key={`${it.contractId}::${it.field}`}
                  data-testid={`review-queue-row-${it.contractId}-${it.field}`}
                  className="px-4 py-2 flex items-start gap-3"
                >
                  <div className="min-w-[140px] flex-shrink-0">
                    <div className="text-[11px] font-medium text-ink-950">{it.fieldLabel}</div>
                    <div className="text-[10.5px] text-ink-400 font-mono">{it.field}</div>
                  </div>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="text-dense text-ink-950 truncate">
                      {it.value != null && it.value !== ''
                        ? String(it.value)
                        : <em className="text-ink-400">(empty)</em>}
                    </div>
                    {it.quote && (
                      <div className="text-[10.5px] text-ink-500 italic truncate"
                           title={it.quote}>
                        “{it.quote}”
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {/* Every value on this page was written by the model, so the
                        confidence reading is an assist mark, not a risk badge —
                        the mark goes hollow as the model gets less sure. */}
                    <span
                      className="inline-flex items-center gap-1.5 text-[10.5px] font-mono tabular-nums rounded-chip px-1.5 py-0.5 bg-assist-50 text-assist-700 border border-assist-200"
                      title={`Extractor confidence: ${(it.confidence * 100).toFixed(0)}%`}
                    >
                      <AssistMark confidence={it.confidence < 0.5 ? 'low' : it.confidence < 0.7 ? 'medium' : 'high'} />
                      {(it.confidence * 100).toFixed(0)}%
                    </span>
                    <Button
                      size="xs"
                      variant="danger"
                      onClick={() => reject.mutate({ contractId: it.contractId, field: it.field })}
                      disabled={reject.isPending}
                      data-testid={`review-queue-reject-${it.field}`}
                    >
                      <XCircle />
                      Reject
                    </Button>
                    {/* Verifying an extracted value makes it authoritative, so
                        the action is tinted brand — but outlined, not filled.
                        This is a bulk queue: a filled emerald button repeated
                        down fourteen rows is the opposite of "the brand color,
                        spent sparingly", and it would outweigh the Reject
                        beside it. Both row actions stay outlined and equal;
                        the fill is saved for single-decision surfaces. */}
                    <Button
                      size="xs"
                      variant="outline"
                      className="text-brand-700 border-brand-200 hover:bg-brand-50"
                      onClick={() => verify.mutate({ contractId: it.contractId, field: it.field })}
                      disabled={verify.isPending}
                      data-testid={`review-queue-verify-${it.field}`}
                    >
                      <CheckCircle2 />
                      Verify
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
