/** docs/41 Part 14 — the "Calendar feed" settings section, rendered to a string. */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CalendarFeedSection } from './CalendarFeedSection'

function render(status?: { active: boolean; createdAt: string | null; revokedAt: string | null }) {
  const qc = new QueryClient()
  if (status) qc.setQueryData(['calendar-feed'], status)
  return renderToString(<QueryClientProvider client={qc}><CalendarFeedSection /></QueryClientProvider>).replace(/<!-- -->/g, '')
}

describe('CalendarFeedSection', () => {
  it('offers to make a link, and says what the feed holds', () => {
    const html = render({ active: false, createdAt: null, revokedAt: null })
    expect(html).toContain('Calendar feed')
    expect(html).toContain('Make my link')
    expect(html).toContain('the last day to give notice')
    expect(html).not.toContain('data-testid="calendar-feed-revoke"')
  })

  it('with a link on: make a new one or turn it off', () => {
    const html = render({ active: true, createdAt: '2026-09-01T10:00:00Z', revokedAt: null })
    expect(html).toContain('Your link has been on since 1 Sept 2026')
    expect(html).toContain('Make a new link')
    expect(html).toContain('data-testid="calendar-feed-revoke"')
  })
})
