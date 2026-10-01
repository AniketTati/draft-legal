/**
 * C5 — review-queue corrections must write through to the canonical contract
 * columns (the contracts list, renewals and the renewal scan read those, not
 * keyTerms), and "reject" must clear the value as its label says.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { invalidatePermissionCache } from '../lib/permissions.js'

let app: TestApp
let org: string, owner: string, contract: string

const lowConfidence = (quote: string) => ({ confidence: 0.4, quote })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Review Queue Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Needs Review', status: 'EXECUTED' })
  await prisma.contract.update({
    where: { id: contract },
    data: {
      analysisStatus: 'DONE',
      effectiveDate: new Date('2024-01-01'),
      expiryDate: new Date('2025-01-01'),
      value: 1000,
      jurisdiction: 'Delaware',
      keyTerms: { effectiveDate: '2024-01-01', expiryDate: '2025-01-01', value: 1000, governingLaw: 'Delaware', noticePeriod: '30 days' },
      fieldConfidence: {
        effectiveDate: lowConfidence('commencing January 1'),
        expiryDate:    lowConfidence('ending on'),
        value:         lowConfidence('fees of'),
        governingLaw:  lowConfidence('laws of'),
        noticePeriod:  lowConfidence('notice'),
      },
    },
  })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

const admin = () => auth(org, ['ADMIN'], owner)
const verify = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/review-queue/${contract}/verify`, headers: admin(), payload })

describe('review queue corrections', () => {
  it('lists the low-confidence fields, filterable to one contract', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${contract}`, headers: admin() })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((i: { field: string }) => i.field).sort())
      .toEqual(['effectiveDate', 'expiryDate', 'governingLaw', 'noticePeriodDays', 'value'])
  })

  it('a corrected expiry date, value and governing law reach the columns the list and renewals read', async () => {
    expect((await verify({ field: 'expiryDate', value: '2027-06-30' })).statusCode).toBe(200)
    expect((await verify({ field: 'value', value: '250000' })).statusCode).toBe(200)
    expect((await verify({ field: 'effectiveDate', value: '2024-07-01' })).statusCode).toBe(200)
    expect((await verify({ field: 'governingLaw', value: 'New York' })).statusCode).toBe(200)

    const row = await prisma.contract.findUnique({ where: { id: contract } })
    expect(row?.expiryDate?.toISOString().slice(0, 10)).toBe('2027-06-30')
    expect(row?.effectiveDate?.toISOString().slice(0, 10)).toBe('2024-07-01')
    expect(Number(row?.value)).toBe(250000)
    expect(row?.jurisdiction).toBe('New York')
    // keyTerms stays in step so every reader agrees.
    expect(row?.keyTerms).toMatchObject({ expiryDate: '2027-06-30', value: 250000, governingLaw: 'New York' })

    const list = await app.inject({ method: 'GET', url: '/api/v1/contracts', headers: admin() })
    const listed = list.json().data.find((c: { id: string }) => c.id === contract)
    expect(listed.expiryDate.slice(0, 10)).toBe('2027-06-30')
    expect(Number(listed.value)).toBe(250000)

    // Verified entries leave the queue.
    const q = await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${contract}`, headers: admin() })
    expect(q.json().items.map((i: { field: string }) => i.field)).toEqual(['noticePeriodDays'])
  })

  it('refuses a correction that is not a date or a number', async () => {
    expect((await verify({ field: 'expiryDate', value: 'next spring' })).statusCode).toBe(400)
    expect((await verify({ field: 'value', value: 'lots' })).statusCode).toBe(400)
  })

  it('reject clears the value, as its label says', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review-queue/${contract}/reject`, headers: admin(),
      payload: { field: 'noticePeriod' },
    })
    expect(res.statusCode).toBe(200)
    const row = await prisma.contract.findUnique({ where: { id: contract } })
    expect(row?.keyTerms).not.toHaveProperty('noticePeriod')
    expect((row?.fieldConfidence as Record<string, { rejectedAt?: string }>).noticePeriodDays.rejectedAt).toBeTruthy()

    const expiry = await app.inject({
      method: 'POST', url: `/api/v1/review-queue/${contract}/reject`, headers: admin(),
      payload: { field: 'expiryDate' },
    })
    expect(expiry.statusCode).toBe(200)
    expect((await prisma.contract.findUnique({ where: { id: contract } }))?.expiryDate).toBeNull()
  })

  it('every review is on the record, naming the field but not its value (C5 follow-up)', async () => {
    const events = await prisma.auditEvent.findMany({
      where: { orgId: org, resourceId: contract, action: 'CONTRACT_UPDATED' },
      orderBy: { createdAt: 'asc' }, select: { userId: true, metadata: true },
    })
    const reviews = events.map(e => e.metadata as { source?: string; action?: string; field?: string })
      .filter(m => m.source === 'review_queue')
    expect(reviews).toEqual(expect.arrayContaining([
      { source: 'review_queue', action: 'corrected', field: 'expiryDate' },
      { source: 'review_queue', action: 'corrected', field: 'governingLaw' },
      { source: 'review_queue', action: 'rejected', field: 'noticePeriodDays' },
    ]))
    expect(events.every(e => e.userId === owner)).toBe(true)
    expect(JSON.stringify(reviews)).not.toContain('New York')
  })
})

describe('X42 follow-up — a correction to what an approval judged', () => {
  async function approved() {
    const id = await makeContract(org, owner, { title: 'Approved deal', status: 'APPROVED' })
    await prisma.contract.update({
      where: { id },
      data: {
        analysisStatus: 'DONE', value: 1000, currency: 'USD', expiryDate: new Date('2026-01-01'),
        keyTerms: { value: 1000, currency: 'USD', expiryDate: '2026-01-01' },
        fieldConfidence: { value: lowConfidence('fees of'), currency: lowConfidence('USD'), expiryDate: lowConfidence('ending on') },
      },
    })
    return id
  }
  const correct = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/review-queue/${id}/verify`, headers: admin(), payload })
  const statusOf = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).status

  it('a changed value sends the contract back to DRAFT, on the record; the same value or an expiry doesn\'t', async () => {
    const id = await approved()
    expect((await correct(id, { field: 'value', value: '1,000' })).statusCode).toBe(200)
    expect((await correct(id, { field: 'expiryDate', value: '2027-01-01' })).statusCode).toBe(200)
    expect(await statusOf(id)).toBe('APPROVED')

    expect((await correct(id, { field: 'value', value: '2000' })).statusCode).toBe(200)
    expect(await statusOf(id)).toBe('DRAFT')
    const audit = await prisma.auditEvent.findFirst({
      where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED', metadata: { path: ['statusTo'], equals: 'DRAFT' } },
    })
    expect(audit?.metadata).toMatchObject({ source: 'review_queue', action: 'corrected', field: 'value', statusFrom: 'APPROVED', statusTo: 'DRAFT' })
  })

  it('rejecting the currency clears it and sends the contract back to DRAFT', async () => {
    const id = await approved()
    const res = await app.inject({ method: 'POST', url: `/api/v1/review-queue/${id}/reject`, headers: admin(), payload: { field: 'currency' } })
    expect(res.statusCode).toBe(200)
    const row = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect({ status: row.status, currency: row.currency }).toEqual({ status: 'DRAFT', currency: null })
  })
})

describe('docs/39 B4 — the queue on the field store', () => {
  type Item = { id: string; reason: string; contractId: string; field: string; fieldLabel: string; kind: string; value: unknown; raw: unknown; suggestion: unknown }
  type Page = { items: Item[]; total: number; counts: Record<string, number>; fields: Array<{ key: string; label: string; count: number }> }
  let other: string, c1: string, c2: string

  const queue = async (qs: string, headers = admin()): Promise<Page> => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/review-queue?${qs}`, headers })
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  const patchAsAgent = (id: string, payload: Record<string, unknown>) => app.inject({
    method: 'PATCH', url: `/api/v1/contracts/${id}`,
    headers: { 'x-internal-service': 'agents', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-org-id': org },
    payload,
  })

  beforeAll(async () => {
    other = await makeUser(org)
    // An MSA whose contract-type term and custom field the AI wasn't sure of.
    await prisma.contractFieldDefinition.create({ data: { orgId: org, fieldKey: 'po_number', fieldLabel: 'PO number', fieldType: 'text', contractType: null } })
    c1 = await makeContract(org, owner, { title: 'Queue MSA', type: 'MSA' })
    await prisma.contract.update({ where: { id: c1 }, data: { analysisStatus: 'DONE' } })
    const agent = await patchAsAgent(c1, {
      keyTerms: { governingLaw: 'Delaware', paymentTermsDays: 30, liabilityCapAmount: null },
      fieldConfidence: {
        governingLaw: { confidence: 0.95, quote: 'governed by the laws of Delaware' },
        paymentTermsDays: { confidence: 0.5, quote: 'within thirty (30) days of invoice' },
        liabilityCapAmount: { confidence: 0.4 },
      },
      metadata: {
        _typeFields: { dispute_resolution: { value: 'Arbitration in London', confidence: 0.45, quote: 'arbitration seated in London', label: 'Dispute resolution' } },
        po_number: 'PO-7781',
        _customFieldEvidence: { po_number: { confidence: 0.3, quote: 'Purchase Order PO-7781' } },
      },
    })
    expect(agent.statusCode).toBe(200)
    // Someone else's contract: a checked value the next analysis read differently.
    c2 = await makeContract(org, other, { title: 'Other Rep Supply', type: 'MSA' })
    await prisma.contract.update({ where: { id: c2 }, data: { analysisStatus: 'DONE' } })
    await patchAsAgent(c2, { keyTerms: { governingLaw: 'Texas' }, fieldConfidence: { governingLaw: { confidence: 0.9, quote: 'laws of Texas' } } })
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${c2}/fields/governingLaw/verify`, headers: admin() })
    await patchAsAgent(c2, { keyTerms: { governingLaw: 'Oklahoma' }, fieldConfidence: { governingLaw: { confidence: 0.9, quote: 'laws of Oklahoma' } } })
  })

  it('holds every kind of field, each with why it needs a person', async () => {
    const page = await queue(`contractId=${c1}`)
    const by = Object.fromEntries(page.items.map(i => [i.field, i]))
    expect(by.paymentTermsDays).toMatchObject({ reason: 'low_confidence', kind: 'core', value: '30 days', raw: 30 })
    expect(by.dispute_resolution).toMatchObject({ reason: 'low_confidence', kind: 'type', fieldLabel: 'Dispute resolution' })
    expect(by.po_number).toMatchObject({ reason: 'low_confidence', kind: 'custom', fieldLabel: 'PO number', value: 'PO-7781' })
    expect(by.liabilityCapAmount).toMatchObject({ reason: 'not_found', value: null })
    // A sure value needs nobody.
    expect(by.governingLaw).toBeUndefined()
  })

  it('puts a value a person checked, and the analysis now reads otherwise, first', async () => {
    const page = await queue('q=Other%20Rep')
    expect(page.items[0]).toMatchObject({ contractId: c2, field: 'governingLaw', reason: 'suggestion' })
    expect(page.counts.suggestion).toBe(1)
  })

  it('flags an AI value whose words a new version took out', async () => {
    const v2 = await prisma.contractVersion.create({ data: { contractId: c1, versionNumber: 2, createdById: owner, plainText: 'This Agreement is governed by the laws of Delaware. Invoices are payable on receipt. Disputes go to arbitration seated in London. Purchase Order PO-7781.' } })
    await prisma.contract.update({ where: { id: c1 }, data: { currentVersionId: v2.id } })
    // Nobody opens the contract: the queue places its quotes itself (B2), and the payment terms' are gone.
    const page = await queue(`contractId=${c1}&reason=words_changed`)
    expect(page.items.map(i => i.field)).toEqual(['paymentTermsDays'])
  })

  it('counts every reason, filters by reason and field, and pages', async () => {
    const all = await queue(`contractId=${c1}`)
    expect(all.counts).toMatchObject({ words_changed: 1, low_confidence: 2, not_found: 1 })
    expect(all.total).toBe(4)
    expect(all.fields.map(f => f.key).sort()).toEqual(['dispute_resolution', 'liabilityCapAmount', 'paymentTermsDays', 'po_number'])
    const one = await queue(`contractId=${c1}&field=po_number`)
    expect(one.items.map(i => i.field)).toEqual(['po_number'])
    const p1 = await queue(`contractId=${c1}&limit=2&offset=0`)
    const p2 = await queue(`contractId=${c1}&limit=2&offset=2`)
    expect([...p1.items, ...p2.items].map(i => i.id).sort()).toEqual(all.items.map(i => i.id).sort())
  })

  it('shows the passage a value came from, in its context', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/review-queue/${c2}/source?field=governingLaw`, headers: admin() })
    expect(res.statusCode).toBe(200)
    // No version text for this contract: the value, and no excerpt.
    expect(res.json()).toMatchObject({ field: { key: 'governingLaw' }, excerpt: null })
    const v = await prisma.contractVersion.create({ data: { contractId: c2, versionNumber: 1, createdById: owner, plainText: `${'Recitals. '.repeat(80)}This Agreement is governed by the laws of Texas, without regard to conflicts rules. ${'Boilerplate. '.repeat(60)}` } })
    await prisma.contract.update({ where: { id: c2 }, data: { currentVersionId: v.id } })
    const placed = (await app.inject({ method: 'GET', url: `/api/v1/review-queue/${c2}/source?field=governingLaw`, headers: admin() })).json()
    expect(placed.excerpt.match).toBe('laws of Texas')
    expect(placed.excerpt.before.endsWith('governed by the ')).toBe(true)
    expect(placed.excerpt.after.startsWith(', without regard')).toBe(true)
    expect(placed.excerpt).toMatchObject({ clippedStart: true, clippedEnd: true })
  })

  it('verifies in bulk, only what the caller may edit', async () => {
    await prisma.role.create({
      data: {
        orgId: org, name: 'QUEUE_OWN_EDITOR',
        permissions: [{ action: 'view', resource: 'contract', scope: 'own' }, { action: 'edit', resource: 'contract', scope: 'own' }],
      },
    })
    invalidatePermissionCache(org)
    const ownEditor = auth(org, ['QUEUE_OWN_EDITOR'], owner)
    const res = await app.inject({
      method: 'POST', url: '/api/v1/review-queue/verify-bulk', headers: ownEditor,
      payload: { items: [{ contractId: c1, field: 'po_number' }, { contractId: c1, field: 'dispute_resolution' }, { contractId: c2, field: 'governingLaw' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ verified: 2, failed: [{ contractId: c2, field: 'governingLaw', ok: false }] })
    const left = await queue(`contractId=${c1}`)
    expect(left.items.map(i => i.field).sort()).toEqual(['liabilityCapAmount', 'paymentTermsDays'])
    // The other rep's contract is untouched.
    expect((await queue('q=Other%20Rep')).counts.suggestion).toBe(1)
  })

  it('says which notice many unconfirmed notice periods are, at once (F1)', async () => {
    const ids: string[] = []
    for (const days of [60, 90]) {
      const id = await makeContract(org, owner, { title: `Renewing SaaS ${days}`, type: 'SAAS' })
      await prisma.contract.update({
        where: { id },
        data: { analysisStatus: 'DONE', keyTerms: { noticePeriodDays: days }, fieldConfidence: { noticePeriodDays: { confidence: 0.9, quote: `${days} days before renewal` } } },
      })
      ids.push(id)
    }
    const page = await queue('reason=notice_type&q=Renewing%20SaaS')
    expect(page.items.map(i => i.contractId).sort()).toEqual([...ids].sort())
    const res = await app.inject({
      method: 'POST', url: '/api/v1/review-queue/reassign-bulk', headers: admin(),
      payload: { to: 'nonRenewalNotice', items: page.items.map(i => ({ contractId: i.contractId, field: i.field })) },
    })
    expect(res.json()).toMatchObject({ reassigned: 2, failed: [] })
    expect((await queue('reason=notice_type&q=Renewing%20SaaS')).total).toBe(0)
    const row = await prisma.contract.findUniqueOrThrow({ where: { id: ids[1] } })
    expect(row.keyTerms).toMatchObject({ nonRenewalNotice: { value: 90, unit: 'days' } })
  })
})
