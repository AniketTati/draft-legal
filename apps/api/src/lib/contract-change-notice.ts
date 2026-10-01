/**
 * Z4 — "A contract I own is updated". Settings offered the toggle, and nothing
 * ever sent the notification it controls.
 *
 * Every change to a contract is recorded in the audit log, from any route and
 * from the agent acting for someone. So this listens there (registered in
 * app.ts) and tells the owner when a colleague changed their contract, at most
 * once an hour per contract. Whether it is emailed is the owner's setting,
 * like every notification (lib/notification-prefs.ts). A version the
 * counterparty returns has its own notice, COUNTERPARTY_VERSION, sent by the
 * portal and inbound-email routes.
 */
import { AuditAction } from '@clm/types'
import { prisma } from './prisma.js'
import { redis } from './redis.js'
import { queueNotification } from './queue.js'
import type { AuditParams } from './audit.js'

/** The audit actions that mean the contract itself changed, and how to say so. */
const CHANGES: Partial<Record<AuditAction, string>> = {
  [AuditAction.CONTRACT_UPDATED]:        'edited',
  [AuditAction.CONTRACT_STATUS_CHANGED]: 'changed the status of',
  [AuditAction.STAGE_CHANGED]:           'moved',
  [AuditAction.VERSION_CREATED]:         'added a version to',
  [AuditAction.VERSION_RESTORED]:        'restored an earlier version of',
}

export const CHANGE_NOTICE_WINDOW_S = 60 * 60

/** Returns what it did, for tests and logs. */
export async function noticeContractChange(event: AuditParams): Promise<string> {
  const verb = CHANGES[event.action]
  if (!verb || event.resourceType !== 'contract' || !event.resourceId) return 'not a contract change'
  // A change with no one behind it is the system's own (extraction, internal
  // calls): not what the owner asked to hear about.
  if (!event.userId) return 'a system change'

  const contract = await prisma.contract.findFirst({
    where:  { id: event.resourceId, orgId: event.orgId, deletedAt: null },
    select: { id: true, title: true, ownerId: true },
  })
  if (!contract?.ownerId) return 'no owner'
  if (contract.ownerId === event.userId) return 'changed by the owner'

  const [owner, actor] = await Promise.all([
    prisma.user.findFirst({ where: { id: contract.ownerId, orgId: event.orgId, deletedAt: null }, select: { id: true, email: true } }),
    prisma.user.findFirst({ where: { id: event.userId, orgId: event.orgId }, select: { name: true, email: true } }),
  ])
  if (!owner) return 'no owner'

  // One notice an hour per contract and owner, however many edits.
  const fresh = await redis.set(`contract-change-notice:${contract.id}:${owner.id}`, '1', 'EX', CHANGE_NOTICE_WINDOW_S, 'NX')
  if (fresh !== 'OK') return 'owner told within the hour'

  const who = actor?.name ?? actor?.email ?? 'A colleague'
  queueNotification({
    orgId:        event.orgId,
    userId:       owner.id,
    type:         'CONTRACT_UPDATED',
    title:        `${contract.title} was updated`,
    body:         `${who} ${verb} "${contract.title}". Further changes in the next hour won't send another notice.`,
    resourceType: 'contract',
    resourceId:   contract.id,
    email:        owner.email ?? undefined,
  })
  return 'queued'
}
