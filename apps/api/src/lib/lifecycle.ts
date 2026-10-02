/**
 * docs/41 Part 18 — the one way a contract changes stage, state or turn.
 *
 *   transition({ orgId, contractId, to, source, userId, reason, versionId })
 *
 * checks the move against the allowed transitions (packages/types
 * lifecycle.ts TRANSITIONS), writes the stage, state, turn and the status
 * derived from them in one compare-and-set update (a move made meanwhile by
 * someone else is not overwritten), and records it as a STAGE_CHANGED audit
 * event (lib/status-change.ts) with `contract.stage_changed` /
 * `contract.turn_changed` webhooks. Routes, workers and agent tools all call
 * it; nothing else writes `stage` or `status`.
 *
 * The automatic moves have their own helpers here, so each flow says what
 * happened rather than where to go: a counterparty's version, sending to the
 * counterparty, cancelling.
 */
import {
  defaultState, isStage, isStateOf, stageForStatus, statusFor, transitionRefusal, turnFor, STAGE_LABEL, AuditAction,
  type Stage, type StagePoint, type StageState, type TransitionSource, type Turn,
} from '@clm/types'
import { prisma } from './prisma.js'
import { recordStageChange, type StagePosition } from './status-change.js'
import { createAuditEvent } from './audit.js'
import { syncRenewalTermsFor } from './renewal-terms.js'

export interface StageTarget {
  stage: Stage
  /** The state in the stage; the stage's first state when omitted. */
  state?: StageState
  /** Whose move it is; worked out from the stage and state when omitted. */
  turn?: Turn
  /** The person whose move it is, when the turn is ours (the owner when omitted). */
  turnOwnerId?: string | null
}

export interface TransitionArgs {
  orgId: string
  contractId: string
  to: StageTarget
  source: TransitionSource
  userId?: string | null
  reason?: string | null
  versionId?: string | null
  extra?: Record<string, unknown>
  /**
   * Only move from these stages (or stage/state points); otherwise leave the
   * contract where it is and say so (`skipped`). A late approval decision
   * must not pull back a contract a counterparty's upload moved meanwhile.
   */
  onlyFrom?: Array<Stage | StagePoint>
  /** The actor is an admin (undoing a cancellation). */
  isAdmin?: boolean
  /** When it happened (the last signature's time, for `executedAt`). */
  at?: Date
}

export type TransitionResult =
  | { ok: true; changed: boolean; skipped?: boolean; from: StagePosition; to: StagePosition }
  | { ok: false; status: 404 | 409 | 422; refusal: string; from?: StagePosition }

const SELECT = { id: true, stage: true, stageState: true, turn: true, status: true, ownerId: true, executedAt: true, currentVersionId: true } as const

/** A contract's stage as stored, typed (unknown values read as the stage its status stands for). */
export function positionOf(c: { stage: string; stageState: string; turn: string; status: string }): StagePosition {
  if (isStage(c.stage) && isStateOf(c.stage, c.stageState)) {
    return { stage: c.stage, stageState: c.stageState, turn: (c.turn as Turn) ?? turnFor(c.stage, c.stageState), status: c.status }
  }
  const p = stageForStatus(c.status)
  return { stage: p.stage, stageState: p.state, turn: turnFor(p.stage, p.state), status: c.status }
}

/** The columns a new contract starts with, from the status it is created in (an import, a request). */
export function initialStage(status = 'DRAFT', opts: { turn?: Turn } = {}): { status: string; stage: Stage; stageState: StageState; turn: Turn } {
  const p = stageForStatus(status)
  return { status: statusFor(p.stage, p.state), stage: p.stage, stageState: p.state, turn: opts.turn ?? turnFor(p.stage, p.state) }
}

/**
 * A contract created in its first stage (docs/41 Part 14, from E1): the
 * starting point goes on the record as a STAGE_CHANGED event with no `from`,
 * so the stage history and the progress bar of a child drafted by a flow (an
 * amendment, a renewal letter, a notice) begin where it began rather than at
 * its first move. Never throws.
 */
export async function recordCreatedStage(a: { orgId: string; contractId: string; position: StagePosition; source: TransitionSource; userId?: string | null; versionId?: string | null; extra?: Record<string, unknown> }): Promise<void> {
  const p = a.position
  await createAuditEvent({
    orgId: a.orgId,
    ...(a.userId && a.userId !== 'system' ? { userId: a.userId } : {}),
    action: AuditAction.STAGE_CHANGED,
    resourceType: 'contract',
    resourceId: a.contractId,
    metadata: {
      from: null, to: p.status, toStage: p.stage, toState: p.stageState, toTurn: p.turn, source: a.source, created: true,
      ...(a.versionId ? { versionId: a.versionId } : {}), ...(a.extra ?? {}),
    },
  }).catch(err => console.warn('[stage-change] creation not recorded contractId=%s: %s', a.contractId, (err as Error).message))
}

function matches(from: StagePosition, only: Array<Stage | StagePoint>): boolean {
  return only.some(o => typeof o === 'string' ? o === from.stage : o.stage === from.stage && o.state === from.stageState)
}

/** Move a contract. See the module comment. Never throws on a refused move: it says why. */
export async function transition(a: TransitionArgs): Promise<TransitionResult> {
  const c = await prisma.contract.findFirst({ where: { id: a.contractId, orgId: a.orgId }, select: SELECT })
  if (!c) return { ok: false, status: 404, refusal: 'Contract not found' }
  const from = positionOf(c)
  if (a.onlyFrom && !matches(from, a.onlyFrom)) return { ok: true, changed: false, skipped: true, from, to: from }

  const state = a.to.state ?? (a.to.stage === from.stage ? from.stageState : defaultState(a.to.stage))
  const point: StagePoint = { stage: a.to.stage, state }
  const refusal = transitionRefusal({ from: { stage: from.stage, state: from.stageState }, to: point, source: a.source, reason: a.reason, isAdmin: a.isAdmin })
  if (refusal) return { ok: false, status: 409, refusal, from }

  const turn = a.to.turn ?? turnFor(point.stage, point.state)
  const to: StagePosition = { stage: point.stage, stageState: point.state, turn, status: statusFor(point.stage, point.state) }
  if (to.stage === from.stage && to.stageState === from.stageState && to.turn === from.turn) return { ok: true, changed: false, from, to }

  const at = a.at ?? new Date()
  const moved = await prisma.contract.updateMany({
    // Compare-and-set: only from where it was read.
    where: { id: c.id, orgId: a.orgId, stage: c.stage, stageState: c.stageState, turn: c.turn },
    data: {
      stage: to.stage,
      stageState: to.stageState,
      status: to.status,
      turn: to.turn,
      ...(to.turn !== from.turn && { turnSince: at }),
      turnOwnerId: to.turn === 'internal' ? (a.to.turnOwnerId ?? c.ownerId) : null,
      // docs/41 P0.10 — the day it was signed is kept.
      ...(to.stage === 'active' && from.stage !== 'active' && !c.executedAt && { executedAt: at }),
    },
  })
  if (!moved.count) return { ok: false, status: 409, refusal: 'The contract changed meanwhile. Reload the page.', from }

  await recordStageChange({
    orgId: a.orgId, contractId: c.id, from, to, userId: a.userId, source: a.source,
    reason: a.reason?.trim() || null, versionId: a.versionId ?? c.currentVersionId, extra: a.extra,
  })
  // docs/41 Part 14 — a signed (or ended) amendment or renewal moves its
  // parent's notice deadline: only a signed one changes the terms.
  if (from.stage !== to.stage && (from.stage === 'active' || to.stage === 'active')) {
    await syncRenewalTermsFor(a.orgId, c.id).catch(err => console.warn('[renewal-terms] not synced contractId=%s: %s', c.id, (err as Error).message))
  }
  return { ok: true, changed: true, from, to }
}

// ─── The automatic moves ──────────────────────────────────────────────────────

/**
 * A counterparty's version arrived (a portal upload, an emailed redline): the
 * negotiation is back with us. From an approval, the submission is withdrawn
 * first (lib/approval-reset.ts does that, and calls this). A contract out
 * for signature with its envelope still open, or already signed, stays where
 * it is: the version is recorded and the owner decides.
 */
export async function onCounterpartyVersion(a: { orgId: string; contractId: string; versionId: string; via: 'portal' | 'email' }): Promise<TransitionResult> {
  const openEnvelope = await prisma.signatureRequest.count({ where: { orgId: a.orgId, contractId: a.contractId, status: 'PENDING' } })
  return transition({
    orgId: a.orgId, contractId: a.contractId, source: 'counterparty',
    to: { stage: 'negotiate', state: 'with_us' },
    onlyFrom: ['draft', 'negotiate', 'approve', ...(openEnvelope ? [] : ['sign' as const])],
    reason: 'the counterparty sent a new version',
    versionId: a.versionId, extra: { via: a.via },
  })
}

/**
 * We sent it to the counterparty (a share link, an email, a redline
 * downloaded for them): their turn. From a draft that starts the
 * negotiation; later stages are left alone (a copy sent during approval or
 * signing doesn't hand the contract over).
 */
export async function onSentToCounterparty(a: { orgId: string; contractId: string; userId?: string | null; via: string }): Promise<TransitionResult> {
  return transition({
    orgId: a.orgId, contractId: a.contractId, source: 'send', userId: a.userId,
    to: { stage: 'negotiate', state: 'with_counterparty' },
    onlyFrom: ['draft', 'negotiate'],
    extra: { via: a.via },
  })
}

/**
 * The working stage a contract was in before it went for approval or
 * signature: where a return or a revert takes it. Negotiate when it was
 * negotiating, otherwise Draft (docs/41 Part 4). Read from its recorded
 * moves, the older status changes included.
 */
export async function workingStageBefore(orgId: string, contractId: string): Promise<'draft' | 'negotiate'> {
  const events = await prisma.auditEvent.findMany({
    where: { orgId, resourceType: 'contract', resourceId: contractId, action: { in: [AuditAction.STAGE_CHANGED, AuditAction.CONTRACT_STATUS_CHANGED] } },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
    take: 100,
  })
  for (const e of events) {
    const m = (e.metadata ?? {}) as { fromStage?: unknown; toStage?: unknown; from?: unknown; to?: unknown }
    const fromStage = typeof m.fromStage === 'string' ? m.fromStage : typeof m.from === 'string' ? stageForStatus(m.from).stage : null
    const toStage = typeof m.toStage === 'string' ? m.toStage : typeof m.to === 'string' ? stageForStatus(m.to).stage : null
    if ((toStage === 'approve' || toStage === 'sign') && (fromStage === 'draft' || fromStage === 'negotiate')) return fromStage
  }
  // No record: a version from the counterparty means it was negotiated.
  const theirs = await prisma.contractVersion.count({ where: { contractId, OR: [{ createdById: { startsWith: 'portal:' } }, { createdById: { startsWith: 'email:' } }] } })
  return theirs ? 'negotiate' : 'draft'
}

/** "Draft", "Negotiate": a stage in words, for refusals and notifications. */
export const stageWord = (s: Stage) => STAGE_LABEL[s]
