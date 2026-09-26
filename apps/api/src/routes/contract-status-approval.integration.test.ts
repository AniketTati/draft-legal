/**
 * X24 — approval statuses are the approval workflow's to set. PATCH
 * /contracts/:id and the agent's contract_update set_status allowed
 * PENDING_APPROVAL → APPROVED (or REJECTED) and moving into PENDING_APPROVAL
 * by hand, so anyone with edit:contract could mark a contract approved with no
 * approver and no recorded decision. The web UI offered none of these (A.3).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Status Approval Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await prisma.approvalStep.deleteMany({ where: { orgId: org } })
  await prisma.approvalInstance.deleteMany({ where: { orgId: org } })
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

describe('X24 follow-up — the other ways an approval status was set', () => {
  it('the CSV import refuses approval statuses row by row, and imports the rest', async () => {
    const boundary = `----it${randomBytes(8).toString('hex')}`
    const csv = 'title,status\nX24 Legacy Approved,approved\nX24 Legacy Pending,PENDING_APPROVAL\nX24 Legacy Signed,executed\n'
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`)
    const res = await app.inject({
      method: 'POST', url: '/api/v1/contracts/bulk-import',
      headers: { ...auth(org, ['LEGAL_OPS'], user), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
    })
    expect(res.statusCode).toBe(200)
    const { results } = res.json() as { results: Array<{ row: number; ok: boolean; error?: string }> }
    expect(results.map(r => r.ok)).toEqual([false, false, true])
    expect(results[0].error).toMatch(/approval workflow/)
    expect(await prisma.contract.count({ where: { orgId: org, title: { in: ['X24 Legacy Approved', 'X24 Legacy Pending'] } } })).toBe(0)
    expect(await prisma.contract.count({ where: { orgId: org, title: 'X24 Legacy Signed', status: 'EXECUTED' } })).toBe(1)
  })

  it('the agent\'s status undo puts back only what it changed', async () => {
    const undo = (contractId: string, snapshot: Record<string, unknown>) => app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_update/undo',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, contractId, action: 'set_status', snapshot },
    })
    // An exact undo works.
    const a = await makeContract(org, user, { status: 'PENDING_REVIEW' })
    const set = await tool(a, 'UNDER_NEGOTIATION')
    expect(set.statusCode).toBe(200)
    expect((await undo(a, set.json().snapshot)).statusCode).toBe(200)
    expect(await statusOf(a)).toBe('PENDING_REVIEW')

    // Once the status has moved on, the undo does nothing.
    const b = await makeContract(org, user, { status: 'PENDING_REVIEW' })
    const snapshot = (await tool(b, 'UNDER_NEGOTIATION')).json().snapshot
    await prisma.contract.update({ where: { id: b }, data: { status: 'DRAFT' } })
    expect((await undo(b, snapshot)).statusCode).toBe(409)
    expect(await statusOf(b)).toBe('DRAFT')

    // An older snapshot (no `after`) can't restore an approval status by hand.
    const c = await makeContract(org, user, { status: 'PENDING_SIGNATURE' })
    expect((await undo(c, { status: 'APPROVED' })).statusCode).toBe(409)
    expect(await statusOf(c)).toBe('PENDING_SIGNATURE')
  })

  it('a late approval decision doesn\'t overwrite a contract that has moved on', async () => {
    const approver = await makeUser(org)
    const workflowDefinitionId = await makeWorkflow(org, user, approver)
    for (const decision of ['APPROVED', 'REJECTED']) {
      const contract = await makeContract(org, user, { title: `X24 late ${decision}`, status: 'DRAFT' })
      const submitted = await app.inject({
        method: 'POST', url: `/api/v1/contracts/${contract}/submit-approval`,
        headers: auth(org, ['ADMIN'], user), payload: { workflowDefinitionId },
      })
      expect(submitted.statusCode).toBe(201)
      const { instanceId, steps } = submitted.json() as { instanceId: string; steps: Array<{ id: string }> }
      // Signed meanwhile, the approval still open.
      await prisma.contract.update({ where: { id: contract }, data: { status: 'EXECUTED' } })
      const decided = await app.inject({
        method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`,
        headers: auth(org, ['ADMIN'], approver), payload: { stepId: steps[0].id, decision, comment: 'Late decision' },
      })
      expect(decided.statusCode, decision).toBe(200)
      expect(await statusOf(contract), decision).toBe('EXECUTED')
      expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instanceId } })).status, decision).toBe(decision)
    }
  })
})

describe('X42 — an approval covers the terms it approved', () => {
  async function approved(): Promise<string> {
    const id = await makeContract(org, user, { status: 'APPROVED', type: 'NDA' })
    await prisma.contract.update({ where: { id }, data: { value: 1, currency: 'USD' } })
    return id
  }
  const edit = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: auth(org, ['LEGAL_OPS'], user), payload })

  it('changing the type, value or currency returns an approved contract to DRAFT', async () => {
    for (const change of [{ value: 2_000_000 }, { type: 'MSA' }, { currency: 'EUR' }]) {
      const id = await approved()
      expect((await edit(id, change)).statusCode, JSON.stringify(change)).toBe(200)
      expect(await statusOf(id), JSON.stringify(change)).toBe('DRAFT')
    }
  })

  it('other edits, and the same terms sent again, leave it APPROVED', async () => {
    const id = await approved()
    expect((await edit(id, { title: 'Renamed', type: 'NDA', value: 1, currency: 'USD' })).statusCode).toBe(200)
    expect(await statusOf(id)).toBe('APPROVED')
  })

  it('a term change together with a status change is refused', async () => {
    const id = await approved()
    expect((await edit(id, { value: 5, status: 'EXECUTED' })).statusCode).toBe(409)
    expect(await statusOf(id)).toBe('APPROVED')
  })

  it('X56 — retyping from the contract page or through the agent returns it to DRAFT, on the record', async () => {
    const withText = async () => {
      const id = await approved()
      await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, plainText: 'Mutual NDA.', htmlContent: '<p>Mutual NDA.</p>', createdById: user } })
      return id
    }
    const audited = (id: string) => prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' } })

    const viaPage = await withText()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${viaPage}/retype`, headers: auth(org, ['LEGAL_OPS'], user), payload: { contractType: 'MSA' },
    })
    expect(res.statusCode).toBe(200)
    expect(await statusOf(viaPage)).toBe('DRAFT')
    expect((await audited(viaPage)).metadata).toEqual({ action: 'retype', typeFrom: 'NDA', typeTo: 'MSA', statusFrom: 'APPROVED', statusTo: 'DRAFT' })

    const viaAgent = await withText()
    const applied = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_update',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, userId: user, contractId: viaAgent, action: 'retype', payload: { type: 'MSA' } },
    })
    expect(applied.statusCode).toBe(200)
    expect(applied.json().diff).toContainEqual({ field: 'status', before: 'APPROVED', after: 'DRAFT' })
    expect(await statusOf(viaAgent)).toBe('DRAFT')
    expect((await audited(viaAgent)).metadata).toMatchObject({ action: 'retype', source: 'agent', statusFrom: 'APPROVED', statusTo: 'DRAFT' })
  })

  it('X56 — the same type again changes nothing, and retyping a draft keeps it a draft', async () => {
    const id = await approved()
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, plainText: 'Mutual NDA.', htmlContent: '<p>Mutual NDA.</p>', createdById: user } })
    const retype = (contractType: string) => app.inject({
      method: 'POST', url: `/api/v1/contracts/${id}/retype`, headers: auth(org, ['LEGAL_OPS'], user), payload: { contractType },
    })
    expect((await retype('NDA')).statusCode).toBe(200)
    expect(await statusOf(id)).toBe('APPROVED')
    expect(await prisma.auditEvent.count({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' } })).toBe(0)
    await prisma.contract.update({ where: { id }, data: { status: 'DRAFT' } })
    expect((await retype('MSA')).statusCode).toBe(200)
    expect(await statusOf(id)).toBe('DRAFT')
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' } })).metadata)
      .toEqual({ action: 'retype', typeFrom: 'NDA', typeTo: 'MSA' })
  })

  it('a new document returns it to DRAFT', async () => {
    const id = await approved()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${id}/html-version`, headers: auth(org, ['LEGAL_OPS'], user),
      payload: { htmlContent: '<p>Liability is uncapped.</p>' },
    })
    expect(res.statusCode).toBe(201)
    expect(await statusOf(id)).toBe('DRAFT')
  })
})
