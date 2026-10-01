/**
 * docs/41 Parts 4, 6, 7, 18 — approvals on the stage model, against the database:
 *   - Return (changes needed) and Decline (do not proceed): the reason in
 *     the banner, the notification and the history; the stage back; a
 *     resubmission is a new request, and the history keeps both;
 *   - pooled role steps (first holder to decide claims it), and step orders
 *     with gaps;
 *   - the reset rules per mode, a counterparty's version withdrawing a
 *     submission, a later approval that still stands;
 *   - clause exceptions: no approver named, requested, approved, declined,
 *     their effect on the policy and on the signing gate, reset by their clause.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/queue.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(async () => ({ id: 'job' })) : v]))
})

import { getApp, closeApp, makeOrg, makeUser, makeContract, grantRole, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { queueNotification } from './queue.js'
import { transition } from './lifecycle.js'
import { onApprovalChange } from './approval-reset.js'
import { policy } from './recommendation-guard.js'

let app: TestApp
let org: string, owner: string, approver: string, second: string, clauseApprover: string

const H = (user: string, roles = ['ADMIN']) => auth(org, roles, user)
const contractOf = (id: string) => prisma.contract.findUniqueOrThrow({ where: { id } })
const notes = () => vi.mocked(queueNotification).mock.calls.map(c => c[0] as { userId: string; title: string; body: string })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Approval Lifecycle Org')
  owner = await makeUser(org)
  approver = await makeUser(org)
  second = await makeUser(org)
  clauseApprover = await makeUser(org)
  await prisma.user.update({ where: { id: approver }, data: { name: 'Priya Approver' } })
  await prisma.user.update({ where: { id: second }, data: { name: 'Sam Second' } })
})

afterAll(async () => {
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } }).catch(() => {})
  await cleanupAll()
  await closeApp()
})

/** A workflow with these steps (each `{ order, approverId | roleRequired, resetOn? }`). */
async function workflow(steps: Array<Record<string, unknown>>): Promise<string> {
  return (await prisma.workflowDefinition.create({
    data: {
      orgId: org, name: `WF ${Math.random()}`, createdById: owner, isActive: true, triggerRules: {},
      steps: steps.map(s => ({ name: `Step ${s.order}`, executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48, ...s })) as never,
    },
  })).id
}

/** A contract on v1 with these clauses, in Draft or Negotiate. */
async function contract(stage: 'draft' | 'negotiate' = 'draft', clauses: Array<[string, string]> = [['limitation_of_liability', 'Liability is capped at fees paid.'], ['confidentiality', 'Each party keeps secrets.']]) {
  const id = await makeContract(org, owner, { title: `Lifecycle ${Math.random().toString(36).slice(2, 7)}`, type: 'MSA' })
  const v = await version(id, 1, clauses)
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v } })
  if (stage === 'negotiate') await transition({ orgId: org, contractId: id, to: { stage: 'negotiate', state: 'with_us' }, source: 'manual', userId: owner })
  return id
}

async function version(contractId: string, n: number, clauses: Array<[string, string]>, createdById = owner): Promise<string> {
  const text = clauses.map(c => c[1]).join('\n')
  const v = await prisma.contractVersion.create({ data: { contractId, versionNumber: n, createdById, plainText: text, htmlContent: `<p>${text}</p>` } })
  for (const [i, [clauseType, content]] of clauses.entries()) {
    await prisma.contractClause.create({ data: { versionId: v.id, clauseType, content, sectionRef: String(i + 1), sortOrder: i } })
  }
  return v.id
}

const submit = (id: string, workflowDefinitionId: string) => app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/submit-approval`, headers: H(owner), payload: { workflowDefinitionId } })
const decide = (instanceId: string, stepId: string, as: string, decision: string, comment?: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`, headers: H(as), payload: { stepId, decision, comment, ...extra } })
const pendingSteps = (instanceId: string) => prisma.approvalStep.findMany({ where: { approvalInstanceId: instanceId, status: 'PENDING' }, orderBy: { stepOrder: 'asc' } })

/** Submitted and approved by every step in turn. */
async function approved(id: string, wf: string): Promise<string> {
  const s = await submit(id, wf)
  expect(s.statusCode, s.body).toBe(201)
  const instanceId = s.json().instanceId as string
  for (let i = 0; i < 5; i++) {
    const [step] = await pendingSteps(instanceId)
    if (!step) break
    expect((await decide(instanceId, step.id, step.approverId!, 'APPROVED')).statusCode).toBe(200)
  }
  expect((await contractOf(id)).stageState).toBe('approved')
  return instanceId
}

describe('Return and Decline (docs/41 Part 4)', () => {
  it('a return needs a reason; with one, the contract goes back to Negotiate, the owner\'s turn, and the reason is in the banner, the notification and the history', async () => {
    const wf = await workflow([{ order: 0, approverId: approver }])
    const id = await contract('negotiate')
    const s = await submit(id, wf)
    const instanceId = s.json().instanceId as string
    const stepId = s.json().steps[0].id as string
    expect(await contractOf(id)).toMatchObject({ stage: 'approve', stageState: 'pending', turn: 'approvers', status: 'PENDING_APPROVAL' })

    expect((await decide(instanceId, stepId, approver, 'RETURNED')).statusCode).toBe(400)
    vi.mocked(queueNotification).mockClear()
    const r = await decide(instanceId, stepId, approver, 'RETURNED', 'Liability cap must be 1x fees')
    expect(r.statusCode, r.body).toBe(200)

    expect(await contractOf(id)).toMatchObject({ stage: 'negotiate', stageState: 'returned', turn: 'internal', turnOwnerId: owner, status: 'UNDER_NEGOTIATION' })
    const banner = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/stage`, headers: H(owner) })).json()
    expect(banner.returned).toMatchObject({ outcome: 'returned', reason: 'Liability cap must be 1x fees', by: { name: 'Priya Approver' } })
    expect(banner.next).toMatchObject({ kind: 'resubmit', label: 'Fix and resubmit' })
    expect(banner.line).toBe('Negotiate · Returned for changes · Our turn')
    const note = notes().find(n => n.userId === owner && n.title === 'Contract returned for changes')
    expect(note?.body).toContain('Priya Approver returned')
    expect(note?.body).toContain('“Liability cap must be 1x fees”')
    expect(note?.body).toContain('back in Negotiate')
    const history = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/history?filter=approvals`, headers: H(owner) })).json()
    const decided = history.data.filter((h: { kind: string }) => h.kind === 'approval_decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({ title: 'Priya Approver returned it for changes (Step 0)', detail: 'Liability cap must be 1x fees' })

    // The owner's inbox: fix and resubmit, with the reason.
    const inbox = (await app.inject({ method: 'GET', url: '/api/v1/inbox', headers: H(owner) })).json()
    expect(inbox.data.find((d: { contractId: string }) => d.contractId === id)?.primary).toMatchObject({ kind: 'fix_and_resubmit', detail: 'Liability cap must be 1x fees' })

    // Resubmitted: a new request on the version it stands on; both kept.
    const again = await submit(id, wf)
    expect(again.statusCode).toBe(201)
    expect(again.json().instanceId).not.toBe(instanceId)
    const approval = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/approval`, headers: H(owner) })).json()
    expect(approval.current).toMatchObject({ outcome: 'pending' })
    expect(approval.history).toEqual([expect.objectContaining({ id: instanceId, outcome: 'returned', reason: 'Liability cap must be 1x fees' })])
    expect((await contractOf(id)).stage).toBe('approve')
  })

  it('a contract never negotiated goes back to Draft', async () => {
    const wf = await workflow([{ order: 0, approverId: approver }])
    const id = await contract('draft')
    const s = await submit(id, wf)
    expect((await decide(s.json().instanceId, s.json().steps[0].id, approver, 'REJECTED', 'Older client: a return')).statusCode).toBe(200)
    expect(await contractOf(id)).toMatchObject({ stage: 'draft', stageState: 'returned', status: 'DRAFT' })
  })

  it('a decline stays in Approve, says so, and the owner decides: cancel (and only an admin brings it back)', async () => {
    const wf = await workflow([{ order: 0, approverId: approver }])
    const id = await contract('negotiate')
    const s = await submit(id, wf)
    expect((await decide(s.json().instanceId, s.json().steps[0].id, approver, 'DECLINED', 'We do not do business in this market')).statusCode).toBe(200)
    expect(await contractOf(id)).toMatchObject({ stage: 'approve', stageState: 'declined', turn: 'internal' })
    const banner = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/stage`, headers: H(owner) })).json()
    expect(banner.returned).toMatchObject({ outcome: 'declined', reason: 'We do not do business in this market' })
    expect(banner.canCancel).toBe(true)
    const inbox = (await app.inject({ method: 'GET', url: '/api/v1/inbox', headers: H(owner) })).json()
    expect(inbox.data.find((d: { contractId: string }) => d.contractId === id)?.primary.kind).toBe('decide_declined')

    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/cancel`, headers: H(owner), payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/cancel`, headers: H(owner), payload: { reason: 'Deal is off' } })).statusCode).toBe(200)
    expect(await contractOf(id)).toMatchObject({ stage: 'closed', stageState: 'cancelled', status: 'ARCHIVED', turn: 'none' })
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/uncancel`, headers: H(owner, ['LEGAL_OPS']), payload: { reason: 'Back on' } })).statusCode).toBe(403)
    const back = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/uncancel`, headers: H(owner, ['ADMIN']), payload: { reason: 'The deal is back on' } })
    expect(back.statusCode, back.body).toBe(200)
    expect(await contractOf(id)).toMatchObject({ stage: 'approve', stageState: 'declined' })
  })
})

describe('pooled role approvals and step orders (docs/41 Part 6)', () => {
  it('a role\'s step is every holder\'s to see; the first to decide claims it', async () => {
    await grantRole(org, approver, 'DEAL_DESK')
    await grantRole(org, second, 'DEAL_DESK')
    const wf = await workflow([{ order: 0, roleRequired: 'DEAL_DESK' }])
    const id = await contract()
    const s = await submit(id, wf)
    expect(s.statusCode, s.body).toBe(201)
    const step = await prisma.approvalStep.findUniqueOrThrow({ where: { id: s.json().steps[0].id } })
    expect(step).toMatchObject({ approverId: null })
    expect(step.approverRoleId).toBeTruthy()

    for (const who of [approver, second]) {
      const queue = (await app.inject({ method: 'GET', url: '/api/v1/approvals/my-queue', headers: H(who) })).json()
      expect(queue.data.map((d: { stepId: string }) => d.stepId)).toContain(step.id)
      const inbox = (await app.inject({ method: 'GET', url: '/api/v1/inbox', headers: H(who) })).json()
      expect(inbox.data.find((d: { contractId: string }) => d.contractId === id)?.primary).toMatchObject({ kind: 'approve', stepId: step.id })
    }
    expect((await decide(s.json().instanceId, step.id, owner, 'APPROVED')).statusCode).toBe(403)
    expect((await decide(s.json().instanceId, step.id, second, 'APPROVED')).statusCode).toBe(200)
    expect((await prisma.approvalStep.findUniqueOrThrow({ where: { id: step.id } })).approverId).toBe(second)
    expect((await decide(s.json().instanceId, step.id, approver, 'APPROVED')).statusCode).toBe(403)
    expect((await contractOf(id)).stageState).toBe('approved')
  })

  it('moves to the next step that exists when step numbers skip (0, 2, 5)', async () => {
    const wf = await workflow([{ order: 0, approverId: approver }, { order: 2, approverId: second }, { order: 5, approverId: clauseApprover }])
    const id = await contract()
    const s = await submit(id, wf)
    const instanceId = s.json().instanceId as string
    for (const [order, who] of [[0, approver], [2, second], [5, clauseApprover]] as const) {
      const [step] = await pendingSteps(instanceId)
      expect(step.stepOrder).toBe(order)
      expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instanceId } })).status).toBe('PENDING')
      expect((await decide(instanceId, step.id, who, 'APPROVED')).statusCode).toBe(200)
    }
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instanceId } })).status).toBe('APPROVED')
    expect(await contractOf(id)).toMatchObject({ stage: 'approve', stageState: 'approved', status: 'APPROVED' })
  })
})

describe('reset rules (docs/41 Part 18)', () => {
  const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: H(owner, ['LEGAL_OPS']), payload })
  const stepRows = (instanceId: string) => prisma.approvalStep.findMany({ where: { approvalInstanceId: instanceId }, orderBy: { createdAt: 'asc' } })
  async function newVersion(id: string, n: number, clauses: Array<[string, string]>, by = owner) {
    const v = await version(id, n, clauses, by)
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v } })
    return v
  }

  it('always (the default): a change of value asks again, and the approver is told what changed', async () => {
    const id = await contract()
    await prisma.contract.update({ where: { id }, data: { value: 1000 } })
    const instanceId = await approved(id, await workflow([{ order: 0, approverId: approver }]))
    vi.mocked(queueNotification).mockClear()
    expect((await patch(id, { value: 2000 })).statusCode).toBe(200)
    const rows = await stepRows(instanceId)
    expect(rows.map(r => r.status)).toEqual(['RESET', 'PENDING'])
    expect(await contractOf(id)).toMatchObject({ stage: 'approve', stageState: 'pending', status: 'PENDING_APPROVAL' })
    expect(notes().find(n => n.userId === approver)?.body).toMatch(/The value changed — your approval of .* was reset/)
  })

  it('any_document_change: a field change carries on; a new version asks again', async () => {
    const id = await contract()
    await prisma.contract.update({ where: { id }, data: { value: 1000 } })
    const instanceId = await approved(id, await workflow([{ order: 0, approverId: approver, resetOn: 'any_document_change' }]))
    expect((await patch(id, { value: 2000 })).statusCode).toBe(200)
    expect((await contractOf(id)).stageState).toBe('approved')
    const v2 = await newVersion(id, 2, [['limitation_of_liability', 'Liability is capped at fees paid.'], ['confidentiality', 'Each party keeps secrets.'], ['notices', 'Notices by email.']])
    const r = await onApprovalChange({ orgId: org, contractId: id, versionId: v2, source: 'edit', userId: owner })
    expect(r.resetStepIds).toHaveLength(1)
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instanceId } })).versionId).toBe(v2)
    expect((await contractOf(id)).stageState).toBe('pending')
  })

  it('clause_text_changes: another clause carries the approval to the new version; a covered clause asks again, naming it', async () => {
    const id = await contract()
    const instanceId = await approved(id, await workflow([{ order: 0, approverId: approver, resetOn: { mode: 'clause_text_changes', clauseTypes: ['limitation_of_liability'] } }]))
    const v2 = await newVersion(id, 2, [['limitation_of_liability', 'Liability is capped at fees paid.'], ['confidentiality', 'Each party keeps all secrets forever.']])
    const carried = await onApprovalChange({ orgId: org, contractId: id, versionId: v2, source: 'edit', userId: owner })
    expect(carried).toMatchObject({ carried: true, resetStepIds: [] })
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instanceId } })).versionId).toBe(v2)
    expect((await contractOf(id)).stageState).toBe('approved')

    vi.mocked(queueNotification).mockClear()
    const v3 = await newVersion(id, 3, [['limitation_of_liability', 'Liability is uncapped.'], ['confidentiality', 'Each party keeps all secrets forever.']])
    const reset = await onApprovalChange({ orgId: org, contractId: id, versionId: v3, source: 'edit', userId: owner })
    expect(reset.resetStepIds).toHaveLength(1)
    expect(notes().find(n => n.userId === approver)?.body).toMatch(/^v3 changed §1 Limitation of Liability — your approval/)
  })

  it('fields: only the listed field asks again; never: nothing does', async () => {
    const id = await contract()
    await prisma.contract.update({ where: { id }, data: { value: 1000, currency: 'USD' } })
    await approved(id, await workflow([{ order: 0, approverId: approver, resetOn: { mode: 'fields', fields: ['value'] } }]))
    expect((await patch(id, { currency: 'EUR' })).statusCode).toBe(200)
    expect((await contractOf(id)).stageState).toBe('approved')
    expect((await patch(id, { value: 5000 })).statusCode).toBe(200)
    expect((await contractOf(id)).stageState).toBe('pending')

    const never = await contract()
    const neverInstance = await approved(never, await workflow([{ order: 0, approverId: approver, resetOn: 'never' }]))
    const v2 = await newVersion(never, 2, [['limitation_of_liability', 'Liability is uncapped.']])
    expect(await onApprovalChange({ orgId: org, contractId: never, versionId: v2, source: 'edit', userId: owner })).toMatchObject({ carried: true, resetStepIds: [] })
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: neverInstance } })).status).toBe('APPROVED')
  })

  it('fields: a date the step lists asks again when a person changes it', async () => {
    const id = await contract()
    await prisma.contract.update({ where: { id }, data: { expiryDate: new Date('2027-01-01') } })
    await approved(id, await workflow([{ order: 0, approverId: approver, resetOn: { mode: 'fields', fields: ['expiryDate'] } }]))
    expect((await patch(id, { expiryDate: '2028-01-01T00:00:00.000Z' })).statusCode).toBe(200)
    expect((await contractOf(id)).stageState).toBe('pending')
  })

  it('a later step whose approval still stands isn\'t asked again', async () => {
    const id = await contract()
    const instanceId = await approved(id, await workflow([
      { order: 0, approverId: approver, resetOn: { mode: 'clause_text_changes', clauseTypes: ['limitation_of_liability'] } },
      { order: 1, approverId: second, resetOn: 'never' },
    ]))
    const v2 = await newVersion(id, 2, [['limitation_of_liability', 'Liability is uncapped.'], ['confidentiality', 'Each party keeps secrets.']])
    await onApprovalChange({ orgId: org, contractId: id, versionId: v2, source: 'edit', userId: owner })
    const [again] = await pendingSteps(instanceId)
    expect(again).toMatchObject({ stepOrder: 0, approverId: approver })
    expect((await decide(instanceId, again.id, approver, 'APPROVED')).statusCode).toBe(200)
    // Step 1 (Sam) still stands: approved without asking him again.
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: instanceId } })).status).toBe('APPROVED')
    expect(await prisma.approvalStep.count({ where: { approvalInstanceId: instanceId, approverId: second } })).toBe(1)
  })

  it('a counterparty\'s version after submission withdraws it, tells the approvers, and the negotiation is back with us', async () => {
    const id = await contract('negotiate')
    const s = await submit(id, await workflow([{ order: 0, approverId: approver }]))
    await prisma.approvalInstance.update({ where: { id: s.json().instanceId }, data: { approvalRecommendation: 'ready_to_approve' } })
    vi.mocked(queueNotification).mockClear()
    const theirs = await newVersion(id, 2, [['limitation_of_liability', 'Liability is uncapped.']], 'portal:link1')
    const r = await onApprovalChange({ orgId: org, contractId: id, versionId: theirs, source: 'counterparty', via: 'portal' })
    expect(r.withdrawn).toBe(true)
    expect(await prisma.approvalInstance.findUniqueOrThrow({ where: { id: s.json().instanceId } })).toMatchObject({ status: 'CANCELLED', outcome: 'withdrawn', approvalRecommendation: null })
    expect(await contractOf(id)).toMatchObject({ stage: 'negotiate', stageState: 'with_us', turn: 'internal' })
    expect(notes().find(n => n.userId === approver)).toMatchObject({ title: 'Approval request withdrawn' })
  })
})

describe('clause exceptions (docs/41 Part 7)', () => {
  async function withFinding(clauseType = 'limitation_of_liability') {
    const id = await contract()
    const c = await contractOf(id)
    const category = await prisma.clauseCategory.create({ data: { orgId: org, name: `Liability ${Math.random()}` } })
    const finding = await prisma.reviewFinding.create({
      data: {
        orgId: org, contractId: id, versionId: c.currentVersionId!, kind: 'needs_approval_position', key: `k-${Math.random()}`,
        clauseType, categoryId: category.id, severity: 'high', title: 'Liability cap below your position', explanation: 'Capped at fees; you need 2x.', source: 'deterministic',
      },
    })
    return { id, category: category.id, finding: finding.id, versionId: c.currentVersionId! }
  }
  const ask = (id: string, finding: string) => app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/findings/${finding}/exception`, headers: H(owner), payload: { reason: 'Customer is strategic; 1x is fine here' } })
  const decideStepById = (stepId: string, as: string, decision: string, comment?: string) => app.inject({ method: 'POST', url: `/api/v1/approvals/steps/${stepId}/decide`, headers: H(as), payload: { decision, comment } })
  const policyOf = async (findingId: string) => {
    const f = await prisma.reviewFinding.findUniqueOrThrow({ where: { id: findingId } })
    return policy({ analysis: { kind: 'done' } as never, clauseCount: 2, riskScore: 0.2, findings: [f], counterpartyVersionAfterAnalysis: null }).label
  }

  it('needs a named clause approver', async () => {
    const { id, finding } = await withFinding()
    const res = await ask(id, finding)
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'NO_CLAUSE_APPROVER' })
  })

  it('requested → in the approver\'s inbox, the policy says Needs exception, and signing waits; approved → it can be signed', async () => {
    const { id, category, finding } = await withFinding()
    const set = await app.inject({ method: 'PATCH', url: `/api/v1/clauses/categories/${category}`, headers: H(owner), payload: { approverUserId: clauseApprover } })
    expect(set.statusCode, set.body).toBe(200)
    const res = await ask(id, finding)
    expect(res.statusCode, res.body).toBe(201)
    const stepId = res.json().stepId as string
    expect((await prisma.reviewFinding.findUniqueOrThrow({ where: { id: finding } })).status).toBe('exception_requested')
    expect(await policyOf(finding)).toBe('needs_exception')
    expect((await ask(id, finding)).statusCode).toBe(409)

    const inbox = (await app.inject({ method: 'GET', url: '/api/v1/inbox', headers: H(clauseApprover) })).json()
    expect(inbox.data.find((d: { contractId: string }) => d.contractId === id)?.primary).toMatchObject({ kind: 'decide_exception', stepId })

    // Approved, but an exception still open: no signature.
    await transition({ orgId: org, contractId: id, to: { stage: 'negotiate', state: 'with_us' }, source: 'manual', userId: owner })
    await approved(id, await workflow([{ order: 0, approverId: approver }]))
    const send = () => app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/send-for-signature`, headers: H(owner), payload: { signers: [{ name: 'Pat', email: 'pat@cp.test' }] } })
    const blocked = await send()
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().code).toBe('OPEN_EXCEPTIONS')

    expect((await decideStepById(stepId, owner, 'APPROVED')).statusCode).toBe(403)
    expect((await decideStepById(stepId, clauseApprover, 'APPROVED', 'Fine for this customer')).statusCode).toBe(200)
    expect((await prisma.reviewFinding.findUniqueOrThrow({ where: { id: finding } })).status).toBe('exception_approved')
    expect(await policyOf(finding)).toBe('ready_to_approve')
    expect((await send()).statusCode).toBe(201)
  })

  it('declined → the policy escalates', async () => {
    const { id, category, finding } = await withFinding()
    await prisma.clauseCategory.update({ where: { id: category }, data: { approverUserId: clauseApprover } })
    const stepId = (await ask(id, finding)).json().stepId as string
    expect((await decideStepById(stepId, clauseApprover, 'DECLINED')).statusCode).toBe(400)
    expect((await decideStepById(stepId, clauseApprover, 'DECLINED', 'Not for an uncapped deal')).statusCode).toBe(200)
    expect((await prisma.reviewFinding.findUniqueOrThrow({ where: { id: finding } })).status).toBe('exception_declined')
    expect(await policyOf(finding)).toBe('escalate')
  })

  it('resets only when its own clause\'s words change', async () => {
    const { id, category, finding } = await withFinding()
    await prisma.clauseCategory.update({ where: { id: category }, data: { approverUserId: clauseApprover } })
    const stepId = (await ask(id, finding)).json().stepId as string
    await decideStepById(stepId, clauseApprover, 'APPROVED', 'ok')
    const other = await version(id, 2, [['limitation_of_liability', 'Liability is capped at fees paid.'], ['confidentiality', 'Secrets are kept for ten years.']])
    await prisma.contract.update({ where: { id }, data: { currentVersionId: other } })
    expect((await onApprovalChange({ orgId: org, contractId: id, versionId: other, source: 'edit' })).resetExceptionIds).toEqual([])
    const own = await version(id, 3, [['limitation_of_liability', 'Liability is uncapped.'], ['confidentiality', 'Secrets are kept for ten years.']])
    await prisma.contract.update({ where: { id }, data: { currentVersionId: own } })
    expect((await onApprovalChange({ orgId: org, contractId: id, versionId: own, source: 'edit' })).resetExceptionIds).toEqual([stepId])
    expect((await prisma.approvalStep.findUniqueOrThrow({ where: { id: stepId } })).status).toBe('RESET')
  })
})
