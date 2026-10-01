/**
 * integration-sync worker — docs/41 Parts 17 and 20.
 *
 * Runs the 'integration-sync' queue (lib/integrations/sync-queue.ts):
 *
 *   'contract'   — sync one contract to Salesforce (batched by the job id);
 *   'reconcile'  — compare an org's contracts with Salesforce and fix drift;
 *                  with no org, every connected org (the nightly run, 03:30).
 *
 * Retries follow the webhook worker's policy with Salesforce's API limit
 * respected (syncBackoff). A failure no retry can fix (a revoked connection,
 * a record Salesforce refuses) ends the job at once; its log row stays for
 * the retry button in Integration health.
 */
import { Worker, UnrecoverableError, type Job } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { INTEGRATION_SYNC_QUEUE, integrationSyncQueue, syncBackoff, type ContractSyncJob, type ReconcileJob } from '../lib/integrations/sync-queue.js'
import { syncContractsToSalesforce, reconcileOrg, PermanentSyncError, type SyncOutcome } from '../lib/salesforce/sync.js'
import { SalesforceApiError } from '../lib/salesforce/client.js'

type Fetch = typeof fetch

/** The job's work, separate from BullMQ so tests can drive attempts with a mocked fetch. */
export async function handleIntegrationSync(job: Pick<Job, 'name' | 'data' | 'attemptsMade'>, fetchImpl?: Fetch): Promise<SyncOutcome | null> {
  const attempt = job.attemptsMade + 1
  try {
    if (job.name === 'contract') {
      const data = job.data as ContractSyncJob
      const outcome = await syncContractsToSalesforce(data.orgId, [data.contractId], { attempt, event: data.event, fetch: fetchImpl })
      if (outcome.retry) throw outcome.retry
      return outcome
    }
    if (job.name === 'reconcile') {
      const data = job.data as ReconcileJob
      const orgIds = data.orgId
        ? [data.orgId]
        : (await prisma.integrationConnection.findMany({ where: { provider: 'salesforce', status: { in: ['connected', 'error'] } }, select: { orgId: true } })).map(c => c.orgId)
      let last: SyncOutcome | null = null
      for (const orgId of orgIds) {
        last = await reconcileOrg(orgId, { attempt, fetch: fetchImpl }).catch(err => {
          console.warn('[integration-sync] reconcile of %s failed: %s', orgId, (err as Error).message)
          return null
        })
      }
      return last
    }
    return null
  } catch (err) {
    // A bad request (Salesforce refused what we sent) won't pass on a retry;
    // a 5xx, a timeout or the API limit will.
    if (err instanceof PermanentSyncError) throw new UnrecoverableError(err.message)
    if (err instanceof SalesforceApiError && !err.retryable && err.name !== 'SalesforceRateLimitError') throw new UnrecoverableError(err.message)
    throw err
  }
}

export const integrationSyncWorker = new Worker(
  INTEGRATION_SYNC_QUEUE,
  async (job) => handleIntegrationSync(job),
  {
    connection: redis,
    concurrency: 3,
    settings: {
      backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => syncBackoff(attemptsMade, err),
    },
  },
)

integrationSyncWorker.on('failed', (job, err) => {
  console.warn('[integration-sync] job %s failed (attempt %d): %s', job?.id, job?.attemptsMade, err.message)
})

// The nightly reconcile (docs/41 Part 17 "Background sync"). Idempotent:
// BullMQ keys a repeatable job by its id and pattern.
integrationSyncQueue.add('reconcile', { provider: 'salesforce' } satisfies ReconcileJob, {
  repeat: { pattern: '30 3 * * *' },
  jobId: 'repeat-salesforce-reconcile',
  removeOnComplete: true,
  removeOnFail: 50,
}).catch(err => console.error('[integration-sync] could not register the nightly reconcile:', (err as Error).message))
