/**
 * FieldPicker (docs/39 C2) — "Set as field value": the fields a highlighted
 * passage could fill, best first, then the value it gives the one picked,
 * cleaned and typed ("thirty (30) days' notice" → 30 days), to check and save.
 *
 * The value is saved as picked from the text: the passage is its evidence,
 * "Show in document" finds it again, and a re-analysis leaves it alone.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { rankFields, matchField, type FieldMatch } from '@/lib/field-match'
import { useOrgDateOrder } from '@/lib/org-date-order'
import { toast } from '@/components/common/Toaster'
import { FieldEditor, errorDetail, hasValue, type ContractField, type FieldsResponse } from './FieldsPanel'
import type { TextSelection } from './SelectionMenu'

const WIDTH = 340
const BEST = 6
/** Below this a match is a guess: shown only when nothing fits better. */
const WEAK = 1

/** A value as the field shows it: a number with its unit ("30 days"). */
const shown = (m: FieldMatch<ContractField>) =>
  m.display && m.field.unit && typeof m.value === 'number' ? `${m.display} ${m.field.unit}` : m.display

export function FieldPicker({ contractId, selection, onClose, onSaved }: {
  contractId: string
  selection: TextSelection
  onClose: () => void
  /** After the value is saved: the page highlights the passage it came from. */
  onSaved?: (field: ContractField) => void
}) {
  const qc = useQueryClient()
  const queryKey = ['contract-fields', contractId]
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<FieldsResponse>(`/contracts/${contractId}/fields`)).data,
  })
  const fields = useMemo(() => data?.fields ?? [], [data])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [chosen, setChosen] = useState<FieldMatch<ContractField> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const dateOrder = useOrgDateOrder()
  const ranked = useMemo(() => rankFields(fields, selection.text, { dateOrder }), [fields, selection.text, dateOrder])
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      const strong = ranked.filter(m => m.score >= WEAK)
      return (strong.length ? strong : ranked).slice(0, strong.length ? BEST : 3)
    }
    return fields
      .filter(f => !f.legacy && (f.label.toLowerCase().includes(q) || (data?.groups[f.group] ?? '').toLowerCase().includes(q)))
      .map(f => ranked.find(m => m.field.key === f.key) ?? matchField(f, selection.text, { dateOrder }))
  }, [query, ranked, fields, data?.groups, selection.text, dateOrder])
  useEffect(() => setActive(0), [query])

  // Closes on Escape and on a click outside it. The click listener waits a
  // tick: the mouse-down that opened the picker is still on its way up.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const down = (e: MouseEvent) => { if (panelRef.current && !panelRef.current.contains(e.target as Node)) closeRef.current() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !chosen) closeRef.current() }
    const t = setTimeout(() => document.addEventListener('mousedown', down), 0)
    window.addEventListener('keydown', esc)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); window.removeEventListener('keydown', esc) }
  }, [chosen])

  const save = useMutation({
    mutationFn: async (a: { key: string; value: unknown }) => (await api.put(
      `/contracts/${contractId}/fields/${encodeURIComponent(a.key)}`,
      { value: a.value, source: 'highlight', quote: selection.text, anchor: { occurrence: selection.occurrence } },
    )).data as { field: ContractField; statusChange?: { from: string; to: string } },
    onSuccess: r => {
      qc.invalidateQueries({ queryKey })
      qc.invalidateQueries({ queryKey: ['contract', contractId] })
      qc.invalidateQueries({ queryKey: ['review-queue'] })
      toast.success(`Saved as the ${r.field.label.toLowerCase()}`, {
        description: r.statusChange ? `The contract went back to ${r.statusChange.to.toLowerCase()} for re-approval.` : r.field.display,
      })
      onSaved?.(r.field)
      onClose()
    },
    onError: err => toast.error("Couldn't save", { description: errorDetail(err) }),
  })

  // Below the selection when it fits, else above it.
  const height = chosen ? 250 : 380
  const below = selection.rect.bottom + 8 + height < window.innerHeight
  const top = below ? selection.rect.bottom + 8 : Math.max(8, selection.rect.top - 8 - height)
  const left = Math.min(Math.max(selection.rect.left, 16), window.innerWidth - WIDTH - 16)

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, list.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && list[active]) { e.preventDefault(); setChosen(list[active]) }
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Set as field value"
      data-testid="field-picker"
      className="fixed z-50 rounded-lg border border-paper-200 bg-popover shadow-e3 overflow-hidden"
      style={{ top, left, width: WIDTH }}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-paper-100">
        {chosen && (
          <button type="button" className="mt-0.5 p-0.5 rounded-sm text-ink-500 hover:text-ink-950 hover:bg-paper-100" onClick={() => setChosen(null)} aria-label="Back to the fields">
            <ArrowLeft className="size-3.5" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">{chosen ? chosen.field.label : 'Set as field value'}</p>
          <p className="mt-0.5 text-[12px] italic text-ink-700 line-clamp-2" title={selection.text}>“{selection.text}”</p>
        </div>
        <button type="button" className="p-0.5 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" onClick={onClose} aria-label="Close">
          <X className="size-3.5" />
        </button>
      </div>

      {chosen ? (
        <div className="px-3 py-3 space-y-2">
          {hasValue(chosen.field) && (
            <p className="text-[11.5px] text-ink-500">
              Now <span className="font-medium text-ink-950">{chosen.field.display}</span>
              {chosen.field.locked && chosen.field.source !== 'ai' ? ', set by a person.' : '.'} Saving replaces it.
            </p>
          )}
          <FieldEditor
            // The editor starts from the passage's value, not the field's current one.
            f={{ ...chosen.field, value: chosen.value }}
            saving={save.isPending}
            onSave={value => save.mutate({ key: chosen.field.key, value })}
            onCancel={() => setChosen(null)}
          />
        </div>
      ) : (
        <>
          <div className="relative px-3 pt-2.5">
            <Search className="absolute left-5 top-[19px] size-3.5 text-ink-400" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={keys}
              placeholder="Search fields"
              aria-label="Search fields"
              className="w-full h-8 rounded-md border border-input bg-card pl-7 pr-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ink-950"
              data-testid="field-picker-search"
            />
          </div>
          <p className="px-3 pt-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">
            {query.trim() ? 'Fields' : 'Best matches'}
          </p>
          <div className="max-h-[248px] overflow-y-auto pb-1.5" role="listbox" aria-label="Fields">
            {isLoading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-dense text-ink-500"><Loader2 className="size-3.5 animate-spin" /> Loading fields…</div>
            ) : list.length === 0 ? (
              <p className="px-3 py-3 text-dense text-ink-500">
                {query.trim() ? 'No field by that name.' : 'No field reads these words as its value. Search for one to type it in.'}
              </p>
            ) : list.map((m, i) => (
              <button
                key={m.field.key}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => setChosen(m)}
                className={cn('w-full flex items-center gap-3 px-3 py-1.5 text-left', i === active ? 'bg-paper-100' : 'hover:bg-paper-50')}
                data-testid={`field-picker-option-${m.field.key}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium text-ink-950 truncate">{m.field.label}</span>
                  <span className="block text-[10.5px] text-ink-400 truncate">
                    {data?.groups[m.field.group] ?? m.field.group}{hasValue(m.field) ? ` · now ${m.field.display}` : ''}
                  </span>
                </span>
                <span className={cn('shrink-0 max-w-[45%] truncate text-[12px]', m.display ? 'text-ink-700' : 'text-ink-400 italic')}>
                  {shown(m) ?? `not a ${m.field.type === 'longtext' ? 'text' : m.field.type}`}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
