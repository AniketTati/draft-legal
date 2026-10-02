/**
 * docs/41 P0.10, Part 18 — every move of a contract's stage, state or turn,
 * on the record in one shape.
 *
 * Status changes were scattered across a dozen routes, workers and agent
 * tools; some wrote an audit event, some folded it into another one, some
 * wrote none. Phase 0 gave them one shape (CONTRACT_STATUS_CHANGED). Part 18
 * moved the contract from a status to a stage, a state within it and a turn
 * (lib/lifecycle.ts makes every move); each move is recorded here as one
 * STAGE_CHANGED audit event on the contract with a typed payload. These are
 * the stage events of docs/41 §6.3 — audit events, not a second log. The
 * payload keeps `from`/`to` as the derived status, so readers of the older
 * events read the new ones the same way.
 */
import { AuditAction, type Stage, type StageState, type Turn, type TransitionSource } from '@clm/types'
import { createAuditEvent } from './audit.js'
import { fireWebhook } from './webhook-events.js'

export type StatusChangeSource = TransitionSource

/** Where a contract stood, or stands. */
export interface StagePosition { stage: Stage; stageState: StageState; turn: Turn; status: string }

export interface StageChange {
  orgId: string
  contractId: string
  from: StagePosition
  to: StagePosition
  /** Who did it; omitted for the system's own changes. */
  userId?: string | null
  source: StatusChangeSource
  /** Why, when someone said (a revert, a return, a cancellation). */
  reason?: string | null
  /** The version the contract stood on. */
  versionId?: string | null
  /** Anything the site adds (an approval instance, a signature request). */
  extra?: Record<string, unknown>
}

/** The audit payload of a stage change, typed (pure, for tests and analytics readers). */
export function stageChangeMetadata(c: Omit<StageChange, 'orgId' | 'contractId' | 'userId'>): Record<string, unknown> {
  return {
    from: c.from.status,
    to: c.to.status,
    fromStage: c.from.stage,
    toStage: c.to.stage,
    fromState: c.from.stageState,
    toState: c.to.stageState,
    fromTurn: c.from.turn,
    toTurn: c.to.turn,
    source: c.source,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.versionId ? { versionId: c.versionId } : {}),
    ...(c.extra ?? {}),
  }
}

/** Whether anything moved: the stage, its state or the turn. */
export function moved(from: StagePosition, to: StagePosition): boolean {
  return from.stage !== to.stage || from.stageState !== to.stageState || from.turn !== to.turn
}

/**
 * Record a move that happened, and tell subscribers: `contract.stage_changed`
 * when the stage or its state moved, `contract.turn_changed` when the turn
 * did. A move to where it stood records nothing. Never throws.
 */
export async function recordStageChange(c: StageChange): Promise<void> {
  if (!moved(c.from, c.to)) return
  await createAuditEvent({
    orgId: c.orgId,
    ...(c.userId && c.userId !== 'system' ? { userId: c.userId } : {}),
    action: AuditAction.STAGE_CHANGED,
    resourceType: 'contract',
    resourceId: c.contractId,
    metadata: stageChangeMetadata(c),
  }).catch(err => console.warn('[stage-change] not recorded contractId=%s %s/%s→%s/%s: %s', c.contractId, c.from.stage, c.from.stageState, c.to.stage, c.to.stageState, (err as Error).message))
  if (c.from.stage !== c.to.stage || c.from.stageState !== c.to.stageState) {
    void fireWebhook(c.orgId, 'contract.stage_changed', {
      contractId: c.contractId,
      from: { stage: c.from.stage, state: c.from.stageState },
      to: { stage: c.to.stage, state: c.to.stageState },
      status: c.to.status,
      turn: c.to.turn,
      source: c.source,
      ...(c.reason ? { reason: c.reason } : {}),
    })
  }
  if (c.from.turn !== c.to.turn) {
    void fireWebhook(c.orgId, 'contract.turn_changed', {
      contractId: c.contractId,
      from: c.from.turn,
      to: c.to.turn,
      stage: c.to.stage,
      source: c.source,
    })
  }
}
