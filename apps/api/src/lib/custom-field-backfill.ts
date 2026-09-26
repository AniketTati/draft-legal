/**
 * Custom-field backfill (X2).
 *
 * A field an admin adds only reached contracts analysed after it existed:
 * extraction reads the org's field definitions at upload, and nothing ever
 * went back. This fills the field in on the contracts that were already there
 * (the org's own, of the field's type, analysed), a page at a time in id
 * order. The cursor and counts are saved on the field definition after every
 * contract, so a retried job, or an admin pressing the button again, resumes
 * where it stopped. A contract that already holds a value — extracted since,
 * or typed in by a user — is left alone.
 *
 * The extraction itself is the agents service's /extract-fields: it asks for
 * this one field, where re-running the full review would replace the
 * contract's clause rows and re-embed it.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { reindexContract } from './elasticsearch.js'
import { CostCapExceededError } from './costCap.js'

export interface BackfillState {
  status:    'QUEUED' | 'RUNNING' | 'PAUSED' | 'DONE' | 'FAILED'
  cursor:    string | null
  processed: number
  filled:    number
  failed:    number
  total:     number | null
  error:     string | null
  updatedAt: string
}

export interface ExtractedField { value: unknown; confidence?: number; quote?: string | null }

/** Calls the agents service's /extract-fields for one contract (the worker's callAgents, in production). */
export type ExtractFields = (args: {
  orgId: string
  contractId: string
  body: { plainText: string; fields: unknown[]; contractType: string | null; orgId: string }
}) => Promise<Record<string, ExtractedField> | null>

const PAGE = 20

export async function runCustomFieldBackfill(
  job: { orgId: string; fieldDefinitionId: string },
  extract: ExtractFields,
): Promise<BackfillState | null> {
  const def = await prisma.contractFieldDefinition.findFirst({
    where: { id: job.fieldDefinitionId, orgId: job.orgId, deletedAt: null },
  })
  if (!def) return null

  // The org's own analysed contracts of the field's type (X17: not a
  // diligence room's), in a stable order for the cursor.
  const where: Prisma.ContractWhereInput = {
    orgId: def.orgId, deletedAt: null, diligenceRoomId: null, analysisStatus: 'DONE',
    ...(def.contractType ? { type: def.contractType } : {}),
  }
  const prior = (def.backfill ?? null) as BackfillState | null
  const resume = prior && prior.status !== 'DONE' ? prior : null
  const state: BackfillState = {
    status:    'RUNNING',
    cursor:    resume?.cursor ?? null,
    processed: resume?.processed ?? 0,
    filled:    resume?.filled ?? 0,
    failed:    resume?.failed ?? 0,
    total:     await prisma.contract.count({ where }),
    error:     null,
    updatedAt: new Date().toISOString(),
  }
  const save = async (patch: Partial<BackfillState> = {}) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() })
    await prisma.contractFieldDefinition.update({ where: { id: def.id }, data: { backfill: state as unknown as Prisma.InputJsonValue } })
  }
  await save()

  const field = {
    fieldKey: def.fieldKey, fieldLabel: def.fieldLabel, fieldType: def.fieldType,
    options: (def.options as string[]) ?? [], helpText: def.helpText ?? undefined,
  }

  try {
    for (;;) {
      const page = await prisma.contract.findMany({
        where:   { ...where, ...(state.cursor ? { id: { gt: state.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take:    PAGE,
        select:  { id: true, type: true, metadata: true, currentVersionId: true },
      })
      if (page.length === 0) break

      for (const c of page) {
        const meta = (c.metadata ?? {}) as Record<string, unknown>
        if (meta[def.fieldKey] == null) {
          const text = c.currentVersionId
            ? (await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { plainText: true } }))?.plainText
            : null
          if (text?.trim()) {
            try {
              const out = (await extract({
                orgId: def.orgId, contractId: c.id,
                body: { plainText: text, fields: [field], contractType: c.type, orgId: def.orgId },
              }))?.[def.fieldKey]
              if (out && out.value != null && await setIfEmpty(c.id, def.fieldKey, out)) state.filled++
            } catch (err) {
              // Out of budget: stop here, resumable once the cap resets.
              if (err instanceof CostCapExceededError) {
                await save({ status: 'PAUSED', error: err.message })
                return state
              }
              console.warn('[custom-field-backfill] %s on %s failed: %s', def.fieldKey, c.id, (err as Error).message)
              state.failed++
            }
          }
        }
        state.processed++
        state.cursor = c.id
        await save()
      }
    }
    await save({ status: 'DONE' })
    return state
  } catch (err) {
    await save({ status: 'FAILED', error: (err as Error).message.slice(0, 500) }).catch(() => {})
    throw err
  }
}

/**
 * Writes the value and its evidence in one statement, and only if the field
 * is still empty: a value that landed meanwhile wins, and other metadata keys
 * written concurrently survive (X4's rule for JSON columns).
 */
async function setIfEmpty(contractId: string, key: string, field: ExtractedField): Promise<boolean> {
  const evidence = { confidence: field.confidence ?? 0.5, quote: field.quote ?? null }
  const updated = await prisma.$executeRaw`
    UPDATE contracts
    SET    metadata = (CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END)
             || jsonb_build_object(${key}::text, ${JSON.stringify(field.value)}::jsonb)
             || jsonb_build_object('_customFieldEvidence',
                  (CASE WHEN jsonb_typeof(metadata->'_customFieldEvidence') = 'object' THEN metadata->'_customFieldEvidence' ELSE '{}'::jsonb END)
                  || jsonb_build_object(${key}::text, ${JSON.stringify(evidence)}::jsonb)),
           "updatedAt" = now()
    WHERE  id = ${contractId}
           AND (metadata IS NULL OR metadata->${key} IS NULL OR metadata->${key} = 'null'::jsonb)`
  if (updated) reindexContract(contractId).catch(() => {})
  return updated > 0
}
