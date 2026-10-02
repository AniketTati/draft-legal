/**
 * docs/41 P1 (Part 11) — Analysis health.
 *
 * Every analysis of a contract version is a run of steps (reading the
 * document, its clauses, the checks, the position check). This page lists
 * the runs that failed, or stopped moving, grouped by the step they stopped
 * at, with a Retry for each. A failure used to show only as "Failed" on one
 * contract, or not at all.
 *
 * Lives at /admin/analysis.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Activity, AlertCircle, Loader2, RefreshCw } from 'lucide-react'

interface RunRow {
  id: string
  contractId: string
  contractTitle: string
  versionNumber: number | null
  reason: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'superseded'
  failedStepLabel: string | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  stuck: boolean
  current: boolean
  runningStep: { label: string; index: number; of: number } | null
}

interface Health {
  days: number
  totals: { done: number; failed: number; running: number; stuck: number }
  groups: Array<{ step: string; label: string; count: number; runs: RunRow[] }>
}

const REASON: Record<string, string> = {
  generated: 'drafted', uploaded: 'uploaded', added: 'version added', checkpoint: 'edited',
  backfill: 'catch-up', retry: 'retried', unknown: '—',
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

export function AdminAnalysisHealthPage() {
  const [filter, setFilter] = useState<'problems' | 'failed' | 'stuck'>('problems')
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['analysis-health', filter],
    queryFn: () => api.get<Health>('/admin/analysis/runs', { params: { status: filter } }).then(r => r.data),
    refetchInterval: 30_000,
  })
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/admin/analysis/runs/${id}/retry`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analysis-health'] }),
  })
  const data = q.data

  return (
    <div className="px-6 py-5 max-w-5xl mx-auto" data-testid="admin-analysis-health-page">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-title text-ink-950 flex items-center gap-2">
            <Activity className="size-4 text-ink-700" />
            Analysis health
          </h1>
          <p className="text-dense text-ink-500 mt-1">
            Contract analyses that failed or stopped moving in the last {data?.days ?? 14} days, grouped by the step they stopped at.
          </p>
        </div>
        <select
          value={filter}
          onChange={e => setFilter(e.target.value as typeof filter)}
          className="text-[13px] rounded-md border border-input bg-card px-2 py-1.5"
          data-testid="analysis-health-filter"
        >
          <option value="problems">Failed and stuck</option>
          <option value="failed">Failed</option>
          <option value="stuck">Stuck</option>
        </select>
      </div>

      {data && (
        <div className="grid grid-cols-4 gap-2 mb-5" data-testid="analysis-health-totals">
          {([['Finished', data.totals.done], ['Failed', data.totals.failed], ['Stuck', data.totals.stuck], ['Running now', data.totals.running]] as const).map(([label, n]) => (
            <div key={label} className="border border-border rounded-md bg-card px-3 py-2">
              <div className="text-[11px] text-ink-500">{label}</div>
              <div className="text-[18px] text-ink-950 tabular-nums">{n}</div>
            </div>
          ))}
        </div>
      )}

      {q.isLoading && <p className="text-dense text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading…</p>}
      {q.isError && <p className="text-dense text-risk-700 flex items-center gap-2"><AlertCircle className="size-4" /> Analysis health could not be loaded.</p>}
      {data && data.groups.length === 0 && (
        <p className="text-dense text-ink-500" data-testid="analysis-health-empty">No analysis failed or got stuck in this period.</p>
      )}
      {retry.isError && (
        <p className="text-dense text-risk-700 mb-3">The retry could not be started: {(retry.error as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'try again'}.</p>
      )}

      {data?.groups.map(g => (
        <section key={g.step} className="mb-5" data-testid={`analysis-health-group-${g.step}`}>
          <h2 className="text-[13px] font-medium text-ink-950 mb-1.5">
            Stopped while {g.label} <span className="text-ink-500 tabular-nums">({g.count})</span>
          </h2>
          <ul className="border border-border rounded-md divide-y divide-border bg-card">
            {g.runs.map(r => (
              <li key={r.id} className="px-3 py-2 flex items-start gap-3 text-dense">
                <div className="flex-1 min-w-0">
                  <Link to={`/contracts/${r.contractId}`} className="text-ink-950 hover:underline font-medium">{r.contractTitle}</Link>
                  <span className="text-ink-500"> · v{r.versionNumber ?? '?'} · {REASON[r.reason] ?? r.reason} · started {ago(r.startedAt)}</span>
                  <div className="text-[12px] mt-0.5 text-ink-700">
                    {r.status === 'failed'
                      ? <span className="text-risk-700">{r.error ?? 'Failed without a message.'}</span>
                      : <span>No progress for a while{r.runningStep ? ` — step ${r.runningStep.index} of ${r.runningStep.of}, ${r.runningStep.label}` : ''}.</span>}
                  </div>
                  {!r.current && <div className="text-[11px] text-ink-500 mt-0.5">The contract has a newer version; a retry analyses that one.</div>}
                </div>
                <Button
                  size="sm" variant="outline" className="gap-1 shrink-0"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(r.id)}
                  data-testid={`analysis-health-retry-${r.id}`}
                >
                  <RefreshCw className="size-3.5" /> Retry
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
