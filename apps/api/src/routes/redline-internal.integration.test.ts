/**
 * C8 — the Negotiate tab's AI redline analysis. The agents service
 * (apps/agents/app/routes/redline.py) fetches the diff and the org's
 * playbook from this API. It sent no x-org-id, so the caller's org resolved
 * to 'system' and the org-scoped diff route 404'd; and it fetched
 * GET /api/v1/playbook, which does not exist, then scored against nothing.
 *
 * These cases replay redline.py's requests with the headers and URL it sends
 * now, and pin the two failure modes it used to hit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, contract: string, v1: string, v2: string

// redline.py _internal_headers(org_id)
const agentHeaders = (withOrg = true) => ({
  'x-internal-service': 'agents',
  'x-internal-secret':  process.env.INTERNAL_SERVICE_SECRET as string,
  ...(withOrg ? { 'x-org-id': org } : {}),
})

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Redline Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Negotiated MSA', type: 'MSA', status: 'UNDER_NEGOTIATION' })
  v1 = (await prisma.contractVersion.create({
    data: { contractId: contract, versionNumber: 1, createdById: owner,
            htmlContent: '<p>Liability is capped at twelve months of fees.</p>', plainText: 'x' },
  })).id
  v2 = (await prisma.contractVersion.create({
    data: { contractId: contract, versionNumber: 2, createdById: owner,
            htmlContent: '<p>Liability is capped at three months of fees.</p>', plainText: 'x' },
  })).id
  const category = await prisma.clauseCategory.create({ data: { orgId: org, name: 'Limitation of Liability' } })
  await prisma.playbookPosition.create({
    data: { orgId: org, clauseCategoryId: category.id, positionType: 'preferred',
            content: '<p>Cap at 12 months of fees.</p>', contractTypes: ['MSA'], createdById: owner },
  })
})

afterAll(async () => {
  await prisma.versionDiffCache.deleteMany({ where: { contractId: contract } })
  await prisma.playbookPosition.deleteMany({ where: { orgId: org } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('redline analysis inputs, as the agents service requests them', () => {
  it('the diff resolves with x-org-id and shows the real change', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/contracts/${contract}/versions/${v1}/diff/${v2}`, headers: agentHeaders(),
    })
    expect(res.statusCode).toBe(200)
    const { diffHtml } = res.json()
    expect(diffHtml).toMatch(/<del[^>]*>twelve<\/del>/)
    expect(diffHtml).toMatch(/<ins[^>]*>three<\/ins>/)
  })

  it('the playbook positions route returns the org\'s positions for the contract type', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/playbook/positions?contractType=MSA', headers: agentHeaders(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
    expect(res.json().data[0].content).toContain('12 months')
  })

  it('pins the old failures: no x-org-id → the diff 404s; /api/v1/playbook does not exist', async () => {
    const noOrg = await app.inject({
      method: 'GET', url: `/api/v1/contracts/${contract}/versions/${v1}/diff/${v2}`, headers: agentHeaders(false),
    })
    expect(noOrg.statusCode).toBe(404)
    const oldPlaybook = await app.inject({ method: 'GET', url: `/api/v1/playbook?orgId=${org}`, headers: agentHeaders() })
    expect(oldPlaybook.statusCode).toBe(404)
  })

  it('a failure is recorded as a status + reason the Negotiate tab can show', async () => {
    // redline.py _set_failed(): merges (C4), so the rest of the metadata survives.
    await prisma.contract.update({ where: { id: contract }, data: { metadata: { _compliance: { ok: true } } } })
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: agentHeaders(),
      payload: { metadata: { _redlineStatus: 'FAILED', _redlineError: 'The two versions have no differences, so there is nothing to analyze.' } },
    })
    expect(res.statusCode).toBe(200)
    const meta = (await prisma.contract.findUnique({ where: { id: contract } }))?.metadata as Record<string, unknown>
    expect(meta).toMatchObject({ _redlineStatus: 'FAILED', _compliance: { ok: true } })
  })
})
