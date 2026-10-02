/**
 * docs/39 D6 — a diligence room's own columns: "Add column" (a question asked
 * of every document, or any field the contracts hold), each column's header
 * saying where its answers stand, and each cell with the words its answer
 * came from — confirmed, corrected or found in the contract from there.
 */
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, CircleCheck, Loader2, MoreHorizontal, Pencil, Plus, RotateCw, Search, TextQuote, Trash2, Undo2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover } from '@/components/ui/popover'
import { AssistMark } from '@/components/ui/assist'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/common/Toaster'
import { catalogSections, typesOf, useFieldCatalog } from '@/lib/field-catalog'
import { FieldEditor, errorDetail, type ContractField } from '@/components/contracts/FieldsPanel'
import {
  ANSWER_TYPES, LOW_CONFIDENCE, answerSource, choicesFrom, guessAnswerType, labelFromQuestion, runUnderWay,
  type AnswerType, type RoomCell, type RoomColumnView,
} from '@/lib/room-columns'

const MAX_COLUMNS = 20
const money = (usd: number) => (usd < 0.01 ? 'under $0.01' : usd < 10 ? `about $${usd.toFixed(2)}` : `about $${Math.round(usd)}`)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Everything the room's table shows is refetched after a column changes. */
function useRoomRefresh(roomId: string) {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['diligence-results', roomId] })
}

// ─── Add / edit a column ──────────────────────────────────────────────────────

export function AddColumnButton({ roomId, columns }: { roomId: string; columns: RoomColumnView[] }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const full = columns.length >= MAX_COLUMNS
  return (
    <>
      <Button ref={anchorRef} variant="outline" size="xs" onClick={() => setOpen(o => !o)} aria-expanded={open} disabled={full}
        title={full ? `A room holds up to ${MAX_COLUMNS} columns of its own` : undefined}
        data-testid="add-column-btn">
        <Plus /> Add column
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchorRef.current} align="end" label="Add a column" width={400}>
        <ColumnForm roomId={roomId} columns={columns} onDone={() => setOpen(false)} />
      </Popover>
    </>
  )
}

function ColumnForm({ roomId, columns, column, onDone }: {
  roomId: string
  columns: RoomColumnView[]
  /** Editing this question, rather than adding a column. */
  column?: RoomColumnView
  onDone: () => void
}) {
  const refresh = useRoomRefresh(roomId)
  const editing = !!column
  const [tab, setTab] = useState<'question' | 'field'>('question')
  const [question, setQuestion] = useState(column?.question ?? '')
  const [answerType, setAnswerType] = useState<AnswerType>(column?.answerType ?? 'boolean')
  // The form follows the question as it's typed, until someone picks one.
  const [typePicked, setTypePicked] = useState(editing)
  const [label, setLabel] = useState(column?.label ?? '')
  const [choices, setChoices] = useState((column?.options ?? []).join(', '))
  const [search, setSearch] = useState('')

  const estimate = useQuery({
    queryKey: ['diligence-ask-estimate', roomId],
    queryFn: async () => (await api.get<{ documents: number; usd: number; byok: boolean }>(`/diligence/${roomId}/ask-estimate`)).data,
    enabled: tab === 'question',
    staleTime: 30_000,
  })
  const catalog = useFieldCatalog()
  const shown = new Set(columns.filter(c => c.kind === 'field').map(c => c.key))

  const options = answerType === 'select' ? choicesFrom(choices) : []
  const reworded = editing && question.trim() !== (column!.question ?? '')
  const reformed = editing && (answerType !== column!.answerType || JSON.stringify(options) !== JSON.stringify(column!.options ?? []))
  const problem = question.trim().length < 3 ? 'Type the question to ask.'
    : answerType === 'select' && options.length < 2 ? 'Give at least two choices, separated by commas.' : null

  const save = useMutation({
    mutationFn: async () => {
      const body = { question: question.trim(), answerType, ...(label.trim() && { label: label.trim() }), ...(answerType === 'select' && { options }) }
      if (editing) return (await api.patch(`/diligence/${roomId}/columns/${column!.id}`, body)).data as { asked: boolean }
      return (await api.post(`/diligence/${roomId}/columns`, { kind: 'question', ...body })).data
    },
    onSuccess: (r: { asked?: boolean }) => {
      refresh()
      const n = estimate.data?.documents ?? 0
      if (!editing) toast.success('Column added', { description: n ? `Asking ${plural(n, 'document')} — answers fill in as they come.` : 'Each document is asked once it has been read.' })
      else if (r.asked) toast.success('Asking the new question', { description: 'Answers fill in as they come.' })
      onDone()
    },
    onError: err => toast.error(editing ? "Couldn't change the question" : "Couldn't add the column", { description: errorDetail(err) }),
  })
  const addField = useMutation({
    mutationFn: async (key: string) => (await api.post(`/diligence/${roomId}/columns`, { kind: 'field', key })).data,
    onSuccess: () => { refresh(); onDone() },
    onError: err => toast.error("Couldn't add the column", { description: errorDetail(err) }),
  })

  const sections = catalogSections(catalog.data ?? [], search)
  const fieldCls = 'w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ink-950'
  const eyebrow = 'block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 mb-1'

  return (
    <div data-testid="column-form">
      {!editing && (
        <div className="flex border-b border-paper-100 px-2 pt-2" role="tablist">
          {([['question', 'Ask a question'], ['field', 'Show a field']] as const).map(([t, name]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={cn('px-3 pb-2 text-[12.5px] font-medium border-b-2 -mb-px', tab === t ? 'border-ink-950 text-ink-950' : 'border-transparent text-ink-500 hover:text-ink-950')}
              data-testid={`column-tab-${t}`}>
              {name}
            </button>
          ))}
        </div>
      )}

      {tab === 'question' ? (
        <form className="p-3 space-y-3" onSubmit={e => { e.preventDefault(); if (!problem && !save.isPending) save.mutate() }}>
          <label className="block">
            <span className={eyebrow}>{editing ? 'Question' : 'Ask every document'}</span>
            <textarea
              autoFocus rows={2} value={question} maxLength={1000}
              onChange={e => { setQuestion(e.target.value); if (!typePicked) setAnswerType(guessAnswerType(e.target.value)) }}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit() }}
              placeholder="e.g. Can the supplier assign the agreement without our consent?"
              className={cn(fieldCls, 'leading-snug resize-none')} data-testid="column-question"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className={eyebrow}>Answer as</span>
              <select value={answerType} onChange={e => { setAnswerType(e.target.value as AnswerType); setTypePicked(true) }}
                className={cn(fieldCls, 'h-8 py-0')} data-testid="column-answer-type">
                {ANSWER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={eyebrow}>Column name</span>
              <Input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} className="h-8 text-[12.5px]"
                placeholder={labelFromQuestion(question) || 'Named from the question'} data-testid="column-label" />
            </label>
          </div>
          {answerType === 'select' && (
            <label className="block">
              <span className={eyebrow}>Choices</span>
              <Input value={choices} onChange={e => setChoices(e.target.value)} className="h-8 text-[12.5px]"
                placeholder="Allowed, Needs consent, Not allowed" data-testid="column-choices" />
              <span className="mt-1 block text-[11px] text-ink-500">Separate them with commas. The AI picks one for each document.</span>
            </label>
          )}
          {editing && (reworded || reformed) && (
            <p className="text-[11.5px] text-attention-700 bg-attention-50 border border-attention-200 rounded-md px-2.5 py-1.5">
              {reformed
                ? 'Changing the form of the answer clears every answer — people’s too — and asks again.'
                : 'Every document is asked the new question. Answers people gave or confirmed stay.'}
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <p className="flex-1 text-[11px] text-ink-500 leading-snug" data-testid="column-estimate">
              {problem && question.trim() ? problem
                // Renaming asks nothing.
                : editing && !reworded && !reformed ? ' '
                : estimate.data ? (estimate.data.documents
                  ? <>Asks the AI about {plural(estimate.data.documents, 'document')} · {estimate.data.byok ? 'on your own AI key' : money(estimate.data.usd)}</>
                  : 'Each document is asked once it has been read.')
                  : ' '}
            </p>
            <Button type="button" variant="ghost" size="xs" onClick={onDone}>Cancel</Button>
            <Button type="submit" size="xs" disabled={!!problem || save.isPending || (editing && !reworded && !reformed && label.trim() === column!.label)} data-testid="column-save">
              {save.isPending && <Loader2 className="animate-spin" />}
              {editing ? (reworded || reformed ? 'Save and ask again' : 'Save') : 'Add and ask'}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <div className="relative p-2 border-b border-paper-100">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-3.5 text-ink-400" />
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a field" aria-label="Find a field"
              className="h-8 w-full rounded-md border border-input bg-card pl-7 pr-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ink-950" />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {catalog.isLoading && <p className="px-3 py-2 text-[12px] text-ink-500"><Loader2 className="inline size-3.5 animate-spin mr-1.5" />Loading fields…</p>}
            {!catalog.isLoading && sections.length === 0 && <p className="px-3 py-2 text-[12px] text-ink-500">No field by that name.</p>}
            {sections.map(s => (
              <div key={s.title} className="py-1">
                <p className="px-3 pb-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-400">{s.title}</p>
                {s.fields.map(f => {
                  const on = shown.has(f.key)
                  return (
                    <button key={f.key} type="button" disabled={on || addField.isPending} onClick={() => addField.mutate(f.key)}
                      className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-950', on ? 'opacity-50' : 'hover:bg-paper-100')}
                      data-testid={`column-field-${f.key}`}>
                      <span className="truncate">{f.label}</span>
                      <span className="ml-auto shrink-0 text-[10.5px] text-ink-400">{on ? 'shown' : typesOf(f) ?? ''}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <p className="px-3 py-2 border-t border-paper-100 text-[11px] text-ink-500">
            Shows each contract’s value for the field, with the words it came from. Nothing is asked until you look for the empty ones.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── A column's header ────────────────────────────────────────────────────────

export function ColumnHeader({ roomId, column, canEdit }: { roomId: string; column: RoomColumnView; canEdit: boolean }) {
  const refresh = useRoomRefresh(roomId)
  const [editOpen, setEditOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const headRef = useRef<HTMLDivElement>(null)
  const run = column.run
  const under = runUnderWay(run)
  const c = column.counts

  const ask = useMutation({
    mutationFn: async (scope: 'missing' | 'all') => (await api.post(`/diligence/${roomId}/columns/${column.id}/run`, { scope })).data,
    onSuccess: () => refresh(),
    onError: err => toast.error("Couldn't ask", { description: errorDetail(err) }),
  })
  const undo = useMutation({
    mutationFn: async () => (await api.post(`/diligence/${roomId}/columns/${column.id}/undo`)).data as { restored: number; skipped: number },
    onSuccess: r => {
      refresh()
      toast.success(`Took back ${plural(r.restored, 'value')}`, { description: r.skipped ? `${plural(r.skipped, 'value')} changed since — left as it is.` : undefined })
    },
    onError: err => toast.error("Couldn't undo", { description: errorDetail(err) }),
  })
  const remove = useMutation({
    mutationFn: async () => api.delete(`/diligence/${roomId}/columns/${column.id}`),
    onSuccess: () => { refresh(); toast.success(`Removed “${column.label}”`) },
    onError: err => toast.error("Couldn't remove the column", { description: errorDetail(err) }),
  })

  const isQuestion = column.kind === 'question'
  const toAsk = c.unasked + c.failed
  // A field column that has looked for its empty cells says what it found, not "look for it" again.
  const looked = !isQuestion && run?.status === 'DONE'
  const filled = looked && !!run!.fieldRunId && run!.answered > 0
  const link = 'underline underline-offset-2 hover:text-ink-950 disabled:opacity-50'

  let status: React.ReactNode = null
  if (under) {
    status = (
      <span className="inline-flex items-center gap-1 text-info-700">
        <Loader2 className="size-3 animate-spin" />
        {isQuestion ? 'Asking' : 'Reading'}{run!.total ? `… ${Math.min(run!.processed, run!.total)} of ${run!.total}` : '…'}
      </span>
    )
  } else if (run?.status === 'PAUSED' || run?.status === 'FAILED') {
    status = (
      <span className={run.status === 'PAUSED' ? 'text-attention-700' : 'text-risk-700'} title={run.error ?? undefined}>
        {run.status === 'PAUSED' ? 'Paused' : 'Stopped'}{run.error ? ` — ${run.error.replace(/\.$/, '')}` : ''}
        {canEdit && <> · <button type="button" className={link} disabled={ask.isPending} onClick={() => ask.mutate(run.scope)}>{run.status === 'PAUSED' ? 'Resume' : 'Try again'}</button></>}
      </span>
    )
  } else if (isQuestion && toAsk > 0) {
    status = (
      <span className={c.failed ? 'text-risk-700' : 'text-ink-500'}>
        {c.failed ? `${c.failed} couldn’t be asked` : `${c.unasked} not asked yet`}
        {canEdit && <> · <button type="button" className={link} disabled={ask.isPending} onClick={() => ask.mutate('missing')} data-testid={`column-ask-rest-${column.id}`}>Ask {toAsk === 1 ? 'it' : 'them'}</button></>}
      </span>
    )
  } else if (filled) {
    status = (
      <span className="text-ink-500">
        Filled {run!.answered}{c.none > 0 ? ` · ${c.none} not found` : ''}
        {canEdit && <> · <button type="button" className={link} disabled={undo.isPending} onClick={() => undo.mutate()} data-testid={`column-undo-${column.id}`}>Undo</button></>}
      </span>
    )
  } else if (!isQuestion && c.none > 0) {
    status = (
      <span className="text-ink-500">
        {looked ? `${c.none} not in the documents` : `${c.none} empty`}
        {canEdit && <> · <button type="button" className={link} disabled={ask.isPending} onClick={() => ask.mutate('missing')} data-testid={`column-look-${column.id}`}>{looked ? 'Look again' : 'Look for it'}</button></>}
      </span>
    )
  }

  return (
    <div ref={headRef} className="flex items-start gap-1 min-w-[150px] max-w-[240px]" data-testid={`column-header-${column.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {isQuestion && <AssistMark className="shrink-0" />}
          <span className="truncate" title={isQuestion ? column.question : column.field?.label ?? column.label}>{column.label}</span>
        </div>
        {status && <div className="mt-0.5 text-[10.5px] font-normal normal-case tracking-normal leading-snug">{status}</div>}
      </div>
      {canEdit && (
        <DropdownMenu onOpenChange={o => { if (!o) setConfirmRemove(false) }}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="-mr-1 p-0.5 rounded-sm text-ink-400 hover:text-ink-950 hover:bg-paper-100" aria-label={`${column.label} column`} data-testid={`column-menu-${column.id}`}>
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="normal-case tracking-normal font-normal">
            {isQuestion && <DropdownMenuItem onSelect={() => setEditOpen(true)}><Pencil className="size-3.5" /> Edit question…</DropdownMenuItem>}
            {isQuestion && (
              <DropdownMenuItem disabled={under} onSelect={() => ask.mutate('all')} data-testid={`column-ask-again-${column.id}`}>
                <RotateCw className="size-3.5" /> Ask every document again
              </DropdownMenuItem>
            )}
            {!isQuestion && c.none > 0 && (
              <DropdownMenuItem disabled={under} onSelect={() => ask.mutate('missing')}>
                <Search className="size-3.5" /> Look for it in the {c.none} empty
              </DropdownMenuItem>
            )}
            {!isQuestion && run?.fieldRunId && (
              <DropdownMenuItem disabled={under} onSelect={() => undo.mutate()}><Undo2 className="size-3.5" /> Undo the last fill</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-variant="destructive" onSelect={e => { if (!confirmRemove) { e.preventDefault(); setConfirmRemove(true) } else remove.mutate() }} data-testid={`column-remove-${column.id}`}>
              <Trash2 className="size-3.5" /> {confirmRemove ? (isQuestion ? 'Remove it and its answers' : 'Remove it') : 'Remove column'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {isQuestion && (
        <Popover open={editOpen} onClose={() => setEditOpen(false)} anchor={headRef.current} label={`Edit ${column.label}`} width={400}>
          <div className="normal-case tracking-normal font-normal text-left">
            <ColumnForm roomId={roomId} columns={[]} column={column} onDone={() => setEditOpen(false)} />
          </div>
        </Popover>
      )}
    </div>
  )
}

// ─── A cell ───────────────────────────────────────────────────────────────────

/** An answer as the field editor takes it (FieldsPanel), for a person to correct. */
function answerField(column: RoomColumnView, cell: RoomCell): ContractField {
  return {
    key: column.id, kind: 'custom', label: column.label, type: column.answerType ?? 'text', group: 'custom',
    options: column.options ?? undefined, value: cell.state === 'answered' ? cell.value : null, display: cell.display,
    source: null, confidence: null, quote: null, section: null, issue: null, anchor: null, verifiedAt: null, rejectedAt: null,
    suggestion: null, locked: false,
  }
}

export function RoomCellView({ roomId, column, cell, doc, canEdit }: {
  roomId: string
  column: RoomColumnView
  cell: RoomCell | undefined
  doc: { id: string; title: string }
  canEdit: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  if (!cell) return <span className="text-ink-400">—</span>
  const isQuestion = column.kind === 'question'

  const quiet = 'text-[11.5px] text-ink-400'
  switch (cell.state) {
    case 'waiting': return <span className={quiet} title="The document is still being read">Reading…</span>
    case 'asking': return <span className={cn(quiet, 'inline-flex items-center gap-1')}><Loader2 className="size-3 animate-spin" /> {isQuestion ? 'Asking…' : 'Reading…'}</span>
    case 'unread': return <span className={quiet} title="The document couldn’t be read">—</span>
  }

  const low = cell.state === 'answered' && !cell.checked && cell.source === 'ai' && (cell.confidence ?? 1) < LOW_CONFIDENCE
  let content: React.ReactNode
  if (cell.state === 'answered') {
    content = (
      <span className="flex items-start gap-1.5">
        {cell.source === 'ai' && !cell.checked && <AssistMark confidence={low ? 'low' : 'high'} className="mt-[5px]" />}
        {/* A person's own answer is marked as theirs; the AI's, confirmed, with a check. */}
        {(cell.source === 'user' || (cell.source && cell.source !== 'ai' && !cell.checked))
          ? <Pencil className="size-3 mt-[3px] shrink-0 text-ink-500" aria-label="Set by a person" />
          : cell.checked && <CircleCheck className="size-3 mt-[3px] shrink-0 text-brand-700" aria-label="Checked by a person" />}
        <span className={cn('line-clamp-2 break-words', cell.issue ? 'text-attention-800' : 'text-ink-950')}>{cell.display}</span>
      </span>
    )
  } else if (cell.state === 'none') {
    content = <span className="text-ink-400 italic">{isQuestion ? 'Not stated' : '—'}</span>
  } else if (cell.state === 'unasked') {
    content = <span className={quiet}>Not asked yet</span>
  } else {
    content = <span className="inline-flex items-center gap-1 text-[11.5px] text-risk-700" title={cell.error ?? undefined}><AlertTriangle className="size-3" /> Couldn’t ask</span>
  }

  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full text-left text-[12.5px] leading-snug rounded-sm -mx-1 px-1 py-0.5 hover:bg-paper-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink-950"
        title={cell.state === 'answered' ? cell.display : undefined}
        data-testid={`cell-${column.id}-${doc.id}`} data-state={cell.state}>
        {content}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} label={`${column.label} — ${doc.title}`} width={360}>
        <CellDetail roomId={roomId} column={column} cell={cell} doc={doc} canEdit={canEdit} onClose={() => setOpen(false)} />
      </Popover>
    </>
  )
}

function CellDetail({ roomId, column, cell, doc, canEdit, onClose }: {
  roomId: string
  column: RoomColumnView
  cell: RoomCell
  doc: { id: string; title: string }
  canEdit: boolean
  onClose: () => void
}) {
  const navigate = useNavigate()
  const refresh = useRoomRefresh(roomId)
  const [editing, setEditing] = useState(false)
  const isQuestion = column.kind === 'question'
  const field = useMemo(() => answerField(column, cell), [column, cell])

  const check = useMutation({
    mutationFn: async (checked: boolean) => api.post(`/diligence/${roomId}/columns/${column.id}/cells/${doc.id}/check`, { checked }),
    onSuccess: () => refresh(),
    onError: err => toast.error("Couldn't save", { description: errorDetail(err) }),
  })
  const answer = useMutation({
    mutationFn: async (value: unknown) => api.put(`/diligence/${roomId}/columns/${column.id}/cells/${doc.id}`, { value }),
    onSuccess: () => { refresh(); setEditing(false) },
    onError: err => toast.error("Couldn't save the answer", { description: errorDetail(err) }),
  })
  const ask = useMutation({
    mutationFn: async () => api.post(`/diligence/${roomId}/columns/${column.id}/run`, { scope: 'missing' }),
    onSuccess: () => { refresh(); onClose() },
    onError: err => toast.error("Couldn't ask", { description: errorDetail(err) }),
  })

  // The contract, with the words the answer came from highlighted (docs/39 B2's "Show in document").
  const openContract = () => navigate(`/contracts/${doc.id}`, cell.quote && !cell.exhibit ? { state: { reveal: { text: cell.quote, occurrence: cell.occurrence } } } : undefined)
  const low = !cell.checked && cell.source === 'ai' && (cell.confidence ?? 1) < LOW_CONFIDENCE
  const confirmable = canEdit && cell.state !== 'failed' && cell.state !== 'unasked' && !cell.checked && (isQuestion || cell.state === 'answered')

  return (
    <div className="p-3 space-y-2.5" data-testid="cell-detail">
      <div>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 truncate">{column.label}</p>
        <p className="text-[11.5px] text-ink-500 truncate" title={doc.title}>{doc.title}</p>
      </div>
      {isQuestion && column.question && column.question !== column.label && (
        <p className="text-[12px] text-ink-700 leading-snug">{column.question}</p>
      )}

      {editing ? (
        <FieldEditor f={field} saving={answer.isPending} onSave={v => answer.mutate(v)} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <div>
            <p className={cn('text-[15px] font-medium leading-snug break-words', cell.state === 'answered' ? 'text-ink-950' : 'text-ink-500')} data-testid="cell-answer">
              {cell.state === 'answered' ? cell.display
                : cell.state === 'none' ? (isQuestion ? 'The document doesn’t say' : 'No value')
                  : cell.state === 'unasked' ? 'Not asked yet' : 'Couldn’t ask'}
            </p>
            {(cell.state === 'answered' || (cell.state === 'none' && isQuestion)) && (
              <p className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-ink-500" data-testid="cell-source">
                {cell.source === 'ai' && !cell.checked && cell.state === 'answered' && <AssistMark confidence={low ? 'low' : 'high'} />}
                {cell.source === 'user' ? <Pencil className="size-3" /> : cell.checked && <CircleCheck className="size-3 text-brand-700" />}
                {answerSource(column.kind, cell)}
              </p>
            )}
          </div>
          {cell.issue && (
            <p className="flex gap-1.5 text-[11.5px] leading-snug text-attention-800 bg-attention-50 border border-attention-200 rounded-md px-2 py-1.5">
              <AlertTriangle className="size-3.5 shrink-0 mt-px" /> {cell.issue}
            </p>
          )}
          {cell.state === 'failed' && cell.error && <p className="text-[11.5px] text-risk-700">{cell.error}</p>}
          {cell.quote ? (
            <div>
              <p className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-400 mb-1">
                <TextQuote className="size-3" /> {cell.exhibit ? `From the exhibit “${cell.exhibit}”` : 'From the document'}
              </p>
              <blockquote className="border-l-2 border-assist-300 pl-2.5 text-[12px] italic leading-snug text-ink-700 max-h-40 overflow-y-auto" data-testid="cell-quote">
                “{cell.quote}”
              </blockquote>
            </div>
          ) : cell.state === 'answered' && cell.source === 'ai' && (
            <p className="text-[11.5px] text-ink-500">No words were quoted for it — check it in the document.</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Button size="xs" variant="outline" onClick={openContract} data-testid="cell-open">
              {cell.quote && !cell.exhibit ? 'Show in the contract' : 'Open the contract'}
            </Button>
            {confirmable && (
              <Button size="xs" variant="outline" disabled={check.isPending} onClick={() => check.mutate(true)} data-testid="cell-confirm">
                <CircleCheck /> {cell.state === 'none' ? 'Confirm it isn’t there' : 'Confirm'}
              </Button>
            )}
            {canEdit && isQuestion && cell.checked && cell.source === 'ai' && (
              <Button size="xs" variant="ghost" disabled={check.isPending} onClick={() => check.mutate(false)}>Unconfirm</Button>
            )}
            {canEdit && isQuestion && cell.state !== 'unasked' && (
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)} data-testid="cell-change">
                <Pencil /> {cell.state === 'answered' || cell.state === 'none' ? 'Change answer' : 'Answer it yourself'}
              </Button>
            )}
            {canEdit && isQuestion && (cell.state === 'failed' || cell.state === 'unasked') && (
              // The column's run asks every document without an answer, this one among them.
              <Button size="xs" variant="ghost" disabled={ask.isPending} onClick={() => ask.mutate()}>
                <RotateCw /> {column.counts.unasked + column.counts.failed > 1 ? `Ask the ${column.counts.unasked + column.counts.failed} without an answer` : 'Ask it now'}
              </Button>
            )}
            {!isQuestion && cell.state === 'answered' && !cell.checked && (
              <span className="text-[11px] text-ink-500">Change it on the contract.</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
