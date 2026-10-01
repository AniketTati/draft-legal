/**
 * Field filters on the contracts list (docs/39 D3).
 *
 * A term captured on contracts — by the AI, a highlight or an admin's new
 * field — could be read only one contract at a time. Here it narrows the
 * list in its own terms: a duration as a length of time ("at least 3 years",
 * whether the contract said 36 months or three years), money with its
 * currency, a date range, a yes/no, a field's choices, words in a text.
 *
 *   <AddFieldFilter>   the "Field" button: pick a field, then its condition
 *   <FieldFilterChip>  one filter as a chip; click it to change the condition
 */
import { useMemo, useRef, useState } from 'react'
import { ArrowLeft, ListFilter, Search } from 'lucide-react'
import {
  FILTER_OPS, NUMERIC_TYPES, opLabel, validateFieldFilter, describeFieldFilter, parseNumber,
  type CatalogField, type DurationUnit, type FieldFilter, type FieldFilterOp,
} from '@clm/types'
import { Popover } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/primitives'
import { catalogSections, typesOf } from '@/lib/field-catalog'
import { cn } from '@/lib/utils'

const UNITS: DurationUnit[] = ['days', 'weeks', 'months', 'years']
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'CAD', 'AUD', 'SGD', 'CHF']

const INPUT = 'h-8 w-full rounded-md border border-input bg-card px-2 text-[12.5px] text-ink-950 focus:outline-none focus:ring-1 focus:ring-ink-950'

/** One bound as typed: a number (and a unit, for a duration) or a date. */
interface Bound { n: string; unit: DurationUnit; date: string }

const boundFrom = (v: unknown): Bound => {
  if (v && typeof v === 'object' && 'unit' in (v as object)) {
    const d = v as { value: number; unit: DurationUnit }
    return { n: String(d.value), unit: d.unit, date: '' }
  }
  return { n: typeof v === 'number' ? String(v) : '', unit: 'months', date: typeof v === 'string' ? v : '' }
}

function boundValue(field: CatalogField, b: Bound): unknown {
  if (field.type === 'date') return b.date || undefined
  const n = parseNumber(b.n)
  if (n === null) return undefined
  return field.type === 'duration' ? { value: n, unit: b.unit } : n
}

function FieldFilterEditor({ field, initial, onApply, onRemove, onBack }: {
  field: CatalogField
  initial?: FieldFilter
  onApply: (f: FieldFilter) => void
  onRemove?: () => void
  onBack?: () => void
}) {
  const ops = FILTER_OPS[field.type]
  const [op, setOp] = useState<FieldFilterOp>(initial?.op ?? ops[0])
  const [from, setFrom] = useState<Bound>(() => boundFrom(initial?.value))
  const [to, setTo] = useState<Bound>(() => boundFrom(initial?.to))
  const [text, setText] = useState(typeof initial?.value === 'string' ? initial.value : Array.isArray(initial?.value) && field.type === 'text' ? (initial.value as string[]).join(', ') : '')
  const [yes, setYes] = useState<boolean>(initial?.value !== false)
  const [picked, setPicked] = useState<string[]>(Array.isArray(initial?.value) ? initial.value as string[] : [])
  const [currency, setCurrency] = useState(initial?.currency ?? '')

  const filter: FieldFilter = useMemo(() => {
    const base: FieldFilter = { key: field.key, op }
    if (op === 'present' || op === 'empty') return base
    if (field.type === 'boolean') return { ...base, value: yes }
    // Words, any of several: "Delaware, New York".
    if (op === 'any_of' && field.type === 'text') return { ...base, value: text.split(',').map(s => s.trim()).filter(Boolean) }
    if (op === 'any_of') return { ...base, value: picked }
    if (field.type === 'select' && op === 'is_not') return { ...base, value: picked[0] }
    if (NUMERIC_TYPES.has(field.type) || field.type === 'date') {
      return {
        ...base, value: boundValue(field, from),
        ...(op === 'between' && { to: boundValue(field, to) }),
        ...(field.type === 'currency' && currency && { currency }),
      }
    }
    return { ...base, value: text.trim() }
  }, [field, op, yes, picked, from, to, text, currency])
  const why = validateFieldFilter(field.type, filter)

  const boundInput = (b: Bound, set: (b: Bound) => void, placeholder: string) => field.type === 'date'
    ? <input type="date" value={b.date} onChange={e => set({ ...b, date: e.target.value })} className={INPUT} aria-label={placeholder} />
    : (
      <div className="flex gap-1.5">
        <input inputMode="decimal" value={b.n} onChange={e => set({ ...b, n: e.target.value })} placeholder={placeholder} aria-label={placeholder}
          className={cn(INPUT, field.type === 'duration' && 'w-24 shrink-0')} />
        {field.type === 'duration' && (
          <select value={b.unit} onChange={e => set({ ...b, unit: e.target.value as DurationUnit })} className={INPUT} aria-label="Unit">
            {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
        {field.type === 'percentage' && <span className="self-center text-[12px] text-ink-500">%</span>}
      </div>
    )

  const options = field.options ?? []
  return (
    <form className="p-3 space-y-2.5" onSubmit={e => { e.preventDefault(); if (!why) onApply(filter) }} data-testid="field-filter-editor">
      <div className="flex items-center gap-1.5">
        {onBack && (
          <button type="button" onClick={onBack} className="p-0.5 -ml-0.5 rounded-sm text-ink-400 hover:text-ink-950" aria-label="Back to the fields">
            <ArrowLeft className="size-3.5" />
          </button>
        )}
        <span className="text-[12.5px] font-semibold text-ink-950 truncate">{field.label}</span>
        {typesOf(field) && <span className="ml-auto text-[10.5px] text-ink-400 shrink-0">{typesOf(field)}</span>}
      </div>
      <select value={op} onChange={e => setOp(e.target.value as FieldFilterOp)} className={INPUT} aria-label="Condition" data-testid="field-filter-op">
        {ops.map(o => <option key={o} value={o}>{opLabel(field.type, o)}</option>)}
      </select>

      {op !== 'present' && op !== 'empty' && (
        field.type === 'boolean' ? (
          <div className="flex gap-1.5" role="radiogroup" aria-label={field.label}>
            {[true, false].map(v => (
              <button key={String(v)} type="button" role="radio" aria-checked={yes === v} onClick={() => setYes(v)}
                className={cn('h-8 flex-1 rounded-md border text-[12.5px]', yes === v ? 'border-ink-950 bg-ink-950 text-white' : 'border-input text-ink-700 hover:bg-paper-100')}>
                {v ? 'Yes' : 'No'}
              </button>
            ))}
          </div>
        ) : (field.type === 'select' || field.type === 'multiselect') ? (
          <div className="max-h-44 overflow-y-auto space-y-0.5">
            {options.length === 0 && <p className="text-[11.5px] text-ink-500">This field has no choices set.</p>}
            {options.map(o => {
              const single = field.type === 'select' && op === 'is_not'
              const on = single ? picked[0] === o : picked.includes(o)
              return (
                <label key={o} className="flex items-center gap-2 px-1 py-1 rounded-sm text-[12.5px] text-ink-950 hover:bg-paper-50 cursor-pointer">
                  <input type={single ? 'radio' : 'checkbox'} checked={on} name={`opt-${field.key}`}
                    onChange={() => setPicked(p => single ? [o] : on ? p.filter(x => x !== o) : [...p, o])} />
                  {o}
                </label>
              )
            })}
          </div>
        ) : (NUMERIC_TYPES.has(field.type) || field.type === 'date') ? (
          <div className="space-y-1.5">
            {op === 'between'
              ? (
                <div className="grid grid-cols-[2.25rem_1fr] items-center gap-x-1.5 gap-y-1.5">
                  <span className="text-[11px] text-ink-500">From</span>{boundInput(from, setFrom, 'From')}
                  <span className="text-[11px] text-ink-500">To</span>{boundInput(to, setTo, 'To')}
                </div>
              )
              : boundInput(from, setFrom, field.type === 'date' ? 'Date' : field.type === 'duration' ? 'How long' : 'Amount')}
            {field.type === 'currency' && (
              <select value={currency} onChange={e => setCurrency(e.target.value)} className={INPUT} aria-label="Currency">
                <option value="">Any currency</option>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </div>
        ) : (
          <input value={text} onChange={e => setText(e.target.value)} className={INPUT} aria-label="Value"
            placeholder={op === 'contains' ? 'Words to look for' : op === 'any_of' ? 'Values, separated by commas' : 'Value'} />
        )
      )}

      <div className="flex items-center gap-2 pt-0.5">
        {onRemove && <Button type="button" size="xs" variant="ghost" onClick={onRemove}>Remove</Button>}
        <Button type="submit" size="xs" className="ml-auto" disabled={!!why} title={why ?? undefined} data-testid="field-filter-apply">Apply</Button>
      </div>
    </form>
  )
}

/** The "Field" button: pick a field, then say what it should hold. */
export function AddFieldFilter({ catalog, onAdd }: { catalog: CatalogField[]; onAdd: (f: FieldFilter) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [field, setField] = useState<CatalogField | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const sections = catalogSections(catalog, search)
  const close = () => { setOpen(false); setField(null); setSearch('') }
  return (
    <>
      <button
        ref={anchorRef} type="button" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-dashed border-paper-300 text-[11.5px] text-ink-700 hover:border-ink-400 hover:text-ink-950"
        data-testid="add-field-filter"
      >
        <ListFilter className="size-3.5" /> Field
      </button>
      <Popover open={open} onClose={close} anchor={anchorRef.current} label="Filter by a field" width={300}>
        {field ? (
          <FieldFilterEditor field={field} onBack={() => setField(null)} onApply={f => { onAdd(f); close() }} />
        ) : (
          <div>
            <div className="relative p-2 border-b border-paper-100">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-3.5 text-ink-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a field" aria-label="Find a field"
                className={cn(INPUT, 'pl-7')} data-testid="field-filter-search" />
            </div>
            <div className="max-h-80 overflow-y-auto py-1">
              {sections.length === 0 && <p className="px-3 py-2 text-[12px] text-ink-500">No field by that name.</p>}
              {sections.map(s => (
                <div key={s.title} className="py-1">
                  <p className="px-3 pb-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-400">{s.title}</p>
                  {s.fields.map(f => (
                    <button key={f.key} type="button" onClick={() => setField(f)}
                      className="w-full flex items-baseline gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-950 hover:bg-paper-100">
                      <span className="truncate">{f.label}</span>
                      {typesOf(f) && <span className="ml-auto shrink-0 text-[10.5px] text-ink-400">{typesOf(f)}</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </Popover>
    </>
  )
}

/** One field filter as a chip: its condition in words; click to change it, × to drop it. */
export function FieldFilterChip({ field, filter, onChange, onRemove }: {
  field: CatalogField | undefined
  filter: FieldFilter
  onChange: (f: FieldFilter) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  // A saved view can name a field since deleted: say so rather than drop it silently.
  const label = field ? describeFieldFilter(field.label, field.type, filter) : `${filter.key} (field removed)`
  return (
    <span ref={anchorRef} className="inline-flex" data-testid={`field-filter-chip-${filter.key}`}>
      <Chip onClick={field ? () => setOpen(o => !o) : undefined} onRemove={onRemove} removeLabel={`Remove filter: ${label}`}>{label}</Chip>
      {field && (
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchorRef.current} label={`Change the ${field.label} filter`} width={300}>
          <FieldFilterEditor field={field} initial={filter} onApply={f => { onChange(f); setOpen(false) }} onRemove={() => { setOpen(false); onRemove() }} />
        </Popover>
      )}
    </span>
  )
}
