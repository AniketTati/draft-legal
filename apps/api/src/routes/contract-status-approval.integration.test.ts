/**
 * X24 — approval statuses are the approval workflow's to set. PATCH
 * /contracts/:id and the agent's contract_update set_status allowed
 * PENDING_APPROVAL → APPROVED (or REJECTED) and moving into PENDING_APPROVAL
 * by hand, so anyone with edit:contract could mark a contract approved with no
 * approver and no recorded decision. The web UI offered none of these (A.3).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Status Approval Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

const patch = (id: string, status: string) =>
  app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: auth(org, ['LEGAL_OPS'], user), payload: { status } })
const tool = (contractId: string, status: string) => app.inject({
  method: 'POST', url: '/api/internal/ai/tools/contract_update',
  headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
  payload: { orgId: org, userId: user, contractId, action: 'set_status', payload: { status } },
})
const statusOf = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).status

describe('approval statuses can\'t be set by hand', () => {
  it('REST: a pending approval can\'t be marked APPROVED or REJECTED', async () => {
    const id = await makeContract(org, user, { status: 'PENDING_APPROVAL' })
    for (const to of ['APPROVED', 'REJECTED']) {
      const res = await patch(id, to)
      expect(res.statusCode, to).toBe(409)
      expect(res.json().detail).toMatch(/approval workflow/)
    }
    expect(await statusOf(id)).toBe('PENDING_APPROVAL')
  })

  it('REST: a draft can\'t be moved into PENDING_APPROVAL without an approval', async () => {
    const id = await makeContract(org, user, { status: 'DRAFT' })
    expect((await patch(id, 'PENDING_APPROVAL')).statusCode).toBe(409)
    expect(await statusOf(id)).toBe('DRAFT')
  })

  it('the agent set_status follows the same table', async () => {
    const id = await makeContract(org, user, { status: 'PENDING_APPROVAL' })
    expect((await tool(id, 'APPROVED')).statusCode).toBe(409)
    expect(await statusOf(id)).toBe('PENDING_APPROVAL')
  })

  it('ordinary manual transitions still work', async () => {
    const approved = await makeContract(org, user, { status: 'APPROVED' })
    expect((await patch(approved, 'EXECUTED')).statusCode).toBe(200)
    const review = await makeContract(org, user, { status: 'PENDING_REVIEW' })
    expect((await tool(review, 'UNDER_NEGOTIATION')).statusCode).toBe(200)
  })
})
