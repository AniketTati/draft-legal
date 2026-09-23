/**
 * X17 — a diligence room's documents are a target company's contracts. C11
 * kept them out of search and the agent's answers, but the org's own figures
 * still counted them: analytics, the dashboard KPIs, renewals, obligations,
 * counterparty counts, and precedents (which also averaged every version,
 * superseded text included). Adding a room contract must not move any of them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueNotification: vi.fn(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { scanObligations, scanRenewals } from '../lib/obligation-scanner.js'
import { queueNotification } from '../lib/queue.js'

const DIM = 1536
const unit = (i: number) => `[${Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0)).join(',')}]`
const IN_30_DAYS = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

let app: TestApp
let org: string, user: string, subject: string, peer: string, room: string, roomContract: string, counterparty: string

async function version(contractId: string, n: number, vector: string, current: boolean): Promise<string> {
  const v = await prisma.contractVersion.create({ data: { contractId, versionNumber: n, createdById: user, plainText: 'x' } })
  const clauseId = `it-x17-${v.id}`
  await prisma.contractClause.create({ data: { id: clauseId, versionId: v.id, clauseType: 'payment', content: 'x' } })
  await prisma.$executeRawUnsafe(`UPDATE contract_clauses SET embedding = '${vector}'::vector WHERE id = '${clauseId}'`)
  if (current) await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id } })
  return v.id
}

async function msa(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await makeContract(org, user, { title, type: 'MSA', status: 'EXECUTED' })
  await prisma.contract.update({
    where: { id },
    data: { expiryDate: IN_30_DAYS, value: 1000, counterpartyId: counterparty, counterpartyName: 'Acme Target Supplier', riskScore: 70, ...extra },
  })
  return id
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: auth(org, ['ADMIN'], user) })

async function snapshot() {
  const bodies = await Promise.all([
    '/api/v1/analytics/summary', '/api/v1/analytics/distributions', '/api/v1/analytics/top-counterparties',
    '/api/v1/renewals/stats', '/api/v1/obligations/stats', '/api/v1/counterparties',
    `/api/v1/counterparties/${counterparty}`,
  ].map(async u => [u, (await get(u)).json()] as const))
  const dash = (await get('/api/v1/dashboard')).json()
  return { ...Object.fromEntries(bodies), dashboard: { ...dash, recentActivity: undefined } }
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Diligence Portfolio Org')
  user = await makeUser(org)
  counterparty = (await prisma.counterparty.create({ data: { orgId: org, name: 'Acme Target Supplier' } })).id
  subject = await msa('Our MSA')
  peer = await msa('Our other MSA')
  // The subject's superseded version reads very differently from its current one.
  await version(subject, 1, unit(1), false)
  await version(subject, 2, unit(0), true)
  await version(peer, 1, unit(0), true)
  await prisma.obligation.create({ data: { orgId: org, contractId: subject, type: 'payment', description: 'Pay monthly', quote: 'Pay monthly', dueDate: IN_30_DAYS } })
  room = (await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Project Falcon', createdById: user } })).id
})

afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { orgId: org } })
  await prisma.approvalInstance.deleteMany({ where: { orgId: org } })
  await prisma.workflowDefinition.deleteMany({ where: { orgId: org } })
  await prisma.obligation.deleteMany({ where: { orgId: org } })
  await prisma.contractClause.deleteMany({ where: { id: { startsWith: 'it-x17-' } } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null, counterpartyId: null, diligenceRoomId: null } })
  await prisma.diligenceRoom.deleteMany({ where: { orgId: org } })
  await prisma.counterparty.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('a diligence room\'s contract is not part of the org\'s figures', () => {
  it('analytics, dashboard, renewals, obligations and counterparty counts don\'t move', async () => {
    const before = await snapshot()
    roomContract = await msa('TARGET CO MSA', { diligenceRoomId: room })
    await version(roomContract, 1, unit(0), true)
    const roomObligation = await prisma.obligation.create({
      data: { orgId: org, contractId: roomContract, type: 'payment', description: 'Target pays', quote: 'Target pays', dueDate: IN_30_DAYS },
    })
    expect(await snapshot()).toEqual(before)

    expect((await get('/api/v1/renewals')).body).not.toContain(roomContract)
    expect((await get('/api/v1/obligations')).body).not.toContain(roomObligation.id)
    // …though the room contract's own obligations rail still lists them.
    expect((await get(`/api/v1/obligations?contractId=${roomContract}`)).body).toContain(roomObligation.id)
  })

  it('precedents come from the org\'s own contracts, compared on their current text', async () => {
    const res = await get(`/api/v1/contracts/${subject}/precedents`)
    expect(res.statusCode).toBe(200)
    const peers = res.json().data as Array<{ contractId?: string; id?: string; similarity: number }>
    const ids = peers.map(p => p.contractId ?? p.id)
    expect(ids).not.toContain(roomContract)
    expect(ids).toContain(peer)
    // Averaging the superseded version in made this ~0.71; the current texts match.
    expect(peers.find(p => (p.contractId ?? p.id) === peer)!.similarity).toBeGreaterThan(0.99)
  })
})

describe('…nor of the org\'s reminders, matching, workload or queues (review follow-up)', () => {
  const IN_3_DAYS = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)

  it('the daily scanners don\'t remind anyone about a target\'s obligations or renewals', async () => {
    await prisma.obligation.create({ data: { orgId: org, contractId: roomContract, type: 'delivery', description: 'Target delivers', quote: 'x', dueDate: IN_3_DAYS } })
    await prisma.obligation.create({ data: { orgId: org, contractId: peer, type: 'delivery', description: 'We deliver', quote: 'x', dueDate: IN_3_DAYS } })
    vi.mocked(queueNotification).mockClear()
    await scanObligations({ orgId: org })
    await scanRenewals({ orgId: org })
    const sent = JSON.stringify(vi.mocked(queueNotification).mock.calls)
    expect(sent).toContain('Our other MSA')        // our own obligation…
    expect(sent).not.toContain('TARGET CO MSA')    // …never the room's
  })

  it('an invoice is never matched to a target\'s payment obligation', async () => {
    await prisma.obligation.updateMany({ where: { orgId: org, contractId: { not: roomContract } }, data: { status: 'COMPLETED' } })
    const roomPayment = await prisma.obligation.create({ data: { orgId: org, contractId: roomContract, type: 'payment', description: 'Pay 1000', quote: 'x', dueDate: IN_3_DAYS } })
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/invoices', headers: auth(org, ['ADMIN'], user),
        payload: { vendorName: 'Acme Target Supplier', amount: 1000, invoiceDate: new Date().toISOString() },
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().invoice.matchedObligationId ?? null).not.toBe(roomPayment.id)
    } finally {
      await prisma.obligation.updateMany({ where: { orgId: org, contractId: { not: roomContract } }, data: { status: 'OPEN' } })
    }
  })

  it('team workload, the org approval count and the extraction queue leave the room out', async () => {
    const mine = (await get('/api/v1/team/workload')).json().find((m: { id: string }) => m.id === user)
    expect(mine.activeContracts).toBe(await prisma.contract.count({ where: { orgId: org, ownerId: user, deletedAt: null, diligenceRoomId: null } }))

    const before = (await get('/api/v1/dashboard')).json().orgPendingApprovals
    const wf = await makeWorkflow(org, user, user)
    await prisma.approvalInstance.create({ data: { orgId: org, contractId: roomContract, workflowDefinitionId: wf, submittedById: user } })
    expect((await get('/api/v1/dashboard')).json().orgPendingApprovals).toBe(before)

    await prisma.contract.update({ where: { id: roomContract }, data: { analysisStatus: 'DONE', fieldConfidence: { value: { confidence: 0.2 } } } })
    expect((await get('/api/v1/review-queue')).body).not.toContain(roomContract)
    expect((await get(`/api/v1/review-queue?diligenceRoomId=${room}`)).body).toContain(roomContract)
  })
})
