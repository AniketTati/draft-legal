/**
 * DD4 — the version a contract stands on: `currentVersionId`, which an undo
 * moves back to the version before. The undone version stays, as the newest,
 * so "the newest version" is the wrong document after an undo: the page
 * showed and edited it, the PDF and download served it, the counterparty
 * portal showed it to the other side, and re-analysis, retype and the
 * approvers' summary ran on it. The newest is only the fallback, for a
 * contract with no pointer.
 */
import { prisma } from './prisma.js'

export async function standingVersion(contractId: string, currentVersionId: string | null) {
  const current = currentVersionId
    ? await prisma.contractVersion.findFirst({ where: { id: currentVersionId, contractId } })
    : null
  return current ?? await prisma.contractVersion.findFirst({ where: { contractId }, orderBy: { versionNumber: 'desc' } })
}
