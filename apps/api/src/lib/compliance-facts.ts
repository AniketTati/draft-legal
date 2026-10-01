/**
 * Compliance facts and applicability for one contract (docs/41 Part 9).
 *
 *   extractComplianceFacts   one fast-tier model call per version text: the
 *                            facts, each with a quote (agents /compliance/facts)
 *   confirmComplianceFact    a person's answer to the one question; it stands
 *                            through every re-analysis until they change it
 *   complianceApplicability  facts + the org's policy → yes / no / unsure per
 *                            framework, with the quotes that decided it
 *   runApplicableChecks      the requirement checks for the frameworks that
 *                            apply, only those not yet checked on this text
 *   runComplianceApplicability  all of it, as a step of analysis
 *
 * Cost: the facts call is skipped when the version's text is the one already
 * read (`metadata._complianceFacts.textHash`); the checks run only for a
 * framework that applies and has no result for this text.
 */
import type { ComplianceFactKey, ComplianceFrameworkId, PolicyRule } from '@clm/types'
import { COMPLIANCE_FACTS, COMPLIANCE_FACT_KEYS, COMPLIANCE_FRAMEWORK_IDS, CompliancePolicyRulesSchema } from '@clm/types'
import { prisma } from './prisma.js'
import { applyPiiPolicy } from './pii-policy.js'
import { assertCostCapNotExceeded, estimateCostUsd, recordUsage, CostCapExceededError } from './costCap.js'
import { modelFetch } from './model-boundary.js'
import { runComplianceCheck, textHashOf, type ComplianceReport } from './compliance-check.js'
import { DEFAULT_COMPLIANCE_POLICY, evaluatePolicy, applyingFrameworks, type PolicyEvaluation, type StoredFact } from './compliance-policy.js'

export interface FactsMark { versionId: string; textHash: string; extractedAt: string }

export interface ComplianceApplicability extends PolicyEvaluation {
  versionId: string | null
  /** When the facts were read, and from which version; null: never. */
  facts: Array<StoredFact & { label: string; source: string; versionId: string | null }>
  factsReadAt: string | null
  factsVersionId: string | null
  /** The facts are from an older text than the current version's. */
  factsStale: boolean
  /** Frameworks someone added by hand. */
  added: ComplianceFrameworkId[]
  report: ComplianceReport | null
}

// ─── Policy ──────────────────────────────────────────────────────────────────

export async function loadCompliancePolicy(orgId: string): Promise<{ rules: PolicyRule[]; isDefault: boolean; updatedAt: Date | null; updatedById: string | null }> {
  const row = await prisma.compliancePolicy.findUnique({ where: { orgId } })
  const parsed = row ? CompliancePolicyRulesSchema.safeParse(row.rules) : null
  if (!row || !parsed?.success) return { rules: DEFAULT_COMPLIANCE_POLICY, isDefault: true, updatedAt: null, updatedById: null }
  return { rules: parsed.data as PolicyRule[], isDefault: false, updatedAt: row.updatedAt, updatedById: row.updatedById }
}

// ─── Reading the contract ────────────────────────────────────────────────────

async function contractAndVersion(orgId: string, contractId: string, versionId?: string | null) {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null },
    select: { id: true, type: true, jurisdiction: true, metadata: true, currentVersionId: true },
  })
  if (!contract) return null
  const version = await prisma.contractVersion.findFirst({
    where: versionId ? { id: versionId, contractId } : contract.currentVersionId ? { id: contract.currentVersionId, contractId } : { contractId },
    orderBy: { versionNumber: 'desc' },
    select: { id: true, plainText: true },
  })
  return { contract, version }
}

const setMetadataKey = (orgId: string, contractId: string, key: string, value: unknown) =>
  prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ${`{${key}}`}::text[], ${JSON.stringify(value)}::jsonb) WHERE id = ${contractId} AND "orgId" = ${orgId}`

// ─── Facts ───────────────────────────────────────────────────────────────────

export interface ExtractResult {
  ok: boolean
  /** Why no model call was made. */
  skipped?: 'unchanged' | 'no text' | 'not found'
  error?: string
}

interface AgentFact { key: string; value: unknown; quote: string | null; confidence: number }

/**
 * Read the facts of a version (the current one by default) and store them. A
 * fact someone confirmed is kept as they answered it. Throws
 * CostCapExceededError when the org's daily cap is spent.
 */
export async function extractComplianceFacts({ orgId, contractId, versionId, userId, force = false }: {
  orgId: string; contractId: string; versionId?: string | null; userId: string; force?: boolean
}): Promise<ExtractResult> {
  const found = await contractAndVersion(orgId, contractId, versionId)
  if (!found?.version) return { ok: false, skipped: 'not found' }
  const { contract, version } = found
  const raw = version.plainText ?? ''
  if (!raw.trim()) return { ok: false, skipped: 'no text' }
  const textHash = textHashOf(raw)
  const mark = (contract.metadata as Record<string, unknown> | null)?._complianceFacts as FactsMark | undefined
  if (!force && mark?.textHash === textHash) return { ok: true, skipped: 'unchanged' }

  await assertCostCapNotExceeded(orgId)
  const { text, mode: piiMode, total: piiTotal } = await applyPiiPolicy(orgId, raw, { surface: 'compliance_facts', contractId, userId })
  const agentsUrl = process.env.AGENTS_URL ?? 'http://localhost:8002'
  const res = await modelFetch(`${agentsUrl}/compliance/facts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
      'x-pii-mode': piiMode,
      'x-pii-redaction-count': String(piiTotal),
    },
    body: JSON.stringify({ plainText: text, contractType: contract.type, jurisdiction: contract.jurisdiction ?? undefined, orgId }),
  }, { orgId, surface: 'compliance_facts', contractId, userId }).catch((err: Error) => err)
  if (res instanceof Error) return { ok: false, error: `agents service unreachable: ${res.message}` }
  if (!res.ok) return { ok: false, error: `agents service error: ${(await res.text()).slice(0, 300)}` }
  const parsed = await res.json() as { facts?: AgentFact[]; error?: string; model?: string; provider?: string }
  recordUsage(orgId, estimateCostUsd(text.length), {
    provider: String(parsed.provider ?? 'unknown'), model: String(parsed.model ?? 'unknown'),
    tier: 'fast', toolName: 'compliance_facts', inputChars: text.length,
  }).catch(() => {})
  if (parsed.error) return { ok: false, error: parsed.error }

  const known = new Set<string>(COMPLIANCE_FACT_KEYS)
  const facts = (parsed.facts ?? []).filter(f => known.has(f.key))
  const confirmed = new Set((await prisma.contractFact.findMany({
    where: { orgId, contractId, confirmedAt: { not: null } }, select: { key: true },
  })).map(f => f.key))
  await prisma.$transaction([
    // What the AI read before and didn't read now is gone; a person's answers stay.
    prisma.contractFact.deleteMany({ where: { orgId, contractId, confirmedAt: null, key: { notIn: facts.map(f => f.key) } } }),
    ...facts.filter(f => !confirmed.has(f.key)).map(f => {
      const data = {
        versionId: version.id,
        value: (f.value ?? null) as never,
        quote: f.quote ? String(f.quote).slice(0, 400) : null,
        confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)),
        source: 'ai',
      }
      return prisma.contractFact.upsert({
        where: { contractId_key: { contractId, key: f.key } },
        create: { orgId, contractId, key: f.key, ...data },
        update: data,
      })
    }),
  ])
  await setMetadataKey(orgId, contractId, '_complianceFacts', { versionId: version.id, textHash, extractedAt: new Date().toISOString() } satisfies FactsMark)
  return { ok: true }
}

/** Coerce a person's answer to the fact's kind; "unsure" is a null answer, still an answer. */
export function answerValue(key: ComplianceFactKey, answer: unknown): { ok: true; value: unknown } | { ok: false; detail: string } {
  const spec = COMPLIANCE_FACTS[key]
  if (answer === null || answer === 'unsure') return { ok: true, value: null }
  if (spec.kind === 'boolean') {
    if (answer === true || answer === 'yes') return { ok: true, value: true }
    if (answer === false || answer === 'no') return { ok: true, value: false }
    return { ok: false, detail: 'Answer yes, no or unsure' }
  }
  if (spec.kind === 'list') {
    const list = (Array.isArray(answer) ? answer : [answer]).filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim().slice(0, 40))
    if (!list.length || list.length > 20) return { ok: false, detail: 'Pick at least one' }
    return { ok: true, value: list }
  }
  if (typeof answer !== 'string' || !answer.trim()) return { ok: false, detail: 'Pick one' }
  const options = spec.options?.map(o => o.value)
  if (options && !options.includes(answer)) return { ok: false, detail: `Pick one of: ${options.join(', ')}` }
  return { ok: true, value: answer.trim().slice(0, 40) }
}

export async function confirmComplianceFact({ orgId, contractId, userId, key, value }: {
  orgId: string; contractId: string; userId: string | null; key: ComplianceFactKey; value: unknown
}): Promise<boolean> {
  const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null }, select: { id: true, currentVersionId: true } })
  if (!contract) return false
  const data = { value: value as never, quote: null, confidence: 1, source: 'user', confirmedById: userId, confirmedAt: new Date(), versionId: contract.currentVersionId }
  await prisma.contractFact.upsert({
    where: { contractId_key: { contractId, key } },
    create: { orgId, contractId, key, ...data },
    update: data,
  })
  return true
}

// ─── Applicability ───────────────────────────────────────────────────────────

export async function complianceApplicability(orgId: string, contractId: string): Promise<ComplianceApplicability | null> {
  const found = await contractAndVersion(orgId, contractId)
  if (!found) return null
  const { contract, version } = found
  const md = (contract.metadata ?? {}) as Record<string, unknown>
  const [{ rules }, rows] = await Promise.all([
    loadCompliancePolicy(orgId),
    prisma.contractFact.findMany({ where: { orgId, contractId }, orderBy: { key: 'asc' } }),
  ])
  const added = ((md._complianceAdded as string[] | undefined) ?? [])
    .filter((f): f is ComplianceFrameworkId => (COMPLIANCE_FRAMEWORK_IDS as readonly string[]).includes(f))
  const mark = md._complianceFacts as FactsMark | undefined
  const facts = rows.map(r => ({
    key: r.key, value: r.value, quote: r.quote, confidence: r.confidence, confirmedAt: r.confirmedAt,
    label: COMPLIANCE_FACTS[r.key as ComplianceFactKey]?.label ?? r.key, source: r.source, versionId: r.versionId,
  }))
  const evaluation = evaluatePolicy(rules, facts, added)
  return {
    ...evaluation,
    versionId: version?.id ?? null,
    facts,
    factsReadAt: mark?.extractedAt ?? null,
    factsVersionId: mark?.versionId ?? null,
    factsStale: !!mark && !!version?.plainText && mark.textHash !== textHashOf(version.plainText),
    added,
    report: (md._compliance as ComplianceReport | undefined) ?? null,
  }
}

export interface ChecksRun { ran: ComplianceFrameworkId[]; error?: string }

/**
 * Run the requirement checks for the frameworks that apply and have no
 * result for the current text. Nothing applies: no call.
 */
export async function runApplicableChecks({ orgId, contractId, userId }: { orgId: string; contractId: string; userId: string }): Promise<ChecksRun> {
  const a = await complianceApplicability(orgId, contractId)
  if (!a?.versionId) return { ran: [] }
  const version = await prisma.contractVersion.findUnique({ where: { id: a.versionId }, select: { plainText: true } })
  const hash = textHashOf(version?.plainText ?? '')
  const done = a.report?.textHash === hash ? new Set(a.report.frameworks.map(f => f.framework)) : new Set<string>()
  const need = applyingFrameworks(a).filter(f => !done.has(f))
  if (!need.length) return { ran: [] }
  let r: Awaited<ReturnType<typeof runComplianceCheck>>
  try {
    r = await runComplianceCheck({ orgId, contractId, userId, frameworks: need, merge: true, applicabilityDecided: true })
  } catch (err) {
    if (err instanceof CostCapExceededError) throw err
    console.warn('[compliance-facts] check failed contractId=%s: %s', contractId, (err as Error)?.message ?? err)
    return { ran: [], error: 'the compliance check could not run. Try again shortly.' }
  }
  return r.ok ? { ran: need } : { ran: [], error: r.error ?? r.skippedReason ?? 'compliance check failed' }
}

/** Add a framework by hand: it applies from now on, and is checked now. */
export async function addComplianceFramework({ orgId, contractId, userId, framework }: {
  orgId: string; contractId: string; userId: string; framework: ComplianceFrameworkId
}) {
  const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null }, select: { metadata: true } })
  if (!contract) return null
  const added = new Set(((contract.metadata as Record<string, unknown> | null)?._complianceAdded as string[] | undefined) ?? [])
  added.add(framework)
  await setMetadataKey(orgId, contractId, '_complianceAdded', [...added])
  return runComplianceCheck({ orgId, contractId, userId, frameworks: [framework], merge: true, applicabilityDecided: true })
}

/** What the analysis step did: why it did nothing, or what it ran. */
export interface ComplianceStepOutcome { skipped?: string; frameworks?: number; checked?: number }

/**
 * The analysis step: read the facts when the version's text changed, then
 * check the frameworks that apply. Never throws (analysis must not fail on
 * it): a step that could not run says why, and is offered again by the
 * contract's Compliance section.
 */
export async function runComplianceApplicability(contractId: string, versionId: string): Promise<ComplianceStepOutcome> {
  try {
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { orgId: true, currentVersionId: true } })
    if (!contract) return { skipped: 'the contract is gone' }
    // Only the version people are looking at: an older one being re-read isn't worth a call.
    if (contract.currentVersionId && contract.currentVersionId !== versionId) return { skipped: 'not the version the contract stands on' }
    const facts = await extractComplianceFacts({ orgId: contract.orgId, contractId, versionId, userId: 'system' })
    if (!facts.ok) {
      if (facts.error) console.warn('[compliance-facts] facts not read contractId=%s: %s', contractId, facts.error)
      return { skipped: facts.skipped === 'no text' ? 'no text to read' : 'the facts could not be read' }
    }
    const checks = await runApplicableChecks({ orgId: contract.orgId, contractId, userId: 'system' })
    if (checks.error) {
      console.warn('[compliance-facts] checks failed contractId=%s: %s', contractId, checks.error)
      return { skipped: 'the checks could not run' }
    }
    const a = await complianceApplicability(contract.orgId, contractId)
    return { frameworks: a ? applyingFrameworks(a).length : 0, checked: checks.ran.length }
  } catch (err) {
    console.warn('[compliance-facts] step failed contractId=%s: %s', contractId, (err as Error)?.message ?? err)
    return { skipped: err instanceof CostCapExceededError ? 'the daily AI cost cap is reached' : 'it could not run' }
  }
}
