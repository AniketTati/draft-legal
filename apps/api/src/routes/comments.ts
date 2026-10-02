/**
 * Contract Comments — Phase 05 (Negotiation)
 * Threaded, clause-anchored comments on contracts.
 * External (portal) comments use authorId = "portal:<linkId>"
 */
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction, isCommentVisibility, parseCommentAnchor, type CommentVisibility } from '@clm/types'
import { Prisma } from '@prisma/client'
import { withAnchors } from '../lib/comment-anchors.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'

/** A portal author's typed name, kept in resolvedById until someone resolves the thread. */
function portalName(c: { resolvedById: string | null; resolved?: boolean }) {
  return c.resolved ? null : c.resolvedById
}

export async function commentRoutes(app: FastifyInstance) {
  // X7 — own-scope callers may only reach their own contracts by id.
  guardOwnScopeContractRoutes(app)

  // ── List comments for a contract ──────────────────────────────────────────
  app.get('/:id/comments', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id: contractId } = req.params as { id: string }
    const { clauseRef, resolved, cursor, limit = '50', visibility, versionId } = req.query as Record<string, string>

    // Verify contract belongs to org
    const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })

    const where: Record<string, unknown> = {
      contractId,
      orgId,
      parentId: null,       // top-level threads only — replies fetched inline
      deletedAt: null,
      // Z7 — a clause's thread: comments anchored to its reference, alone or
      // followed by its title ("Section 8.2 — Limitation of Liability").
      ...(clauseRef && { OR: [{ clauseRef }, { clauseRef: { startsWith: `${clauseRef} ` } }] }),
      ...(resolved !== undefined && { resolved: resolved === 'true' }),
      ...(isCommentVisibility(visibility) && { visibility }),
      ...(cursor && { id: { lt: cursor } }),
    }

    const comments = await prisma.contractComment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit, 10),
      include: {
        replies: {
          // Only replies filed on this contract (X10 — a reply once pointed its
          // parentId at another contract's comment).
          where: { deletedAt: null, contractId, orgId },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    const nextCursor = comments.length === parseInt(limit, 10) ? comments[comments.length - 1].id : null
    const placed = await withAnchors(orgId, contractId, comments, versionId)
    // Names, so a thread says who wrote it and the discussion can be filtered by person.
    const ids = [...new Set(comments.flatMap(c => [c, ...c.replies]).map(c => c.authorId).filter(a => !a.startsWith('portal:')))]
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, name: true } }) : []
    const nameOf = new Map(users.map(u => [u.id, u.name]))
    const named = <C extends { authorId: string; resolvedById: string | null }>(c: C) => ({
      ...c,
      // A portal comment keeps its author's typed name in resolvedById (portal.ts).
      authorName: c.authorId.startsWith('portal:') ? (portalName(c) ?? 'External reviewer') : nameOf.get(c.authorId) ?? null,
    })
    const data = placed.map(t => ({ ...named(t), replies: t.replies.map(named) }))
    // docs/41 Part 12 — how many threads there are, for counts that don't
    // fetch them all (the rail said "9+" for any two).
    const { id: _page, ...every } = where
    const total = await prisma.contractComment.count({ where: every })
    return reply.send({ data, nextCursor, total })
  })


  // ── Add a comment ──────────────────────────────────────────────────────────
  app.post('/:id/comments', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId } = req.params as { id: string }
    const { body, clauseRef, versionId, parentId, visibility: asked, anchor: rawAnchor } = req.body as {
      body: string
      clauseRef?: string
      versionId?: string
      parentId?: string
      visibility?: string
      anchor?: unknown
    }
    if (asked !== undefined && !isCommentVisibility(asked)) return reply.status(400).send({ error: 'visibility must be internal or external' })

    if (!body?.trim()) return reply.status(400).send({ error: 'body is required' })

    const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })

    // If reply, ensure parent belongs to same contract. A reply takes its
    // thread's visibility: an internal note can't be slipped into a thread the
    // counterparty reads, nor the reverse.
    let visibility: CommentVisibility = asked ?? 'internal'
    if (parentId) {
      const parent = await prisma.contractComment.findFirst({ where: { id: parentId, contractId, orgId, deletedAt: null } })
      if (!parent) return reply.status(400).send({ error: 'Parent comment not found' })
      visibility = parent.visibility as CommentVisibility
    }
    // Only a thread is anchored; its replies sit with it.
    const anchor = parentId ? null : parseCommentAnchor(rawAnchor)
    if (anchor?.versionId) {
      const v = await prisma.contractVersion.findFirst({ where: { id: anchor.versionId, contractId }, select: { id: true } })
      if (!v) return reply.status(400).send({ error: 'The anchor names a version of another contract' })
    }

    const comment = await prisma.contractComment.create({
      data: {
        orgId, contractId, authorId: userId, body: body.trim(), clauseRef, versionId: versionId ?? anchor?.versionId ?? undefined, parentId,
        visibility, anchor: anchor ? (anchor as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
      include: { replies: true },
    })

    createAuditEvent({ orgId, userId, action: AuditAction.COMMENT_ADDED, resourceType: 'contract', resourceId: contractId, metadata: { commentId: comment.id, clauseRef, visibility } }).catch(() => {})

    return reply.status(201).send(comment)
  })


  // ── Update a comment (body or resolve) ────────────────────────────────────
  app.patch('/:id/comments/:commentId', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId, commentId } = req.params as { id: string; commentId: string }
    const { body, resolved, visibility } = req.body as { body?: string; resolved?: boolean; visibility?: string }
    if (visibility !== undefined && !isCommentVisibility(visibility)) return reply.status(400).send({ error: 'visibility must be internal or external' })

    const existing = await prisma.contractComment.findFirst({
      where: { id: commentId, contractId, orgId, deletedAt: null },
    })
    if (!existing) return reply.status(404).send({ error: 'Comment not found' })
    if (visibility !== undefined && existing.parentId) {
      return reply.status(400).send({ error: 'A reply follows its thread. Mark the thread instead.' })
    }
    // A thread the counterparty started stays theirs to see.
    if (visibility === 'internal' && existing.authorId.startsWith('portal:')) {
      return reply.status(409).send({ error: 'The counterparty started this thread, so it stays external.' })
    }

    const data: Record<string, unknown> = {}
    if (body !== undefined) data.body = body.trim()
    if (resolved !== undefined) {
      data.resolved = resolved
      if (resolved && !existing.resolved) {
        data.resolvedById = userId
        data.resolvedAt = new Date()
      }
    }

    const flips = visibility !== undefined && visibility !== existing.visibility
    if (flips) data.visibility = visibility

    const updated = await prisma.$transaction(async tx => {
      // The whole thread changes together, so the portal never shows half of it.
      if (flips) await tx.contractComment.updateMany({ where: { parentId: commentId, contractId, orgId }, data: { visibility } })
      return tx.contractComment.update({
        where: { id: commentId },
        data,
        include: { replies: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
      })
    })

    if (flips) {
      createAuditEvent({ orgId, userId, action: AuditAction.COMMENT_VISIBILITY_CHANGED, resourceType: 'contract', resourceId: contractId, metadata: { commentId, from: existing.visibility, to: visibility } }).catch(() => {})
    }

    if (resolved === true && !existing.resolved) {
      createAuditEvent({ orgId, userId, action: AuditAction.COMMENT_RESOLVED, resourceType: 'contract', resourceId: contractId, metadata: { commentId } }).catch(() => {})
    }

    return reply.send(updated)
  })


  // ── Soft-delete a comment ─────────────────────────────────────────────────
  app.delete('/:id/comments/:commentId', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId, commentId } = req.params as { id: string; commentId: string }

    const existing = await prisma.contractComment.findFirst({
      where: { id: commentId, contractId, orgId, deletedAt: null, authorId: userId },
    })
    if (!existing) return reply.status(404).send({ error: 'Comment not found or not owned by you' })

    await prisma.contractComment.update({ where: { id: commentId }, data: { deletedAt: new Date() } })
    return reply.status(204).send()
  })
}
