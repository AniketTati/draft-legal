/**
 * A contract and the agreement it belongs to (docs/39 G3) — see
 * lib/contract-family.ts and field-store applyAmendmentValues.
 *
 *   GET  /api/v1/contracts/:id/parent-suggestions         what it reads as, and the agreements it likely belongs to
 *   PUT  /api/v1/contracts/:id/parent                     { parentContractId: string | null, relationshipType? }
 *   GET  /api/v1/contracts/:id/amendment-changes          the parent's terms it changes
 *   POST /api/v1/contracts/:id/amendment-changes/apply    { keys } — set them on the parent (undo: POST /field-runs/:id/undo)
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AuditAction } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes, ownContractWhere } from '../lib/own-scope-guard.js'
import { parentSuggestions, wouldLoop, RELATIONSHIP_TYPES } from '../lib/contract-family.js'
import { amendmentChanges, applyAmendmentValues } from '../lib/field-store.js'
import { recordRun, UNDO_DAYS } from '../lib/field-runs.js'
import { createAuditEvent } from '../lib/audit.js'
import { fireWebhook } from '../lib/webhook-events.js'

const ParentSchema = z.object({
  parentContractId: z.string().min(1).max(64).nullable(),
  relationshipType: z.enum(RELATIONSHIP_TYPES).optional(),
})

export async function contractFamilyRoutes(app: FastifyInstance) {
  guardOwnScopeContractRoutes(app)

  app.get('/:id/parent-suggestions', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const r = await parentSuggestions(req.user.orgId, id, { ownerId: ownContractWhere(req).ownerId })
    if (!r) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send(r)
  })

  // Link a contract to the agreement it belongs to, change it, or unlink it.
  app.put('/:id/parent', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = ParentSchema.parse(req.body ?? {})
    const { orgId, sub: userId } = req.user
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null, ...ownContractWhere(req) },
      select: { id: true, parentContractId: true, relationshipType: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    if (body.parentContractId) {
      if (body.parentContractId === id) return reply.status(400).send({ detail: 'A contract can’t be its own parent' })
      const parent = await prisma.contract.findFirst({
        where: { id: body.parentContractId, orgId, deletedAt: null, ...ownContractWhere(req) },
        select: { id: true },
      })
      if (!parent) return reply.status(404).send({ detail: 'Parent contract not found' })
      if (await wouldLoop(orgId, id, parent.id)) return reply.status(400).send({ detail: 'That contract belongs to this one: it can’t be its parent too' })
    }
    const relationshipType = body.parentContractId ? body.relationshipType ?? c.relationshipType ?? 'amendment' : null
    await prisma.contract.update({ where: { id }, data: { parentContractId: body.parentContractId, relationshipType } })
    await createAuditEvent({
      orgId, userId, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: id,
      metadata: { action: body.parentContractId ? 'linked_parent' : 'unlinked_parent', parentContractId: body.parentContractId, relationshipType, from: c.parentContractId },
      ipAddress: req.ip,
    }).catch(() => {})
    fireWebhook(orgId, 'contract.updated', { contractId: id, changes: ['parentContractId'], source: 'user' })
    return reply.send({ parentContractId: body.parentContractId, relationshipType })
  })

  app.get('/:id/amendment-changes', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null, ...ownContractWhere(req) },
      select: { parentContractId: true, relationshipType: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const parent = c.parentContractId
      ? await prisma.contract.findFirst({ where: { id: c.parentContractId, orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true, title: true } })
      : null
    if (!parent) return reply.send({ parent: null, relationshipType: c.relationshipType, changes: [], lastRun: null })
    // The latest roll-up from this amendment still to be undone, so the undo outlives the page.
    const [run] = await prisma.$queryRaw<Array<{ id: string; createdAt: Date; count: number }>>`
      SELECT id, "createdAt", jsonb_array_length(changes)::int AS count FROM field_value_runs
       WHERE "orgId" = ${orgId} AND kind = 'rollup' AND "contractId" = ${parent.id} AND "undoneAt" IS NULL
         AND "createdAt" > ${new Date(Date.now() - UNDO_DAYS * 24 * 60 * 60 * 1000)} AND changes @> ${JSON.stringify([{ fromContractId: id }])}::jsonb
       ORDER BY "createdAt" DESC LIMIT 1`
    return reply.send({
      parent, relationshipType: c.relationshipType, changes: await amendmentChanges(orgId, id, parent.id) ?? [],
      lastRun: run ? { id: run.id, createdAt: run.createdAt.toISOString(), count: run.count } : null,
    })
  })

  // Set the chosen terms on the parent: a person decides what the amendment changed.
  app.post('/:id/amendment-changes/apply', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { keys } = z.object({ keys: z.array(z.string().min(1).max(64)).min(1).max(60) }).parse(req.body ?? {})
    const { orgId, sub: userId } = req.user
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null, ...ownContractWhere(req) },
      select: { parentContractId: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    // The write is on the parent: the caller must be able to reach it too.
    const parent = c.parentContractId
      ? await prisma.contract.findFirst({ where: { id: c.parentContractId, orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true, title: true } })
      : null
    if (!parent) return reply.status(400).send({ detail: 'This contract isn’t linked to the agreement it changes' })
    const r = await applyAmendmentValues({ orgId, parentId: parent.id, amendmentId: id, keys, userId, audit: { source: 'amendment_rollup', ipAddress: req.ip } })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    const runId = r.changes.length
      ? await recordRun({ orgId, kind: 'rollup', contractId: parent.id, changes: r.changes.map(ch => ({ ...ch, contractId: parent.id })), createdById: userId })
      : null
    return reply.send({ parent, applied: r.applied, runId })
  })
}
