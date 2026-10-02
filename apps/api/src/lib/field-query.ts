/**
 * docs/39 D3 — contracts by their field values: the list's filters, sort and
 * columns, and (reusing them) its export, the chart by field and the
 * assistant's search.
 *
 * Core fields kept in a contract column (value, dates, governing law,
 * counterparty) are read from the column, as every other screen reads them;
 * every other field from the field store's typed copies (valueNumber for
 * numbers, money and durations in days; valueDate; valueText). The filter
 * vocabulary is packages/types field-query.ts.
 */
import { Prisma } from '@prisma/client'
import {
  CORE_FIELDS, TYPE_FIELDS, coreField, formatFieldValue, filterNumber, validateFieldFilter, NUMERIC_TYPES,
  parseCurrency, parseDate, parseDuration, parseNumber,
  type CatalogField, type ContractSort, type FieldColumn, type FieldFilter, type FieldValueType,
} from '@clm/types'
import { prisma } from './prisma.js'
import { materializeContractFields } from './field-store.js'
import { computedConfidence, type FieldAccuracy } from './field-confidence.js'
import { CHECKED_SHARE_SQL, verificationFilterSql, type CheckedFilter } from './field-verification.js'

// ─── The catalogue ────────────────────────────────────────────────────────────

/** Every field the org's contracts can hold: core, each contract type's, the org's own. */
export async function fieldCatalog(orgId: string): Promise<CatalogField[]> {
  const out: CatalogField[] = CORE_FIELDS.filter(f => !f.legacy).map(f => ({
    key: f.key, label: f.label, type: f.type, kind: 'core' as const, contractTypes: null, group: f.group,
    ...(f.options && { options: f.options }), ...(f.unit && { unit: f.unit }), definition: f.definition,
  }))
  const byKey = new Map(out.map(f => [f.key, f]))
  for (const [contractType, fields] of Object.entries(TYPE_FIELDS)) {
    for (const f of fields) {
      const seen = byKey.get(f.key)
      if (seen) {
        if (seen.kind === 'type' && seen.contractTypes && !seen.contractTypes.includes(contractType)) seen.contractTypes.push(contractType)
        continue
      }
      const entry: CatalogField = { key: f.key, label: f.label, type: f.type, kind: 'type', contractTypes: [contractType] }
      out.push(entry)
      byKey.set(f.key, entry)
    }
  }
  const custom = await prisma.contractFieldDefinition.findMany({
    where: { orgId, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { fieldKey: true, fieldLabel: true, fieldType: true, options: true, helpText: true, contractType: true },
  })
  for (const d of custom) {
    const seen = byKey.get(d.fieldKey)
    if (seen) {
      // The same key defined for two types (or for all) is one field.
      if (seen.kind === 'custom') seen.contractTypes = !d.contractType || !seen.contractTypes ? null : [...new Set([...seen.contractTypes, d.contractType])]
      continue
    }
    const entry: CatalogField = {
      key: d.fieldKey, label: d.fieldLabel, type: d.fieldType as FieldValueType, kind: 'custom',
      contractTypes: d.contractType ? [d.contractType] : null,
      ...(Array.isArray(d.options) && d.options.length && { options: d.options.map(String) }),
      definition: d.helpText,
    }
    out.push(entry)
    byKey.set(d.fieldKey, entry)
  }
  return out
}

/** A key as the catalogue knows it (a core field's older spelling too). */
export function catalogField(catalog: CatalogField[], key: string): CatalogField | undefined {
  return catalog.find(f => f.key === key) ?? catalog.find(f => f.key === coreField(key)?.key)
}

// ─── Fields as the assistant names them ──────────────────────────────────────

const words = (s: string) => s.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-z0-9]+/gi, ' ').trim()

/** A field named by its key, an older spelling, or its label as people say it ("confidentiality period"). */
export function resolveFieldRef(catalog: CatalogField[], ref: string): CatalogField | undefined {
  const n = words(ref)
  return catalogField(catalog, ref) ?? catalog.find(f => words(f.label) === n) ?? catalog.find(f => words(f.key) === n)
}

/** Fields sharing a word with a name that matched none: said instead of a bare "no such field". */
export function similarFields(catalog: CatalogField[], ref: string, max = 5): CatalogField[] {
  const asked = new Set(words(ref).split(' ').filter(w => w.length > 3))
  return catalog.filter(f => words(f.label).split(' ').some(w => asked.has(w))).slice(0, max)
}

/** How a condition's words map to operators, tried in order: longer phrases before the words they contain. */
const CONDITION_OPS: Array<[RegExp, FieldFilter['op']]> = [
  [/^(?:is\s+empty|has\s+no\s+value|is\s+not\s+set|is\s+missing|is\s+blank)$/i, 'empty'],
  [/^(?:has\s+a\s+value|is\s+set|is\s+present|is\s+not\s+empty|is\s+filled\s+in)$/i, 'present'],
  [/^(?:is\s+)?between\s+(.+?)\s+and\s+(.+)$/i, 'between'],
  [/^(?:>=|≥|(?:is\s+)?at\s+least|(?:is\s+)?on\s+or\s+after)\s*(.+)$/i, 'gte'],
  [/^(?:<=|≤|(?:is\s+)?at\s+most|(?:is\s+)?on\s+or\s+before|(?:is\s+)?no\s+more\s+than)\s*(.+)$/i, 'lte'],
  [/^(?:<|(?:is\s+)?less\s+than|(?:is\s+)?fewer\s+than|(?:is\s+)?under|(?:is\s+)?below|(?:is\s+)?before|(?:is\s+)?shorter\s+than)\s*(.+)$/i, 'lt'],
  [/^(?:>|(?:is\s+)?more\s+than|(?:is\s+)?greater\s+than|(?:is\s+)?over|(?:is\s+)?above|(?:is\s+)?after|(?:is\s+)?longer\s+than)\s*(.+)$/i, 'gt'],
  [/^(?:!=|≠|is\s+not|isn['’]t|is\s+other\s+than)\s*(.+)$/i, 'is_not'],
  [/^(?:contains|includes|mentions|says)\s+(.+)$/i, 'contains'],
  [/^(?:in|is\s+(?:one|any)\s+of|(?:one|any)\s+of)\s+(.+)$/i, 'any_of'],
  [/^(?:==|=|:|is|equals)\s*(.+)$/i, 'is'],
]

const unquote = (s: string) => s.trim().replace(/^["'“‘](.*)["'”’]$/, '$1').trim()

/**
 * A field condition as the assistant writes it — "confidentiality period
 * >= 3 years", "region in EMEA, APAC", "governing law is Delaware",
 * "expense approver is empty" — as a filter. The field is found by name
 * first (the longest name the condition starts with), so a label that
 * contains "is" ("Value is") doesn't break it.
 */
export function parseFieldCondition(catalog: CatalogField[], text: string): { ok: true; filter: FieldFilter } | { ok: false; detail: string } {
  const said = text.trim()
  // Labels before keys, so a label wins where the two read alike.
  const byName = new Map<string, CatalogField>()
  for (const f of catalog) if (!byName.has(words(f.label))) byName.set(words(f.label), f)
  for (const f of catalog) if (!byName.has(words(f.key))) byName.set(words(f.key), f)
  // Runs of leading words that name a field, longest first, stopping at the first operator:
  // "confidentiality term > 2 years" starts with the key "confidentiality", but reads as no condition on it.
  const tokens = said.replace(/(>=|<=|!=|==|[<>=:≥≤≠])/g, ' $1 ').split(/\s+/).filter(Boolean)
  const candidates: Array<[CatalogField, number]> = []
  for (let i = 1; i <= tokens.length && /[a-z0-9]/i.test(tokens[i - 1]); i++) {
    const f = byName.get(words(tokens.slice(0, i).join(' ')))
    if (f) candidates.unshift([f, i])
  }
  for (const [field, used] of candidates) {
    const filter = readCondition(field, tokens.slice(used).join(' ').trim())
    if (filter) return { ok: true, filter }
  }
  const near = similarFields(catalog, said.split(/\s*(?:>=|<=|!=|[<>=:≥≤≠]|\bis\b|\bbetween\b|\bin\b|\bcontains\b)/i)[0] ?? said)
  return {
    ok: false,
    detail: `Couldn't read "${said}".${near.length ? ` Fields with a similar name: ${near.map(f => `${f.label} (${f.key})`).join(', ')}.` : ''}`
      + ' Write a condition as "<field> is …", ">= …", "between … and …", "in …, …", "contains …", "is empty" or "has a value".',
  }
}

/** The operator and value after a field's name, as a filter; null when they don't read as one. */
function readCondition(field: CatalogField, rest: string): FieldFilter | null {
  for (const [rx, op] of CONDITION_OPS) {
    const m = rest.match(rx)
    if (!m) continue
    let filter: FieldFilter = { key: field.key, op }
    if (op === 'between') filter = { ...filter, value: unquote(m[1]), to: unquote(m[2]) }
    // Choices by commas or "or" ("England and Wales" is one).
    else if (op === 'any_of') filter = { ...filter, value: m[1].split(/\s*(?:,|\bor\b)\s*/i).map(unquote).filter(Boolean) }
    else if (op !== 'empty' && op !== 'present') filter = { ...filter, value: unquote(m[1]) }
    // A choice "is" one option: any_of, the way choices are filtered.
    if ((field.type === 'select' || field.type === 'multiselect') && filter.op === 'is') filter = { ...filter, op: 'any_of', value: [filter.value] }
    // Money: a currency written with the amount ("USD 100,000", "€50k") is the filter's currency.
    if (field.type === 'currency' || coreField(field.key)?.column === 'value') {
      const written = [filter.value, filter.to].find((v): v is string => typeof v === 'string' && /\b[A-Z]{3}\b|[$€£¥₹]/.test(v))
      const code = written ? parseCurrency(written)?.currency : undefined
      if (code) filter = { ...filter, currency: code }
      const amount = (v: unknown) => (typeof v === 'string' ? parseCurrency(v)?.amount ?? v : v)
      filter = { ...filter, ...(filter.value !== undefined && { value: amount(filter.value) }), ...(filter.to !== undefined && { to: amount(filter.to) }) }
    }
    return {
      ...filter,
      ...(filter.value !== undefined && { value: coerceFilterValue(field, filter.op, filter.value) }),
      ...(filter.to !== undefined && { to: coerceFilterValue(field, filter.op, filter.to) }),
    }
  }
  return null
}

/**
 * A filter's value as the assistant may write it — "3 years", "120,000",
 * "yes", "emea" — in the field's own shape; anything unreadable is left for
 * validateFieldFilter to refuse.
 */
export function coerceFilterValue(field: CatalogField, op: FieldFilter['op'], v: unknown): unknown {
  if (v === undefined || v === null) return v
  switch (field.type) {
    case 'duration':
      return typeof v === 'object' ? v : parseDuration(v as string | number, 'days') ?? v
    case 'number':
    case 'percentage':
    case 'currency':
      return typeof v === 'number' ? v : parseNumber(String(v).replace(/[%$€£¥₹]|[A-Z]{3}/g, '').trim()) ?? v
    case 'boolean':
      if (typeof v === 'boolean') return v
      return /^(y|yes|true)$/i.test(String(v).trim()) ? true : /^(n|no|false)$/i.test(String(v).trim()) ? false : v
    case 'date':
      return typeof v === 'string' ? parseDate(v)?.iso ?? v : v
    case 'select':
    case 'multiselect': {
      // Choices as defined, whatever the case they were asked in.
      const pick = (x: unknown) => (field.options ?? []).find(o => o.toLowerCase() === String(x).trim().toLowerCase()) ?? String(x)
      const list = (Array.isArray(v) ? v : [v]).map(pick)
      return op === 'any_of' ? list : list[0]
    }
    default:
      // "governing law in Delaware, New York": words, any of several.
      if (op === 'any_of') return (Array.isArray(v) ? v : [v]).map(x => String(x).trim()).filter(Boolean)
      return String(v)
  }
}

// ─── SQL pieces ───────────────────────────────────────────────────────────────

/** A JSON value that holds something: not SQL NULL, JSON null, or an empty list, text or object. */
export const present = (col: Prisma.Sql) => Prisma.sql`(${col} IS NOT NULL AND ${col} NOT IN ('null'::jsonb, '[]'::jsonb, '""'::jsonb, '{}'::jsonb))`

/** The column a core field lives in, as SQL over `contracts c`. The currency column defaults to USD, so it counts only beside a value. */
export function columnSql(column: FieldColumn): Prisma.Sql {
  switch (column) {
    case 'effectiveDate':    return Prisma.sql`c."effectiveDate"`
    case 'expiryDate':       return Prisma.sql`c."expiryDate"`
    case 'value':            return Prisma.sql`c.value`
    case 'currency':         return Prisma.sql`(CASE WHEN c.value IS NULL THEN NULL ELSE c.currency END)`
    case 'jurisdiction':     return Prisma.sql`c.jurisdiction`
    case 'counterpartyName': return Prisma.sql`c."counterpartyName"`
  }
}

export const columnOf = (field: CatalogField): FieldColumn | undefined => field.kind === 'core' ? coreField(field.key)?.column : undefined

const likeOf = (s: string) => `%${s.trim().replace(/[\\%_]/g, m => `\\${m}`)}%`

/** Comparisons shared by a column and a typed copy. */
function compare(expr: Prisma.Sql, f: FieldFilter, type: FieldValueType): Prisma.Sql {
  const bound = (v: unknown) => type === 'date' ? Prisma.sql`${String(v)}::date` : Prisma.sql`${filterNumber(type, v)}`
  const e = type === 'date' ? Prisma.sql`${expr}::date` : expr
  switch (f.op) {
    case 'gte':     return Prisma.sql`${e} >= ${bound(f.value)}`
    case 'lte':     return Prisma.sql`${e} <= ${bound(f.value)}`
    case 'lt':      return Prisma.sql`${e} < ${bound(f.value)}`
    case 'gt':      return Prisma.sql`${e} > ${bound(f.value)}`
    case 'between': return Prisma.sql`${e} BETWEEN ${bound(f.value)} AND ${bound(f.to)}`
    default:        return Prisma.sql`${e} = ${bound(f.value)}`
  }
}

/** A filter on a core field's column. */
function columnFilter(field: CatalogField, column: FieldColumn, f: FieldFilter): Prisma.Sql {
  const col = columnSql(column)
  const textual = field.type === 'text'
  if (f.op === 'present') return textual ? Prisma.sql`COALESCE(${col}, '') <> ''` : Prisma.sql`${col} IS NOT NULL`
  if (f.op === 'empty') return textual ? Prisma.sql`COALESCE(${col}, '') = ''` : Prisma.sql`${col} IS NULL`
  if (textual) {
    if (f.op === 'any_of') return Prisma.sql`lower(${col}) IN (${Prisma.join((f.value as string[]).map(x => x.trim().toLowerCase()))})`
    const v = String(f.value ?? '')
    if (f.op === 'contains') return Prisma.sql`${col} ILIKE ${likeOf(v)}`
    if (f.op === 'is_not') return Prisma.sql`(${col} IS NULL OR lower(${col}) <> lower(${v.trim()}))`
    return Prisma.sql`lower(${col}) = lower(${v.trim()})`
  }
  const cmp = compare(col, f, field.type)
  // Money in a column: the contract value, with its currency beside it.
  return column === 'value' && f.currency ? Prisma.sql`(${cmp} AND c.currency = ${f.currency.toUpperCase()})` : cmp
}

/** A filter on a field-store value: EXISTS over its row, with its typed copies. */
function storeFilter(field: CatalogField, f: FieldFilter): Prisma.Sql {
  const has = (cond: Prisma.Sql) => Prisma.sql`EXISTS (SELECT 1 FROM contract_field_values f WHERE f."contractId" = c.id AND f."fieldKey" = ${field.key} AND ${cond})`
  const value = present(Prisma.sql`f.value`)
  if (f.op === 'present') return has(value)
  if (f.op === 'empty') return Prisma.sql`NOT ${has(value)}`
  const t = field.type
  if (NUMERIC_TYPES.has(t)) {
    const cmp = compare(Prisma.sql`f."valueNumber"`, f, t)
    return has(t === 'currency' && f.currency ? Prisma.sql`${cmp} AND f."valueText" = ${f.currency.toUpperCase()}` : cmp)
  }
  if (t === 'date') return has(compare(Prisma.sql`f."valueDate"`, f, t))
  if (t === 'boolean') return has(Prisma.sql`f."valueText" = ${f.value ? 'true' : 'false'}`)
  if (t === 'multiselect') {
    const any = (f.value as string[]).map(o => Prisma.sql`f.value @> ${JSON.stringify([o])}::jsonb`)
    return has(Prisma.sql`(${Prisma.join(any, ' OR ')})`)
  }
  if (t === 'select') {
    if (f.op === 'is_not') return Prisma.sql`NOT ${has(Prisma.sql`f."valueText" = ${String(f.value)}`)}`
    return has(Prisma.sql`f."valueText" IN (${Prisma.join((f.value as string[]).map(String))})`)
  }
  // Text, long text and parties (valueText holds the names).
  if (f.op === 'any_of') return has(Prisma.sql`lower(f."valueText") IN (${Prisma.join((f.value as string[]).map(x => x.trim().toLowerCase()))})`)
  const v = String(f.value ?? '')
  if (f.op === 'contains') return has(Prisma.sql`f."valueText" ILIKE ${likeOf(v)}`)
  if (f.op === 'is_not') return Prisma.sql`NOT ${has(Prisma.sql`lower(f."valueText") = lower(${v.trim()})`)}`
  return has(Prisma.sql`lower(f."valueText") = lower(${v.trim()})`)
}

/** A field's value to sort by: its column, or its typed copy. */
function sortExpr(field: CatalogField): Prisma.Sql {
  const column = columnOf(field)
  if (column) return field.type === 'text' ? Prisma.sql`lower(${columnSql(column)})` : columnSql(column)
  const copy = NUMERIC_TYPES.has(field.type) ? Prisma.sql`f."valueNumber"`
    : field.type === 'date' ? Prisma.sql`f."valueDate"`
      : Prisma.sql`lower(f."valueText")`
  return Prisma.sql`(SELECT ${copy} FROM contract_field_values f WHERE f."contractId" = c.id AND f."fieldKey" = ${field.key} LIMIT 1)`
}

const BUILT_IN_SORTS: Record<string, Prisma.Sql> = {
  createdAt: Prisma.sql`c."createdAt"`,
  updatedAt: Prisma.sql`c."updatedAt"`,
  title:     Prisma.sql`lower(c.title)`,
  status:    Prisma.sql`c.status`,
  riskScore: Prisma.sql`c."riskScore"`,
  // B3 — the share of its values a person checked.
  checked:   CHECKED_SHARE_SQL,
}

// ─── The query ────────────────────────────────────────────────────────────────

export interface ContractQuery {
  orgId: string
  /** Own-scope callers: only their contracts. */
  ownerId?: string
  /** Title or counterparty contains. */
  q?: string
  /** Only these contracts (a search's matches), kept in this order unless sorted. */
  ids?: string[]
  type?: string
  status?: string
  counterpartyId?: string
  counterpartyName?: string
  jurisdiction?: string
  expiryDateTo?: string
  riskScoreMin?: number
  riskScoreMax?: number
  otdMin?: number
  otdMax?: number
  uptimeSlaMin?: number
  uptimeSlaMax?: number
  /** B3 — Verified, Partly verified or Unverified. */
  checked?: CheckedFilter
  /** A16 — the contracts one import made. */
  importBatch?: string
  where?: FieldFilter[]
  sort?: ContractSort
  offset: number
  limit: number
}

export type QueryOutcome = { ok: true; ids: string[]; total: number } | { ok: false; detail: string }

/** Contracts still holding their values only in the legacy blobs, read into the store before a field filter or sort needs them. */
const MATERIALIZE_PER_QUERY = 100

export async function materializePending(orgId: string): Promise<void> {
  const pending = await prisma.contract.findMany({
    where: { orgId, deletedAt: null, fieldValues: { none: {} }, OR: [{ fieldConfidence: { not: {} } }, { keyTerms: { not: {} } }] },
    select: { id: true },
    take: MATERIALIZE_PER_QUERY,
  })
  for (const c of pending) {
    try { await materializeContractFields(c.id) } catch { /* one contract's blobs unreadable: it simply doesn't match */ }
  }
}

export async function queryContractIds(input: ContractQuery, catalog: CatalogField[]): Promise<QueryOutcome> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`c."orgId" = ${input.orgId}`,
    Prisma.sql`c."deletedAt" IS NULL`,
    Prisma.sql`c."diligenceRoomId" IS NULL`,
  ]
  if (input.ownerId) conds.push(Prisma.sql`c."ownerId" = ${input.ownerId}`)
  if (input.ids) conds.push(input.ids.length ? Prisma.sql`c.id IN (${Prisma.join(input.ids)})` : Prisma.sql`FALSE`)
  if (input.type) conds.push(Prisma.sql`c.type = ${input.type}`)
  if (input.status) conds.push(Prisma.sql`c.status = ${input.status}`)
  if (input.jurisdiction) conds.push(Prisma.sql`c.jurisdiction = ${input.jurisdiction}`)
  // Counterparty by id or by name: contracts from before the link have only the name.
  if (input.counterpartyId || input.counterpartyName) {
    const or: Prisma.Sql[] = []
    if (input.counterpartyId) or.push(Prisma.sql`c."counterpartyId" = ${input.counterpartyId}`)
    if (input.counterpartyName) or.push(Prisma.sql`c."counterpartyName" = ${input.counterpartyName}`)
    conds.push(Prisma.sql`(${Prisma.join(or, ' OR ')})`)
  }
  if (input.q?.trim()) {
    const like = likeOf(input.q)
    conds.push(Prisma.sql`(c.title ILIKE ${like} OR c."counterpartyName" ILIKE ${like})`)
  }
  // As GET /contracts: expiring from today until the date.
  if (input.expiryDateTo) conds.push(Prisma.sql`c."expiryDate" >= now() AND c."expiryDate" <= ${new Date(input.expiryDateTo)}`)
  if (input.riskScoreMin !== undefined) conds.push(Prisma.sql`c."riskScore" >= ${input.riskScoreMin}`)
  if (input.riskScoreMax !== undefined) conds.push(Prisma.sql`c."riskScore" <= ${input.riskScoreMax}`)
  // U12's SLA facets, kept in metadata by the seeded logistics and cloud contracts.
  const sla = (key: string, op: '>=' | '<=', v: number) =>
    Prisma.sql`(c.metadata->>${key}) ~ '^-?[0-9.]+$' AND (c.metadata->>${key})::numeric ${Prisma.raw(op)} ${v}`
  if (input.otdMin !== undefined) conds.push(sla('otdSlaPct', '>=', input.otdMin))
  if (input.otdMax !== undefined) conds.push(sla('otdSlaPct', '<=', input.otdMax))
  if (input.uptimeSlaMin !== undefined) conds.push(sla('uptimeSlaPct', '>=', input.uptimeSlaMin))
  if (input.uptimeSlaMax !== undefined) conds.push(sla('uptimeSlaPct', '<=', input.uptimeSlaMax))
  if (input.checked) conds.push(verificationFilterSql(input.checked))
  if (input.importBatch) conds.push(Prisma.sql`c.metadata->'_import'->>'batch' = ${input.importBatch}`)

  let usesStore = false
  for (const f of input.where ?? []) {
    const field = catalogField(catalog, f.key)
    if (!field) return { ok: false, detail: `No field named “${f.key}”` }
    const why = validateFieldFilter(field.type, f)
    if (why) return { ok: false, detail: `${field.label}: ${why}` }
    const column = columnOf(field)
    if (!column) usesStore = true
    conds.push(column ? columnFilter(field, column, f) : storeFilter(field, f))
  }

  let order: Prisma.Sql
  const dir = Prisma.raw(input.sort?.dir === 'asc' ? 'ASC' : 'DESC')
  if (input.sort && BUILT_IN_SORTS[input.sort.key]) {
    order = Prisma.sql`${BUILT_IN_SORTS[input.sort.key]} ${dir} NULLS LAST`
  } else if (input.sort) {
    const field = catalogField(catalog, input.sort.key)
    if (!field) return { ok: false, detail: `No field named “${input.sort.key}”` }
    if (!columnOf(field)) usesStore = true
    order = Prisma.sql`${sortExpr(field)} ${dir} NULLS LAST`
  } else if (input.ids?.length) {
    // A search's matches keep their relevance order.
    order = Prisma.sql`array_position(ARRAY[${Prisma.join(input.ids)}]::text[], c.id)`
  } else {
    order = Prisma.sql`c."createdAt" DESC`
  }

  if (usesStore) await materializePending(input.orgId)

  const rows = await prisma.$queryRaw<Array<{ id: string; total: number }>>`
    SELECT c.id, (COUNT(*) OVER ())::int AS total FROM contracts c
    WHERE ${Prisma.join(conds, ' AND ')}
    ORDER BY ${order}, c."createdAt" DESC, c.id DESC
    OFFSET ${input.offset} LIMIT ${input.limit}`
  if (rows.length) return { ok: true, ids: rows.map(r => r.id), total: rows[0].total }
  // Past the last page, the count still answers.
  if (input.offset === 0) return { ok: true, ids: [], total: 0 }
  const [n] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM contracts c WHERE ${Prisma.join(conds, ' AND ')}`
  return { ok: true, ids: [], total: n?.n ?? 0 }
}

// ─── Cells ────────────────────────────────────────────────────────────────────

/** One field's value on one contract, as the list shows it. */
export interface FieldCell {
  value: unknown
  display: string
  source: string | null
  verified: boolean
  confidence: number | null
  /**
   * docs/39 D6 — where it came from, when asked for (a diligence room's
   * cells): the words as placed in the text (else as quoted), which of the
   * passages worded alike, and why to doubt it.
   */
  quote?: string | null
  occurrence?: number
  issue?: string | null
  /** A12 — the words are in an exhibit read with the contract, not in its own text. */
  exhibit?: string | null
}

type CellContract = {
  id: string
  value: Prisma.Decimal | number | string | null
  currency: string | null
  effectiveDate: Date | null
  expiryDate: Date | null
  jurisdiction: string | null
  counterpartyName: string | null
  keyTerms: unknown
  metadata: unknown
}

function fromColumn(column: FieldColumn, c: CellContract): unknown {
  switch (column) {
    case 'effectiveDate':    return c.effectiveDate ? c.effectiveDate.toISOString().slice(0, 10) : null
    case 'expiryDate':       return c.expiryDate ? c.expiryDate.toISOString().slice(0, 10) : null
    case 'value':            return c.value != null ? Number(c.value) : null
    case 'currency':         return c.value != null ? c.currency : null
    case 'jurisdiction':     return c.jurisdiction
    case 'counterpartyName': return c.counterpartyName
  }
}

/** A value only in the legacy blobs (a contract nobody has touched since the store). */
function fromLegacy(field: CatalogField, c: CellContract): unknown {
  const meta = (c.metadata ?? {}) as Record<string, unknown>
  if (field.kind === 'custom') return meta[field.key] ?? null
  if (field.kind === 'type') return ((meta._typeFields ?? {}) as Record<string, { value?: unknown }>)[field.key]?.value ?? null
  const terms = (c.keyTerms ?? {}) as Record<string, unknown>
  for (const k of [field.key, ...(coreField(field.key)?.aliases ?? [])]) if (terms[k] != null) return terms[k]
  return null
}

function cellConfidence(
  r: { source: string; verifiedAt: Date | null; confidence: number | null; quote: string | null; issue: string | null; anchor: unknown },
  value: unknown, accuracy: FieldAccuracy | undefined,
): number | null {
  const a = r.anchor && typeof r.anchor === 'object' ? r.anchor as { start?: number | null; noText?: boolean; exhibit?: unknown } : null
  return computedConfidence({
    source: r.source, verifiedAt: r.verifiedAt, model: r.confidence, quote: r.quote, issue: r.issue,
    gone: !!r.quote && !!a && a.start === null && !a.noText && !a.exhibit, hasValue: value !== null, value,
  }, accuracy).confidence
}

/** A value's words as the store placed them in the text (else as the AI quoted them). */
function sourceOf(r: { quote: string | null; issue: string | null; anchor: unknown } | undefined): Pick<FieldCell, 'quote' | 'occurrence' | 'issue' | 'exhibit'> {
  const a = r?.anchor && typeof r.anchor === 'object' ? r.anchor as { text?: string | null; occurrence?: number | null; exhibit?: { label?: string } } : null
  return { quote: a?.text || r?.quote || null, occurrence: a?.occurrence ?? 0, issue: r?.issue ?? null, exhibit: a?.exhibit?.label ?? null }
}

/**
 * The chosen fields' values on each contract, keyed by contract then field.
 * B3 — a cell's confidence is the computed one (field-confidence), when the
 * org's field records are given.
 */
export async function fieldCells(
  contracts: CellContract[], keys: string[], catalog: CatalogField[], accuracy?: Map<string, FieldAccuracy>,
  opts: { sources?: boolean } = {},
): Promise<Map<string, Record<string, FieldCell>>> {
  const fields = keys.map(k => catalogField(catalog, k)).filter((f): f is CatalogField => !!f)
  const out = new Map<string, Record<string, FieldCell>>(contracts.map(c => [c.id, {}]))
  if (!fields.length || !contracts.length) return out
  const rows = await prisma.contractFieldValue.findMany({
    where: { contractId: { in: contracts.map(c => c.id) }, fieldKey: { in: fields.map(f => f.key) } },
    select: { contractId: true, fieldKey: true, value: true, source: true, verifiedAt: true, confidence: true, quote: true, issue: true, anchor: true },
  })
  const rowOf = new Map(rows.map(r => [`${r.contractId}:${r.fieldKey}`, r]))
  for (const c of contracts) {
    const cells = out.get(c.id)!
    for (const field of fields) {
      const r = rowOf.get(`${c.id}:${field.key}`)
      const column = columnOf(field)
      const value = column ? fromColumn(column, c) : r ? r.value : fromLegacy(field, c)
      const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
      cells[field.key] = {
        value: empty ? null : value,
        // The contract value is a number with its currency in a field of its own: shown together, as money.
        display: empty ? ''
          : column === 'value' ? formatFieldValue('currency', { amount: Number(value), currency: c.currency ?? 'USD' })
            // A number's unit, as the Fields panel shows it: "30 days".
            : field.unit ? `${formatFieldValue(field.type, value)} ${field.unit}`
              : formatFieldValue(field.type, value),
        source: r?.source ?? null,
        verified: !!r?.verifiedAt,
        confidence: r ? cellConfidence(r, empty ? null : value, accuracy?.get(field.key)) : null,
        ...(opts.sources && !empty && sourceOf(r)),
      }
    }
  }
  return out
}
