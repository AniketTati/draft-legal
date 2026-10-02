/**
 * docs/39 A12 — the exhibits and schedules attached to a contract, read as
 * part of it.
 *
 * An attachment was stored and never opened: a pricing schedule's fees, an
 * SLA exhibit's uptime, a DPA attached to an MSA never reached the contract's
 * fields or search. Now each is read when it's attached (the parse pipeline's
 * own reader: PDFs, scans through OCR, Word, .doc, images), kept here, and
 * the contract is read again with it: the analysis reads the contract's text
 * and then each exhibit's under its name, a value quoted from an exhibit is
 * placed in it (field-store anchorRows), and search finds its words.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from './prisma.js'
import { s3, S3_BUCKET } from './storage.js'
import { MIME } from './file-type.js'
import { extractDocument } from './document.js'
export { EXHIBIT_READ_MAX, EXHIBITS_READ_MAX, exhibitHeading, withExhibits, exhibitFinder } from './exhibit-text.js'

/** An attachment as the contract lists it (contracts.attachments). */
export interface Attachment { filename: string; s3Key: string; mimeType: string; size: number; label?: string; attachedAt?: string }

/** Files read as an exhibit: the contract's own readers, and a CSV as text (a spreadsheet isn't). */
export const EXHIBIT_READABLE: ReadonlySet<string> = new Set<string>([MIME.PDF, MIME.DOCX, MIME.DOC, MIME.TXT, MIME.CSV, MIME.PNG, MIME.JPEG, MIME.TIFF])

export function attachmentsOf(raw: unknown): Attachment[] {
  return Array.isArray(raw) ? raw.filter((a): a is Attachment => !!a && typeof a === 'object' && typeof (a as Attachment).s3Key === 'string') : []
}

/**
 * Read one attachment and keep its text. False when it's gone, or not a kind
 * that's read (a spreadsheet): nothing is kept for it.
 */
export async function readExhibit(input: { orgId: string; contractId: string; s3Key: string }): Promise<boolean> {
  const c = await prisma.contract.findFirst({ where: { id: input.contractId, orgId: input.orgId, deletedAt: null }, select: { attachments: true } })
  const a = attachmentsOf(c?.attachments).find(x => x.s3Key === input.s3Key)
  if (!a || !EXHIBIT_READABLE.has(a.mimeType)) return false
  const label = a.label || a.filename
  const where = { contractId_s3Key: { contractId: input.contractId, s3Key: a.s3Key } }
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: a.s3Key }))
    const file = Buffer.from(await obj.Body!.transformToByteArray())
    const read = a.mimeType === MIME.CSV
      ? { plainText: file.toString('utf8'), pageCount: undefined, ocrApplied: false }
      : await extractDocument(file, a.mimeType, a.filename)
    const text = read.plainText.trim()
    const data = {
      label, text, pageCount: read.pageCount ?? null, ocrApplied: !!read.ocrApplied, readAt: new Date(),
      error: text ? null : 'No text could be read from it.',
    }
    await prisma.contractExhibit.upsert({ where, create: { orgId: input.orgId, contractId: input.contractId, s3Key: a.s3Key, ...data }, update: data })
  } catch (err) {
    const error = `It couldn't be read: ${(err as Error).message}`.slice(0, 300)
    await prisma.contractExhibit.upsert({ where, create: { orgId: input.orgId, contractId: input.contractId, s3Key: a.s3Key, label, error }, update: { label, error, readAt: new Date() } })
  }
  return true
}

/** The exhibits read for a contract, in the order it lists its attachments, the ones with text. */
export async function readExhibits(contractId: string): Promise<Array<{ s3Key: string; label: string; text: string }>> {
  const [c, rows] = await Promise.all([
    prisma.contract.findUnique({ where: { id: contractId }, select: { attachments: true } }),
    prisma.contractExhibit.findMany({ where: { contractId, text: { not: '' } }, select: { s3Key: true, label: true, text: true } }),
  ])
  const order = new Map(attachmentsOf(c?.attachments).map((a, i) => [a.s3Key, i]))
  return rows.filter(r => order.has(r.s3Key)).sort((a, b) => order.get(a.s3Key)! - order.get(b.s3Key)!)
}
