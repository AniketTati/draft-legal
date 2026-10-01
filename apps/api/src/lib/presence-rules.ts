/**
 * docs/41 P0.3 — what is missing, and what was taken out.
 *
 * Every check used to loop over the clauses a contract has, so a clause that
 * isn't there could never be flagged: delete Governing Law and nothing was
 * left to complain about, and the AI recommended approval. Two deterministic
 * checks, no model:
 *
 *   - presence rules: a category the org's playbook marks `required` for this
 *     contract type with no clause of it is "Not detected — find it or
 *     confirm it's missing" (only as reliable as clause detection, so it is
 *     worded as not detected, not as missing, and never blocks on its own);
 *     a `not_allowed` category with a clause of it is flagged;
 *   - against the version analysed before (the baseline): a clause type that
 *     was there and is gone is "Deleted since vN", with the deleted text; a
 *     clause cut by more than 30% is flagged too ("half of Exclusions").
 *
 * The findings are stored with the analysis (`metadata._presence`) in the
 * shape milestone 2's ReviewFinding table will take, and read live for a
 * version edited since (its clauses are carried from the analysed one, and a
 * deleted clause is not carried). The approval guard (recommendation-guard.ts)
 * reads them.
 */
import { analysisStampOf, clauseTypeLabel } from '@clm/types'
import { prisma } from './prisma.js'
import { matchCategory, type MatchedCategory } from './clause-category.js'

export type PresenceFindingKind = 'not_detected' | 'deleted' | 'cut' | 'not_allowed_present'

export interface PresenceFinding {
  kind: PresenceFindingKind
  clauseType: string
  /** What the screens call it: the clause type's name, or the category's for a whole category not found. */
  label: string
  severity: 'medium' | 'high'
  /** The org's playbook requires this clause for the contract's type. */
  required: boolean
  /** One plain sentence. */
  message: string
  /** The words that show it: the deleted text, the text before and after a cut, the clause that isn't allowed. */
  evidence: { text?: string; before?: string; after?: string; sectionRef?: string | null }
  versionId: string
  baselineVersionId: string | null
  baselineVersionNumber: number | null
}

export interface PresenceRule {
  id: string
  name: string
  presence: string
  presenceContractTypes: string[]
}

export interface ClauseLike {
  clauseType: string
  content: string
  sectionRef?: string | null
}

/** Below this share of a clause type's words kept, it was cut, not edited. */
export const CUT_THRESHOLD = 0.7

const words = (s: string) => s.split(/\s+/).filter(Boolean).length
/** Clause types too broad to say anything about when they come and go. */
const NOISE = new Set(['general', 'other'])

/** The rules that apply to a contract of this type, without the optional ones. */
export function applicableRules(rules: PresenceRule[], contractType: string): PresenceRule[] {
  return rules.filter(r => r.presence !== 'optional'
    && (r.presenceContractTypes.length === 0 || r.presenceContractTypes.includes(contractType)))
}

/**
 * The findings for `current` (the version's clauses) against the rules and,
 * when there is one, the version analysed before it. Pure.
 */
export function presenceFindings(input: {
  rules: PresenceRule[]
  contractType: string
  current: ClauseLike[]
  baseline: ClauseLike[] | null
  versionId: string
  baselineVersionId: string | null
  baselineVersionNumber: number | null
}): PresenceFinding[] {
  const { current, baseline, versionId, baselineVersionId, baselineVersionNumber } = input
  const rules = applicableRules(input.rules, input.contractType)
  const categories: MatchedCategory[] = input.rules.map(r => ({ id: r.id, name: r.name }))
  const categoryOf = (clauseType: string) => matchCategory(categories, clauseType)?.id ?? null
  const since = baselineVersionNumber != null ? `v${baselineVersionNumber}` : 'the last analysed version'
  const base = { versionId, baselineVersionId, baselineVersionNumber }
  const out: PresenceFinding[] = []

  const typesNow = new Set(current.map(c => c.clauseType))
  const requiredCategory = new Set(rules.filter(r => r.presence === 'required').map(r => r.id))

  // Gone since the baseline: every clause type, required or not.
  const deletedTypes = new Set<string>()
  if (baseline) {
    const byType = new Map<string, ClauseLike[]>()
    for (const c of baseline) byType.set(c.clauseType, [...(byType.get(c.clauseType) ?? []), c])
    for (const [type, was] of byType) {
      if (NOISE.has(type)) continue
      const cat = categoryOf(type)
      const required = !!cat && requiredCategory.has(cat)
      const label = clauseTypeLabel(type)
      if (!typesNow.has(type)) {
        deletedTypes.add(type)
        out.push({
          ...base, kind: 'deleted', clauseType: type, label, required,
          severity: required ? 'high' : 'medium',
          message: `${label} — deleted since ${since}${required ? ' (required)' : ''}.`,
          evidence: { text: was.map(c => c.content).join('\n\n').slice(0, 2000), sectionRef: was[0].sectionRef ?? null },
        })
        continue
      }
      const before = was.reduce((n, c) => n + words(c.content), 0)
      const nowRows = current.filter(c => c.clauseType === type)
      const after = nowRows.reduce((n, c) => n + words(c.content), 0)
      if (before >= 20 && after < before * CUT_THRESHOLD) {
        out.push({
          ...base, kind: 'cut', clauseType: type, label, required,
          severity: required ? 'high' : 'medium',
          message: `${label} — cut by ${Math.round((1 - after / before) * 100)}% since ${since}.`,
          evidence: { before: was.map(c => c.content).join('\n\n').slice(0, 2000), after: nowRows.map(c => c.content).join('\n\n').slice(0, 2000), sectionRef: nowRows[0]?.sectionRef ?? null },
        })
      }
    }
  }

  for (const r of rules) {
    const here = current.filter(c => categoryOf(c.clauseType) === r.id)
    if (r.presence === 'required' && here.length === 0) {
      // Already said: it was deleted. Otherwise it was never found.
      const deletedHere = [...deletedTypes].some(t => categoryOf(t) === r.id)
      if (deletedHere) continue
      out.push({
        ...base, kind: 'not_detected', clauseType: r.name, label: r.name, required: true, severity: 'medium',
        message: `${r.name} — not detected. Find it in the document or confirm it's missing.`,
        evidence: {},
      })
    }
    if (r.presence === 'not_allowed' && here.length > 0) {
      out.push({
        ...base, kind: 'not_allowed_present', clauseType: here[0].clauseType, label: r.name, required: false, severity: 'high',
        message: `${r.name} — your playbook does not allow this clause in this type of contract.`,
        evidence: { text: here[0].content.slice(0, 2000), sectionRef: here[0].sectionRef ?? null },
      })
    }
  }

  // Required first, then by how serious.
  const rank = (f: PresenceFinding) => (f.required ? 0 : 2) + (f.severity === 'high' ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b))
}

/** What `metadata._presence` holds. */
export interface StoredPresence {
  versionId: string
  baselineVersionId: string | null
  computedAt: string
  findings: PresenceFinding[]
}

export function storedPresenceOf(metadata: unknown): StoredPresence | null {
  const p = (metadata as { _presence?: StoredPresence } | null)?._presence
  return p && typeof p.versionId === 'string' && Array.isArray(p.findings) ? p : null
}

const clausesOf = (versionId: string) => prisma.contractClause.findMany({
  where: { versionId, isSubChunk: false },
  orderBy: { sortOrder: 'asc' },
  select: { clauseType: true, content: true, sectionRef: true },
})

/**
 * The findings for a version of a contract: against the org's rules and the
 * version given as its baseline. A deletion stays flagged while the clause
 * stays gone, across later analyses (`carried`), not only for the one
 * analysis after it.
 */
export async function computePresence(contractId: string, versionId: string, baselineVersionId: string | null, carried: PresenceFinding[] = []): Promise<PresenceFinding[]> {
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { orgId: true, type: true } })
  if (!contract) return []
  const [rules, current, baseline, baselineVersion] = await Promise.all([
    prisma.clauseCategory.findMany({ where: { orgId: contract.orgId }, select: { id: true, name: true, presence: true, presenceContractTypes: true } }),
    clausesOf(versionId),
    baselineVersionId && baselineVersionId !== versionId ? clausesOf(baselineVersionId) : Promise.resolve(null),
    baselineVersionId ? prisma.contractVersion.findFirst({ where: { id: baselineVersionId, contractId }, select: { versionNumber: true } }) : Promise.resolve(null),
  ])
  const findings = presenceFindings({
    rules, contractType: contract.type, current, baseline,
    versionId, baselineVersionId: baseline ? baselineVersionId : null, baselineVersionNumber: baseline ? baselineVersion?.versionNumber ?? null : null,
  })
  const typesNow = new Set(current.map(c => c.clauseType))
  const have = new Set(findings.map(f => `${f.kind}|${f.clauseType}`))
  for (const f of carried) {
    if (f.kind !== 'deleted' || typesNow.has(f.clauseType) || have.has(`deleted|${f.clauseType}`)) continue
    findings.push({ ...f, versionId })
  }
  return findings
}

/**
 * docs/41 P0.3 — run after a version's analysis is stamped (analysis-trigger
 * finishAnalysis): its presence findings, stored with it.
 */
export async function afterAnalysis(contractId: string, versionId: string): Promise<void> {
  try {
    const row = await prisma.contract.findUnique({ where: { id: contractId }, select: { metadata: true } })
    const stamp = analysisStampOf(row?.metadata)
    const previous = storedPresenceOf(row?.metadata)
    const findings = await computePresence(contractId, versionId, stamp?.versionId === versionId ? stamp.baselineVersionId : null, previous?.findings ?? [])
    const stored: StoredPresence = { versionId, baselineVersionId: stamp?.baselineVersionId ?? null, computedAt: new Date().toISOString(), findings }
    await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_presence}', ${JSON.stringify(stored)}::jsonb) WHERE id = ${contractId}`
  } catch (err) {
    console.warn('[presence] findings not computed contractId=%s: %s', contractId, (err as Error).message)
  }
}

/**
 * The findings for the version the contract stands on now: the stored ones
 * when they are for it, else worked out live against the version last
 * analysed (an edit made since — its carried clauses lack what was deleted).
 */
export async function currentPresence(contract: { id: string; currentVersionId: string | null; metadata: unknown }): Promise<PresenceFinding[]> {
  if (!contract.currentVersionId) return []
  const stored = storedPresenceOf(contract.metadata)
  if (stored?.versionId === contract.currentVersionId) return stored.findings
  const stamp = analysisStampOf(contract.metadata)
  if (!stamp) return []
  return computePresence(contract.id, contract.currentVersionId, stamp.versionId, stored?.findings ?? [])
}
