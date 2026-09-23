/**
 * C1 — API keys: a key carries the scopes it was created with, is honoured
 * where they allow and refused where they don't, and a scope-less key (which
 * can call nothing) cannot be created at all. The admin dialog used to send
 * `{ name }` only, producing exactly that dead key.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { hashApiKey } from '../middleware/auth.js'

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

describe('X44 — routes that need only a signed-in user', () => {
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers })
  const ORG_DATA = ['/api/v1/users', '/api/v1/team/workload', '/api/v1/organization', '/api/v1/organization/industry-packs', '/api/v1/admin/users/roles', '/api/v1/skills', '/api/v1/dashboard']
  const PERSONAL = ['/api/v1/users/me', '/api/v1/approvals/notifications', '/api/v1/agent/threads']

  it('the org\'s shared data needs a key with the admin scope; members and the agents service still read it', async () => {
    const readerRes = await createKey({ name: 'Reader key', scopes: ['contracts:read'] })
    const fullRes = await createKey({ name: 'Full key', scopes: ['admin'] })
    expect(readerRes.statusCode).toBe(201)
    expect(fullRes.statusCode).toBe(201)
    const reader = bearer(readerRes.json().key), full = bearer(fullRes.json().key)
    // A legacy key stored with no scopes (creation has refused those since C1).
    const legacyKey = `clm_${randomBytes(24).toString('hex')}`
    await prisma.apiKey.create({ data: { orgId: org, name: 'Legacy', keyHash: hashApiKey(legacyKey), prefix: legacyKey.slice(0, 8), scopes: [], createdById: admin } })
    const legacy = bearer(legacyKey)
    const viewer = await makeUser(org)

    for (const url of ORG_DATA) {
      expect((await get(url, reader)).statusCode, url).toBe(403)
      expect((await get(url, legacy)).statusCode, url).toBe(403)
      expect((await get(url, full)).statusCode, url).toBe(200)
      expect((await get(url, auth(org, ['ADMIN'], admin))).statusCode, url).toBe(200)
      expect((await get(url, auth(org, ['VIEWER'], viewer))).statusCode, url).toBe(200)
    }
    // The model list is guarded the same way; past the guard it asks the
    // agents service, which the integration stack doesn't run.
    expect((await get('/api/v1/agent/models', reader)).statusCode).toBe(403)
    expect((await get('/api/v1/agent/models', full)).statusCode).toBe(502)
    expect((await get('/api/v1/agent/models', auth(org, ['VIEWER'], viewer))).statusCode).toBe(502)

    const internal = { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '', 'x-internal-service': 'agents', 'x-org-id': org }
    expect((await get('/api/v1/organization', internal)).statusCode).toBe(200)
    // The key's own endpoints still work.
    expect((await get('/api/v1/contracts', reader)).statusCode).toBe(200)
  })

  it('a person\'s own things refuse every key, the admin scope included', async () => {
    const fullRes = await createKey({ name: 'Full key (personal)', scopes: ['admin'] })
    expect(fullRes.statusCode).toBe(201)
    const full = bearer(fullRes.json().key)
    for (const url of PERSONAL) {
      expect((await get(url, full)).statusCode, url).toBe(403)
      expect((await get(url, auth(org, ['ADMIN'], admin))).statusCode, url).toBe(200)
    }
    // Was a 500: there is no user `apikey:<id>` to update.
    const patch = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: full, payload: { name: 'Key' } })
    expect(patch.statusCode).toBe(403)
    const thread = await app.inject({ method: 'POST', url: '/api/v1/agent/threads', headers: full, payload: { title: 'Key thread' } })
    expect(thread.statusCode).toBe(403)
  })

  it('agent chat doesn\'t offer the member search to a key without the admin scope', async () => {
    const reader = bearer((await createKey({ name: 'Chat reader', scopes: ['contracts:read'] })).json().key)
    const full = bearer((await createKey({ name: 'Chat admin', scopes: ['admin'] })).json().key)
    const forwarded: Array<{ denied_tools?: string[] | null }> = []
    const realFetch = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/agent/chat')) {
        forwarded.push(JSON.parse(String(init?.body)))
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      return realFetch(input as never, init)
    })
    try {
      for (const headers of [reader, full, auth(org, ['ADMIN'], admin)]) {
        const res = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers, payload: { message: 'who is on the team?', agentMode: true } })
        expect(res.statusCode).toBe(200)
      }
    } finally {
      spy.mockRestore()
    }
    const [asReader, asFull, asUser] = forwarded.slice(-3).map(f => f.denied_tools ?? [])
    expect(asReader).toContain('user_search')
    expect(asFull).not.toContain('user_search')
    expect(asUser).not.toContain('user_search')
  })
})
