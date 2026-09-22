/**
 * C11 — retrieval must answer from each contract's CURRENT version, and keep
 * diligence-room documents (a target's contracts, not the org's) out of
 * ordinary search and agent answers, while room-scoped access still works.
 *
 * pgvector and Postgres are real; only the embeddings HTTP call is stubbed.
 * The Elasticsearch half runs when ES is reachable (docker compose) and is
 * skipped in CI, which runs no ES.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { searchClauses } from './embeddings.js'
import { es, CONTRACT_INDEX, advancedSearch, indexContract, deleteContractFromIndex, ensureContractIndex } from './elasticsearch.js'

const DIM = 1536
const VEC = `[${Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`

let app: TestApp
let org: string, owner: string, room: string
let current: string, legacy: string, diligence: string, sealed: string

async function withVersions(title: string, texts: string[], opts: { current?: boolean; room?: string } = {}) {
  const id = await makeContract(org, owner, { title, type: 'MSA', status: 'EXECUTED' })
  let last = ''
  for (const [i, text] of texts.entries()) {
    const v = await prisma.contractVersion.create({
      data: { contractId: id, versionNumber: i + 1, createdById: owner, plainText: text, htmlContent: `<p>${text}</p>` },
    })
    await prisma.$executeRaw`
      INSERT INTO contract_clauses (id, "versionId", "clauseType", content, embedding)
      VALUES (${`it-c11-${v.id}`}, ${v.id}, 'limitation_of_liability', ${text}, ${VEC}::vector)
    `
    last = v.id
  }
  await prisma.contract.update({
    where: { id },
    data: {
      ...(opts.current === false ? {} : { currentVersionId: last }),
      ...(opts.room ? { diligenceRoomId: opts.room } : {}),
    },
  })
  return id
}

const tool = (name: string, payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: `/api/internal/ai/tools/${name}`,
  headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
  payload: { orgId: org, ...payload },
})

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Retrieval Scope Org')
  owner = await makeUser(org)
  room = (await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Project Falcon', createdById: owner } })).id

  current   = await withVersions('Current MSA', ['Liability v1: unlimited.', 'Liability v2: capped at fees.', 'Liability v3: capped at 12 months.'])
  legacy    = await withVersions('Legacy MSA', ['Legacy v1: uncapped.', 'Legacy v2: capped at 6 months.'], { current: false })
  diligence = await withVersions('Target Co MSA', ['Target liability: capped at 2x fees.'], { room })
  // Sealing / redline_apply / editor saves add a current version with no
  // extracted clauses: retrieval must fall back to the latest one that has them.
  sealed = await withVersions('Sealed MSA', ['Sealed liability: capped at 18 months.'])
  const clauseless = await prisma.contractVersion.create({
    data: { contractId: sealed, versionNumber: 2, createdById: owner, plainText: 'sealed copy', htmlContent: '<p>sealed copy</p>' },
  })
  await prisma.contract.update({ where: { id: sealed }, data: { currentVersionId: clauseless.id } })

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
  await prisma.$executeRaw`DELETE FROM contract_clauses WHERE id LIKE 'it-c11-%'`
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null, diligenceRoomId: null } })
  await prisma.diligenceRoom.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('semantic retrieval (pgvector)', () => {
  it('returns only the current version\'s clause of a three-version contract, and the latest when no current is set', async () => {
    const texts = (await searchClauses('liability cap', org, 50)).map(m => m.content)
    expect(texts).toContain('Liability v3: capped at 12 months.')
    expect(texts).not.toContain('Liability v1: unlimited.')
    expect(texts).not.toContain('Liability v2: capped at fees.')
    expect(texts).toContain('Legacy v2: capped at 6 months.')
    expect(texts).not.toContain('Legacy v1: uncapped.')
  })

  it('a contract whose current version has no clauses yet still answers from its latest extracted version', async () => {
    const texts = (await searchClauses('liability cap', org, 50)).map(m => m.content)
    expect(texts).toContain('Sealed liability: capped at 18 months.')
    const byId = await searchClauses('liability cap', org, 50, sealed)
    expect(byId.map(m => m.content)).toEqual(['Sealed liability: capped at 18 months.'])
  })

  it('keeps diligence-room documents out of org-wide search, but not room-scoped or by-id access', async () => {
    const orgWide = await searchClauses('liability cap', org, 50)
    expect(orgWide.map(m => m.contractId)).not.toContain(diligence)

    const inRoom = await searchClauses('liability cap', org, 50, undefined, undefined, { diligenceRoomId: room })
    expect(inRoom.map(m => m.contractId)).toEqual([diligence])

    const byId = await searchClauses('liability cap', org, 50, diligence)
    expect(byId.map(m => m.content)).toEqual(['Target liability: capped at 2x fees.'])
  })

  it('can still reach superseded text when explicitly asked (history, diffs)', async () => {
    const all = (await searchClauses('liability cap', org, 50, current, undefined, { allVersions: true })).map(m => m.content)
    expect(all.sort()).toEqual(['Liability v1: unlimited.', 'Liability v2: capped at fees.', 'Liability v3: capped at 12 months.'])
  })
})

describe('agent tools', () => {
  it('contract_search and its semantic fallback leave out diligence documents', async () => {
    const list = await tool('contract_search', { query: '*' })
    expect(list.json().results.map((r: { id: string }) => r.id).sort()).toEqual([current, legacy, sealed].sort())
    expect(list.json().totalMatching).toBe(3)

    const semantic = await tool('contract_search', { query: 'no keyword matches this' })
    expect(semantic.json().results.map((r: { id: string }) => r.id)).not.toContain(diligence)
  })

  it('a diligence document is still reachable by id (room-scoped access)', async () => {
    const res = await tool('contract_get', { contractId: diligence })
    expect(res.statusCode).toBe(200)
    expect(res.json().title).toBe('Target Co MSA')
  })

  it('org_memory past-deal excerpts come from current versions only, never from diligence rooms', async () => {
    const res = await tool('org_memory', { topic: 'liability', clauseType: 'limitation_of_liability', limit: 20 })
    expect(res.statusCode).toBe(200)
    const excerpts = JSON.stringify(res.json())
    expect(excerpts).toContain('Liability v3: capped at 12 months.')
    expect(excerpts).not.toContain('Liability v1: unlimited.')
    expect(excerpts).not.toContain('Target liability')
    // No current-version pointer, and a clause-less current version: both still count.
    expect(excerpts).toContain('Legacy v2: capped at 6 months.')
    expect(excerpts).toContain('Sealed liability: capped at 18 months.')
  })

  it('portfolio_search leaves out the target\'s contracts', async () => {
    const pf = await tool('portfolio_search', { query: 'liability cap' })
    expect(pf.statusCode).toBe(200)
    expect(pf.body).not.toContain(diligence)
  })
})

const ES_UP = await es.ping().then(() => true, () => false)

describe.skipIf(!ES_UP)('keyword retrieval (Elasticsearch)', () => {
  beforeAll(async () => {
    await ensureContractIndex()
    // No diligenceRoomId passed, as most index paths don't: indexContract fills it.
    for (const id of [current, diligence]) {
      const c = await prisma.contract.findUniqueOrThrow({ where: { id } })
      await indexContract(id, {
        orgId: org, title: c.title, type: c.type, status: c.status,
        plainText: 'liability falcon', tags: [], createdAt: c.createdAt.toISOString(),
      })
    }
    await es.indices.refresh({ index: CONTRACT_INDEX })
  })

  afterAll(async () => {
    for (const id of [current, diligence]) await deleteContractFromIndex(id).catch(() => {})
  })

  it('a stale ES doc (indexed before C11, without diligenceRoomId) leaks nothing through REST search', async () => {
    await es.index({
      index: CONTRACT_INDEX, id: diligence, refresh: true,
      body: { orgId: org, title: 'Target Co MSA', type: 'MSA', status: 'EXECUTED', plainText: 'liability falcon', tags: [], createdAt: new Date().toISOString() },
    })
    const { auth } = await import('../test-support/helpers.js')
    const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers: auth(org, ['ADMIN'], owner), payload: { q: 'falcon' } })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(diligence)
    expect(res.body).not.toContain('Target Co')
    // Restore the properly indexed doc for the next case.
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: diligence } })
    await indexContract(diligence, { orgId: org, title: c.title, type: c.type, status: c.status, plainText: 'liability falcon', tags: [], createdAt: c.createdAt.toISOString() })
    await es.indices.refresh({ index: CONTRACT_INDEX })
  })

  it('ordinary search excludes the room document; a room-scoped search finds only it', async () => {
    const ordinary = await advancedSearch(org, { q: 'falcon' })
    expect(ordinary.hits.map(h => h.id)).toEqual([current])
    const scoped = await advancedSearch(org, { q: 'falcon', diligenceRoomId: room })
    expect(scoped.hits.map(h => h.id)).toEqual([diligence])
  })
})
