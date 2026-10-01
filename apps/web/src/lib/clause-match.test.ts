import { describe, it, expect } from 'vitest'
import { rankClauseTypes } from './clause-match'

const top = (text: string) => rankClauseTypes(text)[0].type

describe('rankClauseTypes (docs/39 E1)', () => {
  it('reads what a clause is from its words', () => {
    expect(top('Each party shall indemnify, defend and hold harmless the other from any third-party claim.')).toBe('indemnification')
    expect(top('This Agreement is governed by the laws of the State of New York.')).toBe('governing_law')
    expect(top('Neither party shall solicit for employment any employee of the other party.')).toBe('non_solicitation')
    expect(top('Notices must be in writing and sent to the addresses above.')).toBe('notice')
    expect(top('Neither party is liable for delay caused by events beyond its reasonable control, including acts of God (force majeure).')).toBe('force_majeure')
  })
  it('lists every type, so any can be picked', () => {
    expect(rankClauseTypes('x').length).toBeGreaterThan(40)
  })
})
