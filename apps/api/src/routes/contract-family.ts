/**
 * A contract and the agreement it belongs to (docs/39 G3) — see
 * lib/contract-family.ts and field-store applyAmendmentValues.
 *
 *   GET  /api/v1/contracts/:id/parent-suggestions         what it reads as, and the agreements it likely belongs to
 *   PUT  /api/v1/contracts/:id/parent                     { parentContractId: string | null, relationshipType? }
 *   GET  /api/v1/contracts/:id/amendment-changes          the parent's terms it changes
 *   POST /api/v1/contracts/:id/amendment-changes/apply    { keys, supersedeObligationIds? } — set them on the parent (undo: POST /field-runs/:id/undo)
 *
 * docs/41 Part 13 — the family and amendments:
 *   GET  /api/v1/contracts/:id/family-tree                the whole family, from the top agreement down
 *   GET  /api/v1/contracts/:id/effective                  the agreement as its signed amendments left it
 *   GET  /api/v1/contracts/:id/term-history               each amended term's values, the original first
 *   PUT  /api/v1/contracts/:id/amendment-number           { amendmentNumber } — renumber ("Amendment No. 2")
 *   POST /api/v1/contracts/:id/amendment-language         { items: [{ clauseId, instruction }] } — AI drafts of new words (on the parent)
 *   GET  /api/v1/contracts/:id/amendment-redline          an amendment's changes against the parent's words in effect
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
import { familyTree, effectiveView, amendmentSpecOf, nextFamilyNumber } from '../lib/family.js'
import { recordRollUp, termHistory } from '../lib/term-history.js'
import { amendmentRedlineItems, draftAmendmentLanguage, obligationsReplaced, proposedTextsFromHtml } from '../lib/amendments.js'
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
    // docs/41 Part 13 — numbered per agreement when it joins one (or moves to another).
    const amendmentNumber = body.parentContractId && body.parentContractId !== c.parentContractId
      ? await nextFamilyNumber(orgId, body.parentContractId, relationshipType)
      : body.parentContractId ? undefined : null
    await prisma.contract.update({ where: { id }, data: { parentContractId: body.parentContractId, relationshipType, amendmentNumber } })
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
      select: { parentContractId: true, relationshipType: true, metadata: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const parent = c.parentContractId
      ? await prisma.contract.findFirst({ where: { id: c.parentContractId, orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true, title: true } })
      : null
    if (!parent) return reply.send({ parent: null, relationshipType: c.relationshipType, changes: [], obligations: [], lastRun: null })
    // docs/41 Part 13 — the parent's obligations from the clauses this
    // amendment replaces or deletes: the person confirms which are no longer owed.
    const spec = amendmentSpecOf(c.metadata)
    const owed = spec?.changes.some(ch => ch.kind === 'clause')
      ? await prisma.obligation.findMany({
        where: { orgId, contractId: parent.id, OR: [{ supersededById: null }, { supersededById: id }] },
        select: { id: true, description: true, quote: true, sectionRef: true, status: true, supersededById: true },
        take: 500,
      })
      : []
    const obligations = spec ? obligationsReplaced(owed, spec.changes).map(o => ({ ...o, superseded: o.supersededById === id })) : []
    // The latest roll-up from this amendment still to be undone, so the undo outlives the page.
    const [run] = await prisma.$queryRaw<Array<{ id: string; createdAt: Date; count: number }>>`
      SELECT id, "createdAt", jsonb_array_length(changes)::int AS count FROM field_value_runs
       WHERE "orgId" = ${orgId} AND kind = 'rollup' AND "contractId" = ${parent.id} AND "undoneAt" IS NULL
         AND "createdAt" > ${new Date(Date.now() - UNDO_DAYS * 24 * 60 * 60 * 1000)} AND changes @> ${JSON.stringify([{ fromContractId: id }])}::jsonb
       ORDER BY "createdAt" DESC LIMIT 1`
    return reply.send({
      parent, relationshipType: c.relationshipType, changes: await amendmentChanges(orgId, id, parent.id) ?? [], obligations,
      lastRun: run ? { id: run.id, createdAt: run.createdAt.toISOString(), count: run.count } : null,
    })
  })

  // Set the chosen terms on the parent: a person decides what the amendment changed.
  app.post('/:id/amendment-changes/apply', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { keys, supersedeObligationIds } = z.object({
      keys: z.array(z.string().min(1).max(64)).max(60),
      // docs/41 Part 13 — the parent's obligations, from clauses this amendment replaced, a person confirmed are no longer owed.
      supersedeObligationIds: z.array(z.string().min(1).max(64)).max(200).optional(),
    }).refine(b => b.keys.length || b.supersedeObligationIds?.length, 'Pick a term or an obligation').parse(req.body ?? {})
    const { orgId, sub: userId } = req.user
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null, ...ownContractWhere(req) },
      select: { parentContractId: true, effectiveDate: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    // The write is on the parent: the caller must be able to reach it too.
    const parent = c.parentContractId
      ? await prisma.contract.findFirst({ where: { id: c.parentContractId, orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true, title: true } })
      : null
    if (!parent) return reply.status(400).send({ detail: 'This contract isn’t linked to the agreement it changes' })
    // The side-by-side as the person saw it: what each term was, and becomes.
    const before = keys.length ? await amendmentChanges(orgId, id, parent.id) ?? [] : []
    const r = keys.length
      ? await applyAmendmentValues({ orgId, parentId: parent.id, amendmentId: id, keys, userId, audit: { source: 'amendment_rollup', ipAddress: req.ip } })
      : { ok: true as const, applied: [] as string[], changes: [] }
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    // docs/41 Part 13 — the original stays one click away ("Show amended values").
    const rolled = before.filter(b => r.applied.includes(b.key))
    if (rolled.length) {
      const origin = await prisma.contract.findFirst({ where: { id: parent.id, orgId }, select: { effectiveDate: true } })
      await recordRollUp({
        orgId, contractId: parent.id, amendmentId: id, userId, effectiveFrom: c.effectiveDate, originalFrom: origin?.effectiveDate ?? null,
        values: rolled.map(b => ({
          key: b.key, label: b.label,
          before: b.parent.display || b.parent.value != null ? { value: b.parent.value, display: b.parent.display } : null,
          after: { value: b.amendment.value, display: b.amendment.display, quote: b.amendment.quote },
        })),
      })
    }
    // Only obligations of this parent, from clauses this amendment changes, still owed.
    let superseded = 0
    if (supersedeObligationIds?.length) {
      const now = new Date()
      superseded = (await prisma.obligation.updateMany({
        where: { id: { in: supersedeObligationIds }, orgId, contractId: parent.id, supersededById: null },
        data: { supersededById: id, supersededAt: now },
      })).count
      await createAuditEvent({
        orgId, userId, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: parent.id,
        metadata: { source: 'amendment_rollup', action: 'superseded_obligations', amendmentId: id, count: superseded },
        ipAddress: req.ip,
      }).catch(() => {})
    }
    const runId = r.changes.length
      ? await recordRun({ orgId, kind: 'rollup', contractId: parent.id, changes: r.changes.map(ch => ({ ...ch, contractId: parent.id })), createdById: userId })
      : null
    return reply.send({ parent, applied: r.applied, runId, superseded })
  })
  // ── docs/41 Part 13 — the family, the effective view, amendments ────────────

  app.get('/:id/family-tree', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const r = await familyTree(req.user.orgId, id, { ownerId: ownContractWhere(req).ownerId })
    if (!r) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send(r)
  })

  app.get('/:id/effective', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const r = await effectiveView(req.user.orgId, id, { ownerId: ownContractWhere(req).ownerId })
    if (!r) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send(r)
  })

  app.get('/:id/term-history', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const c = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true } })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send({ terms: await termHistory(orgId, id) })
  })

  // The number is worked out when the amendment is made; a person may correct it.
  app.put('/:id/amendment-number', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { amendmentNumber } = z.object({ amendmentNumber: z.number().int().min(1).max(999).nullable() }).parse(req.body ?? {})
    const { orgId, sub: userId } = req.user
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null, ...ownContractWhere(req) },
      select: { id: true, parentContractId: true, amendmentNumber: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    if (!c.parentContractId) return reply.status(400).send({ detail: 'Only a contract linked to an agreement has a number' })
    await prisma.contract.update({ where: { id }, data: { amendmentNumber } })
    await createAuditEvent({
      orgId, userId, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: id,
      metadata: { action: 'renumbered', from: c.amendmentNumber, to: amendmentNumber }, ipAddress: req.ip,
    }).catch(() => {})
    return reply.send({ amendmentNumber })
  })

  // AI drafts of new words for the parent's clauses a person wants changed.
  // Each comes back with the parent's words it replaces: the evidence.
  app.post('/:id/amendment-language', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { items } = z.object({
      items: z.array(z.object({ clauseId: z.string().min(1).max(64), instruction: z.string().trim().min(3).max(2000) })).min(1).max(10),
    }).parse(req.body ?? {})
    const { orgId } = req.user
    const parent = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true } })
    if (!parent) return reply.status(404).send({ detail: 'Contract not found' })
    const drafts = await draftAmendmentLanguage(orgId, parent.id, items)
    return reply.send({ drafts })
  })

  // An amendment's changes against the parent's words in effect without it.
  app.get('/:id/amendment-redline', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const c = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null, ...ownContractWhere(req) },
      select: { id: true, parentContractId: true, metadata: true, currentVersionId: true },
    })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const spec = amendmentSpecOf(c.metadata)
    if (!spec || !c.parentContractId) return reply.send({ parent: null, items: [] })
    const view = await effectiveView(orgId, c.parentContractId, { ownerId: ownContractWhere(req).ownerId })
    if (!view) return reply.send({ parent: null, items: [] })
    // A section this amendment already changed (it's signed) reads as it was before it.
    const effectiveText = (clauseId: string) => {
      const s = view.sections.find(x => x.clauseId === clauseId)
      return !s || s.amendedBy.some(a => a.contractId === id) ? null : s.text
    }
    const version = c.currentVersionId
      ? await prisma.contractVersion.findFirst({ where: { id: c.currentVersionId, contractId: c.id }, select: { htmlContent: true } })
      : null
    const items = amendmentRedlineItems(spec.changes, effectiveText, proposedTextsFromHtml(version?.htmlContent ?? ''))
    return reply.send({ parent: view.contract, items })
  })
}
