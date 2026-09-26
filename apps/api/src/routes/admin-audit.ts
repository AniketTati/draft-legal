/**
 * Org audit log (X3).
 *
 * Every write in the product lands an AuditEvent (lib/audit.ts), hash-chained
 * per org, but nothing could read them back outside the AI-settings slice
 * (GET /admin/ai/audit): this file was an empty stub. Admins get the whole
 * log here, newest first, and a check of the chain.
 *
 *   GET /api/v1/admin/audit          — list, filterable, cursor-paged
 *   GET /api/v1/admin/audit/verify   — re-verify the org's hash chain
 *
 * Gated like the AI audit: configure:organization (ADMIN). The log carries IP
 * addresses and every resource id in the org, so it is not a view:report thing.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { verifyAuditChain, type ChainVerifyResult } from '../lib/audit.js'
import { requirePermission } from '../middleware/permissions.js'

// Filters are plain text (a NUL byte made Postgres fail the query with a 500).
const filter = z.string().max(200).refine(v => !v.includes('\0'), 'Invalid character')

const ListQuery = z.object({
  action:       filter.optional(),              // comma-separated AuditAction values
  resourceType: filter.optional(),
  resourceId:   filter.optional(),
  userId:       filter.optional(),
  from:         z.string().date().optional(),   // YYYY-MM-DD, inclusive
  to:           z.string().date().optional(),   // YYYY-MM-DD, exclusive
  cursor:       z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),   // id of the last event of the previous page
  limit:        z.coerce.number().int().min(1).max(200).default(50),
})

/** The verify walk reads in batches; past this many rows it reports what it checked. */
const VERIFY_LIMIT = 200_000
/** Metadata above this (serialized size) is fetched per event, not listed: one row can hold ~1 MB of tool arguments. */
const LIST_METADATA_BYTES = 4_096

/** One verify per org at a time in this process: a second request shares the running one. */
const verifying = new Map<string, Promise<ChainVerifyResult & { truncated: boolean }>>()

export async function adminAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const parsed = ListQuery.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ detail: 'Invalid query', issues: parsed.error.issues })
    const q = parsed.data

    const where: Record<string, unknown> = { orgId }
    if (q.action)       where.action = { in: q.action.split(',').map(s => s.trim()).filter(Boolean) }
    if (q.resourceType) where.resourceType = q.resourceType
    if (q.resourceId)   where.resourceId = q.resourceId
    if (q.userId)       where.userId = q.userId
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
        ...(q.to ? { lt: new Date(`${q.to}T00:00:00Z`) } : {}),
      }
    }
    // Keyset paging on (createdAt, id): offsets drift while events keep landing.
    if (q.cursor) {
      const at = await prisma.auditEvent.findFirst({ where: { id: q.cursor, orgId }, select: { id: true, createdAt: true } })
      if (!at) return reply.status(400).send({ detail: 'Unknown cursor' })
      where.OR = [
        { createdAt: { lt: at.createdAt } },
        { createdAt: at.createdAt, id: { lt: at.id } },
      ]
    }

    const rows = await prisma.auditEvent.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      select: { id: true, action: true, resourceType: true, resourceId: true, userId: true, ipAddress: true, userAgent: true, createdAt: true },
    })
    const page = rows.slice(0, q.limit)
    // Small metadata inline; large ones via GET /:id when a row is opened.
    const small = page.length
      ? await prisma.$queryRaw<Array<{ id: string; metadata: unknown }>>`
          SELECT id, metadata FROM audit_events
          WHERE id = ANY(${page.map(r => r.id)}) AND octet_length(metadata::text) <= ${LIST_METADATA_BYTES}`
      : []
    const metadataOf = new Map(small.map(r => [r.id, r.metadata]))

    const userIds = [...new Set(page.map(r => r.userId).filter((x): x is string => !!x))]
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds }, orgId }, select: { id: true, name: true, email: true } })
      : []
    const userMap = new Map(users.map(u => [u.id, u]))

    return reply.send({
      events: page.map(r => ({
        id:           r.id,
        action:       r.action,
        resourceType: r.resourceType,
        resourceId:   r.resourceId,
        metadata:     metadataOf.get(r.id) ?? null,
        metadataTruncated: !metadataOf.has(r.id),
        ipAddress:    r.ipAddress,
        userAgent:    r.userAgent,
        createdAt:    r.createdAt,
        actor: r.userId
          ? { id: r.userId, name: userMap.get(r.userId)?.name ?? null, email: userMap.get(r.userId)?.email ?? null }
          : null,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    })
  })

  app.get('/verify', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    let run = verifying.get(orgId)
    if (!run) {
      run = (async () => {
        const [result, all] = await Promise.all([
          verifyAuditChain(orgId, { limit: VERIFY_LIMIT }),
          prisma.auditEvent.count({ where: { orgId } }),
        ])
        return { ...result, truncated: result.ok && all > result.total }
      })().finally(() => verifying.delete(orgId))
      verifying.set(orgId, run)
    }
    return reply.send(await run)
  })

  // One event in full: the list leaves out large metadata.
  app.get('/:id', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const event = await prisma.auditEvent.findFirst({ where: { id, orgId: req.user.orgId } })
    if (!event) return reply.status(404).send({ detail: 'Audit event not found' })
    return reply.send(event)
  })
}
