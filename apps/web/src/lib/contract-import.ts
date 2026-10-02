/**
 * docs/39 A16 — the import wizard's working out, kept apart from its screens:
 * which files are the spreadsheet and which the documents, which document goes
 * with which row, how many of a column's cells read as the field it goes to,
 * and a type or status column's distinct words.
 */
import {
  parseCurrency, parseFieldValue, readContractStatus, readContractType,
  type CatalogField, type ContractStatus, type ContractType, type DateOrder, type FieldValueType, type ImportTarget,
} from '@clm/types'

/** What POST /contracts/import/read answers. */
export interface SheetRead {
  filename: string
  sheetName: string | null
  headers: string[]
  rows: string[][]
  /** Rows in the sheet (only the first 1,000 are imported). */
  total: number
  suggestions: Array<ImportTarget | null>
}

/** One imported row's outcome (POST /contracts/import). */
export interface ImportRowResult {
  row: number
  ok: boolean
  contractId?: string
  title?: string
  file?: string | null
  issues: string[]
  error?: string
}

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
export const SHEET_EXTENSIONS = ['csv', 'tsv', 'xlsx'] as const
export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'doc', 'txt', 'png', 'jpg', 'jpeg', 'tif', 'tiff'] as const
export const isSheetFile = (name: string) => (SHEET_EXTENSIONS as readonly string[]).includes(ext(name))
export const isDocumentFile = (name: string) => (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext(name))

/** "contracts\\2024/Acme_MSA.PDF" → "acme_msa.pdf" */
const baseName = (name: string) => name.replace(/^.*[\\/]/, '').trim().toLowerCase()
/** "Acme_MSA (signed).pdf" → "acmemsasigned": the name as compared when the exact one doesn't match. */
const stemOf = (name: string) => baseName(name).replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]+/g, '')

export interface DocumentMatch {
  /** Each row's document, by row index (null: none). */
  fileOf: Array<string | null>
  /** Documents no row names: imported on their own. */
  unmatched: string[]
  /** Rows naming a document that isn't among the files. */
  missing: number[]
}

/**
 * Which document goes with which row: by the file-name column (its exact
 * name, else the same name without its extension and punctuation), or, with
 * no such column, by a title the same as a document's name. A document goes
 * with one row only.
 */
export function matchDocuments(rows: string[][], mapping: Array<ImportTarget | null>, files: readonly string[]): DocumentMatch {
  const fileCol = mapping.findIndex(t => t?.kind === 'file')
  const titleCol = mapping.findIndex(t => t?.kind === 'title')
  const byName = new Map<string, string>()
  const byStem = new Map<string, string>()
  for (const f of files) {
    if (!byName.has(baseName(f))) byName.set(baseName(f), f)
    const s = stemOf(f)
    if (s && !byStem.has(s)) byStem.set(s, f)
  }
  const used = new Set<string>()
  const missing: number[] = []
  const fileOf = rows.map((r, i) => {
    const named = fileCol >= 0 ? (r[fileCol] ?? '').trim() : ''
    const key = named || (fileCol < 0 && titleCol >= 0 ? (r[titleCol] ?? '').trim() : '')
    if (!key) return null
    const found = byName.get(baseName(key)) ?? byStem.get(stemOf(key))
    if (!found || used.has(found)) {
      if (named) missing.push(i)
      return null
    }
    used.add(found)
    return found
  })
  return { fileOf, unmatched: files.filter(f => !used.has(f)), missing }
}

export interface ColumnReading {
  /** Cells with something in them. */
  filled: number
  /** Of those, the ones that read as the target. */
  read: number
  /** A few that don't, as written. */
  unreadable: string[]
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** How a column's cells read as what it's mapped to: a field's type, an email, a type or status the app knows. */
export function readColumn(rows: string[][], col: number, target: ImportTarget | null, field: CatalogField | undefined, dateOrder: DateOrder): ColumnReading {
  const out: ColumnReading = { filled: 0, read: 0, unreadable: [] }
  for (const r of rows) {
    const cell = (r[col] ?? '').trim()
    if (!cell) continue
    out.filled++
    let ok = true
    if (target?.kind === 'owner') ok = EMAIL.test(cell)
    else if (target?.kind === 'type') ok = !!readContractType(cell)?.known
    else if (target?.kind === 'status') ok = !!readContractStatus(cell)?.known
    else if (target?.kind === 'field' && field) {
      ok = field.key === 'value'
        ? !!parseCurrency(cell)
        : parseFieldValue(field.type as FieldValueType, cell, { options: field.options ? [...field.options] : undefined, dateOrder }).ok
    }
    if (ok) out.read++
    else if (out.unreadable.length < 3 && !out.unreadable.includes(cell)) out.unreadable.push(cell)
  }
  return out
}

/** A column's distinct words, the most used first, with how many rows use each. */
export function distinctValues(rows: string[][], col: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const v = (r[col] ?? '').trim()
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** Each of a type column's words, as the app reads it (the person can change any). */
export const typeValuesOf = (rows: string[][], col: number): Record<string, ContractType> =>
  Object.fromEntries(distinctValues(rows, col).map(({ value }) => [value, readContractType(value)!.type]))

/** Each of a status column's words, as the app reads it — an approval's is a draft (X24). */
export const statusValuesOf = (rows: string[][], col: number): Record<string, ContractStatus> =>
  Object.fromEntries(distinctValues(rows, col).map(({ value }) => [value, readContractStatus(value)!.status]))

/** Splits a list into runs of `size`. */
export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** A sample spreadsheet with the columns people usually have. */
export const SAMPLE_CSV = [
  'Contract,Type,Status,Counterparty,Effective date,Expiry date,Value,Governing law,Auto renew,Owner,File',
  'Acme Master Services Agreement,MSA,Signed,Acme Corp,2024-05-01,2027-04-30,USD 250000,Delaware,Yes,,Acme_MSA.pdf',
  'SaaSCo Annual License,License,Signed,SaaSCo Ltd,2025-05-15,2026-05-14,USD 48000,California,Yes,,SaaSCo_License.pdf',
  'Brex Mutual NDA,NDA,Signed,Brex,2025-01-10,,,New York,No,,',
  '"Project Falcon, SOW #1",SOW,In negotiation,Falcon LLC,2026-06-01,2026-12-31,EUR 80000,England and Wales,,,',
].join('\n')
