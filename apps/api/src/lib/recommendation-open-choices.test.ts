/**
 * docs/41 browser QA — a draft with a choice still open (governing law nobody
 * named) read "Ready to approve" while it couldn't even be sent. An open
 * choice is a term nobody has agreed yet: the label is Review at best.
 */
import { describe, it, expect } from 'vitest'
import { guardReasons, policy, type GuardInput } from './recommendation-guard.js'

const done: GuardInput['analysis'] = { kind: 'done', versionId: 'v1', versionNumber: 1, clauses: 3 }
const base: GuardInput = { analysis: done, clauseCount: 3, riskScore: 0.1, findings: [], counterpartyVersionAfterAnalysis: null }

describe('open choices block "Ready to approve"', () => {
  it('a clean draft with no open choices is ready', () => {
    expect(policy(base).label).toBe('ready_to_approve')
  })

  it('one open choice makes it Review, naming the choice', () => {
    const r = policy({ ...base, openChoices: ['Governing law'] })
    expect(r.label).toBe('review')
    expect(r.reasons[0]).toMatchObject({ code: 'open_choices', text: '1 choice is still open in the draft (Governing law)' })
  })

  it('many open choices are counted and listed three at a time', () => {
    const reasons = guardReasons({ ...base, openChoices: ['Governing law', 'Venue', 'Effective date', 'Purpose', 'Term'] })
    expect(reasons.map(r => r.text)).toContain('5 choices are still open in the draft (Governing law, Venue, Effective date and 2 more)')
  })

  it('still says it can\'t recommend when the analysis is missing', () => {
    expect(policy({ ...base, analysis: { kind: 'not_analysed', reason: null }, openChoices: ['Governing law'] }).label).toBe('cant_recommend')
  })
})
