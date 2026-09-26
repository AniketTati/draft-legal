/**
 * X19 — an invoice may only be linked to a contract the caller can see.
 * `POST /invoices` stored `contractId` without checking its org, so any role
 * with edit:contract could attach another org's contract and read its title
 * and counterparty back from the 201. The auto-matcher also scored every
 * obligation in the org, so an own-scope editor was shown (and linked to)
 * another rep's contract and payment obligation, on create and on rematch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, otherOrg: string, repA: string, repB: string, mine: string, theirs: string, foreign: string, deleted: string
const DUE = new Date('2026-10-15T00:00:00Z')

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Invoice Link Org')
  otherOrg = await makeOrg('Invoice Link Other Org')
  repA = await makeUser(org)
  repB = await makeUser(org)
  const outsider = await makeUser(otherOrg)
  await prisma.role.create({
    data: {
      orgId: org, name: 'OWN_EDITOR',
      permissions: [
        { action: 'view', resource: 'contract', scope: 'own' },
        { action: 'edit', resource: 'contract', scope: 'own' },
      ],
    },
  })
  mine = await makeContract(org, repA, { title: 'Alpha Supply MSA', status: 'EXECUTED' })
  theirs = await makeContract(org, repB, { title: 'Bravo Globex Secret Terms', status: 'EXECUTED' })
  foreign = await makeContract(otherOrg, outsider, { title: 'OTHER ORG CONFIDENTIAL MSA', status: 'EXECUTED' })
  await prisma.contract.update({ where: { id: theirs }, data: { counterpartyName: 'Globex' } })
  await prisma.obligation.create({
    data: { orgId: org, contractId: theirs, type: 'payment', description: 'Bravo secret payment obligation', quote: 'q', dueDate: DUE },
  })
  // repA's own counterparty, and a deleted contract nobody should match.
  await prisma.contract.update({ where: { id: mine }, data: { counterpartyName: 'Initech' } })
  await prisma.obligation.create({
    data: { orgId: org, contractId: mine, type: 'payment', description: 'Alpha pays Initech', quote: 'q', dueDate: DUE },
  })
  deleted = await makeContract(org, repA, { title: 'Deleted Umbrella MSA', status: 'EXECUTED' })
  await prisma.contract.update({ where: { id: deleted }, data: { counterpartyName: 'Umbrella', deletedAt: new Date() } })
  await prisma.obligation.create({
    data: { orgId: org, contractId: deleted, type: 'payment', description: 'Umbrella obligation', quote: 'q', dueDate: DUE },
  })
})

afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { orgId: { in: [org, otherOrg] } } })
  await prisma.obligation.deleteMany({ where: { orgId: { in: [org, otherOrg] } } })
  await cleanupAll()
  await closeApp()
})

const create = (roles: string[], user: string, payload: object) =>
  app.inject({ method: 'POST', url: '/api/v1/invoices', headers: auth(org, roles, user), payload })
const globex = { vendorName: 'Globex', amount: 100, invoiceDate: DUE.toISOString() }

describe('linking an invoice to a contract', () => {
  it('another org\'s contract cannot be linked', async () => {
    const res = await create(['LEGAL_OPS'], repA, { ...globex, vendorName: 'Nobody', contractId: foreign })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('OTHER ORG CONFIDENTIAL MSA')
    expect(await prisma.invoice.count({ where: { orgId: org, contractId: foreign } })).toBe(0)
  })

  it('an own-scope editor cannot link another rep\'s contract', async () => {
    const res = await create(['OWN_EDITOR'], repA, { ...globex, vendorName: 'Nobody', contractId: theirs })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('Bravo Globex Secret Terms')
  })

  it('an own-scope editor\'s auto-match never lands on another rep\'s obligation — create or rematch', async () => {
    const res = await create(['OWN_EDITOR'], repA, globex)
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain('Bravo')
    const invoice = res.json().invoice
    expect(invoice.contractId).toBeNull()

    const again = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invoice.id}/rematch`, headers: auth(org, ['OWN_EDITOR'], repA) })
    expect(again.statusCode).toBe(200)
    expect(again.body).not.toContain('Bravo')
    // …and the editor can still open the invoice it entered.
    expect((await app.inject({ method: 'GET', url: `/api/v1/invoices/${invoice.id}`, headers: auth(org, ['OWN_EDITOR'], repA) })).statusCode).toBe(200)
  })

  it('an own-scope editor still links and auto-matches its own contracts', async () => {
    const manual = await create(['OWN_EDITOR'], repA, { ...globex, vendorName: 'Nobody', contractId: mine })
    expect(manual.statusCode).toBe(201)
    expect(manual.json().invoice.contractId).toBe(mine)
    const matched = await create(['OWN_EDITOR'], repA, { ...globex, vendorName: 'Initech' })
    expect(matched.json().invoice).toMatchObject({ contractId: mine, status: 'MATCHED' })
  })

  it('a deleted contract is neither linkable nor matched', async () => {
    expect((await create(['LEGAL_OPS'], repA, { ...globex, vendorName: 'Nobody', contractId: deleted })).statusCode).toBe(404)
    const res = await create(['LEGAL_OPS'], repA, { ...globex, vendorName: 'Umbrella' })
    expect(res.statusCode).toBe(201)
    expect(res.json().invoice.contractId).toBeNull()
    expect(res.body).not.toContain('Deleted Umbrella MSA')
  })

  it('an empty contractId is a 400, not a 500', async () => {
    expect((await create(['LEGAL_OPS'], repA, { ...globex, contractId: '' })).statusCode).toBe(400)
  })

  it('reconciling closes the matched obligation on the invoice\'s own contract', async () => {
    const matched = (await create(['LEGAL_OPS'], repA, { ...globex, vendorName: 'Initech' })).json().invoice
    const res = await app.inject({ method: 'POST', url: `/api/v1/invoices/${matched.id}/reconcile`, headers: auth(org, ['LEGAL_OPS'], repA), payload: {} })
    expect(res.statusCode).toBe(200)
    expect((await prisma.obligation.findUniqueOrThrow({ where: { id: matched.matchedObligationId } })).status).toBe('COMPLETED')
  })

  // X63 — reconcile wrote OBLIGATION_COMPLETED whenever the invoice had a
  // match, even when the obligation was already closed and nothing changed.
  it('reconciling records the obligation as completed only when it closed it', async () => {
    const ob = await prisma.obligation.create({
      data: { orgId: org, contractId: mine, type: 'payment', description: 'X63 obligation', quote: 'q', dueDate: DUE },
    })
    const invoice = () => prisma.invoice.create({
      data: { orgId: org, contractId: mine, createdById: repA, vendorName: 'X63', amount: 1, invoiceDate: DUE, status: 'MATCHED', matchedObligationId: ob.id },
    })
    const reconcile = (id: string) =>
      app.inject({ method: 'POST', url: `/api/v1/invoices/${id}/reconcile`, headers: auth(org, ['LEGAL_OPS'], repA), payload: {} })
    const completions = () => prisma.auditEvent.count({
      where: { orgId: org, action: 'OBLIGATION_COMPLETED', resourceId: mine, metadata: { path: ['obligationId'], equals: ob.id } },
    })

    expect((await reconcile((await invoice()).id)).statusCode).toBe(200)
    expect(await completions()).toBe(1)

    // A second invoice matched to the same obligation, now completed.
    expect((await reconcile((await invoice()).id)).statusCode).toBe(200)
    expect(await completions()).toBe(1)
  })

  it('the repair migration unlinks invoices made before the fix that point at another org', async () => {
    const bad = await prisma.invoice.create({
      data: { orgId: org, contractId: foreign, createdById: repA, vendorName: 'Pre-fix', amount: 1, invoiceDate: DUE },
    })
    const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', '20260923010000_unlink_cross_org_invoices', 'migration.sql'), 'utf8')
    for (const stmt of sql.split(/;\s*$/m).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(stmt)
    }
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: bad.id } })).contractId).toBeNull()
    expect(await prisma.invoice.count({ where: { orgId: org, contractId: mine } })).toBeGreaterThan(0)
  })

  it('org-scope callers still link their org\'s contracts and auto-match across the org', async () => {
    const manual = await create(['LEGAL_OPS'], repA, { ...globex, vendorName: 'Nobody', contractId: mine })
    expect(manual.statusCode).toBe(201)
    expect(manual.json().invoice.contractId).toBe(mine)

    const matched = await create(['LEGAL_OPS'], repA, globex)
    expect(matched.statusCode).toBe(201)
    expect(matched.json().invoice.contractId).toBe(theirs)
  })
})
