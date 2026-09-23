/**
 * X22 — POST /agent/feedback scored whichever Langfuse trace the client
 * named: a raw traceId, or the latest trace of a raw sessionId. Any user could
 * score another org's traces, and `recorded` vs `trace_not_found` told them
 * whether a session existed. Only the caller's own chat turns may be scored
 * now; anything else answers `trace_not_found`, as a missing trace does.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, type TestApp } from '../test-support/helpers.js'

const LANGFUSE = 'http://langfuse.test'
let app: TestApp
let orgA: string, orgB: string, alice: string, bob: string, mallory: string

interface Trace { id: string; sessionId: string; userId: string; metadata: Record<string, unknown>; timestamp: string }
let traces: Trace[] = []
const scored: string[] = []
const lookups: string[] = []

beforeAll(async () => {
  process.env.LANGFUSE_HOST = LANGFUSE
  process.env.LANGFUSE_PUBLIC_KEY = 'pk-it'
  process.env.LANGFUSE_SECRET_KEY = 'sk-it'
  app = await getApp()
  orgA = await makeOrg('Feedback Org A')
  orgB = await makeOrg('Feedback Org B')
  ;[alice, bob] = await Promise.all([makeUser(orgA), makeUser(orgA)])
  mallory = await makeUser(orgB)
  traces = [
    { id: 't-alice-1', sessionId: 'thread-1', userId: alice, metadata: { org_id: orgA }, timestamp: '2026-09-01T10:00:00Z' },
    { id: 't-bob-1',   sessionId: 'thread-2', userId: bob,   metadata: { org_id: orgA }, timestamp: '2026-09-01T11:00:00Z' },
    // Mallory reused Alice's thread id for her own chat.
    { id: 't-mallory-1', sessionId: 'thread-1', userId: mallory, metadata: { org_id: orgB }, timestamp: '2026-09-02T09:00:00Z' },
  ]

  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== LANGFUSE) return realFetch(input as never, init)
    if (url.pathname.startsWith('/api/public/traces')) lookups.push(url.pathname + url.search)
    if (url.pathname === '/api/public/scores') {
      scored.push((JSON.parse(String(init?.body)) as { traceId: string }).traceId)
      return new Response('{}')
    }
    const one = url.pathname.match(/^\/api\/public\/traces\/(.+)$/)
    if (one) {
      const t = traces.find(x => x.id === decodeURIComponent(one[1]))
      return t ? new Response(JSON.stringify(t)) : new Response('{}', { status: 404 })
    }
    if (url.pathname === '/api/public/traces') {
      // Langfuse's own filters, as its public API applies them.
      const sessionId = url.searchParams.get('sessionId'), userId = url.searchParams.get('userId')
      const data = traces.filter(t => t.sessionId === sessionId && (!userId || t.userId === userId))
      return new Response(JSON.stringify({ data }))
    }
    return new Response('{}', { status: 404 })
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  delete process.env.LANGFUSE_HOST
  delete process.env.LANGFUSE_PUBLIC_KEY
  delete process.env.LANGFUSE_SECRET_KEY
  await cleanupAll()
  await closeApp()
})

const feedback = (org: string, user: string, payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/v1/agent/feedback', headers: auth(org, ['LEGAL_OPS'], user), payload: { rating: 'down', ...payload },
})

describe('feedback scores only the caller\'s own chat turns', () => {
  it('another org\'s trace id is not scored, and answers as a missing one would', async () => {
    const before = scored.length
    const res = await feedback(orgB, mallory, { sessionId: 'anything', traceId: 't-alice-1' })
    expect(res.json()).toEqual({ recorded: false, reason: 'trace_not_found' })
    expect(scored.length).toBe(before)
    const missing = await feedback(orgB, mallory, { sessionId: 'anything', traceId: 't-nope' })
    expect(missing.json()).toEqual(res.json())
  })

  it('a colleague\'s trace or session is not scored either', async () => {
    const before = scored.length
    expect((await feedback(orgA, alice, { sessionId: 'thread-2', traceId: 't-bob-1' })).json().recorded).toBe(false)
    expect((await feedback(orgA, alice, { sessionId: 'thread-2' })).json()).toEqual({ recorded: false, reason: 'trace_not_found' })
    expect(scored.length).toBe(before)
  })

  it('a session id shared with another user resolves to the caller\'s own turn', async () => {
    const res = await feedback(orgA, alice, { sessionId: 'thread-1' })
    expect(res.json().recorded).toBe(true)
    expect(scored.at(-1)).toBe('t-alice-1')   // not Mallory's newer turn in the "same" session
  })

  it('the caller\'s own trace is scored', async () => {
    const res = await feedback(orgA, alice, { sessionId: 'thread-1', traceId: 't-alice-1' })
    expect(res.json().recorded).toBe(true)
    expect(scored.at(-1)).toBe('t-alice-1')
  })

  it('a named trace is looked up among the caller\'s own, never fetched by id', async () => {
    lookups.length = 0
    await feedback(orgB, mallory, { sessionId: 'thread-1', traceId: 't-alice-1' })
    expect(lookups.every(u => u.startsWith('/api/public/traces?') && new URL(u, LANGFUSE).searchParams.get('userId') === mallory)).toBe(true)
    expect(lookups.length).toBe(1)
  })
})
