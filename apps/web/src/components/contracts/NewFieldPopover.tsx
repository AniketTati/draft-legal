/**
 * NewFieldPopover (docs/39 C3) — a field made from words in the contract.
 *
 * When the AI didn't track a term — a PO number, a service credit, a launch
 * date — an admin had to leave the contract, add the field in Settings, come
 * back and type the value; anyone else couldn't add it at all. Here the
 * highlighted words are the value: the popover guesses the field's name from
 * the words around them and its type from how they read, adds the field (for
 * this contract type or every contract) and saves the value on this contract
 * in one go — or, for someone who can't add fields, sends it to those who can.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, X } from 'lucide-react'
import { fieldKeyFromLabel, parseFieldValue, type FieldValueType } from '@clm/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { inferFieldType, labelFromContext } from '@/lib/field-suggest'
import { useOrgDateOrder } from '@/lib/org-date-order'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toaster'
import { errorDetail } from './FieldsPanel'
import type { TextSelection } from './SelectionMenu'

const WIDTH = 360

const TYPES: Array<{ value: FieldValueType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'longtext', label: 'Long text' },
  { value: 'date', label: 'Date' },
  { value: 'duration', label: 'Length of time' },
  { value: 'currency', label: 'Amount of money' },
  { value: 'number', label: 'Number' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'select', label: 'One of a list' },
]

type Done =
  | { kind: 'added'; label: string; fieldId: string; saved: string | null }
  | { kind: 'suggested'; label: string; duplicate: boolean }

export function NewFieldPopover({ contractId, contractType, selection, canCreate, onClose, seed }: {
  contractId: string
  contractType: string | null
  selection: TextSelection
  /** May add fields (configure:contract); otherwise the field is suggested to those who may. */
  canCreate: boolean
  onClose: () => void
  /**
   * docs/39 C4 — started from something the AI found rather than a highlight:
   * its name, and the contract's words it read the value from. The value
   * (selection.text) is saved as the person's, quoting those words.
   */
  seed?: { label: string; quote: string | null }
}) {
  const qc = useQueryClient()
  const dateOrder = useOrgDateOrder()
  const [label, setLabel] = useState(() => seed?.label ?? labelFromContext(selection.before, selection.after))
  const [type, setType] = useState<FieldValueType>(() => inferFieldType(selection.text))
  const [scope, setScope] = useState<'type' | 'all'>(contractType && contractType !== 'OTHER' ? 'type' : 'all')
  const [helpText, setHelpText] = useState('')
  const [options, setOptions] = useState(selection.text)
  const [done, setDone] = useState<Done | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const optionList = options.split(',').map(o => o.trim()).filter(Boolean)
  const parsed = useMemo(
    () => parseFieldValue(type, type === 'boolean' ? 'yes' : selection.text, { dateOrder, options: type === 'select' ? optionList : undefined }),
    [type, selection.text, dateOrder, options],
  )
  const value = parsed.ok && parsed.value !== null ? parsed.value : null
  const key = fieldKeyFromLabel(label || 'field')
  const typeName = contractType ? contractType.replace(/_/g, ' ') : 'these'

  // Closes on Escape and on a click outside it (a tick later: the mouse-down that opened it is still on its way).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const down = (e: MouseEvent) => { if (panelRef.current && !panelRef.current.contains(e.target as Node)) closeRef.current() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    const t = setTimeout(() => document.addEventListener('mousedown', down), 0)
    window.addEventListener('keydown', esc)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); window.removeEventListener('keydown', esc) }
  }, [])

  const add = useMutation({
    mutationFn: async () => {
      const def = (await api.post<{ id: string; fieldKey: string; fieldLabel: string }>('/field-definitions', {
        fieldKey: key, fieldLabel: label.trim(), fieldType: type,
        contractType: scope === 'type' ? contractType : null,
        helpText: helpText.trim() || undefined,
        options: type === 'select' ? optionList : [],
      })).data
      let saved: string | null = null
      if (value !== null) {
        const r = await api.put(`/contracts/${contractId}/fields/${encodeURIComponent(def.fieldKey)}`, seed
          // A finding: the value the person just confirmed, with the words the AI read it from.
          ? { value, source: 'user', ...(seed.quote && { quote: seed.quote }) }
          : { value, source: 'highlight', quote: selection.text, anchor: { occurrence: selection.occurrence } },
        ).catch(() => null)
        saved = (r?.data as { field?: { display?: string } } | null)?.field?.display ?? null
      }
      return { def, saved }
    },
    onSuccess: ({ def, saved }) => {
      qc.invalidateQueries({ queryKey: ['contract-fields', contractId] })
      qc.invalidateQueries({ queryKey: ['field-definitions'] })
      // The list's columns and filters, and the AI findings it no longer needs to show (C4).
      qc.invalidateQueries({ queryKey: ['contract-field-catalog'] })
      setDone({ kind: 'added', label: def.fieldLabel, fieldId: def.id, saved })
    },
    onError: err => toast.error("Couldn't add the field", { description: errorDetail(err) }),
  })

  const suggest = useMutation({
    mutationFn: async () => (await api.post<{ duplicate?: boolean }>('/field-suggestions', {
      label: label.trim(), fieldType: type,
      contractType: scope === 'type' ? contractType : null,
      helpText: helpText.trim() || undefined,
      options: type === 'select' ? optionList : [],
      example: seed
        ? { contractId, quote: seed.quote ?? selection.text, value }
        : { contractId, quote: selection.text, value, occurrence: selection.occurrence },
    })).data,
    onSuccess: r => setDone({ kind: 'suggested', label: label.trim(), duplicate: !!r.duplicate }),
    onError: err => toast.error("Couldn't send the suggestion", { description: errorDetail(err) }),
  })

  const busy = add.isPending || suggest.isPending
  const ready = label.trim().length > 0 && (type !== 'select' || optionList.length > 0)
  const submit = () => { if (ready && !busy) (canCreate ? add : suggest).mutate() }

  const height = done ? 170 : 430
  const below = selection.rect.bottom + 8 + height < window.innerHeight
  const top = below ? selection.rect.bottom + 8 : Math.max(8, selection.rect.top - 8 - height)
  const left = Math.min(Math.max(selection.rect.left, 16), window.innerWidth - WIDTH - 16)

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={canCreate ? 'New field' : 'Suggest a field'}
      data-testid="new-field-popover"
      className="fixed z-50 rounded-lg border border-paper-200 bg-popover shadow-e3 overflow-hidden"
      style={{ top, left, width: WIDTH }}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-paper-100">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">{canCreate ? 'New field' : 'Suggest a field'}</p>
          <p className="mt-0.5 text-[12px] italic text-ink-700 line-clamp-2" title={selection.text}>“{selection.text}”</p>
        </div>
        <button type="button" className="p-0.5 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" onClick={onClose} aria-label="Close">
          <X className="size-3.5" />
        </button>
      </div>

      {done ? (
        <div className="px-4 py-4 space-y-3" data-testid="new-field-done">
          <p className="flex items-start gap-2 text-[13px] text-ink-950">
            <CheckCircle2 className="size-4 text-brand-700 mt-0.5 shrink-0" />
            {done.kind === 'added'
              ? <span><span className="font-semibold">{done.label}</span> added{done.saved ? <>, and saved on this contract as <span className="font-semibold">{done.saved}</span>.</> : '.'}</span>
              : done.duplicate
                ? <span>Someone already asked for <span className="font-semibold">{done.label}</span>. Your admins have it.</span>
                : <span>Sent to your admins. They&apos;ll add <span className="font-semibold">{done.label}</span> or tell you why not.</span>}
          </p>
          <div className="flex justify-end gap-1.5">
            {done.kind === 'added' && (
              <Link to={`/settings?tab=custom-fields&field=${done.fieldId}`} className="inline-flex items-center h-[26px] px-2.5 rounded-sm border border-input text-[11.5px] text-ink-700 hover:bg-paper-100" onClick={onClose}>
                Fill it in on other contracts
              </Link>
            )}
            <Button size="xs" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="px-3 py-3 space-y-2.5" onSubmit={e => { e.preventDefault(); submit() }}>
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-700">Name</span>
            <Input autoFocus value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. PO number" className="mt-1 h-8 text-[12.5px]" data-testid="new-field-label" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-700">Type</span>
              <select value={type} onChange={e => setType(e.target.value as FieldValueType)} className="mt-1 h-8 w-full rounded-md border border-input bg-card px-2 text-[12.5px]" data-testid="new-field-type">
                {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-700">On</span>
              <select value={scope} onChange={e => setScope(e.target.value as 'type' | 'all')} className="mt-1 h-8 w-full rounded-md border border-input bg-card px-2 text-[12.5px]" data-testid="new-field-scope">
                {contractType && <option value="type">{typeName} contracts</option>}
                <option value="all">Every contract</option>
              </select>
            </label>
          </div>
          {type === 'select' && (
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-700">Choices, separated by commas</span>
              <Input value={options} onChange={e => setOptions(e.target.value)} className="mt-1 h-8 text-[12.5px]" />
            </label>
          )}
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-700">What the AI should look for <span className="font-normal text-ink-400">(optional)</span></span>
            <textarea
              value={helpText} onChange={e => setHelpText(e.target.value)} rows={2} maxLength={512}
              placeholder={label ? `e.g. The ${label.toLowerCase()} as the contract states it` : 'e.g. The purchase order number the customer issues'}
              className="mt-1 w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-[12.5px] leading-snug focus:outline-none focus:ring-1 focus:ring-ink-950"
            />
          </label>
          <p className={cn('text-[11.5px]', value !== null ? 'text-ink-500' : 'text-attention-700')} data-testid="new-field-value">
            {value !== null
              ? <>This contract: <span className="font-medium text-ink-950">{parsed.ok ? parsed.display : ''}</span>{parsed.ok && parsed.ambiguous ? ` · ${parsed.ambiguous}` : ''}</>
              : `These words don't read as ${TYPES.find(t => t.value === type)?.label.toLowerCase()}: the field is ${canCreate ? 'added' : 'suggested'} without a value.`}
          </p>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10.5px] font-mono text-ink-400 truncate" title="The field's key">{key}</span>
            <div className="ml-auto flex gap-1.5">
              <Button type="button" size="xs" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button type="submit" size="xs" disabled={!ready || busy} data-testid="new-field-submit">
                {busy && <Loader2 className="animate-spin" />}
                {canCreate ? 'Add field' : 'Suggest to an admin'}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>,
    document.body,
  )
}
