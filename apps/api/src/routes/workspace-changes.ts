/**
 * docs/41 Part 15 (C2) — the workspace's Changes mode.
 *
 *   GET  /api/v1/contracts/:id/changes?baseline=<versionId|origin>
 *        what changed since the baseline, in the document as it stands now
 *        (the draft changes when there are any, else the current version):
 *        → { baseline, against, diffHtml, stats, options }
 *        The default baseline is the review's (lib/review-findings.ts
 *        resolveBaseline: the last version sent or approved, else the one
 *        before); "origin" is the version first generated from the template.
 *   POST /api/v1/contracts/:id/changes/counter { ourText, theirText, clauseType? }
 *        counter wording for one change, with why (lib/change-advice.ts).
 *
 * The person's decisions (accept, keep original, counter) are applied by the
 * workspace to the draft changes (routes/working-copy.ts), never as a
 * version: a version is made when they save one.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { getWorkingCopy } from '../lib/working-copy.js'
import { resolveBaseline, baselineWords, type BaselineReason } from '../lib/review-findings.js'
import { computeVersionDiff, DiffTooLargeError } from '../lib/diff.js'
import { counterChange } from '../lib/change-advice.js'
import { CostCapExceededError } from '../lib/costCap.js'
import { askAiDrafts } from '../lib/ask-ai.js'

const counterBody = z.object({
  ourText: z.string().max(20_000).default(''),
  theirText: z.string().max(20_000).default(''),
  clauseType: z.string().max(100).nullish(),
})

export async function workspaceChangesRoutes(app: FastifyInstance) {
  // X7 — own-scope callers may only reach their own contracts by id.
  guardOwnScopeContractRoutes(app)

  app.get('/:id/changes', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { baseline: asked } = z.object({ baseline: z.string().min(1).max(64).optional() }).parse(req.query)
    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true, currentVersionId: true } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const versions = await prisma.contractVersion.findMany({
      where: { contractId: id },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, createdAt: true, changeNote: true, createdById: true },
    })
    const current = versions.find(v => v.id === contract.currentVersionId) ?? versions[0]
    if (!current) return reply.status(409).send({ detail: 'This contract has no version yet.' })
    const origin = await prisma.contractVersion.findFirst({
      where: { contractId: id, htmlContent: { contains: 'data-fp="' } },
      orderBy: { versionNumber: 'asc' },
      select: { id: true },
    })

    // The baseline: the one asked for, else the review's, else the version before.
    let base: { versionId: string; reason: BaselineReason | 'chosen' } | null = null
    if (asked === 'origin') {
      if (!origin) return reply.status(404).send({ detail: 'This contract was not generated from a template.' })
      base = { versionId: origin.id, reason: 'origin' }
    } else if (asked) {
      if (!versions.some(v => v.id === asked)) return reply.status(404).send({ detail: 'Version not found' })
      base = { versionId: asked, reason: 'chosen' }
    } else {
      const b = await resolveBaseline(id, current)
      const before = versions.find(v => v.versionNumber < current.versionNumber)
      base = b ? { versionId: b.versionId, reason: b.reason } : before ? { versionId: before.id, reason: 'analysed' } : null
    }

    const copy = await getWorkingCopy(orgId, id)
    const nowRow = await prisma.contractVersion.findUnique({ where: { id: current.id }, select: { htmlContent: true } })
    const nowHtml = copy?.html ?? nowRow?.htmlContent ?? ''
    const against = { kind: copy ? 'draft' as const : 'version' as const, versionId: current.id, versionNumber: current.versionNumber }
    const options = {
      originVersionId: origin?.id ?? null,
      versions: versions.map(v => ({ id: v.id, versionNumber: v.versionNumber, createdAt: v.createdAt, changeNote: v.changeNote, fromCounterparty: /^(portal|email):/.test(v.createdById) })),
    }
    if (!base) return reply.send({ baseline: null, against, diffHtml: '', stats: { insertions: 0, deletions: 0 }, options })

    const baseRow = await prisma.contractVersion.findUnique({ where: { id: base.versionId }, select: { versionNumber: true, htmlContent: true } })
    if (!baseRow?.htmlContent?.trim()) return reply.status(409).send({ detail: 'The baseline version is still being read. Try again in a moment.' })
    const baseline = {
      versionId: base.versionId, versionNumber: baseRow.versionNumber, reason: base.reason,
      words: base.reason === 'chosen' ? `v${baseRow.versionNumber}` : baselineWords(base.reason),
    }
    if (baseRow.htmlContent === nowHtml) return reply.send({ baseline, against, diffHtml: nowHtml, stats: { insertions: 0, deletions: 0 }, options })
    const diff = await computeVersionDiff(baseRow.htmlContent, nowHtml).catch(err => { if (err instanceof DiffTooLargeError) return null; throw err })
    if (!diff) return reply.status(422).send({ detail: new DiffTooLargeError().message })
    return reply.send({ baseline, against, diffHtml: diff.diffHtml, stats: diff.stats, options })
  })

  app.post('/:id/changes/counter', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const parsed = counterBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.status(400).send({ detail: 'Send the original words and theirs.' })
    const { ourText, theirText, clauseType } = parsed.data
    if (!ourText.trim() && !theirText.trim()) return reply.status(400).send({ detail: 'Send the original words and theirs.' })
    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true, type: true, playbookId: true } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    try {
      const draft = await counterChange({ orgId, contract, ourText, theirText, clauseType })
      if (!draft.counterText) return reply.status(502).send({ detail: 'No counter could be drafted for this change. Try again, or write one.' })
      return reply.send(draft)
    } catch (err) {
      if (err instanceof CostCapExceededError) return reply.status(429).send({ detail: 'Today\'s AI budget is used up. Try again tomorrow.' })
      req.log.warn({ err }, 'counter draft failed')
      return reply.status(502).send({ detail: 'The counter could not be drafted. Try again.' })
    }
  })

  // docs/41 Part 16 — "Ask AI" on selected words: three drafts, each with why.
  // Nothing is written here; the workspace puts the chosen one in its draft.
  app.post('/:id/ask-ai', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { selectedText, instruction } = (req.body ?? {}) as { selectedText?: unknown; instruction?: unknown }
    if (typeof selectedText !== 'string' || typeof instruction !== 'string') return reply.status(400).send({ detail: 'Send the selected words and an instruction.' })
    try {
      const r = await askAiDrafts({ orgId: req.user.orgId, contractId: id, selectedText, instruction })
      if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
      return reply.send(r.data)
    } catch (err) {
      if (err instanceof CostCapExceededError) return reply.status(429).send({ detail: 'Today\'s AI budget is used up. Try again tomorrow.' })
      req.log.warn({ err }, 'ask-ai drafts failed')
      return reply.status(502).send({ detail: 'No drafts could be made. Try again.' })
    }
  })
}
