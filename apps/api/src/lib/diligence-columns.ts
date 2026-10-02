/**
 * docs/39 D6 — a diligence room's own columns.
 *
 * A room's table had fixed columns (counterparty, value, term, risk), so a
 * reviewer with a question of their own — "can the supplier assign this
 * without consent?" — read every document for it by hand. Now the room's
 * people add columns: any field the org's contracts hold, or a question asked
 * of every document and answered in the form they choose (yes or no, a date,
 * an amount, one of a list…). Every cell shows the words it came from and how
 * sure the AI was; a person can confirm or correct an answer, and asking
 * again never replaces what a person gave or confirmed.
 *
 * A question is asked through the agents service's /extract-fields — the pass
 * a custom field is filled in with, its quote checked against the document
 * word for word — as a field of its own whose meaning is the question.
 * Answers are kept per room, column and document (diligence_cells). A field
 * column shows the field store's values; the documents without one can be
 * read for it the same way, written through the store (fill_blanks: a value a
 * person set is never replaced) and undone for 30 days.
 *
 * A column's run goes a page of documents at a time in id order, its cursor
 * and counts kept on the column after every document, so a retried job
 * resumes and a spent AI budget pauses it where it stopped. A document that
 * finishes its analysis later is asked on its own (answerDocument).
 */
import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { parseFieldValue, type CatalogField, type FieldValueType } from '@clm/types'
import { prisma } from './prisma.js'
import { CostCapExceededError } from './costCap.js'
import { applyExtraction } from './field-store.js'
import { catalogField, fieldCatalog, fieldCells, type FieldCell } from './field-query.js'
import { fieldExamples } from './field-examples.js'
import { recordRun, appendRunChanges } from './field-runs.js'
import { trackedChangesOf, versionTrackedViews } from './tracked-changes.js'
import { readExhibits, withExhibits } from './exhibits.js'
import { resolveLlm } from './aiRouter.js'
import { tokenCostUsd } from './model-pricing.js'

// ─── Columns ──────────────────────────────────────────────────────────────────

/** The forms an answer can take (the field types a question's answer is read as). */
export const ANSWER_TYPES = ['text', 'boolean', 'date', 'number', 'currency', 'duration', 'percentage', 'select'] as const
export type AnswerType = typeof ANSWER_TYPES[number]

export const MAX_ROOM_COLUMNS = 20
export const MAX_ANSWER_OPTIONS = 20

/** What an answer that doesn't fit its form was meant to be ("isn't a date"). */
const ANSWER_NOUN: Record<AnswerType, string> = {
  text: 'a short answer', boolean: 'a yes or no', date: 'a date', number: 'a number',
  currency: 'an amount', duration: 'a length of time', percentage: 'a percentage', select: 'one of the choices',
}

export interface ColumnRun {
  /**
   * The run's own: a job whose token isn't the column's any more (the
   * question was reworded, asked again, or the job is a stale duplicate)
   * stops at its next save.
   */
  token: string
  status: 'QUEUED' | 'RUNNING' | 'PAUSED' | 'DONE' | 'FAILED'
  /** 'missing': the documents without an answer, or whose asking failed; 'all': every one again, but a person's. */
  scope: 'missing' | 'all'
  cursor: string | null
  /** Documents gone through, asked or not. */
  processed: number
  /** Answers found (a question), or values written (a field). */
  answered: number
  failed: number
  total: number
  error: string | null
  updatedAt: string
  startedById: string | null
  /** A field column's fill: the values it wrote, which can be undone for 30 days (lib/field-runs.ts). */
  fieldRunId?: string | null
}

interface ColumnBase {
  id: string
  label: string
  addedAt: string
  addedById: string
  run?: ColumnRun | null
}
export interface FieldColumnDef extends ColumnBase { kind: 'field'; key: string }
export interface QuestionColumnDef extends ColumnBase {
  kind: 'question'
  question: string
  answerType: AnswerType
  options?: string[] | null
}
export type RoomColumn = FieldColumnDef | QuestionColumnDef

export const newColumnId = () => `col_${randomBytes(6).toString('hex')}`

/**
 * A question's column name when none is given: the question, its little words
 * dropped when it's long ("Can supplier assign agreement without consent?"),
 * then shortened at a word.
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

/** The room's columns as stored, anything malformed left out. */
export function roomColumns(raw: unknown): RoomColumn[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is RoomColumn => {
    if (!c || typeof c !== 'object' || typeof (c as RoomColumn).id !== 'string' || typeof (c as RoomColumn).label !== 'string') return false
    const col = c as RoomColumn
    return col.kind === 'field' ? typeof col.key === 'string'
      : col.kind === 'question' && typeof col.question === 'string' && (ANSWER_TYPES as readonly string[]).includes(col.answerType)
  })
}

/**
 * A run still under way: queued or running, and heard from in the last ten
 * minutes (a run whose job never started, or whose worker died, doesn't
 * leave its cells "being asked" for good, nor stop anyone asking again).
 */
export function runUnderWay(run: ColumnRun | null | undefined): boolean {
  return !!run && (run.status === 'QUEUED' || run.status === 'RUNNING') && Date.now() - new Date(run.updatedAt).getTime() < 10 * 60_000
}

/** A new run's starting state; `resume` carries on from a paused or failed run's cursor and counts. */
export function freshRun(scope: ColumnRun['scope'], startedById: string | null, resume?: ColumnRun | null): ColumnRun {
  return {
    token: randomBytes(8).toString('hex'), status: 'QUEUED', scope,
    cursor: resume?.cursor ?? null, processed: resume?.processed ?? 0, answered: resume?.answered ?? 0, failed: resume?.failed ?? 0,
    total: resume?.total ?? 0, error: null, updatedAt: new Date().toISOString(), startedById, fieldRunId: resume?.fieldRunId ?? null,
  }
}

/** The room holds the column — as it was, when `guard` names what must not have changed (its run's token). */
const hasColumn = (columnId: string, guard: Record<string, unknown> = {}) => Prisma.sql`columns @> ${JSON.stringify([{ ...guard, id: columnId }])}::jsonb`

/** Adds a column at the end; false when the room is gone or full. One statement: two people adding at once both land. */
export async function appendColumn(roomId: string, column: RoomColumn): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE diligence_rooms SET columns = columns || jsonb_build_array(${JSON.stringify(column)}::jsonb), "updatedAt" = now()
    WHERE id = ${roomId} AND "deletedAt" IS NULL AND jsonb_array_length(columns) < ${MAX_ROOM_COLUMNS}`
  return n > 0
}

/** Merges `patch` into one column (a key set to null clears it); false when the column is gone, or changed from `guard`. */
export async function patchColumn(roomId: string, columnId: string, patch: Record<string, unknown>, guard?: Record<string, unknown>): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE diligence_rooms SET columns = (
      SELECT COALESCE(jsonb_agg(CASE WHEN c->>'id' = ${columnId} THEN c || ${JSON.stringify(patch)}::jsonb ELSE c END ORDER BY o), '[]'::jsonb)
      FROM jsonb_array_elements(columns) WITH ORDINALITY AS t(c, o))
    WHERE id = ${roomId} AND ${hasColumn(columnId, guard)}`
  return n > 0
}

/** Takes a column and its answers out of the room; false when it was already gone. */
export async function removeColumn(roomId: string, columnId: string): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE diligence_rooms SET columns = (
      SELECT COALESCE(jsonb_agg(c ORDER BY o), '[]'::jsonb)
      FROM jsonb_array_elements(columns) WITH ORDINALITY AS t(c, o) WHERE c->>'id' <> ${columnId}), "updatedAt" = now()
    WHERE id = ${roomId} AND ${hasColumn(columnId)}`
  if (n > 0) await prisma.diligenceCell.deleteMany({ where: { roomId, columnId } })
  return n > 0
}

// ─── Answers ──────────────────────────────────────────────────────────────────

export interface ExtractedAnswer { value: unknown; confidence?: number; quote?: string | null; issue?: string | null }

/** The agents service's /extract-fields for one document (the worker's callAgents, in production). */
export type AskFields = (args: {
  orgId: string
  contractId: string
  body: { plainText: string; fields: unknown[]; contractType: string | null; orgId: string }
}) => Promise<Record<string, ExtractedAnswer> | null>

/** The key a question is asked under: a field of its own, for /extract-fields. */
export const questionKey = (columnId: string) => `question_${columnId.replace(/[^a-zA-Z0-9]/g, '')}`

/** A question as the agents service reads it: a field whose meaning is the question. */
export function questionSpec(column: QuestionColumnDef) {
  return {
    fieldKey: questionKey(column.id), fieldLabel: column.label, fieldType: column.answerType,
    options: column.options ?? [], question: column.question,
  }
}

export interface Answer { value: unknown; display: string; quote: string | null; confidence: number | null; issue: string | null }

/**
 * What the AI answered, in the column's form: parsed like a field of that
 * type ("thirty days" → 30 days), and doubted the way a field's value is
 * (lib/field-confidence): no words to show for it, a quote that isn't in the
 * document, or an answer the form can't hold — which is kept as said
 * ("upon signature" for a date), not dropped.
 */
export function readAnswer(column: Pick<QuestionColumnDef, 'answerType' | 'options'>, out: ExtractedAnswer | null | undefined): Answer {
  const said = out?.value
  if (said === null || said === undefined || (typeof said === 'string' && !said.trim())) {
    return { value: null, display: '', quote: null, confidence: typeof out?.confidence === 'number' ? out.confidence : null, issue: null }
  }
  const quote = typeof out?.quote === 'string' && out.quote.trim() ? out.quote.trim() : null
  let confidence = typeof out?.confidence === 'number' && Number.isFinite(out.confidence) ? Math.max(0, Math.min(1, out.confidence)) : 0.5
  const parsed = parseFieldValue(column.answerType as FieldValueType, said, { options: column.options ?? [] })
  if (!parsed.ok || parsed.value === null) {
    const words = (typeof said === 'string' ? said : JSON.stringify(said)).replace(/\s+/g, ' ').trim()
    return {
      value: null, display: words.slice(0, 300), quote, confidence: Math.min(confidence, 0.4),
      issue: `The AI answered “${words.length > 80 ? `${words.slice(0, 80)}…` : words}”, which isn't ${ANSWER_NOUN[column.answerType]}.`,
    }
  }
  // A "no" can stand without words to show for it; anything else is doubted.
  if (!quote && !(column.answerType === 'boolean' && parsed.value === false)) confidence = Math.min(confidence, 0.65)
  return { value: parsed.value, display: parsed.display, quote, confidence, issue: out?.issue ?? null }
}

const jsonValue = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : v as Prisma.InputJsonValue)

/** A person's answer, or one a person confirmed: asking again leaves it alone. */
const personal = { OR: [{ source: 'user' }, { checkedAt: { not: null } }] } satisfies Prisma.DiligenceCellWhereInput

/** Writes the AI's answer, unless a person answered or confirmed the cell meanwhile. */
async function saveAnswer(ids: CellIds, answer: Answer): Promise<void> {
  const data = {
    value: jsonValue(answer.value), display: answer.display, quote: answer.quote, confidence: answer.confidence,
    issue: answer.issue, error: null, answeredAt: new Date(), source: 'ai',
  }
  const updated = await prisma.diligenceCell.updateMany({ where: { roomId: ids.roomId, columnId: ids.columnId, contractId: ids.contractId, NOT: personal }, data })
  if (updated.count) return
  await prisma.diligenceCell.create({ data: { ...ids, ...data } }).catch((err: { code?: string }) => {
    // A cell there already is a person's (or a run beside this one wrote it): it stays.
    if (err.code !== 'P2002') throw err
  })
}

/** Asking failed: said on the cell, unless it already holds an answer (a re-ask that failed keeps the last one). */
async function saveFailure(ids: CellIds, error: string): Promise<void> {
  const updated = await prisma.diligenceCell.updateMany({
    where: { roomId: ids.roomId, columnId: ids.columnId, contractId: ids.contractId, NOT: personal, error: { not: null } },
    data: { error, answeredAt: new Date() },
  })
  if (updated.count) return
  await prisma.diligenceCell.create({ data: { ...ids, value: Prisma.DbNull, error } }).catch((err: { code?: string }) => {
    if (err.code !== 'P2002') throw err
  })
}

interface CellIds { orgId: string; roomId: string; columnId: string; contractId: string }

/** An error as a person can act on it. */
function said(err: unknown): string {
  const m = (err as Error)?.message ?? String(err)
  return (m === 'fetch failed' ? 'the AI service didn’t answer' : m).slice(0, 300)
}

/** The document's text as the review reads it: the contract, then each exhibit read with it (A12). */
async function documentText(contractId: string, versionId: string | null): Promise<{ text: string; metadata: unknown } | null> {
  if (!versionId) return null
  const v = await prisma.contractVersion.findUnique({ where: { id: versionId }, select: { plainText: true, metadata: true } })
  if (!v?.plainText?.trim()) return null
  return { text: withExhibits(v.plainText, await readExhibits(contractId)), metadata: v.metadata }
}

// ─── A column's run ───────────────────────────────────────────────────────────

export interface AnswerColumnJob { orgId: string; roomId: string; columnId: string; token: string }

/** The room's documents a run reads: analysed ones. */
const readable = (roomId: string): Prisma.ContractWhereInput => ({ diligenceRoomId: roomId, deletedAt: null, analysisStatus: 'DONE' })

const PAGE = 20

const CELL_CONTRACT = {
  id: true, type: true, currentVersionId: true, value: true, currency: true, effectiveDate: true, expiryDate: true,
  jurisdiction: true, counterpartyName: true, keyTerms: true, metadata: true,
} satisfies Prisma.ContractSelect

/**
 * Answers a column for the room's documents: a question is asked of each
 * document without an answer (or of every one, `scope: 'all'`, but those a
 * person answered or confirmed); a field is read for each document without a
 * value. Resumes from the column's cursor; stops when the column is removed.
 */
export async function answerColumn(job: AnswerColumnJob, ask: AskFields): Promise<ColumnRun | null> {
  const room = await prisma.diligenceRoom.findFirst({ where: { id: job.roomId, orgId: job.orgId, deletedAt: null }, select: { columns: true } })
  const column = room ? roomColumns(room.columns).find(c => c.id === job.columnId) : undefined
  // Gone, or a newer run took over (reworded, asked again): nothing to do.
  if (!column?.run || column.run.token !== job.token) return null
  const where = readable(job.roomId)
  const run: ColumnRun = { ...column.run, status: 'RUNNING', error: null, total: await prisma.contract.count({ where }), updatedAt: new Date().toISOString() }
  const guard = { run: { token: job.token } }
  const save = async (patch: Partial<ColumnRun> = {}) => {
    Object.assign(run, patch, { updatedAt: new Date().toISOString() })
    return patchColumn(job.roomId, job.columnId, { run }, guard)
  }

  // A field column reads the field as the org defines it, with how people filled it in elsewhere (A5).
  let field: CatalogField | undefined
  let catalog: CatalogField[] = []
  let spec: Record<string, unknown>
  if (column.kind === 'field') {
    catalog = await fieldCatalog(job.orgId)
    field = catalogField(catalog, column.key)
    if (!field) {
      await save({ status: 'FAILED', error: 'The field no longer exists.' })
      return run
    }
    const examples = (await fieldExamples(job.orgId, [field.key])).get(field.key)
    spec = {
      fieldKey: field.key, fieldLabel: field.label, fieldType: field.type, options: field.options ?? [],
      helpText: field.definition ?? undefined, ...(examples?.length && { examples }),
    }
    run.fieldRunId ??= await recordRun({ orgId: job.orgId, kind: 'diligence', changes: [], createdById: run.startedById })
  } else {
    spec = questionSpec(column)
  }
  if (!await save()) return null

  try {
    for (;;) {
      const page = await prisma.contract.findMany({
        where: { ...where, ...(run.cursor ? { id: { gt: run.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: PAGE,
        select: CELL_CONTRACT,
      })
      if (!page.length) break
      const todo = column.kind === 'question'
        ? await questionsToAsk(job.roomId, column.id, page.map(c => c.id), run.scope)
        : new Set([...(await fieldCells(page, [field!.key], catalog)).entries()].filter(([, cells]) => cells[field!.key]?.value == null).map(([id]) => id))

      for (const c of page) {
        if (todo.has(c.id)) {
          const ids = { orgId: job.orgId, roomId: job.roomId, columnId: column.id, contractId: c.id }
          const doc = await documentText(c.id, c.currentVersionId)
          if (!doc) {
            if (column.kind === 'question') await saveFailure(ids, 'The document has no text to read.')
            run.failed++
          } else {
            try {
              const out = (await ask({ orgId: job.orgId, contractId: c.id, body: { plainText: doc.text, fields: [spec], contractType: c.type, orgId: job.orgId } }))?.[spec.fieldKey as string]
              if (column.kind === 'question') {
                const answer = readAnswer(column, out)
                await saveAnswer(ids, answer)
                if (answer.display) run.answered++
              } else if (out && out.value != null && await fillField(c.id, c.currentVersionId, doc.metadata, field!, out, run.fieldRunId ?? null)) {
                run.answered++
              }
            } catch (err) {
              // Out of budget: stop here, resumable once the cap resets.
              if (err instanceof CostCapExceededError) {
                await save({ status: 'PAUSED', error: 'Today’s AI budget is used up.' })
                return run
              }
              console.warn('[diligence-columns] %s on %s failed: %s', column.id, c.id, (err as Error).message)
              if (column.kind === 'question') await saveFailure(ids, said(err))
              run.failed++
            }
          }
        }
        run.processed++
        run.cursor = c.id
        // Removed, reworded or asked again while it ran: stop.
        if (!await save()) return null
      }
    }
    await save({ status: 'DONE' })
    return run
  } catch (err) {
    await save({ status: 'FAILED', error: said(err) }).catch(() => {})
    throw err
  }
}

/** Which of these documents a question asks. */
async function questionsToAsk(roomId: string, columnId: string, contractIds: string[], scope: ColumnRun['scope']): Promise<Set<string>> {
  const cells = await prisma.diligenceCell.findMany({
    where: { roomId, columnId, contractId: { in: contractIds } },
    select: { contractId: true, error: true, source: true, checkedAt: true },
  })
  const cellOf = new Map(cells.map(c => [c.contractId, c]))
  return new Set(contractIds.filter(id => {
    const cell = cellOf.get(id)
    if (!cell) return true
    if (cell.source === 'user' || cell.checkedAt) return false
    return scope === 'all' || !!cell.error
  }))
}

/** A field column's reading, written only where the field is still empty; true when it was. */
async function fillField(contractId: string, versionId: string | null, versionMetadata: unknown, field: CatalogField, out: ExtractedAnswer, runId: string | null): Promise<boolean> {
  // A9 — a Word file with tracked changes: what's agreed is written, their proposal beside it.
  const tracked = versionId && trackedChangesOf(versionMetadata) ? await versionTrackedViews(contractId, versionId) : null
  const outcome = await applyExtraction(contractId, [{
    key: field.key, kind: field.kind, value: out.value, confidence: out.confidence ?? 0.5, quote: out.quote ?? null, issue: out.issue ?? null,
  }], { mode: 'fill_blanks', reindex: true, tracked })
  if (runId && outcome?.changes.length) await appendRunChanges(runId, outcome.changes.map(ch => ({ ...ch, contractId })))
  return !!outcome?.written.includes(field.key)
}

// ─── A document read later ────────────────────────────────────────────────────

export interface AnswerDocumentJob { orgId: string; contractId: string }

/**
 * A room's document finished its analysis (a late upload, or read again):
 * each question column asks it, unless it holds an answer read from this
 * version already, or one a person gave or confirmed. A spent budget leaves
 * the rest "not asked yet", which the column's run picks up.
 */
export async function answerDocument(job: AnswerDocumentJob, ask: AskFields): Promise<number> {
  // Its fields saved (DONE), or its clauses being indexed after them: its text is there to ask.
  const c = await prisma.contract.findFirst({
    where: { id: job.contractId, orgId: job.orgId, deletedAt: null, analysisStatus: { in: ['DONE', 'INDEXING'] }, diligenceRoomId: { not: null } },
    select: { id: true, type: true, currentVersionId: true, diligenceRoomId: true },
  })
  if (!c?.diligenceRoomId) return 0
  const room = await prisma.diligenceRoom.findFirst({ where: { id: c.diligenceRoomId, deletedAt: null }, select: { id: true, columns: true } })
  const questions = room ? roomColumns(room.columns).filter((q): q is QuestionColumnDef => q.kind === 'question') : []
  if (!room || !questions.length) return 0
  const version = c.currentVersionId ? await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { createdAt: true } }) : null
  const cells = await prisma.diligenceCell.findMany({
    where: { roomId: room.id, contractId: c.id, columnId: { in: questions.map(q => q.id) } },
    select: { columnId: true, source: true, checkedAt: true, answeredAt: true, error: true },
  })
  const cellOf = new Map(cells.map(x => [x.columnId, x]))
  const due = questions.filter(q => {
    const cell = cellOf.get(q.id)
    if (!cell) return true
    if (cell.source === 'user' || cell.checkedAt) return false
    // Read before this version was: asked again of the words it has now.
    return !!cell.error || (!!version && cell.answeredAt < version.createdAt)
  })
  if (!due.length) return 0
  const doc = await documentText(c.id, c.currentVersionId)
  let asked = 0
  for (const q of due) {
    const ids = { orgId: job.orgId, roomId: room.id, columnId: q.id, contractId: c.id }
    if (!doc) { await saveFailure(ids, 'The document has no text to read.'); continue }
    try {
      const spec = questionSpec(q)
      const out = (await ask({ orgId: job.orgId, contractId: c.id, body: { plainText: doc.text, fields: [spec], contractType: c.type, orgId: job.orgId } }))?.[spec.fieldKey]
      await saveAnswer(ids, readAnswer(q, out))
      asked++
    } catch (err) {
      if (err instanceof CostCapExceededError) break
      await saveFailure(ids, said(err))
    }
  }
  return asked
}

// ─── A person's answer ────────────────────────────────────────────────────────

/** A person's answer to a question for one document, parsed for the column's form. */
export async function setAnswer(input: {
  orgId: string; roomId: string; column: QuestionColumnDef; contractId: string; userId: string; value: unknown
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const parsed = parseFieldValue(input.column.answerType as FieldValueType, input.value, { options: input.column.options ?? [] })
  if (!parsed.ok) return { ok: false, detail: parsed.error }
  const now = new Date()
  const data = {
    value: jsonValue(parsed.value), display: parsed.value === null ? '' : parsed.display, quote: null, confidence: null,
    issue: null, error: null, answeredAt: now, source: 'user', checkedById: input.userId, checkedAt: now,
  }
  await prisma.diligenceCell.upsert({
    where: { roomId_columnId_contractId: { roomId: input.roomId, columnId: input.column.id, contractId: input.contractId } },
    create: { orgId: input.orgId, roomId: input.roomId, columnId: input.column.id, contractId: input.contractId, ...data },
    update: data,
  })
  return { ok: true }
}

/** A person confirms (or un-confirms) the AI's answer: confirmed, asking again leaves it alone. */
export async function checkAnswer(input: { roomId: string; columnId: string; contractId: string; userId: string; checked: boolean }): Promise<boolean> {
  const r = await prisma.diligenceCell.updateMany({
    where: { roomId: input.roomId, columnId: input.columnId, contractId: input.contractId, error: null },
    data: input.checked ? { checkedAt: new Date(), checkedById: input.userId } : { checkedAt: null, checkedById: null },
  })
  return r.count > 0
}

// ─── The table ────────────────────────────────────────────────────────────────

/**
 * One document's cell in a column:
 *   answered — a value (or the AI's words, when they didn't fit the form)
 *   none     — asked, or read: the document doesn't say
 *   asking   — a run is under way that will reach it
 *   unasked  — analysed, not asked yet (a paused run; a document added since)
 *   waiting  — the document is still being read
 *   unread   — the document couldn't be read
 *   failed   — asking failed (`error` says why)
 */
export type CellState = 'answered' | 'none' | 'asking' | 'unasked' | 'waiting' | 'unread' | 'failed'

export interface RoomCell {
  state: CellState
  value: unknown
  display: string
  quote: string | null
  /** Which of the passages worded like the quote it is (a field's placed value). */
  occurrence: number
  confidence: number | null
  issue: string | null
  error: string | null
  /** 'ai' | 'user' — and a field's other sources (highlight, import…). */
  source: string | null
  checked: boolean
  /** A12 — the words are in an exhibit read with the contract. */
  exhibit: string | null
}

/** A column as the table shows it: what it is, where its run stands and how its cells add up. */
export type ColumnView = Omit<RoomColumn, 'run'> & {
  run: ColumnRun | null
  /** A field column's field: its name and form as the catalogue has them. */
  field?: { label: string; type: FieldValueType; kind: CatalogField['kind'] } | null
  counts: Record<CellState, number>
}

/** What the table reads of each document for the added columns. */
export const TABLE_CONTRACT = { ...CELL_CONTRACT, analysisStatus: true, updatedAt: true } satisfies Prisma.ContractSelect

/**
 * A document whose analysis finished this recently, and that holds no answer
 * yet, is being asked on its own (answerDocument): "being asked", not "not
 * asked yet", until then.
 */
const JUST_READ_MS = 3 * 60_000
type TableContract = Prisma.ContractGetPayload<{ select: typeof TABLE_CONTRACT }>

/** A cell's words, as long as the table carries them (a passage, not the clause around it). */
const QUOTE_MAX = 600
const clip = (quote: string | null | undefined) => (quote && quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX)}…` : quote ?? null)

const EMPTY: Omit<RoomCell, 'state'> = {
  value: null, display: '', quote: null, occurrence: 0, confidence: null, issue: null, error: null, source: null, checked: false, exhibit: null,
}

/** Every added column's cell for each document, and each column's counts. */
export async function roomTable(orgId: string, roomId: string, columns: RoomColumn[], docs: TableContract[]): Promise<{
  columns: ColumnView[]
  cells: Map<string, Record<string, RoomCell>>
}> {
  const out = new Map<string, Record<string, RoomCell>>(docs.map(d => [d.id, {}]))
  const fieldKeys = columns.filter((c): c is FieldColumnDef => c.kind === 'field').map(c => c.key)
  const catalog = fieldKeys.length ? await fieldCatalog(orgId) : []
  const [values, answers] = await Promise.all([
    fieldKeys.length ? fieldCells(docs, fieldKeys, catalog, undefined, { sources: true }) : Promise.resolve(new Map<string, Record<string, FieldCell>>()),
    columns.some(c => c.kind === 'question')
      ? prisma.diligenceCell.findMany({ where: { roomId, columnId: { in: columns.map(c => c.id) } } })
      : Promise.resolve([]),
  ])
  const answerOf = new Map(answers.map(a => [`${a.columnId}:${a.contractId}`, a]))
  const views: ColumnView[] = []
  for (const column of columns) {
    const counts: Record<CellState, number> = { answered: 0, none: 0, asking: 0, unasked: 0, waiting: 0, unread: 0, failed: 0 }
    const running = runUnderWay(column.run)
    const field = column.kind === 'field' ? catalogField(catalog, column.key) : undefined
    for (const d of docs) {
      let cell: RoomCell
      const pendingDoc = d.analysisStatus !== 'DONE'
      if (column.kind === 'field') {
        const v = values.get(d.id)?.[field?.key ?? column.key]
        if (v && v.value !== null) {
          cell = {
            ...EMPTY, state: 'answered', value: v.value, display: v.display, quote: clip(v.quote), occurrence: v.occurrence ?? 0,
            confidence: v.confidence, issue: v.issue ?? null, source: v.source, checked: v.verified, exhibit: v.exhibit ?? null,
          }
        } else {
          cell = { ...EMPTY, state: d.analysisStatus === 'FAILED' ? 'unread' : pendingDoc ? 'waiting' : running ? 'asking' : 'none' }
        }
      } else {
        // Asked again, the answer so far stands until the new one lands.
        const a = answerOf.get(`${column.id}:${d.id}`)
        if (a) {
          cell = a.error
            ? { ...EMPTY, state: 'failed', error: a.error }
            : {
              ...EMPTY, state: a.display ? 'answered' : 'none', value: a.value, display: a.display ?? '', quote: clip(a.quote),
              confidence: a.confidence, issue: a.issue, source: a.source, checked: !!a.checkedAt,
            }
        } else {
          const justRead = d.analysisStatus === 'DONE' && Date.now() - d.updatedAt.getTime() < JUST_READ_MS
          cell = { ...EMPTY, state: d.analysisStatus === 'FAILED' ? 'unread' : pendingDoc ? 'waiting' : running || justRead ? 'asking' : 'unasked' }
        }
      }
      counts[cell.state]++
      out.get(d.id)![column.id] = cell
    }
    views.push({
      ...column, run: column.run ?? null, counts,
      ...(column.kind === 'field' && { field: field ? { label: field.label, type: field.type, kind: field.kind } : null }),
    })
  }
  return { columns: views, cells: out }
}

// ─── What asking would take ───────────────────────────────────────────────────

/** Prompt and answer overhead of one /extract-fields call, beyond the document's own text (as lib/field-preview). */
const PROMPT_TOKENS = 700
const ANSWER_TOKENS = 150

export interface AskEstimate { documents: number; usd: number; byok: boolean; model: string | null }

/** Asking a question of every analysed document in the room: how many, and about what it costs. */
export async function estimateAsk(orgId: string, roomId: string): Promise<AskEstimate> {
  const [row] = await prisma.$queryRaw<Array<{ n: number; chars: bigint }>>`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(LENGTH(v."plainText")), 0)::bigint AS chars
    FROM contracts c JOIN contract_versions v ON v.id = c."currentVersionId"
    WHERE c."diligenceRoomId" = ${roomId} AND c."orgId" = ${orgId} AND c."deletedAt" IS NULL AND c."analysisStatus" = 'DONE'`
  const documents = row?.n ?? 0
  let model: string | null = null
  let byok = false
  try {
    const llm = await resolveLlm(orgId, 'default')
    model = llm.model
    byok = llm.source === 'byok'
  } catch { /* no key configured: priced at the default, which errs high */ }
  const input = Math.ceil(Number(row?.chars ?? 0) / 4) + documents * PROMPT_TOKENS
  return { documents, usd: tokenCostUsd(model ?? 'unknown', input, documents * ANSWER_TOKENS), byok, model }
}
