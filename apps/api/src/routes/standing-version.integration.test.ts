/**
 * DD4 — after "Undo" on an applied redline, the contract stands on the
 * version before it; the undone version stays, as the newest. The download
 * (and the page's PDF view, which uses it) served the newest: the undone
 * text.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Kept off the shared Redis queue, which the dev API's workers also consume;
// and the jobs these routes queue are what the tests read.
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueApprovalSummary: vi.fn(),
  queueNotification: vi.fn(),
  queueEscalation: vi.fn(async () => ({ id: 'escalation' })),
  queueClassifyDocument: vi.fn(),
  queueParseDocument: vi.fn(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { queueApprovalSummary, queueClassifyDocument } from '../lib/queue.js'

/** A contract standing on v1 after "Undo" on v2, which stays as the newest. */
async function undone(orgId: string, owner: string) {
  const id = await makeContract(orgId, owner, { title: 'DD4 undone redline' })
  const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, htmlContent: '<p>What we agreed.</p>', plainText: 'What we agreed.' } })
  const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: owner, htmlContent: '<p>An internal redline, undone.</p>', plainText: 'An internal redline, undone.', changeNote: 'redline_apply (moderate) (reverted via undo)' } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v1.id } })
  return { id, v1: v1.id, v2: v2.id }
}

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('DD4 Standing Version Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('the version a contract stands on', () => {
  it('is what the download serves after an undo', async () => {
    const id = await makeContract(org, user)
    const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, s3Key: `${org}/dd4/v1.pdf`, mimeType: 'application/pdf', plainText: 'one' } })
    await prisma.contractVersion.create({
      data: { contractId: id, versionNumber: 2, createdById: user, renderedPdfKey: `${org}/dd4/v2-undone.pdf`, plainText: 'two', changeNote: 'redline_apply (moderate) (reverted via undo)' },
    })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v1.id } })

    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/download`, headers: auth(org, ['ADMIN'], user) })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().url).toContain('dd4/v1.pdf')
  })

  it('falls back only to a file at or before it', async () => {
    const id = await makeContract(org, user)
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, s3Key: `${org}/dd4b/v1.pdf`, mimeType: 'application/pdf', plainText: 'one' } })
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: user, plainText: 'two, edited, not rendered yet' } })
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 3, createdById: user, renderedPdfKey: `${org}/dd4b/v3-undone.pdf`, plainText: 'three' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })

    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/download`, headers: auth(org, ['ADMIN'], user) })
    expect(res.json().url).toContain('dd4b/v1.pdf')
  })

  it('is what approvers get a summary of', async () => {
    const approver = await makeUser(org)
    await makeWorkflow(org, user, approver)
    const { id, v1 } = await undone(org, user)
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/submit-approval`, headers: auth(org, ['ADMIN'], user), payload: {} })
    expect(res.statusCode, res.body).toBeLessThan(300)
    expect(vi.mocked(queueApprovalSummary)).toHaveBeenCalledWith(expect.objectContaining({ contractId: id, versionId: v1 }))
  })

  it('is what the assistant re-analyses', async () => {
    const { id, v1 } = await undone(org, user)
    const res = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_update',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, userId: user, contractId: id, action: 're_analyze', payload: {} },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(vi.mocked(queueClassifyDocument)).toHaveBeenCalledWith(expect.objectContaining({ contractId: id, versionId: v1 }))
  })
})
