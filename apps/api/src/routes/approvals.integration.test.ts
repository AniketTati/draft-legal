/**
 * Approval state machine (end-to-end) — submit → decide advances the contract's
 * status through the real routes + engine (Wave 3.8). Guards the money-path.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp,
} from '../test-support/helpers.js'
import { handleEscalate } from '../lib/approval-escalation.js'
import type { NotificationJob } from '../lib/queue.js'

let app: TestApp
let org: string, submitter: string, approver: string, workflowId: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Approval Org')
  submitter = await makeUser(org)
  approver = await makeUser(org)
  workflowId = await makeWorkflow(org, submitter, approver)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

async function submit(contractId: string) {
  const res = await app.inject({
    method: 'POST', url: `/api/v1/contracts/${contractId}/submit-approval`,
    headers: auth(org, ['ADMIN'], submitter), payload: { workflowDefinitionId: workflowId },
  })
  return res
}

describe('approval state machine', () => {
  it('APPROVE advances the contract to APPROVED', async () => {
    const contract = await makeContract(org, submitter, { title: 'Awaiting approval', status: 'DRAFT' })

    const submitRes = await submit(contract)
    expect(submitRes.statusCode).toBe(201)
    const { instanceId, steps } = submitRes.json() as { instanceId: string; steps: Array<{ id: string }> }
    expect(steps.length).toBe(1)

    // The contract is now PENDING_APPROVAL.
    expect((await prisma.contract.findUnique({ where: { id: contract } }))?.status).toBe('PENDING_APPROVAL')

    // The assigned approver decides. The decide handler checks the step is
    // assigned to req.user.sub, so the token's sub must be the approver.
    const decideRes = await app.inject({
      method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`,
      headers: auth(org, ['ADMIN'], approver),
      payload: { stepId: steps[0].id, decision: 'APPROVED' },
    })
    expect(decideRes.statusCode).toBe(200)

    expect((await prisma.contract.findUnique({ where: { id: contract } }))?.status).toBe('APPROVED')
    expect((await prisma.approvalInstance.findUnique({ where: { id: instanceId } }))?.status).toBe('APPROVED')
  })

  it('REJECT returns the contract to DRAFT', async () => {
    const contract = await makeContract(org, submitter, { title: 'To be rejected', status: 'DRAFT' })

    const submitRes = await submit(contract)
    expect(submitRes.statusCode).toBe(201)
    const { instanceId, steps } = submitRes.json() as { instanceId: string; steps: Array<{ id: string }> }

    const decideRes = await app.inject({
      method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`,
      headers: auth(org, ['ADMIN'], approver),
      payload: { stepId: steps[0].id, decision: 'REJECTED', comment: 'Not acceptable' },
    })
    expect(decideRes.statusCode).toBe(200)

    expect((await prisma.contract.findUnique({ where: { id: contract } }))?.status).toBe('DRAFT')
    expect((await prisma.approvalInstance.findUnique({ where: { id: instanceId } }))?.status).toBe('REJECTED')
  })

  it('a non-assigned user cannot decide someone else\'s step (403)', async () => {
    const contract = await makeContract(org, submitter, { title: 'Guarded step', status: 'DRAFT' })
    const submitRes = await submit(contract)
    const { instanceId, steps } = submitRes.json() as { instanceId: string; steps: Array<{ id: string }> }

    // submitter has approve:workflow via ADMIN but is NOT the assigned approver.
    const res = await app.inject({
      method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`,
      headers: auth(org, ['ADMIN'], submitter),
      payload: { stepId: steps[0].id, decision: 'APPROVED' },
    })
    expect(res.statusCode).toBe(403)
  })
})

/**
 * C2 — approvals must not be stranded, undercounted, or hidden.
 * makeWorkflow numbers its single step from 0, as the builder and seed do.
 */
describe('C2: escalation, step-0 workflows and oversight', () => {
  let admin: string

  beforeAll(async () => {
    admin = await makeUser(org)
    const role = await prisma.role.create({ data: { orgId: org, name: 'ADMIN', isSystem: true } })
    await prisma.userRole.create({ data: { userId: admin, roleId: role.id } })
  })

  async function submitted() {
    const contract = await makeContract(org, submitter, { title: `C2 ${Math.random().toString(36).slice(2, 8)}`, status: 'DRAFT' })
    const res = await submit(contract)
    expect(res.statusCode).toBe(201)
    const { instanceId, steps } = res.json() as { instanceId: string; steps: Array<{ id: string }> }
    return { contract, instanceId, stepId: steps[0].id }
  }

  it('an escalation with no target keeps the step with its approver, who can still decide, and notifies an admin', async () => {
    const { contract, instanceId, stepId } = await submitted()
    const sent: NotificationJob[] = []
    await handleEscalate({ instanceId, stepId, orgId: org }, n => { sent.push(n) })

    expect((await prisma.approvalStep.findUnique({ where: { id: stepId } }))?.status).toBe('PENDING')
    expect((await prisma.approvalInstance.findUnique({ where: { id: instanceId } }))?.status).toBe('PENDING')
    expect(sent.map(n => n.userId).sort()).toEqual([admin, approver].sort())

    const queue = await app.inject({ method: 'GET', url: '/api/v1/approvals/my-queue', headers: auth(org, ['APPROVER'], approver) })
    expect(queue.json().data.map((d: { stepId: string }) => d.stepId)).toContain(stepId)

    const decide = await app.inject({
      method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`,
      headers: auth(org, ['ADMIN'], approver), payload: { stepId, decision: 'APPROVED' },
    })
    expect(decide.statusCode).toBe(200)
    expect((await prisma.contract.findUnique({ where: { id: contract } }))?.status).toBe('APPROVED')
  })

  it('an escalation to a named user still reassigns the step', async () => {
    const { instanceId, stepId } = await submitted()
    const sent: NotificationJob[] = []
    await handleEscalate({ instanceId, stepId, orgId: org, escalateTo: admin }, n => { sent.push(n) })
    expect((await prisma.approvalStep.findUnique({ where: { id: stepId } }))?.status).toBe('ESCALATED')
    const replacement = await prisma.approvalStep.findFirst({ where: { approvalInstanceId: instanceId, status: 'PENDING' } })
    expect(replacement?.approverId).toBe(admin)
    expect(sent.map(n => n.userId)).toEqual([admin])
  })

  it('a step-0 approval is counted on the approver\'s dashboard and shown as step 1 of 1 in oversight', async () => {
    const { instanceId } = await submitted()
    const dash = await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: auth(org, ['APPROVER'], approver) })
    expect(dash.statusCode).toBe(200)
    const pendingForApprover = await prisma.approvalStep.count({
      where: { orgId: org, approverId: approver, status: 'PENDING', instance: { status: 'PENDING' } },
    })
    expect(dash.json().pendingApprovals).toBe(pendingForApprover)
    expect(pendingForApprover).toBeGreaterThan(0)

    const all = await app.inject({ method: 'GET', url: '/api/v1/approvals/all', headers: auth(org, ['ADMIN'], admin) })
    const row = all.json().data.find((r: { instanceId: string }) => r.instanceId === instanceId)
    expect(row).toMatchObject({ currentStepOrder: 0, currentStepPosition: 1, stepCount: 1, currentStepName: 'Legal Review' })
    expect(row.currentApproverName).toBe('Integration User')
  })

  it('escalated instances appear in oversight and in the pending count', async () => {
    const { instanceId } = await submitted()
    await prisma.approvalInstance.update({ where: { id: instanceId }, data: { status: 'ESCALATED' } })

    const all = await app.inject({ method: 'GET', url: '/api/v1/approvals/all', headers: auth(org, ['ADMIN'], admin) })
    expect(all.json().data.map((r: { instanceId: string }) => r.instanceId)).toContain(instanceId)

    const summary = await app.inject({ method: 'GET', url: '/api/v1/analytics/summary', headers: auth(org, ['ADMIN'], admin) })
    const open = await prisma.approvalInstance.count({ where: { orgId: org, status: { in: ['PENDING', 'IN_PROGRESS', 'ESCALATED'] } } })
    expect(summary.json().pendingApprovals).toBe(open)

    await prisma.approvalInstance.update({ where: { id: instanceId }, data: { status: 'PENDING' } })
  })

  it('the repair migration hands a stranded escalation back to its approver', async () => {
    const { contract, instanceId, stepId } = await submitted()
    // What the old no-target branch left behind.
    await prisma.approvalStep.update({ where: { id: stepId }, data: { status: 'ESCALATED' } })
    await prisma.approvalInstance.update({ where: { id: instanceId }, data: { status: 'ESCALATED' } })

    const sql = readFileSync(new URL('../../prisma/migrations/20260923000000_repair_stranded_escalations/migration.sql', import.meta.url), 'utf8')
    for (const stmt of sql.split(/;\s*\n/).map(x => x.trim()).filter(x => /^\s*(--.*\n\s*)*UPDATE/i.test(x))) {
      await prisma.$executeRawUnsafe(stmt)
    }

    expect((await prisma.approvalStep.findUnique({ where: { id: stepId } }))?.status).toBe('PENDING')
    expect((await prisma.approvalInstance.findUnique({ where: { id: instanceId } }))?.status).toBe('PENDING')
    const decide = await app.inject({
      method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`,
      headers: auth(org, ['ADMIN'], approver), payload: { stepId, decision: 'APPROVED' },
    })
    expect(decide.statusCode).toBe(200)
    expect((await prisma.contract.findUnique({ where: { id: contract } }))?.status).toBe('APPROVED')
  })
})
