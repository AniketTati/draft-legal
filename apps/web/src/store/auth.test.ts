/**
 * X48 — the shared refresh: it has a time limit, and a refresh that finishes
 * after the session changed (a sign-out, another sign-in) doesn't write the
 * old session's tokens over the new one.
 */
import { describe, it, expect, vi } from 'vitest'

const post = vi.hoisted(() => {
  // The store persists to localStorage; give it an in-memory one.
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => { items.set(k, v) },
      removeItem: (k: string) => { items.delete(k) },
    },
  })
  return vi.fn()
})
vi.mock('axios', () => ({ default: { post } }))

import { useAuthStore } from './auth'

describe('auth store refresh', () => {
  it('refreshes once with a time limit, and keeps a session that changed meanwhile', async () => {
    let answer!: (v: { data: { accessToken: string; refreshToken: string } }) => void
    post.mockImplementation(() => new Promise(r => { answer = r }))
    useAuthStore.setState({ accessToken: 'old-access', refreshToken: 'first-session' })

    const refreshing = useAuthStore.getState().refresh()
    // Signed out and back in (as someone else) while the refresh was in flight.
    useAuthStore.setState({ accessToken: 'second-access', refreshToken: 'second-session' })
    answer({ data: { accessToken: 'first-access-2', refreshToken: 'first-session-2' } })
    await refreshing

    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/v1/auth/refresh', { refreshToken: 'first-session' }, { timeout: 15_000 })
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'second-access', refreshToken: 'second-session' })
  })

  it('stores the new tokens when the session is still the one it refreshed', async () => {
    post.mockResolvedValue({ data: { accessToken: 'access-2', refreshToken: 'session-2' } })
    useAuthStore.setState({ accessToken: 'access-1', refreshToken: 'session-1' })
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'access-2', refreshToken: 'session-2' })
  })
})
