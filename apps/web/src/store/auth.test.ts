/**
 * X48 — the shared refresh: it has a time limit, and a refresh that finishes
 * after the session changed (a sign-out, another sign-in) doesn't write the
 * old session's tokens over the new one. X50 — and a tab takes the same
 * user's tokens another tab already rotated rather than refreshing with its
 * stale copy, which the server refuses; another user's never.
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

const tokenSub = (token: string | null) => (token ? JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub : undefined)

describe('auth store refresh', () => {
  it('refreshes once with a time limit, and keeps a session that changed meanwhile', async () => {
    let answer!: (v: { data: { accessToken: string; refreshToken: string } }) => void
    post.mockImplementation(() => new Promise(r => { answer = r }))
    useAuthStore.setState({ accessToken: 'old-access', refreshToken: 'first-session' })

    const refreshing = useAuthStore.getState().refresh()
    await vi.waitFor(() => expect(post).toHaveBeenCalled())
    // Signed out and back in (as someone else) while the refresh was in flight.
    useAuthStore.setState({ accessToken: 'second-access', refreshToken: 'second-session' })
    answer({ data: { accessToken: 'first-access-2', refreshToken: 'first-session-2' } })
    await refreshing

    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/v1/auth/refresh', { refreshToken: 'first-session' }, { timeout: 15_000 })
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'second-access', refreshToken: 'second-session' })
  })

  // A JWT-shaped token carrying `claims` (the store reads claims to compare sessions, never verifies).
  const jwt = (claims: Record<string, unknown>) =>
    ['h', btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'), 's'].join('.')
  const inAnHour = Math.floor(Date.now() / 1000) + 3600
  const storeFromOtherTab = (accessToken: string, refreshToken: string) =>
    localStorage.setItem('clm-auth', JSON.stringify({ state: { accessToken, refreshToken, user: null, isAuthenticated: true }, version: 0 }))

  it('X50 — takes the same user\'s newer tokens another tab stored, without refreshing', async () => {
    post.mockReset()
    useAuthStore.setState({ accessToken: jwt({ sub: 'u1', exp: 1 }), refreshToken: jwt({ sub: 'u1', n: 1 }) })
    const otherTab = { accessToken: jwt({ sub: 'u1', exp: inAnHour }), refreshToken: jwt({ sub: 'u1', n: 2 }) }
    storeFromOtherTab(otherTab.accessToken, otherTab.refreshToken)
    await useAuthStore.getState().refresh()
    expect(post).not.toHaveBeenCalled()
    expect(useAuthStore.getState()).toMatchObject(otherTab)
  })

  it('X50 — never takes another user\'s session from storage', async () => {
    post.mockReset()
    post.mockResolvedValue({ data: { accessToken: jwt({ sub: 'u1', exp: inAnHour }), refreshToken: jwt({ sub: 'u1', n: 3 }) } })
    const held = jwt({ sub: 'u1', n: 1 })
    useAuthStore.setState({ accessToken: jwt({ sub: 'u1', exp: 1 }), refreshToken: held })
    storeFromOtherTab(jwt({ sub: 'u2', exp: inAnHour }), jwt({ sub: 'u2', n: 9 }))
    await useAuthStore.getState().refresh()
    expect(post).toHaveBeenCalledWith('/api/v1/auth/refresh', { refreshToken: held }, { timeout: 15_000 })
    expect(tokenSub(useAuthStore.getState().refreshToken)).toBe('u1')
  })

  it('X50 — refused because another tab won a simultaneous refresh: takes the winner\'s tokens', async () => {
    post.mockReset()
    const winner = { accessToken: jwt({ sub: 'u1', exp: inAnHour }), refreshToken: jwt({ sub: 'u1', n: 5 }) }
    post.mockImplementation(async () => {
      storeFromOtherTab(winner.accessToken, winner.refreshToken)   // the other tab's response lands first
      throw Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } })
    })
    useAuthStore.setState({ accessToken: jwt({ sub: 'u1', exp: 1 }), refreshToken: jwt({ sub: 'u1', n: 4 }) })
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState()).toMatchObject(winner)
  })

  it('X50 — a refused refresh with nothing newer in storage still fails, so the tab signs out as before', async () => {
    post.mockReset()
    post.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }))
    useAuthStore.setState({ accessToken: jwt({ sub: 'u1', exp: 1 }), refreshToken: jwt({ sub: 'u1', n: 6 }) })
    await expect(useAuthStore.getState().refresh()).rejects.toThrow('401')
  })

  it('stores the new tokens when the session is still the one it refreshed', async () => {
    post.mockReset()
    post.mockResolvedValue({ data: { accessToken: 'access-2', refreshToken: 'session-2' } })
    useAuthStore.setState({ accessToken: 'access-1', refreshToken: 'session-1' })
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'access-2', refreshToken: 'session-2' })
  })
})
