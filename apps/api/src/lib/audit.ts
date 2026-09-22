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
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import type { AuditAction } from '@clm/types'

interface AuditParams {
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
  // expected behaviour at Serializable isolation. Catch and retry up
  // to 5 times with exponential backoff (10ms / 20ms / 40ms / 80ms /
  // 160ms) — total worst-case wait ~310ms, still well under any
  // reasonable request budget. If we're STILL conflicting after 5
  // tries we surface the error so callers can react (or rate-limit).
  const MAX_ATTEMPTS = 5
  let lastErr: unknown = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
      return // success
    } catch (err) {
      lastErr = err
      const code = (err as { code?: string }).code
      // P2034 = "Transaction failed due to a write conflict or a deadlock"
      // 40001 = Postgres serialization_failure (reaches Prisma as P2034 too)
      const isRetryable = code === 'P2034' ||
        (err as { meta?: { code?: string } }).meta?.code === '40001'
      if (!isRetryable || attempt === MAX_ATTEMPTS - 1) throw err
      const backoffMs = 10 * Math.pow(2, attempt) // 10, 20, 40, 80, 160
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }
  throw lastErr
}

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
export async function verifyAuditChain(
  orgId: string,
  opts: { sinceDate?: Date; limit?: number } = {},
): Promise<ChainVerifyResult> {
  const events = await prisma.auditEvent.findMany({
    where: {
      orgId,
      ...(opts.sinceDate && { createdAt: { gte: opts.sinceDate } }),
    },
    orderBy: { createdAt: 'asc' },
    take: opts.limit,
  })

  let prevHash: string | null = null
  let verified = 0
  for (const e of events) {
    if (!e.hash) {
      // Unhashed legacy row — skip but don't break the chain since
      // older events pre-date this feature.
      verified++
      continue
    }
    if (e.prevHash !== prevHash) {
      return {
        ok: false,
        total: events.length,
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
        total: events.length,
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

  return { ok: true, total: events.length, verified, firstBreak: null }
}
