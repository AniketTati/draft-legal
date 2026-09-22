/**
 * C4 — re-analysis must not wipe a contract's stored reports.
 *
 * The agents service writes extraction results with PATCH /contracts/:id
 * { metadata: {…only its own keys…} }. The route handed that to Prisma, which
 * REPLACES a JSON column, so the compliance report, playbook review, binder
 * markers and custom values were erased on every re-analyze.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, contract: string

const REPORTS = {
  _compliance:     { framework: 'GDPR', score: 82, checkedAt: '2026-09-01' },
  _playbookReview: { findings: [{ clause: 'LoL', severity: 'high' }] },
  _binderDetected: true,
  _splitInto:      ['child-1', 'child-2'],
  poNumber:        'PO-123',
}

// The agents service's headers (apps/agents/app/routes/review.py).
const agentHeaders = () => ({
  'x-internal-service': 'agents',
  'x-internal-secret':  process.env.INTERNAL_SERVICE_SECRET as string,
  'x-org-id':           org,
})

async function meta(): Promise<Record<string, unknown>> {
  const row = await prisma.contract.findUnique({ where: { id: contract }, select: { metadata: true } })
  return row?.metadata as Record<string, unknown>
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Metadata Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner)
  await prisma.contract.update({
    where: { id: contract },
    data: { metadata: { ...REPORTS, _typeFields: { old: { value: 'stale' } }, _aiFindings: ['stale finding'] } },
  })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('PATCH /contracts/:id merges metadata', () => {
  it('a re-extraction keeps every stored report and updates its own keys', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: agentHeaders(),
      payload: { summary: 'Re-analysed', metadata: { _typeFields: { term: { value: '24 months' } }, costCenter: 'CC-9' } },
    })
    expect(res.statusCode).toBe(200)
    const m = await meta()
    expect(m).toMatchObject(REPORTS)
    expect(m._typeFields).toEqual({ term: { value: '24 months' } })
    expect(m.costCenter).toBe('CC-9')
  })

  it('null deletes a key, so an extraction can clear its own stale output', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: agentHeaders(),
      payload: { metadata: { _aiFindings: null } },
    })
    expect(res.statusCode).toBe(200)
    const m = await meta()
    expect(m).not.toHaveProperty('_aiFindings')
    expect(m).toMatchObject(REPORTS)
  })

  it('a status-only metadata write (redline failure path) no longer wipes the blob', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['ADMIN'], owner),
      payload: { metadata: { _redlineStatus: 'FAILED', _redlineError: 'no second version' } },
    })
    expect(res.statusCode).toBe(200)
    const m = await meta()
    expect(m).toMatchObject({ ...REPORTS, _redlineStatus: 'FAILED' })
  })

  it('a PATCH without metadata leaves it untouched', async () => {
    const before = await meta()
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['ADMIN'], owner),
      payload: { title: 'Renamed' },
    })
    expect(res.statusCode).toBe(200)
    expect(await meta()).toEqual(before)
  })
})
