/**
 * ColumnPicker (docs/39 D3) — which field values the contracts list shows
 * beside each contract. Any field the org's contracts can hold: the standard
 * ones, each contract type's own, the org's. Shown in the order picked.
 */
import { useRef, useState } from 'react'
import { Columns3, Search } from 'lucide-react'
import type { CatalogField } from '@clm/types'
import { Popover } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { CountBadge } from '@/components/ui/primitives'
import { catalogSections, typesOf } from '@/lib/field-catalog'

/** The list always shows these; offering them again would only duplicate a column. */
const ALWAYS_SHOWN = new Set(['counterpartyName', 'expiryDate'])
export const MAX_COLUMNS = 12

export function ColumnPicker({ catalog, columns, onChange }: { catalog: CatalogField[]; columns: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const anchorRef = useRef<HTMLButtonElement>(null)
  const sections = catalogSections(catalog.filter(f => !ALWAYS_SHOWN.has(f.key)), search)
  const full = columns.length >= MAX_COLUMNS
  const toggle = (key: string) => onChange(columns.includes(key) ? columns.filter(k => k !== key) : full ? columns : [...columns, key])
  return (
    <>
      <Button ref={anchorRef} variant="outline" size="sm" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className={`gap-1.5 ${columns.length ? 'border-ink-950 text-ink-950' : ''}`} data-testid="column-picker">
        <Columns3 className="size-4" /> Columns
        {columns.length > 0 && <CountBadge tone="ink" className="h-4 min-w-4 px-1 text-[10px]">{columns.length}</CountBadge>}
      </Button>
      <Popover open={open} onClose={() => { setOpen(false); setSearch('') }} anchor={anchorRef.current} align="end" label="Columns" width={300}>
        <div className="relative p-2 border-b border-paper-100">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-3.5 text-ink-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a field" aria-label="Find a field"
            className="h-8 w-full rounded-md border border-input bg-card pl-7 pr-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ink-950" />
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {sections.length === 0 && <p className="px-3 py-2 text-[12px] text-ink-500">No field by that name.</p>}
          {sections.map(s => (
            <div key={s.title} className="py-1">
              <p className="px-3 pb-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-400">{s.title}</p>
              {s.fields.map(f => {
                const on = columns.includes(f.key)
                return (
                  <label key={f.key} className={`flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-ink-950 ${!on && full ? 'opacity-50' : 'hover:bg-paper-100 cursor-pointer'}`}>
                    <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(f.key)} data-testid={`column-${f.key}`} />
                    <span className="truncate">{f.label}</span>
                    {typesOf(f) && <span className="ml-auto shrink-0 text-[10.5px] text-ink-400">{typesOf(f)}</span>}
                  </label>
                )
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 px-3 py-2 border-t border-paper-100 text-[11.5px] text-ink-500">
          {full ? `Up to ${MAX_COLUMNS} columns` : `${columns.length} shown`}
          {columns.length > 0 && <button type="button" className="ml-auto text-ink-950 hover:underline underline-offset-2" onClick={() => onChange([])}>Clear</button>}
        </div>
      </Popover>
    </>
  )
}
