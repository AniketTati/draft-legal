/**
 * C7 — clause flags must reach Elasticsearch, or the Contracts list's
 * clause-flag facets count 0 and its filters are hidden.
 *
 * Runs against the real ES (docker compose). Documents are keyed to a
 * throwaway org and deleted afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { es, CONTRACT_INDEX, indexContract, deleteContractFromIndex, ensureContractIndex } from './elasticsearch.js'

let app: TestApp
let org: string, owner: string, flagged: string, bare: string, versionId: string

const agentHeaders = () => ({
  'x-internal-service': 'agents',
  'x-internal-secret':  process.env.INTERNAL_SERVICE_SECRET as string,
  'x-org-id':           org,
})

async function esDoc(id: string, until: (src: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 40; i++) {
    const res = await es.get({ index: CONTRACT_INDEX, id }).catch(() => null)
    const src = (res?.body as { _source?: Record<string, unknown> } | undefined)?._source
    if (src && until(src)) return src
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}

beforeAll(async () => {
  app = await getApp()
  await ensureContractIndex()
  org = await makeOrg('Clause Flag Org')
  owner = await makeUser(org)
  flagged = await makeContract(org, owner, { title: 'Flagged MSA', status: 'EXECUTED' })
  bare = await makeContract(org, owner, { title: 'Bare NDA', status: 'EXECUTED' })
  const v = await prisma.contractVersion.create({
    data: { contractId: flagged, versionNumber: 1, plainText: 'force majeure applies', createdById: owner },
  })
  versionId = v.id
  await prisma.contract.update({ where: { id: flagged }, data: { currentVersionId: v.id } })
})

afterAll(async () => {
  for (const id of [flagged, bare]) await deleteContractFromIndex(id).catch(() => {})
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('clause flags in the search index', () => {
  it('the Review agent storing flags re-indexes the contract with them', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${flagged}/versions/${versionId}/clauses`, headers: agentHeaders(),
      payload: { clauseFlags: { forceMajeure: true, mfn: false, auditRights: true } },
    })
    expect(res.statusCode).toBe(201)
    const doc = await esDoc(flagged, src => !!src.clauseFlags)
    expect(doc?.clauseFlags).toEqual({ forceMajeure: true, mfn: false, auditRights: true })
    expect(doc?.title).toBe('Flagged MSA')
    expect(doc?.plainText).toBe('force majeure applies')
  })

  it('facets count the flag and the list filter finds the contract', async () => {
    await es.indices.refresh({ index: CONTRACT_INDEX })
    const facets = await app.inject({ method: 'GET', url: '/api/v1/search/facets', headers: auth(org, ['ADMIN'], owner) })
    expect(facets.json().clauseFlags.forceMajeure).toBe(1)
    expect(facets.json().clauseFlags.auditRights).toBe(1)
    expect(facets.json().clauseFlags.mfn).toBe(0)

    const filtered = await app.inject({
      method: 'POST', url: '/api/v1/search/advanced', headers: auth(org, ['ADMIN'], owner),
      payload: { clauseFlags: { forceMajeure: true } },
    })
    expect(filtered.statusCode).toBe(200)
    const ids = JSON.stringify(filtered.json())
    expect(ids).toContain(flagged)
    expect(ids).not.toContain(bare)
  })

  it('any indexContract call without flags fills them from the version (every path, incl. backfill)', async () => {
    await indexContract(flagged, {
      orgId: org, title: 'Flagged MSA', type: 'NDA', status: 'EXECUTED',
      plainText: '', tags: [], createdAt: new Date().toISOString(),
    })
    const doc = await esDoc(flagged, src => src.plainText === '')
    expect(doc?.clauseFlags).toEqual({ forceMajeure: true, mfn: false, auditRights: true })

    await indexContract(bare, {
      orgId: org, title: 'Bare NDA', type: 'NDA', status: 'EXECUTED',
      plainText: '', tags: [], createdAt: new Date().toISOString(),
    })
    const bareDoc = await esDoc(bare, () => true)
    expect(bareDoc).not.toHaveProperty('clauseFlags')
  })
})
