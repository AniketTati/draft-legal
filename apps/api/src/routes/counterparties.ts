import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { portfolioWhere } from '../lib/own-scope-guard.js'

const CreateCounterpartySchema = z.object({
  name:    z.string().min(1).max(255),
  email:   z.string().email().optional(),
  phone:   z.string().optional(),
  address: z.string().optional(),
  website: z.string().url().optional(),
  crmId:   z.string().optional(),
  metadata:z.record(z.unknown()).optional(),
})

const UpdateCounterpartySchema = CreateCounterpartySchema.partial()

export async function counterpartyRoutes(app: FastifyInstance) {
  // GET /api/v1/counterparties
  //
  // B.6.9 — list now returns `contractCount` and `lastContractAt` so
  // the UI can show the single most-useful signal at-a-glance ("how
  // much business do we have with this counterparty?"). Counts match
  // both the FK (contract.counterpartyId) and the name fallback
  // (contract.counterpartyName) so denormalised rows aren't missed.
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { q, limit = '50' } = req.query as { q?: string; limit?: string }
    const { orgId } = req.user

    const counterparties = await prisma.counterparty.findMany({
      where: {
        orgId,
        deletedAt: null,
        // U.6.2 — drop rows synthesised by verify scripts (names like
        // "P744-Verify-1777102226493"). These pollute every user-facing
        // counterparty picker / list. The pattern is stable: an
        // uppercase-prefixed token, then "-Verify-", then a timestamp.
        NOT: { name: { contains: '-Verify-' } },
        ...(q && { name: { contains: q, mode: 'insensitive' } }),
      },
      take: Math.min(Number(limit), 100),
      orderBy: { name: 'asc' },
    })

    if (counterparties.length === 0) {
      return reply.send({ data: [] })
    }

    // Batch-fetch the counts + most-recent updatedAt for every
    // counterparty in one pass. Matching by EITHER id OR name covers
    // extractor-era contracts where only the name got filled in.
    const names = counterparties.map((c) => c.name)
    const ids = counterparties.map((c) => c.id)

    const contractRows = await prisma.contract.findMany({
      where: {
        orgId,
        deletedAt: null,
        // X7 — own-scope callers count only their own contracts. X17 — and
        // a diligence room's documents are a target's, not the org's.
        ...portfolioWhere(req),
        OR: [
          { counterpartyId: { in: ids } },
          { counterpartyName: { in: names } },
        ],
      },
      select: {
        id: true,
        counterpartyId: true,
        counterpartyName: true,
        updatedAt: true,
      },
    })

    // Group by (id OR normalized name). Using a Set for IDs to dedupe
    // any contract that matches both FK + name.
    const byCpId = new Map<string, Set<string>>()        // cpId -> set of contractIds
    const contractIdToCpId = new Map<string, string>()    // contractId -> cpId (for activity rollup)
    const lastActivityByCpId = new Map<string, Date>()
    const lastActivityKindByCpId = new Map<string, 'contract' | 'comment' | 'share'>()
    for (const cp of counterparties) {
      byCpId.set(cp.id, new Set())
    }
    for (const ct of contractRows) {
      const target =
        (ct.counterpartyId && byCpId.has(ct.counterpartyId) ? ct.counterpartyId : null) ??
        counterparties.find((cp) => ct.counterpartyName === cp.name)?.id
      if (!target) continue
      byCpId.get(target)!.add(ct.id)
      contractIdToCpId.set(ct.id, target)
      const prev = lastActivityByCpId.get(target)
      if (!prev || ct.updatedAt > prev) {
        lastActivityByCpId.set(target, ct.updatedAt)
        lastActivityKindByCpId.set(target, 'contract')
      }
    }

    // P7.4.6 / F-50 — fold in real activity signals (comments +
    // share-link creations) so the column means "something a person
    // did" rather than just "contract.updatedAt". Without this every
    // row reads "today" because the seed touches every contract on
    // the same day.
    const allContractIds = Array.from(contractIdToCpId.keys())
    if (allContractIds.length > 0) {
      const [latestComments, latestShares] = await Promise.all([
        prisma.contractComment.groupBy({
          by: ['contractId'],
          where: {
            contractId: { in: allContractIds },
            deletedAt: null,
          },
          _max: { createdAt: true },
        }),
        prisma.contractShareLink.groupBy({
          by: ['contractId'],
          where: { contractId: { in: allContractIds } },
          _max: { createdAt: true },
        }),
      ])

      for (const row of latestComments) {
        const cpId = contractIdToCpId.get(row.contractId)
        const ts = row._max.createdAt
        if (!cpId || !ts) continue
        const prev = lastActivityByCpId.get(cpId)
        if (!prev || ts > prev) {
          lastActivityByCpId.set(cpId, ts)
          lastActivityKindByCpId.set(cpId, 'comment')
        }
      }
      for (const row of latestShares) {
        const cpId = contractIdToCpId.get(row.contractId)
        const ts = row._max.createdAt
        if (!cpId || !ts) continue
        const prev = lastActivityByCpId.get(cpId)
        if (!prev || ts > prev) {
          lastActivityByCpId.set(cpId, ts)
          lastActivityKindByCpId.set(cpId, 'share')
        }
      }
    }

    const data = counterparties.map((cp) => ({
      ...cp,
      contractCount: byCpId.get(cp.id)?.size ?? 0,
      // Kept name for backwards-compat with current UI; semantically
      // it's now "last meaningful activity" (contract update / comment
      // / share-link send).
      lastContractAt: lastActivityByCpId.get(cp.id)?.toISOString() ?? null,
      lastActivityKind: lastActivityKindByCpId.get(cp.id) ?? null,
    }))

    return reply.send({ data })
  })

  // POST /api/v1/counterparties
  app.post('/', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const body = CreateCounterpartySchema.parse(req.body)
    const { orgId } = req.user

    const counterparty = await prisma.counterparty.create({
      data: { ...body, orgId } as Prisma.CounterpartyUncheckedCreateInput,
    })

    return reply.status(201).send(counterparty)
  })

  // GET /api/v1/counterparties/:id
  //
  // P7.4.5 — extended to power the new Counterparty profile page. We
  // return:
  //   - the counterparty itself (with legal name, contacts, etc.)
  //   - every contract with this CP (matched on counterpartyId OR the
  //     denormalised counterpartyName), full enough to render rows
  //     without a second round-trip — value, status, risk, dates, etc.
  //   - precomputed aggregates (TCV, active count, high-risk count,
  //     status breakdown) so the page header is one query, not five.
  //   - a small "recentActivity" timeline derived from the contracts'
  //     updatedAt + status (a real audit-log will replace this later).
  app.get('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const counterparty = await prisma.counterparty.findFirst({
      where: { id, orgId, deletedAt: null },
    })
    if (!counterparty) return reply.status(404).send({ detail: 'Counterparty not found' })

    // Match contracts by FK OR the denormalised name — covers the
    // extractor-era rows where counterpartyId never got backfilled.
    const contracts = await prisma.contract.findMany({
      where: {
        orgId,
        deletedAt: null,
        // X7 — an own-scope caller sees only their own contracts with this
        // party. X17 — none of a diligence room's.
        ...portfolioWhere(req),
        OR: [
          { counterpartyId: id },
          { counterpartyName: counterparty.name },
        ],
      },
      select: {
        id: true,
        title: true,
        status: true,
        type: true,
        value: true,
        currency: true,
        riskScore: true,
        effectiveDate: true,
        expiryDate: true,
        createdAt: true,
        updatedAt: true,
        ownerId: true,
        owner: { select: { id: true, name: true } },
        contractNumber: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    })

    // ── Aggregates
    const ACTIVE = ['UNDER_NEGOTIATION', 'PENDING_REVIEW', 'PENDING_APPROVAL', 'PENDING_SIGNATURE', 'APPROVED']
    const EXECUTED = ['EXECUTED', 'PARTIALLY_EXECUTED']

    let totalValue = 0
    let activeCount = 0
    let executedCount = 0
    let draftCount = 0
    let highRiskCount = 0
    const statusBreakdown: Record<string, number> = {}

    for (const c of contracts) {
      // Decimal to number — value is "5000000" string in JSON, sum it as float
      const v = c.value ? Number(c.value.toString()) : 0
      totalValue += v
      statusBreakdown[c.status] = (statusBreakdown[c.status] ?? 0) + 1
      if (ACTIVE.includes(c.status)) activeCount++
      else if (EXECUTED.includes(c.status)) executedCount++
      else if (c.status === 'DRAFT') draftCount++
      if ((c.riskScore ?? 0) >= 0.7) highRiskCount++
    }

    // Recent activity — derive from contract createdAt/updatedAt/status.
    // Returns the 6 most-recent "things happened" events we can reason
    // about without an audit log. Good enough to make the page feel
    // alive; replaces with real activity feed once we have one.
    const events: Array<{ kind: string; when: string; contractId: string; contractTitle: string; label: string }> = []
    for (const c of contracts) {
      events.push({
        kind: 'created',
        when: c.createdAt.toISOString(),
        contractId: c.id,
        contractTitle: c.title,
        label: `${c.title} added`,
      })
      // Treat updatedAt as a "last touched" event when it's well after
      // creation (≥1 hr) — otherwise it's the same as created.
      const dt = c.updatedAt.getTime() - c.createdAt.getTime()
      if (dt > 60 * 60 * 1000) {
        const verb =
          c.status === 'EXECUTED' ? 'executed' :
          c.status === 'UNDER_NEGOTIATION' ? 'in negotiation' :
          c.status === 'PENDING_APPROVAL' ? 'sent for approval' :
          c.status === 'PENDING_SIGNATURE' ? 'sent for signature' :
          c.status === 'APPROVED' ? 'approved' :
          'updated'
        events.push({
          kind: 'updated',
          when: c.updatedAt.toISOString(),
          contractId: c.id,
          contractTitle: c.title,
          label: `${c.title} ${verb}`,
        })
      }
    }
    const recentActivity = events
      .sort((a, b) => b.when.localeCompare(a.when))
      .slice(0, 6)

    return reply.send({
      ...counterparty,
      contracts,
      stats: {
        contractCount: contracts.length,
        totalValue,
        currency: contracts[0]?.currency ?? 'USD',
        activeCount,
        executedCount,
        draftCount,
        highRiskCount,
        statusBreakdown,
        firstContractAt: contracts[contracts.length - 1]?.createdAt ?? null,
        lastContractAt: contracts[0]?.updatedAt ?? null,
      },
      recentActivity,
    })
  })

  // PATCH /api/v1/counterparties/:id
  app.patch('/:id', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = UpdateCounterpartySchema.parse(req.body)

    const existing = await prisma.counterparty.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Counterparty not found' })

    const updated = await prisma.counterparty.update({ where: { id, orgId }, data: body as Prisma.CounterpartyUncheckedUpdateInput })
    return reply.send(updated)
  })

  // DELETE /api/v1/counterparties/:id
  app.delete('/:id', { preHandler: requirePermission('delete', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const existing = await prisma.counterparty.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Counterparty not found' })

    await prisma.counterparty.update({ where: { id }, data: { deletedAt: new Date() } })
    return reply.status(204).send()
  })
}
