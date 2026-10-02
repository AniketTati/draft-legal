/**
 * obligation-extract.ts — shared helper for running the obligations LLM
 * pass and persisting the result.
 *
 * Used by:
 *   • POST /contracts/:id/extract-obligations  (manual trigger)
 *   • signature.completed handler              (auto-trigger on EXECUTED)
 *   • a draft's full analysis                   (docs/41 Part 11: proposed,
 *     confirmed at signing — see queueProposedObligations)
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
import { fireWebhook } from './webhook-events.js'
import { modelFetch } from './model-boundary.js'

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

/** Caps applied when persisting. Named so the golden tests can assert the
 *  boundary rather than a magic number, and so a change is a visible diff. */
export const MAX_OBLIGATION_ROWS = 100
export const MAX_TEXT_CHARS = 4000
export const MAX_TRIGGER_CHARS = 1000

export interface ObligationRow {
  orgId: string
  contractId: string
  type: string
  description: string
  owner: string
  dueDate: Date | null
  recurrence: string
  trigger: string | null
  quote: string
  severity: string
  sectionRef: string | null
}

/**
 * Agent-service payload → the rows we persist. PURE.
 *
 * Separated from extractObligationsForContract so it can be pinned with golden
 * fixtures. This is the last transformation before contract obligations hit
 * the database, and every failure in it is silent: a change to `toDate` nulls
 * every due date and the reminder cron simply stops firing, with nothing
 * erroring and no test noticing. See obligation-extract.golden.test.ts.
 */
export function toObligationRows(
  incoming: Array<Record<string, unknown>>,
  { orgId, contractId }: { orgId: string; contractId: string },
): ObligationRow[] {
  return incoming.slice(0, MAX_OBLIGATION_ROWS).map(o => ({
    orgId,
    contractId,
    type:        norm(o.type, 'other').toLowerCase(),
    description: norm(o.description, '').slice(0, MAX_TEXT_CHARS),
    owner:       norm(o.owner, 'unknown').toLowerCase(),
    dueDate:     toDate(o.dueDate),
    recurrence:  norm(o.recurrence, 'one-time').toLowerCase(),
    trigger:     o.trigger ? String(o.trigger).slice(0, MAX_TRIGGER_CHARS) : null,
    quote:       norm(o.quote, '').slice(0, MAX_TEXT_CHARS),
    severity:    norm(o.severity, 'medium').toLowerCase(),
    sectionRef:  o.sectionRef ? String(o.sectionRef) : null,
  }))
}

/**
 * docs/39 G4 — after its analysis, a signed contract is read for its
 * obligations: executed in the app or uploaded as signed, or its document
 * gives a signing date (a draft's signature block is left blank). Once only;
 * what's found is suggested. True when queued.
 */
export async function queueObligationsIfSigned(orgId: string, contractId: string): Promise<boolean> {
  const c = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null, diligenceRoomId: null },
    select: { status: true, stage: true, stageState: true, executedAt: true, metadata: true },
  })
  if (!c || ((c.metadata ?? {}) as Record<string, unknown>).obligationsExtractedAt) return false
  if (!(await readsAsSigned(contractId, c))) return false
  // Loaded here: the queue connects to Redis as it loads, which this module's pure helpers don't need.
  const { queueExtractObligations } = await import('./queue.js')
  return queueExtractObligations({ orgId, contractId })
}

/**
 * docs/41 Part 11 — signed: what it promises is owed. Before that (a draft,
 * a negotiation, an approval) what it would commit to is only proposed.
 */
export function isSigned(c: { status: string; stage: string; stageState: string; executedAt: Date | null }): boolean {
  return c.status === 'EXECUTED' || !!c.executedAt || c.stage === 'active' || (c.stage === 'closed' && c.stageState !== 'cancelled')
}

/** Signed, or its document gives a signing date (a draft's signature block is left blank). */
export async function readsAsSigned(contractId: string, c: Parameters<typeof isSigned>[0]): Promise<boolean> {
  if (isSigned(c)) return true
  const signedOn = await prisma.contractFieldValue.findUnique({ where: { contractId_fieldKey: { contractId, fieldKey: 'executionDate' } }, select: { value: true } })
  return typeof signedOn?.value === 'string' && signedOn.value !== ''
}

/** The stages whose full analysis reads obligations as proposed. */
export const PROPOSED_STAGES: readonly string[] = ['draft', 'negotiate', 'approve']

/**
 * docs/41 Part 11 — once its analysis is done, a draft's obligations are
 * read as proposed: a lawyer sees what the draft commits them to before
 * signing. Full analyses only (a generated, uploaded or added version, a
 * retry), never an edit checkpoint, which would be a model run per pause.
 * True when queued.
 */
export async function queueProposedObligations(orgId: string, contractId: string, opts: { full: boolean }): Promise<boolean> {
  if (!opts.full) return false
  const c = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null, diligenceRoomId: null },
    select: { status: true, stage: true, stageState: true, executedAt: true },
  })
  if (!c || !PROPOSED_STAGES.includes(c.stage) || await readsAsSigned(contractId, c)) return false
  const { queueExtractObligations } = await import('./queue.js')
  return queueExtractObligations({ orgId, contractId })
}

/**
 * docs/41 Part 11 — at signing, what was proposed becomes owed: the
 * obligations read from the signed version, and any a person confirmed or
 * dismissed, become OPEN; suggestions read from an earlier version are
 * dropped (the signed text is what counts, and it is read instead).
 */
export async function confirmProposedObligations(orgId: string, contractId: string, versionId: string | null): Promise<number> {
  const proposed = await prisma.obligation.findMany({
    where: { orgId, contractId, status: 'PROPOSED' }, select: { id: true, versionId: true, reviewState: true },
  })
  const keep = proposed.filter(o => (versionId && o.versionId === versionId) || o.reviewState !== 'SUGGESTED').map(o => o.id)
  const drop = proposed.filter(o => !keep.includes(o.id)).map(o => o.id)
  if (drop.length) await prisma.obligation.deleteMany({ where: { orgId, id: { in: drop } } })
  if (keep.length) await prisma.obligation.updateMany({ where: { orgId, id: { in: keep }, status: 'PROPOSED' }, data: { status: 'OPEN' } })
  return keep.length
}

/** Two obligations the same one: their words, case, spacing and punctuation aside. */
export function sameObligation(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160)
}

/**
 * Run extraction end-to-end. Replaces the AI's own suggestions still open;
 * what a person confirmed, dismissed or completed is preserved (G4).
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
      currentVersionId: true, status: true, stage: true, stageState: true, executedAt: true,
    },
  })
  if (!contract) return { ok: false, count: 0, summary: '', error: 'contract not found' }

  const versionId = contract.currentVersionId ?? (await prisma.contractVersion.findFirst({
    where: { contractId: contract.id },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  }))?.id
  if (!versionId) return { ok: false, count: 0, summary: '', error: null, skippedReason: 'no version' }

  // docs/41 Part 11 — unsigned, what's read is proposed; signed, what was
  // proposed is owed now, and the signed version isn't read twice.
  const signed = await readsAsSigned(contractId, contract)
  const meta = (contract.metadata ?? {}) as Record<string, unknown>
  if (signed) {
    const confirmed = await confirmProposedObligations(orgId, contractId, versionId)
    if (meta.obligationsProposedVersionId === versionId) {
      const rest: Record<string, unknown> = { ...meta, obligationsExtractedAt: new Date().toISOString() }
      delete rest.obligationsProposedAt; delete rest.obligationsProposedVersionId
      await prisma.contract.update({ where: { id: contractId }, data: { metadata: rest as never } })
      if (confirmed > 0) fireWebhook(orgId, 'obligation.extracted', { contractId, count: confirmed })
      await createAuditEvent({
        orgId, userId, action: AuditAction.OBLIGATION_EXTRACTED, resourceType: 'contract', resourceId: contractId,
        metadata: { count: confirmed, confirmedAtSigning: true, versionId, trigger: userId === 'system' ? 'auto' : 'manual' },
      })
      return { ok: true, count: confirmed, summary: String(meta.obligationsSummary ?? ''), error: null }
    }
  }

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

  const agentsUrl = process.env.AGENTS_URL ?? 'http://localhost:8002'
  const pyRes = await modelFetch(`${agentsUrl}/extract_obligations`, {
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
  }, { orgId, surface: 'extract_obligations', contractId: contract.id, userId })
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

  // docs/39 G4 — what the AI finds is a suggestion until a person confirms
  // it. A re-read replaces only its own suggestions still open: what a person
  // confirmed, dismissed or completed stays, and isn't suggested again. (It
  // used to delete every open obligation, a confirmed one included.)
  // A draft's re-read (a new version) replaces the proposals still open in
  // the same way; ones a person confirmed or dismissed stay.
  const incoming = (parsed.obligations ?? []) as Array<Record<string, unknown>>
  await prisma.obligation.deleteMany({
    where: { contractId, reviewState: 'SUGGESTED', status: signed ? { in: ['OPEN', 'OVERDUE'] } : 'PROPOSED' },
  })
  const kept = await prisma.obligation.findMany({ where: { contractId }, select: { description: true, quote: true } })
  const known = new Set(kept.flatMap(k => [sameObligation(k.quote), sameObligation(k.description)]).filter(Boolean))
  const fresh = toObligationRows(incoming, { orgId, contractId })
    .filter(r => !known.has(sameObligation(r.quote)) && !known.has(sameObligation(r.description)))
  if (fresh.length > 0) {
    await prisma.obligation.createMany({
      data: fresh.map(r => ({ ...r, reviewState: 'SUGGESTED', ...(!signed && { status: 'PROPOSED', versionId }) })),
    })
    // H2 — advertised to webhook subscribers, never emitted until now. A
    // draft's proposals aren't obligations yet: they're announced at signing.
    if (signed) fireWebhook(orgId, 'obligation.extracted', { contractId, count: fresh.length })
  }

  // Update metadata with summary + extraction timestamp.
  // A draft's read is stamped apart: obligationsExtractedAt means the signed
  // contract was read (queueObligationsIfSigned reads it once).
  const nextMeta: Record<string, unknown> = {
    ...meta,
    obligationsSummary: parsed.summary ?? null,
    ...(signed
      ? { obligationsExtractedAt: new Date().toISOString() }
      : { obligationsProposedAt: new Date().toISOString(), obligationsProposedVersionId: versionId }),
  }
  delete nextMeta.obligations
  if (signed) { delete nextMeta.obligationsProposedAt; delete nextMeta.obligationsProposedVersionId }
  await prisma.contract.update({
    where: { id: contractId },
    data:  { metadata: nextMeta as never },
  })

  await createAuditEvent({
    orgId, userId,
    action: AuditAction.OBLIGATION_EXTRACTED,
    resourceType: 'contract', resourceId: contractId,
    metadata: { count: fresh.length, found: incoming.length, trigger: userId === 'system' ? 'auto' : 'manual', ...(!signed && { proposed: true, versionId }) },
  })

  return {
    ok:      !parsed.error,
    count:   fresh.length,
    summary: parsed.summary ?? '',
    error:   parsed.error ?? null,
  }
}

export { CostCapExceededError }
