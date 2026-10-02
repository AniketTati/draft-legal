/**
 * Which clauses "Redline against playbook" rewrites.
 *
 * The rail's playbook review compares each clause with the playbook's prose
 * positions ("6 of 12 clauses deviate"). The rule check (playbook_check) can
 * only judge positions that carry machine rules, and most carry none: on a
 * contract the review flagged six clauses of, the rule check found one, and
 * the redline rewrote one. The redline now covers both, and carries the
 * review's category and reason for each clause to the rewriter.
 */

import { prisma } from './prisma.js'

/** A clause the playbook review flagged (contract.metadata._playbookReview.findings). */
export interface ReviewFinding {
  clauseId:        string
  /** The playbook category it was judged against, by name. */
  clauseType?:     string
  reasoning?:      string
  recommendation?: string
  severity?:       string
}

export interface RuleCheck { clauseId: string; failedCount: number; worstSeverity: string | null }

export function redlineTargets(
  checks: readonly RuleCheck[],
  review: { versionId?: string; findings?: ReviewFinding[] } | null | undefined,
  versionId: string,
) {
  const failing = checks.filter(c => c.failedCount > 0)
  // A review of another version names clause rows that are not this one's.
  const reviewed = review?.versionId === versionId
    ? (review.findings ?? []).filter(f => f.clauseId && f.recommendation !== 'accept')
    : []
  const hints: Record<string, { category?: string; issue?: string }> = {}
  for (const f of reviewed) hints[f.clauseId] = { category: f.clauseType, issue: f.reasoning }
  const severity = new Map<string, string | null>(reviewed.map(f => [f.clauseId, f.severity ?? null]))
  for (const c of failing) severity.set(c.clauseId, c.worstSeverity ?? severity.get(c.clauseId) ?? null)
  return {
    clauseIds: [...new Set([...failing.map(c => c.clauseId), ...reviewed.map(f => f.clauseId)])],
    hints,
    severity,
  }
}

/**
 * How many of a version's clauses neither the rules nor the review judged:
 * its clauses, less those the review read. Clauses, not their rows: a long
 * clause is one clause stored as several sub-chunk windows, which were
 * counted as clauses "left unchecked".
 */
export async function uncheckedClauses(
  versionId: string,
  review: { versionId?: string; clausesReviewed?: number } | null | undefined,
  fromCheck: number,
): Promise<number> {
  if (review?.versionId !== versionId) return fromCheck
  const clauses = await prisma.contractClause.count({ where: { versionId, isSubChunk: false } })
  return Math.max(0, clauses - (review.clausesReviewed ?? 0))
}

/**
 * docs/41 P0.7 — what a redline that found nothing to change says: never
 * "No clause deviated" when no clause was there to check.
 */
export function redlineClearNote(clauseCount: number, checked: number): string {
  if (clauseCount === 0) return 'Nothing to check — this contract has no analysed clauses.'
  if (checked === 0) return 'Nothing was checked — no playbook position covers these clauses.'
  return 'No clause deviated from the playbook.'
}
