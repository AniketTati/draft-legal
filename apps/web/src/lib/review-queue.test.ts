/**
 * EE1 — every action in the review drawer is a decision, and a decided clause
 * leaves the queue. The queue used to hold every flagged clause whatever its
 * state: accepting one moved the drawer on but "n / total" never shrank, the
 * clause came round again, Reject was stored as a plain "reviewed", and Mark
 * reviewed didn't move on at all.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reviewQueue, nextPending, isReviewState, type ReviewState } from './review-queue'

const flagged = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const states = (s: Record<string, ReviewState>) => (id: string) => s[id]

describe('the review queue', () => {
  it('holds only the clauses still waiting on a decision', () => {
    const q = reviewQueue(flagged, states({ a: 'resolved', b: 'rejected', c: 'unreviewed' }), null)
    expect(q.map(c => c.id)).toEqual(['c', 'd'])
  })

  it('shrinks by one with each decision, whatever the decision', () => {
    for (const verdict of ['resolved', 'rejected', 'reviewed'] as const) {
      expect(reviewQueue(flagged, states({ b: verdict }), 'c')).toHaveLength(3)
    }
  })

  it('keeps a decided clause while it is open, so it can be read and reopened', () => {
    expect(reviewQueue(flagged, states({ a: 'resolved' }), 'a').map(c => c.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is empty once everything is decided', () => {
    expect(reviewQueue(flagged, states({ a: 'resolved', b: 'rejected', c: 'reviewed', d: 'resolved' }), null)).toEqual([])
  })
})

describe('after a decision the drawer moves to', () => {
  it('the next pending clause', () => {
    expect(nextPending(flagged, states({ c: 'resolved' }), 'b')).toBe('d')
  })

  it('a pending clause the reviewer skipped, when none is left after it', () => {
    expect(nextPending(flagged, states({ b: 'resolved', c: 'resolved' }), 'd')).toBe('a')
  })

  it('nowhere once the queue is done, so the drawer closes', () => {
    expect(nextPending(flagged, states({ a: 'resolved', b: 'rejected', c: 'reviewed' }), 'd')).toBeNull()
  })
})

it('knows the four states', () => {
  expect(['unreviewed', 'reviewed', 'resolved', 'rejected'].every(isReviewState)).toBe(true)
  expect(isReviewState('done')).toBe(false)
})

describe('the contract page', () => {
  const page = readFileSync(join(__dirname, '..', 'pages', 'ContractDetailPage.tsx'), 'utf8')
  const drawer = page.slice(page.indexOf('<FocusedReviewDrawer'), page.indexOf('onClose={() => setFocusedClauseId(null)}'))

  it('gives the drawer the queue of undecided clauses', () => {
    expect(page).toMatch(/const queue = reviewQueue\(/)
    expect(drawer).toContain('clauses={queue}')
  })

  it('records each action as its own final state', () => {
    expect(drawer).toMatch(/onAccept=\{\(cid\) => decide\(cid, 'resolved'\)\}/)
    expect(drawer).toMatch(/onReject=\{\(cid\) => decide\(cid, 'rejected'\)\}/)
    expect(drawer).toMatch(/onMarkReviewed=\{\(cid\) => decide\(cid, 'reviewed'\)\}/)
    expect(drawer).toMatch(/onApplied=\{\(cid\) => decide\(cid, 'resolved'\)\}/)
  })

  it('keeps a rejected clause rejected when the page reloads its clauses', () => {
    const seed = page.slice(page.indexOf('B.5.7 — seed review states'), page.indexOf('const updateReviewState'))
    expect(seed).toContain('isReviewState(')
  })
})
