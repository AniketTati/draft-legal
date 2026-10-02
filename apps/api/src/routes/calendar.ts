/**
 * docs/41 Part 14 — the calendar feed (lib/calendar-feed.ts).
 *
 *   GET    /api/v1/calendar/:token.ics   the feed itself; the token is the only key (calendar apps send no login)
 *   GET    /api/v1/calendar-feed         whether I have a link
 *   POST   /api/v1/calendar-feed         a new link (replaces the old one); the URL is shown once
 *   DELETE /api/v1/calendar-feed         end my link
 */
import type { FastifyInstance } from 'fastify'
import { AuditAction } from '@clm/types'
import { requireUser } from '../middleware/auth.js'
import { setTenant } from '../lib/tenant-context.js'
import { createAuditEvent } from '../lib/audit.js'
import { buildIcs, createFeedToken, feedEvents, feedStatus, resolveFeedToken, revokeFeedToken } from '../lib/calendar-feed.js'

const NOT_FOUND = { type: 'https://httpstatuses.com/404', title: 'Not Found', status: 404, detail: 'This calendar link doesn’t work any more.' }

/** The feed's public URL (the web app proxies /api, as the SSO callbacks assume). */
const feedUrl = (token: string) =>
  `${(process.env.API_PUBLIC_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/api/v1/calendar/${token}.ics`

export async function calendarFeedRoutes(app: FastifyInstance) {
  app.get('/calendar/:file', async (req, reply) => {
    const { file } = req.params as { file: string }
    if (!file.endsWith('.ics')) return reply.status(404).send(NOT_FOUND)
    const who = await resolveFeedToken(file.slice(0, -4))
    if (!who) return reply.status(404).send(NOT_FOUND)
    setTenant(who.orgId)
    const ics = buildIcs(await feedEvents(who.orgId, who.userId))
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('cache-control', 'private, max-age=900')
      .header('content-disposition', 'inline; filename="contract-dates.ics"')
      .send(ics)
  })

  app.get('/calendar-feed', { preHandler: requireUser }, async (req, reply) => {
    return reply.send(await feedStatus(req.user.orgId, req.user.sub))
  })

  app.post('/calendar-feed', { preHandler: requireUser }, async (req, reply) => {
    const { orgId, sub } = req.user
    const { token, createdAt } = await createFeedToken(orgId, sub)
    await createAuditEvent({ orgId, userId: sub, action: AuditAction.CALENDAR_FEED_CREATED, resourceType: 'user', resourceId: sub, ipAddress: req.ip })
    return reply.status(201).send({ active: true, createdAt, url: feedUrl(token) })
  })

  app.delete('/calendar-feed', { preHandler: requireUser }, async (req, reply) => {
    const { orgId, sub } = req.user
    if (await revokeFeedToken(orgId, sub)) {
      await createAuditEvent({ orgId, userId: sub, action: AuditAction.CALENDAR_FEED_REVOKED, resourceType: 'user', resourceId: sub, ipAddress: req.ip })
    }
    return reply.send(await feedStatus(orgId, sub))
  })
}
