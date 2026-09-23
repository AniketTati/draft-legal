import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { permissionScopeFor } from '../middleware/permissions.js'

const ACTIVE_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'UNDER_NEGOTIATION',
  'PENDING_APPROVAL',
  'APPROVED',
  'PENDING_SIGNATURE',
  'EXECUTED',
]

const OPEN_REQUEST_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'MORE_INFO_NEEDED']

/**
 * B.6.4 — Activity feed rewrite.
 *
 * Problem (docs/27 Walk 5): the feed was noise-dominated — 7 of 8
 * entries read "Contract updated · System · <date>" with no entity
 * title. A user learned nothing from it.
 *
 * Fix: model each entry as a complete sentence — "[actor] [verb]
 * [entity]" with optional secondary context. Inspired by Linear's
 * project activity feed. Plumbing events authored by the system
 * (userId = null) are excluded — they live in the audit trail
 * instead, where admins can read them.
 *
 * The verb table is keyed on action; when rich context is available
 * (e.g. status transitions), we emit a `secondary` line too.
 */

// Human verbs (past-tense, one word where possible) for each AuditAction.
// Action names match what the API actually writes — verified against the
// live audit_events table. Unmapped actions fall back to a lowercased
// underscore-split of the action name.
const VERB_BY_ACTION: Record<string, string> = {
  CONTRACT_CREATED:         'drafted',
  CONTRACT_UPDATED:         'edited',
  CONTRACT_UPLOADED:        'uploaded',
  CONTRACT_STATUS_CHANGED:  'changed status on',
  CONTRACT_DELETED:         'deleted',
  CONTRACT_RESTORED:        'restored',
  CONTRACT_ARCHIVED:        'archived',
  VERSION_CREATED:          'added a new version to',
  REQUEST_CREATED:          'submitted a request for',
  REQUEST_STATUS_CHANGED:   'updated',
  REQUEST_ASSIGNED:         'assigned',
  APPROVAL_SUBMITTED:       'requested approval on',
  APPROVAL_DECIDED:         'decided on',
  APPROVAL_ESCALATED:       'escalated approval on',
  APPROVAL_DELEGATED:       'delegated approval on',
  COMMENT_ADDED:            'commented on',
  COMMENT_RESOLVED:         'resolved a comment on',
  CLAUSE_CREATED:           'added a clause to',
  CLAUSE_UPDATED:           'edited a clause on',
  LINK_SHARED:              'shared',
  LINK_REVOKED:             'revoked share link for',
}

const ACTIONS_TO_HIDE = [
  // Viewing / auth — not meaningful in an activity feed.
  'USER_LOGIN',
  'USER_LOGOUT',
  'CONTRACT_VIEWED',
  'PORTAL_VIEWED',
  // Admin plumbing — has its own admin screen.
  'USER_CREATED',
  'USER_INVITED',
  'USER_DELETED',
  // Pipeline plumbing — the audit trail keeps them; the dashboard feed
  // exists to tell a user "what happened on my deals", not "what the
  // parser did."
  'CONTRACT_ANALYZED',
  'CONTRACT_PARSED',
  'CONTRACT_INDEXED',
]

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAuth }, async (req, reply) => {
    const { orgId, sub: userId } = req.user

    // X7 — this route is requireAuth-only, so resolve the scopes it must honour.
    // Unless the caller can view contracts (requests) beyond its own, it counts
    // and sees only the contracts it owns (the requests it raised).
    const [contractScope, requestScope] = await Promise.all([
      permissionScopeFor(req, 'view', 'contract'),
      permissionScopeFor(req, 'view', 'request'),
    ])
    const narrowContracts = !contractScope || contractScope === 'own'
    const narrowRequests = !requestScope || requestScope === 'own'
    const ownContracts = narrowContracts ? { ownerId: userId } : {}
    const ownRequests = narrowRequests ? { requestedById: userId } : {}

    // The feed takes the 40 newest events, so narrow it in the query — not
    // after — or a busy org pushes a rep's own activity out of the window.
    // Only these three resource types can be titled below; others drop anyway.
    let feedWhere: Record<string, unknown> = {}
    if (narrowContracts || narrowRequests) {
      const idsOf = (rows: Array<{ id: string }>) => ({ in: rows.map(r => r.id) })
      const [myContracts, myRequests, myApprovals] = await Promise.all([
        narrowContracts ? prisma.contract.findMany({ where: { orgId, ownerId: userId }, select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 5_000 }) : null,
        narrowRequests ? prisma.contractRequest.findMany({ where: { orgId, requestedById: userId }, select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 5_000 }) : null,
        narrowContracts ? prisma.approvalInstance.findMany({ where: { orgId, contract: { is: { ownerId: userId } } }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 5_000 }) : null,
      ])
      feedWhere = {
        OR: [
          { resourceType: 'contract', ...(myContracts ? { resourceId: idsOf(myContracts) } : {}) },
          { resourceType: 'contract_request', ...(myRequests ? { resourceId: idsOf(myRequests) } : {}) },
          { resourceType: 'approval_instance', ...(myApprovals ? { resourceId: idsOf(myApprovals) } : {}) },
        ],
      }
    }

    const now = new Date()
    // P7.1.1 — Renewal-window lookahead is the CLM industry standard
    // 90 days, not 30. The 30-day window was too tight: Cloudwave (47d
    // out) and Datadog (67d out) wouldn't show up, breaking Lisa's
    // procurement JTBD entirely (F-77 in docs/audit-2026-04-25.md).
    const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)

    const [
      activeContracts,
      openRequests,
      pendingApprovals,
      expiringSoon,
      // B.6.15 — "Your day" signals: all scoped to userId, not orgId.
      myRequestsWaiting,
      myExpiringSoon,
      myDraftsInProgress,
      // P7.2.3 — Org-wide approval count for admin oversight.
      orgPendingApprovals,
      // P7.1.1 — Per-persona surfaces that solve F-77 (Lisa: renewals),
      // F-78 (Maya: in-flight negotiations), F-79 (Daniel: deals in
      // motion). All three are "contracts I own that need attention".
      myInNegotiationContracts,
      myExpiringContracts,
      recentEvents,
    ] = await Promise.all([
      prisma.contract.count({
        where: { orgId, deletedAt: null, ...ownContracts, status: { in: ACTIVE_STATUSES } },
      }),
      prisma.contractRequest.count({
        where: { orgId, deletedAt: null, ...ownRequests, status: { in: OPEN_REQUEST_STATUSES } },
      }),
      // P7.2.3 — Per-user pending approvals: only steps assigned to me
      // AND only the currently-active step (sequential gating). Without
      // both filters the badge counts steps the user shouldn't see yet.
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM approval_steps s
        JOIN approval_instances i ON i.id = s."approvalInstanceId"
        WHERE s."orgId" = ${orgId}
          AND s."approverId" = ${userId}
          AND s.status = 'PENDING'
          AND s."stepOrder" = i."currentStepOrder"
      `.then(rows => Number(rows[0]?.count ?? 0)),
      prisma.contract.count({
        where: {
          orgId,
          deletedAt: null,
          ...ownContracts,
          expiryDate: { gte: now, lte: in90Days },
          // Only count active contracts — expired-EXECUTED in the
          // renewal window is the actionable signal; archived/cancelled
          // shouldn't count.
          status: { in: ACTIVE_STATUSES },
        },
      }),
      // Requests where the current user is the assignee and status is
      // still open. "N requests need your decision".
      prisma.contractRequest.count({
        where: {
          orgId,
          deletedAt: null,
          assignedToId: userId,
          status: { in: OPEN_REQUEST_STATUSES },
        },
      }),
      // Contracts owned by me that are expiring soon — more actionable
      // than the org-wide expiringSoon since I'm the owner.
      prisma.contract.count({
        where: {
          orgId,
          deletedAt: null,
          ownerId: userId,
          expiryDate: { gte: now, lte: in90Days },
          status: { in: ACTIVE_STATUSES },
        },
      }),
      // Drafts I'm actively working on (not failed / archived).
      prisma.contract.count({
        where: {
          orgId,
          deletedAt: null,
          ownerId: userId,
          status: 'DRAFT',
          analysisStatus: { not: 'FAILED' },
        },
      }),
      // P7.2.3 — Org-wide pending approval count. Surfaces to admin
      // and legal_ops in the KPI strip so they can spot "1 deal stuck
      // somewhere in the org" without joining each approval queue.
      // X21 — narrowed like the rest of the strip: an own-scope caller counts
      // the approvals on their own contracts only.
      prisma.approvalInstance.count({
        where: { orgId, ...(narrowContracts ? { contract: { is: { ownerId: userId, deletedAt: null } } } : {}), status: { in: ['PENDING', 'IN_PROGRESS', 'ESCALATED'] } },
      }),
      // P7.1.1 — Negotiations I own (Maya's primary JTBD). Returns full
      // rows (not just count) because the dashboard renders inline cards
      // for each — the count alone isn't actionable.
      prisma.contract.findMany({
        where: {
          orgId,
          deletedAt: null,
          ownerId: userId,
          status: { in: ['UNDER_NEGOTIATION', 'PENDING_REVIEW'] },
        },
        select: {
          id: true, title: true, type: true, status: true,
          counterpartyName: true, value: true, currency: true,
          riskScore: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 5,
      }),
      // P7.1.1 — Renewals I own (Lisa's primary JTBD). Full rows for
      // inline cards. Sorted by soonest-to-expire so the most urgent
      // contracts surface first.
      prisma.contract.findMany({
        where: {
          orgId,
          deletedAt: null,
          ownerId: userId,
          expiryDate: { gte: now, lte: in90Days },
          status: { in: ACTIVE_STATUSES },
        },
        select: {
          id: true, title: true, type: true, status: true,
          counterpartyName: true, value: true, currency: true,
          expiryDate: true,
        },
        orderBy: { expiryDate: 'asc' },
        take: 5,
      }),
      // Over-fetch so we can reasonably fill a 10-entry feed even after
      // the user-authored + entity-resolvable filters trim plumbing.
      prisma.auditEvent.findMany({
        where: {
          orgId,
          action: { notIn: ACTIONS_TO_HIDE },
          userId: { not: null },
          ...feedWhere,
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
    ])

    // --- Resolve actors ---
    const userIds = [...new Set(recentEvents.map((e) => e.userId).filter(Boolean))] as string[]
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : []
    const userMap = new Map(users.map((u) => [u.id, u.name]))

    // --- Resolve entity titles in batches so every row has a name to
    //     show. A single pass groups IDs by type.
    const byType = new Map<string, Set<string>>()
    for (const e of recentEvents) {
      if (!e.resourceType || !e.resourceId) continue
      const set = byType.get(e.resourceType) ?? new Set<string>()
      set.add(e.resourceId)
      byType.set(e.resourceType, set)
    }
    const titleMap = new Map<string, { title: string; status?: string; entityType: string }>()
    const entityKey = (t: string, id: string) => `${t}::${id}`

    const contractIds = [...(byType.get('contract') ?? [])]
    if (contractIds.length) {
      const rows = await prisma.contract.findMany({
        where: { id: { in: contractIds }, orgId, ...ownContracts },
        select: { id: true, title: true, status: true },
      })
      for (const r of rows) titleMap.set(entityKey('contract', r.id), {
        title: r.title ?? 'Untitled contract',
        status: r.status,
        entityType: 'contract',
      })
    }

    const requestIds = [...(byType.get('contract_request') ?? [])]
    if (requestIds.length) {
      const rows = await prisma.contractRequest.findMany({
        where: { id: { in: requestIds }, orgId, ...ownRequests },
        select: { id: true, title: true, status: true },
      })
      for (const r of rows) titleMap.set(entityKey('contract_request', r.id), {
        title: r.title ?? 'Untitled request',
        status: r.status,
        entityType: 'contract_request',
      })
    }

    const approvalIds = [...(byType.get('approval_instance') ?? [])]
    if (approvalIds.length) {
      const rows = await prisma.approvalInstance.findMany({
        where: { id: { in: approvalIds } },
        select: { id: true, contractId: true, status: true },
      })
      const approvalContractIds = rows.map((r) => r.contractId).filter(Boolean) as string[]
      const contracts = approvalContractIds.length
        ? await prisma.contract.findMany({
            where: { id: { in: approvalContractIds }, orgId, ...ownContracts },
            select: { id: true, title: true },
          })
        : []
      const cMap = new Map(contracts.map((c) => [c.id, c.title]))
      for (const r of rows) {
        // An approval on a contract the caller can't see stays out of the feed.
        if (narrowContracts && !(r.contractId && cMap.has(r.contractId))) continue
        titleMap.set(entityKey('approval_instance', r.id), {
          title: cMap.get(r.contractId) ?? 'Untitled contract',
          status: r.status,
          entityType: 'approval_instance',
        })
      }
    }

    // --- Humanise status codes for the "secondary" line ---
    const prettyStatus = (s?: unknown): string | undefined => {
      if (typeof s !== 'string') return undefined
      return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    }

    // --- Shape each event ---
    const shaped = recentEvents
      .map((e) => {
        if (!e.userId) return null // paranoia — we filtered at query level
        if (!e.resourceId || !e.resourceType) return null

        const entity = titleMap.get(entityKey(e.resourceType, e.resourceId))
        if (!entity) return null // entity deleted or unknown — hide

        const actorName = userMap.get(e.userId) ?? 'A teammate'
        const initials = actorName
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase() ?? '')
          .join('')
          || 'A'

        const verb = VERB_BY_ACTION[e.action] ?? e.action.replace(/_/g, ' ').toLowerCase()

        // Rich secondary context for specific actions
        let secondary: string | undefined
        const meta = (e.metadata ?? {}) as Record<string, unknown>
        if (e.action === 'CONTRACT_STATUS_CHANGED') {
          const from = prettyStatus(meta.from)
          const to = prettyStatus(meta.to)
          if (from && to) secondary = `${from} → ${to}`
        } else if (e.action === 'APPROVAL_DECIDED') {
          const decision = prettyStatus(meta.decision)
          if (decision) secondary = `Decision: ${decision}`
        } else if (e.action === 'VERSION_CREATED') {
          const v = meta.versionNumber
          if (typeof v === 'number') secondary = `v${v}`
        } else if (e.action === 'COMMENT_CREATED' && typeof meta.excerpt === 'string') {
          secondary = (meta.excerpt as string).slice(0, 100)
        }

        return {
          id: e.id,
          actorId: e.userId,
          actorName,
          actorInitials: initials,
          verb,
          entityType: entity.entityType,
          entityId: e.resourceId,
          entityTitle: entity.title,
          entityStatus: entity.status,
          secondary,
          createdAt: e.createdAt,
        }
      })
      .filter(Boolean)
      .slice(0, 10) // cap the feed at 10 entries

    // B.6.15 — "Your day" summary. The dashboard greets the user
    // with their own workload before the org-wide KPIs.
    //
    // P7.1.1 — Extended with `negotiationsInFlight` (F-78 fix for
    // Maya/Legal) and includes the count in `total` so the green
    // "all caught up" banner doesn't lie when there's actually work
    // to do (F-04 fix). The `negotiations[]` and `renewals[]` arrays
    // carry full row data so the dashboard can render inline cards.
    const yourDay = {
      approvalsWaiting:      pendingApprovals,
      requestsWaiting:       myRequestsWaiting,
      contractsExpiring:     myExpiringSoon,
      draftsInProgress:      myDraftsInProgress,
      negotiationsInFlight:  myInNegotiationContracts.length,
      total:
        pendingApprovals +
        myRequestsWaiting +
        myExpiringSoon +
        myInNegotiationContracts.length,
      // P7.1.1 — Inline cards for the dashboard "Your day" surface.
      // Persona-aware: Lisa sees renewals; Maya sees negotiations;
      // Marcus sees approvals (already in pendingApprovals).
      negotiations: myInNegotiationContracts.map(c => ({
        id: c.id,
        title: c.title,
        type: c.type,
        status: c.status,
        counterpartyName: c.counterpartyName,
        value: c.value ? Number(c.value) : null,
        currency: c.currency,
        riskScore: c.riskScore,
        daysSinceUpdate: Math.round((now.getTime() - c.updatedAt.getTime()) / (24 * 60 * 60 * 1000)),
      })),
      renewals: myExpiringContracts.map(c => ({
        id: c.id,
        title: c.title,
        type: c.type,
        status: c.status,
        counterpartyName: c.counterpartyName,
        value: c.value ? Number(c.value) : null,
        currency: c.currency,
        expiryDate: c.expiryDate?.toISOString() ?? null,
        daysToExpiry: c.expiryDate
          ? Math.round((c.expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
          : null,
      })),
    }

    return reply.send({
      activeContracts,
      openRequests,
      pendingApprovals,
      // P7.2.3 — Surface org-wide count for admin / legal-ops so the
      // KPI card can switch between "your queue" and "your org" views.
      orgPendingApprovals,
      expiringSoon,
      yourDay,
      recentActivity: shaped,
    })
  })
}
