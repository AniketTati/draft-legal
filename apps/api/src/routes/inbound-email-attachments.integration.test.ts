/**
 * X14 — POST /inbound/email (provider webhooks, multipart). Two edge cases
 * rejected ordinary emails:
 *   - busboy's file-part limit (5) made the sixth part throw 413, so an email
 *     with inline images before the PDF was refused outright;
 *   - the 25MB check ran after the first PDF/DOCX was chosen, so an oversized
 *     first document refused the email instead of trying the next one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: { send: async () => ({}) },
}))
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueParseDocument: vi.fn(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

const SECRET = 'it-inbound-secret'
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`)

let app: TestApp
let org: string, contract: string

function email(files: Array<{ name: string; type: string; body: Buffer }>) {
  const boundary = `----it${randomBytes(8).toString('hex')}`
  const field = (k: string, v: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
  const payload = Buffer.concat([
    field('to', `contracts+${contract}@inbound.example.com`),
    field('from', 'Counter Party <cp@example.com>'),
    field('subject', 'Our redline'),
    field('text', 'See attached.'),
    ...files.flatMap((f, i) => [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment${i + 1}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`),
      f.body, Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ])
  return app.inject({
    method: 'POST', url: '/api/v1/inbound/email', payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-inbound-secret': SECRET },
  })
}

beforeAll(async () => {
  process.env.INBOUND_EMAIL_SECRET = SECRET
  app = await getApp()
  org = await makeOrg('Inbound Email Org')
  const owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Inbound target' })
  const cp = await prisma.counterparty.create({ data: { orgId: org, name: 'Counter Party', email: 'cp@example.com' } })
  await prisma.contract.update({ where: { id: contract }, data: { counterpartyId: cp.id } })
})

afterAll(async () => {
  delete process.env.INBOUND_EMAIL_SECRET
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null, counterpartyId: null } })
  await prisma.counterparty.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

const versions = () => prisma.contractVersion.count({ where: { contractId: contract } })

describe('inbound email attachments', () => {
  it('inline images ahead of the PDF don\'t get the email refused', async () => {
    const before = await versions()
    const images = Array.from({ length: 7 }, (_, i) => ({ name: `image${i}.png`, type: 'image/png', body: PNG }))
    const res = await email([...images, { name: 'redline.pdf', type: 'application/pdf', body: pdf('redline') }])
    expect(res.statusCode).toBe(201)
    expect(await versions()).toBe(before + 1)
  })

  it('an oversized first document is skipped for the next one', async () => {
    const before = await versions()
    const huge = Buffer.concat([pdf('huge'), Buffer.alloc(26 * 1024 * 1024, 0x20)])
    const res = await email([
      { name: 'scan.pdf', type: 'application/pdf', body: huge },
      { name: 'redline.pdf', type: 'application/pdf', body: pdf('small') },
    ])
    expect(res.statusCode).toBe(201)
    expect(await versions()).toBe(before + 1)
  })

  // X66 — the size check that answers 413 saw only JSON attachments. A file
  // part over the limit reached it empty, so an email whose only document
  // was too large was told it had no PDF or DOCX.
  it('an email whose only document is too large is told so (413)', async () => {
    const before = await versions()
    const huge = Buffer.concat([pdf('huge'), Buffer.alloc(26 * 1024 * 1024, 0x20)])
    const res = await email([{ name: 'scan.pdf', type: 'application/pdf', body: huge }])
    expect(res.statusCode).toBe(413)
    expect(res.json().error).toBe('Attachment too large (25MB limit)')
    expect(await versions()).toBe(before)
  })

  it('with no usable document, the reply still names what was attached', async () => {
    const res = await email([{ name: 'photo.png', type: 'image/png', body: PNG }])
    expect(res.statusCode).toBe(400)
    expect(res.json().attachments).toEqual([{ filename: 'photo.png', contentType: 'image/png' }])
  })
})
