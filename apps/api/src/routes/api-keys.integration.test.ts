/**
 * C1 — API keys: a key carries the scopes it was created with, is honoured
 * where they allow and refused where they don't, and a scope-less key (which
 * can call nothing) cannot be created at all. The admin dialog used to send
 * `{ name }` only, producing exactly that dead key.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, grantRole, prisma, type TestApp } from '../test-support/helpers.js'
import { hashApiKey } from '../middleware/auth.js'

let app: TestApp
let org: string, otherOrg: string, admin: string, contract: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('API Key Org')
  otherOrg = await makeOrg('API Key Other Org')
  admin = await makeUser(org)
  await grantRole(org, admin, 'ADMIN')   // X46 — a key works while its maker can make keys
  contract = await makeContract(org, admin, { title: 'Keyed Contract' })
})

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { orgId: { in: [org, otherOrg] } } })
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
    await grantRole(org, leaver, 'ADMIN')
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

describe('X46 — keys can\'t make keys, and no key outlives the user behind it', () => {
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
  const status = async (key: string) => (await app.inject({ method: 'GET', url: '/api/v1/contracts', headers: bearer(key) })).statusCode
  /** A key row written directly, as one made through another key before X46 would be. */
  const stored = async (createdById: string, over: { revoked?: boolean; expired?: boolean; orgId?: string } = {}) => {
    const key = `clm_${randomBytes(24).toString('hex')}`
    const row = await prisma.apiKey.create({
      data: {
        orgId: over.orgId ?? org, name: 'Minted', keyHash: hashApiKey(key), prefix: key.slice(0, 8), scopes: ['admin'], createdById,
        revokedAt: over.revoked ? new Date() : null, expiresAt: over.expired ? new Date(Date.now() - 60_000) : null,
      },
    })
    return { id: row.id, key }
  }
  const revokedAt = async (id: string) => (await prisma.apiKey.findUniqueOrThrow({ where: { id } })).revokedAt
  const anAdmin = async (orgId = org) => { const u = await makeUser(orgId); await grantRole(orgId, u, 'ADMIN'); return u }

  it('an admin key can\'t manage keys or give anyone access; it keeps its other admin rights', async () => {
    const fullRes = await createKey({ name: 'Minting admin', scopes: ['admin'] })
    expect(fullRes.statusCode).toBe(201)
    const headers = bearer(fullRes.json().key)
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) })
    expect((await call('POST', '/api/v1/admin/integrations/api-keys', { name: 'Minted', scopes: ['admin'] })).statusCode).toBe(403)
    expect((await call('GET', '/api/v1/admin/integrations/api-keys')).statusCode).toBe(403)
    expect((await call('GET', '/api/v1/admin/integrations/api-key-scopes')).statusCode).toBe(403)
    expect((await call('DELETE', `/api/v1/admin/integrations/api-keys/${fullRes.json().id}`)).statusCode).toBe(403)
    // Nor give a person access that would outlive the key: a new account, a
    // role, a reactivation.
    const member = await makeUser(org)
    expect((await call('POST', '/api/v1/admin/users/invite', { email: `x46-${randomBytes(4).toString('hex')}@test.local`, name: 'Invited', roles: ['ADMIN'] })).statusCode).toBe(403)
    expect((await call('POST', '/api/v1/admin/users/bulk-import', [])).statusCode).toBe(403)
    expect((await call('PATCH', `/api/v1/admin/users/${member}/roles`, { roles: ['ADMIN'] })).statusCode).toBe(403)
    expect((await call('POST', `/api/v1/admin/users/${member}/reactivate`)).statusCode).toBe(403)
    expect((await call('GET', '/api/v1/admin/integrations/webhooks')).statusCode).toBe(200)
  })

  it('a key works only while the user behind it could still make it', async () => {
    const earlyLeaver = await anAdmin(), root = await anAdmin(), demotee = await anAdmin()
    const own = await stored(root)
    const minted = await stored(`apikey:${own.id}`)
    const leftBefore = await stored(earlyLeaver)
    const demoted = await stored(demotee)
    for (const k of [minted, leftBefore, demoted]) expect(await status(k.key)).toBe(200)

    // Deactivated before X43, so their keys were never revoked; and a maker
    // moved to a role that can't make keys.
    await prisma.user.updateMany({ where: { id: { in: [earlyLeaver, root] } }, data: { status: 'DEACTIVATED' } })
    await prisma.userRole.deleteMany({ where: { userId: demotee } })
    await grantRole(org, demotee, 'SALES_REP')
    for (const k of [leftBefore, own, minted, demoted]) expect(await status(k.key)).toBe(401)
    const refused = await app.inject({ method: 'GET', url: '/api/v1/contracts', headers: bearer(demoted.key) })
    expect(refused.json().detail).toBe('API key invalid or revoked')   // no more than for a revoked key
  })

  it('a key made through a key dies with that key, even while their user is active', async () => {
    const root = await anAdmin()
    const parent = await stored(root)
    const child = await stored(`apikey:${parent.id}`)
    expect(await status(child.key)).toBe(200)
    const revoke = await app.inject({ method: 'DELETE', url: `/api/v1/admin/integrations/api-keys/${parent.id}`, headers: auth(org, ['ADMIN'], admin) })
    expect(revoke.statusCode).toBe(204)
    expect(await status(child.key)).toBe(401)

    const expiredParent = await stored(root, { expired: true })
    expect(await status((await stored(`apikey:${expiredParent.id}`)).key)).toBe(401)
    // A link into another org leads nowhere.
    const foreign = await stored(await anAdmin(otherOrg), { orgId: otherOrg })
    expect(await status((await stored(`apikey:${foreign.id}`)).key)).toBe(401)
    // Chains made before X46 are followed through five keys, no further.
    let link = await stored(root)
    for (let i = 0; i < 5; i++) link = await stored(`apikey:${link.id}`)
    expect(await status(link.key)).toBe(200)
    expect(await status((await stored(`apikey:${link.id}`)).key)).toBe(401)
  })

  it('only someone who could make a key now can create one', async () => {
    const gone = await anAdmin()
    await prisma.user.update({ where: { id: gone }, data: { status: 'DEACTIVATED' } })
    const create = (headers: Record<string, string>) => app.inject({
      method: 'POST', url: '/api/v1/admin/integrations/api-keys', headers, payload: { name: 'Late key', scopes: ['contracts:read'] },
    })
    // A deactivated admin's access token is still valid for its lifetime.
    expect((await create(auth(org, ['ADMIN'], gone))).statusCode).toBe(403)
    // The agents service is no user.
    const internal = { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '', 'x-internal-service': 'agents', 'x-org-id': org }
    expect((await create(internal)).statusCode).toBe(403)
    expect((await create(auth(org, ['ADMIN'], admin))).statusCode).toBe(201)
  })

  it('deactivating a user revokes the keys made through theirs too, for good', async () => {
    const leaver = await anAdmin()
    const own = await app.inject({
      method: 'POST', url: '/api/v1/admin/integrations/api-keys',
      headers: auth(org, ['ADMIN'], leaver), payload: { name: 'Leaver key', scopes: ['admin'] },
    })
    expect(own.statusCode).toBe(201)
    // A child and a grandchild of the leaver's key, and a child of one of
    // theirs that was already revoked.
    const child = await stored(`apikey:${own.json().id}`)
    const grandchild = await stored(`apikey:${child.id}`)
    const revokedEarlier = await stored(leaver, { revoked: true })
    const childOfRevoked = await stored(`apikey:${revokedEarlier.id}`)
    const chain = [own.json().id, child.id, grandchild.id, childOfRevoked.id]

    const res = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${leaver}/deactivate`, headers: auth(org, ['ADMIN'], admin) })
    expect(res.statusCode).toBe(200)
    for (const id of chain) expect(await revokedAt(id)).not.toBeNull()
    const audit = await prisma.auditEvent.findFirst({ where: { orgId: org, action: 'USER_DEACTIVATED', resourceId: leaver } })
    expect((audit?.metadata as { apiKeysRevoked?: number } | undefined)?.apiKeysRevoked).toBe(4)

    // Reactivating them doesn't bring the keys back: they are revoked, not
    // just refused while their maker is away.
    const back = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${leaver}/reactivate`, headers: auth(org, ['ADMIN'], admin) })
    expect(back.statusCode).toBe(200)
    for (const id of chain) expect(await revokedAt(id)).not.toBeNull()
    for (const k of [child, grandchild]) expect(await status(k.key)).toBe(401)
  })

  it('the repair migration revokes the keys orphaned before this change', async () => {
    const gone = await anAdmin(), deleted = await anAdmin(), healthy = await anAdmin()
    const goneKey = await stored(gone)
    const goneChild = await stored(`apikey:${goneKey.id}`)
    const deletedKey = await stored(deleted)
    const nobodysKey = await stored('no-such-user')
    const revokedParent = await stored(healthy, { revoked: true })
    const childOfRevoked = await stored(`apikey:${revokedParent.id}`)
    const expiredParent = await stored(healthy, { expired: true })
    const childOfExpired = await stored(`apikey:${expiredParent.id}`)
    const healthyKey = await stored(healthy)
    const healthyChild = await stored(`apikey:${healthyKey.id}`)
    await prisma.user.update({ where: { id: gone }, data: { status: 'DEACTIVATED' } })
    await prisma.user.update({ where: { id: deleted }, data: { deletedAt: new Date() } })

    const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', '20260923050000_revoke_orphaned_api_keys', 'migration.sql'), 'utf8')
    await prisma.$executeRawUnsafe(sql.replace(/^\s*--.*$/gm, '').trim().replace(/;$/, ''))

    for (const k of [goneKey, goneChild, deletedKey, nobodysKey, childOfRevoked, childOfExpired]) expect(await revokedAt(k.id)).not.toBeNull()
    for (const k of [healthyKey, healthyChild]) expect(await revokedAt(k.id)).toBeNull()
    expect(await status(healthyChild.key)).toBe(200)
  })
})
