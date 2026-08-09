/**
 * Renewal routes (P8 Step 7).
 *
 *   GET /api/v1/renewals
 *     Org-wide list of EXECUTED contracts whose expiryDate falls inside
 *     the lookahead window. Groups by month and exposes per-bucket KPIs
 *     (count, total ACV) so the calendar view can render without
 *     additional fetches.
 *
 *   GET /api/v1/renewals/stats
 *     Header KPIs: this month, next 30d, next 60d, next 90d, no-decision.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { buildCsv } from '../lib/csv.js'

const ListSchema = z.object({
  bucket: z.enum(['all', 'this_week', 'next_30', 'next_60', 'next_90', 'overdue']).default('all'),
  /** Override the lookahead window. Default 365d. */
  lookaheadDays: z.coerce.number().int().min(1).max(3650).default(365),
  status: z.enum(['all', 'pending', 'decided']).default('all'),
})

interface RenewalRow {
  id:               string
  title:            string
  type:             string
  counterpartyName: string | null
  expiryDate:       string | null
  effectiveDate:    string | null
  value:            string | null
  currency:         string | null
  ownerId:          string
  ownerName:        string | null
  // AI-extracted term sheet. The renewals calendar needs autoRenew +
  // noticeDays to show the notice-to-terminate deadline, which is the date
  // that actually binds — expiry alone is too late to act on.
  keyTerms:         Record<string, unknown> | null
  // Renewal-specific from metadata
  renewalDecision:    string | null   // renew | renegotiate | let_expire | pause | unknown
  renewalDecisionAt:  string | null
  renewalAdvice: {
    recommendation: string
    confidence:     string
    rationale:      string
  } | null
}

export async function renewalRoutes(app: FastifyInstance) {
  // ── GET / ──────────────────────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    let q
    try { q = ListSchema.parse(req.query as Record<string, unknown>) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid query', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId } = req.user
    const now = new Date()

    // Date window — default 365 days lookahead, allow up to 30 days look-back.
    const lookahead = new Date(now.getTime() + q.lookaheadDays * 24 * 60 * 60 * 1000)
    const lookback  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const contracts = await prisma.contract.findMany({
      where: {
        orgId, deletedAt: null,
        status:     'EXECUTED',
        expiryDate: { gte: lookback, lte: lookahead },
      },
      select: {
        id: true, title: true, type: true,
        counterpartyName: true, expiryDate: true, effectiveDate: true,
        value: true, currency: true, metadata: true, keyTerms: true,
        ownerId: true,
        owner: { select: { name: true } },
      },
      orderBy: { expiryDate: 'asc' },
      take: 1_000,
    })

    const rows: RenewalRow[] = contracts.map(c => {
      const md = (c.metadata ?? {}) as {
        renewalDecision?:   string | null
        renewalDecisionAt?: string | null
        renewalAdvice?:     { recommendation?: string; confidence?: string; rationale?: string }
      }
      return {
        id:               c.id,
        title:            c.title,
        type:             c.type,
        counterpartyName: c.counterpartyName,
        expiryDate:       c.expiryDate?.toISOString() ?? null,
        effectiveDate:    c.effectiveDate?.toISOString() ?? null,
        value:            c.value ? c.value.toString() : null,
        currency:         c.currency ?? null,
        ownerId:          c.ownerId,
        ownerName:        c.owner?.name ?? null,
        keyTerms:         (c.keyTerms && typeof c.keyTerms === 'object' && !Array.isArray(c.keyTerms))
          ? (c.keyTerms as Record<string, unknown>)
          : null,
        renewalDecision:    md.renewalDecision ?? null,
        renewalDecisionAt:  md.renewalDecisionAt ?? null,
        renewalAdvice:    md.renewalAdvice
          ? {
              recommendation: md.renewalAdvice.recommendation ?? '',
              confidence:     md.renewalAdvice.confidence ?? '',
              rationale:      md.renewalAdvice.rationale ?? '',
            }
          : null,
      }
    })

    // Bucket filter
    let filtered = rows
    if (q.bucket !== 'all') {
      const cutoff7  = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000)
      const cutoff30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      const cutoff60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000)
      const cutoff90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
      filtered = rows.filter(r => {
        if (!r.expiryDate) return false
        const d = new Date(r.expiryDate)
        if (q.bucket === 'overdue')   return d < now
        if (q.bucket === 'this_week') return d >= now && d <= cutoff7
        if (q.bucket === 'next_30')   return d >= now && d <= cutoff30
        if (q.bucket === 'next_60')   return d >= now && d <= cutoff60
        if (q.bucket === 'next_90')   return d >= now && d <= cutoff90
        return true
      })
    }
    if (q.status !== 'all') {
      filtered = filtered.filter(r =>
        q.status === 'decided'
          ? r.renewalDecision != null && r.renewalDecision !== 'unknown'
          : r.renewalDecision == null || r.renewalDecision === 'unknown',
      )
    }

    // Group by month-of-expiry (YYYY-MM) for the calendar UI.
    const groups: Record<string, { month: string; label: string; rows: RenewalRow[]; totalValue: number; currency: string }> = {}
    for (const r of filtered) {
      if (!r.expiryDate) continue
      const d = new Date(r.expiryDate)
      const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      if (!groups[monthKey]) {
        groups[monthKey] = { month: monthKey, label, rows: [], totalValue: 0, currency: r.currency ?? 'USD' }
      }
      groups[monthKey].rows.push(r)
      if (r.value) {
        const n = Number(r.value)
        if (!isNaN(n)) groups[monthKey].totalValue += n
      }
    }
    const months = Object.values(groups).sort((a, b) => a.month.localeCompare(b.month))

    return reply.send({
      data:    filtered,
      months,
      total:   filtered.length,
      window:  { from: lookback.toISOString(), to: lookahead.toISOString() },
    })
  })

  // ── GET /export — CSV download (P9 Step 7) ─────────────────────────
  app.get('/export', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const format = ((req.query as { format?: string }).format ?? 'csv').toLowerCase()
    if (format !== 'csv') return reply.status(400).send({ detail: 'Only csv is supported' })
    const { orgId } = req.user
    const now = new Date()
    const lookahead = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
    const lookback  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const contracts = await prisma.contract.findMany({
      where: {
        orgId, deletedAt: null, status: 'EXECUTED',
        expiryDate: { gte: lookback, lte: lookahead },
      },
      select: {
        id: true, title: true, type: true, counterpartyName: true,
        effectiveDate: true, expiryDate: true, value: true, currency: true,
        metadata: true,
        owner: { select: { name: true, email: true } },
      },
      orderBy: { expiryDate: 'asc' },
      take: 5_000,
    })

    const headers = [
      'Title', 'Type', 'Counterparty', 'Owner', 'Effective Date', 'Expiry Date',
      'Days Until Expiry', 'Value', 'Currency', 'AI Recommendation', 'AI Confidence', 'Decision',
    ]
    const rows = contracts.map(c => {
      const md = (c.metadata ?? {}) as { renewalAdvice?: { recommendation?: string; confidence?: string }; renewalDecision?: string }
      const days = c.expiryDate ? Math.round((c.expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) : ''
      return [
        c.title, c.type, c.counterpartyName ?? '',
        c.owner?.name ?? '',
        c.effectiveDate?.toISOString().slice(0, 10) ?? '',
        c.expiryDate?.toISOString().slice(0, 10) ?? '',
        days,
        c.value ? Number(c.value.toString()) : '',
        c.currency ?? '',
        md.renewalAdvice?.recommendation ?? '',
        md.renewalAdvice?.confidence ?? '',
        md.renewalDecision ?? '',
      ]
    })
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="renewals-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(buildCsv(headers, rows))
  })

  // ── GET /stats — header KPIs ──────────────────────────────────────────
  app.get('/stats', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const now = new Date()
    const cut7  = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000)
    const cut30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    const cut60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000)
    const cut90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    const back30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const [overdue, thisWeek, next30, next60, next90, totalIn90] = await Promise.all([
      prisma.contract.count({ where: { orgId, deletedAt: null, status: 'EXECUTED', expiryDate: { gte: back30, lt: now } } }),
      prisma.contract.count({ where: { orgId, deletedAt: null, status: 'EXECUTED', expiryDate: { gte: now, lte: cut7 } } }),
      prisma.contract.count({ where: { orgId, deletedAt: null, status: 'EXECUTED', expiryDate: { gte: now, lte: cut30 } } }),
      prisma.contract.count({ where: { orgId, deletedAt: null, status: 'EXECUTED', expiryDate: { gte: now, lte: cut60 } } }),
      prisma.contract.count({ where: { orgId, deletedAt: null, status: 'EXECUTED', expiryDate: { gte: now, lte: cut90 } } }),
      prisma.contract.findMany({
        where:  { orgId, deletedAt: null, status: 'EXECUTED', expiryDate: { gte: now, lte: cut90 } },
        select: { value: true, currency: true, metadata: true },
        take: 500,
      }),
    ])

    let totalAcvNext90 = 0
    let undecided = 0
    for (const c of totalIn90) {
      if (c.value) {
        const n = Number(c.value.toString())
        if (!isNaN(n)) totalAcvNext90 += n
      }
      const md = (c.metadata ?? {}) as { renewalDecision?: string | null }
      if (!md.renewalDecision || md.renewalDecision === 'unknown') undecided++
    }

    return reply.send({
      overdue, thisWeek, next30, next60, next90, undecided, totalAcvNext90,
    })
  })
}
