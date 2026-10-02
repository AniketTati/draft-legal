/**
 * Filtering and sorting contracts by their field values (docs/39 D3).
 *
 * A captured term was only readable on its own contract: nobody could ask
 * "which SOWs keep things confidential for more than three years" or "every
 * contract governed by Delaware law worth over $100k". One vocabulary for it,
 * shared by the contracts list, its saved views and export, the chart by
 * field and the assistant: a filter names a field, an operator the field's
 * type allows, and a value in the field's own shape (a duration as a duration,
 * money as an amount with an optional currency).
 */
import { durationInDays, formatFieldValue, type DurationValue, type FieldGroup, type FieldValueType } from './fields'

export type FieldFilterOp = 'is' | 'is_not' | 'contains' | 'gte' | 'gt' | 'lte' | 'lt' | 'between' | 'any_of' | 'present' | 'empty'

export interface FieldFilter {
  key: string
  op: FieldFilterOp
  /** is / is_not / contains: the value; gte / lte: the bound; between: the lower bound; any_of: the options. */
  value?: unknown
  /** between: the upper bound. */
  to?: unknown
  /** A money filter's three-letter currency; any currency when absent. */
  currency?: string
}

/** The operators each type offers, the usual one first. */
export const FILTER_OPS: Readonly<Record<FieldValueType, readonly FieldFilterOp[]>> = {
  text:        ['contains', 'is', 'any_of', 'is_not', 'present', 'empty'],
  longtext:    ['contains', 'present', 'empty'],
  parties:     ['contains', 'present', 'empty'],
  number:      ['gte', 'gt', 'lte', 'lt', 'between', 'is', 'present', 'empty'],
  percentage:  ['gte', 'gt', 'lte', 'lt', 'between', 'is', 'present', 'empty'],
  currency:    ['gte', 'gt', 'lte', 'lt', 'between', 'is', 'present', 'empty'],
  duration:    ['gte', 'gt', 'lte', 'lt', 'between', 'is', 'present', 'empty'],
  date:        ['between', 'gte', 'gt', 'lte', 'lt', 'present', 'empty'],
  boolean:     ['is', 'present', 'empty'],
  select:      ['any_of', 'is_not', 'present', 'empty'],
  multiselect: ['any_of', 'present', 'empty'],
}

/** How an operator reads for a type: dates are "on or after", numbers "at least". */
export function opLabel(type: FieldValueType, op: FieldFilterOp): string {
  const dated = type === 'date'
  switch (op) {
    case 'is':       return 'is'
    case 'is_not':   return 'is not'
    case 'contains': return 'contains'
    case 'gte':      return dated ? 'on or after' : 'at least'
    case 'lte':      return dated ? 'on or before' : 'at most'
    case 'lt':       return dated ? 'before' : 'less than'
    case 'gt':       return dated ? 'after' : 'more than'
    case 'between':  return 'between'
    case 'any_of':   return type === 'multiselect' ? 'includes any of' : 'is any of'
    case 'present':  return 'has a value'
    case 'empty':    return 'is empty'
  }
}

/** Types whose values compare as numbers (a duration in days, money by amount). */
export const NUMERIC_TYPES: ReadonlySet<FieldValueType> = new Set(['number', 'percentage', 'currency', 'duration'])

const isDuration = (v: unknown): v is DurationValue =>
  !!v && typeof v === 'object' && typeof (v as DurationValue).value === 'number' && ['days', 'weeks', 'months', 'years'].includes((v as DurationValue).unit)

/** The number a bound compares as: days for a duration, the amount for money, points for a percentage. */
export function filterNumber(type: FieldValueType, v: unknown): number | null {
  if (type === 'duration') return isDuration(v) ? durationInDays(v) : null
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Why a filter doesn't fit its field's type, or null when it does. */
export function validateFieldFilter(type: FieldValueType, f: FieldFilter): string | null {
  if (!FILTER_OPS[type]?.includes(f.op)) return `"${f.op}" doesn't apply to a ${type} field`
  if (f.op === 'present' || f.op === 'empty') return null
  const bound = (v: unknown) => type === 'date' ? typeof v === 'string' && ISO_DATE.test(v) : filterNumber(type, v) !== null
  switch (f.op) {
    case 'gte': case 'gt': case 'lte': case 'lt':
      return bound(f.value) ? null : 'needs a value to compare with'
    case 'between':
      if (!bound(f.value) || !bound(f.to)) return 'needs both ends'
      return null
    case 'any_of':
      return Array.isArray(f.value) && f.value.length > 0 && f.value.every(x => typeof x === 'string') ? null : 'needs at least one option'
    case 'is': case 'is_not':
      if (type === 'boolean') return typeof f.value === 'boolean' ? null : 'needs yes or no'
      if (NUMERIC_TYPES.has(type)) return bound(f.value) ? null : 'needs a value'
      return typeof f.value === 'string' && f.value.trim() ? null : 'needs a value'
    case 'contains':
      return typeof f.value === 'string' && f.value.trim() ? null : 'needs some words'
  }
  return null
}

/** A bound as people read it, in the field's own terms. */
function shown(type: FieldValueType, v: unknown, currency?: string): string {
  if (type === 'currency') {
    const n = filterNumber(type, v)
    return n === null ? '—' : `${currency ? `${currency} ` : ''}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  }
  return formatFieldValue(type, v)
}

/** The filter as a chip reads it: "Confidentiality period at least 3 years". */
export function describeFieldFilter(label: string, type: FieldValueType, f: FieldFilter): string {
  switch (f.op) {
    case 'present':  return `${label}: has a value`
    case 'empty':    return `${label}: empty`
    case 'between':  return `${label} ${shown(type, f.value, f.currency)} – ${shown(type, f.to, f.currency)}`
    case 'gte':      return `${label} ${type === 'date' ? 'from' : '≥'} ${shown(type, f.value, f.currency)}`
    case 'lte':      return `${label} ${type === 'date' ? 'until' : '≤'} ${shown(type, f.value, f.currency)}`
    case 'lt':       return `${label} ${type === 'date' ? 'before' : '<'} ${shown(type, f.value, f.currency)}`
    case 'gt':       return `${label} ${type === 'date' ? 'after' : '>'} ${shown(type, f.value, f.currency)}`
    case 'any_of':   return `${label}: ${(f.value as string[]).join(' or ')}`
    case 'contains': return `${label} contains “${String(f.value)}”`
    case 'is_not':   return `${label} is not ${shown(type, f.value)}`
    case 'is':       return type === 'boolean' ? `${label}: ${f.value ? 'Yes' : 'No'}` : `${label}: ${shown(type, f.value, f.currency)}`
  }
}

/** Filters to and from a URL parameter (JSON; anything malformed is dropped). */
export function encodeFieldFilters(filters: readonly FieldFilter[]): string {
  return JSON.stringify(filters.map(({ key, op, value, to, currency }) => ({ key, op, ...(value !== undefined && { value }), ...(to !== undefined && { to }), ...(currency && { currency }) })))
}

export function decodeFieldFilters(raw: string | null | undefined): FieldFilter[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((f): f is FieldFilter => !!f && typeof f.key === 'string' && typeof f.op === 'string' && f.op in OP_SET)
  } catch {
    return []
  }
}

const OP_SET: Record<FieldFilterOp, true> = { is: true, is_not: true, contains: true, gte: true, gt: true, lte: true, lt: true, between: true, any_of: true, present: true, empty: true }

/** A field the contracts list, its filters and the assistant can use, across the org. */
export interface CatalogField {
  key: string
  label: string
  type: FieldValueType
  kind: 'core' | 'type' | 'custom'
  /** The contract types that have it; null when every contract does. */
  contractTypes: string[] | null
  options?: readonly string[]
  unit?: string
  /** What the field means (its definition, or the admin's description). */
  definition?: string | null
  /** A core field's group (term, parties, commercial, legal), for pickers. */
  group?: FieldGroup
}

/** Built-in sorts that aren't fields. */
export const CONTRACT_SORTS = ['createdAt', 'updatedAt', 'title', 'status', 'riskScore', 'checked'] as const
export type ContractSortKey = (typeof CONTRACT_SORTS)[number] | string

export interface ContractSort { key: ContractSortKey; dir: 'asc' | 'desc' }
