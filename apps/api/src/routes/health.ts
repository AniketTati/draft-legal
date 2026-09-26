/**
 * Health probes for orchestrators (Kubernetes / Render / ECS / Vercel).
 *
 * Three endpoints with distinct semantics:
 *
 *   GET /health
 *     Comprehensive check: DB + Redis ping. Used by humans + status
 *     pages. Returns 200 if everything healthy, 503 if degraded.
 *     Cached for 1s to keep cost down under polling.
 *
 *   GET /health/live (liveness)
 *     "Is the process alive?" — returns 200 if Node responds. NEVER
 *     fails for a downstream issue (DB / Redis hiccup); orchestrator
 *     would kill us pointlessly. Cheapest possible path.
 *
 *   GET /health/ready (readiness)
 *     "Should the orchestrator route traffic to me?" — returns 200
 *     only if every dependency we MUST have is responsive. Returns
 *     503 during startup before deps are connected, or if DB / Redis
 *     drops (so the LB pulls us out of rotation).
 *
 * The legacy /api/health stays as an alias for /health (back-compat).
 *
 * Conventional pairing in deployments:
 *   livenessProbe:  /health/live  (every 10s, 3 fail → restart)
 *   readinessProbe: /health/ready (every 5s, 2 fail → drop traffic)
 */
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { redis } from '../lib/redis.js'
import { environmentName } from '../lib/runtime-mode.js'

const READY_CACHE_MS = 1_000
let _readyCache: { at: number; healthy: boolean; checks: Record<string, 'ok' | 'error'>; latencyMs: Record<string, number> } | null = null

async function readinessSnapshot() {
  if (_readyCache && Date.now() - _readyCache.at < READY_CACHE_MS) return _readyCache

  const checks: Record<string, 'ok' | 'error'> = {}
  const latencyMs: Record<string, number> = {}
  // DB
  let t = Date.now()
  try {
    await prisma.$queryRaw`SELECT 1`
    checks.database = 'ok'
  } catch {
    checks.database = 'error'
  }
  latencyMs.database = Date.now() - t
  // Redis
  t = Date.now()
  try {
    await redis.ping()
    checks.redis = 'ok'
  } catch {
    checks.redis = 'error'
  }
  latencyMs.redis = Date.now() - t

  const healthy = Object.values(checks).every(v => v === 'ok')
  _readyCache = { at: Date.now(), healthy, checks, latencyMs }
  return _readyCache
}

export async function healthRoutes(app: FastifyInstance) {
  // ── /health/live ─────────────────────────────────────────────────────
  // Cheapest possible signal — if the event loop is responding, we're
  // alive. NEVER touch DB / Redis here; a transient DB blip should
  // not cause k8s to kill us (that just slows recovery).
  app.get('/health/live', async (_req, reply) => {
    return reply.send({ status: 'ok', service: 'clm-api', timestamp: new Date().toISOString() })
  })

  // ── /health/ready ────────────────────────────────────────────────────
  // Return 503 if any required dep is down — orchestrator pulls us from
  // load-balancing rotation until we recover.
  app.get('/health/ready', async (_req, reply) => {
    const snap = await readinessSnapshot()
    return reply.status(snap.healthy ? 200 : 503).send({
      status: snap.healthy ? 'ready' : 'degraded',
      checks: snap.checks,
      latencyMs: snap.latencyMs,
      timestamp: new Date().toISOString(),
    })
  })

  // ── /health ──────────────────────────────────────────────────────────
  // Human-friendly comprehensive health page. Same shape as readiness
  // but lives at the conventional path. /api/health stays as legacy alias.
  app.get('/health', async (_req, reply) => {
    const snap = await readinessSnapshot()
    return reply.status(snap.healthy ? 200 : 503).send({
      status: snap.healthy ? 'ok' : 'degraded',
      checks: snap.checks,
      latencyMs: snap.latencyMs,
      uptime: Math.round(process.uptime()),
      versions: {
        node:   process.version,
        env:    environmentName(),
        commit: process.env.GIT_COMMIT_SHA ?? 'unknown',
      },
      timestamp: new Date().toISOString(),
    })
  })

  // Legacy alias.
  app.get('/api/health', async (_req, reply) => {
    const snap = await readinessSnapshot()
    return reply.status(snap.healthy ? 200 : 503).send({
      status: snap.healthy ? 'ok' : 'degraded',
      checks: snap.checks,
      timestamp: new Date().toISOString(),
    })
  })
}
