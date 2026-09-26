import { prisma } from './prisma.js'

/**
 * The version whose clauses a contract's clause list shows (B.5.6): its
 * current version, or — when that has no extracted clauses yet (an editor
 * save before re-analysis) — the latest version that does. Shared so the
 * approval summary restores against the clauses the agents service read (X27).
 */
export async function clauseVersionId(contractId: string, currentVersionId: string | null): Promise<string | null> {
  if (!currentVersionId) return null
  const count = await prisma.contractClause.count({ where: { versionId: currentVersionId, isSubChunk: false } })
  if (count > 0) return currentVersionId
  const fallback = await prisma.contractVersion.findFirst({
    where:   { contractId, clauses: { some: { isSubChunk: false } } },
    orderBy: { versionNumber: 'desc' },
    select:  { id: true },
  })
  return fallback?.id ?? currentVersionId
}
