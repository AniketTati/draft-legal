/**
 * Mapping a clause's `clauseType` onto an org's `ClauseCategory`.
 *
 * There is no foreign key between them — clauseType is a free-text label the
 * extractor produces (`limitation_of_liability`) and category names are
 * human-written (`Limitation of Liability`). The join is by normalised name.
 *
 * This lived in three places with three different rules:
 *
 *   internal-ai.ts     `s.replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase()`
 *   clause-propose.ts  `clause.clauseType.replace(/_/g, ' ')`  (case-insensitive equals)
 *   internal-ai.ts     substring containment, in org_memory
 *
 * They disagree. A category named `limitation-of-liability` resolves in the
 * checker and misses in the rewriter — and a miss there is silent: the rewrite
 * simply runs with `hasPlaybook: false` and invents language from the clause
 * alone, with nothing in the response saying the playbook was lost. That is the
 * worst kind of failure for this feature, because the output still looks like a
 * playbook-grounded redline.
 */
import { prisma } from './prisma.js'

/**
 * Collapse a clauseType or category name to a comparable key.
 * Underscores, hyphens and whitespace runs all become single spaces.
 */
export function normalisedKey(s: string): string {
  return s.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

export interface MatchedCategory { id: string; name: string }

/**
 * Resolve one clauseType to a category for an org.
 *
 * Matching happens in memory rather than in SQL because the normalisation is
 * not expressible as a Postgres comparison without a functional index, and an
 * org has on the order of 3–20 categories.
 */
export async function findCategoryForClauseType(
  orgId: string,
  clauseType: string,
): Promise<MatchedCategory | null> {
  const categories = await prisma.clauseCategory.findMany({
    where: { orgId },
    select: { id: true, name: true },
  })
  return matchCategory(categories, clauseType)
}

/** Pure form, for callers that already hold the org's categories. */
export function matchCategory(
  categories: MatchedCategory[],
  clauseType: string,
): MatchedCategory | null {
  const key = normalisedKey(clauseType)
  return categories.find(c => normalisedKey(c.name) === key) ?? null
}
