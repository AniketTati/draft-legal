/**
 * DD2 — what a version made by editing needs, from every place one is made
 * (an editor save, an applied redline, an assistant change, a sealed
 * signature copy): the older version's clauses now, followed into the new
 * text (clause-carry.ts), then, in the background, the search index's full
 * text, the clauses' windows and embeddings, and a fresh playbook review
 * when clause text changed (the refresh-version job).
 *
 * Never fails the save that called it: the version exists either way, and a
 * version without clauses is what there was before.
 */
import { carryClauses, type CarryResult } from './clause-carry.js'

export async function afterEdit(opts: { contractId: string; orgId: string; versionId: string; fromVersionId?: string | null }): Promise<CarryResult | null> {
  let carried: CarryResult | null = null
  try {
    carried = await carryClauses({ contractId: opts.contractId, toVersionId: opts.versionId, fromVersionId: opts.fromVersionId })
  } catch (err) {
    console.warn('[version-refresh] carrying clauses to versionId=%s failed: %s', opts.versionId, (err as Error).message)
  }
  // Imported here, not at the top: clause-apply is unit-tested, and the
  // queue module opens a Redis connection when loaded.
  const { queueRefreshVersion } = await import('./queue.js')
  queueRefreshVersion({
    contractId: opts.contractId,
    versionId: opts.versionId,
    orgId: opts.orgId,
    fromVersionId: carried?.fromVersionId ?? null,
    review: (carried?.changed ?? 0) > 0,
  })
  return carried
}
