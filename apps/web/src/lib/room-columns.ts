/**
 * docs/39 D6 — a diligence room's own columns, as the room's table shows them
 * (the API's lib/diligence-columns.ts): the forms an answer takes, a
 * question's likely form and column name, and who an answer came from.
 */
import type { FieldValueType } from '@clm/types'

export type AnswerType = 'text' | 'boolean' | 'date' | 'number' | 'currency' | 'duration' | 'percentage' | 'select'

/**
 * answered · none (the document doesn't say) · asking (a run will reach it) ·
 * unasked (analysed, not asked yet) · waiting (still being read) · unread
 * (couldn't be read) · failed (asking failed).
 */
export type CellState = 'answered' | 'none' | 'asking' | 'unasked' | 'waiting' | 'unread' | 'failed'

export interface ColumnRun {
  token: string
  status: 'QUEUED' | 'RUNNING' | 'PAUSED' | 'DONE' | 'FAILED'
  scope: 'missing' | 'all'
  processed: number
  answered: number
  failed: number
  total: number
  error: string | null
  updatedAt: string
  fieldRunId?: string | null
}

export interface RoomColumnView {
  id: string
  kind: 'field' | 'question'
  label: string
  key?: string
  question?: string
  answerType?: AnswerType
  options?: string[] | null
  run: ColumnRun | null
  field?: { label: string; type: FieldValueType; kind: string } | null
  counts: Record<CellState, number>
}

export interface RoomCell {
  state: CellState
  value: unknown
  display: string
  quote: string | null
  occurrence: number
  confidence: number | null
  issue: string | null
  error: string | null
  source: string | null
  checked: boolean
  exhibit: string | null
}

export const ANSWER_TYPES: ReadonlyArray<{ value: AnswerType; label: string }> = [
  { value: 'boolean', label: 'Yes or no' },
  { value: 'text', label: 'Short answer' },
  { value: 'date', label: 'Date' },
  { value: 'currency', label: 'Amount' },
  { value: 'number', label: 'Number' },
  { value: 'duration', label: 'Length of time' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'select', label: 'One of a list' },
]

/** The form a question's answer most likely takes, from how it's asked ("Can…?" is a yes or no). */
export function guessAnswerType(question: string): AnswerType {
  const q = question.trim().toLowerCase()
  if (/^(is|are|can|could|does|do|did|has|have|had|will|would|may|might|must|should|shall|was|were)\b/.test(q)) return 'boolean'
  if (/^how long\b|\b(notice|cure|grace|term|renewal) period\b/.test(q)) return 'duration'
  if (/^how much\b|\b(cap|fees?|price|amount|cost|liability limit)\b/.test(q) && !/^(what|which|who)\b.*\b(law|court|party)\b/.test(q)) return 'currency'
  if (/^how many\b/.test(q)) return 'number'
  if (/\bper ?cent(age)?\b|%/.test(q)) return 'percentage'
  if (/^when\b|\b(date|deadline|expire|expiry|expiration)\b/.test(q)) return 'date'
  return 'text'
}

/**
 * A question's column name when none is given: the question, its little words
 * dropped when it's long ("Can supplier assign agreement without consent?"),
 * then shortened at a word. The API names it the same way.
 */
export function labelFromQuestion(question: string, max = 48): string {
  let q = question.replace(/\s+/g, ' ').trim()
  if (q.length <= max) return q
  const capital = /^[A-Z]/.test(q)
  q = q.replace(/\b(the|a|an|our|its|their|this|that|any|such)\s+/gi, '')
  if (capital) q = q.replace(/^\w/, ch => ch.toUpperCase())
  if (q.length <= max) return q
  const cut = q.slice(0, max + 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : q.slice(0, max)).replace(/[\s,;:.-]+$/, '')}…`
}

/** A run still under way: queued or running, and heard from in the last ten minutes. */
export function runUnderWay(run: ColumnRun | null | undefined): boolean {
  return !!run && (run.status === 'QUEUED' || run.status === 'RUNNING') && Date.now() - new Date(run.updatedAt).getTime() < 10 * 60_000
}

/** Below this an AI answer asks to be read rather than trusted (as the room's rows, B3). */
export const LOW_CONFIDENCE = 0.7

/** Who an answer came from, as a person reads it. */
export function answerSource(kind: RoomColumnView['kind'], cell: Pick<RoomCell, 'state' | 'source' | 'checked' | 'confidence'>): string {
  const sure = cell.confidence != null ? ` · ${Math.round(cell.confidence * 100)}% sure` : ''
  if (kind === 'question') {
    if (cell.source === 'user') return 'Answered by a person'
    if (cell.state === 'none') return cell.checked ? 'Confirmed by a person' : 'AI · found nothing on it in the document'
    return cell.checked ? 'AI · confirmed by a person' : `AI${sure}`
  }
  if (cell.checked) return 'Checked by a person'
  switch (cell.source) {
    case 'ai': return `AI${sure}`
    case 'calculated': return 'Worked out from the start date and term'
    case 'highlight': return 'Picked from the text by a person'
    case 'variable': return 'Filled in from the template'
    case 'amendment': return 'Set from an amendment'
    case 'import': return 'Imported'
    default: return 'Set by a person'
  }
}

/** Choices typed as one line: "Allowed, Needs consent" → each, trimmed, once. */
export function choicesFrom(text: string): string[] {
  const seen = new Map<string, string>()
  for (const c of text.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)) if (!seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c)
  return [...seen.values()]
}
