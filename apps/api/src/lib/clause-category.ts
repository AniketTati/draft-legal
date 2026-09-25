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

/**
 * The extractor's clause types (apps/agents review_agent.py) and the words an
 * org's category for each is named with. Playbooks name categories as people
 * do ("Fees & Payment", "Term & Termination"), and an exact-name join left
 * most clauses with no playbook at all: "payment" never met "Fees & Payment".
 */
const CATEGORY_WORDS: Record<string, string[]> = {
  payment:                 ['payment', 'fees', 'pricing'],
  price_adjustment:        ['fees', 'pricing', 'payment'],
  termination:             ['termination', 'term'],
  auto_renewal:            ['renewal', 'termination', 'term'],
  renewal_term:            ['renewal', 'termination', 'term'],
  limitation_of_liability: ['liability'],
  uncapped_liability:      ['liability'],
  liquidated_damages:      ['liability', 'damages'],
  indemnification:         ['indemn'],
  confidentiality:         ['confidential'],
  data_protection:         ['data', 'privacy'],
  ip_ownership:            ['intellectual property', 'ip'],
  license_grant:           ['licen', 'intellectual property'],
  warranty:                ['warrant', 'representation'],
  governing_law:           ['governing law', 'law'],
  dispute_resolution:      ['dispute', 'arbitration'],
  assignment:              ['assignment'],
  change_of_control:       ['change of control', 'assignment'],
  force_majeure:           ['force majeure'],
  notice:                  ['notice'],
  insurance:               ['insurance'],
  audit_rights:            ['audit'],
  non_solicitation:        ['solicit'],
  non_compete:             ['compet'],
  exclusivity:             ['exclusiv'],
  sla:                     ['service level', 'performance'],
  acceptance:              ['acceptance'],
}

/** Pure form, for callers that already hold the org's categories. */
export function matchCategory(
  categories: MatchedCategory[],
  clauseType: string,
): MatchedCategory | null {
  const key = normalisedKey(clauseType)
  const exact = categories.find(c => normalisedKey(c.name) === key)
  if (exact) return exact
  // Otherwise the category whose name carries the type's words, in the
  // order they're listed (the likeliest first).
  const words = CATEGORY_WORDS[key.replace(/ /g, '_')] ?? []
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z])${w.replace(/ /g, '\\s+')}`, 'i')
    const hit = categories.find(c => re.test(normalisedKey(c.name)))
    if (hit) return hit
  }
  return null
}
