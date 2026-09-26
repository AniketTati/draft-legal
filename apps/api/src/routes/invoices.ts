/**
 * Invoice routes (P8 Step 9 — invoice reconciliation).
 *
 * Customers track vendor invoices against payment obligations
 * extracted from executed contracts. Each invoice can be auto-matched
 * to a payment obligation; users confirm or dispute the match.
 *
 *   POST  /api/v1/invoices                — create + auto-match
 *   GET   /api/v1/invoices                — list with status filter
 *   GET   /api/v1/invoices/:id            — single
 *   POST  /api/v1/invoices/:id/reconcile  — confirm match (closes obligation)
 *   POST  /api/v1/invoices/:id/dispute    — flag mismatch
 *   POST  /api/v1/invoices/:id/rematch    — re-run auto-matcher
 *   GET   /api/v1/invoices/stats          — header KPIs
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { fireWebhook } from '../lib/webhook-events.js'
import { guardOwnScopeRoutes, ownScopeGuard } from '../lib/own-scope-guard.js'

const CreateSchema = z.object({
  contractId:    z.string().min(1).optional(),  // optional manual link
  vendorName:    z.string().min(1).max(200),
  invoiceNumber: z.string().max(100).optional(),
  amount:        z.coerce.number().positive(),
  currency:      z.string().length(3).default('USD'),
  invoiceDate:   z.string(),  // ISO
  dueDate:       z.string().optional(),
  description:   z.string().max(2000).optional(),
})

const ListSchema = z.object({
  status:     z.enum(['all', 'PENDING', 'MATCHED', 'RECONCILED', 'DISPUTED']).default('all'),
  contractId: z.string().optional(),
  vendor:     z.string().optional(),
  q:          z.string().optional(),
  limit:      z.coerce.number().int().min(1).max(100).default(50),
  offset:     z.coerce.number().int().min(0).default(0),
})

interface MatchResult {
  obligationId: string
  contractId:   string
  score:        number   // 0..1
  reason:       string
}

/**
 * Pick the single best payment obligation that matches an invoice. X19 — for
 * an own-scope caller (`ownerId`), only obligations on contracts it owns: a
 * match is returned with the contract's title and the obligation's text.
 */
async function autoMatchInvoice(orgId: string, invoice: {
  vendorName: string; amount: number; currency: string; invoiceDate: Date; description?: string | null
}, ownerId?: string): Promise<MatchResult | null> {
  // Pull every OPEN payment obligation in the org and score against the invoice.
  // Capped at 500 — orgs running >500 OPEN payment obligations can re-run match
  // post-creation via /rematch with a more restrictive contract filter.
  const obs = await prisma.obligation.findMany({
    where: {
      orgId,
      status: 'OPEN',
      type:   'payment',
      // A live contract only — and, for own scope, one the caller owns. X17 —
      // never a diligence room's: its obligations are a target's, and a match
      // would let reconciling our invoice close them.
      contract: { is: { deletedAt: null, diligenceRoomId: null, ...(ownerId ? { ownerId } : {}) } },
    },
    include: {
      contract: { select: { counterpartyName: true, currency: true, value: true } },
    },
    take: 500,
  })

  let best: MatchResult | null = null
  const vendorL = invoice.vendorName.toLowerCase().trim()
  const tWindow = 60 * 24 * 60 * 60 * 1000 // ±60 days

  for (const o of obs) {
    if (!o.contract) continue
    let score = 0
    const reasons: string[] = []

    // 1. Vendor / counterparty similarity (0.40 max)
    // Weights rebalanced in Wave 3.4 to make room for the amount signal (5)
    // without pushing the max total above 1.0.
    const counterL = (o.contract.counterpartyName ?? '').toLowerCase().trim()
    if (counterL && vendorL) {
      if (counterL === vendorL) {
        score += 0.40
        reasons.push('exact counterparty match')
      } else if (counterL.includes(vendorL) || vendorL.includes(counterL)) {
        score += 0.27
        reasons.push('partial counterparty match')
      } else {
        const tokens = vendorL.split(/\s+/).filter(t => t.length > 2)
        const hit = tokens.some(t => counterL.includes(t))
        if (hit) {
          score += 0.13
          reasons.push('keyword counterparty match')
        }
      }
    }

    // 2. Due-date proximity to invoice date (0.25 max)
    if (o.dueDate) {
      const diff = Math.abs(o.dueDate.getTime() - invoice.invoiceDate.getTime())
      if (diff < 7 * 24 * 60 * 60 * 1000) {
        score += 0.25
        reasons.push('dueDate within 7d of invoiceDate')
      } else if (diff < 30 * 24 * 60 * 60 * 1000) {
        score += 0.15
        reasons.push('dueDate within 30d of invoiceDate')
      } else if (diff < tWindow) {
        score += 0.07
        reasons.push('dueDate within 60d of invoiceDate')
      }
    } else {
      // Recurring obligations without a fixed dueDate get a small base score
      // so they're not penalized into oblivion.
      if (o.recurrence !== 'one-time' && o.recurrence !== 'unknown') {
        score += 0.10
        reasons.push(`recurring (${o.recurrence})`)
      }
    }

    // 3. Currency match (0.10)
    const obCurrency = o.contract.currency ?? 'USD'
    if (obCurrency.toUpperCase() === invoice.currency.toUpperCase()) {
      score += 0.10
      reasons.push('currency matches')
    }

    // 4. Description keyword overlap with obligation description (0.15 max)
    if (invoice.description) {
      const obDescTokens = (o.description ?? '').toLowerCase().split(/\s+/).filter(t => t.length > 4)
      const invDescL = invoice.description.toLowerCase()
      const overlap = obDescTokens.filter(t => invDescL.includes(t)).length
      if (overlap >= 3) {
        score += 0.15
        reasons.push('strong description match')
      } else if (overlap >= 1) {
        score += 0.07
        reasons.push('weak description match')
      }
    }

    // 5. Amount proximity to contract value (0.15 max) — Wave 3.4.
    // The schema has no per-obligation amount, so contract.value (the total)
    // is the only amount reference. It's coarse, but a large gap is a strong
    // signal the invoice belongs to a different contract entirely — which is
    // exactly the $5-vs-$500k confusion this fixes. Prisma Decimal → Number.
    if (o.contract.value != null) {
      const contractValue = Number(o.contract.value.toString())
      if (contractValue > 0 && invoice.amount > 0) {
        const rel = Math.abs(invoice.amount - contractValue) / contractValue
        if (rel <= 0.02) {          // within 2%
          score += 0.15
          reasons.push('amount matches contract value')
        } else if (rel <= 0.10) {   // within 10%
          score += 0.10
          reasons.push('amount within 10% of contract value')
        } else if (rel <= 0.50) {   // within 50% (installment / partial)
          score += 0.05
          reasons.push('amount within 50% of contract value')
        } else if (rel >= 5) {      // off by >5× — almost certainly the wrong contract
          score -= 0.15
          reasons.push('amount grossly mismatched (penalty)')
        }
      }
    }

    // Keep the score in [0,1] after the rebalance + possible penalty, so it
    // matches the persisted matchScore (Float 0..1) and the 0.4 threshold.
    score = Math.max(0, Math.min(1, score))

    if (score > 0 && (!best || score > best.score)) {
      best = {
        obligationId: o.id,
        contractId:   o.contractId,
        score,
        reason:       reasons.join(' · '),
      }
    }
  }

  // Threshold — don't auto-match below 0.4. Lower scores = "PENDING" so the
  // user manually picks. The /rematch endpoint can be re-run after data quality
  // improves (e.g. counterparty name corrected on the contract).
  if (best && best.score >= 0.4) return best
  return null
}

/**
 * X7 — own-scope callers see the invoices on contracts they own, plus unlinked
 * invoices they entered themselves; never another rep's contract title,
 * counterparty or matched obligation.
 */
function ownInvoiceWhere(userId: string) {
  return { OR: [{ contract: { is: { ownerId: userId } } }, { contractId: null, createdById: userId }] }
}
const ownInvoiceScope = (req: FastifyRequest) => req.permissionScope === 'own' ? [ownInvoiceWhere(req.user.sub)] : []

export async function invoiceRoutes(app: FastifyInstance) {
  guardOwnScopeRoutes(app, /\/:id(\/|$)/, ownScopeGuard(
    async (req, id) => (await prisma.invoice.count({ where: { id, orgId: req.user.orgId, ...ownInvoiceWhere(req.user.sub) } })) > 0,
    'Invoice not found',
  ))

  // ── POST / — create + auto-match ─────────────────────────────────────
  app.post('/', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    let body
    try { body = CreateSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid invoice', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId, sub: userId } = req.user

    const invoiceDate = new Date(body.invoiceDate)
    const dueDate     = body.dueDate ? new Date(body.dueDate) : null
    if (isNaN(invoiceDate.getTime())) {
      return reply.status(400).send({ detail: 'invalid invoiceDate' })
    }

    // X19 — a manual link must name a live contract of this org (one the
    // caller owns, for own scope). It was stored unchecked, and the response
    // then carried another org's contract title and counterparty.
    const ownerId = req.permissionScope === 'own' ? userId : undefined
    if (body.contractId) {
      const linkable = await prisma.contract.count({
        where: { id: body.contractId, orgId, deletedAt: null, ...(ownerId ? { ownerId } : {}) },
      })
      if (!linkable) return reply.status(404).send({ detail: 'Contract not found' })
    }

    // Auto-match BEFORE inserting so we can stamp matchedObligationId + score on creation.
    const match = await autoMatchInvoice(orgId, {
      vendorName: body.vendorName,
      amount:     body.amount,
      currency:   body.currency,
      invoiceDate,
      description: body.description ?? null,
    }, ownerId)

    // If user supplied a contractId, force the contract link to that one
    // (overrides the auto-match's contract). The obligation match still
    // applies if it was on that contract; otherwise we keep the score
    // for transparency but null out matchedObligationId.
    let contractId: string | null = body.contractId ?? null
    let matchedObligationId: string | null = null
    let matchScore: number | null = null
    if (match) {
      matchScore = match.score
      if (!contractId || contractId === match.contractId) {
        contractId = match.contractId
        matchedObligationId = match.obligationId
      }
    }

    const created = await prisma.invoice.create({
      data: {
        orgId,
        createdById:    userId,
        vendorName:     body.vendorName.trim(),
        invoiceNumber:  body.invoiceNumber ?? null,
        amount:         body.amount,
        currency:       body.currency.toUpperCase(),
        invoiceDate,
        dueDate,
        description:    body.description ?? null,
        contractId,
        matchedObligationId,
        matchScore,
        status:         matchedObligationId ? 'MATCHED' : 'PENDING',
      },
      include: {
        contract:         { select: { id: true, title: true, counterpartyName: true } },
        matchedObligation: { select: { id: true, type: true, description: true, dueDate: true, severity: true } },
      },
    })

    // H2 — advertised to webhook subscribers, never emitted until now.
    fireWebhook(orgId, 'invoice.created', {
      invoiceId: created.id, contractId: created.contractId, vendorName: created.vendorName,
      amount: Number(created.amount), currency: created.currency, status: created.status,
    })
    return reply.status(201).send({ invoice: created, matchReason: match?.reason ?? null })
  })

  // ── GET / — list ──────────────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    let q
    try { q = ListSchema.parse(req.query as Record<string, unknown>) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid query', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId } = req.user

    const where: Record<string, unknown> = { orgId, AND: ownInvoiceScope(req) }
    if (q.status !== 'all') where.status = q.status
    if (q.contractId)       where.contractId = q.contractId
    if (q.vendor)           where.vendorName = { contains: q.vendor, mode: 'insensitive' }
    if (q.q) {
      where.OR = [
        { vendorName:    { contains: q.q, mode: 'insensitive' } },
        { invoiceNumber: { contains: q.q, mode: 'insensitive' } },
        { description:   { contains: q.q, mode: 'insensitive' } },
      ]
    }

    const [items, total] = await Promise.all([
      prisma.invoice.findMany({
        where: where as never,
        orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
        skip: q.offset, take: q.limit,
        include: {
          contract:         { select: { id: true, title: true, counterpartyName: true } },
          matchedObligation: { select: { id: true, type: true, description: true, dueDate: true } },
        },
      }),
      prisma.invoice.count({ where: where as never }),
    ])
    return reply.send({ data: items, total, limit: q.limit, offset: q.offset })
  })

  // ── GET /stats ────────────────────────────────────────────────────────
  app.get('/stats', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const AND = ownInvoiceScope(req)
    const [pending, matched, reconciled, disputed] = await Promise.all([
      prisma.invoice.count({ where: { orgId, AND, status: 'PENDING' } }),
      prisma.invoice.count({ where: { orgId, AND, status: 'MATCHED' } }),
      prisma.invoice.count({ where: { orgId, AND, status: 'RECONCILED' } }),
      prisma.invoice.count({ where: { orgId, AND, status: 'DISPUTED' } }),
    ])
    // Total invoiced amount in pending+matched buckets
    const open = await prisma.invoice.findMany({
      where: { orgId, AND, status: { in: ['PENDING', 'MATCHED'] } },
      select: { amount: true, currency: true },
      take: 5_000,
    })
    let openTotal = 0
    for (const inv of open) {
      const n = Number(inv.amount.toString())
      if (!isNaN(n)) openTotal += n
    }
    return reply.send({ pending, matched, reconciled, disputed, openTotal })
  })

  // ── GET /:id ──────────────────────────────────────────────────────────
  app.get('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const invoice = await prisma.invoice.findFirst({
      where: { id, orgId },
      include: {
        contract:          { select: { id: true, title: true, counterpartyName: true, type: true } },
        matchedObligation: { select: { id: true, type: true, description: true, dueDate: true, severity: true, status: true } },
      },
    })
    if (!invoice) return reply.status(404).send({ detail: 'Invoice not found' })
    return reply.send(invoice)
  })

  // ── POST /:id/reconcile — confirm the match ──────────────────────────
  // Closes the linked obligation as well, since the customer is asserting
  // the invoice IS the satisfaction of the obligation.
  app.post('/:id/reconcile', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = (req.body ?? {}) as { notes?: string }

    const inv = await prisma.invoice.findFirst({
      where: { id, orgId },
      select: { id: true, status: true, matchedObligationId: true, contractId: true },
    })
    if (!inv) return reply.status(404).send({ detail: 'Invoice not found' })
    if (inv.status === 'RECONCILED') return reply.status(409).send({ detail: 'Already reconciled' })
    // X45 — reconciling completes the matched obligation, whose completer is a
    // user, and a key is none: a key's reconcile records no one there (its
    // audit event names the key).
    const completedById = req.user.sub.startsWith('apikey:') ? null : userId

    const now = new Date()
    const updated = await prisma.invoice.update({
      where: { id },
      data: {
        status:         'RECONCILED',
        reconciledAt:   now,
        reconciledById: userId,
        notes:          body.notes ? body.notes.slice(0, 4000) : undefined,
      },
    })

    // Close the matched obligation if it's still open.
    if (inv.matchedObligationId) {
      const closed = await prisma.obligation.updateMany({
        // Bounded to this org and the invoice's own contract, so a bad link
        // can never close someone else's obligation.
        where: { id: inv.matchedObligationId, orgId, contractId: inv.contractId ?? undefined, status: { in: ['OPEN', 'OVERDUE'] } },
        data: {
          status:         'COMPLETED',
          completedAt:    now,
          completedById,
          completionNote: `Reconciled via invoice ${inv.id}${body.notes ? ` — ${body.notes.slice(0, 100)}` : ''}`,
        },
      })
      // X63 — only when this closed it: an obligation already completed (or
      // a link that doesn't qualify) was recorded as completed again.
      if (inv.contractId && closed.count > 0) {
        await createAuditEvent({
          orgId, userId,
          action: AuditAction.OBLIGATION_COMPLETED,
          resourceType: 'contract', resourceId: inv.contractId,
          metadata: { obligationId: inv.matchedObligationId, source: 'invoice_reconcile', invoiceId: id },
        })
      }
    }

    fireWebhook(orgId, 'invoice.reconciled', {
      invoiceId: id, contractId: inv.contractId,
      obligationId: inv.matchedObligationId,
      reconciledAt: now.toISOString(),
    })

    return reply.send(updated)
  })

  // ── POST /:id/dispute ────────────────────────────────────────────────
  app.post('/:id/dispute', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = (req.body ?? {}) as { reason?: string }
    const updated = await prisma.invoice.updateMany({
      where: { id, orgId, status: { in: ['PENDING', 'MATCHED'] } },
      data:  { status: 'DISPUTED', disputeReason: body.reason ? body.reason.slice(0, 4000) : null },
    })
    if (updated.count === 0) {
      return reply.status(404).send({ detail: 'Invoice not found or not in a disputable state' })
    }
    return reply.send({ ok: true })
  })

  // ── POST /:id/rematch — re-run auto-matcher ──────────────────────────
  app.post('/:id/rematch', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const inv = await prisma.invoice.findFirst({
      where: { id, orgId },
      select: { id: true, vendorName: true, amount: true, currency: true, invoiceDate: true, description: true, status: true },
    })
    if (!inv) return reply.status(404).send({ detail: 'Invoice not found' })
    if (inv.status === 'RECONCILED') return reply.status(409).send({ detail: 'Cannot rematch a reconciled invoice' })

    const match = await autoMatchInvoice(orgId, {
      vendorName: inv.vendorName,
      amount:     Number(inv.amount.toString()),
      currency:   inv.currency,
      invoiceDate: inv.invoiceDate,
      description: inv.description ?? null,
    }, req.permissionScope === 'own' ? req.user.sub : undefined)

    const data: Record<string, unknown> = {
      matchedObligationId: match?.obligationId ?? null,
      matchScore:          match?.score ?? null,
      contractId:          match?.contractId ?? null,
      status:              match ? 'MATCHED' : 'PENDING',
    }
    const updated = await prisma.invoice.update({
      where: { id },
      data: data as never,
      include: {
        contract:         { select: { id: true, title: true, counterpartyName: true } },
        matchedObligation: { select: { id: true, type: true, description: true, dueDate: true } },
      },
    })
    return reply.send({ invoice: updated, matchReason: match?.reason ?? null })
  })
}
