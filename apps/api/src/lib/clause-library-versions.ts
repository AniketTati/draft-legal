/**
 * docs/41 Part 1 — a library clause's words are kept at every version, and a
 * version never changes once written.
 *
 * A template's published snapshot pins each slot variant at its version, and
 * a draft records the version it used, so "which words did we approve when
 * this was drafted" always has an answer. Editing a clause's words (title,
 * text, variant name, condition or the names a request may use for it) is a
 * new version; approving it or moving it isn't.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

type Db = Prisma.TransactionClient | typeof prisma

export interface VersionedFields {
  title: string
  content: string
  variantLabel: string | null
  condition: unknown
  matchValues: string[]
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Whether a change to a clause makes a new version of its words. */
export function changesWords(existing: VersionedFields, patch: Partial<VersionedFields>): boolean {
  return (patch.title !== undefined && patch.title !== existing.title)
    || (patch.content !== undefined && patch.content !== existing.content)
    || (patch.variantLabel !== undefined && (patch.variantLabel ?? null) !== (existing.variantLabel ?? null))
    || (patch.condition !== undefined && !same(patch.condition, existing.condition))
    || (patch.matchValues !== undefined && !same(patch.matchValues, existing.matchValues))
}

/** Write the version row for an item as it now stands (its `version`). */
export async function recordClauseVersion(db: Db, item: VersionedFields & { id: string; orgId: string; version: number }, userId: string, note?: string | null) {
  await db.clauseLibraryVersion.create({
    data: {
      orgId: item.orgId,
      itemId: item.id,
      version: item.version,
      title: item.title,
      content: item.content,
      variantLabel: item.variantLabel,
      condition: (item.condition ?? undefined) as Prisma.InputJsonValue | undefined,
      matchValues: item.matchValues ?? [],
      note: note ?? null,
      createdById: userId,
    },
  })
}

/**
 * Update a clause; a change of its words bumps its version and writes the new
 * version's row, in one transaction. The legacy `versions` JSON keeps its
 * entry too, for the history the clause editor shows.
 */
export async function updateClauseItem(input: {
  orgId: string
  id: string
  userId: string
  data: Prisma.ClauseLibraryItemUncheckedUpdateInput & Partial<VersionedFields>
  note?: string | null
}) {
  return prisma.$transaction(async tx => {
    const existing = await tx.clauseLibraryItem.findFirstOrThrow({ where: { id: input.id, orgId: input.orgId, deletedAt: null } })
    const bump = changesWords(existing, input.data as Partial<VersionedFields>)
    const history = Array.isArray(existing.versions) ? existing.versions as unknown[] : []
    const updated = await tx.clauseLibraryItem.update({
      where: { id: existing.id },
      data: {
        ...input.data,
        ...(bump && {
          version: existing.version + 1,
          versions: [...history, {
            version: existing.version + 1,
            content: (input.data.content as string | undefined) ?? existing.content,
            changedById: input.userId,
            changedAt: new Date().toISOString(),
            note: input.note ?? '',
          }] as Prisma.InputJsonValue,
        }),
      },
    })
    if (bump) await recordClauseVersion(tx, updated, input.userId, input.note)
    return updated
  })
}
