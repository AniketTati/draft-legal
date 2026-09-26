/**
 * Stuck-contract recovery — run by the workers every few minutes.
 *
 * In-progress statuses (PARSING … ANALYZING) older than 5 minutes mean the
 * job died mid-flight: reset to FAILED so the user can retry.
 *
 * C13 — PENDING needs different handling. It is also the column's default,
 * so template drafts, request intakes and imports sit at PENDING by design
 * with nothing to parse, and a big upload batch legitimately waits in the
 * queue. So a PENDING contract counts as LOST only when all three hold:
 *   1. its current (else latest) version is an uploaded file never parsed
 *      (s3Key set, plainText empty) — there is work that should be running;
 *   2. it has been PENDING longer than PENDING_LOST_THRESHOLD_MS;
 *   3. no parse job for it is waiting / active / delayed in the queue.
 * (3) is what makes a backlog safe, however deep: a queued job is found. The
 * time bound only covers the gap between the row being written and the job
 * being enqueued, and a sweep racing a job between queue states — 30 minutes
 * is a generous margin for both while still surfacing a lost upload within
 * the hour instead of never. If the queue can't be listed, PENDING is left
 * alone: never FAILED on a guess.
 */
import { prisma } from './prisma.js'
import { documentQueue } from './queue.js'

export const IN_PROGRESS_STATUSES = ['PARSING', 'SPLITTING', 'CLASSIFYING', 'EXTRACTING', 'INDEXING', 'ANALYZING']
export const STUCK_THRESHOLD_MS = 5 * 60 * 1000
export const PENDING_LOST_THRESHOLD_MS = 30 * 60 * 1000

export const LOST_JOB_MESSAGE =
  'This document was never picked up for processing (its job was lost). Click Re-analyze to process it.'

/** Contract ids that still have a parse job in the document queue. */
export async function queuedParseContractIds(): Promise<Set<string>> {
  const jobs = await documentQueue.getJobs(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused'])
  return new Set(
    jobs.filter(j => j?.name === 'parse-document')
      .map(j => (j.data as { contractId?: string } | undefined)?.contractId)
      .filter((id): id is string => typeof id === 'string'),
  )
}

export interface RecoveryResult { inProgressFailed: number; pendingFailed: number; pendingSkipped: 'queue-unavailable' | null }

export async function recoverStuckContracts(opts: {
  now?: number
  /** Injectable for tests; defaults to reading the document queue. */
  listQueued?: () => Promise<Set<string>>
} = {}): Promise<RecoveryResult> {
  const now = opts.now ?? Date.now()

  const inProgress = await prisma.contract.updateMany({
    where: {
      analysisStatus: { in: IN_PROGRESS_STATUSES },
      updatedAt: { lt: new Date(now - STUCK_THRESHOLD_MS) },
    },
    data: { analysisStatus: 'FAILED', analysisError: 'Processing timed out — the job may have crashed mid-flight. Click Re-analyze to retry.' },
  })

  // PENDING uploads that have waited past the threshold and were never parsed.
  const candidates = await prisma.contract.findMany({
    where: {
      analysisStatus: 'PENDING',
      deletedAt: null,
      updatedAt: { lt: new Date(now - PENDING_LOST_THRESHOLD_MS) },
      versions: { some: { s3Key: { not: null }, plainText: '' } },
    },
    select: {
      id: true, currentVersionId: true,
      versions: { orderBy: { versionNumber: 'desc' }, select: { id: true, s3Key: true, plainText: true } },
    },
    take: 1_000,
  })
  const unparsed = candidates.filter(c => {
    const v = c.versions.find(x => x.id === c.currentVersionId) ?? c.versions[0]
    return !!v?.s3Key && !v.plainText
  })

  let pendingFailed = 0
  let pendingSkipped: RecoveryResult['pendingSkipped'] = null
  if (unparsed.length) {
    let queued: Set<string> | null = null
    try { queued = await (opts.listQueued ?? queuedParseContractIds)() }
    catch (err) {
      pendingSkipped = 'queue-unavailable'
      console.warn('[recovery] document queue unavailable — leaving PENDING contracts alone:', (err as Error).message)
    }
    if (queued) {
      const lost = unparsed.filter(c => !queued!.has(c.id)).map(c => c.id)
      if (lost.length) {
        const r = await prisma.contract.updateMany({
          // Re-check the status: a job may have started since we looked.
          where: { id: { in: lost }, analysisStatus: 'PENDING' },
          data:  { analysisStatus: 'FAILED', analysisError: LOST_JOB_MESSAGE },
        })
        pendingFailed = r.count
      }
    }
  }

  if (inProgress.count > 0) console.warn(`[recovery] reset ${inProgress.count} stuck in-progress contract(s) to FAILED`)
  if (pendingFailed > 0) console.warn(`[recovery] reset ${pendingFailed} contract(s) whose parse job was lost to FAILED`)
  return { inProgressFailed: inProgress.count, pendingFailed, pendingSkipped }
}
