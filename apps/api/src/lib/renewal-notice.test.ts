/**
 * C6 — the auto-renewal notice deadline, derived server-side.
 */
import { describe, it, expect } from 'vitest'
import { noticeDaysOf, isAutoRenew, renewalNotice, amendedRenewalNotice } from './renewal-notice.js'

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

describe('amendedRenewalNotice', () => {
  const expiry = new Date('2026-12-14T00:00:00.000Z')
  const base = { expiryDate: expiry, keyTerms: { autoRenew: true, noticeDays: 30 } }
  const amendment = (title: string, effective: string, keyTerms: Record<string, unknown>, relationshipType = 'amendment', status = 'EXECUTED') =>
    ({ title, relationshipType, status, keyTerms, effectiveDate: new Date(effective), createdAt: new Date(effective) })

  it('ignores an amendment nobody has signed yet', () => {
    for (const status of ['DRAFT', 'UNDER_NEGOTIATION', 'PENDING_SIGNATURE']) {
      const n = amendedRenewalNotice(base, [amendment('Amendment No. 2 (draft)', '2026-09-01', { noticePeriodDays: 90, autoRenew: false }, 'amendment', status)])
      expect(n).toMatchObject({ noticeDays: 30, autoRenew: true, noticeSetBy: null })
      expect(n.deadline?.toISOString().slice(0, 10)).toBe('2026-11-14')
    }
  })

  it('takes the notice period an amendment set, and names it', () => {
    const n = amendedRenewalNotice(base, [amendment('Amendment No. 1', '2026-06-01', { noticePeriodDays: 60 })])
    expect(n.noticeDays).toBe(60)
    expect(n.deadline?.toISOString().slice(0, 10)).toBe('2026-10-15')
    expect(n.noticeSetBy).toBe('Amendment No. 1')
  })

  it('lets the latest amendment win, whatever order they come in', () => {
    const n = amendedRenewalNotice(base, [
      amendment('Amendment No. 2', '2026-08-01', { noticePeriod: '90 days' }),
      amendment('Amendment No. 1', '2026-06-01', { noticePeriodDays: 60 }),
    ])
    expect(n.noticeDays).toBe(90)
    expect(n.noticeSetBy).toBe('Amendment No. 2')
  })

  it('keeps the base terms when an amendment is silent on them, and ignores exhibits', () => {
    const n = amendedRenewalNotice(base, [
      amendment('Price change', '2026-06-01', { unitPrice: 'US$0.27' }),
      amendment('Exhibit A', '2026-07-01', { noticePeriodDays: 180 }, 'exhibit_only'),
    ])
    expect(n.noticeDays).toBe(30)
    expect(n.noticeSetBy).toBeNull()
    expect(n.deadline?.toISOString().slice(0, 10)).toBe('2026-11-14')
  })

  it('has no deadline once an amendment turns auto-renewal off', () => {
    const n = amendedRenewalNotice(base, [amendment('Amendment No. 1', '2026-06-01', { autoRenew: false })])
    expect(n.autoRenew).toBe(false)
    expect(n.deadline).toBeNull()
  })

  it("carries the amendment's notice as written, by the calendar, and whether it is the non-renewal notice (docs/39 F1)", () => {
    const n = amendedRenewalNotice(base, [amendment('Amendment No. 1', '2026-06-01', { nonRenewalNotice: { value: 2, unit: 'months' } })])
    expect(n.deadline?.toISOString().slice(0, 10)).toBe('2026-10-14')
    expect(n).toMatchObject({ noticeLabel: '2 months', noticeConfirmed: true, noticeDays: 61, noticeSetBy: 'Amendment No. 1' })
  })
})

describe('which notice stops a renewal (docs/39 F1)', () => {
  const yearEnd = new Date('2026-12-31T00:00:00.000Z')

  it('uses the non-renewal notice, counting months by the calendar', () => {
    const n = renewalNotice({ expiryDate: yearEnd, keyTerms: { autoRenew: true, nonRenewalNotice: { value: 3, unit: 'months' } } })
    expect(n.deadline?.toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(n).toMatchObject({ noticeConfirmed: true, noticeLabel: '3 months', noticeDays: 92 })
  })

  it('never takes the notice to end early for the notice to stop a renewal', () => {
    const n = renewalNotice({ expiryDate: yearEnd, keyTerms: { autoRenew: true, terminationNotice: { value: 30, unit: 'days' } } })
    expect(n.deadline).toBeNull()
  })

  it('prefers the non-renewal notice over one found before notices were told apart', () => {
    const n = renewalNotice({ expiryDate: yearEnd, keyTerms: { autoRenew: true, noticePeriodDays: 30, nonRenewalNotice: { value: 90, unit: 'days' } } })
    expect(n).toMatchObject({ noticeDays: 90, noticeConfirmed: true })
  })

  it('still counts a notice found before the split, marked unconfirmed', () => {
    const n = renewalNotice({ expiryDate: yearEnd, keyTerms: { autoRenew: true, noticePeriod: '60 days' } })
    expect(n.deadline?.toISOString().slice(0, 10)).toBe('2026-11-01')
    expect(n).toMatchObject({ noticeConfirmed: false, noticeLabel: '60 days' })
  })

  it('reads the notice as the contract writes it', () => {
    const n = renewalNotice({ expiryDate: yearEnd, keyTerms: { autoRenew: true, nonRenewalNotice: 'ninety (90) days' } })
    expect(n.noticeDays).toBe(90)
  })
})
