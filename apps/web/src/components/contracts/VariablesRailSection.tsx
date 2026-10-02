/**
 * docs/39 H2 — a draft's Variables panel: the terms its template filled in,
 * each changed once — everywhere it appears in the text, and in the field it
 * fills.
 *
 * Ironclad regenerates a workflow's document from its launch form ("Edit
 * Information"). Here the draft's own text keeps its terms marked (the
 * Variable mark), so a term is changed where it stands — the rest of the
 * draft, edits included, stays as it is — and saved as a version whose note
 * says what changed. A variable whose field now says something else (changed
 * in the Fields panel) offers to bring the two back in step, either way.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, LocateFixed, Pencil } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { noteOf, variableRows, wordsForField, type DraftVariables, type VariableRow } from '@/lib/draft-variables'
import { useOrgDateOrder } from '@/lib/org-date-order'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toaster'
import { setVariableText, variablePlaces } from '@/components/editor/VariableMark'
import { RailSection } from './RailSection'
import { errorDetail, type FieldsResponse } from './FieldsPanel'
import { revealRange, viewOf } from './SourceHighlight'

interface VariableWrite {
  field: { label: string; display: string } | null
  unread?: { key: string; label: string }
  statusChange?: { from: string; to: string }
}

export function VariablesRailSection({ contractId, editor, canEdit, canEditFields, title, canRetitle, focusKey, onFocused, beforeChange, saveDocument }: {
  contractId: string
  editor: Editor | null
  /** May change the document (and it isn't out in Google Docs). */
  canEdit: boolean
  canEditFields: boolean
  /** The contract's title: a blank left in it ("[[provider_name]]") is filled with the variable. */
  title?: string | null
  canRetitle?: boolean
  /** A variable clicked in the document: its row is shown, ready to change. */
  focusKey?: string | null
  onFocused?: () => void
  /** Save edits still waiting (typed in the last seconds) before a variable changes. */
  beforeChange: () => Promise<unknown>
  /** Save the change a variable made, now, as a version with this note; false when there was nothing to save. */
  saveDocument: (note: string) => Promise<boolean>
}) {
  const qc = useQueryClient()
  // The canvas swaps editors when a saved version comes back: a change waits on a save, then uses the one there is.
  const editorRef = useRef(editor)
  editorRef.current = editor
  // The places, read again after every change to the text.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!editor) return
    const on = () => setTick(t => t + 1)
    editor.on('update', on)
    setTick(t => t + 1)
    return () => { editor.off('update', on) }
  }, [editor])
  const places = useMemo(
    // `tick` is the document's change.
    () => (editor && viewOf(editor) ? variablePlaces(editor.state.doc) : []),
    [editor, tick],
  )
  const has = places.length > 0
  // Read again whenever the fields are: one changed in the Fields panel may no longer say what the text does.
  const fields = useQuery({
    queryKey: ['contract-fields', contractId],
    queryFn: async () => (await api.get<FieldsResponse>(`/contracts/${contractId}/fields`)).data,
    enabled: has,
  })
  const { data } = useQuery({
    queryKey: ['contract-variables', contractId, fields.dataUpdatedAt],
    queryFn: async () => (await api.get<DraftVariables>(`/contracts/${contractId}/variables`)).data,
    enabled: has,
    placeholderData: prev => prev,
  })
  const rows = useMemo(() => variableRows(places, data?.variables), [places, data])
  const dateOrder = useOrgDateOrder()

  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  // "Show in document" steps through a variable's places.
  const shown = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!focusKey) return
    if (rows.some(r => r.key === focusKey)) {
      setFocused(focusKey)
      if (canEdit) setEditing(focusKey)
    }
    onFocused?.()
  }, [focusKey])
  useEffect(() => {
    if (!focused) return
    const t = setTimeout(() => setFocused(null), 4000)
    return () => clearTimeout(t)
  }, [focused])

  if (!rows.length) return null

  const show = (row: VariableRow) => {
    const i = (shown.current[row.key] ?? 0) % row.places.length
    const p = row.places[i]
    shown.current[row.key] = i + 1
    revealRange(editor, p.from, p.to)
  }

  /** The field a variable fills, from the words the text now has for it. */
  const writeField = async (row: VariableRow, words: string) =>
    (await api.put<VariableWrite>(`/contracts/${contractId}/variables/${encodeURIComponent(row.key)}`, { text: words })).data

  const change = async (row: VariableRow, text: string) => {
    const words = text.trim()
    if (!words || busy) return
    setBusy(row.key)
    try {
      await beforeChange()
      const current = editorRef.current
      const n = current && viewOf(current) ? setVariableText(current, row.key, words) : 0
      if (!n) throw new Error('It isn’t in the document any more.')
      if (!await saveDocument(noteOf(row.label, words, n))) throw new Error('The document wasn’t saved. Try again, or press ⌘S.')
      setEditing(null)
      const blank = `[[${row.key}]]`
      const retitle = !!canRetitle && !!title?.includes(blank)
      if (retitle) {
        await api.patch(`/contracts/${contractId}`, { title: title!.split(blank).join(words) })
        qc.invalidateQueries({ queryKey: ['contract', contractId] })
        qc.invalidateQueries({ queryKey: ['contract-title', contractId] })
      }
      let description = `${n > 1 ? `Changed in all ${n} places` : 'Changed in the document'}${retitle ? ' and the title' : ''}.`
      // The server knows which field it fills; before it has said, it's asked anyway.
      if (canEditFields && (!row.info || row.info.field)) {
        const r = await writeField(row, words)
        if (r.field) description += ` The ${r.field.label.toLowerCase()} is now ${r.field.display}.`
        else if (r.unread) description += ` The ${r.unread.label.toLowerCase()} field was left as it was: “${words}” doesn’t read as one.`
        if (r.statusChange) description += ` The contract went back to ${r.statusChange.to.toLowerCase()} for re-approval.`
      }
      toast.success(`${row.label} changed`, { description, durationMs: 6000 })
    } catch (err) {
      toast.error(`Couldn’t change ${row.label.toLowerCase()}`, { description: errorDetail(err) })
    } finally {
      setBusy(null)
      qc.invalidateQueries({ queryKey: ['contract-fields', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-variables', contractId] })
      qc.invalidateQueries({ queryKey: ['review-queue'] })
    }
  }

  /** The text is right and the field isn't: the field takes the text's words. */
  const keepText = async (row: VariableRow) => {
    if (busy) return
    setBusy(row.key)
    try {
      const r = await writeField(row, row.text)
      if (r.field) toast.success(`The ${r.field.label.toLowerCase()} is now ${r.field.display}`, { description: 'As the document says.' })
      else if (r.unread) toast.error(`The ${r.unread.label.toLowerCase()} wasn’t changed`, { description: `“${row.text}” doesn’t read as one.` })
    } catch (err) {
      toast.error('Couldn’t change the field', { description: errorDetail(err) })
    } finally {
      setBusy(null)
      qc.invalidateQueries({ queryKey: ['contract-fields', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-variables', contractId] })
    }
  }

  const blanks = rows.filter(r => r.unfilled).length
  return (
    <RailSection title="Variables" defaultOpen count={rows.length}>
      <div data-testid="variables-section">
        <p className="pb-1.5 text-[11px] text-ink-500">
          The terms this draft was made with{data?.template ? <> from <span className="text-ink-700">{data.template.name}</span></> : null}.
          {canEdit && ' Change one here and it changes everywhere it appears.'}
        </p>
        {blanks > 0 && (
          <p className="pb-1 text-[11px] font-medium text-attention-700" data-testid="variables-blanks">
            {blanks === 1 ? '1 still to fill in' : `${blanks} still to fill in`}
          </p>
        )}
        {rows.map(row => (
          <VariableRowView
            key={row.key}
            row={row}
            canEdit={canEdit}
            canEditFields={canEditFields}
            editing={editing === row.key}
            focused={focused === row.key}
            busy={busy === row.key}
            locked={!!busy && busy !== row.key}
            fieldWords={row.info?.field ? wordsForField(row.unfilled ? '' : row.text, row.info.field, dateOrder) : null}
            onEdit={() => setEditing(row.key)}
            onCancel={() => setEditing(null)}
            onChange={text => change(row, text)}
            onShow={() => show(row)}
            onKeepText={() => keepText(row)}
          />
        ))}
      </div>
    </RailSection>
  )
}

function VariableRowView({ row, canEdit, canEditFields, editing, focused, busy, locked, fieldWords, onEdit, onCancel, onChange, onShow, onKeepText }: {
  row: VariableRow
  canEdit: boolean
  canEditFields: boolean
  editing: boolean
  focused: boolean
  busy: boolean
  /** Another variable is changing. */
  locked: boolean
  /** The field's value as the text would write it. */
  fieldWords: string | null
  onEdit: () => void
  onCancel: () => void
  onChange: (text: string) => void
  onShow: () => void
  onKeepText: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focused])
  const field = row.info?.field ?? null
  const n = row.places.length
  const outOfStep = !!field && field.hasValue && !field.inStep
  const meta = [
    n > 1 && `${n} places`,
    field && `Fills the ${field.label.toLowerCase()}`,
  ].filter(Boolean).join(' · ')

  return (
    <div
      ref={ref}
      className={cn('group -mx-5 px-5 py-2 transition-colors', focused ? 'bg-attention-50' : 'hover:bg-paper-50')}
      data-testid={`variable-row-${row.key}`}
    >
      <div className="flex items-center gap-2 min-h-[22px]">
        <p className="flex-1 min-w-0 truncate text-[11px] text-ink-500" title={`{{${row.key}}}`}>{row.label}</p>
        {!editing && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button type="button" className="p-1 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100"
              title={n > 1 ? `Show in document (${n} places)` : 'Show in document'} aria-label={`Show ${row.label} in the document`}
              onClick={onShow} data-testid={`variable-show-${row.key}`}>
              <LocateFixed className="size-3.5" />
            </button>
            {canEdit && (
              <button type="button" className="p-1 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" title="Change"
                aria-label={`Change ${row.label}`} onClick={onEdit} disabled={locked} data-testid={`variable-edit-${row.key}`}>
                <Pencil className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mt-0.5">
        {editing ? (
          <VariableEditor row={row} saving={busy} onSave={onChange} onCancel={onCancel} />
        ) : (
          <button
            type="button"
            disabled={!canEdit || locked}
            onClick={onEdit}
            className={cn(
              'block w-full text-left text-[13px] leading-snug rounded-sm -mx-1 px-1 truncate',
              row.unfilled ? 'text-attention-700' : 'text-ink-950 font-medium',
              canEdit && 'hover:bg-paper-100 cursor-text',
            )}
            title={canEdit ? 'Click to change' : undefined}
            data-testid={`variable-value-${row.key}`}
          >
            {row.unfilled ? (canEdit ? 'Fill in' : 'Not filled in') : row.text}
          </button>
        )}
      </div>
      {!editing && (meta || row.differs > 0) && (
        <p className="mt-0.5 text-[11px] text-ink-400">
          {meta}
          {row.differs > 0 && (
            <span className="text-attention-700" data-testid={`variable-differs-${row.key}`}>
              {meta && ' · '}{row.differs === 1 ? '1 place reads differently' : `${row.differs} places read differently`}
            </span>
          )}
        </p>
      )}
      {!editing && outOfStep && (
        <div className="mt-1.5 rounded-md border border-attention-200 bg-attention-50 px-2.5 py-1.5" data-testid={`variable-out-of-step-${row.key}`}>
          <p className="text-[11.5px] text-attention-800 leading-snug">
            The {field!.label.toLowerCase()} field {row.unfilled ? 'has' : 'says'} <span className="font-semibold">{field!.display}</span>
            {row.unfilled ? '.' : ', not what the document says.'}
          </p>
          {canEdit && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Button size="xs" variant="outline" disabled={busy || locked || !fieldWords} onClick={() => fieldWords && onChange(fieldWords)}
                title={fieldWords ?? undefined} data-testid={`variable-use-field-${row.key}`}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                Put “{fieldWords && fieldWords.length > 24 ? `${fieldWords.slice(0, 23)}…` : fieldWords}” in the document
              </Button>
              {!row.unfilled && canEditFields && (
                <Button size="xs" variant="ghost" disabled={busy || locked} onClick={onKeepText} data-testid={`variable-keep-text-${row.key}`}>
                  Keep the document’s
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function VariableEditor({ row, saving, onSave, onCancel }: {
  row: VariableRow
  saving: boolean
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(row.unfilled ? '' : row.text)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  const words = text.trim()
  // The same words change nothing, unless some places read differently.
  const same = words === row.text && row.differs === 0
  const save = () => { if (words && !same && !saving) onSave(words) }
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    if (e.key === 'Enter') { e.preventDefault(); save() }
  }
  const n = row.places.length
  const field = row.info?.field
  const type = row.info?.type
  return (
    <div className="space-y-1.5" data-testid={`variable-editor-${row.key}`}>
      <Input ref={input} className="h-8 text-[12.5px]" value={text} onChange={e => setText(e.target.value)} onKeyDown={keys}
        aria-label={row.label} placeholder={type === 'date' ? 'e.g. 1 June 2027' : type === 'number' ? 'e.g. 25,000' : ''}
        data-testid={`variable-input-${row.key}`} />
      <div className="flex items-center gap-2 min-h-[18px]">
        <span className="text-[11px] text-ink-500 leading-snug">
          {n > 1 ? `In all ${n} places` : 'In the document'}{field ? ` and the ${field.label.toLowerCase()}` : ''}
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button size="xs" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button size="xs" onClick={save} disabled={saving || !words || same} data-testid={`variable-save-${row.key}`}>
            {saving ? <Loader2 className="animate-spin" /> : <Check />} Change
          </Button>
        </div>
      </div>
    </div>
  )
}
