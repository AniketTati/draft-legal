/**
 * docs/41 Part 20 — the queue every integration's sync runs on.
 *
 * Its own BullMQ queue ('integration-sync'), so a slow or rate-limited
 * Salesforce org never holds up webhooks, parsing or signing. Retries follow
 * the webhook worker's policy (exponential backoff), with one difference the
 * plan asks for: when Salesforce says the org's API limit is reached, the next
 * attempt waits at least as long as Salesforce asked.
 *
 * Changes to one contract close together are batched: a job's id carries the
 * contract and a 5-second window, so ten edits in a burst become one upsert
 * that reads the contract as it stands when the job runs.
 */
import { Queue } from 'bullmq'
import { redis } from '../redis.js'
import { prisma } from '../prisma.js'
export { syncBackoff } from './backoff.js'

export const INTEGRATION_SYNC_QUEUE = 'integration-sync'
export const integrationSyncQueue = new Queue(INTEGRATION_SYNC_QUEUE, { connection: redis })

export const SYNC_ATTEMPTS = 6
const BATCH_WINDOW_MS = 5_000

export interface ContractSyncJob {
  provider: 'salesforce'
  orgId: string
  contractId: string
  event?: string
}

export interface ReconcileJob {
  provider: 'salesforce'
  /** One org; none = every connected org (the nightly run). */
  orgId?: string
}

const JOB_DEFAULTS = {
  attempts: SYNC_ATTEMPTS,
  backoff: { type: 'integration' },
  removeOnComplete: true,
  removeOnFail: true,
} as const

/** Queue a sync of one contract to Salesforce (batched with others close in time). */
export async function enqueueContractSync(orgId: string, contractId: string, event?: string): Promise<void> {
  const window = Math.floor(Date.now() / BATCH_WINDOW_MS)
  await integrationSyncQueue.add('contract', { provider: 'salesforce', orgId, contractId, event } satisfies ContractSyncJob, {
    ...JOB_DEFAULTS,
    jobId: `salesforce:${contractId}:${window}`,
    delay: BATCH_WINDOW_MS,
  })
}

/** Queue a full comparison of an org's contracts with Salesforce (or every org's). */
export async function enqueueReconcile(orgId?: string): Promise<void> {
  await integrationSyncQueue.add('reconcile', { provider: 'salesforce', orgId } satisfies ReconcileJob, { ...JOB_DEFAULTS, attempts: 3 })
}

/** The events that change what a Salesforce contract record shows. */
const SYNCED_EVENT = /^(contract|signature|approval|amendment)\./

/**
 * Called for every webhook event (lib/webhook-events.ts) and contract status
 * change: when the org has Salesforce connected and the event is about a
 * contract, queue its sync. Never throws: a sync problem must not fail the
 * change that caused it.
 */
export async function noteIntegrationEvent(orgId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const contractId = typeof payload.contractId === 'string' ? payload.contractId : null
    if (!contractId || !SYNCED_EVENT.test(event)) return
    const connected = await prisma.integrationConnection.count({
      where: { orgId, provider: 'salesforce', status: { in: ['connected', 'error'] } },
    })
    if (!connected) return
    await enqueueContractSync(orgId, contractId, event)
  } catch (err) {
    console.warn('[integration-sync] could not queue %s for %s: %s', event, orgId, (err as Error).message)
  }
}

/**
 * Status changes recorded in the audit log from paths that fire no webhook
 * (the approval workflow, a manual status change): registered in app.ts with
 * afterAuditEvent, as the change notice is.
 */
export async function syncOnAuditEvent(event: { orgId: string; action: string; resourceType: string; resourceId: string }): Promise<void> {
  if (event.resourceType !== 'contract' || !['CONTRACT_STATUS_CHANGED', 'CONTRACT_UPDATED'].includes(event.action)) return
  await noteIntegrationEvent(event.orgId, 'contract.updated', { contractId: event.resourceId })
}
