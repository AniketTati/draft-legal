/**
 * X29 follow-up — an open collaboration connection was re-checked only when
 * it sent a message, while Hocuspocus sends every document update to every
 * connection: a silent one kept receiving edits after its token expired.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { watchCollabConnection, type CollabContext } from './collab-server.js'

afterEach(() => { vi.useRealTimers() })

function context(expiresInSeconds: number): CollabContext {
  const now = Date.now()
  return { user: { id: 'u', orgId: 'o' }, roles: [], contractId: 'c', exp: Math.floor(now / 1000) + expiresInSeconds, readOnly: true, checkedAt: now }
}

describe('watchCollabConnection', () => {
  it('closes a connection that sends nothing, once its token expires', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const stop = watchCollabConnection(context(20), close, 15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(close).toHaveBeenCalledWith('Session expired')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(close).toHaveBeenCalledTimes(1)   // closed once, then no longer watched
    stop()
  })

  it('stops when the connection goes away', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    watchCollabConnection(context(20), close, 15_000)()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(close).not.toHaveBeenCalled()
  })
})
