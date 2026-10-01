/**
 * docs/41 Part 20 — SCIM 2.0 provisioning against a real database: an
 * identity provider creates a user, finds it by filter, deactivates it (PATCH
 * or DELETE), and groups give roles. An org's token reaches only its own
 * users; a revoked token, another org's token or a session token gets nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getApp, closeApp, makeOrg, makeUser, grantRole, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let orgA: string, orgB: string, adminA: string, adminB: string
let tokenA: string, tokenB: string

const scim = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' })
const email = () => `scim-${randomUUID().slice(0, 8)}@acme-scim.example`

async function mintToken(orgId: string, adminId: string): Promise<{ id: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/admin/sso/scim-tokens', headers: auth(orgId, ['ADMIN'], adminId), payload: { name: 'Okta' } })
  expect(res.statusCode).toBe(201)
  return res.json()
}

beforeAll(async () => {
  app = await getApp()
  orgA = await makeOrg('SCIM A')
  orgB = await makeOrg('SCIM B')
  adminA = await makeUser(orgA)
  adminB = await makeUser(orgB)
  await grantRole(orgA, adminA, 'ADMIN')
  await grantRole(orgB, adminB, 'ADMIN')
  tokenA = (await mintToken(orgA, adminA)).token
  tokenB = (await mintToken(orgB, adminB)).token
})

afterAll(async () => {
  for (const orgId of [orgA, orgB]) {
    await prisma.identityLink.deleteMany({ where: { orgId } })
    await prisma.scimGroup.deleteMany({ where: { orgId } })
    await prisma.scimToken.deleteMany({ where: { orgId } })
  }
  await cleanupAll()
  await closeApp()
})

describe('SCIM Users', () => {
  let userId: string
  const userName = email()

  it('creates a user, active, with its external id', async () => {
    const res = await app.inject({
      method: 'POST', url: '/scim/v2/Users', headers: scim(tokenA),
      payload: JSON.stringify({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName, externalId: '00u1okta', name: { givenName: 'Jane', familyName: 'Doe' }, emails: [{ value: userName, primary: true }], active: true }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.headers['content-type']).toContain('application/scim+json')
    const body = res.json()
    expect(body).toMatchObject({ userName, active: true, externalId: '00u1okta', name: { formatted: 'Jane Doe' } })
    userId = body.id
    const user = await prisma.user.findFirstOrThrow({ where: { id: userId } })
    expect(user).toMatchObject({ orgId: orgA, status: 'ACTIVE', email: userName })
  })

  it('refuses a duplicate userName', async () => {
    const res = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: scim(tokenA), payload: JSON.stringify({ userName }) })
    expect(res.statusCode).toBe(409)
    expect(res.json().scimType).toBe('uniqueness')
  })

  it('finds it with userName eq and externalId eq; anything else is an invalid filter', async () => {
    const byName = await app.inject({ method: 'GET', url: `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${userName.toUpperCase()}"`)}`, headers: scim(tokenA) })
    expect(byName.json()).toMatchObject({ totalResults: 1, Resources: [{ id: userId }] })
    const byExt = await app.inject({ method: 'GET', url: `/scim/v2/Users?filter=${encodeURIComponent('externalId eq "00u1okta"')}`, headers: scim(tokenA) })
    expect(byExt.json().Resources.map((r: { id: string }) => r.id)).toEqual([userId])
    const none = await app.inject({ method: 'GET', url: `/scim/v2/Users?filter=${encodeURIComponent('userName eq "nobody@x.example"')}`, headers: scim(tokenA) })
    expect(none.json().totalResults).toBe(0)
    const bad = await app.inject({ method: 'GET', url: `/scim/v2/Users?filter=${encodeURIComponent('userName co "j"')}`, headers: scim(tokenA) })
    expect(bad.statusCode).toBe(400)
  })

  it('PATCH active false deactivates (signed out, keys revoked); true brings them back', async () => {
    await prisma.user.update({ where: { id: userId }, data: { refreshToken: 'live-session' } })
    const key = await prisma.apiKey.create({ data: { orgId: orgA, createdById: userId, name: 'theirs', keyHash: randomUUID(), prefix: 'clm_live_x', scopes: ['contracts:read'] } })
    const off = await app.inject({
      method: 'PATCH', url: `/scim/v2/Users/${userId}`, headers: scim(tokenA),
      payload: JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', value: { active: 'False' } }] }),
    })
    expect(off.statusCode).toBe(200)
    expect(off.json().active).toBe(false)
    const user = await prisma.user.findFirstOrThrow({ where: { id: userId } })
    expect(user).toMatchObject({ status: 'DEACTIVATED', refreshToken: null })
    expect((await prisma.apiKey.findFirstOrThrow({ where: { id: key.id } })).revokedAt).not.toBeNull()

    const on = await app.inject({ method: 'PATCH', url: `/scim/v2/Users/${userId}`, headers: scim(tokenA), payload: JSON.stringify({ Operations: [{ op: 'replace', path: 'active', value: true }] }) })
    expect(on.json().active).toBe(true)
  })

  it('DELETE deactivates rather than erasing', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/scim/v2/Users/${userId}`, headers: scim(tokenA) })
    expect(res.statusCode).toBe(204)
    const user = await prisma.user.findFirstOrThrow({ where: { id: userId } })
    expect(user.status).toBe('DEACTIVATED')
    const read = await app.inject({ method: 'GET', url: `/scim/v2/Users/${userId}`, headers: scim(tokenA) })
    expect(read.json().active).toBe(false)
  })

  it('another org\'s token neither finds nor changes the user', async () => {
    const get = await app.inject({ method: 'GET', url: `/scim/v2/Users/${userId}`, headers: scim(tokenB) })
    expect(get.statusCode).toBe(404)
    const patch = await app.inject({ method: 'PATCH', url: `/scim/v2/Users/${userId}`, headers: scim(tokenB), payload: JSON.stringify({ Operations: [{ op: 'replace', path: 'active', value: true }] }) })
    expect(patch.statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: `/scim/v2/Users/${userId}`, headers: scim(tokenB) })
    expect(del.statusCode).toBe(404)
    const list = await app.inject({ method: 'GET', url: `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`, headers: scim(tokenB) })
    expect(list.json().totalResults).toBe(0)
    // Nor can it claim the same email in its own org: emails are unique across orgs.
    const create = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: scim(tokenB), payload: JSON.stringify({ userName }) })
    expect(create.statusCode).toBe(409)
  })

  it('refuses a session token, a missing token and a revoked one', async () => {
    expect((await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: auth(orgA, ['ADMIN'], adminA) })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/scim/v2/Users' })).statusCode).toBe(401)
    const { id, token } = await mintToken(orgA, adminA)
    expect((await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: scim(token) })).statusCode).toBe(200)
    // Another org's admin cannot revoke it.
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/sso/scim-tokens/${id}`, headers: auth(orgB, ['ADMIN'], adminB) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/sso/scim-tokens/${id}`, headers: auth(orgA, ['ADMIN'], adminA) })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: scim(token) })).statusCode).toBe(401)
  })

  it('never shows the token again after creating it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/sso/scim-tokens', headers: auth(orgA, ['ADMIN'], adminA) })
    expect(JSON.stringify(res.json())).not.toContain(tokenA)
    expect(res.json().data.map((t: { prefix: string }) => t.prefix)).toContain(tokenA.slice(0, 12))
  })
})

describe('SCIM Groups → roles', () => {
  it('gives members the group\'s role, and takes it back when they leave', async () => {
    const u = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: scim(tokenA), payload: JSON.stringify({ userName: email(), name: { formatted: 'Lee Counsel' } }) })
    const memberId = u.json().id
    const created = await app.inject({ method: 'POST', url: '/scim/v2/Groups', headers: scim(tokenA), payload: JSON.stringify({ displayName: 'Legal', members: [] }) })
    expect(created.statusCode).toBe(201)
    const groupId = created.json().id

    // The admin picks the role the group gives.
    const map = await app.inject({ method: 'PATCH', url: `/api/v1/admin/sso/scim-groups/${groupId}`, headers: auth(orgA, ['ADMIN'], adminA), payload: { roleName: 'LEGAL_COUNSEL' } })
    expect(map.statusCode).toBe(200)

    const add = await app.inject({ method: 'PATCH', url: `/scim/v2/Groups/${groupId}`, headers: scim(tokenA), payload: JSON.stringify({ Operations: [{ op: 'add', path: 'members', value: [{ value: memberId }] }] }) })
    expect(add.statusCode).toBe(200)
    expect(add.json().members.map((m: { value: string }) => m.value)).toEqual([memberId])
    const roles = async () => (await prisma.userRole.findMany({ where: { userId: memberId }, include: { role: true } })).map(r => r.role.name)
    expect(await roles()).toEqual(['LEGAL_COUNSEL'])

    const remove = await app.inject({ method: 'PATCH', url: `/scim/v2/Groups/${groupId}`, headers: scim(tokenA), payload: JSON.stringify({ Operations: [{ op: 'remove', path: `members[value eq "${memberId}"]` }] }) })
    expect(remove.json().members).toEqual([])
    expect(await roles()).toEqual([])

    // Another org's member id is dropped, never added.
    const otherUser = await makeUser(orgB)
    const cross = await app.inject({ method: 'PATCH', url: `/scim/v2/Groups/${groupId}`, headers: scim(tokenA), payload: JSON.stringify({ Operations: [{ op: 'add', path: 'members', value: [{ value: otherUser }] }] }) })
    expect(cross.json().members).toEqual([])
    expect(await prisma.userRole.count({ where: { userId: otherUser } })).toBe(0)

    // And the other org cannot see the group.
    expect((await app.inject({ method: 'GET', url: `/scim/v2/Groups/${groupId}`, headers: scim(tokenB) })).statusCode).toBe(404)
    const filtered = await app.inject({ method: 'GET', url: `/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "Legal"')}`, headers: scim(tokenA) })
    expect(filtered.json().totalResults).toBe(1)
  })
})
