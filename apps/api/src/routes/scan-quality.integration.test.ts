/**
 * docs/39 A7 — a value read from a page of a scan the OCR engine was unsure
 * of asks to be checked against that page, in the Fields and the Review Queue.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, contract: string, version: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })
const admin = () => auth(org, ['ADMIN'], owner)

const PAGE_1 = 'MASTER SERVICES AGREEMENT between Initech LLC and Hooli Inc. This Agreement is governed by the laws of the State of Texas.'
const PAGE_2 = 'Payment. Customer shall pay each invoice within thirty (30) days of receipt.'

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Scan Quality Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Initech MSA (scanned)', type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: {
    contractId: contract, versionNumber: 1, createdById: owner, plainText: `${PAGE_1}\n\n${PAGE_2}`,
    metadata: { extraction: {
      ocrApplied: true, ocrBackend: 'tesseract', ocrPages: 2, pageCount: 2,
      ocrQuality: [{ page: 1, confidence: 0.94 }, { page: 2, confidence: 0.38 }],
      pageStarts: [{ page: 1, start: 0 }, { page: 2, start: PAGE_1.length + 2 }],
      unreadPages: [], ocrTruncated: false,
    } },
  } })
  version = v.id
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('a value read from a hard page of a scan', () => {
  it('asks to be checked against that page; one from a clear page doesn’t', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}?versionId=${version}`, headers: internal(), payload: {
      analysisStatus: 'DONE',
      keyTerms: { paymentTermsDays: 30, governingLaw: 'State of Texas' },
      fieldConfidence: {
        paymentTermsDays: { confidence: 0.95, quote: 'within thirty (30) days of receipt' },
        governingLaw: { confidence: 0.95, quote: 'the laws of the State of Texas' },
      },
    } })
    expect(r.statusCode).toBe(200)
    const fields = new Map(((await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/fields`, headers: admin() })).json().fields as Array<Record<string, any>>).map(f => [f.key, f]))
    const pay = fields.get('paymentTermsDays')!
    expect(pay.issue).toBe('Read from page 2 of the scan, which is hard to read.')
    expect(pay.confidence).toBeLessThan(0.8)
    expect(fields.get('governingLaw')).toMatchObject({ issue: null })

    const queue = (await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${contract}`, headers: admin() })).json()
    expect(queue.items.map((i: { field: string; reason: string }) => `${i.field}:${i.reason}`)).toContain('paymentTermsDays:low_confidence')
    expect(queue.items.map((i: { field: string }) => i.field)).not.toContain('governingLaw')
  })
})
