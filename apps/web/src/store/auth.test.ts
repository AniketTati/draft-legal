/**
 * X48 — the shared refresh: it has a time limit, and a refresh that finishes
 * after the session changed (a sign-out, another sign-in) doesn't write the
 * old session's tokens over the new one. X50 — and a tab takes the same
 * user's newer tokens another tab stored rather than refreshing with its
 * stale copy, which the server refuses; never another user's, and never an
 * older pair. A refresh that failed signs out only its own tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  // Each case starts signed out with empty storage: storage now keeps the
  // newer of two same-user sessions, so one case's tokens would outlive it.
  beforeEach(() => {
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false })
    localStorage.removeItem('clm-auth')
  })

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
  const now = Math.floor(Date.now() / 1000)
  const inAnHour = now + 3600
  const access = (sub: string, exp: number) => jwt({ sub, exp })
  /** A refresh token issued `ago` seconds before now. */
  const refreshOf = (sub: string, ago: number) => jwt({ sub, iat: now - ago, type: 'refresh' })
  const storeFromOtherTab = (accessToken: string, refreshToken: string) =>
    localStorage.setItem('clm-auth', JSON.stringify({ state: { accessToken, refreshToken, user: null, isAuthenticated: true }, version: 0 }))
  const refused = () => Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } })
  const refreshedWith = (refreshToken: string) =>
    expect(post).toHaveBeenCalledWith('/api/v1/auth/refresh', { refreshToken }, { timeout: 15_000 })

  it('X50 — takes the same user\'s newer tokens another tab stored, without refreshing', async () => {
    post.mockReset()
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900) })
    const otherTab = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 10) }
    storeFromOtherTab(otherTab.accessToken, otherTab.refreshToken)
    await useAuthStore.getState().refresh()
    expect(post).not.toHaveBeenCalled()
    expect(useAuthStore.getState()).toMatchObject(otherTab)
  })

  it('X50 — never takes another user\'s session from storage', async () => {
    post.mockReset()
    post.mockResolvedValue({ data: { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) } })
    const held = refreshOf('u1', 900)
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: held })
    storeFromOtherTab(access('u2', inAnHour), refreshOf('u2', 10))
    await useAuthStore.getState().refresh()
    refreshedWith(held)
    expect(tokenSub(useAuthStore.getState().refreshToken)).toBe('u1')
  })

  it('X50 review — never takes an older pair that a tab with a stale copy wrote back', async () => {
    post.mockReset()
    const held = refreshOf('u1', 60)
    const fresh = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) }
    post.mockResolvedValue({ data: fresh })
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: held })
    storeFromOtherTab(access('u1', inAnHour), refreshOf('u1', 900))   // issued before ours, since rotated away
    await useAuthStore.getState().refresh()
    refreshedWith(held)
    expect(useAuthStore.getState()).toMatchObject(fresh)
  })

  it('X50 review — never takes a stored pair whose access token is another user\'s', async () => {
    post.mockReset()
    const held = refreshOf('u1', 900)
    post.mockResolvedValue({ data: { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) } })
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: held })
    storeFromOtherTab(access('u2', inAnHour), refreshOf('u1', 10))
    await useAuthStore.getState().refresh()
    refreshedWith(held)
    expect(tokenSub(useAuthStore.getState().accessToken)).toBe('u1')
  })

  it('X50 review — an adopted access token with under a minute left is refreshed, in case this clock is behind', async () => {
    post.mockReset()
    const adopted = refreshOf('u1', 10)
    const fresh = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) }
    post.mockResolvedValue({ data: fresh })
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900) })
    storeFromOtherTab(access('u1', now + 30), adopted)
    await useAuthStore.getState().refresh()
    refreshedWith(adopted)
    expect(useAuthStore.getState()).toMatchObject(fresh)
  })

  it('X50 — refused because another tab won a simultaneous refresh: takes the winner\'s tokens', async () => {
    post.mockReset()
    const winner = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) }
    post.mockImplementation(async () => {
      storeFromOtherTab(winner.accessToken, winner.refreshToken)   // the other tab's response lands first
      throw refused()
    })
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900) })
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState()).toMatchObject(winner)
  })

  it('X50 review — …or a moment after this tab was refused', async () => {
    post.mockReset()
    const winner = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) }
    post.mockImplementation(async () => {
      setTimeout(() => storeFromOtherTab(winner.accessToken, winner.refreshToken), 500)
      throw refused()
    })
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900) })
    await useAuthStore.getState().refresh()
    expect(post).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState()).toMatchObject(winner)
  })

  it('X50 review — a session that changes while it waits for the winner is left as it is', async () => {
    post.mockReset()
    const u2 = { accessToken: access('u2', inAnHour), refreshToken: refreshOf('u2', 0) }
    post.mockImplementation(async () => {
      setTimeout(() => {
        useAuthStore.setState(u2)   // signed out, and back in as someone else
        storeFromOtherTab(access('u1', inAnHour), refreshOf('u1', 0))   // then a u1 tab's refresh lands
      }, 300)
      throw refused()
    })
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900) })
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState()).toMatchObject(u2)
  })

  it('X50 review — …even in the last moment of its wait', async () => {
    post.mockReset()
    const winner = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) }
    post.mockImplementation(async () => {
      setTimeout(() => storeFromOtherTab(winner.accessToken, winner.refreshToken), 1_900)
      throw refused()
    })
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900) })
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState()).toMatchObject(winner)
  })

  it('X50 review — …but not an older pair written back while it waits, whose access token has expired', async () => {
    post.mockReset()
    post.mockImplementation(async () => {
      storeFromOtherTab(access('u1', now - 10), refreshOf('u1', 600))   // later than ours, and dead
      throw refused()
    })
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900) })
    await expect(useAuthStore.getState().refresh()).rejects.toThrow('401')
  })

  it('X50 review — a stale tab\'s state change keeps the same user\'s newer stored tokens', () => {
    const stale = { accessToken: access('u1', now + 60), refreshToken: refreshOf('u1', 900) }
    const newer = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) }
    useAuthStore.setState(stale)
    storeFromOtherTab(newer.accessToken, newer.refreshToken)
    useAuthStore.getState().setUser({ id: 'u1', name: 'Renamed' } as never)   // a profile save in the stale tab
    const stored = JSON.parse(localStorage.getItem('clm-auth')!).state
    expect(stored).toMatchObject({ ...newer, user: { name: 'Renamed' } })
    expect(useAuthStore.getState()).toMatchObject(stale)   // this tab takes them on its next refresh
  })

  it('X50 — a refused refresh with nothing newer in storage still fails, so the tab signs out as before', async () => {
    post.mockReset()
    post.mockRejectedValue(refused())
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900) })
    await expect(useAuthStore.getState().refresh()).rejects.toThrow('401')
  })

  it('X50 review — signing out after a failed refresh leaves the server session, which may be another tab\'s, alone', () => {
    post.mockReset()
    post.mockResolvedValue({})
    const session = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0), isAuthenticated: true }
    useAuthStore.setState(session)
    useAuthStore.getState().logout({ local: true })
    expect(post).not.toHaveBeenCalled()
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, isAuthenticated: false })
    useAuthStore.setState(session)
    useAuthStore.getState().logout()   // signing out on purpose still ends it, with the refresh token for when the access token has expired
    expect(post).toHaveBeenCalledWith('/api/v1/auth/logout', { refreshToken: session.refreshToken }, { headers: { Authorization: `Bearer ${session.accessToken}` } })
  })

  it('X50 review — a local sign-out keeps a session another tab stored meanwhile', () => {
    const mine = { accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900), isAuthenticated: true }
    const theirs = { accessToken: access('u1', inAnHour), refreshToken: refreshOf('u1', 0) }
    useAuthStore.setState(mine)
    storeFromOtherTab(theirs.accessToken, theirs.refreshToken)
    useAuthStore.getState().logout({ local: true })
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, isAuthenticated: false })
    expect(JSON.parse(localStorage.getItem('clm-auth')!).state).toMatchObject(theirs)
  })

  it('X50 review — …and clears storage that holds only its own', () => {
    useAuthStore.setState({ accessToken: access('u1', 1), refreshToken: refreshOf('u1', 900), isAuthenticated: true })
    useAuthStore.getState().logout({ local: true })
    expect(JSON.parse(localStorage.getItem('clm-auth')!).state).toMatchObject({ accessToken: null, refreshToken: null, isAuthenticated: false })
  })

  it('stores the new tokens when the session is still the one it refreshed', async () => {
    post.mockReset()
    post.mockResolvedValue({ data: { accessToken: 'access-2', refreshToken: 'session-2' } })
    useAuthStore.setState({ accessToken: 'access-1', refreshToken: 'session-1' })
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'access-2', refreshToken: 'session-2' })
  })
})
