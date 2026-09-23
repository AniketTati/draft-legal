/**
 * Signature routes (P7.6.1).
 *
 * Endpoints:
 *   POST /api/v1/contracts/:id/send-for-signature
 *     Body: { signers: [{name, email, role?, signOrder?}], message?,
 *             signOrder: 'ANY'|'SEQUENTIAL', expiresInDays? }
 *     Creates a SignatureRequest + Signer rows + per-signer tokens.
 *     Sets contract.status = PENDING_SIGNATURE.
 *
 *   GET /api/v1/sign/:token
 *     Public — no auth. Returns the contract + signature request envelope
 *     for the signer at this token. Records a VIEWED event.
 *
 *   POST /api/v1/sign/:token/sign
 *     Public. Body: { signedName }. Records the signature, emits a
 *     SIGNED event, advances the request. When all signers are done,
 *     marks the contract EXECUTED + emits COMPLETED.
 *
 *   POST /api/v1/sign/:token/decline
 *     Public. Body: { reason? }. Marks signer as DECLINED + voids
 *     the request.
 *
 *   GET /api/v1/contracts/:id/signature-requests
 *     Auth. Returns all SignatureRequests for a contract (admin view).
 *
 * No PDF signing yet (X.509 + pdf-lib lands in V1.5). For now the
 * digital trail is: typed name + IP + UA + timestamp, anchored in the
 * audit log + persisted on the Signer row.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { sendSigningEmailForSigner } from '../lib/signing-email.js'
import { queueSigningReminder, queueSealSignedPdf } from '../lib/queue.js'
import { extractObligationsForContract, CostCapExceededError } from '../lib/obligation-extract.js'
import { fireWebhook } from '../lib/webhook-events.js'
import { guardOwnScopeContractRoutes, ownsContract } from '../lib/own-scope-guard.js'

const SignersSchema = z.object({
  signers: z.array(z.object({
    name: z.string().min(1),
    email: z.string().email(),
    role: z.string().optional(),
    signOrder: z.number().int().min(1).optional(),
    userId: z.string().optional(),
  })).min(1).max(20),
  message: z.string().max(2000).optional(),
  signOrder: z.enum(['ANY', 'SEQUENTIAL']).default('ANY'),
  expiresInDays: z.number().int().min(1).max(180).default(14),
})

const SignBodySchema = z.object({
  signedName: z.string().min(1).max(200),
  // Wave 2.7 — explicit ESIGN/UETA consent to conduct business electronically.
  // Optional for backward-compat with older clients, but recorded in the
  // signature event so the audit trail shows affirmative consent when present.
  consent: z.boolean().optional(),
})

const DeclineBodySchema = z.object({
  reason: z.string().max(500).optional(),
})

function newToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

export async function signatureRoutes(app: FastifyInstance) {
  // X7 — own-scope callers may only reach their own contracts by id.
  guardOwnScopeContractRoutes(app, /\/contracts\/:id(\/|$)/)

  // ── POST /contracts/:id/send-for-signature ────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/contracts/:id/send-for-signature',
    { preHandler: requirePermission('sign', 'contract') },
    async (req, reply) => {
      const { id } = req.params
      const { orgId, sub: userId } = req.user
      const body = SignersSchema.parse(req.body)

      const contract = await prisma.contract.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true, currentVersionId: true, status: true, title: true, type: true },
      })
      if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
      if (!contract.currentVersionId) {
        return reply.status(400).send({ detail: 'Contract has no version to sign' })
      }
      if (contract.status === 'EXECUTED') {
        return reply.status(409).send({ detail: 'Contract already executed' })
      }

      const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000)

      // Wrap creation so a partial signers insert doesn't leave a half-built request.
      const created = await prisma.$transaction(async (tx) => {
        const sr = await tx.signatureRequest.create({
          data: {
            orgId,
            contractId: id,
            versionId: contract.currentVersionId!,
            status: 'PENDING',
            signOrder: body.signOrder,
            expiresAt,
            message: body.message,
            createdById: userId,
          },
        })
        for (const s of body.signers) {
          await tx.signer.create({
            data: {
              signatureRequestId: sr.id,
              email: s.email,
              name: s.name,
              role: s.role,
              signOrder: s.signOrder ?? 1,
              userId: s.userId,
              token: newToken(),
              status: 'PENDING',
            },
          })
        }
        await tx.signatureEvent.create({
          data: {
            signatureRequestId: sr.id,
            kind: 'SENT',
            metadata: { signerCount: body.signers.length },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          },
        })
        // Move the contract into PENDING_SIGNATURE so the dashboard reflects it.
        await tx.contract.update({
          where: { id },
          data: { status: 'PENDING_SIGNATURE' },
        })
        return sr
      })

      const fresh = await prisma.signatureRequest.findUnique({
        where: { id: created.id },
        include: { signers: true },
      })

      // Send the signing link email to each signer. For SEQUENTIAL flows
      // we only email the first-bucket signer initially — later buckets get
      // notified as their predecessors finish, in the /sign/:token/sign
      // completion handler (Wave 3.7).
      if (fresh) {
        const orgRow = await prisma.organization.findUnique({
          where: { id: orgId }, select: { name: true },
        })
        const sender = await prisma.user.findUnique({
          where: { id: userId }, select: { name: true },
        })
        const baseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:5173'
        const minSignOrder = body.signOrder === 'SEQUENTIAL'
          ? Math.min(...fresh.signers.map(s => s.signOrder))
          : Infinity   // ANY → email everyone
        for (const s of fresh.signers) {
          const shouldEmail = body.signOrder === 'ANY' || s.signOrder === minSignOrder
          if (!shouldEmail) continue
          sendSigningEmailForSigner({
            signer: s,
            baseUrl,
            senderName: sender?.name ?? null,
            orgName: orgRow?.name ?? 'draftLegal',
            contractTitle: contract.title,
            contractType: contract.type,
            message: fresh.message,
            expiresAt: fresh.expiresAt,
          })
        }
      }

      // P10A — fire webhook for signature.sent
      fireWebhook(orgId, 'signature.sent', {
        contractId: id,
        signatureRequestId: created.id,
        signerCount: body.signers.length,
        signOrder: body.signOrder,
        expiresAt: created.expiresAt?.toISOString() ?? null,
      })

      await createAuditEvent({
        orgId, userId,
        action: AuditAction.SIGNATURE_SENT,
        resourceType: 'contract',
        resourceId: id,
        metadata: {
          signatureRequestId: created.id,
          signerCount: body.signers.length,
          signers: body.signers.map(s => ({ name: s.name, email: s.email, role: s.role })),
          signOrder: body.signOrder,
        },
        ipAddress: req.ip,
      })

      // Phase 07 Step 8 — schedule reminder nudges. We fire two:
      //   T-3d before expiry → "first" reminder
      //   T-1d before expiry → "final" reminder
      // The worker rechecks status at fire time, so a request that's
      // already COMPLETED/VOIDED before the reminder fires is a no-op.
      // Both jobs use deterministic ids — re-sending the same request
      // (e.g. user clicks "Resend for signature") would replace them.
      if (created.expiresAt) {
        const now = Date.now()
        const exp = created.expiresAt.getTime()
        const firstDelay = exp - now - 3 * 24 * 60 * 60 * 1000   // T-3d
        const finalDelay = exp - now - 1 * 24 * 60 * 60 * 1000   // T-1d
        if (firstDelay > 60_000) {  // skip if already in the past
          queueSigningReminder({ signatureRequestId: created.id, kind: 'first' }, firstDelay)
            .catch(err => app.log.warn({ err }, 'failed to enqueue first signing reminder'))
        }
        if (finalDelay > 60_000) {
          queueSigningReminder({ signatureRequestId: created.id, kind: 'final' }, finalDelay)
            .catch(err => app.log.warn({ err }, 'failed to enqueue final signing reminder'))
        }
      }

      return reply.status(201).send(fresh)
    },
  )

  // ── GET /signature-requests (org-wide) ─────────────────────────────────
  // Powers the /signatures admin page: list every signature request in the
  // org, with the contract title + signer summary needed to render the table.
  // Filterable by status. Authenticated users see their own org only.
  app.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    '/signature-requests',
    // X7 — was requireAuth only: any member saw every request in the org with
    // its contract's title and counterparty.
    { preHandler: requirePermission('view', 'contract') },
    async (req, reply) => {
      const { orgId } = req.user
      const limit = Math.min(100, parseInt(req.query.limit ?? '50', 10) || 50)
      const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10) || 0)
      const where: Record<string, unknown> = { orgId }
      const own = req.permissionScope === 'own'
      const [owned, me] = await Promise.all([
        own ? prisma.contract.findMany({ where: { orgId, ownerId: req.user.sub, deletedAt: null }, select: { id: true } }) : [],
        prisma.user.findUnique({ where: { id: req.user.sub }, select: { email: true } }),
      ])
      if (own) {
        // Own contracts, plus requests where the caller is a signer (the
        // sidebar's "awaiting me" badge reads this list).
        // Signer emails are stored as typed, so match the linked user id, or
        // the address ignoring case.
        where.OR = [
          { contractId: { in: owned.map(c => c.id) } },
          { signers: { some: { OR: [
            { userId: req.user.sub },
            ...(me?.email ? [{ email: { equals: me.email, mode: 'insensitive' } }] : []),
          ] } } },
        ]
      }
      if (req.query.status && ['PENDING', 'COMPLETED', 'VOIDED', 'EXPIRED'].includes(req.query.status)) {
        where.status = req.query.status
      }
      const [items, total] = await Promise.all([
        prisma.signatureRequest.findMany({
          where: where as never,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          include: {
            signers: { select: { id: true, name: true, email: true, role: true, status: true, signedAt: true, signOrder: true, userId: true, token: true } },
          },
        }),
        prisma.signatureRequest.count({ where: where as never }),
      ])
      // X21 — an own-scope signer can't open a contract they don't own, so the
      // page's "Open" link 404'd for them. Say which rows the caller can open,
      // and give a pending signer the way to their own signing page.
      const ownedIds = new Set(owned.map(c => c.id))
      const myEmail = me?.email?.toLowerCase()
      const isMe = (s: { userId: string | null; email: string }) =>
        s.userId === req.user.sub || (!!myEmail && s.email.toLowerCase() === myEmail)
      // Hydrate contract title + type via a single batch query.
      const contractIds = [...new Set(items.map(i => i.contractId))]
      const contracts = contractIds.length === 0 ? [] : await prisma.contract.findMany({
        where: { id: { in: contractIds }, orgId },
        select: { id: true, title: true, type: true, counterpartyName: true },
      })
      const contractById = new Map(contracts.map(c => [c.id, c]))
      const data = items.map(it => ({
        id: it.id,
        status: it.status,
        signOrder: it.signOrder,
        createdAt: it.createdAt,
        completedAt: it.completedAt,
        voidedAt: it.voidedAt,
        expiresAt: it.expiresAt,
        signedCount: it.signers.filter(s => s.status === 'SIGNED').length,
        totalSigners: it.signers.length,
        // Tokens stay out of the list (X18); only the caller's own, as a path.
        signers: it.signers.map(({ token: _token, userId: _userId, ...s }) => s),
        contract: contractById.get(it.contractId) ?? null,
        canOpenContract: !own || ownedIds.has(it.contractId),
        mySignPath: (() => {
          const mine = it.status === 'PENDING' ? it.signers.find(s => s.status === 'PENDING' && isMe(s)) : undefined
          return mine ? `/sign/${mine.token}` : null
        })(),
      }))
      return reply.send({ data, total, limit, offset })
    },
  )

  // ── GET /contracts/:id/signature-requests ─────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/contracts/:id/signature-requests',
    // X7 — was requireAuth only (no permission check at all). With view:contract
    // the own-scope guard applies too.
    { preHandler: requirePermission('view', 'contract') },
    async (req, reply) => {
      const { id } = req.params
      const { orgId } = req.user
      const requests = await prisma.signatureRequest.findMany({
        where: { contractId: id, orgId },
        orderBy: { createdAt: 'desc' },
        include: { signers: true, events: { orderBy: { createdAt: 'desc' }, take: 20 } },
      })
      // X18 — a signer's token is the whole credential for /sign/:token, so
      // anyone who could view the contract could sign as the counterparty.
      // Only a caller who may send for signature (and so re-share the link)
      // gets it.
      const signScope = await permissionScopeFor(req, 'sign', 'contract')
      const mayShareLinks = !!signScope && (signScope !== 'own' || await ownsContract(req, id))
      if (mayShareLinks) return reply.send({ data: requests })
      // An internal signer still gets their OWN link — it's their credential.
      const me = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { email: true } })
      const isMe = (s: { userId: string | null; email: string }) =>
        s.userId === req.user.sub || (!!me?.email && s.email.toLowerCase() === me.email.toLowerCase())
      return reply.send({
        data: requests.map(r => ({
          ...r,
          signers: r.signers.map(({ token, ...signer }) => (isMe(signer) ? { ...signer, token } : signer)),
        })),
      })
    },
  )

  // ── GET /sign/:token (public) ─────────────────────────────────────────
  app.get<{ Params: { token: string } }>(
    '/sign/:token',
    async (req: FastifyRequest, reply) => {
      const { token } = req.params as { token: string }
      const signer = await prisma.signer.findUnique({
        where: { token },
        include: {
          signatureRequest: {
            include: {
              signers: { select: { id: true, name: true, role: true, status: true, signOrder: true } },
            },
          },
        },
      })
      if (!signer) return reply.status(404).send({ detail: 'Invalid signing link' })
      const sr = signer.signatureRequest
      if (sr.status !== 'PENDING') return reply.status(410).send({ detail: 'This signing request is no longer active' })
      if (sr.expiresAt && sr.expiresAt < new Date()) {
        // Lazy-expire the request the first time someone hits a stale link.
        await prisma.signatureRequest.update({
          where: { id: sr.id },
          data: { status: 'EXPIRED' },
        })
        return reply.status(410).send({ detail: 'This signing link has expired' })
      }

      // Record a VIEWED event the first time this signer opens the link.
      const alreadyViewed = await prisma.signatureEvent.findFirst({
        where: { signatureRequestId: sr.id, signerId: signer.id, kind: 'VIEWED' },
      })
      if (!alreadyViewed) {
        await prisma.signatureEvent.create({
          data: {
            signatureRequestId: sr.id,
            signerId: signer.id,
            kind: 'VIEWED',
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          },
        })
      }

      // Pull the contract + version htmlContent
      const version = await prisma.contractVersion.findUnique({
        where: { id: sr.versionId },
        select: { id: true, versionNumber: true, htmlContent: true },
      })
      const contract = await prisma.contract.findUnique({
        where: { id: sr.contractId },
        select: {
          id: true, title: true, type: true, status: true, counterpartyName: true,
          org: { select: { name: true, brandColor: true, logoUrl: true } },
        },
      })

      return reply.send({
        signer: {
          id: signer.id,
          name: signer.name,
          email: signer.email,
          role: signer.role,
          status: signer.status,
          signedAt: signer.signedAt,
        },
        signatureRequest: {
          id: sr.id,
          status: sr.status,
          message: sr.message,
          expiresAt: sr.expiresAt,
          signOrder: sr.signOrder,
          totalSigners: sr.signers.length,
          signedCount: sr.signers.filter(s => s.status === 'SIGNED').length,
        },
        contract,
        version,
      })
    },
  )

  // ── POST /sign/:token/sign (public) ───────────────────────────────────
  app.post<{ Params: { token: string } }>(
    '/sign/:token/sign',
    async (req, reply) => {
      const body = SignBodySchema.parse(req.body)
      const { token } = req.params

      const signer = await prisma.signer.findUnique({
        where: { token },
        include: { signatureRequest: { include: { signers: true } } },
      })
      if (!signer) return reply.status(404).send({ detail: 'Invalid signing link' })
      const sr = signer.signatureRequest
      if (sr.status !== 'PENDING') return reply.status(410).send({ detail: 'Signing request is no longer active' })
      if (signer.status === 'SIGNED')  return reply.status(409).send({ detail: 'Already signed' })
      if (signer.status === 'DECLINED') return reply.status(409).send({ detail: 'Already declined' })

      // Sequential gating: a signer can only sign if every earlier
      // signOrder bucket has finished.
      if (sr.signOrder === 'SEQUENTIAL') {
        const earlier = sr.signers.filter(s => s.signOrder < signer.signOrder)
        const allEarlierSigned = earlier.every(s => s.status === 'SIGNED')
        if (!allEarlierSigned) {
          return reply.status(403).send({
            detail: 'Earlier signers have not yet signed. You will be notified when it is your turn.',
          })
        }
      }

      const now = new Date()
      const updated = await prisma.signer.update({
        where: { id: signer.id },
        data: {
          status: 'SIGNED',
          signedAt: now,
          signedName: body.signedName,
          signedIp: req.ip,
          signedUserAgent: req.headers['user-agent'] ?? null,
        },
      })
      await prisma.signatureEvent.create({
        data: {
          signatureRequestId: sr.id,
          signerId: signer.id,
          kind: 'SIGNED',
          metadata: {
            signedName: body.signedName,
            // ESIGN/UETA affirmative consent (Wave 2.7).
            consentGiven: body.consent === true,
            consentText: 'Signer agreed to conduct business and sign electronically.',
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        },
      })

      // Check if everyone has signed → flip request COMPLETED + contract EXECUTED.
      const fresh = await prisma.signatureRequest.findUnique({
        where: { id: sr.id },
        include: { signers: true },
      })
      const allSigned = fresh!.signers.every(s => s.status === 'SIGNED')
      if (allSigned) {
        const completedAt = new Date()
        await prisma.$transaction([
          prisma.signatureRequest.update({
            where: { id: sr.id },
            data: { status: 'COMPLETED', completedAt },
          }),
          prisma.contract.update({
            where: { id: sr.contractId },
            data: { status: 'EXECUTED' },
          }),
          prisma.signatureEvent.create({
            data: {
              signatureRequestId: sr.id,
              kind: 'COMPLETED',
              metadata: { signerCount: fresh!.signers.length },
            },
          }),
        ])
        await createAuditEvent({
          orgId: sr.orgId,
          userId: sr.createdById,
          action: AuditAction.SIGNATURE_COMPLETED,
          resourceType: 'contract',
          resourceId: sr.contractId,
          metadata: { signatureRequestId: sr.id, signerCount: fresh!.signers.length },
        })

        // P10A — fire signature.completed + contract.executed webhooks
        fireWebhook(sr.orgId, 'signature.completed', {
          contractId: sr.contractId,
          signatureRequestId: sr.id,
          signerCount: fresh!.signers.length,
          completedAt: completedAt.toISOString(),
        })
        fireWebhook(sr.orgId, 'contract.executed', {
          contractId: sr.contractId,
          executedAt: completedAt.toISOString(),
        })

        // ── PDF binding (Step 6) ───────────────────────────────────
        // Queue the seal rather than doing it inline. The signed PDF is a
        // legally significant artefact, so it must survive a transient S3 /
        // Gotenberg / signing-cert failure: this used to be a fire-and-forget
        // IIFE with swallowed errors, which could leave the contract EXECUTED
        // with no sealed document and no way to recover. The worker re-reads
        // state and is idempotent, so retries are safe.
        queueSealSignedPdf({ signatureRequestId: sr.id })

        // ── P8 Step 2: auto-extract obligations on signature completion ──
        // Fire-and-forget — the signed contract becomes the system of
        // record for what was promised, and we want a structured list of
        // those promises ready for the obligations rail / list view as
        // soon as the signing flow settles. Failures (cost cap, agents
        // service down, etc.) are logged but never block the sign call.
        ;(async () => {
          try {
            const result = await extractObligationsForContract({
              orgId:      sr.orgId,
              contractId: sr.contractId,
              userId:     'system',
            })
            app.log.info(
              { contractId: sr.contractId, count: result.count, skipped: result.skippedReason ?? null },
              '[obligations] auto-extracted on signature.completed',
            )
          } catch (err) {
            if (err instanceof CostCapExceededError) {
              app.log.info({ contractId: sr.contractId }, '[obligations] auto-extract skipped: daily cost cap reached')
            } else {
              app.log.warn(
                { contractId: sr.contractId, err: (err as Error).message },
                '[obligations] auto-extract failed',
              )
            }
          }
        })().catch(() => { /* swallow */ })
      } else if (sr.signOrder === 'SEQUENTIAL') {
        // Wave 3.7 — sequential flow, not everyone has signed yet. If this
        // signature just unblocked a later signOrder bucket, email those signers
        // now instead of making them wait for a T-3d/T-1d reminder job. Mirrors
        // the initial-send loop and the reminder worker's bucket selection.
        const pending = fresh!.signers.filter(s => s.status === 'PENDING')
        if (pending.length > 0) {
          const minOrder = Math.min(...pending.map(s => s.signOrder))
          // Only notify when this sign advanced the sequence to a NEW bucket —
          // guards against re-emailing parallel siblings still pending in the
          // current signer's own bucket (they were emailed when that bucket
          // opened).
          if (minOrder > signer.signOrder) {
            const nextBucket = pending.filter(s => s.signOrder === minOrder)
            const cMeta = await prisma.contract.findUnique({
              where: { id: sr.contractId },
              select: { title: true, type: true, org: { select: { name: true } } },
            })
            const sender = await prisma.user.findUnique({
              where: { id: sr.createdById }, select: { name: true },
            })
            const baseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:5173'
            for (const s of nextBucket) {
              sendSigningEmailForSigner({
                signer: s,
                baseUrl,
                senderName: sender?.name ?? null,
                orgName: cMeta?.org?.name ?? 'draftLegal',
                contractTitle: cMeta?.title ?? 'Contract',
                contractType: cMeta?.type ?? '',
                message: sr.message,
                expiresAt: sr.expiresAt,
              })
            }
            await prisma.signatureEvent.create({
              data: {
                signatureRequestId: sr.id,
                kind: 'SENT',
                metadata: { sequentialAdvance: true, notified: nextBucket.length, signOrder: minOrder },
              },
            }).catch(() => { /* audit best-effort */ })
          }
        }
      }

      return reply.send({
        ok: true,
        signedAt: updated.signedAt,
        allSigned,
      })
    },
  )

  // ── POST /sign/:token/decline (public) ────────────────────────────────
  app.post<{ Params: { token: string } }>(
    '/sign/:token/decline',
    async (req, reply) => {
      const body = DeclineBodySchema.parse(req.body)
      const { token } = req.params

      const signer = await prisma.signer.findUnique({
        where: { token },
        include: { signatureRequest: true },
      })
      if (!signer) return reply.status(404).send({ detail: 'Invalid signing link' })
      const sr = signer.signatureRequest
      if (sr.status !== 'PENDING') return reply.status(410).send({ detail: 'Signing request is no longer active' })
      if (signer.status !== 'PENDING') return reply.status(409).send({ detail: 'Signer already responded' })

      await prisma.$transaction([
        prisma.signer.update({
          where: { id: signer.id },
          data: { status: 'DECLINED', declinedAt: new Date(), declinedReason: body.reason },
        }),
        prisma.signatureEvent.create({
          data: {
            signatureRequestId: sr.id,
            signerId: signer.id,
            kind: 'DECLINED',
            metadata: { reason: body.reason },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          },
        }),
        prisma.signatureRequest.update({
          where: { id: sr.id },
          data: { status: 'VOIDED', voidedAt: new Date(), voidedReason: `${signer.name} declined: ${body.reason ?? '(no reason given)'}` },
        }),
      ])

      await createAuditEvent({
        orgId: sr.orgId,
        userId: sr.createdById,
        action: AuditAction.SIGNATURE_VOIDED,
        resourceType: 'contract',
        resourceId: sr.contractId,
        metadata: { signatureRequestId: sr.id, declinedBy: signer.email, reason: body.reason },
      })
      // H2 — a decline voids the request; subscribers were promised this event.
      fireWebhook(sr.orgId, 'signature.voided', {
        contractId: sr.contractId, signatureRequestId: sr.id,
        reason: `${signer.name} declined${body.reason ? `: ${body.reason}` : ''}`,
      })

      return reply.send({ ok: true })
    },
  )

  // ── POST /contracts/:id/signature-requests/:srId/remind ───────────────
  // Manual nudge — sender can fire a reminder email at any time. Idempotent
  // by virtue of the worker's status-recheck. No effect on a non-PENDING SR.
  app.post<{ Params: { id: string; srId: string } }>(
    '/contracts/:id/signature-requests/:srId/remind',
    { preHandler: requirePermission('sign', 'contract') },
    async (req, reply) => {
      const { id, srId } = req.params
      const { orgId } = req.user
      const sr = await prisma.signatureRequest.findFirst({
        where: { id: srId, contractId: id, orgId },
        include: { signers: true },
      })
      if (!sr) return reply.status(404).send({ detail: 'Signature request not found' })
      if (sr.status !== 'PENDING') {
        return reply.status(409).send({ detail: `Request is ${sr.status} — cannot send reminder` })
      }
      const pending = sr.signers.filter(s => s.status === 'PENDING')
      if (pending.length === 0) {
        return reply.status(409).send({ detail: 'All signers have already responded' })
      }
      // Mirror the worker's nudge logic so the response count is honest:
      // SEQUENTIAL → only the lowest-signOrder bucket of pending is emailed.
      const nudgeCount = sr.signOrder === 'SEQUENTIAL'
        ? (() => {
            const minOrder = Math.min(...pending.map(s => s.signOrder))
            return pending.filter(s => s.signOrder === minOrder).length
          })()
        : pending.length
      // Fire immediately (delay=0). Worker handles the rest.
      await queueSigningReminder({ signatureRequestId: srId, kind: 'manual' }, 0)
        .catch(err => req.log.warn({ err }, 'failed to enqueue manual reminder'))
      return reply.send({ ok: true, signersNotified: nudgeCount })
    },
  )

  // ── POST /contracts/:id/signature-requests/:srId/void ─────────────────
  app.post<{ Params: { id: string; srId: string } }>(
    '/contracts/:id/signature-requests/:srId/void',
    { preHandler: requirePermission('sign', 'contract') },
    async (req, reply) => {
      const { id, srId } = req.params
      const { orgId, sub: userId } = req.user
      const sr = await prisma.signatureRequest.findFirst({
        where: { id: srId, contractId: id, orgId },
      })
      if (!sr) return reply.status(404).send({ detail: 'Signature request not found' })
      if (sr.status !== 'PENDING') return reply.status(409).send({ detail: 'Already terminated' })

      await prisma.$transaction([
        prisma.signatureRequest.update({
          where: { id: srId },
          data: { status: 'VOIDED', voidedAt: new Date(), voidedReason: 'Voided by sender' },
        }),
        prisma.signatureEvent.create({
          data: { signatureRequestId: srId, kind: 'VOIDED', metadata: { actor: userId } },
        }),
      ])

      await createAuditEvent({
        orgId, userId,
        action: AuditAction.SIGNATURE_VOIDED,
        resourceType: 'contract',
        resourceId: id,
        metadata: { signatureRequestId: srId },
      })
      fireWebhook(orgId, 'signature.voided', { contractId: id, signatureRequestId: srId, reason: 'Voided by sender' })

      return reply.send({ ok: true })
    },
  )
}
