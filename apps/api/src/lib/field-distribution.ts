/**
 * docs/39 D3 — how a field's values spread across the portfolio, for the
 * chart by field on Analytics: "how many contracts auto-renew", "payment
 * terms, by days", "confidentiality periods", "expiring when".
 *
 * Each bar carries the filters that list exactly its contracts, so a click
 * opens them in the contracts list (ranges as "≥ low" and "< high", so a
 * value on a boundary lands in one bar and one list). Contracts the field
 * applies to without a value are a bar of their own: a portfolio where half
 * the contracts were never read for the field is not the same as one where
 * half say "no".
 */
import { Prisma } from '@prisma/client'
import {
  formatFieldValue, type CatalogField, type DurationUnit, type DurationValue, type FieldFilter, type FieldValueType,
} from '@clm/types'
import { prisma } from './prisma.js'
import { columnOf, columnSql, materializePending, present } from './field-query.js'

export interface FieldBucket { label: string; count: number; filters: FieldFilter[] }

export interface FieldDistribution {
  key: string
  label: string
  type: FieldValueType
  kind: 'category' | 'range' | 'time'
  buckets: FieldBucket[]
  /** Contracts the field applies to that hold no value. */
  empty: FieldBucket
  /** Contracts the field applies to, in scope. */
  total: number
  /** Values past the bars shown: less common words, or money in other currencies. */
  other: number
  /** Money: the currency charted, and every currency seen. */
  currency: string | null
  currencies: Array<{ code: string; count: number }>
  /** The one contract type the chart covers, when it covers one (the list link carries it). */
  contractType: string | null
}

/** The types a chart makes sense of: long text and party lists are for reading, not counting. */
export const CHARTABLE_TYPES: ReadonlySet<FieldValueType> = new Set(['text', 'select', 'multiselect', 'boolean', 'number', 'percentage', 'currency', 'duration', 'date'])

const TOP_WORDS = 12
const EXACT_MAX = 8
const MAX_ROWS = 50_000

type Row = { n: number | null; t: string | null; d: Date | null; j: unknown; cur: string | null }

// ─── Durations and numbers people read ───────────────────────────────────────

const DAY_UNITS: Array<[DurationUnit, number]> = [['years', 365], ['months', 30], ['weeks', 7], ['days', 1]]

/** Whole days as the duration people would write: 365 → 1 year, 90 → 3 months. */
export function daysToDuration(days: number): DurationValue {
  for (const [unit, size] of DAY_UNITS) if (days !== 0 && days % size === 0) return { value: days / size, unit }
  return { value: days, unit: 'days' }
}

const DURATION_STEPS = [7, 30, 90, 180, 365, 730, 1825, 3650]

function niceStep(span: number, buckets = 6): number {
  if (span <= 0) return 1
  const raw = span / buckets
  const mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag
}

const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n)

// ─── The distribution ────────────────────────────────────────────────────────

export async function fieldDistribution(
  input: { orgId: string; ownerId?: string; contractType?: string; currency?: string },
  field: CatalogField,
): Promise<FieldDistribution> {
  const base: FieldDistribution = {
    key: field.key, label: field.label, type: field.type, kind: 'category', buckets: [],
    empty: { label: 'No value', count: 0, filters: [{ key: field.key, op: 'empty' }] },
    total: 0, other: 0, currency: null, currencies: [], contractType: input.contractType ?? null,
  }
  // A field for some contract types covers only those.
  const types = input.contractType ? [input.contractType] : field.contractTypes
  if (input.contractType && field.contractTypes && !field.contractTypes.includes(input.contractType)) return base
  if (!input.contractType && field.contractTypes?.length === 1) base.contractType = field.contractTypes[0]

  const conds: Prisma.Sql[] = [
    Prisma.sql`c."orgId" = ${input.orgId}`, Prisma.sql`c."deletedAt" IS NULL`, Prisma.sql`c."diligenceRoomId" IS NULL`,
  ]
  if (input.ownerId) conds.push(Prisma.sql`c."ownerId" = ${input.ownerId}`)
  if (types?.length) conds.push(Prisma.sql`c.type IN (${Prisma.join(types)})`)
  const where = Prisma.join(conds, ' AND ')

  const column = columnOf(field)
  let rows: Row[]
  if (column) {
    const col = columnSql(column)
    rows = await prisma.$queryRaw<Row[]>`
      SELECT ${field.type === 'number' ? Prisma.sql`${col}::float8` : Prisma.sql`NULL::float8`} AS n,
             ${field.type === 'text' ? col : Prisma.sql`NULL::text`} AS t,
             ${field.type === 'date' ? col : Prisma.sql`NULL::timestamp`} AS d,
             NULL::jsonb AS j,
             ${column === 'value' ? Prisma.sql`c.currency` : Prisma.sql`NULL::text`} AS cur
      FROM contracts c WHERE ${where} LIMIT ${MAX_ROWS}`
  } else {
    await materializePending(input.orgId)
    rows = await prisma.$queryRaw<Row[]>`
      SELECT f."valueNumber" AS n, f."valueText" AS t, f."valueDate" AS d, f.value AS j, f."valueText" AS cur
      FROM contracts c
      LEFT JOIN contract_field_values f ON f."contractId" = c.id AND f."fieldKey" = ${field.key} AND ${present(Prisma.sql`f.value`)}
      WHERE ${where} LIMIT ${MAX_ROWS}`
  }
  base.total = rows.length
  const has = (r: Row) => column
    ? (field.type === 'text' ? !!r.t?.trim() : field.type === 'date' ? !!r.d : r.n !== null)
    : r.j !== null && r.j !== undefined
  const valued = rows.filter(has)
  base.empty.count = rows.length - valued.length
  const k = field.key

  // ── Words, choices, yes/no ──
  if (field.type === 'boolean') {
    const yes = valued.filter(r => r.t === 'true').length
    base.buckets = [
      { label: 'Yes', count: yes, filters: [{ key: k, op: 'is', value: true }] },
      { label: 'No', count: valued.length - yes, filters: [{ key: k, op: 'is', value: false }] },
    ]
    return base
  }
  if (field.type === 'select' || field.type === 'multiselect') {
    const counts = new Map<string, number>()
    for (const r of valued) {
      const vals = field.type === 'multiselect' && Array.isArray(r.j) ? (r.j as unknown[]).map(String) : [r.t ?? String(r.j)]
      for (const v of new Set(vals)) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    const order = [...(field.options ?? []), ...[...counts.keys()].filter(v => !(field.options ?? []).includes(v)).sort()]
    base.buckets = order.filter(v => counts.has(v)).map(v => ({ label: v, count: counts.get(v)!, filters: [{ key: k, op: 'any_of', value: [v] }] }))
    return base
  }
  if (field.type === 'text') {
    const groups = new Map<string, { count: number; forms: Map<string, number> }>()
    for (const r of valued) {
      const text = (r.t ?? '').trim()
      const g = groups.get(text.toLowerCase()) ?? { count: 0, forms: new Map() }
      g.count++
      g.forms.set(text, (g.forms.get(text) ?? 0) + 1)
      groups.set(text.toLowerCase(), g)
    }
    const ranked = [...groups.values()].sort((a, b) => b.count - a.count)
    base.buckets = ranked.slice(0, TOP_WORDS).map(g => {
      const label = [...g.forms.entries()].sort((a, b) => b[1] - a[1])[0][0]
      return { label, count: g.count, filters: [{ key: k, op: 'is', value: label }] }
    })
    base.other = ranked.slice(TOP_WORDS).reduce((s, g) => s + g.count, 0)
    return base
  }

  // ── Dates, by month or by year ──
  if (field.type === 'date') {
    base.kind = 'time'
    const days = valued.map(r => r.d!).sort((a, b) => a.getTime() - b.getTime())
    if (!days.length) return base
    const first = days[0], last = days[days.length - 1]
    const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth()
    const byYear = months > 24
    const keyOf = (d: Date) => byYear ? `${d.getUTCFullYear()}` : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const counts = new Map<string, number>()
    for (const d of days) counts.set(keyOf(d), (counts.get(keyOf(d)) ?? 0) + 1)
    base.buckets = [...counts.entries()].map(([key, count]) => {
      const [y, m] = key.split('-').map(Number)
      const start = byYear ? `${y}-01-01` : `${key}-01`
      const end = byYear ? `${y + 1}-01-01` : m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
      const label = byYear ? key : new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
      return { label, count, filters: [{ key: k, op: 'gte', value: start }, { key: k, op: 'lt', value: end }] }
    })
    return base
  }

  // ── Amounts, money, lengths of time, rates ──
  base.kind = 'range'
  let values = valued
  const money = field.type === 'currency' || column === 'value'
  if (money) {
    const byCode = new Map<string, number>()
    for (const r of valued) { const code = (r.cur ?? 'USD').toUpperCase(); byCode.set(code, (byCode.get(code) ?? 0) + 1) }
    base.currencies = [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count)
    base.currency = input.currency && byCode.has(input.currency.toUpperCase()) ? input.currency.toUpperCase() : base.currencies[0]?.code ?? null
    values = valued.filter(r => (r.cur ?? 'USD').toUpperCase() === base.currency)
    base.other = valued.length - values.length
  }
  const nums = values.map(r => r.n!).filter(n => Number.isFinite(n)).sort((a, b) => a - b)
  if (!nums.length) return base
  const cur = money && base.currency ? { currency: base.currency } : {}
  const duration = field.type === 'duration'
  const bound = (n: number): unknown => (duration ? daysToDuration(n) : n)
  // A range's ends read short ("USD 100K"); an exact amount in full ("USD 80,000").
  const show = (n: number, exact = false): string => {
    const num = exact ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : compact(n)
    return duration ? formatFieldValue('duration', daysToDuration(n))
      : money ? `${base.currency} ${num}`
        : field.type === 'percentage' ? `${num}%`
          : `${num}${field.unit ? ` ${field.unit}` : ''}`
  }

  const distinct = [...new Set(nums)]
  if (distinct.length <= EXACT_MAX) {
    // A handful of values (net 30 / 45 / 60): a bar each.
    base.buckets = distinct.map(v => ({
      label: show(v, true),
      count: nums.filter(n => n === v).length,
      filters: [{ key: k, op: 'is', value: bound(v), ...cur }],
    }))
    return base
  }
  const min = nums[0], max = nums[nums.length - 1]
  const step = duration
    ? DURATION_STEPS.find(s => Math.floor((max - Math.floor(min / s) * s) / s) + 1 <= 7) ?? DURATION_STEPS[DURATION_STEPS.length - 1]
    : niceStep(max - min)
  const lo = Math.floor(min / step) * step
  const count = Math.floor((max - lo) / step) + 1
  base.buckets = Array.from({ length: count }, (_, i) => {
    const a = lo + i * step, b = a + step
    const lastBar = i === count - 1
    const label = lastBar ? `${show(a)} or more` : a === 0 ? `Under ${show(b)}` : `${show(a)} – ${show(b)}`
    return {
      label,
      count: nums.filter(n => n >= a && (lastBar || n < b)).length,
      filters: [
        ...(a > 0 || lastBar ? [{ key: k, op: 'gte' as const, value: bound(a), ...cur }] : []),
        ...(!lastBar ? [{ key: k, op: 'lt' as const, value: bound(b), ...cur }] : []),
      ],
    }
  })
  return base
}
