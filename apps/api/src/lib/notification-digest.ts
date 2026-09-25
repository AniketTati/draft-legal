/**
 * Z4 — the daily digest. Settings › Notifications offered "Daily digest: one
 * email at 9am", and every email still went out as it happened.
 *
 * A notification for someone on the daily digest is written as usual, marked
 * `emailDigest` (lib/notification-delivery.ts). Every 15 minutes the scan
 * worker runs sendDueDigests: from 9am in each person's own timezone
 * (Settings › General), each person with notifications waiting gets one
 * email listing them, once per local day. A run missed while the API was down
 * is caught up by the next one.
 *
 * Kept out of workers/ for the reason given in notification-delivery.ts: a
 * worker module starts a BullMQ Worker when imported.
 */
import { prisma } from './prisma.js'
import { redis } from './redis.js'
import { isEmailConfigured, sendEmail } from './mailer.js'

export const DIGEST_HOUR = 9
/** How many notifications one digest lists; the rest are counted. */
const LISTED = 50
const APP_BASE = process.env.FRONTEND_URL ?? 'http://localhost:5173'

export interface DigestRun {
  /** People with notifications waiting. */
  users:         number
  sent:          number
  notifications: number
  /** Not yet 9am where they are, or already sent today. */
  waiting:       number
  errors:        string[]
}

function zoneOf(preferences: unknown): string {
  const zone = (preferences as { general?: { timezone?: unknown } } | null)?.general?.timezone
  if (typeof zone !== 'string' || !zone) return 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone } catch { return 'UTC' }
}

/** The local date (YYYY-MM-DD) and hour at `now` in `timeZone`. */
export function localClock(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) }
}

const sentKey = (userId: string, localDate: string) => `notification-digest:${userId}:${localDate}`

function compose(name: string | null, rows: Array<{ title: string; body: string; resourceType: string; resourceId: string }>, more: number): string {
  const lines = rows.map(r => {
    const link = r.resourceType === 'contract' ? `\n  ${APP_BASE}/contracts/${r.resourceId}` : ''
    return `• ${r.title}\n  ${r.body}${link}`
  })
  return [
    `Hello${name ? ` ${name}` : ''},`,
    '',
    `Here is what happened in DraftLegal since your last digest:`,
    '',
    ...lines,
    ...(more > 0 ? ['', `…and ${more} more in DraftLegal.`] : []),
    '',
    `Open DraftLegal: ${APP_BASE}`,
    '',
    'You get this once a day because Settings › Notifications is set to "Daily digest".',
  ].join('\n')
}

export async function sendDueDigests(now: Date = new Date()): Promise<DigestRun> {
  const run: DigestRun = { users: 0, sent: 0, notifications: 0, waiting: 0, errors: [] }
  // Nothing is held without a mailer (notification-delivery.ts).
  if (!isEmailConfigured()) return run

  const waiting = await prisma.notification.groupBy({ by: ['userId'], where: { emailDigest: true } })
  for (const { userId } of waiting) {
    run.users++
    try {
      const user = await prisma.user.findUnique({
        where:  { id: userId },
        select: { email: true, name: true, preferences: true, status: true, deletedAt: true },
      })
      const prefs = (user?.preferences ?? {}) as { notifications?: { digest?: string } }
      if (!user?.email || user.status !== 'ACTIVE' || user.deletedAt || prefs.notifications?.digest === 'off') {
        // No one to send to, or they have paused email since: nothing to hold.
        await prisma.notification.updateMany({ where: { userId, emailDigest: true }, data: { emailDigest: false } })
        continue
      }

      const clock = localClock(now, zoneOf(user.preferences))
      if (clock.hour < DIGEST_HOUR || await redis.exists(sentKey(userId, clock.date))) { run.waiting++; continue }

      const held = await prisma.notification.findMany({
        where:   { userId, emailDigest: true },
        orderBy: { createdAt: 'asc' },
        select:  { id: true, title: true, body: true, resourceType: true, resourceId: true },
      })
      if (held.length === 0) continue
      const result = await sendEmail({
        to:      user.email,
        subject: `Your DraftLegal digest: ${held.length} update${held.length === 1 ? '' : 's'}`,
        text:    compose(user.name, held.slice(0, LISTED), held.length - LISTED),
      })
      if (!result.sent) { run.errors.push(`${userId}: ${result.reason ?? 'not sent'}`); continue }

      await redis.set(sentKey(userId, clock.date), '1', 'EX', 36 * 60 * 60)
      await prisma.notification.updateMany({ where: { id: { in: held.map(h => h.id) } }, data: { emailDigest: false } })
      run.sent++
      run.notifications += held.length
    } catch (err) {
      run.errors.push(`${userId}: ${(err as Error).message.slice(0, 160)}`)
    }
  }
  return run
}
