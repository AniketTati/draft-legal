/** docs/41 Part 14 — the renewal words the rail and the dialog show. */
import { describe, it, expect } from 'vitest'
import { deadlineWords, noticeOutstanding, noticeSentWords, type RenewalState } from './renewal'

const terms = { renewalType: 'auto', renewalTermMonths: 12, noticeDays: 60, noticeDeadline: '2026-11-01', optOutWindowStart: null, priceUpliftCap: null, confirmed: true } as RenewalState['terms']

describe('renewal words', () => {
  it('says when the notice was sent, and whether it was in time', () => {
    expect(noticeSentWords({ noticeSentAt: '2026-10-01', noticeSentInTime: true })).toBe('Notice sent 1 Oct 2026, before the deadline')
    expect(noticeSentWords({ noticeSentAt: '2026-11-03', noticeSentInTime: false })).toBe('Notice sent 3 Nov 2026, after the deadline (late)')
    expect(noticeSentWords({ noticeSentAt: null, noticeSentInTime: null })).toBeNull()
  })

  it('counts down to the notice deadline', () => {
    expect(deadlineWords({ terms, daysToDeadline: 30 })).toBe('Last day to give notice: 1 Nov 2026 (in 30 days)')
    expect(deadlineWords({ terms, daysToDeadline: -2 })).toBe('Last day to give notice: 1 Nov 2026 (2 days ago)')
    expect(deadlineWords({ terms: { ...terms, noticeDeadline: null }, daysToDeadline: null })).toBeNull()
  })

  it('asks for the notice only on a decision not to renew that has none yet', () => {
    const base = { decision: { decision: 'let_lapse', noticeSentAt: null } } as unknown as RenewalState
    expect(noticeOutstanding(base)).toBe(true)
    expect(noticeOutstanding({ ...base, decision: { ...base.decision!, noticeSentAt: '2026-10-01' } })).toBe(false)
    expect(noticeOutstanding({ ...base, decision: { ...base.decision!, decision: 'renew' } })).toBe(false)
  })
})
