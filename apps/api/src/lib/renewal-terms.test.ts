/**
 * docs/41 Part 14 — the renewal columns worked out from a contract's values
 * and its signed amendments.
 */
import { describe, it, expect, vi } from 'vitest'
vi.mock('./prisma.js', () => ({ prisma: {} }))
import { renewalColumns, monthsIn } from './renewal-terms.js'
import { amendedRenewalNotice } from './renewal-notice.js'

const expiry = new Date('2026-12-31T00:00:00Z')
const amendment = (title: string, effective: string, keyTerms: Record<string, unknown>, status = 'EXECUTED') =>
  ({ title, relationshipType: 'amendment', status, keyTerms, effectiveDate: new Date(effective), createdAt: new Date(effective) })

describe('renewalColumns', () => {
  it('reads an automatic renewal: type, term, notice, deadline, earliest notice and price cap', () => {
    const c = renewalColumns({ expiryDate: expiry, keyTerms: {
      renewalType: 'Automatic', renewalTerm: { value: 1, unit: 'years' }, nonRenewalNotice: { value: 90, unit: 'days' },
      optOutWindow: { value: 120, unit: 'days' }, priceUpliftCap: 5,
    } })
    expect(c).toMatchObject({ renewalType: 'auto', renewalTermMonths: 12, noticeDays: 90, priceUpliftCap: 5, renewalConfirmed: false })
    expect(c.noticeDeadline?.toISOString().slice(0, 10)).toBe('2026-10-02')
    expect(c.optOutWindowStart?.toISOString().slice(0, 10)).toBe('2026-09-02')
  })

  it('gives a contract renewing by agreement a last day to tell them, and none to an evergreen one', () => {
    const manual = renewalColumns({ expiryDate: expiry, keyTerms: { renewalType: 'By agreement', nonRenewalNotice: '60 days' } })
    expect(manual.renewalType).toBe('manual')
    expect(manual.noticeDeadline?.toISOString().slice(0, 10)).toBe('2026-11-01')
    const evergreen = renewalColumns({ expiryDate: expiry, keyTerms: { renewalType: 'Evergreen', nonRenewalNotice: '60 days' } })
    expect(evergreen).toMatchObject({ renewalType: 'evergreen', noticeDeadline: null })
    expect(renewalColumns({ expiryDate: expiry, keyTerms: { renewalType: 'None' } }).renewalType).toBe('none')
  })

  it('reads the older autoRenew flag as automatic', () => {
    expect(renewalColumns({ expiryDate: expiry, keyTerms: { autoRenew: true, noticePeriodDays: 30 } }).renewalType).toBe('auto')
    expect(renewalColumns({ expiryDate: expiry, keyTerms: { autoRenew: false } }).renewalType).toBeNull()
  })

  it('applies a signed amendment’s notice and renewal type, and not a draft’s', () => {
    const base = { expiryDate: expiry, keyTerms: { renewalType: 'Automatic', nonRenewalNotice: '30 days', priceUpliftCap: 3 } }
    const c = renewalColumns(base, [
      amendment('Amendment No. 1', '2026-03-01', { nonRenewalNotice: '60 days', priceUpliftCap: 4 }),
      amendment('Amendment No. 2', '2026-05-01', { renewalType: 'By agreement', nonRenewalNotice: '120 days' }, 'DRAFT'),
    ])
    expect(c).toMatchObject({ renewalType: 'auto', noticeDays: 60, priceUpliftCap: 4 })
    expect(c.noticeDeadline?.toISOString().slice(0, 10)).toBe('2026-11-01')
    const signed = renewalColumns(base, [amendment('Amendment No. 2', '2026-05-01', { renewalType: 'By agreement' })])
    expect(signed.renewalType).toBe('manual')
  })

  it('is confirmed only when every renewal value it has was set or checked by a person', () => {
    const kt = { expiryDate: expiry, keyTerms: { renewalType: 'Automatic', nonRenewalNotice: '30 days' } }
    expect(renewalColumns(kt, [], []).renewalConfirmed).toBe(false)
    expect(renewalColumns(kt, [], [{ key: 'renewalType', locked: true }, { key: 'nonRenewalNotice', locked: false }]).renewalConfirmed).toBe(false)
    expect(renewalColumns(kt, [], [{ key: 'renewalType', locked: true }, { key: 'nonRenewalNotice', locked: true }, { key: 'title', locked: false }]).renewalConfirmed).toBe(true)
  })

  it('counts months', () => {
    expect(monthsIn({ value: 2, unit: 'years' })).toBe(24)
    expect(monthsIn({ value: 90, unit: 'days' })).toBe(3)
    expect(monthsIn(null)).toBeNull()
  })
})

describe('amendedRenewalNotice reads the stored columns first', () => {
  it('uses the stored deadline and type over the values', () => {
    const stored = new Date('2026-08-01T00:00:00Z')
    const n = amendedRenewalNotice({ expiryDate: expiry, keyTerms: { autoRenew: true, noticePeriodDays: 30 }, noticeDeadline: stored, noticeDays: 152, renewalType: 'manual' })
    expect(n).toMatchObject({ deadline: stored, noticeDays: 152, renewalType: 'manual', autoRenew: false })
  })
  it('works it out when the columns were never synced', () => {
    const n = amendedRenewalNotice({ expiryDate: expiry, keyTerms: { autoRenew: true, noticePeriodDays: 30 }, noticeDeadline: null, renewalType: null })
    expect(n.deadline?.toISOString().slice(0, 10)).toBe('2026-12-01')
  })
})
