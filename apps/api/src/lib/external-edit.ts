/**
 * BB2/BB3 — their Word file, round-tripped.
 *
 * "Edit in Google Docs" hands out a working copy (their paper with our
 * changes as tracked changes, which Google Docs shows as suggestions) and
 * makes DraftLegal's copy read-only until the edited file is published back
 * as the next version, or the copy is discarded. The lock lives in its own
 * column (contract.externalEdit), and every path by which our side writes a
 * version checks it. The counterparty's uploads (portal, email) are never
 * blocked: they make the working copy stale, which publishing then says.
 *
 * "Download for counterparty" is their paper with our current version as
 * tracked changes, authored by the person sending it.
 */
import { createHash } from 'node:crypto'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from './prisma.js'
import { s3, S3_BUCKET } from './storage.js'
import { MIME } from './file-type.js'
import { redlineDocx, type RedlineStats } from './ooxml/docx-redline.js'
import { htmlBlocks } from './ooxml/html-blocks.js'

export interface ExternalEditLock {
  provider:          'google-docs'
  startedById:       string
  startedByName:     string
  startedAt:         string
  baseVersionId:     string
  baseVersionNumber: number
  /** The working copy handed out, as stored. */
  workingCopyKey:    string
  workingCopyName:   string
}

export function lockOf(value: unknown): ExternalEditLock | null {
  const v = value as ExternalEditLock | null | undefined
  return v && typeof v === 'object' && v.provider === 'google-docs' ? v : null
}

/** The 409 a write path answers while a working copy is out. */
export function lockedBody(lock: ExternalEditLock) {
  return {
    code:   'EDITING_IN_GOOGLE_DOCS',
    detail: `${lock.startedByName} is editing this contract in Google Docs (from Version ${lock.baseVersionNumber}). `
      + 'Publish that copy back, or discard it, before changing the contract here.',
    externalEdit: lock,
  }
}

/** For write paths that start from a contract id: the lock's 409 body, or null. */
export async function externalEditBlock(contractId: string) {
  const c = await prisma.contract.findUnique({ where: { id: contractId }, select: { externalEdit: true } })
  const lock = lockOf(c?.externalEdit)
  return lock ? { status: 409 as const, ...lockedBody(lock) } : null
}

export async function readObject(key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  return Buffer.from(await obj.Body!.transformToByteArray())
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** A version made by publishing a Google Docs copy back. */
export const isGoogleDocsVersion = (metadata: unknown) => (metadata as { source?: string } | null)?.source === 'google-docs'

/**
 * Their paper: the latest Word file among the contract's versions that isn't
 * one of our Google Docs round trips — what they sent, or last sent back.
 */
export async function theirWordVersion(contractId: string) {
  const files = await prisma.contractVersion.findMany({
    where:   { contractId, mimeType: MIME.DOCX, s3Key: { not: null } },
    orderBy: { versionNumber: 'desc' },
    select:  { id: true, versionNumber: true, s3Key: true, metadata: true, createdById: true },
  })
  return files.find(v => !isGoogleDocsVersion(v.metadata)) ?? null
}

/** Their paper with `html` written in as tracked changes by `author`. */
export async function redlineAgainstTheirs(
  base: { s3Key: string | null },
  html: string,
  author: string,
): Promise<{ docx: Buffer; stats: RedlineStats }> {
  const original = await readObject(base.s3Key!)
  return redlineDocx(original, htmlBlocks(html), { author, acceptExisting: true })
}

/** A safe file name for a download: the contract's title and a suffix. */
export function fileName(title: string, suffix: string): string {
  const safe = title.replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Contract'
  return `${safe} - ${suffix}.docx`
}
