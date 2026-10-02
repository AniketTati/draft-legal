/**
 * Binder split — slice a multi-agreement PDF into one child contract per
 * agreement. Runs as the parse worker's `split-binder` job; lives in lib/ so
 * it can be tested without constructing the worker (notification-delivery.ts
 * pattern).
 *
 * C10 — two ways this used to duplicate children, and one way it failed
 * opaquely:
 *   • A re-split ("Adjust splits") created a fresh set and never removed the
 *     previous one; a BullMQ retry after a partial failure did the same.
 *     Previous split children are now replaced — or, if any has moved on
 *     (left DRAFT or been edited), the split is refused with a reason.
 *   • Splitting is PDF-only (pdf-lib). A DOCX "binder" died inside pdf-lib
 *     after three retries; it is now refused with the fix, without retrying.
 */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { UnrecoverableError } from 'bullmq'
import { prisma } from './prisma.js'
import { s3, S3_BUCKET } from './storage.js'
import { indexContract, deleteContractFromIndex } from './elasticsearch.js'
import { splitPdf, getPdfPageCount } from './pdf-splitter.js'
import { queueParseDocument } from './queue.js'
import type { SplitBinderJob } from './queue.js'
import { detectFileType, MIME } from './file-type.js'

export const SPLIT_REQUIRES_PDF =
  'Splitting a binder works on PDFs only. Save this document as a PDF and upload it again to split it, or upload each agreement separately.'

/** S3 prefix every split child's file lives under — how split children are recognised. */
export const splitPrefix = (orgId: string, contractId: string) => `${orgId}/contracts/${contractId}/splits/`

/**
 * Children created by earlier splits of this binder. Identified by their
 * split S3 key (or the parent's _splitInto list) — never by relationshipType
 * alone, since /upload lets a user attach a manual exhibit with the same one.
 */
export async function previousSplitChildren(contractId: string, orgId: string) {
  const parent = await prisma.contract.findFirst({
    where: { id: contractId, orgId }, select: { metadata: true },
  })
  const splitInto = ((parent?.metadata as { _splitInto?: unknown } | null)?._splitInto ?? []) as unknown
  const ids = Array.isArray(splitInto) ? splitInto.filter((x): x is string => typeof x === 'string') : []
  return prisma.contract.findMany({
    where: {
      orgId,
      parentContractId: contractId,
      deletedAt: null,
      OR: [
        { id: { in: ids } },
        { versions: { some: { s3Key: { startsWith: splitPrefix(orgId, contractId) } } } },
      ],
    },
    select: { id: true, title: true, status: true, _count: { select: { versions: true } } },
  })
}

/** Why a re-split must not replace these children, or null if it may. */
export function resplitBlocker(children: Array<{ title: string; status: string; _count: { versions: number } }>): string | null {
  const movedOn = children.filter(c => c.status !== 'DRAFT' || c._count.versions > 1)
  if (movedOn.length === 0) return null
  const names = movedOn.slice(0, 3).map(c => `"${c.title}" (${c.status.toLowerCase().replace(/_/g, ' ')})`).join(', ')
  return `This binder was already split, and ${movedOn.length === 1 ? 'one of those contracts has' : `${movedOn.length} of those contracts have`} `
    + `moved on since: ${names}. Re-splitting would replace them. Archive or delete them first, then split again.`
}

export async function splitBinder(data: SplitBinderJob): Promise<void> {
  const { contractId, orgId, userId, splits } = data

  console.info('[parse-worker] split-binder start contractId=%s splits=%d', contractId, splits.length)

  // C11 — a binder uploaded to a diligence room splits into the target's
  // agreements; they stay in that room rather than leaking into the org's
  // own contracts, search and agent answers.
  const parentRow = await prisma.contract.findUnique({ where: { id: contractId }, select: { diligenceRoomId: true, ownerId: true } })
  const diligenceRoomId = parentRow?.diligenceRoomId ?? null
  // X45 — a child's owner is a user. A split a key asked for names the
  // binder's owner; one queued by a key before that (its user `apikey:<id>`)
  // gets the same, rather than failing after retiring the previous children.
  const ownerId = data.ownerId ?? (userId.startsWith('apikey:') ? parentRow?.ownerId : userId)
  if (!ownerId) throw new UnrecoverableError(`Binder ${contractId} not found`)

  // Previous children: replace them, unless one has moved on (then refuse).
  const previous = await previousSplitChildren(contractId, orgId)
  const blocker = resplitBlocker(previous)
  if (blocker) {
    const meta = (await prisma.contract.findUnique({ where: { id: contractId }, select: { metadata: true } }))?.metadata as object ?? {}
    await prisma.contract.update({
      where: { id: contractId },
      data:  { analysisStatus: 'DONE', metadata: { ...meta, _splitError: blocker } },
    })
    console.warn('[parse-worker] split-binder refused contractId=%s: %s', contractId, blocker)
    return
  }

  await prisma.contract.update({
    where: { id: contractId },
    data: { analysisStatus: 'SPLITTING' },
  })

  // Fetch original version to get s3Key + mimeType
  const version = await prisma.contractVersion.findFirst({
    where: { contractId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, s3Key: true, mimeType: true },
  })
  if (!version?.s3Key) throw new Error(`No S3 key found for contractId=${contractId}`)

  // Download original PDF
  const s3Res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: version.s3Key }))
  const chunks: Uint8Array[] = []
  for await (const chunk of s3Res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  const buffer = Buffer.concat(chunks)

  // Retrying can't turn a DOCX into a PDF — fail once, with the fix.
  if (detectFileType(buffer) !== MIME.PDF) throw new UnrecoverableError(SPLIT_REQUIRES_PDF)

  const totalPages = await getPdfPageCount(buffer)
  const slices = await splitPdf(buffer, splits, totalPages)

  // Retire the previous set only once the new one is certain to be built.
  if (previous.length) {
    await prisma.contract.updateMany({
      where: { id: { in: previous.map(c => c.id) } },
      data:  { deletedAt: new Date() },
    })
    for (const c of previous) {
      deleteContractFromIndex(c.id).catch(err =>
        console.warn('[parse-worker] ES delete of replaced split child failed childId=%s: %s', c.id, err?.message ?? err))
    }
    console.info('[parse-worker] split-binder replaced %d previous children of contractId=%s', previous.length, contractId)
  }

  const childIds: string[] = []
  for (const slice of slices) {
    const childS3Key = `${splitPrefix(orgId, contractId)}${slice.title.replace(/\s+/g, '-')}.pdf`
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key:    childS3Key,
      Body:   slice.pdfBytes,
      ContentType: 'application/pdf',
    }))

    // P2.3 — schema-aligned: Contract uses `createdBy` (not `uploadedBy`),
    // ContractVersion has no `filename` column. Parent-child link via
    // parentContractId; relationshipType='split_part' marks it as a
    // binder slice rather than an amendment.
    const child = await prisma.contract.create({
      data: {
        orgId,
        ownerId,
        createdBy:        userId,
        title:            slice.title,
        type:             slice.type,
        analysisStatus:   'PENDING',
        parentContractId: contractId,
        relationshipType: 'split_part',
        diligenceRoomId,
        versions: {
          create: {
            versionNumber: 1,
            htmlContent:   '',
            plainText:     '',
            s3Key:    childS3Key,
            mimeType: 'application/pdf',
            fileSize: slice.pdfBytes.byteLength,
            createdById: userId,
            changeNote:  `Split from scanned file (pages ${slice.pageStart}-${slice.pageEnd})`,
          },
        },
      },
      include: { versions: true },
    })

    const childVersion = child.versions[0]

    await prisma.contract.update({
      where: { id: child.id },
      data:  { currentVersionId: childVersion.id },
    })

    // Wave 3.2 — index the split child so it's searchable. plainText is empty
    // until its own parse job runs (queued below), which re-indexes with full
    // text via handleChunkAndIndex. Fire-and-forget.
    indexContract(child.id, {
      orgId,
      title:          child.title,
      type:           child.type,
      status:         child.status,
      plainText:      '',
      tags:           child.tags,
      createdAt:      child.createdAt.toISOString(),
      ...(diligenceRoomId ? { diligenceRoomId } : {}),
    }).catch(err => console.warn('[parse-worker] ES index on binder child failed childId=%s: %s', child.id, err?.message ?? err))

    queueParseDocument({
      contractId: child.id,
      versionId:  childVersion.id,
      s3Key:      childS3Key,
      mimeType:   'application/pdf',
      filename:   `${slice.title}.pdf`,
      orgId,
    })
    childIds.push(child.id)
  }

  // Mark parent as DONE — store child IDs so UI can show "Adjust splits" banner
  const parentMeta = (await prisma.contract.findUnique({
    where: { id: contractId }, select: { metadata: true },
  }))?.metadata as Record<string, unknown> ?? {}
  const { _splitError: _cleared, ...rest } = parentMeta
  await prisma.contract.update({
    where: { id: contractId },
    data: { analysisStatus: 'DONE', metadata: { ...rest, _splitInto: childIds } as never },
  })

  console.info('[parse-worker] split-binder done contractId=%s children=%s', contractId, childIds.join(','))
}
