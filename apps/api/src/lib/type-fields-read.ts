/**
 * docs/39 A13 — a contract given another type reads that type's own fields,
 * and only those.
 *
 * Correcting the type re-ran the whole three-pass extraction (every field,
 * every clause, the summary and the risk) to get the handful of fields the
 * new type adds. Here the agents service's /extract-fields (the pass the
 * org's own fields use, A5) reads just those, and they are saved as the AI's
 * — never over a value a person set. The old type's values stay in the store
 * (unseen while the type differs), so changing it back brings them back.
 */
import { typeFieldsFor } from '@clm/types'
import { prisma } from './prisma.js'
import { applyExtraction, type ExtractedField } from './field-store.js'
import { standingVersion } from './standing-version.js'
import { recordRun } from './field-runs.js'
import { versionTrackedViews } from './tracked-changes.js'

/**
 * The read on the contract (metadata._typeFieldsRead) while it runs, so the
 * page says what is happening; and after its last attempt failed, so the page
 * says that and offers it again — the rest of the analysis stands.
 */
export interface TypeFieldsMark { type: string; at: string; error?: string }

export function typeFieldsMark(type: string, error?: string): TypeFieldsMark {
  return { type, at: new Date().toISOString(), ...(error && { error: error.slice(0, 300) }) }
}

/** Sets the mark, without touching anything else (or updatedAt). */
export async function setTypeFieldsMark(contractId: string, mark: TypeFieldsMark): Promise<void> {
  await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_typeFieldsRead}', ${JSON.stringify(mark)}::jsonb) WHERE id = ${contractId}`
}

/** Clears the mark — only one for this type: a later retype's read is its own. */
export async function clearTypeFieldsMark(contractId: string, type: string): Promise<void> {
  await prisma.$executeRaw`UPDATE contracts SET metadata = metadata - '_typeFieldsRead' WHERE id = ${contractId} AND metadata->'_typeFieldsRead'->>'type' = ${type}`
}

export interface TypeFieldsCall {
  (body: { plainText: string; fields: Array<{ fieldKey: string; fieldLabel: string; fieldType: string; options: string[] }>; contractType: string; orgId: string }):
    Promise<Record<string, {
      value: unknown; confidence?: number | null; quote?: string | null; issue?: string | null
      /** docs/39 A6 — the contract says different things about it. */
      candidates?: Array<{ value: unknown; quote?: string | null }> | null
    }> | null>
}

export async function readTypeFields(input: { contractId: string; orgId: string; contractType: string; call: TypeFieldsCall }): Promise<{ written: string[]; read: number } | null> {
  const specs = typeFieldsFor(input.contractType)
  if (!specs.length) return { written: [], read: 0 }
  const c = await prisma.contract.findFirst({ where: { id: input.contractId, orgId: input.orgId, deletedAt: null }, select: { currentVersionId: true, type: true } })
  if (!c) return null
  // Given another type again since: that retype reads its own fields.
  if (c.type !== input.contractType) return { written: [], read: 0 }
  // DD4 — the version the contract stands on.
  const version = await standingVersion(input.contractId, c.currentVersionId)
  if (!version?.plainText) return null
  const found = await input.call({
    plainText: version.plainText,
    fields: specs.map(f => ({ fieldKey: f.key, fieldLabel: f.label, fieldType: f.type, options: [] })),
    contractType: input.contractType,
    orgId: input.orgId,
  })
  if (!found) return null
  const fields: ExtractedField[] = specs.map(f => {
    const got = found[f.key]
    // Asked and not found: kept as looked for, so the field counts as read.
    return { key: f.key, kind: 'type', value: got?.value ?? null, confidence: got?.confidence ?? (got ? null : 0.5), quote: got?.quote ?? null, issue: got?.issue ?? null, label: f.label, candidates: got?.candidates ?? null }
  })
  // A9 — read from a Word file with tracked changes: what's agreed, their proposals beside it.
  const tracked = await versionTrackedViews(input.contractId, version.id)
  const outcome = await applyExtraction(input.contractId, fields, { mode: 'replace_ai', reindex: true, versionId: version.id, tracked })
  // G1 — values it already had (a type it was before) can be put back for 30
  // days, as after a re-analysis.
  if (outcome?.changes.length) {
    await recordRun({
      orgId: input.orgId, kind: 'reanalysis', contractId: input.contractId,
      changes: outcome.changes.map(ch => ({ ...ch, contractId: input.contractId })),
    }).catch(err => console.warn('[type-fields] run not recorded:', (err as Error).message))
  }
  return outcome ? { written: outcome.written, read: specs.length } : null
}
