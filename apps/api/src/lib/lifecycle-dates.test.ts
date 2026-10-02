/**
 * docs/41 Part 18 / fix-up 16 — the moves dates make, and how far an
 * automatic renewal moves the expiry date on.
 */
import { describe, it, expect, vi } from 'vitest'
vi.mock('./prisma.js', () => ({ prisma: {} }))
vi.mock('./lifecycle.js', () => ({ transition: vi.fn() }))
vi.mock('./field-store.js', () => ({ renewExpiry: vi.fn() }))
import { dateMove, renewedExpiry, renewalTermOf } from './lifecycle-dates.js'

const now = new Date('2026-10-02T00:00:00Z')
const at = (d: string) => new Date(`${d}T00:00:00Z`)

describe('an automatic renewal', () => {
  const base = { stage: 'active', stageState: 'active', autoRenew: true }

  it('renews at the expiry date, and again at the renewed one when its term is known', () => {
    expect(dateMove({ ...base, expiryDate: at('2026-10-01') }, now)).toBe('auto_renewed')
    expect(dateMove({ ...base, stageState: 'auto_renewed', expiryDate: at('2026-10-01') }, now)).toBeNull()
    expect(dateMove({ ...base, stageState: 'auto_renewed', expiryDate: at('2026-10-01'), termMonths: 12 }, now)).toBe('auto_renewed')
  })

  it('makes a renewed term expiring as it nears its end', () => {
    expect(dateMove({ ...base, stageState: 'auto_renewed', expiryDate: at('2026-10-20'), termMonths: 12 }, now)).toBe('expiring')
    expect(dateMove({ ...base, stageState: 'auto_renewed', expiryDate: at('2027-10-01'), termMonths: 12 }, now)).toBeNull()
  })

  it('leaves a contract we decided to renew as Renewing, not Expiring, until its end date (fix-up 18)', () => {
    expect(dateMove({ ...base, stageState: 'renewing', expiryDate: at('2026-10-20') }, now)).toBeNull()
    expect(dateMove({ ...base, stageState: 'renewing', expiryDate: at('2026-10-01'), termMonths: 12 }, now)).toBe('auto_renewed')
    expect(dateMove({ ...base, autoRenew: false, stageState: 'renewing', expiryDate: at('2026-10-01') }, now)).toBe('expired')
  })

  it('moves the expiry on by the term, as many terms as it takes to be in the future', () => {
    expect(renewedExpiry(at('2026-10-01'), 12, now)).toEqual({ to: at('2027-10-01'), renewals: 1 })
    expect(renewedExpiry(at('2026-01-31'), 3, now)).toEqual({ to: at('2026-10-31'), renewals: 3 })
  })

  it('reads the term from the column, the stated renewal term, else the initial term', () => {
    expect(renewalTermOf({ renewalTermMonths: 24, keyTerms: { renewalTerm: '1 year' } })).toEqual({ months: 24, from: 'renewal term' })
    expect(renewalTermOf({ renewalTermMonths: null, keyTerms: { renewalTerm: '1 year' } })).toEqual({ months: 12, from: 'renewal term' })
    expect(renewalTermOf({ renewalTermMonths: null, keyTerms: { initialTerm: '36 months' } })).toEqual({ months: 36, from: 'initial term' })
    expect(renewalTermOf({ renewalTermMonths: null, keyTerms: null })).toBeNull()
  })
})
