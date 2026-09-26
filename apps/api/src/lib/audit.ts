/**
 * Audit logger with tamper-evident hash chain (P7.5.4).
 *
 * Each audit event stores a SHA-256 hash linking back to the previous
 * event of the same org. If anyone modifies a row in the database
 * (action, metadata, etc.), the hash no longer matches and every
 * subsequent event's prevHash also fails to verify — so a single
 * `verifyAuditChain(orgId)` walk reveals tampering anywhere in the
 * sequence.
 *
 * Why per-org chains rather than one global chain:
 *   - We multi-tenant on orgId throughout. A global chain would force
 *     a serial bottleneck across all tenants.
 *   - Tampering detection only needs to be per-tenant (each tenant
 *     reviews their own log).
 *
 * Hash content (canonical-ordered JSON):
 *   {
 *     id, orgId, userId, action, resourceType, resourceId,
 *     metadata, ipAddress, userAgent, createdAt, prevHash
 *   }
 *
 * Concurrency: two events created in the same millisecond on different
 * connections could race for the "previous" slot. To handle this we
 * wrap the insert in a transaction that locks the most-recent row of
 * the org with `FOR UPDATE`. Cost: one extra row read per event.
 */
import crypto from 'node:crypto'
import type { Prisma, AuditEvent } from '@prisma/client'
import { prisma } from './prisma.js'
import type { AuditAction } from '@clm/types'

export interface AuditParams {
  orgId: string
  userId?: string
  action: AuditAction
  resourceType: string
  resourceId: string
  metadata?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

/**
 * Z4 — code that acts on what the log records, run once an event is stored.
 * lib/contract-change-notice.ts registers from app.ts, so this module stays
 * free of queues. A listener's failure is logged, never the caller's.
 */
type AuditListener = (event: AuditParams) => Promise<unknown> | unknown
const listeners = new Set<AuditListener>()
export function afterAuditEvent(listener: AuditListener): void { listeners.add(listener) }

/**
 * Canonical-stringify an object so the hash is deterministic. JSON
 * keys are sorted; Date values become ISO strings.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/** Compute the hash an audit row would have. */
export function hashAuditRow(row: {
  id: string
  orgId: string
  userId: string | null
  action: string
  resourceType: string
  resourceId: string
  metadata: unknown
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  prevHash: string | null
}): string {
  const payload = canonicalize({
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    prevHash: row.prevHash,
  })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

export async function createAuditEvent(
  params: AuditParams,
  // Run a write in the same transaction as the audit row, so a change and
  // its record commit together: a failed audit can't leave a silent change
  // (X5). Re-run on a serialization retry, so it must be idempotent.
  opts: { within?: (tx: Prisma.TransactionClient) => Promise<void> } = {},
): Promise<void> {
  // Lookup the previous event for this org, then create the new one
  // with prevHash + hash. We use a transaction with serializable
  // isolation to avoid two concurrent writes both reading the same
  // "previous" row and both linking to it.
  //
  // P2034 retry loop (2026-04-29 audit fix): under concurrent writes
  // Postgres throws P2034 / 40001 serialization failures; that's the
  // expected behaviour at Serializable isolation. Catch and retry.
  //
  // X34 — it used to retry 5 times on a fixed 10–160 ms backoff. Writers
  // that collided slept the same time and collided again, so in a burst
  // (parallel chat tool calls, each logging a PII redaction) some ran out
  // of attempts and their event was lost. Now each retry sleeps a random
  // part of the backoff, and retries continue until a time budget is
  // spent. The retried transaction starts afresh, so its createdAt stays
  // after the row it links to, which the chain's order depends on.
  const deadline = Date.now() + RETRY_BUDGET_MS
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        await opts.within?.(tx)
        const prev = await tx.auditEvent.findFirst({
          where: { orgId: params.orgId },
          orderBy: { createdAt: 'desc' },
          select: { hash: true },
        })

        // Two-phase: create the row, then update it with the hash. We
        // can't compute the hash before insert because we need the auto-
        // generated id and createdAt to be part of the hashed payload.
        const created = await tx.auditEvent.create({
          data: {
            orgId: params.orgId,
            userId: params.userId,
            action: params.action,
            resourceType: params.resourceType,
            resourceId: params.resourceId,
            metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
            ipAddress: params.ipAddress,
            userAgent: params.userAgent,
            prevHash: prev?.hash ?? null,
          },
        })

        const hash = hashAuditRow({
          id: created.id,
          orgId: created.orgId,
          userId: created.userId,
          action: created.action,
          resourceType: created.resourceType,
          resourceId: created.resourceId,
          metadata: created.metadata,
          ipAddress: created.ipAddress,
          userAgent: created.userAgent,
          createdAt: created.createdAt,
          prevHash: created.prevHash,
        })

        await tx.auditEvent.update({
          where: { id: created.id },
          data: { hash },
        })
      }, {
        // Serializable so concurrent appends to the same org's chain are
        // strictly ordered. Audit volume is low; the perf cost is fine.
        isolationLevel: 'Serializable',
      })
      for (const listener of listeners) {
        Promise.resolve()
          .then(() => listener(params))
          .catch((err: Error) => console.warn('[audit] listener failed for %s: %s', params.action, err.message))
      }
      return // success
    } catch (err) {
      const code = (err as { code?: string }).code
      // P2034 = "Transaction failed due to a write conflict or a deadlock"
      // 40001 = Postgres serialization_failure (reaches Prisma as P2034 too)
      const isRetryable = code === 'P2034' ||
        (err as { meta?: { code?: string } }).meta?.code === '40001'
      if (!isRetryable || Date.now() >= deadline) throw err
      // Full jitter: up to 10, 20, 40… ms, capped.
      const backoffMs = Math.random() * Math.min(RETRY_CAP_MS, 10 * 2 ** attempt)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }
}

/** X34 — how long an append keeps retrying serialization failures, and the most one retry sleeps. */
const RETRY_BUDGET_MS = 5_000
const RETRY_CAP_MS = 250

export interface ChainVerifyResult {
  ok: boolean
  total: number
  verified: number
  firstBreak: {
    eventId: string
    expected: string
    got: string
    reason: 'hash_mismatch' | 'prev_hash_mismatch' | 'missing_hash'
  } | null
}

/**
 * Walk the org's audit chain in createdAt order and re-verify each
 * row's hash + prevHash linkage. Returns the first break or ok:true.
 *
 * Performance: this is O(N) per org. Run as a periodic job, not on
 * every read. Audit-log row counts grow slowly enough this stays
 * comfortable into the millions.
 */
/** Z1 — what checking one event against the chain found. */
export type AuditEventCheck = 'intact' | 'unhashed' | 'hash_mismatch' | 'prev_hash_mismatch'

/**
 * Z1 — check chosen events against the org's chain, by the same rules as
 * verifyAuditChain: each event's own hash, and its link to the hashed event
 * before it. For a report that lists some of an org's events, such as a
 * contract's compliance package, without walking the whole log. One lookup
 * per event.
 */
export async function checkAuditEvents(orgId: string, events: AuditEvent[]): Promise<Map<string, AuditEventCheck>> {
  const checks = new Map<string, AuditEventCheck>()
  for (const e of events) {
    if (!e.hash) { checks.set(e.id, 'unhashed'); continue }
    const expected = hashAuditRow({
      id: e.id, orgId: e.orgId, userId: e.userId, action: e.action,
      resourceType: e.resourceType, resourceId: e.resourceId, metadata: e.metadata,
      ipAddress: e.ipAddress, userAgent: e.userAgent, createdAt: e.createdAt, prevHash: e.prevHash,
    })
    if (expected !== e.hash) { checks.set(e.id, 'hash_mismatch'); continue }
    const before = await prisma.auditEvent.findFirst({
      where: {
        orgId,
        hash: { not: null },
        OR: [{ createdAt: { lt: e.createdAt } }, { createdAt: e.createdAt, id: { lt: e.id } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { hash: true },
    })
    checks.set(e.id, e.prevHash === (before?.hash ?? null) ? 'intact' : 'prev_hash_mismatch')
  }
  return checks
}

export async function verifyAuditChain(
  orgId: string,
  opts: { sinceDate?: Date; limit?: number } = {},
): Promise<ChainVerifyResult> {
  // X3 — walked in batches, yielding between them: loading an org's whole log
  // at once took ~0.5 GB and blocked the event loop for large orgs. (Ties on
  // createdAt are ordered by id so the batches are stable.)
  const BATCH = 1_000
  let prevHash: string | null = null
  let verified = 0
  let seen = 0
  let after: { createdAt: Date; id: string } | null = null
  for (;;) {
    const take = opts.limit != null ? Math.min(BATCH, opts.limit - seen) : BATCH
    if (take <= 0) break
    const events: AuditEvent[] = await prisma.auditEvent.findMany({
      where: {
        orgId,
        ...(opts.sinceDate && { createdAt: { gte: opts.sinceDate } }),
        ...(after && { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
    })
    if (events.length === 0) break

    for (const e of events) {
      seen++
      if (!e.hash) {
        // Unhashed legacy row — skip but don't break the chain since
        // older events pre-date this feature.
        verified++
        continue
      }
      if (e.prevHash !== prevHash) {
        return {
          ok: false,
          total: seen,
          verified,
          firstBreak: {
            eventId: e.id,
            expected: prevHash ?? '(null)',
            got: e.prevHash ?? '(null)',
            reason: 'prev_hash_mismatch',
          },
        }
      }
      const expectedHash = hashAuditRow({
        id: e.id,
        orgId: e.orgId,
        userId: e.userId,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        metadata: e.metadata,
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
        createdAt: e.createdAt,
        prevHash: e.prevHash,
      })
      if (expectedHash !== e.hash) {
        return {
          ok: false,
          total: seen,
          verified,
          firstBreak: {
            eventId: e.id,
            expected: expectedHash,
            got: e.hash,
            reason: 'hash_mismatch',
          },
        }
      }
      prevHash = e.hash
      verified++
    }
    const last: AuditEvent = events[events.length - 1]
    after = { createdAt: last.createdAt, id: last.id }
    await new Promise(resolve => setImmediate(resolve))
  }

  return { ok: true, total: seen, verified, firstBreak: null }
}
