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
 *
 *   GET /api/v1/analytics/by-field?key=&contractType=&currency=
 *     docs/39 D3 — one field's values across the portfolio, as bars that
 *     each open their contracts.
 *
 *   GET /api/v1/analytics/{speed|bottlenecks|workload|negotiation|risk|renewals|ai}
 *       ?from=&to=&type=&ownerId=&paperSource=ours|theirs[&format=csv]
 *     docs/41 Part 19 — one section of the decision-led page (see
 *     lib/analytics-sections.ts for what each holds and what the period means).
 *
 *   GET /api/v1/analytics/drilldown?metric=section.part.chart&key=&<filters>
 *     The contracts behind one bar, for the contract list.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { portfolioWhere } from '../lib/own-scope-guard.js'
import { totalsByCurrency, type CurrencyTotal } from '@clm/types'
import { catalogField, fieldCatalog } from '../lib/field-query.js'
import { CHARTABLE_TYPES, fieldDistribution } from '../lib/field-distribution.js'
import { loadDirectory } from '../lib/counterparty-directory.js'
import { compactKey } from '../lib/company-names.js'
import { permissionScopeFor } from '../middleware/permissions.js'
import { SECTIONS, loadSection, flatten, drilldown, type AnalyticsContext, type AnalyticsFilters } from '../lib/analytics-sections.js'
import { sectionCsv, withoutIds, DAY_MS } from '../lib/analytics-metrics.js'

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

  // Currency — docs/39 D4: one total per currency, never a sum across them.
  executedTotals: CurrencyTotal[]  // EXECUTED contracts' value, per currency, most common first
  executedTotalValue: number      // the most common currency's total only
  executedTotalCurrency: string   // that currency

  // Time-based KPIs
  cycleTimeAvgDays:    number | null    // contracts EXECUTED in window
  cycleTimeMedianDays: number | null
  approvalAcceptanceRate: number | null // 0..1
  onTimeExecutionRate:    number | null // 0..1 (executed within 14d)
  withinTargetDays:        number       // target threshold used in onTime calc

  windowDays: number
}

const DEFAULT_PERIOD_DAYS = 180
/** The contract list takes the ids in its query string; more than this would not fit. */
const DRILL_LIMIT = 300

const SectionQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  type: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  paperSource: z.enum(['ours', 'theirs']).optional(),
  format: z.enum(['json', 'csv']).optional(),
  metric: z.string().optional(),
  key: z.string().optional(),
})

export async function analyticsRoutes(app: FastifyInstance) {
  // ── GET /summary ─────────────────────────────────────────────────────
  app.get('/summary', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    let q
    try { q = TimeRangeSchema.parse(req.query as Record<string, unknown>) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid query', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId } = req.user
    // X7 — own-scope callers get the figures for their own contracts.
    const own = portfolioWhere(req)   // X17 — the org's own contracts, not a diligence room's
    const ownApprovals = { contract: { is: { diligenceRoomId: null, ...(own.ownerId ? { ownerId: own.ownerId } : {}) } } }
    const now = new Date()
    const windowStart = new Date(now.getTime() - q.days * 24 * 60 * 60 * 1000)
    const expiringHorizon = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    const TARGET_DAYS = 14

    // Fan out the simple counts in parallel.
    const [
      totalContracts, executedContracts, pendingApprovals, expiringSoon, highRiskOpen,
      executedAggregate, executedRecent, approvals,
    ] = await Promise.all([
      prisma.contract.count({ where: { orgId, deletedAt: null, ...own } }),
      prisma.contract.count({ where: { orgId, deletedAt: null, ...own, status: 'EXECUTED' } }),
      // ESCALATED is still awaiting a decision (C2) — count it as pending.
      prisma.approvalInstance.count({ where: { orgId, ...ownApprovals, status: { in: ['PENDING', 'IN_PROGRESS', 'ESCALATED'] } } }),
      prisma.contract.count({
        where: { orgId, deletedAt: null, ...own, status: 'EXECUTED', expiryDate: { gte: now, lte: expiringHorizon } },
      }),
      prisma.contract.count({
        where: {
          orgId, deletedAt: null, ...own,
          // 0-100, matching the declared scale in @clm/types. These were 0-1,
          // so with real data "high risk open" counted almost nothing.
          riskScore: { gt: 60 },
          status: { notIn: ['EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED'] },
        },
      }),
      // Sum executed value (Decimal in Prisma → handle in app layer).
      prisma.contract.findMany({
        where:  { orgId, deletedAt: null, ...own, status: 'EXECUTED' },
        select: { value: true, currency: true },
        take:   5_000,
      }),
      // For cycle time: contracts that EXECUTED inside the window.
      prisma.contract.findMany({
        where: {
          orgId, deletedAt: null, ...own,
          executedAt: { gte: windowStart },
        },
        select: { id: true, createdAt: true, executedAt: true },
        take: 5_000,
      }),
      // Approvals decided in the window — for acceptance rate.
      prisma.approvalInstance.findMany({
        where: { orgId, ...ownApprovals, status: { in: ['APPROVED', 'REJECTED'] }, decidedAt: { gte: windowStart } },
        select: { status: true },
        take: 5_000,
      }),
    ])

    // Total executed value, per currency (docs/39 D4). The single figure kept
    // for older readers is the most common currency's own total: it summed
    // every currency's amounts under that one label.
    const executedTotals = totalsByCurrency(executedAggregate.map(c => ({ value: c.value?.toString(), currency: c.currency })))
    const executedTotalValue = executedTotals[0]?.amount ?? 0
    const dominantCurrency = executedTotals[0]?.currency ?? 'USD'

    // Cycle time — created to executed (docs/41 Part 19). It was measured to
    // updatedAt, which any later edit moved; executedAt is set once, when the
    // last signer signs (or the record is marked executed).
    const days: number[] = []
    let withinTarget = 0
    for (const c of executedRecent) {
      const ms = c.executedAt!.getTime() - c.createdAt.getTime()
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
      executedTotals,
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
    const own = portfolioWhere(req)   // X7, X17

    const [byStatus, byType, byRisk] = await Promise.all([
      prisma.contract.groupBy({
        by: ['status'],
        where: { orgId, deletedAt: null, ...own },
        _count: { _all: true },
      }),
      prisma.contract.groupBy({
        by: ['type'],
        where: { orgId, deletedAt: null, ...own },
        _count: { _all: true },
      }),
      // Risk buckets — a single grouped query against the literal CASE
      // expression. We do this in app-layer because Prisma's groupBy
      // can't bucket arbitrary numeric ranges.
      prisma.contract.findMany({
        where: { orgId, deletedAt: null, ...own },
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

  // ── GET /by-field — docs/39 D3 ───────────────────────────────────────
  // How one field's values spread across the portfolio, each bar with the
  // filters that list its contracts (lib/field-distribution.ts).
  app.get('/by-field', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const q = z.object({
      key: z.string().min(1).max(64),
      contractType: z.string().max(64).optional(),
      currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    }).parse(req.query)
    const catalog = await fieldCatalog(req.user.orgId)
    const field = catalogField(catalog, q.key)
    if (!field) return reply.status(404).send({ detail: `No field named “${q.key}”` })
    if (!CHARTABLE_TYPES.has(field.type)) return reply.status(400).send({ detail: `${field.label} is written out in words: it can be read, not charted` })
    return reply.send(await fieldDistribution({
      orgId: req.user.orgId, contractType: q.contractType, currency: q.currency,
      ownerId: req.permissionScope === 'own' ? req.user.sub : undefined,   // X7
    }, field))
  })

  // ── GET /timeseries ──────────────────────────────────────────────────
  // Contracts created per month, last 12 months. Fills empty months
  // with zero so the chart line is continuous.
  app.get('/timeseries', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1)

    const contracts = await prisma.contract.findMany({
      where:  { orgId, deletedAt: null, ...portfolioWhere(req), createdAt: { gte: start } },   // X7
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
      where:  { orgId, deletedAt: null, ...portfolioWhere(req), status: 'EXECUTED', counterpartyName: { not: null } },   // X7
      select: { counterpartyName: true, counterpartyId: true, value: true, currency: true },
      take:   5_000,
    })

    // docs/39 A14 — one row per company: the directory entry a contract links
    // to, else its name as a company ("ACME CORP" and "Acme Corp." together).
    // D4 — and totals per currency: they used to add euros to dollars.
    const entries = new Map((await loadDirectory(prisma, orgId)).map(e => [e.id, e]))
    const groups = new Map<string, { entry: { id: string; name: string } | null; names: Map<string, number>; rows: typeof contracts }>()
    for (const c of contracts) {
      const name = c.counterpartyName?.trim()
      if (!name) continue
      const entry = c.counterpartyId ? entries.get(c.counterpartyId) : undefined
      const k = entry ? `id:${entry.id}` : `name:${compactKey(name) || name.toLowerCase()}`
      const g = groups.get(k) ?? { entry: entry ? { id: entry.id, name: entry.name } : null, names: new Map<string, number>(), rows: [] }
      g.names.set(name, (g.names.get(name) ?? 0) + 1)
      g.rows.push(c)
      groups.set(k, g)
    }
    // Ranked by what they come to in the portfolio's main currency: amounts in
    // different currencies can't be compared without a rate.
    const main = totalsByCurrency(contracts.map(c => ({ value: c.value?.toString(), currency: c.currency })))[0]?.currency ?? 'USD'
    const ranked = [...groups.values()]
      .map(g => {
        const names = [...g.names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)
        const totals = totalsByCurrency(g.rows.map(c => ({ value: c.value?.toString(), currency: c.currency })))
        return {
          counterparty:   g.entry?.name ?? names[0],
          counterpartyId: g.entry?.id ?? null,
          // How its contracts spell it, for a list filtered to them when it isn't in the directory.
          names,
          count:          g.rows.length,
          totals,
          // The largest currency's total, for older readers.
          value:          totals[0]?.amount ?? 0,
          currency:       totals[0]?.currency ?? main,
        }
      })
      .sort((a, b) =>
        (b.totals.find(t => t.currency === main)?.amount ?? 0) - (a.totals.find(t => t.currency === main)?.amount ?? 0)
        || b.count - a.count
        || a.counterparty.localeCompare(b.counterparty))
      .slice(0, limit)

    return reply.send({ data: ranked })
  })

  // ── docs/41 Part 19: sections organised by decision ────────────────────
  const parseFilters = (q: Record<string, unknown>): AnalyticsFilters | { error: unknown } => {
    const r = SectionQuerySchema.safeParse(q)
    if (!r.success) return { error: r.error.issues }
    const to = r.data.to ?? new Date()
    const from = r.data.from ?? new Date(to.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS)
    if (from > to) return { error: [{ message: 'from is after to' }] }
    return { from, to, type: r.data.type, ownerId: r.data.ownerId, paperSource: r.data.paperSource }
  }
  const contextOf = async (req: import('fastify').FastifyRequest): Promise<AnalyticsContext> => ({
    orgId: req.user.orgId, userId: req.user.sub, scope: portfolioWhere(req),   // X7, X17
    canTeam: (await permissionScopeFor(req, 'configure', 'workflow')) === 'org',
    now: new Date(),
  })

  for (const name of SECTIONS) {
    app.get(`/${name}`, { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
      const q = req.query as Record<string, unknown>
      const f = parseFilters(q)
      if ('error' in f) return reply.status(400).send({ detail: 'Invalid query', issues: f.error })
      const parts = await loadSection(name, await contextOf(req), f)
      if (q.format === 'csv') {
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="analytics-${name}-${f.from.toISOString().slice(0, 10)}-to-${f.to.toISOString().slice(0, 10)}.csv"`)
          .send(sectionCsv(flatten(parts)))
      }
      return reply.send({
        section: name,
        filters: { from: f.from.toISOString(), to: f.to.toISOString(), type: f.type ?? null, ownerId: f.ownerId ?? null, paperSource: f.paperSource ?? null },
        parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, withoutIds(v)])),
      })
    })
  }

  app.get('/drilldown', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (typeof q.metric !== 'string' || typeof q.key !== 'string') return reply.status(400).send({ detail: 'metric and key are required' })
    const f = parseFilters(q)
    if ('error' in f) return reply.status(400).send({ detail: 'Invalid query', issues: f.error })
    const r = await drilldown(q.metric, q.key, await contextOf(req), f)
    if (!r) return reply.status(404).send({ detail: `No chart ${q.metric}` })
    return reply.send({ metric: q.metric, key: q.key, label: r.label, total: r.ids.length, ids: r.ids.slice(0, DRILL_LIMIT) })
  })
}
