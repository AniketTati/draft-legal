/**
 * docs/41 Parts 6, 12, 18 — what the stage model shows and sends:
 *   - the database keeps status and stage agreeing (the contracts_stage_sync
 *     trigger, for writers that still set only a status);
 *   - the inbox: one row per contract, the badge equal to the list, waiting
 *     on others, and the Team view's filters;
 *   - the History: an approval decision, a counterparty's version and a
 *     signature each exactly once, and its filters;
 *   - sending to the counterparty hands them the turn; the date job;
 *     a revert to Approve when the approval stands;
 *   - contract.stage_changed and contract.turn_changed reach subscribers;
 *   - "Decline request" needs and keeps a reason; a request becomes a draft
 *     through the Request stage.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const { delivered } = vi.hoisted(() => ({ delivered: [] as Array<{ event: string; payload: Record<string, unknown> }> }))
vi.mock('../lib/queue.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(async () => ({ id: 'job' })) : v])),
    queueWebhookDelivery: async (job: { event: string; payload: Record<string, unknown> }) => { delivered.push(job); return {} },
  }
})

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { STAGES, STAGE_STATES, statusFor, stageForStatus, turnFor, type StageState } from '@clm/types'
import { transition } from './lifecycle.js'
import { scanStageDates } from './lifecycle-dates.js'

let app: TestApp
let org: string, owner: string, approver: string, other: string

const H = (user: string, roles = ['ADMIN']) => auth(org, roles, user)
const contractOf = (id: string) => prisma.contract.findUniqueOrThrow({ where: { id } })
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 25 })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Lifecycle Views Org')
  owner = await makeUser(org)
  approver = await makeUser(org)
  other = await makeUser(org)
  await prisma.user.update({ where: { id: approver }, data: { name: 'Priya Approver' } })
})

afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { orgId: org } })
  await prisma.contractRequest.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

async function withVersion(status = 'DRAFT', by = owner) {
  const id = await makeContract(org, by, { title: `Views ${Math.random().toString(36).slice(2, 7)}`, status })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: by, plainText: 'Terms.', htmlContent: '<p>Terms.</p>' } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  return { id, v1: v.id }
}

async function workflow(approverId: string) {
  return (await prisma.workflowDefinition.create({
    data: { orgId: org, name: `WF ${Math.random()}`, createdById: owner, isActive: true, triggerRules: {}, steps: [{ order: 0, name: 'Legal', approverId, executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48 }] as never },
  })).id
}
const submit = async (id: string, wf: string) => (await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/submit-approval`, headers: H(owner), payload: { workflowDefinitionId: wf } })).json() as { instanceId: string; steps: Array<{ id: string }> }

describe('status and stage agree in the database', () => {
  it('a writer that sets only a status gets the stage it stands for; a stage move sets the status', async () => {
    for (const status of ['DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL', 'APPROVED', 'PENDING_SIGNATURE', 'EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED']) {
      const id = await makeContract(org, owner, { status })
      const c = await contractOf(id)
      const p = stageForStatus(status)
      expect({ stage: c.stage, stageState: c.stageState, turn: c.turn }, status).toEqual({ stage: p.stage, stageState: p.state, turn: turnFor(p.stage, p.state) })
      // And an update of the status alone moves the stage.
      await prisma.contract.update({ where: { id }, data: { status: 'DRAFT' } })
      expect((await contractOf(id)).stage).toBe('draft')
    }
    const id = await makeContract(org, owner)
    for (const stage of STAGES) {
      for (const state of STAGE_STATES[stage] as readonly StageState[]) {
        await prisma.contract.update({ where: { id }, data: { stage, stageState: state } })
        expect((await contractOf(id)).status, `${stage}/${state}`).toBe(statusFor(stage, state))
      }
    }
  })
})

describe('the inbox (docs/41 Part 6)', () => {
  it('counts contracts, not steps; the badge is the list\'s length, before and after a decision', async () => {
    const { id } = await withVersion()
    const s = await submit(id, await workflow(approver))
    // A second thing for the same person on the same contract: an exception to decide.
    await prisma.approvalStep.create({ data: { orgId: org, kind: 'clause_exception', contractId: id, stepOrder: 0, stepName: 'Exception: Liability cap', approverId: approver, status: 'PENDING', requestedById: owner, requestNote: 'Strategic' } })
    const inbox = (await app.inject({ method: 'GET', url: '/api/v1/inbox', headers: H(approver) })).json()
    const rows = inbox.data.filter((d: { contractId: string }) => d.contractId === id)
    expect(rows).toHaveLength(1)
    expect(rows[0].actions.map((a: { kind: string }) => a.kind)).toEqual(['approve', 'decide_exception'])
    expect(rows[0].primary.kind).toBe('approve')
    const stats = (await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: H(approver) })).json()
    expect(stats.pendingApprovals).toBe(inbox.total)
    expect(inbox.counts.mine).toBe(inbox.total)
    expect((await app.inject({ method: 'GET', url: '/api/v1/inbox/count', headers: H(approver) })).json().mine).toBe(inbox.total)

    await app.inject({ method: 'POST', url: `/api/v1/approvals/${s.instanceId}/decide`, headers: H(approver), payload: { stepId: s.steps[0].id, decision: 'APPROVED' } })
    const after = (await app.inject({ method: 'GET', url: '/api/v1/inbox', headers: H(approver) })).json()
    expect(after.data.find((d: { contractId: string }) => d.contractId === id)?.actions.map((a: { kind: string }) => a.kind)).toEqual(['decide_exception'])
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: H(approver) })).json().pendingApprovals).toBe(after.total)
    // The owner's move now: send it for signature.
    const mine = (await app.inject({ method: 'GET', url: '/api/v1/inbox', headers: H(owner) })).json()
    expect(mine.data.find((d: { contractId: string }) => d.contractId === id)?.primary.kind).toBe('send_for_signature')
  })

  it('waiting on others: what I own that someone else has, who and since when', async () => {
    const { id } = await withVersion()
    await submit(id, await workflow(approver))
    const waiting = (await app.inject({ method: 'GET', url: '/api/v1/inbox?view=waiting', headers: H(owner) })).json()
    const row = waiting.data.find((d: { contractId: string }) => d.contractId === id)
    expect(row.waitingOn).toMatchObject({ who: 'Approvers', names: ['Priya Approver'] })
    expect(row.approvals).toEqual({ approved: 0, total: 1 })
    expect(row.line).toMatch(/^Approve · Waiting for approval · Approvers' turn/)
  })

  it('Team: for those who configure workflows; stuck, aging and stage filters; never a deleted or diligence-room contract', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/inbox?view=team', headers: H(approver, ['APPROVER']) })).statusCode).toBe(403)
    // Stuck: its approver left.
    const gone = await makeUser(org)
    const stuck = await withVersion()
    await submit(stuck.id, await workflow(gone))
    await prisma.user.update({ where: { id: gone }, data: { status: 'DEACTIVATED' } })
    const fine = await withVersion()
    await submit(fine.id, await workflow(approver))
    const deleted = await withVersion()
    await submit(deleted.id, await workflow(gone))
    await prisma.contract.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
    const room = await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Room', createdById: owner } })
    const inRoom = await withVersion()
    await submit(inRoom.id, await workflow(gone))
    await prisma.contract.update({ where: { id: inRoom.id }, data: { diligenceRoomId: room.id } })

    const team = (q: string) => app.inject({ method: 'GET', url: `/api/v1/inbox?view=team${q}`, headers: H(owner, ['LEGAL_OPS']) }).then(r => r.json())
    const ids = (r: { data: Array<{ contractId: string }> }) => r.data.map(d => d.contractId)
    // Waiting for approval with no request open (set by hand long ago): stuck too.
    const orphan = await withVersion('PENDING_APPROVAL')
    const stuckOnly = await team('&stuck=1')
    expect(ids(stuckOnly)).toContain(stuck.id)
    expect(ids(stuckOnly)).not.toContain(fine.id)
    expect(stuckOnly.data.find((d: { contractId: string }) => d.contractId === orphan.id)?.stuck).toMatch(/no request for approval is open/)
    expect(stuckOnly.data.find((d: { contractId: string }) => d.contractId === stuck.id).stuck).toMatch(/can’t act/)
    const all = await team('')
    expect(ids(all)).toEqual(expect.arrayContaining([stuck.id, fine.id]))
    expect(ids(all)).not.toContain(deleted.id)
    expect(ids(all)).not.toContain(inRoom.id)
    expect(ids(await team('&stage=negotiate'))).not.toContain(fine.id)
    await prisma.contract.update({ where: { id: fine.id }, data: { turnSince: new Date(Date.now() - 10 * 86_400_000) } })
    const aging = await team('&agingDays=7')
    expect(ids(aging)).toContain(fine.id)
    expect(ids(aging)).not.toContain(stuck.id)
    await prisma.diligenceRoom.delete({ where: { id: room.id } }).catch(() => {})
  })
})

describe('History (docs/41 Part 12)', () => {
  it('a decision with its reason, a counterparty version and a signature each appear once; filters narrow it', async () => {
    const { id, v1 } = await withVersion()
    const s = await submit(id, await workflow(approver))
    await app.inject({ method: 'POST', url: `/api/v1/approvals/${s.instanceId}/decide`, headers: H(approver), payload: { stepId: s.steps[0].id, decision: 'RETURNED', comment: 'Fix the cap' } })
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: 'portal:link9', plainText: 'Theirs.', htmlContent: '<p>Theirs.</p>' } })
    const sr = await prisma.signatureRequest.create({ data: { orgId: org, contractId: id, versionId: v2.id, createdById: owner, status: 'COMPLETED' } })
    const signer = await prisma.signer.create({ data: { signatureRequestId: sr.id, email: 'pat@cp.test', name: 'Pat Signer', token: `t-${Math.random()}` } })
    await prisma.signatureEvent.create({ data: { signatureRequestId: sr.id, signerId: signer.id, kind: 'SIGNED' } })

    const h = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/history`, headers: H(owner) })).json()
    const once = (pred: (i: { kind: string; title: string; detail?: string | null }) => boolean) => h.data.filter(pred)
    expect(once(i => i.kind === 'approval_decided')).toEqual([expect.objectContaining({ detail: 'Fix the cap', title: expect.stringContaining('Priya Approver returned it') })])
    expect(once(i => i.kind === 'version' && i.title === 'The counterparty sent v2')).toHaveLength(1)
    expect(h.data.find((i: { kind: string; version?: { number: number } }) => i.kind === 'version' && i.version?.number === 2).version).toMatchObject({ previousId: v1, previousNumber: 1, fromCounterparty: true })
    expect(once(i => i.kind === 'signature_signed' && i.title === 'Pat Signer signed')).toHaveLength(1)
    expect(once(i => i.kind === 'stage' && /Draft · Returned for changes/.test(i.title))).toHaveLength(1)

    const approvals = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/history?filter=approvals`, headers: H(owner) })).json()
    expect(approvals.data.every((i: { group: string }) => i.group === 'approvals')).toBe(true)
    expect(approvals.counts.all).toBe(h.total)
    const sigs = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/history?filter=signatures`, headers: H(owner) })).json()
    expect(sigs.data.map((i: { kind: string }) => i.kind)).toEqual(['signature_signed'])
  })
})

describe('turn, dates and reverts (docs/41 Part 18)', () => {
  it('sending to the counterparty hands them the turn, and subscribers hear of the stage and the turn', async () => {
    await prisma.webhook.create({ data: { orgId: org, name: 'stages', url: 'https://example.test/hook', secret: 's', createdById: owner, events: ['contract.stage_changed', 'contract.turn_changed'] } })
    const { id } = await withVersion()
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/share`, headers: H(owner), payload: { permissions: ['read', 'upload'] } })
    expect(res.statusCode, res.body).toBe(201)
    expect(await contractOf(id)).toMatchObject({ stage: 'negotiate', stageState: 'with_counterparty', turn: 'counterparty', status: 'UNDER_NEGOTIATION' })
    await eventually(() => {
      expect(delivered.find(d => d.event === 'contract.stage_changed' && d.payload.contractId === id)?.payload).toMatchObject({ from: { stage: 'draft', state: 'drafting' }, to: { stage: 'negotiate', state: 'with_counterparty' }, status: 'UNDER_NEGOTIATION', source: 'send' })
      expect(delivered.find(d => d.event === 'contract.turn_changed' && d.payload.contractId === id)?.payload).toMatchObject({ from: 'internal', to: 'counterparty' })
    })
    const banner = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/stage`, headers: H(owner) })).json()
    expect(banner.line).toMatch(/^Negotiate · Counterparty's turn/)
    expect(banner.moves.map((m: { label: string }) => m.label)).toContain('It’s our turn')
    // By hand, back to us.
    const back = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/stage`, headers: H(owner), payload: { stage: 'negotiate', state: 'with_us' } })
    expect(back.statusCode).toBe(200)
    expect((await contractOf(id)).turn).toBe('internal')
    // Active → Negotiate is never a move.
    const active = await withVersion('EXECUTED')
    const reopen = await app.inject({ method: 'POST', url: `/api/v1/contracts/${active.id}/stage`, headers: H(owner), payload: { stage: 'negotiate', state: 'with_us', reason: 'more changes' } })
    expect(reopen.statusCode).toBe(409)
    expect(reopen.json().detail).toMatch(/amendment/)
  })

  it('the date job: expiring, expired, renewed on its own, and back when the date moves', async () => {
    const day = 86_400_000
    const make = async (expiry: number, status = 'EXECUTED', autoRenew = false) => {
      const { id } = await withVersion(status)
      await prisma.contract.update({ where: { id }, data: { expiryDate: new Date(Date.now() + expiry * day), ...(autoRenew && { keyTerms: { autoRenew: true } }) } })
      return id
    }
    const soon = await make(10)
    const past = await make(-2)
    const renews = await make(-2, 'EXECUTED', true)
    const later = await make(200)
    const extended = await make(30, 'EXPIRED')
    const r = await scanStageDates({ orgId: org })
    expect(r.errors).toEqual([])
    expect((await contractOf(soon)).stageState).toBe('expiring')
    expect(await contractOf(past)).toMatchObject({ stage: 'closed', stageState: 'expired', status: 'EXPIRED' })
    expect(await contractOf(renews)).toMatchObject({ stage: 'active', stageState: 'auto_renewed' })
    expect((await contractOf(later)).stageState).toBe('active')
    expect(await contractOf(extended)).toMatchObject({ stage: 'active', status: 'EXECUTED' })
    const e = await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: past, action: 'STAGE_CHANGED' } })
    expect(e.metadata).toMatchObject({ source: 'dates', toState: 'expired' })
  })

  it('after a void, back to Approve while the approval stands — not once the document changed', async () => {
    const { id } = await withVersion()
    const s = await submit(id, await workflow(approver))
    await app.inject({ method: 'POST', url: `/api/v1/approvals/${s.instanceId}/decide`, headers: H(approver), payload: { stepId: s.steps[0].id, decision: 'APPROVED' } })
    const send = () => app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/send-for-signature`, headers: H(owner), payload: { signers: [{ name: 'Pat', email: 'pat@cp.test' }] } })
    const sent = await send()
    expect(sent.statusCode, sent.body).toBe(201)
    expect((await contractOf(id)).turn).toBe('signers')
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/signature-requests/${sent.json().id}/void`, headers: H(owner), payload: {} })
    expect(await contractOf(id)).toMatchObject({ stage: 'sign', stageState: 'voided', turn: 'internal' })
    const back = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/revert-signature`, headers: H(owner), payload: { reason: 'Wrong signer', to: 'approve' } })
    expect(back.statusCode, back.body).toBe(200)
    expect(await contractOf(id)).toMatchObject({ stage: 'approve', stageState: 'approved', status: 'APPROVED' })
    // Sent again, voided again, and now the document changed: no way back to Approve.
    const again = await send()
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/signature-requests/${again.json().id}/void`, headers: H(owner), payload: {} })
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: owner, plainText: 'New.', htmlContent: '<p>New.</p>' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
    const refused = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/revert-signature`, headers: H(owner), payload: { reason: 'Changed', to: 'approve' } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('NO_STANDING_APPROVAL')
  })
})

describe('requests (docs/41 Parts 4, 18)', () => {
  it('"Decline request" needs a reason and keeps it; a request becomes a draft through the Request stage', async () => {
    const make = () => prisma.contractRequest.create({ data: { orgId: org, title: 'NDA for Acme', type: 'NDA', requestedById: other, description: 'Mutual NDA' } })
    const declined = await make()
    const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/v1/requests/${id}`, headers: H(owner, ['LEGAL_OPS']), payload })
    expect((await patch(declined.id, { status: 'REJECTED' })).statusCode).toBe(409)
    expect((await patch(declined.id, { status: 'REJECTED', rejectionReason: 'We already have an NDA with Acme' })).statusCode).toBe(200)
    expect(await prisma.contractRequest.findUniqueOrThrow({ where: { id: declined.id } })).toMatchObject({ status: 'REJECTED', rejectionReason: 'We already have an NDA with Acme' })
    expect((await patch(declined.id, { status: 'ACCEPTED' })).statusCode).toBe(409)

    const accepted = await make()
    await prisma.contractRequest.update({ where: { id: accepted.id }, data: { attachments: [{ s3Key: 'k', mimeType: 'application/pdf', filename: 'nda.pdf', size: 1 }] } })
    const res = await app.inject({ method: 'POST', url: `/api/v1/requests/${accepted.id}/convert`, headers: H(owner), payload: {} })
    expect(res.statusCode, res.body).toBe(201)
    const c = await contractOf(res.json().contractId)
    expect(c).toMatchObject({ stage: 'draft', stageState: 'drafting', status: 'DRAFT' })
    const e = await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: c.id, action: 'STAGE_CHANGED' } })
    expect(e.metadata).toMatchObject({ fromStage: 'request', toStage: 'draft', requestId: accepted.id })
    const banner = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${c.id}/stage`, headers: H(owner) })).json()
    expect(banner.progress[0]).toMatchObject({ stage: 'request', status: 'done' })
  })
})
