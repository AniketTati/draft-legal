/**
 * docs/41 P0.2/P0.3 — deleting Governing Law, or never analysing, can't end
 * in "Ready to approve"; the approval routes show why.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('./queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  queueEmbedContract: vi.fn(),
  queueNotification: vi.fn(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { finishAnalysis } from './analysis-trigger.js'
import { afterAnalysis } from './presence-rules.js'

let app: TestApp
let org: string, owner: string, approver: string

const GOV = 'This Agreement is governed by the laws of the State of New York, without regard to its conflict-of-laws principles.'
const CONF = 'The Recipient shall hold the Confidential Information in strict confidence and use it only for the Purpose.'
const TERM = 'This Agreement continues for two years from the Effective Date unless terminated earlier on thirty days notice.'

async function version(id: string, n: number, clauses: Array<[string, string]>) {
  const text = clauses.map(c => c[1]).join('\n')
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: n, createdById: owner, htmlContent: `<p>${text}</p>`, plainText: text } })
  for (const [i, [clauseType, content]] of clauses.entries()) {
    await prisma.contractClause.create({ data: { versionId: v.id, clauseType, content, sortOrder: i } })
  }
  return v
}

async function analysed(id: string, v: { id: string }, clauses: number) {
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'INDEXING' } })
  await finishAnalysis(id, v.id, clauses)
  await afterAnalysis(id, v.id)
}

const checks = (id: string) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/checks`, headers: auth(org, ['ADMIN'], owner) })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Recommendation Guard Org')
  owner = await makeUser(org)
  approver = await makeUser(org)
  await prisma.clauseCategory.createMany({
    data: [
      { orgId: org, name: 'Confidentiality', presence: 'required', presenceContractTypes: ['NDA'] },
      { orgId: org, name: 'Dispute Resolution', presence: 'required', presenceContractTypes: ['NDA', 'MSA'] },
      { orgId: org, name: 'Term & Termination', presence: 'required', presenceContractTypes: ['NDA', 'MSA'] },
      { orgId: org, name: 'Compliance with Laws' },
    ],
  })
})

afterAll(async () => {
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('deleted governing law', () => {
  it('is "Deleted since v1" with the deleted text, and blocks Ready', async () => {
    const id = await makeContract(org, owner, { title: 'NDA — Acme', type: 'NDA' })
    await prisma.contract.update({ where: { id }, data: { riskScore: 0.1 } })
    const v1 = await version(id, 1, [['confidentiality', CONF], ['termination', TERM], ['governing_law', GOV]])
    await analysed(id, v1, 3)
    let res = (await checks(id)).json()
    expect(res.ready).toBe(true)
    expect(res.findings).toEqual([])

    // v2: Governing Law taken out (an edit's carried clauses lack it).
    const v2 = await version(id, 2, [['confidentiality', CONF], ['termination', TERM]])
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
    res = (await checks(id)).json()
    expect(res.ready).toBe(false)
    expect(res.findings[0]).toMatchObject({ kind: 'deleted', severity: 'high', status: 'open', title: 'Governing Law — deleted since v1 (required)' })
    const review = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/review`, headers: auth(org, ['ADMIN'], owner) })).json()
    expect(review.groups.needsAttention[0].evidence.baselineQuote).toContain('State of New York')
    expect(res.reasons.map((r: { code: string }) => r.code)).toEqual(['analysis_stale', 'required_deleted'])

    // Analysed again: still deleted, still not ready.
    await analysed(id, v2, 2)
    res = (await checks(id)).json()
    expect(res.reasons.map((r: { code: string }) => r.code)).toEqual(['required_deleted'])
    // docs/41 P1 — stored as review findings of v2, measured against v1.
    const stored = await prisma.reviewFinding.findMany({ where: { versionId: v2.id } })
    expect(stored.map(f => ({ kind: f.kind, baselineVersionId: f.baselineVersionId }))).toEqual([{ kind: 'deleted', baselineVersionId: v1.id }])

    // And the next analysis still remembers it while the clause stays gone.
    const v3 = await version(id, 3, [['confidentiality', CONF], ['termination', `${TERM} Renewal requires written notice.`]])
    await analysed(id, v3, 2)
    res = (await checks(id)).json()
    expect(res.findings.map((f: { kind: string; title: string }) => `${f.kind}:${f.title}`)).toContain('deleted:Governing Law — deleted since v1 (required)')
  })
})

describe('the recommendation an approver sees', () => {
  async function pending(id: string) {
    const wf = await makeWorkflow(org, owner, approver)
    const inst = await prisma.approvalInstance.create({
      data: { orgId: org, contractId: id, workflowDefinitionId: wf, status: 'PENDING', currentStepOrder: 0, submittedById: owner, approvalRecommendation: 'approve' },
    })
    await prisma.approvalStep.create({ data: { approvalInstanceId: inst.id, orgId: org, stepOrder: 0, stepName: 'Legal Review', approverId: approver, status: 'PENDING' } })
    return inst.id
  }

  it('a never-analysed contract with a null risk score is never "approve"', async () => {
    const id = await makeContract(org, owner, { title: 'Unread NDA', type: 'NDA' })
    const v = await version(id, 1, [])
    // As a request's draft was left before docs/41: DONE, never read.
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
    const inst = await pending(id)
    // The agent writes "approve"; the guard stores "cant_recommend".
    const patched = await app.inject({
      method: 'PATCH', url: `/api/v1/approvals/${inst}/summary`,
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-org-id': org },
      payload: { aiSummary: 'An NDA.', approvalRecommendation: 'approve' },
    })
    expect(patched.statusCode).toBe(200)
    expect((await prisma.approvalInstance.findUniqueOrThrow({ where: { id: inst } })).approvalRecommendation).toBe('cant_recommend')

    const detail = (await app.inject({ method: 'GET', url: `/api/v1/approvals/${inst}`, headers: auth(org, ['ADMIN'], approver) })).json()
    expect(detail.approvalRecommendation).toBe('cant_recommend')
    expect(detail.recommendationReasons).toEqual(['this contract has not been analysed', 'its risk score is unknown'])

    const queue = (await app.inject({ method: 'GET', url: '/api/v1/approvals/my-queue', headers: auth(org, ['ADMIN'], approver) })).json()
    const item = queue.data.find((d: { instanceId: string }) => d.instanceId === inst)
    expect(item.instance.approvalRecommendation).toBe('cant_recommend')
  })

  it('an analysed contract with a known score and nothing missing is "Ready to approve" — the policy\'s label, not the model\'s', async () => {
    const id = await makeContract(org, owner, { title: 'Clean NDA', type: 'NDA' })
    await prisma.contract.update({ where: { id }, data: { riskScore: 0.12 } })
    const v1 = await version(id, 1, [['confidentiality', CONF], ['termination', TERM], ['governing_law', GOV]])
    await analysed(id, v1, 3)
    const inst = await pending(id)
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/approvals/${inst}`, headers: auth(org, ['ADMIN'], approver) })).json()
    expect(detail.approvalRecommendation).toBe('ready_to_approve')
    expect(detail.recommendationReasons).toEqual([])
  })
})
