/**
 * X25 — matter links weren't checked against the org. A user in org B could
 * PATCH their own contract into org A's matter (org A's matter view then
 * listed it, and its count went up), and a matter could be pointed at another
 * org's counterparty or user, whose name, website, email and avatar the
 * matter view then returned. Ids must now belong to the org, the matter views
 * filter by org, and a repair migration clears links stored before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let orgA: string, orgB: string, userA: string, userB: string
let matterA: string, matterB: string, cpA: string, cpB: string, contractA: string, contractB: string

beforeAll(async () => {
  app = await getApp()
  orgA = await makeOrg('Matter Links Org A')
  orgB = await makeOrg('Matter Links Org B')
  userA = await makeUser(orgA)
  userB = await makeUser(orgB)
  cpA = (await prisma.counterparty.create({ data: { orgId: orgA, name: 'ORG A COUNTERPARTY', website: 'https://a.example' } })).id
  cpB = (await prisma.counterparty.create({ data: { orgId: orgB, name: 'Org B Counterparty' } })).id
  matterA = (await prisma.matter.create({ data: { orgId: orgA, name: 'Org A matter', ownerId: userA, createdById: userA } })).id
  matterB = (await prisma.matter.create({ data: { orgId: orgB, name: 'Org B matter', ownerId: userB, createdById: userB } })).id
  contractA = await makeContract(orgA, userA, { title: 'Org A contract' })
  contractB = await makeContract(orgB, userB, { title: 'ORG B CONTRACT' })
  await prisma.contract.update({ where: { id: contractA }, data: { matterId: matterA } })
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: { in: [orgA, orgB] } }, data: { matterId: null } })
  await prisma.matter.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await prisma.counterparty.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await cleanupAll()
  await closeApp()
})

const as = (org: string, user: string) => auth(org, ['LEGAL_OPS'], user)

describe('matter links must stay inside the org', () => {
  it('a contract can\'t be put into another org\'s matter', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contractB}`, headers: as(orgB, userB), payload: { matterId: matterA } })
    expect(res.statusCode).toBe(404)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractB } })).matterId).toBeNull()
  })

  it('a matter can\'t point at another org\'s counterparty or user', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/v1/matters', headers: as(orgB, userB), payload: { name: 'Sneaky', counterpartyId: cpA } })
    expect(create.statusCode).toBe(404)
    for (const payload of [{ counterpartyId: cpA }, { ownerId: userA }]) {
      const res = await app.inject({ method: 'PATCH', url: `/api/v1/matters/${matterB}`, headers: as(orgB, userB), payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(404)
    }
  })

  it('same-org links still work', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contractB}`, headers: as(orgB, userB), payload: { matterId: matterB } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/matters/${matterB}`, headers: as(orgB, userB), payload: { counterpartyId: cpB } })).statusCode).toBe(200)
    await prisma.contract.update({ where: { id: contractB }, data: { matterId: null } })
    await prisma.matter.update({ where: { id: matterB }, data: { counterpartyId: null } })
  })
})

describe('links stored before the fix', () => {
  it('the matter views don\'t show another org\'s rows, and the migration clears them', async () => {
    // As an attacker could have stored them before.
    await prisma.contract.update({ where: { id: contractB }, data: { matterId: matterA } })
    await prisma.matter.update({ where: { id: matterB }, data: { counterpartyId: cpA, ownerId: userA } })

    const viewA = await app.inject({ method: 'GET', url: `/api/v1/matters/${matterA}`, headers: as(orgA, userA) })
    expect(viewA.body).not.toContain('ORG B CONTRACT')
    const listA = (await app.inject({ method: 'GET', url: '/api/v1/matters', headers: as(orgA, userA) })).json().items
    expect(listA.find((m: { id: string }) => m.id === matterA).contractCount).toBe(1)

    const viewB = (await app.inject({ method: 'GET', url: `/api/v1/matters/${matterB}`, headers: as(orgB, userB) })).json()
    expect(viewB.counterparty).toBeNull()
    expect(viewB.owner).toBeNull()
    expect(JSON.stringify(viewB)).not.toContain('ORG A COUNTERPARTY')

    const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', '20260923030000_repair_cross_org_matter_links', 'migration.sql'), 'utf8')
    for (const stmt of sql.split(/;\s*$/m).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(stmt)
    }
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractB } })).matterId).toBeNull()
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractA } })).matterId).toBe(matterA)
    const repaired = await prisma.matter.findUniqueOrThrow({ where: { id: matterB } })
    expect(repaired.counterpartyId).toBeNull()
    expect(repaired.ownerId).toBe(userB)
  })
})
