/**
 * docs/41 P0.6/P0.7 — a returned approval is visible on the contract, with
 * its reason, in three places (the approval route the page reads, the
 * notification, the contract's Activity); a playbook redline on an
 * unanalysed contract says so instead of failing or reporting an all-clear.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueNotification: vi.fn(),
  queueApprovalSummary: vi.fn(),
  queuePlaybookRedline: vi.fn(),
  queueEscalation: vi.fn(async () => ({ id: 'esc' })),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { queueNotification } from '../lib/queue.js'
import { redlineClearNote } from '../lib/playbook-redline-targets.js'

let app: TestApp
let org: string, owner: string, approver: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Approval Visibility Org')
  owner = await makeUser(org)
  approver = await makeUser(org)
  await prisma.user.update({ where: { id: approver }, data: { name: 'Priya Approver' } })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

async function submitted() {
  const id = await makeContract(org, owner, { title: 'MSA — Initech', type: 'MSA', status: 'DRAFT' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, htmlContent: '<p>x</p>', plainText: 'x' } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  const wf = await makeWorkflow(org, owner, approver)
  const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/submit-approval`, headers: auth(org, ['ADMIN'], owner), payload: { workflowDefinitionId: wf } })
  expect(res.statusCode).toBe(201)
  return { id, instanceId: res.json().instanceId as string, stepId: res.json().steps[0].id as string }
}

const approvalOf = (id: string, as = owner) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/approval`, headers: auth(org, ['ADMIN'], as) }).then(r => r.json())

describe('GET /contracts/:id/approval', () => {
  it('shows the pending request, who it waits on, and the step waiting on the approver', async () => {
    const { id, instanceId, stepId } = await submitted()
    const forOwner = await approvalOf(id)
    expect(forOwner.current).toMatchObject({ id: instanceId, outcome: 'pending', waitingOn: [{ id: approver, name: 'Priya Approver' }] })
    expect(forOwner.awaitingMe).toBeNull()
    const forApprover = await approvalOf(id, approver)
    expect(forApprover.awaitingMe).toMatchObject({ stepId, instanceId, contract: { id } })
  })

  it('a return shows who and why — on the route, in the notification, in Activity — and the contract is back in Draft', async () => {
    const { id, instanceId, stepId } = await submitted()
    vi.mocked(queueNotification).mockClear()
    const decided = await app.inject({
      method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`, headers: auth(org, ['ADMIN'], approver),
      payload: { stepId, decision: 'REJECTED', comment: 'Liability cap must be 1x fees' },
    })
    expect(decided.statusCode).toBe(200)

    const a = await approvalOf(id)
    expect(a.current).toMatchObject({ outcome: 'returned', reason: 'Liability cap must be 1x fees', returnedBy: { id: approver, name: 'Priya Approver' } })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT')

    const note = vi.mocked(queueNotification).mock.calls.map(c => c[0]).find(n => n.type === 'APPROVAL_DECIDED')
    expect(note?.body).toContain('Priya Approver returned "MSA — Initech" for changes: “Liability cap must be 1x fees”')
    expect(note).toMatchObject({ resourceType: 'contract', resourceId: id, userId: owner })

    const timeline = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/timeline`, headers: auth(org, ['ADMIN'], owner) })).json().data as Array<{ action: string; metadata: Record<string, unknown>; userName: string | null }>
    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'APPROVAL_DECIDED', userName: 'Priya Approver', metadata: expect.objectContaining({ decision: 'REJECTED', reason: 'Liability cap must be 1x fees' }) }),
      expect.objectContaining({ action: 'CONTRACT_STATUS_CHANGED', metadata: expect.objectContaining({ from: 'PENDING_APPROVAL', to: 'DRAFT', source: 'approval', reason: 'Liability cap must be 1x fees' }) }),
    ]))

    // Sent again: the new request is current, the returned one is history.
    const again = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/submit-approval`, headers: auth(org, ['ADMIN'], owner), payload: {} })
    expect(again.statusCode).toBe(201)
    const b = await approvalOf(id)
    expect(b.current.outcome).toBe('pending')
    expect(b.history).toEqual([expect.objectContaining({ id: instanceId, outcome: 'returned', reason: 'Liability cap must be 1x fees' })])
  })

  it('another org\'s contract is not found', async () => {
    const { id } = await submitted()
    const other = await makeOrg('Other Org')
    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/approval`, headers: auth(other, ['ADMIN']) })
    expect(res.statusCode).toBe(404)
  })
})

describe('the playbook redline needs an analysed version', () => {
  it('refuses with the state, instead of a bare 400', async () => {
    const id = await makeContract(org, owner, { title: 'Unread', type: 'NDA' })
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, htmlContent: '<p>x</p>', plainText: 'x' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/redline-against-playbook`, headers: auth(org, ['ADMIN'], owner), payload: {} })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'NOT_ANALYSED', analysis: { kind: 'not_analysed' } })
    expect(res.json().detail).toMatch(/hasn’t been analysed yet/)
  })

  it('never says "No clause deviated" over zero clauses', () => {
    expect(redlineClearNote(0, 0)).toBe('Nothing to check — this contract has no analysed clauses.')
    expect(redlineClearNote(5, 0)).toBe('Nothing was checked — no playbook position covers these clauses.')
    expect(redlineClearNote(5, 5)).toBe('No clause deviated from the playbook.')
  })
})
