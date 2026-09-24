/**
 * Inbound email parser (P7.6.3).
 *
 * SendGrid Inbound Parse / Mailgun / Postmark webhook target. The counterparty
 * replies to a per-contract email address with a redline PDF attached; the
 * webhook lands the PDF as a new ContractVersion attributed to the sender,
 * flips the contract to UNDER_NEGOTIATION, and writes an audit event.
 *
 * Address pattern: `contracts+<contractId>@inbound.<your-domain>`
 *   - The +tag is parsed out of the To: header so deployments only need
 *     one mailbox; routing happens by tag.
 *
 * Sender validation: by default we accept the sender's address only if
 * (a) it matches a previously-issued portal share-link's external email,
 * (b) it matches the contract's counterparty.email, OR
 * (c) INBOUND_EMAIL_ALLOW_ALL=1 in env. Otherwise → 403.
 * (c) is a dev convenience and is IGNORED in production (it would otherwise
 * let any holder of the shared secret post into any contract in any org).
 *
 * Auth: shared-secret header `x-inbound-secret` must match
 * INBOUND_EMAIL_SECRET. SendGrid lets you configure this via Inbound
 * Parse → "Username/Password" or via custom headers.
 *
 * Body shape — both SendGrid's flat multipart/form-data (fields + attachment1..N
 * as files) and a JSON envelope (for testability + alt providers) are accepted;
 * multipart is normalised into the envelope below before validation:
 *   {
 *     to:           "contracts+abc123@inbound.example.com",
 *     from:         "counsel@counterparty.com",
 *     subject:      "Re: MSA — redline v3",
 *     text:         "(plain-text body)",
 *     attachments:  [{ filename: "redline.pdf", contentType: "application/pdf",
 *                       contentBase64: "JVBERi0xLjQK..." }]
 *   }
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { createAuditEvent } from '../lib/audit.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { queueParseDocument, queueNotification } from '../lib/queue.js'
import { bareAddress, extractContractTag } from '../lib/email-address.js'
import { AuditAction } from '@clm/types'
import { checkUpload, PDF_OR_DOCX } from '../lib/file-type.js'
import { devFlag, isStrict } from '../lib/runtime-mode.js'

const InboundEmailSchema = z.object({
  to: z.string().min(1),
  from: z.string().email(),
  subject: z.string().optional().default(''),
  text: z.string().optional().default(''),
  attachments: z.array(z.object({
    filename: z.string(),
    contentType: z.string(),
    contentBase64: z.string(),
    // X66 — a file part over the size limit arrives without its content.
    oversized: z.boolean().optional(),
  })).default([]),
})

// Address parsing lives in lib/email-address.ts with regression tests — both
// functions gate who may write to a contract, and both have a plausible-looking
// wrong implementation (see the spoofing cases in email-address.test.ts).

/**
 * Normalise the request body into the JSON envelope the schema expects.
 *
 * SendGrid Inbound Parse (and Mailgun's store/forward) POST multipart/form-data
 * with flat text fields plus attachment1..N as files — NOT the JSON envelope.
 * The module header claimed both were accepted, but the handler only ever ran
 * the zod parse against req.body, which is undefined for a multipart POST
 * (multipart is registered without attachFieldsToBody). A real provider webhook
 * therefore always failed here.
 */
// Bound what a single webhook call may buffer. Every file part is read fully
// into memory and then base64-encoded (1.33x), and busboy's `files`/`parts`
// limits default to Infinity, so without these an attacker holding the shared
// secret could OOM the process with many large parts. Only the first usable
// attachment is ever consumed downstream, so a small cap costs nothing.
const MAX_ATTACHMENTS   = 5
const MAX_TOTAL_BYTES   = 30 * 1024 * 1024
// X14 — the number of file parts READ. Inline images usually come before the
// document, so a low cap here rejected ordinary emails outright; only the
// document candidates below are buffered.
const MAX_FILE_PARTS    = 50
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

async function readInboundBody(req: FastifyRequest): Promise<unknown> {
  const isMultipart = typeof (req as { isMultipart?: () => boolean }).isMultipart === 'function'
    && (req as unknown as { isMultipart: () => boolean }).isMultipart()
  if (!isMultipart) return req.body

  const fields: Record<string, string> = {}
  const attachments: Array<{ filename: string; contentType: string; contentBase64: string; oversized?: boolean }> = []
  let totalBytes = 0

  const parts = (req as unknown as {
    parts: (o?: unknown) => AsyncIterable<MultipartPart>
  }).parts({ limits: { files: MAX_FILE_PARTS, fields: 40, fileSize: MAX_ATTACHMENT_BYTES }, throwFileSizeLimit: false })

  for await (const part of parts) {
    if (part.type === 'file') {
      // X14 — keep only parts that ARE a PDF/DOCX (by content, as chosen
      // below), so inline images can't use up the slots. Anything else is
      // listed by name for the "no usable attachment" reply.
      const listOnly = { filename: part.filename, contentType: part.mimetype, contentBase64: '' }
      if (attachments.filter(a => a.contentBase64).length >= MAX_ATTACHMENTS) {
        for await (const chunk of part.file) void chunk   // drain, unbuffered
        attachments.push(listOnly)
        continue
      }
      const buf = await part.toBuffer()
      // Over the per-file limit: skip it and let the next candidate be tried,
      // saying it was too large (X66: it reached the check below empty, so an
      // email whose only document was too large got "no PDF or DOCX").
      if (part.file.truncated) {
        attachments.push({ ...listOnly, oversized: true })
        continue
      }
      if (!checkUpload(buf, part.mimetype, PDF_OR_DOCX).ok) {
        attachments.push(listOnly)
        continue
      }
      totalBytes += buf.length
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error('Inbound email payload exceeds the size limit')
      }
      attachments.push({
        filename:      part.filename,
        contentType:   part.mimetype,
        contentBase64: buf.toString('base64'),
      })
    } else {
      fields[part.fieldname] = String(part.value ?? '')
    }
  }

  // Prefer the SMTP envelope over the headers where the provider supplies it
  // (SendGrid sends `envelope` as JSON: {"to":[...],"from":"..."}). The envelope
  // is the actual MAIL FROM / RCPT TO — it is what SPF authenticates, whereas
  // From:/To: are free text the sender chooses.
  let envFrom = ''
  let envTo   = ''
  if (fields.envelope) {
    try {
      const env = JSON.parse(fields.envelope) as { from?: string; to?: string[] | string }
      if (typeof env.from === 'string') envFrom = env.from
      const to = Array.isArray(env.to) ? env.to[0] : env.to
      if (typeof to === 'string') envTo = to
    } catch {
      // Malformed envelope — fall back to the headers below.
    }
  }

  return {
    to:      envTo   || fields.to   || '',
    from:    envFrom || fields.from || '',
    subject: fields.subject ?? '',
    text:    fields.text ?? '',
    attachments,
  }
}

type MultipartPart =
  | { type: 'file';  fieldname: string; filename: string; mimetype: string; toBuffer: () => Promise<Buffer>; file: AsyncIterable<Buffer> & { truncated?: boolean }; value?: undefined }
  | { type: 'field'; fieldname: string; value: unknown; filename?: undefined; mimetype?: undefined; toBuffer?: undefined }

// Attachments are chosen by content via checkUpload(…, PDF_OR_DOCX). Legacy
// .doc is deliberately absent: the extraction pipeline (lib/document.ts) has no
// OLE reader, so such an attachment would be stored and then fail parsing.
// Better to skip it and report no usable attachment than to land a version
// that can never be read or diffed.

export async function inboundEmailRoutes(app: FastifyInstance) {

  // ── Auth: shared-secret header (mailgun / sendgrid both let you set
  // arbitrary headers on the inbound webhook).
  // Scoped to this plugin's routes by registration (X35: a req.url prefix
  // test here was skipped by `/api/v1/%69nbound/email`, which still routed).
  app.addHook('preHandler', async (req, reply) => {
    const expected = process.env.INBOUND_EMAIL_SECRET
    if (!expected) {
      // X35 — not configured is closed in every environment. Skipping the
      // check outside production opened staging and previews to anyone who
      // could forge a counterparty's From.
      return reply.status(503).send({ error: 'Inbound email handler not configured' })
    }
    const got = req.headers['x-inbound-secret']
    if (got !== expected) {
      return reply.status(401).send({ error: 'Invalid inbound secret' })
    }
  })

  app.post('/email', async (req, reply) => {
    const raw = await readInboundBody(req)
    // Providers send display-name addresses (`Jane Doe <jane@x.com>`); normalise
    // before validation, which requires a bare mailbox.
    const normalised = (raw && typeof raw === 'object')
      ? {
          ...(raw as Record<string, unknown>),
          to:   bareAddress(String((raw as Record<string, unknown>).to ?? '')),
          from: bareAddress(String((raw as Record<string, unknown>).from ?? '')),
        }
      : raw
    const body = InboundEmailSchema.parse(normalised)

    const contractId = extractContractTag(body.to)
    if (!contractId) {
      return reply.status(400).send({ error: 'Could not extract contract id from To: address. Expected format: contracts+<id>@…' })
    }
    // Soft-delete is filtered in the query rather than after the fetch, matching
    // how every other contract lookup in the codebase is written. Note there is
    // deliberately no org filter here: this is an unauthenticated webhook with
    // no requesting org, and orgId is derived from the resolved contract. Real
    // per-org isolation would need per-org inbound addresses or secrets — see
    // the sender-validation note below for what actually gates access today.
    const contract = await prisma.contract.findFirst({
      where: { id: contractId, deletedAt: null },
      include: {
        counterparty: { select: { id: true, email: true, name: true } },
        // Needed to notify the owner that a revision arrived (and to give the
        // notification worker an address for the optional email leg).
        owner:        { select: { email: true } },
      },
    })
    if (!contract) {
      return reply.status(404).send({ error: 'Contract not found' })
    }
    if (contract.status === 'EXECUTED') {
      return reply.status(409).send({ error: 'Contract already executed — emails ignored' })
    }

    // Sender allow-list: see if the sender was previously emailed via a
    // share link or matches the registered counterparty.
    const senderEmail = body.from.toLowerCase()

    // INBOUND_EMAIL_ALLOW_ALL switches off sender validation entirely, which
    // would let anyone holding the shared secret inject a document into ANY
    // contract in ANY org — the one genuine cross-tenant path on this route.
    // Y5 — a development-only relaxation: it never applies in a strict
    // environment, where it stops the boot instead (lib/runtime-mode.ts).
    const allowAll = devFlag('INBOUND_EMAIL_ALLOW_ALL')

    let allowed = allowAll
    let senderReason = allowAll ? 'allow_all_dev' : 'unknown'

    if (!allowed && contract.counterparty?.email && contract.counterparty.email.toLowerCase() === senderEmail) {
      allowed = true
      senderReason = 'counterparty_email_match'
    }
    if (!allowed) {
      // Accept if a still-valid portal share link was emailed to this address.
      // Share links now record invitedEmail, so a counterparty invited by link
      // (rather than registered as the contract's counterparty) can email a
      // redline back. Revoked/expired links do not count.
      const invited = await prisma.contractShareLink.findFirst({
        where: {
          contractId,
          invitedEmail: senderEmail,
          revokedAt:    null,
          expiresAt:    { gt: new Date() },
          // The link must actually permit returning a document. Without this a
          // read-only share becomes an upload channel by another route: the
          // portal correctly refuses their upload, so they email it instead.
          permissions:  { hasSome: ['upload', 'edit'] },
        },
        select: { id: true },
      })
      if (invited) {
        allowed = true
        senderReason = 'share_link_invite_match'
      }
    }
    if (!allowed) {
      return reply.status(403).send({
        // Don't advertise the dev-only bypass outside development and tests.
        error: isStrict()
          ? `Sender ${senderEmail} is not authorised on this contract.`
          : `Sender ${senderEmail} is not authorised on this contract. Add them as the counterparty or set INBOUND_EMAIL_ALLOW_ALL=1 (dev only).`,
        sender_reason: senderReason,
      })
    }

    // Pick the first attachment whose BYTES are a PDF/DOCX — the declared
    // content type is sender-controlled (S3). The detected type is what we store.
    let pdfOrDocx: (typeof body.attachments)[number] | undefined
    let mimeType = ''
    let tooLarge = false
    for (const a of body.attachments) {
      const bytes = Buffer.from(a.contentBase64, 'base64')
      // X14 — an oversized document is skipped, so the next one gets its turn.
      if (a.oversized || bytes.length > MAX_ATTACHMENT_BYTES) { tooLarge = true; continue }
      const checked = checkUpload(bytes, a.contentType, PDF_OR_DOCX)
      if (checked.ok) { pdfOrDocx = a; mimeType = checked.mimeType; break }
    }
    if (!pdfOrDocx) {
      if (tooLarge) return reply.status(413).send({ error: 'Attachment too large (25MB limit)' })
      return reply.status(400).send({
        error: 'No PDF or DOCX attachment found. We only attach PDF/DOCX as new versions.',
        attachments: body.attachments.map(a => ({ filename: a.filename, contentType: a.contentType })),
      })
    }

    const buffer = Buffer.from(pdfOrDocx.contentBase64, 'base64')
    if (buffer.length === 0) {
      return reply.status(400).send({ error: 'Empty attachment' })
    }

    const s3Key = `inbound-email/${contractId}/${Date.now()}-${pdfOrDocx.filename}`
    try {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: mimeType,
        Metadata: {
          'sender': senderEmail,
          'contract-id': contractId,
        },
      }))
    } catch (err) {
      req.log.error({ err, s3Key }, '[inbound-email] S3 upload failed')
      return reply.status(502).send({ error: 'Could not store the attachment.' })
    }

    const latest = await prisma.contractVersion.findFirst({
      where: { contractId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    })
    const nextVersion = (latest?.versionNumber ?? 0) + 1

    const version = await prisma.contractVersion.create({
      data: {
        contractId,
        versionNumber: nextVersion,
        s3Key,
        fileSize: buffer.length,
        mimeType: mimeType,
        // email:<sender> attribution — same shape as portal:<linkId>.
        // The reader (e.g. NegotiationStatusStrip) treats both as
        // "from counterparty" by checking the prefix.
        createdById: `email:${senderEmail}`,
        changeNote: `Emailed by ${senderEmail}: ${body.subject || '(no subject)'}`,
        metadata: {
          inboundEmail: {
            from: senderEmail,
            to: body.to,
            subject: body.subject,
            textExcerpt: body.text.slice(0, 500),
          },
        },
      },
    })

    // Flip to UNDER_NEGOTIATION, point the contract at the incoming version,
    // and reset analysisStatus so the parse pipeline extracts the attachment.
    // currentVersionId and analysisStatus must move together — PENDING is what
    // makes a not-yet-parsed version render as "Preparing document…".
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        status:           'UNDER_NEGOTIATION',
        currentVersionId: version.id,
        analysisStatus:   'PENDING',
        updatedAt:        new Date(),
      },
    })

    // Without this the emailed redline stays blank text forever and cannot
    // be diffed against the previous version.
    queueParseDocument({
      contractId,
      versionId:  version.id,
      s3Key,
      mimeType:   mimeType,
      orgId:      contract.orgId,
      filename:   pdfOrDocx.filename,
    })

    // Actually notify the owner — the response below claims this happened.
    queueNotification({
      orgId:        contract.orgId,
      userId:       contract.ownerId,
      type:         'COUNTERPARTY_VERSION',
      title:        'Counterparty emailed a revised version',
      body:         `${senderEmail} emailed a revised version (v${nextVersion}) of "${contract.title}".`,
      resourceType: 'contract',
      resourceId:   contractId,
      email:        contract.owner?.email ?? undefined,
    })

    createAuditEvent({
      orgId: contract.orgId,
      action: AuditAction.EMAIL_REDLINE_RECEIVED,
      resourceType: 'contract',
      resourceId: contractId,
      metadata: {
        sender: senderEmail,
        subject: body.subject,
        filename: pdfOrDocx.filename,
        versionNumber: nextVersion,
        senderReason,
      },
      ipAddress: req.ip,
    }).catch((err) => {
      req.log.warn({ err }, '[inbound-email] audit write failed')
    })

    return reply.status(201).send({
      ok: true,
      versionId: version.id,
      versionNumber: nextVersion,
      filename: pdfOrDocx.filename,
      message: `Recorded as v${nextVersion} on ${contract.title}. Owner has been notified.`,
    })
  })
}
