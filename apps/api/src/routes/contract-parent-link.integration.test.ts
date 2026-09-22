/**
 * X20 — POST /contracts/upload stored the form's parentContractId unchecked,
 * so an upload could name any contract — another org's too — as its parent,
 * and that parent's family view (not org-filtered) then listed it. The parent
 * must now be a live contract the caller could open (its org; owned, for own
 * scope), the family view filters by org, and a repair migration clears links
 * made before.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: { send: async () => ({}) },
}))
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueParseDocument: vi.fn(),
}))
vi.mock('../lib/elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/elasticsearch.js')>()),
  indexContract: vi.fn(async () => {}),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let orgA: string, orgB: string, userA: string, repA2: string, userB: string, parentA: string, parentA2: string

function upload(fields: Record<string, string>, jsonFields: Record<string, unknown> = {}) {
  const boundary = `----it${randomBytes(8).toString('hex')}`
  const parts = [
    ...Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    ...Object.entries(jsonFields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(v)}\r\n`),
  ]
  const payload = Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="amendment.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('Amendment No. 1 to the agreement.'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

async function post(org: string, roles: string[], user: string, fields: Record<string, string>, jsonFields: Record<string, unknown> = {}) {
  const { payload, headers } = upload(fields, jsonFields)
  return app.inject({ method: 'POST', url: '/api/v1/contracts/upload', headers: { ...auth(org, roles, user), ...headers }, payload })
}

beforeAll(async () => {
  app = await getApp()
  orgA = await makeOrg('Parent Link Org A')
  orgB = await makeOrg('Parent Link Org B')
  userA = await makeUser(orgA)
  repA2 = await makeUser(orgA)
  userB = await makeUser(orgB)
  parentA = await makeContract(orgA, userA, { title: 'Org A Master Agreement' })
  parentA2 = await makeContract(orgA, repA2, { title: 'Another rep\'s agreement' })
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: { in: [orgA, orgB] } }, data: { parentContractId: null, currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('an upload\'s parent must be a contract the caller could open', () => {
  it('another org\'s contract is refused, and nothing is stored', async () => {
    const before = await prisma.contract.count({ where: { orgId: orgB } })
    const res = await post(orgB, ['LEGAL_OPS'], userB, { parentContractId: parentA, title: 'Sneaky child' })
    expect(res.statusCode).toBe(404)
    expect(await prisma.contract.count({ where: { orgId: orgB } })).toBe(before)
  })

  it('an own-scope caller can\'t hang an upload off another rep\'s contract', async () => {
    const res = await post(orgA, ['SALES_REP'], userA, { parentContractId: parentA2, title: 'Rep child' })
    expect(res.statusCode).toBe(404)
  })

  it('a parent sent as a JSON-typed part can\'t act as a filter', async () => {
    const before = await prisma.contract.count({ where: { orgId: orgA } })
    const res = await post(orgA, ['LEGAL_OPS'], userA, { title: 'JSON parent' }, { parentContractId: { not: 'x' } })
    expect(res.statusCode).toBe(201)   // the non-text field is ignored…
    const created = await prisma.contract.findFirstOrThrow({ where: { orgId: orgA, title: 'JSON parent' } })
    expect(created.parentContractId).toBeNull()   // …and links nothing
    expect(await prisma.contract.count({ where: { orgId: orgA } })).toBe(before + 1)
  })

  it('an own-scope caller links to a contract it owns', async () => {
    const res = await post(orgA, ['SALES_REP'], userA, { parentContractId: parentA, title: 'Own child' })
    expect(res.statusCode).toBe(201)
  })

  it('a same-org parent still links', async () => {
    const res = await post(orgA, ['LEGAL_OPS'], userA, { parentContractId: parentA, title: 'Amendment 1', relationshipType: 'amendment' })
    expect(res.statusCode).toBe(201)
    const child = await prisma.contract.findFirstOrThrow({ where: { orgId: orgA, title: 'Amendment 1' } })
    expect(child.parentContractId).toBe(parentA)
  })
})

describe('the family view', () => {
  it('doesn\'t show a deleted parent', async () => {
    const gone = await makeContract(orgA, userA, { title: 'DELETED PARENT' })
    const child = await makeContract(orgA, userA, { title: 'Child of deleted' })
    await prisma.contract.update({ where: { id: child }, data: { parentContractId: gone } })
    await prisma.contract.update({ where: { id: gone }, data: { deletedAt: new Date() } })
    const fam = await app.inject({ method: 'GET', url: `/api/v1/contracts/${child}/family`, headers: auth(orgA, ['LEGAL_OPS'], userA) })
    expect(fam.json().parent).toBeNull()
  })
})

describe('links made before the fix', () => {
  it('the family view never lists another org\'s contract, as child or as parent', async () => {
    const intruder = await makeContract(orgB, userB, { title: 'ORG B CONFIDENTIAL' })
    await prisma.contract.update({ where: { id: intruder }, data: { parentContractId: parentA } })
    const fam = await app.inject({ method: 'GET', url: `/api/v1/contracts/${parentA}/family`, headers: auth(orgA, ['LEGAL_OPS'], userA) })
    expect(fam.statusCode).toBe(200)
    expect(fam.body).not.toContain('ORG B CONFIDENTIAL')

    const foreignParent = await makeContract(orgB, userB, { title: 'ORG B PARENT' })
    const adopted = await makeContract(orgA, userA, { title: 'Adopted by B' })
    await prisma.contract.update({ where: { id: adopted }, data: { parentContractId: foreignParent } })
    const fam2 = await app.inject({ method: 'GET', url: `/api/v1/contracts/${adopted}/family`, headers: auth(orgA, ['LEGAL_OPS'], userA) })
    expect(fam2.json().parent).toBeNull()

    // …and the repair migration clears the link itself.
    const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', '20260923020000_unlink_cross_org_parents', 'migration.sql'), 'utf8')
    await prisma.$executeRawUnsafe(sql.replace(/^\s*--.*$/gm, '').trim().replace(/;$/, ''))
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: intruder } })).parentContractId).toBeNull()
    expect((await prisma.contract.findFirstOrThrow({ where: { orgId: orgA, title: 'Amendment 1' } })).parentContractId).toBe(parentA)
  })
})
