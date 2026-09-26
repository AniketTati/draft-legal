/**
 * Custom Fields API — Phase 2.1
 *
 * Org admins define extra fields for their contracts (Ironclad-style).
 * Field values are stored in contracts.metadata JSONB.
 * ES auto-indexes metadata.* via dynamic templates.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { queueBackfillCustomField } from '../lib/queue.js'
import type { BackfillState } from '../lib/custom-field-backfill.js'

const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multiselect'] as const

const CreateFieldSchema = z.object({
  contractType: z.string().nullable().optional(),
  fieldKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, {
    message: 'fieldKey must be snake_case (e.g. payment_terms, renewal_notice_days)',
  }),
  fieldLabel: z.string().min(1).max(128),
  fieldType: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  options: z.array(z.string()).default([]),
  sortOrder: z.number().int().default(0),
  helpText: z.string().max(512).optional(),
})

const UpdateFieldSchema = CreateFieldSchema.partial().omit({ fieldKey: true })

export async function fieldDefinitionRoutes(app: FastifyInstance) {
  // ── List field definitions for the org ────────────────────────────────────
  // FIX (2026-04-30 audit): everyone in the org needs to READ field defs so
  // contract detail pages can render custom fields. configure:contract is
  // required for mutations (POST/PATCH/DELETE) but GET should be view:contract.
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { contractType } = req.query as { contractType?: string }

    const defs = await prisma.contractFieldDefinition.findMany({
      where: {
        orgId,
        ...(contractType ? {
          OR: [
            { contractType },
            { contractType: null },  // global fields apply to all types
          ],
        } : {}),
      },
      orderBy: [{ contractType: 'asc' }, { sortOrder: 'asc' }],
    })

    return reply.send({ data: defs })
  })

  // ── Create a new field definition ─────────────────────────────────────────
  app.post('/', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const body = CreateFieldSchema.parse(req.body)

    // select/multiselect must have options
    if ((body.fieldType === 'select' || body.fieldType === 'multiselect') && !body.options.length) {
      return reply.status(422).send({ detail: 'select and multiselect fields require at least one option' })
    }

    try {
      const def = await prisma.contractFieldDefinition.create({
        data: { orgId, ...body, options: body.options },
      })
      return reply.status(201).send(def)
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ detail: `Field key "${body.fieldKey}" already exists for this org/type` })
      }
      throw err
    }
  })

  // ── Get a single field definition ─────────────────────────────────────────
  app.get('/:id', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const def = await prisma.contractFieldDefinition.findFirst({ where: { id, orgId } })
    if (!def) return reply.status(404).send({ detail: 'Field definition not found' })

    return reply.send(def)
  })

  // ── Update a field definition ─────────────────────────────────────────────
  app.patch('/:id', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = UpdateFieldSchema.parse(req.body)

    const existing = await prisma.contractFieldDefinition.findFirst({ where: { id, orgId } })
    if (!existing) return reply.status(404).send({ detail: 'Field definition not found' })

    const updated = await prisma.contractFieldDefinition.update({
      where: { id },
      data: body,
    })

    return reply.send(updated)
  })

  // ── Delete a field definition ─────────────────────────────────────────────
  app.delete('/:id', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const existing = await prisma.contractFieldDefinition.findFirst({ where: { id, orgId } })
    if (!existing) return reply.status(404).send({ detail: 'Field definition not found' })

    await prisma.contractFieldDefinition.delete({ where: { id } })

    return reply.status(204).send()
  })

  // ── Fill the field in on existing contracts (X2) ──────────────────────────
  // A field only reached contracts analysed after it existed. This queues the
  // backfill (lib/custom-field-backfill.ts); pressing again while it runs is a
  // no-op, after a pause or failure it resumes, after completion it re-scans
  // (contracts can have been added since).
  app.post('/:id/backfill', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const def = await prisma.contractFieldDefinition.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!def) return reply.status(404).send({ detail: 'Field definition not found' })

    const prior = def.backfill as BackfillState | null
    if (prior?.status !== 'RUNNING') {
      const backfill = { ...(prior && prior.status !== 'DONE' ? prior : {}), status: 'QUEUED', error: null, updatedAt: new Date().toISOString() }
      await prisma.contractFieldDefinition.update({ where: { id }, data: { backfill } })
    }
    await queueBackfillCustomField({ orgId, fieldDefinitionId: id })
    const fresh = await prisma.contractFieldDefinition.findUniqueOrThrow({ where: { id }, select: { backfill: true } })
    return reply.status(202).send({ backfill: fresh.backfill })
  })

  // ── Reorder field definitions ─────────────────────────────────────────────
  app.post('/reorder', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { order } = req.body as { order: Array<{ id: string; sortOrder: number }> }

    if (!Array.isArray(order)) return reply.status(400).send({ detail: 'order must be an array' })

    await Promise.all(
      order.map(({ id, sortOrder }) =>
        prisma.contractFieldDefinition.updateMany({
          where: { id, orgId },
          data: { sortOrder },
        }),
      ),
    )

    return reply.send({ updated: order.length })
  })
}
