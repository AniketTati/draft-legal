/**
 * Contract Comments — Phase 05 (Negotiation)
 * Threaded, clause-anchored comments on contracts.
 * External (portal) comments use authorId = "portal:<linkId>"
 */
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'

export async function commentRoutes(app: FastifyInstance) {
  // X7 — own-scope callers may only reach their own contracts by id.
  guardOwnScopeContractRoutes(app)

  // ── List comments for a contract ──────────────────────────────────────────
  app.get('/:id/comments', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id: contractId } = req.params as { id: string }
    const { clauseRef, resolved, cursor, limit = '50' } = req.query as Record<string, string>

    // Verify contract belongs to org
    const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })

    const where: Record<string, unknown> = {
      contractId,
      orgId,
      parentId: null,       // top-level threads only — replies fetched inline
      deletedAt: null,
      ...(clauseRef && { clauseRef }),
      ...(resolved !== undefined && { resolved: resolved === 'true' }),
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
    return reply.send({ data: comments, nextCursor })
  })


  // ── Add a comment ──────────────────────────────────────────────────────────
  app.post('/:id/comments', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId } = req.params as { id: string }
    const { body, clauseRef, versionId, parentId } = req.body as {
      body: string
      clauseRef?: string
      versionId?: string
      parentId?: string
    }

    if (!body?.trim()) return reply.status(400).send({ error: 'body is required' })

    const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })

    // If reply, ensure parent belongs to same contract
    if (parentId) {
      const parent = await prisma.contractComment.findFirst({ where: { id: parentId, contractId, deletedAt: null } })
      if (!parent) return reply.status(400).send({ error: 'Parent comment not found' })
    }

    const comment = await prisma.contractComment.create({
      data: { orgId, contractId, authorId: userId, body: body.trim(), clauseRef, versionId, parentId },
      include: { replies: true },
    })

    createAuditEvent({ orgId, userId, action: AuditAction.COMMENT_ADDED, resourceType: 'contract', resourceId: contractId, metadata: { commentId: comment.id, clauseRef } }).catch(() => {})

    return reply.status(201).send(comment)
  })


  // ── Update a comment (body or resolve) ────────────────────────────────────
  app.patch('/:id/comments/:commentId', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId, commentId } = req.params as { id: string; commentId: string }
    const { body, resolved } = req.body as { body?: string; resolved?: boolean }

    const existing = await prisma.contractComment.findFirst({
      where: { id: commentId, contractId, orgId, deletedAt: null },
    })
    if (!existing) return reply.status(404).send({ error: 'Comment not found' })

    const data: Record<string, unknown> = {}
    if (body !== undefined) data.body = body.trim()
    if (resolved !== undefined) {
      data.resolved = resolved
      if (resolved && !existing.resolved) {
        data.resolvedById = userId
        data.resolvedAt = new Date()
      }
    }

    const updated = await prisma.contractComment.update({
      where: { id: commentId },
      data,
      include: { replies: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
    })

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
