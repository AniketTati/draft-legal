/**
 * Clause types (docs/39 E3) — the organization's own beside the built-in
 * ones; see lib/clause-types.ts.
 *
 *   GET    /api/v1/clause-types                every type: the built-in ones, then the org's
 *   POST   /api/v1/clause-types                { label, description?, examples? }
 *   PATCH  /api/v1/clause-types/:id            { label?, description?, examples? }
 *   DELETE /api/v1/clause-types/:id            clauses already tagged with it keep it
 *   POST   /api/v1/clause-types/:id/preview    { contractId } → what the AI finds there; nothing saved
 *   POST   /api/v1/clause-types/:id/detect     find it in the contracts read before it
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { CLAUSE_TYPE_LABELS } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  orgClauseTypes, customKeyOf, findInContract, examplesOf,
  CUSTOM_CLAUSE_TYPES_MAX, CLAUSE_EXAMPLES_MAX, CLAUSE_EXAMPLE_MAX_CHARS, type DetectState,
} from '../lib/clause-types.js'
import { agentsFindClause } from '../lib/clause-type-agents.js'
import { queueDetectClauseType } from '../lib/queue.js'
import { CostCapExceededError } from '../lib/costCap.js'

const Examples = z.array(z.string().trim().min(12, 'An example is a passage of a contract: a sentence at least').max(CLAUSE_EXAMPLE_MAX_CHARS))
  .max(CLAUSE_EXAMPLES_MAX, `At most ${CLAUSE_EXAMPLES_MAX} examples`)
const CreateSchema = z.object({
  label:       z.string().trim().min(2).max(80),
  description: z.string().trim().max(1000).default(''),
  examples:    Examples.default([]),
})
const UpdateSchema = CreateSchema.partial()

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export async function clauseTypeRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    return reply.send({ clauseTypes: await orgClauseTypes(req.user.orgId), max: CUSTOM_CLAUSE_TYPES_MAX })
  })

  app.post('/', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const body = CreateSchema.parse(req.body)
    if (Object.values(CLAUSE_TYPE_LABELS).some(l => sameName(l, body.label))) {
      return reply.status(409).send({ detail: `“${body.label}” is already a clause type the AI finds.` })
    }
    const existing = await prisma.clauseTypeDefinition.findMany({ where: { orgId, deletedAt: null }, select: { label: true } })
    if (existing.some(e => sameName(e.label, body.label))) {
      return reply.status(409).send({ detail: `There's already a clause type called “${body.label}”.` })
    }
    if (existing.length >= CUSTOM_CLAUSE_TYPES_MAX) {
      return reply.status(422).send({ detail: `An organization can add at most ${CUSTOM_CLAUSE_TYPES_MAX} clause types of its own.` })
    }
    const key = customKeyOf(body.label)
    // A type deleted before, under the same name, comes back.
    const def = await prisma.clauseTypeDefinition.upsert({
      where: { orgId_key: { orgId, key } },
      create: { orgId, key, label: body.label, description: body.description, examples: body.examples, createdById: userId },
      update: { label: body.label, description: body.description, examples: body.examples, deletedAt: null, detect: Prisma.JsonNull },
    })
    return reply.status(201).send({ clauseType: { id: def.id, key: def.key, label: def.label, description: def.description || null, examples: examplesOf(def.examples), custom: true, detect: null } })
  })

  app.patch('/:id', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = UpdateSchema.parse(req.body)
    const def = await prisma.clauseTypeDefinition.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!def) return reply.status(404).send({ detail: 'Clause type not found' })
    if (body.label && !sameName(body.label, def.label)) {
      const clash = Object.values(CLAUSE_TYPE_LABELS).some(l => sameName(l, body.label!))
        || !!await prisma.clauseTypeDefinition.findFirst({ where: { orgId, deletedAt: null, id: { not: id }, label: { equals: body.label, mode: 'insensitive' } }, select: { id: true } })
      if (clash) return reply.status(409).send({ detail: `There's already a clause type called “${body.label}”.` })
    }
    // Its key stays: the clauses tagged with it keep their type.
    const updated = await prisma.clauseTypeDefinition.update({ where: { id }, data: body })
    return reply.send({ clauseType: { id: updated.id, key: updated.key, label: updated.label, description: updated.description || null, examples: examplesOf(updated.examples), custom: true, detect: updated.detect ?? null } })
  })

  app.delete('/:id', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const def = await prisma.clauseTypeDefinition.findFirst({ where: { id, orgId: req.user.orgId, deletedAt: null } })
    if (!def) return reply.status(404).send({ detail: 'Clause type not found' })
    await prisma.clauseTypeDefinition.update({ where: { id }, data: { deletedAt: new Date() } })
    return reply.status(204).send()
  })

  // ── What the AI finds in one contract, nothing saved ─────────────────────
  app.post('/:id/preview', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { contractId, description, examples } = z.object({
      contractId: z.string().min(1),
      // Tried before they're saved.
      description: z.string().trim().max(1000).optional(),
      examples: Examples.optional(),
    }).parse(req.body)
    const def = await prisma.clauseTypeDefinition.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!def) return reply.status(404).send({ detail: 'Clause type not found' })
    try {
      const found = await findInContract(
        { ...def, ...(description !== undefined && { description }), ...(examples && { examples }) },
        contractId, agentsFindClause('clause_preview'),
      )
      if (!found) return reply.status(422).send({ detail: 'That contract has no text to read yet.' })
      return reply.send({ clauses: found.clauses })
    } catch (err) {
      if (err instanceof CostCapExceededError) return reply.status(429).send({ detail: 'Today’s AI budget is used up.' })
      return reply.status(502).send({ detail: `Couldn’t read it: ${(err as Error).message}` })
    }
  })

  // ── Find it in the contracts read before it existed ─────────────────────
  app.post('/:id/detect', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const def = await prisma.clauseTypeDefinition.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!def) return reply.status(404).send({ detail: 'Clause type not found' })
    const prior = def.detect as DetectState | null
    // Pressing again while it runs does nothing; after a pause it resumes; after it finished, it reads again.
    if (prior?.status !== 'RUNNING' && prior?.status !== 'QUEUED') {
      const now = new Date().toISOString()
      const detect: DetectState = {
        ...(prior?.status === 'PAUSED' ? prior : { total: 0, processed: 0, found: 0, failed: 0, cursor: null, startedAt: now }),
        status: 'QUEUED', error: null, updatedAt: now,
      } as DetectState
      await prisma.clauseTypeDefinition.update({ where: { id }, data: { detect: detect as unknown as Prisma.InputJsonValue } })
      queueDetectClauseType({ orgId, definitionId: id })
    }
    const fresh = await prisma.clauseTypeDefinition.findUniqueOrThrow({ where: { id }, select: { detect: true } })
    return reply.status(202).send({ detect: fresh.detect })
  })
}
