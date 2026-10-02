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
 *
 * docs/39 D5 — a re-check reads again the values the AI found too: once an
 * admin rewords what the field means, the old readings were made against the
 * old wording. Values a person set or checked are still left alone; each
 * change is kept for the run's 30-day undo.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { CostCapExceededError } from './costCap.js'
import { applyExtraction } from './field-store.js'
import { trackedChangesOf, versionTrackedViews, type TrackedViews } from './tracked-changes.js'
import { recordRun, appendRunChanges } from './field-runs.js'
import { fieldExamples } from './field-examples.js'

export interface BackfillState {
  status:    'QUEUED' | 'RUNNING' | 'PAUSED' | 'DONE' | 'FAILED'
  cursor:    string | null
  processed: number
  filled:    number
  failed:    number
  total:     number | null
  error:     string | null
  updatedAt: string
  /** docs/39 D1 — the run whose values can be undone for 30 days (lib/field-runs.ts). */
  runId?:    string | null
  /**
   * docs/39 D1 — contracts it read: without a value, with text. `processed`
   * also counts those it passed over, so "filled on 1 of 39" read wrong
   * beside the preview's "7 contracts without a value yet".
   */
  read?:     number
  /** docs/39 D5 — 'recheck': the AI's values read again too; `filled` counts the values that changed. */
  mode?:     'fill' | 'recheck'
}

/** A value the fill leaves alone: one a person set or checked. */
const locked = (r: { value: unknown; source: string; verifiedAt: Date | null } | undefined) =>
  !!r && r.value !== null && (r.verifiedAt !== null || !['ai', 'calculated'].includes(r.source))

export interface ExtractedField {
  value: unknown; confidence?: number; quote?: string | null; issue?: string | null
  /** docs/39 A6 — the contract says different things about it. */
  candidates?: Array<{ value: unknown; quote?: string | null }> | null
}

/** Calls the agents service's /extract-fields for one contract (the worker's callAgents, in production). */
export type ExtractFields = (args: {
  orgId: string
  contractId: string
  body: { plainText: string; fields: unknown[]; contractType: string | null; orgId: string }
}) => Promise<Record<string, ExtractedField> | null>

const PAGE = 20

export async function runCustomFieldBackfill(
  job: { orgId: string; fieldDefinitionId: string; mode?: 'fill' | 'recheck' },
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
  const mode = job.mode ?? prior?.mode ?? 'fill'
  // A paused run resumes; a run of the other kind starts over.
  const resume = prior && prior.status !== 'DONE' && (prior.mode ?? 'fill') === mode ? prior : null
  const state: BackfillState = {
    mode,
    status:    'RUNNING',
    cursor:    resume?.cursor ?? null,
    processed: resume?.processed ?? 0,
    filled:    resume?.filled ?? 0,
    failed:    resume?.failed ?? 0,
    total:     await prisma.contract.count({ where }),
    error:     null,
    updatedAt: new Date().toISOString(),
    runId:     resume?.runId ?? await recordRun({ orgId: def.orgId, kind: 'backfill', fieldDefinitionId: def.id, changes: [] }),
    read:      resume?.read ?? 0,
  }
  const save = async (patch: Partial<BackfillState> = {}) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() })
    await prisma.contractFieldDefinition.update({ where: { id: def.id }, data: { backfill: state as unknown as Prisma.InputJsonValue } })
  }
  await save()

  // A5 — how people filled it in on other contracts, as examples.
  const examples = (await fieldExamples(def.orgId, [def.fieldKey])).get(def.fieldKey)
  const field = {
    fieldKey: def.fieldKey, fieldLabel: def.fieldLabel, fieldType: def.fieldType,
    options: (def.options as string[]) ?? [], helpText: def.helpText ?? undefined,
    ...(examples?.length && { examples }),
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
      // D5 — who set each value, for a re-check to pass over a person's.
      const rows = mode === 'recheck'
        ? new Map((await prisma.contractFieldValue.findMany({
          where: { contractId: { in: page.map(c => c.id) }, fieldKey: def.fieldKey },
          select: { contractId: true, value: true, source: true, verifiedAt: true },
        })).map(r => [r.contractId, r]))
        : null

      for (const c of page) {
        const meta = (c.metadata ?? {}) as Record<string, unknown>
        if (rows ? !locked(rows.get(c.id)) : meta[def.fieldKey] == null) {
          const version = c.currentVersionId
            ? await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { plainText: true, metadata: true } })
            : null
          const text = version?.plainText
          // A9 — a Word file with tracked changes: what's agreed is written, their proposal beside it.
          const tracked = c.currentVersionId && trackedChangesOf(version?.metadata) ? await versionTrackedViews(c.id, c.currentVersionId) : null
          if (text?.trim()) {
            state.read = (state.read ?? 0) + 1
            try {
              const out = (await extract({
                orgId: def.orgId, contractId: c.id,
                body: { plainText: text, fields: [field], contractType: c.type, orgId: def.orgId },
              }))?.[def.fieldKey]
              if (mode === 'recheck') {
                // What the AI reads now replaces what it read before; "not there", only when it is sure.
                if (await rewrite(c.id, def.fieldKey, out ?? { value: null, confidence: 0 }, state.runId ?? null, tracked)) state.filled++
              } else if (out && out.value != null && await setIfEmpty(c.id, def.fieldKey, out, state.runId ?? null, tracked)) state.filled++
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
 * D5 — a re-check's reading, through the store's replace_ai: an AI value is
 * replaced, one a person set or checked meanwhile gets a suggestion instead.
 * True when the value changed.
 */
async function rewrite(contractId: string, key: string, field: ExtractedField, runId: string | null, tracked: TrackedViews | null = null): Promise<boolean> {
  const outcome = await applyExtraction(contractId, [{
    key, kind: 'custom', value: field.value, confidence: field.confidence ?? 0.5, quote: field.quote ?? null, issue: field.issue ?? null, candidates: field.candidates ?? null,
  }], { mode: 'replace_ai', reindex: true, tracked })
  if (runId && outcome?.changes.length) await appendRunChanges(runId, outcome.changes.map(ch => ({ ...ch, contractId })))
  return !!outcome?.changes.length
}

/**
 * Writes the value and its evidence through the field store (docs/39), and
 * only if the field is still empty: a value that landed meanwhile wins (the
 * store records the model's reading beside it as a suggestion), and other
 * metadata keys written concurrently survive — the store rebuilds metadata
 * under a lock on the contract row.
 */
async function setIfEmpty(contractId: string, key: string, field: ExtractedField, runId: string | null, tracked: TrackedViews | null = null): Promise<boolean> {
  const outcome = await applyExtraction(contractId, [{
    key, kind: 'custom', value: field.value, confidence: field.confidence ?? 0.5, quote: field.quote ?? null, issue: field.issue ?? null, candidates: field.candidates ?? null,
  }], { mode: 'fill_blanks', reindex: true, tracked })
  // D1 — each value the run writes is one it can take back.
  if (runId && outcome?.changes.length) await appendRunChanges(runId, outcome.changes.map(ch => ({ ...ch, contractId })))
  return !!outcome?.written.includes(key)
}
