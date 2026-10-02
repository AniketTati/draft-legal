/**
 * docs/39 G4 — obligations the AI finds are suggestions until a person
 * confirms or dismisses them; a re-read replaces only its own suggestions;
 * signed contracts are read after their analysis, and in bulk from the
 * Obligations page; an upload can say it's a signed copy.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

const found = vi.hoisted(() => ({ obligations: [] as Array<Record<string, unknown>> }))

vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: { send: async () => ({}) },
}))
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueParseDocument: vi.fn(),
  queueExtractObligations: vi.fn(async () => true),
}))
vi.mock('../lib/elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/elasticsearch.js')>()),
  indexContract: vi.fn(async () => {}),
}))
vi.mock('../lib/model-boundary.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/model-boundary.js')>()),
  modelFetch: vi.fn(async (url: string) => url.endsWith('/extract_obligations')
    ? new Response(JSON.stringify({ obligations: found.obligations, summary: 'Pays monthly.' }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('{}', { status: 404 })),
}))

import { queueExtractObligations } from '../lib/queue.js'
import { queueObligationsIfSigned, queueProposedObligations, extractObligationsForContract } from '../lib/obligation-extract.js'
import { modelFetch } from '../lib/model-boundary.js'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string

const admin = () => auth(org, ['ADMIN'], owner)
const withText = async (title: string, status = 'DRAFT') => {
  const id = await makeContract(org, owner, { title, type: 'MSA', status })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: `${title}. The Customer shall pay monthly.` } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
  return id
}
const list = async (query = '') => ((await app.inject({ method: 'GET', url: `/api/v1/obligations?limit=100${query}`, headers: admin() })).json().data as Array<{ id: string; description: string; reviewState: string }>)
const ob = (description: string, quote: string) => ({ type: 'payment', description, quote, owner: 'customer', severity: 'medium' })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Obligation Review Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('suggested until a person confirms', () => {
  let contract: string

  it('suggests what it finds, and a person confirms (correcting it) or dismisses each', async () => {
    contract = await withText('Supply MSA', 'EXECUTED')
    found.obligations = [ob('Pay the monthly fee', 'The Customer shall pay monthly.'), ob('Send a usage report', 'Provider shall report usage.')]
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/extract-obligations`, headers: admin() })
    expect(r.statusCode).toBe(200)
    const rows = await list(`&contractId=${contract}`)
    expect(rows.map(o => o.reviewState)).toEqual(['SUGGESTED', 'SUGGESTED'])
    const [pay, report] = [rows.find(o => o.description.startsWith('Pay'))!, rows.find(o => o.description.startsWith('Send'))!]

    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/obligations/${pay.id}/confirm`, headers: admin(), payload: { dueDate: '2026-11-01', severity: 'high' } })
    expect(confirmed.json()).toMatchObject({ reviewState: 'CONFIRMED', severity: 'high', dueDate: '2026-11-01T00:00:00.000Z' })
    expect((await app.inject({ method: 'POST', url: `/api/v1/obligations/${report.id}/dismiss`, headers: admin() })).json()).toMatchObject({ reviewState: 'DISMISSED' })

    // A dismissed suggestion is gone from the lists and the counts.
    expect((await list(`&contractId=${contract}`)).map(o => o.id)).toEqual([pay.id])
    expect((await list(`&contractId=${contract}&review=dismissed`)).map(o => o.id)).toEqual([report.id])
  })

  it('a re-read replaces only its own suggestions, and never suggests again what a person decided', async () => {
    found.obligations = [
      ob('Pay the monthly fee', 'The Customer shall pay monthly.'),           // confirmed already
      ob('Send a usage report', 'Provider shall report usage in writing.'),   // dismissed already (same description)
      ob('Keep insurance in force', 'Provider shall maintain insurance.'),
    ]
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/extract-obligations`, headers: admin() })
    const rows = await list(`&contractId=${contract}`)
    expect(rows.map(o => [o.description, o.reviewState]).sort()).toEqual([
      ['Keep insurance in force', 'SUGGESTED'],
      ['Pay the monthly fee', 'CONFIRMED'],
    ])
    expect((await list(`&contractId=${contract}&review=suggested`)).map(o => o.description)).toEqual(['Keep insurance in force'])
    const stats = (await app.inject({ method: 'GET', url: '/api/v1/obligations/stats', headers: admin() })).json()
    expect(stats.suggested).toBe(1)

    const insurance = rows.find(o => o.reviewState === 'SUGGESTED')!
    const bulk = await app.inject({ method: 'POST', url: '/api/v1/obligations/review', headers: admin(), payload: { ids: [insurance.id], action: 'confirm' } })
    expect(bulk.json()).toEqual({ ok: true, count: 1 })
  })

  it('needs edit rights to confirm', async () => {
    const [row] = await list(`&contractId=${contract}`)
    expect((await app.inject({ method: 'POST', url: `/api/v1/obligations/${row.id}/confirm`, headers: auth(org, ['VIEWER'], owner) })).statusCode).toBe(403)
  })
})

describe('signed contracts are read for their obligations', () => {
  it('queues a signed contract after its analysis, once; a draft with a signing date too, one without not', async () => {
    vi.mocked(queueExtractObligations).mockClear()
    const executed = await withText('Signed NDA', 'EXECUTED')
    const draftSigned = await withText('Countersigned SOW')
    await prisma.contractFieldValue.create({ data: { orgId: org, contractId: draftSigned, fieldKey: 'executionDate', kind: 'core', valueType: 'date', value: '2026-03-01', valueDate: new Date('2026-03-01'), source: 'ai' } })
    const draft = await withText('Draft MSA')
    const read = await withText('Already read MSA', 'EXECUTED')
    await prisma.contract.update({ where: { id: read }, data: { metadata: { obligationsExtractedAt: new Date().toISOString() } } })

    expect(await queueObligationsIfSigned(org, executed)).toBe(true)
    expect(await queueObligationsIfSigned(org, draftSigned)).toBe(true)
    expect(await queueObligationsIfSigned(org, draft)).toBe(false)
    expect(await queueObligationsIfSigned(org, read)).toBe(false)
    expect(vi.mocked(queueExtractObligations).mock.calls.map(c => c[0].contractId).sort()).toEqual([executed, draftSigned].sort())
  })

  it('finds the signed contracts never read, from the Obligations page', async () => {
    vi.mocked(queueExtractObligations).mockClear()
    const stats = (await app.inject({ method: 'GET', url: '/api/v1/obligations/stats', headers: admin() })).json()
    // Signed NDA (queued but not yet read) is still unread; Supply MSA was read above.
    expect(stats.unreadSigned).toBe(1)
    const r = await app.inject({ method: 'POST', url: '/api/v1/obligations/find', headers: admin(), payload: {} })
    expect(r.statusCode).toBe(202)
    expect(r.json()).toEqual({ queued: 1, more: false })
    expect(vi.mocked(queueExtractObligations)).toHaveBeenCalledWith({ orgId: org, contractId: expect.any(String) })
    expect((await app.inject({ method: 'POST', url: '/api/v1/obligations/find', headers: auth(org, ['VIEWER'], owner), payload: {} })).statusCode).toBe(403)
  })

  it('takes an upload as a signed copy when it says so', async () => {
    const boundary = `----it${randomBytes(8).toString('hex')}`
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="signed"\r\n\r\ntrue\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="signed.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from('This Agreement is signed by both parties.'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const r = await app.inject({ method: 'POST', url: '/api/v1/contracts/upload', headers: { ...admin(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
    expect(r.statusCode).toBeLessThan(300)
    const id = r.json().id ?? r.json().contract?.id
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).status).toBe('EXECUTED')
  })
})

describe('a draft\'s obligations are proposed, and confirmed at signing (docs/41 Part 11)', () => {
  type Row = { id: string; description: string; status: string; reviewState: string; versionId: string | null }
  const rows = (contractId: string) => prisma.obligation.findMany({ where: { contractId }, orderBy: { description: 'asc' } }) as Promise<Row[]>
  const reads = () => vi.mocked(modelFetch).mock.calls.filter(c => String(c[0]).endsWith('/extract_obligations')).length
  const newVersion = async (contractId: string, n: number) => {
    const v = await prisma.contractVersion.create({ data: { contractId, versionNumber: n, createdById: owner, plainText: `Version ${n}. The Customer shall pay monthly.` } })
    await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id } })
    return v.id
  }
  const sign = (contractId: string) => prisma.contract.update({ where: { id: contractId }, data: { status: 'EXECUTED', stage: 'active', stageState: 'active', executedAt: new Date() } })
  let draft: string

  it('reads a draft\'s obligations as proposed: on its contract, not in the org\'s list, and not completable', async () => {
    draft = await withText('Proposed supply MSA')
    found.obligations = [ob('Pay the monthly fee', 'The Customer shall pay monthly.'), ob('Send a usage report', 'Provider shall report usage.')]
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${draft}/extract-obligations`, headers: admin() })).statusCode).toBe(200)
    const v1 = (await prisma.contract.findUniqueOrThrow({ where: { id: draft } })).currentVersionId
    expect((await rows(draft)).map(o => [o.status, o.reviewState, o.versionId])).toEqual([['PROPOSED', 'SUGGESTED', v1], ['PROPOSED', 'SUGGESTED', v1]])
    const meta = (await prisma.contract.findUniqueOrThrow({ where: { id: draft } })).metadata as Record<string, unknown>
    expect(meta).toMatchObject({ obligationsProposedVersionId: v1 })
    expect(meta.obligationsExtractedAt).toBeUndefined()

    expect((await list(`&contractId=${draft}`))).toHaveLength(2)
    const ids = (await rows(draft)).map(o => o.id)
    expect((await list()).filter(o => ids.includes(o.id))).toEqual([])
    expect((await list('&status=PROPOSED')).filter(o => ids.includes(o.id))).toHaveLength(2)
    const [first] = await rows(draft)
    const done = await app.inject({ method: 'POST', url: `/api/v1/obligations/${first.id}/complete`, headers: admin(), payload: {} })
    expect(done.statusCode).toBe(409)
    expect(done.json().detail).toMatch(/owed once the contract is signed/)
  })

  it('a new version replaces the proposals still open; one a person confirmed stays', async () => {
    const pay = (await rows(draft)).find(o => o.description.startsWith('Pay'))!
    expect((await app.inject({ method: 'POST', url: `/api/v1/obligations/${pay.id}/confirm`, headers: admin(), payload: {} })).statusCode).toBe(200)
    const v2 = await newVersion(draft, 2)
    found.obligations = [ob('Pay the monthly fee', 'The Customer shall pay monthly.'), ob('Keep insurance in force', 'Provider shall maintain insurance.')]
    await extractObligationsForContract({ orgId: org, contractId: draft, userId: 'system' })
    expect((await rows(draft)).map(o => [o.description, o.status, o.reviewState, o.versionId === v2])).toEqual([
      ['Keep insurance in force', 'PROPOSED', 'SUGGESTED', true],
      ['Pay the monthly fee', 'PROPOSED', 'CONFIRMED', false],
    ])
  })

  it('at signing, the signed version\'s proposals become obligations without reading it again', async () => {
    vi.mocked(queueExtractObligations).mockClear()
    await sign(draft)
    const before = reads()
    const r = await extractObligationsForContract({ orgId: org, contractId: draft, userId: 'system' })
    expect(r).toMatchObject({ ok: true, count: 2 })
    expect(reads()).toBe(before)
    expect((await rows(draft)).map(o => [o.description, o.status])).toEqual([['Keep insurance in force', 'OPEN'], ['Pay the monthly fee', 'OPEN']])
    const meta = (await prisma.contract.findUniqueOrThrow({ where: { id: draft } })).metadata as Record<string, unknown>
    expect(meta.obligationsExtractedAt).toBeTruthy()
    expect(meta.obligationsProposedVersionId).toBeUndefined()
    expect(await queueObligationsIfSigned(org, draft)).toBe(false)
  })

  it('signed on a version never read: older proposals are dropped (a confirmed one kept) and the signed text is read', async () => {
    const id = await withText('Proposed then changed SOW')
    found.obligations = [ob('Deliver the reports', 'Provider shall deliver reports.'), ob('Pay on delivery', 'Customer shall pay on delivery.')]
    await extractObligationsForContract({ orgId: org, contractId: id, userId: 'system' })
    const reports = (await rows(id)).find(o => o.description.startsWith('Deliver'))!
    await app.inject({ method: 'POST', url: `/api/v1/obligations/${reports.id}/confirm`, headers: admin(), payload: {} })
    await newVersion(id, 2)
    await sign(id)
    found.obligations = [ob('Deliver the reports', 'Provider shall deliver reports.'), ob('Pay within 30 days', 'Customer shall pay within 30 days.')]
    const before = reads()
    await extractObligationsForContract({ orgId: org, contractId: id, userId: 'system' })
    expect(reads()).toBe(before + 1)
    expect((await rows(id)).map(o => [o.description, o.status, o.reviewState])).toEqual([
      ['Deliver the reports', 'OPEN', 'CONFIRMED'],
      ['Pay within 30 days', 'OPEN', 'SUGGESTED'],
    ])
  })

  it('a draft is read after a full analysis only, never an edit checkpoint, and a signed one not as proposed', async () => {
    vi.mocked(queueExtractObligations).mockClear()
    const id = await withText('Checkpoint MSA')
    expect(await queueProposedObligations(org, id, { full: false })).toBe(false)
    expect(await queueProposedObligations(org, id, { full: true })).toBe(true)
    expect(await queueProposedObligations(org, await withText('Signed one', 'EXECUTED'), { full: true })).toBe(false)
    expect(vi.mocked(queueExtractObligations).mock.calls.map(c => c[0].contractId)).toEqual([id])
  })
})
