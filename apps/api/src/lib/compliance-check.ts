/**
 * compliance-check.ts — shared helper for running the Compliance Agent
 * (GDPR / HIPAA / SOX / CCPA regulatory clause checks) and persisting
 * the result.
 *
 * Used by:
 *   • POST /contracts/:id/compliance-check  (manual trigger from the rail)
 *
 * Phase 10 — Compliance Agent. Result is stored on
 * Contract.metadata._compliance so the rail section + agent tools read
 * it without re-running the LLM pass.
 */
import { prisma } from './prisma.js'
import { applyPiiPolicy } from './pii-policy.js'
import { assertCostCapNotExceeded, recordCost, estimateCostUsd, CostCapExceededError, recordUsage } from './costCap.js'
import { createAuditEvent } from './audit.js'
import { AuditAction } from '@clm/types'
import { modelFetch } from './model-boundary.js'
import { createHash } from 'node:crypto'

// docs/41 Part 9 — UK GDPR and PCI DSS joined; the catalogue is in the agents service.
export const COMPLIANCE_FRAMEWORKS = ['GDPR', 'UK_GDPR', 'HIPAA', 'SOX', 'CCPA', 'PCI_DSS'] as const
export type ComplianceFramework = typeof COMPLIANCE_FRAMEWORKS[number]

export interface ComplianceCheckItem {
  id:             string
  requirement:    string
  status:         'present' | 'partial' | 'missing' | 'risky'
  severity:       'low' | 'medium' | 'high' | 'critical'
  finding:        string
  quote:          string | null
  sectionRef:     string | null
  recommendation: string | null
}

export interface ComplianceFrameworkResult {
  framework:           string
  applicable:          boolean
  applicabilityReason: string
  status:              'compliant' | 'gaps' | 'non_compliant' | 'not_applicable'
  score:               number
  checks:              ComplianceCheckItem[]
}

export interface ComplianceReport {
  frameworks: ComplianceFrameworkResult[]
  overall: {
    status:        string
    summary:       string
    criticalCount: number
  }
  checkedAt:           string
  frameworksRequested: string[]
  /** docs/41 Part 9 — the version checked, and a hash of its text: a result is for one text. */
  versionId?:          string
  textHash?:           string
}

/** The hash a report and the facts are stamped with: same text, same hash. */
export const textHashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)

export interface ComplianceParams {
  orgId:      string
  contractId: string
  /** User who triggered (audit attribution). Use 'system' for auto-runs. */
  userId:     string
  /** Subset of COMPLIANCE_FRAMEWORKS; defaults to all. */
  frameworks?: string[]
  /**
   * docs/41 Part 9 — keep the stored results for frameworks not checked now,
   * when they are for the same text ("Add a framework" adds one result).
   */
  merge?: boolean
  /** The frameworks were found to apply from facts and policy: the model only checks requirements. */
  applicabilityDecided?: boolean
}

export interface ComplianceResult {
  ok:      boolean
  report:  ComplianceReport | null
  error:   string | null
  /** Set when the LLM call was skipped (no plaintext, no version, etc). */
  skippedReason?: string
}

/**
 * Run the compliance pass end-to-end and persist onto
 * contract.metadata._compliance (replacing any previous report).
 *
 * Throws CostCapExceededError when the daily cap is hit so callers can
 * surface 429. All other failures return { ok: false, error }.
 */
export async function runComplianceCheck({
  orgId, contractId, userId, frameworks, merge, applicabilityDecided,
}: ComplianceParams): Promise<ComplianceResult> {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null },
    select: {
      id: true, type: true, jurisdiction: true, metadata: true,
      currentVersionId: true,
    },
  })
  if (!contract) return { ok: false, report: null, error: 'contract not found' }

  const versionId = contract.currentVersionId ?? (await prisma.contractVersion.findFirst({
    where: { contractId: contract.id },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  }))?.id
  if (!versionId) return { ok: false, report: null, error: null, skippedReason: 'no version' }

  const version = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { plainText: true },
  })
  const rawText = version?.plainText ?? ''
  if (!rawText) return { ok: false, report: null, error: null, skippedReason: 'no plaintext' }

  const requested = (frameworks ?? [...COMPLIANCE_FRAMEWORKS])
    .filter((f): f is ComplianceFramework => (COMPLIANCE_FRAMEWORKS as readonly string[]).includes(f))
  if (requested.length === 0) return { ok: false, report: null, error: 'no valid frameworks requested' }

  // Daily cost cap.
  await assertCostCapNotExceeded(orgId)

  // PII policy.
  const { text, mode: piiMode, total: piiTotal } = await applyPiiPolicy(orgId, rawText, {
    surface: 'compliance_check',
    contractId: contract.id,
    userId,
  })

  const agentsUrl = process.env.AGENTS_URL ?? 'http://localhost:8002'
  const pyRes = await modelFetch(`${agentsUrl}/check_compliance`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
      'x-pii-mode': piiMode,
      'x-pii-redaction-count': String(piiTotal),
    },
    body: JSON.stringify({
      plainText:    text,
      contractType: contract.type,
      frameworks:   requested,
      jurisdiction: contract.jurisdiction ?? undefined,
      orgId,   // Wave 3.5 — lets the agents service resolve the org's BYOK key
      applicabilityDecided: applicabilityDecided ?? false,
    }),
  }, { orgId, surface: 'compliance_check', contractId: contract.id, userId })
  if (!pyRes.ok) {
    const errText = await pyRes.text()
    return { ok: false, report: null, error: `agents service error: ${errText.slice(0, 300)}` }
  }
  const parsed = await pyRes.json() as {
    frameworks?: ComplianceFrameworkResult[]
    overall?: { status?: string; summary?: string; criticalCount?: number }
    error?: string
  }

  // Best-effort cost tracking.
  recordUsage(orgId, estimateCostUsd(text.length), {
    provider: String((parsed as Record<string, unknown>).provider ?? 'unknown'),
    model:    String((parsed as Record<string, unknown>).model ?? 'unknown'),
    tier:     'default',
    toolName: 'check_compliance',
    inputChars: text.length,
  }).catch(() => {})

  if (parsed.error) {
    return { ok: false, report: null, error: parsed.error }
  }

  const textHash = textHashOf(rawText)
  const fresh = parsed.frameworks ?? []
  // The results kept from before: only for the same text, and not re-checked now.
  const previous = (contract.metadata as Record<string, unknown> | null)?._compliance as ComplianceReport | undefined
  const kept = merge && previous?.textHash === textHash
    ? previous.frameworks.filter(f => !fresh.some(n => n.framework === f.framework))
    : []
  const report: ComplianceReport = {
    frameworks: [...kept, ...fresh],
    overall: {
      status:        parsed.overall?.status ?? 'unknown',
      summary:       parsed.overall?.summary ?? '',
      criticalCount: (parsed.overall?.criticalCount ?? 0)
        + kept.flatMap(f => f.checks).filter(c => c.severity === 'critical' && c.status !== 'present').length,
    },
    checkedAt:           new Date().toISOString(),
    frameworksRequested: [...new Set([...kept.map(f => f.framework), ...requested])],
    versionId,
    textHash,
  }

  // One key, written in place: other analysis steps write other metadata keys meanwhile.
  await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_compliance}', ${JSON.stringify(report)}::jsonb) WHERE id = ${contractId} AND "orgId" = ${orgId}`

  await createAuditEvent({
    orgId, userId,
    action: AuditAction.COMPLIANCE_CHECKED,
    resourceType: 'contract', resourceId: contractId,
    metadata: {
      frameworks:    requested,
      status:        report.overall.status,
      criticalCount: report.overall.criticalCount,
      trigger:       userId === 'system' ? 'auto' : 'manual',
    },
  })

  return { ok: true, report, error: null }
}

export { CostCapExceededError }
