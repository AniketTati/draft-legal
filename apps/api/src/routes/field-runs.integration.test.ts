/**
 * docs/39 G1/D1 — a re-analysis that changed a contract's values, or a field
 * filled in across contracts, can be undone for 30 days: every value still as
 * the run left it goes back; one a person changed since stays. And a new field
 * is tried on a few contracts first, with what a fill would take.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { runCustomFieldBackfill } from '../lib/custom-field-backfill.js'
import { previewField, estimateFill, type ExtractedField } from '../lib/field-preview.js'

let app: TestApp
let org: string, owner: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Field Runs Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

const admin = () => auth(org, ['ADMIN'], owner)
const agent = () => ({ 'x-internal-service': 'agents', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-org-id': org })
const extract = (id: string, keyTerms: Record<string, unknown>) => app.inject({
  method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: agent(),
  payload: { keyTerms, fieldConfidence: Object.fromEntries(Object.keys(keyTerms).map(k => [k, { confidence: 0.9 }])) },
})
const valueOf = async (id: string, key: string) => ((await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/fields`, headers: admin() })).json().fields as Array<{ key: string; value: unknown; source: string }>).find(f => f.key === key)

describe('undoing a re-analysis (G1)', () => {
  it('records what a re-analysis changed, and puts back what nobody touched since', async () => {
    const id = await makeContract(org, owner, { title: 'Re-read MSA', type: 'MSA' })
    await prisma.contract.update({ where: { id }, data: { analysisStatus: 'DONE' } })
    expect((await extract(id, { governingLaw: 'Delaware', paymentTermsDays: 30, value: 120000 })).statusCode).toBe(200)
    // The first analysis filled empty fields: nothing to undo.
    expect((await app.inject({ method: 'GET', url: `/api/v1/field-runs/contract/${id}/latest`, headers: admin() })).json().run).toBeNull()

    await extract(id, { governingLaw: 'Texas', paymentTermsDays: 45, value: 99000 })
    const latest = (await app.inject({ method: 'GET', url: `/api/v1/field-runs/contract/${id}/latest`, headers: admin() })).json().run
    expect(latest).toMatchObject({ kind: 'reanalysis', canUndo: true })
    expect(latest.changes.map((c: { fieldKey: string; label: string }) => [c.fieldKey, c.label]).sort()).toEqual([
      ['governingLaw', 'Governing law'], ['paymentTermsDays', 'Payment terms'], ['value', 'Contract value'],
    ])

    // A person fixes the payment terms in the meantime.
    await app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/paymentTermsDays`, headers: admin(), payload: { value: '60' } })
    const undo = await app.inject({ method: 'POST', url: `/api/v1/field-runs/${latest.id}/undo`, headers: admin() })
    expect(undo.json()).toEqual({ ok: true, restored: 2, skipped: 1 })
    expect((await valueOf(id, 'governingLaw'))?.value).toBe('Delaware')
    expect((await valueOf(id, 'value'))?.value).toBe(120000)
    expect(await valueOf(id, 'paymentTermsDays')).toMatchObject({ value: 60, source: 'user' })
    // The columns follow.
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).jurisdiction).toBe('Delaware')
    expect((await app.inject({ method: 'POST', url: `/api/v1/field-runs/${latest.id}/undo`, headers: admin() })).statusCode).toBe(409)
  })
})

describe('trying a field, and undoing its fill-in (D1)', () => {
  let defId: string
  const ids: string[] = []

  beforeAll(async () => {
    const def = await prisma.contractFieldDefinition.create({ data: { orgId: org, fieldKey: 'po_number', fieldLabel: 'PO number', fieldType: 'text', contractType: 'SOW', helpText: 'The PO number' } })
    defId = def.id
    for (const [i, po] of ['PO-1', 'PO-2', null].entries()) {
      const id = await makeContract(org, owner, { title: `SOW ${i + 1}`, type: 'SOW' })
      const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: po ? `Statement of work. Purchase order ${po}.` : 'Statement of work with no purchase order.' } })
      await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
      ids.push(id)
    }
  })

  const fake = async ({ body }: { body: { plainText: string } }): Promise<Record<string, ExtractedField>> => {
    const m = body.plainText.match(/PO-\d+/)
    return m ? { po_number: { value: m[0], confidence: 0.9, quote: `Purchase order ${m[0]}` } } : {}
  }

  it('tries the field on a few contracts, saving nothing, with an improved description if given', async () => {
    const def = await prisma.contractFieldDefinition.findUniqueOrThrow({ where: { id: defId } })
    const seen: string[] = []
    const rows = await previewField(def, { limit: 5, helpText: 'The customer’s purchase order number' }, async (a) => {
      seen.push((a.body.fields[0] as { helpText?: string }).helpText ?? '')
      return fake(a)
    })
    expect(rows.map(r => r.display).sort()).toEqual(['PO-1', 'PO-2', null].sort())
    expect(new Set(seen)).toEqual(new Set(['The customer’s purchase order number']))
    expect(await prisma.contractFieldValue.count({ where: { contractId: { in: ids }, fieldKey: 'po_number' } })).toBe(0)
  })

  it('says how many contracts a fill would read and about what it costs', async () => {
    const def = await prisma.contractFieldDefinition.findUniqueOrThrow({ where: { id: defId } })
    const e = await estimateFill(def)
    expect(e.contracts).toBe(3)
    expect(e.inputTokens).toBeGreaterThan(3 * 700)
    expect(e.usd).toBeGreaterThan(0)
  })

  it('fills it in, and the fill can be undone', async () => {
    const state = await runCustomFieldBackfill({ orgId: org, fieldDefinitionId: defId }, fake)
    // Read: the three without a value, as the estimate counted them.
    expect(state).toMatchObject({ status: 'DONE', filled: 2, read: 3 })
    expect(state?.runId).toBeTruthy()
    expect((await valueOf(ids[0], 'po_number'))?.value).toBe('PO-1')
    // The field list says the fill can be undone, and until when.
    const fillRun = async () => ((await app.inject({ method: 'GET', url: '/api/v1/field-definitions', headers: admin() })).json().data as Array<{ id: string; fillRun: unknown }>).find(d => d.id === defId)?.fillRun
    expect(await fillRun()).toMatchObject({ canUndo: true, undone: false, changed: 2 })
    const undo = await app.inject({ method: 'POST', url: `/api/v1/field-runs/${state!.runId}/undo`, headers: admin() })
    expect(undo.json()).toEqual({ ok: true, restored: 2, skipped: 0 })
    expect((await valueOf(ids[0], 'po_number'))?.value ?? null).toBeNull()
    expect(await fillRun()).toMatchObject({ canUndo: false, undone: true })
  })

  it('re-checks the AI’s values after a rewording, leaves a person’s, and the re-check can be undone (D5)', async () => {
    await prisma.contractFieldDefinition.update({ where: { id: defId }, data: { backfill: Prisma.DbNull } })
    const filled = await runCustomFieldBackfill({ orgId: org, fieldDefinitionId: defId }, fake)
    expect(filled).toMatchObject({ status: 'DONE', filled: 2 })
    // A person corrects one.
    expect((await app.inject({ method: 'PUT', url: `/api/v1/contracts/${ids[1]}/fields/po_number`, headers: admin(), payload: { value: 'PO-2-A' } })).statusCode).toBe(200)

    const def = await prisma.contractFieldDefinition.findUniqueOrThrow({ where: { id: defId } })
    expect((await estimateFill(def)).recheck).toMatchObject({ contracts: 2, aiValues: 1 })

    // The reworded field reads the first one differently.
    const reread = async (a: Parameters<typeof fake>[0]): Promise<Record<string, ExtractedField>> => {
      const m = a.body.plainText.match(/PO-\d+/)
      return m ? { po_number: { value: `${m[0]}-R`, confidence: 0.9, quote: `Purchase order ${m[0]}` } } : {}
    }
    const state = await runCustomFieldBackfill({ orgId: org, fieldDefinitionId: defId, mode: 'recheck' }, reread)
    expect(state).toMatchObject({ status: 'DONE', mode: 'recheck', read: 2, filled: 1 })
    expect((await valueOf(ids[0], 'po_number'))?.value).toBe('PO-1-R')
    expect(await valueOf(ids[1], 'po_number')).toMatchObject({ value: 'PO-2-A', source: 'user' })

    expect((await app.inject({ method: 'POST', url: `/api/v1/field-runs/${state!.runId}/undo`, headers: admin() })).json()).toEqual({ ok: true, restored: 1, skipped: 0 })
    expect((await valueOf(ids[0], 'po_number'))?.value).toBe('PO-1')
  })
})
