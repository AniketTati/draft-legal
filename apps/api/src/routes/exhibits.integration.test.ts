/**
 * docs/39 A12 — an exhibit attached to a contract is read as part of it: its
 * text is kept, the contract is read again with it (after its own text,
 * under its name), a value quoted from it is placed in it rather than marked
 * "words gone", and removing it takes it out of what's read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

// Kept off the shared Redis queue, which the dev API's workers also consume.
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueReadExhibit: vi.fn(),
  queueExtractAi: vi.fn(),
}))
// Object storage is faked: CI runs no MinIO.
vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: (await import('../test-support/fake-s3.js')).fakeS3(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { queueReadExhibit } from '../lib/queue.js'
import { readExhibit } from '../lib/exhibits.js'
import { runExtractionJob, type ExtractionDeps, type ExtractionJobLike, type ReviewRun } from '../lib/extraction-job.js'

let app: TestApp
let org: string, owner: string, contract: string, versionId: string

const admin = () => auth(org, ['ADMIN'], owner)
const TEXT = 'MASTER SERVICES AGREEMENT between Demo Org and Initech LLC. Fees are set out in Exhibit B. This Agreement is governed by the laws of Delaware.'
const PRICING = 'EXHIBIT B — PRICING. Platform fee: USD 48,000 per year. Customer shall pay each invoice within forty-five (45) days of receipt.'

function multipart(filename: string, contentType: string, body: string, fields: Record<string, string> = {}) {
  const boundary = `----it${randomBytes(8).toString('hex')}`
  const payload = Buffer.concat([
    Buffer.from(Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.from(body),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Exhibits Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Initech MSA', type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: owner, plainText: TEXT } })
  versionId = v.id
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('an exhibit attached to a contract', () => {
  let s3Key: string

  it('is read when attached', async () => {
    const file = multipart('pricing.txt', 'text/plain', PRICING, { label: 'Exhibit B — Pricing' })
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/attach`, headers: { ...admin(), ...file.headers }, payload: file.payload })
    expect(r.statusCode).toBe(200)
    s3Key = r.json().attachments[0].s3Key
    expect(r.json().attachments[0]).toMatchObject({ label: 'Exhibit B — Pricing', attachedAt: expect.any(String) })
    expect(vi.mocked(queueReadExhibit)).toHaveBeenCalledWith({ orgId: org, contractId: contract, s3Key })

    // The job's work: read and kept.
    expect(await readExhibit({ orgId: org, contractId: contract, s3Key })).toBe(true)
    const row = await prisma.contractExhibit.findUniqueOrThrow({ where: { contractId_s3Key: { contractId: contract, s3Key } } })
    expect(row).toMatchObject({ label: 'Exhibit B — Pricing', error: null })
    expect(row.text).toContain('USD 48,000 per year')
    // The contract says so, without the text.
    const c = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}`, headers: admin() })).json()
    expect(c.exhibits).toEqual([expect.objectContaining({ s3Key, error: null })])
    expect(c.exhibits[0].text).toBeUndefined()
  })

  it('is read with the contract, and a value quoted from it is placed in it', async () => {
    const run: ReviewRun = {
      contract: {
        analysisStatus: 'DONE',
        keyTerms: { paymentTermsDays: 45, governingLaw: 'Delaware' },
        fieldConfidence: {
          paymentTermsDays: { confidence: 0.92, quote: 'within forty-five (45) days of receipt' },
          governingLaw: { confidence: 0.95, quote: 'governed by the laws of Delaware' },
        },
      },
      version: {},
      failed: false,
    }
    let body: Record<string, unknown> | null = null
    const deps: ExtractionDeps = {
      async review(b) { body = b; return new Response(JSON.stringify(run), { status: 200 }) },
      async reviewLegacy() { return new Response('{}', { status: 404 }) },
      async api(method, path, orgId, payload) {
        const res = await app.inject({ method, url: path, payload: payload as never, headers: { 'x-internal-service': 'agents', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-org-id': orgId } })
        return { status: res.statusCode, text: res.body }
      },
    }
    const job: ExtractionJobLike = { data: { contractId: contract, versionId, orgId: org, triggeredBy: 'exhibit', typeLocked: true }, attemptsMade: 0, opts: { attempts: 3 }, async updateData(d) { job.data = d } }
    expect(await runExtractionJob(job, deps)).toBe('saved')
    // Its own text first, then the exhibit under its name.
    expect(body!.plainText).toBe(`${TEXT}\n\nEXHIBIT: Exhibit B — Pricing\n\n${PRICING}`)

    const fields = new Map(((await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/fields`, headers: admin() })).json().fields as Array<Record<string, any>>).map(f => [f.key, f]))
    const pay = fields.get('paymentTermsDays')!
    expect(pay).toMatchObject({ value: 45, anchor: { start: null, exhibit: { s3Key, label: 'Exhibit B — Pricing' } } })
    expect(pay.confidenceReasons.join(' ')).not.toMatch(/current version/)
    expect(fields.get('governingLaw')!.anchor).toMatchObject({ start: expect.any(Number) })
    const queue = (await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${contract}`, headers: admin() })).json()
    expect(queue.items.map((i: { field: string }) => i.field)).not.toContain('paymentTermsDays')
  })

  it('from before attachments were read can be read on request; a spreadsheet can’t', async () => {
    vi.mocked(queueReadExhibit).mockClear()
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/attachments/0/read`, headers: admin() })).statusCode).toBe(202)
    expect(vi.mocked(queueReadExhibit)).toHaveBeenCalledWith({ orgId: org, contractId: contract, s3Key })
    await prisma.contract.update({ where: { id: contract }, data: { attachments: [...((await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).attachments as object[]), { filename: 'rates.xlsx', s3Key: 'x/rates.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 10 }] } })
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/attachments/1/read`, headers: admin() })).statusCode).toBe(422)
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/attachments/0/read`, headers: auth(org, ['VIEWER'], owner) })).statusCode).toBe(403)
  })

  it('removed, is no longer read with the contract', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/contracts/${contract}/attachments/0`, headers: admin() })).statusCode).toBe(200)
    expect(await prisma.contractExhibit.count({ where: { contractId: contract } })).toBe(0)
  })
})
