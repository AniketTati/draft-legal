/**
 * docs/39 H1 — variables from a template's own paper, in the template builder.
 *
 * SuggestedVariables: the placeholders the sections already have
 * ("[Customer Name]", "«Effective Date»", "Fees: ____", a {{key}} missing
 * from the list) made variables in one go — named, typed and matched to the
 * field each fills (@clm/types template-variables).
 *
 * MakeVariablePopover: words selected in a section made a variable — named
 * from the words around them, typed from how they read, here or everywhere
 * they appear — or pointed at a variable the template has already.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, X } from 'lucide-react'
import {
  fieldKeyFromLabel, suggestImportTarget, suggestTemplateVariables, variableTypeFor,
  type CatalogField, type SuggestedVariable, type VariableDef, type VariableType,
} from '@clm/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { catalogSections } from '@/lib/field-catalog'
import { inferFieldType, labelFromContext } from '@/lib/field-suggest'
import type { VariableSelection } from '@/components/editor/ContractEditor'

const TYPES: VariableType[] = ['text', 'number', 'date', 'boolean', 'select']
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** A field picker: the fields grouped as the other pickers show them. */
export function FieldSelect({ value, onChange, catalog, className, label }: {
  value: string | null | undefined
  onChange: (key: string | null) => void
  catalog: CatalogField[]
  className?: string
  label: string
}) {
  const sections = useMemo(() => catalogSections(catalog), [catalog])
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value || null)} aria-label={label}
      className={cn('border border-input rounded-md px-1.5 py-1 text-[11.5px] text-ink-950 bg-card outline-none', className)}>
      <option value="">No field</option>
      {sections.map(s => (
        <optgroup key={s.title} label={s.title}>
          {s.fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

// ─── Suggested variables ──────────────────────────────────────────────────────

export function SuggestedVariables({ sections, variables, catalog, onApply }: {
  sections: string[]
  variables: VariableDef[]
  catalog: CatalogField[]
  onApply: (picks: SuggestedVariable[]) => void
}) {
  const suggestions = useMemo(() => suggestTemplateVariables(sections, variables, catalog), [sections, variables, catalog])
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState(false)
  if (!suggestions.length || hidden) return null
  const picks = suggestions.filter(s => !skipped.has(s.key))
  const fieldLabel = (key: string | null) => (key ? catalog.find(f => f.key === key)?.label : null)
  return (
    <div className="rounded-md border border-attention-200 bg-attention-50 p-2.5 space-y-2" data-testid="suggested-variables">
      <div className="flex items-start gap-2">
        <Braces className="size-3.5 text-attention-700 mt-0.5 shrink-0" />
        <p className="flex-1 text-[11.5px] text-attention-800 leading-snug">
          {suggestions.length === 1 ? 'A placeholder' : `${suggestions.length} placeholders`} in the text could be variables.
        </p>
        <button type="button" className="text-attention-700 hover:text-ink-950" aria-label="Not now" onClick={() => setHidden(true)}><X className="size-3.5" /></button>
      </div>
      <ul className="space-y-1">
        {suggestions.map(s => (
          <li key={s.key}>
            <label className="flex items-start gap-1.5 text-[11.5px] text-ink-950">
              <input type="checkbox" className="accent-ink-950 mt-0.5" checked={!skipped.has(s.key)}
                onChange={e => setSkipped(prev => { const next = new Set(prev); if (e.target.checked) next.delete(s.key); else next.add(s.key); return next })} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.label}</span>
                <span className="text-ink-500"> · {s.type}{s.count > 1 ? ` · ×${s.count}` : ''}{s.listed ? ' · listed' : ''}</span>
                <span className="block truncate font-mono text-[10.5px] text-ink-500" title={s.matches.map(decode).join('  ')}>
                  {s.token && !s.listed ? `${decode(s.matches[0])} isn’t in the list` : decode(s.matches[0])}
                  {fieldLabel(s.field) ? ` → ${fieldLabel(s.field)}` : ''}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <Button size="xs" className="w-full" disabled={!picks.length} onClick={() => onApply(picks)} data-testid="apply-suggested-variables">
        Make {picks.length === 1 ? 'it a variable' : `${picks.length} variables`}
      </Button>
    </div>
  )
}

// ─── Make variable ────────────────────────────────────────────────────────────

/** A variable type from how the selected words read (C3's reading of a highlight). */
function typeOfWords(text: string): VariableType {
  const t = inferFieldType(text)
  if (t === 'date' || t === 'boolean') return t
  if (t === 'number' || t === 'currency' || t === 'percentage' || t === 'duration') return 'number'
  return 'text'
}

export interface MadeVariable {
  key: string
  /** A new variable to list (absent: an existing one was picked). */
  def?: VariableDef
  everywhere: boolean
}

export function MakeVariablePopover({ selection, variables, catalog, elsewhere, onMake, onClose }: {
  selection: VariableSelection
  variables: VariableDef[]
  catalog: CatalogField[]
  /** Times the same words are in the template's other sections. */
  elsewhere: number
  onMake: (made: MadeVariable) => void
  onClose: () => void
}) {
  const guessed = labelFromContext(selection.before, selection.after)
  const [existing, setExisting] = useState('')
  const [label, setLabel] = useState(guessed)
  // The type and field follow the name as it's typed, until the author picks one.
  const typeFor = (name: string): VariableType => (name && variableTypeFor(name) !== 'text' ? variableTypeFor(name) : typeOfWords(selection.text))
  // A field another variable fills already isn't offered twice.
  const fieldFor = (name: string) => {
    const t = name ? suggestImportTarget(name, catalog) : null
    return t?.kind === 'field' && !variables.some(v => v.field === t.key) ? t.key : null
  }
  const [type, setType] = useState<VariableType>(() => typeFor(guessed))
  const [field, setField] = useState<string | null>(() => fieldFor(guessed))
  const [picked, setPicked] = useState({ type: false, field: false })
  const rename = (name: string) => {
    setLabel(name)
    if (!picked.type) setType(typeFor(name))
    if (!picked.field) setField(fieldFor(name))
  }
  const [keepDefault, setKeepDefault] = useState(false)
  const total = selection.occurrences + elsewhere
  const [everywhere, setEverywhere] = useState(total > 1)

  const taken = new Set(variables.map(v => v.key))
  let key = fieldKeyFromLabel(label || 'variable')
  for (let i = 2; taken.has(key); i++) key = `${fieldKeyFromLabel(label || 'variable')}_${i}`

  const WIDTH = 320
  const below = selection.rect.bottom + 8 + 360 < window.innerHeight
  const top = below ? selection.rect.bottom + 8 : Math.max(8, selection.rect.top - 8 - 360)
  const left = Math.min(Math.max(selection.rect.left, 16), window.innerWidth - WIDTH - 16)
  const make = () => onMake(existing
    ? { key: existing, everywhere }
    : { key, everywhere, def: { key, label: label.trim(), type, required: false, field, ...(keepDefault && { defaultValue: selection.text }) } })

  return createPortal(
    <div role="dialog" aria-label="Make variable" data-testid="make-variable-popover"
      className="fixed z-50 rounded-lg border border-paper-200 bg-popover shadow-e3 p-3 space-y-2.5" style={{ top, left, width: WIDTH }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Make variable</p>
          <p className="mt-0.5 text-[12px] italic text-ink-700 line-clamp-2" title={selection.text}>“{selection.text}”</p>
        </div>
        <button type="button" className="p-0.5 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" onClick={onClose} aria-label="Close"><X className="size-3.5" /></button>
      </div>
      {variables.length > 0 && (
        <select value={existing} onChange={e => setExisting(e.target.value)} aria-label="Use a variable the template has"
          className="w-full h-8 rounded-md border border-input bg-card px-2 text-[12.5px]">
          <option value="">A new variable</option>
          {variables.map(v => <option key={v.key} value={v.key}>{v.label || v.key}</option>)}
        </select>
      )}
      {!existing && (
        <>
          <label className="block">
            <span className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 mb-1">Name</span>
            <Input autoFocus value={label} onChange={e => rename(e.target.value)} placeholder="e.g. Customer name" className="h-8 text-[12.5px]" data-testid="make-variable-label" />
            <span className="mt-1 block font-mono text-[10.5px] text-ink-500">{`{{${key}}}`}</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 mb-1">Type</span>
              <select value={type} onChange={e => { setType(e.target.value as VariableType); setPicked(p => ({ ...p, type: true })) }} className="w-full h-8 rounded-md border border-input bg-card px-2 text-[12.5px]">
                {TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 mb-1">Fills the field</span>
              <FieldSelect value={field} onChange={f => { setField(f); setPicked(p => ({ ...p, field: true })) }} catalog={catalog} className="w-full h-8 text-[12.5px]" label="Fills the field" />
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-ink-700">
            <input type="checkbox" className="accent-ink-950" checked={keepDefault} onChange={e => setKeepDefault(e.target.checked)} />
            Keep “{selection.text.length > 30 ? `${selection.text.slice(0, 30)}…` : selection.text}” as its default
          </label>
        </>
      )}
      {total > 1 && (
        <label className="flex items-center gap-1.5 text-[11.5px] text-ink-700">
          <input type="checkbox" className="accent-ink-950" checked={everywhere} onChange={e => setEverywhere(e.target.checked)} data-testid="make-variable-everywhere" />
          Everywhere it appears ({total}{elsewhere ? `, ${elsewhere} in other sections` : ''})
        </label>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="xs" onClick={onClose}>Cancel</Button>
        <Button size="xs" disabled={!existing && !label.trim()} onClick={make} data-testid="make-variable-save">Make variable</Button>
      </div>
    </div>,
    document.body,
  )
}
