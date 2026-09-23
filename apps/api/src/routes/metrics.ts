/**
 * GET /api/v1/metrics (X3) — Prometheus text format, for a scraper.
 *
 * Off unless METRICS_TOKEN is set (404 otherwise), and then only for a caller
 * presenting it as a bearer token: route patterns and queue depths are
 * operational detail, not something to publish.
 */
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { renderMetrics, type QueueCounts } from '../lib/metrics.js'
import { documentQueue, agentQueue, notificationQueue, scanQueue, webhookQueue, signingQueue } from '../lib/queue.js'

const QUEUES = { documents: documentQueue, agents: agentQueue, notifications: notificationQueue, scans: scanQueue, webhooks: webhookQueue, signing: signingQueue }

async function queueCounts(): Promise<QueueCounts | null> {
  // A scrape must not hang on Redis; the queue gauges are dropped instead.
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 2000).unref())
  const counts = Promise.all(Object.entries(QUEUES).map(async ([name, q]) =>
    [name, await q.getJobCounts('waiting', 'active', 'delayed', 'failed')] as const,
  )).then(entries => Object.fromEntries(entries) as QueueCounts, () => null)
  return Promise.race([counts, timeout])
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  // Not rate-limited: the limiter keeps its counters in Redis, so during a
  // Redis outage — when these numbers matter — every scrape would hang on it.
  // The token is the gate.
  app.get('/', { config: { rateLimit: false } }, async (req, reply) => {
    const token = process.env.METRICS_TOKEN
    if (!token) return reply.status(404).send({ detail: 'Not found' })
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''))
    const expected = Buffer.from(token)
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return reply.status(401).send({ detail: 'Unauthorized' })
    }
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    return reply.send(renderMetrics(await queueCounts()))
  })
}
