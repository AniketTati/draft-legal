/** docs/41 Part 14 — when an undecided renewal goes to Legal Ops. */
import { describe, it, expect } from 'vitest'
import { escalationDays, escalationDue, renewalReminderAction } from './renewal-reminders.js'

const NOW = Date.parse('2026-10-02T09:00:00Z')
const inDays = (n: number) => new Date(NOW + n * 24 * 60 * 60 * 1000)

describe('escalationDays', () => {
  it('reads the org setting, 14 by default', () => {
    expect(escalationDays({})).toBe(14)
    expect(escalationDays(null)).toBe(14)
    expect(escalationDays({ renewalEscalationDays: 30 })).toBe(30)
    expect(escalationDays({ renewalEscalationDays: '30' })).toBe(14)
    expect(escalationDays({ renewalEscalationDays: -1 })).toBe(14)
  })
})

describe('escalationDue', () => {
  it('is due from N days before the deadline through the deadline itself', () => {
    expect(escalationDue(inDays(20), NOW, 14, undefined).due).toBe(false)
    expect(escalationDue(inDays(14), NOW, 14, undefined).due).toBe(true)
    expect(escalationDue(inDays(0), NOW, 14, undefined).due).toBe(true)
    expect(escalationDue(inDays(-1), NOW, 14, undefined).due).toBe(false)
    expect(escalationDue(null, NOW, 14, undefined)).toEqual({ due: false, key: null })
  })

  it('happens once per deadline; the next term’s deadline is a new window', () => {
    const first = escalationDue(inDays(10), NOW, 14, undefined)
    expect(first).toEqual({ due: true, key: '2026-10-12' })
    expect(escalationDue(inDays(10), NOW, 14, first.key!).due).toBe(false)
    expect(escalationDue(inDays(10), NOW, 14, '2025-10-12').due).toBe(true)
  })
})

describe('renewalReminderAction (fix-up 17)', () => {
  const deadline = { date: '2026-11-01', days: 30, period: '90 days', confirmed: true }
  it('says "auto-renews" only for an automatic renewal', () => {
    expect(renewalReminderAction({ renewalType: 'auto', expiry: '2027-01-30', deadline })).toBe("auto-renews unless 90 days' notice is served by 2026-11-01.")
    const manual = renewalReminderAction({ renewalType: 'manual', expiry: '2027-01-30', deadline })
    expect(manual).not.toMatch(/auto-renew/)
    expect(manual).toBe("renews only if both sides agree: tell them by 2026-11-01 (90 days' notice) if you want to renew. Otherwise it ends on 2027-01-30.")
    expect(renewalReminderAction({ renewalType: 'manual', expiry: '2027-01-30', deadline: { ...deadline, days: -2 } })).toMatch(/has passed\. Without an agreed renewal it ends on 2027-01-30/)
  })
  it('words a reminder with no deadline by how it renews', () => {
    expect(renewalReminderAction({ renewalType: 'manual', expiry: '2027-01-30' })).toBe('ends on 2027-01-30 unless both sides agree to renew. Review renewal options now.')
    expect(renewalReminderAction({ renewalType: 'none', expiry: '2027-01-30' })).toMatch(/does not renew/)
    expect(renewalReminderAction({ renewalType: 'evergreen', expiry: '2027-01-30' })).toMatch(/runs until either side ends it/)
    expect(renewalReminderAction({ renewalType: null, expiry: '2027-01-30' })).toBe('review renewal options now.')
  })
  it('asks to confirm a notice nobody has checked', () => {
    expect(renewalReminderAction({ renewalType: 'auto', expiry: '2027-01-30', deadline: { ...deadline, confirmed: false } })).toMatch(/Confirm this is the notice to stop renewal/)
  })
})
