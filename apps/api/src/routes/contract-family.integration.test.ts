/**
 * docs/39 G3 — an amendment's terms reach the agreement it amends: it is
 * found (or linked) as that agreement's amendment, a person picks the terms
 * it changes, the parent holds them (and renews and alerts on them), and the
 * roll-up can be undone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, msa: string, amendment: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })
const admin = () => auth(org, ['ADMIN'], owner)
const get = (url: string) => app.inject({ method: 'GET', url, headers: admin() }).then(r => r.json())

/** A contract as its analysis left it, with the words it was read from. */
async function analysed(title: string, text: string, keyTerms: Record<string, unknown>, fieldConfidence: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const id = await makeContract(org, owner, { title, type: 'MSA', status: 'EXECUTED' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: text } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, counterpartyName: 'Globex Corporation', ...over } })
  const r = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: internal(), payload: { analysisStatus: 'DONE', keyTerms, fieldConfidence } })
  expect(r.statusCode).toBe(200)
  return id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Family Org')
  owner = await makeUser(org)
  msa = await analysed('Globex Master Services Agreement', 'This Master Services Agreement is made on January 1, 2024 between Demo Org and Globex Corporation.', {
    effectiveDate: '2024-01-01', expiryDate: '2025-12-31', paymentTermsDays: 30, governingLaw: 'Delaware',
  }, {
    effectiveDate: { confidence: 0.95, quote: 'made on January 1, 2024' }, expiryDate: { confidence: 0.9, quote: 'until December 31, 2025' },
    paymentTermsDays: { confidence: 0.9, quote: 'net thirty (30) days' }, governingLaw: { confidence: 0.95, quote: 'laws of Delaware' },
  }, { effectiveDate: new Date('2024-01-01') })
  amendment = await analysed('Amendment No. 1', 'AMENDMENT NO. 1 to the Master Services Agreement dated January 1, 2024 between Demo Org and Globex Corporation. The Term is extended until December 31, 2027. Payment is due within forty-five (45) days.', {
    effectiveDate: '2025-06-01', expiryDate: '2027-12-31', paymentTermsDays: 45, governingLaw: 'Delaware',
  }, {
    effectiveDate: { confidence: 0.95, quote: 'effective June 1, 2025' }, expiryDate: { confidence: 0.9, quote: 'extended until December 31, 2027' },
    paymentTermsDays: { confidence: 0.9, quote: 'within forty-five (45) days' }, governingLaw: { confidence: 0.9, quote: 'laws of Delaware' },
  }, { effectiveDate: new Date('2025-06-01') })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('finding the agreement an amendment belongs to', () => {
  it('reads as an amendment, and offers the agreement it names by kind and date, with the same counterparty', async () => {
    const r = await get(`/api/v1/contracts/${amendment}/parent-suggestions`)
    expect(r.looksLike).toBe('amendment')
    expect(r.suggestions[0]).toMatchObject({ id: msa, title: 'Globex Master Services Agreement' })
    expect(r.suggestions[0].reasons).toEqual(expect.arrayContaining(['Same counterparty', 'Refers to a master services agreement', 'Mentions its date, 1 January 2024']))
  })

  it('an agreement that only talks about SOWs and itself isn’t offered a parent', async () => {
    const other = await analysed('Globex Consulting Agreement', 'MASTER SERVICES AGREEMENT\n\nThis Master Services Agreement is made on March 3, 2024. Provider performs the services in each Statement of Work (SOW No. 1 onwards) under this Agreement.', {}, {}, { effectiveDate: new Date('2024-03-03') })
    const r = await get(`/api/v1/contracts/${other}/parent-suggestions`)
    expect(r).toEqual({ looksLike: null, suggestions: [] })
  })

  it('links it, and never so that a contract becomes its own ancestor', async () => {
    const put = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/parent`, headers: admin(), payload })
    expect((await put(amendment, { parentContractId: msa, relationshipType: 'amendment' })).statusCode).toBe(200)
    expect(await prisma.contract.findUniqueOrThrow({ where: { id: amendment }, select: { parentContractId: true, relationshipType: true } }))
      .toEqual({ parentContractId: msa, relationshipType: 'amendment' })
    expect((await put(msa, { parentContractId: amendment })).statusCode).toBe(400)
    expect((await put(msa, { parentContractId: msa })).statusCode).toBe(400)
    // Linked, it's no longer offered: the agreement's own family isn't a candidate for it.
    expect((await get(`/api/v1/contracts/${msa}/parent-suggestions`)).suggestions.map((s: { id: string }) => s.id)).not.toContain(amendment)
  })
})

describe('rolling its terms up', () => {
  it('lists the terms it changes — not its own date — and sets the chosen ones on the agreement, naming it', async () => {
    const r = await get(`/api/v1/contracts/${amendment}/amendment-changes`)
    expect(r.parent).toEqual({ id: msa, title: 'Globex Master Services Agreement' })
    expect(r.changes.map((c: { key: string }) => c.key).sort()).toEqual(['expiryDate', 'paymentTermsDays'])
    expect(r.changes.find((c: { key: string }) => c.key === 'expiryDate')).toMatchObject({
      parent: { display: 'Dec 31, 2025' }, amendment: { display: 'Dec 31, 2027', quote: 'extended until December 31, 2027' }, applied: false,
    })

    const applied = await app.inject({ method: 'POST', url: `/api/v1/contracts/${amendment}/amendment-changes/apply`, headers: admin(), payload: { keys: ['expiryDate'] } })
    expect(applied.statusCode).toBe(200)
    expect(applied.json()).toMatchObject({ applied: ['expiryDate'], runId: expect.any(String) })

    const expiry = (await get(`/api/v1/contracts/${msa}/fields`)).fields.find((f: { key: string }) => f.key === 'expiryDate')
    expect(expiry).toMatchObject({ value: '2027-12-31', source: 'amendment', fromContractId: amendment, fromContract: { id: amendment, title: 'Amendment No. 1' }, quote: 'extended until December 31, 2027' })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: msa } })).expiryDate?.toISOString().slice(0, 10)).toBe('2027-12-31')
    const after = await get(`/api/v1/contracts/${amendment}/amendment-changes`)
    expect(after.changes.find((c: { key: string }) => c.key === 'expiryDate').applied).toBe(true)
    // The undo outlives the page: the latest roll-up still to be undone comes with the changes.
    expect(after.lastRun).toMatchObject({ id: applied.json().runId, count: 1 })

    // A re-analysis of the agreement leaves it.
    await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${msa}`, headers: internal(), payload: { keyTerms: { expiryDate: '2025-12-31' }, fieldConfidence: { expiryDate: { confidence: 0.99, quote: 'until December 31, 2025' } } } })
    expect((await prisma.contractFieldValue.findFirstOrThrow({ where: { contractId: msa, fieldKey: 'expiryDate' } })).value).toBe('2027-12-31')

    // Undone: the agreement's own end date is back.
    const undo = await app.inject({ method: 'POST', url: `/api/v1/field-runs/${applied.json().runId}/undo`, headers: admin() })
    expect(undo.json()).toMatchObject({ restored: 1, skipped: 0 })
    expect(await prisma.contractFieldValue.findFirstOrThrow({ where: { contractId: msa, fieldKey: 'expiryDate' } })).toMatchObject({ value: '2025-12-31', source: 'ai', fromContractId: null })
    expect((await get(`/api/v1/contracts/${amendment}/amendment-changes`)).lastRun).toBeNull()
  })

  it('an amendment renews with its agreement, not on its own', async () => {
    await prisma.contract.update({ where: { id: amendment }, data: { expiryDate: new Date(Date.now() + 20 * 86_400_000) } })
    await prisma.contract.update({ where: { id: msa }, data: { expiryDate: new Date(Date.now() + 30 * 86_400_000) } })
    const rows = (await get('/api/v1/renewals')).data as Array<{ id: string; pendingAmendment: { id: string } | null }>
    const ids = rows.map(r => r.id)
    expect(ids).toContain(msa)
    expect(ids).not.toContain(amendment)
    // The agreement's row says an amendment ends it on another date, not set on it yet.
    expect(rows.find(r => r.id === msa)?.pendingAmendment).toMatchObject({ id: amendment, title: 'Amendment No. 1' })
  })

  it('needs a link to an agreement, and edit rights', async () => {
    const lone = await makeContract(org, owner, { title: 'Lone' })
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${lone}/amendment-changes/apply`, headers: admin(), payload: { keys: ['expiryDate'] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${amendment}/amendment-changes/apply`, headers: auth(org, ['VIEWER'], owner), payload: { keys: ['expiryDate'] } })).statusCode).toBe(403)
  })
})
