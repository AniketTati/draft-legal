/**
 * docs/39 B3 — what a person checked, and how sure to be of what they didn't:
 * a computed confidence (a missing quote, a flag, the field's record), each
 * field's check level, a contract's Verified / Partly / Unverified state with
 * Check all, and the contracts list and its export saying so.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { runExtractionJob, type ExtractionDeps } from '../lib/extraction-job.js'

let app: TestApp
let org: string, owner: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })
const admin = () => auth(org, ['ADMIN'], owner)
const fields = (id: string) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/fields`, headers: admin() }).then(r => r.json())
const field = async (id: string, key: string) => (await fields(id)).fields.find((f: { key: string }) => f.key === key)

/** A contract as an analysis leaves it: these values, with this evidence. */
async function analysed(title: string, keyTerms: Record<string, unknown>, fieldConfidence: Record<string, unknown>) {
  const id = await makeContract(org, owner, { title, type: 'MSA' })
  const r = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: internal(), payload: { analysisStatus: 'DONE', keyTerms, fieldConfidence } })
  expect(r.statusCode).toBe(200)
  return id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Verification Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('a contract’s fields', () => {
  it('are as sure as what can be checked allows, saying why, and the contract says how much a person checked', async () => {
    const id = await analysed('Plain MSA', { governingLaw: 'Delaware', paymentTermsDays: 30, autoRenew: false }, {
      governingLaw: { confidence: 0.95, quote: 'governed by the laws of Delaware' },
      paymentTermsDays: { confidence: 0.9 },
      autoRenew: { confidence: 0.9 },
    })
    const v = await fields(id)
    const by = (k: string) => v.fields.find((f: { key: string }) => f.key === k)
    expect(by('governingLaw')).toMatchObject({ confidence: 0.95, modelConfidence: 0.95, confidenceReasons: [], check: 'unsure', checkBelow: 0.7 })
    expect(by('paymentTermsDays')).toMatchObject({ confidence: 0.65, modelConfidence: 0.9, confidenceReasons: ['It quotes no passage of the contract'] })
    // A clause that isn't there has nothing to quote.
    expect(by('autoRenew')).toMatchObject({ value: false, confidence: 0.9 })
    expect(v.verification).toEqual({ state: 'unverified', checked: 0, filled: 3 })

    await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/governingLaw/verify`, headers: admin() })
    expect((await fields(id)).verification).toEqual({ state: 'partly', checked: 1, filled: 3 })

    const all = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/verify-all`, headers: admin() })
    expect(all.json()).toMatchObject({ verified: expect.arrayContaining(['paymentTermsDays', 'autoRenew']), verification: { state: 'verified', checked: 3, filled: 3 } })
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/verify-all`, headers: auth(org, ['VIEWER'], owner) })).statusCode).toBe(403)
  })

  it('Check all leaves what a person must decide: a second reading, a notice of unknown type', async () => {
    const id = await analysed('Undecided MSA', { governingLaw: 'Delaware', noticePeriod: '30 days' }, {
      governingLaw: { confidence: 0.9, quote: 'laws of Delaware' }, noticePeriod: { confidence: 0.9, quote: 'thirty days notice' },
    })
    const r = (await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/verify-all`, headers: admin() })).json()
    expect(r.verified).toEqual(['governingLaw'])
    expect(r.verification.state).toBe('partly')
  })
})

describe('corrections', () => {
  it('are kept with what the AI read, and a field corrected often is less sure on the next contract', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await analysed(`Net ${i}`, { paymentTermsDays: 30 }, { paymentTermsDays: { confidence: 0.95, quote: 'net thirty (30) days' } }))
    for (const id of ids.slice(0, 3)) {
      await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/paymentTermsDays`, headers: admin(), payload: { value: 45 } })
    }
    for (const id of ids.slice(3)) await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/paymentTermsDays/verify`, headers: admin() })
    const row = await prisma.contractFieldValue.findFirstOrThrow({ where: { contractId: ids[0], fieldKey: 'paymentTermsDays' } })
    expect(row).toMatchObject({ value: 45, source: 'user', correctedFrom: { value: 30, quote: 'net thirty (30) days', confidence: 0.95 } })

    // Kept on 3 (the first test's Check all, and two here), corrected on 3: right half the time.
    const next = await analysed('Net 6', { paymentTermsDays: 30 }, { paymentTermsDays: { confidence: 0.95, quote: 'net thirty (30) days' } })
    expect(await field(next, 'paymentTermsDays')).toMatchObject({
      confidence: 0.5, modelConfidence: 0.95,
      confidenceReasons: ['People corrected this field on 3 of the 6 contracts they checked'],
    })

    const records = (await app.inject({ method: 'GET', url: '/api/v1/field-definitions/records', headers: admin() })).json().fields
    expect(records[0]).toMatchObject({ key: 'paymentTermsDays', confirmed: 3, corrected: 3, accuracy: 0.5, attention: true, unchecked: 1 })
  })
})

describe('corrections as examples (I2)', () => {
  it('go to the next extraction for a field corrected more than once — not for the one contract’s own facts', async () => {
    // The corrections test above corrected Payment terms 30 → 45 on three contracts.
    const id = await makeContract(org, owner, { title: 'Next.pdf', type: 'MSA' })
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: 'Payment is due net thirty (30) days.' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
    let body: Record<string, unknown> | null = null
    const deps: ExtractionDeps = {
      async review(b) { body = b; return new Response(JSON.stringify({ contract: { analysisStatus: 'DONE' }, version: {}, failed: false }), { status: 200 }) },
      async reviewLegacy() { return new Response('{}') },
      async api(method, path, orgId, payload) {
        const res = await app.inject({ method, url: path, payload: payload as never, headers: { ...internal(), 'x-org-id': orgId } })
        return { status: res.statusCode, text: res.body }
      },
    }
    await runExtractionJob({ data: { contractId: id, versionId: v.id, orgId: org }, attemptsMade: 0, opts: { attempts: 3 }, async updateData() {} }, deps)
    expect(body!.corrections).toEqual([{
      key: 'paymentTermsDays', label: 'Payment terms',
      examples: [{ read: '30 days', corrected: '45 days', quote: 'net thirty (30) days' }],
    }])
    await prisma.contract.update({ where: { id }, data: { currentVersionId: null } })
  })
})

describe('check levels', () => {
  it('always: every unchecked value is listed, however sure; rarely: only the very unsure', async () => {
    const put = (key: string, level: string, roles = ['ADMIN']) =>
      app.inject({ method: 'PUT', url: '/api/v1/field-definitions/checks', headers: auth(org, roles, owner), payload: { key, level } })
    const sure = await analysed('Sure MSA', { governingLaw: 'Delaware', executionDate: '2025-01-15' }, {
      governingLaw: { confidence: 0.98, quote: 'laws of Delaware' },
      executionDate: { confidence: 0.5, quote: 'signed on 15 January 2025' },
    })
    const queue = async () => (await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${sure}`, headers: admin() })).json().items
      .map((i: { field: string; reason: string }) => `${i.field}:${i.reason}`).sort()

    expect(await queue()).toEqual(['executionDate:low_confidence'])
    expect((await put('governingLaw', 'always')).statusCode).toBe(200)
    expect((await put('executionDate', 'rarely')).statusCode).toBe(200)
    expect(await queue()).toEqual(['governingLaw:always'])
    expect(await field(sure, 'governingLaw')).toMatchObject({ check: 'always', checkBelow: null })

    expect((await put('governingLaw', 'unsure', ['LEGAL_COUNSEL'])).statusCode).toBe(403)
    expect((await put('noSuchField', 'always')).statusCode).toBe(404)
    // The settings form can't set them around the check.
    await app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: admin(), payload: { settings: { fieldChecks: { governingLaw: 'rarely' } } } })
    expect((await app.inject({ method: 'GET', url: '/api/v1/field-definitions/records', headers: admin() })).json().fields
      .find((f: { key: string }) => f.key === 'governingLaw').check).toBe('always')

    await put('governingLaw', 'unsure')
    await put('executionDate', 'unsure')
    expect(await queue()).toEqual(['executionDate:low_confidence'])
  })
})

describe('the contracts list and its export', () => {
  it('filter and sort by how much a person checked, and say it per contract', async () => {
    const done = await analysed('All checked', { governingLaw: 'Ohio' }, { governingLaw: { confidence: 0.9, quote: 'laws of Ohio' } })
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${done}/fields/verify-all`, headers: admin() })
    const none = await analysed('None checked', { governingLaw: 'Iowa', paymentTermsDays: 60 }, {
      governingLaw: { confidence: 0.9, quote: 'laws of Iowa' }, paymentTermsDays: { confidence: 0.9, quote: 'sixty (60) days' },
    })
    const query = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/v1/contracts/query', headers: admin(), payload: { limit: 100, ...payload } }).then(r => r.json())

    const verified = await query({ checked: 'verified' })
    expect(verified.data.map((c: { id: string }) => c.id)).toContain(done)
    expect(verified.data.map((c: { id: string }) => c.id)).not.toContain(none)
    const unverified = (await query({ checked: 'unverified' })).data
    expect(unverified.find((c: { id: string }) => c.id === none).verification).toEqual({ state: 'unverified', checked: 0, filled: 2 })

    const sorted = (await query({ sort: { key: 'checked', dir: 'desc' } })).data.map((c: { id: string }) => c.id)
    expect(sorted.indexOf(done)).toBeLessThan(sorted.indexOf(none))

    // The assistant asks the same: "which contracts has nobody checked?"
    const search = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_search', headers: internal(),
      payload: { orgId: org, checked: 'unverified', limit: 50 },
    })
    const found = search.json().results.map((c: { id: string }) => c.id)
    expect(found).toContain(none)
    expect(found).not.toContain(done)

    const csv = await app.inject({ method: 'POST', url: '/api/v1/contracts/query/export', headers: admin(), payload: { q: 'None checked' } })
    const [head, row] = csv.body.replace(/^\uFEFF/, '').split('\r\n')
    expect(head).toContain('Values checked,Not yet checked')
    expect(row).toContain('0 of 2,Governing law; Payment terms')
  })
})
