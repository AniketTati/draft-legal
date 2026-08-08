/**
 * ContractMatterPicker (P4.2 / docs/30 D.7.2)
 *
 * Inline matter assignment on the contract detail header. Shows:
 *   • "Add to matter" when no assignment
 *   • The matter name when assigned (click → detail), with an × to unlink
 *   • A dropdown search-picker when the user clicks "Add to matter"
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Briefcase, X, Search } from 'lucide-react'
import { api } from '@/lib/api'

interface MatterLite {
  id: string
  name: string
  status: 'OPEN' | 'CLOSED' | 'ARCHIVED'
  counterpartyName: string | null
  contractCount: number
}

export function ContractMatterPicker({
  contractId,
  currentMatterId,
}: {
  contractId: string
  currentMatterId: string | null
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const { data } = useQuery({
    queryKey: ['matters-picker'],
    queryFn: async () => (await api.get<{ items: MatterLite[]; total: number }>('/matters', {
      params: { status: 'OPEN', limit: 100 },
    })).data,
    enabled: open,
  })

  const currentMatter = useMemo(
    () => (data?.items ?? []).find(m => m.id === currentMatterId),
    [data, currentMatterId],
  )

  const assign = useMutation({
    mutationFn: async (matterId: string | null) => {
      if (matterId) {
        return api.post(`/matters/${matterId}/attach`, { kind: 'contract', entityId: contractId }).then(r => r.data)
      }
      // Unlink — attach to '' isn't supported; use PATCH on contract directly
      return api.patch(`/contracts/${contractId}`, { matterId: null }).then(r => r.data)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] })
      qc.invalidateQueries({ queryKey: ['matter'] })
      qc.invalidateQueries({ queryKey: ['matters-picker'] })
      setOpen(false)
    },
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.items ?? []).filter(m =>
      !q ||
      m.name.toLowerCase().includes(q) ||
      (m.counterpartyName ?? '').toLowerCase().includes(q)
    )
  }, [data, search])

  // If the current matter wasn't in the OPEN list (CLOSED or archived),
  // fetch it on-demand.
  const { data: onePick } = useQuery({
    queryKey: ['matter-one', currentMatterId],
    enabled: !!currentMatterId && !currentMatter,
    queryFn: async () => (await api.get<MatterLite & { id: string }>(`/matters/${currentMatterId}`)).data,
  })
  const effectiveCurrent = currentMatter ?? onePick

  if (effectiveCurrent) {
    return (
      // A matter is a human filing cabinet, not machine output — the indigo it
      // used to wear belongs to the assistant, so this is a plain neutral chip.
      <span className="inline-flex items-center gap-1 rounded-full border border-paper-200 bg-paper-100 px-2 py-0.5 text-[10.5px] font-medium text-ink-950"
            data-testid="contract-matter-badge"
            data-matter-id={effectiveCurrent.id}>
        <Briefcase className="size-3" />
        <Link to={`/matters/${effectiveCurrent.id}`} className="hover:underline truncate max-w-[180px]">
          {effectiveCurrent.name}
        </Link>
        <button
          type="button"
          onClick={() => assign.mutate(null)}
          title="Unlink from matter"
          data-testid="contract-matter-unlink"
          className="hover:bg-paper-200 rounded-full p-0.5"
        >
          <X className="size-2.5" />
        </button>
      </span>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="contract-matter-add-btn"
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-paper-300 px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-ink-950 hover:border-ink-400"
      >
        <Briefcase className="size-3" /> Add to matter
      </button>
    )
  }

  return (
    <div className="relative">
      <div
        data-testid="contract-matter-picker"
        className="absolute top-6 left-0 z-20 w-80 rounded-card border border-border bg-card shadow-e2"
      >
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2 top-2 size-3 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search open matters…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
              className="w-full pl-7 pr-2 py-1 text-[12px] rounded-md border border-input bg-card placeholder:text-ink-400 focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/12"
              data-testid="contract-matter-picker-search"
            />
          </div>
        </div>
        <ul className="max-h-72 overflow-y-auto divide-y divide-border">
          {filtered.length === 0 && (
            <li className="px-3 py-3 text-[11.5px] text-muted-foreground italic">
              No matching open matters. <Link to="/matters" className="underline">Create one.</Link>
            </li>
          )}
          {filtered.map(m => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => assign.mutate(m.id)}
                data-testid={`contract-matter-pick-${m.id}`}
                className="w-full text-left px-3 py-1.5 hover:bg-paper-100 flex items-baseline gap-2"
              >
                <Briefcase className="size-3 text-ink-400 flex-shrink-0" />
                <span className="font-medium text-[12px] text-ink-950 truncate">{m.name}</span>
                {m.counterpartyName && <span className="text-[10.5px] text-muted-foreground truncate">· {m.counterpartyName}</span>}
                <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{m.contractCount}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="px-2 py-1.5 border-t border-border flex items-center justify-between text-[10.5px]">
          <Link to="/matters" className="text-ink-950 hover:underline" onClick={() => setOpen(false)}>
            + New matter
          </Link>
          <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-ink-950">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
