/**
 * docs/41 Parts 17 and 20 — connected integrations (Salesforce) on the
 * Integrations → Health tab: how the last day of syncs went, the last
 * failure with a retry, and changes waiting on someone.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { StatusPill } from '@/components/ui/status-pill'
import type { Meaning } from '@/lib/status'

export interface IntegrationHealth {
  provider: string
  status: string
  health: 'healthy' | 'degraded' | 'failing' | 'disabled'
  externalOrgId: string | null
  lastSyncAt: string | null
  lastError: string | null
  syncs24h: { ok: number; failed: number; skipped: number; conflicts: number }
  openConflicts: number
  lastFailure: { id: string; object: string; contractId: string | null; error: string | null; attempt: number; at: string } | null
}

const BADGE: Record<IntegrationHealth['health'], { label: string; meaning: Meaning }> = {
  healthy:  { label: 'Healthy',  meaning: 'binding' },
  degraded: { label: 'Degraded', meaning: 'turn' },
  failing:  { label: 'Failing',  meaning: 'risk' },
  disabled: { label: 'Not set up', meaning: 'neutral' },
}

const NAME: Record<string, string> = { salesforce: 'Salesforce' }

export function IntegrationHealthPanel({ items }: { items: IntegrationHealth[] | undefined }) {
  const qc = useQueryClient()
  const retry = useMutation({
    mutationFn: async (logId: string) => api.post(`/admin/integrations/salesforce/sync-log/${logId}/retry`),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['integrations-health'] }), 8000),
  })
  if (!items?.length) return null
  return (
    <div className="bg-card border border-paper-200 rounded-card overflow-hidden mb-5" data-testid="integration-health">
      <table className="w-full text-[13px]">
        <thead className="bg-paper-50 text-[11px] uppercase tracking-[0.08em] text-ink-500">
          <tr>
            <th className="text-left px-4 py-2 font-semibold">Status</th>
            <th className="text-left px-4 py-2 font-semibold">Integration</th>
            <th className="text-left px-4 py-2 font-semibold">Last sync</th>
            <th className="text-left px-4 py-2 font-semibold">24h</th>
            <th className="text-left px-4 py-2 font-semibold">Last error</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-paper-200">
          {items.map(i => (
            <tr key={i.provider} data-testid={`integration-health-${i.provider}`} data-health={i.health}>
              <td className="px-4 py-2"><StatusPill meaning={BADGE[i.health].meaning}>{BADGE[i.health].label}</StatusPill></td>
              <td className="px-4 py-2">
                <div className="font-medium text-ink-950">{NAME[i.provider] ?? i.provider}</div>
                {i.externalOrgId && <div className="text-[11px] font-mono text-ink-400">{i.externalOrgId}</div>}
              </td>
              <td className="px-4 py-2 text-[11px] text-ink-700 tabular-nums">{i.lastSyncAt ? new Date(i.lastSyncAt).toLocaleString() : 'never'}</td>
              <td className="px-4 py-2 text-[11px] tabular-nums">
                <span className="text-ink-700">{i.syncs24h.ok} synced</span>
                {i.syncs24h.failed > 0 && <span className="text-risk-700"> · {i.syncs24h.failed} failed</span>}
                {i.openConflicts > 0 && <span className="text-attention-700"> · {i.openConflicts} waiting on you</span>}
              </td>
              <td className="px-4 py-2 text-[11px] text-ink-700 max-w-[260px]">
                {i.lastError ?? (i.lastFailure ? <span className="line-clamp-2" title={i.lastFailure.error ?? undefined}>{i.lastFailure.error}</span> : <span className="text-ink-400">—</span>)}
              </td>
              <td className="px-4 py-2 text-right">
                {i.lastFailure?.contractId && (
                  <button
                    onClick={() => retry.mutate(i.lastFailure!.id)}
                    disabled={retry.isPending}
                    data-testid={`integration-retry-${i.provider}`}
                    className="text-dense text-ink-950 hover:text-ink-700 inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <RefreshCw className={`size-3.5 ${retry.isPending ? 'animate-spin' : ''}`} /> Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
