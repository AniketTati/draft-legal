/**
 * BB2/BB3 — their Word file round-tripped: "Download for counterparty" gives
 * their paper with our changes tracked under the sender's name, and "Edit in
 * Google Docs" locks the contract, hands out a working copy and takes the
 * edited file back as the next version, comments kept internal.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import JSZip from 'jszip'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { Document, Packer, Paragraph, TextRun } from 'docx'

// Kept off the shared Redis queue, which the dev API's workers also consume.
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueParseDocument: vi.fn(),
  queueNotification: vi.fn(),
  queueRefreshVersion: vi.fn(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { extractDocument } from '../lib/document.js'
import { docxParagraphs } from '../lib/ooxml/docx-redline.js'
import { applyClauseProposal, applyClauseBatch } from '../lib/clause-apply.js'
import { queueParseDocument } from '../lib/queue.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('BB Google Docs Org')
  user = await makeUser(org)
  await prisma.user.update({ where: { id: user }, data: { name: 'Neelam Dalwani' } })
})
afterAll(async () => { await cleanupAll(); await closeApp() })

const headers = () => auth(org, ['ADMIN'], user)

async function theirPaper(): Promise<Buffer> {
  return Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph('SUPPLY AGREEMENT'),
    new Paragraph({ children: [new TextRun('Customer shall pay within '), new TextRun({ text: 'thirty (30)', bold: true }), new TextRun(' days.')] }),
    new Paragraph('Supplier’s liability is unlimited.'),
    new Paragraph('This Agreement is governed by English law.'),
  ] }] })))
}

/** A contract whose Version 1 is their Word file, read as the parse worker reads it. */
async function contractOnTheirPaper(title: string) {
  const contract = await makeContract(org, user, { title, status: 'UNDER_NEGOTIATION' })
  const file = await theirPaper()
  const key = `${org}/contracts/${contract}/${Date.now()}-their-paper.docx`
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: file, ContentType: DOCX }))
  const { htmlContent, plainText } = await extractDocument(file, DOCX, 'their-paper.docx')
  const v1 = await prisma.contractVersion.create({
    data: { contractId: contract, versionNumber: 1, htmlContent, plainText, s3Key: key, mimeType: DOCX, fileSize: file.length, createdById: user },
  })
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v1.id } })
  return { contract, v1: { ...v1, htmlContent } }
}

/** Our edit, saved from the editor. */
async function saveEdit(contract: string, html: string) {
  return app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/html-version`, headers: headers(), payload: { htmlContent: html } })
}

function multipart(file: Buffer, filename: string, type: string, fields: Record<string, string> = {}) {
  const boundary = `----bb${randomBytes(8).toString('hex')}`
  const payload = Buffer.concat([
    Buffer.from(Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { ...headers(), 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

/**
 * What coming back from Google Docs looks like: the working copy with a
 * colleague's suggestion, a comment and a reply to it.
 */
async function editedInGoogleDocs(workingCopy: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(workingCopy)
  let xml = await zip.file('word/document.xml')!.async('string')
  xml = xml.replace(/(<w:t xml:space="preserve">This Agreement is governed by )/,
    '<w:commentRangeStart w:id="900"/>$1')
  xml = xml.replace(/(English law\.<\/w:t><\/w:r>)/,
    '$1<w:commentRangeEnd w:id="900"/><w:r><w:commentReference w:id="900"/></w:r>'
    + '<w:ins w:id="901" w:author="Priya (Acme Legal)" w:date="2026-09-25T12:00:00Z"><w:r><w:t xml:space="preserve"> Disputes go to the courts of London.</w:t></w:r></w:ins>')
  zip.file('word/document.xml', xml)
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">`
    + '<w:comment w:id="900" w:author="Priya (Acme Legal)" w:date="2026-09-25T12:00:00Z"><w:p w14:paraId="1A000001"><w:r><w:t>Can we accept English law?</w:t></w:r></w:p></w:comment>'
    + '<w:comment w:id="902" w:author="Neelam Dalwani" w:date="2026-09-25T12:30:00Z"><w:p w14:paraId="1A000002"><w:r><w:t>Yes, with London courts.</w:t></w:r></w:p></w:comment>'
    + '</w:comments>')
  zip.file('word/commentsExtended.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">'
    + '<w15:commentEx w15:paraId="1A000001" w15:done="0"/><w15:commentEx w15:paraId="1A000002" w15:paraIdParent="1A000001" w15:done="0"/></w15:commentsEx>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('Download for counterparty', () => {
  it('gives their Word file with our changes as tracked changes by the person sending it, and records what was sent', async () => {
    const { contract, v1 } = await contractOnTheirPaper('BB Supply Agreement')
    const download = () => app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/redline/counterparty`, headers: headers() })

    // Nothing of ours yet.
    expect((await download()).json()).toMatchObject({ code: 'NO_CHANGES' })

    const edited = v1.htmlContent.replace('thirty (30)', 'sixty (60)').replace('is unlimited.', 'is capped at the fees paid in the prior 12 months.')
    expect((await saveEdit(contract, edited)).statusCode).toBe(201)

    const res = await download()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toBe(DOCX)
    expect(res.headers['content-disposition']).toContain('BB Supply Agreement - our changes to their v1.docx')
    const stats = JSON.parse(decodeURIComponent(String(res.headers['x-redline-stats'])))
    expect(stats).toMatchObject({ modified: 2, inserted: 0, deleted: 0, skipped: [], verified: true })

    const file = res.rawPayload
    const xml = await (await JSZip.loadAsync(file)).file('word/document.xml')!.async('string')
    expect(xml).toContain('w:author="Neelam Dalwani"')
    expect(xml).toContain('<w:delText xml:space="preserve">thirty</w:delText>')
    expect((await docxParagraphs(file, 'accepted')).join('\n')).toContain('Customer shall pay within sixty (60) days.')
    expect((await docxParagraphs(file, 'original')).join('\n')).toContain('Customer shall pay within thirty (30) days.')

    const audit = await prisma.auditEvent.findFirst({ where: { orgId: org, resourceId: contract, action: 'REDLINE_EXPORTED' } })
    expect(audit?.metadata).toMatchObject({ audience: 'counterparty', author: 'Neelam Dalwani', theirVersionNumber: 1, versionNumber: 2 })
  })

  it('says why not, for a contract that came as a PDF', async () => {
    const contract = await makeContract(org, user, { title: 'BB PDF paper' })
    const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, htmlContent: '<p>Terms.</p>', plainText: 'Terms.', s3Key: 'x.pdf', mimeType: 'application/pdf', createdById: user } })
    await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id } })
    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/redline/counterparty`, headers: headers() })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'NO_WORD_ORIGINAL' })
  })
})

describe('Edit in Google Docs', () => {
  it('locks the contract, hands out a working copy, and takes the edited file back as the next version', async () => {
    const { contract, v1 } = await contractOnTheirPaper('BB Google Docs round trip')
    expect((await saveEdit(contract, v1.htmlContent.replace('thirty (30)', 'sixty (60)'))).statusCode).toBe(201)

    const start = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/start`, headers: headers() })
    expect(start.statusCode, start.body).toBe(201)
    expect(start.json()).toMatchObject({
      externalEdit: { provider: 'google-docs', startedById: user, startedByName: 'Neelam Dalwani', baseVersionNumber: 2 },
      stats: { modified: 1, verified: true },
      theirVersionNumber: 1,
    })

    // Read-only everywhere our side writes a version.
    const again = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/start`, headers: headers() })
    expect(again.json()).toMatchObject({ code: 'ALREADY_EDITING_IN_GOOGLE_DOCS' })
    const save = await saveEdit(contract, '<p>An edit made here meanwhile.</p>')
    expect(save.statusCode).toBe(409)
    expect(save.json()).toMatchObject({ code: 'EDITING_IN_GOOGLE_DOCS', detail: expect.stringContaining('Neelam Dalwani is editing this contract in Google Docs') })
    const upload = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/versions`, ...multipart(await theirPaper(), 'x.docx', DOCX) })
    expect(upload.statusCode).toBe(409)
    expect(await applyClauseProposal({ orgId: org, userId: user, contractId: contract, clauseId: 'any', proposedText: 'x' }))
      .toMatchObject({ ok: false, status: 409, code: 'EDITING_IN_GOOGLE_DOCS' })
    expect(await applyClauseBatch({ orgId: org, userId: user, contractId: contract, changes: [{ clauseId: 'any', proposedText: 'x' }] }))
      .toMatchObject({ ok: false, status: 409, code: 'EDITING_IN_GOOGLE_DOCS' })
    const send = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/redline/counterparty`, headers: headers() })
    expect(send.json()).toMatchObject({ code: 'EDITING_IN_GOOGLE_DOCS' })

    // The working copy: their paper, our change tracked.
    const copy = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/external-edit/working-copy`, headers: headers() })
    expect(copy.statusCode).toBe(200)
    expect(copy.headers['content-disposition']).toContain('BB Google Docs round trip - v2 for Google Docs.docx')
    expect((await docxParagraphs(copy.rawPayload, 'accepted')).join('\n')).toContain('sixty (60)')

    // Not a Word file, and the wrong document, are refused.
    const pdf = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/publish`, ...multipart(Buffer.from('%PDF-1.4\n%x\n'), 'x.pdf', 'application/pdf') })
    expect(pdf.statusCode).toBe(415)
    const other = Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Minutes of the board meeting held on Tuesday.')] }] })))
    const wrong = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/publish`, ...multipart(other, 'minutes.docx', DOCX) })
    expect(wrong.json()).toMatchObject({ code: 'DIFFERENT_DOCUMENT' })

    // Back from Google Docs.
    vi.mocked(queueParseDocument).mockClear()
    const returned = await editedInGoogleDocs(copy.rawPayload)
    const publish = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/publish`, ...multipart(returned, 'BB Google Docs round trip.docx', DOCX) })
    expect(publish.statusCode, publish.body).toBe(201)
    // Our change (two words, each a deletion and an insertion) and the colleague's suggestion, still open.
    expect(publish.json()).toMatchObject({
      version: { versionNumber: 3 },
      imported: { comments: 2, openSuggestions: 5, suggestionAuthors: ['Neelam Dalwani', 'Priya (Acme Legal)'] },
    })

    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract }, include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } } })
    const v3 = after.versions[0]
    expect(after.externalEdit).toBeNull()
    expect(after.currentVersionId).toBe(v3.id)
    expect(after.analysisStatus).toBe('PENDING')
    expect(v3.metadata).toMatchObject({ source: 'google-docs', externalEdit: { baseVersionNumber: 2 } })
    expect(v3.plainText).toContain('sixty (60)')
    expect(v3.plainText).toContain('Disputes go to the courts of London.')
    expect(v3.changeNote).toContain('Published from Google Docs by Neelam Dalwani')
    expect(vi.mocked(queueParseDocument)).toHaveBeenCalledWith(expect.objectContaining({ contractId: contract, versionId: v3.id }))

    // Comments come in as internal comments, the reply threaded under its comment.
    const comments = await prisma.contractComment.findMany({ where: { contractId: contract }, orderBy: { createdAt: 'asc' } })
    expect(comments).toHaveLength(2)
    expect(comments[0].body).toContain('From Google Docs, Priya (Acme Legal) (2026-09-25): Can we accept English law?')
    expect(comments[0].body).toContain('On: “This Agreement is governed by English law.')
    expect(comments[1].parentId).toBe(comments[0].id)

    // Unlocked: the editor saves again, and the counterparty redline is against their Version 1.
    expect((await saveEdit(contract, `${v3.htmlContent}<p>One more clause.</p>`)).statusCode).toBe(201)
    const redline = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/redline/counterparty`, headers: headers() })
    expect(redline.statusCode, redline.body).toBe(200)
    expect(redline.headers['content-disposition']).toContain('their v1.docx')
    const accepted = (await docxParagraphs(redline.rawPayload, 'accepted')).join('\n')
    expect(accepted).toContain('Disputes go to the courts of London.')
    expect(accepted).toContain('One more clause.')
    const xml = await (await JSZip.loadAsync(redline.rawPayload)).file('word/document.xml')!.async('string')
    // Externally, every change is the sender's; the colleague's name stays inside DraftLegal.
    expect(xml).not.toContain('Priya')
  })

  it('says when the counterparty sent a version meanwhile, and publishes anyway when asked', async () => {
    const { contract } = await contractOnTheirPaper('BB stale copy')
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/start`, headers: headers() })
    const copy = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/external-edit/working-copy`, headers: headers() })
    await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 2, htmlContent: '<p>Theirs.</p>', plainText: 'Theirs.', createdById: 'portal:link' } })

    const stale = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/publish`, ...multipart(copy.rawPayload, 'c.docx', DOCX) })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ code: 'STALE_BASE', latestVersionNumber: 2, baseVersionNumber: 1 })
    const forced = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/publish`, ...multipart(copy.rawPayload, 'c.docx', DOCX, { force: 'true' }) })
    expect(forced.statusCode, forced.body).toBe(201)
    expect(forced.json()).toMatchObject({ version: { versionNumber: 3 } })
  })

  it('DD4 — publishes a copy of the version the contract stands on, though an undone version is newer', async () => {
    const { contract } = await contractOnTheirPaper('DD4 undone newer')
    // An assistant redline, undone: v2 stays, as the newest, and the contract stands on v1.
    await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 2, htmlContent: '<p>undone</p>', plainText: 'undone', createdById: user, changeNote: 'redline_apply (moderate) (reverted via undo)' } })
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/start`, headers: headers() })
    const copy = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/external-edit/working-copy`, headers: headers() })
    const publish = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/publish`, ...multipart(copy.rawPayload, 'c.docx', DOCX) })
    expect(publish.statusCode, publish.body).toBe(201)
    expect(publish.json()).toMatchObject({ version: { versionNumber: 3 } })
  })

  it('discards a copy without making a version, and one start wins when two race', async () => {
    const { contract } = await contractOnTheirPaper('BB discard')
    const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/start`, headers: headers() })))
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])

    const discard = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/discard`, headers: headers() })
    expect(discard.json()).toEqual({ discarded: true })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).externalEdit).toBeNull()
    expect(await prisma.contractVersion.count({ where: { contractId: contract } })).toBe(1)
    const late = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/publish`, ...multipart(await theirPaper(), 'c.docx', DOCX) })
    expect(late.json()).toMatchObject({ code: 'NOT_EDITING_IN_GOOGLE_DOCS' })
  })

  it('gives a clean Word copy of our text when there is no Word file of theirs', async () => {
    const contract = await makeContract(org, user, { title: 'BB our paper' })
    const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, htmlContent: '<h1>NDA</h1><p>Each party keeps the other’s information confidential.</p>', plainText: 'NDA', createdById: user } })
    await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id } })
    const start = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/external-edit/start`, headers: headers() })
    expect(start.statusCode, start.body).toBe(201)
    expect(start.json()).toMatchObject({ stats: null, theirVersionNumber: null })
    const copy = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/external-edit/working-copy`, headers: headers() })
    expect((await docxParagraphs(copy.rawPayload, 'accepted')).join('\n')).toContain('Each party keeps the other’s information confidential.')
  })
})
