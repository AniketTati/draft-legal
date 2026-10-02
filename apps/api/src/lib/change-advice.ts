/**
 * docs/41 Part 15 — the model's view of a counterparty's changes, as part of
 * the review instead of a panel of its own.
 *
 *   counterChange      Counter… on one change in the workspace: counter
 *                      wording with a one-line rationale (agents
 *                      /redline/counter), which the workspace puts into the
 *                      draft changes as the new text.
 *
 *   changeAdviceStep   a counterparty's version, once its findings are
 *                      worked out: the redline agent scores each change
 *                      against the playbook (agents /redline/score) and its
 *                      advice (accept, counter or push back, with why and a
 *                      counter) is kept on the change's finding. Keyed by
 *                      (version, baseline): run once per pair. It replaces the
 *                      "Analyse redlines" button and its panel; the advice
 *                      shows on the findings, in the Review panel and in
 *                      Changes mode.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { callAgents } from './agents-call.js'
import { contractPlaybook } from './playbooks.js'
import { computeVersionDiff } from './diff.js'
import { reviewStampOf } from './review-findings.js'
import type { StepOutcome } from './analysis-runs.js'

/** The playbook positions the model weighs a change against, for a contract. */
export async function positionsFor(orgId: string, contract: { id: string; type: string; playbookId?: string | null }) {
  const playbook = await contractPlaybook(orgId, contract)
  if (!playbook.where) return []
  const rows = await prisma.playbookPosition.findMany({
    where: playbook.where,
    select: { positionType: true, content: true, clauseCategory: { select: { name: true } } },
    take: 200,
  })
  return rows.map(r => ({ clause: r.clauseCategory?.name ?? null, positionType: r.positionType, content: r.content }))
}

export interface CounterDraft { counterText: string; counterNote: string }

/** Counter wording for one change, with why. Throws when the agents service fails. */
export async function counterChange(a: {
  orgId: string
  contract: { id: string; type: string; playbookId?: string | null }
  ourText: string
  theirText: string
  clauseType?: string | null
}): Promise<CounterDraft> {
  const playbookPositions = await positionsFor(a.orgId, a.contract)
  const res = await callAgents('/redline/counter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body: JSON.stringify({
      ourText: a.ourText, theirText: a.theirText, clauseType: a.clauseType ?? null,
      contractType: a.contract.type, orgId: a.orgId, playbookPositions,
    }),
  }, { orgId: a.orgId, toolName: 'redline_counter', scope: a.contract.id, contractId: a.contract.id, context: `${a.ourText}\n\n${a.theirText}` })
  if (!res.ok) throw new Error(`Agents /redline/counter returned ${res.status}`)
  const body = await res.json() as Partial<CounterDraft>
  return { counterText: String(body.counterText ?? '').trim(), counterNote: String(body.counterNote ?? '').trim() }
}

// ── The change scoring, as a findings stage ──────────────────────────────────

export type Recommendation = 'accept' | 'counter' | 'reject'

/** What `ReviewFinding.advice` holds. */
export interface ChangeAdvice {
  recommendation: Recommendation
  reasoning: string
  severity: string | null
  ourText: string
  theirText: string
  counterText: string | null
  counterNote: string | null
  baselineVersionId: string
  at: string
}

/** One change as the redline agent scored it. */
export interface ScoredChange {
  changeId?: string
  clauseType?: string | null
  ourText?: string | null
  theirText?: string | null
  recommendation?: string | null
  reasoning?: string | null
  severity?: string | null
  counterText?: string | null
  counterNote?: string | null
}

/** The finding kinds a change of the counterparty's is. */
export const CHANGE_KINDS = ['modified', 'added', 'deleted', 'material_cut']

/** A version the counterparty sent: through the portal or by email. */
export const isCounterpartyVersion = (v: { createdById: string }) => /^(portal|email):/.test(v.createdById)

const words = (s: string | null | undefined) => new Set((s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [])
/** How much of `part`'s words are in `whole`: 0..1. */
function overlap(part: string | null | undefined, whole: string | null | undefined): number {
  const p = words(part)
  if (p.size < 2) return 0
  const w = words(whole)
  let n = 0
  for (const x of p) if (w.has(x)) n++
  return n / p.size
}
const RANK: Record<string, number> = { accept: 0, counter: 1, reject: 2 }

/**
 * Pure: the finding each scored change is about. A change belongs to the
 * change finding whose quote holds most of its new words (or, for words
 * removed, whose baseline quote holds them), at least half of them; the
 * same clause type counts in its favour. When two changes land on one
 * finding, the stronger advice stands (push back over counter over accept).
 */
export function matchChanges<F extends { id: string; kind: string; clauseType: string | null; evidence: unknown }>(changes: ScoredChange[], findings: F[]): Map<string, ScoredChange> {
  const out = new Map<string, ScoredChange>()
  const candidates = findings.filter(f => CHANGE_KINDS.includes(f.kind))
  for (const c of changes) {
    let best: { f: F; score: number } | null = null
    for (const f of candidates) {
      const e = (f.evidence ?? {}) as { quote?: string; baselineQuote?: string }
      const score = Math.max(overlap(c.theirText, e.quote), overlap(c.ourText, e.baselineQuote)) + (c.clauseType && c.clauseType === f.clauseType ? 0.1 : 0)
      if (score >= 0.5 && (!best || score > best.score)) best = { f, score }
    }
    if (!best) continue
    const had = out.get(best.f.id)
    if (!had || (RANK[c.recommendation ?? ''] ?? 0) > (RANK[had.recommendation ?? ''] ?? 0)) out.set(best.f.id, c)
  }
  return out
}

/** The advice to keep on a finding, from the change the agent scored. */
export function adviceOf(c: ScoredChange, baselineVersionId: string, at = new Date()): ChangeAdvice {
  const rec = (['accept', 'counter', 'reject'] as const).find(r => r === c.recommendation) ?? 'counter'
  return {
    recommendation: rec,
    reasoning: String(c.reasoning ?? '').slice(0, 1000),
    severity: c.severity ?? null,
    ourText: String(c.ourText ?? '').slice(0, 4000),
    theirText: String(c.theirText ?? '').slice(0, 4000),
    counterText: c.counterText ? String(c.counterText).slice(0, 4000) : null,
    counterNote: c.counterNote ? String(c.counterNote).slice(0, 1000) : null,
    baselineVersionId,
    at: at.toISOString(),
  }
}

/** What `ContractVersion.metadata._changeAdvice` holds: the pair it was worked out for. */
export interface ChangeAdviceStamp { baselineVersionId: string; at: string; changes: number; advised: number }

/**
 * The `change-advice` job: a counterparty version's changes since its review
 * baseline, scored by the redline agent, the advice kept on their findings.
 * Once per (version, baseline); a recompute that keeps the baseline keeps
 * the advice (storeFindings leaves the column alone).
 */
export async function changeAdviceStep(contractId: string, versionId: string, opts: { again?: boolean } = {}): Promise<StepOutcome> {
  const version = await prisma.contractVersion.findFirst({
    where: { id: versionId, contractId },
    select: { id: true, createdById: true, htmlContent: true, plainText: true, metadata: true, contract: { select: { id: true, orgId: true, type: true, playbookId: true, deletedAt: true } } },
  })
  if (!version || version.contract.deletedAt) return { skipped: 'the contract is gone' }
  if (!isCounterpartyVersion(version)) return { skipped: 'not a counterparty version' }
  const baselineVersionId = reviewStampOf(version.metadata)?.baselineVersionId
  if (!baselineVersionId) return { skipped: 'no baseline to compare with' }
  const done = (version.metadata as { _changeAdvice?: ChangeAdviceStamp } | null)?._changeAdvice
  if (!opts.again && done?.baselineVersionId === baselineVersionId) return { skipped: 'already advised for this baseline', counts: { changes: done.changes, advised: done.advised } }

  const baseline = await prisma.contractVersion.findFirst({ where: { id: baselineVersionId, contractId }, select: { htmlContent: true, plainText: true } })
  if (!baseline?.htmlContent?.trim() || !version.htmlContent?.trim()) return { skipped: 'a version is still being read' }
  const { diffHtml } = await computeVersionDiff(baseline.htmlContent, version.htmlContent)
  const { orgId } = version.contract
  const res = await callAgents('/redline/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body: JSON.stringify({ diffHtml, orgId, contractType: version.contract.type, playbookPositions: await positionsFor(orgId, version.contract) }),
  }, { orgId, toolName: 'redline', scope: contractId, contractId, context: `${baseline.plainText}\n\n${version.plainText}` })
  if (!res.ok) throw new Error(`Agents /redline/score returned ${res.status}`)
  const scored = await res.json() as { changes?: ScoredChange[]; error?: string | null }
  const changes = scored.changes ?? []
  if (!changes.length && scored.error) return { failed: `The changes could not be scored: ${scored.error}` }

  const findings = await prisma.reviewFinding.findMany({ where: { contractId, versionId, kind: { in: CHANGE_KINDS } } })
  const matched = matchChanges(changes, findings)
  const now = new Date()
  for (const f of findings) {
    const c = matched.get(f.id)
    await prisma.reviewFinding.update({ where: { id: f.id }, data: { advice: c ? (adviceOf(c, baselineVersionId, now) as object) : Prisma.DbNull } })
  }
  const stamp: ChangeAdviceStamp = { baselineVersionId, at: now.toISOString(), changes: changes.length, advised: matched.size }
  await prisma.$executeRaw`UPDATE contract_versions SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_changeAdvice}', ${JSON.stringify(stamp)}::jsonb) WHERE id = ${versionId}`
  return { counts: { changes: changes.length, advised: matched.size } }
}

/** Queue the advice on a counterparty version's changes, after its findings. */
export async function queueChangeAdviceStep(contractId: string, versionId: string): Promise<void> {
  const v = await prisma.contractVersion.findFirst({ where: { id: versionId, contractId }, select: { createdById: true, contract: { select: { orgId: true } } } })
  if (!v || !isCounterpartyVersion(v)) return
  // Imported here: the queue module opens a Redis connection when loaded.
  const { queueChangeAdvice } = await import('./queue.js')
  queueChangeAdvice({ contractId, orgId: v.contract.orgId, versionId })
}

// ── What the status banner says when the counterparty sent a version ──────────

/** Open as the Review panel counts it (routes/review.ts). */
const OPEN = new Set(['open', 'exception_requested', 'exception_declined'])

export interface CounterpartySummary {
  versionNumber: number
  /** Their changes since the baseline: changed, added, deleted or cut clauses and text. */
  changes: number
  /** Open findings the Review panel lists under Needs attention. */
  needAttention: number
  /** Required clauses not found. */
  missingRequired: number
  /** Whether the model's advice on their changes is in yet. */
  advised: boolean
}

/** Pure: the counts, from a version's findings. */
export function summarise(versionNumber: number, findings: Array<{ kind: string; status: string }>, advised: boolean): CounterpartySummary {
  const open = findings.filter(f => OPEN.has(f.status))
  return {
    versionNumber,
    changes: findings.filter(f => CHANGE_KINDS.includes(f.kind)).length,
    needAttention: open.filter(f => !['missing_required', 'drafting', 'compliance'].includes(f.kind)).length,
    missingRequired: open.filter(f => f.kind === 'missing_required').length,
    advised,
  }
}

/** The counts for a counterparty's version, once its findings are worked out (else null). */
export async function counterpartySummary(contractId: string, version: { id: string; versionNumber: number }): Promise<CounterpartySummary | null> {
  const v = await prisma.contractVersion.findFirst({ where: { id: version.id, contractId }, select: { metadata: true } })
  if (!reviewStampOf(v?.metadata)) return null
  const findings = await prisma.reviewFinding.findMany({ where: { contractId, versionId: version.id }, select: { kind: true, status: true } })
  return summarise(version.versionNumber, findings, !!(v?.metadata as { _changeAdvice?: unknown } | null)?._changeAdvice)
}
