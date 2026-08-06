/**
 * PII policy helpers (P7.5.1).
 *
 * Wraps `redactPii` with org-level policy lookup + audit-log write.
 * Call this at every boundary where document text leaves our trust
 * zone (i.e. before being sent to an LLM / 3rd-party API).
 *
 * Usage pattern:
 *   const { text, counts } = await applyPiiPolicy(orgId, plainText, {
 *     contractId, surface: 'extract_obligations',
 *   })
 *   await fetch(agentsUrl, { body: JSON.stringify({ plainText: text }) })
 */
import { prisma } from './prisma.js'
import { redactPii, type PiiMode, type PiiKind } from './pii-redactor.js'
import { createAuditEvent } from './audit.js'
import { AuditAction } from '@clm/types'

/** Cache org settings so we don't re-fetch on every LLM call. */
const orgModeCache = new Map<string, { mode: PiiMode; expires: number }>()
const CACHE_TTL_MS = 60_000

export async function getOrgPiiMode(orgId: string): Promise<PiiMode> {
  const cached = orgModeCache.get(orgId)
  if (cached && cached.expires > Date.now()) return cached.mode

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { settings: true },
  })
  const raw = (org?.settings as { piiRedactionMode?: string } | null)?.piiRedactionMode
  // Default flipped to 'redact' for production launch (2026-04-29).
  // Previously 'off', which silently sent SSNs / credit cards / DOBs
  // verbatim to OpenAI. CLM contracts routinely contain PII
  // (employment agreements, healthcare BAAs, financial covenants);
  // the launch posture is privacy-by-default. Orgs that explicitly
  // need raw text (e.g. for extraction quality on government IDs)
  // can set settings.piiRedactionMode = 'off' through the admin
  // panel — opt-out, not opt-in.
  const mode: PiiMode =
    raw === 'redact' || raw === 'tokenize' || raw === 'off'
      ? (raw as PiiMode)
      : 'redact'

  orgModeCache.set(orgId, { mode, expires: Date.now() + CACHE_TTL_MS })
  return mode
}

export interface ApplyOptions {
  /** Arbitrary surface label so audit logs can group by call-site. */
  surface: string
  /** When the redaction is for a specific contract. */
  contractId?: string
  /** When the call is on behalf of a specific user. */
  userId?: string
  /** Override the org's policy (e.g. force-redact for a specific path). */
  override?: PiiMode
}

export interface ApplyResult {
  text: string
  mode: PiiMode
  counts: Partial<Record<PiiKind, number>>
  total: number
}

export async function applyPiiPolicy(
  orgId: string,
  text: string,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const mode: PiiMode = opts.override ?? await getOrgPiiMode(orgId)
  if (mode === 'off') {
    return { text, mode, counts: {}, total: 0 }
  }
  const result = redactPii(text, mode)
  // Only emit an audit event if anything was actually redacted.
  // Otherwise this would spam the log on every text-free call.
  if (result.total > 0) {
    // Fire-and-forget: don't block the LLM call on the audit write.
    createAuditEvent({
      orgId,
      userId: opts.userId,
      action: AuditAction.PII_REDACTED,
      resourceType: opts.contractId ? 'contract' : 'request',
      resourceId: opts.contractId ?? 'system',
      metadata: {
        surface: opts.surface,
        mode,
        counts: result.counts,
        total: result.total,
      },
    }).catch((err: unknown) => {
      // Audit log failure shouldn't break the request — but log it.
      console.error('[pii-policy] failed to write audit event:', err)
    })
  }
  return { text: result.text, mode, counts: result.counts, total: result.total }
}

/**
 * Redact a batch of excerpts under one policy read and ONE audit event.
 *
 * The search and comparison tools return many excerpts per call — a portfolio
 * search over 20 contracts, a 10x10 comparison matrix. Calling applyPiiPolicy
 * per excerpt would read the policy 20 times and write 20 `PII_REDACTED` audit
 * rows for what is, from the user's point of view, a single action. That buries
 * the audit trail it exists to provide.
 *
 * Returns the redacted texts in input order, plus the combined counts.
 */
export async function applyPiiPolicyBatch(
  orgId: string,
  texts: string[],
  opts: ApplyOptions,
): Promise<{ texts: string[]; mode: PiiMode; counts: Partial<Record<PiiKind, number>>; total: number }> {
  const mode: PiiMode = opts.override ?? await getOrgPiiMode(orgId)
  if (mode === 'off' || texts.length === 0) {
    return { texts, mode, counts: {}, total: 0 }
  }

  const counts: Partial<Record<PiiKind, number>> = {}
  let total = 0
  const out = texts.map(t => {
    const r = redactPii(t ?? '', mode)
    for (const [kind, n] of Object.entries(r.counts)) {
      counts[kind as PiiKind] = (counts[kind as PiiKind] ?? 0) + (n ?? 0)
    }
    total += r.total
    return r.text
  })

  if (total > 0) {
    createAuditEvent({
      orgId,
      userId: opts.userId,
      action: AuditAction.PII_REDACTED,
      resourceType: opts.contractId ? 'contract' : 'request',
      resourceId: opts.contractId ?? 'system',
      metadata: { surface: opts.surface, mode, counts, total, excerpts: texts.length },
    }).catch((err: unknown) => {
      console.error('[pii-policy] failed to write audit event:', err)
    })
  }
  return { texts: out, mode, counts, total }
}

/** Test/admin helper: clear the cache when an org's setting changes. */
export function clearOrgPiiModeCache(orgId?: string): void {
  if (orgId) orgModeCache.delete(orgId)
  else orgModeCache.clear()
}
