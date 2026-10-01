/**
 * Parse Worker — handles documentQueue jobs:
 *   parse-document  : S3 download → full text extraction → queue extract-ai
 *   embed-contract  : pgvector embedding of clause segments
 *   chunk-and-index : SOTA legal chunking → ES clause index + full-text refresh
 *                     of the CONTRACT_INDEX doc (Wave 3.1) → queue embed-contract
 */
import { Worker } from 'bullmq'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { extractDocument } from '../lib/document.js'
import { embedContractVersion } from '../lib/embeddings.js'
import { legalChunkAndStore } from '../lib/legal-chunker.js'
import { indexContract, reindexContract } from '../lib/elasticsearch.js'
import { getPdfPageCount } from '../lib/pdf-splitter.js'
import { splitBinder } from '../lib/binder-split.js'
import { queueDetectBinder, queueEmbedContract, queuePlaybookReview, queueExtractAi, queueAnswerDiligenceDocument } from '../lib/queue.js'
import type { ParseDocumentJob, ChunkAndIndexJob, SplitBinderJob, RefreshVersionJob, ReadExhibitJob } from '../lib/queue.js'
import { carryClauses } from '../lib/clause-carry.js'
import { refreshVersion } from '../lib/version-refresh.js'
import { readTrackedChanges } from '../lib/tracked-changes.js'
import { readExhibit } from '../lib/exhibits.js'
import { MIME } from '../lib/file-type.js'
import { runVersionReviewSteps } from '../lib/version-review-steps.js'

// ─── parse-document ──────────────────────────────────────────────────────────

async function handleParseDocument(data: ParseDocumentJob): Promise<void> {
  const { contractId, versionId, s3Key, mimeType, filename, orgId } = data

  console.info('[parse-worker] parse-document start contractId=%s versionId=%s', contractId, versionId)

  // Download raw bytes from S3
  const s3Res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }))
  const chunks: Uint8Array[] = []
  for await (const chunk of s3Res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)

  // docs/39 A7 — the page says the document is being read from the start: a
  // long scan takes minutes, a batch of pages at a time, and says how far it's got.
  await prisma.contract.updateMany({ where: { id: contractId, analysisStatus: 'PENDING' }, data: { analysisStatus: 'PARSING' } })
  const markOcr = (mark: { done: number; of: number } | null) => (mark
    ? prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_ocr}', ${JSON.stringify(mark)}::jsonb) WHERE id = ${contractId}`
    : prisma.$executeRaw`UPDATE contracts SET metadata = COALESCE(metadata, '{}'::jsonb) - '_ocr' WHERE id = ${contractId}`
  ).catch(err => console.warn('[parse-worker] OCR progress not marked: %s', (err as Error).message))

  // Full text extraction — no char limit
  let extracted: Awaited<ReturnType<typeof extractDocument>>
  try {
    extracted = await extractDocument(buffer, mimeType, filename, { onOcrProgress: async (done, of) => { await markOcr({ done, of }) } })
  } finally {
    await markOcr(null)
  }

  console.info('[parse-worker] extracted chars=%d htmlLen=%d', extracted.plainText.length, extracted.htmlContent.length)

  if (!extracted.plainText.trim()) {
    await prisma.contract.update({
      where: { id: contractId },
      data: { analysisStatus: 'FAILED', analysisError: 'Could not extract text from the document. The file may be a scanned image without OCR support, or the content is empty.' },
    })
    return
  }

  // Update version with extracted text + P2.1 OCR metadata. The OCR
  // flag + backend name travel on the version so downstream (HITL
  // queue, trust badges, re-index) can treat OCR'd text as lower-
  // confidence than digital extraction without re-deriving the signal.
  const existingVersion = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { metadata: true },
  })
  const existingMd = (existingVersion?.metadata as Record<string, unknown> | null) ?? {}
  const nextMd: Record<string, unknown> = { ...existingMd }
  if (extracted.ocrApplied) {
    nextMd.extraction = {
      ocrApplied:  true,
      ocrBackend:  extracted.ocrBackend ?? 'unknown',
      ocrPages:    extracted.ocrPages ?? 0,
      pageCount:   extracted.pageCount ?? 0,
      extractedAt: new Date().toISOString(),
      note:        'Text came from OCR, not digital extraction — treat confidence accordingly.',
      // A7 — a scan read in batches: how sure the engine was of each page,
      // where each starts in the text (scan-quality.ts), what it couldn't read.
      ...(extracted.ocr && {
        ocrQuality:   extracted.ocr.quality,
        pageStarts:   extracted.ocr.pageStarts,
        unreadPages:  extracted.ocr.unread,
        ocrTruncated: extracted.ocr.truncated,
      }),
    }
  } else if (extracted.pageCount !== undefined) {
    // Still record pageCount even on digital path, for analytics +
    // the HITL queue to know how large a contract is.
    nextMd.extraction = {
      ocrApplied:  false,
      pageCount:   extracted.pageCount,
      extractedAt: new Date().toISOString(),
    }
  }
  // P2.2 — persist the section tree. Every version has one; downstream
  // TOC / citations / section-anchored comments read it from here
  // without re-parsing HTML.
  if (extracted.structure) {
    nextMd.structure = extracted.structure
  }
  // docs/39 A9 — a Word file's tracked changes nobody has accepted: the text
  // reads them made (as mammoth reads it), so the page says so and the values
  // keep what the file says without them (lib/tracked-changes.ts).
  delete nextMd.trackedChanges
  if (extracted.mimeType === MIME.DOCX) {
    try {
      nextMd.trackedChanges = await readTrackedChanges(buffer)
    } catch (err) {
      console.warn('[parse-worker] tracked changes of versionId=%s not read: %s', versionId, (err as Error).message)
    }
  }
  // docs/39 A12 — a legacy .doc or a scan kept as an image was read as the PDF
  // it was made into: that PDF is kept, to be shown as the Original and downloaded.
  let renderedPdfKey: string | undefined
  if (extracted.convertedPdf) {
    renderedPdfKey = `${s3Key}.pdf`
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: renderedPdfKey, Body: extracted.convertedPdf, ContentType: 'application/pdf' }))
  }
  await prisma.contractVersion.update({
    where: { id: versionId },
    data: {
      plainText:   extracted.plainText,
      htmlContent: extracted.htmlContent,
      metadata:    nextMd as never,
      ...(renderedPdfKey && { renderedPdfKey }),
    },
  })

  // DD2 — until analysis gives this version its own clauses, it keeps the
  // previous version's, followed into its text: the clause tools, the
  // Clauses tab and search read the document the contract now has.
  // Analysis replaces them (storeClauseSegments).
  try {
    const carried = await carryClauses({ contractId, toVersionId: versionId })
    if (carried.carried) console.info('[parse-worker] carried %d clauses (%d changed, %d gone) from %s to %s', carried.carried, carried.changed, carried.dropped, carried.fromVersionId, versionId)
  } catch (err) {
    console.warn('[parse-worker] carrying clauses to versionId=%s failed: %s', versionId, (err as Error).message)
  }

  // This version's text just changed, so any cached diff involving it is now
  // stale. VersionDiffCache is keyed on version IDs alone, so nothing else
  // would ever evict these rows — without this they'd outlive the content
  // they describe.
  await prisma.versionDiffCache.deleteMany({
    where: { OR: [{ v1Id: versionId }, { v2Id: versionId }] },
  })

  // Get page count (needed later by detect-binder for auto-split range computation)
  let totalPages: number | undefined
  if (mimeType === 'application/pdf' || extracted.convertedPdf) {
    totalPages = await getPdfPageCount(extracted.convertedPdf ?? buffer)
    console.info('[parse-worker] pdf page count contractId=%s pages=%d', contractId, totalPages)
  }

  // Set status: PARSING — store _totalPages so detect-binder can compute split ranges
  const existingMeta = (await prisma.contract.findUnique({
    where: { id: contractId },
    select: { metadata: true },
  }))?.metadata as object ?? {}

  await prisma.contract.update({
    where: { id: contractId },
    data: {
      analysisStatus: 'PARSING',
      metadata: { ...existingMeta, ...(totalPages !== undefined && { _totalPages: totalPages }) },
    },
  })

  // Queue LLM binder detection (Service 2a) — replaces inline heuristic
  queueDetectBinder({ contractId, versionId, orgId })

  console.info('[parse-worker] parse-document done, detect-binder queued for contractId=%s', contractId)
}

// ─── read-exhibit (docs/39 A12) ──────────────────────────────────────────────

/** How long after an exhibit is read the contract is read again: exhibits attached together, read together. */
export const EXHIBIT_REREAD_DELAY_MS = 15_000

async function handleReadExhibit(data: ReadExhibitJob): Promise<void> {
  if (!await readExhibit(data)) return
  // Its words are found in search with the contract's.
  await reindexContract(data.contractId).catch(err => console.warn('[parse-worker] re-index after exhibit failed contractId=%s: %s', data.contractId, (err as Error).message))
  // An analysed contract is read again with it, its type as it stands (an
  // exhibit's own kind — an SLA attached to an MSA — isn't the contract's).
  // Not analysed yet: its analysis reads it.
  const c = await prisma.contract.findFirst({ where: { id: data.contractId, orgId: data.orgId, deletedAt: null }, select: { analysisStatus: true, currentVersionId: true, type: true } })
  if (!c?.currentVersionId || c.analysisStatus !== 'DONE') return
  await prisma.contract.updateMany({ where: { id: data.contractId, analysisStatus: 'DONE' }, data: { analysisStatus: 'EXTRACTING' } })
  // The page says why it's being read again (cleared when that read is saved).
  await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_exhibitReread}', to_jsonb(${new Date().toISOString()}::text)) WHERE id = ${data.contractId}`
  queueExtractAi(
    { contractId: data.contractId, versionId: c.currentVersionId, orgId: data.orgId, contractType: c.type, triggeredBy: 'exhibit', typeLocked: true },
    { jobId: `exhibits-${data.contractId}`, delay: EXHIBIT_REREAD_DELAY_MS },
  )
  console.info('[parse-worker] exhibit read contractId=%s — the contract is read again with it', data.contractId)
}

// ─── chunk-and-index ─────────────────────────────────────────────────────────

async function handleChunkAndIndex(data: ChunkAndIndexJob): Promise<void> {
  const { contractId, versionId, orgId } = data

  console.info('[parse-worker] chunk-and-index start contractId=%s versionId=%s', contractId, versionId)

  await prisma.contract.update({
    where: { id: contractId },
    data: { analysisStatus: 'INDEXING' },
  })

  // Wave 3.1 — refresh the CONTRACT_INDEX ('contracts') document with the real
  // full text now that parsing produced it. Upload/create paths index a stub
  // with plainText:'' on the promise it would be "re-indexed after parse"; this
  // is where that promise is kept, so contract_search/portfolio_search BM25 has
  // an actual document body to match on. Runs BEFORE the clause guard below so a
  // contract with parsed text but zero detected clauses still gets a full-text
  // index. indexContract is a full-document overwrite, so this one write both
  // fills plainText and refreshes the denormalized metadata. Fire-and-forget so
  // an ES hiccup never flips the job to FAILED (the failed handler does that).
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    select: {
      title: true, type: true, status: true, counterpartyName: true,
      jurisdiction: true, summary: true, tags: true, riskScore: true,
      effectiveDate: true, expiryDate: true, keyTerms: true, metadata: true,
      createdAt: true, diligenceRoomId: true,
    },
  })
  const version = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { plainText: true },
  })
  // docs/39 D6 — a diligence room's document, read: the room's questions are asked of it
  // (the extraction's save asks too; one job per version).
  const askRoomQuestions = () => { if (contract?.diligenceRoomId) queueAnswerDiligenceDocument({ orgId, contractId, versionId }) }
  if (contract) {
    indexContract(contractId, {
      orgId,
      title:            contract.title,
      type:             contract.type,
      status:           contract.status,
      counterpartyName: contract.counterpartyName ?? undefined,
      jurisdiction:     contract.jurisdiction ?? undefined,
      plainText:        version?.plainText ?? '',
      summary:          contract.summary ?? undefined,
      tags:             contract.tags,
      riskScore:        contract.riskScore ?? undefined,
      effectiveDate:    contract.effectiveDate?.toISOString(),
      expiryDate:       contract.expiryDate?.toISOString(),
      createdAt:        contract.createdAt.toISOString(),
      keyTerms:         contract.keyTerms as Record<string, unknown>,
      metadata:         contract.metadata as Record<string, unknown>,
    }).catch(err => console.warn('[parse-worker] full-text ES re-index failed contractId=%s: %s', contractId, err?.message ?? err))
  }

  // docs/41 Parts 9–10 — drafting findings and compliance applicability; never fails the job.
  void runVersionReviewSteps({ contractId, versionId }).catch(() => {})

  // Fetch clause segments written by the agents service
  const clauses = await prisma.contractClause.findMany({
    where: { versionId },
    orderBy: { sortOrder: 'asc' },
  })

  if (clauses.length === 0) {
    console.warn('[parse-worker] no clauses found for versionId=%s — marking DONE (full-text already indexed above)', versionId)
    await prisma.contract.update({
      where: { id: contractId },
      data: { analysisStatus: 'DONE', analysisError: null },
    })
    askRoomQuestions()
    return
  }

  await legalChunkAndStore(versionId, contractId, orgId, clauses, contract)

  // Queue embeddings (Service 3b)
  queueEmbedContract(versionId)

  await prisma.contract.update({
    where: { id: contractId },
    data: { analysisStatus: 'DONE', analysisError: null },
  })
  askRoomQuestions()

  // Score the freshly-extracted clauses against the org playbook. This is the
  // only automatic playbook pass a received contract ever gets: redline
  // analysis diffs two versions, so it cannot run on a document that has just
  // arrived with a single version. Queued after DONE so the contract is
  // already usable — a failure here leaves analysisStatus untouched.
  queuePlaybookReview({ contractId, orgId, versionId })

  console.info('[parse-worker] chunk-and-index done for contractId=%s', contractId)
}

// ─── refresh-version (DD2) ───────────────────────────────────────────────────
// A version made by editing: lib/version-refresh.ts (refreshVersion).

// ─── split-binder ─────────────────────────────────────────────────────────────
// The body lives in lib/binder-split.ts so it can be tested without
// constructing this file's BullMQ Worker.

// ─── Worker ──────────────────────────────────────────────────────────────────

export const parseWorker = new Worker(
  'documents',
  async (job) => {
    console.info('[worker:documents] → start name=%s id=%s', job.name, job.id)
    if (job.name === 'parse-document') {
      await handleParseDocument(job.data as ParseDocumentJob)
    } else if (job.name === 'embed-contract') {
      await embedContractVersion(job.data.versionId as string)
    } else if (job.name === 'chunk-and-index') {
      await handleChunkAndIndex(job.data as ChunkAndIndexJob)
    } else if (job.name === 'split-binder') {
      await splitBinder(job.data as SplitBinderJob)
    } else if (job.name === 'refresh-version') {
      await refreshVersion(job.data as RefreshVersionJob)
    } else if (job.name === 'read-exhibit') {
      await handleReadExhibit(job.data as ReadExhibitJob)
    }
  },
  { connection: redis, concurrency: 3 }
)

parseWorker.on('completed', (job) => {
  console.info('[worker:documents] ✓ job done name=%s id=%s', job.name, job.id)
})

parseWorker.on('failed', async (job, err) => {
  // P2.3 — log the stack too so silent Prisma validation fails don't
  // hide behind an empty `err.message` like split-binder did pre-fix.
  console.error('[worker:documents] ✗ job failed name=%s id=%s attempt=%d/%d err=%s',
    job?.name, job?.id, job?.attemptsMade ?? 0, job?.opts?.attempts ?? 3,
    err?.message || err?.toString() || 'unknown')
  if (err?.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'))

  const maxAttempts = job?.opts?.attempts ?? 3
  const exhausted = (job?.attemptsMade ?? 0) >= maxAttempts

  // parse-document — mark FAILED after all retries
  if (job?.name === 'parse-document' && exhausted) {
    const { contractId } = job.data as ParseDocumentJob
    await prisma.contract.update({
      where: { id: contractId },
      data: { analysisStatus: 'FAILED', analysisError: err.message.slice(0, 500) },
    }).catch(() => {})
  }

  // chunk-and-index — mark FAILED after all retries (contract would be stuck at INDEXING otherwise)
  if (job?.name === 'chunk-and-index' && exhausted) {
    const { contractId } = job.data as ChunkAndIndexJob
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        analysisStatus: 'FAILED',
        analysisError: `Search indexing failed: ${err.message.slice(0, 400)}`,
      },
    }).catch(() => {})
  }

  // split-binder — mark FAILED after all retries
  if (job?.name === 'split-binder' && exhausted) {
    const { contractId } = job.data as SplitBinderJob
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        analysisStatus: 'FAILED',
        analysisError: `Binder split failed: ${err.message.slice(0, 400)}`,
      },
    }).catch(() => {})
  }
})
