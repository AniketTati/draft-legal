/**
 * docs/41 P0.8/P0.10 — signing needs approval (unless the org says
 * otherwise), a voided request has a way back, and every status change is on
 * the record, executedAt included.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueNotification: vi.fn(),
  queueSigningReminder: vi.fn(async () => ({ id: 'x' })),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { createAuditEvent } from '../lib/audit.js'

let app: TestApp
let org: string, user: string

async function withVersion(status: string) {
  const id = await makeContract(org, user, { title: `Gate ${status}`, type: 'NDA', status })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: '<p>Terms</p>', plainText: 'Terms' } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  return { id, versionId: v.id }
}

const send = (id: string) => app.inject({
  method: 'POST', url: `/api/v1/contracts/${id}/send-for-signature`, headers: auth(org, ['ADMIN'], user),
  payload: { signers: [{ name: 'Pat', email: 'pat@cp.test' }] },
})
const statusEvents = (id: string) => prisma.auditEvent.findMany({ where: { orgId: org, resourceId: id, action: 'STAGE_CHANGED' }, orderBy: { createdAt: 'asc' } })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Signing Gate Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('the signing gate', () => {
  it('refuses a contract that hasn\'t been approved, with the reason', async () => {
    const { id } = await withVersion('DRAFT')
    const res = await send(id)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'APPROVAL_REQUIRED', detail: 'This contract needs approval before it can be sent for signature. Send it for approval first.' })
    expect(await prisma.signatureRequest.count({ where: { contractId: id } })).toBe(0)
    const pending = await withVersion('PENDING_APPROVAL')
    expect((await send(pending.id)).json().detail).toMatch(/still waiting for approval/)
  })

  it('sends an approved contract, on the record as a status change', async () => {
    const { id, versionId } = await withVersion('APPROVED')
    const res = await send(id)
    expect(res.statusCode).toBe(201)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_SIGNATURE')
    const [e] = await statusEvents(id)
    expect(e.metadata).toMatchObject({ from: 'APPROVED', to: 'PENDING_SIGNATURE', source: 'signature', versionId })
  })

  it('an org that allows signing without approval can — and only an admin of the organization can say so', async () => {
    const legalOps = await app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: auth(org, ['LEGAL_OPS'], user), payload: { settings: { allowSignWithoutApproval: true } } })
    expect(legalOps.statusCode).toBe(403)
    const bad = await app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: auth(org, ['ADMIN'], user), payload: { settings: { allowSignWithoutApproval: 'yes' } } })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: auth(org, ['ADMIN'], user), payload: { settings: { allowSignWithoutApproval: true } } })
    expect(ok.statusCode).toBe(200)
    const { id } = await withVersion('DRAFT')
    expect((await send(id)).statusCode).toBe(201)
    await app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: auth(org, ['ADMIN'], user), payload: { settings: { allowSignWithoutApproval: false } } })
  })
})

describe('taking a contract back from signature', () => {
  it('after a void, goes back to where it was worked on, with a reason, and needs approval again', async () => {
    const { id } = await withVersion('UNDER_NEGOTIATION')
    // Its history: negotiated, sent for approval (recorded before stages, as
    // a status change), approved, sent for signature.
    await createAuditEvent({ orgId: org, userId: user, action: 'CONTRACT_STATUS_CHANGED' as never, resourceType: 'contract', resourceId: id, metadata: { from: 'UNDER_NEGOTIATION', to: 'PENDING_APPROVAL', source: 'approval' } })
    await prisma.contract.update({ where: { id }, data: { status: 'APPROVED' } })
    const sent = await send(id)
    expect(sent.statusCode).toBe(201)

    const early = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/revert-signature`, headers: auth(org, ['ADMIN'], user), payload: { reason: 'Wrong signer' } })
    expect(early.statusCode).toBe(409)
    expect(early.json().code).toBe('SIGNATURE_PENDING')

    const voided = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/signature-requests/${sent.json().id}/void`, headers: auth(org, ['ADMIN'], user), payload: {} })
    expect(voided.statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/revert-signature`, headers: auth(org, ['ADMIN'], user), payload: {} })).statusCode).toBe(400)

    const back = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/revert-signature`, headers: auth(org, ['ADMIN'], user), payload: { reason: 'The counterparty wants a different signer' } })
    expect(back.statusCode).toBe(200)
    expect(back.json().status).toBe('UNDER_NEGOTIATION')
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).status).toBe('UNDER_NEGOTIATION')
    const last = (await statusEvents(id)).at(-1)
    expect(last?.metadata).toMatchObject({ from: 'PENDING_SIGNATURE', to: 'UNDER_NEGOTIATION', source: 'revert', reason: 'The counterparty wants a different signer', approvalsReset: true, signatureRequestStatus: 'VOIDED' })
    // Its approval no longer stands.
    expect((await send(id)).json().code).toBe('APPROVAL_REQUIRED')
  })
})

describe('executedAt (docs/41 P0.10)', () => {
  it('is set when the status becomes EXECUTED, with the change on the record', async () => {
    const { id } = await withVersion('APPROVED')
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: auth(org, ['ADMIN'], user), payload: { status: 'EXECUTED' } })
    expect(res.statusCode).toBe(200)
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(c.executedAt).toBeInstanceOf(Date)
    const [e] = await statusEvents(id)
    expect(e.metadata).toMatchObject({ from: 'APPROVED', to: 'EXECUTED', source: 'manual' })
  })
})
