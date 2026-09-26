/**
 * V1 — GET /contracts/:id/playbook-review feeds the contract rail: findings
 * in document order, each linkable to its clause, and a 404 that says WHY
 * there is no review (no positions for the type vs. not run yet).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, reviewed: string, clauseIds: string[]

const get = (id: string, orgId = org) => app.inject({
  method: 'GET', url: `/api/v1/contracts/${id}/playbook-review`, headers: auth(orgId, ['VIEWER'], owner),
})

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Playbook Review Org')
  owner = await makeUser(org)
  reviewed = await makeContract(org, owner, { title: 'Reviewed MSA', type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: reviewed, versionNumber: 1, createdById: owner } })
  clauseIds = []
  for (const [i, t] of ['confidentiality', 'limitation_of_liability', 'termination'].entries()) {
    const c = await prisma.contractClause.create({
      data: { versionId: v.id, clauseType: t, content: `${t} clause text`, sortOrder: i, sectionRef: `${i + 1}.1` },
    })
    clauseIds.push(c.id)
  }
  // Stored in MODEL order (termination first), not document order.
  await prisma.contract.update({
    where: { id: reviewed },
    data: {
      metadata: {
        _playbookReview: {
          findings: [
            { clauseId: clauseIds[2], clauseType: 'termination', playbookAlignment: 'fallback', severity: 'medium', recommendation: 'negotiate', reasoning: 'notice is 10 days' },
            { clauseId: clauseIds[0], clauseType: 'confidentiality', playbookAlignment: 'walkaway', severity: 'critical', recommendation: 'reject', reasoning: 'perpetual one-way', requiresHumanReview: true },
          ],
          summary: '2 of 3 clauses deviate', requiresHumanGate: true, clausesReviewed: 3,
          reviewedAt: '2026-09-20T00:00:00.000Z', versionId: v.id,
        },
      },
    },
  })
})

afterAll(async () => {
  const versions = await prisma.contractVersion.findMany({ where: { contract: { orgId: org } }, select: { id: true } })
  await prisma.contractClause.deleteMany({ where: { versionId: { in: versions.map(x => x.id) } } })
  await prisma.playbookPosition.deleteMany({ where: { orgId: org } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('GET /contracts/:id/playbook-review', () => {
  it('returns findings in document order, each with its clause section and excerpt', async () => {
    const res = await get(reviewed)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.findings.map((f: { clauseId: string }) => f.clauseId)).toEqual([clauseIds[0], clauseIds[2]])
    expect(body.findings[0]).toMatchObject({ severity: 'critical', sectionRef: '1.1', excerpt: 'confidentiality clause text', sortOrder: 0 })
    expect(body).toMatchObject({ requiresHumanGate: true, clausesReviewed: 3 })
  })

  it('explains a missing review: no positions for the type vs. not run yet', async () => {
    const nda = await makeContract(org, owner, { title: 'Unreviewed NDA', type: 'NDA' })
    const none = await get(nda)
    expect(none.statusCode).toBe(404)
    expect(none.json()).toMatchObject({ reason: 'no_positions', playbookPositionCount: 0, contractType: 'NDA' })

    const cat = await prisma.clauseCategory.create({ data: { orgId: org, name: 'Confidentiality' } })
    await prisma.playbookPosition.create({
      data: { orgId: org, clauseCategoryId: cat.id, positionType: 'preferred', content: 'mutual', contractTypes: ['NDA'], createdById: owner },
    })
    const notRun = await get(nda)
    expect(notRun.statusCode).toBe(404)
    expect(notRun.json()).toMatchObject({ reason: 'not_run', playbookPositionCount: 1 })
  })

  it('is org-scoped', async () => {
    const other = await makeOrg('Other Playbook Org')
    const res = await get(reviewed, other)
    expect(res.statusCode).toBe(404)
    expect(res.json().reason).toBeUndefined()
  })
})
