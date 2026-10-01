/**
 * docs/39 A16 — contracts imported from a spreadsheet, with their documents.
 *
 * The CSV import took nine fixed columns, no documents, and kept a contract
 * type list of its own. Now each column of a sheet (CSV or Excel) goes where
 * the person points it — the title, type, status, owner, the document the
 * row goes with, or any field the org's contracts hold — and each row's
 * values are written through the field store as Imported: a person's values,
 * which an analysis never replaces (the AI's different reading of the
 * document waits beside the value, in the Review Queue).
 *
 * A row becomes a contract at once; one with a document waits for it (POST
 * /contracts/:id/import-document), which is then read by the AI like any
 * upload. The wizard sends the rows a chunk at a time with the same batch, so
 * a large sheet shows its progress, and the batch finds the contracts again
 * (the contracts list's import filter).
 */
import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  AuditAction, ContractType, IMPORTABLE_STATUSES, parseCurrency, parseFieldValue, readContractStatus, readContractType,
  type CatalogField, type DateOrder, type FieldValueType, type ImportTarget,
} from '@clm/types'
import { prisma } from './prisma.js'
import { fieldCatalog, catalogField } from './field-query.js'
import { setFieldValues, type PersonValue } from './field-store.js'
import { orgDateOrder } from './org-date-order.js'
import { createAuditEvent } from './audit.js'
import { indexContract, reindexContract } from './elasticsearch.js'
import { clearFieldAccuracy } from './field-confidence.js'

export const newImportBatch = () => `imp_${randomBytes(6).toString('hex')}`

/** The rows of one chunk, each with its row number in the sheet (0: a document without a row) and the document it goes with. */
export interface ImportRow { row: number; cells: string[]; file?: string | null }

export interface ImportPlan {
  headers: string[]
  mapping: Array<ImportTarget | null>
  /** How each value of the type column reads, as the person left it (else as readContractType reads it). */
  typeValues?: Record<string, string>
  /** How each value of the status column reads, as the person left it (else as readContractStatus reads it). */
  statusValues?: Record<string, string>
  /** A row without a status: a draft, or signed. */
  defaultStatus?: 'DRAFT' | 'EXECUTED'
}

export interface ImportRowResult {
  row: number
  ok: boolean
  contractId?: string
  title?: string
  /** The document the contract waits for. */
  file?: string | null
  /** Values left out, and why. */
  issues: string[]
  /** Why the row wasn't imported. */
  error?: string
}

const CONTRACT_TYPES = new Set<string>(Object.values(ContractType))
const STATUSES = new Set<string>(IMPORTABLE_STATUSES)

/** "acme_msa-2024 (signed).pdf" → "Acme msa 2024 (signed)": a title from a document's name, as an upload names one. */
export function titleFromFile(name: string): string {
  const t = name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** What a value of each type is, to say what a cell isn't. */
const NOUN: Partial<Record<FieldValueType, string>> = {
  date: 'a date', number: 'a number', currency: 'an amount', duration: 'a length of time', percentage: 'a percentage',
  boolean: 'a yes or no', parties: 'a list of parties',
}

/** A field's value as the sheet has it: parsed for the field (an amount's currency read with it), or why it can't be. */
function readValue(field: CatalogField, raw: string, dateOrder: DateOrder): { ok: true; raw: unknown } | { ok: false; why: string } {
  // A contract value with its currency ("EUR 12,000", "$4.5k") is an amount.
  if (field.key === 'value') {
    const c = parseCurrency(raw)
    return c ? { ok: true, raw: c.amount } : { ok: false, why: 'isn’t an amount' }
  }
  const parsed = parseFieldValue(field.type as FieldValueType, raw, { options: field.options ? [...field.options] : undefined, dateOrder })
  if (parsed.ok) return { ok: true, raw }
  const choices = field.options?.length ? `one of ${field.options.join(', ')}` : null
  return { ok: false, why: `isn’t ${(field.type === 'select' || field.type === 'multiselect') && choices ? choices : NOUN[field.type as FieldValueType] ?? 'something this field holds'}` }
}

/**
 * Imports one chunk of a sheet's rows. Each row is its own contract: one that
 * can't be made (no title, no document to name it by) is reported and the
 * rest go on; a value that can't be read is left out and said.
 */
export async function importRows(input: {
  orgId: string
  userId: string
  /** Who owns a row without an owner of its own (the importer; an API key's maker). */
  ownerId: string
  batch: string
  plan: ImportPlan
  rows: ImportRow[]
  ipAddress?: string
}): Promise<ImportRowResult[]> {
  const { orgId, plan } = input
  const catalog = await fieldCatalog(orgId)
  const dateOrder = await orgDateOrder(orgId)
  const col = (kind: ImportTarget['kind']) => plan.mapping.findIndex(t => t?.kind === kind)
  const at = { title: col('title'), type: col('type'), status: col('status'), owner: col('owner') }
  const fieldCols = plan.mapping
    .map((t, i) => (t?.kind === 'field' ? { i, field: catalogField(catalog, t.key) } : null))
    .filter((x): x is { i: number; field: CatalogField | undefined } => !!x)
  const currencyCol = fieldCols.find(f => f.field?.key === 'currency')?.i ?? -1

  // Owners by email, once for the chunk.
  const emails = at.owner >= 0 ? [...new Set(input.rows.map(r => r.cells[at.owner]?.trim().toLowerCase()).filter(Boolean))] : []
  const users = emails.length
    ? await prisma.user.findMany({ where: { orgId, email: { in: emails, mode: 'insensitive' }, status: { not: 'DEACTIVATED' } }, select: { id: true, email: true } })
    : []
  const ownerOf = new Map(users.map(u => [u.email.toLowerCase(), u.id]))

  const out: ImportRowResult[] = []
  for (const r of input.rows) {
    const cell = (i: number) => (i >= 0 ? (r.cells[i] ?? '').trim() : '')
    const issues: string[] = []
    const title = cell(at.title) || (r.file ? titleFromFile(r.file) : '')
    if (!title) {
      out.push({ row: r.row, ok: false, issues, error: 'It has no title, and no document to name it by.' })
      continue
    }

    // The type, as the person mapped the sheet's word for it.
    const rawType = cell(at.type)
    let type: string = ContractType.OTHER
    if (rawType) {
      const chosen = plan.typeValues?.[rawType]
      const read = chosen && CONTRACT_TYPES.has(chosen) ? { type: chosen, known: true } : readContractType(rawType)
      type = read?.type ?? ContractType.OTHER
      if (read && !read.known) issues.push(`Type “${rawType}” isn’t one the app knows: imported as Other.`)
    }

    // The status: an approval's (X24) is a draft's, unless the person chose otherwise.
    const rawStatus = cell(at.status)
    let status: string = plan.defaultStatus ?? 'DRAFT'
    if (rawStatus) {
      const chosen = plan.statusValues?.[rawStatus]
      if (chosen && STATUSES.has(chosen)) status = chosen
      else {
        const read = readContractStatus(rawStatus)
        if (read) status = read.status
        if (read?.workflow) issues.push(`Status “${rawStatus}” is set by an approval, not an import: imported as ${status === 'DRAFT' ? 'Draft' : status}.`)
        else if (read && !read.known) issues.push(`Status “${rawStatus}” isn’t one the app knows: imported as ${status === 'DRAFT' ? 'Draft' : status}.`)
      }
    }

    let ownerId = input.ownerId
    const email = cell(at.owner).toLowerCase()
    if (email) {
      const found = ownerOf.get(email)
      if (found) ownerId = found
      else issues.push(`No one here has the email ${email}: you own it.`)
    }

    // The fields, as the sheet has them; one that can't be read, or doesn't
    // belong to this type of contract, is left out and said.
    const values: PersonValue[] = []
    for (const { i, field } of fieldCols) {
      const raw = cell(i)
      if (!raw || !field) continue
      if (field.contractTypes && !field.contractTypes.includes(type)) {
        issues.push(`${field.label} is kept for ${field.contractTypes.map(t => t.replace(/_/g, ' ')).join(', ')} contracts: left out.`)
        continue
      }
      const read = readValue(field, raw, dateOrder)
      if (!read.ok) {
        issues.push(`${field.label}: “${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}” ${read.why} — left empty.`)
        continue
      }
      values.push({ key: field.key, raw: read.raw, source: 'import' })
      // An amount written with its currency sets the currency too, unless the sheet has a column for it.
      if (field.key === 'value' && currencyCol < 0) {
        const c = parseCurrency(raw)
        if (c && /[A-Za-z$€£¥₹]/.test(raw)) values.push({ key: 'currency', raw: c.currency, source: 'import' })
      }
    }

    try {
      const contract = await prisma.contract.create({
        data: {
          orgId, ownerId, createdBy: input.userId, title: title.slice(0, 500), type, status,
          // A record until its document arrives (import-document reads it then).
          analysisStatus: 'DONE',
          tags: ['imported'],
          metadata: {
            _import: { batch: input.batch, row: r.row, ...(r.file && { file: r.file }) },
            // A13 — a type the sheet gave stands through the analysis.
            ...(rawType && { _typeSource: 'person' }),
          },
        },
        select: { id: true, title: true, type: true, status: true, tags: true, createdAt: true },
      })
      if (values.length) {
        const w = await setFieldValues({ orgId, contractId: contract.id, userId: input.userId, values, audit: { source: 'import', ipAddress: input.ipAddress }, skipApprovalReset: true, bulk: true })
        if (!w.ok) issues.push(`Its values couldn’t be saved: ${w.detail}`)
      }
      await createAuditEvent({
        orgId, userId: input.userId, action: AuditAction.CONTRACT_CREATED, resourceType: 'contract', resourceId: contract.id,
        metadata: { source: 'import', batch: input.batch, row: r.row, fields: values.map(v => v.key), ...(r.file && { file: r.file }) },
        ipAddress: input.ipAddress,
      })
      // Found by search from the start; values the store wrote go in with a re-index.
      if (values.length) reindexContract(contract.id).catch(() => {})
      else indexContract(contract.id, { orgId, title: contract.title, type: contract.type, status: contract.status, plainText: '', tags: contract.tags, createdAt: contract.createdAt.toISOString() } as never).catch(() => {})
      out.push({ row: r.row, ok: true, contractId: contract.id, title: contract.title, file: r.file ?? null, issues })
    } catch (err) {
      out.push({ row: r.row, ok: false, title, issues, error: (err as Error).message.slice(0, 200) })
    }
  }
  // B3 — the fields' records count people's values: counted again next time they're read.
  clearFieldAccuracy(orgId)
  return out
}

/** An imported contract still waiting for its document: made by an import, with no version yet. */
export async function waitingForDocument(orgId: string, contractId: string): Promise<{ id: string; metadata: Prisma.JsonValue } | null> {
  const c = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null, currentVersionId: null },
    select: { id: true, metadata: true },
  })
  const imported = c?.metadata && typeof c.metadata === 'object' && !Array.isArray(c.metadata) && (c.metadata as Record<string, unknown>)._import
  return imported ? c : null
}
