/** docs/41 Part 14 — when an undecided renewal goes to Legal Ops. */
import { describe, it, expect } from 'vitest'
import { escalationDays, escalationDue } from './renewal-reminders.js'

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
