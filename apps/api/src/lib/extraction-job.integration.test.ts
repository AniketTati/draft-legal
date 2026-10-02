/**
 * docs/39 A1 / A15 — the extraction runs inside its job and is saved by it:
 * saved through the routes the agents service used to call back into, a
 * failed save retried without a new run, every failure naming its step and
 * attempt, and the run's real token use recorded as `extraction`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { internalWriteInit } from './internal-write.js'
import { runExtractionJob, type ExtractionDeps, type ExtractionJobData, type ExtractionJobLike, type ReviewRun } from './extraction-job.js'

let app: TestApp
let org: string, owner: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Extraction Job Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

const TEXT = 'MASTER SERVICES AGREEMENT between Our Org and Initech LLC. This Agreement is governed by the laws of Delaware. 5. PAYMENT. Fees are due within thirty (30) days.'

async function contractWithText(text = TEXT) {
  const id = await makeContract(org, owner, { title: 'Upload.pdf', type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: text } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'EXTRACTING' } })
  return { id, versionId: v.id }
}

const RUN: ReviewRun = {
  contract: {
    analysisStatus: 'DONE', summary: 'A services agreement.', type: 'MSA', jurisdiction: 'Delaware',
    keyTerms: { governingLaw: 'Delaware', paymentTermsDays: 30 },
    fieldConfidence: { governingLaw: { confidence: 0.95, quote: 'governed by the laws of Delaware' }, paymentTermsDays: { confidence: 0.9, quote: 'due within thirty (30) days' } },
  },
  version: { clauseSegments: [{ clauseType: 'payment', content: 'Fees are due within thirty (30) days.', sortOrder: 0, startsWith: '5. PAYMENT.', endsWith: 'thirty (30) days.' }] },
  failed: false,
  usage: { calls: 3, inputTokens: 12_000, outputTokens: 2_000, byModel: [{ provider: 'gemini', model: 'gemini-2.5-flash', source: 'platform', calls: 3, inputTokens: 12_000, outputTokens: 2_000 }] },
}

function fakeJob(data: ExtractionJobData, attemptsMade = 0): ExtractionJobLike {
  const job: ExtractionJobLike = {
    data, attemptsMade, opts: { attempts: 3 },
    async updateData(d) { job.data = d },
  }
  return job
}

/** The agents service answering with `run`, and this API taking the writes (unless `refuse` says otherwise). */
function deps(run: ReviewRun | { status: number }, opts: { refuse?: RegExp } = {}) {
  const calls = { review: 0, legacy: 0, writes: [] as string[], body: null as Record<string, unknown> | null }
  const d: ExtractionDeps = {
    async review(body) {
      calls.review++
      calls.body = body
      if ('status' in run) return new Response('Not Found', { status: run.status })
      // The real answer starts with the heartbeat spaces.
      return new Response(`   ${JSON.stringify(run)}`, { status: 200, headers: { 'content-type': 'application/json' } })
    },
    async reviewLegacy() { calls.legacy++; return new Response(JSON.stringify({ status: 'queued' }), { status: 200 }) },
    async api(method, path, orgId, body) {
      calls.writes.push(`${method} ${path.split('?')[0]}`)
      if (opts.refuse?.test(path)) return { status: 500, text: 'database unavailable' }
      // The worker's own request (headers and body), so a bodiless write is
      // sent as it really is: with a JSON type and no body it was refused (400).
      const init = internalWriteInit(method, orgId, process.env.INTERNAL_SERVICE_SECRET as string, body)
      const res = await app.inject({ method, url: path, payload: init.body as string | undefined, headers: init.headers as Record<string, string> })
      return { status: res.statusCode, text: res.body }
    },
  }
  return { d, calls }
}

const mark = async (id: string) => ((await prisma.contract.findUniqueOrThrow({ where: { id } })).metadata as Record<string, unknown>)._extraction as Record<string, unknown> | undefined

describe('the extraction job', () => {
  it('runs the extraction, saves its fields and clauses, and records what it really used', async () => {
    const { id, versionId } = await contractWithText()
    const { d, calls } = deps(RUN)
    expect(await runExtractionJob(fakeJob({ contractId: id, versionId, orgId: org, triggeredBy: 'upload' }), d)).toBe('saved')
    const row = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ analysisStatus: 'DONE', jurisdiction: 'Delaware', summary: 'A services agreement.' })
    expect(row.keyTerms).toMatchObject({ paymentTermsDays: 30 })
    const clauses = await prisma.contractClause.findMany({ where: { versionId } })
    expect(clauses.map(c => c.clauseType)).toEqual(['payment'])
    expect(calls.writes).toEqual([`PATCH /api/v1/contracts/${id}`, `POST /api/v1/contracts/${id}/versions/${versionId}/clauses`, `POST /api/v1/contracts/${id}/versions/${versionId}/chunk`])
    expect(await mark(id)).toBeUndefined()
    const usage = await prisma.orgUsageDaily.findFirst({ where: { orgId: org, toolName: 'extraction', model: 'gemini-2.5-flash' } })
    expect(usage).toMatchObject({ inputTokens: 12_000, outputTokens: 2_000, callCount: 3 })
    expect(Number(usage?.costUsd)).toBeCloseTo(0.0086, 6)
  })

  it('a refused save fails the attempt and names the step; the retry saves the same run without a new one', async () => {
    const { id, versionId } = await contractWithText()
    const job = fakeJob({ contractId: id, versionId, orgId: org, triggeredBy: 'upload' })
    const first = deps(RUN, { refuse: /\/clauses$/ })
    await expect(runExtractionJob(job, first.d)).rejects.toThrow(/Failed while saving what was read \(attempt 1 of 3\): the clauses were refused \(500\)/)
    expect(await mark(id)).toMatchObject({ step: 'saving', attempt: 1, of: 3 })
    expect(job.data.run).toBeTruthy()

    const retry = deps({ status: 500 }) // were the extraction called again, it would fail
    job.attemptsMade = 1
    expect(await runExtractionJob(job, retry.d)).toBe('saved')
    expect(retry.calls.review).toBe(0)
    expect((await prisma.contractClause.findMany({ where: { versionId } })).length).toBe(1)
    expect(await mark(id)).toBeUndefined()
  })

  it('a run that produced nothing is retried, not saved over the last good analysis', async () => {
    const { id, versionId } = await contractWithText()
    const { d, calls } = deps({ ...RUN, contract: { analysisStatus: 'FAILED' }, version: {}, failed: true, error: 'model timed out' })
    await expect(runExtractionJob(fakeJob({ contractId: id, versionId, orgId: org }, 2), d))
      .rejects.toThrow('Failed while reading its fields and clauses (attempt 3 of 3): model timed out')
    expect(calls.writes).toEqual([])
    expect(await mark(id)).toMatchObject({ step: 'extracting', attempt: 3, error: 'model timed out' })
  })

  it('a document with no text yet fails at reading it', async () => {
    const { id, versionId } = await contractWithText('')
    await expect(runExtractionJob(fakeJob({ contractId: id, versionId, orgId: org }), deps(RUN).d)).rejects.toThrow(/Failed while reading the document/)
  })

  it('tells the extraction the contract\u2019s language and the org\u2019s date order, and keeps the language (A11)', async () => {
    const FR = 'Le présent contrat est conclu entre les parties. Le prestataire fournit les services décrits dans l\u2019annexe 1 et le client paie les honoraires dans les trente jours suivant la réception de la facture. Aucune des parties ne peut céder le contrat sans l\u2019accord écrit de l\u2019autre partie.'
    const { id, versionId } = await contractWithText(FR)
    const { d, calls } = deps(RUN)
    await runExtractionJob(fakeJob({ contractId: id, versionId, orgId: org }), d)
    expect(calls.body).toMatchObject({ language: 'fr', dateOrder: 'MDY' })
    const md = (await prisma.contract.findUniqueOrThrow({ where: { id } })).metadata as Record<string, unknown>
    expect(md._language).toEqual({ code: 'fr', name: 'French' })
  })

  it('hands the run to an agents service that has no /review/run yet, as before', async () => {
    const { id, versionId } = await contractWithText()
    const { d, calls } = deps({ status: 404 })
    expect(await runExtractionJob(fakeJob({ contractId: id, versionId, orgId: org }), d)).toBe('handed_off')
    expect(calls).toMatchObject({ review: 1, legacy: 1, writes: [] })
  })

  it('saves a draft whose open blanks were read as values, and stores them as no value (41: browser QA)', async () => {
    const { id, versionId } = await contractWithText()
    const { d, calls } = deps({
      ...RUN,
      contract: {
        ...RUN.contract, effectiveDate: '[[effectiveDate]]', jurisdiction: '[[Choose governing law: Delaware · New York]]',
        keyTerms: { governingLaw: '[[Choose governing law: Delaware · New York]]', paymentTermsDays: 30 },
      },
    })
    expect(await runExtractionJob(fakeJob({ contractId: id, versionId, orgId: org }), d)).toBe('saved')
    // The chunk request, which has no body, went through too.
    expect(calls.writes.at(-1)).toBe(`POST /api/v1/contracts/${id}/versions/${versionId}/chunk`)
    const row = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(row.effectiveDate).toBeNull()
    expect(row.jurisdiction).toBeNull()
    expect(row.analysisStatus).toBe('DONE')
    const law = await prisma.contractFieldValue.findFirst({ where: { contractId: id, fieldKey: 'governingLaw' } })
    expect(law?.value ?? null).toBeNull()
  })

  it('a bodiless write with a JSON type is what was refused', async () => {
    const { id, versionId } = await contractWithText()
    const headers = { 'x-internal-service': 'agents', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-org-id': org }
    const url = `/api/v1/contracts/${id}/versions/${versionId}/chunk`
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' } })).statusCode).toBe(400)
    const init = internalWriteInit('POST', org, headers['x-internal-secret'])
    expect((await app.inject({ method: 'POST', url, headers: init.headers as Record<string, string> })).statusCode).toBeLessThan(300)
  })
})
