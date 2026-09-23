/**
 * X50 — the retry after a 401: a request is sent again only as the user who
 * made it (the session can change while a refresh runs), and a refresh that
 * failed signs out this tab without ending the session other tabs hold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'

const store = vi.hoisted(() => ({
  accessToken: null as string | null,
  refresh: vi.fn(),
  logout: vi.fn(),
}))
vi.mock('@/store/auth', () => ({ useAuthStore: { getState: () => store } }))

import { api } from './api'

const jwt = (claims: Record<string, unknown>) =>
  ['h', btoa(JSON.stringify(claims)).replace(/=+$/, ''), 's'].join('.')

/**
 * Answers 401 to `expired`, 200 to anything else; records the bearer of every
 * call. `meanwhile` runs while the refused request is in flight.
 */
function server(expired: string, meanwhile?: () => void) {
  const seen: string[] = []
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const bearer = String(config.headers.Authorization ?? '')
    seen.push(bearer)
    if (bearer === `Bearer ${expired}`) {
      meanwhile?.()
      const response = { data: {}, status: 401, statusText: 'Unauthorized', headers: {}, config }
      throw new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', config, null, response)
    }
    return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config }
  }
  return seen
}

beforeEach(() => {
  store.refresh.mockReset()
  store.logout.mockReset()
  vi.stubGlobal('window', { location: { pathname: '/contracts', search: '', href: '' } })
})

describe('api 401 retry', () => {
  it('sends the request again with the refreshed token, as the same user', async () => {
    const expired = jwt({ sub: 'u1', n: 1 })
    const renewed = jwt({ sub: 'u1', n: 2 })
    store.accessToken = expired
    store.refresh.mockImplementation(async () => { store.accessToken = renewed })
    const seen = server(expired)
    await expect(api.get('/contracts')).resolves.toMatchObject({ data: { ok: true } })
    expect(seen).toEqual([`Bearer ${expired}`, `Bearer ${renewed}`])
  })

  it('never sends one user\'s request again as another who signed in meanwhile', async () => {
    const expired = jwt({ sub: 'u1', n: 1 })
    store.accessToken = expired
    store.refresh.mockImplementation(async () => { store.accessToken = jwt({ sub: 'u2', n: 1 }) })
    const seen = server(expired)
    await expect(api.post('/contracts', { title: 'u1 draft' })).rejects.toMatchObject({ response: { status: 401 } })
    expect(seen).toEqual([`Bearer ${expired}`])
    expect(store.logout).not.toHaveBeenCalled()
  })

  it('X50 review — refuses without refreshing once another user is signed in', async () => {
    const expired = jwt({ sub: 'u1', n: 1 })
    store.accessToken = expired
    // Signed in as someone else before the 401 lands.
    const seen = server(expired, () => { store.accessToken = jwt({ sub: 'u2', n: 1 }) })
    await expect(api.get('/contracts')).rejects.toMatchObject({ response: { status: 401 } })
    expect(seen).toEqual([`Bearer ${expired}`])
    expect(store.refresh).not.toHaveBeenCalled()
    expect(store.logout).not.toHaveBeenCalled()
  })

  it('X50 review — retries without refreshing when a live token already replaced the one it was sent with', async () => {
    const expired = jwt({ sub: 'u1', n: 1 })
    const renewed = jwt({ sub: 'u1', n: 2, exp: Math.floor(Date.now() / 1000) + 900 })
    store.accessToken = expired
    // Another request's refresh finished first.
    const seen = server(expired, () => { store.accessToken = renewed })
    await expect(api.get('/contracts')).resolves.toMatchObject({ data: { ok: true } })
    expect(seen).toEqual([`Bearer ${expired}`, `Bearer ${renewed}`])
    expect(store.refresh).not.toHaveBeenCalled()
  })

  it('X50 review — a refresh that ends with no session rejects the request, without retrying or signing out', async () => {
    const expired = jwt({ sub: 'u1', n: 1 })
    store.accessToken = expired
    store.refresh.mockImplementation(async () => { store.accessToken = null })   // signed out meanwhile
    const seen = server(expired)
    await expect(api.get('/contracts')).rejects.toMatchObject({ response: { status: 401 } })
    expect(seen).toEqual([`Bearer ${expired}`])
    expect(store.logout).not.toHaveBeenCalled()
  })

  it('X50 review — a refresh that fails for a network reason fails only this request', async () => {
    const expired = jwt({ sub: 'u1', n: 1 })
    store.accessToken = expired
    store.refresh.mockRejectedValue(Object.assign(new Error('Network Error'), { isAxiosError: true }))
    server(expired)
    await expect(api.get('/contracts')).rejects.toMatchObject({ response: { status: 401 } })
    expect(store.logout).not.toHaveBeenCalled()
    expect(window.location.href).toBe('')
  })

  it('a refresh that failed signs out this tab only, and sends it to sign in', async () => {
    const expired = jwt({ sub: 'u1', n: 1 })
    store.accessToken = expired
    store.refresh.mockRejectedValue(new Error('Request failed with status code 401'))
    server(expired)
    await expect(api.get('/contracts')).rejects.toMatchObject({ response: { status: 401 } })
    expect(store.logout).toHaveBeenCalledWith({ local: true })
    expect(window.location.href).toBe('/login?next=%2Fcontracts')
  })
})
