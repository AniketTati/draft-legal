/**
 * docs/41 fix-up 4 — Salesforce changes held back on this contract. When the
 * deal changes in Salesforce after the contract went out for signature (or was
 * signed), the sync leaves the contract as it is and records a conflict. The
 * owner sees each one here, with the old and new value, and either updates the
 * contract or keeps it. Renders nothing when there are none.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import { RailSection } from '@/components/contracts/RailSection'

export interface ContractConflict {
  id: string
  label: string
  currentValue: unknown
  incomingValue: unknown
  createdAt: string
}

/** A value as a person reads it: numbers (and numeric text) grouped, nothing as "empty". */
export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v).toLocaleString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function SalesforceConflictsSection({ contractId, canEdit }: { contractId: string; canEdit: boolean }) {
  const qc = useQueryClient()
  const queryKey = ['integration-conflicts', contractId]
  const { data } = useQuery<{ data: ContractConflict[] }>({
    queryKey,
    queryFn: () => api.get(`/contracts/${contractId}/integration-conflicts`).then(r => r.data),
  })
  const resolve = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'apply' | 'dismiss' }) =>
      api.post(`/contracts/${contractId}/integration-conflicts/${id}/resolve`, { action }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey })
      if (v.action === 'apply') {
        qc.invalidateQueries({ queryKey: ['contract', contractId] })
        qc.invalidateQueries({ queryKey: ['contract-fields', contractId] })
      }
      toast.success(v.action === 'apply' ? 'Contract updated from Salesforce' : 'Kept the contract as it is')
    },
    onError: e => toast.error('Not saved', { description: apiErrorMessage(e) }),
  })
  const items = data?.data ?? []
  if (!items.length) return null
  return (
    <RailSection title="Salesforce changes" count={items.length} defaultOpen>
      <p className="text-dense text-ink-500 mb-2">
        The deal changed in Salesforce after this contract went out, so the contract was left as it is.
      </p>
      <ul className="space-y-2" data-testid="salesforce-conflicts">
        {items.map(k => (
          <li key={k.id} className="rounded-card border border-paper-200 bg-paper-50 px-3 py-2" data-testid={`salesforce-conflict-${k.id}`}>
            <div className="flex items-start gap-2">
              <RefreshCw className="size-3.5 text-ink-400 mt-0.5 shrink-0" aria-hidden />
              <p className="text-dense text-ink-950">
                Salesforce changed {k.label.toLowerCase()} <span className="tabular-nums">{showValue(k.currentValue)} → {showValue(k.incomingValue)}</span>
              </p>
            </div>
            {canEdit && (
              <div className="flex gap-2 mt-2 pl-5">
                <Button size="xs" onClick={() => resolve.mutate({ id: k.id, action: 'apply' })} disabled={resolve.isPending}>Apply</Button>
                <Button size="xs" variant="ghost" onClick={() => resolve.mutate({ id: k.id, action: 'dismiss' })} disabled={resolve.isPending}>Dismiss</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </RailSection>
  )
}
