/**
 * docs/41 Part 15 — the redline agent's scores kept on the findings they are
 * about, and the counts the banner says after a counterparty version.
 */
import { describe, it, expect } from 'vitest'
import { adviceOf, isCounterpartyVersion, matchChanges, summarise } from './change-advice.js'

const f = (id: string, kind: string, clauseType: string | null, evidence: Record<string, string>) => ({ id, kind, clauseType, evidence })
const FINDINGS = [
  f('cap', 'modified', 'liability', { quote: 'Liability under this Agreement is uncapped.', baselineQuote: 'Liability is capped at the fees paid in the prior twelve months.' }),
  f('law', 'deleted', 'governing_law', { baselineQuote: 'This Agreement is governed by the laws of New York.' }),
  f('notice', 'added', 'notice', { quote: 'Notices may be given by email to the addresses above.' }),
  f('terms', 'drafting', null, { quote: 'Liability under this Agreement is uncapped.' }),
]

describe('matching scored changes to findings', () => {
  it('puts each change on the change finding that quotes its words', () => {
    const m = matchChanges([
      { changeId: 'a', clauseType: 'liability', ourText: 'Liability is capped at the fees paid in the prior twelve months.', theirText: 'Liability under this Agreement is uncapped.', recommendation: 'reject', reasoning: 'Uncapped is outside the playbook.' },
      { changeId: 'b', clauseType: 'governing_law', ourText: 'This Agreement is governed by the laws of New York.', theirText: '', recommendation: 'counter' },
      { changeId: 'c', clauseType: 'notice', ourText: '', theirText: 'Notices may be given by email', recommendation: 'accept' },
      { changeId: 'd', clauseType: 'other', ourText: '', theirText: 'Something nobody flagged at all', recommendation: 'accept' },
    ], FINDINGS)
    expect([...m.entries()].map(([id, c]) => [id, c.changeId])).toEqual([['cap', 'a'], ['law', 'b'], ['notice', 'c']])
  })

  it('keeps the stronger advice when two changes land on one finding', () => {
    const m = matchChanges([
      { changeId: 'a', theirText: 'Liability under this Agreement is uncapped.', recommendation: 'accept' },
      { changeId: 'b', theirText: 'this Agreement is uncapped', recommendation: 'reject' },
      { changeId: 'c', theirText: 'Liability under this Agreement', recommendation: 'counter' },
    ], FINDINGS)
    expect(m.get('cap')?.changeId).toBe('b')
  })
})

describe('the advice kept', () => {
  it('names a known recommendation (else counter), with why, both texts and the counter', () => {
    const a = adviceOf({ recommendation: 'reject', reasoning: 'Too far.', ourText: 'x', theirText: 'y', counterText: 'z', counterNote: 'Halfway.' }, 'v1', new Date('2026-10-02T00:00:00Z'))
    expect(a).toEqual({ recommendation: 'reject', reasoning: 'Too far.', severity: null, ourText: 'x', theirText: 'y', counterText: 'z', counterNote: 'Halfway.', baselineVersionId: 'v1', at: '2026-10-02T00:00:00.000Z' })
    expect(adviceOf({ recommendation: 'maybe' }, 'v1').recommendation).toBe('counter')
  })

  it('is for versions the counterparty sent', () => {
    expect(isCounterpartyVersion({ createdById: 'portal:link1' })).toBe(true)
    expect(isCounterpartyVersion({ createdById: 'email:a@b.com' })).toBe(true)
    expect(isCounterpartyVersion({ createdById: 'user_123' })).toBe(false)
  })
})

describe('the banner counts', () => {
  it('counts their changes, the open findings needing attention and the required clauses missing', () => {
    const s = summarise(5, [
      { kind: 'modified', status: 'open' }, { kind: 'added', status: 'accepted' }, { kind: 'deleted', status: 'open' },
      { kind: 'missing_required', status: 'open' }, { kind: 'missing_required', status: 'resolved' },
      { kind: 'drafting', status: 'open' }, { kind: 'position_not_met', status: 'exception_requested' },
    ], true)
    expect(s).toEqual({ versionNumber: 5, changes: 3, needAttention: 3, missingRequired: 1, advised: true })
  })
})
