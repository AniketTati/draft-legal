/**
 * docs/41 P0.10 — every change of a contract's status, on the record in one
 * shape, and the day it was signed kept.
 *
 * Status changes were scattered across a dozen routes, workers and agent
 * tools; some wrote an audit event, some folded it into another one
 * (`statusFrom`/`statusTo` on CONTRACT_UPDATED), some wrote none. Analytics
 * had nothing to measure stage durations from, and an executed contract
 * didn't record when it was executed. Every site now sets the status through
 * `statusData` (which stamps `executedAt` on EXECUTED) and records it with
 * `recordStatusChange`: a CONTRACT_STATUS_CHANGED audit event on the
 * contract, with a typed payload. These are the stage events of docs/41
 * §6.3 — audit events, not a second log.
 */
import { AuditAction } from '@clm/types'
import { createAuditEvent } from './audit.js'

/** What set the status: a person, the approval workflow, signing, the counterparty, the agent… */
export type StatusChangeSource =
  | 'manual' | 'approval' | 'signature' | 'counterparty' | 'edit' | 'agent' | 'revert' | 'system'

export interface StatusChange {
  orgId: string
  contractId: string
  from: string
  to: string
  /** Who did it; omitted for the system's own changes. */
  userId?: string | null
  source: StatusChangeSource
  /** Why, when someone said (a revert, a return). */
  reason?: string | null
  /** The version the contract stood on. */
  versionId?: string | null
  /** Anything the site adds (an approval instance, a signature request). */
  extra?: Record<string, unknown>
}

/** The `data` of a contract update that moves it to `to`: EXECUTED also records when. */
export function statusData(to: string, at: Date = new Date()): { status: string; executedAt?: Date } {
  return to === 'EXECUTED' ? { status: to, executedAt: at } : { status: to }
}

/** The audit payload of a status change, typed (pure, for tests and analytics readers). */
export function statusChangeMetadata(c: Omit<StatusChange, 'orgId' | 'contractId' | 'userId'>): Record<string, unknown> {
  return {
    from: c.from,
    to: c.to,
    source: c.source,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.versionId ? { versionId: c.versionId } : {}),
    ...(c.extra ?? {}),
  }
}

/** Record a change that happened. A change to the same status records nothing. Never throws. */
export async function recordStatusChange(c: StatusChange): Promise<void> {
  if (!c.to || c.from === c.to) return
  await createAuditEvent({
    orgId: c.orgId,
    ...(c.userId && c.userId !== 'system' ? { userId: c.userId } : {}),
    action: AuditAction.CONTRACT_STATUS_CHANGED,
    resourceType: 'contract',
    resourceId: c.contractId,
    metadata: statusChangeMetadata(c),
  }).catch(err => console.warn('[status-change] not recorded contractId=%s %s→%s: %s', c.contractId, c.from, c.to, (err as Error).message))
}
