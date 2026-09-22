/**
 * C1 — API keys: a key carries the scopes it was created with, is honoured
 * where they allow and refused where they don't, and a scope-less key (which
 * can call nothing) cannot be created at all. The admin dialog used to send
 * `{ name }` only, producing exactly that dead key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, admin: string, contract: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('API Key Org')
  admin = await makeUser(org)
  contract = await makeContract(org, admin, { title: 'Keyed Contract' })
})

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

async function createKey(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/v1/admin/integrations/api-keys',
    headers: auth(org, ['ADMIN'], admin), payload,
  })
}

describe('API key scopes', () => {
  it('lists the scope vocabulary for the create dialog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/integrations/api-key-scopes', headers: auth(org, ['ADMIN'], admin) })
    expect(res.statusCode).toBe(200)
    expect(res.json().scopes).toEqual(expect.arrayContaining(['contracts:read', 'contracts:write']))
  })

  it('refuses to create a key with no scopes', async () => {
    for (const payload of [{ name: 'dead key' }, { name: 'dead key', scopes: [] }]) {
      const res = await createKey(payload)
      expect(res.statusCode).toBe(400)
    }
  })

  it('a contracts:read key can read contracts but not edit them', async () => {
    const created = await createKey({ name: 'Reader', scopes: ['contracts:read'], expiresInDays: 30 })
    expect(created.statusCode).toBe(201)
    const { key, scopes, expiresAt } = created.json()
    expect(scopes).toEqual(['contracts:read'])
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000)

    const bearer = { authorization: `Bearer ${key}` }
    const read = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}`, headers: bearer })
    expect(read.statusCode).toBe(200)
    const write = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: bearer, payload: { title: 'nope' } })
    expect(write.statusCode).toBe(403)
  })

  it('never returns the full key again after creation', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/integrations/api-keys', headers: auth(org, ['ADMIN'], admin) })
    expect(list.statusCode).toBe(200)
    for (const k of list.json().data) expect(k).not.toHaveProperty('key')
  })
})
