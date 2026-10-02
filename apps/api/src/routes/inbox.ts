/**
 * docs/41 Part 6 — the inbox (lib/inbox.ts).
 *
 *   GET /api/v1/inbox?view=mine        Needs my action (the default)
 *   GET /api/v1/inbox?view=waiting     Waiting on others
 *   GET /api/v1/inbox?view=team        Team, in flight (configure:workflow),
 *       with &stuck=1, &agingDays=N, &stage=<stage>
 *
 * Every answer carries `counts.mine`: the sidebar badge, from the same query
 * as the Needs-my-action list, so the two can't disagree.
 */
import type { FastifyInstance } from 'fastify'
import { isStage, STAGE_LABEL, type Stage } from '@clm/types'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { needsMyAction, waitingOnOthers, teamInFlight } from '../lib/inbox.js'

export async function inboxRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const q = req.query as { view?: string; stuck?: string; agingDays?: string; stage?: string }
    const view = q.view === 'waiting' || q.view === 'team' ? q.view : 'mine'
    const canTeam = (await permissionScopeFor(req, 'configure', 'workflow')) === 'org'
    if (view === 'team' && !canTeam) {
      return reply.status(403).send({ type: 'https://httpstatuses.com/403', title: 'Forbidden', status: 403, detail: 'Missing permission: configure:workflow' })
    }

    const mine = await needsMyAction(orgId, userId)
    let data = mine
    let filters: Record<string, unknown> = {}
    if (view === 'waiting') {
      data = await waitingOnOthers(orgId, userId, new Set(mine.map(r => r.contractId)))
    } else if (view === 'team') {
      const agingDays = q.agingDays ? Math.max(1, Math.min(365, parseInt(q.agingDays, 10) || 0)) : undefined
      const stage: Stage | undefined = isStage(q.stage) ? q.stage : undefined
      filters = { stuck: q.stuck === '1' || q.stuck === 'true', agingDays: agingDays ?? null, stage: stage ?? null }
      data = await teamInFlight(orgId, { stuck: filters.stuck as boolean, agingDays, stage })
    }
    return reply.send({
      view,
      data,
      total: data.length,
      counts: { mine: mine.length },
      canTeam,
      ...(view === 'team' && { filters, stages: (['request', 'draft', 'negotiate', 'approve', 'sign'] as Stage[]).map(s => ({ stage: s, label: STAGE_LABEL[s] })) }),
    })
  })

  // The badge alone (the sidebar): the length of Needs my action.
  app.get('/count', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    return reply.send({ mine: (await needsMyAction(orgId, userId)).length })
  })
}
