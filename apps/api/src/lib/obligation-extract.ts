/**
 * obligation-extract.ts — shared helper for running the obligations LLM
 * pass and persisting the result.
 *
 * Used by:
 *   • POST /contracts/:id/extract-obligations  (manual trigger)
 *   • signature.completed handler              (auto-trigger on EXECUTED)
 *
 * Phase 08 Step 2 — promotes extraction from a manual button to a
 * fire-and-forget event handler so customers don't have to remember to
 * click "Extract" after every signature.
 */
import { prisma } from './prisma.js'
import { applyPiiPolicy } from './pii-policy.js'
import { assertCostCapNotExceeded, recordCost, estimateCostUsd, CostCapExceededError, recordUsage } from './costCap.js'
import { createAuditEvent } from './audit.js'
import { AuditAction } from '@clm/types'

export interface ExtractParams {
  orgId:      string
  contractId: string
  /** User who triggered (audit attribution). Use 'system' for auto-extract. */
  userId:     string
}

export interface ExtractResult {
  ok:          boolean
  count:       number
  summary:     string
  error:       string | null
  /** Set when the LLM call was skipped (no plaintext, cost cap, etc). */
  skippedReason?: string
}

const norm = (v: unknown, fallback: string): string => {
  if (v == null) return fallback
  const s = String(v).trim()
  return s ? s : fallback
}
const toDate = (v: unknown): Date | null => {
  if (!v || typeof v !== 'string') return null
  const t = new Date(v)
  return isNaN(t.getTime()) ? null : t
}

/**
 * Run extraction end-to-end. Replaces existing OPEN obligations on the
 * contract; COMPLETED rows are preserved across re-runs.
 *
 * Throws CostCapExceededError when the daily cap is hit so callers can
 * decide whether to surface 429 or skip silently. All other failures
 * return { ok: false, error } rather than throwing — the caller is in
 * an event-handler / fire-and-forget context most of the time.
 */
export async function extractObligationsForContract({
  orgId, contractId, userId,
}: ExtractParams): Promise<ExtractResult> {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null },
    select: {
      id: true, type: true, effectiveDate: true, metadata: true,
      currentVersionId: true,
    },
  })
  if (!contract) return { ok: false, count: 0, summary: '', error: 'contract not found' }

  const versionId = contract.currentVersionId ?? (await prisma.contractVersion.findFirst({
    where: { contractId: contract.id },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  }))?.id
  if (!versionId) return { ok: false, count: 0, summary: '', error: null, skippedReason: 'no version' }

  const version = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { plainText: true },
  })
  const rawText = version?.plainText ?? ''
  if (!rawText) return { ok: false, count: 0, summary: '', error: null, skippedReason: 'no plaintext' }

  // Daily cost cap.
  await assertCostCapNotExceeded(orgId)

  // PII policy.
  const { text, mode: piiMode, total: piiTotal } = await applyPiiPolicy(orgId, rawText, {
    surface: 'extract_obligations',
    contractId: contract.id,
    userId,
  })

  const agentsUrl = process.env.AGENTS_URL ?? 'http://localhost:8000'
  const pyRes = await fetch(`${agentsUrl}/extract_obligations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
      'x-pii-mode': piiMode,
      'x-pii-redaction-count': String(piiTotal),
    },
    body: JSON.stringify({
      plainText:     text,
      contractType:  contract.type,
      effectiveDate: contract.effectiveDate ? contract.effectiveDate.toISOString().slice(0, 10) : undefined,
      orgId,   // Wave 3.5 — lets the agents service resolve the org's BYOK key
    }),
  })
  if (!pyRes.ok) {
    const errText = await pyRes.text()
    return { ok: false, count: 0, summary: '', error: `agents service error: ${errText.slice(0, 300)}` }
  }
  const parsed = await pyRes.json() as {
    obligations?: Array<Record<string, unknown>>
    summary?: string
    error?: string
  }

  // Best-effort cost + usage tracking.
  recordUsage(orgId, estimateCostUsd(text.length), {
    provider: String((parsed as Record<string, unknown>).provider ?? 'unknown'),
    model:    String((parsed as Record<string, unknown>).model ?? 'unknown'),
    tier:     'default',
    toolName: 'extract_obligations',
    inputChars: text.length,
  }).catch(() => {})

  // Replace OPEN/OVERDUE rows; preserve COMPLETED.
  const incoming = (parsed.obligations ?? []) as Array<Record<string, unknown>>
  await prisma.obligation.deleteMany({
    where: { contractId, status: { in: ['OPEN', 'OVERDUE'] } },
  })
  if (incoming.length > 0) {
    await prisma.obligation.createMany({
      data: incoming.slice(0, 100).map(o => ({
        orgId,
        contractId,
        type:        norm(o.type, 'other').toLowerCase(),
        description: norm(o.description, '').slice(0, 4000),
        owner:       norm(o.owner, 'unknown').toLowerCase(),
        dueDate:     toDate(o.dueDate),
        recurrence:  norm(o.recurrence, 'one-time').toLowerCase(),
        trigger:     o.trigger ? String(o.trigger).slice(0, 1000) : null,
        quote:       norm(o.quote, '').slice(0, 4000),
        severity:    norm(o.severity, 'medium').toLowerCase(),
        sectionRef:  o.sectionRef ? String(o.sectionRef) : null,
      })),
    })
  }

  // Update metadata with summary + extraction timestamp.
  const existing = (contract.metadata ?? {}) as Record<string, unknown>
  const nextMeta: Record<string, unknown> = {
    ...existing,
    obligationsSummary:     parsed.summary ?? null,
    obligationsExtractedAt: new Date().toISOString(),
  }
  delete nextMeta.obligations
  await prisma.contract.update({
    where: { id: contractId },
    data:  { metadata: nextMeta as never },
  })

  await createAuditEvent({
    orgId, userId,
    action: AuditAction.OBLIGATION_EXTRACTED,
    resourceType: 'contract', resourceId: contractId,
    metadata: { count: incoming.length, trigger: userId === 'system' ? 'auto' : 'manual' },
  })

  return {
    ok:      !parsed.error,
    count:   incoming.length,
    summary: parsed.summary ?? '',
    error:   parsed.error ?? null,
  }
}

export { CostCapExceededError }
