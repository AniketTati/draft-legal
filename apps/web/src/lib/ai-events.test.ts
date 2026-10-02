/**
 * docs/41 Part 16 — AI suggestion outcomes go to the server in batches; a
 * staged batch shown on every render is logged once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const posted = vi.hoisted(() => [] as Array<{ url: string; body: { events: unknown[] } }>)
vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(async (url: string, body: { events: unknown[] }) => { posted.push({ url, body }); return { data: {} } }) },
}))

import { flushAiEvents, logAiEvent, logAiEventOnce, pendingAiEvents } from './ai-events'

beforeEach(() => { posted.length = 0 })

describe('AI suggestion events', () => {
  it('are sent together, not one request each', async () => {
    logAiEvent({ contractId: 'k', feature: 'ask_ai', outcome: 'shown', suggestionId: 's' })
    logAiEvent({ contractId: 'k', feature: 'ask_ai', outcome: 'accepted', suggestionId: 's' })
    expect(posted).toHaveLength(0)
    await flushAiEvents()
    expect(posted).toEqual([{ url: '/ai-suggestion-events', body: { events: [
      { contractId: 'k', feature: 'ask_ai', outcome: 'shown', suggestionId: 's' },
      { contractId: 'k', feature: 'ask_ai', outcome: 'accepted', suggestionId: 's' },
    ] } }])
    expect(pendingAiEvents()).toHaveLength(0)
  })

  it('send a full batch at once, in batches of at most 100', async () => {
    for (let i = 0; i < 150; i++) logAiEvent({ contractId: 'k', feature: 'fix_all', outcome: 'shown', suggestionId: String(i) })
    await flushAiEvents()
    expect(posted.map(p => p.body.events.length)).toEqual([100, 50])
  })

  it('log a shown batch once however often it renders, and nothing without a contract', async () => {
    logAiEventOnce('fix_all:k:1:c1', { contractId: 'k', feature: 'fix_all', outcome: 'shown' })
    logAiEventOnce('fix_all:k:1:c1', { contractId: 'k', feature: 'fix_all', outcome: 'shown' })
    logAiEvent({ contractId: '', feature: 'ask_ai', outcome: 'shown' })
    await flushAiEvents()
    expect(posted[0].body.events).toHaveLength(1)
  })
})
