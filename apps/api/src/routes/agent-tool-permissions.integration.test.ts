/**
 * X9 — the agent's read tools checked view:contract where the matching REST
 * route checks something else, so the chat assistant handed out what the UI
 * refuses:
 *   - playbook positions (walkaway language) without view:playbook
 *     (playbook_check, org_memory), and clause-library items without
 *     view:clause (org_memory);
 *   - the approval queue without view:workflow, and the org-wide approval
 *     list without configure:workflow (approval_list);
 *   - playbook-grounded redline proposals without edit:contract
 *     (redline_propose / _batch; REST's /clauses/:id/suggest needs edit).
 * Tools the caller can never use are also withheld from the model.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, salesRep: string, viewer: string, approver: string, legalOps: string, ownReviewer: string, other: string
let mine: string, theirs: string, wf: string, categoryId: string
const forwarded: Array<Record<string, unknown>> = []

async function tool(name: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: `/api/internal/ai/tools/${name}`,
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, ...payload },
  })
}

async function grantRole(userId: string, name: string, permissions?: Array<{ action: string; resource: string; scope: string }>) {
  const role = await prisma.role.upsert({
    where: { orgId_name: { orgId: org, name } },
    create: { orgId: org, name, isSystem: !permissions, ...(permissions ? { permissions } : {}) },
    update: {},
  })
  await prisma.userRole.create({ data: { userId, roleId: role.id } })
}

async function withClause(contractId: string, ownerId: string) {
  const v = await prisma.contractVersion.create({ data: { contractId, versionNumber: 1, createdById: ownerId, plainText: 'x' } })
  await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id } })
  await prisma.contractClause.create({
    data: { id: `it-x9-${contractId}`, versionId: v.id, clauseType: 'limitation_of_liability', content: 'Liability is capped at fees paid.' },
  })
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Agent Tool Permissions Org')
  ;[salesRep, viewer, approver, legalOps, ownReviewer, other] = await Promise.all(Array.from({ length: 6 }, () => makeUser(org)))
  await grantRole(salesRep, 'SALES_REP')
  await grantRole(viewer, 'VIEWER')
  await grantRole(approver, 'APPROVER')
  await grantRole(legalOps, 'LEGAL_OPS')
  await grantRole(other, 'SALES_REP')
  // May use both tools, but only on contracts it owns.
  await grantRole(ownReviewer, 'OWN_REVIEWER', [
    { action: 'view', resource: 'contract', scope: 'own' },
    { action: 'edit', resource: 'contract', scope: 'own' },
    { action: 'view', resource: 'playbook', scope: 'org' },
  ])

  mine = await makeContract(org, salesRep, { title: 'Rep MSA', type: 'MSA', status: 'EXECUTED' })
  theirs = await makeContract(org, other, { title: 'Other MSA', type: 'MSA', status: 'EXECUTED' })
  const reviewerOwn = await makeContract(org, ownReviewer, { title: 'Reviewer MSA', type: 'MSA', status: 'EXECUTED' })
  for (const [c, o] of [[mine, salesRep], [theirs, other], [reviewerOwn, ownReviewer]] as const) await withClause(c, o)

  const category = await prisma.clauseCategory.create({ data: { orgId: org, name: 'Limitation of Liability' } })
  categoryId = category.id
  await prisma.playbookPosition.create({
    data: { orgId: org, clauseCategoryId: category.id, positionType: 'walkaway', content: 'WALKAWAY: never accept unlimited liability', createdById: legalOps },
  })
  await prisma.clauseLibraryItem.create({
    data: { orgId: org, categoryId: category.id, title: 'Standard liability cap', content: 'Capped at fees.', isApproved: true, createdById: legalOps },
  })
  wf = (await prisma.workflowDefinition.create({
    data: { orgId: org, name: 'X9 flow', createdById: legalOps, isActive: true, isDefault: false, triggerRules: {}, steps: [] },
  })).id
  const inst = await prisma.approvalInstance.create({
    data: { orgId: org, contractId: theirs, workflowDefinitionId: wf, submittedById: other, aiSummary: 'SECRET APPROVAL SUMMARY' },
  })
  await prisma.approvalStep.create({ data: { orgId: org, approvalInstanceId: inst.id, stepName: 'Legal', stepOrder: 0, approverId: approver } })
  // A later step on another instance: not the approver's to decide yet.
  const later = await prisma.approvalInstance.create({
    data: { orgId: org, contractId: mine, workflowDefinitionId: wf, submittedById: salesRep, currentStepOrder: 0 },
  })
  await prisma.approvalStep.create({ data: { orgId: org, approvalInstanceId: later.id, stepName: 'Finance', stepOrder: 1, approverId: approver } })
  const m = await prisma.matter.create({ data: { orgId: org, name: 'X9 matter', ownerId: legalOps, createdById: legalOps } })
  await prisma.contract.updateMany({ where: { id: { in: [mine, theirs] } }, data: { matterId: m.id } })

  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/redline_propose') || url.endsWith('/compare')) return new Response(JSON.stringify({ variants: [], positions: [] }))
    if (url.endsWith('/agent/chat')) {
      forwarded.push(JSON.parse(String(init?.body)))
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    return realFetch(input as never, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.contract.updateMany({ where: { orgId: org }, data: { matterId: null } })
  await prisma.matter.deleteMany({ where: { orgId: org } })
  await prisma.approvalStep.deleteMany({ where: { orgId: org } })
  await prisma.approvalInstance.deleteMany({ where: { orgId: org } })
  await prisma.clauseLibraryItem.deleteMany({ where: { orgId: org } })
  await prisma.playbookPosition.deleteMany({ where: { orgId: org } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await prisma.contractClause.deleteMany({ where: { id: { startsWith: 'it-x9-' } } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await prisma.userRole.deleteMany({ where: { role: { orgId: org } } })
  await cleanupAll()
  await closeApp()
})

describe('playbook data follows view:playbook', () => {
  it('playbook_check refuses a caller without it, and serves one with it', async () => {
    expect((await tool('playbook_check', { userId: salesRep, contractId: mine })).statusCode).toBe(403)
    const ok = await tool('playbook_check', { userId: viewer, contractId: mine })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().contract.id).toBe(mine)
  })

  it('org_memory withholds, and names, what the caller may not see', async () => {
    const rep = (await tool('org_memory', { userId: salesRep, topic: 'liability' })).json()
    expect(rep.playbook).toEqual([])
    expect(rep.withheld).toEqual(['playbook'])
    expect(rep.clauseLibrary.length).toBeGreaterThan(0)   // SALES_REP has view:clause

    const apprRes = await tool('org_memory', { userId: approver, topic: 'liability' })
    const appr = apprRes.json()
    expect(appr.withheld).toEqual(['playbook', 'clauseLibrary'])
    expect(JSON.stringify(appr)).not.toContain('WALKAWAY')
    // No category either (it belongs to the playbook / library), and the
    // withheld note comes first so it survives when memory cuts a long result.
    expect(appr.matchedCategory).toBeNull()
    expect(apprRes.body.startsWith('{"withheld"')).toBe(true)

    const ops = (await tool('org_memory', { userId: legalOps, topic: 'liability' })).json()
    expect(ops.withheld).toBeUndefined()
    expect(JSON.stringify(ops.playbook)).toContain('WALKAWAY')
  })
})

describe('approvals follow the workflow permissions', () => {
  it('the queue holds only the approver\'s CURRENT steps, as REST\'s my-queue does', async () => {
    const items = (await tool('approval_list', { userId: approver })).json().items
    expect(items.map((i: { stepName: string }) => i.stepName)).toEqual(['Legal'])
  })

  it('the queue needs view:workflow; the org-wide list configure:workflow', async () => {
    expect((await tool('approval_list', { userId: salesRep })).statusCode).toBe(403)
    expect((await tool('approval_list', { userId: viewer, scope: 'all' })).statusCode).toBe(403)
    const queue = await tool('approval_list', { userId: approver })
    expect(queue.statusCode).toBe(200)
    expect(queue.json().items).toHaveLength(1)
    expect((await tool('approval_list', { userId: approver, scope: 'all' })).statusCode).toBe(403)
    const all = await tool('approval_list', { userId: legalOps, scope: 'all' })
    expect(all.statusCode).toBe(200)
    expect(all.body).toContain('SECRET APPROVAL SUMMARY')
  })
})

describe('redline proposals follow edit:contract', () => {
  it('a caller who may not edit gets 403; one who may, gets proposals', async () => {
    for (const userId of [salesRep, viewer]) {
      expect((await tool('redline_propose', { userId, contractId: mine, clauseId: `it-x9-${mine}` })).statusCode).toBe(403)
    }
    expect((await tool('redline_propose', { userId: legalOps, contractId: mine, clauseId: `it-x9-${mine}` })).statusCode).toBe(200)
  })

  it('own scope still stops at the caller\'s own contracts (as S2 established)', async () => {
    expect((await tool('playbook_check', { userId: ownReviewer, contractId: theirs })).statusCode).toBe(404)
    expect((await tool('redline_propose', { userId: ownReviewer, contractId: theirs, clauseId: `it-x9-${theirs}` })).statusCode).toBe(404)
  })
})

describe('the other surfaces the review found', () => {
  it('REST /agent/compare (playbook positions) needs view:playbook', async () => {
    const compare = (roles: string[], user: string) => app.inject({
      method: 'POST', url: '/api/v1/agent/compare', headers: auth(org, roles, user), payload: { clauseText: 'x', clauseCategoryId: categoryId },
    })
    expect((await compare(['SALES_REP'], salesRep)).statusCode).toBe(403)
    expect((await compare(['LEGAL_OPS'], legalOps)).statusCode).not.toBe(403)
  })

  it('template_list needs view:template', async () => {
    expect((await tool('template_list', { userId: approver })).statusCode).toBe(403)
    expect((await tool('template_list', { userId: salesRep })).statusCode).toBe(200)
  })

  it('matter_list counts only what the caller could open', async () => {
    const count = async (userId: string) => (await tool('matter_list', { userId })).json().items[0].contractCount
    expect(await count(salesRep)).toBe(1)
    expect(await count(legalOps)).toBe(2)
  })
})

describe('tools the caller can never use are not offered', () => {
  it('SALES_REP is not offered them; LEGAL_OPS is', async () => {
    const chat = (user: string, roles: string[]) => app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers: auth(org, roles, user), payload: { message: 'hi', agentMode: true },
    })
    await chat(salesRep, ['SALES_REP'])
    await chat(legalOps, ['LEGAL_OPS'])
    const [rep, ops] = forwarded.slice(-2)
    expect(rep.denied_tools).toEqual(expect.arrayContaining(['redline_propose', 'redline_propose_batch', 'playbook_check', 'approval_list']))
    for (const t of ['redline_propose', 'playbook_check', 'approval_list']) {
      expect((ops.denied_tools as string[] | null) ?? []).not.toContain(t)
    }
  })
})
