/**
 * Clause families — docs/41 Part 1 and §6.2.
 *
 * A family is one clause the org has approved alternatives for (Governing
 * law), each alternative a library clause (a variant): its words, the names a
 * request may call it by ("New York", "NY"), and an optional condition that
 * picks it for a draft. One variant may be the family's default. A template
 * slot points at the family, so variants can change without touching the
 * templates; publishing a template pins the variants as they are then.
 *
 * Variants are library clauses, so a playbook position can point at one
 * (PlaybookPosition.libraryItemId) — one clause model, not two.
 */
import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AuditAction, isClauseCondition, resolveSlot, type ConditionFacts } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { recordClauseVersion, updateClauseItem } from '../lib/clause-library-versions.js'
import { asSlotVariant } from '../lib/template-snapshot.js'
import { createAuditEvent } from '../lib/audit.js'

const Condition = z.unknown().refine(c => c === null || isClauseCondition(c), 'Not a valid condition')

const CreateFamilySchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(1024).nullish(),
  categoryId: z.string().max(64).nullish(),
  requestKey: z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_.]*$/).nullish(),
})
const UpdateFamilySchema = CreateFamilySchema.partial()

const VariantSchema = z.object({
  /** Attach a clause already in the library instead of writing a new one. */
  itemId: z.string().max(64).optional(),
  title: z.string().trim().min(1).max(256).optional(),
  variantLabel: z.string().trim().min(1).max(128).optional(),
  content: z.string().max(100_000).optional(),
  condition: Condition.optional(),
  matchValues: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  isFamilyDefault: z.boolean().optional(),
  isApproved: z.boolean().optional(),
  variantOrder: z.number().int().min(0).max(10_000).optional(),
  changeNote: z.string().max(512).optional(),
})

const PreviewSchema = z.object({
  /** Facts the conditions test, e.g. { "counterparty.country": "GB", value: 300000 }. */
  facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** A value the request names for the family's key (governingLaw: "New York"). */
  requestValue: z.string().max(256).optional(),
})

const familyInclude = {
  category: { select: { id: true, name: true } },
  variants: {
    where: { deletedAt: null },
    orderBy: [{ variantOrder: 'asc' as const }, { createdAt: 'asc' as const }],
    select: {
      id: true, title: true, variantLabel: true, content: true, condition: true, matchValues: true,
      isFamilyDefault: true, isApproved: true, variantOrder: true, version: true, updatedAt: true,
    },
  },
  _count: { select: { slots: { where: { template: { deletedAt: null } } } } },
} satisfies Prisma.ClauseFamilyInclude

export async function clauseFamilyRoutes(app: FastifyInstance) {
  // ── List families with their variants ─────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'clause') }, async (req, reply) => {
    const { orgId } = req.user
    const families = await prisma.clauseFamily.findMany({
      where: { orgId, deletedAt: null },
      include: familyInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })
    return reply.send({ data: families.map(({ _count, ...f }) => ({ ...f, templateCount: _count.slots })) })
  })

  app.get('/:id', { preHandler: requirePermission('view', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const family = await prisma.clauseFamily.findFirst({ where: { id, orgId, deletedAt: null }, include: familyInclude })
    if (!family) return reply.status(404).send({ detail: 'Clause family not found' })
    const { _count, ...rest } = family
    return reply.send({ ...rest, templateCount: _count.slots })
  })

  // ── Create / update / delete a family ─────────────────────────────────────
  app.post('/', { preHandler: requirePermission('create', 'clause') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const body = CreateFamilySchema.parse(req.body ?? {})
    if (body.categoryId && !await prisma.clauseCategory.findFirst({ where: { id: body.categoryId, orgId }, select: { id: true } })) {
      return reply.status(404).send({ detail: 'Category not found' })
    }
    if (await prisma.clauseFamily.findFirst({ where: { orgId, deletedAt: null, name: { equals: body.name, mode: 'insensitive' } }, select: { id: true } })) {
      return reply.status(409).send({ detail: `There is already a clause family called “${body.name}”.` })
    }
    const family = await prisma.clauseFamily.create({
      data: { orgId, createdById: userId, name: body.name, description: body.description ?? null, categoryId: body.categoryId ?? null, requestKey: body.requestKey ?? null },
      include: familyInclude,
    })
    const { _count, ...rest } = family
    return reply.status(201).send({ ...rest, templateCount: _count.slots })
  })

  app.patch('/:id', { preHandler: requirePermission('edit', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = UpdateFamilySchema.parse(req.body ?? {})
    const existing = await prisma.clauseFamily.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } })
    if (!existing) return reply.status(404).send({ detail: 'Clause family not found' })
    if (body.categoryId && !await prisma.clauseCategory.findFirst({ where: { id: body.categoryId, orgId }, select: { id: true } })) {
      return reply.status(404).send({ detail: 'Category not found' })
    }
    await prisma.clauseFamily.update({ where: { id }, data: body })
    const { _count, ...rest } = await prisma.clauseFamily.findFirstOrThrow({ where: { id, orgId }, include: familyInclude })
    return reply.send({ ...rest, templateCount: _count.slots })
  })

  app.delete('/:id', { preHandler: requirePermission('delete', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const existing = await prisma.clauseFamily.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } })
    if (!existing) return reply.status(404).send({ detail: 'Clause family not found' })
    const used = await prisma.templateSection.count({ where: { slotFamilyId: id, template: { orgId, deletedAt: null } } })
    if (used) return reply.status(409).send({ detail: `${used} template section${used === 1 ? ' uses' : 's use'} this family. Replace those clause slots first.` })
    await prisma.$transaction([
      prisma.clauseLibraryItem.updateMany({ where: { orgId, familyId: id }, data: { familyId: null, isFamilyDefault: false } }),
      prisma.clauseFamily.update({ where: { id }, data: { deletedAt: new Date() } }),
    ])
    return reply.status(204).send()
  })

  // ── Variants ──────────────────────────────────────────────────────────────
  // Add a variant: a new clause, or one already in the library attached.
  app.post('/:id/variants', { preHandler: requirePermission('edit', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = VariantSchema.parse(req.body ?? {})
    const family = await prisma.clauseFamily.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!family) return reply.status(404).send({ detail: 'Clause family not found' })

    let itemId: string
    if (body.itemId) {
      const item = await prisma.clauseLibraryItem.findFirst({ where: { id: body.itemId, orgId, deletedAt: null } })
      if (!item) return reply.status(404).send({ detail: 'Clause not found' })
      if (item.familyId && item.familyId !== id) return reply.status(409).send({ detail: 'That clause already belongs to another family.' })
      await updateClauseItem({
        orgId, id: item.id, userId, note: body.changeNote ?? 'Added to a clause family',
        data: {
          familyId: id,
          ...(body.variantLabel !== undefined && { variantLabel: body.variantLabel }),
          ...(body.condition !== undefined && { condition: (body.condition ?? null) as Prisma.InputJsonValue }),
          ...(body.matchValues !== undefined && { matchValues: body.matchValues }),
          ...(body.variantOrder !== undefined && { variantOrder: body.variantOrder }),
          ...(body.isApproved !== undefined && { isApproved: body.isApproved }),
        },
      })
      itemId = item.id
    } else {
      const categoryId = family.categoryId
        ?? (await prisma.clauseCategory.findFirst({ where: { orgId }, orderBy: { sortOrder: 'asc' }, select: { id: true } }))?.id
      if (!categoryId) return reply.status(422).send({ detail: 'Create a clause category first.' })
      if (!body.variantLabel || !body.content?.trim()) return reply.status(400).send({ detail: 'A new variant needs a name and its words.' })
      const item = await prisma.clauseLibraryItem.create({
        data: {
          orgId, categoryId, createdById: userId, familyId: id,
          title: body.title ?? `${family.name} — ${body.variantLabel}`,
          variantLabel: body.variantLabel,
          content: body.content,
          condition: (body.condition ?? undefined) as Prisma.InputJsonValue | undefined,
          matchValues: body.matchValues ?? [],
          variantOrder: body.variantOrder ?? await prisma.clauseLibraryItem.count({ where: { orgId, familyId: id, deletedAt: null } }),
          isApproved: body.isApproved ?? false,
          versions: [{ version: 1, content: body.content, changedById: userId, changedAt: new Date().toISOString(), note: 'Initial version' }],
        },
      })
      await recordClauseVersion(prisma, item, userId, 'Initial version')
      itemId = item.id
    }
    if (body.isFamilyDefault) await setDefault(orgId, id, itemId)
    await createAuditEvent({ orgId, userId, action: AuditAction.CLAUSE_FAMILY_CHANGED, resourceType: 'clause_family', resourceId: id, metadata: { variantAdded: itemId } }).catch(() => {})
    return reply.status(201).send(await variantOut(orgId, itemId))
  })

  // Edit a variant. A change of its words, condition or names is a new version.
  app.patch('/:id/variants/:itemId', { preHandler: requirePermission('edit', 'clause') }, async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string }
    const { orgId, sub: userId } = req.user
    const body = VariantSchema.omit({ itemId: true }).parse(req.body ?? {})
    const item = await prisma.clauseLibraryItem.findFirst({ where: { id: itemId, orgId, familyId: id, deletedAt: null }, select: { id: true } })
    if (!item) return reply.status(404).send({ detail: 'Variant not found' })
    await updateClauseItem({
      orgId, id: itemId, userId, note: body.changeNote ?? null,
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.variantLabel !== undefined && { variantLabel: body.variantLabel }),
        ...(body.content !== undefined && { content: body.content }),
        ...(body.condition !== undefined && { condition: (body.condition ?? null) as Prisma.InputJsonValue }),
        ...(body.matchValues !== undefined && { matchValues: body.matchValues }),
        ...(body.variantOrder !== undefined && { variantOrder: body.variantOrder }),
        ...(body.isApproved !== undefined && { isApproved: body.isApproved }),
        ...(body.isFamilyDefault === false && { isFamilyDefault: false }),
      },
    })
    if (body.isFamilyDefault) await setDefault(orgId, id, itemId)
    await createAuditEvent({ orgId, userId, action: AuditAction.CLAUSE_FAMILY_CHANGED, resourceType: 'clause_family', resourceId: id, metadata: { variantChanged: itemId } }).catch(() => {})
    return reply.send(await variantOut(orgId, itemId))
  })

  // Take a variant out of the family (the clause stays in the library).
  app.delete('/:id/variants/:itemId', { preHandler: requirePermission('edit', 'clause') }, async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string }
    const { orgId } = req.user
    const item = await prisma.clauseLibraryItem.findFirst({ where: { id: itemId, orgId, familyId: id, deletedAt: null }, select: { id: true } })
    if (!item) return reply.status(404).send({ detail: 'Variant not found' })
    await prisma.clauseLibraryItem.update({ where: { id: itemId }, data: { familyId: null, isFamilyDefault: false } })
    return reply.status(204).send()
  })

  // Mark the family's default (null: no default — drafts ask unless a rule decides).
  app.put('/:id/default', { preHandler: requirePermission('edit', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const { variantId } = z.object({ variantId: z.string().max(64).nullable() }).parse(req.body ?? {})
    const family = await prisma.clauseFamily.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } })
    if (!family) return reply.status(404).send({ detail: 'Clause family not found' })
    if (variantId) {
      const v = await prisma.clauseLibraryItem.findFirst({ where: { id: variantId, orgId, familyId: id, deletedAt: null }, select: { isApproved: true } })
      if (!v) return reply.status(404).send({ detail: 'Variant not found' })
      if (!v.isApproved) return reply.status(422).send({ detail: 'Approve this wording before making it the default.' })
      await setDefault(orgId, id, variantId)
    } else {
      await prisma.clauseLibraryItem.updateMany({ where: { orgId, familyId: id }, data: { isFamilyDefault: false } })
    }
    await createAuditEvent({ orgId, userId, action: AuditAction.CLAUSE_FAMILY_CHANGED, resourceType: 'clause_family', resourceId: id, metadata: { defaultVariant: variantId } }).catch(() => {})
    const { _count, ...rest } = await prisma.clauseFamily.findFirstOrThrow({ where: { id, orgId }, include: familyInclude })
    return reply.send({ ...rest, templateCount: _count.slots })
  })

  // Which variant drafting would pick for these facts (the condition builder's preview).
  app.post('/:id/preview', { preHandler: requirePermission('view', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = PreviewSchema.parse(req.body ?? {})
    const family = await prisma.clauseFamily.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { variants: { where: { deletedAt: null, isApproved: true }, orderBy: [{ variantOrder: 'asc' }, { createdAt: 'asc' }] } },
    })
    if (!family) return reply.status(404).send({ detail: 'Clause family not found' })
    const decision = resolveSlot({
      family: { id: family.id, name: family.name, requestKey: family.requestKey },
      variants: family.variants.map(asSlotVariant),
      requestValues: family.requestKey && body.requestValue ? { [family.requestKey]: { value: body.requestValue } } : {},
      facts: body.facts as ConditionFacts,
    })
    return reply.send(decision)
  })
}

/** Make one variant the family's default: the others stop being it first (one default, enforced by the index too). */
async function setDefault(orgId: string, familyId: string, itemId: string) {
  await prisma.$transaction([
    prisma.clauseLibraryItem.updateMany({ where: { orgId, familyId, isFamilyDefault: true, NOT: { id: itemId } }, data: { isFamilyDefault: false } }),
    prisma.clauseLibraryItem.update({ where: { id: itemId }, data: { isFamilyDefault: true } }),
  ])
}

async function variantOut(orgId: string, itemId: string) {
  return prisma.clauseLibraryItem.findFirst({
    where: { id: itemId, orgId },
    select: {
      id: true, familyId: true, title: true, variantLabel: true, content: true, condition: true, matchValues: true,
      isFamilyDefault: true, isApproved: true, variantOrder: true, version: true, updatedAt: true,
    },
  })
}
