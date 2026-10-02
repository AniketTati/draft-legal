/**
 * Cron routes (P5.2 / docs/30 Wave H.2)
 *
 * Admin-triggered + external-scheduler hooks for background passes
 * that don't need their own worker but should be visible + auditable.
 *
 *   POST /api/v1/cron/obligations
 *     Scans Contract.metadata.obligations for due-within-window items,
 *     fires queueNotification() for each, and stamps `notifiedAt` on
 *     the obligation so the next run is idempotent.
 *
 *     Body (all optional):
 *       leadDays  — lookahead window (default 7, max 365)
 *       force     — ignore cooldown, renotify anyway (debug / verify)
 *
 * Auth: requires `configure:user` (admin / owner). External cron
 * can hit the same path with an internal-service token — see
 * docs/30 §6 for the deployment pattern.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../middleware/permissions.js'
import { scanObligations, scanRenewals } from '../lib/obligation-scanner.js'
import { scanStageDates } from '../lib/lifecycle-dates.js'

const ObligationsScanSchema = z.object({
  leadDays: z.number().int().min(1).max(365).optional(),
  force:    z.boolean().optional(),
  // scope — admin may scan their own org only; "all" is a system token path
  scope:    z.enum(['org', 'all']).default('org'),
}).default({})

export async function cronRoutes(app: FastifyInstance) {

  // ── POST /api/v1/cron/obligations ─────────────────────────────────────
  app.post(
    '/obligations',
    { preHandler: requirePermission('configure', 'user') },
    async (req, reply) => {
      let body
      try { body = ObligationsScanSchema.parse(req.body ?? {}) }
      catch (err) {
        return reply.status(400).send({
          detail: 'Invalid request',
          issues: (err as { issues?: unknown }).issues,
        })
      }

      const orgId = body.scope === 'all' && req.user.sub === 'system'
        ? undefined
        : req.user.orgId

      const result = await scanObligations({
        orgId,
        leadDays: body.leadDays,
        force:    body.force,
      })

      return reply.send({
        ok:     true,
        result,
        ranAt:  new Date().toISOString(),
      })
    },
  )

  // ── POST /api/v1/cron/renewals (P5.3) ─────────────────────────────────
  const RenewalsScanSchema = z.object({
    leadDays: z.number().int().min(1).max(365).optional(),
    force:    z.boolean().optional(),
    scope:    z.enum(['org', 'all']).default('org'),
  }).default({})

  app.post(
    '/renewals',
    { preHandler: requirePermission('configure', 'user') },
    async (req, reply) => {
      let body
      try { body = RenewalsScanSchema.parse(req.body ?? {}) }
      catch (err) {
        return reply.status(400).send({
          detail: 'Invalid request',
          issues: (err as { issues?: unknown }).issues,
        })
      }

      const orgId = body.scope === 'all' && req.user.sub === 'system'
        ? undefined
        : req.user.orgId

      // docs/41 Part 18 — dates move contracts first (Expiring, Expired).
      const stageDates = await scanStageDates({ orgId })
      const result = await scanRenewals({
        orgId,
        leadDays: body.leadDays,
        force:    body.force,
      })

      return reply.send({
        ok:     true,
        result,
        stageDates,
        ranAt:  new Date().toISOString(),
      })
    },
  )
}
