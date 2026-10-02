/**
 * docs/39 A9 — the other side's redline, a Word file whose changes nobody has
 * accepted: its values keep what is agreed, and what their changes propose
 * waits beside each — a person's value included — to be taken or left.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { trackedDocx } from '../test-support/tracked-docx.js'
import { extractDocument } from '../lib/document.js'
import { readTrackedChanges } from '../lib/tracked-changes.js'
import { MIME } from '../lib/file-type.js'
import { s3 } from '../lib/storage.js'
import { Prisma } from '@prisma/client'

vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: (await import('../test-support/fake-s3.js')).fakeS3(),
}))

let app: TestApp
let org: string, owner: string, contract: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })
const admin = () => auth(org, ['ADMIN'], owner)
const store = (s3 as unknown as { objects: Map<string, Uint8Array> }).objects

const OURS = [
  'MASTER SERVICES AGREEMENT',
  'Payment. Customer shall pay each invoice within thirty (30) days of receipt of the invoice.',
  'Termination. Either party may terminate this Agreement on ninety (90) days notice to the other party.',
  'Renewal. This Agreement starts on the Effective Date. Each party signs below.',
  'Governing law. This Agreement is governed by the laws of the State of New York.',
]
const THEIRS = [
  'MASTER SERVICES AGREEMENT',
  'Payment. Customer shall pay each invoice within {-thirty (30)-}{+sixty (60)+} days of receipt of the invoice.',
  '{-Termination. Either party may terminate this Agreement on ninety (90) days notice to the other party.-}',
  'Renewal. This Agreement starts on the Effective Date.{+ It renews automatically for successive one (1) year terms.+} Each party signs below.',
  'Governing law. This Agreement is governed by the laws of the State of New York.',
]

/** The analysis of a version, saved as the extraction job saves it. */
const save = (versionId: string, keyTerms: Record<string, unknown>, fieldConfidence: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}?versionId=${versionId}`, headers: internal(), payload: { analysisStatus: 'DONE', keyTerms, fieldConfidence } })

/** A Word file uploaded as the contract's next version, read as the parse job reads it. */
async function uploaded(versionNumber: number, file: Buffer, key: string) {
  store.set(key, file)
  const { plainText, htmlContent } = await extractDocument(file, MIME.DOCX, 'redline.docx')
  const trackedChanges = await readTrackedChanges(file)
  const v = await prisma.contractVersion.create({ data: {
    contractId: contract, versionNumber, createdById: owner, plainText, htmlContent, s3Key: key, mimeType: MIME.DOCX,
    metadata: { trackedChanges } as never,
  } })
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id } })
  return v.id
}

const fields = async () => {
  const r = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/fields`, headers: admin() })
  return new Map((r.json().fields as Array<Record<string, any>>).map(f => [f.key, f]))
}

// What the review reads from their file: it reads the changes as made.
const THEIR_READING = {
  keyTerms: { paymentTermsDays: 60, terminationNotice: null, renewalTerm: { value: 1, unit: 'years' }, autoRenew: true, governingLaw: 'State of New York' },
  fieldConfidence: {
    paymentTermsDays: { confidence: 0.9, quote: 'within sixty (60) days of receipt' },
    terminationNotice: { confidence: 0.95, quote: null },
    renewalTerm: { confidence: 0.9, quote: 'It renews automatically for successive one (1) year terms.' },
    autoRenew: { confidence: 0.9, quote: 'It renews automatically for successive one (1) year terms.' },
    governingLaw: { confidence: 0.95, quote: 'laws of the State of New York' },
  },
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Tracked Changes Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Globex Master Services Agreement', type: 'MSA' })
  // Our draft, analysed.
  const v1 = await uploaded(1, await trackedDocx(OURS), `${org}/ours.docx`)
  expect((await save(v1, { paymentTermsDays: 30, terminationNotice: { value: 90, unit: 'days' }, governingLaw: 'State of New York' }, {
    paymentTermsDays: { confidence: 0.9, quote: 'within thirty (30) days of receipt' },
    terminationNotice: { confidence: 0.9, quote: 'on ninety (90) days notice' },
    governingLaw: { confidence: 0.95, quote: 'laws of the State of New York' },
  })).statusCode).toBe(200)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('their redline, changes not accepted', () => {
  let v2: string

  it('is counted when the file is read', async () => {
    v2 = await uploaded(2, await trackedDocx(THEIRS, 'Priya Shah'), `${org}/theirs.docx`)
    const v = await prisma.contractVersion.findUniqueOrThrow({ where: { id: v2 } })
    expect((v.metadata as Record<string, unknown>).trackedChanges).toEqual({ insertions: 2, deletions: 2, byAuthor: { 'Priya Shah': 4 }, comments: 0 })
    // The text shows their changes made, as before.
    expect(v.plainText).toContain('within sixty (60) days')
  })

  it('leaves each value what is agreed, with what their changes propose beside it', async () => {
    // A person had checked the payment terms on our draft.
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/fields/paymentTermsDays/verify`, headers: admin() })).statusCode).toBe(200)
    expect((await save(v2, THEIR_READING.keyTerms, THEIR_READING.fieldConfidence)).statusCode).toBe(200)

    const f = await fields()
    // Changed: 30 stands (checked, and agreed); their 60 is proposed.
    expect(f.get('paymentTermsDays')).toMatchObject({ value: 30, suggestion: { value: 60, display: '60 days', reason: 'proposed' } })
    // Taken out: the 90 days stands; their changes would take it out.
    expect(f.get('terminationNotice')).toMatchObject({ value: { value: 90, unit: 'days' }, suggestion: { value: null, display: '', reason: 'proposed' } })
    // Put in: the agreed text doesn't say it; they propose it.
    expect(f.get('renewalTerm')).toMatchObject({ value: null, suggestion: { value: { value: 1, unit: 'years' }, reason: 'proposed' } })
    expect(f.get('autoRenew')).toMatchObject({ value: null, suggestion: { value: true, reason: 'proposed' } })
    // Untouched by their changes: as read, nothing proposed.
    expect(f.get('governingLaw')).toMatchObject({ value: 'State of New York', suggestion: null })
    // The agreed words are in the file, beneath their changes: not "gone".
    expect(f.get('terminationNotice')!.confidenceReasons.join(' ')).not.toMatch(/current version/)
    // Nothing agreed changed, so there is nothing for "the last analysis changed" to undo.
    expect(await prisma.fieldValueRun.count({ where: { contractId: contract, kind: 'reanalysis' } })).toBe(0)
    // The Review Queue lists each as a proposed change, ahead of everything else.
    const queue = (await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${contract}`, headers: admin() })).json()
    expect(queue.counts.proposed).toBe(4)
    expect(queue.items.slice(0, 4).map((i: { field: string; reason: string }) => `${i.field}:${i.reason}`).sort())
      .toEqual(['autoRenew:proposed', 'paymentTermsDays:proposed', 'renewalTerm:proposed', 'terminationNotice:proposed'])
  })

  it('reads the same again: a second analysis of their file changes nothing', async () => {
    expect((await save(v2, THEIR_READING.keyTerms, THEIR_READING.fieldConfidence)).statusCode).toBe(200)
    const f = await fields()
    expect(f.get('paymentTermsDays')).toMatchObject({ value: 30, suggestion: { value: 60, reason: 'proposed' } })
    expect(f.get('terminationNotice')).toMatchObject({ value: { value: 90, unit: 'days' }, suggestion: { value: null, reason: 'proposed' } })
  })

  it('a proposal taken becomes the value; one taken out, cleared', async () => {
    const take = (key: string) => app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/fields/${key}/suggestion`, headers: admin(), payload: { action: 'accept' } })
    expect((await take('paymentTermsDays')).statusCode).toBe(200)
    expect((await take('terminationNotice')).statusCode).toBe(200)
    const f = await fields()
    expect(f.get('paymentTermsDays')).toMatchObject({ value: 60, suggestion: null })
    expect(f.get('terminationNotice')).toMatchObject({ value: null, suggestion: null })
    // Their file read again: what the person took stands, and the agreed 30 isn't offered back.
    expect((await save(v2, THEIR_READING.keyTerms, THEIR_READING.fieldConfidence)).statusCode).toBe(200)
    const again = await fields()
    expect(again.get('paymentTermsDays')).toMatchObject({ value: 60, suggestion: null })
    expect(again.get('terminationNotice')).toMatchObject({ value: null, suggestion: null })
  })

  it('the next, clean version settles what was proposed — read or not', async () => {
    expect((await fields()).get('renewalTerm')).toMatchObject({ suggestion: { reason: 'proposed' } })
    // They send it back with every change accepted; this reading happens not to mention the renewal term.
    const v3 = await uploaded(3, await trackedDocx(THEIRS.map(p => p.replace(/\{-[\s\S]*?-\}/g, '').replace(/\{\+([\s\S]*?)\+\}/g, '$1'))), `${org}/clean.docx`)
    const { renewalTerm: _r, ...keyTerms } = THEIR_READING.keyTerms
    expect((await save(v3, keyTerms, THEIR_READING.fieldConfidence)).statusCode).toBe(200)
    const f = await fields()
    expect([...f.values()].filter(x => x.suggestion?.reason === 'proposed').map(x => x.key)).toEqual([])
    expect(f.get('autoRenew')).toMatchObject({ value: true, suggestion: null })
    // Back to their file with changes for the rest.
    await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v2 } })
  })

  it('a Word file read before changes were counted is counted when it is next analysed', async () => {
    // As an upload from before: no count on the version, and the payment terms read as the AI read our draft.
    await prisma.contractVersion.update({ where: { id: v2 }, data: { metadata: {} } })
    await prisma.contractFieldValue.updateMany({
      where: { contractId: contract, fieldKey: 'paymentTermsDays' },
      data: { value: 30, valueNumber: 30, source: 'ai', quote: 'within thirty (30) days of receipt', verifiedAt: null, verifiedById: null, suggestion: Prisma.JsonNull },
    })
    expect((await save(v2, THEIR_READING.keyTerms, THEIR_READING.fieldConfidence)).statusCode).toBe(200)
    const v = await prisma.contractVersion.findUniqueOrThrow({ where: { id: v2 } })
    expect((v.metadata as Record<string, unknown>).trackedChanges).toMatchObject({ insertions: 2, deletions: 2 })
    expect((await fields()).get('paymentTermsDays')).toMatchObject({ value: 30, suggestion: { value: 60, reason: 'proposed' } })
  })

  it('when the file can’t be read again, values are read as it shows them', async () => {
    store.delete(`${org}/theirs.docx`)
    expect((await save(v2, { ...THEIR_READING.keyTerms, governingLaw: 'State of Delaware' }, {
      ...THEIR_READING.fieldConfidence, governingLaw: { confidence: 0.95, quote: 'laws of the State of New York' },
    })).statusCode).toBe(200)
    expect((await fields()).get('governingLaw')).toMatchObject({ value: 'State of Delaware' })
  })
})
