/**
 * C6 — the auto-renewal notice deadline, derived server-side.
 */
import { describe, it, expect } from 'vitest'
import { noticeDaysOf, isAutoRenew, renewalNotice } from './renewal-notice.js'

describe('noticeDaysOf', () => {
  it('reads every spelling and both shapes', () => {
    expect(noticeDaysOf({ noticePeriodDays: 120 })).toBe(120)
    expect(noticeDaysOf({ noticePeriod: '90 days' })).toBe(90)
    expect(noticeDaysOf({ renewalNoticeDays: '60' })).toBe(60)
    expect(noticeDaysOf({ noticeDays: 30.4 })).toBe(30)
  })

  it('refuses ranges and junk rather than guessing', () => {
    expect(noticeDaysOf({ noticePeriod: '30-60 days' })).toBeNull()
    expect(noticeDaysOf({ noticePeriod: 'reasonable notice' })).toBeNull()
    expect(noticeDaysOf({})).toBeNull()
    expect(noticeDaysOf(null)).toBeNull()
  })
})

describe('isAutoRenew', () => {
  it('parses booleans and the strings people type', () => {
    expect(isAutoRenew({ autoRenew: true })).toBe(true)
    expect(isAutoRenew({ autoRenew: 'yes' })).toBe(true)
    expect(isAutoRenew({ autoRenew: 'no' })).toBe(false)
    expect(isAutoRenew({ autoRenew: 'false' })).toBe(false)
    expect(isAutoRenew({})).toBe(false)
  })
})

describe('renewalNotice', () => {
  const expiry = new Date('2027-05-01T00:00:00.000Z')

  it('is expiry minus the notice period for an auto-renewing contract', () => {
    const n = renewalNotice({ expiryDate: expiry, keyTerms: { autoRenew: true, noticePeriodDays: 120 } })
    expect(n.autoRenew).toBe(true)
    expect(n.noticeDays).toBe(120)
    expect(n.deadline?.toISOString().slice(0, 10)).toBe('2027-01-01')
  })

  it('has no deadline when the contract does not auto-renew, or the period or expiry is unknown', () => {
    expect(renewalNotice({ expiryDate: expiry, keyTerms: { autoRenew: false, noticePeriodDays: 120 } }).deadline).toBeNull()
    expect(renewalNotice({ expiryDate: expiry, keyTerms: { autoRenew: true } }).deadline).toBeNull()
    expect(renewalNotice({ expiryDate: null, keyTerms: { autoRenew: true, noticePeriodDays: 30 } }).deadline).toBeNull()
  })
})
