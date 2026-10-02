/**
 * docs/41 Part 14 — a person's calendar feed: notice deadlines, expiries and
 * obligation due dates for the contracts they can see, as an .ics file their
 * calendar app subscribes to (GET /calendar/:token.ics).
 *
 * The link's token is random, signed with the server secret (so a made-up
 * token is turned away before the database is asked), and kept only as a
 * SHA-256 hash. One feed per person: a new link replaces the old one, and
 * revoking it makes the link 404.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from './prisma.js'
import { resolveSecret } from './secrets.js'
import { withoutTenantGuard } from './tenant-context.js'
import { resolveCallerScope, contractScopeWhere } from './agent-scope.js'

const RANDOM_LEN = 32   // 24 bytes, base64url
const SIG_LEN = 16

const sign = (random: string) =>
  createHmac('sha256', resolveSecret('JWT_SECRET')).update(`calendar-feed:${random}`).digest('base64url').slice(0, SIG_LEN)

export const hashFeedToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Is this token one we could have made? Checked before any database read. */
export function feedTokenSigned(token: string): boolean {
  if (token.length !== RANDOM_LEN + SIG_LEN || !/^[A-Za-z0-9_-]+$/.test(token)) return false
  const want = Buffer.from(sign(token.slice(0, RANDOM_LEN)))
  const got = Buffer.from(token.slice(RANDOM_LEN))
  return want.length === got.length && timingSafeEqual(want, got)
}

/** A new link for this person, replacing any earlier one. The token is returned once. */
export async function createFeedToken(orgId: string, userId: string): Promise<{ token: string; createdAt: Date }> {
  const random = randomBytes(24).toString('base64url')
  const token = random + sign(random)
  const tokenHash = hashFeedToken(token)
  const now = new Date()
  const existing = await prisma.calendarFeed.findFirst({ where: { orgId, userId }, select: { id: true } })
  if (existing) {
    await prisma.calendarFeed.update({ where: { id: existing.id }, data: { tokenHash, revokedAt: null, rotatedAt: now, version: { increment: 1 } } })
  } else {
    await prisma.calendarFeed.create({ data: { orgId, userId, tokenHash, rotatedAt: now } })
  }
  return { token, createdAt: now }
}

/** Ends the link. True when there was one to end. */
export async function revokeFeedToken(orgId: string, userId: string): Promise<boolean> {
  const r = await prisma.calendarFeed.updateMany({ where: { orgId, userId, tokenHash: { not: null } }, data: { tokenHash: null, revokedAt: new Date() } })
  return r.count > 0
}

/** Whether this person has a working link, and since when. */
export async function feedStatus(orgId: string, userId: string) {
  const f = await prisma.calendarFeed.findFirst({ where: { orgId, userId }, select: { tokenHash: true, rotatedAt: true, revokedAt: true } })
  return { active: !!f?.tokenHash, createdAt: f?.tokenHash ? f.rotatedAt : null, revokedAt: f?.tokenHash ? null : f?.revokedAt ?? null }
}

/** The person a token belongs to, or null (bad signature, unknown, revoked, or left the org). */
export async function resolveFeedToken(token: string): Promise<{ orgId: string; userId: string } | null> {
  if (!feedTokenSigned(token)) return null
  // Before a tenant is known: the token names it.
  const feed = await withoutTenantGuard(() => prisma.calendarFeed.findUnique({
    where: { tokenHash: hashFeedToken(token) }, select: { orgId: true, userId: true, revokedAt: true },
  }))
  if (!feed || feed.revokedAt) return null
  const user = await withoutTenantGuard(() => prisma.user.findFirst({
    where: { id: feed.userId, orgId: feed.orgId, deletedAt: null, status: { not: 'DEACTIVATED' } }, select: { id: true },
  }))
  return user ? { orgId: feed.orgId, userId: feed.userId } : null
}

// ── The .ics file ─────────────────────────────────────────────────────────
const APP_BASE = process.env.FRONTEND_URL ?? 'http://localhost:5173'
const DAY = 24 * 60 * 60 * 1000

export interface FeedEvent { uid: string; day: Date; summary: string; description: string; url: string }

/** RFC 5545 text: backslash, semicolon, comma and newlines escaped. */
const esc = (s: string) => s.replace(/[,;\\]/g, m => `\\${m}`).replace(/\r?\n/g, '\\n')
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')
/** Lines longer than 75 octets continue on the next line after a space. */
function fold(line: string): string {
  const out: string[] = []
  let cur = ''
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = '' }
    cur += ch
  }
  out.push(cur)
  return out.join('\r\n ')
}

export function buildIcs(events: FeedEvent[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//draftLegal//Contract dates//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:Contract dates',
  ]
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT', `UID:${e.uid}@draftlegal`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(e.day)}`, `DTEND;VALUE=DATE:${ymd(new Date(e.day.getTime() + DAY))}`,
      `SUMMARY:${esc(e.summary)}`, `DESCRIPTION:${esc(e.description)}`, `URL:${e.url}`, 'TRANSP:TRANSPARENT', 'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

/**
 * The person's dates: for each contract they can see (all of the org's, or
 * only their own with an own-scope role), its last day to give notice, its
 * end date, and the due dates of its open obligations. A year back, three ahead.
 */
export async function feedEvents(orgId: string, userId: string, now = new Date()): Promise<FeedEvent[]> {
  const scope = await resolveCallerScope(orgId, userId, 'contract')
  if (scope.kind === 'none') return []
  const from = new Date(now.getTime() - 365 * DAY)
  const to = new Date(now.getTime() + 3 * 365 * DAY)
  const contracts = await prisma.contract.findMany({
    where: {
      orgId, deletedAt: null, ...contractScopeWhere(scope),
      OR: [{ noticeDeadline: { gte: from, lte: to } }, { expiryDate: { gte: from, lte: to } }],
    },
    select: { id: true, title: true, counterpartyName: true, noticeDeadline: true, expiryDate: true, noticeDays: true },
    take: 2_000,
  })
  const events: FeedEvent[] = []
  const who = (c: { counterpartyName: string | null }) => (c.counterpartyName ? ` with ${c.counterpartyName}` : '')
  for (const c of contracts) {
    const url = `${APP_BASE}/contracts/${c.id}`
    if (c.noticeDeadline && c.noticeDeadline >= from && c.noticeDeadline <= to) {
      events.push({
        uid: `notice-${c.id}`, day: c.noticeDeadline, url,
        summary: `Last day to give notice: ${c.title}`,
        description: `The last day to give notice${c.noticeDays ? ` (${c.noticeDays} days)` : ''} on ${c.title}${who(c)}, before it renews or ends.`,
      })
    }
    if (c.expiryDate && c.expiryDate >= from && c.expiryDate <= to) {
      events.push({ uid: `expiry-${c.id}`, day: c.expiryDate, url, summary: `Ends: ${c.title}`, description: `${c.title}${who(c)} reaches the end of its term.` })
    }
  }
  const obligations = await prisma.obligation.findMany({
    where: {
      orgId, dueDate: { gte: from, lte: to }, status: { in: ['OPEN', 'OVERDUE'] }, reviewState: { not: 'DISMISSED' }, supersededAt: null,
      contract: { deletedAt: null, ...contractScopeWhere(scope) },
    },
    select: { id: true, description: true, dueDate: true, contractId: true, contract: { select: { title: true } } },
    take: 2_000,
  })
  for (const o of obligations) {
    events.push({
      uid: `obligation-${o.id}`, day: o.dueDate!, url: `${APP_BASE}/contracts/${o.contractId}`,
      summary: `Due: ${o.description.slice(0, 80)}`, description: `${o.description} (${o.contract.title})`,
    })
  }
  return events.sort((a, b) => a.day.getTime() - b.day.getTime())
}
