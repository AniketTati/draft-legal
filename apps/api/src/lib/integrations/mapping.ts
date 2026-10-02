/**
 * docs/41 Part 17 — field mappings between an outside system (Salesforce
 * first) and draftLegal, and the field-ownership rule.
 *
 * The draftLegal side of a mapping is one of:
 *   - a key of the field registry (packages/types CORE_FIELDS: `value`,
 *     `effectiveDate`, `governingLaw` …), so a mapped value lands where
 *     extraction, renewals and the Fields panel read it;
 *   - a request's own text (`title`, `description`, `priority`);
 *   - `var:<name>`, a template variable, for a launch form that fills one.
 *
 * Direction is per field, as in Ironclad: `inbound` (Salesforce owns it),
 * `outbound` (draftLegal owns it) or `both`. The rule the plan sets:
 * Salesforce owns the commercial deal up to signing, draftLegal owns the
 * contract. Once a contract is out for signature or signed it is frozen: an
 * inbound change to it never writes, it becomes a conflict someone decides.
 *
 * Everything here is pure (no database), so the rules are unit-tested alone.
 */
import crypto from 'node:crypto'
import {
  CORE_FIELDS, coreField, parseFieldValue, durationInDays,
  type FieldValueType, type DurationValue, type CurrencyValue,
} from '@clm/types'

export type MappingDirection = 'inbound' | 'outbound' | 'both'

export interface FieldMapping {
  id?: string
  contractType?: string | null
  externalObject: string
  externalField: string
  dlField: string
  direction: MappingDirection | string
  locked?: boolean
}

/** A request's own fields a launch form can fill, beyond the field registry. */
const REQUEST_FIELDS: ReadonlyArray<{ key: string; label: string; type: FieldValueType }> = [
  { key: 'title',       label: 'Request title', type: 'text' },
  { key: 'description', label: 'What is needed', type: 'longtext' },
  { key: 'priority',    label: 'Priority',       type: 'select' },
]

export const REQUEST_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const

export interface MappingTarget { key: string; label: string; type: FieldValueType; group: string }

/** What a mapping can point at on our side, for the mapping editor. */
export function mappingTargets(): MappingTarget[] {
  return [
    ...REQUEST_FIELDS.map(f => ({ ...f, group: 'request' })),
    ...CORE_FIELDS.filter(f => !f.legacy).map(f => ({ key: f.key, label: f.label, type: f.type, group: f.group })),
  ]
}

const VAR_PREFIX = 'var:'
const VAR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** Whether `key` names something a mapping may point at. */
export function isValidDlField(key: string): boolean {
  if (key.startsWith(VAR_PREFIX)) return VAR_NAME.test(key.slice(VAR_PREFIX.length))
  return REQUEST_FIELDS.some(f => f.key === key) || (!!coreField(key) && coreField(key)!.key === key && !coreField(key)!.legacy)
}

/** The value type a draftLegal field holds (template variables are text). */
export function dlFieldType(key: string): FieldValueType {
  if (key.startsWith(VAR_PREFIX)) return 'text'
  return REQUEST_FIELDS.find(f => f.key === key)?.type ?? coreField(key)?.type ?? 'text'
}

const inbound = (m: FieldMapping) => m.direction === 'inbound' || m.direction === 'both'
const outbound = (m: FieldMapping) => m.direction === 'outbound' || m.direction === 'both'

/**
 * The mappings that apply to a contract type: those for the type, and those
 * for every type unless the type has its own for the same draftLegal field.
 */
export function mappingsForType<M extends FieldMapping>(mappings: M[], contractType: string | null | undefined): M[] {
  const own = mappings.filter(m => contractType && m.contractType === contractType)
  const taken = new Set(own.map(m => m.dlField))
  return [...own, ...mappings.filter(m => !m.contractType && !taken.has(m.dlField))]
}

/** A record's field, following `Account.Name`-style relationship paths. */
export function readPath(record: Record<string, unknown> | undefined, path: string): unknown {
  let at: unknown = record
  for (const part of path.split('.')) {
    if (at === null || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[part]
  }
  return at
}

export interface MappedValue {
  dlField: string
  value: unknown
  locked: boolean
  externalObject: string
  externalField: string
}

export interface InboundResult {
  values: MappedValue[]
  /** Values that didn't parse for their field: reported, never guessed. */
  issues: Array<{ dlField: string; externalField: string; error: string }>
}

/**
 * Salesforce record data → draftLegal values, through the inbound mappings.
 * `records` is keyed by object name (`Opportunity`, `Account`, `Quote` …).
 * Each value is parsed for its field's type, as a typed value is.
 */
export function applyInboundMapping(
  mappings: FieldMapping[],
  records: Record<string, Record<string, unknown> | undefined>,
  opts: { dateOrder?: 'MDY' | 'DMY' } = {},
): InboundResult {
  const values: MappedValue[] = []
  const issues: InboundResult['issues'] = []
  for (const m of mappings) {
    if (!inbound(m)) continue
    const raw = readPath(records[m.externalObject], m.externalField)
    if (raw === undefined) continue
    const parsed = coerceInbound(m.dlField, raw, opts)
    if (!parsed.ok) { issues.push({ dlField: m.dlField, externalField: `${m.externalObject}.${m.externalField}`, error: parsed.error }); continue }
    values.push({ dlField: m.dlField, value: parsed.value, locked: !!m.locked, externalObject: m.externalObject, externalField: m.externalField })
  }
  return { values, issues }
}

function coerceInbound(dlField: string, raw: unknown, opts: { dateOrder?: 'MDY' | 'DMY' }): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null || raw === '') return { ok: true, value: null }
  if (dlField === 'priority') {
    const p = String(raw).trim().toUpperCase()
    return (REQUEST_PRIORITIES as readonly string[]).includes(p) ? { ok: true, value: p } : { ok: false, error: `not one of ${REQUEST_PRIORITIES.join(', ')}` }
  }
  const def = coreField(dlField)
  if (!def) return { ok: true, value: typeof raw === 'object' ? JSON.stringify(raw) : String(raw) }
  const r = parseFieldValue(def.type, raw, { options: def.options, dateOrder: opts.dateOrder })
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error }
}

/**
 * draftLegal values → Salesforce fields, through the outbound mappings, by
 * object. `values` is the contract's values keyed by draftLegal field.
 */
export function applyOutboundMapping(mappings: FieldMapping[], values: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const m of mappings) {
    if (!outbound(m) || !(m.dlField in values)) continue
    ;(out[m.externalObject] ??= {})[m.externalField] = toSalesforceValue(dlFieldType(m.dlField), values[m.dlField])
  }
  return out
}

/** A stored value in the shape a Salesforce field takes. */
export function toSalesforceValue(type: FieldValueType, value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  switch (type) {
    case 'date':     return typeof value === 'string' ? value.slice(0, 10) : value
    case 'currency': return typeof value === 'object' ? (value as CurrencyValue).amount : value
    case 'duration': return typeof value === 'object' ? durationInDays(value as DurationValue) : value
    case 'parties':  return Array.isArray(value) ? value.map(p => (p as { name?: string }).name ?? '').filter(Boolean).join('; ') : value
    case 'multiselect': return Array.isArray(value) ? value.join(';') : value
    default:         return typeof value === 'object' ? JSON.stringify(value) : value
  }
}

// ─── Field ownership and conflicts ────────────────────────────────────────────

/**
 * Statuses in which the deal terms are frozen in draftLegal: out for
 * signature, signed, and everything after. docs/41 Part 18 adds a stage
 * model; until it lands the status decides (the one place to change).
 */
const FROZEN_STATUSES = new Set(['PENDING_SIGNATURE', 'EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED'])

export function isFrozen(contract: { status: string; stage?: string | null }): boolean {
  if (contract.stage) return ['sign', 'signature', 'manage', 'signed', 'closed'].includes(contract.stage.toLowerCase())
  return FROZEN_STATUSES.has(contract.status)
}

export interface InboundConflict {
  dlField: string
  externalObject: string
  externalField: string
  current: unknown
  incoming: unknown
}

export interface InboundPlan {
  /** Changed values to write now. */
  write: MappedValue[]
  /** Changed values held for someone to decide (the contract is frozen). */
  conflicts: InboundConflict[]
  /** Values that already match. */
  unchanged: string[]
}

/**
 * What an inbound change does to a contract: before signing Salesforce wins
 * and changed values are written; once frozen, each changed value becomes a
 * conflict and nothing is written.
 */
export function planInboundChange(input: { frozen: boolean; incoming: MappedValue[]; current: Record<string, unknown> }): InboundPlan {
  const plan: InboundPlan = { write: [], conflicts: [], unchanged: [] }
  for (const v of input.incoming) {
    const current = input.current[v.dlField] ?? null
    if (sameValue(current, v.value)) { plan.unchanged.push(v.dlField); continue }
    if (input.frozen) {
      plan.conflicts.push({ dlField: v.dlField, externalObject: v.externalObject, externalField: v.externalField, current, incoming: v.value })
    } else {
      plan.write.push(v)
    }
  }
  return plan
}

/** Equal as stored values: numbers by value, dates by day, objects by content. */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === '') return null
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return v.slice(0, 10)
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
    if (v && typeof v === 'object' && 'toNumber' in v && typeof (v as { toNumber: unknown }).toNumber === 'function') return (v as { toNumber(): number }).toNumber()
    return v
  }
  return canonical(norm(a)) === canonical(norm(b))
}

/** How a conflict reads to a person: "Salesforce changed Contract value 40,000 → 45,000". */
export function describeConflict(c: Pick<InboundConflict, 'dlField' | 'current' | 'incoming'>): string {
  const label = coreField(c.dlField)?.label ?? REQUEST_FIELDS.find(f => f.key === c.dlField)?.label ?? c.dlField
  const show = (v: unknown) => v === null || v === undefined ? 'empty'
    : typeof v === 'number' ? v.toLocaleString('en-US')
    : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return `Salesforce changed ${label}: ${show(c.current)} → ${show(c.incoming)}`
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A stable hash of a payload, for the sync log (same content, same hash). */
export function payloadHash(payload: unknown): string {
  return crypto.createHash('sha256').update(canonical(payload)).digest('hex').slice(0, 32)
}
