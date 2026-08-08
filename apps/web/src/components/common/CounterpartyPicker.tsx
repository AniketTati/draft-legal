/**
 * CounterpartyPicker (P7.4.14 / F-56)
 *
 * Typeahead for picking an existing counterparty + the option to
 * create a new one inline. Replaces the plain text input that the
 * audit flagged as a duplicate-counterparty risk.
 *
 * Behavior:
 *   - Mounts with current value (if set).
 *   - On focus / type → fetches /counterparties?q=… and shows matches.
 *   - Click match → fires onChange({ id, name }) and collapses dropdown.
 *   - If no match for typed text → shows "Create new counterparty 'X'"
 *     button at the bottom; clicking it POSTs and selects the new row.
 *   - Free text typing without selection still updates `name` (the
 *     parent can store a name even without an id, for backward compat
 *     with endpoints that accept counterpartyName as freetext).
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Check, Plus, Building2, Loader2, X } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface Counterparty {
  id: string
  name: string
  legalName?: string | null
  contractCount?: number
}

export interface CounterpartySelection {
  id: string | null
  name: string
}

export function CounterpartyPicker({
  value,
  onChange,
  placeholder = 'Search counterparty…',
  testIdPrefix = 'cp-picker',
}: {
  value: CounterpartySelection
  onChange: (sel: CounterpartySelection) => void
  placeholder?: string
  testIdPrefix?: string
}) {
  const [query, setQuery] = useState(value.name ?? '')
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Sync external value → input when it changes
  useEffect(() => { setQuery(value.name ?? '') }, [value.name])

  // Click-outside handler to close the dropdown
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const { data, isFetching } = useQuery({
    queryKey: ['cp-picker', query],
    queryFn: () => api.get('/counterparties', {
      params: { q: query || undefined, limit: 8 },
    }).then(r => r.data),
    staleTime: 10_000,
  })

  const matches: Counterparty[] = data?.data ?? []
  const trimmed = query.trim()
  // Show the "create new" affordance only when the user has typed
  // something that doesn't exactly match an existing row (case-insens).
  const exactMatch = matches.find(c => c.name.toLowerCase() === trimmed.toLowerCase())
  const showCreate = trimmed.length >= 2 && !exactMatch

  const create = useMutation({
    mutationFn: () => api.post('/counterparties', { name: trimmed }).then(r => r.data),
    onSuccess: (cp: Counterparty) => {
      onChange({ id: cp.id, name: cp.name })
      setQuery(cp.name)
      setOpen(false)
    },
  })

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Building2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-400 pointer-events-none" />
        <Input
          type="text"
          value={query}
          onChange={(e) => {
            const v = e.target.value
            setQuery(v)
            setOpen(true)
            // Updating name without id keeps backward-compat — parent
            // sees a real-time name even before user picks from list.
            onChange({ id: null, name: v })
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          data-testid={`${testIdPrefix}-input`}
          className="pl-8 pr-8"
        />
        {value.id && (
          // Resolved to a real counterparty row — a verified link, so brand.
          <span
            title="Linked to counterparty"
            data-testid={`${testIdPrefix}-linked`}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-brand-700"
          >
            <Check className="size-3.5" />
          </span>
        )}
        {!value.id && query && (
          <button
            type="button"
            onClick={() => { setQuery(''); onChange({ id: null, name: '' }); setOpen(false) }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
            data-testid={`${testIdPrefix}-clear`}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {open && (matches.length > 0 || showCreate) && (
        <div
          data-testid={`${testIdPrefix}-dropdown`}
          className="absolute z-30 left-0 right-0 mt-1 bg-card border border-paper-200 rounded-md shadow-e2 max-h-72 overflow-y-auto"
        >
          {isFetching && matches.length === 0 && (
            <div className="px-3 py-2 text-dense text-ink-400 inline-flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" /> Searching…
            </div>
          )}
          {matches.map(cp => (
            <button
              key={cp.id}
              type="button"
              onClick={() => {
                onChange({ id: cp.id, name: cp.name })
                setQuery(cp.name)
                setOpen(false)
              }}
              data-testid={`${testIdPrefix}-option-${cp.id}`}
              className="w-full px-3 py-2 text-left hover:bg-paper-100 flex items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink-950 truncate">{cp.name}</div>
                {cp.legalName && cp.legalName !== cp.name && (
                  <div className="text-[10.5px] text-ink-400 truncate">{cp.legalName}</div>
                )}
              </div>
              {(cp.contractCount ?? 0) > 0 && (
                <span className="text-[10.5px] text-ink-400 tabular-nums shrink-0">
                  {cp.contractCount} {cp.contractCount === 1 ? 'contract' : 'contracts'}
                </span>
              )}
            </button>
          ))}
          {showCreate && (
            // Creating a counterparty is an action, not a binding state, so it
            // reads as ink rather than keeping the old emerald.
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={create.isPending}
              data-testid={`${testIdPrefix}-create`}
              className="w-full px-3 py-2 text-left border-t border-paper-200 hover:bg-paper-100 inline-flex items-center gap-2 text-dense text-ink-950 font-medium disabled:opacity-50"
            >
              {create.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3.5" />}
              Create new counterparty <span className="font-semibold">"{trimmed}"</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
