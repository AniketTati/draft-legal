/**
 * The moves a person — or the assistant's contract_update set_status, for
 * them — may make by hand (X24, docs/41 Part 18). One table for both paths.
 *
 * Moving INTO Approve, or between its states, belongs to the approval
 * workflow: /submit-approval opens a request for approval as it moves the
 * contract, and only a decision (or the workflow's auto-approve rule)
 * approves, returns or declines it. Moving into Sign belongs to the signing
 * flow, which checks the approval. Allowed by hand, anyone with
 * edit:contract could mark a contract approved with no approver and no
 * recorded decision. What is allowed between stages is
 * packages/types lifecycle.ts TRANSITIONS; this adds what a person may do
 * within one.
 *
 * Clients that still send a `status` (PATCH /contracts/:id, the assistant)
 * are read as the stage that status stands for (`manualTarget`).
 */
import { stageForStatus, transitionRefusal, STAGE_LABEL, type StagePoint, type TransitionSource } from '@clm/types'

/** The stage a status names when a client asks to move to it by hand. */
export function manualTarget(status: string): StagePoint | null {
  const known = ['DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PENDING_SIGNATURE', 'EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED']
  return known.includes(status) ? stageForStatus(status) : null
}

/** Within a stage, the state changes a person makes (the rest are a flow's). */
function manualWithin(from: StagePoint, to: StagePoint): boolean {
  if (from.stage === 'draft') return to.state === 'drafting' || to.state === 'ready'
  if (from.stage === 'negotiate') return to.state === 'with_us' || to.state === 'with_counterparty'
  if (from.stage === 'closed') return from.state === 'expired' && to.state === 'archived'
  if (from.stage === 'active') return to.state === 'active' || to.state === 'expiring'
  return false
}

/** Why a manual move from `from` to `to` isn't allowed, or null when it is. */
export function manualRefusal(from: StagePoint, to: StagePoint, opts: { reason?: string | null; source?: TransitionSource; isAdmin?: boolean } = {}): string | null {
  const source = opts.source ?? 'manual'
  // An approval in progress moves when the approval workflow decides it.
  if (from.stage === 'approve' && from.state === 'pending' && !(to.stage === 'closed' && to.state === 'cancelled') && !(to.stage === from.stage && to.state === from.state)) {
    return 'A contract waiting for approval moves when the approval workflow decides it, not by hand. An approver approves, returns or declines it.'
  }
  if (to.state === 'returned') return 'A contract is returned by an approver, through the approval workflow.'
  if (to.stage === 'approve' && !(from.stage === 'approve' && from.state === to.state)) {
    return 'Approval is set by the approval workflow, not by hand. Submit the contract for approval instead.'
  }
  if (to.stage === 'sign' && from.stage !== 'sign') return 'A contract goes to signature by sending it for signature.'
  if (from.stage === to.stage) {
    if (from.state === to.state) return null
    if (!manualWithin(from, to)) return `A contract in ${STAGE_LABEL[from.stage]} can't be moved to that state by hand.`
  }
  // Cancelling and bringing back are their own moves, with a reason.
  const s: TransitionSource = to.stage === 'closed' && to.state === 'cancelled' ? 'cancel'
    : from.stage === 'closed' && from.state === 'cancelled' ? 'undo_cancel'
    : source
  return transitionRefusal({ from, to, source: s, reason: opts.reason, isAdmin: opts.isAdmin })
}

/** The source a manual move is recorded with. */
export function manualSource(from: StagePoint, to: StagePoint, agent = false): TransitionSource {
  if (to.stage === 'closed' && to.state === 'cancelled') return 'cancel'
  if (from.stage === 'closed' && from.state === 'cancelled') return 'undo_cancel'
  return agent ? 'agent' : 'manual'
}
