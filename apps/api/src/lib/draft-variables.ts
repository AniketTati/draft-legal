/**
 * docs/39 H2 — a drafted contract's variables: the terms its template filled
 * in, which its text keeps marked (template-engine's data-variable spans).
 *
 * A term that changes is changed once: the draft's Variables panel rewrites
 * it everywhere it appears in the text (in the editor, saved as a version)
 * and here, in the field it fills. Each variable says which field that is,
 * and whether the field still holds what the text says — a field changed in
 * the Fields panel is a document that says something else.
 */
import { labelFromPlaceholder, type FieldSource, type VariableDef, type VariableType } from '@clm/types'
import { prisma } from './prisma.js'
import { getContractFields, sameValue, setFieldValues, type AuditContext, type FieldView } from './field-store.js'
import { fieldForVariable, fieldsFromVariables } from './template-fields.js'
import { orgDateOrder } from './org-date-order.js'

/** The template a contract was drafted from, as drafting recorded it (metadata._template). */
export interface DraftTemplate {
  id: string
  name: string
  version?: number
  variables?: VariableDef[]
}

export function templateOf(metadata: unknown): DraftTemplate | null {
  const t = (metadata as { _template?: DraftTemplate } | null)?._template
  return t && typeof t.id === 'string' ? t : null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }
const textOf = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e]).trim()

export interface VariablePlaces {
  key: string
  /** Its words where it first appears. */
  text: string
  /** Still the template's blank ("[[key]]"). */
  unfilled: boolean
  count: number
}

/**
 * The variables a document's HTML is marked with, in the order they first
 * appear. A draft made before H2 marks only its blanks (data-key).
 */
export function variablesIn(html: string | null | undefined): VariablePlaces[] {
  const out = new Map<string, VariablePlaces>()
  for (const m of (html ?? '').matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/g)) {
    const attrs = m[1]
    const key = /\bdata-variable="([A-Za-z_][A-Za-z0-9_]*)"/.exec(attrs)?.[1]
      ?? (/\btemplate-variable-unfilled\b/.test(attrs) ? /\bdata-key="([A-Za-z_][A-Za-z0-9_]*)"/.exec(attrs)?.[1] : undefined)
    if (!key) continue
    const seen = out.get(key)
    if (seen) { seen.count++; continue }
    out.set(key, { key, text: textOf(m[2]), unfilled: /\btemplate-variable-unfilled\b/.test(attrs), count: 1 })
  }
  return [...out.values()]
}

/** A variable named from its key when its template doesn't name it: customer_name → Customer name. */
export function labelOfKey(key: string): string {
  return labelFromPlaceholder(key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_+/g, ' ').trim()) || key
}

export interface DraftVariable {
  key: string
  label: string
  type: VariableType
  /** The field it fills, as the contract holds it now; null when it fills none. */
  field: {
    key: string
    label: string
    type: string
    value: unknown
    display: string
    hasValue: boolean
    source: FieldSource | null
    /** The field holds what the text says (or holds nothing yet). */
    inStep: boolean
  } | null
}

const namedFields = (t: DraftTemplate | null) =>
  Object.fromEntries((t?.variables ?? []).filter(v => v.field !== undefined).map(v => [v.key, v.field ?? null]))

/** The field a variable's words give, read as drafting reads them; null when they don't read as it. */
function readWords(fields: FieldView[], key: string, text: string, named: Record<string, string | null>, dateOrder: Awaited<ReturnType<typeof orgDateOrder>>) {
  return fieldsFromVariables({ [key]: text }, fields, { dateOrder, named })[0] ?? null
}

/** The variables the text of a contract's current version is marked with, and the field each fills. */
export async function draftVariables(orgId: string, contractId: string): Promise<{ template: { id: string; name: string } | null; variables: DraftVariable[] } | null> {
  const c = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null },
    select: { metadata: true, currentVersionId: true },
  })
  if (!c) return null
  const version = await prisma.contractVersion.findFirst({
    where: { contractId, ...(c.currentVersionId ? { id: c.currentVersionId } : {}) },
    orderBy: { versionNumber: 'desc' },
    select: { htmlContent: true },
  })
  const template = templateOf(c.metadata)
  const places = variablesIn(version?.htmlContent)
  if (!places.length) return { template: template && { id: template.id, name: template.name }, variables: [] }

  const [loaded, dateOrder] = await Promise.all([getContractFields(orgId, contractId), orgDateOrder(orgId)])
  const fields = loaded?.fields ?? []
  const named = namedFields(template)
  const variables = places.map((p): DraftVariable => {
    const def = template?.variables?.find(v => v.key === p.key)
    const f = fieldForVariable(fields, p.key, named) as FieldView | undefined
    let field: DraftVariable['field'] = null
    if (f && !f.legacy) {
      const hasValue = f.value !== null && f.value !== undefined && f.value !== ''
      const read = p.unfilled ? null : readWords(fields, p.key, p.text, named, dateOrder)
      field = {
        key: f.key, label: f.label, type: f.type, value: f.value ?? null, display: f.display, hasValue, source: f.source,
        inStep: !hasValue || (!!read && sameValue(read.raw, f.value)),
      }
    }
    return { key: p.key, label: def?.label?.trim() || labelOfKey(p.key), type: def?.type ?? 'text', field }
  })
  return { template: template && { id: template.id, name: template.name }, variables }
}

export type SetVariableResult =
  | { ok: true; field: FieldView | null; statusChange?: { from: string; to: string }; unread?: { key: string; label: string } }
  | { ok: false; status: number; detail: string }

/**
 * A variable's new words, into the field it fills: read as drafting reads
 * them and saved as set from the draft's variables (source "variable"), the
 * words as its quote. A variable that fills no field changes only the text;
 * words that don't read as the field (a date written "TBC") leave it as it
 * was, and say so.
 */
export async function setVariableField(input: {
  orgId: string
  contractId: string
  key: string
  text: string
  userId: string
  audit: AuditContext
}): Promise<SetVariableResult> {
  const c = await prisma.contract.findFirst({ where: { id: input.contractId, orgId: input.orgId, deletedAt: null }, select: { metadata: true } })
  if (!c) return { ok: false, status: 404, detail: 'Contract not found' }
  const [loaded, dateOrder] = await Promise.all([getContractFields(input.orgId, input.contractId), orgDateOrder(input.orgId)])
  const fields = loaded?.fields ?? []
  const named = namedFields(templateOf(c.metadata))
  const f = fieldForVariable(fields, input.key, named)
  if (!f || f.legacy) return { ok: true, field: null }
  const read = readWords(fields, input.key, input.text, named, dateOrder)
  if (!read) return { ok: true, field: null, unread: { key: f.key, label: f.label } }
  const r = await setFieldValues({
    orgId: input.orgId, contractId: input.contractId, userId: input.userId, audit: input.audit,
    values: [{ key: f.key, raw: read.raw, source: 'variable', quote: input.text.slice(0, 4000) }],
  })
  if (!r.ok) return r
  return { ok: true, field: r.fields[0] ?? null, ...(r.statusChange ? { statusChange: r.statusChange } : {}) }
}
