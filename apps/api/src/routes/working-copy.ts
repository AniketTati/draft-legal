/**
 * docs/41 Part 16 (C1) — the editor's working copy, and versions made from it.
 *
 *   GET    /api/v1/contracts/:id/working-copy        the draft changes, or { workingCopy: null }
 *   PUT    /api/v1/contracts/:id/working-copy        autosave { html, revision, baseVersionId? }
 *                                                   → 200 { workingCopy } | 409 WORKING_COPY_CONFLICT
 *   DELETE /api/v1/contracts/:id/working-copy        discard them
 *   POST   /api/v1/contracts/:id/versions/from-working-copy
 *          { note, sendToCounterparty?, resetApprovals?, overwriteNewer? }
 *          → 201 { version, approvals, send? } | 409 NO_WORKING_COPY | BASE_CHANGED
 *
 * See lib/working-copy.ts for why typing no longer makes versions.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { lockOf, lockedBody } from '../lib/external-edit.js'
import { onSentToCounterparty } from '../lib/lifecycle.js'
import { discardWorkingCopy, getWorkingCopy, noteRefusal, saveWorkingCopy, versionFromWorkingCopy } from '../lib/working-copy.js'
import type { ApprovalOverride } from '../lib/approval-reset.js'

export const SEND_METHODS = ['share_link', 'email', 'word', 'pdf'] as const
export type SendMethod = typeof SEND_METHODS[number]

interface SendToCounterparty {
  method: SendMethod
  /** share_link / email: as POST /contracts/:id/share takes them. */
  label?: string
  permissions?: string[]
  expiresInHours?: number
  recipientEmail?: string
  message?: string
}

/** The headers a request on the user's behalf carries (the share route checks them as its own). */
const authHeaders = (req: FastifyRequest) => Object.fromEntries(
  ['authorization', 'x-api-key', 'cookie'].map(h => [h, req.headers[h]]).filter(([, v]) => typeof v === 'string'),
) as Record<string, string>

const forbidden = (permission: string) => ({ type: 'https://httpstatuses.com/403', title: 'Forbidden', status: 403, detail: `Missing permission: ${permission}` })

export async function workingCopyRoutes(app: FastifyInstance) {
  // X7 — own-scope callers may only reach their own contracts by id.
  guardOwnScopeContractRoutes(app)

  app.get('/:id/working-copy', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send({ workingCopy: await getWorkingCopy(orgId, id) })
  })

  app.put('/:id/working-copy', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const { html, revision, baseVersionId } = (req.body ?? {}) as { html?: string; revision?: number; baseVersionId?: string }
    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { externalEdit: true } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    // BB3 — read-only while a Google Docs copy is out.
    const lock = lockOf(contract.externalEdit)
    if (lock) return reply.status(409).send(lockedBody(lock))
    const r = await saveWorkingCopy({ orgId, contractId: id, userId, html: html ?? '', revision, baseVersionId })
    if (!r.ok) return reply.status(r.status).send(r.body)
    return reply.send({ workingCopy: r.copy })
  })

  app.delete('/:id/working-copy', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const discarded = await discardWorkingCopy({ orgId, contractId: id, userId })
    return reply.send({ discarded })
  })

  app.post('/:id/versions/from-working-copy', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = (req.body ?? {}) as { note?: string; sendToCounterparty?: SendToCounterparty | null; resetApprovals?: boolean; overwriteNewer?: boolean }
    // Not found, as the other routes say, rather than "no draft changes" for a contract the caller can't see.
    if (!(await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } }))) {
      return reply.status(404).send({ detail: 'Contract not found' })
    }
    const refusal = noteRefusal(body.note)
    if (refusal) return reply.status(400).send({ code: 'NOTE_REQUIRED', detail: refusal })
    const send = body.sendToCounterparty ?? null
    if (send && !SEND_METHODS.includes(send.method)) {
      return reply.status(400).send({ detail: `sendToCounterparty.method must be one of ${SEND_METHODS.join(', ')}` })
    }
    if (send?.method === 'email' && !send.recipientEmail?.trim()) {
      return reply.status(400).send({ detail: 'An email address is needed to send it by email.' })
    }
    // Checked before anything is saved: a send this person can't make
    // shouldn't leave a version behind and then fail.
    if (send && (send.method === 'share_link' || send.method === 'email') && (await permissionScopeFor(req, 'configure', 'contract')) === null) {
      return reply.status(403).send(forbidden('configure:contract'))
    }
    // "Reset approvals" is the workflow owner's call; for anyone else the
    // steps' reset rules decide, as they would without the box.
    const mayOverride = typeof body.resetApprovals === 'boolean' && (await permissionScopeFor(req, 'configure', 'workflow')) !== null
    const approvals: ApprovalOverride | undefined = mayOverride ? (body.resetApprovals ? 'reset_all' : 'keep') : undefined

    const r = await versionFromWorkingCopy({
      orgId, contractId: id, userId, note: body.note!, approvals, via: 'working_copy',
      overwriteNewer: body.overwriteNewer === true, ipAddress: req.ip, log: app.log,
    })
    if (!r.ok) return reply.status(r.status).send(r.body)

    const out: Record<string, unknown> = {
      version: r.version,
      created: r.created,
      approvals: approvals ?? 'rules',
    }
    if (send) out.send = await sendIt(req, id, send, r.version)
    const contract = await prisma.contract.findFirst({ where: { id, orgId }, select: { stage: true, stageState: true, turn: true, turnSince: true } })
    out.contract = contract
    return reply.status(201).send(out)
  })

  /**
   * Send the new version to the counterparty by the path each method already
   * has. A send that fails leaves the version saved and says why: the
   * version was the main thing asked for.
   *   - share_link / email: POST /share (its own checks, audit and turn change);
   *   - word: the redline of their Word file, which the page downloads from
   *     GET /redline/counterparty — that route changes the turn once the file
   *     is made (no Word file of theirs, no send);
   *   - pdf: the version's PDF, downloaded by the page; the turn changes now.
   */
  async function sendIt(req: FastifyRequest, contractId: string, send: SendToCounterparty, version: { id: string; versionNumber: number }) {
    const { orgId, sub: userId } = req.user
    if (send.method === 'share_link' || send.method === 'email') {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/contracts/${contractId}/share`, headers: authHeaders(req),
        payload: {
          label: send.label ?? `v${version.versionNumber}`,
          permissions: send.permissions ?? ['read', 'comment', 'upload'],
          expiresInHours: send.expiresInHours,
          ...(send.method === 'email' && { recipientEmail: send.recipientEmail, message: send.message }),
        },
      })
      const data = res.json() as Record<string, unknown>
      if (res.statusCode >= 300) return { method: send.method, ok: false, status: res.statusCode, detail: data.detail ?? data.error ?? 'Not sent', code: data.code }
      return { method: send.method, ok: true, portalUrl: data.portalUrl, emailedTo: data.emailedTo, emailDelivered: data.emailDelivered }
    }
    if (send.method === 'word') {
      return { method: 'word', ok: true, download: `/contracts/${contractId}/redline/counterparty` }
    }
    await onSentToCounterparty({ orgId, contractId, userId, via: 'pdf' })
    return { method: 'pdf', ok: true, download: `/contracts/${contractId}/download?versionId=${version.id}` }
  }
}
