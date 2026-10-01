/**
 * FieldsPanel (docs/39 B1) — every field a contract holds, who set it, and
 * the fixes a person makes in place.
 *
 * Before this the Key Terms, contract-type terms and custom fields were three
 * read-only cards: a wrong value could only be fixed from the Review Queue,
 * and only if the AI had scored it low; contract-type terms and custom values
 * could not be fixed at all. Here every value can be edited with an input
 * that fits its type, the AI's value can be confirmed in one click, a
 * re-analysis that reads a value differently asks before replacing one a
 * person set, and a notice period found before the AI told notices apart
 * asks which notice it is (F1).
 *
 * Machine-authored values carry the assist mark, scaled by confidence
 * (design system §04); values a person set or checked carry ink marks.
 *
 * B2 — a value with a quote shows where it came from: "Show in document"
 * highlights the passage in the document beside it, and a value whose words
 * are no longer in the current version says so.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, Calculator, Check, CircleCheck, FileDiff, FileSpreadsheet, FileText, Loader2, LocateFixed, Paperclip, Pencil, Quote, TextQuote,
} from 'lucide-react'
import {
  DEFAULT_CHECK_BELOW, VERIFICATION_LABELS, parseFieldValue,
  type CheckLevel, type DateOrder, type DurationUnit, type FieldValueType, type VerificationState,
} from '@clm/types'
import { useOrgDateOrder } from '@/lib/org-date-order'
import { AnalysisChanges } from './AnalysisChanges'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { CounterpartyLink, counterpartyKey } from './CounterpartyLink'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AssistMark } from '@/components/ui/assist'
import { toast } from '@/components/common/Toaster'

export interface FieldSuggestion {
  value: unknown
  display: string
  quote: string | null
  section: string | null
  confidence: number | null
  versionId: string | null
  at: string
  /**
   * G2 'edited' — read from the words an edit put in place of the value's own;
   * A9 'proposed' — what the other side's tracked changes, not accepted, would
   * make it (a null value: they take it out).
   */
  reason?: 'edited' | 'proposed'
}

/** docs/39 A6 — one of the things a contract says about a field, with its words (API field-store FieldCandidate). */
export interface FieldCandidate {
  value: unknown
  display: string
  quote: string | null
  section: string | null
}

/** Where a value's quote sits in the version the contract stands on (API field-store FieldAnchor). */
export interface FieldAnchor {
  versionId: string
  /** null: the quoted words aren't in this version. */
  start: number | null
  end: number | null
  /** The document's own wording of the passage. */
  text: string | null
  /** Which of the passages worded like this one it is. */
  occurrence: number
  /** The version has no text to look in: not the same as the words being gone. */
  noText?: boolean
  /** docs/39 A12 — in an exhibit read with the contract, not its own text. */
  exhibit?: { s3Key: string; label: string }
}

export interface ContractField {
  key: string
  kind: 'core' | 'type' | 'custom'
  label: string
  type: FieldValueType
  group: string
  options?: string[]
  definition?: string | null
  legacy?: boolean
  required?: boolean
  /** A number's unit, shown after it ("45 days"). */
  unit?: string
  value: unknown
  display: string
  source: 'ai' | 'calculated' | 'user' | 'highlight' | 'variable' | 'amendment' | 'import' | null
  confidence: number | null
  quote: string | null
  section: string | null
  issue: string | null
  anchor: FieldAnchor | null
  verifiedAt: string | null
  rejectedAt: string | null
  suggestion: FieldSuggestion | null
  locked: boolean
  /** B3 — the model's own number; `confidence` is held down by what can be checked. */
  modelConfidence?: number | null
  /** Why `confidence` is lower than the model said. */
  confidenceReasons?: string[]
  /** When this field's AI values need a person, and below what confidence (null: always). */
  check?: CheckLevel
  checkBelow?: number | null
  /** G3 — the amendment a value was set from. */
  fromContract?: { id: string; title: string } | null
  /** docs/39 A6 — the contract says different things about it: each reading, the value's first. */
  candidates?: FieldCandidate[] | null
}

/** docs/39 A6 — the contract says different things about it, and nobody has chosen yet. */
export const disagrees = (f: Pick<ContractField, 'candidates'>) => (f.candidates?.length ?? 0) > 1

/** The value's passage is in the current version. */
export const isPlaced = (f: ContractField) => !!f.anchor && f.anchor.start !== null && !!f.anchor.text
/** The value's passage was looked for in the current version and isn't there. */
const isGone = (f: ContractField) => !!f.quote && !!f.anchor && f.anchor.start === null && !f.anchor.noText && !f.anchor.exhibit && f.suggestion?.reason !== 'proposed'
/** A9 — the agreed words, which the other side's tracked changes replace in the document. */
const underTheirChanges = (f: ContractField) => !!f.quote && !!f.anchor && f.anchor.start === null && f.suggestion?.reason === 'proposed'

export interface FieldsResponse {
  contractId: string
  contractType: string
  groups: Record<string, string>
  fields: ContractField[]
  /** B3 — how much of it a person set or checked. */
  verification?: { state: VerificationState; checked: number; filled: number }
}

const GROUP_ORDER = ['term', 'parties', 'commercial', 'legal', 'type', 'custom']
/** Below this an unchecked AI value asks to be checked, unless its field says otherwise (B3). */
const CHECK_BELOW = DEFAULT_CHECK_BELOW

/** B3 — the field's own rule: checked always, or below its threshold. */
const belowThreshold = (f: ContractField) =>
  f.check === 'always' || (f.confidence ?? 1) < (f.checkBelow === undefined ? CHECK_BELOW : f.checkBelow ?? Infinity)

export const hasValue = (f: ContractField) => f.value !== null && f.value !== undefined && f.value !== ''

export function errorDetail(err: unknown): string {
  const e = err as { response?: { data?: { detail?: string } }; message?: string }
  return e.response?.data?.detail ?? e.message ?? 'Something went wrong'
}

/** What a field needs from a person: a low-confidence AI value, a suggestion, or a notice of unknown type. */
function needsCheck(f: ContractField): boolean {
  if (f.suggestion) return true
  if (disagrees(f)) return true
  if (f.legacy && hasValue(f)) return true
  // An AI value whose words an edit or a new version took out may no longer hold (B2).
  return f.source === 'ai' && !f.verifiedAt && hasValue(f) && (belowThreshold(f) || isGone(f))
}

// ─── Who set it ───────────────────────────────────────────────────────────────

function SourceMark({ f }: { f: ContractField }) {
  if (!hasValue(f) && !f.rejectedAt) return null
  if (f.rejectedAt && !hasValue(f)) {
    return <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-500" title="A person marked the AI's value wrong">Cleared</span>
  }
  if (f.source === 'ai' && !f.verifiedAt) {
    // The mark scales with how sure the AI is (design system §04); the
    // number is in the tooltip — on every row it was noise. Only a value
    // that should be checked says so in words.
    const c = f.confidence ?? 0.5
    const level = c >= 0.9 ? 'high' : c >= CHECK_BELOW ? 'medium' : 'low'
    const gone = isGone(f)
    const check = belowThreshold(f) || gone
    // B3 — why it's this sure (the model's number held down by what can be checked), and the field's rule.
    const why = [
      ...(f.confidenceReasons ?? (f.issue ? [f.issue] : [])),
      ...(gone && !(f.confidenceReasons ?? []).some(r => r.includes('current version')) ? ['its words aren\u2019t in the current version'] : []),
      ...(f.check === 'always' ? ['this field is always checked'] : []),
    ]
    return (
      <span
        className={cn('inline-flex items-center gap-1.5 text-[10.5px] font-semibold', check ? 'text-attention-700' : 'text-assist-700')}
        title={`Read by the AI · ${Math.round(c * 100)}% sure${why.length ? ` · ${why.join(' · ')}` : ''}${check ? ' · check it against the contract' : ''}`}
        data-testid={`field-source-${f.key}`}
      >
        <AssistMark confidence={level} />
        {check ? 'Check' : 'AI'}
      </span>
    )
  }
  if (f.source === 'calculated' && !f.verifiedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-500" title="Worked out from the effective date and the initial term. A stated or edited date replaces it." data-testid={`field-source-${f.key}`}>
        <Calculator className="size-3" /> Calculated
      </span>
    )
  }
  if (f.source === 'ai' || f.source === 'calculated') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-brand-700" title="Checked by a person" data-testid={`field-source-${f.key}`}>
        <CircleCheck className="size-3" /> Checked
      </span>
    )
  }
  if (f.source === 'amendment') {
    // G3 — set from an amendment: which one, a click away.
    const label = <><FileDiff className="size-3" /> Amended</>
    return f.fromContract ? (
      <Link
        to={`/contracts/${f.fromContract.id}`}
        className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-700 hover:text-ink-950 hover:underline underline-offset-2"
        title={`Set from ${f.fromContract.title} — a re-analysis won't change it`}
        data-testid={`field-source-${f.key}`}
      >
        {label}
      </Link>
    ) : (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-700" title="Set from an amendment — a re-analysis won't change it" data-testid={`field-source-${f.key}`}>{label}</span>
    )
  }
  if (f.source === 'highlight') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-700" title="Picked from the contract text by a person" data-testid={`field-source-${f.key}`}>
        <TextQuote className="size-3" /> From text
      </span>
    )
  }
  if (f.source === 'variable') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-700" title="Filled in when the contract was drafted from a template — a re-analysis won't change it" data-testid={`field-source-${f.key}`}>
        <FileText className="size-3" /> From template
      </span>
    )
  }
  if (f.source === 'import') {
    // docs/39 A16 — from the spreadsheet the contract was imported with.
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-700" title="From the spreadsheet this contract was imported with — a re-analysis won't change it" data-testid={`field-source-${f.key}`}>
        <FileSpreadsheet className="size-3" /> Imported
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-700" title="Set by a person — a re-analysis won't change it" data-testid={`field-source-${f.key}`}>
      <Pencil className="size-3" /> Edited
    </span>
  )
}

// ─── Editors ──────────────────────────────────────────────────────────────────

const UNITS: DurationUnit[] = ['days', 'weeks', 'months', 'years']

type Draft =
  | { kind: 'text'; text: string }
  | { kind: 'duration'; amount: string; unit: DurationUnit }
  | { kind: 'currency'; amount: string; currency: string }
  | { kind: 'multi'; values: string[] }

function draftFor(f: ContractField): Draft {
  const v = f.value
  if (f.type === 'duration') {
    const d = v && typeof v === 'object' ? v as { value: number; unit: DurationUnit } : null
    return { kind: 'duration', amount: d ? String(d.value) : '', unit: d?.unit ?? 'days' }
  }
  if (f.type === 'currency') {
    const c = v && typeof v === 'object' ? v as { amount: number; currency: string } : null
    return { kind: 'currency', amount: c ? String(c.amount) : '', currency: c?.currency ?? 'USD' }
  }
  if (f.type === 'multiselect') return { kind: 'multi', values: Array.isArray(v) ? v.map(String) : [] }
  if (v === null || v === undefined) return { kind: 'text', text: '' }
  if (f.type === 'boolean') return { kind: 'text', text: v === true ? 'yes' : v === false ? 'no' : String(v) }
  if (f.type === 'parties' && Array.isArray(v)) {
    return { kind: 'text', text: (v as Array<{ name: string; role?: string | null }>).map(p => (p.role ? `${p.name} (${p.role})` : p.name)).join('\n') }
  }
  return { kind: 'text', text: typeof v === 'object' ? JSON.stringify(v) : String(v) }
}

/** The value a draft sends, or undefined while it doesn't read. */
function payloadOf(f: ContractField, d: Draft, dateOrder: DateOrder): { value: unknown; preview: string; error?: string; hint?: string } {
  if (d.kind === 'duration') {
    if (!d.amount.trim()) return { value: null, preview: '—' }
    const n = Number(d.amount)
    if (!Number.isFinite(n) || n < 0) return { value: undefined, preview: '', error: 'Enter a number' }
    const r = parseFieldValue('duration', { value: n, unit: d.unit })
    return r.ok ? { value: r.value, preview: r.display } : { value: undefined, preview: '', error: r.error }
  }
  if (d.kind === 'currency') {
    if (!d.amount.trim()) return { value: null, preview: '—' }
    const r = parseFieldValue('currency', `${d.currency} ${d.amount}`)
    return r.ok ? { value: r.value, preview: r.display } : { value: undefined, preview: '', error: r.error }
  }
  if (d.kind === 'multi') return { value: d.values.length ? d.values : null, preview: d.values.join(', ') || '—' }
  // A11 — read as the API will: "03/04/2025" is 3 April in a day-first org.
  const r = parseFieldValue(f.type, d.text, { options: f.options, dateOrder })
  if (!r.ok) return { value: undefined, preview: '', error: r.error }
  return { value: r.value, preview: r.display, hint: r.ambiguous }
}

/** A typed input for one field's value; also the field picker's, when a highlight sets it (C2). */
export function FieldEditor({ f, saving, onSave, onCancel }: {
  f: ContractField
  saving: boolean
  onSave: (value: unknown) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFor(f))
  const firstInput = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null)
  useEffect(() => { firstInput.current?.focus() }, [])
  const dateOrder = useOrgDateOrder()
  const out = payloadOf(f, draft, dateOrder)
  const save = () => { if (out.value !== undefined && !saving) onSave(out.value) }
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement && !e.metaKey && !e.ctrlKey)) { e.preventDefault(); save() }
  }
  const inputCls = 'h-8 text-[12.5px]'

  let control: React.ReactNode
  if (draft.kind === 'duration') {
    control = (
      <div className="flex gap-1.5">
        <Input ref={firstInput} className={cn(inputCls, 'w-24')} inputMode="decimal" value={draft.amount} placeholder="90"
          onChange={e => setDraft({ ...draft, amount: e.target.value })} onKeyDown={keys} aria-label={`${f.label} amount`} />
        <select className="h-8 rounded-md border border-input bg-card px-2 text-[12.5px]" value={draft.unit}
          onChange={e => setDraft({ ...draft, unit: e.target.value as DurationUnit })} onKeyDown={keys} aria-label={`${f.label} unit`}>
          {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
    )
  } else if (draft.kind === 'currency') {
    control = (
      <div className="flex gap-1.5">
        <Input className={cn(inputCls, 'w-16 uppercase')} maxLength={3} value={draft.currency}
          onChange={e => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} onKeyDown={keys} aria-label={`${f.label} currency`} />
        <Input ref={firstInput} className={cn(inputCls, 'flex-1')} inputMode="decimal" value={draft.amount} placeholder="250,000"
          onChange={e => setDraft({ ...draft, amount: e.target.value })} onKeyDown={keys} aria-label={`${f.label} amount`} />
      </div>
    )
  } else if (draft.kind === 'multi') {
    control = (
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {(f.options ?? []).map(o => (
          <label key={o} className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-950">
            <input type="checkbox" checked={draft.values.includes(o)}
              onChange={e => setDraft({ ...draft, values: e.target.checked ? [...draft.values, o] : draft.values.filter(x => x !== o) })} />
            {o}
          </label>
        ))}
      </div>
    )
  } else if (f.type === 'boolean') {
    control = (
      <div className="inline-flex rounded-md border border-input overflow-hidden" role="radiogroup" aria-label={f.label}>
        {[['yes', 'Yes'], ['no', 'No'], ['', 'Not stated']].map(([v, label]) => (
          <button key={label} type="button" role="radio" aria-checked={draft.text === v}
            className={cn('px-2.5 h-8 text-[12px] border-r border-input last:border-r-0', draft.text === v ? 'bg-ink-950 text-white' : 'bg-card text-ink-700 hover:bg-paper-100')}
            onClick={() => setDraft({ kind: 'text', text: v })} onKeyDown={keys}>
            {label}
          </button>
        ))}
      </div>
    )
  } else if (f.type === 'select') {
    control = (
      <select ref={firstInput} className="h-8 rounded-md border border-input bg-card px-2 text-[12.5px] min-w-[10rem]" value={draft.text}
        onChange={e => setDraft({ kind: 'text', text: e.target.value })} onKeyDown={keys} aria-label={f.label}>
        <option value="">Not stated</option>
        {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  } else if (f.type === 'longtext' || f.type === 'parties') {
    control = (
      <textarea ref={firstInput} rows={f.type === 'parties' ? 3 : 4}
        className="w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-[12.5px] leading-snug focus:outline-none focus:ring-1 focus:ring-ink-950"
        value={draft.text} placeholder={f.type === 'parties' ? 'Acme Inc (Vendor)\nOur Org (Client)' : ''}
        onChange={e => setDraft({ kind: 'text', text: e.target.value })} onKeyDown={keys} aria-label={f.label} />
    )
  } else {
    const placeholder = f.type === 'date' ? '2027-06-30 or 30 June 2027' : f.type === 'number' ? (f.unit ? '30' : '250000') : f.type === 'percentage' ? '5%' : ''
    const input = (
      <Input ref={firstInput} className={cn(inputCls, f.unit && 'w-24')} value={draft.text} placeholder={placeholder}
        onChange={e => setDraft({ kind: 'text', text: e.target.value })} onKeyDown={keys} aria-label={f.label} />
    )
    // A count says what it counts: "30 days", not a bare 30.
    control = f.unit ? <div className="flex items-center gap-2">{input}<span className="text-[12.5px] text-ink-500">{f.unit}</span></div> : input
  }

  return (
    <div className="space-y-1.5" data-testid={`field-editor-${f.key}`}>
      {control}
      <div className="flex items-center gap-2 min-h-[18px]">
        {out.error
          ? <span className="text-[11px] text-risk-700">{out.error}</span>
          : out.hint
            ? <span className="text-[11px] text-attention-700">Reads as {out.preview} · {out.hint}</span>
            // Only when the input will be read differently from how it is written
            // ("thirty (30) days" → 30 days); a choice or an unchanged value needs no echo.
            : draft.kind === 'text' && draft.text.trim() && f.type !== 'boolean' && f.type !== 'select'
                && out.preview.toLowerCase() !== draft.text.trim().toLowerCase()
              ? <span className="text-[11px] text-ink-500">Reads as {out.preview}</span>
              : null}
        <div className="ml-auto flex gap-1.5">
          <Button size="xs" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button size="xs" onClick={save} disabled={saving || out.value === undefined} data-testid={`field-save-${f.key}`}>
            {saving ? <Loader2 className="animate-spin" /> : <Check />} Save
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── What the contract says, when it says different things (A6) ───────────────

const sameReading = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * A long contract read in parts gave different values for the field — a fee
 * in the body and another in a schedule, a notice period a later clause
 * changes. Each reading, with its words: the one that governs is a person's
 * call (a precedence clause, an amendment). The value in use until then is
 * the first in the document.
 */
function Readings({ f, indent, canEdit, busy, onChoose, onKeep, onShowSource }: {
  f: ContractField
  indent: string
  canEdit: boolean
  busy: boolean
  onChoose: (c: FieldCandidate) => void
  onKeep: () => void
  onShowSource?: (f: ContractField) => void
}) {
  return (
    <div className={cn('mt-2 rounded-md border border-attention-200 bg-attention-50 px-3 py-2', indent)} data-testid={`field-readings-${f.key}`}>
      <p className="text-[12px] font-medium text-attention-800">The contract says different things. Which one governs?</p>
      <ul className="mt-1.5 space-y-2">
        {(f.candidates ?? []).map((c, i) => {
          const inUse = sameReading(c.value, f.value)
          return (
            <li key={i} className="flex items-start gap-2" data-testid={`field-reading-${f.key}-${i}`}>
              <span className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', inUse ? 'bg-ink-950' : 'bg-attention-300')} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] leading-snug text-ink-950">
                  <span className="font-semibold">{inUse ? f.display : c.display}</span>
                  {inUse && <span className="ml-1.5 text-[10.5px] text-ink-500">in use</span>}
                  {c.section && <span className="ml-1.5 font-mono text-[10.5px] text-ink-400">{c.section}</span>}
                </p>
                {c.quote && <p className="mt-0.5 text-[11.5px] italic leading-snug text-ink-700 line-clamp-2" title={c.quote}>“{c.quote}”</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {c.quote && onShowSource && (
                  <button type="button" className="p-1 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-attention-100" title="Show in document"
                    aria-label={`Show ${c.display} in the document`} onClick={() => onShowSource({ ...f, quote: c.quote, anchor: null })}
                    data-testid={`field-reading-show-${f.key}-${i}`}>
                    <LocateFixed className="size-3.5" />
                  </button>
                )}
                {canEdit && (inUse ? (
                  <Button size="xs" variant="ghost" disabled={busy} onClick={onKeep} data-testid={`field-reading-keep-${f.key}`}>Keep</Button>
                ) : (
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => onChoose(c)} data-testid={`field-reading-use-${f.key}-${i}`}>Use this</Button>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ─── A row ────────────────────────────────────────────────────────────────────

function FieldRow({ f, compact, canEdit, editing, focused, busy, onEdit, onCancel, onSave, onVerify, onSuggestion, onReassign, onChoose, onShowSource, below }: {
  f: ContractField
  /** The narrow rail beside the document: label above value. */
  compact: boolean
  canEdit: boolean
  editing: boolean
  focused: boolean
  busy: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (value: unknown) => void
  onVerify: () => void
  onSuggestion: (accept: boolean) => void
  onReassign: (to: string) => void
  /** A6 — the reading of it that governs, of those the contract gives. */
  onChoose: (c: FieldCandidate) => void
  onShowSource?: (f: ContractField) => void
  /** Under the value: the counterparty's directory entry (A14). */
  below?: React.ReactNode
}) {
  const [showSource, setShowSource] = useState(false)
  const canShow = !!onShowSource && isPlaced(f) && hasValue(f)
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focused])
  const canVerify = canEdit && (f.source === 'ai' || f.source === 'calculated') && !f.verifiedAt && hasValue(f)
  const indent = compact ? '' : 'ml-[38%]'

  const label = (
    <p className={cn('truncate', compact ? 'text-[11px] text-ink-500 flex-1' : 'text-dense text-ink-500')} title={f.definition ?? f.label}>
      {f.label}{f.required && <span className="text-risk-600" aria-label="required"> *</span>}
    </p>
  )
  const value = editing ? (
    <FieldEditor f={f} saving={busy} onSave={onSave} onCancel={onCancel} />
  ) : (
    <button
      type="button"
      disabled={!canEdit}
      onClick={onEdit}
      className={cn(
        'block w-full text-left text-[13px] leading-snug rounded-sm -mx-1 px-1',
        hasValue(f) ? 'text-ink-950 font-medium' : 'text-ink-400',
        canEdit && 'hover:bg-paper-100 cursor-text',
        f.type === 'longtext' ? 'line-clamp-3' : 'truncate',
      )}
      title={canEdit ? 'Click to edit' : undefined}
      data-testid={`field-value-${f.key}`}
    >
      {hasValue(f) ? f.display : canEdit ? 'Add a value' : '—'}
    </button>
  )
  const status = !editing && (
    <div className={cn('flex items-center gap-2 justify-end', !compact && 'pt-0.5 min-w-[7.5rem]')}>
      <SourceMark f={f} />
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {canShow && (
          <button type="button" className="p-1 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" title="Show in document"
            onClick={() => onShowSource!(f)} data-testid={`field-show-${f.key}`}>
            <LocateFixed className="size-3.5" />
          </button>
        )}
        {f.quote && (
          <button type="button" className="p-1 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" title="Show the quote"
            onClick={() => setShowSource(s => !s)} aria-expanded={showSource} data-testid={`field-quote-toggle-${f.key}`}>
            <Quote className="size-3.5" />
          </button>
        )}
        {canVerify && (
          <button type="button" className="p-1 rounded-sm text-ink-400 hover:text-brand-700 hover:bg-brand-50" title="The AI got it right"
            onClick={onVerify} disabled={busy} data-testid={`field-verify-${f.key}`}>
            <Check className="size-3.5" />
          </button>
        )}
        {canEdit && (
          <button type="button" className="p-1 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" title="Edit"
            onClick={onEdit} data-testid={`field-edit-${f.key}`}>
            <Pencil className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div
      ref={rowRef}
      className={cn('group transition-colors', compact ? '-mx-5 px-5 py-2' : 'px-5 py-2.5', focused ? 'bg-attention-50' : 'hover:bg-paper-50')}
      data-testid={`field-row-${f.key}`}
    >
      {compact ? (
        <>
          <div className="flex items-center gap-2 min-h-[22px]">{label}{status}</div>
          <div className="mt-0.5">{value}</div>
          {!editing && below}
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,38%)_minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0 pt-0.5">{label}</div>
          <div className="min-w-0">{value}{!editing && below}</div>
          {status}
        </div>
      )}

      {showSource && f.quote && !editing && (
        <div className={cn('mt-2', indent)}>
          <blockquote className="border-l-2 border-paper-300 pl-3 text-[12px] italic text-ink-700" data-testid={`field-quote-${f.key}`}>
            “{f.quote}”{f.section && <span className="not-italic text-[10.5px] font-mono text-ink-400 ml-2">{f.section}</span>}
          </blockquote>
          {canShow ? (
            <button type="button" className="mt-1 ml-3 inline-flex items-center gap-1 text-[11.5px] text-ink-500 hover:text-ink-950 underline-offset-2 hover:underline"
              onClick={() => onShowSource!(f)}>
              <LocateFixed className="size-3" /> Show in document
            </button>
          ) : isGone(f) ? (
            <p className="mt-1 ml-3 text-[11.5px] text-attention-700" data-testid={`field-quote-gone-${f.key}`}>
              These words aren't in the current version. Check the value still holds.
            </p>
          ) : underTheirChanges(f) ? (
            <p className="mt-1 ml-3 text-[11.5px] text-ink-500" data-testid={`field-quote-agreed-${f.key}`}>
              The agreed wording. The other side's tracked changes replace it in the document.
            </p>
          ) : f.anchor?.exhibit && (
            <p className="mt-1 ml-3 inline-flex items-center gap-1 text-[11.5px] text-ink-500" data-testid={`field-quote-exhibit-${f.key}`}>
              <Paperclip className="size-3" /> From the exhibit “{f.anchor.exhibit.label}”
            </p>
          )}
        </div>
      )}

      {disagrees(f) && !editing && (
        <Readings f={f} indent={indent} canEdit={canEdit} busy={busy} onChoose={onChoose} onKeep={onVerify} onShowSource={onShowSource} />
      )}

      {f.suggestion && !editing && (
        <div className={cn('mt-2 rounded-md border border-assist-200 bg-assist-50 px-3 py-2', indent)} data-testid={`field-suggestion-${f.key}`}>
          <div className="flex items-start gap-2">
            <AssistMark className="mt-1.5" confidence={(f.suggestion.confidence ?? 0.8) >= 0.9 ? 'high' : (f.suggestion.confidence ?? 0.8) >= CHECK_BELOW ? 'medium' : 'low'} />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-assist-900">
                {f.suggestion.reason === 'proposed' ? (
                  // A9 — the other side's tracked changes, not accepted.
                  f.suggestion.display
                    ? <>Their tracked changes propose <span className="font-semibold">{f.suggestion.display}</span>. The agreed value stays until you choose.</>
                    : <>Their tracked changes take this out. The agreed value stays until you choose.</>
                ) : (
                  <>
                    {f.suggestion.reason === 'edited' ? 'Since the edit, the contract reads ' : 'A new analysis reads '}
                    <span className="font-semibold">{f.suggestion.display}</span>
                    {f.source !== 'ai' || f.verifiedAt || f.suggestion.reason === 'edited' ? ' — the current value stays until you choose.' : '.'}
                  </>
                )}
              </p>
              {f.suggestion.quote && <p className="text-[11.5px] italic text-assist-700 mt-0.5 line-clamp-2">“{f.suggestion.quote}”</p>}
            </div>
          </div>
          {canEdit && (
            <div className="flex flex-wrap justify-end gap-1.5 mt-2">
              <Button size="xs" variant="ghost" onClick={() => onSuggestion(false)} disabled={busy} data-testid={`field-suggestion-keep-${f.key}`}>Keep current</Button>
              <Button size="xs" variant="assistOutline" onClick={() => onSuggestion(true)} disabled={busy} data-testid={`field-suggestion-use-${f.key}`}>
                <AssistMark /> {f.suggestion.display ? `Use ${f.suggestion.display}` : 'Clear the value'}
              </Button>
            </div>
          )}
        </div>
      )}

      {f.legacy && hasValue(f) && !editing && (
        <div className={cn('mt-2 rounded-md border border-attention-200 bg-attention-50 px-3 py-2', indent)} data-testid={`field-reassign-${f.key}`}>
          <p className="text-[12px] text-ink-950 flex items-start gap-1.5">
            <AlertTriangle className="size-3.5 mt-0.5 text-attention-600 shrink-0" />
            <span>Which notice is this? It was found before the AI told the two apart, and only the notice to stop a renewal sets the opt-out deadline.</span>
          </p>
          {canEdit && (
            <div className="flex flex-wrap justify-end gap-1.5 mt-2">
              <Button size="xs" variant="outline" onClick={() => onReassign('terminationNotice')} disabled={busy} data-testid={`field-reassign-termination-${f.key}`}>
                Notice to end early
              </Button>
              <Button size="xs" onClick={() => onReassign('nonRenewalNotice')} disabled={busy} data-testid={`field-reassign-nonrenewal-${f.key}`}>
                Notice to stop renewal
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── The panel ────────────────────────────────────────────────────────────────

export function FieldsPanel({ contractId, canEdit, variant = 'card', onShowSource }: {
  contractId: string
  canEdit: boolean
  /** card — a panel of its own; rail — inside a rail section beside the document. */
  variant?: 'card' | 'rail'
  /** Highlight a value's passage in the document (B2). */
  onShowSource?: (f: ContractField) => void
}) {
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const focusKey = params.get('field')
  const compact = variant === 'rail'
  const [editing, setEditing] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [showEmpty, setShowEmpty] = useState(false)
  const [onlyToCheck, setOnlyToCheck] = useState(false)
  // A8 — the AI's counterparty a person just replaced: was it one of ours?
  const [replacedCounterparty, setReplacedCounterparty] = useState<string | null>(null)

  const queryKey = ['contract-fields', contractId]
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<FieldsResponse>(`/contracts/${contractId}/fields`)).data,
  })

  const afterWrite = (field: ContractField, message?: string) => {
    qc.setQueryData<FieldsResponse>(queryKey, prev => prev && ({ ...prev, fields: prev.fields.map(x => (x.key === field.key ? field : x)) }))
    qc.invalidateQueries({ queryKey })
    qc.invalidateQueries({ queryKey: ['contract', contractId] })
    qc.invalidateQueries({ queryKey: ['review-queue'] })
    if (field.key === 'counterpartyName') qc.invalidateQueries({ queryKey: counterpartyKey(contractId) })
    if (message) toast.success(message)
  }
  const run = useMutation({
    mutationFn: async (a: { key: string; kind: 'set' | 'verify' | 'suggestion' | 'reassign'; body?: unknown }) => {
      // Paths written out whole, so the route-table test (Y3) can check each one.
      const key = encodeURIComponent(a.key)
      const res = a.kind === 'set' ? await api.put(`/contracts/${contractId}/fields/${key}`, a.body)
        : a.kind === 'verify' ? await api.post(`/contracts/${contractId}/fields/${key}/verify`)
        : a.kind === 'suggestion' ? await api.post(`/contracts/${contractId}/fields/${key}/suggestion`, a.body)
        : await api.post(`/contracts/${contractId}/fields/${key}/reassign`, a.body)
      return res.data as { field: ContractField; statusChange?: { from: string; to: string } }
    },
    onMutate: a => {
      setBusyKey(a.key)
      return { before: data?.fields.find(x => x.key === a.key) }
    },
    onSuccess: (r, a, ctx) => {
      const before = ctx?.before
      if (a.key === 'counterpartyName' && a.kind === 'set' && before?.source === 'ai' && hasValue(before) && String(before.value) !== String(r.field.value ?? '')) {
        setReplacedCounterparty(String(before.value))
      }
      if (a.kind === 'reassign') {
        qc.invalidateQueries({ queryKey })
        qc.invalidateQueries({ queryKey: ['contract', contractId] })
        toast.success(`Saved as the ${r.field.label.toLowerCase()}`)
        return
      }
      afterWrite(r.field, r.statusChange ? `Saved — the contract went back to ${r.statusChange.to.toLowerCase()} for re-approval` : undefined)
      if (a.kind === 'set') setEditing(null)
    },
    onError: err => toast.error("Couldn't save", { description: errorDetail(err) }),
    onSettled: () => setBusyKey(null),
  })

  // B3 — Check all: every AI value still unchecked, once someone has read them against the contract.
  const [confirmAll, setConfirmAll] = useState(false)
  const verifyAll = useMutation({
    mutationFn: async () => (await api.post<{ verified: string[] }>(`/contracts/${contractId}/fields/verify-all`)).data,
    onSuccess: r => {
      setConfirmAll(false)
      qc.invalidateQueries({ queryKey })
      qc.invalidateQueries({ queryKey: ['contract', contractId] })
      qc.invalidateQueries({ queryKey: ['review-queue'] })
      toast.success(r.verified.length ? `Checked ${r.verified.length} value${r.verified.length === 1 ? '' : 's'}` : 'Nothing left to check')
    },
    onError: err => toast.error("Couldn't check them", { description: errorDetail(err) }),
  })

  const fields = data?.fields ?? []
  const toCheck = fields.filter(needsCheck).length
  const filled = fields.filter(hasValue).length
  const groups = useMemo(() => {
    const shown = fields.filter(f =>
      (onlyToCheck ? needsCheck(f) : showEmpty || hasValue(f) || f.required || f.suggestion || f.key === focusKey || f.key === editing))
    return GROUP_ORDER
      .map(g => ({ key: g, label: data?.groups[g] ?? g, fields: shown.filter(f => f.group === g) }))
      .filter(g => g.fields.length > 0)
  }, [fields, showEmpty, onlyToCheck, data?.groups, focusKey, editing])
  const emptyCount = fields.filter(f => !hasValue(f) && !f.legacy).length

  const controls = (
    <>
      {toCheck > 0 && (
        <button type="button"
          onClick={() => setOnlyToCheck(v => !v)}
          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold border',
            onlyToCheck ? 'bg-attention-600 border-attention-600 text-white' : 'bg-attention-50 border-attention-200 text-attention-700 hover:bg-attention-100')}
          aria-pressed={onlyToCheck}
          data-testid="fields-to-check">
          {toCheck} to check
        </button>
      )}
      <div className="ml-auto">
        {!onlyToCheck && emptyCount > 0 && (
          <button type="button" className="text-[11px] text-ink-500 hover:text-ink-950 underline-offset-2 hover:underline"
            onClick={() => setShowEmpty(v => !v)} data-testid="fields-show-empty">
            {showEmpty ? 'Hide empty fields' : `Show ${emptyCount} empty`}
          </button>
        )}
      </div>
    </>
  )

  const body = isLoading ? (
    <div className={cn('flex items-center gap-2 text-dense text-ink-500', compact ? 'py-2' : 'px-5 py-6')}><Loader2 className="size-3.5 animate-spin" /> Loading fields…</div>
  ) : error ? (
    <div className={cn('text-dense text-risk-700', compact ? 'py-2' : 'px-5 py-6')}>Couldn't load the fields: {errorDetail(error)}</div>
  ) : groups.length === 0 ? (
    <div className={cn('text-dense text-ink-500', compact ? 'py-2' : 'px-5 py-6')}>
      {onlyToCheck ? 'Nothing left to check.' : 'No values yet.'}
      {!onlyToCheck && canEdit && emptyCount > 0 && (
        <button type="button" className="ml-1 text-ink-950 underline underline-offset-2" onClick={() => setShowEmpty(true)}>Add one</button>
      )}
    </div>
  ) : (
    groups.map(g => (
      <section key={g.key} aria-label={g.label} data-testid={`fields-group-${g.key}`}>
        <h4 className={cn('pt-3 pb-1 text-[10.5px] uppercase tracking-[0.08em] font-semibold text-ink-400', !compact && 'px-5')}>{g.label}</h4>
        <div className="divide-y divide-paper-100">
          {g.fields.map(f => (
            <FieldRow
              key={f.key}
              f={f}
              compact={compact}
              canEdit={canEdit}
              editing={editing === f.key}
              focused={focusKey === f.key}
              busy={busyKey === f.key}
              onEdit={() => setEditing(f.key)}
              onCancel={() => setEditing(null)}
              onSave={value => run.mutate({ key: f.key, kind: 'set', body: { value } })}
              onVerify={() => run.mutate({ key: f.key, kind: 'verify' })}
              onSuggestion={accept => run.mutate({ key: f.key, kind: 'suggestion', body: { action: accept ? 'accept' : 'dismiss' } })}
              onReassign={to => run.mutate({ key: f.key, kind: 'reassign', body: { to } })}
              // A6 — a reading with its words is picked from the text; the words go with it.
              onChoose={c => run.mutate({ key: f.key, kind: 'set', body: c.quote ? { value: c.value, source: 'highlight', quote: c.quote } : { value: c.value } })}
              onShowSource={onShowSource}
              below={f.key === 'counterpartyName' && hasValue(f) ? (
                <CounterpartyLink
                  contractId={contractId}
                  canEdit={canEdit}
                  replaced={replacedCounterparty}
                  onReplacedSeen={() => setReplacedCounterparty(null)}
                  onUseParty={name => run.mutate({ key: f.key, kind: 'set', body: { value: name } }, {
                    onSuccess: () => {
                      // The address the AI read went with the wrong party.
                      const address = fields.find(x => x.key === 'counterpartyAddress')
                      if (address && address.source === 'ai' && hasValue(address)) {
                        toast.info('Check the counterparty address', { description: `It was read with ${String(f.value)} as the counterparty.`, durationMs: 6000 })
                      }
                    },
                  })}
                />
              ) : undefined}
            />
          ))}
        </div>
      </section>
    ))
  )

  const unchecked = data?.verification ? data.verification.filled - data.verification.checked : 0
  // What "Check all" would mark: the AI's values nothing is waiting on.
  const checkableFields = fields.filter(f => (f.source === 'ai' || f.source === 'calculated') && !f.verifiedAt && hasValue(f) && !f.suggestion && !disagrees(f) && !f.legacy)
  const checkable = checkableFields.length
  const flagged = checkableFields.filter(needsCheck).length
  const verificationBar = data?.verification && data.verification.filled > 0 && (
    <VerificationBar
      verification={data.verification}
      compact={compact}
      onCheckAll={canEdit && checkable > 0 ? () => setConfirmAll(true) : undefined}
      busy={verifyAll.isPending}
    />
  )
  const confirmDialog = (
    <ConfirmDialog
      open={confirmAll}
      title={`Mark ${checkable} of the AI's value${checkable === 1 ? '' : 's'} as checked?`}
      body={<>
        They'll show as checked by you, and leave the Review Queue. Do this once you've read them against the contract.
        {flagged > 0 && <> <span className="font-semibold text-attention-700">{flagged} {flagged === 1 ? 'is' : 'are'} marked Check</span> — the AI was unsure, or the words changed: look at {flagged === 1 ? 'it' : 'those'} first.</>}
        {unchecked > checkable && <> {unchecked - checkable} with something to decide — a second reading, or a notice whose type isn't known — stay for you to settle.</>}
      </>}
      confirmLabel={`Check ${checkable}`}
      tone="default"
      isPending={verifyAll.isPending}
      onConfirm={() => verifyAll.mutate()}
      onCancel={() => setConfirmAll(false)}
      testId="fields-check-all-dialog"
    />
  )

  if (compact) {
    return (
      <div data-testid="fields-panel">
        {verificationBar}
        {confirmDialog}
        {(toCheck > 0 || emptyCount > 0) && <div className="flex items-center gap-2 pb-1">{controls}</div>}
        {/* G1 — what the last analysis changed, and its undo. */}
        <div className="pb-1 empty:hidden"><AnalysisChanges contractId={contractId} /></div>
        {body}
      </div>
    )
  }
  return (
    <div className="bg-card rounded-card border border-paper-200 shadow-e1" data-testid="fields-panel">
      <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-paper-200">
        <h3 className="text-section text-ink-950">Fields</h3>
        {!isLoading && <span className="text-dense text-ink-500 tabular-nums">{filled} filled</span>}
        {controls}
      </div>
      {verificationBar && <div className="px-5 pt-3">{verificationBar}</div>}
      {confirmDialog}
      <div className="px-5 pt-3 empty:hidden"><AnalysisChanges contractId={contractId} /></div>
      {body}
      <div className="h-2" />
    </div>
  )
}

/**
 * B3 — how much of the contract a person set or checked: Verified, Partly
 * verified or Unverified, what someone handed the data needs to know.
 */
function VerificationBar({ verification: v, compact, onCheckAll, busy }: {
  verification: { state: VerificationState; checked: number; filled: number }
  compact: boolean
  onCheckAll?: () => void
  busy: boolean
}) {
  const pct = v.filled ? Math.round((v.checked / v.filled) * 100) : 0
  return (
    <div className={cn('flex items-center gap-2', compact ? 'pb-2' : '')} data-testid="fields-verification" data-state={v.state}>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] text-ink-700 flex items-center gap-1.5">
          {v.state === 'verified'
            ? <CircleCheck className="size-3.5 text-brand-700 shrink-0" />
            : <span className="size-3.5 rounded-full border border-ink-300 shrink-0" aria-hidden />}
          <span className={cn('font-semibold whitespace-nowrap shrink-0', v.state === 'verified' ? 'text-brand-700' : 'text-ink-950')}>{VERIFICATION_LABELS[v.state]}</span>
          <span className="text-ink-500 tabular-nums truncate" title={`${v.checked} of the ${v.filled} values it holds were set or checked by a person`}>
            · {v.checked} of {v.filled}{compact ? '' : ' checked by a person'}
          </span>
        </p>
        <div className="mt-1 h-1 rounded-full bg-paper-200 overflow-hidden" aria-hidden>
          <div className="h-full bg-brand-700/70" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {onCheckAll && (
        <Button size="xs" variant="outline" onClick={onCheckAll} disabled={busy} data-testid="fields-check-all">
          <Check /> Check all
        </Button>
      )}
    </div>
  )
}
