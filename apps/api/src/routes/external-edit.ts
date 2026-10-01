/**
 * BB2/BB3 — "Edit in Google Docs" and "Download for counterparty"
 * (lib/external-edit.ts has the why).
 *
 *   POST /:id/external-edit/start          lock, and make the working copy
 *   GET  /:id/external-edit/working-copy   the working copy (.docx)
 *   POST /:id/external-edit/publish        the edited file back, as the next version
 *   POST /:id/external-edit/discard        unlock, no version
 *   GET  /:id/redline/counterparty         their paper, our changes tracked (.docx)
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { AuditAction } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { createAuditEvent } from '../lib/audit.js'
import { resolveRevisionAuthors } from '../lib/revision-author.js'
import { generatePlainDocx } from '../lib/docx-export.js'
import { checkUpload, MIME } from '../lib/file-type.js'
import { extractDocument } from '../lib/document.js'
import { onApprovalChange } from '../lib/approval-reset.js'
import { onSentToCounterparty } from '../lib/lifecycle.js'
import { queueParseDocument } from '../lib/queue.js'
import { DocxError, readDocxReview, type RedlineStats } from '../lib/ooxml/docx-redline.js'
import { likeness, wordBag } from '../lib/ooxml/sequence-diff.js'
import {
  lockOf, lockedBody, theirWordVersion, redlineAgainstTheirs, readObject, sha256, fileName, type ExternalEditLock,
} from '../lib/external-edit.js'

const MAX_BYTES = 25 * 1024 * 1024

/** What the web shows after a redline: counts, and what was left alone and why. */
const statsHeader = (stats: RedlineStats) => JSON.stringify({
  modified: stats.modified, inserted: stats.inserted, deleted: stats.deleted,
  skipped: stats.skipped.slice(0, 20), verified: stats.verified, acceptedExisting: stats.acceptedExisting,
})

function sendDocx(reply: FastifyReply, file: Buffer, name: string, stats?: RedlineStats) {
  if (stats) reply.header('x-redline-stats', encodeURIComponent(statsHeader(stats)))
  return reply
    .header('content-type', MIME.DOCX)
    .header('content-disposition', `attachment; filename="${name}"`)
    .send(file)
}

export async function externalEditRoutes(app: FastifyInstance) {
  guardOwnScopeContractRoutes(app)

  const authorName = async (userId: string) => (await resolveRevisionAuthors([userId], 'DraftLegal')).get(userId) ?? 'DraftLegal'

  const findContract = (id: string, orgId: string) => prisma.contract.findFirst({
    where:  { id, orgId, deletedAt: null },
    select: { id: true, orgId: true, title: true, status: true, currentVersionId: true, externalEdit: true, analysisStatus: true },
  })

  /** The version the contract stands on, if its text is ready. */
  const standing = async (c: { id: string; currentVersionId: string | null }) => {
    const v = c.currentVersionId
      ? await prisma.contractVersion.findFirst({ where: { id: c.currentVersionId, contractId: c.id } })
      : await prisma.contractVersion.findFirst({ where: { contractId: c.id }, orderBy: { versionNumber: 'desc' } })
    return v && v.htmlContent.trim() ? v : null
  }

  // ── Start: lock, and make the working copy ────────────────────────────────
  app.post('/:id/external-edit/start', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const contract = await findContract(id, orgId)
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const held = lockOf(contract.externalEdit)
    if (held) return reply.status(409).send({ ...lockedBody(held), code: 'ALREADY_EDITING_IN_GOOGLE_DOCS' })
    if (contract.status === 'EXECUTED' || contract.status === 'ARCHIVED') {
      return reply.status(409).send({ code: 'CONTRACT_FINAL', detail: 'This contract is signed or archived, so it can no longer be edited.' })
    }
    const version = await standing(contract)
    if (!version) {
      return reply.status(409).send({ code: 'VERSION_NOT_READY', detail: 'The document is still being prepared. Try again in a moment.' })
    }

    const author = await authorName(userId)
    // Their paper with our changes tracked; with no Word file of theirs (our
    // paper, or theirs came as a PDF), a clean Word copy of our text.
    const theirs = await theirWordVersion(id)
    let file: Buffer
    let stats: RedlineStats | undefined
    try {
      if (theirs) ({ docx: file, stats } = await redlineAgainstTheirs(theirs, version.htmlContent, author))
      else file = Buffer.from(await generatePlainDocx(version.htmlContent, { title: contract.title, author }))
    } catch (err) {
      if (err instanceof DocxError) return reply.status(422).send({ code: 'WORD_FILE_UNREADABLE', detail: err.message })
      throw err
    }
    if (stats && !stats.verified) req.log.warn({ contractId: id, stats }, 'BB3: working copy failed its self-check')

    const workingCopyName = fileName(contract.title, `v${version.versionNumber} for Google Docs`)
    const workingCopyKey = `${orgId}/contracts/${id}/google-docs/${Date.now()}-working-copy.docx`
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: workingCopyKey, Body: file, ContentType: MIME.DOCX }))

    const lock: ExternalEditLock = {
      provider: 'google-docs', startedById: userId, startedByName: author, startedAt: new Date().toISOString(),
      baseVersionId: version.id, baseVersionNumber: version.versionNumber, workingCopyKey, workingCopyName,
    }
    // Only one copy out at a time, even for two clicks at once.
    const took = await prisma.contract.updateMany({
      where: { id, orgId, externalEdit: { equals: Prisma.DbNull } },
      data:  { externalEdit: lock as unknown as Prisma.InputJsonValue },
    })
    if (took.count !== 1) {
      const now = await findContract(id, orgId)
      const other = lockOf(now?.externalEdit)
      return reply.status(409).send(other ? { ...lockedBody(other), code: 'ALREADY_EDITING_IN_GOOGLE_DOCS' } : { detail: 'Try again.' })
    }
    await createAuditEvent({
      orgId, userId, action: AuditAction.EXTERNAL_EDIT_STARTED, resourceType: 'contract', resourceId: id,
      metadata: {
        provider: 'google-docs', baseVersionNumber: version.versionNumber, workingCopySha256: sha256(file),
        theirVersionNumber: theirs?.versionNumber ?? null, redline: stats ? JSON.parse(statsHeader(stats)) : null,
      },
      ipAddress: req.ip,
    })
    return reply.status(201).send({ externalEdit: lock, stats: stats ? JSON.parse(statsHeader(stats)) : null, theirVersionNumber: theirs?.versionNumber ?? null })
  })

  // ── The working copy, again ───────────────────────────────────────────────
  app.get('/:id/external-edit/working-copy', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const contract = await findContract(id, req.user.orgId)
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const lock = lockOf(contract.externalEdit)
    if (!lock) return reply.status(409).send({ code: 'NOT_EDITING_IN_GOOGLE_DOCS', detail: 'No Google Docs copy is out for this contract.' })
    return sendDocx(reply, await readObject(lock.workingCopyKey), lock.workingCopyName)
  })

  // ── Discard: unlock, make nothing ─────────────────────────────────────────
  app.post('/:id/external-edit/discard', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const contract = await findContract(id, orgId)
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const lock = lockOf(contract.externalEdit)
    if (!lock) return reply.send({ discarded: false })
    await prisma.contract.updateMany({ where: { id, orgId }, data: { externalEdit: Prisma.DbNull } })
    await createAuditEvent({
      orgId, userId, action: AuditAction.EXTERNAL_EDIT_DISCARDED, resourceType: 'contract', resourceId: id,
      metadata: { provider: lock.provider, startedById: lock.startedById, startedAt: lock.startedAt, baseVersionNumber: lock.baseVersionNumber },
      ipAddress: req.ip,
    })
    return reply.send({ discarded: true })
  })

  // ── Publish: the edited file back, as the next version ────────────────────
  app.post('/:id/external-edit/publish', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const contract = await findContract(id, orgId)
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const lock = lockOf(contract.externalEdit)
    if (!lock) {
      return reply.status(409).send({ code: 'NOT_EDITING_IN_GOOGLE_DOCS', detail: 'No Google Docs copy is out for this contract, so there is nothing to publish. It may already have been published or discarded.' })
    }

    let file: Buffer | null = null
    let filename = 'google-docs.docx'
    let declared: string | undefined
    let force = false
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        file = await part.toBuffer()
        filename = part.filename || filename
        declared = part.mimetype
      } else if (part.fieldname === 'force') {
        force = String(part.value) === 'true'
      }
    }
    if (!file) return reply.status(400).send({ detail: 'Attach the Word file you downloaded from Google Docs.' })
    if (file.length > MAX_BYTES) return reply.status(413).send({ detail: 'That file is over 25 MB.' })
    const checked = checkUpload(file, declared, [MIME.DOCX])
    if (!checked.ok) {
      return reply.status(415).send({ code: 'NOT_A_WORD_FILE', detail: 'Publish the Word file: in Google Docs, File → Download → Microsoft Word (.docx).' })
    }

    let extracted: Awaited<ReturnType<typeof extractDocument>>
    let review: Awaited<ReturnType<typeof readDocxReview>>
    try {
      ;[extracted, review] = await Promise.all([extractDocument(file, MIME.DOCX, filename), readDocxReview(file)])
    } catch (err) {
      return reply.status(422).send({ code: 'WORD_FILE_UNREADABLE', detail: err instanceof DocxError ? err.message : 'That Word file could not be read.' })
    }
    if (!extracted.plainText.trim()) {
      return reply.status(422).send({ code: 'EMPTY_DOCUMENT', detail: 'That file has no text in it. Check you downloaded the right document from Google Docs.' })
    }

    const base = await prisma.contractVersion.findFirst({ where: { id: lock.baseVersionId, contractId: id } })
    // DD4 — a version made after the copy was, not merely a newer number:
    // after an undo the newest version is the undone one, older than the copy.
    const latest = await prisma.contractVersion.findFirst({
      where: { contractId: id, createdAt: { gt: new Date(lock.startedAt) } },
      orderBy: { versionNumber: 'desc' },
    })
    if (!force) {
      // The counterparty sent a new version while the copy was out.
      if (latest && latest.id !== lock.baseVersionId) {
        return reply.status(409).send({
          code: 'STALE_BASE',
          detail: `Version ${latest.versionNumber} arrived while this copy was in Google Docs (it was made from Version ${lock.baseVersionNumber}). `
            + `Publishing makes it Version ${latest.versionNumber + 1} and leaves Version ${latest.versionNumber}'s changes out of it.`,
          latestVersionNumber: latest.versionNumber, baseVersionNumber: lock.baseVersionNumber,
        })
      }
      // The wrong file is the likeliest mistake: a different document.
      if (base?.plainText && likeness(wordBag(base.plainText), wordBag(extracted.plainText)) < 0.3) {
        return reply.status(409).send({
          code: 'DIFFERENT_DOCUMENT',
          detail: `That file doesn't look like "${contract.title}" (it shares little of its text). Check it is the copy you edited in Google Docs.`,
        })
      }
    }

    const author = await authorName(userId)
    const s3Key = `${orgId}/contracts/${id}/${Date.now()}-google-docs.docx`
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: s3Key, Body: file, ContentType: MIME.DOCX }))

    const open = review.revisions.insertions + review.revisions.deletions
    const others = Object.keys(review.revisions.byAuthor)
    const note = [
      `Published from Google Docs by ${author}`,
      open ? `${open} suggestion${open === 1 ? '' : 's'} still open (${others.join(', ')}), included as written` : null,
      review.comments.length ? `${review.comments.length} comment${review.comments.length === 1 ? '' : 's'} imported (internal)` : null,
    ].filter(Boolean).join('; ')

    let created: { id: string; versionNumber: number }
    try {
      created = await prisma.$transaction(async tx => {
        // Unlock and publish as one step: two publishes can't both land.
        const freed = await tx.contract.updateMany({
          where: { id, orgId, externalEdit: { not: Prisma.DbNull } },
          data:  { externalEdit: Prisma.DbNull },
        })
        if (freed.count !== 1) throw Object.assign(new Error('already published'), { code: 'ALREADY_PUBLISHED' })
        const last = await tx.contractVersion.findFirst({ where: { contractId: id }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true } })
        const version = await tx.contractVersion.create({
          data: {
            contractId: id,
            versionNumber: (last?.versionNumber ?? 0) + 1,
            htmlContent: extracted.htmlContent,
            plainText:   extracted.plainText,
            s3Key, mimeType: MIME.DOCX, fileSize: file!.length,
            changeNote:  note,
            createdById: userId,
            metadata: {
              source: 'google-docs',
              externalEdit: { startedById: lock.startedById, startedByName: lock.startedByName, startedAt: lock.startedAt, baseVersionNumber: lock.baseVersionNumber },
              review: { revisions: review.revisions, comments: review.comments.length },
              sha256: sha256(file!),
            } as Prisma.InputJsonValue,
          },
          select: { id: true, versionNumber: true },
        })
        await tx.contract.update({
          where: { id },
          data:  {
            currentVersionId: version.id, updatedAt: new Date(), analysisStatus: 'PENDING',
          },
        })
        // Their comments, kept internal: threads and resolutions as they were.
        const ids = new Map<string, string>()
        for (const c of review.comments) {
          const body = `From Google Docs, ${c.author}${c.date ? ` (${c.date.slice(0, 10)})` : ''}: ${c.text}`
            + (c.anchor ? `\n\nOn: “${c.anchor.slice(0, 300)}”` : '')
          const row = await tx.contractComment.create({
            data: {
              orgId, contractId: id, versionId: version.id, authorId: userId, body,
              parentId: c.parentId ? ids.get(c.parentId) ?? null : null,
              ...(c.resolved && { resolved: true, resolvedById: userId, resolvedAt: new Date() }),
            },
            select: { id: true },
          })
          ids.set(c.id, row.id)
        }
        return version
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'ALREADY_PUBLISHED') {
        return reply.status(409).send({ code: 'NOT_EDITING_IN_GOOGLE_DOCS', detail: 'This copy was just published or discarded by someone else.' })
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.status(409).send({ detail: 'Another version was added at the same moment. Publish again.' })
      }
      throw err
    }

    // X42, docs/41 Part 18 — approvals given are asked again as their reset rules say.
    await onApprovalChange({ orgId, contractId: id, versionId: created.id, source: 'edit', userId })
    // The same pipeline as any new file: text, clauses, review.
    queueParseDocument({ contractId: id, versionId: created.id, s3Key, mimeType: MIME.DOCX, orgId, filename })
    await createAuditEvent({
      orgId, userId, action: AuditAction.EXTERNAL_EDIT_PUBLISHED, resourceType: 'contract', resourceId: id,
      metadata: {
        provider: 'google-docs', versionNumber: created.versionNumber, baseVersionNumber: lock.baseVersionNumber,
        startedById: lock.startedById, revisions: review.revisions, comments: review.comments.length,
        sha256: sha256(file), filename, forced: force,
      },
      ipAddress: req.ip,
    })
    return reply.status(201).send({
      version: created,
      imported: { comments: review.comments.length, openSuggestions: open, suggestionAuthors: others },
    })
  })

  // ── Download for counterparty ─────────────────────────────────────────────
  app.get('/:id/redline/counterparty', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const contract = await findContract(id, orgId)
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const lock = lockOf(contract.externalEdit)
    if (lock) {
      return reply.status(409).send({
        ...lockedBody(lock),
        detail: `${lock.startedByName} has this contract open in Google Docs. Publish that copy back first, so the counterparty gets your latest changes.`,
      })
    }
    const version = await standing(contract)
    if (!version) return reply.status(409).send({ code: 'VERSION_NOT_READY', detail: 'The document is still being prepared. Try again in a moment.' })
    const theirs = await theirWordVersion(id)
    if (!theirs) {
      return reply.status(409).send({
        code: 'NO_WORD_ORIGINAL',
        detail: 'There is no Word file of theirs to mark up: this contract came as a PDF, or was drafted here. '
          + 'Use Export › Word (tracked) to send a comparison between two versions instead.',
      })
    }
    if (theirs.id === version.id) {
      return reply.status(409).send({ code: 'NO_CHANGES', detail: `Version ${version.versionNumber} is their file as they sent it: there are no changes of ours to mark up yet.` })
    }

    const author = await authorName(userId)
    let result: { docx: Buffer; stats: RedlineStats }
    try {
      result = await redlineAgainstTheirs(theirs, version.htmlContent, author)
    } catch (err) {
      if (err instanceof DocxError) return reply.status(422).send({ code: 'WORD_FILE_UNREADABLE', detail: err.message })
      throw err
    }
    const { docx, stats } = result
    if (!stats.verified) req.log.warn({ contractId: id, stats }, 'BB2: counterparty redline failed its self-check')

    // Internal provenance: who sent what, against which of their versions.
    await createAuditEvent({
      orgId, userId, action: AuditAction.REDLINE_EXPORTED, resourceType: 'contract', resourceId: id,
      metadata: {
        audience: 'counterparty', author, theirVersionNumber: theirs.versionNumber, versionNumber: version.versionNumber,
        redline: JSON.parse(statsHeader(stats)), sha256: sha256(docx),
      },
      ipAddress: req.ip,
    })
    // docs/41 Part 18 — downloaded for the counterparty: their turn.
    await onSentToCounterparty({ orgId, contractId: id, userId, via: 'redline_download' })
    return sendDocx(reply, docx, fileName(contract.title, `our changes to their v${theirs.versionNumber}`), stats)
  })
}
