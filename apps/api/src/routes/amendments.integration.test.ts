/**
 * docs/41 Part 13 — an amendment drafted from what changes: numbered per
 * parent, its operative words built around the parent's clauses, a redline
 * against the words in effect, the parent's effective view once it is
 * signed, the roll-up that keeps the original value one click away and
 * supersedes the obligations a replaced clause carried; none of it reachable
 * from another org.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
// The agents service, as /amendment_language answers: new words, and a quote
// of the parent's words (one the clause holds, one it doesn't).
const agentCalls: Array<{ items: Array<{ clauseText: string; instruction: string }> }> = []
vi.mock('../lib/model-boundary.js', async (orig) => ({
  ...await orig<typeof import('../lib/model-boundary.js')>(),
  modelFetch: vi.fn(async (url: string, init: RequestInit) => {
    if (!url.endsWith('/amendment_language')) return new Response('{}', { status: 503 })
    const body = JSON.parse(init.body as string)
    agentCalls.push(body)
    return new Response(JSON.stringify({ drafts: body.items.map((it: { clauseId: string }, i: number) => ({
      clauseId: it.clauseId, proposedText: 'Payment is due within forty-five (45) days of invoice.', rationale: 'As asked',
      quote: i === 0 ? 'thirty (30) days' : 'sixty (60) days', error: null,
    })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  }),
}))
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, parent: string, feesClause: string, termClause: string, ob: string
let otherOrg: string, otherUser: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })
const admin = () => auth(org, ['ADMIN'], owner)
const outsider = () => auth(otherOrg, ['ADMIN'], otherUser)
const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = admin()) =>
  app.inject({ method, url: `/api/v1/contracts${url}`, headers, ...(payload ? { payload: payload as object } : {}) })

const FEES = 'Payment is due within thirty (30) days of invoice.'

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Amendment Org')
  owner = await makeUser(org)
  otherOrg = await makeOrg('Other Org')
  otherUser = await makeUser(otherOrg)
  parent = await makeContract(org, owner, { title: 'Globex MSA', type: 'MSA', status: 'EXECUTED' })
  const v = await prisma.contractVersion.create({ data: { contractId: parent, versionNumber: 1, createdById: owner, plainText: `1. Term. One year.\n5. Fees. ${FEES}` } })
  await prisma.contract.update({ where: { id: parent }, data: { currentVersionId: v.id, effectiveDate: new Date('2024-01-01'), counterpartyName: 'Globex' } })
  termClause = (await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'term', sectionRef: '1', content: 'The term is one year.', sortOrder: 0 } })).id
  feesClause = (await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'payment_terms', sectionRef: '5', content: FEES, sortOrder: 1 } })).id
  ob = (await prisma.obligation.create({ data: { orgId: org, contractId: parent, type: 'payment', description: 'Pay invoices in 30 days', quote: FEES, sectionRef: '5' } })).id
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

let a1: string, a2: string

describe('drafting an amendment from what changes', () => {
  it('numbers it, writes the operative words around the parent’s clause, and records the changes', async () => {
    const r = await req('POST', `/${parent}/amendments`, {
      relationshipType: 'amendment', effectiveDate: '2025-06-01',
      changes: [
        { kind: 'clause', clauseId: feesClause, action: 'replace', newText: 'Payment is due within forty-five (45) days of invoice.', source: 'ai', instruction: '45 days' },
        { kind: 'term', key: 'expiryDate', label: 'Expiry date', from: '2025-12-31', to: '2027-12-31' },
      ],
    })
    expect(r.statusCode).toBe(201)
    const body = r.json()
    expect(body).toMatchObject({ amendmentNumber: 1, label: 'Amendment No. 1', relationshipType: 'amendment', title: 'Amendment No. 1 to Globex MSA' })
    a1 = body.id
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: a1 }, select: { metadata: true, currentVersionId: true } })
    const spec = (c.metadata as { _amendment: { changes: Array<{ parentText?: string }> } })._amendment
    expect(spec.changes[0].parentText).toBe(FEES)
    const v = await prisma.contractVersion.findUniqueOrThrow({ where: { id: c.currentVersionId! } })
    expect(v.htmlContent).toContain('Section 5 of the Agreement is deleted in its entirety and replaced with the following:')
    expect(v.htmlContent).toContain('forty-five (45) days')
    expect(v.plainText).toContain('The Expiry date is amended to read: 2027-12-31.')    // E2 step 0 — created through the lifecycle: its starting stage is on the record.
    const ev = await prisma.auditEvent.findFirst({ where: { orgId: org, resourceId: a1, action: 'STAGE_CHANGED' } })
    expect(ev?.metadata).toMatchObject({ created: true, toStage: 'draft', from: null, parentContractId: parent, relationshipType: 'amendment' })
  })

  it('counts on per parent, takes a number a person gives, and lets it be corrected', async () => {
    const r = await req('POST', `/${parent}/amendments`, { relationshipType: 'amendment' })
    expect(r.json().amendmentNumber).toBe(2)
    a2 = r.json().id
    const sow = await req('POST', `/${parent}/amendments`, { relationshipType: 'Statement of Work', amendmentNumber: 3 })
    expect(sow.json()).toMatchObject({ relationshipType: 'sow', amendmentNumber: 3, label: 'SOW #3' })
    const fix = await req('PUT', `/${a2}/amendment-number`, { amendmentNumber: 4 })
    expect(fix.statusCode).toBe(200)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: a2 } })).amendmentNumber).toBe(4)
    const fam = (await req('GET', `/${a2}/family`)).json()
    expect(fam.label).toBe('Amendment No. 4')
    expect(fam.splitFromParent).toBe(false)
  })

  it('refuses a replace with no words, and a clause from another agreement', async () => {
    const empty = await req('POST', `/${parent}/amendments`, { changes: [{ kind: 'clause', clauseId: feesClause, action: 'replace', newText: ' ' }] })
    expect(empty.statusCode).toBe(400)
    const elsewhere = await makeContract(org, owner, { title: 'Other' })
    const r = await req('POST', `/${elsewhere}/amendments`, { changes: [{ kind: 'clause', clauseId: feesClause, action: 'delete' }] })
    expect(r.statusCode).toBe(400)
  })

  it('reads an older spelling as the relationship it meant (the column holds the fixed set)', async () => {
    const id = await makeContract(org, owner, { title: 'Old exhibit' })
    await prisma.contract.update({ where: { id }, data: { parentContractId: parent, relationshipType: 'exhibit_only' } })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).relationshipType).toBe('exhibit')
  })

  it('drafts new words from an instruction, with the parent’s words as the evidence', async () => {
    const r = await req('POST', `/${parent}/amendment-language`, { items: [{ clauseId: feesClause, instruction: 'Make it 45 days' }] })
    expect(r.statusCode).toBe(200)
    expect(r.json().drafts[0]).toMatchObject({ clauseId: feesClause, parentText: FEES, quote: 'thirty (30) days', proposedText: 'Payment is due within forty-five (45) days of invoice.' })
    expect(agentCalls[0].items[0]).toMatchObject({ clauseText: FEES, instruction: 'Make it 45 days' })
    // A quote the clause doesn't hold is not shown as evidence.
    const two = await req('POST', `/${parent}/amendment-language`, { items: [{ clauseId: termClause, instruction: 'Two years' }, { clauseId: feesClause, instruction: 'Sixty days' }] })
    expect(two.json().drafts[1]).toMatchObject({ clauseId: feesClause, quote: null })
  })
})

describe('once it is signed', () => {
  beforeAll(async () => {
    const patch = (id: string, keyTerms: Record<string, unknown>, fieldConfidence: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: internal(), payload: { analysisStatus: 'DONE', keyTerms, fieldConfidence } })
    expect((await patch(parent, { paymentTermsDays: 30 }, { paymentTermsDays: { confidence: 0.9, quote: 'thirty (30) days' } })).statusCode).toBe(200)
    expect((await patch(a1, { paymentTermsDays: 45 }, { paymentTermsDays: { confidence: 0.9, quote: 'forty-five (45) days' } })).statusCode).toBe(200)
    await prisma.contract.update({ where: { id: a1 }, data: { status: 'EXECUTED', stage: 'active', stageState: 'in_effect', effectiveDate: new Date('2025-06-01') } })
  })

  it('shows the redline of the parent’s words in effect against the words being signed', async () => {
    const r = (await req('GET', `/${a1}/amendment-redline`)).json()
    expect(r.parent).toMatchObject({ id: parent })
    expect(r.items[0]).toMatchObject({ kind: 'clause', name: 'Section 5', current: FEES, proposed: 'Payment is due within forty-five (45) days of invoice.' })
    expect(r.items[0].segments).toEqual(expect.arrayContaining([{ op: 'delete', text: 'thirty (30) ' }, { op: 'insert', text: 'forty-five (45) ' }]))
    expect(r.items[1]).toMatchObject({ kind: 'term', name: 'Expiry date', current: '2025-12-31', proposed: '2027-12-31' })
  })

  it('marks the amended section in the parent’s effective view, and leaves the rest as written', async () => {
    const r = (await req('GET', `/${parent}/effective`)).json()
    const fees = r.sections.find((s: { clauseId: string }) => s.clauseId === feesClause)
    expect(fees).toMatchObject({ text: 'Payment is due within forty-five (45) days of invoice.', originalText: FEES })
    expect(fees.amendedBy[0]).toMatchObject({ contractId: a1, short: 'A1', label: 'Amendment No. 1' })
    expect(r.sections.find((s: { clauseId: string }) => s.clauseId === termClause).amendedBy).toEqual([])
  })

  it('shows the family from the top agreement, numbered', async () => {
    const r = (await req('GET', `/${a1}/family-tree`)).json()
    expect(r.root.id).toBe(parent)
    expect(r.currentId).toBe(a1)
    const labels = r.root.children.map((c: { label: string | null }) => c.label)
    expect(labels).toEqual(expect.arrayContaining(['Amendment No. 1', 'Amendment No. 4', 'SOW #3']))
    expect(r.root.children.find((c: { id: string }) => c.id === a1)).toMatchObject({ signed: true, changesTerms: true })
  })

  it('rolls a confirmed term up, keeps the original one click away, and supersedes the replaced clause’s obligation', async () => {
    const changes = (await req('GET', `/${a1}/amendment-changes`)).json()
    expect(changes.changes.find((c: { key: string }) => c.key === 'paymentTermsDays')).toBeTruthy()
    expect(changes.obligations.map((o: { id: string }) => o.id)).toEqual([ob])
    const r = await req('POST', `/${a1}/amendment-changes/apply`, { keys: ['paymentTermsDays'], supersedeObligationIds: [ob] })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ applied: ['paymentTermsDays'], superseded: 1 })
    const h = (await req('GET', `/${parent}/term-history`)).json().terms.paymentTermsDays
    expect(h.values).toHaveLength(2)
    expect(h.values[0]).toMatchObject({ current: false, source: null })
    expect(h.values[1]).toMatchObject({ current: true, source: { contractId: a1, label: 'Amendment No. 1' } })
    expect((await prisma.obligation.findUniqueOrThrow({ where: { id: ob } })).supersededById).toBe(a1)

    // Undone, the history goes and the obligation is owed again.
    const undo = await app.inject({ method: 'POST', url: `/api/v1/field-runs/${r.json().runId}/undo`, headers: admin() })
    expect(undo.statusCode).toBe(200)
    expect((await req('GET', `/${parent}/term-history`)).json().terms).toEqual({})
    expect((await prisma.obligation.findUniqueOrThrow({ where: { id: ob } })).supersededById).toBeNull()
  })
})

describe('the assistant', () => {
  it('reads the terms and sections in effect, each naming the amendment that changed it', async () => {
    expect((await req('POST', `/${a1}/amendment-changes/apply`, { keys: ['paymentTermsDays'] })).statusCode).toBe(200)
    const r = await app.inject({ method: 'POST', url: '/api/internal/ai/tools/contract_get', headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string }, payload: { orgId: org, contractId: parent } })
    expect(r.statusCode).toBe(200)
    const e = r.json().effectiveTerms
    expect(e.terms[0]).toMatchObject({ key: 'paymentTermsDays', amendedBy: 'Amendment No. 1' })
    expect(e.terms[0].original).toBeTruthy()
    expect(e.sections[0]).toMatchObject({ sectionRef: '5', amendedBy: ['Amendment No. 1'] })
  })
})

describe('another org', () => {
  it('can’t read or change any of it', async () => {
    for (const url of [`/${parent}/effective`, `/${parent}/family-tree`, `/${parent}/term-history`, `/${a1}/amendment-redline`]) {
      expect((await req('GET', url, undefined, outsider())).statusCode, url).toBe(404)
    }
    expect((await req('PUT', `/${a1}/amendment-number`, { amendmentNumber: 9 }, outsider())).statusCode).toBe(404)
    expect((await req('POST', `/${parent}/amendment-language`, { items: [{ clauseId: feesClause, instruction: 'Make it 60 days' }] }, outsider())).statusCode).toBe(404)
    expect((await req('POST', `/${a1}/amendment-changes/apply`, { keys: [], supersedeObligationIds: [ob] }, outsider())).statusCode).toBe(404)
    const mine = await makeContract(otherOrg, otherUser, { title: 'Theirs' })
    const r = await req('POST', `/${mine}/amendments`, { changes: [{ kind: 'clause', clauseId: feesClause, action: 'delete' }] }, outsider())
    expect(r.statusCode).toBe(400)
    expect((await prisma.obligation.findUniqueOrThrow({ where: { id: ob } })).supersededById).toBeNull()
  })
})
