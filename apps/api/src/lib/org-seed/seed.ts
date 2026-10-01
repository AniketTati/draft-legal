/**
 * Org-defaults seeder — idempotent.
 *
 * Strategy: there are no unique compound indexes on the Prisma library tables
 * (Template / ClauseCategory / ClauseLibraryItem / PlaybookPosition), so we
 * can't use `upsert` by natural key. Instead, for each library we (a) load
 * the org's existing rows once into an in-memory set keyed by natural ID
 * (name / title / playbook `key`), then (b) `createMany` only the rows
 * missing from that set. Re-running the seed never duplicates.
 *
 * Each library is wrapped in its own `prisma.$transaction` for atomicity
 * (categories all-or-nothing, etc.). The five steps run sequentially because
 * clauses + playbook positions depend on category IDs.
 */

import { prisma } from '../prisma.js'
import { UNIVERSAL_CATEGORIES }       from './universal/categories.js'
import { UNIVERSAL_CLAUSES }          from './universal/clauses.js'
import { UNIVERSAL_TEMPLATES }        from './universal/templates.js'
import { UNIVERSAL_PLAYBOOK }         from './universal/playbook.js'
import { UNIVERSAL_FAMILIES }         from './universal/families.js'
import { updateClauseItem }           from '../clause-library-versions.js'
import { publishTemplate }            from '../template-publish.js'
import type { SeedClause }            from './universal/clauses.js'
import type { SeedTemplate }          from './universal/templates.js'
import type { SeedPlaybookPosition }  from './universal/playbook.js'
import { SAAS_CLAUSES,         SAAS_TEMPLATES,         SAAS_PLAYBOOK }         from './packs/saas.js'
import { HEALTHCARE_CLAUSES,   HEALTHCARE_TEMPLATES,   HEALTHCARE_PLAYBOOK }   from './packs/healthcare.js'
import { MANUFACTURING_CLAUSES, MANUFACTURING_TEMPLATES, MANUFACTURING_PLAYBOOK } from './packs/manufacturing.js'
import { BIOTECH_CLAUSES,      BIOTECH_TEMPLATES,      BIOTECH_PLAYBOOK }      from './packs/biotech.js'
import { LOGISTICS_CLAUSES,    LOGISTICS_TEMPLATES,    LOGISTICS_PLAYBOOK }    from './packs/logistics.js'

export type IndustryPackId = 'saas' | 'healthcare' | 'manufacturing' | 'biotech' | 'logistics'

export interface SeedOrgOptions {
  industryPack?: IndustryPackId
}

const PACK_REGISTRY: Record<IndustryPackId, { clauses: SeedClause[]; templates: SeedTemplate[]; playbook: SeedPlaybookPosition[] }> = {
  saas:          { clauses: SAAS_CLAUSES,          templates: SAAS_TEMPLATES,          playbook: SAAS_PLAYBOOK },
  healthcare:    { clauses: HEALTHCARE_CLAUSES,    templates: HEALTHCARE_TEMPLATES,    playbook: HEALTHCARE_PLAYBOOK },
  manufacturing: { clauses: MANUFACTURING_CLAUSES, templates: MANUFACTURING_TEMPLATES, playbook: MANUFACTURING_PLAYBOOK },
  biotech:       { clauses: BIOTECH_CLAUSES,       templates: BIOTECH_TEMPLATES,       playbook: BIOTECH_PLAYBOOK },
  logistics:     { clauses: LOGISTICS_CLAUSES,     templates: LOGISTICS_TEMPLATES,     playbook: LOGISTICS_PLAYBOOK },
}

// ─── 1. Categories ─────────────────────────────────────────────────────────
// Returns a map of slug → ClauseCategory.id for the org. Existing rows
// (matched by name) are reused; missing ones are created.

async function seedCategories(orgId: string): Promise<Map<string, string>> {
  const existing = await prisma.clauseCategory.findMany({
    where: { orgId },
    select: { id: true, name: true },
  })
  const idByName = new Map(existing.map(c => [c.name, c.id]))

  const toCreate = UNIVERSAL_CATEGORIES.filter(c => !idByName.has(c.name))
  if (toCreate.length > 0) {
    await prisma.$transaction(
      toCreate.map(c =>
        prisma.clauseCategory.create({
          data: {
            orgId, name: c.name, description: c.description, sortOrder: c.sortOrder,
            // docs/41 P0.3 — the small set of clauses a contract must have.
            ...(c.required && { presence: 'required', presenceContractTypes: c.required }),
          },
        }),
      ),
    )
    // Reload to capture the newly-created IDs.
    const refreshed = await prisma.clauseCategory.findMany({
      where: { orgId, name: { in: UNIVERSAL_CATEGORIES.map(c => c.name) } },
      select: { id: true, name: true },
    })
    for (const c of refreshed) idByName.set(c.name, c.id)
  }

  // Build slug → id map by joining the seed list (which knows slugs) with
  // the DB list (which knows IDs) on `name`.
  const idBySlug = new Map<string, string>()
  for (const c of UNIVERSAL_CATEGORIES) {
    const id = idByName.get(c.name)
    if (id) idBySlug.set(c.slug, id)
  }
  return idBySlug
}

// ─── 2. Clauses ────────────────────────────────────────────────────────────
async function seedClauses(orgId: string, adminId: string, categoryIdBySlug: Map<string, string>, clauses: SeedClause[]): Promise<number> {
  const existing = await prisma.clauseLibraryItem.findMany({
    where: { orgId },
    select: { title: true },
  })
  const existingTitles = new Set(existing.map(c => c.title))

  const toCreate = clauses
    .filter(c => !existingTitles.has(c.title))
    .map(c => {
      const categoryId = categoryIdBySlug.get(c.categorySlug)
      if (!categoryId) return null
      return {
        orgId,
        categoryId,
        title: c.title,
        content: c.content,
        tags: c.tags,
        riskRating: c.riskRating,
        isApproved: c.isApproved,
        createdById: adminId,
      }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)

  if (toCreate.length === 0) return 0
  const result = await prisma.clauseLibraryItem.createMany({ data: toCreate })
  return result.count
}

// ─── 2b. Clause families (docs/41 Part 1) ──────────────────────────────────
// The seeded library clauses that are alternatives for one clause, grouped
// into a family (by category and title, families.ts). Idempotent: a family
// that exists (by name) is reused, a clause already in a family stays put.
// `bump`: an existing org's clause gains a new version for its new variant
// name (backfill); a fresh org's clause is simply written that way.
export async function seedClauseFamilies(orgId: string, adminId: string, categoryIdBySlug: Map<string, string>, opts: { bump?: boolean } = {}): Promise<Map<string, string>> {
  const idByName = new Map<string, string>()
  for (const f of UNIVERSAL_FAMILIES) {
    const items = await prisma.clauseLibraryItem.findMany({
      where: { orgId, deletedAt: null, title: { in: f.variants.map(v => v.title) } },
      select: { id: true, title: true, familyId: true },
    })
    if (items.length < 2) continue
    const family = await prisma.clauseFamily.findFirst({ where: { orgId, deletedAt: null, name: f.name }, select: { id: true } })
      ?? await prisma.clauseFamily.create({
        data: { orgId, name: f.name, description: f.description, requestKey: f.requestKey ?? null, categoryId: categoryIdBySlug.get(f.categorySlug) ?? null, createdById: adminId },
        select: { id: true },
      })
    idByName.set(f.name, family.id)
    for (const [order, v] of f.variants.entries()) {
      const item = items.find(i => i.title === v.title)
      if (!item || item.familyId) continue
      const data = { familyId: family.id, variantLabel: v.label, matchValues: v.matchValues ?? [], variantOrder: order }
      if (opts.bump) await updateClauseItem({ orgId, id: item.id, userId: adminId, data, note: `Added to the ${f.name} family` })
      else await prisma.clauseLibraryItem.update({ where: { id: item.id }, data })
    }
  }
  return idByName
}

/** Each clause's words as its first version, where none is recorded yet (createMany writes none). */
export async function ensureClauseVersions(orgId: string): Promise<void> {
  const items = await prisma.clauseLibraryItem.findMany({
    where: { orgId, textVersions: { none: {} } },
    select: { id: true, orgId: true, version: true, title: true, content: true, variantLabel: true, condition: true, matchValues: true, createdById: true },
  })
  if (!items.length) return
  await prisma.clauseLibraryVersion.createMany({
    data: items.map(i => ({
      orgId: i.orgId, itemId: i.id, version: i.version, title: i.title, content: i.content, variantLabel: i.variantLabel,
      condition: (i.condition ?? undefined) as never, matchValues: i.matchValues, createdById: i.createdById, note: 'Initial version',
    })),
    skipDuplicates: true,
  })
}

// ─── 3. Templates (+ sections) ─────────────────────────────────────────────
async function seedTemplates(orgId: string, adminId: string, templates: SeedTemplate[], familyIdByName: Map<string, string> = new Map()): Promise<number> {
  const existing = await prisma.template.findMany({
    where: { orgId },
    select: { name: true },
  })
  const existingNames = new Set(existing.map(t => t.name))

  const toCreate = templates.filter(t => !existingNames.has(t.name))
  if (toCreate.length === 0) return 0
  // docs/41 Part 1 — a type's seeded default, unless the org already has one.
  const defaults = new Set((await prisma.template.findMany({ where: { orgId, deletedAt: null, isDefaultForType: true }, select: { contractType: true } })).map(t => t.contractType))

  // Templates have nested sections — we can't use createMany because
  // sections need the template ID. Create sequentially in a single tx.
  await prisma.$transaction(
    toCreate.map(t =>
      prisma.template.create({
        data: {
          orgId,
          name: t.name,
          description: t.description,
          contractType: t.contractType,
          variables: t.variables as never,
          isPublished: t.isPublished,
          isDefaultForType: !!t.isDefaultForType && t.isPublished && !defaults.has(t.contractType),
          createdById: adminId,
          sections: {
            create: t.sections.map(s => {
              // A slot over a family the org doesn't have stays the literal governing-law sentence.
              const slotFamilyId = s.slotFamily ? familyIdByName.get(s.slotFamily) ?? null : null
              return {
                title: s.title,
                sortOrder: s.sortOrder,
                content: s.slotFamily && !slotFamilyId ? '<p>This Agreement is governed by the laws of {{governingLaw}}.</p>' : s.content,
                clauseRefs: [] as never,
                slotFamilyId,
              }
            }),
          },
        },
      }),
    ),
  )
  return toCreate.length
}

/** docs/41 Part 1 — the org's published templates without a snapshot get one (drafts pin it). */
export async function publishUnsnapshotted(orgId: string, adminId: string): Promise<number> {
  const templates = await prisma.template.findMany({ where: { orgId, deletedAt: null, isPublished: true, publishedVersionId: null }, select: { id: true } })
  for (const t of templates) await publishTemplate(orgId, t.id, adminId)
  return templates.length
}

// ─── 4. Playbook positions ─────────────────────────────────────────────────
// Idempotency key for playbook positions: we embed the seed `key` at the
// start of `notes` (in a stable marker) and skip rows whose `notes` already
// contains a matching marker. This works without a unique index.

const PB_MARKER_PREFIX = '[seed-key:'

function markedNotes(key: string, notes: string): string {
  return `${PB_MARKER_PREFIX}${key}] ${notes}`
}

function extractKey(notes: string): string | null {
  if (!notes.startsWith(PB_MARKER_PREFIX)) return null
  const end = notes.indexOf(']')
  if (end < 0) return null
  return notes.slice(PB_MARKER_PREFIX.length, end)
}

async function seedPlaybook(orgId: string, adminId: string, categoryIdBySlug: Map<string, string>, positions: SeedPlaybookPosition[]): Promise<number> {
  const existing = await prisma.playbookPosition.findMany({
    where: { orgId },
    select: { notes: true },
  })
  const existingKeys = new Set(existing.map(p => extractKey(p.notes ?? '')).filter((k): k is string => k !== null))

  const toCreate = positions
    .filter(p => !existingKeys.has(p.key))
    .map(p => {
      const categoryId = categoryIdBySlug.get(p.categorySlug)
      if (!categoryId) return null
      return {
        orgId,
        clauseCategoryId: categoryId,
        positionType: p.positionType,
        content: p.content,
        notes: markedNotes(p.key, p.notes),
        riskThreshold: p.riskThreshold,
        contractTypes: p.contractTypes,
        sortOrder: p.sortOrder,
        createdById: adminId,
      }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)

  if (toCreate.length === 0) return 0
  const result = await prisma.playbookPosition.createMany({ data: toCreate })
  return result.count
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface SeedReport {
  categoriesCreated: number
  clausesCreated: number
  templatesCreated: number
  playbookPositionsCreated: number
  packApplied?: IndustryPackId
}

export async function seedOrgDefaults(
  orgId: string,
  _orgSlug: string,
  adminId: string,
  options: SeedOrgOptions = {},
): Promise<SeedReport> {
  // 1. Categories (the foundation everything else references)
  const beforeCats = await prisma.clauseCategory.count({ where: { orgId } })
  const categoryIdBySlug = await seedCategories(orgId)
  const afterCats = await prisma.clauseCategory.count({ where: { orgId } })

  // 2. Universal clauses, and (docs/41 Part 1) the families of alternatives among them
  const clausesCreated = await seedClauses(orgId, adminId, categoryIdBySlug, UNIVERSAL_CLAUSES)
  const familyIdByName = await seedClauseFamilies(orgId, adminId, categoryIdBySlug)
  await ensureClauseVersions(orgId)

  // 3. Universal templates (governing law as a clause slot over its family)
  const templatesCreated = await seedTemplates(orgId, adminId, UNIVERSAL_TEMPLATES, familyIdByName)

  // 4. Universal playbook positions
  const playbookCreated = await seedPlaybook(orgId, adminId, categoryIdBySlug, UNIVERSAL_PLAYBOOK)

  const report: SeedReport = {
    categoriesCreated: afterCats - beforeCats,
    clausesCreated,
    templatesCreated,
    playbookPositionsCreated: playbookCreated,
  }

  // 5. Optional industry pack on top
  if (options.industryPack) {
    const packReport = await applyIndustryPack(orgId, adminId, options.industryPack, categoryIdBySlug)
    report.packApplied = options.industryPack
    report.clausesCreated += packReport.clausesCreated
    report.templatesCreated += packReport.templatesCreated
    report.playbookPositionsCreated += packReport.playbookPositionsCreated
  }

  // 6. docs/41 Part 1 — publish what was seeded published: a snapshot each,
  // linted against the playbook just seeded.
  await publishUnsnapshotted(orgId, adminId)

  return report
}

export async function applyIndustryPack(
  orgId: string,
  adminId: string,
  packId: IndustryPackId,
  categoryIdBySlug?: Map<string, string>,
): Promise<{ clausesCreated: number; templatesCreated: number; playbookPositionsCreated: number }> {
  const pack = PACK_REGISTRY[packId]
  // If we weren't passed a category map, ensure categories exist and load it.
  const idBySlug = categoryIdBySlug ?? (await seedCategories(orgId))

  const clausesCreated = await seedClauses(orgId, adminId, idBySlug, pack.clauses)
  await ensureClauseVersions(orgId)
  const templatesCreated = await seedTemplates(orgId, adminId, pack.templates)
  const playbookPositionsCreated = await seedPlaybook(orgId, adminId, idBySlug, pack.playbook)
  // A pack applied on its own (the admin's Packs page) publishes its templates itself.
  if (!categoryIdBySlug) await publishUnsnapshotted(orgId, adminId)
  return { clausesCreated, templatesCreated, playbookPositionsCreated }
}

// ─── Counts (informational; updated to reflect real seed sizes) ────────────

export const UNIVERSAL_COUNTS = {
  categories: UNIVERSAL_CATEGORIES.length,
  clauses: UNIVERSAL_CLAUSES.length,
  playbookPositions: UNIVERSAL_PLAYBOOK.length,
  templates: UNIVERSAL_TEMPLATES.length,
} as const

export const PACK_COUNTS: Record<IndustryPackId, { clauses: number; templates: number; playbookPositions: number }> = {
  saas:          { clauses: SAAS_CLAUSES.length,          templates: SAAS_TEMPLATES.length,          playbookPositions: SAAS_PLAYBOOK.length },
  healthcare:    { clauses: HEALTHCARE_CLAUSES.length,    templates: HEALTHCARE_TEMPLATES.length,    playbookPositions: HEALTHCARE_PLAYBOOK.length },
  manufacturing: { clauses: MANUFACTURING_CLAUSES.length, templates: MANUFACTURING_TEMPLATES.length, playbookPositions: MANUFACTURING_PLAYBOOK.length },
  biotech:       { clauses: BIOTECH_CLAUSES.length,       templates: BIOTECH_TEMPLATES.length,       playbookPositions: BIOTECH_PLAYBOOK.length },
  logistics:     { clauses: LOGISTICS_CLAUSES.length,     templates: LOGISTICS_TEMPLATES.length,     playbookPositions: LOGISTICS_PLAYBOOK.length },
}

export const INDUSTRY_PACK_INFO: Record<IndustryPackId, { label: string; description: string }> = {
  saas:          { label: 'SaaS',          description: `Cloud subscription terms — multi-tenant security, SLA / DR, data export, API rate limits, CMEK. Adds ${PACK_COUNTS.saas.clauses} clauses, ${PACK_COUNTS.saas.templates} template, ${PACK_COUNTS.saas.playbookPositions} playbook positions.` },
  healthcare:    { label: 'Healthcare',    description: `HIPAA-aware terms — BAA template, PHI protections, 60-day breach notification, GLP/GMP / HITRUST, anti-kickback. Adds ${PACK_COUNTS.healthcare.clauses} clauses, ${PACK_COUNTS.healthcare.templates} template, ${PACK_COUNTS.healthcare.playbookPositions} playbook positions.` },
  manufacturing: { label: 'Manufacturing', description: `Supply-chain terms — Incoterms, inspection/acceptance, recall cooperation, tooling ownership, country-of-origin. Adds ${PACK_COUNTS.manufacturing.clauses} clauses, ${PACK_COUNTS.manufacturing.templates} template, ${PACK_COUNTS.manufacturing.playbookPositions} playbook positions.` },
  biotech:       { label: 'Biotech',       description: `Research collaboration terms — MTA template, joint IP, clinical data ownership, GLP/GMP, IRB/IACUC. Adds ${PACK_COUNTS.biotech.clauses} clauses, ${PACK_COUNTS.biotech.templates} template, ${PACK_COUNTS.biotech.playbookPositions} playbook positions.` },
  logistics:     { label: 'Logistics',     description: `Transportation terms — Carmack liability, fuel surcharge, demurrage/detention, FMCSA, cargo insurance. Adds ${PACK_COUNTS.logistics.clauses} clauses, ${PACK_COUNTS.logistics.templates} template, ${PACK_COUNTS.logistics.playbookPositions} playbook positions.` },
}
