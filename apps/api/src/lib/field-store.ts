/**
 * Field store (docs/39 B1, B5, G1) — the one writer of a contract's field
 * values: the core registry (packages/types fields.ts), the contract type's
 * own fields and the org's custom fields, one ContractFieldValue row each.
 *
 * Why a store: a value used to be three JSON blobs and six columns with no
 * record of who set it, so re-analysis overwrote people's corrections
 * wholesale (G1), type terms sat in a server-only key nobody could edit (B1),
 * and nothing re-indexed search when a value changed (B5). Now:
 *
 *   - every row says where its value came from (`source`) and who checked it
 *     (`verifiedAt`); extraction may overwrite only unchecked `ai` rows, and
 *     leaves a `suggestion` on anything a person set or checked;
 *   - person writes are typed (parseFieldValue), verified, audited without
 *     the value (as the Review Queue always was), and re-index search;
 *   - the contract's columns, keyTerms, fieldConfidence and metadata stay the
 *     read model every existing reader uses: each write rebuilds them from
 *     the rows (`legacyPatch`), under a lock on the contract row.
 *
 * Contracts analysed before the store existed need no migration: their
 * values are read out of the legacy blobs into rows on first touch
 * (`ensureRows`), keeping who-set-it where the blobs recorded it.
 */
import { Prisma, type ContractFieldValue } from '@prisma/client'
import {
  AuditAction, CORE_FIELDS, coreField, canonicalFieldKey, parseFieldValue, formatFieldValue, ambiguousNumericDate,
  durationInDays, termEndDate, typeFieldsFor, checkBelow, isChecked, verificationState,
  type CoreFieldDef, type FieldKind, type FieldSource, type FieldValueType,
  type DurationValue, type CurrencyValue, type PartyValue, type CheckLevel, type VerificationState, type DateOrder,
} from '@clm/types'
import { prisma } from './prisma.js'
import { syncRenewalTermsFor } from './renewal-terms.js'
import { createAuditEvent } from './audit.js'
import { reindexContract } from './elasticsearch.js'
import { fireWebhook } from './webhook-events.js'
import { normalizeForSearch, findQuote, findSpan, type NormalizedText, type Span } from './text-span.js'
import { orgDateOrder } from './org-date-order.js'
import { fieldsFromVariables } from './template-fields.js'
import { counterpartyIdFor } from './counterparty-directory.js'
import { readValueFrom, replacedPassage } from './value-recheck.js'
import { counterpart, type TrackedViews } from './tracked-changes.js'
import { poorScanIssue } from './scan-quality.js'
import { exhibitFinder } from './exhibit-text.js'
import { computedConfidence, fieldAccuracy, fieldCheckLevels, clearFieldAccuracy, type FieldAccuracy } from './field-confidence.js'

// ─── Definitions ──────────────────────────────────────────────────────────────

export type FieldGroupKey = CoreFieldDef['group'] | 'type' | 'custom'

export interface FieldDef {
  key: string
  kind: FieldKind
  label: string
  type: FieldValueType
  group: FieldGroupKey
  column?: CoreFieldDef['column']
  options?: readonly string[]
  definition?: string | null
  legacy?: boolean
  required?: boolean
  /** A number's unit, shown after it: "30 days". */
  unit?: string
}

export interface CustomFieldDefRow {
  fieldKey: string
  fieldLabel: string
  fieldType: string
  options: unknown
  helpText: string | null
  required: boolean
}

const CUSTOM_TYPES = new Set<FieldValueType>(['text', 'longtext', 'number', 'date', 'boolean', 'select', 'multiselect', 'currency', 'duration', 'percentage'])

function optionsOf(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.length ? v.map(String) : undefined
}

/** Every field a contract of this type can hold: core, then its type's, then the org's own. */
export function fieldDefsFor(contractType: string | null | undefined, customDefs: CustomFieldDefRow[]): FieldDef[] {
  const defs: FieldDef[] = CORE_FIELDS.map(f => ({
    key: f.key, kind: 'core', label: f.label, type: f.type, group: f.group,
    column: f.column, options: f.options, definition: f.definition, legacy: f.legacy, unit: f.unit,
  }))
  const taken = new Set(defs.map(d => d.key))
  for (const f of typeFieldsFor(contractType)) {
    if (taken.has(f.key)) continue
    taken.add(f.key)
    defs.push({ key: f.key, kind: 'type', label: f.label, type: f.type, group: 'type' })
  }
  for (const d of customDefs) {
    if (taken.has(d.fieldKey)) continue
    taken.add(d.fieldKey)
    const type = CUSTOM_TYPES.has(d.fieldType as FieldValueType) ? d.fieldType as FieldValueType : 'text'
    defs.push({
      key: d.fieldKey, kind: 'custom', label: d.fieldLabel, type, group: 'custom',
      options: optionsOf(d.options), definition: d.helpText, required: d.required,
    })
  }
  return defs
}

/** The definition a key names for this contract: a core key or older spelling, or a type/custom key. */
export function resolveDef(defs: FieldDef[], key: string): FieldDef | undefined {
  const canonical = canonicalFieldKey(key)
  return defs.find(d => d.key === canonical) ?? defs.find(d => d.key === key)
}

// ─── Contract snapshot ────────────────────────────────────────────────────────

export const FIELD_CONTRACT_SELECT = {
  id: true, orgId: true, type: true, status: true, currentVersionId: true, updatedAt: true,
  effectiveDate: true, expiryDate: true, value: true, currency: true,
  jurisdiction: true, counterpartyName: true, counterpartyId: true,
  keyTerms: true, fieldConfidence: true, metadata: true,
} as const

export type FieldContract = Prisma.ContractGetPayload<{ select: typeof FIELD_CONTRACT_SELECT }>

type Tx = Prisma.TransactionClient

interface Evidence {
  confidence?: number | null
  quote?: string | null
  section?: string | null
  issue?: string | null
  verifiedAt?: string | null
  verifiedBy?: string | null
  rejectedAt?: string | null
  source?: string
  label?: string
  value?: unknown
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

async function customDefsFor(tx: Tx, orgId: string, contractType: string | null): Promise<CustomFieldDefRow[]> {
  return tx.contractFieldDefinition.findMany({
    where: { orgId, deletedAt: null, OR: [{ contractType }, { contractType: null }] },
    orderBy: { sortOrder: 'asc' },
    select: { fieldKey: true, fieldLabel: true, fieldType: true, options: true, helpText: true, required: true },
  })
}

// ─── Values ───────────────────────────────────────────────────────────────────

/** Read a stored or incoming value as the field's type; a value that doesn't parse is kept as given. */
export function normaliseValue(def: Pick<FieldDef, 'type' | 'options'>, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null
  const r = parseFieldValue(def.type, raw, { options: def.options })
  return r.ok ? r.value : raw
}

function stable(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

/** Typed copies of a value, for filtering and sorting. */
function projections(type: FieldValueType, value: unknown): { valueText: string | null; valueNumber: number | null; valueDate: Date | null } {
  const none = { valueText: null, valueNumber: null, valueDate: null }
  if (value === null || value === undefined) return none
  switch (type) {
    case 'number':
    case 'percentage':
      return { ...none, valueNumber: typeof value === 'number' && Number.isFinite(value) ? value : null }
    case 'currency': {
      const c = value as CurrencyValue
      return { ...none, valueNumber: Number.isFinite(c?.amount) ? c.amount : null, valueText: c?.currency ?? null }
    }
    case 'duration': {
      const d = value as DurationValue
      return { ...none, valueNumber: d && typeof d.value === 'number' ? durationInDays(d) : null }
    }
    case 'date': {
      const d = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`)
      return { ...none, valueDate: Number.isNaN(d.getTime()) ? null : d }
    }
    case 'boolean':
      return { ...none, valueText: value === true ? 'true' : value === false ? 'false' : String(value) }
    case 'parties':
      return { ...none, valueText: Array.isArray(value) ? (value as PartyValue[]).map(p => p?.name).filter(Boolean).join('; ') : String(value) }
    case 'multiselect':
      return { ...none, valueText: Array.isArray(value) ? value.join('; ') : String(value) }
    default:
      return { ...none, valueText: typeof value === 'string' ? value.slice(0, 2000) : JSON.stringify(value).slice(0, 2000) }
  }
}

// ─── Legacy read (first touch) ────────────────────────────────────────────────

function columnValue(column: NonNullable<CoreFieldDef['column']>, c: FieldContract): unknown {
  switch (column) {
    case 'effectiveDate': return c.effectiveDate ? c.effectiveDate.toISOString().slice(0, 10) : null
    case 'expiryDate':    return c.expiryDate ? c.expiryDate.toISOString().slice(0, 10) : null
    case 'value':         return c.value != null ? Number(c.value) : null
    // The column defaults to USD, so a contract with no value "has" a currency
    // nobody stated: read it only when there is a value it belongs to.
    case 'currency':      return c.value != null ? c.currency ?? null : null
    case 'jurisdiction':  return c.jurisdiction ?? null
    case 'counterpartyName': return c.counterpartyName ?? null
  }
}

interface LegacyEntry { value: unknown; evidence?: Evidence; source: FieldSource }

function legacyCoreEntry(def: FieldDef, c: FieldContract): LegacyEntry | null {
  const core = coreField(def.key)!
  const kt = obj(c.keyTerms)
  const fc = obj(c.fieldConfidence)
  const keys = [core.key, ...(core.aliases ?? [])]
  let raw: unknown = core.column ? columnValue(core.column, c) : undefined
  if (raw == null || raw === '') {
    raw = undefined
    for (const k of keys) if (kt[k] != null && kt[k] !== '') { raw = kt[k]; break }
  }
  let evidence: Evidence | undefined
  for (const k of keys) if (fc[k] && typeof fc[k] === 'object') { evidence = fc[k] as Evidence; break }
  if (raw === undefined && !evidence) return null
  let source: FieldSource = (evidence?.source as FieldSource | undefined) ?? (evidence ? 'ai' : 'user')
  // The counterparty column is filled from the extracted parties, which carry
  // the evidence: it was the AI's, unless a person typed a name not among them.
  if (core.key === 'counterpartyName' && !evidence && raw != null) {
    const parties = Array.isArray(kt.parties) ? kt.parties as PartyValue[] : []
    const partiesEvidence = fc.parties as Evidence | undefined
    if (partiesEvidence && parties.some(p => p?.name === raw)) { source = 'ai'; evidence = { ...partiesEvidence, issue: null } }
  }
  return { value: evidence?.rejectedAt ? null : normaliseValue(def, raw ?? null), evidence, source }
}

function legacyEntry(def: FieldDef, c: FieldContract): LegacyEntry | null {
  const md = obj(c.metadata)
  if (def.kind === 'core') return legacyCoreEntry(def, c)
  if (def.kind === 'type') {
    const e = obj(md._typeFields)[def.key] as Evidence | undefined
    if (!e) return null
    return { value: normaliseValue(def, e.value ?? null), evidence: e, source: (e.source as FieldSource | undefined) ?? 'ai' }
  }
  const raw = md[def.key]
  const evidence = obj(md._customFieldEvidence)[def.key] as Evidence | undefined
  if ((raw === undefined || raw === null || raw === '') && !evidence) return null
  return { value: normaliseValue(def, raw ?? null), evidence, source: (evidence?.source as FieldSource | undefined) ?? (evidence ? 'ai' : 'user') }
}

function rowFromLegacy(c: FieldContract, def: FieldDef, e: LegacyEntry): Prisma.ContractFieldValueCreateManyInput {
  const ev = e.evidence ?? {}
  const verifiedAt = ev.verifiedAt ? new Date(ev.verifiedAt) : null
  return {
    orgId: c.orgId, contractId: c.id, fieldKey: def.key, kind: def.kind,
    label: def.kind === 'type' ? (ev.label ?? def.label) : null,
    valueType: def.type,
    value: e.value === null ? Prisma.JsonNull : e.value as Prisma.InputJsonValue,
    ...projections(def.type, e.value),
    source: e.source,
    confidence: typeof ev.confidence === 'number' ? ev.confidence : null,
    quote: ev.quote ?? null, section: ev.section ?? null, issue: ev.issue ?? null,
    verifiedAt: verifiedAt && !Number.isNaN(verifiedAt.getTime()) ? verifiedAt : null,
    verifiedById: ev.verifiedBy ?? null,
    rejectedAt: ev.rejectedAt ? new Date(ev.rejectedAt) : null,
  }
}

/** Rows for every field that has a legacy value but no row yet. */
async function ensureRows(tx: Tx, c: FieldContract, defs: FieldDef[]): Promise<ContractFieldValue[]> {
  const rows = await tx.contractFieldValue.findMany({ where: { contractId: c.id } })
  const have = new Set(rows.map(r => r.fieldKey))
  const create: Prisma.ContractFieldValueCreateManyInput[] = []
  for (const def of defs) {
    if (have.has(def.key)) continue
    const e = legacyEntry(def, c)
    if (e) create.push(rowFromLegacy(c, def, e))
  }
  if (!create.length) return rows
  await tx.contractFieldValue.createMany({ data: create, skipDuplicates: true })
  return tx.contractFieldValue.findMany({ where: { contractId: c.id } })
}

// ─── Legacy write (read model) ────────────────────────────────────────────────

function evidenceOf(r: ContractFieldValue): Evidence {
  return {
    confidence: r.confidence, quote: r.quote, section: r.section, issue: r.issue, source: r.source,
    ...(r.verifiedAt ? { verifiedAt: r.verifiedAt.toISOString(), verifiedBy: r.verifiedById } : {}),
    ...(r.rejectedAt ? { rejectedAt: r.rejectedAt.toISOString() } : {}),
  }
}

function columnOut(column: NonNullable<CoreFieldDef['column']>, v: unknown): unknown {
  if (v === null || v === undefined || v === '') return null
  if (column === 'effectiveDate' || column === 'expiryDate') {
    const d = new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (column === 'value') {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : null
  }
  return String(v)
}

/**
 * The contract's columns, keyTerms, fieldConfidence and metadata, rebuilt
 * from the rows: what every reader outside the store still reads. Only fields
 * that have a row are touched; alias keys of a core field are folded away.
 */
export function legacyPatch(c: FieldContract, defs: FieldDef[], rows: ContractFieldValue[]): Record<string, unknown> {
  const byKey = new Map(rows.map(r => [r.fieldKey, r]))
  const kt = { ...obj(c.keyTerms) }
  const fc = { ...obj(c.fieldConfidence) }
  const md = { ...obj(c.metadata) }
  const data: Record<string, unknown> = {}
  for (const f of CORE_FIELDS) {
    const r = byKey.get(f.key)
    if (!r) continue
    for (const a of f.aliases ?? []) { delete kt[a]; delete fc[a] }
    if (r.value === null || r.value === undefined) delete kt[f.key]
    else kt[f.key] = r.value
    fc[f.key] = evidenceOf(r)
    if (f.column) data[f.column] = columnOut(f.column, r.value)
  }
  const typeKeys = new Set(defs.filter(d => d.kind === 'type').map(d => d.key))
  const typeFields: Record<string, unknown> = {}
  for (const r of rows) {
    if (r.kind !== 'type' || !typeKeys.has(r.fieldKey) || r.value === null) continue
    const def = defs.find(d => d.key === r.fieldKey)
    typeFields[r.fieldKey] = { value: r.value, label: r.label ?? def?.label ?? r.fieldKey, ...evidenceOf(r) }
  }
  if (Object.keys(typeFields).length || md._typeFields !== undefined) md._typeFields = typeFields
  const customKeys = new Set(defs.filter(d => d.kind === 'custom').map(d => d.key))
  const customEvidence = { ...obj(md._customFieldEvidence) }
  for (const r of rows) {
    if (r.kind !== 'custom' || !customKeys.has(r.fieldKey)) continue
    if (r.value === null) delete md[r.fieldKey]
    else md[r.fieldKey] = r.value
    customEvidence[r.fieldKey] = evidenceOf(r)
  }
  if (Object.keys(customEvidence).length) md._customFieldEvidence = customEvidence
  data.keyTerms = kt
  data.fieldConfidence = fc
  data.metadata = md
  return data
}

// ─── Views ────────────────────────────────────────────────────────────────────

export interface FieldSuggestion {
  value: unknown
  display: string
  quote: string | null
  section: string | null
  confidence: number | null
  versionId: string | null
  at: string
  /**
   * G2 'edited' — read from the words an edit put in place of the value's own;
   * A9 'proposed' — what the other side's tracked changes, not accepted, would
   * make it (null: they take it out). Else: a new analysis.
   */
  reason?: 'edited' | 'proposed'
}

export interface FieldView extends FieldDef {
  value: unknown
  display: string
  source: FieldSource | null
  confidence: number | null
  quote: string | null
  section: string | null
  issue: string | null
  /** Where the quote sits in the version the contract stands on (B2). */
  anchor: FieldAnchor | null
  verifiedAt: string | null
  verifiedById: string | null
  rejectedAt: string | null
  suggestion: FieldSuggestion | null
  updatedAt: string | null
  /** A person set or checked this value: extraction won't overwrite it. */
  locked: boolean
  /** B3 — the model's own number; `confidence` is held down by what can be checked (field-confidence). */
  modelConfidence: number | null
  /** Why `confidence` is lower than the model said. */
  confidenceReasons: string[]
  /** When this field's AI values need a person, and below what confidence (null: always). */
  check: CheckLevel
  checkBelow: number | null
  /** G3 — the amendment a value was set from (source 'amendment'). */
  fromContractId: string | null
  fromContract?: { id: string; title: string } | null
  /** docs/39 A6 — the contract says different things about it: each reading, the value's first. */
  candidates: FieldCandidate[] | null
}

/** docs/39 A6 — one of the things a contract says about a field, with its words. */
export interface FieldCandidate {
  value: unknown
  display: string
  quote: string | null
  section: string | null
}

export function isLocked(r: Pick<ContractFieldValue, 'source' | 'verifiedAt'> | null | undefined): boolean {
  // The AI's values and calculated ones (an end date from a start and a term) may be refreshed.
  return !!r && ((r.source !== 'ai' && r.source !== 'calculated') || r.verifiedAt !== null)
}

/** A stored value as the screens show it: display text, who set it, its evidence. */
export function fieldView(def: FieldDef, r: ContractFieldValue | undefined): FieldView {
  return viewOf(def, r)
}

function viewOf(def: FieldDef, r: ContractFieldValue | undefined): FieldView {
  const value = r?.value ?? null
  const display = formatFieldValue(def.type, value)
  return {
    ...def,
    label: def.kind === 'type' ? (r?.label ?? def.label) : def.label,
    value,
    display: def.unit && typeof value === 'number' ? `${display} ${def.unit}` : display,
    source: (r?.source as FieldSource | undefined) ?? null,
    confidence: r?.confidence ?? null,
    quote: r?.quote ?? null,
    section: r?.section ?? null,
    issue: r?.issue ?? null,
    anchor: resolvedAnchor(r?.anchor),
    verifiedAt: r?.verifiedAt?.toISOString() ?? null,
    verifiedById: r?.verifiedById ?? null,
    rejectedAt: r?.rejectedAt?.toISOString() ?? null,
    suggestion: (r?.suggestion as FieldSuggestion | null | undefined) ?? null,
    updatedAt: r?.updatedAt?.toISOString() ?? null,
    locked: isLocked(r),
    modelConfidence: r?.confidence ?? null,
    confidenceReasons: [],
    check: 'unsure',
    checkBelow: checkBelow('unsure'),
    fromContractId: r?.fromContractId ?? null,
    candidates: (r?.candidates as FieldCandidate[] | null | undefined) ?? null,
  }
}

/** A value as the Fields panel shows it: with its unit ("45 days"). */
function displayOf(def: Pick<FieldDef, 'type' | 'unit'>, value: unknown): string {
  const text = formatFieldValue(def.type, value)
  return def.unit && typeof value === 'number' ? `${text} ${def.unit}` : text
}

/** A value that holds something (not null, '', [] or {}). */
function holds(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/**
 * B3 — a view with the confidence to decide by (the model's, held down by
 * what can be checked and by the field's record) and its field's check level.
 */
function withConfidence(v: FieldView, accuracy: Map<string, FieldAccuracy>, levels: Record<string, CheckLevel>): FieldView {
  // A9 — words their tracked changes replace are still in the file, beneath them: not gone;
  // A12 — nor words in an exhibit read with the contract.
  const gone = !!v.quote && !!v.anchor && v.anchor.start === null && !v.anchor.noText && !v.anchor.exhibit && v.suggestion?.reason !== 'proposed'
  const { confidence, reasons } = computedConfidence({
    source: v.source, verifiedAt: v.verifiedAt, model: v.modelConfidence, quote: v.quote, issue: v.issue, gone, hasValue: holds(v.value), value: v.value,
  }, accuracy.get(v.key))
  const check = levels[v.key] ?? 'unsure'
  return { ...v, confidence, confidenceReasons: reasons, check, checkBelow: checkBelow(check) }
}

export interface Verification {
  state: VerificationState
  /** Values a person set or checked. */
  checked: number
  /** Values the contract holds. */
  filled: number
}

/** B3 — how much of what a contract holds a person set or checked. */
export function verificationOf(fields: Pick<FieldView, 'value' | 'source' | 'verifiedAt'>[]): Verification {
  const filled = fields.filter(f => holds(f.value))
  const checked = filled.filter(f => isChecked(f)).length
  return { state: verificationState(checked, filled.length), checked, filled: filled.length }
}

/** A legacy field shows only while it still holds something to move. */
function visible(def: FieldDef, r: ContractFieldValue | undefined): boolean {
  if (def.legacy) return !!r && r.value !== null
  return true
}

export interface ContractFields {
  contract: FieldContract
  fields: FieldView[]
  verification: Verification
}

// ─── Anchors (docs/39 B2) ─────────────────────────────────────────────────────

/**
 * Where a value's quote sits in the version the contract stands on: what
 * "Show in document" highlights. `text` is the document's own wording (the
 * quote is the model's copy of it); `occurrence` says which of the passages
 * with that wording it is, for the view to find the same one. `start: null`
 * records that the words aren't in that version — an amendment or an edit
 * changed them — so the search isn't repeated on every read.
 *
 * A person's highlight arrives as `{ occurrence }` (which match of the
 * selected words they picked) and is placed on the next read.
 */
export interface FieldAnchor {
  versionId: string
  start: number | null
  end: number | null
  text: string | null
  occurrence: number
  /** The version has no text to look in (it failed to read): not "the words are gone". */
  noText?: boolean
  /** docs/39 A12 — not in the contract's own text but in an exhibit read with it: not "the words are gone" either. */
  exhibit?: { s3Key: string; label: string }
}

function anchorOf(raw: unknown): Partial<FieldAnchor> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<FieldAnchor> : null
}

function resolvedAnchor(raw: unknown): FieldAnchor | null {
  const a = anchorOf(raw)
  return a && typeof a.versionId === 'string' && a.start !== undefined ? a as FieldAnchor : null
}

/** The `occurrence`-th place `quote` appears, else its first (the document changed since). */
function nthQuote(text: NormalizedText, quote: string, occurrence: number): Span | null {
  let from = 0
  let first: Span | null = null
  for (let i = 0; i <= occurrence; i++) {
    const s = findQuote(text, quote, from)
    if (!s) return first
    if (i === occurrence) return s
    first ??= s
    from = s.end
  }
  return first
}

/**
 * A quote this short says too little to place when it appears twice:
 * "twelve months" may be the term or the renewal. A longer one repeated is
 * boilerplate, and its first place reads the same as the others.
 */
const MIN_UNIQUE_WORDS = 6
/** An elided quote's parts shorter than this are too common to find. */
const MIN_PART = 12

/**
 * A model's quote placed in the text: as written, else the parts either
 * side of an elision ("The term … twelve (12) months"), else its longest
 * part, else its opening words (a quote drifts from the text toward its end).
 */
export function locateQuote(text: NormalizedText, quote: string, occurrence = 0): Span | null {
  const q = quote.trim()
  const whole = nthQuote(text, q, occurrence)
  if (whole) {
    const short = q.split(/\s+/).length < MIN_UNIQUE_WORDS
    // A short quote that appears more than once is a guess unless someone pointed.
    if (short && occurrence === 0 && findQuote(text, q, whole.end)) return null
    return whole
  }
  const parts = q.split(/\.{3,}|…/).map(p => p.trim()).filter(p => p.length >= MIN_PART)
  if (parts.length >= 2) {
    const span = findSpan(text, parts[0], parts[parts.length - 1], { maxLength: 5000 })
    if (span) return span
  }
  const longest = [...parts].sort((a, b) => b.length - a.length)[0]
  if (longest && longest !== q) {
    const s = findQuote(text, longest)
    if (s) return s
  }
  const words = q.split(/\s+/)
  if (words.length >= 8) return findQuote(text, words.slice(0, 8).join(' '))
  return null
}

/** Which of the passages worded like `span` it is (0 = the first). */
function occurrenceOf(text: NormalizedText, original: string, span: Span): number {
  const wording = original.slice(span.start, span.end)
  let k = 0
  let from = 0
  for (;;) {
    const s = findQuote(text, wording, from)
    if (!s || s.start >= span.start) return k
    k++
    from = s.end
  }
}

async function standingVersionId(tx: Tx, c: FieldContract): Promise<string | null> {
  if (c.currentVersionId) return c.currentVersionId
  const v = await tx.contractVersion.findFirst({ where: { contractId: c.id }, orderBy: { versionNumber: 'desc' }, select: { id: true } })
  return v?.id ?? null
}

/**
 * Places every quoted value in the version the contract stands on, for rows
 * never placed or placed in another version. Reads the version's text only
 * when something needs placing; keeps each row's updatedAt (placing a quote
 * changes no value).
 */
async function anchorRows(tx: Tx, c: FieldContract, rows: ContractFieldValue[]): Promise<ContractFieldValue[]> {
  const versionId = await standingVersionId(tx, c)
  if (!versionId) return rows
  const stale = rows.filter(r => r.quote?.trim() && r.value !== null && resolvedAnchor(r.anchor)?.versionId !== versionId)
  if (!stale.length) return rows
  const version = await tx.contractVersion.findUnique({ where: { id: versionId }, select: { plainText: true } })
  const plain = version?.plainText ?? ''
  // A version with no text (its file failed to read) is recorded as looked at,
  // not as "the words are gone", so no value is flagged and no read retries it.
  const text = plain.trim() ? normalizeForSearch(plain) : null
  const placed = new Map<string, ContractFieldValue>()
  // A12 — a quote not in the contract's own text may be in an exhibit read with it.
  let inExhibit: ((quote: string) => { s3Key: string; label: string } | null) | null = null
  for (const r of stale) {
    const hint = anchorOf(r.anchor)
    const span = text ? locateQuote(text, r.quote!, typeof hint?.occurrence === 'number' ? hint.occurrence : 0) : null
    if (!span && text && !inExhibit) {
      inExhibit = exhibitFinder(await tx.contractExhibit.findMany({ where: { contractId: c.id, text: { not: '' } }, select: { s3Key: true, label: true, text: true } }))
    }
    const exhibit = !span && inExhibit ? inExhibit(r.quote!) : null
    const anchor: FieldAnchor = span && text
      ? { versionId, start: span.start, end: span.end, text: plain.slice(span.start, span.end), occurrence: occurrenceOf(text, plain, span) }
      : { versionId, start: null, end: null, text: null, occurrence: 0, ...(text ? {} : { noText: true }), ...(exhibit && { exhibit }) }
    placed.set(r.id, await tx.contractFieldValue.update({
      where: { id: r.id },
      data: { anchor: anchor as unknown as Prisma.InputJsonValue, updatedAt: r.updatedAt },
    }))
  }
  return rows.map(r => placed.get(r.id) ?? r)
}

async function lockContract(tx: Tx, contractId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${contractId} FOR UPDATE`
}

async function loadInTx(tx: Tx, contractId: string, orgId: string | null): Promise<{ c: FieldContract; defs: FieldDef[]; rows: ContractFieldValue[] } | null> {
  const c = await tx.contract.findFirst({
    where: { id: contractId, deletedAt: null, ...(orgId ? { orgId } : {}) },
    select: FIELD_CONTRACT_SELECT,
  })
  if (!c) return null
  await lockContract(tx, c.id)
  const defs = fieldDefsFor(c.type, await customDefsFor(tx, c.orgId, c.type))
  const rows = await ensureRows(tx, c, defs)
  return { c, defs, rows }
}

/**
 * The contract's fields as the Fields panel shows them. Reads legacy values
 * into rows on first touch, which is why it takes the contract's lock.
 */
export async function getContractFields(orgId: string, contractId: string): Promise<ContractFields | null> {
  // B3 — the org's field records and check levels, read before the contract's lock is taken.
  const [accuracy, levels] = await Promise.all([fieldAccuracy(orgId), fieldCheckLevels(orgId)])
  return prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, contractId, orgId)
    if (!loaded) return null
    const rows = await anchorRows(tx, loaded.c, loaded.rows)
    const byKey = new Map(rows.map(r => [r.fieldKey, r]))
    const fields = loaded.defs.filter(d => visible(d, byKey.get(d.key))).map(d => withConfidence(viewOf(d, byKey.get(d.key)), accuracy, levels))
    // The contract value reads with its currency ("USD 12,500"), as everywhere else.
    const value = fields.find(f => f.key === 'value')
    const currency = fields.find(f => f.key === 'currency')?.value
    if (value && typeof value.value === 'number' && typeof currency === 'string' && currency) value.display = `${currency} ${value.display}`
    // A6 — and so do the readings the contract gives for it.
    if (value?.candidates && typeof currency === 'string' && currency) value.candidates = withCurrency(value.candidates, currency)
    // G3 — the amendments values were set from, by title.
    const fromIds = [...new Set(fields.map(f => f.fromContractId).filter((id): id is string => !!id))]
    if (fromIds.length) {
      const from = await tx.contract.findMany({ where: { id: { in: fromIds }, orgId, deletedAt: null }, select: { id: true, title: true } })
      const byId = new Map(from.map(c => [c.id, c]))
      for (const f of fields) if (f.fromContractId) f.fromContract = byId.get(f.fromContractId) ?? null
    }
    return { contract: loaded.c, fields, verification: verificationOf(fields) }
  })
}

/** The words around a value's passage in the version the contract stands on. */
export interface SourceExcerpt {
  versionId: string
  before: string
  match: string
  after: string
  /** The excerpt starts or ends inside the document, not at its edges. */
  clippedStart: boolean
  clippedEnd: boolean
}

/** Characters of context either side of a passage. */
const EXCERPT_CONTEXT = 420

/**
 * Move a cut at `at` to a space, so an excerpt neither starts nor ends in
 * the middle of a word: forward for a start (just after the space), back for
 * an end (at the space). Within 40 characters, else where it was.
 */
function wordEdge(text: string, at: number, dir: -1 | 1): number {
  for (let i = 0; i < 40; i++) {
    const p = at + i * dir
    if (p <= 0 || p >= text.length) return Math.max(0, Math.min(text.length, p))
    if (/\s/.test(text[p])) return dir === 1 ? p + 1 : p
  }
  return at
}

/**
 * docs/39 B4 — one field of one contract with the passage it came from, in
 * its context: what the Review Queue shows beside a value so it can be
 * checked without opening the contract. Places the contract's quotes first
 * (B2), as the Fields panel does.
 */
export async function fieldSource(orgId: string, contractId: string, key: string): Promise<{ field: FieldView; excerpt: SourceExcerpt | null } | null> {
  const fields = await getContractFields(orgId, contractId)
  if (!fields) return null
  const canonical = canonicalFieldKey(key)
  const field = fields.fields.find(f => f.key === canonical) ?? fields.fields.find(f => f.key === key)
  if (!field) return null
  const a = field.anchor
  if (!a || a.start === null || a.end === null) return { field, excerpt: null }
  const version = await prisma.contractVersion.findFirst({ where: { id: a.versionId, contractId }, select: { plainText: true } })
  const text = version?.plainText ?? ''
  if (a.end > text.length) return { field, excerpt: null }
  const from = wordEdge(text, Math.max(0, a.start - EXCERPT_CONTEXT), 1)
  const to = wordEdge(text, Math.min(text.length, a.end + EXCERPT_CONTEXT), -1)
  return {
    field,
    excerpt: {
      versionId: a.versionId,
      before: text.slice(from, a.start),
      match: text.slice(a.start, a.end),
      after: text.slice(a.end, Math.max(a.end, to)),
      clippedStart: from > 0,
      clippedEnd: to < text.length,
    },
  }
}

// ─── Person writes ────────────────────────────────────────────────────────────

export interface AuditContext {
  /** Where the write came from: fields_panel · review_queue · api · highlight. */
  source: string
  ipAddress?: string
}

export type FieldWriteResult =
  | { ok: true; field: FieldView; statusChange?: { from: string; to: string } }
  | { ok: false; status: 400 | 404; detail: string }

/** X42 — a change to what an approval judged sends the contract back to DRAFT. */
/**
 * docs/41 Part 18 — a value a person changes is a change an approval may
 * have judged: the approval's reset rules decide (`always` asks again after
 * any change; `fields` only for the fields it lists). X42 limited this to
 * value and currency, which the auto-approval rule reads.
 */
const judges = (_key: string) => true

/**
 * docs/39 F2 — an expiry date nobody stated, worked out from the effective
 * date and the initial term ("twelve months from 15 January 2025" ends on
 * 14 January 2026), so renewals and alerts see it. Marked `calculated`: a
 * stated or a person's value always wins, and it follows its inputs when they
 * change. Returns whether it wrote.
 */
async function deriveCalculated(tx: Tx, c: FieldContract, rows: ContractFieldValue[]): Promise<boolean> {
  const byKey = new Map(rows.map(r => [r.fieldKey, r]))
  const start = byKey.get('effectiveDate')
  const term = byKey.get('initialTerm')
  const expiry = byKey.get('expiryDate')
  if (expiry && expiry.source !== 'calculated' && expiry.value !== null) return false
  const termValue = term?.value as DurationValue | null | undefined
  const calc = typeof start?.value === 'string' && termValue && typeof termValue === 'object'
    ? termEndDate(start.value, termValue)
    : null
  if (!calc) {
    if (expiry?.source !== 'calculated' || expiry.value === null) return false
    await tx.contractFieldValue.update({ where: { id: expiry.id }, data: { value: Prisma.JsonNull, valueText: null, valueNumber: null, valueDate: null } })
    return true
  }
  if (expiry?.source === 'calculated' && expiry.value === calc) return false
  const conf = Math.min(start?.confidence ?? 1, term?.confidence ?? 1)
  const data = {
    value: calc, ...projections('date', calc), valueType: 'date', source: 'calculated',
    confidence: conf, quote: term?.quote ?? null, section: term?.section ?? null,
    issue: null, verifiedAt: null, verifiedById: null, rejectedAt: null, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull, anchor: Prisma.JsonNull,
  }
  if (expiry) await tx.contractFieldValue.update({ where: { id: expiry.id }, data })
  else await tx.contractFieldValue.create({ data: { orgId: c.orgId, contractId: c.id, fieldKey: 'expiryDate', kind: 'core', ...data } })
  return true
}

/**
 * X42, docs/41 Part 18 — a term an approval judged (value, currency)
 * changed: the approval reset rules decide what is asked again
 * (lib/approval-reset.ts, loaded when used: this module is unit-tested and
 * the queue opens Redis when loaded). The status change it made, if any.
 */
async function resetForField(c: FieldContract, field: string, userId: string): Promise<{ from: string; to: string } | undefined> {
  const { onApprovalChange } = await import('./approval-reset.js')
  await onApprovalChange({ orgId: c.orgId, contractId: c.id, fields: [field], source: 'edit', userId })
  const now = await prisma.contract.findUnique({ where: { id: c.id }, select: { status: true } })
  return now && now.status !== c.status ? { from: c.status, to: now.status } : undefined
}

async function commit(
  tx: Tx, c: FieldContract, defs: FieldDef[],
  opts: { keepUpdatedAt?: boolean } = {},
): Promise<ContractFieldValue[]> {
  let rows = await tx.contractFieldValue.findMany({ where: { contractId: c.id } })
  if (await deriveCalculated(tx, c, rows)) rows = await tx.contractFieldValue.findMany({ where: { contractId: c.id } })
  const patch = legacyPatch(c, defs, rows)
  // A14 — the counterparty's directory entry follows its name: linked when
  // the name changes, or when a contract naming a company isn't linked yet.
  if ('counterpartyName' in patch) {
    const name = patch.counterpartyName as string | null
    if (name !== c.counterpartyName || (name && !c.counterpartyId)) {
      patch.counterpartyId = await counterpartyIdFor(tx, c.orgId, name, c.counterpartyId)
    }
  }
  await tx.contract.update({
    where: { id: c.id },
    data: {
      ...patch,
      // A maintenance pass changes no term: it must not reorder "recently edited".
      ...(opts.keepUpdatedAt ? { updatedAt: c.updatedAt } : {}),
    } as never,
  })
  // docs/41 Part 14 — the renewal columns follow the values they come from
  // (and an amendment's or renewal's follow onto its parent).
  await syncRenewalTermsFor(c.orgId, c.id, tx)
  return rows
}

/**
 * docs/39 A3 — a contract's legacy values read into rows, and its read model
 * rewritten under the canonical field names (older spellings folded away).
 * For scripts/backfill-field-values.ts; leaves the contract's updatedAt alone.
 */
export async function materializeContractFields(contractId: string): Promise<{ rows: number } | null> {
  return prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, contractId, null)
    if (!loaded) return null
    const rows = await commit(tx, loaded.c, loaded.defs, { keepUpdatedAt: true })
    // B2 — and its quotes placed, so the Review Queue sees words a later version took out.
    await anchorRows(tx, loaded.c, rows)
    return { rows: rows.length }
  })
}

/**
 * B2/B4 — place a contract's quotes in the version it now stands on, without
 * anyone opening it: the Review Queue does this for contracts whose quotes
 * were placed in an older version (or never), so "words changed" is found.
 */
export async function placeContractQuotes(contractId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, contractId, null)
    if (loaded) await anchorRows(tx, loaded.c, loaded.rows)
  })
}

function afterPersonWrite(
  c: FieldContract, userId: string, field: string, action: string, audit: AuditContext,
  statusChange?: { from: string; to: string }, opts: { reindex?: boolean } = {},
) {
  // B3 — a check or a correction changes the field's record.
  clearFieldAccuracy(c.orgId)
  // A bulk review re-indexes each contract once, after all its writes.
  if (opts.reindex !== false) {
    reindexContract(c.id).catch(err => console.warn('[field-store] re-index failed contractId=%s: %s', c.id, (err as Error).message))
  }
  fireWebhook(c.orgId, 'contract.updated', { contractId: c.id, changes: [field], source: 'user' })
  // Like the Review Queue always did: the field is named, its value isn't.
  return createAuditEvent({
    orgId: c.orgId, userId,
    action: AuditAction.CONTRACT_UPDATED,
    resourceType: 'contract',
    resourceId: c.id,
    metadata: {
      source: audit.source, action, field,
      ...(statusChange ? { statusFrom: statusChange.from, statusTo: statusChange.to } : {}),
    },
    ipAddress: audit.ipAddress,
  })
}

/**
 * B3/I2 — what the AI read, when a person's write replaces it with something
 * else (or rejects it): how often each field is corrected, and the examples
 * the extraction learns from. Null when the value was a person's, or the same.
 */
function correctionOf(before: ContractFieldValue | undefined, value: unknown, at: Date, extra: { rejected?: boolean } = {}): Prisma.InputJsonValue | null {
  if (!before || (before.source !== 'ai' && before.source !== 'calculated') || before.value === null) return null
  if (!extra.rejected && sameValue(before.value, value)) return null
  return {
    value: before.value as Prisma.InputJsonValue, quote: before.quote, section: before.section, confidence: before.confidence,
    at: at.toISOString(), ...(extra.rejected ? { rejected: true } : {}),
  }
}

export interface PersonValue {
  key: string
  raw: unknown
  /**
   * user: typed; highlight: picked from the text; variable: filled in a
   * template the contract was drafted from (H3); import: from a spreadsheet
   * the contract was imported with (A16).
   */
  source?: Extract<FieldSource, 'user' | 'highlight' | 'variable' | 'import'>
  quote?: string | null
  anchor?: Prisma.InputJsonValue | null
}

export type FieldsWriteResult =
  | { ok: true; fields: FieldView[]; statusChange?: { from: string; to: string } }
  | { ok: false; status: 400 | 404; detail: string }

/**
 * A person sets one or more values — typed in the Fields panel or the Review
 * Queue, picked from a highlight, or sent through the API. Every value is
 * parsed for its field's type before any is written, so a bad one fails the
 * lot; each is saved as verified and wins over extraction.
 */
export async function setFieldValues(input: {
  orgId: string
  contractId: string
  userId: string
  values: PersonValue[]
  audit: AuditContext
  /** The caller handles X42 itself (PATCH does). */
  skipApprovalReset?: boolean
  /**
   * docs/39 A16 — one of many contracts written at once (an import): the
   * caller re-indexes and records each contract once, not each field.
   */
  bulk?: boolean
}): Promise<FieldsWriteResult> {
  // A11 — "03/04/2025" typed by someone in a day-first org is 3 April.
  const dateOrder = await orgDateOrder(input.orgId)
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, input.contractId, input.orgId)
    if (!loaded) return { ok: false as const, status: 404 as const, detail: 'Contract not found' }
    const { c, defs, rows } = loaded
    const planned: Array<{ def: FieldDef; value: unknown; v: PersonValue }> = []
    for (const v of input.values) {
      const def = resolveDef(defs, v.key)
      if (!def) return { ok: false as const, status: 404 as const, detail: `Unknown field: ${v.key}` }
      const parsed = parseFieldValue(def.type, v.raw, { options: def.options, dateOrder })
      if (!parsed.ok) return { ok: false as const, status: 400 as const, detail: `${def.label}: ${parsed.error}` }
      planned.push({ def, value: parsed.value, v })
    }
    const now = new Date()
    // X42, docs/41 Part 18 — a term an approval judged changed: the reset rules decide, after the write.
    let judged: string | undefined
    for (const { def, value, v } of planned) {
      const before = rows.find(r => r.fieldKey === def.key)
      const data = {
        value: value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue,
        ...projections(def.type, value),
        valueType: def.type,
        source: v.source ?? 'user',
        confidence: 1,
        // A typed value isn't what the old quote said; a highlight brings its own.
        quote: v.quote ?? null,
        section: null,
        issue: null,
        anchor: v.anchor ?? Prisma.JsonNull,
        verifiedAt: now, verifiedById: input.userId,
        rejectedAt: null,
        suggestion: Prisma.JsonNull,
        candidates: Prisma.JsonNull,
        // B3/I2 — the AI's reading this corrects (kept through later edits by people).
        correctedFrom: correctionOf(before, value, now) ?? (before?.correctedFrom as Prisma.InputJsonValue | null | undefined) ?? Prisma.JsonNull,
        updatedById: input.userId,
      }
      await tx.contractFieldValue.upsert({
        where: { contractId_fieldKey: { contractId: c.id, fieldKey: def.key } },
        create: { orgId: c.orgId, contractId: c.id, fieldKey: def.key, kind: def.kind, label: def.kind === 'type' ? def.label : null, ...data },
        update: data,
      })
      if (!judged && !input.skipApprovalReset && judges(def.key) && !sameValue(before?.value ?? null, value)) judged = def.key
    }
    const after = await commit(tx, c, defs)
    const fields = planned.map(p => viewOf(p.def, after.find(r => r.fieldKey === p.def.key)))
    return { ok: true as const, fields, judged, c, planned }
  })
  if (!result.ok) return result
  const statusChange = result.judged ? await resetForField(result.c, result.judged, input.userId) : undefined
  if (input.bulk) return { ok: true, fields: result.fields, statusChange }
  for (const [i, p] of result.planned.entries()) {
    const action = p.v.source === 'highlight' ? 'set_from_highlight' : p.v.source === 'variable' ? 'set_from_template' : p.v.source === 'import' ? 'set_from_import' : 'corrected'
    // The status change is recorded once, with the field that caused it.
    await afterPersonWrite(result.c, input.userId, p.def.key, action, input.audit, i === 0 ? statusChange : undefined)
  }
  return { ok: true, fields: result.fields, statusChange }
}

/**
 * docs/39 H3 — a contract drafted from a template gets the template's
 * filled-in variables as its field values (lib/template-fields.ts), set
 * from the template: known values an extraction leaves alone.
 */
export async function setValuesFromTemplate(input: {
  orgId: string
  contractId: string
  userId: string
  variables: Record<string, unknown> | null | undefined
  audit: AuditContext
  /** docs/39 H1/H2 — the template's variables: the field each one's author named. */
  templateVariables?: ReadonlyArray<{ key: string; field?: string | null }> | null
}): Promise<FieldsWriteResult | null> {
  const c = await prisma.contract.findFirst({ where: { id: input.contractId, orgId: input.orgId, deletedAt: null }, select: { type: true } })
  if (!c) return null
  const custom = await prisma.contractFieldDefinition.findMany({
    where: { orgId: input.orgId, deletedAt: null, OR: [{ contractType: c.type }, { contractType: null }] },
    orderBy: { sortOrder: 'asc' },
    select: { fieldKey: true, fieldLabel: true, fieldType: true, options: true, helpText: true, required: true },
  })
  const named = Object.fromEntries((input.templateVariables ?? []).filter(v => v.field !== undefined).map(v => [v.key, v.field ?? null]))
  const values = fieldsFromVariables(input.variables, fieldDefsFor(c.type, custom), { dateOrder: await orgDateOrder(input.orgId), named })
  if (!values.length) return { ok: true, fields: [] }
  // A draft has no approval to undo.
  return setFieldValues({ orgId: input.orgId, contractId: input.contractId, userId: input.userId, values, audit: input.audit, skipApprovalReset: true })
}

/** One value: see setFieldValues. */
export async function setFieldValue(input: {
  orgId: string
  contractId: string
  key: string
  raw: unknown
  userId: string
  source?: Extract<FieldSource, 'user' | 'highlight' | 'variable'>
  quote?: string | null
  anchor?: Prisma.InputJsonValue | null
  audit: AuditContext
  skipApprovalReset?: boolean
}): Promise<FieldWriteResult> {
  const r = await setFieldValues({
    orgId: input.orgId, contractId: input.contractId, userId: input.userId, audit: input.audit,
    skipApprovalReset: input.skipApprovalReset,
    values: [{ key: input.key, raw: input.raw, source: input.source, quote: input.quote, anchor: input.anchor }],
  })
  if (!r.ok) {
    // A single field's parse error reads without its label prefix.
    return r.status === 400 ? { ...r, detail: r.detail.replace(/^[^:]+: /, '') } : r
  }
  return { ok: true, field: r.fields[0], statusChange: r.statusChange }
}

/** A person confirms the value as it stands. */
export async function verifyFieldValue(input: {
  orgId: string; contractId: string; key: string; userId: string; audit: AuditContext
  /** false: the caller re-indexes the contract itself (a bulk review). */
  reindex?: boolean
}): Promise<FieldWriteResult> {
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, input.contractId, input.orgId)
    if (!loaded) return { ok: false as const, status: 404 as const, detail: 'Contract not found' }
    const { c, defs } = loaded
    const def = resolveDef(defs, input.key)
    if (!def) return { ok: false as const, status: 404 as const, detail: `Unknown field: ${input.key}` }
    const now = new Date()
    await tx.contractFieldValue.upsert({
      where: { contractId_fieldKey: { contractId: c.id, fieldKey: def.key } },
      create: {
        orgId: c.orgId, contractId: c.id, fieldKey: def.key, kind: def.kind, valueType: def.type,
        label: def.kind === 'type' ? def.label : null, value: Prisma.JsonNull, source: 'user',
        confidence: 1, verifiedAt: now, verifiedById: input.userId, updatedById: input.userId,
      },
      update: { confidence: 1, issue: null, candidates: Prisma.JsonNull, verifiedAt: now, verifiedById: input.userId, updatedById: input.userId },
    })
    const after = await commit(tx, c, defs)
    return { ok: true as const, field: viewOf(def, after.find(r => r.fieldKey === def.key)), c, def }
  })
  if (!result.ok) return result
  await afterPersonWrite(result.c, input.userId, result.def.key, 'verified', input.audit, undefined, { reindex: input.reindex })
  return { ok: true, field: result.field }
}

/**
 * B3 — "Check all": a person who has read the contract marks every AI value
 * still unchecked as right, in one go. Values with something to decide are
 * left for them: a second reading waiting beside the value, readings the
 * contract disagrees on (A6), or a notice period whose type isn't known. One audit row names the fields.
 */
export async function verifyAllFieldValues(input: {
  orgId: string; contractId: string; userId: string; audit: AuditContext
}): Promise<{ ok: true; verified: string[]; verification: Verification } | { ok: false; status: 404; detail: string }> {
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, input.contractId, input.orgId)
    if (!loaded) return null
    const { c, defs, rows } = loaded
    const shown = new Set(defs.filter(d => !d.legacy).map(d => d.key))
    const todo = rows.filter(r =>
      shown.has(r.fieldKey) && (r.source === 'ai' || r.source === 'calculated') && !r.verifiedAt && !r.rejectedAt
      && holds(r.value) && !holds(r.suggestion) && !holds(r.candidates))
    const now = new Date()
    if (todo.length) {
      await tx.contractFieldValue.updateMany({
        where: { id: { in: todo.map(r => r.id) } },
        data: { verifiedAt: now, verifiedById: input.userId, updatedById: input.userId, confidence: 1, issue: null },
      })
    }
    const after = todo.length ? await commit(tx, c, defs) : rows
    const views = defs.filter(d => visible(d, after.find(r => r.fieldKey === d.key))).map(d => viewOf(d, after.find(r => r.fieldKey === d.key)))
    return { c, verified: todo.map(r => r.fieldKey), verification: verificationOf(views) }
  })
  if (!result) return { ok: false, status: 404, detail: 'Contract not found' }
  if (result.verified.length) {
    clearFieldAccuracy(input.orgId)
    reindexContract(input.contractId).catch(err => console.warn('[field-store] re-index failed contractId=%s: %s', input.contractId, (err as Error).message))
    fireWebhook(input.orgId, 'contract.updated', { contractId: input.contractId, changes: result.verified, source: 'user' })
    await createAuditEvent({
      orgId: input.orgId, userId: input.userId, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: input.contractId,
      metadata: { source: input.audit.source, action: 'verified_all', fields: result.verified },
      ipAddress: input.audit.ipAddress,
    })
  }
  return { ok: true, verified: result.verified, verification: result.verification }
}

/**
 * A person says the value is wrong: it's cleared (so it stops driving
 * renewals, alerts and answers) and the field leaves the queue.
 */
export async function rejectFieldValue(input: { orgId: string; contractId: string; key: string; userId: string; audit: AuditContext }): Promise<FieldWriteResult> {
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, input.contractId, input.orgId)
    if (!loaded) return { ok: false as const, status: 404 as const, detail: 'Contract not found' }
    const { c, defs, rows } = loaded
    const def = resolveDef(defs, input.key)
    if (!def) return { ok: false as const, status: 404 as const, detail: `Unknown field: ${input.key}` }
    const before = rows.find(r => r.fieldKey === def.key)
    const now = new Date()
    const data = {
      value: Prisma.JsonNull, valueText: null, valueNumber: null, valueDate: null,
      confidence: 0, rejectedAt: now, verifiedAt: now, verifiedById: input.userId,
      suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull, anchor: Prisma.JsonNull, updatedById: input.userId,
      // B3/I2 — rejecting the AI's reading is correcting it.
      correctedFrom: correctionOf(before, null, now, { rejected: true }) ?? (before?.correctedFrom as Prisma.InputJsonValue | null | undefined) ?? Prisma.JsonNull,
    }
    await tx.contractFieldValue.upsert({
      where: { contractId_fieldKey: { contractId: c.id, fieldKey: def.key } },
      create: { orgId: c.orgId, contractId: c.id, fieldKey: def.key, kind: def.kind, valueType: def.type, label: def.kind === 'type' ? def.label : null, source: 'ai', ...data },
      update: data,
    })
    const judged = judges(def.key) && before?.value != null
    const after = await commit(tx, c, defs)
    return { ok: true as const, field: viewOf(def, after.find(r => r.fieldKey === def.key)), judged, c, def }
  })
  if (!result.ok) return result
  const statusChange = result.judged ? await resetForField(result.c, result.def.key, input.userId) : undefined
  await afterPersonWrite(result.c, input.userId, result.def.key, 'rejected', input.audit, statusChange)
  return { ok: true, field: result.field, statusChange }
}

/**
 * Take or leave what the AI read for a value a person set (G1). Taking it
 * makes it the value, checked by the person who took it.
 */
export async function resolveSuggestion(input: { orgId: string; contractId: string; key: string; userId: string; accept: boolean; audit: AuditContext }): Promise<FieldWriteResult> {
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, input.contractId, input.orgId)
    if (!loaded) return { ok: false as const, status: 404 as const, detail: 'Contract not found' }
    const { c, defs, rows } = loaded
    const def = resolveDef(defs, input.key)
    if (!def) return { ok: false as const, status: 404 as const, detail: `Unknown field: ${input.key}` }
    const row = rows.find(r => r.fieldKey === def.key)
    const suggestion = row?.suggestion as FieldSuggestion | null | undefined
    if (!row || !suggestion) return { ok: false as const, status: 404 as const, detail: 'No suggestion for this field' }
    const now = new Date()
    let judged = false
    if (input.accept) {
      await tx.contractFieldValue.update({
        where: { id: row.id },
        data: {
          value: suggestion.value === null ? Prisma.JsonNull : suggestion.value as Prisma.InputJsonValue,
          ...projections(def.type, suggestion.value),
          source: 'ai', confidence: 1, quote: suggestion.quote, section: suggestion.section, issue: null,
          anchor: Prisma.JsonNull, verifiedAt: now, verifiedById: input.userId, rejectedAt: null,
          suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull, updatedById: input.userId,
        },
      })
      judged = judges(def.key) && !sameValue(row.value, suggestion.value)
    } else {
      await tx.contractFieldValue.update({ where: { id: row.id }, data: { suggestion: Prisma.JsonNull, updatedById: input.userId } })
    }
    const after = await commit(tx, c, defs)
    return { ok: true as const, field: viewOf(def, after.find(r => r.fieldKey === def.key)), judged, c, def }
  })
  if (!result.ok) return result
  const statusChange = result.judged ? await resetForField(result.c, result.def.key, input.userId) : undefined
  await afterPersonWrite(result.c, input.userId, result.def.key, input.accept ? 'accepted_suggestion' : 'dismissed_suggestion', input.audit, statusChange)
  return { ok: true, field: result.field, statusChange }
}

/**
 * F1 — a value kept in a legacy field (the notice period found before notices
 * were told apart) moves to the field a person says it belongs to.
 */
export async function reassignLegacyValue(input: {
  orgId: string; contractId: string; key: string; to: string; userId: string; audit: AuditContext
  /** false: the caller re-indexes the contract itself (a bulk review). */
  reindex?: boolean
}): Promise<FieldWriteResult> {
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, input.contractId, input.orgId)
    if (!loaded) return { ok: false as const, status: 404 as const, detail: 'Contract not found' }
    const { c, defs, rows } = loaded
    const from = resolveDef(defs, input.key)
    const to = resolveDef(defs, input.to)
    if (!from?.legacy || !to || to.legacy || to.type !== from.type) {
      return { ok: false as const, status: 400 as const, detail: `Can't move ${input.key} to ${input.to}` }
    }
    const row = rows.find(r => r.fieldKey === from.key)
    if (!row || row.value === null) return { ok: false as const, status: 404 as const, detail: 'Nothing to move' }
    const now = new Date()
    await tx.contractFieldValue.upsert({
      where: { contractId_fieldKey: { contractId: c.id, fieldKey: to.key } },
      create: {
        orgId: c.orgId, contractId: c.id, fieldKey: to.key, kind: to.kind, valueType: to.type,
        value: row.value as Prisma.InputJsonValue, ...projections(to.type, row.value),
        source: row.source, confidence: 1, quote: row.quote, section: row.section,
        verifiedAt: now, verifiedById: input.userId, updatedById: input.userId,
      },
      update: {
        value: row.value as Prisma.InputJsonValue, ...projections(to.type, row.value),
        source: row.source, confidence: 1, quote: row.quote, section: row.section, issue: null,
        verifiedAt: now, verifiedById: input.userId, rejectedAt: null, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull, updatedById: input.userId,
      },
    })
    await tx.contractFieldValue.update({
      where: { id: row.id },
      data: { value: Prisma.JsonNull, valueText: null, valueNumber: null, valueDate: null, verifiedAt: now, verifiedById: input.userId, updatedById: input.userId },
    })
    const after = await commit(tx, c, defs)
    return { ok: true as const, field: viewOf(to, after.find(r => r.fieldKey === to.key)), c, to }
  })
  if (!result.ok) return result
  await afterPersonWrite(result.c, input.userId, result.to.key, 'reassigned', input.audit, undefined, { reindex: input.reindex })
  return { ok: true, field: result.field }
}

/**
 * G1/D1 — a run's changes to one contract put back (lib/field-runs.ts): each
 * value still as the run left it — still the AI's, unchecked — returns to
 * what it was before; one a person or a later run has changed since stays.
 */
export async function restoreFieldValues(contractId: string, changes: FieldChange[]): Promise<{ restored: string[]; skipped: string[] } | null> {
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, contractId, null)
    if (!loaded) return null
    const { c, defs, rows } = loaded
    const restored: string[] = []
    const skipped: string[] = []
    for (const ch of changes) {
      const def = resolveDef(defs, ch.fieldKey)
      const row = rows.find(r => r.fieldKey === ch.fieldKey)
      const untouched = row && (row.source === 'ai' || row.source === 'calculated') && row.verifiedAt === null && sameValue(row.value ?? null, ch.after ?? null)
      if (!def || !row || !untouched) { skipped.push(ch.fieldKey); continue }
      const b = ch.before
      await tx.contractFieldValue.update({
        where: { id: row.id },
        data: b
          ? { value: b.value as Prisma.InputJsonValue, ...projections(def.type, b.value), source: b.source, confidence: b.confidence, quote: b.quote, section: b.section, issue: b.issue, anchor: Prisma.JsonNull, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull }
          : { value: Prisma.JsonNull, valueText: null, valueNumber: null, valueDate: null, quote: null, section: null, issue: null, anchor: Prisma.JsonNull, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull },
      })
      restored.push(ch.fieldKey)
    }
    if (restored.length) await commit(tx, c, defs)
    return { restored, skipped }
  })
  if (result?.restored.length) {
    reindexContract(contractId).catch(err => console.warn('[field-store] re-index failed contractId=%s: %s', contractId, (err as Error).message))
  }
  return result
}

// ─── After an edit (docs/39 G2) ───────────────────────────────────────────────

/** Versions back to look for the text a value's words were last in. */
const RECHECK_VERSIONS = 10
/** As sure as a value read again from edited words may be. */
const EDITED_CONFIDENCE = 0.6

/**
 * G2 — after an edit, each value whose words are no longer in the contract,
 * read again from the words that took their place (value-recheck.ts): the
 * same value — the words changed around it — keeps it and takes the new
 * words as its quote (so it stops asking to be checked); another value is
 * offered beside it as a suggestion, for a person to take or leave. A value
 * whose passage was rewritten wholesale stays as it is, marked "words
 * changed" (B2). Run by the refresh-version job for the version the contract
 * stands on.
 */
export async function recheckValuesAfterEdit(contractId: string, versionId: string): Promise<{ suggested: string[]; requoted: string[] } | null> {
  const head = await prisma.contract.findFirst({ where: { id: contractId, deletedAt: null }, select: { orgId: true, currentVersionId: true } })
  if (!head || head.currentVersionId !== versionId) return null
  const dateOrder = await orgDateOrder(head.orgId)
  return prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, contractId, null)
    if (!loaded) return null
    const { defs, rows } = loaded
    const version = await tx.contractVersion.findFirst({ where: { id: versionId, contractId }, select: { plainText: true, versionNumber: true } })
    const text = version?.plainText ?? ''
    if (!text) return { suggested: [], requoted: [] }
    const now = normalizeForSearch(text)
    const quoted = rows.filter(r => r.quote?.trim() && r.value !== null && !findQuote(now, r.quote))
    if (!quoted.length) return { suggested: [], requoted: [] }
    const earlier = await tx.contractVersion.findMany({
      where: { contractId, versionNumber: { lt: version!.versionNumber } },
      orderBy: { versionNumber: 'desc' },
      take: RECHECK_VERSIONS,
      select: { plainText: true },
    })
    const olds = earlier.map(v => v.plainText ?? '').filter(Boolean).map(t => ({ text: t, norm: normalizeForSearch(t) }))
    const suggested: string[] = []
    const requoted: string[] = []
    const at = new Date().toISOString()
    for (const r of quoted) {
      const def = resolveDef(defs, r.fieldKey)
      const old = olds.find(o => findQuote(o.norm, r.quote!))
      if (!def || !old) continue
      const passage = replacedPassage(old.text, text, r.quote!)
      if (!passage) continue
      const read = readValueFrom(def.type, passage, { value: r.value, quote: r.quote }, { options: def.options, dateOrder })
      if (read === undefined) continue
      const value = normaliseValue(def, read)
      if (sameValue(value, r.value)) {
        // The same value in new words: they're its quote now, placed on the next read.
        await tx.contractFieldValue.update({ where: { id: r.id }, data: { quote: passage.slice(0, 4000), anchor: Prisma.JsonNull } })
        requoted.push(r.fieldKey)
      } else {
        const suggestion: FieldSuggestion = {
          value, display: displayOf(def, value), quote: passage.slice(0, 4000), section: null,
          confidence: EDITED_CONFIDENCE, versionId, at, reason: 'edited',
        }
        await tx.contractFieldValue.update({ where: { id: r.id }, data: { suggestion: suggestion as unknown as Prisma.InputJsonValue } })
        suggested.push(r.fieldKey)
      }
    }
    return { suggested, requoted }
  })
}

// ─── Amendments (docs/39 G3) ──────────────────────────────────────────────────

/** Terms an amendment states about itself, not about the agreement it amends. */
const OWN_TERMS = new Set(['effectiveDate', 'executionDate', 'parties', 'counterpartyName', 'counterpartyAddress', 'signatories', 'noticePeriodDays'])

export interface AmendmentChange {
  key: string
  label: string
  type: FieldValueType
  /** The parent's value now, and who set it. */
  parent: { display: string; value: unknown; source: FieldSource | null; fromContractId: string | null }
  /** The amendment's value, and the words it came from. */
  amendment: { display: string; value: unknown; quote: string | null; section: string | null; source: FieldSource | null }
  /** The parent holds this very value, set from this amendment. */
  applied: boolean
}

/**
 * What an amendment says about the terms its parent holds: each field the
 * amendment states that the parent holds differently, or not at all — and
 * those already applied from it. Fields about the amendment itself (its own
 * date, parties, signatories) are left out.
 */
export async function amendmentChanges(orgId: string, amendmentId: string, parentId: string): Promise<AmendmentChange[] | null> {
  const child = await getContractFields(orgId, amendmentId)
  const parent = child && await getContractFields(orgId, parentId)
  if (!child || !parent) return null
  const onParent = new Map(parent.fields.map(f => [f.key, f]))
  const out: AmendmentChange[] = []
  for (const f of child.fields) {
    const p = onParent.get(f.key)
    if (!p || OWN_TERMS.has(f.key) || f.legacy || !holds(f.value)) continue
    const applied = p.source === 'amendment' && p.fromContractId === amendmentId && sameValue(p.value, f.value)
    if (!applied && sameValue(p.value, f.value)) continue
    out.push({
      key: f.key, label: f.label, type: f.type,
      parent: { display: holds(p.value) ? p.display : '', value: p.value, source: p.source, fromContractId: p.fromContractId },
      amendment: { display: f.display, value: f.value, quote: f.quote, section: f.section, source: f.source },
      applied,
    })
  }
  return out
}

/**
 * G3 — the terms a person chose from an amendment, set on its parent: source
 * 'amendment', naming the amendment, with its words as the quote. A
 * re-analysis of the parent leaves them (a person set them); the parent's
 * renewals and alerts read them. One run, undoable for 30 days while each
 * value is still the amendment's.
 */
export async function applyAmendmentValues(input: {
  orgId: string; parentId: string; amendmentId: string; keys: string[]; userId: string; audit: AuditContext
}): Promise<{ ok: true; applied: string[]; changes: FieldChange[] } | { ok: false; status: 404; detail: string }> {
  const changes = await amendmentChanges(input.orgId, input.amendmentId, input.parentId)
  if (!changes) return { ok: false, status: 404, detail: 'Contract not found' }
  const chosen = changes.filter(c => input.keys.includes(c.key) && !c.applied)
  if (!chosen.length) return { ok: true, applied: [], changes: [] }
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, input.parentId, input.orgId)
    if (!loaded) return null
    const { c, defs, rows } = loaded
    const now = new Date()
    const done: FieldChange[] = []
    for (const ch of chosen) {
      const def = resolveDef(defs, ch.key)
      if (!def) continue
      const before = rows.find(r => r.fieldKey === def.key)
      const value = ch.amendment.value
      const data = {
        value: value as Prisma.InputJsonValue, ...projections(def.type, value), valueType: def.type,
        source: 'amendment', confidence: 1, quote: ch.amendment.quote, section: ch.amendment.section, issue: null,
        anchor: Prisma.JsonNull, verifiedAt: now, verifiedById: input.userId, rejectedAt: null,
        suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull, fromContractId: input.amendmentId, updatedById: input.userId,
      }
      await tx.contractFieldValue.upsert({
        where: { contractId_fieldKey: { contractId: c.id, fieldKey: def.key } },
        create: { orgId: c.orgId, contractId: c.id, fieldKey: def.key, kind: def.kind, label: def.kind === 'type' ? def.label : null, ...data },
        update: data,
      })
      done.push({ fieldKey: def.key, before: snapshotOf(before), after: value, fromContractId: input.amendmentId })
    }
    await commit(tx, c, defs)
    return { c, done }
  })
  if (!result) return { ok: false, status: 404, detail: 'Contract not found' }
  reindexContract(input.parentId).catch(err => console.warn('[field-store] re-index failed contractId=%s: %s', input.parentId, (err as Error).message))
  fireWebhook(input.orgId, 'contract.updated', { contractId: input.parentId, changes: result.done.map(d => d.fieldKey), source: 'user' })
  await createAuditEvent({
    orgId: input.orgId, userId: input.userId, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: input.parentId,
    metadata: { source: input.audit.source, action: 'applied_amendment', amendmentId: input.amendmentId, fields: result.done.map(d => d.fieldKey) },
    ipAddress: input.audit.ipAddress,
  })
  return { ok: true, applied: result.done.map(d => d.fieldKey), changes: result.done }
}

/**
 * G3 — a roll-up's changes put back (lib/field-runs.ts): each value still as
 * the amendment set it returns to what it was, who had checked it included;
 * one a person or a later amendment has changed since stays.
 */
export async function restoreAmendmentValues(contractId: string, changes: FieldChange[]): Promise<{ restored: string[]; skipped: string[] } | null> {
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, contractId, null)
    if (!loaded) return null
    const { c, defs, rows } = loaded
    const restored: string[] = []
    const skipped: string[] = []
    for (const ch of changes) {
      const def = resolveDef(defs, ch.fieldKey)
      const row = rows.find(r => r.fieldKey === ch.fieldKey)
      const untouched = row && row.source === 'amendment' && (!ch.fromContractId || row.fromContractId === ch.fromContractId) && sameValue(row.value ?? null, ch.after ?? null)
      if (!def || !row || !untouched) { skipped.push(ch.fieldKey); continue }
      const b = ch.before
      await tx.contractFieldValue.update({
        where: { id: row.id },
        data: b
          ? {
            value: b.value as Prisma.InputJsonValue, ...projections(def.type, b.value), source: b.source, confidence: b.confidence,
            quote: b.quote, section: b.section, issue: b.issue, anchor: Prisma.JsonNull, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull,
            verifiedAt: b.verifiedAt ? new Date(b.verifiedAt) : null, verifiedById: b.verifiedById ?? null, fromContractId: null,
          }
          : {
            value: Prisma.JsonNull, valueText: null, valueNumber: null, valueDate: null, source: 'ai', confidence: null,
            quote: null, section: null, issue: null, anchor: Prisma.JsonNull, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull,
            verifiedAt: null, verifiedById: null, fromContractId: null,
          },
      })
      restored.push(ch.fieldKey)
    }
    if (restored.length) await commit(tx, c, defs)
    return { restored, skipped }
  })
  if (result?.restored.length) {
    reindexContract(contractId).catch(err => console.warn('[field-store] re-index failed contractId=%s: %s', contractId, (err as Error).message))
  }
  return result
}

// ─── Extraction writes ────────────────────────────────────────────────────────

export interface ExtractedField {
  key: string
  kind: FieldKind
  value: unknown
  confidence?: number | null
  quote?: string | null
  section?: string | null
  issue?: string | null
  label?: string | null
  /** docs/39 A6 — the readings of it a long contract's chunks disagreed on (agents candidates.py). */
  candidates?: Array<{ value: unknown; quote?: string | null; section?: string | null }> | null
}

/** docs/39 A6 — at most this many readings of one field are kept. */
const MAX_READINGS = 5

/** Two readings of one term: the same value, or one name inside the other ("Delaware", "the State of Delaware"). */
function sameReading(a: unknown, b: unknown): boolean {
  if (sameValue(a, b)) return true
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = normalizeForSearch(a).norm.trim().toLowerCase()
  const y = normalizeForSearch(b).norm.trim().toLowerCase()
  return Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))
}

/**
 * docs/39 A6 — what a contract says about a field, when it says different
 * things: each distinct reading once, as the field reads it, with its words;
 * the value written first. Null when the readings come to one value.
 */
function readingsOf(def: FieldDef, f: ExtractedField, value: unknown): FieldCandidate[] | null {
  if (!Array.isArray(f.candidates) || f.candidates.length < 2) return null
  const out: FieldCandidate[] = [{ value, display: displayOf(def, value), quote: f.quote ?? null, section: f.section ?? null }]
  for (const c of f.candidates) {
    if (!c || typeof c !== 'object' || unreadable(def, c.value)) continue
    const v = normaliseValue(def, c.value)
    if (v === null || v === undefined) continue
    const quote = typeof c.quote === 'string' && c.quote.trim() ? c.quote.slice(0, 4000) : null
    const same = out.find(o => sameReading(o.value, v))
    if (same) {
      if (!same.quote && quote) same.quote = quote
      continue
    }
    out.push({ value: v, display: displayOf(def, v), quote, section: typeof c.section === 'string' ? c.section : null })
  }
  return out.length > 1 ? out.slice(0, MAX_READINGS) : null
}

/** A6 — the contract value's readings, with its currency ("USD 150,000"), as the value reads. */
export function withCurrency(readings: FieldCandidate[], currency: string): FieldCandidate[] {
  return readings.map(r => (typeof r.value === 'number' ? { ...r, display: `${currency} ${r.display}` } : r))
}

function conflictIssue(readings: FieldCandidate[]): string {
  const shown = readings.map(r => r.display)
  return `The contract says different things: ${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}. Choose the one that governs.`
}

/**
 * replace_ai — refresh every value the AI owns (a new document, a first
 *   analysis); fill_blanks — only fill empty values (re-analysis that should
 *   not disturb anything, a custom-field backfill). Neither touches a value a
 *   person set or checked: those get a suggestion when the AI reads otherwise.
 */
export type ExtractionMode = 'replace_ai' | 'fill_blanks'

export interface ExtractionOutcome {
  written: string[]
  suggested: string[]
  cleared: string[]
  kept: string[]
  /** G1 — what each written or cleared value was before, for a run's undo (lib/field-runs.ts). */
  changes: FieldChange[]
}

/** A value as a run found it: enough to put it back. */
export interface FieldSnapshot {
  value: unknown
  source: string
  confidence: number | null
  quote: string | null
  section: string | null
  issue: string | null
  verifiedAt?: string | null
  verifiedById?: string | null
}

export interface FieldChange {
  fieldKey: string
  before: FieldSnapshot | null
  after: unknown
  /** G3 — a value set from this amendment. */
  fromContractId?: string
}

export function snapshotOf(r: ContractFieldValue | undefined): FieldSnapshot | null {
  if (!r || r.value === null) return null
  return {
    value: r.value, source: r.source, confidence: r.confidence, quote: r.quote, section: r.section, issue: r.issue,
    // C5 — who had checked it, so putting it back puts that back too.
    verifiedAt: r.verifiedAt?.toISOString() ?? null, verifiedById: r.verifiedById,
  }
}

/**
 * docs/39 C5 — a value the assistant set for someone, put back as it was:
 * only while it's still the value that person set through it (nobody has
 * changed or cleared it since). 'changed' when it isn't.
 */
export async function undoPersonValue(input: {
  contractId: string; key: string; userId: string; before: FieldSnapshot | null; after: unknown
}): Promise<'restored' | 'changed' | null> {
  const result = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, input.contractId, null)
    if (!loaded) return null
    const { c, defs, rows } = loaded
    const def = resolveDef(defs, input.key)
    const row = rows.find(r => r.fieldKey === def?.key)
    if (!def || !row || row.source !== 'user' || row.updatedById !== input.userId || !sameValue(row.value ?? null, input.after ?? null)) return 'changed' as const
    const b = input.before
    await tx.contractFieldValue.update({
      where: { id: row.id },
      data: b
        ? {
          value: b.value as Prisma.InputJsonValue, ...projections(def.type, b.value), source: b.source, confidence: b.confidence,
          quote: b.quote, section: b.section, issue: b.issue, anchor: Prisma.JsonNull, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull,
          verifiedAt: b.verifiedAt ? new Date(b.verifiedAt) : null, verifiedById: b.verifiedById ?? null, updatedById: input.userId,
          correctedFrom: Prisma.JsonNull,
        }
        : {
          value: Prisma.JsonNull, valueText: null, valueNumber: null, valueDate: null, source: 'ai', confidence: null,
          quote: null, section: null, issue: null, anchor: Prisma.JsonNull, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull,
          verifiedAt: null, verifiedById: null, updatedById: input.userId, correctedFrom: Prisma.JsonNull,
        },
    })
    await commit(tx, c, defs)
    return 'restored' as const
  })
  if (result === 'restored') {
    reindexContract(input.contractId).catch(err => console.warn('[field-store] re-index failed contractId=%s: %s', input.contractId, (err as Error).message))
  }
  return result
}

/** Certain enough that a term is absent to clear what an earlier run found. */
const ABSENCE_CONFIDENCE = 0.9

/** As sure as the AI may be of a date its quote writes so it reads two ways. */
const AMBIGUOUS_DATE_CONFIDENCE = 0.6

/** As sure as it may be of a field it read as something that field can't hold. */
const UNREADABLE_CONFIDENCE = 0.3

/** What a field holds, for saying that a reading isn't one. */
function kindOfValue(def: Pick<FieldDef, 'type' | 'options'>): string {
  switch (def.type) {
    case 'number':      return 'a number'
    case 'currency':    return 'an amount of money'
    case 'duration':    return 'a length of time'
    case 'percentage':  return 'a percentage'
    case 'date':        return 'a date'
    case 'boolean':     return 'a yes or no'
    case 'select':
    case 'multiselect': return `one of its choices (${(def.options ?? []).join(', ')})`
    default:            return 'a value it can hold'
  }
}

/**
 * docs/39 A5 — an AI reading the field can't hold ("about three years" for
 * a length of time, a choice the field doesn't have) used to be stored as it
 * came, where filters, sorts and charts then missed it. It's kept as not
 * found instead, saying what the AI read, so it reaches a person.
 */
function unreadable(def: Pick<FieldDef, 'type' | 'options'>, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (parseFieldValue(def.type, raw, { options: def.options }).ok) return null
  const said = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return `The AI read “${said.length > 120 ? `${said.slice(0, 117)}…` : said}”, which isn't ${kindOfValue(def)}. Enter the value, or clear it if the contract doesn't say.`
}

/**
 * docs/39 A11 — a date the AI read from "03/04/2025" is a guess at the order
 * of day and month, however sure the model says it is: it asks to be checked
 * (the Review Queue's "unsure"), saying both readings.
 */
function ambiguousDate(value: unknown, quote: string | null | undefined): string | null {
  if (typeof value !== 'string' || !quote) return null
  const amb = ambiguousNumericDate(quote)
  if (!amb || (value !== amb.monthFirst && value !== amb.dayFirst)) return null
  const other = value === amb.monthFirst ? amb.dayFirst : amb.monthFirst
  return `Written "${amb.written}": read as ${formatFieldValue('date', value)}, but it could be ${formatFieldValue('date', other)}. Check which the contract means.`
}

// ─── A Word file's tracked changes (docs/39 A9) ──────────────────────────────

/** As sure as a value read back from beneath the other side's changes may be. */
const AGREED_CONFIDENCE = 0.6

/** What their tracked changes would make a value: null, they take it out. */
interface Proposal { value: unknown; quote: string | null; confidence: number | null }

/**
 * A reading of words the other side's tracked changes put in, split in two:
 * `agreed`, what the file says with the changes rejected — the reading to
 * write; a null value when the file didn't say it before; undefined when its
 * words hold no value that can be read, and the value held stays — and their
 * `proposal`. Null when there's nothing to split: the reading's words are
 * agreed, can't be placed in the file, or say the same value reworded.
 */
function splitProposal(
  def: FieldDef, f: ExtractedField, views: TrackedViews, dateOrder: DateOrder | undefined,
): { agreed: ExtractedField | undefined; proposal: Proposal } | null {
  const quote = f.quote?.trim()
  if (!quote || !holds(f.value)) return null
  if (findQuote(views.agreedNorm, quote) || !findQuote(views.proposedNorm, quote)) return null
  const proposal: Proposal = { value: f.value, quote, confidence: typeof f.confidence === 'number' ? f.confidence : null }
  const passage = counterpart(views, 'agreed', quote)
  // Their words where the file had none: it didn't say this before.
  if (passage === '') return { agreed: { ...f, value: null, quote: null, confidence: null, issue: null }, proposal }
  if (passage === null) return { agreed: undefined, proposal }
  const read = readValueFrom(def.type, passage, { value: f.value, quote }, { options: def.options, dateOrder })
  if (read === undefined) return { agreed: undefined, proposal }
  if (sameValue(normaliseValue(def, read), normaliseValue(def, f.value))) return null
  return { agreed: { ...f, value: read, quote: passage.slice(0, 4000), confidence: Math.min(proposal.confidence ?? 1, AGREED_CONFIDENCE), issue: null }, proposal }
}

/**
 * A value read before — from an earlier version — whose words their changes
 * take out (a null proposal) or change (what they now say). Undefined when
 * their changes don't touch its words, or what they say instead can't be read.
 */
function proposalFromChanges(def: FieldDef, r: ContractFieldValue, views: TrackedViews, dateOrder: DateOrder | undefined): Proposal | undefined {
  const quote = r.quote?.trim()
  if (!quote || !holds(r.value)) return undefined
  if (!findQuote(views.agreedNorm, quote) || findQuote(views.proposedNorm, quote)) return undefined
  const passage = counterpart(views, 'proposed', quote)
  if (passage === '') return { value: null, quote: null, confidence: AGREED_CONFIDENCE }
  if (passage === null) return undefined
  const read = readValueFrom(def.type, passage, { value: r.value, quote }, { options: def.options, dateOrder })
  return read === undefined ? undefined : { value: read, quote: passage.slice(0, 4000), confidence: AGREED_CONFIDENCE }
}

/** Their proposals, beside the values the readings left (a person's included): a suggestion each, over any other. */
async function offerProposals(
  tx: Tx, c: FieldContract, defs: FieldDef[], proposals: Map<string, Proposal>, views: TrackedViews,
  ctx: { versionId: string | null; at: string; dateOrder: DateOrder | undefined }, outcome: ExtractionOutcome,
): Promise<void> {
  const now = new Map((await tx.contractFieldValue.findMany({ where: { contractId: c.id } })).map(r => [r.fieldKey, r]))
  for (const def of defs) {
    const r = now.get(def.key)
    const offer = proposals.get(def.key) ?? (r ? proposalFromChanges(def, r, views, ctx.dateOrder) : undefined)
    if (!offer) continue
    const value = offer.value === null ? null : normaliseValue(def, offer.value)
    if (sameValue(r?.value ?? null, value)) {
      // Taken already: an earlier proposal of it has nothing left to choose.
      if (r && (r.suggestion as FieldSuggestion | null)?.reason === 'proposed') await tx.contractFieldValue.update({ where: { id: r.id }, data: { suggestion: Prisma.JsonNull } })
      continue
    }
    const suggestion: FieldSuggestion = {
      value, display: holds(value) ? displayOf(def, value) : '', quote: offer.quote, section: null,
      confidence: offer.confidence, versionId: ctx.versionId, at: ctx.at, reason: 'proposed',
    }
    if (r) await tx.contractFieldValue.update({ where: { id: r.id }, data: { suggestion: suggestion as unknown as Prisma.InputJsonValue } })
    else {
      await tx.contractFieldValue.create({ data: {
        orgId: c.orgId, contractId: c.id, fieldKey: def.key, kind: def.kind, valueType: def.type, label: def.kind === 'type' ? def.label : null,
        value: Prisma.JsonNull, source: 'ai', suggestion: suggestion as unknown as Prisma.InputJsonValue,
      } })
    }
    if (!outcome.suggested.includes(def.key)) outcome.suggested.push(def.key)
  }
}

export async function applyExtraction(
  contractId: string,
  fields: ExtractedField[],
  opts: {
    mode: ExtractionMode; versionId?: string | null; protectKeys?: readonly string[]; reindex?: boolean
    /** A9 — the version is a Word file with tracked changes: its two readings (lib/tracked-changes.ts). */
    tracked?: TrackedViews | null
    /** A7 — the version is a scan: the page a quote is on, when the OCR engine was unsure of it (lib/scan-quality.ts). */
    poorPageOf?: ((quote: string) => number | null) | null
  },
): Promise<ExtractionOutcome | null> {
  const outcome: ExtractionOutcome = { written: [], suggested: [], cleared: [], kept: [], changes: [] }
  const done = await prisma.$transaction(async tx => {
    const loaded = await loadInTx(tx, contractId, null)
    if (!loaded) return false
    const { c, defs, rows } = loaded
    const byKey = new Map(rows.map(r => [r.fieldKey, r]))
    const protect = new Set(opts.protectKeys ?? [])
    const at = new Date().toISOString()
    const tracked = opts.tracked ?? null
    const dateOrder = tracked ? await orgDateOrder(c.orgId) : undefined
    // A9 — what their changes would make each value, set beside it once the readings are written.
    const proposals = new Map<string, Proposal>()
    for (const f0 of fields) {
      const def = f0.kind === 'core' ? defs.find(d => d.kind === 'core' && d.key === canonicalFieldKey(f0.key)) : defs.find(d => d.kind === f0.kind && d.key === f0.key)
      // The model's output follows the document it read: only fields this
      // contract really has are written (X26 — never a key the server owns).
      // A legacy field is still accepted: an agents service older than the
      // API (mid-deploy) still sends the pre-split notice period.
      if (!def) continue
      // A9 — read from words their tracked changes put in: what the file
      // says without them is written, and their proposal goes beside it.
      let f = f0
      const split = tracked ? splitProposal(def, f0, tracked, dateOrder) : null
      if (split) {
        proposals.set(def.key, split.proposal)
        // The agreed words hold no value we can read: the value held stays.
        if (split.agreed === undefined) { outcome.kept.push(def.key); continue }
        f = split.agreed
      }
      const misread = unreadable(def, f.value)
      const value = misread ? null : normaliseValue(def, f.value)
      const row = byKey.get(def.key)
      const confidence = typeof f.confidence === 'number' ? f.confidence : null
      const amb = def.type === 'date' ? ambiguousDate(value, f.quote) : null
      // A7 — read from a page of the scan the OCR engine was unsure of: checked against the page.
      const poorPage = value !== null && f.quote && opts.poorPageOf ? opts.poorPageOf(f.quote) : null
      // docs/39 A6 — the contract says different things about it: every reading, for a person to choose.
      const readings = value !== null ? readingsOf(def, f, value) : null
      const evidence = {
        confidence: misread ? Math.min(confidence ?? 1, UNREADABLE_CONFIDENCE) : amb ? Math.min(confidence ?? 1, AMBIGUOUS_DATE_CONFIDENCE) : confidence,
        quote: f.quote ?? null, section: f.section ?? null,
        issue: misread ?? amb ?? (readings ? conflictIssue(readings) : null) ?? f.issue ?? (poorPage ? poorScanIssue(poorPage) : null),
      }
      if ((isLocked(row) || protect.has(def.key)) && split) {
        // A9 — a person's value: what their changes propose may be raised
        // (offerProposals), never the agreed words read back — the person may
        // have taken the proposal already.
        if (row?.suggestion) await tx.contractFieldValue.update({ where: { id: row.id }, data: { suggestion: Prisma.JsonNull } })
        outcome.kept.push(def.key)
        continue
      }
      if (isLocked(row) || protect.has(def.key)) {
        if (value !== null && !sameValue(row?.value ?? null, value)) {
          const suggestion: FieldSuggestion = { value, display: displayOf(def, value), quote: evidence.quote, section: evidence.section, confidence: evidence.confidence, versionId: opts.versionId ?? null, at }
          if (row) await tx.contractFieldValue.update({ where: { id: row.id }, data: { suggestion: suggestion as unknown as Prisma.InputJsonValue } })
          outcome.suggested.push(def.key)
        } else {
          if (row?.suggestion) await tx.contractFieldValue.update({ where: { id: row.id }, data: { suggestion: Prisma.JsonNull } })
          outcome.kept.push(def.key)
        }
        continue
      }
      const hasValue = row?.value !== null && row?.value !== undefined
      if (value === null) {
        const certain = (evidence.confidence ?? 0) >= ABSENCE_CONFIDENCE
        // A9 — gone only because their tracked changes take it out: it stands, and that's proposed.
        const theirs = !!tracked && !!row?.quote?.trim() && !!findQuote(tracked.agreedNorm, row.quote) && !findQuote(tracked.proposedNorm, row.quote)
        if (opts.mode === 'replace_ai' && hasValue && certain && !theirs) {
          await tx.contractFieldValue.update({
            where: { id: row!.id },
            data: { value: Prisma.JsonNull, valueText: null, valueNumber: null, valueDate: null, ...evidence, anchor: Prisma.JsonNull, suggestion: Prisma.JsonNull, candidates: Prisma.JsonNull },
          })
          outcome.cleared.push(def.key)
          outcome.changes.push({ fieldKey: def.key, before: snapshotOf(row), after: null })
        } else if (!row) {
          // The model looked and found nothing: keep that, so the field counts as read.
          await tx.contractFieldValue.create({ data: { orgId: c.orgId, contractId: c.id, fieldKey: def.key, kind: def.kind, valueType: def.type, label: def.kind === 'type' ? (f.label ?? def.label) : null, value: Prisma.JsonNull, source: 'ai', ...evidence } })
        } else {
          outcome.kept.push(def.key)
        }
        continue
      }
      if (opts.mode === 'fill_blanks' && hasValue) {
        if (!sameValue(row!.value, value)) {
          const suggestion: FieldSuggestion = { value, display: displayOf(def, value), quote: evidence.quote, section: evidence.section, confidence: evidence.confidence, versionId: opts.versionId ?? null, at }
          await tx.contractFieldValue.update({ where: { id: row!.id }, data: { suggestion: suggestion as unknown as Prisma.InputJsonValue } })
          outcome.suggested.push(def.key)
        } else outcome.kept.push(def.key)
        continue
      }
      const data = {
        value: value as Prisma.InputJsonValue, ...projections(def.type, value), valueType: def.type,
        source: 'ai', ...evidence, anchor: Prisma.JsonNull, verifiedAt: null, verifiedById: null,
        rejectedAt: null, suggestion: Prisma.JsonNull,
        candidates: readings ? (readings as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        ...(def.kind === 'type' ? { label: f.label ?? def.label } : {}),
      }
      if (row) await tx.contractFieldValue.update({ where: { id: row.id }, data })
      else await tx.contractFieldValue.create({ data: { orgId: c.orgId, contractId: c.id, fieldKey: def.key, kind: def.kind, ...data } })
      outcome.written.push(def.key)
      if (!sameValue(row?.value ?? null, value)) outcome.changes.push({ fieldKey: def.key, before: snapshotOf(row), after: value })
    }
    // A9 — what another version's tracked changes proposed is settled by this
    // version's reading: taken into it, or not.
    if (opts.versionId) {
      await tx.$executeRaw`UPDATE contract_field_values SET suggestion = 'null'::jsonb
        WHERE "contractId" = ${c.id} AND suggestion->>'reason' = 'proposed' AND suggestion->>'versionId' IS DISTINCT FROM ${opts.versionId}`
    }
    if (tracked) await offerProposals(tx, c, defs, proposals, tracked, { versionId: opts.versionId ?? null, at, dateOrder }, outcome)
    await commit(tx, c, defs)
    return true
  })
  if (!done) return null
  if (opts.reindex) reindexContract(contractId).catch(err => console.warn('[field-store] re-index failed contractId=%s: %s', contractId, (err as Error).message))
  return outcome
}

// ─── Reading an extraction PATCH ──────────────────────────────────────────────

/** The column → core field an extraction PATCH writes, besides keyTerms. */
const COLUMN_KEYS = ['effectiveDate', 'expiryDate', 'value', 'currency', 'jurisdiction', 'counterpartyName'] as const

/**
 * The fields in a PATCH body from the agents service (review.py): keyTerms
 * with fieldConfidence, the promoted columns, `_typeFields`, and the org's
 * custom fields with `_customFieldEvidence`. keyTerms wins over a column it
 * was promoted from; counterpartyName comes with the parties' evidence.
 */
/** docs/39 A6 — the readings an extraction sent with a field, when its chunks disagreed. */
function readingsIn(ev: Record<string, unknown>): ExtractedField['candidates'] {
  return Array.isArray(ev.candidates) ? (ev.candidates.filter(c => c && typeof c === 'object') as NonNullable<ExtractedField['candidates']>) : null
}

export function extractedFieldsFromPatch(body: Record<string, unknown>, customKeys: ReadonlySet<string>): ExtractedField[] {
  const out = new Map<string, ExtractedField>()
  const kt = obj(body.keyTerms)
  const fc = obj(body.fieldConfidence)
  for (const [k, v] of Object.entries(kt)) {
    const def = coreField(k)
    if (!def) continue
    const ev = obj(fc[k])
    // The canonical key beats an older spelling of it.
    if (out.has(def.key) && k !== def.key) continue
    out.set(def.key, { key: def.key, kind: 'core', value: v, confidence: ev.confidence as number | undefined, quote: ev.quote as string | undefined, section: ev.section as string | undefined, issue: ev.issue as string | undefined, candidates: readingsIn(ev) })
  }
  for (const col of COLUMN_KEYS) {
    if (!(col in body)) continue
    const def = coreField(col)!
    if (out.has(def.key) && out.get(def.key)!.value !== null && out.get(def.key)!.value !== undefined) continue
    const ev = obj(fc[def.key])
    const partiesEv = col === 'counterpartyName' ? obj(fc.parties) : {}
    const src = Object.keys(ev).length ? ev : partiesEv
    out.set(def.key, { key: def.key, kind: 'core', value: body[col], confidence: src.confidence as number | undefined, quote: src.quote as string | undefined, section: src.section as string | undefined })
  }
  const md = obj(body.metadata)
  for (const [k, e] of Object.entries(obj(md._typeFields))) {
    const entry = obj(e)
    out.set(`type:${k}`, { key: k, kind: 'type', value: entry.value, confidence: entry.confidence as number | undefined, quote: entry.quote as string | undefined, label: entry.label as string | undefined, issue: entry.issue as string | undefined, candidates: readingsIn(entry) })
  }
  const customEvidence = obj(md._customFieldEvidence)
  for (const k of customKeys) {
    if (!(k in md)) continue
    const ev = obj(customEvidence[k])
    // A5 — the custom pass says when its quote isn't in the document.
    out.set(`custom:${k}`, { key: k, kind: 'custom', value: md[k], confidence: ev.confidence as number | undefined, quote: ev.quote as string | undefined, issue: ev.issue as string | undefined, candidates: readingsIn(ev) })
  }
  return [...out.values()]
}

/**
 * The field values in a person's PATCH (API clients): the columns, keyTerms
 * entries of core fields, and the org's custom keys in metadata.
 */
export function personFieldsFromPatch(body: Record<string, unknown>, customKeys: ReadonlySet<string>): PersonValue[] {
  const out = new Map<string, PersonValue>()
  for (const col of COLUMN_KEYS) {
    if (body[col] === undefined) continue
    const def = coreField(col)!
    const raw = (col === 'effectiveDate' || col === 'expiryDate') && typeof body[col] === 'string' ? String(body[col]).slice(0, 10) : body[col]
    out.set(def.key, { key: def.key, raw })
  }
  for (const [k, v] of Object.entries(obj(body.keyTerms))) {
    const def = coreField(k)
    if (!def || def.legacy || out.has(def.key)) continue
    out.set(def.key, { key: def.key, raw: v })
  }
  const md = obj(body.metadata)
  for (const k of customKeys) if (k in md) out.set(k, { key: k, raw: md[k] })
  return [...out.values()]
}

/** Keys an extraction PATCH carries that the store now writes (removed from the generic update). */
export const STORE_OWNED_PATCH_KEYS = ['keyTerms', 'fieldConfidence', ...COLUMN_KEYS] as const
export const STORE_OWNED_METADATA_KEYS = ['_typeFields', '_customFieldEvidence'] as const
