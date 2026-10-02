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
import { previewField, estimateFill, type ExtractedField } from '../lib/field-preview.js'
import { callAgents } from '../lib/agents-call.js'
import { recordRunUsage, type RunUsage } from '../lib/extraction-job.js'
import { runStates } from '../lib/field-runs.js'
import { CostCapExceededError } from '../lib/costCap.js'
import { fieldRecords, setFieldCheck } from '../lib/field-attention.js'
import { CHECK_LEVELS } from '@clm/types'

// docs/39 D2 — money, lengths of time and rates, as values the store can compare.
export const FIELD_TYPES = ['text', 'longtext', 'number', 'currency', 'duration', 'percentage', 'date', 'boolean', 'select', 'multiselect'] as const

export const CreateFieldSchema = z.object({
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

type CreateField = z.infer<typeof CreateFieldSchema>

/**
 * A new field definition, checked as the admin route checks it. Shared with
 * the add of a suggested field (docs/39 C3, routes/field-suggestions.ts).
 */
export async function createFieldDefinition(orgId: string, body: CreateField): Promise<
  | { ok: true; def: Awaited<ReturnType<typeof prisma.contractFieldDefinition.create>> }
  | { ok: false; status: 409 | 422; detail: string }
> {
  // select/multiselect must have options
  if ((body.fieldType === 'select' || body.fieldType === 'multiselect') && !body.options.length) {
    return { ok: false, status: 422, detail: 'select and multiselect fields require at least one option' }
  }
  try {
    const def = await prisma.contractFieldDefinition.create({ data: { orgId, ...body, options: body.options } })
    return { ok: true, def }
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return { ok: false, status: 409, detail: `Field key "${body.fieldKey}" already exists for this org/type` }
    }
    throw err
  }
}

export async function fieldDefinitionRoutes(app: FastifyInstance) {
  // ── docs/39 B3/I2 — how often the AI is right about each field, and when
  // each field's values need a person (lib/field-attention.ts).
  app.get('/records', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    return reply.send({ fields: await fieldRecords(req.user.orgId) })
  })

  app.put('/checks', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const body = z.object({ key: z.string().min(1).max(64), level: z.enum(CHECK_LEVELS) }).parse(req.body ?? {})
    const r = await setFieldCheck({ orgId: req.user.orgId, userId: req.user.sub, key: body.key, level: body.level, ipAddress: req.ip })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    return reply.send({ key: body.key, level: r.level })
  })

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
      // createdAt breaks ties, so a field doesn't jump when it is updated.
      orderBy: [{ contractType: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    })

    // docs/39 D1 — a fill's undo, beside the field.
    const runIdOf = (d: { backfill: unknown }) => (d.backfill as BackfillState | null)?.runId ?? null
    const runs = await runStates(orgId, defs.map(runIdOf).filter((id): id is string => !!id))
    return reply.send({ data: defs.map(d => ({ ...d, fillRun: runs.get(runIdOf(d) ?? '') ?? null })) })
  })

  // ── Create a new field definition ─────────────────────────────────────────
  app.post('/', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const r = await createFieldDefinition(req.user.orgId, CreateFieldSchema.parse(req.body))
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    return reply.status(201).send(r.def)
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

  // ── docs/39 D1 — try the field on a few contracts, nothing saved ─────────
  app.post('/:id/preview', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = z.object({
      limit: z.number().int().min(1).max(10).default(5),
      // An improved description, tried before it is saved.
      helpText: z.string().max(512).optional(),
    }).parse(req.body ?? {})
    const def = await prisma.contractFieldDefinition.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!def) return reply.status(404).send({ detail: 'Field definition not found' })
    const results = await previewField(def, body, async ({ contractId, body: call }) => {
      const res = await callAgents('/extract-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
        body: JSON.stringify(call),
      }, { orgId, toolName: 'field_preview', scope: contractId, contractId, estimate: false }).catch((err: Error) => {
        // Said so an admin can act on it: the preview shows it beside the contract.
        if (err instanceof CostCapExceededError) throw new Error('today’s AI budget is used up')
        throw new Error(err.message === 'fetch failed' ? 'the AI service didn’t answer' : err.message)
      })
      if (!res.ok) throw new Error(`the AI service answered ${res.status}`)
      const out = await res.json() as { customFields?: Record<string, ExtractedField>; usage?: RunUsage }
      await recordRunUsage(orgId, out.usage, { inputChars: JSON.stringify(call).length, outputChars: JSON.stringify(out).length }, 'field_preview')
      return out.customFields ?? null
    })
    return reply.send({ results, found: results.filter(r => r.value !== null).length, tried: results.length })
  })

  // ── docs/39 D1 — how many contracts a fill would read, and about its cost ─
  app.get('/:id/backfill/estimate', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const def = await prisma.contractFieldDefinition.findFirst({ where: { id, orgId: req.user.orgId, deletedAt: null } })
    if (!def) return reply.status(404).send({ detail: 'Field definition not found' })
    return reply.send(await estimateFill(def))
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
    // docs/39 D5 — 'recheck' reads again the values the AI found as well.
    const { mode } = z.object({ mode: z.enum(['fill', 'recheck']).default('fill') }).parse(req.body ?? {})

    const prior = def.backfill as BackfillState | null
    if (prior?.status !== 'RUNNING') {
      const resumable = prior && prior.status !== 'DONE' && (prior.mode ?? 'fill') === mode
      const backfill = { ...(resumable ? prior : {}), mode, status: 'QUEUED', error: null, updatedAt: new Date().toISOString() }
      await prisma.contractFieldDefinition.update({ where: { id }, data: { backfill } })
    }
    await queueBackfillCustomField({ orgId, fieldDefinitionId: id, mode })
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
