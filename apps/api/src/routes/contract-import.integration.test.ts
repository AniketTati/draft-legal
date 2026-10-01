/**
 * docs/39 A16 — contracts imported from a spreadsheet with their documents:
 * the sheet read (CSV or Excel) with where each column likely goes; rows made
 * contracts with the shared type list, statuses an import may set, owners by
 * email and any field's value as Imported (one that can't be read left out
 * and said); a chunked import kept one batch the list can filter by; a row's
 * document read by the AI, which leaves the imported values alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

// Kept off the shared Redis queue, which the dev API's workers also consume.
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueParseDocument: vi.fn(),
  queueEmbedContract: vi.fn(),
}))
vi.mock('../lib/elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/elasticsearch.js')>()),
  indexContract: vi.fn(async () => {}),
  reindexContract: vi.fn(async () => {}),
}))
// Object storage is faked: CI runs no MinIO.
vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: (await import('../test-support/fake-s3.js')).fakeS3(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { buildXlsx } from '../test-support/xlsx.js'
import { queueParseDocument } from '../lib/queue.js'
import { applyExtraction } from '../lib/field-store.js'
import type { ImportTarget } from '@clm/types'

let app: TestApp
let org: string, owner: string, colleague: string, colleagueEmail: string
let batch: string
const made: Record<string, string> = {}

const admin = () => auth(org, ['ADMIN'], owner)

function multipart(filename: string, contentType: string, body: Buffer) {
  const boundary = `----it${randomBytes(8).toString('hex')}`
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

const HEADERS = ['Contract', 'Type', 'Status', 'Vendor', 'Start date', 'Value', 'Auto renew', 'Owner', 'PO number', 'Deliverables', 'File']
const MAPPING: Array<ImportTarget | null> = [
  { kind: 'title' }, { kind: 'type' }, { kind: 'status' }, { kind: 'field', key: 'counterpartyName' }, { kind: 'field', key: 'effectiveDate' },
  { kind: 'field', key: 'value' }, { kind: 'field', key: 'autoRenew' }, { kind: 'owner' }, { kind: 'field', key: 'po_number' },
  { kind: 'field', key: 'deliverables' }, { kind: 'file' },
]
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n')

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Import Org')
  owner = await makeUser(org)
  colleague = await makeUser(org)
  colleagueEmail = (await prisma.user.findUniqueOrThrow({ where: { id: colleague } })).email
  await prisma.contractFieldDefinition.create({ data: { orgId: org, fieldKey: 'po_number', fieldLabel: 'PO number', fieldType: 'text' } })
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('a spreadsheet', () => {
  it('is read — an Excel workbook too — with where each column likely goes', async () => {
    const file = await buildXlsx([
      HEADERS,
      ['Acme MSA', 'Master Services Agreement', 'Signed', 'Acme Corp', { date: '2024-03-01' }, 'USD 250,000', 'Yes', colleagueEmail.toUpperCase(), 'PO-1001', '', 'Acme_MSA.pdf'],
    ])
    const mp = multipart('contracts.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file)
    const r = await app.inject({ method: 'POST', url: '/api/v1/contracts/import/read', headers: { ...admin(), ...mp.headers }, payload: mp.payload })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toMatchObject({ filename: 'contracts.xlsx', sheetName: 'Contracts', headers: HEADERS, total: 1 })
    expect(body.rows[0][4]).toBe('2024-03-01')
    // Every column named: the contract's own properties, the standard fields by the names people use, a custom field and a SOW's own by theirs.
    expect(body.suggestions).toEqual(MAPPING)
  })

  it('that isn’t one, or is an older .xls, is refused with what to do', async () => {
    const xls = multipart('old.xls', 'application/vnd.ms-excel', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]))
    const r = await app.inject({ method: 'POST', url: '/api/v1/contracts/import/read', headers: { ...admin(), ...xls.headers }, payload: xls.payload })
    expect(r.statusCode).toBe(422)
    expect(r.json().detail).toContain('.xlsx or CSV')
    const viewer = await app.inject({ method: 'POST', url: '/api/v1/contracts/import/read', headers: { ...auth(org, ['VIEWER'], owner), ...xls.headers }, payload: xls.payload })
    expect(viewer.statusCode).toBe(403)
  })
})

describe('an import', () => {
  const importChunk = (rows: Array<{ row: number; cells: string[]; file?: string | null }>, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/contracts/import', headers: admin(), payload: { plan: { headers: HEADERS, mapping: MAPPING, ...extra }, rows, ...(batch && { batch }) } })

  it('makes each row a contract: the shared types, the statuses it may set, owners by email, values as Imported', async () => {
    const r = await importChunk([
      { row: 2, cells: ['Acme MSA', 'Master Services Agreement', 'Signed', 'Acme Corp', '2024-03-01', 'USD 250,000', 'Yes', colleagueEmail.toUpperCase(), 'PO-1001', '', 'Acme_MSA.pdf'], file: 'Acme_MSA.pdf' },
      { row: 3, cells: ['Globex DPA', 'DPA', 'Approved', 'Globex', 'TBD', 'EUR 12,000', '', '', '', '', ''] },
      { row: 4, cells: ['', 'NDA', '', 'Nobody', '', '', '', '', '', '', ''] },
      { row: 5, cells: ['Initech Lease', 'Lease', 'Expired', 'Initech', '01/02/2023', '', 'no', 'someone@elsewhere.test', '', 'Two reports', ''] },
    ])
    expect(r.statusCode).toBe(200)
    batch = r.json().batch
    expect(batch).toMatch(/^imp_[0-9a-f]{12}$/)
    const results = r.json().results as Array<{ row: number; ok: boolean; contractId?: string; issues: string[]; error?: string; file?: string | null }>
    expect(results.map(x => x.ok)).toEqual([true, true, false, true])
    expect(results[2].error).toContain('no title')
    for (const x of results) if (x.contractId) made[x.row] = x.contractId

    const acme = await prisma.contract.findUniqueOrThrow({ where: { id: made[2] } })
    expect(acme).toMatchObject({ title: 'Acme MSA', type: 'MSA', status: 'EXECUTED', ownerId: colleague, counterpartyName: 'Acme Corp', currency: 'USD', analysisStatus: 'DONE', currentVersionId: null, tags: ['imported'] })
    expect(Number(acme.value)).toBe(250000)
    expect(acme.metadata).toMatchObject({ _import: { batch, row: 2, file: 'Acme_MSA.pdf' }, _typeSource: 'person' })
    expect(results[0]).toMatchObject({ file: 'Acme_MSA.pdf', issues: [] })
    const values = await prisma.contractFieldValue.findMany({ where: { contractId: made[2] }, select: { fieldKey: true, value: true, source: true } })
    expect(Object.fromEntries(values.map(v => [v.fieldKey, [v.value, v.source]]))).toMatchObject({
      counterpartyName: ['Acme Corp', 'import'], effectiveDate: ['2024-03-01', 'import'], autoRenew: [true, 'import'], po_number: ['PO-1001', 'import'], value: [250000, 'import'],
    })

    // DPA is the shared type; Approved is an approval's to set; TBD isn't a date; the amount's currency comes with it.
    const globex = await prisma.contract.findUniqueOrThrow({ where: { id: made[3] } })
    expect(globex).toMatchObject({ type: 'DATA_PROCESSING', status: 'DRAFT', ownerId: owner, currency: 'EUR', effectiveDate: null })
    expect(results[1].issues).toEqual([
      'Status “Approved” is set by an approval, not an import: imported as Draft.',
      'Effective date: “TBD” isn’t a date — left empty.',
    ])

    // An unknown type is Other; a type-only field is left out of another type; an unknown owner is the importer.
    const initech = await prisma.contract.findUniqueOrThrow({ where: { id: made[5] } })
    expect(initech).toMatchObject({ type: 'OTHER', status: 'EXPIRED', ownerId: owner })
    expect(results[3].issues).toEqual([
      'Type “Lease” isn’t one the app knows: imported as Other.',
      'No one here has the email someone@elsewhere.test: you own it.',
      'Deliverables is kept for SOW contracts: left out.',
    ])
  })

  it('reads the sheet’s words for types and statuses as the person mapped them, and adds to the same batch', async () => {
    const r = await importChunk([{ row: 6, cells: ['Hooli Lease', 'Lease', 'Approved', 'Hooli', '', '', '', '', '', '', ''] }], {
      typeValues: { Lease: 'VENDOR_AGREEMENT' }, statusValues: { Approved: 'EXECUTED' },
    })
    expect(r.json().batch).toBe(batch)
    const [res] = r.json().results
    expect(res).toMatchObject({ ok: true, issues: [] })
    made[6] = res.contractId
    expect(await prisma.contract.findUniqueOrThrow({ where: { id: res.contractId } })).toMatchObject({ type: 'VENDOR_AGREEMENT', status: 'EXECUTED' })
    // The list finds the whole import (and only it).
    await makeContract(org, owner, { title: 'Not imported' })
    const list = await app.inject({ method: 'POST', url: '/api/v1/contracts/query', headers: admin(), payload: { importBatch: batch, limit: 50 } })
    expect(list.json().total).toBe(4)
    expect(list.json().data.map((c: { title: string }) => c.title).sort()).toEqual(['Acme MSA', 'Globex DPA', 'Hooli Lease', 'Initech Lease'])
  })

  it('refuses two columns for one field, a chunk too big, and someone who can’t create contracts', async () => {
    const twice = await app.inject({ method: 'POST', url: '/api/v1/contracts/import', headers: admin(), payload: {
      plan: { headers: ['A', 'B'], mapping: [{ kind: 'field', key: 'counterpartyName' }, { kind: 'field', key: 'counterpartyName' }] }, rows: [{ row: 2, cells: ['x', 'y'] }],
    } })
    expect(twice.statusCode).toBe(400)
    const big = await app.inject({ method: 'POST', url: '/api/v1/contracts/import', headers: admin(), payload: {
      plan: { headers: ['A'], mapping: [{ kind: 'title' }] }, rows: Array.from({ length: 101 }, (_, i) => ({ row: i + 2, cells: [`C${i}`] })),
    } })
    expect(big.statusCode).toBe(400)
    const viewer = await app.inject({ method: 'POST', url: '/api/v1/contracts/import', headers: auth(org, ['VIEWER'], owner), payload: {
      plan: { headers: ['A'], mapping: [{ kind: 'title' }] }, rows: [{ row: 2, cells: ['x'] }],
    } })
    expect(viewer.statusCode).toBe(403)
  })
})

describe('an imported row’s document', () => {
  it('is read by the AI once it arrives — only once, and only for a row waiting for one', async () => {
    const send = (id: string) => {
      const mp = multipart('Acme_MSA.pdf', 'application/pdf', PDF)
      return app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/import-document`, headers: { ...admin(), ...mp.headers }, payload: mp.payload })
    }
    const r = await send(made[2])
    expect(r.statusCode).toBe(201)
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: made[2] }, include: { versions: true } })
    expect(c.analysisStatus).toBe('PENDING')
    expect(c.versions).toHaveLength(1)
    expect(c.currentVersionId).toBe(c.versions[0].id)
    expect(queueParseDocument).toHaveBeenCalledWith(expect.objectContaining({ contractId: made[2], versionId: c.versions[0].id, mimeType: 'application/pdf' }))
    expect((await send(made[2])).statusCode).toBe(409)
    expect((await send(await makeContract(org, owner, { title: 'Uploaded by hand' }))).statusCode).toBe(409)
    expect((await send('no-such-contract')).statusCode).toBe(404)
  })

  it('once read, leaves the imported values alone: the AI’s other reading waits beside them', async () => {
    await applyExtraction(made[2], [
      { key: 'counterpartyName', kind: 'core', value: 'ACME CORPORATION', confidence: 0.9, quote: 'between ACME CORPORATION and Us' },
      { key: 'governingLaw', kind: 'core', value: 'Delaware', confidence: 0.9, quote: 'laws of the State of Delaware' },
    ], { mode: 'replace_ai' })
    const rows = await prisma.contractFieldValue.findMany({ where: { contractId: made[2], fieldKey: { in: ['counterpartyName', 'governingLaw'] } } })
    const cp = rows.find(r => r.fieldKey === 'counterpartyName')!
    expect(cp).toMatchObject({ value: 'Acme Corp', source: 'import' })
    expect(cp.suggestion).toMatchObject({ value: 'ACME CORPORATION' })
    // A value the sheet didn't have is the AI's to fill.
    expect(rows.find(r => r.fieldKey === 'governingLaw')).toMatchObject({ value: 'Delaware', source: 'ai' })
  })
})
