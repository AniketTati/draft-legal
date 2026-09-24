import { prisma } from './prisma.js'

/**
 * Jobs that run after a contract's analysis has succeeded. Their failure is
 * theirs alone: the document is extracted and usable, so it must not mark the
 * contract's analysis FAILED.
 */
const FOLLOW_ON_JOBS = new Set(['playbook-review', 'playbook-redline', 'redline-analysis', 'approval-summary'])

interface FailedJob {
  name?: string
  data?: unknown
  attemptsMade?: number
  opts?: { attempts?: number }
}

/**
 * What a failed agents job leaves on its contract, once it has no retries
 * left. X57 — a failed redline analysis marked the whole contract's analysis
 * FAILED and left the Negotiate panel on "Analyzing redlines…" forever; it now
 * records its own failure and reason (`_redlineStatus`/`_redlineError`, which
 * the panel shows), and follow-on jobs leave the analysis status alone.
 */
export async function onAgentJobFailed(job: FailedJob | undefined, err: Error): Promise<void> {
  const contractId = (job?.data as { contractId?: string } | undefined)?.contractId
  if (!job || !contractId || (job.attemptsMade ?? 0) < (job.opts?.attempts ?? 2)) return
  if (job.name === 'redline-analysis') {
    const row = await prisma.contract.findUnique({ where: { id: contractId }, select: { metadata: true } })
    if (!row) return
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        metadata: {
          ...((row.metadata as Record<string, unknown> | null) ?? {}),
          _redlineStatus: 'FAILED',
          _redlineError: `The redline analysis could not run: ${err.message}`.slice(0, 500),
        } as never,
      },
    }).catch(() => {})
    return
  }
  if (job.name && FOLLOW_ON_JOBS.has(job.name)) return
  await prisma.contract.update({
    where: { id: contractId },
    data: { analysisStatus: 'FAILED', analysisError: err.message.slice(0, 500) },
  }).catch(() => {})
}
