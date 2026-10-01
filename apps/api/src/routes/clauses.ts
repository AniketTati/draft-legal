/**
 * Clause Library API — Phase 4.1
 *
 * CRUD for clause categories (tree) and clause library items.
 * Clauses are reusable contract language snippets organized by category.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { clauseTypeLabel } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { recordClauseVersion, updateClauseItem } from '../lib/clause-library-versions.js'

// ─── Schemas ────────────────────────────────────────────────────────────────

const CreateCategorySchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
  parentCategoryId: z.string().nullable().optional(),
  sortOrder: z.number().int().default(0),
  // docs/41 P0.3 — presence rule: whether contracts of these types must have it.
  presence: z.enum(['required', 'not_allowed', 'optional']).optional(),
  presenceContractTypes: z.array(z.string().min(1).max(64)).max(32).optional(),
})

const UpdateCategorySchema = CreateCategorySchema.partial()

const CreateClauseSchema = z.object({
  categoryId: z.string().min(1),
  title: z.string().min(1).max(256),
  content: z.string().default(''),
  tags: z.array(z.string()).default([]),
  riskRating: z.enum(['favorable', 'unfavorable', 'neutral', 'standard']).nullish(),
  isApproved: z.boolean().default(false),
})

const UpdateClauseSchema = CreateClauseSchema.partial().omit({ categoryId: true })

// docs/39 E4 — wording a reader saves from a contract.
const FromContractSchema = z.object({
  contractId: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(20_000),
  title: z.string().trim().min(1).max(256),
  categoryId: z.string().min(1).max(64).optional(),
  /** The clause type the words read as, to file it under (when no category is picked). */
  clauseType: z.string().max(64).optional(),
  section: z.string().trim().max(64).optional(),
})

/** Where saved wording goes when nothing better fits. */
const SAVED_CATEGORY = 'Saved from contracts'

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Plain text as the library's HTML: a paragraph per blank-line-separated block. */
function asHtml(text: string): string {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
}

/** Text compared as wording: case, spacing and punctuation aside. */
const wording = (s: string) => s.replace(/<[^>]+>/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Each item with the contract its wording came from, when there is one (E4). */
async function withSources<T extends { sourceContractId: string | null }>(orgId: string, items: T[]): Promise<Array<T & { sourceContract: { id: string; title: string } | null }>> {
  const ids = [...new Set(items.map(i => i.sourceContractId).filter((id): id is string => !!id))]
  const contracts = ids.length
    ? await prisma.contract.findMany({ where: { id: { in: ids }, orgId, deletedAt: null }, select: { id: true, title: true } })
    : []
  const byId = new Map(contracts.map(c => [c.id, c]))
  return items.map(i => ({ ...i, sourceContract: i.sourceContractId ? byId.get(i.sourceContractId) ?? null : null }))
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

export async function clauseRoutes(app: FastifyInstance) {
  // ═══════════════════════════════════════════════════════════════════════════
  // CLAUSE CATEGORIES
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Get full category tree ────────────────────────────────────────────────
  app.get('/categories', { preHandler: requirePermission('view', 'clause') }, async (req, reply) => {
    const { orgId } = req.user

    const categories = await prisma.clauseCategory.findMany({
      where: { orgId },
      orderBy: [{ parentCategoryId: 'asc' }, { sortOrder: 'asc' }],
    })

    // Build tree structure
    const map = new Map(categories.map(c => [c.id, { ...c, children: [] as any[] }]))
    const roots: any[] = []

    for (const cat of map.values()) {
      if (cat.parentCategoryId) {
        const parent = map.get(cat.parentCategoryId)
        if (parent) parent.children.push(cat)
      } else {
        roots.push(cat)
      }
    }

    return reply.send({ data: roots })
  })

  // ── Create category ───────────────────────────────────────────────────────
  app.post('/categories', { preHandler: requirePermission('create', 'clause') }, async (req, reply) => {
    const { orgId } = req.user
    const body = CreateCategorySchema.parse(req.body)

    const category = await prisma.clauseCategory.create({
      data: { orgId, ...body },
    })

    return reply.status(201).send(category)
  })

  // ── Update category ───────────────────────────────────────────────────────
  app.patch('/categories/:id', { preHandler: requirePermission('edit', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = UpdateCategorySchema.parse(req.body)

    const existing = await prisma.clauseCategory.findFirst({ where: { id, orgId } })
    if (!existing) return reply.status(404).send({ detail: 'Category not found' })

    const updated = await prisma.clauseCategory.update({ where: { id }, data: body })
    return reply.send(updated)
  })

  // ── Delete category ───────────────────────────────────────────────────────
  app.delete('/categories/:id', { preHandler: requirePermission('delete', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const existing = await prisma.clauseCategory.findFirst({ where: { id, orgId } })
    if (!existing) return reply.status(404).send({ detail: 'Category not found' })

    // Prevent deletion if category has items or children
    const childCount = await prisma.clauseCategory.count({ where: { parentCategoryId: id } })
    const itemCount = await prisma.clauseLibraryItem.count({ where: { categoryId: id, deletedAt: null } })

    if (childCount > 0 || itemCount > 0) {
      return reply.status(409).send({
        detail: `Cannot delete category with ${childCount} sub-categories and ${itemCount} clauses`,
      })
    }

    await prisma.clauseCategory.delete({ where: { id } })
    return reply.status(204).send()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // CLAUSE LIBRARY ITEMS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── List clauses ──────────────────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'clause') }, async (req, reply) => {
    const { orgId } = req.user
    const query = req.query as {
      categoryId?: string
      tag?: string
      riskRating?: string
      approved?: string
      q?: string
      limit?: string
      offset?: string
    }

    const where: any = {
      orgId,
      deletedAt: null,
      ...(query.categoryId && { categoryId: query.categoryId }),
      ...(query.riskRating && { riskRating: query.riskRating }),
      ...(query.approved !== undefined && { isApproved: query.approved === 'true' }),
      ...(query.tag && { tags: { has: query.tag } }),
      ...(query.q && {
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { content: { contains: query.q, mode: 'insensitive' } },
        ],
      }),
    }

    const [clauses, total] = await Promise.all([
      prisma.clauseLibraryItem.findMany({
        where,
        include: { category: { select: { id: true, name: true } } },
        orderBy: [{ categoryId: 'asc' }, { title: 'asc' }],
        take: Number(query.limit ?? 100),
        skip: Number(query.offset ?? 0),
      }),
      prisma.clauseLibraryItem.count({ where }),
    ])

    return reply.send({ data: await withSources(orgId, clauses), total })
  })

  // ── Get single clause ─────────────────────────────────────────────────────
  app.get('/:id', { preHandler: requirePermission('view', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const clause = await prisma.clauseLibraryItem.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { category: { select: { id: true, name: true } } },
    })

    if (!clause) return reply.status(404).send({ detail: 'Clause not found' })
    return reply.send((await withSources(orgId, [clause]))[0])
  })

  // ── docs/41 Part 1 — a clause's words at every version ────────────────────
  app.get('/:id/versions', { preHandler: requirePermission('view', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const clause = await prisma.clauseLibraryItem.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true, version: true } })
    if (!clause) return reply.status(404).send({ detail: 'Clause not found' })
    const versions = await prisma.clauseLibraryVersion.findMany({
      where: { orgId, itemId: id },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, title: true, content: true, variantLabel: true, condition: true, matchValues: true, note: true, createdById: true, createdAt: true },
    })
    return reply.send({ current: clause.version, data: versions })
  })

  // ── docs/39 E4 — save wording from a contract ─────────────────────────────
  // Unapproved until someone who approves clauses does; it keeps the contract
  // (and section) it came from. The same wording already in the library is
  // returned instead of a copy.
  app.post('/from-contract', { preHandler: requirePermission('create', 'clause') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const body = FromContractSchema.parse(req.body ?? {})
    // The reader must be able to see the contract (an own-scope reader, only theirs).
    const scope = await permissionScopeFor(req, 'view', 'contract')
    if (!scope) return reply.status(403).send({ detail: 'You can’t see this contract' })
    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId, deletedAt: null, ...(scope === 'own' ? { ownerId: userId } : {}) },
      select: { id: true, title: true, currentVersionId: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const same = await prisma.clauseLibraryItem.findMany({
      where: { orgId, deletedAt: null, content: { contains: body.text.slice(0, 40).replace(/\s+/g, ' ').split(' ').slice(0, 3).join(' '), mode: 'insensitive' } },
      include: { category: { select: { id: true, name: true } } },
      take: 50,
    })
    const existing = same.find(c => wording(c.content) === wording(body.text))
    if (existing) return reply.send({ clause: (await withSources(orgId, [existing]))[0], duplicate: true })

    let categoryId = body.categoryId
    if (categoryId) {
      if (!await prisma.clauseCategory.findFirst({ where: { id: categoryId, orgId }, select: { id: true } })) {
        return reply.status(404).send({ detail: 'Category not found' })
      }
    } else {
      const wanted = body.clauseType ? clauseTypeLabel(body.clauseType) : null
      const cats = await prisma.clauseCategory.findMany({ where: { orgId }, select: { id: true, name: true } })
      const match = wanted ? cats.find(c => c.name.toLowerCase() === wanted.toLowerCase()) : undefined
      categoryId = match?.id ?? cats.find(c => c.name === SAVED_CATEGORY)?.id
        ?? (await prisma.clauseCategory.create({ data: { orgId, name: SAVED_CATEGORY, description: 'Wording saved from contracts, to sort and approve.' } })).id
    }

    const content = asHtml(body.text)
    const note = `Saved from “${contract.title}”${body.section ? ` §${body.section}` : ''}`
    const clause = await prisma.clauseLibraryItem.create({
      data: {
        orgId, createdById: userId, categoryId, title: body.title, content, isApproved: false,
        sourceContractId: contract.id, sourceVersionId: contract.currentVersionId, sourceSection: body.section ?? null,
        versions: [{ version: 1, content, changedById: userId, changedAt: new Date().toISOString(), note }],
      },
      include: { category: { select: { id: true, name: true } } },
    })
    await recordClauseVersion(prisma, clause, userId, note)
    return reply.status(201).send({ clause: { ...clause, sourceContract: { id: contract.id, title: contract.title } }, duplicate: false })
  })

  // ── Create clause ─────────────────────────────────────────────────────────
  app.post('/', { preHandler: requirePermission('create', 'clause') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const body = CreateClauseSchema.parse(req.body)

    // Verify category belongs to this org
    const category = await prisma.clauseCategory.findFirst({
      where: { id: body.categoryId, orgId },
    })
    if (!category) return reply.status(404).send({ detail: 'Category not found' })

    const clause = await prisma.clauseLibraryItem.create({
      data: {
        orgId,
        createdById: userId,
        ...body,
        versions: [
          { version: 1, content: body.content, changedById: userId, changedAt: new Date().toISOString(), note: 'Initial version' },
        ],
      },
      include: { category: { select: { id: true, name: true } } },
    })
    // docs/41 Part 1 — its words, kept as version 1.
    await recordClauseVersion(prisma, clause, userId, 'Initial version')

    return reply.status(201).send(clause)
  })

  // ── Update clause ─────────────────────────────────────────────────────────
  app.patch('/:id', { preHandler: requirePermission('edit', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = UpdateClauseSchema.parse(req.body)

    const existing = await prisma.clauseLibraryItem.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Clause not found' })

    // docs/41 Part 1 — a change of its words is a new, immutable version
    // (templates pin the version they were published with).
    await updateClauseItem({ orgId, id, userId, data: body, note: (req.body as { changeNote?: string }).changeNote ?? '' })
    const updated = await prisma.clauseLibraryItem.findFirst({
      where: { id, orgId },
      include: { category: { select: { id: true, name: true } } },
    })

    return reply.send(updated)
  })

  // ── Approve / unapprove clause ────────────────────────────────────────────
  app.post('/:id/approve', { preHandler: requirePermission('edit', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { approved = true } = (req.body as { approved?: boolean }) ?? {}

    const existing = await prisma.clauseLibraryItem.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Clause not found' })

    const updated = await prisma.clauseLibraryItem.update({
      where: { id },
      data: { isApproved: approved },
    })

    return reply.send(updated)
  })

  // ── Delete clause (soft) ──────────────────────────────────────────────────
  app.delete('/:id', { preHandler: requirePermission('delete', 'clause') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const existing = await prisma.clauseLibraryItem.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Clause not found' })

    await prisma.clauseLibraryItem.update({ where: { id }, data: { deletedAt: new Date() } })
    return reply.status(204).send()
  })

}
