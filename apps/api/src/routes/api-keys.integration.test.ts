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

describe('X43 — a key\'s lifecycle', () => {
  it('creating and revoking a key are audited, and the list names who made it', async () => {
    const res = await createKey({ name: 'Audited key', scopes: ['contracts:read'] })
    expect(res.statusCode).toBe(201)
    const id = res.json().id as string
    expect(await prisma.auditEvent.count({ where: { orgId: org, action: 'API_KEY_CREATED', resourceId: id } })).toBe(1)
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/integrations/api-keys', headers: auth(org, ['ADMIN'], admin) })
    expect(list.json().data.find((k: { id: string }) => k.id === id).createdBy.id).toBe(admin)
    const revoked = await app.inject({ method: 'DELETE', url: `/api/v1/admin/integrations/api-keys/${id}`, headers: auth(org, ['ADMIN'], admin) })
    expect(revoked.statusCode).toBe(204)
    expect(await prisma.auditEvent.count({ where: { orgId: org, action: 'API_KEY_REVOKED', resourceId: id } })).toBe(1)
  })

  it('deactivating a user revokes the keys they made', async () => {
    const leaver = await makeUser(org)
    const made = await app.inject({
      method: 'POST', url: '/api/v1/admin/integrations/api-keys',
      headers: auth(org, ['ADMIN'], leaver), payload: { name: 'Leaver key', scopes: ['contracts:read'] },
    })
    expect(made.statusCode).toBe(201)
    const use = () => app.inject({ method: 'GET', url: '/api/v1/contracts', headers: { authorization: `Bearer ${made.json().key}` } })
    expect((await use()).statusCode).toBe(200)
    const off = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${leaver}/deactivate`, headers: auth(org, ['ADMIN'], admin) })
    expect(off.statusCode).toBe(200)
    expect((await use()).statusCode).toBe(401)
  })
})
