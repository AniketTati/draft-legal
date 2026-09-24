/**
 * Y3 — the API client refuses a write the signed-in user has no permission
 * for, before sending it, with one message; every button that would have
 * sent it gets the same answer, gated or not. It judges only once the user's
 * roles are known, and leaves reads and the rest to the server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InternalAxiosRequestConfig } from 'axios'

const store = vi.hoisted(() => ({ accessToken: 'token', user: { roles: ['VIEWER'] } as { roles: string[] } | null }))
vi.mock('@/store/auth', () => ({ useAuthStore: { getState: () => store } }))

import { api } from './api'
import { rememberRoles } from './can-request'

const VIEWER = { name: 'VIEWER', permissions: [{ action: 'view', resource: 'contract', scope: 'org' }] }
const sent: string[] = []

beforeEach(() => {
  sent.length = 0
  store.user = { roles: ['VIEWER'] }
  rememberRoles([VIEWER])
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    sent.push(`${config.method?.toUpperCase()} ${config.url}`)
    return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config }
  }
})

describe('a write the user can\'t make', () => {
  it('is refused before it is sent, with one message', async () => {
    const refused = await api.post('/contracts/c1/share', { expiresInDays: 7 }).catch(e => e)
    expect(sent).toEqual([])
    expect(refused.response.status).toBe(403)
    expect(refused.response.data.detail).toBe('You don\'t have permission to configure contracts.')
    await expect(api.post('/contracts/c1/amendments', {})).rejects.toMatchObject({ response: { data: { detail: 'You don\'t have permission to create contracts.' } } })
    expect(sent).toEqual([])
  })

  it('is sent for a user who holds the permission, or is ADMIN', async () => {
    rememberRoles([{ name: 'VIEWER', permissions: [...VIEWER.permissions, { action: 'configure', resource: 'contract', scope: 'org' }] }])
    await api.post('/contracts/c1/share', {})
    store.user = { roles: ['ADMIN'] }
    await api.post('/contracts/c1/amendments', {})
    expect(sent).toEqual(['POST /contracts/c1/share', 'POST /contracts/c1/amendments'])
  })

  it('is left to the server when the roles aren\'t known yet, for a read, or where the route needs no permission', async () => {
    await api.get('/contracts/c1')
    await api.post('/auth/logout', {})
    rememberRoles(undefined)
    await api.post('/contracts/c1/share', {})
    expect(sent).toEqual(['GET /contracts/c1', 'POST /auth/logout', 'POST /contracts/c1/share'])
  })
})
