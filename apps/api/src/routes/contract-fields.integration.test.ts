/**
 * docs/39 B1 / G1 / B5 — the field store, through its routes and the
 * extraction's PATCH:
 *
 *   - a contract analysed before the store existed reads its legacy values
 *     into rows on first touch, keeping who set them;
 *   - a person's value is typed, verified, written through to the columns
 *     and keyTerms every reader uses, and audited without the value;
 *   - re-extraction never overwrites a value a person set or checked: it
 *     leaves a suggestion, which the person can take or leave;
 *   - `fill_blanks` re-analysis fills only empty values; a full re-analysis
 *     no longer empties them first;
 *   - the pre-split notice period moves to the notice it really is (F1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, otherOrg: string, otherUser: string

const agentHeaders = () => ({
  'x-internal-service': 'agents',
  'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string,
  'x-org-id': org,
})
const admin = () => auth(org, ['ADMIN'], owner)
type Field = { key: string; value: unknown; source: string | null; locked: boolean; verifiedAt: string | null; suggestion: { value: unknown } | null; label: string; kind: string; display: string }

async function fields(id: string): Promise<Record<string, Field>> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/fields`, headers: admin() })
  expect(res.statusCode).toBe(200)
  return Object.fromEntries((res.json().fields as Field[]).map(f => [f.key, f]))
}

/** A contract as the extraction left it before the store existed. */
async function analysed(over: Partial<{ type: string; status: string }> = {}) {
  const id = await makeContract(org, owner, { title: 'Supply MSA', type: over.type ?? 'MSA', status: over.status ?? 'DRAFT' })
  await prisma.contract.update({
    where: { id },
    data: {
      analysisStatus: 'DONE',
      effectiveDate: new Date('2025-01-01'), expiryDate: new Date('2026-12-31'),
      value: 120000, currency: 'USD', jurisdiction: 'Delaware', counterpartyName: 'Initech LLC',
      keyTerms: {
        effectiveDate: '2025-01-01', expiryDate: '2026-12-31', value: 120000, currency: 'USD',
        governingLaw: 'Delaware', autoRenew: true, noticePeriodDays: 90,
        parties: [{ role: 'Vendor', name: 'Initech LLC' }, { role: 'Client', name: 'Our Org' }],
        governing_law: 'Delaware',
      },
      fieldConfidence: {
        effectiveDate: { confidence: 0.95, quote: 'effective as of January 1, 2025' },
        expiryDate: { confidence: 0.9, quote: 'until December 31, 2026' },
        value: { confidence: 0.6, quote: 'fees of $120,000' },
        currency: { confidence: 0.9, quote: 'USD' },
        governingLaw: { confidence: 0.99, quote: 'laws of Delaware', verifiedAt: '2026-09-01T00:00:00.000Z', verifiedBy: owner },
        autoRenew: { confidence: 0.8, quote: 'renews automatically' },
        noticePeriodDays: { confidence: 0.7, quote: 'ninety (90) days prior written notice' },
        parties: { confidence: 0.9, quote: 'between Initech LLC and Our Org' },
      },
      metadata: {
        _typeFields: { dispute_resolution: { value: 'Arbitration in NYC', confidence: 0.8, quote: 'arbitration', label: 'Dispute Resolution' } },
        cost_center: 'CC-42',
        _compliance: { score: 80 },
      },
    },
  })
  return id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Field Store Org')
  owner = await makeUser(org)
  otherOrg = await makeOrg('Field Store Other Org')
  otherUser = await makeUser(otherOrg)
  await prisma.contractFieldDefinition.createMany({
    data: [
      { orgId: org, fieldKey: 'cost_center', fieldLabel: 'Cost center', fieldType: 'text' },
      { orgId: org, fieldKey: 'data_region', fieldLabel: 'Data region', fieldType: 'select', options: ['EU', 'US', 'UK'] },
    ],
  })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('reading a contract analysed before the store existed', () => {
  it('reads every legacy value into a field, keeping who set it', async () => {
    const id = await analysed()
    const f = await fields(id)
    expect(f.effectiveDate).toMatchObject({ value: '2025-01-01', source: 'ai', locked: false })
    expect(f.governingLaw).toMatchObject({ value: 'Delaware', source: 'ai', locked: true })
    expect(f.governingLaw.verifiedAt).toBeTruthy()
    expect(f.counterpartyName).toMatchObject({ value: 'Initech LLC', source: 'ai' })
    expect(f.noticePeriodDays).toMatchObject({ value: { value: 90, unit: 'days' }, label: 'Notice period (unconfirmed)' })
    expect(f.dispute_resolution).toMatchObject({ kind: 'type', value: 'Arbitration in NYC', label: 'Dispute Resolution' })
    // No evidence → a person (or an import) put it there.
    expect(f.cost_center).toMatchObject({ kind: 'custom', value: 'CC-42', source: 'user', locked: true })
    expect(f.data_region).toMatchObject({ kind: 'custom', value: null, source: null })
    // An empty core field is listed, ready to fill.
    expect(f.nonRenewalNotice).toMatchObject({ value: null, source: null })
  })

  it('folds an older spelling into the canonical key', async () => {
    const id = await analysed()
    await fields(id)
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/effectiveDate/verify`, headers: admin() })
    const row = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(row.keyTerms).not.toHaveProperty('governing_law')
    expect(row.keyTerms).toMatchObject({ governingLaw: 'Delaware' })
  })

  it('answers 404 for another org\'s contract', async () => {
    const id = await analysed()
    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/fields`, headers: auth(otherOrg, ['ADMIN'], otherUser) })
    expect(res.statusCode).toBe(404)
  })
})

describe('a person sets a value', () => {
  it('is typed, verified, written to the columns and keyTerms, and audited without the value', async () => {
    const id = await analysed()
    const put = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/expiryDate`, headers: admin(), payload: { value: '30 June 2027' } })
    expect(put.statusCode).toBe(200)
    expect(put.json().field).toMatchObject({ value: '2027-06-30', source: 'user', locked: true, display: 'Jun 30, 2027' })
    const row = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(row.expiryDate?.toISOString().slice(0, 10)).toBe('2027-06-30')
    expect(row.keyTerms).toMatchObject({ expiryDate: '2027-06-30' })
    expect((row.fieldConfidence as Record<string, { source: string; verifiedAt?: string }>).expiryDate).toMatchObject({ source: 'user' })

    const audit = await prisma.auditEvent.findFirst({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' }, orderBy: { createdAt: 'desc' } })
    expect(audit?.metadata).toEqual({ source: 'fields_panel', action: 'corrected', field: 'expiryDate' })
    expect(JSON.stringify(audit?.metadata)).not.toContain('2027')
  })

  it('explains what it expected when the value does not read as the field\'s type', async () => {
    const id = await analysed()
    const bad = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/expiryDate`, headers: admin(), payload: { value: 'next spring' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().detail).toMatch(/date/i)
    const option = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/data_region`, headers: admin(), payload: { value: 'Mars' } })
    expect(option.statusCode).toBe(400)
    const ok = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/data_region`, headers: admin(), payload: { value: 'eu' } })
    expect(ok.json().field).toMatchObject({ value: 'EU' })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).metadata).toMatchObject({ data_region: 'EU', _compliance: { score: 80 } })
  })

  it('edits a contract-type field, which nobody could before', async () => {
    const id = await analysed()
    const res = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/dispute_resolution`, headers: admin(), payload: { value: 'Courts of New York' } })
    expect(res.statusCode).toBe(200)
    const md = (await prisma.contract.findUniqueOrThrow({ where: { id } })).metadata as Record<string, Record<string, { value: string; source: string }>>
    expect(md._typeFields.dispute_resolution).toMatchObject({ value: 'Courts of New York', source: 'user' })
  })

  it('a value set from a highlight must carry the highlighted text', async () => {
    const id = await analysed()
    const missing = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/value`, headers: admin(), payload: { value: '150000', source: 'highlight' } })
    expect(missing.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'PUT', url: `/api/v1/contracts/${id}/fields/value`, headers: admin(),
      payload: { value: '$150,000', source: 'highlight', quote: 'total fees of $150,000', anchor: { occurrence: 0 } },
    })
    expect(ok.json().field).toMatchObject({ value: 150000, source: 'highlight', quote: 'total fees of $150,000' })
  })
})

describe('re-extraction and people\'s values (G1)', () => {
  async function extract(id: string, keyTerms: Record<string, unknown>, fieldConfidence: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: agentHeaders(),
      payload: { keyTerms, fieldConfidence, analysisStatus: 'DONE', ...extra },
    })
    expect(res.statusCode).toBe(200)
  }

  it('refreshes what the AI owns, and leaves a suggestion on what a person set or checked', async () => {
    const id = await analysed()
    await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/expiryDate`, headers: admin(), payload: { value: '2027-06-30' } })
    await extract(id,
      { expiryDate: '2028-01-31', governingLaw: 'New York', value: 99000, effectiveDate: '2025-02-01' },
      { expiryDate: { confidence: 0.9 }, governingLaw: { confidence: 0.9, quote: 'laws of New York' }, value: { confidence: 0.9 }, effectiveDate: { confidence: 0.9 } },
      { expiryDate: '2028-01-31T00:00:00.000Z', jurisdiction: 'New York', value: 99000 },
    )
    const f = await fields(id)
    // AI-owned, unchecked: refreshed.
    expect(f.effectiveDate.value).toBe('2025-02-01')
    expect(f.value.value).toBe(99000)
    // Set by a person: kept, with what the AI read beside it.
    expect(f.expiryDate.value).toBe('2027-06-30')
    expect(f.expiryDate.suggestion?.value).toBe('2028-01-31')
    // Checked by a person: kept too.
    expect(f.governingLaw.value).toBe('Delaware')
    expect(f.governingLaw.suggestion?.value).toBe('New York')
    const row = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(row.expiryDate?.toISOString().slice(0, 10)).toBe('2027-06-30')
    expect(row.jurisdiction).toBe('Delaware')
    // Other reports survive.
    expect(row.metadata).toMatchObject({ _compliance: { score: 80 }, cost_center: 'CC-42' })
  })

  it('taking a suggestion makes it the checked value; leaving it clears it', async () => {
    const id = await analysed()
    await extract(id, { governingLaw: 'Texas' }, { governingLaw: { confidence: 0.9, quote: 'laws of Texas' } })
    const take = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/governingLaw/suggestion`, headers: admin(), payload: { action: 'accept' } })
    expect(take.json().field).toMatchObject({ value: 'Texas', locked: true, suggestion: null, quote: 'laws of Texas' })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).jurisdiction).toBe('Texas')

    await extract(id, { governingLaw: 'Ohio' }, { governingLaw: { confidence: 0.9 } })
    const leave = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/governingLaw/suggestion`, headers: admin(), payload: { action: 'dismiss' } })
    expect(leave.json().field).toMatchObject({ value: 'Texas', suggestion: null })
  })

  it('a later version keeps who the contract is with, as a suggestion', async () => {
    const id = await analysed()
    await prisma.contractVersion.createMany({ data: [
      { contractId: id, versionNumber: 1, createdById: owner },
      { contractId: id, versionNumber: 2, createdById: owner },
    ] })
    await extract(id, {}, {}, { counterpartyName: 'Someone Else Inc' })
    const f = await fields(id)
    expect(f.counterpartyName.value).toBe('Initech LLC')
    expect(f.counterpartyName.suggestion?.value).toBe('Someone Else Inc')
  })

  it('fill_blanks re-analysis fills only empty values, and a full re-analysis empties nothing', async () => {
    const id = await analysed()
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: 'An agreement.' } })
    const queued = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/analyze`, headers: admin(), payload: { fields: 'fill_blanks' } })
    expect(queued.statusCode).toBe(200)
    expect(queued.json().fields).toBe('fill_blanks')
    await extract(id, { effectiveDate: '2030-01-01', paymentTermsDays: 45 }, { effectiveDate: { confidence: 0.9 }, paymentTermsDays: { confidence: 0.9 } })
    const f = await fields(id)
    expect(f.effectiveDate.value).toBe('2025-01-01')
    expect(f.effectiveDate.suggestion?.value).toBe('2030-01-01')
    expect(f.paymentTermsDays.value).toBe(45)
    // The mode applied to that one write.
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).metadata).not.toHaveProperty('_extractionMode')
  })

  it('an absence the model is sure of clears a stale AI value; a vague one keeps it', async () => {
    const id = await analysed()
    await extract(id, { autoRenew: null, paymentTermsDays: null }, { autoRenew: { confidence: 1 }, paymentTermsDays: { confidence: 0.3 } })
    const f = await fields(id)
    expect(f.autoRenew.value).toBeNull()
    expect(f.value.value).toBe(120000)
  })
})

describe('an end date from a start and a term (F2)', () => {
  it('is calculated when nobody stated one, follows its inputs, and gives way to a stated or a person\'s date', async () => {
    const id = await makeContract(org, owner, { title: 'Term only', type: 'SOW' })
    const extract = (keyTerms: Record<string, unknown>) => app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: agentHeaders(),
      payload: { keyTerms, fieldConfidence: Object.fromEntries(Object.keys(keyTerms).map(k => [k, { confidence: 0.9 }])) },
    })
    await extract({ effectiveDate: '2025-01-15', initialTerm: '12 months', expiryDate: null })
    let f = await fields(id)
    expect(f.expiryDate).toMatchObject({ value: '2026-01-14', source: 'calculated', locked: false })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).expiryDate?.toISOString().slice(0, 10)).toBe('2026-01-14')

    // A person moves the start: the calculated end follows.
    await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/effectiveDate`, headers: admin(), payload: { value: '2025-02-01' } })
    f = await fields(id)
    expect(f.expiryDate).toMatchObject({ value: '2026-01-31', source: 'calculated' })

    // A person's end date wins, and stays when the start moves again.
    await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/expiryDate`, headers: admin(), payload: { value: '2026-06-30' } })
    await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/effectiveDate`, headers: admin(), payload: { value: '2025-03-01' } })
    f = await fields(id)
    expect(f.expiryDate).toMatchObject({ value: '2026-06-30', source: 'user' })
  })

  it('a stated end date replaces a calculated one', async () => {
    const id = await makeContract(org, owner, { title: 'Term then date', type: 'SOW' })
    const extract = (keyTerms: Record<string, unknown>) => app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: agentHeaders(),
      payload: { keyTerms, fieldConfidence: Object.fromEntries(Object.keys(keyTerms).map(k => [k, { confidence: 0.9 }])) },
    })
    await extract({ effectiveDate: '2025-01-15', initialTerm: '12 months' })
    await extract({ effectiveDate: '2025-01-15', initialTerm: '12 months', expiryDate: '2025-12-31' })
    const f = await fields(id)
    expect(f.expiryDate).toMatchObject({ value: '2025-12-31', source: 'ai' })
  })
})

describe('the notice period found before notices were told apart (F1)', () => {
  it('moves to the notice it really is, checked by the person who said so', async () => {
    const id = await analysed()
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/noticePeriodDays/reassign`, headers: admin(), payload: { to: 'nonRenewalNotice' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().field).toMatchObject({ key: 'nonRenewalNotice', value: { value: 90, unit: 'days' }, locked: true })
    const f = await fields(id)
    expect(f.noticePeriodDays).toBeUndefined()
    const row = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(row.keyTerms).toMatchObject({ nonRenewalNotice: { value: 90, unit: 'days' } })
    expect(row.keyTerms).not.toHaveProperty('noticePeriodDays')
  })

  it('refuses to move a value between fields of different types', async () => {
    const id = await analysed()
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/fields/noticePeriodDays/reassign`, headers: admin(), payload: { to: 'expiryDate' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('show in document (B2)', () => {
  type Anchor = { versionId: string; start: number | null; end: number | null; text: string | null; occurrence: number }
  type Anchored = Field & { anchor: Anchor | null; updatedAt: string }
  const anchored = async (id: string) => await fields(id) as Record<string, Anchored>
  const V1 = 'MASTER SUPPLY AGREEMENT\n\nThis Agreement is effective as of\nJanuary 1, 2025 between Initech LLC and Our Org.\n\n4. FEES. Customer shall pay fees of $120,000 per year, invoiced in USD.\n\n12. This Agreement is governed by the laws of Delaware.'

  async function withVersion(text: string): Promise<{ id: string; versionId: string }> {
    const id = await analysed()
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: text } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
    return { id, versionId: v.id }
  }

  it('places each quote in the version the contract stands on, in the document\'s own words', async () => {
    const { id, versionId } = await withVersion(V1)
    const f = await anchored(id)
    const eff = f.effectiveDate.anchor!
    expect(eff).toMatchObject({ versionId, occurrence: 0 })
    // The quote said "effective as of January 1, 2025"; the document breaks the line there.
    expect(eff.text).toBe('effective as of\nJanuary 1, 2025')
    expect(V1.slice(eff.start!, eff.end!)).toBe(eff.text)
    expect(f.governingLaw.anchor?.text).toBe('laws of Delaware')
    // A short quote that appears once is still placed.
    expect(f.currency.anchor?.text).toBe('USD')
  })

  it('leaves a short quote that appears twice unplaced, and takes the one a person pointed at', async () => {
    const text = 'Term. Twelve months. Renewal. Twelve months unless notice is given.'
    const { id } = await withVersion(text)
    await fields(id)
    // As an extraction that quoted only "Twelve months" would leave it.
    await prisma.contractFieldValue.updateMany({ where: { contractId: id, fieldKey: 'value' }, data: { quote: 'Twelve months', anchor: Prisma.JsonNull } })
    let f = await anchored(id)
    expect(f.value.anchor).toMatchObject({ start: null })
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/contracts/${id}/fields/renewalTerm`, headers: admin(),
      payload: { value: '12 months', source: 'highlight', quote: 'Twelve months', anchor: { occurrence: 1 } },
    })
    expect(res.statusCode).toBe(200)
    f = await anchored(id)
    const a = f.renewalTerm.anchor!
    expect(a).toMatchObject({ occurrence: 1, text: 'Twelve months' })
    expect(a.start).toBe(text.lastIndexOf('Twelve months'))
  })

  it('places again in a new version, and says when the words are gone, without touching the value', async () => {
    const { id } = await withVersion(V1)
    const before = await anchored(id)
    const v2 = await prisma.contractVersion.create({
      data: { contractId: id, versionNumber: 2, createdById: owner, plainText: V1.replace('laws of Delaware', 'laws of the State of New York') },
    })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
    const f = await anchored(id)
    expect(f.effectiveDate.anchor).toMatchObject({ versionId: v2.id, text: 'effective as of\nJanuary 1, 2025' })
    expect(f.governingLaw.anchor).toMatchObject({ versionId: v2.id, start: null, text: null })
    expect(f.governingLaw.value).toBe('Delaware')
    // Placing a quote changes no value, so the value's "updated" time stays.
    expect(f.governingLaw.updatedAt).toBe(before.governingLaw.updatedAt)
  })

  it('finds a quote with an elision, and one whose end drifts from the text', async () => {
    const { locateQuote } = await import('../lib/field-store.js')
    const { normalizeForSearch } = await import('../lib/text-span.js')
    const doc = 'The initial term of this Agreement shall commence on the Effective Date and shall continue for a period of twelve (12) months, unless terminated earlier.'
    const t = normalizeForSearch(doc)
    const elided = locateQuote(t, 'The initial term of this Agreement … shall continue for a period of twelve (12) months')!
    expect(doc.slice(elided.start, elided.end)).toBe('The initial term of this Agreement shall commence on the Effective Date and shall continue for a period of twelve (12) months')
    const drifted = locateQuote(t, 'The initial term of this Agreement shall commence on the Effective Date and continues for 12 months')!
    expect(doc.slice(drifted.start, drifted.end)).toBe('The initial term of this Agreement shall commence')
    expect(locateQuote(t, 'Nothing like this is in the contract at all')).toBeNull()
  })
})

describe('dates written with numbers (A11)', () => {
  const setOrder = async (order: string) => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: admin(), payload: { settings: { dateOrder: order } } })
    return res.statusCode
  }
  afterAll(async () => { await setOrder('MDY') })

  it('reads a typed date the way the org writes dates, and refuses any other order', async () => {
    const id = await analysed()
    const typed = async () => (await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/executionDate`, headers: admin(), payload: { value: '03/04/2025' } })).json().field.value
    expect(await setOrder('MDY')).toBe(200)
    expect(await typed()).toBe('2025-03-04')
    expect(await setOrder('DMY')).toBe(200)
    expect(await typed()).toBe('2025-04-03')
    expect(await setOrder('YMD')).toBe(400)
  })

  it('flags a date the AI read from a quote that could go either way', async () => {
    const id = await makeContract(org, owner, { title: 'Dated 03/04/2025', type: 'MSA' })
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: agentHeaders(),
      payload: {
        keyTerms: { effectiveDate: '2025-04-03', expiryDate: '2026-04-02' },
        fieldConfidence: {
          effectiveDate: { confidence: 0.95, quote: 'This Agreement is dated 03/04/2025.' },
          expiryDate: { confidence: 0.95, quote: 'ends on 2 April 2026' },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    const f = await fields(id) as Record<string, Field & { confidence: number; issue: string | null }>
    expect(f.effectiveDate.confidence).toBe(0.6)
    expect(f.effectiveDate.issue).toBe('Written "03/04/2025": read as Apr 3, 2025, but it could be Mar 4, 2025. Check which the contract means.')
    // Written out in words, a date reads one way: nothing to flag.
    expect(f.expiryDate).toMatchObject({ confidence: 0.95, issue: null })
  })
})

describe('readings a field can’t hold, and the custom pass (A5)', () => {
  type Evidence = Field & { confidence: number | null; issue: string | null; quote: string | null }
  const extract = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: agentHeaders(), payload })

  it('keeps a reading the field can’t hold as not found, saying what the AI read, for a person', async () => {
    const id = await makeContract(org, owner, { title: 'Hosting MSA', type: 'MSA' })
    await prisma.contract.update({ where: { id }, data: { analysisStatus: 'DONE' } })
    const r = await extract(id, {
      keyTerms: { paymentFrequency: 'Every other Tuesday' },
      fieldConfidence: { paymentFrequency: { confidence: 0.9, quote: 'invoiced every other Tuesday' } },
      metadata: { data_region: 'Mars', _customFieldEvidence: { data_region: { confidence: 0.95, quote: 'hosted on Mars' } } },
    })
    expect(r.statusCode).toBe(200)
    const f = await fields(id) as unknown as Record<string, Evidence>
    expect(f.data_region).toMatchObject({ value: null, confidence: 0.3, quote: 'hosted on Mars' })
    expect(f.data_region.issue).toBe('The AI read “Mars”, which isn\'t one of its choices (EU, US, UK). Enter the value, or clear it if the contract doesn\'t say.')
    expect(f.paymentFrequency).toMatchObject({ value: null, confidence: 0.3 })
    // Not in the metadata the filters and search read either.
    expect(((await prisma.contract.findUniqueOrThrow({ where: { id } })).metadata as Record<string, unknown>).data_region ?? null).toBeNull()
    const q = await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${id}`, headers: admin() })
    expect(q.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'data_region', reason: 'not_found' })]))
  })

  it('passes on the custom pass’s own doubt about a reading', async () => {
    const id = await makeContract(org, owner, { title: 'EU MSA', type: 'MSA' })
    await prisma.contract.update({ where: { id }, data: { analysisStatus: 'DONE' } })
    const issue = 'Its quote isn\'t in the document word for word: check the value against the contract.'
    await extract(id, { metadata: { data_region: 'EU', _customFieldEvidence: { data_region: { confidence: 0.5, quote: 'hosted in Europe', issue } } } })
    const f = await fields(id) as unknown as Record<string, Evidence>
    expect(f.data_region).toMatchObject({ value: 'EU', confidence: 0.5, issue })
  })

  it('offers what people set or checked on other contracts as examples, one of each', async () => {
    const { fieldExamples } = await import('../lib/field-examples.js')
    const ids: string[] = []
    for (const [value, quote] of [['UK', 'data stays in London'], ['UK', 'hosted in the United Kingdom'], ['US', 'servers in Virginia']] as const) {
      const id = await makeContract(org, owner, { title: `Region ${value}`, type: 'MSA' })
      const put = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/data_region`, headers: admin(), payload: { value, source: 'highlight', quote } })
      expect(put.statusCode).toBe(200)
      ids.push(id)
    }
    const ex = (await fieldExamples(org, ['data_region'], { excludeContractId: ids[2] })).get('data_region') ?? []
    // The contract being read isn't its own example; the same answer twice teaches nothing new.
    expect(ex.map(e => e.value)).toEqual(['UK'])
    expect(ex[0].quote).toBe('hosted in the United Kingdom')
  })
})
