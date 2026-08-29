import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import pino from 'pino'
import pinoPretty from 'pino-pretty'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
// @ts-ignore — @bull-board v5 has no types/exports field; works at runtime
import { createBullBoard } from '@bull-board/api'
// @ts-ignore
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js'
// @ts-ignore
import { FastifyAdapter } from '@bull-board/fastify'

import { redis } from './lib/redis.js'
import { documentQueue, agentQueue, notificationQueue, scanQueue, webhookQueue, signingQueue } from './lib/queue.js'
import { ensureContractIndex } from './lib/elasticsearch.js'
import { ensureBucket } from './lib/storage.js'
import { authRoutes } from './routes/auth.js'
import { contractRoutes } from './routes/contracts.js'
import { searchRoutes } from './routes/search.js'
import { counterpartyRoutes } from './routes/counterparties.js'
import { requestRoutes } from './routes/requests.js'
import { userRoutes } from './routes/users.js'
import { agentRoutes } from './routes/agents.js'
import { fieldDefinitionRoutes } from './routes/field-definitions.js'
import { templateRoutes } from './routes/templates.js'
import { clauseRoutes } from './routes/clauses.js'
import { playbookRoutes } from './routes/playbook.js'
import { commentRoutes } from './routes/comments.js'
import { shareRoutes } from './routes/share.js'
import { portalRoutes } from './routes/portal.js'
import { approvalRoutes } from './routes/approvals.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { adminUserRoutes } from './routes/admin-users.js'
import { adminAuditRoutes } from './routes/admin-audit.js'
import { metricsRoutes } from './routes/metrics.js'
import { teamRoutes } from './routes/team.js'
import { organizationRoutes } from './routes/organization.js'
import { healthRoutes } from './routes/health.js'
import { internalAiRoutes } from './routes/internal-ai.js'
import { adminAiRoutes } from './routes/admin-ai.js'
import { adminPackRoutes } from './routes/admin-packs.js'
import { agentThreadRoutes } from './routes/agent-threads.js'
import { skillsRoutes } from './routes/skills.js'
import { reviewQueueRoutes } from './routes/review-queue.js'
import { obligationRoutes } from './routes/obligations.js'
import { renewalRoutes } from './routes/renewals.js'
import { invoiceRoutes } from './routes/invoices.js'
import { analyticsRoutes } from './routes/analytics.js'
import { diligenceRoutes } from './routes/diligence.js'
import { integrationsRoutes } from './routes/integrations.js'
import { matterRoutes } from './routes/matters.js'
import { cronRoutes } from './routes/cron.js'
import { signatureRoutes } from './routes/signatures.js'
import { inboundEmailRoutes } from './routes/inbound-email.js'
import { marketingRoutes } from './routes/marketing.js'
import { telemetryRoutes } from './routes/telemetry.js'
import { slackRoutes } from './routes/slack.js'
import { errorHandler } from './middleware/error-handler.js'
import { assertRouterConfigured } from './lib/aiRouter.js'
import { assertSecretsConfigured } from './lib/secrets.js'

function devLogger() {
  const stream = pinoPretty({ colorize: true })
  return pino({ level: process.env.LOG_LEVEL ?? 'info' }, stream)
}

export async function buildApp() {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'development'
        ? devLogger()
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            // Production observability — pino's default JSON output
            // is the right shape for ingest into DataDog / Loki /
            // CloudWatch. Add the commit SHA so we can correlate logs
            // to a release; the deploy script sets GIT_COMMIT_SHA.
            base: {
              pid: process.pid,
              env: process.env.NODE_ENV ?? 'production',
              commit: process.env.GIT_COMMIT_SHA ?? 'unknown',
              service: 'clm-api',
            },
            // Pino redacts these on every log line so headers/cookies
            // never end up in the logs by accident.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-internal-secret"]',
                'res.headers["set-cookie"]',
                '*.password',
                '*.passwordHash',
                '*.refreshToken',
                '*.accessToken',
              ],
              censor: '[REDACTED]',
            },
            // Request-id propagation: trust an upstream X-Request-Id
            // (set by load balancer / CDN) so traces correlate across
            // services. Otherwise Fastify generates one.
            genReqId: (req) =>
              (req.headers['x-request-id'] as string | undefined)
              ?? (req.headers['x-correlation-id'] as string | undefined)
              ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          },
    // P25 — surface the request-id back to the caller so client logs
    // can include it when reporting a bug. Trivially correlates.
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    maxParamLength: 500,   // Portal JWT tokens can be ~400 chars
  })

  // Echo the request id back on every response so the client can log
  // it alongside its own error reports.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  // Plugins
  //
  // CORS allowlist:
  //   - The app's FRONTEND_URL (Firebase Hosting site that proxies /api/**
  //     to this Cloud Run service — same-origin from the browser's POV).
  //   - The marketing site origins (draftlegal-marketing.web.app + the apex
  //     domain draft-legal.com) so the public Contact form can POST to
  //     /api/v1/marketing/contact cross-origin.
  //   - The hosted app origin app.draft-legal.com (2026-06-10: the app is
  //     served from its own subdomain, not just behind the /api proxy).
  //   - Local dev (Vite on 5173, marketing dev on 5174).
  //   - Anything in CORS_ALLOWED_ORIGINS (comma-separated) — add new
  //     deployment origins via env, no code change needed.
  const allowedOrigins = new Set<string>([
    process.env.FRONTEND_URL ?? 'http://localhost:5173',
    'http://localhost:5173',
    'http://localhost:5174',
    'https://draftlegal-marketing.web.app',
    'https://draft-legal.com',
    'https://www.draft-legal.com',
    'https://app.draft-legal.com',
    ...(process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean),
  ])
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server: no Origin header — allow.
      if (!origin) return cb(null, true)
      if (allowedOrigins.has(origin)) return cb(null, true)
      // statusCode so the error handler reports 403, not a generic 500.
      cb(Object.assign(new Error(`Origin ${origin} not allowed`), { statusCode: 403 }), false)
    },
    credentials: true,
  })

  await app.register(helmet, { contentSecurityPolicy: false })

  // Global rate limit. Production: 1000/min/IP. Dev/test: 10× so the
  // 48-probe audit can run back-to-back without tripping the cap;
  // production behavior is unchanged.
  // `rateLimit as any`: @hocuspocus/server pulls a second Fastify (v5)
  // copy alongside apps/api's v4, so @fastify/rate-limit's plugin
  // signature type-mismatches the host FastifyInstance. Runtime is correct
  // (v4 plugin + v4 instance); the cast sidesteps the dual-version type
  // skew. `skip`'s req is typed explicitly to keep that callback safe.
  await app.register(rateLimit as any, {
    redis,
    max: process.env.NODE_ENV === 'production' ? 1000 : 10_000,
    timeWindow: '1 minute',
    // Wave 1.4 (2026-07): key the global limiter on the client IP, NOT
    // the attacker-controlled `x-org-id` header. The header is only
    // meaningful on internal-secret-authenticated calls; using it as the
    // key let any unauthenticated caller rotate values for a fresh
    // 1000/min bucket, defeating the cap on every public surface.
    // (Default keyGenerator = req.ip.) Per-org authenticated limits, if
    // needed, belong on a post-auth limiter that reads req.user.orgId.
    // Trusted-internal bypass: probes / scripts can pass the same
    // INTERNAL_SERVICE_SECRET we already use elsewhere to skip the
    // global cap (the per-route limits — login, register — still apply).
    // Externally-issued requests can never set this.
    skip: (req: FastifyRequest) => {
      const s = req.headers['x-internal-secret']
      return !!s && s === process.env.INTERNAL_SERVICE_SECRET
    },
  })

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  })

  // Bull Board — queue visibility at /admin/queues (internal access only)
  const bullBoardAdapter = new FastifyAdapter()
  bullBoardAdapter.setBasePath('/admin/queues')
  createBullBoard({
    // @bull-board v5 + bullmq v5 have benign generic-type friction on the
    // BullMQAdapter → BaseAdapter assignment; the imports are already
    // untyped (@ts-ignore above). Runtime is correct.
    queues: [new BullMQAdapter(documentQueue), new BullMQAdapter(agentQueue), new BullMQAdapter(notificationQueue), new BullMQAdapter(scanQueue), new BullMQAdapter(webhookQueue), new BullMQAdapter(signingQueue)] as any,
    serverAdapter: bullBoardAdapter,
  })
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin/queues')) return
    if (process.env.NODE_ENV !== 'production') return // open in dev
    const secret = req.headers['x-internal-secret']
    if (!secret || secret !== process.env.INTERNAL_SERVICE_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  })
  await app.register(bullBoardAdapter.registerPlugin(), {
    prefix: '/admin/queues',
    basePath: '/admin/queues',
  })

  // Error handler MUST be set BEFORE route plugins are registered —
  // Fastify snapshots the active error handler into each encapsulated
  // plugin context at registration time. Previously this was set after
  // the routes (bottom of buildApp), so every route used Fastify's
  // DEFAULT handler: ZodError surfaced as a raw 500 with the issues
  // JSON in `message` instead of the structured 422. (Found in the
  // 2026-06-10 full-app review via POST /search with a bad body.)
  app.setErrorHandler(errorHandler)

  // Routes
  await app.register(healthRoutes)
  await app.register(authRoutes,         { prefix: '/api/v1/auth' })
  await app.register(contractRoutes,     { prefix: '/api/v1/contracts' })
  await app.register(searchRoutes,       { prefix: '/api/v1/search' })
  await app.register(counterpartyRoutes, { prefix: '/api/v1/counterparties' })
  await app.register(requestRoutes,      { prefix: '/api/v1/requests' })
  await app.register(userRoutes,         { prefix: '/api/v1/users' })
  await app.register(agentRoutes,        { prefix: '/api/v1/agent' })
  await app.register(fieldDefinitionRoutes, { prefix: '/api/v1/field-definitions' })
  await app.register(templateRoutes,        { prefix: '/api/v1/templates' })
  await app.register(clauseRoutes,          { prefix: '/api/v1/clauses' })
  await app.register(playbookRoutes,        { prefix: '/api/v1/playbook' })
  await app.register(commentRoutes,         { prefix: '/api/v1/contracts' })
  await app.register(shareRoutes,           { prefix: '/api/v1/contracts' })
  await app.register(portalRoutes,          { prefix: '/api/v1/portal' })
  await app.register(approvalRoutes,        { prefix: '/api/v1/approvals' })
  await app.register(dashboardRoutes,      { prefix: '/api/v1/dashboard' })
  await app.register(adminUserRoutes,      { prefix: '/api/v1/admin/users' })
  await app.register(adminAuditRoutes,     { prefix: '/api/v1/admin/audit' })
  await app.register(metricsRoutes,        { prefix: '/api/v1/metrics' })
  await app.register(teamRoutes,           { prefix: '/api/v1/team' })
  await app.register(organizationRoutes,   { prefix: '/api/v1/organization' })
  await app.register(internalAiRoutes,     { prefix: '/api/internal/ai' })
  await app.register(adminAiRoutes,        { prefix: '/api/v1/admin/ai' })
  await app.register(adminPackRoutes,      { prefix: '/api/v1/admin/packs' })
  await app.register(agentThreadRoutes,    { prefix: '/api/v1/agent/threads' })
  await app.register(skillsRoutes,         { prefix: '/api/v1/skills' })
  await app.register(reviewQueueRoutes,    { prefix: '/api/v1/review-queue' })
  await app.register(obligationRoutes,     { prefix: '/api/v1/obligations' })
  await app.register(renewalRoutes,        { prefix: '/api/v1/renewals' })
  await app.register(invoiceRoutes,        { prefix: '/api/v1/invoices' })
  await app.register(analyticsRoutes,      { prefix: '/api/v1/analytics' })
  await app.register(diligenceRoutes,      { prefix: '/api/v1/diligence' })
  await app.register(integrationsRoutes,   { prefix: '/api/v1/admin/integrations' })
  await app.register(matterRoutes,         { prefix: '/api/v1/matters' })
  await app.register(cronRoutes,           { prefix: '/api/v1/cron' })
  // P7.6.1 — eSignature: paths split between auth'd /contracts/:id/...
  // and public /sign/:token/... so we register at /api/v1.
  await app.register(signatureRoutes,      { prefix: '/api/v1' })
  // P7.6.3 — Inbound email parser webhook (SendGrid / Mailgun target)
  await app.register(inboundEmailRoutes,   { prefix: '/api/v1/inbound' })
  await app.register(marketingRoutes,      { prefix: '/api/v1/marketing' })
  // L6 #13 — lib/telemetry.ts has posted here from nine call sites since
  // B.5.17 against a route that was never registered. Unauthenticated by
  // design: the client's primary transport is sendBeacon on unload.
  await app.register(telemetryRoutes,      { prefix: '/api/v1/telemetry' })
  // Phase 10 — Slack slash command + interactive buttons (public; signed
  // by the org's Slack signing secret rather than a user JWT).
  await app.register(slackRoutes,          { prefix: '/api/v1/slack' })

  // Wave 1.1 — fail closed at boot if JWT_SECRET / PORTAL_JWT_SECRET are
  // missing or a known-insecure placeholder in production (no more silent
  // hardcoded-secret fallback). In dev, generates + persists a local secret.
  assertSecretsConfigured()

  // D.0.3 — log the platform routing table at boot. Wave 0.4: warns (no
  // longer throws) when a critical tier has no platform key, so the app
  // boots keyless and AI features 503-degrade.
  assertRouterConfigured()

  // Elasticsearch index bootstrap (non-blocking — ES may not be running locally)
  ensureContractIndex().catch(err =>
    app.log.warn({ err }, 'Elasticsearch not available — search will fall back to Postgres'),
  )

  ensureBucket().catch(err =>
    app.log.warn({ err }, 'MinIO not available — file uploads will fail until storage is running'),
  )

  return app
}
