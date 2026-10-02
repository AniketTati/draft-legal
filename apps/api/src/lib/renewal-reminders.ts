/**
 * docs/41 Part 14 — who hears about a renewal.
 *
 *   • reminders go to the contract's owner and everyone watching it;
 *   • when the notice deadline is close (an org setting, 14 days by default)
 *     and nobody has decided, Legal Ops — the people who can configure
 *     workflows — are told once for that deadline.
 *
 * The scan itself is scanRenewals (lib/obligation-scanner.ts).
 */
import { prisma } from './prisma.js'
import { getPermissionsForRoles, evaluatePermission } from './permissions.js'

export const DEFAULT_ESCALATION_DAYS = 14

/** The org's "escalate this many days before the notice deadline" setting. */
export function escalationDays(settings: unknown): number {
  const v = (settings as { renewalEscalationDays?: unknown } | null)?.renewalEscalationDays
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 365 ? Math.round(v) : DEFAULT_ESCALATION_DAYS
}

const ACTIVE = { deletedAt: null, status: { not: 'DEACTIVATED' } } as const

/** The owner, then the watchers: active people in the org, each once. */
export async function renewalRecipients(orgId: string, contractId: string, ownerId: string) {
  const watchers = await prisma.contractWatcher.findMany({ where: { orgId, contractId }, select: { userId: true } })
  const ids = [ownerId, ...watchers.map(w => w.userId)]
  const users = await prisma.user.findMany({
    where: { orgId, id: { in: ids }, ...ACTIVE },
    select: { id: true, email: true },
  })
  return ids.map(id => users.find(u => u.id === id)).filter((u, i, all): u is NonNullable<typeof u> => !!u && all.indexOf(u) === i)
}

/** Legal Ops: active people whose roles let them configure workflows org-wide. */
export async function legalOpsUsers(orgId: string) {
  const users = await prisma.user.findMany({
    where: { orgId, ...ACTIVE },
    select: { id: true, email: true, userRoles: { select: { role: { select: { name: true } } } } },
    take: 2_000,
  })
  const out: Array<{ id: string; email: string | null }> = []
  // People share role sets, so each set is evaluated once.
  const granted = new Map<string, boolean>()
  for (const u of users) {
    const roles = u.userRoles.map(r => r.role.name).sort()
    const key = roles.join('|')
    if (!granted.has(key)) {
      const perms = await getPermissionsForRoles(orgId, roles)
      granted.set(key, evaluatePermission(perms, 'configure', 'workflow').scope === 'org')
    }
    if (granted.get(key)) out.push({ id: u.id, email: u.email })
  }
  return out
}

/**
 * Is an undecided renewal due to be escalated? Yes when its notice deadline is
 * today or within `days` days, and it hasn't been escalated for this deadline
 * already (a new deadline — the next term's — is a new window).
 */
export function escalationDue(
  deadline: Date | null, now: number, days: number, escalatedFor: string | undefined,
): { due: boolean; key: string | null } {
  if (!deadline) return { due: false, key: null }
  const key = deadline.toISOString().slice(0, 10)
  const today = new Date(now).toISOString().slice(0, 10)
  const last = new Date(now + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { due: key >= today && key <= last && escalatedFor !== key, key }
}
