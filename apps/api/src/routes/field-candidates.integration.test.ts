/**
 * docs/39 A6 — a long contract that says different things about a field.
 *
 * Its chunks each read the field; the extraction sends every reading. The
 * store keeps each once, with its words, and flags the value; the Review
 * Queue lists it and "Check all" leaves it. A person settles it — choosing a
 * reading, checking the value — and a re-analysis leaves that choice alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string

const agentHeaders = () => ({
  'x-internal-service': 'agents',
  'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string,
  'x-org-id': org,
})
const admin = () => auth(org, ['ADMIN'], owner)

type Reading = { value: unknown; display: string; quote: string | null }
type Field = { key: string; value: unknown; display: string; source: string | null; quote: string | null; issue: string | null; verifiedAt: string | null; candidates: Reading[] | null }

async function fields(id: string): Promise<Record<string, Field>> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/fields`, headers: admin() })
  expect(res.statusCode).toBe(200)
  return Object.fromEntries((res.json().fields as Field[]).map(f => [f.key, f]))
}

async function extract(id: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: agentHeaders(), payload: { analysisStatus: 'DONE', ...payload } })
  expect(res.statusCode).toBe(200)
}

const BODY = "terminate this Agreement for convenience on thirty (30) days' written notice"
const SCHEDULE = "terminate for convenience on sixty (60) days' prior written notice"
const NOTICE = {
  keyTerms: { terminationNotice: '30 days', governingLaw: 'Delaware' },
  fieldConfidence: {
    terminationNotice: {
      confidence: 0.9, quote: BODY, section: '12.1',
      candidates: [{ value: '30 days', quote: BODY }, { value: 'sixty (60) days', quote: SCHEDULE }, { value: 'thirty days', quote: 'a repeat' }],
    },
    // Readings that come to one value are no disagreement.
    governingLaw: { confidence: 0.9, quote: 'laws of Delaware', candidates: [{ value: 'Delaware', quote: 'laws of Delaware' }, { value: 'the State of Delaware', quote: 'State of Delaware' }] },
  },
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Readings Org')
  owner = await makeUser(org)
  await prisma.contractFieldDefinition.create({ data: { orgId: org, fieldKey: 'po_number', fieldLabel: 'PO number', fieldType: 'text' } })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('a field the contract says different things about (docs/39 A6)', () => {
  it('keeps every reading with its words, flags the value, and lists it until a person chooses', async () => {
    const id = await makeContract(org, owner, { title: 'Long MSA', type: 'MSA' })
    await extract(id, NOTICE)
    let f = await fields(id)
    expect(f.terminationNotice.value).toEqual({ value: 30, unit: 'days' })
    expect(f.terminationNotice.candidates?.map(c => c.display)).toEqual(['30 days', '60 days'])
    expect(f.terminationNotice.candidates?.[1].quote).toBe(SCHEDULE)
    expect(f.terminationNotice.issue).toBe('The contract says different things: 30 days and 60 days. Choose the one that governs.')
    expect(f.governingLaw.candidates).toBeNull()

    // The Review Queue lists it with its readings.
    const q = (await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${id}&reason=conflict`, headers: admin() })).json()
    expect(q.counts.conflict).toBe(1)
    expect(q.items).toHaveLength(1)
    expect(q.items[0]).toMatchObject({ field: 'terminationNotice', reason: 'conflict' })
    expect(q.items[0].candidates.map((c: Reading) => c.display)).toEqual(['30 days', '60 days'])

    // "Check all" leaves it for a person to choose.
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/verify-all`, headers: admin() })).statusCode).toBe(200)
    f = await fields(id)
    expect(f.terminationNotice.verifiedAt).toBeNull()
    expect(f.governingLaw.verifiedAt).not.toBeNull()

    // The schedule's reading chosen: the value, its words, nothing left to decide.
    const chose = await app.inject({
      method: 'PUT', url: `/api/v1/contracts/${id}/fields/terminationNotice`, headers: admin(),
      payload: { value: { value: 60, unit: 'days' }, source: 'highlight', quote: SCHEDULE },
    })
    expect(chose.statusCode).toBe(200)
    expect(chose.json().field).toMatchObject({ value: { value: 60, unit: 'days' }, source: 'highlight', quote: SCHEDULE, candidates: null })
    expect((await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${id}`, headers: admin() })).json().counts.conflict).toBe(0)

    // A re-analysis that reads them differently again leaves the person's choice alone.
    await extract(id, NOTICE)
    f = await fields(id)
    expect(f.terminationNotice).toMatchObject({ value: { value: 60, unit: 'days' }, source: 'highlight', candidates: null })
  })

  it('a checked value settles it; a type or custom field keeps its readings too; one reading is none', async () => {
    const id = await makeContract(org, owner, { title: 'Long SOW', type: 'SOW' })
    await extract(id, {
      keyTerms: { value: 120000, currency: 'USD' },
      fieldConfidence: {
        value: { confidence: 0.9, quote: 'fees of $120,000', candidates: [{ value: '120000', quote: 'fees of $120,000' }, { value: 'USD 150,000', quote: 'Schedule 2: fees of USD 150,000' }] },
        currency: { confidence: 0.9, quote: 'USD', candidates: [{ value: 'USD', quote: 'USD' }] },
      },
      metadata: {
        _typeFields: { work_location: { value: 'Remote', confidence: 0.8, quote: 'work remotely', label: 'Work Location', candidates: [{ value: 'Remote', quote: 'work remotely' }, { value: 'London office', quote: 'at the London office' }] } },
        po_number: 'PO-1',
        _customFieldEvidence: { po_number: { confidence: 0.8, quote: 'PO-1', candidates: [{ value: 'PO-1', quote: 'PO-1' }, { value: 'PO-2', quote: 'Purchase order PO-2' }] } },
      },
    })
    let f = await fields(id)
    expect(f.value.candidates?.map(c => c.value)).toEqual([120000, 150000])
    expect(f.currency.candidates).toBeNull()
    expect(f.work_location.candidates?.map(c => c.value)).toEqual(['Remote', 'London office'])
    expect(f.po_number.candidates?.map(c => c.value)).toEqual(['PO-1', 'PO-2'])

    // The value as it stands is the one that governs.
    const checked = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/value/verify`, headers: admin() })
    expect(checked.statusCode).toBe(200)
    expect(checked.json().field).toMatchObject({ value: 120000, candidates: null, issue: null })
    // Rejecting one settles it as well.
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/po_number/reject`, headers: admin() })
    f = await fields(id)
    expect(f.po_number).toMatchObject({ value: null, candidates: null })
    expect(f.work_location.candidates).toHaveLength(2)
  })
})
