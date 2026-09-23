/**
 * Status changes a user — or the agent's contract_update set_status — may make
 * by hand (X24). One table for both paths; each used to keep its own copy.
 *
 * Moving INTO PENDING_APPROVAL, APPROVED or REJECTED belongs to the approval
 * workflow: /submit-approval (and the agent's approval_route) opens an approval
 * instance as it sets PENDING_APPROVAL, and only a decision — or the
 * workflow's own auto-approve rule — sets APPROVED or REJECTED. Allowed by
 * hand, anyone with edit:contract could mark a contract approved with no
 * approver and no recorded decision. The web offers none of these (A.3).
 */
export const MANUAL_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT:             ['PENDING_REVIEW'],
  PENDING_REVIEW:    ['DRAFT', 'UNDER_NEGOTIATION'],
  UNDER_NEGOTIATION: ['PENDING_REVIEW'],
  PENDING_APPROVAL:  [],
  APPROVED:          ['EXECUTED', 'PENDING_SIGNATURE'],
  EXECUTED:          ['ARCHIVED'],
  EXPIRED:           ['ARCHIVED'],
  REJECTED:          ['DRAFT'],
}

const WORKFLOW_STATUSES = new Set(['PENDING_APPROVAL', 'APPROVED', 'REJECTED'])

/** Whether only the approval workflow sets `status` (X24). */
export function setByWorkflow(status: string): boolean {
  return WORKFLOW_STATUSES.has(status)
}

/** Why a manual change from `from` to `to` isn't allowed, or null when it is. */
export function manualStatusRefusal(from: string, to: string): string | null {
  if ((MANUAL_STATUS_TRANSITIONS[from] ?? []).includes(to)) return null
  if (WORKFLOW_STATUSES.has(to)) {
    return `${to} is set by the approval workflow, not by hand. Submit the contract for approval instead.`
  }
  return `Cannot transition from ${from} to ${to}`
}

/**
 * X42 — the status a contract takes when something its approval judged
 * changes: its type, value or currency, or its document. An APPROVED
 * contract goes back to DRAFT, to be approved again: the approval (and
 * auto-approval, which checks type and value at submission) covered the terms
 * as they stood. Otherwise the status is left alone (undefined).
 */
export function statusAfterTermsChange(status: string): string | undefined {
  return status === 'APPROVED' ? 'DRAFT' : undefined
}
