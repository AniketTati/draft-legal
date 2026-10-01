/**
 * docs/39 G2 — an edit in the app re-reads the values whose words it
 * changed: a new value is offered beside the old, the same value takes its
 * new words, and a person's value is never overwritten.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { recheckValuesAfterEdit } from '../lib/field-store.js'

let app: TestApp
let org: string, owner: string, contract: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })
const admin = () => auth(org, ['ADMIN'], owner)
const row = (key: string) => prisma.contractFieldValue.findFirstOrThrow({ where: { contractId: contract, fieldKey: key } })

const PARAS = [
  'MASTER SERVICES AGREEMENT',
  'This Agreement is governed by the laws of the State of New York, without regard to its conflict of laws rules.',
  'Customer shall pay all undisputed invoices within thirty (30) days of the invoice date.',
  'Either party may terminate this Agreement on ninety (90) days written notice to the other party.',
]
const html = (paras: string[]) => paras.map(p => `<p>${p}</p>`).join('')

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Edit Recheck Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Recheck MSA', type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: owner, plainText: PARAS.join('\n\n'), htmlContent: html(PARAS) } })
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id } })
  await app.inject({
    method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: internal(),
    payload: {
      analysisStatus: 'DONE',
      keyTerms: { governingLaw: 'New York', paymentTermsDays: 30, terminationNotice: { value: 90, unit: 'days' } },
      fieldConfidence: {
        governingLaw: { confidence: 0.95, quote: 'governed by the laws of the State of New York' },
        paymentTermsDays: { confidence: 0.9, quote: 'within thirty (30) days' },
        terminationNotice: { confidence: 0.9, quote: 'on ninety (90) days written notice' },
      },
    },
  })
  // A person set the notice themselves.
  await app.inject({ method: 'PUT', url: `/api/v1/contracts/${contract}/fields/terminationNotice`, headers: admin(), payload: { value: { value: 90, unit: 'days' } } })
  await prisma.contractFieldValue.updateMany({ where: { contractId: contract, fieldKey: 'terminationNotice' }, data: { quote: 'on ninety (90) days written notice' } })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('an edit in the app', () => {
  it('offers the value its new words give, keeps the same value with its new words, and leaves a person’s value to them', async () => {
    const edited = [
      PARAS[0],
      'This Agreement is governed by and construed under the laws of the State of New York, without regard to its conflict of laws rules.',
      'Customer shall pay all undisputed invoices within sixty (60) days of the invoice date.',
      'Either party may terminate this Agreement on thirty (30) days written notice to the other party.',
    ]
    const saved = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/html-version`, headers: admin(), payload: { htmlContent: html(edited) } })
    expect(saved.statusCode).toBe(201)
    const r = await recheckValuesAfterEdit(contract, saved.json().id)
    expect(r?.suggested.sort()).toEqual(['paymentTermsDays', 'terminationNotice'])
    expect(r?.requoted).toEqual(['governingLaw'])

    // The AI's 30 stays until someone takes the 60 offered beside it.
    expect(await row('paymentTermsDays')).toMatchObject({
      value: 30, source: 'ai',
      suggestion: { value: 60, display: '60 days', reason: 'edited', quote: 'within sixty (60) days', confidence: 0.6 },
    })
    // Reworded around, the same law: its new words are its quote, so it no longer asks to be checked.
    expect(await row('governingLaw')).toMatchObject({ value: 'New York', quote: 'governed by and construed under the laws of the State of New York', suggestion: null })
    // A person's notice stays theirs; the new reading waits beside it.
    expect(await row('terminationNotice')).toMatchObject({ value: { value: 90, unit: 'days' }, source: 'user', suggestion: { value: { value: 30, unit: 'days' }, reason: 'edited' } })

    // The Review Queue lists them as new readings.
    const items = (await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${contract}`, headers: admin() })).json().items
    expect(items.filter((i: { reason: string }) => i.reason === 'suggestion').map((i: { field: string }) => i.field).sort()).toEqual(['paymentTermsDays', 'terminationNotice'])

    // Taking one makes it the value, checked.
    const take = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/fields/paymentTermsDays/suggestion`, headers: admin(), payload: { action: 'accept' } })
    expect(take.statusCode).toBe(200)
    expect(await row('paymentTermsDays')).toMatchObject({ value: 60, suggestion: null, verifiedAt: expect.any(Date) })
  })
})
