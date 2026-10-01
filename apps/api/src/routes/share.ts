/**
 * Contract Share Links — Phase 05 (Negotiation)
 * Generate time-limited portal tokens for external reviewers/counterparties.
 * Portal JWT is signed with PORTAL_JWT_SECRET (isolated from user JWT_SECRET).
 */
import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { resolveSecret } from '../lib/secrets.js'
import { sendShareLinkEmail } from '../lib/share-email.js'
import { isEmailConfigured } from '../lib/mailer.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { openChoices, openChoicesMessage } from '../lib/open-choices.js'

// Portal tokens are signed with PORTAL_JWT_SECRET, isolated from the user
// JWT_SECRET. Resolved lazily + cached; production fails closed if missing/
// weak (lib/secrets.ts). The old chained `?? JWT_SECRET ?? 'portal-dev-secret'`
// fallback is gone — it both leaked a hardcoded default and broke isolation.
let _portalSecret: string | null = null
function portalSecret(): string {
  if (_portalSecret === null) _portalSecret = resolveSecret('PORTAL_JWT_SECRET')
  return _portalSecret
}
const FRONTEND_URL  = process.env.FRONTEND_URL ?? 'http://localhost:5173'

// Canonical portal-link permissions. 'read' is implied on every link — it is
// the entry point every other capability builds on. 'comment' gates portal
// commenting (portal.ts:117); 'upload' gates the counterparty revision upload
// (portal.ts:221, which also still honours 'edit', kept here as a legacy alias).
// Validated because this array is both persisted AND signed into the portal
// JWT — unvalidated caller input must reach neither.
const VALID_PERMISSIONS = new Set(['read', 'comment', 'upload', 'edit'])

export interface PortalTokenPayload {
  type: 'portal'
  token: string           // ContractShareLink.token (DB lookup key)
  contractId: string
  orgId: string
  permissions: string[]
}

export function signPortalToken(payload: Omit<PortalTokenPayload, 'type'>, expiresInSeconds: number): string {
  return jwt.sign({ ...payload, type: 'portal' }, portalSecret(), { expiresIn: expiresInSeconds })
}

export function verifyPortalToken(token: string): PortalTokenPayload {
  return jwt.verify(token, portalSecret()) as PortalTokenPayload
}

export async function shareRoutes(app: FastifyInstance) {
  // X7 — own-scope callers may only reach their own contracts by id.
  guardOwnScopeContractRoutes(app)

  // ── Create a share link ───────────────────────────────────────────────────
  app.post('/:id/share', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId } = req.params as { id: string }
    const {
      label,
      permissions = ['read'],
      expiresInHours = 168,  // 7 days default
      recipientEmail,
      message,
    } = req.body as {
      label?: string
      permissions?: string[]
      expiresInHours?: number
      recipientEmail?: string
      message?: string
    }

    const contract = await prisma.contract.findFirst({
      where:   { id: contractId, orgId, deletedAt: null },
      include: { org: { select: { name: true } } },
    })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })
    // docs/41 P0.4 — the counterparty never receives a draft with a term
    // still to choose (a governing law nobody named).
    const open = await openChoices(contractId)
    if (open.length) {
      const detail = openChoicesMessage(open, 'sending it to the counterparty')
      return reply.status(409).send({ code: 'OPEN_CHOICES', error: detail, detail, choices: open })
    }

    if (!Array.isArray(permissions)) {
      return reply.status(400).send({ error: 'permissions must be an array of strings' })
    }
    const invalid = permissions.filter(p => !VALID_PERMISSIONS.has(p))
    if (invalid.length > 0) {
      return reply.status(400).send({ error: `Unknown permission(s): ${invalid.join(', ')}` })
    }
    // 'read' is implied: every other capability is reached through the portal view.
    const grantedPermissions = Array.from(new Set(['read', ...permissions]))

    // Optional: deliver the link by email instead of making the user copy it.
    const inviteEmail = recipientEmail?.trim().toLowerCase() || null
    if (inviteEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) {
      return reply.status(400).send({ error: 'recipientEmail is not a valid email address' })
    }

    // Clamp expiry: 1h min, 720h (30d) max. Coerce first — a non-numeric value
    // would otherwise clamp to NaN and surface as an unhandled 500 from Prisma
    // when `new Date(NaN)` is written.
    const requestedHours = Number(expiresInHours)
    const clampedHours = Number.isFinite(requestedHours)
      ? Math.min(Math.max(requestedHours, 1), 720)
      : 168
    const expiresAt = new Date(Date.now() + clampedHours * 3600 * 1000)
    const rawToken = crypto.randomBytes(32).toString('hex')

    const shareLink = await prisma.contractShareLink.create({
      data: {
        orgId, contractId, token: rawToken, label,
        permissions: grantedPermissions, expiresAt, createdById: userId,
        // Recorded even though the email send is fire-and-forget: the
        // inbound-email allow-list uses it to recognise this counterparty
        // if they email a redline back.
        invitedEmail: inviteEmail,
      },
    })

    const portalJwt = signPortalToken(
      { token: rawToken, contractId, orgId, permissions: grantedPermissions },
      clampedHours * 3600,
    )
    const portalUrl = `${FRONTEND_URL}/portal/${portalJwt}`

    if (inviteEmail) {
      const sender = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
      sendShareLinkEmail({
        to:            inviteEmail,
        portalUrl,
        contractTitle: contract.title,
        contractType:  contract.type,
        orgName:       contract.org?.name ?? 'draftLegal',
        senderName:    sender?.name ?? null,
        message:       message?.trim() || null,
        expiresAt,
        canUpload:     grantedPermissions.includes('upload') || grantedPermissions.includes('edit'),
        // Only offered when inbound email is actually configured — otherwise we
        // would invite a reply to an address nothing is listening on.
        replyToAddress: process.env.INBOUND_EMAIL_DOMAIN
          ? `contracts+${contractId}@${process.env.INBOUND_EMAIL_DOMAIN}`
          : null,
      })
    }

    createAuditEvent({ orgId, userId, action: AuditAction.LINK_SHARED, resourceType: 'contract', resourceId: contractId, metadata: { shareLinkId: shareLink.id, permissions: grantedPermissions, expiresAt, emailedTo: inviteEmail } }).catch(() => {})

    return reply.status(201).send({
      shareLink,
      portalUrl,
      emailedTo: inviteEmail,
      // Report honestly whether an email could actually go out. Without an
      // email provider the send is a no-op (the link is only logged
      // server-side), and telling the user "sent" would be a lie — the caller
      // uses this to say "copy this manually" instead. Z5 — SendGrid counts.
      emailDelivered: inviteEmail ? isEmailConfigured() : null,
    })
  })


  // ── List active share links for a contract ─────────────────────────────────
  app.get('/:id/share', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id: contractId } = req.params as { id: string }

    const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })

    const links = await prisma.contractShareLink.findMany({
      where: { contractId, orgId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })

    return reply.send({ data: links })
  })


  // ── Revoke a share link ───────────────────────────────────────────────────
  app.delete('/:id/share/:linkId', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId, linkId } = req.params as { id: string; linkId: string }

    const link = await prisma.contractShareLink.findFirst({ where: { id: linkId, contractId, orgId, revokedAt: null } })
    if (!link) return reply.status(404).send({ error: 'Share link not found' })

    await prisma.contractShareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } })

    createAuditEvent({ orgId, userId, action: AuditAction.LINK_REVOKED, resourceType: 'contract', resourceId: contractId, metadata: { shareLinkId: linkId } }).catch(() => {})

    return reply.status(204).send()
  })
}
