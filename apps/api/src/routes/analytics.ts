/**
 * Analytics routes (P9 Step 1+2 — KPI engine + dashboard data).
 *
 *   GET /api/v1/analytics/summary
 *     Headline KPIs: total executed value, cycle time, approval rate,
 *     on-time execution %, contracts at risk.
 *
 *   GET /api/v1/analytics/distributions
 *     Counts grouped by status, type, and risk bucket — feeds the
 *     pie / bar charts on the dashboard.
 *
 *   GET /api/v1/analytics/timeseries
 *     Contracts created per month for the last 12 months. Feeds the
 *     volume trend line chart.
 *
 *   GET /api/v1/analytics/top-counterparties
 *     Top N counterparties by total executed value (default 10).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'

const TimeRangeSchema = z.object({
  // Lookback in days for cycle-time + acceptance KPIs. Defaults to 90.
  days:  z.coerce.number().int().min(7).max(3650).default(90),
})

interface KpiSummary {
  // Counts
  totalContracts:    number
  executedContracts: number
  pendingApprovals:  number
  expiringSoon:      number       // next 90 days
  highRiskOpen:      number       // riskScore > 60 + not EXECUTED/EXPIRED/TERMINATED

  // Currency
  executedTotalValue: number      // sum(value) EXECUTED
  executedTotalCurrency: string   // dominant currency in EXECUTED set

  // Time-based KPIs
  cycleTimeAvgDays:    number | null    // contracts EXECUTED in window
  cycleTimeMedianDays: number | null
  approvalAcceptanceRate: number | null // 0..1
  onTimeExecutionRate:    number | null // 0..1 (executed within 14d)
  withinTargetDays:        number       // target threshold used in onTime calc

  windowDays: number
}

export async function analyticsRoutes(app: FastifyInstance) {
  // ── GET /summary ─────────────────────────────────────────────────────
  app.get('/summary', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    let q
    try { q = TimeRangeSchema.parse(req.query as Record<string, unknown>) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid query', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId } = req.user
    const now = new Date()
    const windowStart = new Date(now.getTime() - q.days * 24 * 60 * 60 * 1000)
    const expiringHorizon = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    const TARGET_DAYS = 14

    // Fan out the simple counts in parallel.
    const [
      totalContracts, executedContracts, pendingApprovals, expiringSoon, highRiskOpen,
      executedAggregate, executedRecent, approvals,
    ] = await Promise.all([
      prisma.contract.count({ where: { orgId, deletedAt: null } }),
      prisma.contract.count({ where: { orgId, deletedAt: null, status: 'EXECUTED' } }),
      prisma.approvalInstance.count({ where: { orgId, status: 'PENDING' } }),
      prisma.contract.count({
        where: { orgId, deletedAt: null, status: 'EXECUTED', expiryDate: { gte: now, lte: expiringHorizon } },
      }),
      prisma.contract.count({
        where: {
          orgId, deletedAt: null,
          // 0-100, matching the declared scale in @clm/types. These were 0-1,
          // so with real data "high risk open" counted almost nothing.
          riskScore: { gt: 60 },
          status: { notIn: ['EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED'] },
        },
      }),
      // Sum executed value (Decimal in Prisma → handle in app layer).
      prisma.contract.findMany({
        where:  { orgId, deletedAt: null, status: 'EXECUTED' },
        select: { value: true, currency: true },
        take:   5_000,
      }),
      // For cycle time: contracts that EXECUTED inside the window.
      prisma.contract.findMany({
        where: {
          orgId, deletedAt: null, status: 'EXECUTED',
          updatedAt: { gte: windowStart },
        },
        select: { id: true, createdAt: true, updatedAt: true },
        take: 5_000,
      }),
      // Approvals decided in the window — for acceptance rate.
      prisma.approvalInstance.findMany({
        where: { orgId, status: { in: ['APPROVED', 'REJECTED'] }, decidedAt: { gte: windowStart } },
        select: { status: true },
        take: 5_000,
      }),
    ])

    // Total executed value + dominant currency.
    let executedTotalValue = 0
    const currencyCounts = new Map<string, number>()
    for (const c of executedAggregate) {
      if (c.value) {
        const n = Number(c.value.toString())
        if (!isNaN(n)) executedTotalValue += n
      }
      const cur = c.currency ?? 'USD'
      currencyCounts.set(cur, (currencyCounts.get(cur) ?? 0) + 1)
    }
    let dominantCurrency = 'USD'
    let dominantCount = 0
    for (const [cur, count] of currencyCounts.entries()) {
      if (count > dominantCount) { dominantCount = count; dominantCurrency = cur }
    }

    // Cycle time — using updatedAt as a proxy for the EXECUTED transition.
    // signatures.ts hits prisma.contract.update() right when `allSigned` flips
    // to EXECUTED, so for any contract whose terminal state is EXECUTED the
    // updatedAt is the execution timestamp (within sub-second precision).
    // This avoids needing a schema-level executedAt + a migration.
    const days: number[] = []
    let withinTarget = 0
    for (const c of executedRecent) {
      const ms = c.updatedAt.getTime() - c.createdAt.getTime()
      const d = ms / (24 * 60 * 60 * 1000)
      if (d >= 0) {
        days.push(d)
        if (d <= TARGET_DAYS) withinTarget++
      }
    }
    days.sort((a, b) => a - b)
    const avg = days.length > 0 ? days.reduce((s, x) => s + x, 0) / days.length : null
    const med = days.length > 0
      ? days.length % 2 === 1
        ? days[(days.length - 1) / 2]
        : (days[days.length / 2 - 1] + days[days.length / 2]) / 2
      : null

    // Approval acceptance rate.
    const approved = approvals.filter(a => a.status === 'APPROVED').length
    const total = approvals.length
    const acceptanceRate = total > 0 ? approved / total : null

    // On-time execution: % of executed contracts whose cycle was within target.
    const onTimeRate = days.length > 0 ? withinTarget / days.length : null

    const summary: KpiSummary = {
      totalContracts,
      executedContracts,
      pendingApprovals,
      expiringSoon,
      highRiskOpen,
      executedTotalValue,
      executedTotalCurrency: dominantCurrency,
      cycleTimeAvgDays:    avg != null ? Number(avg.toFixed(1)) : null,
      cycleTimeMedianDays: med != null ? Number(med.toFixed(1)) : null,
      approvalAcceptanceRate: acceptanceRate,
      onTimeExecutionRate:    onTimeRate,
      withinTargetDays:       TARGET_DAYS,
      windowDays:             q.days,
    }
    return reply.send(summary)
  })

  // ── GET /distributions ───────────────────────────────────────────────
  app.get('/distributions', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user

    const [byStatus, byType, byRisk] = await Promise.all([
      prisma.contract.groupBy({
        by: ['status'],
        where: { orgId, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.contract.groupBy({
        by: ['type'],
        where: { orgId, deletedAt: null },
        _count: { _all: true },
      }),
      // Risk buckets — a single grouped query against the literal CASE
      // expression. We do this in app-layer because Prisma's groupBy
      // can't bucket arbitrary numeric ranges.
      prisma.contract.findMany({
        where: { orgId, deletedAt: null },
        select: { riskScore: true },
        take: 5_000,
      }),
    ])

    const riskBuckets = { low: 0, medium: 0, high: 0, critical: 0, none: 0 }
    for (const c of byRisk) {
      if (c.riskScore == null) riskBuckets.none++
      else if (c.riskScore < 30) riskBuckets.low++
      else if (c.riskScore < 60) riskBuckets.medium++
      else if (c.riskScore < 80) riskBuckets.high++
      else riskBuckets.critical++
    }

    return reply.send({
      byStatus: byStatus.map(s => ({ key: s.status, count: s._count._all })),
      byType:   byType.map(t   => ({ key: t.type,   count: t._count._all })),
      byRisk: [
        { key: 'low',      count: riskBuckets.low,      label: '<30 (low)' },
        { key: 'medium',   count: riskBuckets.medium,   label: '30–59 (medium)' },
        { key: 'high',     count: riskBuckets.high,     label: '60–79 (high)' },
        { key: 'critical', count: riskBuckets.critical, label: '80+ (critical)' },
        { key: 'none',     count: riskBuckets.none,     label: 'Not scored' },
      ],
    })
  })

  // ── GET /timeseries ──────────────────────────────────────────────────
  // Contracts created per month, last 12 months. Fills empty months
  // with zero so the chart line is continuous.
  app.get('/timeseries', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1)

    const contracts = await prisma.contract.findMany({
      where:  { orgId, deletedAt: null, createdAt: { gte: start } },
      select: { createdAt: true, status: true },
      take:   10_000,
    })

    // Bucket by month.
    const buckets = new Map<string, { created: number; executed: number }>()
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      buckets.set(key, { created: 0, executed: 0 })
    }
    for (const c of contracts) {
      const key = `${c.createdAt.getFullYear()}-${String(c.createdAt.getMonth() + 1).padStart(2, '0')}`
      const b = buckets.get(key)
      if (b) {
        b.created++
        if (c.status === 'EXECUTED') b.executed++
      }
    }
    const series = Array.from(buckets.entries()).map(([month, v]) => ({
      month,
      label: new Date(month + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      created:  v.created,
      executed: v.executed,
    }))
    return reply.send({ series })
  })

  // ── GET /top-counterparties ──────────────────────────────────────────
  app.get('/top-counterparties', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const limit = Math.min(50, Math.max(5, Number((req.query as { limit?: string }).limit ?? 10)))

    const contracts = await prisma.contract.findMany({
      where:  { orgId, deletedAt: null, status: 'EXECUTED', counterpartyName: { not: null } },
      select: { counterpartyName: true, counterpartyId: true, value: true, currency: true },
      take:   5_000,
    })

    const totals = new Map<string, { count: number; value: number; currency: string; counterpartyId: string | null }>()
    for (const c of contracts) {
      if (!c.counterpartyName) continue
      const k = c.counterpartyName.trim()
      if (!k) continue
      if (!totals.has(k)) {
        totals.set(k, { count: 0, value: 0, currency: c.currency ?? 'USD', counterpartyId: c.counterpartyId ?? null })
      }
      const entry = totals.get(k)!
      entry.count++
      // Prefer the most-recently-seen non-null id.
      if (c.counterpartyId) entry.counterpartyId = c.counterpartyId
      if (c.value) {
        const n = Number(c.value.toString())
        if (!isNaN(n)) entry.value += n
      }
    }
    const ranked = Array.from(totals.entries())
      .map(([name, v]) => ({
        counterparty:   name,
        counterpartyId: v.counterpartyId,
        count:          v.count,
        value:          v.value,
        currency:       v.currency,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit)

    return reply.send({ data: ranked })
  })
}
