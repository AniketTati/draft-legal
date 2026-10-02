/**
 * docs/41 Part 19 — loads what each analytics section needs, for one org and
 * one set of filters, and hands it to the pure metrics (analytics-metrics.ts).
 *
 * A section is a few parts (Speed is cycle time and template outcomes), each
 * part a few charts. A chart is addressed as `section.part.chart`, which is
 * what the drill-down takes to list a bar's contracts.
 *
 * The period means what each figure measures: executed in it (cycle time,
 * adherence), active in it (stages, turns, findings), asked for in it
 * (approvals, exceptions, AI suggestions), or a deadline passed in it
 * (missed renewals). Work waiting and renewals ahead are always as of now.
 */
import { AuditAction } from '@clm/types'
import { prisma } from './prisma.js'
import { needsMyAction } from './inbox.js'
import {
  cycleTime, timeInStage, workload, approvalTimes, negotiation, renewals, mostNegotiated, exceptions, templateUsage,
  adherence, aiAcceptance, moveOf, stageSpans, turnSpans, paperSource, originTemplate, DAY_MS,
  type Section, type Move, type PaperSource, type WaitingItem, type FindingRow,
} from './analytics-metrics.js'

export const SECTIONS = ['speed', 'bottlenecks', 'workload', 'negotiation', 'risk', 'renewals', 'ai'] as const
export type SectionName = (typeof SECTIONS)[number]

export interface AnalyticsFilters {
  from: Date
  to: Date
  type?: string
  ownerId?: string
  paperSource?: PaperSource
}

export interface AnalyticsContext {
  orgId: string
  userId: string
  /** The contracts the caller may see (own scope, never a diligence room's). */
  scope: { diligenceRoomId: null; ownerId?: string }
  /** Whether the caller sees the team's waiting work (configure:workflow, org scope). */
  canTeam: boolean
  now: Date
}

export type SectionParts = Record<string, Section>

/** Steps nobody decided: skipped by a rule, or cleared when the document changed. */
const NOT_DECIDED_BY_ANYONE = ['SKIPPED', 'RESET', 'AUTO_APPROVED']

const CHUNK = 1_000
const LIMIT = 5_000

async function chunked<T>(ids: string[], load: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...await load(ids.slice(i, i + CHUNK)))
  return out
}

const CONTRACT_SELECT = {
  id: true, type: true, ownerId: true, createdAt: true, updatedAt: true, executedAt: true, stage: true, turn: true, turnSince: true,
  turnOwnerId: true, counterpartyId: true, counterpartyName: true, currentVersionId: true, metadata: true, noticeDeadline: true, renewalType: true,
  owner: { select: { name: true, email: true } },
} as const

type ContractRow = Awaited<ReturnType<typeof loadContracts>>[number]

/** The contracts the filters allow, narrowed further by `where`; paper source is read from metadata. */
async function loadContracts(ctx: AnalyticsContext, f: AnalyticsFilters, where: Record<string, unknown>) {
  const rows = await prisma.contract.findMany({
    where: {
      orgId: ctx.orgId, deletedAt: null, ...ctx.scope,
      ...(f.type && { type: f.type }),
      ...(f.ownerId && !ctx.scope.ownerId && { ownerId: f.ownerId }),
      ...where,
    },
    select: CONTRACT_SELECT,
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
  })
  return f.paperSource ? rows.filter(c => paperSource(c.metadata) === f.paperSource) : rows
}

/** Active in the period: created by its end and touched since its start. */
const activeIn = (f: AnalyticsFilters) => ({ createdAt: { lte: f.to }, updatedAt: { gte: f.from } })

const ownerName = (c: ContractRow) => c.owner?.name || c.owner?.email || 'Unknown'

/** Each contract's moves, oldest first, from its stage events (the older status events included). */
async function movesOf(orgId: string, ids: string[]): Promise<Map<string, Move[]>> {
  const events = await chunked(ids, chunk => prisma.auditEvent.findMany({
    where: { orgId, resourceType: 'contract', resourceId: { in: chunk }, action: { in: [AuditAction.STAGE_CHANGED, AuditAction.CONTRACT_STATUS_CHANGED] } },
    select: { resourceId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  }))
  const by = new Map<string, Move[]>()
  for (const e of events) if (e.resourceId) by.set(e.resourceId, [...(by.get(e.resourceId) ?? []), moveOf({ at: e.createdAt, metadata: e.metadata })])
  return by
}

async function userNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const users = ids.length ? await prisma.user.findMany({ where: { orgId, id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } }) : []
  return new Map(users.map(u => [u.id, u.name || u.email]))
}

async function findingsOf(orgId: string, ids: string[]): Promise<FindingRow[]> {
  return chunked(ids, chunk => prisma.reviewFinding.findMany({
    where: { orgId, contractId: { in: chunk } },
    select: { contractId: true, versionId: true, key: true, kind: true, clauseType: true, severity: true, status: true, resolvedById: true },
  }))
}

// ── Sections ─────────────────────────────────────────────────────────────

/** Speed: cycle time of what was executed in the period, and how each template's contracts fare. */
async function speed(ctx: AnalyticsContext, f: AnalyticsFilters): Promise<SectionParts> {
  const [executed, drafted] = await Promise.all([
    loadContracts(ctx, f, { executedAt: { gte: f.from, lte: f.to } }),
    loadContracts(ctx, f, { createdAt: { gte: f.from, lte: f.to } }),
  ])
  const fromTemplate = drafted.map(c => ({ c, t: originTemplate(c.metadata) })).filter(x => x.t)
  const moves = await movesOf(ctx.orgId, fromTemplate.map(x => x.c.id))
  return {
    cycle: cycleTime(executed.filter(c => c.executedAt).map(c => ({
      id: c.id, type: c.type, ownerId: c.ownerId, ownerName: ownerName(c), createdAt: c.createdAt, executedAt: c.executedAt!, paper: paperSource(c.metadata),
    }))),
    templates: templateUsage(fromTemplate.map(({ c, t }) => ({
      id: c.id, templateId: t!.id, templateName: t!.name, createdAt: c.createdAt, executedAt: c.executedAt,
      turns: turnSpans(c, moves.get(c.id) ?? [], ctx.now).filter(s => s.key === 'counterparty').length,
    }))),
  }
}

/** Bottlenecks: time in each stage for contracts active in the period, and how long approvers take. */
async function bottlenecks(ctx: AnalyticsContext, f: AnalyticsFilters): Promise<SectionParts> {
  const cs = await loadContracts(ctx, f, activeIn(f))
  const moves = await movesOf(ctx.orgId, cs.map(c => c.id))
  const ids = new Set(cs.map(c => c.id))
  // Steps decided in the period or waiting now, then every step of their requests (a later step's clock starts at the one before it).
  const STEP_SELECT = { id: true, contractId: true, approvalInstanceId: true, kind: true, stepOrder: true, stepName: true, approverId: true, approverRoleId: true, delegatedToId: true, createdAt: true, decidedAt: true, status: true } as const
  const asked = (await prisma.approvalStep.findMany({
    where: { orgId: ctx.orgId, contractId: { in: [...ids] }, createdAt: { lte: f.to }, status: { notIn: NOT_DECIDED_BY_ANYONE }, OR: [{ decidedAt: null, status: { in: ['PENDING', 'ESCALATED'] } }, { decidedAt: { gte: f.from, lte: f.to } }] },
    select: STEP_SELECT, take: LIMIT,
  }))
  const askedIds = new Set(asked.map(s => s.id))
  const instanceIds = [...new Set(asked.map(s => s.approvalInstanceId).filter((x): x is string => !!x))]
  const siblings = instanceIds.length ? await prisma.approvalStep.findMany({ where: { orgId: ctx.orgId, approvalInstanceId: { in: instanceIds }, id: { notIn: [...askedIds] }, status: { notIn: NOT_DECIDED_BY_ANYONE } }, select: STEP_SELECT }) : []
  const live = instanceIds.length ? await prisma.approvalInstance.findMany({ where: { orgId: ctx.orgId, id: { in: instanceIds } }, select: { id: true, submittedAt: true, status: true, currentStepOrder: true } }) : []
  const inst = new Map(live.map(i => [i.id, i]))
  // A pending step waits on its approver only when its request is open and has reached it.
  const waitingNow = (s: typeof asked[number]) => !s.approvalInstanceId || (['PENDING', 'IN_PROGRESS', 'ESCALATED'].includes(inst.get(s.approvalInstanceId)?.status ?? '') && inst.get(s.approvalInstanceId)?.currentStepOrder === s.stepOrder)
  const steps = [...asked.filter(s => s.decidedAt || waitingNow(s)), ...siblings]
  const [names, roles] = await Promise.all([
    userNames(ctx.orgId, steps.flatMap(s => [s.approverId, s.delegatedToId]).filter((x): x is string => !!x)),
    prisma.role.findMany({ where: { orgId: ctx.orgId, id: { in: steps.map(s => s.approverRoleId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ])
  const roleName = new Map(roles.map(r => [r.id, r.name]))
  const approver = (s: typeof steps[number]) => {
    const u = s.delegatedToId ?? s.approverId
    if (u) return { key: u, label: names.get(u) ?? 'Unknown' }
    if (s.approverRoleId) return { key: `role:${s.approverRoleId}`, label: `${roleName.get(s.approverRoleId) ?? 'A role'} (anyone)` }
    return { key: 'unassigned', label: 'Unassigned' }
  }
  return {
    stages: timeInStage(cs.map(c => ({ contractId: c.id, spans: stageSpans(c, moves.get(c.id) ?? [], ctx.now) }))),
    approvals: approvalTimes(steps.map(s => {
      const a = approver(s)
      return {
        id: s.id, contractId: s.contractId!, instanceId: s.approvalInstanceId, kind: s.kind, stepOrder: s.stepOrder,
        stepName: s.kind === 'clause_exception' ? 'Clause exception' : s.stepName, approverKey: a.key, approverLabel: a.label, createdAt: s.createdAt, decidedAt: s.decidedAt,
      }
    }), new Map(live.map(i => [i.id, i.submittedAt])), ctx.now, s => askedIds.has(s.id)),
  }
}

const IN_FLIGHT = ['request', 'draft', 'negotiate', 'approve', 'sign']
const TURN_HOLDER: Record<string, string> = { counterparty: 'Counterparty', approvers: 'Approvers', signers: 'Signers' }

/**
 * Workload, as of now: what waits on me (the inbox's Needs my action, aged
 * from when each action began), and for Legal Ops the team's work in flight
 * by who holds it — its owner on our turn, else the counterparty, the
 * approvers or the signers — aged from when the turn began.
 */
async function workloadSection(ctx: AnalyticsContext, f: AnalyticsFilters): Promise<SectionParts> {
  const mineRows = await needsMyAction(ctx.orgId, ctx.userId)
  const allowed = new Set((await loadContracts(ctx, f, { id: { in: mineRows.map(r => r.contractId) } })).map(c => c.id))
  const mine: WaitingItem[] = mineRows.filter(r => allowed.has(r.contractId)).map(r => ({
    contractId: r.contractId, holderKey: r.primary?.kind ?? 'other', holderLabel: r.primary?.label ?? 'Other', since: new Date(r.primary?.since ?? r.turnSince),
  }))
  const parts: SectionParts = { mine: workload(mine, ctx.now) }
  if (ctx.canTeam) {
    const cs = await loadContracts(ctx, f, { stage: { in: IN_FLIGHT } })
    const names = await userNames(ctx.orgId, cs.map(c => c.turnOwnerId ?? c.ownerId))
    parts.team = workload(cs.map(c => {
      const person = c.turnOwnerId ?? c.ownerId
      return c.turn in TURN_HOLDER
        ? { contractId: c.id, holderKey: c.turn, holderLabel: TURN_HOLDER[c.turn], since: c.turnSince }
        : { contractId: c.id, holderKey: person, holderLabel: names.get(person) ?? ownerName(c), since: c.turnSince }
    }), ctx.now)
  }
  return parts
}

/** Negotiation: counterparty turnaround and turns for contracts active in the period, and the clauses pushed back on most. */
async function negotiationSection(ctx: AnalyticsContext, f: AnalyticsFilters): Promise<SectionParts> {
  const cs = await loadContracts(ctx, f, activeIn(f))
  const ids = cs.map(c => c.id)
  const [moves, findings] = await Promise.all([movesOf(ctx.orgId, ids), findingsOf(ctx.orgId, ids)])
  return {
    turns: negotiation(cs.map(c => ({
      contractId: c.id, counterpartyKey: c.counterpartyId ?? c.counterpartyName ?? 'unknown', counterpartyLabel: c.counterpartyName ?? 'Unknown counterparty',
      spans: turnSpans(c, moves.get(c.id) ?? [], ctx.now),
    }))),
    clauses: mostNegotiated(findings),
  }
}

/** Risk: adherence at signature for what was executed in the period, and exceptions asked for in it. */
async function risk(ctx: AnalyticsContext, f: AnalyticsFilters): Promise<SectionParts> {
  const [executed, active] = await Promise.all([
    loadContracts(ctx, f, { executedAt: { gte: f.from, lte: f.to } }),
    loadContracts(ctx, f, activeIn(f)),
  ])
  const allowed = new Set(active.map(c => c.id))
  const [findings, steps] = await Promise.all([
    findingsOf(ctx.orgId, executed.map(c => c.id)),
    prisma.approvalStep.findMany({
      where: { orgId: ctx.orgId, kind: 'clause_exception', createdAt: { gte: f.from, lte: f.to }, contractId: { in: [...allowed] } },
      select: { contractId: true, clauseType: true, approverId: true, delegatedToId: true, status: true, decision: true },
      take: LIMIT,
    }),
  ])
  const names = await userNames(ctx.orgId, steps.map(s => s.delegatedToId ?? s.approverId).filter((x): x is string => !!x))
  return {
    adherence: adherence(executed.map(c => ({ id: c.id, versionId: c.currentVersionId })), findings),
    exceptions: exceptions(steps.map(s => {
      const who = s.delegatedToId ?? s.approverId
      return { contractId: s.contractId!, clauseType: s.clauseType, approverKey: who ?? 'unassigned', approverLabel: who ? names.get(who) ?? 'Unknown' : 'Unassigned', status: s.status, decision: s.decision }
    })),
  }
}

/** Renewals: undecided notice deadlines in the next 90 days, and the ones that passed in the period. */
async function renewalsSection(ctx: AnalyticsContext, f: AnalyticsFilters): Promise<SectionParts> {
  const horizon = new Date(ctx.now.getTime() + 91 * DAY_MS)
  const cs = await loadContracts(ctx, f, { noticeDeadline: { gte: f.from, lte: horizon } })
  const decisions = await chunked(cs.map(c => c.id), chunk => prisma.renewalDecision.findMany({
    where: { orgId: ctx.orgId, contractId: { in: chunk } },
    select: { contractId: true, createdAt: true, noticeSentAt: true, supersededAt: true, decidedInTime: true, noticeSentInTime: true },
  }))
  return { renewals: renewals(cs, decisions, ctx.now, f.from) }
}

/**
 * AI acceptance by feature, from the suggestion events the editor records
 * (shown, accepted, edited, dismissed). Grouped by contract too, so each bar
 * can list the contracts behind it.
 */
async function ai(ctx: AnalyticsContext, f: AnalyticsFilters): Promise<SectionParts> {
  const restrict = !!(ctx.scope.ownerId || f.type || f.ownerId || f.paperSource)
  const allowed = restrict ? (await loadContracts(ctx, f, {})).map(c => c.id) : null
  const groups = await prisma.aiSuggestionEvent.groupBy({
    by: ['feature', 'outcome', 'contractId'],
    where: { orgId: ctx.orgId, at: { gte: f.from, lte: f.to }, ...(allowed ? { contractId: { in: allowed } } : {}) },
    _count: { _all: true },
  })
  const section = aiAcceptance(groups.map(g => ({ feature: g.feature, outcome: g.outcome, n: g._count._all, contractIds: [g.contractId] })))
  return { acceptance: { ...section, available: true } }
}

const LOADERS: Record<SectionName, (ctx: AnalyticsContext, f: AnalyticsFilters) => Promise<SectionParts>> = {
  speed, bottlenecks, workload: workloadSection, negotiation: negotiationSection, risk, renewals: renewalsSection, ai,
}

export const loadSection = (name: SectionName, ctx: AnalyticsContext, f: AnalyticsFilters) => LOADERS[name](ctx, f)

/** A section's parts as one, for the CSV: headline figures and charts named `part.chart`. */
export function flatten(parts: SectionParts): Section {
  return {
    headline: Object.fromEntries(Object.entries(parts).flatMap(([p, s]) => Object.entries(s.headline).map(([k, v]) => [`${p}.${k}`, v]))),
    charts: Object.fromEntries(Object.entries(parts).flatMap(([p, s]) => Object.entries(s.charts).map(([k, v]) => [`${p}.${k}`, v]))),
  }
}

/** The contracts behind one bar: `metric` is `section.part.chart`, `key` the bar's key. Null when no such chart. */
export async function drilldown(metric: string, key: string, ctx: AnalyticsContext, f: AnalyticsFilters): Promise<{ label: string; ids: string[] } | null> {
  const [section, part, chart] = metric.split('.')
  if (!(SECTIONS as readonly string[]).includes(section) || !part || !chart) return null
  const parts = await loadSection(section as SectionName, ctx, f)
  const bars = parts[part]?.charts[chart]
  if (!bars) return null
  const bar = bars.find(b => b.key === key)
  return { label: bar?.label ?? key, ids: bar?.ids ?? [] }
}
