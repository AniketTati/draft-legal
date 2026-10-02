/**
 * docs/41 fix-up 9 — a category's rules set from the Playbook page: presence
 * (required / not allowed / optional) for the contract types it applies to,
 * and the clause approver. Needs edit:playbook. A presence change re-reviews
 * an unsigned contract's current version on its next review read, keeping
 * what people decided; signed contracts keep their findings.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/queue.js')>()
  return {
    ...real,
    queueEmbedContract: vi.fn(), queueNotification: vi.fn(), queueRefreshVersion: vi.fn(), queuePlaybookReview: vi.fn(),
    queueComplianceReview: vi.fn(), queuePlaybookRedline: vi.fn(), queueExtractAi: vi.fn(), queueClassifyDocument: vi.fn(),
    agentQueue: { getJob: async () => undefined, add: async () => undefined },
  }
})

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { finishAnalysis } from '../lib/analysis-trigger.js'
import { afterAnalysis } from '../lib/presence-rules.js'
import { htmlToText } from '../lib/html-text.js'

let app: TestApp
let org: string, other: string, owner: string, approver: string
const CONF = 'The Recipient shall hold the Confidential Information in strict confidence and use it only for the Purpose.'
const GOV = 'This Agreement is governed by the laws of the State of New York.'

const rules = (category: string, payload: object, headers = auth(org, ['ADMIN'], owner)) =>
  app.inject({ method: 'PATCH', url: `/api/v1/playbook/categories/${category}/rules`, headers, payload })
const review = (id: string) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/review`, headers: auth(org, ['ADMIN'], owner) })
const notDetected = async (id: string) => ((await review(id)).json().groups.notDetected as Array<{ title: string; status: string }>)

/** An NDA with a confidentiality clause and no governing-law clause, analysed. */
async function nda(title: string) {
  const id = await makeContract(org, owner, { title, type: 'NDA' })
  const html = `<p>${CONF}</p>`
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, htmlContent: html, plainText: htmlToText(html) } })
  await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'confidentiality', content: CONF, sortOrder: 0 } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'INDEXING', riskScore: 0.1 } })
  await finishAnalysis(id, v.id, 1)
  await afterAnalysis(id, v.id)
  return id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Category Rules Org')
  other = await makeOrg('Category Rules Other Org')
  owner = await makeUser(org)
  approver = await makeUser(org)
  await prisma.clauseCategory.createMany({
    data: [
      { id: `${org}-conf`, orgId: org, name: 'Confidentiality', presence: 'required', presenceContractTypes: ['NDA'] },
      { id: `${org}-gov`, orgId: org, name: 'Governing Law', presence: 'optional' },
    ],
  })
})

afterAll(async () => {
  await cleanupAll()
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } }).catch(() => {})
  await closeApp()
})

describe('setting a category\'s rules from the Playbook page', () => {
  it('sets presence, contract types and the approver; naming a role clears the person', async () => {
    const r = await rules(`${org}-gov`, { presence: 'required', presenceContractTypes: ['NDA', 'MSA'], approverUserId: approver })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ presence: 'required', presenceContractTypes: ['NDA', 'MSA'], approverUserId: approver, approverRoleId: null })
    expect(r.json().presenceChangedAt).toBeTruthy()

    const role = await prisma.role.create({ data: { orgId: org, name: `Deal desk ${Math.random()}` } })
    const byRole = (await rules(`${org}-gov`, { approverRoleId: role.id })).json()
    expect(byRole).toMatchObject({ approverUserId: null, approverRoleId: role.id })
    // The approver alone changes no presence rule.
    expect(byRole.presenceChangedAt).toBe(r.json().presenceChangedAt)

    expect((await rules(`${org}-gov`, { presence: 'sometimes' })).statusCode).toBe(400)
    expect((await rules(`${org}-gov`, { approverUserId: approver, approverRoleId: role.id })).statusCode).toBe(400)
    // Reset for the next test.
    await prisma.clauseCategory.update({ where: { id: `${org}-gov` }, data: { presence: 'optional', presenceContractTypes: [], presenceChangedAt: null } })
  })

  it('needs the right to edit the playbook, and never reaches another org\'s category', async () => {
    expect((await rules(`${org}-gov`, { presence: 'required' }, auth(org, ['VIEWER'], owner))).statusCode).toBe(403)
    const outsider = await makeUser(other)
    expect((await rules(`${org}-gov`, { presence: 'required' }, auth(other, ['ADMIN'], outsider))).statusCode).toBe(404)
    expect((await prisma.clauseCategory.findUniqueOrThrow({ where: { id: `${org}-gov` } })).presence).toBe('optional')
  })
})

describe('findings follow a presence change on the next review read', () => {
  it('flags a clause now required, and drops it again when optional; a signed contract keeps its findings', async () => {
    const draft = await nda('NDA — no governing law')
    const signed = await nda('NDA — signed without governing law')
    await prisma.contract.update({ where: { id: signed }, data: { executedAt: new Date(), status: 'EXECUTED' } })
    expect(await notDetected(draft)).toEqual([])
    expect(await notDetected(signed)).toEqual([])

    expect((await rules(`${org}-gov`, { presence: 'required', presenceContractTypes: ['NDA'] })).statusCode).toBe(200)
    expect((await notDetected(draft)).map(f => f.title)).toEqual(['Governing Law — not detected'])
    expect(await notDetected(signed)).toEqual([])

    // Required for MSAs only: an NDA no longer needs it.
    await rules(`${org}-gov`, { presenceContractTypes: ['MSA'] })
    expect(await notDetected(draft)).toEqual([])
  })
})
