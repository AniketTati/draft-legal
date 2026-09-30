/**
 * EE1 — the review drawer's queue: the flagged clauses still waiting on a
 * decision. Every action in the drawer is a decision (accept, reject, mark
 * reviewed, apply a rewrite), and a decided clause leaves the queue, so the
 * count goes down as the reviewer works through it. It used to hold every
 * flagged clause whatever its state, so "3 / 7" never moved.
 */

/** unreviewed is waiting on the reviewer; the other three are final. */
export type ReviewState = 'unreviewed' | 'reviewed' | 'resolved' | 'rejected'

export const REVIEW_STATES: readonly ReviewState[] = ['unreviewed', 'reviewed', 'resolved', 'rejected']

export const isReviewState = (s: unknown): s is ReviewState =>
  typeof s === 'string' && (REVIEW_STATES as readonly string[]).includes(s)

export const isDecided = (s: ReviewState | undefined): boolean => !!s && s !== 'unreviewed'

/** What each final state is called on screen. */
export const DECISION_LABEL: Record<ReviewState, string> = {
  unreviewed: 'Pending',
  reviewed:   'Reviewed',
  resolved:   'Accepted',
  rejected:   'Rejected',
}

/**
 * The clauses still waiting on a decision, in document order. The clause open
 * in the drawer stays in the list even once decided, so a clause opened from
 * the checklist can be read (and reopened) rather than vanishing.
 */
export function reviewQueue<T extends { id: string }>(
  flagged: T[],
  stateOf: (id: string) => ReviewState | undefined,
  openId: string | null,
): T[] {
  return flagged.filter(c => c.id === openId || !isDecided(stateOf(c.id)))
}

/**
 * Where the drawer goes once `decidedId` is decided: the next clause still
 * pending after it, else the first pending one before it (the reviewer
 * skipped it), else null — nothing is left, and the drawer closes.
 */
export function nextPending<T extends { id: string }>(
  flagged: T[],
  stateOf: (id: string) => ReviewState | undefined,
  decidedId: string,
): string | null {
  const pending = (c: T) => c.id !== decidedId && !isDecided(stateOf(c.id))
  const at = flagged.findIndex(c => c.id === decidedId)
  return flagged.slice(at + 1).find(pending)?.id
    ?? flagged.slice(0, Math.max(at, 0)).find(pending)?.id
    ?? null
}
