/**
 * docs/39 E3 — clause types an organization teaches the AI: added (not
 * twice, not over a built-in one), taggable, tried on a contract without
 * saving, found in the contracts read before them, told to every extraction,
 * and removed without touching the clauses already found.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Kept off the shared Redis queue, which the dev API's workers also consume.
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueDetectClauseType: vi.fn(),
  queueEmbedContract: vi.fn(),
}))
// The agents service's /find-clause: finds the residency clause where there is one.
vi.mock('../lib/clause-type-agents.js', () => ({
  agentsFindClause: () => async ({ body }: { body: { plainText: string } }) => {
    const at = body.plainText.indexOf('Supplier shall store')
    return at < 0 ? [] : [{ content: body.plainText.slice(at, at + 96), sectionRef: '7', interpretation: 'Data stays in the EU.' }]
  },
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { queueDetectClauseType } from '../lib/queue.js'
import { runDetect } from '../lib/clause-types.js'
import { agentsFindClause } from '../lib/clause-type-agents.js'
import { runExtractionJob, type ExtractionDeps, type ExtractionJobLike } from '../lib/extraction-job.js'

let app: TestApp
let org: string, owner: string, withIt: string, without: string, typeId: string

const admin = () => auth(org, ['ADMIN'], owner)
const RESIDENCY_TEXT = 'SERVICES AGREEMENT. 7. DATA. Supplier shall store and process Customer Data only in data centres located in the European Union and nowhere else. 8. FEES. Payable monthly.'

async function analysed(title: string, text: string) {
  const id = await makeContract(org, owner, { title, type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: text } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
  return id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Clause Types Org')
  owner = await makeUser(org)
  withIt = await analysed('Hosting Services Agreement', RESIDENCY_TEXT)
  without = await analysed('Office Supplies Order', 'ORDER. Supplier shall deliver 40 chairs by 1 March. Payment within 30 days.')
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('an organization’s own clause type', () => {
  it('is added once, never over a built-in one, and listed after them', async () => {
    const add = (label: string) => app.inject({ method: 'POST', url: '/api/v1/clause-types', headers: admin(), payload: {
      label, description: 'Where the supplier may store or process our data.', examples: ['All Customer Data shall be hosted in the United Kingdom.'],
    } })
    const r = await add('Data residency')
    expect(r.statusCode).toBe(201)
    typeId = r.json().clauseType.id
    expect(r.json().clauseType).toMatchObject({ key: 'custom_data_residency', custom: true })
    expect((await add('data RESIDENCY')).statusCode).toBe(409)
    expect((await add('Force Majeure')).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/v1/clause-types', headers: auth(org, ['VIEWER'], owner), payload: { label: 'AI use' } })).statusCode).toBe(403)

    const list = (await app.inject({ method: 'GET', url: '/api/v1/clause-types', headers: auth(org, ['VIEWER'], owner) })).json().clauseTypes
    expect(list.filter((t: { custom: boolean }) => !t.custom).length).toBeGreaterThan(40)
    expect(list.at(-1)).toMatchObject({ key: 'custom_data_residency', label: 'Data residency', examples: ['All Customer Data shall be hosted in the United Kingdom.'] })
  })

  it('can be tagged on a clause, as a built-in one can; one that isn’t a type can’t', async () => {
    const tag = (clauseType: string) => app.inject({ method: 'POST', url: `/api/v1/contracts/${withIt}/clauses/tag`, headers: admin(), payload: {
      clauseType, text: 'Supplier shall store and process Customer Data only in data centres located in the European Union',
    } })
    expect((await tag('custom_data_residency')).statusCode).toBe(200)
    expect((await tag('custom_nothing_like_it')).statusCode).toBe(422)
  })

  it('is tried on a contract without anything saved', async () => {
    const before = await prisma.contractClause.count({ where: { version: { contractId: withIt }, clauseType: 'custom_data_residency', source: 'ai' } })
    const r = await app.inject({ method: 'POST', url: `/api/v1/clause-types/${typeId}/preview`, headers: admin(), payload: { contractId: withIt } })
    expect(r.statusCode).toBe(200)
    expect(r.json().clauses).toEqual([expect.objectContaining({ sectionRef: '7', docStart: expect.any(Number) })])
    expect((await app.inject({ method: 'POST', url: `/api/v1/clause-types/${typeId}/preview`, headers: admin(), payload: { contractId: without } })).json().clauses).toEqual([])
    expect(await prisma.contractClause.count({ where: { version: { contractId: withIt }, clauseType: 'custom_data_residency', source: 'ai' } })).toBe(before)
  })

  it('is found in the contracts read before it, and says how many', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/clause-types/${typeId}/detect`, headers: admin() })
    expect(r.statusCode).toBe(202)
    expect(r.json().detect).toMatchObject({ status: 'QUEUED' })
    expect(vi.mocked(queueDetectClauseType)).toHaveBeenCalledWith({ orgId: org, definitionId: typeId })
    // The job's work.
    const state = await runDetect({ orgId: org, definitionId: typeId }, agentsFindClause('clause_detect'))
    expect(state).toMatchObject({ status: 'DONE', total: 2, processed: 2 })
    // The person's tag of the same passage stands; the AI doesn't add it again.
    const rows = await prisma.contractClause.findMany({ where: { version: { contractId: withIt }, clauseType: 'custom_data_residency' } })
    expect(rows.map(r => r.source).sort()).toEqual(['user'])
    expect(await prisma.contractClause.count({ where: { version: { contractId: without }, clauseType: 'custom_data_residency' } })).toBe(0)
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/clause-types', headers: admin() })).json().clauseTypes.at(-1)
    expect(listed.detect).toMatchObject({ status: 'DONE', processed: 2 })
  })

  it('is told to every extraction', async () => {
    let body: Record<string, unknown> | null = null
    const deps: ExtractionDeps = {
      async review(b) { body = b; return new Response(JSON.stringify({ contract: {}, version: {}, failed: false }), { status: 200 }) },
      async reviewLegacy() { return new Response('{}', { status: 404 }) },
      async api() { return { status: 200, text: '{}' } },
    }
    const v = await prisma.contract.findUniqueOrThrow({ where: { id: without }, select: { currentVersionId: true } })
    const job: ExtractionJobLike = { data: { contractId: without, versionId: v.currentVersionId!, orgId: org }, attemptsMade: 0, opts: { attempts: 3 }, async updateData(d) { job.data = d } }
    await runExtractionJob(job, deps)
    expect(body!.customClauseTypes).toEqual([{ key: 'custom_data_residency', label: 'Data residency', description: 'Where the supplier may store or process our data.', examples: ['All Customer Data shall be hosted in the United Kingdom.'] }])
  })

  it('removed, is no longer looked for; the clauses found keep their type', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/clause-types/${typeId}`, headers: admin() })).statusCode).toBe(204)
    const list = (await app.inject({ method: 'GET', url: '/api/v1/clause-types', headers: admin() })).json().clauseTypes
    expect(list.some((t: { key: string }) => t.key === 'custom_data_residency')).toBe(false)
    expect(await prisma.contractClause.count({ where: { version: { contractId: withIt }, clauseType: 'custom_data_residency' } })).toBe(1)
    // Added again under its name, it comes back.
    expect((await app.inject({ method: 'POST', url: '/api/v1/clause-types', headers: admin(), payload: { label: 'Data residency' } })).json().clauseType.id).toBe(typeId)
  })
})
