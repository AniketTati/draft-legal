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
import { prisma } from './prisma.js'
import { carryClauses, copyEmbeddings, type CarryResult } from './clause-carry.js'
import type { RefreshVersionJob } from './queue.js'

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

/**
 * The refresh-version job (run by the parse worker): the search index's full
 * text, the clauses' windows and search entries, their embeddings, and a
 * fresh playbook review. The contract's analysis status is left as it is:
 * nothing was analysed.
 */
export async function refreshVersion(data: RefreshVersionJob): Promise<void> {
  const { contractId, versionId, orgId, fromVersionId, review } = data
  // Loaded here: the queue opens a Redis connection, and the search client an Elasticsearch one.
  const { queueEmbedContract, queuePlaybookReviewSoon } = await import('./queue.js')
  const { reindexContract } = await import('./elasticsearch.js')
  const { legalChunkAndStore } = await import('./legal-chunker.js')
  // The review is of whatever version stands two minutes on, so it is asked
  // for even when this one has been replaced.
  if (review) queuePlaybookReviewSoon({ contractId, orgId })
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { currentVersionId: true, title: true, type: true, jurisdiction: true } })
  // A later save (the editor saves five seconds after typing stops) made a
  // newer version: its own job indexes and embeds that one.
  if (!contract || contract.currentVersionId !== versionId) return
  try {
    await reindexContract(contractId)
  } catch (err) {
    console.warn('[version-refresh] re-index failed contractId=%s: %s', contractId, (err as Error).message)
  }
  const clauses = await prisma.contractClause.findMany({
    where: { versionId, isSubChunk: false },
    orderBy: { sortOrder: 'asc' },
  })
  if (clauses.length) {
    await legalChunkAndStore(versionId, contractId, orgId, clauses, contract)
    if (fromVersionId) await copyEmbeddings(fromVersionId, versionId)
    queueEmbedContract(versionId)
  }
}
