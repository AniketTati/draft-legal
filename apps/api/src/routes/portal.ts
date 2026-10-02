/**
 * External Portal — Phase 05 (Negotiation) + B.5.14 refactor.
 * Token-gated (no requireAuth). External reviewers/counterparties access contracts
 * via a signed portal JWT embedded in the URL (/portal/:portalToken on the frontend).
 *
 * Portal comments use authorId = "portal:<shareLinkId>". The portal reads and
 * writes external threads only; internal ones never leave our side (docs/41 Part 16).
 *
 * B.5.14 additions:
 *   - GET  /:portalToken/download/docx  — HTML→DOCX round-trip via Gotenberg
 *   - POST /:portalToken/versions       — counterparty uploads a revised .docx,
 *                                          lands as v(n+1) with author="portal:<linkId>"
 *                                          so our history has the external turn
 *                                          attributed correctly.
 */
import type { FastifyInstance } from 'fastify'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../lib/prisma.js'
import { createAuditEvent } from '../lib/audit.js'
import { generatePlainDocx } from '../lib/docx-export.js'
import { verifyPortalToken } from './share.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { queueParseDocument, queueNotification } from '../lib/queue.js'
import { AuditAction, parseCommentAnchor } from '@clm/types'
import { Prisma } from '@prisma/client'
import { withAnchors } from '../lib/comment-anchors.js'
import { checkUpload, PDF_OR_DOCX } from '../lib/file-type.js'
import { standingVersion } from '../lib/standing-version.js'
import { onApprovalChange } from '../lib/approval-reset.js'
import { onCounterpartyVersion } from '../lib/lifecycle.js'

async function resolvePortalToken(portalToken: string) {
  let payload
  try {
    payload = verifyPortalToken(portalToken)
  } catch {
    return null
  }

  const link = await prisma.contractShareLink.findUnique({
    where: { token: payload.token },
  })

  if (!link) return null
  if (link.revokedAt) return null
  if (link.expiresAt < new Date()) return null

  return { payload, link }
}

/**
 * The version the other side reads and downloads: the one the contract
 * stands on, or, while its text is still being read, the latest one before
 * it whose text has been. A version just uploaded has no text until the
 * parse job finishes; the page said nothing had been uploaded, while the
 * counterparty had just uploaded it. It is reported as pending instead.
 *
 * DD4 — not the newest: after an undo, the newest is the undone version, an
 * internal redline the other side was never sent.
 */
async function portalVersion(contract: { id: string; currentVersionId: string | null }) {
  const current = await standingVersion(contract.id, contract.currentVersionId)
  if (!current) return { shown: null, pendingVersion: null }
  const shown = current.htmlContent?.trim()
    ? current
    : await prisma.contractVersion.findFirst({
        where:   { contractId: contract.id, versionNumber: { lt: current.versionNumber }, htmlContent: { not: '' } },
        orderBy: { versionNumber: 'desc' },
      })
  const pendingVersion = current.htmlContent?.trim() ? null : current.versionNumber
  return { shown, pendingVersion }
}

export async function portalRoutes(app: FastifyInstance) {

  // ── Get contract via portal token ─────────────────────────────────────────
  // Use wildcard because JWT tokens contain dots that confuse Fastify's radix tree with long paths
  app.get('/:portalToken/contract', async (req, reply) => {
    const { portalToken } = req.params as { portalToken: string }

    const resolved = await resolvePortalToken(portalToken)
    if (!resolved) return reply.status(401).send({ error: 'Invalid or expired share link' })

    const { payload, link } = resolved

    const contract = await prisma.contract.findFirst({
      where: { id: payload.contractId, orgId: payload.orgId, deletedAt: null },
      include: {
        counterparty: { select: { name: true, legalName: true } },
        owner: { select: { name: true } },
        org: { select: { name: true, brandColor: true, logoUrl: true } },
      },
    })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })
    const { shown, pendingVersion } = await portalVersion(contract)

    // Update view stats (fire and forget)
    prisma.contractShareLink.update({
      where: { id: link.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    }).catch(() => {})

    createAuditEvent({
      orgId: payload.orgId,
      action: AuditAction.PORTAL_VIEWED,
      resourceType: 'contract',
      resourceId: payload.contractId,
      metadata: { shareLinkId: link.id, ipAddress: req.ip },
    }).catch(() => {})

    return reply.send({
      contract: {
        id: contract.id,
        title: contract.title,
        type: contract.type,
        status: contract.status,
        counterpartyName: contract.counterpartyName ?? contract.counterparty?.name,
        effectiveDate: contract.effectiveDate,
        expiryDate: contract.expiryDate,
        org: contract.org,
      },
      htmlContent:   shown?.htmlContent ?? '',
      versionId:     shown?.id,
      versionNumber: shown?.versionNumber ?? null,
      // A version still being read, or one that couldn't be read.
      pending: pendingVersion == null ? null : {
        versionNumber: pendingVersion,
        failed:        contract.analysisStatus === 'FAILED',
      },
      permissions: payload.permissions,
      shareLink: {
        id: link.id,
        label: link.label,
        expiresAt: link.expiresAt,
        viewCount: link.viewCount + 1,
      },
    })
  })


  // ── External comment threads ──────────────────────────────────────────────
  // Only threads marked external. Authors are shown by name; our user ids stay
  // ours. Anchors are placed in the version the portal shows.
  app.get('/:portalToken/comments', async (req, reply) => {
    const { portalToken } = req.params as { portalToken: string }
    const resolved = await resolvePortalToken(portalToken)
    if (!resolved) return reply.status(401).send({ error: 'Invalid or expired share link' })
    const { payload, link } = resolved

    const contract = await prisma.contract.findFirst({ where: { id: payload.contractId, orgId: payload.orgId, deletedAt: null }, include: { org: { select: { name: true } } } })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })
    const { shown } = await portalVersion(contract)

    const threads = await prisma.contractComment.findMany({
      where: { orgId: payload.orgId, contractId: payload.contractId, parentId: null, deletedAt: null, visibility: 'external' },
      orderBy: { createdAt: 'asc' },
      include: { replies: { where: { orgId: payload.orgId, contractId: payload.contractId, deletedAt: null, visibility: 'external' }, orderBy: { createdAt: 'asc' } } },
    })
    const userIds = [...new Set(threads.flatMap(t => [t, ...t.replies]).map(c => c.authorId).filter(a => !a.startsWith('portal:')))]
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, orgId: payload.orgId }, select: { id: true, name: true } }) : []
    const nameOf = new Map(users.map(u => [u.id, u.name]))
    const view = (c: (typeof threads)[number] | (typeof threads)[number]['replies'][number]) => ({
      id: c.id, body: c.body, createdAt: c.createdAt, resolved: c.resolved, visibility: c.visibility,
      fromThisLink: c.authorId === `portal:${link.id}`,
      fromCounterparty: c.authorId.startsWith('portal:'),
      // A portal comment keeps the name its author typed (see POST).
      authorName: c.authorId.startsWith('portal:') ? (c.authorName ?? 'External reviewer') : nameOf.get(c.authorId) ?? contract.org.name,
    })
    const placed = await withAnchors(payload.orgId, payload.contractId, threads, shown?.id ?? null)
    return reply.send({
      data: placed.map(t => ({ ...view(t), anchor: t.anchor, anchorState: t.anchorState, anchorStart: t.anchorStart, anchorEnd: t.anchorEnd, replies: t.replies.map(view) })),
    })
  })

  // ── Add comment via portal ────────────────────────────────────────────────
  app.post('/:portalToken/comments', async (req, reply) => {
    const { portalToken } = req.params as { portalToken: string }

    const resolved = await resolvePortalToken(portalToken)
    if (!resolved) return reply.status(401).send({ error: 'Invalid or expired share link' })

    const { payload, link } = resolved

    if (!payload.permissions.includes('comment')) {
      return reply.status(403).send({ error: 'This link does not allow comments' })
    }

    const { body, clauseRef, authorName, authorEmail, parentId, anchor: rawAnchor } = req.body as {
      body: string
      clauseRef?: string
      authorName?: string
      authorEmail?: string
      parentId?: string
      anchor?: unknown
    }

    if (!body?.trim()) return reply.status(400).send({ error: 'body is required' })

    // A reply goes only into a thread the counterparty can see.
    if (parentId) {
      const parent = await prisma.contractComment.findFirst({
        where: { id: parentId, orgId: payload.orgId, contractId: payload.contractId, parentId: null, deletedAt: null, visibility: 'external' },
      })
      if (!parent) return reply.status(404).send({ error: 'Comment not found' })
    }
    const anchor = parentId ? null : parseCommentAnchor(rawAnchor)
    if (anchor?.versionId) {
      const v = await prisma.contractVersion.findFirst({ where: { id: anchor.versionId, contractId: payload.contractId }, select: { id: true } })
      if (!v) anchor.versionId = null
    }

    const comment = await prisma.contractComment.create({
      data: {
        orgId: payload.orgId,
        contractId: payload.contractId,
        authorId: `portal:${link.id}`,
        body: body.trim(),
        clauseRef,
        parentId: parentId ?? null,
        // Everything the counterparty writes is, by definition, shared with them.
        visibility: 'external',
        anchor: anchor ? (anchor as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        // The name they typed; resolvedById is for whoever resolves the thread.
        authorName: (authorName ?? authorEmail ?? 'External reviewer').slice(0, 200),
      },
      include: { replies: true },
    })

    return reply.status(201).send(comment)
  })


  // ── B.5.14: Download current version as .docx via Gotenberg ──────────────
  // Counterparties often redline in Word and mail it back. The original
  // Phase 05 portal only offered a read-only HTML view, which forced them
  // into our portal — the exact friction ChatGPT flagged in round 3 as a
  // deal-losing pattern. This endpoint closes the loop: download .docx →
  // redline locally → upload revised version back via POST /:token/versions.
  app.get('/:portalToken/download/docx', async (req, reply) => {
    const { portalToken } = req.params as { portalToken: string }

    const resolved = await resolvePortalToken(portalToken)
    if (!resolved) return reply.status(401).send({ error: 'Invalid or expired share link' })
    const { payload, link } = resolved

    const contract = await prisma.contract.findFirst({
      where: { id: payload.contractId, orgId: payload.orgId, deletedAt: null },
    })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })
    // The same version the page shows, not a newer one still being read.
    const latest = (await portalVersion(contract)).shown
    if (!latest?.htmlContent?.trim()) {
      return reply.status(400).send({ error: 'No content available to export' })
    }

    // Was: POST the HTML to Gotenberg's /forms/libreoffice/convert -- a
    // document-to-PDF route -- then stamp a .docx name and the wordprocessingml
    // MIME type on the PDF that came back. Word refuses to open it, and the
    // audience here is the COUNTERPARTY, whose whole job is to redline it and
    // send it back.
    let docxBuffer: Buffer
    try {
      const bytes = await generatePlainDocx(latest.htmlContent, {
        title:  contract.title || 'Contract',
        author: 'draftLegal',
      })
      docxBuffer = Buffer.from(bytes)
    } catch (err) {
      app.log.error({ err }, 'Portal docx generation failed')
      return reply.status(502).send({ error: 'DOCX generation failed — try again shortly' })
    }

    const safeTitle = (contract.title || 'contract').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60)
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    reply.header('Content-Disposition', `attachment; filename="${safeTitle}-v${latest.versionNumber}.docx"`)

    createAuditEvent({
      orgId:        payload.orgId,
      action:       AuditAction.PORTAL_VIEWED, // reuse — portal-download audit added in a follow-up
      resourceType: 'contract',
      resourceId:   payload.contractId,
      metadata:     { shareLinkId: link.id, action: 'download_docx', ipAddress: req.ip },
    }).catch(() => {})

    return reply.send(docxBuffer)
  })


  // ── B.5.14: Counterparty uploads a revised .docx/.pdf ────────────────────
  // Lands as a new ContractVersion with:
  //   - createdById:  `portal:<shareLinkId>`  (attribution path)
  //   - changeNote:   "Uploaded by counterparty via portal"
  // The revised file itself is stored as a version `filename`/`fileKey`;
  // HTML re-extraction runs asynchronously through the same parse pipeline
  // the in-app upload uses, so the upload returns fast and the version
  // becomes diffable once parsing completes.
  app.post('/:portalToken/versions', async (req, reply) => {
    const { portalToken } = req.params as { portalToken: string }

    const resolved = await resolvePortalToken(portalToken)
    if (!resolved) return reply.status(401).send({ error: 'Invalid or expired share link' })
    const { payload, link } = resolved

    // Per-link permission gate: only share links that explicitly grant
    // 'edit' (or the new 'upload') can upload revisions. 'read' and
    // 'comment' links cannot — that keeps read-only shares truly read-only.
    const allowed = payload.permissions.includes('edit') || payload.permissions.includes('upload')
    if (!allowed) {
      return reply.status(403).send({ error: 'This link does not allow uploads' })
    }

    // Share links are not revoked when a contract executes, and they live up to
    // 30 days — so without this guard a counterparty could upload against an
    // already-signed contract, flipping it back to UNDER_NEGOTIATION and
    // repointing currentVersionId at an unsealed file. The authenticated PATCH
    // path enforces a transition matrix where EXECUTED may only go to ARCHIVED;
    // this path bypassed it entirely. Mirrors the inbound-email guard.
    const target = await prisma.contract.findFirst({
      where:  { id: payload.contractId, deletedAt: null },
      select: { status: true },
    })
    if (!target) return reply.status(404).send({ error: 'Contract not found' })
    if (target.status === 'EXECUTED' || target.status === 'ARCHIVED') {
      return reply.status(409).send({
        error: 'This contract is already finalised — uploads are closed. Contact the sender if changes are still needed.',
      })
    }

    const file = await (req as unknown as { file: () => Promise<{ filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined> }).file()
    if (!file) return reply.status(400).send({ error: 'file is required' })
    const buffer = await file.toBuffer()
    if (buffer.length > 25 * 1024 * 1024) {
      return reply.status(413).send({ error: 'File too large (25MB limit)' })
    }
    // S3 — validate the bytes; the declared mimetype is attacker-controlled.
    const checked = checkUpload(buffer, file.mimetype, PDF_OR_DOCX)
    if (!checked.ok) return reply.status(checked.status).send({ error: checked.detail })
    const mimeType = checked.mimeType

    // Next version number for this contract
    const latest = await prisma.contractVersion.findFirst({
      where:   { contractId: payload.contractId },
      orderBy: { versionNumber: 'desc' },
      select:  { versionNumber: true },
    })
    const nextVersion = (latest?.versionNumber ?? 0) + 1

    // P7.6.2 — actually push the bytes to S3/MinIO. If the upload
    // fails (network / credentials), the row creation is rolled back
    // by NOT creating it (we throw before the prisma.create call).
    // Fire-and-forget would lose data; we'd rather 502.
    const s3Key = `portal-uploads/${link.id}/${Date.now()}-${file.filename}`
    try {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: mimeType,
        Metadata: {
          'uploaded-by': `portal:${link.id}`,
          'contract-id': payload.contractId,
        },
      }))
    } catch (err) {
      req.log.error({ err, s3Key }, '[portal] S3 upload failed')
      return reply.status(502).send({ error: 'Could not store the uploaded file. Please try again.' })
    }

    // htmlContent / plainText start empty and are filled in by the parse
    // worker queued below. Without that job the version stays permanently
    // blank and undiffable — which is exactly what used to happen here.
    const version = await prisma.contractVersion.create({
      data: {
        contractId:    payload.contractId,
        versionNumber: nextVersion,
        s3Key,
        fileSize:      buffer.length,
        mimeType:      mimeType,
        createdById:   `portal:${link.id}`,
        changeNote:    `Uploaded by counterparty via portal (${file.filename})`,
      },
    })

    // Point the contract at the incoming version, and reset analysisStatus so
    // the parse pipeline runs. These two must move together: currentVersionId
    // on a not-yet-parsed version renders as "Preparing document…" only
    // because analysisStatus is PENDING; without it the contract body would
    // read as empty.
    await prisma.contract.update({
      where: { id: payload.contractId },
      data:  {
        currentVersionId: version.id,
        analysisStatus:   'PENDING',
        updatedAt:        new Date(),
      },
    })
    // docs/41 Part 18 — the negotiation is back with us (Negotiate, our
    // turn); a request for approval made before it is withdrawn and its
    // approvers told (§6.5).
    const reset = await onApprovalChange({ orgId: payload.orgId, contractId: payload.contractId, versionId: version.id, source: 'counterparty', via: 'portal' })
    if (!reset.withdrawn) await onCounterpartyVersion({ orgId: payload.orgId, contractId: payload.contractId, versionId: version.id, via: 'portal' })

    // Extract text/HTML from the uploaded file so the owner can actually
    // diff the counterparty's turn against the previous version.
    queueParseDocument({
      contractId: payload.contractId,
      versionId:  version.id,
      s3Key,
      mimeType:   mimeType,
      orgId:      payload.orgId,
      filename:   file.filename,
    })

    // Actually notify the owner. The 201 response below tells the counterparty
    // "the owner has been notified" — until now nothing here made that true,
    // and the only signal was a passive status flip on next page load.
    const ownerRef = await prisma.contract.findUnique({
      where:  { id: payload.contractId },
      select: { title: true, ownerId: true, owner: { select: { email: true } } },
    })
    if (ownerRef) {
      queueNotification({
        orgId:        payload.orgId,
        userId:       ownerRef.ownerId,
        type:         'COUNTERPARTY_VERSION',
        title:        'Counterparty returned a revised version',
        body:         `A revised version (v${nextVersion}) of "${ownerRef.title}" was uploaded via the share link${link.label ? ` — ${link.label}` : ''}.`,
        resourceType: 'contract',
        resourceId:   payload.contractId,
        email:        ownerRef.owner?.email ?? undefined,
      })
    }

    // P7.6.2 — proper PORTAL_UPLOADED_VERSION action so the counterparty's
    // upload shows up distinctly from a generic view in the audit log.
    createAuditEvent({
      orgId:        payload.orgId,
      action:       AuditAction.PORTAL_UPLOADED_VERSION,
      resourceType: 'contract',
      resourceId:   payload.contractId,
      metadata:     {
        shareLinkId: link.id,
        versionNumber: nextVersion,
        filename:    file.filename,
        ipAddress:   req.ip,
        userAgent:   req.headers['user-agent'] ?? null,
      },
    }).catch(() => {})

    return reply.status(201).send({
      id:            version.id,
      versionNumber: nextVersion,
      filename:      file.filename,
      message:       'Revised version uploaded. The owner has been notified.',
    })
  })
}
