/**
 * docs/41 Part 1 — a template as drafting sees it: its published snapshot.
 *
 * Publishing a template writes a TemplateVersion holding every section's text
 * and, for each clause slot, the approved variants of its family as they were
 * then (each at its version). Drafts are made from that snapshot, so neither
 * an edit to the template (a draft revision, until it is published again) nor
 * an edit to the clause library changes what a draft says. A template
 * published before snapshots existed is drafted from its rows, as before.
 */
import type { Prisma } from '@prisma/client'
import type { ClauseCondition, SlotFamily, SlotVariant } from '@clm/types'
import { isClauseCondition } from '@clm/types'
import { prisma } from './prisma.js'
import type { TemplateWithSections } from './template-engine.js'

export interface SnapshotSection {
  id: string
  title: string
  sortOrder: number
  content: string
  conditionalLogic: unknown
  clauseRefs: string[]
  /** A clause slot: the family, and its approved variants pinned at their versions. */
  slot?: { family: SlotFamily; variants: SlotVariant[] }
}

export interface TemplateSnapshot {
  templateId: string
  name: string
  contractType: string | null
  /** The published version (TemplateVersion.version); the template's revision when unpublished. */
  version: number
  variables: unknown[]
  sections: SnapshotSection[]
}

export interface DraftSource {
  snapshot: TemplateSnapshot
  /** Null when the template has no published snapshot (drafted from its rows). */
  templateVersionId: string | null
}

const conditionOf = (c: unknown): ClauseCondition | null => (isClauseCondition(c) ? c : null)

type VariantRow = { id: string; title: string; variantLabel: string | null; version: number; content: string; condition: unknown; matchValues: string[]; isFamilyDefault: boolean; variantOrder: number }

export const asSlotVariant = (v: VariantRow): SlotVariant => ({
  id: v.id,
  label: v.variantLabel?.trim() || v.title,
  version: v.version,
  content: v.content,
  condition: conditionOf(v.condition),
  matchValues: v.matchValues ?? [],
  isDefault: v.isFamilyDefault,
  order: v.variantOrder,
})

/** A family's approved, live variants as they are now. */
export async function liveFamilies(orgId: string, familyIds: string[]): Promise<Map<string, { family: SlotFamily; variants: SlotVariant[] }>> {
  if (!familyIds.length) return new Map()
  const families = await prisma.clauseFamily.findMany({
    where: { orgId, id: { in: [...new Set(familyIds)] }, deletedAt: null },
    include: { variants: { where: { deletedAt: null, isApproved: true }, orderBy: [{ variantOrder: 'asc' }, { createdAt: 'asc' }] } },
  })
  return new Map(families.map(f => [f.id, {
    family: { id: f.id, name: f.name, requestKey: f.requestKey },
    variants: f.variants.map(asSlotVariant),
  }]))
}

/** The template's rows as a snapshot, its slots holding their families' variants as they are now. */
export async function buildSnapshot(orgId: string, templateId: string, version?: number): Promise<TemplateSnapshot | null> {
  const t = await prisma.template.findFirst({
    where: { id: templateId, orgId, deletedAt: null },
    include: { sections: { orderBy: { sortOrder: 'asc' } } },
  })
  if (!t) return null
  const families = await liveFamilies(orgId, t.sections.flatMap(s => (s.slotFamilyId ? [s.slotFamilyId] : [])))
  return {
    templateId: t.id,
    name: t.name,
    contractType: t.contractType,
    version: version ?? t.version,
    variables: Array.isArray(t.variables) ? t.variables as unknown[] : [],
    sections: t.sections.map(s => ({
      id: s.id,
      title: s.title,
      sortOrder: s.sortOrder,
      content: s.content,
      conditionalLogic: s.conditionalLogic,
      clauseRefs: Array.isArray(s.clauseRefs) ? s.clauseRefs as string[] : [],
      // A slot over a family that was deleted has nothing to offer: it stays a slot with no variants (drafting asks).
      ...(s.slotFamilyId && { slot: families.get(s.slotFamilyId) ?? { family: { id: s.slotFamilyId, name: s.title, requestKey: null }, variants: [] } }),
    })),
  }
}

/** What a draft of this template is made from: its published snapshot, or (never published with one) its rows. */
export async function draftSource(orgId: string, template: { id: string; publishedVersionId: string | null }): Promise<DraftSource | null> {
  if (template.publishedVersionId) {
    const v = await prisma.templateVersion.findFirst({ where: { id: template.publishedVersionId, orgId, templateId: template.id } })
    if (v) return { snapshot: v.snapshot as unknown as TemplateSnapshot, templateVersionId: v.id }
  }
  const snapshot = await buildSnapshot(orgId, template.id)
  return snapshot && { snapshot, templateVersionId: null }
}

/** The snapshot in the shape the template engine renders. */
export function asTemplate(snapshot: TemplateSnapshot, orgId: string): TemplateWithSections {
  return {
    id: snapshot.templateId,
    orgId,
    name: snapshot.name,
    contractType: snapshot.contractType,
    version: snapshot.version,
    variables: snapshot.variables as Prisma.JsonValue,
    sections: snapshot.sections.map(s => ({
      id: s.id, templateId: snapshot.templateId, title: s.title, sortOrder: s.sortOrder, content: s.content,
      conditionalLogic: (s.conditionalLogic ?? null) as Prisma.JsonValue, clauseRefs: s.clauseRefs as Prisma.JsonValue,
      slotFamilyId: s.slot?.family.id ?? null,
    })),
  } as unknown as TemplateWithSections
}

export interface LibraryChange {
  sectionId: string
  familyId: string
  familyName: string
  /** In words: "New York is at version 3 (this template uses version 2)". */
  changes: string[]
}

/**
 * How the library moved on since the snapshot: a pinned variant with newer
 * words, one no longer approved, one added, or a new default. Republishing
 * the template picks them up.
 */
export async function libraryChanges(orgId: string, snapshot: TemplateSnapshot): Promise<LibraryChange[]> {
  const slots = snapshot.sections.filter(s => s.slot)
  const live = await liveFamilies(orgId, slots.map(s => s.slot!.family.id))
  const out: LibraryChange[] = []
  for (const s of slots) {
    const pinned = s.slot!
    const now = live.get(pinned.family.id)
    const changes: string[] = []
    if (!now) changes.push('This clause family was deleted.')
    else {
      for (const v of pinned.variants) {
        const cur = now.variants.find(x => x.id === v.id)
        if (!cur) changes.push(`${v.label} is no longer approved.`)
        else if (cur.version > v.version) changes.push(`${cur.label} is at version ${cur.version} (this template uses version ${v.version}).`)
      }
      for (const v of now.variants) {
        if (!pinned.variants.some(x => x.id === v.id)) changes.push(`${v.label} was added.`)
      }
      const before = pinned.variants.find(v => v.isDefault)?.id ?? null
      const after = now.variants.find(v => v.isDefault)?.id ?? null
      if (before !== after) changes.push(after ? `${now.variants.find(v => v.id === after)!.label} is now the default.` : 'The default was removed.')
    }
    if (changes.length) out.push({ sectionId: s.id, familyId: pinned.family.id, familyName: pinned.family.name, changes })
  }
  return out
}
