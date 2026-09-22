/**
 * S3 — the external portal upload path must validate file CONTENT, not the
 * client-declared mimetype. An unauthenticated counterparty holding an upload
 * link could otherwise store HTML labelled as a PDF, which the presigned
 * download URL would later serve back as whatever type was stored.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { signPortalToken } from './share.js'

let app: TestApp
let org: string, contract: string, portalToken: string

function multipart(filename: string, contentType: string, body: Buffer) {
  const boundary = `----it${randomBytes(8).toString('hex')}`
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Portal Upload Org')
  const owner = await makeUser(org)
  contract = await makeContract(org, owner, { status: 'UNDER_NEGOTIATION' })
  const token = randomBytes(32).toString('hex')
  await prisma.contractShareLink.create({
    data: {
      orgId: org, contractId: contract, token, permissions: ['read', 'upload'],
      expiresAt: new Date(Date.now() + 3600_000), createdById: owner,
    },
  })
  portalToken = signPortalToken({ token, contractId: contract, orgId: org, permissions: ['read', 'upload'] }, 3600)
})

afterAll(async () => {
  await prisma.contractShareLink.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('POST /portal/:token/versions validates content', () => {
  it('refuses HTML declared as application/pdf, and stores nothing', async () => {
    const html = Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>')
    const { payload, headers } = multipart('redline.pdf', 'application/pdf', html)
    const res = await app.inject({ method: 'POST', url: `/api/v1/portal/${portalToken}/versions`, payload, headers })
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toMatch(/Allowed: PDF, DOCX/)
    expect(await prisma.contractVersion.count({ where: { contractId: contract } })).toBe(0)
  })

  it('refuses SVG declared as a DOCX', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    const { payload, headers } = multipart(
      'redline.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', svg,
    )
    const res = await app.inject({ method: 'POST', url: `/api/v1/portal/${portalToken}/versions`, payload, headers })
    expect(res.statusCode).toBe(415)
  })

  it('accepts a real PDF even when mislabelled, and stores the detected type', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
    const { payload, headers } = multipart('redline.pdf', 'application/octet-stream', pdf)
    const res = await app.inject({ method: 'POST', url: `/api/v1/portal/${portalToken}/versions`, payload, headers })
    // 201 when object storage is reachable; 502 when it is not (CI runs no
    // MinIO). Both mean the file passed the content gate.
    expect([201, 502]).toContain(res.statusCode)
    if (res.statusCode === 201) {
      const v = await prisma.contractVersion.findFirst({ where: { contractId: contract }, select: { mimeType: true } })
      expect(v?.mimeType).toBe('application/pdf')
    }
  })
})
