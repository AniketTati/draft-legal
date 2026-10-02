/**
 * docs/41 Part 1 — why a draft says what it says, and a clause choice made
 * in it.
 *
 * `metadata._origin` (lib/draft-plan.ts) records the template version a draft
 * was made from, how each clause slot was decided (a person, the request's
 * words, a rule, the default) and where each value came from. A slot nothing
 * decided is a blank in the draft listing the approved options, and holds the
 * draft back from being sent (lib/open-choices.ts) until someone picks one
 * here: the blank becomes that option's words, as a new version.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AuditAction, type DraftOrigin, type SlotVariant } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { lockOf, lockedBody } from '../lib/external-edit.js'
import { liveFamilies, type TemplateSnapshot } from '../lib/template-snapshot.js'
import { interpolateVariables } from '../lib/template-engine.js'
import { restampSection } from '../lib/fingerprint.js'
import { htmlToText } from '../lib/html-text.js'
import { createAuditEvent } from '../lib/audit.js'
import { onVersionCreated } from '../lib/analysis-trigger.js'

export const originOf = (metadata: unknown): DraftOrigin | null => {
  const o = (metadata as { _origin?: DraftOrigin } | null)?._origin
  return o && typeof o.templateId === 'string' ? o : null
}

/** The variants a draft's slot offered: as its template version pinned them, else as the library has them now. */
async function slotOptions(orgId: string, origin: DraftOrigin, familyId: string): Promise<SlotVariant[]> {
  if (origin.templateVersionId) {
    const v = await prisma.templateVersion.findFirst({ where: { id: origin.templateVersionId, orgId }, select: { snapshot: true } })
    const slot = (v?.snapshot as TemplateSnapshot | undefined)?.sections.find(s => s.slot?.family.id === familyId)?.slot
    if (slot) return slot.variants
  }
  return (await liveFamilies(orgId, [familyId])).get(familyId)?.variants ?? []
}

/** The blank a slot left — its whole paragraph when the paragraph is only the blank. */
function blankOf(html: string, familyId: string): { start: number; end: number } | null {
  const attr = `data-slot="${familyId.replace(/"/g, '&quot;')}"`
  const at = html.indexOf(attr)
  if (at < 0) return null
  const spanStart = html.lastIndexOf('<span', at)
  const spanEnd = html.indexOf('</span>', at)
  if (spanStart < 0 || spanEnd < 0) return null
  const end = spanEnd + '</span>'.length
  const pStart = html.lastIndexOf('<p', spanStart)
  const pEnd = html.indexOf('</p>', end)
  if (pStart >= 0 && pEnd >= 0 && !html.slice(pStart, spanStart).replace(/<p\b[^>]*>/, '').trim() && !html.slice(end, pEnd).trim()) {
    return { start: pStart, end: pEnd + '</p>'.length }
  }
  return { start: spanStart, end }
}

export async function draftOriginRoutes(app: FastifyInstance) {
  guardOwnScopeContractRoutes(app)

  // GET /api/v1/contracts/:id/origin
  app.get('/:id/origin', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const c = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { metadata: true } })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const origin = originOf(c.metadata)
    if (!origin) return reply.send({ origin: null })
    const template = await prisma.template.findFirst({
      where: { id: origin.templateId, orgId },
      select: { id: true, name: true, deletedAt: true, publishedVersionId: true, publishedVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } } },
    })
    return reply.send({
      origin,
      template: template && {
        id: template.id,
        name: template.name,
        deleted: !!template.deletedAt,
        // The template has been published again since this draft was made.
        latestVersion: template.publishedVersions[0]?.version ?? null,
      },
    })
  })

  // POST /api/v1/contracts/:id/origin/slots/:familyId — choose an open clause choice.
  app.post('/:id/origin/slots/:familyId', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, familyId } = req.params as { id: string; familyId: string }
    const { orgId, sub: userId } = req.user
    const { variantId } = z.object({ variantId: z.string().min(1).max(64) }).parse(req.body ?? {})
    const c = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { metadata: true, currentVersionId: true, externalEdit: true } })
    if (!c) return reply.status(404).send({ detail: 'Contract not found' })
    const lock = lockOf(c.externalEdit)
    if (lock) return reply.status(409).send(lockedBody(lock))
    const origin = originOf(c.metadata)
    const slot = origin?.slots.find(s => s.familyId === familyId)
    if (!origin || !slot) return reply.status(404).send({ detail: 'This draft has no such clause choice.' })
    const variant = (await slotOptions(orgId, origin, familyId)).find(v => v.id === variantId)
    if (!variant) return reply.status(422).send({ detail: 'That option isn’t one this clause offers.' })

    const current = c.currentVersionId
      ? await prisma.contractVersion.findFirst({ where: { id: c.currentVersionId, contractId: id }, select: { htmlContent: true, versionNumber: true } })
      : null
    const html = current?.htmlContent ?? ''
    const blank = blankOf(html, familyId)
    if (!blank) return reply.status(409).send({ detail: 'This choice has already been made in the draft (its blank is gone). Edit the clause in the document instead.' })

    // The option's words, filled with the draft's values.
    const values = Object.fromEntries(origin.variables.map(v => [v.key, v.value]))
    const filled = interpolateVariables(variant.content, values).html
    const source = `library:${variant.id}:${variant.version}`
    const sectionId = origin.sections.find(sec => sec.slot === familyId)?.sectionId
    const replaced = html.slice(0, blank.start) + filled + html.slice(blank.end)
    const stamped = sectionId ? restampSection(replaced, sectionId, source) : { html: replaced, fp: null }
    const next = stamped.html
    const last = await prisma.contractVersion.findFirst({ where: { contractId: id }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true } })
    const version = await prisma.contractVersion.create({
      data: {
        contractId: id,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        htmlContent: next,
        plainText: htmlToText(next),
        mimeType: 'text/html',
        fileSize: Buffer.byteLength(next),
        changeNote: `Chose ${variant.label} for ${slot.familyName.toLowerCase()}`,
        createdById: userId,
      },
    })
    const updated: DraftOrigin = {
      ...origin,
      slots: origin.slots.map(s => s.familyId === familyId
        ? { ...s, decidedBy: 'user', variantId: variant.id, variantLabel: variant.label, variantVersion: variant.version, reason: undefined }
        : s),
      // The section's new stamp (unchanged when its wrapper is gone: review then can't call it standard).
      sections: origin.sections.map(s => s.slot === familyId && stamped.fp ? { ...s, fp: stamped.fp, source } : s),
    }
    await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_origin}', ${JSON.stringify(updated)}::jsonb) WHERE id = ${id} AND "orgId" = ${orgId}`
    await createAuditEvent({
      orgId, userId, action: AuditAction.CLAUSE_CHOICE_MADE, resourceType: 'contract', resourceId: id,
      metadata: { familyId, familyName: slot.familyName, variantId: variant.id, variantLabel: variant.label, variantVersion: variant.version, versionNumber: version.versionNumber },
    })
    await onVersionCreated(id, version.id, 'added')
    return reply.send({ origin: updated, versionId: version.id, versionNumber: version.versionNumber })
  })
}

