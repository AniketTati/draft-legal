/**
 * docs/41 P1 (Part 11) — Analysis health: the analyses that failed or
 * stopped moving, grouped by the step they stopped at, with a retry.
 *
 *   GET  /api/v1/admin/analysis/runs             — failed and stuck runs, by step
 *   GET  /api/v1/contracts/:id/analysis-runs     — one contract's runs (contract page)
 *   POST /api/v1/admin/analysis/runs/:id/retry   — run the failed part again
 *
 * A failure used to show only as FAILED on one contract, if at all: a review
 * whose callback failed was only logged. Gated on configure:organization
 * like the other admin pages; the contract's own list needs view:contract.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { STEP_LABEL, STUCK_RUN_MS, RUN_STEPS, viewRun, type RunStepName } from '../lib/analysis-runs.js'

const ListQuery = z.object({
  /** failed, stuck, or both (default). */
  status: z.enum(['failed', 'stuck', 'problems']).default('problems'),
  /** Look back this many days. */
  days: z.coerce.number().int().min(1).max(90).default(14),
})

export async function analysisHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/runs', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId } = req.user
    const parsed = ListQuery.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ detail: 'Invalid query', issues: parsed.error.issues })
    const { status, days } = parsed.data
    const since = new Date(Date.now() - days * 86_400_000)
    const stuckBefore = new Date(Date.now() - STUCK_RUN_MS)

    const [runs, totals] = await Promise.all([
      prisma.analysisRun.findMany({
        where: {
          orgId,
          startedAt: { gte: since },
          OR: [
            ...(status !== 'stuck' ? [{ status: 'failed' }] : []),
            ...(status !== 'failed' ? [{ status: { in: ['queued', 'running'] }, updatedAt: { lt: stuckBefore } }] : []),
          ],
        },
        orderBy: { startedAt: 'desc' },
        take: 500,
        include: { contract: { select: { id: true, title: true, currentVersionId: true, deletedAt: true } } },
      }),
      prisma.analysisRun.groupBy({ by: ['status'], where: { orgId, startedAt: { gte: since } }, _count: { _all: true } }),
    ])
    const live = runs.filter(r => !r.contract.deletedAt)
    const versions = await prisma.contractVersion.findMany({ where: { id: { in: live.map(r => r.versionId) } }, select: { id: true, versionNumber: true } })
    const numberOf = new Map(versions.map(v => [v.id, v.versionNumber]))

    // Grouped by where they stopped: a failed run's step, a stuck run's running one.
    const groups = new Map<string, Array<ReturnType<typeof row>>>()
    function row(r: typeof live[number]) {
      const view = viewRun(r, numberOf.get(r.versionId) ?? null)
      return {
        ...view,
        contractId: r.contract.id,
        contractTitle: r.contract.title,
        // A retry analyses the version the contract stands on; say when that isn't this one.
        current: r.contract.currentVersionId === r.versionId,
        runningStep: view.current,
      }
    }
    for (const r of live) {
      const v = row(r)
      const step = r.status === 'failed' ? (r.failedStep ?? 'unknown') : (v.runningStep?.name ?? 'queued')
      groups.set(step, [...(groups.get(step) ?? []), v])
    }
    const rank = (s: string) => { const i = RUN_STEPS.indexOf(s as RunStepName); return i === -1 ? RUN_STEPS.length : i }
    const count = (s: string) => totals.find(t => t.status === s)?._count._all ?? 0
    return reply.send({
      days,
      totals: { done: count('done'), failed: count('failed'), running: count('running') + count('queued'), stuck: live.filter(r => r.status !== 'failed').length },
      groups: [...groups.entries()]
        .sort((a, b) => rank(a[0]) - rank(b[0]))
        .map(([step, items]) => ({ step, label: STEP_LABEL[step as RunStepName] ?? (step === 'queued' ? 'waiting to start' : step), count: items.length, runs: items })),
    })
  })

  app.post('/runs/:id/retry', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id } = req.params as { id: string }
    const run = await prisma.analysisRun.findFirst({
      where: { id, orgId },
      include: { contract: { select: { id: true, currentVersionId: true, deletedAt: true } } },
    })
    if (!run || run.contract.deletedAt) return reply.status(404).send({ detail: 'Analysis run not found' })
    if (run.status === 'done' || run.status === 'superseded') {
      return reply.status(409).send({ code: 'NOT_FAILED', detail: 'This analysis finished; there is nothing to retry.' })
    }
    const { onVersionCreated } = await import('../lib/analysis-trigger.js')
    const { queuePlaybookReview } = await import('../lib/queue.js')
    let retried: string
    // Only the model's position check failed: the rest of the analysis
    // stands, so only that is asked for again.
    const onCurrent = run.contract.currentVersionId === run.versionId
    if (run.failedStep === 'position_check' && onCurrent) {
      queuePlaybookReview({ contractId: run.contractId, orgId, versionId: run.versionId })
      retried = 'position_check'
    } else if ((run.failedStep === 'drafting' || run.failedStep === 'compliance') && onCurrent) {
      // So did the defined-terms checks and the compliance step (docs/41 Parts 9, 10).
      const { draftingStep, queueComplianceStep } = await import('../lib/version-review-steps.js')
      if (run.failedStep === 'drafting') await draftingStep(run.contractId, run.versionId)
      else await queueComplianceStep(run.contractId, run.versionId, { again: true })
      retried = run.failedStep
    } else {
      const versionId = run.contract.currentVersionId ?? run.versionId
      retried = await onVersionCreated(run.contractId, versionId, 'retry')
    }
    createAuditEvent({
      orgId, userId, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: run.contractId,
      metadata: { via: 'analysis-health.retry', runId: run.id, failedStep: run.failedStep, retried },
    }).catch(() => {})
    return reply.status(202).send({ retried })
  })
}

/** One contract's runs, newest first: what the contract page shows as the analysis' history. */
export async function contractAnalysisRunRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/analysis-runs', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id } = req.params as { id: string }
    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const runs = await prisma.analysisRun.findMany({ where: { orgId, contractId: id }, orderBy: { startedAt: 'desc' }, take: 20 })
    const versions = await prisma.contractVersion.findMany({ where: { contractId: id }, select: { id: true, versionNumber: true } })
    const numberOf = new Map(versions.map(v => [v.id, v.versionNumber]))
    return reply.send({ data: runs.map(r => viewRun(r, numberOf.get(r.versionId) ?? null)) })
  })
}
