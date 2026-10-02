/**
 * docs/41 Part 19 — analytics organised by the decision each figure helps
 * make. Pure functions over rows the route loads (contracts, stage events,
 * approval steps, findings, renewal decisions), so each metric is tested
 * with fixtures and the route only loads and filters.
 *
 * Every chart is a list of bars, and every bar keeps the contracts behind
 * it (`ids`), so a bar opens its contracts and a CSV lists what is on screen.
 * Durations are in days.
 */
import { STAGE_LABEL, TURN_LABEL, stageForStatus, isStage, type Stage, type Turn } from '@clm/types'

export const DAY_MS = 86_400_000

export interface Bar {
  key: string
  label: string
  /** The figure the bar shows (a median in days, a count or a rate 0..1). */
  value: number | null
  /** How many contracts or items stand behind it. */
  n: number
  ids: string[]
  /** More figures for the tooltip and the CSV (p90, counts by outcome). */
  extra?: Record<string, number | string | null>
}

/** A section's answer: a few headline figures, and its charts by name. */
export interface Section {
  headline: Record<string, number | string | null>
  charts: Record<string, Bar[]>
  /** False when the data it needs is not recorded here yet. */
  available?: boolean
}

const round1 = (x: number) => Math.round(x * 10) / 10
const days = (ms: number) => ms / DAY_MS
const uniq = (xs: string[]) => [...new Set(xs)]

/** The p-th percentile (0..100), linear between ranks. Null for no values. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const r = (p / 100) * (s.length - 1)
  const lo = Math.floor(r), hi = Math.ceil(r)
  return s[lo] + (s[hi] - s[lo]) * (r - lo)
}
export const median = (xs: number[]) => percentile(xs, 50)

export interface Stats { n: number; medianDays: number | null; p90Days: number | null }
export function stats(xs: number[]): Stats {
  const m = median(xs), p = percentile(xs, 90)
  return { n: xs.length, medianDays: m == null ? null : round1(m), p90Days: p == null ? null : round1(p) }
}

/** Group items into bars of their median duration, largest median first. */
function durationBars<T>(items: T[], keyOf: (t: T) => { key: string; label: string } | null, daysOf: (t: T) => number, idOf: (t: T) => string): Bar[] {
  const groups = new Map<string, { label: string; xs: number[]; ids: string[] }>()
  for (const t of items) {
    const k = keyOf(t)
    if (!k) continue
    const g = groups.get(k.key) ?? { label: k.label, xs: [], ids: [] }
    g.xs.push(daysOf(t)); g.ids.push(idOf(t))
    groups.set(k.key, g)
  }
  return [...groups.entries()].map(([key, g]) => {
    const s = stats(g.xs)
    return { key, label: g.label, value: s.medianDays, n: g.xs.length, ids: uniq(g.ids), extra: { p90Days: s.p90Days } }
  }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
}

// ── Paper source and template ────────────────────────────────────────────

export type PaperSource = 'ours' | 'theirs'
export const PAPER_LABEL: Record<PaperSource, string> = { ours: 'Our paper', theirs: 'Their paper or uploaded' }

/** The template a contract was drafted from: `_origin` (docs/41), else `_template` (docs/39). */
export function originTemplate(metadata: unknown): { id: string; name: string } | null {
  const m = (metadata ?? {}) as { _origin?: { templateId?: unknown; templateName?: unknown }; _template?: { id?: unknown; name?: unknown } }
  if (typeof m._origin?.templateId === 'string') return { id: m._origin.templateId, name: typeof m._origin.templateName === 'string' ? m._origin.templateName : 'Template' }
  if (typeof m._template?.id === 'string') return { id: m._template.id, name: typeof m._template.name === 'string' ? m._template.name : 'Template' }
  return null
}

/** Our paper when drafted from one of our templates; otherwise theirs or uploaded. */
export const paperSource = (metadata: unknown): PaperSource => originTemplate(metadata) ? 'ours' : 'theirs'

// ── Timelines from stage events ──────────────────────────────────────────

export interface StageEvent { at: Date; metadata: unknown }
export interface Move { at: Date; fromStage: Stage | null; toStage: Stage | null; fromTurn: Turn | null; toTurn: Turn | null; created: boolean }

const asStage = (s: unknown): Stage | null => isStage(s) ? s : null
const asTurn = (t: unknown): Turn | null => typeof t === 'string' && t in TURN_LABEL ? t as Turn : null

/** One event as a move. Older CONTRACT_STATUS_CHANGED events carry statuses only; their stage is derived and they say nothing of the turn. */
export function moveOf(e: StageEvent): Move {
  const m = (e.metadata ?? {}) as Record<string, unknown>
  const fromStage = asStage(m.fromStage) ?? (typeof m.from === 'string' ? stageForStatus(m.from).stage : null)
  const toStage = asStage(m.toStage) ?? (typeof m.to === 'string' ? stageForStatus(m.to).stage : null)
  return { at: e.at, fromStage, toStage, fromTurn: asTurn(m.fromTurn), toTurn: asTurn(m.toTurn), created: m.created === true || (m.from === null && m.to != null) }
}

export interface Interval<K> { key: K; start: Date; end: Date; open: boolean }

/**
 * The spans a contract spent in each value of one dimension (stage or turn),
 * oldest first. It starts at creation in the first move's `from` (or in the
 * creation event's `to`); a move to the value it already had is not a new
 * span; the last span runs to now and is marked open.
 */
function spans<K>(createdAt: Date, moves: Move[], pick: (m: Move) => { from: K | null; to: K | null }, current: K | null, now: Date): Interval<K>[] {
  const ms = [...moves].sort((a, b) => a.at.getTime() - b.at.getTime())
  const out: Interval<K>[] = []
  let key: K | null = null
  let start = createdAt
  for (const m of ms) {
    const { from, to } = pick(m)
    if (to == null) continue
    if (key == null) {
      // The first move tells where it began: its `from`, or its own `to` when it records the creation.
      if (m.created || from == null) { key = to; start = m.at < createdAt ? m.at : createdAt; continue }
      key = from
    }
    if (to === key) continue
    out.push({ key, start, end: m.at, open: false })
    key = to; start = m.at
  }
  if (key == null) key = current
  if (key != null) out.push({ key, start, end: now, open: true })
  return out.filter(i => i.end.getTime() >= i.start.getTime())
}

export function stageSpans(c: { createdAt: Date; stage: string }, moves: Move[], now: Date): Interval<Stage>[] {
  return spans<Stage>(c.createdAt, moves, m => ({ from: m.fromStage, to: m.toStage }), asStage(c.stage), now)
}

/** Turn spans, from the moves that recorded a turn (the older status events did not). */
export function turnSpans(c: { createdAt: Date; turn: string }, moves: Move[], now: Date): Interval<Turn>[] {
  return spans<Turn>(c.createdAt, moves.filter(m => m.toTurn != null), m => ({ from: m.fromTurn, to: m.toTurn }), asTurn(c.turn), now)
}

export const durationDays = (i: { start: Date; end: Date }) => days(i.end.getTime() - i.start.getTime())

// ── Speed: cycle time, request to executed ───────────────────────────────

export interface CycleContract {
  id: string; type: string; ownerId: string; ownerName: string
  createdAt: Date; executedAt: Date; paper: PaperSource
}

/** Created (the request) to executed, overall and by type, paper and owner. */
export function cycleTime(cs: CycleContract[]): Section {
  const d = (c: CycleContract) => Math.max(0, days(c.executedAt.getTime() - c.createdAt.getTime()))
  const all = stats(cs.map(d))
  return {
    headline: { executed: all.n, medianDays: all.medianDays, p90Days: all.p90Days },
    charts: {
      byType: durationBars(cs, c => ({ key: c.type, label: c.type }), d, c => c.id),
      byPaper: durationBars(cs, c => ({ key: c.paper, label: PAPER_LABEL[c.paper] }), d, c => c.id),
      byOwner: durationBars(cs, c => ({ key: c.ownerId, label: c.ownerName }), d, c => c.id),
    },
  }
}

// ── Bottlenecks: time in stage ───────────────────────────────────────────

/** The stages work moves through; Active and Closed are where it ends, not where it waits. */
export const PROCESS_STAGES: Stage[] = ['request', 'draft', 'negotiate', 'approve', 'sign']

/**
 * Days per visit to each stage. A finished visit counts its length; a
 * contract in the stage now counts the time so far, so a stage that holds
 * work shows up before the work leaves it. The bottleneck is the stage with
 * the largest median.
 */
export function timeInStage(timelines: Array<{ contractId: string; spans: Interval<Stage>[] }>): Section {
  const visits = timelines.flatMap(t => t.spans.filter(s => PROCESS_STAGES.includes(s.key)).map(s => ({ ...s, contractId: t.contractId })))
  const bars: Bar[] = PROCESS_STAGES.map(stage => {
    const vs = visits.filter(v => v.key === stage)
    const s = stats(vs.map(durationDays))
    const open = vs.filter(v => v.open)
    return {
      key: stage, label: STAGE_LABEL[stage], value: s.medianDays, n: vs.length, ids: uniq(vs.map(v => v.contractId)),
      extra: { p90Days: s.p90Days, inStageNow: open.length, totalDays: round1(vs.reduce((t, v) => t + durationDays(v), 0)) },
    }
  })
  const ranked = bars.filter(b => b.value != null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  return {
    headline: { bottleneck: ranked[0]?.key ?? null, bottleneckLabel: ranked[0]?.label ?? null, bottleneckMedianDays: ranked[0]?.value ?? null },
    charts: { byStage: bars },
  }
}

// ── Workload: what waits, and for how long ───────────────────────────────

export const AGE_BUCKETS = [
  { key: '0-2', label: 'Under 3 days', max: 3 },
  { key: '3-7', label: '3 to 7 days', max: 8 },
  { key: '8-14', label: '8 to 14 days', max: 15 },
  { key: '15-30', label: '15 to 30 days', max: 31 },
  { key: '30+', label: 'Over 30 days', max: Infinity },
] as const

export interface WaitingItem { contractId: string; holderKey: string; holderLabel: string; since: Date }

/** Open items by age, and by who holds them (oldest median first). */
export function workload(items: WaitingItem[], now: Date): Section {
  const age = (i: WaitingItem) => Math.max(0, days(now.getTime() - i.since.getTime()))
  const byAge: Bar[] = AGE_BUCKETS.map((b, ix) => {
    const lo = ix === 0 ? 0 : AGE_BUCKETS[ix - 1].max
    const xs = items.filter(i => age(i) >= lo && age(i) < b.max)
    return { key: b.key, label: b.label, value: xs.length, n: xs.length, ids: uniq(xs.map(i => i.contractId)) }
  })
  const byHolder = durationBars(items, i => ({ key: i.holderKey, label: i.holderLabel }), age, i => i.contractId)
    .map(b => ({ ...b, extra: { ...b.extra, waiting: b.n } }))
  const ages = items.map(age)
  return {
    headline: { waiting: items.length, over14Days: ages.filter(a => a >= 15).length, oldestDays: ages.length ? round1(Math.max(...ages)) : null },
    charts: { byAge, byHolder },
  }
}

// ── Approval time per approver and step ──────────────────────────────────

export interface ApprovalStepRow {
  id: string; contractId: string; instanceId: string | null; kind: string
  stepOrder: number; stepName: string; approverKey: string; approverLabel: string
  createdAt: Date; decidedAt: Date | null
}

/**
 * When a step became someone's to decide: the request's submission for the
 * first step, the last decision of the step before it for a later one, its
 * own creation for an exception request (or a step added later).
 */
export function activeSince(step: ApprovalStepRow, siblings: ApprovalStepRow[], submittedAt: Date | null): Date {
  const base = submittedAt && step.kind !== 'clause_exception' ? submittedAt : step.createdAt
  const before = siblings.filter(s => s.stepOrder < step.stepOrder && s.decidedAt).map(s => s.decidedAt!.getTime())
  return new Date(Math.max(base.getTime(), step.createdAt.getTime(), ...before))
}

/** Decided steps' time to decide, by approver and by step name; steps still waiting are counted. */
export function approvalTimes(steps: ApprovalStepRow[], submittedAt: Map<string, Date>, now: Date, measure: (s: ApprovalStepRow) => boolean = () => true): Section {
  const byInstance = new Map<string, ApprovalStepRow[]>()
  for (const s of steps) if (s.instanceId) byInstance.set(s.instanceId, [...(byInstance.get(s.instanceId) ?? []), s])
  // Every step of a request is needed to know when a later one became active; only the ones asked about are measured.
  const timed = steps.filter(measure).map(s => {
    const since = activeSince(s, s.instanceId ? byInstance.get(s.instanceId)! : [], s.instanceId ? submittedAt.get(s.instanceId) ?? null : null)
    return { ...s, since, d: Math.max(0, days((s.decidedAt ?? now).getTime() - since.getTime())) }
  })
  const decided = timed.filter(s => s.decidedAt)
  const waiting = timed.filter(s => !s.decidedAt)
  const all = stats(decided.map(s => s.d))
  const withWaiting = (bars: Bar[], keyOf: (s: typeof timed[number]) => string) => bars.map(b => ({ ...b, extra: { ...b.extra, waitingNow: waiting.filter(w => keyOf(w) === b.key).length } }))
  return {
    headline: { decided: all.n, medianDays: all.medianDays, p90Days: all.p90Days, waitingNow: waiting.length },
    charts: {
      byApprover: withWaiting(durationBars(decided, s => ({ key: s.approverKey, label: s.approverLabel }), s => s.d, s => s.contractId), s => s.approverKey),
      byStep: withWaiting(durationBars(decided, s => ({ key: s.stepName, label: s.stepName }), s => s.d, s => s.contractId), s => s.stepName),
    },
  }
}

// ── Negotiation: counterparty turnaround and turns ───────────────────────

export interface TurnTimeline { contractId: string; counterpartyKey: string; counterpartyLabel: string; spans: Interval<Turn>[] }

/**
 * How long the counterparty keeps a draft (each finished turn with them),
 * how many times it went to them per contract, and who keeps it longest.
 * A turn still with them counts as waiting now, not as a turnaround.
 */
export function negotiation(timelines: TurnTimeline[]): Section {
  const turns = timelines.flatMap(t => t.spans.filter(s => s.key === 'counterparty').map(s => ({ ...s, contractId: t.contractId, cpKey: t.counterpartyKey, cpLabel: t.counterpartyLabel })))
  const done = turns.filter(t => !t.open)
  const withThemNow = turns.filter(t => t.open)
  const rounds = timelines.map(t => ({ contractId: t.contractId, n: t.spans.filter(s => s.key === 'counterparty').length })).filter(r => r.n > 0)
  const turnaround = stats(done.map(durationDays))
  const roundBuckets = [1, 2, 3, 4].map(k => {
    const xs = rounds.filter(r => (k === 4 ? r.n >= 4 : r.n === k))
    return { key: String(k), label: k === 4 ? '4 or more' : k === 1 ? '1 turn' : `${k} turns`, value: xs.length, n: xs.length, ids: xs.map(r => r.contractId) }
  })
  return {
    headline: {
      turnaroundMedianDays: turnaround.medianDays, turnaroundP90Days: turnaround.p90Days, turnsReturned: turnaround.n,
      withCounterpartyNow: withThemNow.length, medianTurnsPerContract: median(rounds.map(r => r.n)),
    },
    charts: {
      byCounterparty: durationBars(done, t => ({ key: t.cpKey, label: t.cpLabel }), durationDays, t => t.contractId).slice(0, 15),
      turnsPerContract: roundBuckets,
    },
  }
}

// ── Renewals: upcoming and missed notice deadlines ───────────────────────

export interface RenewalContract { id: string; noticeDeadline: Date | null; renewalType: string | null }
export interface RenewalDecisionRow { contractId: string; createdAt: Date; noticeSentAt: Date | null; supersededAt: Date | null; decidedInTime: boolean | null; noticeSentInTime: boolean | null }

export const RENEWAL_WINDOWS = [
  { key: '0-30', label: 'Next 30 days', max: 31 },
  { key: '31-60', label: '31 to 60 days', max: 61 },
  { key: '61-90', label: '61 to 90 days', max: 91 },
] as const

/**
 * Upcoming: notice deadlines in the next 90 days with no decision yet.
 * Missed: a deadline that passed (within the period asked) with neither a
 * decision made by it nor a notice sent by it.
 */
export function renewals(cs: RenewalContract[], decisions: RenewalDecisionRow[], now: Date, missedSince: Date): Section {
  const live = new Map<string, RenewalDecisionRow[]>()
  for (const d of decisions) if (!d.supersededAt) live.set(d.contractId, [...(live.get(d.contractId) ?? []), d])
  const withDeadline = cs.filter(c => c.noticeDeadline)
  const daysLeft = (c: RenewalContract) => days(c.noticeDeadline!.getTime() - now.getTime())
  const undecided = withDeadline.filter(c => !(live.get(c.id)?.length))
  const upcoming: Bar[] = RENEWAL_WINDOWS.map((w, ix) => {
    const lo = ix === 0 ? 0 : RENEWAL_WINDOWS[ix - 1].max
    const xs = undecided.filter(c => daysLeft(c) >= lo && daysLeft(c) < w.max)
    return { key: w.key, label: w.label, value: xs.length, n: xs.length, ids: xs.map(c => c.id) }
  })
  const inTime = (c: RenewalContract) => (live.get(c.id) ?? []).some(d =>
    d.decidedInTime === true || d.noticeSentInTime === true
    || (d.decidedInTime == null && d.createdAt <= c.noticeDeadline!)
    || (d.noticeSentInTime == null && d.noticeSentAt != null && d.noticeSentAt <= c.noticeDeadline!))
  const passed = withDeadline.filter(c => c.noticeDeadline! < now && c.noticeDeadline! >= missedSince)
  const missed = passed.filter(c => !inTime(c))
  const missedAuto = missed.filter(c => c.renewalType === 'auto' || c.renewalType === 'evergreen')
  return {
    headline: { upcoming: upcoming.reduce((t, b) => t + b.n, 0), deadlinesPassed: passed.length, missed: missed.length, missedAutoRenewing: missedAuto.length },
    charts: {
      upcoming,
      outcome: [
        { key: 'in_time', label: 'Decided in time', value: passed.length - missed.length, n: passed.length - missed.length, ids: passed.filter(inTime).map(c => c.id) },
        { key: 'missed', label: 'Missed', value: missed.length, n: missed.length, ids: missed.map(c => c.id) },
      ],
    },
  }
}

// ── Negotiation: the clauses pushed back on most ─────────────────────────

export interface FindingRow {
  contractId: string; versionId: string; key: string; kind: string; clauseType: string | null
  severity: string; status: string; resolvedById: string | null
}

/** Kinds where the other side's words differ from our position. */
export const DEVIATION_KINDS = new Set(['modified', 'position_not_met', 'material_cut', 'deleted', 'needs_approval_position', 'not_allowed_present'])

/**
 * How a deviation was settled: countered (a person redlined it back, which
 * resolves it), an exception asked for, or accepted as it stands. One that
 * matched a position on its own (resolved by nobody) was not negotiated.
 */
export function outcomeOf(f: FindingRow): 'countered' | 'exception' | 'accepted' | null {
  if (f.status.startsWith('exception_')) return 'exception'
  if (f.status === 'accepted') return 'accepted'
  if (f.status === 'resolved' && f.resolvedById) return 'countered'
  return null
}

/**
 * Per clause type: the contracts where it was negotiated, as a share of the
 * reviewed contracts that have the clause flagged at all, and how it was
 * settled. A finding repeats across versions; each contract counts once.
 */
export function mostNegotiated(findings: FindingRow[]): Section {
  const by = new Map<string, { flagged: Set<string>; negotiated: Set<string>; countered: Set<string>; exception: Set<string>; accepted: Set<string> }>()
  for (const f of findings) {
    if (!f.clauseType || !DEVIATION_KINDS.has(f.kind)) continue
    const g = by.get(f.clauseType) ?? { flagged: new Set(), negotiated: new Set(), countered: new Set(), exception: new Set(), accepted: new Set() }
    g.flagged.add(f.contractId)
    const o = outcomeOf(f)
    if (o) { g.negotiated.add(f.contractId); g[o].add(f.contractId) }
    by.set(f.clauseType, g)
  }
  const reviewed = new Set(findings.map(f => f.contractId)).size
  const bars: Bar[] = [...by.entries()].filter(([, g]) => g.negotiated.size > 0).map(([ct, g]) => ({
    key: ct, label: clauseLabel(ct), value: g.negotiated.size, n: g.negotiated.size, ids: [...g.negotiated],
    extra: {
      deviationRate: reviewed ? round1((g.flagged.size / reviewed) * 100) / 100 : null,
      flagged: g.flagged.size, countered: g.countered.size, exception: g.exception.size, accepted: g.accepted.size,
    },
  })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 15)
  return { headline: { reviewedContracts: reviewed, clauseTypes: bars.length, top: bars[0]?.label ?? null }, charts: { byClause: bars } }
}

/** "limitation_of_liability" → "Limitation of liability". */
export function clauseLabel(t: string): string {
  const w = t.replace(/[_-]+/g, ' ').trim()
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : t
}

// ── Risk: exceptions granted ─────────────────────────────────────────────

export interface ExceptionStepRow { contractId: string; clauseType: string | null; approverKey: string; approverLabel: string; status: string; decision: string | null }

const exceptionOutcome = (s: ExceptionStepRow) => s.decision === 'APPROVED' ? 'approved' : s.decision ? 'declined' : 'pending'

/** Exception requests by clause and by the approver who decided them, with how they ended. */
export function exceptions(steps: ExceptionStepRow[]): Section {
  const group = (keyOf: (s: ExceptionStepRow) => { key: string; label: string } | null, only = (_: ExceptionStepRow) => true) => {
    const m = new Map<string, { label: string; rows: ExceptionStepRow[] }>()
    for (const s of steps.filter(only)) { const k = keyOf(s); if (!k) continue; const g = m.get(k.key) ?? { label: k.label, rows: [] }; g.rows.push(s); m.set(k.key, g) }
    return [...m.entries()].map(([key, g]) => {
      const c = { approved: 0, declined: 0, pending: 0 }
      for (const r of g.rows) c[exceptionOutcome(r)]++
      const decided = c.approved + c.declined
      return { key, label: g.label, value: c.approved, n: g.rows.length, ids: uniq(g.rows.map(r => r.contractId)), extra: { ...c, grantRate: decided ? Math.round((c.approved / decided) * 100) / 100 : null } }
    }).sort((a, b) => b.n - a.n)
  }
  const granted = steps.filter(s => exceptionOutcome(s) === 'approved').length
  const decided = steps.filter(s => exceptionOutcome(s) !== 'pending').length
  return {
    headline: { requested: steps.length, granted, declined: decided - granted, grantRate: decided ? Math.round((granted / decided) * 100) / 100 : null },
    charts: {
      byClause: group(s => ({ key: s.clauseType ?? 'other', label: s.clauseType ? clauseLabel(s.clauseType) : 'Other' })),
      byApprover: group(s => ({ key: s.approverKey, label: s.approverLabel }), s => exceptionOutcome(s) !== 'pending'),
    },
  }
}

// ── Templates: usage against cycle time and turns ────────────────────────

export interface TemplateContract { id: string; templateId: string; templateName: string; createdAt: Date; executedAt: Date | null; turns: number }

/** Per template: contracts drafted from it, the median cycle of those executed, and the median turns with the counterparty. */
export function templateUsage(cs: TemplateContract[]): Section {
  const m = new Map<string, { label: string; rows: TemplateContract[] }>()
  for (const c of cs) { const g = m.get(c.templateId) ?? { label: c.templateName, rows: [] }; g.rows.push(c); m.set(c.templateId, g) }
  const bars: Bar[] = [...m.entries()].map(([key, g]) => {
    const executed = g.rows.filter(r => r.executedAt)
    const cycle = stats(executed.map(r => Math.max(0, days(r.executedAt!.getTime() - r.createdAt.getTime()))))
    const turns = median(g.rows.map(r => r.turns))
    return { key, label: g.label, value: g.rows.length, n: g.rows.length, ids: g.rows.map(r => r.id), extra: { executed: executed.length, medianCycleDays: cycle.medianDays, medianTurns: turns == null ? null : round1(turns) } }
  }).sort((a, b) => b.n - a.n)
  return { headline: { templates: bars.length, drafted: cs.length }, charts: { byTemplate: bars } }
}

// ── Risk: playbook adherence at signature ────────────────────────────────

/** Still open at signature: not settled one way or another. */
const OPEN_AT_SIGNATURE = new Set(['open', 'exception_requested', 'exception_declined'])
/** A finding that should not survive to signature: a required clause missing, or anything critical. */
export const blocksAdherence = (f: FindingRow) => OPEN_AT_SIGNATURE.has(f.status) && (f.kind === 'missing_required' || f.severity === 'critical')

/**
 * The share of executed contracts signed with no open required or critical
 * finding on the version they were signed on, and what the others had open.
 * Contracts never reviewed are counted apart: nothing is known of them.
 */
export function adherence(executed: Array<{ id: string; versionId: string | null }>, findings: FindingRow[]): Section {
  const atSignature = new Map<string, FindingRow[]>()
  for (const c of executed) if (c.versionId) atSignature.set(c.id, findings.filter(f => f.contractId === c.id && f.versionId === c.versionId))
  const reviewed = executed.filter(c => (atSignature.get(c.id)?.length ?? 0) > 0)
  const breaking = reviewed.map(c => ({ id: c.id, open: atSignature.get(c.id)!.filter(blocksAdherence) }))
  const clean = breaking.filter(b => !b.open.length)
  const notClean = breaking.filter(b => b.open.length)
  const byClause = new Map<string, Set<string>>()
  for (const b of notClean) for (const f of b.open) { const k = f.clauseType ?? f.kind; byClause.set(k, (byClause.get(k) ?? new Set()).add(b.id)) }
  return {
    headline: { executed: executed.length, reviewed: reviewed.length, adherent: clean.length, rate: reviewed.length ? Math.round((clean.length / reviewed.length) * 100) / 100 : null, notReviewed: executed.length - reviewed.length },
    charts: {
      atSignature: [
        { key: 'adherent', label: 'Within the playbook', value: clean.length, n: clean.length, ids: clean.map(b => b.id) },
        { key: 'open_findings', label: 'Signed with open issues', value: notClean.length, n: notClean.length, ids: notClean.map(b => b.id) },
        { key: 'not_reviewed', label: 'Not reviewed', value: executed.length - reviewed.length, n: executed.length - reviewed.length, ids: executed.filter(c => !reviewed.includes(c)).map(c => c.id) },
      ],
      openByClause: [...byClause.entries()].map(([k, ids]) => ({ key: k, label: clauseLabel(k), value: ids.size, n: ids.size, ids: [...ids] })).sort((a, b) => b.n - a.n),
    },
  }
}

// ── AI: acceptance by feature ────────────────────────────────────────────

export interface AiOutcomeCount { feature: string; outcome: string; n: number; contractIds: string[] }

// The names people see for the features the suggestion log records (lib/ai-suggestion-events.ts).
const AI_FEATURE_LABELS: Record<string, string> = {
  ask_ai: 'Ask AI', counter: 'Counter-proposal', insert_standard: 'Insert our standard clause',
  redline_to_position: 'Edit to our position', fix_all: 'Fix all', amendment_language: 'Amendment wording', draft: 'Drafting',
}

/** accepted ÷ shown per feature; edited counts the accepted ones a person changed afterwards. */
export function aiAcceptance(rows: AiOutcomeCount[]): Section {
  const m = new Map<string, { shown: number; accepted: number; edited: number; dismissed: number; ids: Set<string> }>()
  for (const r of rows) {
    const g = m.get(r.feature) ?? { shown: 0, accepted: 0, edited: 0, dismissed: 0, ids: new Set<string>() }
    if (r.outcome === 'shown' || r.outcome === 'accepted' || r.outcome === 'edited' || r.outcome === 'dismissed') g[r.outcome] += r.n
    r.contractIds.forEach(id => g.ids.add(id))
    m.set(r.feature, g)
  }
  const rate = (a: number, b: number) => b ? Math.round((a / b) * 100) / 100 : null
  const bars: Bar[] = [...m.entries()].map(([f, g]) => ({
    key: f, label: AI_FEATURE_LABELS[f] ?? clauseLabel(f), value: rate(g.accepted, g.shown), n: g.shown, ids: [...g.ids],
    extra: { shown: g.shown, accepted: g.accepted, edited: g.edited, dismissed: g.dismissed, editedAfterAccept: rate(g.edited, g.accepted) },
  })).sort((a, b) => b.n - a.n)
  const shown = bars.reduce((t, b) => t + b.n, 0), accepted = [...m.values()].reduce((t, g) => t + g.accepted, 0)
  return { headline: { shown, accepted, rate: rate(accepted, shown) }, charts: { byFeature: bars } }
}

// ── CSV ──────────────────────────────────────────────────────────────────

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** A section's charts as one table: a row per bar, with its extra figures as columns. */
export function sectionCsv(section: Section): string {
  const extras = uniq(Object.values(section.charts).flatMap(bars => bars.flatMap(b => Object.keys(b.extra ?? {}))))
  const head = ['chart', 'key', 'label', 'value', 'n', ...extras]
  const rows = Object.entries(section.charts).flatMap(([chart, bars]) => bars.map(b => [chart, b.key, b.label, b.value, b.n, ...extras.map(e => b.extra?.[e])]))
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\n') + '\n'
}

/** A section as it goes out: bars without their contract ids, which the drill-down serves. */
export function withoutIds(section: Section): Omit<Section, 'charts'> & { charts: Record<string, Array<Omit<Bar, 'ids'>>> } {
  return { ...section, charts: Object.fromEntries(Object.entries(section.charts).map(([k, bars]) => [k, bars.map(({ ids: _ids, ...b }) => b)])) }
}
