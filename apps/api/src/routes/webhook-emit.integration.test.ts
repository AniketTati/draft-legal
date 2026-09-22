/**
 * H2 — the webhook events that were advertised but never emitted now fire at
 * their real trigger points. Deliveries are captured at the queue boundary.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const { delivered } = vi.hoisted(() => ({ delivered: [] as Array<{ event: string; payload: Record<string, unknown> }> }))
vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueWebhookDelivery: async (job: { event: string; payload: Record<string, unknown> }) => { delivered.push(job); return {} },
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { scanObligations } from '../lib/obligation-scanner.js'

let app: TestApp
let org: string, owner: string, approver: string, contract: string

const events = (name: string) => delivered.filter(d => d.event === name)
const settle = () => new Promise(r => setTimeout(r, 50))

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Webhook Emit Org')
  owner = await makeUser(org)
  approver = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Hooked MSA', status: 'DRAFT' })
  await prisma.webhook.create({
    data: {
      orgId: org, name: 'all events', url: 'https://example.test/hook', secret: 's', createdById: owner,
      events: ['contract.updated', 'approval.decided', 'obligation.overdue', 'invoice.created', 'amendment.created'],
    },
  })
})

afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { orgId: org } })
  await prisma.obligation.deleteMany({ where: { orgId: org } })
  await prisma.webhook.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('events that used to be advertised but never fired', () => {
  it('contract.updated on PATCH', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['ADMIN'], owner), payload: { title: 'Hooked MSA v2' } })
    expect(res.statusCode).toBe(200)
    await settle()
    expect(events('contract.updated').at(-1)?.payload).toMatchObject({ contractId: contract, title: 'Hooked MSA v2', changes: ['title'] })
  })

  it('amendment.created when a related document is created', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${contract}/amendments`, headers: auth(org, ['ADMIN'], owner),
      payload: { relationshipType: 'amendment', title: 'Amendment 1' },
    })
    expect(res.statusCode).toBe(201)
    await settle()
    expect(events('amendment.created').at(-1)?.payload).toMatchObject({ parentContractId: contract, relationshipType: 'amendment' })
  })

  it('invoice.created when an invoice is logged', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/invoices', headers: auth(org, ['ADMIN'], owner),
      payload: { vendorName: 'Acme', amount: 1200, currency: 'usd', invoiceDate: '2026-09-01' },
    })
    expect(res.statusCode).toBe(201)
    await settle()
    expect(events('invoice.created').at(-1)?.payload).toMatchObject({ vendorName: 'Acme', amount: 1200, currency: 'USD' })
  })

  it('approval.decided when an approver decides', async () => {
    const wf = await makeWorkflow(org, owner, approver)
    const c = await makeContract(org, owner, { title: 'Needs approval', status: 'DRAFT' })
    const submitted = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${c}/submit-approval`, headers: auth(org, ['ADMIN'], owner), payload: { workflowDefinitionId: wf },
    })
    const { instanceId, steps } = submitted.json()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/approvals/${instanceId}/decide`, headers: auth(org, ['ADMIN'], approver),
      payload: { stepId: steps[0].id, decision: 'APPROVED' },
    })
    expect(res.statusCode).toBe(200)
    await settle()
    expect(events('approval.decided').at(-1)?.payload).toMatchObject({ contractId: c, decision: 'APPROVED', instanceStatus: 'APPROVED' })
  })

  it('obligation.overdue once, the first time an obligation is seen overdue', async () => {
    const executed = await makeContract(org, owner, { title: 'Executed with obligations', status: 'EXECUTED' })
    await prisma.obligation.create({
      data: { orgId: org, contractId: executed, type: 'payment', description: 'Pay the quarterly fee', quote: 'pay', dueDate: new Date(Date.now() - 3 * 86400_000) },
    })
    await scanObligations({ orgId: org })
    await scanObligations({ orgId: org })
    await settle()
    const overdue = events('obligation.overdue').filter(e => e.payload.contractId === executed)
    expect(overdue).toHaveLength(1)
    expect(overdue[0].payload).toMatchObject({ description: 'Pay the quarterly fee', daysOverdue: 3 })
  })
})
