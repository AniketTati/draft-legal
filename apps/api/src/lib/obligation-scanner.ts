/**
 * Obligation scanner (P5.2 / docs/30 Wave H.2 — promoted to first-class
 * Obligation rows in P8 Step 1)
 *
 * Queries the Obligation table for items whose dueDate falls inside the
 * lead window and fires in-app + email notifications. Idempotent —
 * notifiedAt is stamped on each row that gets notified, so re-running
 * the scan the same day skips already-notified items via cooldownMs.
 *
 * Designed to be called:
 *   • manually from the admin UI (POST /cron/obligations)
 *   • daily from a real cron/scheduler
 *   • from a BullMQ repeatable job (P8 Step 6)
 *
 * JTBD — close the loop between "extractor pulled out deliverables"
 * and "someone actually did them on time". Without this, obligations
 * sit dormant and the customer misses a renewal / a payment / an audit
 * window — exactly the failure mode the post-signature wave is meant
 * to kill.
 */
import { prisma } from './prisma.js'
import { queueNotification } from './queue.js'
import { createAuditEvent } from './audit.js'
import { AuditAction } from '@clm/types'
import { renewalNotice } from './renewal-notice.js'
import { fireWebhook } from './webhook-events.js'

export interface ScanOptions {
  /** Only walk this one org. Omit to scan all orgs. */
  orgId?:    string
  /** How far ahead to look. Default 7 days; renewal advisor bumps to 90. */
  leadDays?: number
  /** Force-renotify even if notifiedAt was set within the cooldown. */
  force?:    boolean
  /** Min ms between renotifications for the same obligation. Default 72h. */
  cooldownMs?: number
}

export interface ScanResult {
  scannedContracts:  number
  obligationsSeen:   number
  notified:          number
  skippedAcked:      number
  skippedCooldown:   number
  skippedNoOwner:    number
  errors:            string[]
}

/**
 * Resolve who to notify for a given obligation + contract.
 * Priority: contract.ownerId → first admin user in the org.
 * We never send to the counterparty (they're not in our Users table
 * unless they invited themselves; the portal has its own channel).
 */
async function resolveRecipient(
  orgId: string,
  contractOwnerId: string,
): Promise<{ userId: string; email: string | null } | null> {
  const owner = await prisma.user.findFirst({
    where: { id: contractOwnerId, orgId },
    select: { id: true, email: true },
  })
  if (owner) return { userId: owner.id, email: owner.email }
  // fallback — any active org user
  const any = await prisma.user.findFirst({
    where: { orgId, status: 'ACTIVE' },
    select: { id: true, email: true },
    orderBy: { createdAt: 'asc' },
  })
  return any ? { userId: any.id, email: any.email } : null
}

/**
 * Walk every OPEN obligation in the lead window, fire notifications,
 * stamp notifiedAt back on each row. Idempotent via the cooldown check.
 */
export async function scanObligations(opts: ScanOptions = {}): Promise<ScanResult> {
  const leadDays   = opts.leadDays   ?? 7
  const cooldownMs = opts.cooldownMs ?? 72 * 60 * 60 * 1000
  const now        = Date.now()
  const windowEnd  = new Date(now + leadDays * 24 * 60 * 60 * 1000)
  const graceStart = new Date(now - 7 * 24 * 60 * 60 * 1000)

  const res: ScanResult = {
    scannedContracts: 0,
    obligationsSeen:  0,
    notified:         0,
    skippedAcked:     0,
    skippedCooldown:  0,
    skippedNoOwner:   0,
    errors:           [],
  }

  const obWhere: Record<string, unknown> = {
    status:  'OPEN',
    dueDate: { gte: graceStart, lte: windowEnd },
  }
  if (opts.orgId) obWhere.orgId = opts.orgId

  const obligations = await prisma.obligation.findMany({
    where: obWhere as never,
    include: {
      contract: {
        select: { id: true, orgId: true, title: true, ownerId: true, status: true },
      },
    },
    take: 5_000,
  })
  res.obligationsSeen = obligations.length
  res.scannedContracts = new Set(obligations.map(o => o.contractId)).size

  for (const o of obligations) {
    if (!o.dueDate) continue
    if (!o.contract) continue

    if (!opts.force && o.notifiedAt) {
      const lastNote = o.notifiedAt.getTime()
      if (now - lastNote < cooldownMs) {
        res.skippedCooldown++
        continue
      }
    }

    const recipient = await resolveRecipient(o.contract.orgId, o.contract.ownerId)
    if (!recipient) { res.skippedNoOwner++; continue }

    const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0)
    const dueMid   = new Date(o.dueDate); dueMid.setHours(0, 0, 0, 0)
    const daysOut  = Math.round((dueMid.getTime() - todayMid.getTime()) / (24 * 60 * 60 * 1000))
    const severity = (o.severity ?? 'medium').toUpperCase()
    const prefix   = daysOut < 0
      ? `Overdue ${Math.abs(daysOut)}d`
      : daysOut === 0
        ? 'Due today'
        : daysOut === 1
          ? 'Due tomorrow'
          : `Due in ${daysOut}d`

    queueNotification({
      orgId:        o.contract.orgId,
      userId:       recipient.userId,
      type:         'OBLIGATION_DUE',
      title:        `${prefix} · ${o.contract.title}`,
      body:         `${severity} · ${o.type} · ${o.description}`.slice(0, 400),
      resourceType: 'contract',
      resourceId:   o.contract.id,
      email:        recipient.email ?? undefined,
    })

    try {
      await prisma.obligation.update({
        where: { id: o.id },
        data:  { notifiedAt: new Date() },
      })
      res.notified++
    } catch (err) {
      res.errors.push(`${o.id}: ${(err as Error).message.slice(0, 160)}`)
    }

    // P8 Step 5 — fire OBLIGATION_OVERDUE audit event the first time we
    // see an obligation past its due date. Idempotent — we check the
    // audit log for a prior event keyed on this obligationId before
    // writing, so re-running the scanner doesn't spam the trail.
    if (daysOut < 0) {
      try {
        const prior = await prisma.auditEvent.findFirst({
          where: {
            orgId: o.contract.orgId,
            action: AuditAction.OBLIGATION_OVERDUE,
            resourceType: 'contract',
            resourceId: o.contract.id,
            metadata: { path: ['obligationId'], equals: o.id } as never,
          },
          select: { id: true },
        })
        if (!prior) {
          await createAuditEvent({
            orgId: o.contract.orgId,
            // No userId — scanner is system-driven.
            action: AuditAction.OBLIGATION_OVERDUE,
            resourceType: 'contract',
            resourceId: o.contract.id,
            metadata: {
              obligationId: o.id,
              type: o.type,
              severity: o.severity,
              daysOverdue: -daysOut,
              dueDate: o.dueDate?.toISOString().slice(0, 10),
            },
          })
          // H2 — once per obligation, like the audit event it rides on.
          fireWebhook(o.contract.orgId, 'obligation.overdue', {
            contractId: o.contract.id, obligationId: o.id, description: o.description,
            dueDate: o.dueDate?.toISOString().slice(0, 10) ?? null, daysOverdue: -daysOut,
          })
        }
      } catch (err) {
        res.errors.push(`overdue-audit ${o.id}: ${(err as Error).message.slice(0, 120)}`)
      }
    }
  }

  return res
}

// ─── P5.3 — Renewal scanner ─────────────────────────────────────────────────
/**
 * Walk every EXECUTED contract with a populated expiryDate, fire a
 * RENEWAL_DUE notification for each that expires within the lookahead
 * window and hasn't been notified during the cooldown.
 *
 * Separate from scanObligations() because the signal is different:
 *   • obligations scanner watches metadata.obligations[].dueDate
 *   • renewal  scanner watches Contract.expiryDate + metadata.renewalNotifiedAt
 *
 * A renewal notification is *high-value, low-frequency* — we only ping
 * the owner once per 7 days until they record a decision.
 *
 * C6 — an auto-renewing contract is also due when its NOTICE DEADLINE
 * (expiry − notice-to-terminate period, lib/renewal-notice.ts) is within
 * NOTICE_LEAD_DAYS or has passed. That deadline, not expiry, is the date
 * that can't be undone: with a 120-day notice period, an expiry-only 90-day
 * window alerted 30 days after the chance to opt out was gone.
 */
export interface ScanRenewalsOptions {
  orgId?:       string
  /** Default 90 days — the CLM industry standard renewal lookahead. */
  leadDays?:    number
  /** Ignore cooldown and renotify. */
  force?:       boolean
  /** Min ms between renotifications. Default 7 days. */
  cooldownMs?:  number
}

/** Alert this many days before an auto-renewal notice deadline. */
export const NOTICE_LEAD_DAYS = 30
/** How far past the lead window a notice deadline can sit: notice periods run up to a year. */
const MAX_NOTICE_DAYS = 366

export interface RenewalScanResult {
  scannedContracts:  number
  candidates:        number
  notified:          number
  skippedCooldown:   number
  skippedNoOwner:    number
  errors:            string[]
}

export async function scanRenewals(
  opts: ScanRenewalsOptions = {},
): Promise<RenewalScanResult> {
  const leadDays   = opts.leadDays   ?? 90
  const cooldownMs = opts.cooldownMs ?? 7 * 24 * 60 * 60 * 1000
  const now        = Date.now()
  const windowEnd  = now + leadDays * 24 * 60 * 60 * 1000

  const res: RenewalScanResult = {
    scannedContracts: 0, candidates: 0, notified: 0,
    skippedCooldown: 0, skippedNoOwner: 0, errors: [],
  }

  // Candidates: expiring inside the lead window, or far enough out that an
  // auto-renewal notice deadline could already be close. Which ones are
  // actually due is decided per contract below.
  const noticeWindowEnd = now + (MAX_NOTICE_DAYS + NOTICE_LEAD_DAYS) * 24 * 60 * 60 * 1000
  const where: Record<string, unknown> = {
    deletedAt:     null,
    status:        'EXECUTED',
    expiryDate:    { lte: new Date(Math.max(windowEnd, noticeWindowEnd)), gte: new Date(now - 30 * 24 * 60 * 60 * 1000) },
  }
  if (opts.orgId) where.orgId = opts.orgId

  const contracts = await prisma.contract.findMany({
    where: where as never,
    select: {
      id: true, orgId: true, title: true, ownerId: true,
      counterpartyName: true, metadata: true, expiryDate: true,
      type: true, value: true, currency: true, keyTerms: true,
    },
    orderBy: { expiryDate: 'asc' },
    take: 5_000,
  })
  res.scannedContracts = contracts.length

  for (const c of contracts) {
    if (!c.expiryDate) continue
    const notice = renewalNotice({ expiryDate: c.expiryDate, keyTerms: c.keyTerms })
    const expiringSoon = c.expiryDate.getTime() <= windowEnd
    const noticeDue = notice.deadline != null
      && notice.deadline.getTime() <= now + NOTICE_LEAD_DAYS * 24 * 60 * 60 * 1000
    if (!expiringSoon && !noticeDue) continue
    res.candidates++

    const md = (c.metadata ?? {}) as {
      renewalNotifiedAt?:  string
      renewalDecision?:    string  // 'renew' | 'renegotiate' | 'let_expire' | 'unknown'
    }
    if (!opts.force && md.renewalNotifiedAt) {
      const last = new Date(md.renewalNotifiedAt).getTime()
      if (!isNaN(last) && now - last < cooldownMs) {
        res.skippedCooldown++
        continue
      }
    }
    if (md.renewalDecision && md.renewalDecision !== 'unknown') {
      // Owner already logged a decision — no more reminders.
      res.skippedCooldown++
      continue
    }

    const owner = await prisma.user.findFirst({
      where: { id: c.ownerId, orgId: c.orgId },
      select: { id: true, email: true },
    })
    if (!owner) { res.skippedNoOwner++; continue }

    // Anchor to midnight for a clean daysOut count.
    const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0)
    const expMid   = new Date(c.expiryDate); expMid.setHours(0, 0, 0, 0)
    const daysOut  = Math.round((expMid.getTime() - todayMid.getTime()) / (24 * 60 * 60 * 1000))
    const label    = daysOut < 0 ? `Expired ${Math.abs(daysOut)}d ago`
                   : daysOut === 0 ? 'Expires today'
                   : `Expires in ${daysOut}d`

    const valueStr = c.value ? `${c.currency ?? 'USD'} ${c.value.toString()}` : ''

    // The notice deadline, when it is what makes this due, leads the alert.
    let title = `${label} · ${c.title}`
    let action = 'review renewal options now.'
    if (noticeDue && notice.deadline) {
      const dlMid = new Date(notice.deadline); dlMid.setHours(0, 0, 0, 0)
      const dlDays = Math.round((dlMid.getTime() - todayMid.getTime()) / (24 * 60 * 60 * 1000))
      const dlStr = notice.deadline.toISOString().slice(0, 10)
      const dlLabel = dlDays < 0 ? 'Notice deadline passed'
                    : dlDays === 0 ? 'Notice deadline today'
                    : `Notice deadline in ${dlDays}d`
      title = `${dlLabel} · ${c.title}`
      action = dlDays < 0
        ? `auto-renews: the ${notice.noticeDays}-day notice deadline (${dlStr}) has passed. Check whether it can still be stopped.`
        : `auto-renews unless ${notice.noticeDays} days' notice is served by ${dlStr}.`
    }

    queueNotification({
      orgId:        c.orgId,
      userId:       owner.id,
      type:         'RENEWAL_DUE',
      title,
      body:         `${c.counterpartyName ?? 'Counterparty'}${valueStr ? ` · ${valueStr}` : ''} — ${action}`.slice(0, 400),
      resourceType: 'contract',
      resourceId:   c.id,
      email:        owner.email ?? undefined,
    })

    try {
      const nextMeta = { ...(c.metadata as Record<string, unknown>), renewalNotifiedAt: new Date().toISOString() }
      await prisma.contract.update({
        where: { id: c.id },
        data:  { metadata: nextMeta as never },
      })
      res.notified++
    } catch (err) {
      res.errors.push(`${c.id}: ${(err as Error).message.slice(0, 160)}`)
    }
  }

  return res
}
