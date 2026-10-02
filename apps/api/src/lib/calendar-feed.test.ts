/** docs/41 Part 14 — the calendar feed's token and .ics text. */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildIcs, feedTokenSigned, hashFeedToken } from './calendar-feed.js'

beforeAll(() => { process.env.JWT_SECRET ??= 'test-secret-for-calendar-feed-0123456789abcdef' })

describe('buildIcs', () => {
  const ics = buildIcs([
    { uid: 'notice-k1', day: new Date('2026-11-01T00:00:00Z'), summary: 'Last day to give notice: Acme, Inc; MSA', description: 'Line one\nline two', url: 'https://app.example/contracts/k1' },
  ], new Date('2026-10-02T09:00:00Z'))

  it('is a calendar with one all-day event per date', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(ics).toContain('UID:notice-k1@draftlegal')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102')
    expect(ics).toContain('DTSTAMP:20261002T090000Z')
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
  })

  it('escapes text and folds long lines', () => {
    expect(ics).toContain(`SUMMARY:Last day to give notice: Acme\\, Inc${'\\'}; MSA`)
    expect(ics).toContain('DESCRIPTION:Line one\\nline two')
    const long = buildIcs([{ uid: 'x', day: new Date(), summary: 'S'.repeat(200), description: '', url: 'u' }])
    for (const line of long.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    expect(long).toContain('\r\n S')
  })
})

describe('feed tokens', () => {
  it('turns away a made-up token before any lookup', () => {
    expect(feedTokenSigned('x'.repeat(48))).toBe(false)
    expect(feedTokenSigned('short')).toBe(false)
    expect(hashFeedToken('a')).toHaveLength(64)
  })
})
