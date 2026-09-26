/**
 * X45 — a contracts:write API key couldn't create a contract. Every create
 * path stored the caller's id as the owner, and for a key that is
 * `apikey:<id>`, which is no user: the insert failed on the owner's foreign
 * key with a 500, and a draft saved through the agent was dropped behind a
 * 200. Creating a matter, converting a request and completing an obligation
 * (directly or by reconciling its invoice) failed the same way, as did an
 * admin key setting the org's AI key, and a chat skill's invocation record was
 * dropped.
 *
 * A key now acts as the user who made it, while that user is an active member
 * who can still manage the org's API keys; what it creates names the key as
 * creator. A key's obligation completions name no user, and a key's split
 * leaves the children with the binder's owner. A key with no such user is
 * told so, before anything is stored. (Since X46 a key whose maker has left
 * doesn't authenticate at all.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: { send: vi.fn(async () => ({})) },
}))
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueParseDocument: vi.fn(),
  queueSplitBinder: vi.fn(),
  queueClassifyDocument: vi.fn(),
  queueClassifyRequest: vi.fn(),
  queueDraftContract: vi.fn(),
}))
vi.mock('../lib/elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/elasticsearch.js')>()),
  indexContract: vi.fn(async () => {}),
}))

import { s3 } from '../lib/storage.js'
import { queueSplitBinder } from '../lib/queue.js'
import { hashApiKey } from '../middleware/auth.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, grantRole, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, otherOrg: string, maker: string, leaver: string, demoted: string, colleague: string
let writer: Record<string, string>, writerId: string
let orphan: Record<string, string>, demotedKey: Record<string, string>
const draftCalls: string[] = []

function multipart(filename: string, contentType: string, body: string, fields: Record<string, string> = {}) {
  const boundary = `----it${randomBytes(8).toString('hex')}`
  const payload = Buffer.concat([
    Buffer.from(Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.from(body),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

async function keyFor(userId: string, name: string, scopes = ['contracts:write']) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/admin/integrations/api-keys',
    headers: auth(org, ['ADMIN'], userId), payload: { name, scopes },
  })
  expect(res.statusCode).toBe(201)
  return { headers: { authorization: `Bearer ${res.json().key}` }, id: res.json().id as string }
}

/** A key row written directly, as one made through another key before X46 would be. */
async function storedKey(createdById: string, scopes = ['contracts:write']) {
  const key = `clm_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({ data: { orgId: org, name: 'Stored', keyHash: hashApiKey(key), prefix: key.slice(0, 8), scopes, createdById } })
  return { authorization: `Bearer ${key}` }
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Key Create Org')
  otherOrg = await makeOrg('Key Create Other Org')
  maker = await makeUser(org)
  leaver = await makeUser(org)
  demoted = await makeUser(org)
  colleague = await makeUser(org)
  for (const u of [maker, leaver, demoted]) await grantRole(org, u, 'ADMIN')
  await grantRole(org, colleague, 'SALES_REP')
  ;({ headers: writer, id: writerId } = await keyFor(maker, 'Writer'))
  orphan = (await keyFor(leaver, 'Orphaned writer')).headers
  demotedKey = (await keyFor(demoted, 'Demoted writer')).headers
  // Deactivated before X43, which now revokes a leaver's keys (and since X46
  // such a key no longer authenticates).
  await prisma.user.update({ where: { id: leaver }, data: { status: 'DEACTIVATED' } })
  // Moved to an own-scope role while still active.
  await prisma.userRole.deleteMany({ where: { userId: demoted } })
  await grantRole(org, demoted, 'SALES_REP')

  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/agent/chat')) return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    if (url.endsWith('/draft')) {
      draftCalls.push(url)
      return new Response(JSON.stringify({ html: '<p>Mutual non-disclosure.</p>', contractType: 'NDA', usedTemplateName: 'NDA' }), { status: 200 })
    }
    return realFetch(input, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.contractRequest.deleteMany({ where: { orgId: org } })
  await prisma.invoice.deleteMany({ where: { orgId: org } })
  await prisma.obligation.deleteMany({ where: { orgId: org } })
  await prisma.matter.deleteMany({ where: { orgId: org } })
  await prisma.skillInvocation.deleteMany({ where: { orgId: org } })
  await prisma.skill.deleteMany({ where: { orgId: org } })
  await prisma.orgAiKey.deleteMany({ where: { orgId: org } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null, parentContractId: null, diligenceRoomId: null } })
  await prisma.diligenceRoom.deleteMany({ where: { orgId: org } })
  await prisma.apiKey.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

async function ownerOf(id: string) {
  return (await prisma.contract.findUniqueOrThrow({ where: { id }, select: { ownerId: true } })).ownerId
}
async function auditedBy(resourceId: string) {
  return (await prisma.auditEvent.findFirst({ where: { orgId: org, resourceId }, orderBy: { createdAt: 'desc' } }))?.userId
}

describe('a contracts:write key creates contracts owned by the user who made it', () => {
  it('POST /contracts — and the audit names the key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/contracts', headers: writer, payload: { title: 'Keyed NDA', type: 'NDA' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().ownerId).toBe(maker)
    expect(await auditedBy(res.json().id)).toBe(`apikey:${writerId}`)
  })

  it('upload, amendment and CSV import', async () => {
    const file = multipart('keyed.txt', 'text/plain', 'This Agreement is made between the parties.', { title: 'Keyed upload' })
    const up = await app.inject({ method: 'POST', url: '/api/v1/contracts/upload', headers: { ...writer, ...file.headers }, payload: file.payload })
    expect(up.statusCode).toBe(201)
    expect(await ownerOf(up.json().id)).toBe(maker)
    expect(await auditedBy(up.json().id)).toBe(`apikey:${writerId}`)

    const amend = await app.inject({ method: 'POST', url: `/api/v1/contracts/${up.json().id}/amendments`, headers: writer, payload: {} })
    expect(amend.statusCode).toBe(201)
    expect(await ownerOf(amend.json().id)).toBe(maker)
    expect(await auditedBy(amend.json().id)).toBe(`apikey:${writerId}`)

    const csv = multipart('import.csv', 'text/csv', 'title,type\nKeyed import,NDA\n')
    const imp = await app.inject({ method: 'POST', url: '/api/v1/contracts/bulk-import', headers: { ...writer, ...csv.headers }, payload: csv.payload })
    expect(imp.statusCode).toBe(200)
    const row = imp.json().results[0]
    expect(row.ok).toBe(true)
    const imported = await prisma.contract.findUniqueOrThrow({ where: { id: row.id }, select: { ownerId: true, createdBy: true } })
    expect(imported).toEqual({ ownerId: maker, createdBy: `apikey:${writerId}` })
  })

  it('diligence upload and a draft saved through the agent', async () => {
    const room = await app.inject({ method: 'POST', url: '/api/v1/diligence', headers: writer, payload: { name: 'Keyed room' } })
    expect(room.statusCode).toBe(201)
    const file = multipart('target.txt', 'text/plain', 'Supply agreement between the target and its vendor.')
    const up = await app.inject({ method: 'POST', url: `/api/v1/diligence/${room.json().id}/upload`, headers: { ...writer, ...file.headers }, payload: file.payload })
    expect(up.statusCode).toBe(201)
    expect(await ownerOf(up.json().data[0].id)).toBe(maker)

    const draft = await app.inject({
      method: 'POST', url: '/api/v1/agent/draft', headers: writer,
      payload: { userMessage: 'Draft a mutual NDA', saveAs: { title: 'Keyed draft' } },
    })
    expect(draft.statusCode).toBe(200)
    expect(draft.json().contractId).toBeTruthy()
    expect(await ownerOf(draft.json().contractId)).toBe(maker)
  })

  it('a key made through another key acts as the user at the root', async () => {
    const minted = await storedKey(`apikey:${writerId}`)
    const res = await app.inject({ method: 'POST', url: '/api/v1/contracts', headers: minted, payload: { title: 'Minted NDA', type: 'NDA' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().ownerId).toBe(maker)
  })
})

describe('where the owner isn\'t the key\'s maker', () => {
  it('a key\'s split leaves the children with the binder\'s owner, the key as their creator', async () => {
    const binder = await makeContract(org, colleague, { title: 'Colleague\'s binder' })
    const split = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${binder}/split`, headers: writer,
      payload: { splits: [{ pageStart: 1, pageEnd: 2 }, { pageStart: 3, pageEnd: 4 }] },
    })
    expect(split.statusCode).toBe(202)
    expect(vi.mocked(queueSplitBinder)).toHaveBeenLastCalledWith(expect.objectContaining({ contractId: binder, userId: `apikey:${writerId}`, ownerId: colleague }))

    // A signed-in user's split is theirs, as before.
    await app.inject({
      method: 'POST', url: `/api/v1/contracts/${binder}/split`, headers: auth(org, ['ADMIN'], maker),
      payload: { splits: [{ pageStart: 1, pageEnd: 2 }, { pageStart: 3, pageEnd: 4 }] },
    })
    const last = vi.mocked(queueSplitBinder).mock.calls.at(-1)?.[0]
    expect(last?.userId).toBe(maker)
    expect(last?.ownerId).toBeUndefined()
  })

  it('converting a request: the requester owns it; for a request the key raised, the key\'s maker', async () => {
    const both = (await keyFor(maker, 'Requests and contracts', ['requests:write', 'contracts:write'])).headers
    const raised = await app.inject({ method: 'POST', url: '/api/v1/requests', headers: both, payload: { title: 'Keyed request', type: 'NDA', description: 'A mutual NDA with Acme' } })
    expect(raised.statusCode).toBe(201)
    const converted = await app.inject({ method: 'POST', url: `/api/v1/requests/${raised.json().id}/convert`, headers: both, payload: {} })
    expect(converted.statusCode).toBe(201)
    expect(await ownerOf(converted.json().contractId)).toBe(maker)

    const asked = await app.inject({ method: 'POST', url: '/api/v1/requests', headers: auth(org, ['SALES_REP'], colleague), payload: { title: 'Colleague request', type: 'NDA', description: 'An NDA with Initech' } })
    expect(asked.statusCode).toBe(201)
    const byKey = await app.inject({ method: 'POST', url: `/api/v1/requests/${asked.json().id}/convert`, headers: both, payload: {} })
    expect(byKey.statusCode).toBe(201)
    expect(await ownerOf(byKey.json().contractId)).toBe(colleague)
  })

  it('a matter is the maker\'s; a key\'s obligation completion names no one', async () => {
    const matter = await app.inject({ method: 'POST', url: '/api/v1/matters', headers: writer, payload: { name: 'Keyed matter' } })
    expect(matter.statusCode).toBe(201)
    expect(matter.json().ownerId).toBe(maker)

    const contractId = await makeContract(org, maker, { title: 'Keyed obligations' })
    const completion = async (id: string) => prisma.obligation.findUniqueOrThrow({ where: { id }, select: { status: true, completedById: true } })
    const monthly = await prisma.obligation.create({ data: { orgId: org, contractId, type: 'payment', description: 'Pay monthly', quote: 'Pay monthly' } })
    const done = await app.inject({ method: 'POST', url: `/api/v1/obligations/${monthly.id}/complete`, headers: writer, payload: { note: 'Paid' } })
    expect(done.statusCode).toBe(200)
    expect(await completion(monthly.id)).toEqual({ status: 'COMPLETED', completedById: null })

    const quarterly = await prisma.obligation.create({ data: { orgId: org, contractId, type: 'payment', description: 'Pay quarterly', quote: 'Pay quarterly' } })
    const invoice = await prisma.invoice.create({
      data: { orgId: org, contractId, createdById: maker, vendorName: 'Keyed vendor', amount: 100, invoiceDate: new Date(), matchedObligationId: quarterly.id },
    })
    const reconciled = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invoice.id}/reconcile`, headers: writer, payload: {} })
    expect(reconciled.statusCode).toBe(200)
    expect(await completion(quarterly.id)).toEqual({ status: 'COMPLETED', completedById: null })

    // A signed-in user's completion is still theirs.
    const weekly = await prisma.obligation.create({ data: { orgId: org, contractId, type: 'payment', description: 'Pay weekly', quote: 'Pay weekly' } })
    await app.inject({ method: 'POST', url: `/api/v1/obligations/${weekly.id}/complete`, headers: auth(org, ['ADMIN'], maker), payload: {} })
    expect((await completion(weekly.id)).completedById).toBe(maker)
  })

  it('an admin key sets the org\'s AI key, and a skill run through chat is recorded, as the maker', async () => {
    const prior = process.env.AI_KEY_ENCRYPTION_KEY
    process.env.AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    try {
      const adminKey = (await keyFor(maker, 'Admin writer', ['admin'])).headers
      const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/ai/keys/openai', headers: adminKey, payload: { apiKey: 'sk-test-0123456789abcdef' } })
      expect(put.statusCode).toBe(200)
      expect((await prisma.orgAiKey.findFirstOrThrow({ where: { orgId: org, provider: 'openai' } })).createdById).toBe(maker)
    } finally {
      if (prior === undefined) delete process.env.AI_KEY_ENCRYPTION_KEY
      else process.env.AI_KEY_ENCRYPTION_KEY = prior
    }

    const skill = await prisma.skill.create({
      data: { orgId: org, name: 'Keyed skill', slug: '@keyed', description: 'Keyed', ownerType: 'org', contextScope: 'any', systemPrompt: 'Be brief.', allowedTools: [], modelTier: 'default', triggerTypes: ['mention'] },
    })
    const chat = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: writer, payload: { message: 'hi', agentMode: true, skillSlug: '@keyed' } })
    expect(chat.statusCode).toBe(200)
    expect((await prisma.skillInvocation.findFirstOrThrow({ where: { skillId: skill.id } })).userId).toBe(maker)

    // A key whose maker can no longer make keys doesn't get this far (X46).
    const refused = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: demotedKey, payload: { message: 'hi', agentMode: true, skillSlug: '@keyed' } })
    expect(refused.statusCode).toBe(401)
    expect(await prisma.skillInvocation.count({ where: { skillId: skill.id } })).toBe(1)
  })
})

describe('a key with no user to act as', () => {
  it('since X46 doesn\'t authenticate: nothing is stored, uploaded or drafted', async () => {
    const other = await makeUser(otherOrg)
    const deleted = await makeUser(org)
    await grantRole(org, deleted, 'ADMIN')
    await prisma.user.update({ where: { id: deleted }, data: { deletedAt: new Date() } })
    const before = await prisma.contract.count({ where: { orgId: org } })
    // Its maker left, can no longer make keys, was deleted, or is in another org.
    for (const headers of [orphan, demotedKey, await storedKey(deleted), await storedKey(other)]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/contracts', headers, payload: { title: 'Nobody\'s NDA', type: 'NDA' } })
      expect(res.statusCode).toBe(401)
    }

    const sends = vi.mocked(s3.send).mock.calls.length
    const file = multipart('orphan.txt', 'text/plain', 'Orphaned upload.')
    const up = await app.inject({ method: 'POST', url: '/api/v1/contracts/upload', headers: { ...demotedKey, ...file.headers }, payload: file.payload })
    expect(up.statusCode).toBe(401)
    const room = await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Orphan room', createdById: maker } })
    const roomFile = multipart('orphan.txt', 'text/plain', 'Orphaned upload.')
    const roomUp = await app.inject({ method: 'POST', url: `/api/v1/diligence/${room.id}/upload`, headers: { ...demotedKey, ...roomFile.headers }, payload: roomFile.payload })
    expect(roomUp.statusCode).toBe(401)
    expect(vi.mocked(s3.send).mock.calls.length).toBe(sends)

    const calls = draftCalls.length
    const draft = await app.inject({
      method: 'POST', url: '/api/v1/agent/draft', headers: demotedKey,
      payload: { userMessage: 'Draft a mutual NDA', saveAs: { title: 'Orphan draft' } },
    })
    expect(draft.statusCode).toBe(401)
    expect(draftCalls.length).toBe(calls)
    expect(await prisma.contract.count({ where: { orgId: org } })).toBe(before)
  })

  it('a route would still answer NO_ACTING_USER rather than pick someone', () => {
    // requireAuth puts the user behind a key on the request; without one
    // (a key authenticated some other way) there is no one to act as.
    expect(actingUserId({ sub: `apikey:${writerId}` })).toBeNull()
    expect(actingUserId({ sub: `apikey:${writerId}`, keyMakerId: maker })).toBe(maker)
    expect(actingUserId({ sub: maker })).toBe(maker)
    expect(NO_ACTING_USER).toMatchObject({ error: 'NO_ACTING_USER', detail: expect.stringMatching(/no user to act as/) })
  })
})
