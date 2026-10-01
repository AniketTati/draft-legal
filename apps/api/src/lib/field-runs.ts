/**
 * docs/39 G1/D1 — runs that write field values in bulk, and their undo.
 *
 * A re-analysis refreshes the AI's values on a contract; filling a new field
 * in across contracts writes one value to each. Either could be wrong at
 * scale — a worse model, a field described badly — with no way back but
 * fixing values one by one. Each run now keeps what it changed and what each
 * value was before; for 30 days it can be undone, which puts back every value
 * still as the run left it (a value a person has since set or checked stays).
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { restoreFieldValues, restoreAmendmentValues, type FieldChange } from './field-store.js'

export const UNDO_DAYS = 30

/**
 * reanalysis: one contract's; backfill: a field filled in across contracts
 * (D1); counterparty: the other party put right where one of ours was named
 * (A8); rollup: an amendment's terms set on its parent (G3); diligence: a
 * field read for a diligence room's documents without it (D6).
 */
export type RunKind = 'reanalysis' | 'backfill' | 'counterparty' | 'rollup' | 'diligence'

export interface RunChange extends FieldChange { contractId: string }

export interface RunView {
  id: string
  kind: RunKind
  contractId: string | null
  fieldDefinitionId: string | null
  createdAt: string
  undoneAt: string | null
  undoUntil: string
  canUndo: boolean
  changes: RunChange[]
}

const undoUntil = (createdAt: Date) => new Date(createdAt.getTime() + UNDO_DAYS * 24 * 60 * 60 * 1000)

function view(r: { id: string; kind: string; contractId: string | null; fieldDefinitionId: string | null; createdAt: Date; undoneAt: Date | null; changes: unknown }): RunView {
  const until = undoUntil(r.createdAt)
  return {
    id: r.id, kind: r.kind as RunKind, contractId: r.contractId, fieldDefinitionId: r.fieldDefinitionId,
    createdAt: r.createdAt.toISOString(), undoneAt: r.undoneAt?.toISOString() ?? null, undoUntil: until.toISOString(),
    canUndo: !r.undoneAt && until.getTime() > Date.now(),
    changes: Array.isArray(r.changes) ? r.changes as RunChange[] : [],
  }
}

/** A run with the changes so far; null when there is nothing to undo. */
export async function recordRun(input: {
  orgId: string; kind: RunKind; contractId?: string | null; fieldDefinitionId?: string | null
  changes: RunChange[]; createdById?: string | null
}): Promise<string | null> {
  if (input.kind === 'reanalysis' && !input.changes.some(c => c.before !== null)) return null
  const run = await prisma.fieldValueRun.create({
    data: {
      orgId: input.orgId, kind: input.kind, contractId: input.contractId ?? null,
      fieldDefinitionId: input.fieldDefinitionId ?? null,
      changes: input.changes as unknown as object, createdById: input.createdById ?? null,
    },
    select: { id: true },
  })
  return run.id
}

/** More changes for a run under way (a backfill, contract by contract). */
export async function appendRunChanges(runId: string, changes: RunChange[]): Promise<void> {
  if (!changes.length) return
  const value = JSON.stringify(changes)
  await prisma.$executeRaw`UPDATE field_value_runs SET changes = changes || ${value}::jsonb WHERE id = ${runId}`
}

export async function getRun(orgId: string, runId: string): Promise<RunView | null> {
  const r = await prisma.fieldValueRun.findFirst({ where: { id: runId, orgId } })
  return r ? view(r) : null
}

export interface RunState { undoUntil: string; canUndo: boolean; undone: boolean; changed: number }

/** Where each run stands, without loading its changes (the field list shows a fill's undo). */
export async function runStates(orgId: string, runIds: string[]): Promise<Map<string, RunState>> {
  if (!runIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ id: string; createdAt: Date; undoneAt: Date | null; changed: number }>>`
    SELECT id, "createdAt", "undoneAt", jsonb_array_length(changes)::int AS changed FROM field_value_runs
    WHERE "orgId" = ${orgId} AND id IN (${Prisma.join(runIds)})`
  return new Map(rows.map(r => {
    const until = undoUntil(r.createdAt)
    return [r.id, { undoUntil: until.toISOString(), canUndo: !r.undoneAt && until.getTime() > Date.now(), undone: !!r.undoneAt, changed: r.changed }]
  }))
}

/** The contract's latest re-analysis that changed a value, while it can still be undone. */
export async function latestReanalysis(orgId: string, contractId: string): Promise<RunView | null> {
  const r = await prisma.fieldValueRun.findFirst({
    where: { orgId, contractId, kind: 'reanalysis', undoneAt: null, createdAt: { gt: new Date(Date.now() - UNDO_DAYS * 24 * 60 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
  })
  return r ? view(r) : null
}

export async function undoRun(input: { orgId: string; runId: string; userId: string }): Promise<
  | { ok: true; restored: number; skipped: number }
  | { ok: false; status: 404 | 409; detail: string }
> {
  const run = await getRun(input.orgId, input.runId)
  if (!run) return { ok: false, status: 404, detail: 'Run not found' }
  if (run.undoneAt) return { ok: false, status: 409, detail: 'This run was already undone.' }
  if (!run.canUndo) return { ok: false, status: 409, detail: `A run can be undone for ${UNDO_DAYS} days.` }
  // Claimed first, so two undos can't both run.
  const claimed = await prisma.fieldValueRun.updateMany({ where: { id: run.id, undoneAt: null }, data: { undoneAt: new Date(), undoneById: input.userId } })
  if (!claimed.count) return { ok: false, status: 409, detail: 'This run was already undone.' }
  const byContract = new Map<string, RunChange[]>()
  for (const ch of run.changes) byContract.set(ch.contractId, [...(byContract.get(ch.contractId) ?? []), ch])
  let restored = 0
  let skipped = 0
  for (const [contractId, changes] of byContract) {
    const r = run.kind === 'rollup' ? await restoreAmendmentValues(contractId, changes) : await restoreFieldValues(contractId, changes)
    restored += r?.restored.length ?? 0
    skipped += r ? r.skipped.length : changes.length
  }
  return { ok: true, restored, skipped }
}
