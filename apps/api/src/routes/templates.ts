/**
 * Templates API — Phase 4.1
 *
 * CRUD for contract templates + generate/preview endpoints.
 * Templates are assembled by the template-engine into contract HTML.
 */
import { orgDateOrder } from '../lib/org-date-order.js'
import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  generateDocument,
  buildSampleVariables,
  type VariableMap,
} from '../lib/template-engine.js'
import { extractDocument } from '../lib/document.js'
import { splitHtmlIntoSections, stripTags } from '../lib/template-import.js'
import { resolveSlot, type ConditionFacts } from '@clm/types'
import { asTemplate, buildSnapshot, draftSource, libraryChanges } from '../lib/template-snapshot.js'
import { resolveSlots } from '../lib/clause-resolution.js'
import { lintTemplate } from '../lib/template-lint.js'
import { publishTemplate, setDefaultForType } from '../lib/template-publish.js'

// ─── Schemas ────────────────────────────────────────────────────────────────

// docs/41 Part 1 — the seeded templates' variables are camelCase, typed
// 'string'/'enum' and default to numbers, so saving one from the builder was
// refused outright (and publishing it never happened). Their shape is read as
// the builder's: the engine fills any {{key}} the template uses.
const SEED_TYPES: Record<string, string> = { string: 'text', enum: 'select' }
const VariableDefSchema = z.object({
  key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'A variable key is letters, digits and underscores'),
  label: z.string().min(1),
  type: z.preprocess(t => (typeof t === 'string' ? SEED_TYPES[t] ?? t : t), z.enum(['text', 'number', 'date', 'boolean', 'select'])),
  required: z.boolean().default(false),
  defaultValue: z.preprocess(v => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : v), z.string().optional()),
  // docs/41 P0.4 — the org's own default for a legal choice (see VariableDef).
  orgDefault: z.boolean().optional(),
  options: z.array(z.string()).optional(), // for select type
  helpText: z.string().max(1000).optional(),
  // docs/39 H1/H2 — the contract field its value fills.
  field: z.string().max(100).nullable().optional(),
})

const SectionSchema = z.object({
  title: z.string().min(1),
  sortOrder: z.number().int().default(0),
  content: z.string().default(''),
  conditionalLogic: z
    .object({
      field: z.string(),
      operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_empty', 'empty']),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    })
    .nullable()
    .optional(),
  clauseRefs: z.array(z.string()).default([]),
  // docs/41 Part 1 — a clause slot: the family whose variant drafting picks.
  slotFamilyId: z.string().max(64).nullable().optional(),
})

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  contractType: z.string().nullable().optional(),
  variables: z.array(VariableDefSchema).default([]),
  isPublished: z.boolean().default(false),
  sections: z.array(SectionSchema).default([]),
})

const UpdateTemplateSchema = CreateTemplateSchema.partial().omit({ sections: true })

const SlotPreviewSchema = z.object({
  /** Sample facts the conditions test, e.g. { "counterparty.country": "GB", value: 300000 }. */
  facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** Sample values a request might name, by key (governingLaw: "New York"). */
  requestValues: z.record(z.string().max(256)).default({}),
})

/** The slot families named by sections, all this org's live ones; else the first one that isn't. */
async function unknownFamily(orgId: string, sections: Array<{ slotFamilyId?: string | null }>): Promise<string | null> {
  const ids = [...new Set(sections.map(s => s.slotFamilyId).filter((x): x is string => !!x))]
  if (!ids.length) return null
  const found = await prisma.clauseFamily.findMany({ where: { orgId, id: { in: ids }, deletedAt: null }, select: { id: true } })
  return ids.find(id => !found.some(f => f.id === id)) ?? null
}

/** What the builder shows beside a template: the published version, what changed since, and lint. */
async function publishState(orgId: string, t: { id: string; publishedVersionId: string | null }) {
  const published = t.publishedVersionId
    ? await prisma.templateVersion.findFirst({ where: { id: t.publishedVersionId, orgId }, select: { id: true, version: true, publishedAt: true, publishedById: true, lint: true, snapshot: true } })
    : null
  const changes = published ? await libraryChanges(orgId, published.snapshot as never) : []
  const { snapshot: _s, ...version } = published ?? { snapshot: null }
  return { publishedVersion: published ? version : null, libraryChanges: changes }
}

const UpdateSectionSchema = SectionSchema.partial().extend({
  id: z.string().optional(), // existing section
})

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function templateRoutes(app: FastifyInstance) {
  // ── List templates ────────────────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'template') }, async (req, reply) => {
    const { orgId } = req.user
    const query = req.query as {
      contractType?: string
      published?: string
      q?: string
      limit?: string
      offset?: string
    }

    const where: any = {
      orgId,
      deletedAt: null,
      ...(query.contractType && { contractType: query.contractType }),
      ...(query.published !== undefined && { isPublished: query.published === 'true' }),
      ...(query.q && { name: { contains: query.q, mode: 'insensitive' } }),
    }

    const [templates, total] = await Promise.all([
      prisma.template.findMany({
        where,
        include: { sections: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
        take: Number(query.limit ?? 50),
        skip: Number(query.offset ?? 0),
      }),
      prisma.template.count({ where }),
    ])

    return reply.send({ data: templates, total })
  })

  // ── Get single template ───────────────────────────────────────────────────
  app.get('/:id', { preHandler: requirePermission('view', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const template = await prisma.template.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    })

    if (!template) return reply.status(404).send({ detail: 'Template not found' })
    return reply.send({ ...template, ...(await publishState(orgId, template)) })
  })

  // ── Create template ───────────────────────────────────────────────────────
  app.post('/', { preHandler: requirePermission('create', 'template') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const body = CreateTemplateSchema.parse(req.body)
    const { sections, isPublished, ...templateData } = body
    if (await unknownFamily(orgId, sections)) return reply.status(404).send({ detail: 'Clause family not found' })

    const template = await prisma.template.create({
      data: {
        orgId,
        createdById: userId,
        ...templateData,
        sections: {
          create: sections.map((s, i) => ({
            ...s,
            sortOrder: s.sortOrder ?? i,
            clauseRefs: s.clauseRefs,
            conditionalLogic: s.conditionalLogic ?? undefined,
            slotFamilyId: s.slotFamilyId ?? null,
          })),
        },
      },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    })
    // docs/41 Part 1 — a template created published is published: snapshotted and linted.
    if (isPublished) await publishTemplate(orgId, template.id, userId)
    const out = await prisma.template.findFirstOrThrow({ where: { id: template.id, orgId }, include: { sections: { orderBy: { sortOrder: 'asc' } } } })

    return reply.status(201).send({ ...out, ...(await publishState(orgId, out)) })
  })

  // ── Create a template from an uploaded .docx ──────────────────────────────
  // Mirrors the contract upload pattern (multipart + magic-byte sniffing) and
  // reuses the same mammoth-backed converter. Lands as an UNPUBLISHED draft so
  // the author reviews the conversion before anyone can use it.
  app.post('/upload', { preHandler: requirePermission('create', 'template') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user

    const parts = req.parts()
    let fileBuffer: Buffer | null = null
    let filename     = ''
    let name         = ''
    let description  = ''
    let contractType = ''

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
        filename   = part.filename
      } else {
        const val = (part as unknown as { value?: string }).value ?? ''
        if (part.fieldname === 'name')         name         = val
        if (part.fieldname === 'description')  description  = val
        if (part.fieldname === 'contractType') contractType = val
      }
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      return reply.status(400).send({ detail: 'No file uploaded' })
    }
    if (fileBuffer.length > 10 * 1024 * 1024) {
      return reply.status(413).send({ detail: 'File too large (10MB limit)' })
    }

    // Validate by magic bytes, not the client-declared mimetype (spoofable).
    // DOCX is a zip archive: 50 4b 03 04. Only .docx is accepted — mammoth is
    // the converter, and a PDF-derived template loses the heading structure
    // that makes a template worth having.
    if (fileBuffer.subarray(0, 4).toString('hex') !== '504b0304') {
      return reply.status(415).send({
        detail: 'Only .docx files can be converted into a template. Save your document as .docx and try again.',
      })
    }

    let htmlContent: string
    try {
      const extracted = await extractDocument(
        fileBuffer,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename,
      )
      htmlContent = extracted.htmlContent
    } catch (err) {
      req.log.error({ err, filename }, '[templates] docx conversion failed')
      return reply.status(422).send({
        detail: 'Could not read that .docx — it may be corrupted or password-protected.',
      })
    }

    if (!stripTags(htmlContent)) {
      return reply.status(422).send({
        detail: 'That document appears to be empty — there is nothing to turn into a template.',
      })
    }

    const cleanName = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
    const templateName = (name.trim() || cleanName || 'Untitled template').slice(0, 256)

    const template = await prisma.template.create({
      data: {
        orgId,
        createdById:  userId,
        name:         templateName,
        description:  description.trim() || undefined,
        contractType: contractType.trim() || null,
        isPublished:  false,
        sections:     { create: splitHtmlIntoSections(htmlContent, templateName) },
      },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    })

    return reply.status(201).send(template)
  })

  // ── Update template metadata ──────────────────────────────────────────────
  app.patch('/:id', { preHandler: requirePermission('edit', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const { isPublished, ...body } = UpdateTemplateSchema.parse(req.body)

    const existing = await prisma.template.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Template not found' })

    const edits = Object.keys(body).length > 0
    if (edits || isPublished === false) {
      await prisma.template.update({
        where: { id },
        data: {
          ...body,
          version: { increment: 1 },
          // docs/41 Part 1 — after publishing, an edit is a draft revision:
          // drafts keep using the published snapshot until it is republished.
          ...(edits && existing.publishedVersionId && { hasUnpublishedChanges: true }),
          // Unpublished, or moved to another type: no longer that type's default.
          ...((isPublished === false || (body.contractType !== undefined && body.contractType !== existing.contractType)) && { isDefaultForType: false }),
          ...(isPublished === false && { isPublished: false }),
        },
      })
    }
    // Publishing (or publishing again) snapshots and lints it.
    if (isPublished === true) await publishTemplate(orgId, id, userId)

    const template = await prisma.template.findFirstOrThrow({ where: { id, orgId }, include: { sections: { orderBy: { sortOrder: 'asc' } } } })
    return reply.send({ ...template, ...(await publishState(orgId, template)) })
  })

  // ── Update sections (replace all) ────────────────────────────────────────
  app.put('/:id/sections', { preHandler: requirePermission('edit', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { sections } = req.body as { sections: z.infer<typeof SectionSchema>[] }

    const existing = await prisma.template.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Template not found' })
    if (await unknownFamily(orgId, sections)) return reply.status(404).send({ detail: 'Clause family not found' })

    // Replace all sections in a transaction
    await prisma.$transaction([
      prisma.templateSection.deleteMany({ where: { templateId: id } }),
      prisma.templateSection.createMany({
        data: sections.map((s, i) => ({
          templateId: id,
          title: s.title,
          content: s.content ?? '',
          sortOrder: s.sortOrder ?? i,
          clauseRefs: s.clauseRefs ?? [],
          conditionalLogic: (s.conditionalLogic ?? null) as Prisma.InputJsonValue,
          slotFamilyId: s.slotFamilyId ?? null,
        })) as Prisma.TemplateSectionCreateManyInput[],
      }),
      // docs/41 Part 1 — a published template's edit is a draft revision until republished.
      prisma.template.update({ where: { id }, data: { version: { increment: 1 }, ...(existing.publishedVersionId && { hasUnpublishedChanges: true }) } }),
    ])

    const updated = await prisma.template.findFirst({
      where: { id },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    })

    return reply.send(updated)
  })

  // ── Delete template (soft) ────────────────────────────────────────────────
  app.delete('/:id', { preHandler: requirePermission('delete', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const existing = await prisma.template.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Template not found' })

    await prisma.template.update({ where: { id }, data: { deletedAt: new Date(), isDefaultForType: false } })
    return reply.status(204).send()
  })

  // ── Generate contract HTML from template + variable values ────────────────
  app.post('/:id/generate', { preHandler: requirePermission('view', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { variables = {} } = req.body as { variables?: VariableMap }

    const row = await prisma.template.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true, publishedVersionId: true } })
    if (!row) return reply.status(404).send({ detail: 'Template not found' })
    // docs/41 Part 1 — from the published snapshot, its clause slots decided by rule.
    const source = (await draftSource(orgId, row))!
    const template = asTemplate(source.snapshot, orgId)

    // Fetch any clause library items referenced by sections
    const allClauseRefs = template.sections.flatMap(s =>
      Array.isArray(s.clauseRefs) ? (s.clauseRefs as string[]) : [],
    )
    const clauseItems = allClauseRefs.length
      ? await prisma.clauseLibraryItem.findMany({
          where: { id: { in: allClauseRefs }, orgId, deletedAt: null },
        })
      : []

    const clauseMap = new Map(clauseItems.map(c => [c.id, c]))
    const { slotText, slots } = resolveSlots({ snapshot: source.snapshot, facts: { contractType: source.snapshot.contractType ?? undefined, paperSource: 'ours' } })

    // Dates as the org writes them, not as stored (41: browser QA).
    const result = { ...generateDocument({ template, variables, clauseMap, slotText, style: { dateOrder: await orgDateOrder(orgId) } }), slots }

    // Increment usage count
    await prisma.template.update({ where: { id }, data: { usageCount: { increment: 1 } } })

    return reply.send(result)
  })

  // ── Preview template with sample data ────────────────────────────────────
  app.post('/:id/preview', { preHandler: requirePermission('view', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { variables: overrides = {} } = (req.body as { variables?: VariableMap }) ?? {}

    // The working copy, as the builder shows it; its slots decided by rule.
    const snapshot = await buildSnapshot(orgId, id)
    if (!snapshot) return reply.status(404).send({ detail: 'Template not found' })
    const template = asTemplate(snapshot, orgId)

    const variableDefs = Array.isArray(template.variables)
      ? (template.variables as Array<{ key: string; type: string; defaultValue?: string }>)
      : []

    const sampleVars = { ...buildSampleVariables(variableDefs), ...overrides }

    const allClauseRefs = template.sections.flatMap(s =>
      Array.isArray(s.clauseRefs) ? (s.clauseRefs as string[]) : [],
    )
    const clauseItems = allClauseRefs.length
      ? await prisma.clauseLibraryItem.findMany({
          where: { id: { in: allClauseRefs }, orgId, deletedAt: null },
        })
      : []

    const clauseMap = new Map(clauseItems.map(c => [c.id, c]))
    const { slotText, slots } = resolveSlots({ snapshot, facts: { contractType: snapshot.contractType ?? undefined, paperSource: 'ours' } })
    const result = generateDocument({ template, variables: sampleVars, clauseMap, slotText })

    return reply.send({ ...result, slots, isSample: true })
  })

  // ── docs/41 Part 1 — publish: snapshot (slot variants pinned) + lint ──────
  app.post('/:id/publish', { preHandler: requirePermission('edit', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const existing = await prisma.template.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } })
    if (!existing) return reply.status(404).send({ detail: 'Template not found' })
    const published = await publishTemplate(orgId, id, userId)
    const template = await prisma.template.findFirstOrThrow({ where: { id, orgId }, include: { sections: { orderBy: { sortOrder: 'asc' } } } })
    return reply.send({ template: { ...template, ...(await publishState(orgId, template)) }, version: published?.version, lint: published?.lint ?? [] })
  })

  // ── The versions published, newest first ─────────────────────────────────
  app.get('/:id/versions', { preHandler: requirePermission('view', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const existing = await prisma.template.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true, publishedVersionId: true } })
    if (!existing) return reply.status(404).send({ detail: 'Template not found' })
    const versions = await prisma.templateVersion.findMany({
      where: { orgId, templateId: id },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, publishedAt: true, publishedById: true, lint: true },
    })
    return reply.send({ data: versions.map(v => ({ ...v, current: v.id === existing.publishedVersionId })) })
  })

  // ── Lint the working copy (the builder shows it before publishing) ────────
  app.get('/:id/lint', { preHandler: requirePermission('view', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const snapshot = await buildSnapshot(orgId, id)
    if (!snapshot) return reply.status(404).send({ detail: 'Template not found' })
    return reply.send({ data: await lintTemplate(orgId, snapshot) })
  })

  // ── Default template for its contract type ────────────────────────────────
  app.put('/:id/default-for-type', { preHandler: requirePermission('edit', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const { isDefault } = z.object({ isDefault: z.boolean() }).parse(req.body ?? {})
    const r = await setDefaultForType(orgId, id, isDefault, userId)
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    const template = await prisma.template.findFirstOrThrow({ where: { id, orgId }, include: { sections: { orderBy: { sortOrder: 'asc' } } } })
    return reply.send({ ...template, ...(await publishState(orgId, template)) })
  })

  // ── Which variant each clause slot picks for sample inputs ────────────────
  app.post('/:id/slot-preview', { preHandler: requirePermission('view', 'template') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = SlotPreviewSchema.parse(req.body ?? {})
    const snapshot = await buildSnapshot(orgId, id)
    if (!snapshot) return reply.status(404).send({ detail: 'Template not found' })
    const facts: ConditionFacts = { contractType: snapshot.contractType ?? undefined, paperSource: 'ours', ...(body.requestValues.governingLaw && { governingLaw: body.requestValues.governingLaw }), ...body.facts }
    const slots = snapshot.sections.filter(s => s.slot).map(s => ({
      sectionId: s.id,
      sectionTitle: s.title,
      ...resolveSlot({
        family: s.slot!.family,
        variants: s.slot!.variants,
        requestValues: Object.fromEntries(Object.entries(body.requestValues).map(([k, v]) => [k, { value: v }])),
        facts,
      }),
    }))
    return reply.send({ data: slots })
  })
}
