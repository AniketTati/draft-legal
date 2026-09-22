/**
 * S2 — the agent's internal tool routes must honour the caller's `own` scope.
 *
 * SALES_REP holds VIEW:CONTRACT and VIEW:REQUEST at `own` scope. REST narrows
 * their contract list to ownerId = themselves; before this fix the internal
 * tool routes (which authenticate the agents SERVICE, not the user) returned
 * org-wide data to anyone who asked the assistant. The scope is now resolved
 * server-side from the userId the agent forwards — never from the body.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, repA: string, repB: string, admin: string
let mineId: string, theirsId: string

const DIM = 1536
const VEC = `[${Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`

async function tool(name: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/internal/ai/tools/${name}`,
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, ...payload },
  })
}

async function grantRole(userId: string, name: string) {
  const role = await prisma.role.upsert({
    where: { orgId_name: { orgId: org, name } },
    create: { orgId: org, name, isSystem: true },
    update: {},
  })
  await prisma.userRole.create({ data: { userId, roleId: role.id } })
}

async function addVersionWithClause(contractId: string, createdById: string, content: string) {
  const v = await prisma.contractVersion.create({
    data: { contractId, versionNumber: 1, plainText: content, createdById },
    select: { id: true },
  })
  await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id } })
  await prisma.$executeRaw`
    INSERT INTO contract_clauses (id, "versionId", "clauseType", content, embedding)
    VALUES (${`it-cl-${contractId}`}, ${v.id}, 'confidentiality', ${content}, ${VEC}::vector)
  `
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Agent Scope Org')
  repA = await makeUser(org)
  repB = await makeUser(org)
  admin = await makeUser(org)
  await grantRole(repA, 'SALES_REP')
  await grantRole(repB, 'SALES_REP')
  await grantRole(admin, 'ADMIN')

  mineId = await makeContract(org, repA, { title: 'Alpha Reseller Agreement', status: 'EXECUTED' })
  theirsId = await makeContract(org, repB, { title: 'Beta Secret Deal', status: 'EXECUTED' })
  const soon = new Date(Date.now() + 20 * 24 * 3600 * 1000)
  await prisma.contract.update({ where: { id: mineId }, data: { counterpartyName: 'Alpha Corp', expiryDate: soon } })
  await prisma.contract.update({ where: { id: theirsId }, data: { counterpartyName: 'Beta Corp', expiryDate: soon } })
  await addVersionWithClause(mineId, repA, 'Alpha confidentiality obligations survive five years.')
  await addVersionWithClause(theirsId, repB, 'Beta confidentiality obligations survive ten years.')

  await prisma.obligation.create({
    data: { orgId: org, contractId: theirsId, type: 'payment', description: 'Beta pays quarterly', quote: 'pays' },
  })
  await prisma.contractRequest.create({
    data: { orgId: org, title: 'Beta renewal request', type: 'RENEWAL', requestedById: repB, description: 'renew beta' },
  })

  // Semantic search embeds the query. Stub only that call; everything else is real.
  process.env.OPENAI_API_KEY = 'it-openai-key'
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).includes('api.openai.com/v1/embeddings')) {
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)) }] }))
    }
    return realFetch(input, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  delete process.env.OPENAI_API_KEY
  const contracts = await prisma.contract.findMany({ where: { orgId: org }, select: { id: true } })
  await prisma.$executeRaw`DELETE FROM contract_clauses WHERE id LIKE 'it-cl-%'`
  await prisma.obligation.deleteMany({ where: { orgId: org } })
  await prisma.contractRequest.deleteMany({ where: { orgId: org } })
  await prisma.contract.updateMany({ where: { id: { in: contracts.map(c => c.id) } }, data: { currentVersionId: null } })
  await prisma.userRole.deleteMany({ where: { role: { orgId: org } } })
  await prisma.role.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('own-scope caller (SALES_REP) through the agent tool routes', () => {
  it('cannot fetch, summarize, cite, validate or check another rep\'s contract', async () => {
    for (const name of ['contract_get', 'contract_summarize', 'contract_cite', 'contract_validate', 'compliance_get', 'playbook_check']) {
      const res = await tool(name, { userId: repA, contractId: theirsId, query: 'confidentiality' })
      expect(res.statusCode, name).toBe(404)
      expect(res.body, name).not.toContain('Beta Secret Deal')
    }
    const clause = await tool('clause_search', { userId: repA, contractId: theirsId, query: 'confidentiality' })
    expect(clause.statusCode).toBe(404)
  })

  it('can still fetch their own contract', async () => {
    const res = await tool('contract_get', { userId: repA, contractId: mineId })
    expect(res.statusCode).toBe(200)
    expect(res.json().title).toBe('Alpha Reseller Agreement')
  })

  it('contract_search lists and counts only their own contracts', async () => {
    const res = await tool('contract_search', { userId: repA, query: '*' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results.map((r: { id: string }) => r.id)).toEqual([mineId])
    expect(body.totalMatching).toBe(1)
  })

  it('the semantic fallback (pgvector) is scoped before top-k', async () => {
    const res = await tool('contract_search', { userId: repA, query: 'no keyword will match this text' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.searchMode).toBe('semantic-fallback')
    expect(body.results.map((r: { id: string }) => r.id)).toEqual([mineId])
  })

  it('portfolio_search dense hits are scoped', async () => {
    const res = await tool('portfolio_search', { userId: repA, query: 'confidentiality survival' })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(theirsId)
    expect(res.body).toContain(mineId)
  })

  it('portfolio_compare, counterparty_memory, obligations, renewals and requests exclude the other rep', async () => {
    const compare = await tool('portfolio_compare', { userId: repA, contractIds: [mineId, theirsId], topics: ['confidentiality'] })
    expect(compare.body).not.toContain(theirsId)

    const memory = await tool('counterparty_memory', { userId: repA, counterpartyName: 'Beta Corp' })
    expect(memory.statusCode).toBe(200)
    expect(memory.json().dealCount).toBe(0)

    const obligations = await tool('obligations_list', { userId: repA })
    expect(obligations.statusCode).toBe(200)
    expect(obligations.body).not.toContain('Beta pays quarterly')

    const renewals = await tool('renewal_advice', { userId: repA, leadDays: 90 })
    expect(renewals.statusCode).toBe(200)
    expect(renewals.body).not.toContain(theirsId)
    expect(renewals.body).toContain(mineId)

    const requests = await tool('request_list', { userId: repA })
    expect(requests.statusCode).toBe(200)
    expect(requests.body).not.toContain('Beta renewal request')

    const redline = await tool('redline_propose', { userId: repA, contractId: theirsId, clauseId: `it-cl-${theirsId}` })
    expect(redline.statusCode).toBe(404)
  })
})

describe('org-scope and identity handling', () => {
  it('an ADMIN reaches the other rep\'s contract and sees both in search', async () => {
    const get = await tool('contract_get', { userId: admin, contractId: theirsId })
    expect(get.statusCode).toBe(200)
    const search = await tool('contract_search', { userId: admin, query: '*' })
    expect(search.json().totalMatching).toBe(2)
    const memory = await tool('counterparty_memory', { userId: admin, counterpartyName: 'Beta Corp' })
    expect(memory.json().dealCount).toBe(1)
  })

  it('the owner (repB) sees their own contract and request', async () => {
    expect((await tool('contract_get', { userId: repB, contractId: theirsId })).statusCode).toBe(200)
    expect((await tool('request_list', { userId: repB })).body).toContain('Beta renewal request')
  })

  it('an unknown, null, or other-org userId is refused, never widened', async () => {
    const otherOrg = await makeOrg('Agent Scope Other Org')
    const outsider = await makeUser(otherOrg)
    for (const userId of ['not-a-user', null, 'anonymous', outsider]) {
      const res = await tool('contract_search', { userId, query: '*' })
      expect(res.statusCode, String(userId)).toBe(403)
    }
  })

  it('a service call with no userId (e.g. the playbook worker) keeps org scope', async () => {
    const res = await tool('contract_get', { contractId: theirsId })
    expect(res.statusCode).toBe(200)
  })

  it('a scope claimed in the body is ignored', async () => {
    const res = await tool('contract_search', { userId: repA, query: '*', scope: 'org', permissionScope: 'org' })
    expect(res.json().totalMatching).toBe(1)
  })
})
