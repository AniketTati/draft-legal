/**
 * DD8 — sealing a contract signed on a Word file. Found by a live signing:
 * every retry failed with "No PDF header found" (the seal stamped the .docx
 * bytes as a PDF), so the signed contract never got its sealed copy. The
 * sealed copy is also a new version, which keeps the signed version's
 * clauses (DD2).
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { Document, Packer, Paragraph } from 'docx'

// Kept off the shared Redis queue, which the dev API's workers also consume.
vi.mock('./queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  queueRefreshVersion: vi.fn(),
}))

import { makeOrg, makeUser, makeContract, cleanupAll, prisma } from '../test-support/helpers.js'
import { s3, S3_BUCKET } from './storage.js'
import { extractDocument } from './document.js'
import { sealSignedContract } from './seal-contract.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
let org: string, user: string

beforeAll(async () => {
  org = await makeOrg('DD8 Seal Org')
  user = await makeUser(org)
})
afterAll(async () => { await cleanupAll() })

describe('sealing a contract signed on a Word file', () => {
  it('seals a PDF of its text, and the sealed version keeps the clauses', async () => {
    const contractId = await makeContract(org, user, { title: 'DD8 Word seal', status: 'EXECUTED' })
    const file = Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph('SUPPLY AGREEMENT'),
      new Paragraph('Customer shall pay all undisputed invoices within sixty (60) days.'),
      new Paragraph("Each party's aggregate liability shall not exceed the fees paid in the twelve (12) months preceding the claim."),
    ] }] })))
    const key = `${org}/contracts/${contractId}/${Date.now()}-their-paper.docx`
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: file, ContentType: DOCX }))
    const { htmlContent, plainText } = await extractDocument(file, DOCX, 'their-paper.docx')
    const signed = await prisma.contractVersion.create({
      data: { contractId, versionNumber: 1, htmlContent, plainText, s3Key: key, mimeType: DOCX, fileSize: file.length, createdById: user },
    })
    await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: signed.id } })
    await prisma.contractClause.createMany({
      data: [
        { versionId: signed.id, clauseType: 'payment', content: 'Customer shall pay all undisputed invoices within sixty (60) days.', sortOrder: 0, riskRating: 'favorable' },
        { versionId: signed.id, clauseType: 'limitation_of_liability', content: "Each party's aggregate liability shall not exceed the fees paid in the twelve (12) months preceding the claim.", sortOrder: 1, riskRating: 'neutral' },
      ],
    })
    const sr = await prisma.signatureRequest.create({
      data: {
        orgId: org, contractId, versionId: signed.id, status: 'COMPLETED', completedAt: new Date(), createdById: user,
        signers: { create: [{ email: 'dana@example.com', name: 'Dana', token: randomBytes(16).toString('hex'), status: 'SIGNED', signedAt: new Date(), signedName: 'Dana' }] },
      },
    })

    const out = await sealSignedContract(sr.id)
    expect(out.status).toBe('sealed')
    const sealed = await prisma.contractVersion.findUnique({ where: { id: (out as { versionId: string }).versionId } })
    expect(sealed).toMatchObject({ mimeType: 'application/pdf', versionNumber: 2, plainText })
    expect((await prisma.contract.findUnique({ where: { id: contractId } }))?.currentVersionId).toBe(sealed!.id)
    // The signed version's text was rendered to be sealed.
    expect((await prisma.contractVersion.findUnique({ where: { id: signed.id } }))?.renderedPdfKey).toBeTruthy()
    const clauses = await prisma.contractClause.findMany({ where: { versionId: sealed!.id }, orderBy: { sortOrder: 'asc' } })
    expect(clauses.map(c => [c.clauseType, c.riskRating])).toEqual([['payment', 'favorable'], ['limitation_of_liability', 'neutral']])

    await prisma.signer.deleteMany({ where: { signatureRequestId: sr.id } })
    await prisma.signatureEvent.deleteMany({ where: { signatureRequestId: sr.id } })
  })
})
