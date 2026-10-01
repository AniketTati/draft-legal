/**
 * REST Hooks for Zapier, Make and the like — docs/41 Part 20.
 *
 *   POST   /api/v1/hooks                  — subscribe { target_url, event } → { id, … }
 *   DELETE /api/v1/hooks/:id              — unsubscribe
 *   GET    /api/v1/hooks                  — this caller's subscriptions
 *   GET    /api/v1/hooks/samples/:event   — sample deliveries, for the trigger's test step
 *
 * The REST Hooks pattern (resthooks.org) on top of the webhooks we already
 * deliver: a subscription is a Webhook row with one event, signed and retried
 * by the webhook worker exactly as an admin-made one, and listed on the
 * Integrations page. Callers use an API key with the `hooks` scope (or a
 * signed-in admin). See docs/42-ZAPIER-REST-HOOKS.md.
 */
import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { actingUserId } from '../lib/acting-user.js'
import { isUrlShapeAllowed } from '../lib/ssrf-guard.js'
import { WEBHOOK_EVENTS } from './integrations.js'
import { hookSample } from '../lib/integrations/hook-samples.js'

const SubscribeSchema = z.object({
  // Zapier sends `target_url`; Make and others often `url` or `hookUrl`.
  target_url: z.string().url().max(2000).optional(),
  url:        z.string().url().max(2000).optional(),
  hookUrl:    z.string().url().max(2000).optional(),
  event:      z.string().min(1).max(64),
  name:       z.string().min(1).max(100).optional(),
})

export async function hookRoutes(app: FastifyInstance) {
  const guard = requirePermission('configure', 'integration')

  app.post('/', { preHandler: guard }, async (req, reply) => {
    let body
    try { body = SubscribeSchema.parse(req.body) }
    catch (err) { return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues }) }
    const url = body.target_url ?? body.url ?? body.hookUrl
    if (!url) return reply.status(400).send({ detail: 'target_url is required' })
    if (!isUrlShapeAllowed(url)) return reply.status(400).send({ detail: 'target_url must be a public http(s) endpoint' })
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(body.event)) {
      return reply.status(400).send({ detail: `Unknown event: ${body.event}. Known: ${WEBHOOK_EVENTS.join(', ')}` })
    }
    const { orgId } = req.user
    const created = await prisma.webhook.create({
      data: {
        orgId,
        // X45 — a key's subscription belongs to the person behind the key.
        createdById: actingUserId(req.user) ?? req.user.sub,
        name:    (body.name ?? `Zapier: ${body.event}`).slice(0, 100),
        url,
        events:  [body.event],
        secret:  `whsec_${crypto.randomBytes(32).toString('base64url')}`,
        enabled: true,
        type:    'generic',
      },
      select: { id: true, name: true, url: true, events: true, secret: true, createdAt: true },
    })
    return reply.status(201).send({ id: created.id, event: body.event, target_url: created.url, name: created.name, secret: created.secret, createdAt: created.createdAt })
  })

  app.get('/', { preHandler: guard }, async (req, reply) => {
    const data = await prisma.webhook.findMany({
      where: { orgId: req.user.orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, name: true, url: true, events: true, enabled: true, createdAt: true },
    })
    return reply.send({ data: data.map(w => ({ ...w, target_url: w.url })) })
  })

  app.delete('/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const updated = await prisma.webhook.updateMany({
      where: { id, orgId: req.user.orgId, deletedAt: null },
      data:  { deletedAt: new Date(), enabled: false },
    })
    if (updated.count === 0) return reply.status(404).send({ detail: 'Subscription not found' })
    return reply.status(204).send()
  })

  // Zapier's "perform list": an array, newest first.
  app.get('/samples/:event', { preHandler: guard }, async (req, reply) => {
    const { event } = req.params as { event: string }
    const sample = hookSample(event)
    if (!sample) return reply.status(404).send({ detail: `Unknown event: ${event}` })
    return reply.send([sample])
  })
}
