import { describe, it, expect } from 'vitest'
import {
  percentile, stats, paperSource, originTemplate, moveOf, stageSpans, turnSpans, cycleTime, timeInStage,
  workload, activeSince, approvalTimes, negotiation, renewals, mostNegotiated, exceptions, templateUsage, adherence,
  aiAcceptance, sectionCsv, withoutIds, DAY_MS, type ApprovalStepRow, type StageEvent, type FindingRow,
} from './analytics-metrics.js'

const T0 = new Date('2026-01-01T00:00:00Z')
const d = (n: number) => new Date(T0.getTime() + n * DAY_MS)
const ev = (day: number, m: Record<string, unknown>): StageEvent => ({ at: d(day), metadata: m })

describe('percentile and stats', () => {
  it('interpolates between ranks and is null for no values', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([1, 3], 50)).toBe(2)
    expect(percentile([10, 1, 5], 50)).toBe(5)
    expect(stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ n: 10, medianDays: 5.5, p90Days: 9.1 })
  })
})

describe('paper source', () => {
  it('is ours when drafted from a template (_origin or the older _template), theirs otherwise', () => {
    expect(paperSource({ _origin: { templateId: 't1', templateName: 'MSA' } })).toBe('ours')
    expect(originTemplate({ _template: { id: 't2', name: 'NDA' } })).toEqual({ id: 't2', name: 'NDA' })
    expect(paperSource({})).toBe('theirs')
    expect(paperSource(null)).toBe('theirs')
  })
})

describe('stage and turn spans', () => {
  it('reads the new payload and the older status-only events', () => {
    expect(moveOf(ev(0, { from: 'DRAFT', to: 'PENDING_APPROVAL' }))).toMatchObject({ fromStage: 'draft', toStage: 'approve', toTurn: null })
    expect(moveOf(ev(0, { from: null, to: 'DRAFT', toStage: 'request', toTurn: 'internal', created: true }))).toMatchObject({ toStage: 'request', created: true })
  })

  it('starts at creation, closes each span at the next move and leaves the last one open to now', () => {
    const moves = [
      ev(0, { from: null, toStage: 'request', toTurn: 'internal', created: true }),
      ev(2, { fromStage: 'request', toStage: 'draft', fromTurn: 'internal', toTurn: 'internal' }),
      ev(5, { fromStage: 'draft', toStage: 'negotiate', fromTurn: 'internal', toTurn: 'counterparty' }),
      ev(9, { fromStage: 'negotiate', toStage: 'negotiate', fromTurn: 'counterparty', toTurn: 'internal' }),
      ev(10, { fromStage: 'negotiate', toStage: 'negotiate', fromTurn: 'internal', toTurn: 'counterparty' }),
    ].map(moveOf)
    const s = stageSpans({ createdAt: d(0), stage: 'negotiate' }, moves, d(12))
    expect(s.map(x => [x.key, (x.end.getTime() - x.start.getTime()) / DAY_MS, x.open])).toEqual([
      ['request', 2, false], ['draft', 3, false], ['negotiate', 7, true],
    ])
    const t = turnSpans({ createdAt: d(0), turn: 'counterparty' }, moves, d(12))
    expect(t.map(x => [x.key, (x.end.getTime() - x.start.getTime()) / DAY_MS, x.open])).toEqual([
      ['internal', 5, false], ['counterparty', 4, false], ['internal', 1, false], ['counterparty', 2, true],
    ])
  })

  it('without a creation event, begins in the first move\'s from; with no events, in the current stage', () => {
    const s = stageSpans({ createdAt: d(0), stage: 'approve' }, [moveOf(ev(4, { from: 'DRAFT', to: 'PENDING_APPROVAL' }))], d(6))
    expect(s.map(x => x.key)).toEqual(['draft', 'approve'])
    expect(stageSpans({ createdAt: d(0), stage: 'draft' }, [], d(3))).toEqual([{ key: 'draft', start: d(0), end: d(3), open: true }])
  })
})

describe('cycle time', () => {
  it('is created to executed, by type, paper and owner', () => {
    const base = { ownerId: 'u1', ownerName: 'Ana', createdAt: d(0) }
    const r = cycleTime([
      { ...base, id: 'a', type: 'NDA', executedAt: d(4), paper: 'ours' },
      { ...base, id: 'b', type: 'NDA', executedAt: d(6), paper: 'theirs' },
      { ...base, id: 'c', type: 'MSA', executedAt: d(30), paper: 'theirs', ownerId: 'u2', ownerName: 'Ben' },
    ])
    expect(r.headline).toMatchObject({ executed: 3, medianDays: 6 })
    expect(r.charts.byType.map(b => [b.key, b.value, b.ids])).toEqual([['MSA', 30, ['c']], ['NDA', 5, ['a', 'b']]])
    expect(r.charts.byPaper.find(b => b.key === 'ours')).toMatchObject({ label: 'Our paper', value: 4 })
    expect(r.charts.byOwner[0]).toMatchObject({ key: 'u2', label: 'Ben' })
  })
})

describe('time in stage', () => {
  it('names the stage with the largest median as the bottleneck and counts the ones in it now', () => {
    const span = (key: string, a: number, b: number, open = false) => ({ key: key as never, start: d(a), end: d(b), open })
    const r = timeInStage([
      { contractId: 'a', spans: [span('draft', 0, 2), span('approve', 2, 12), span('active', 12, 40, true)] },
      { contractId: 'b', spans: [span('draft', 0, 4), span('approve', 4, 10, true)] },
    ])
    expect(r.headline).toMatchObject({ bottleneck: 'approve', bottleneckMedianDays: 8 })
    const approve = r.charts.byStage.find(b => b.key === 'approve')!
    expect(approve).toMatchObject({ n: 2, ids: ['a', 'b'], extra: { inStageNow: 1 } })
    expect(r.charts.byStage.map(b => b.key)).not.toContain('active')
  })
})

describe('workload', () => {
  it('buckets what waits by age and by who holds it', () => {
    const r = workload([
      { contractId: 'a', holderKey: 'u1', holderLabel: 'Ana', since: d(9) },
      { contractId: 'b', holderKey: 'u1', holderLabel: 'Ana', since: d(0) },
      { contractId: 'c', holderKey: 'cp', holderLabel: 'Counterparty', since: d(-40) },
    ], d(10))
    expect(r.charts.byAge.map(b => b.n)).toEqual([1, 0, 1, 0, 1])
    expect(r.headline).toMatchObject({ waiting: 3, over14Days: 1, oldestDays: 50 })
    expect(r.charts.byHolder[0]).toMatchObject({ key: 'cp', value: 50 })
  })
})

describe('approval time', () => {
  const step = (o: Partial<ApprovalStepRow>): ApprovalStepRow => ({
    id: 's', contractId: 'c1', instanceId: 'i1', kind: 'approval', stepOrder: 1, stepName: 'Legal', approverKey: 'u1', approverLabel: 'Ana',
    createdAt: d(0), decidedAt: null, ...o,
  })

  it('counts a later step from the decision before it, not from submission', () => {
    const s1 = step({ id: 's1', decidedAt: d(2) })
    const s2 = step({ id: 's2', stepOrder: 2, stepName: 'Finance', approverKey: 'u2', approverLabel: 'Ben', decidedAt: d(7) })
    expect(activeSince(s2, [s1, s2], d(0))).toEqual(d(2))
    const r = approvalTimes([s1, s2, step({ id: 's3', contractId: 'c2', instanceId: 'i2' })], new Map([['i1', d(0)], ['i2', d(1)]]), d(10))
    expect(r.headline).toMatchObject({ decided: 2, waitingNow: 1 })
    expect(r.charts.byApprover.map(b => [b.key, b.value])).toEqual([['u2', 5], ['u1', 2]])
    expect(r.charts.byStep.find(b => b.key === 'Legal')!.extra).toMatchObject({ waitingNow: 1 })
  })

  it('counts an exception request from when it was asked for', () => {
    const ex = step({ kind: 'clause_exception', instanceId: null, createdAt: d(3), decidedAt: d(4) })
    expect(activeSince(ex, [], null)).toEqual(d(3))
  })
})

describe('negotiation', () => {
  it('measures finished counterparty turns, counts rounds and keeps the open one as waiting', () => {
    const sp = (key: string, a: number, b: number, open = false) => ({ key: key as never, start: d(a), end: d(b), open })
    const r = negotiation([
      { contractId: 'a', counterpartyKey: 'acme', counterpartyLabel: 'Acme', spans: [sp('internal', 0, 2), sp('counterparty', 2, 6), sp('internal', 6, 7), sp('counterparty', 7, 9, true)] },
      { contractId: 'b', counterpartyKey: 'beta', counterpartyLabel: 'Beta', spans: [sp('internal', 0, 1), sp('counterparty', 1, 11), sp('internal', 11, 12, true)] },
    ])
    expect(r.headline).toMatchObject({ turnaroundMedianDays: 7, turnsReturned: 2, withCounterpartyNow: 1, medianTurnsPerContract: 1.5 })
    expect(r.charts.byCounterparty.map(b => [b.key, b.value])).toEqual([['beta', 10], ['acme', 4]])
    expect(r.charts.turnsPerContract.map(b => b.n)).toEqual([1, 1, 0, 0])
  })
})

describe('renewals', () => {
  it('lists undecided deadlines ahead and the ones missed without a decision or notice in time', () => {
    const now = d(100)
    const r = renewals([
      { id: 'soon', noticeDeadline: d(110), renewalType: 'auto' },
      { id: 'later', noticeDeadline: d(170), renewalType: 'auto' },
      { id: 'decided', noticeDeadline: d(105), renewalType: 'auto' },
      { id: 'missed', noticeDeadline: d(90), renewalType: 'auto' },
      { id: 'late', noticeDeadline: d(80), renewalType: 'manual' },
      { id: 'ok', noticeDeadline: d(95), renewalType: 'auto' },
      { id: 'old', noticeDeadline: d(10), renewalType: 'auto' },
    ], [
      { contractId: 'decided', createdAt: d(99), noticeSentAt: null, supersededAt: null, decidedInTime: true, noticeSentInTime: null },
      { contractId: 'late', createdAt: d(85), noticeSentAt: null, supersededAt: null, decidedInTime: false, noticeSentInTime: null },
      { contractId: 'ok', createdAt: d(97), noticeSentAt: d(94), supersededAt: null, decidedInTime: false, noticeSentInTime: true },
    ], now, d(50))
    expect(r.charts.upcoming.map(b => b.ids)).toEqual([['soon'], [], ['later']])
    expect(r.charts.outcome.find(b => b.key === 'missed')!.ids.sort()).toEqual(['late', 'missed'])
    expect(r.headline).toMatchObject({ deadlinesPassed: 3, missed: 2, missedAutoRenewing: 1 })
  })
})

const f = (o: Partial<FindingRow>): FindingRow => ({
  contractId: 'a', versionId: 'v1', key: 'k', kind: 'modified', clauseType: 'liability', severity: 'high', status: 'open', resolvedById: null, ...o,
})

describe('most-negotiated clauses', () => {
  it('counts each contract once per clause, by how it was settled, and skips what matched on its own', () => {
    const r = mostNegotiated([
      f({ versionId: 'v1', status: 'resolved', resolvedById: 'u1' }),
      f({ versionId: 'v2', status: 'resolved', resolvedById: 'u1' }),
      f({ contractId: 'b', kind: 'position_not_met', status: 'exception_approved', resolvedById: 'u2' }),
      f({ contractId: 'c', status: 'resolved', resolvedById: null }),
      f({ contractId: 'c', clauseType: 'indemnity', status: 'accepted', resolvedById: 'u1' }),
      f({ contractId: 'd', clauseType: 'payment', kind: 'drafting', status: 'accepted', resolvedById: 'u1' }),
    ])
    expect(r.charts.byClause.map(b => [b.key, b.value])).toEqual([['liability', 2], ['indemnity', 1]])
    expect(r.charts.byClause[0]).toMatchObject({ label: 'Liability', ids: ['a', 'b'], extra: { flagged: 3, countered: 1, exception: 1, deviationRate: 0.75 } })
  })
})

describe('exceptions', () => {
  it('counts requests by clause and decisions by approver, with the grant rate', () => {
    const s = (o: Record<string, unknown>) => ({ contractId: 'a', clauseType: 'liability', approverKey: 'u1', approverLabel: 'Ana', status: 'APPROVED', decision: 'APPROVED', ...o })
    const r = exceptions([s({}), s({ contractId: 'b', decision: 'DECLINED', status: 'DECLINED' }), s({ contractId: 'c', decision: null, status: 'PENDING', approverKey: 'u2' }), s({ clauseType: null, contractId: 'd' })])
    expect(r.headline).toEqual({ requested: 4, granted: 2, declined: 1, grantRate: 0.67 })
    expect(r.charts.byClause[0]).toMatchObject({ key: 'liability', n: 3, value: 1, extra: { pending: 1, declined: 1 } })
    expect(r.charts.byApprover).toHaveLength(1)
  })
})

describe('template usage', () => {
  it('joins contracts to their template, with cycle time of the executed and median turns', () => {
    const r = templateUsage([
      { id: 'a', templateId: 't1', templateName: 'MSA', createdAt: d(0), executedAt: d(10), turns: 2 },
      { id: 'b', templateId: 't1', templateName: 'MSA', createdAt: d(0), executedAt: null, turns: 0 },
      { id: 'c', templateId: 't2', templateName: 'NDA', createdAt: d(0), executedAt: d(2), turns: 0 },
    ])
    expect(r.charts.byTemplate[0]).toMatchObject({ key: 't1', n: 2, extra: { executed: 1, medianCycleDays: 10, medianTurns: 1 } })
  })
})

describe('playbook adherence at signature', () => {
  it('reads the signed version only, and counts open required or critical findings against it', () => {
    const r = adherence(
      [{ id: 'a', versionId: 'v2' }, { id: 'b', versionId: 'v1' }, { id: 'c', versionId: 'v1' }, { id: 'd', versionId: null }],
      [
        f({ contractId: 'a', versionId: 'v1', kind: 'missing_required' }),
        f({ contractId: 'a', versionId: 'v2', kind: 'missing_required', status: 'resolved' }),
        f({ contractId: 'b', versionId: 'v1', severity: 'critical', status: 'exception_declined' }),
        f({ contractId: 'b', versionId: 'v1', severity: 'medium' }),
        f({ contractId: 'c', versionId: 'v1', severity: 'high' }),
      ],
    )
    expect(r.headline).toMatchObject({ executed: 4, reviewed: 3, adherent: 2, rate: 0.67, notReviewed: 1 })
    expect(r.charts.atSignature.find(b => b.key === 'open_findings')!.ids).toEqual(['b'])
    expect(r.charts.openByClause).toEqual([{ key: 'liability', label: 'Liability', value: 1, n: 1, ids: ['b'] }])
  })
})

describe('AI acceptance', () => {
  it('is accepted over shown per feature, with edits after acceptance', () => {
    const r = aiAcceptance([
      { feature: 'clause_suggestion', outcome: 'shown', n: 10, contractIds: ['a'] },
      { feature: 'clause_suggestion', outcome: 'accepted', n: 4, contractIds: ['a'] },
      { feature: 'clause_suggestion', outcome: 'edited', n: 1, contractIds: [] },
      { feature: 'redline', outcome: 'shown', n: 2, contractIds: ['b'] },
    ])
    expect(r.headline).toEqual({ shown: 12, accepted: 4, rate: 0.33 })
    expect(r.charts.byFeature[0]).toMatchObject({ key: 'clause_suggestion', label: 'Clause suggestion', value: 0.4, extra: { editedAfterAccept: 0.25 } })
  })
})

describe('CSV and the public shape', () => {
  it('writes a row per bar with its extra columns, quoting and defusing formulas', () => {
    const csv = sectionCsv({ headline: {}, charts: { byType: [{ key: '=cmd', label: 'A, "b"', value: 1.5, n: 2, ids: ['x'], extra: { p90Days: 3 } }] } })
    expect(csv).toBe('chart,key,label,value,n,p90Days\nbyType,\'=cmd,"A, ""b""",1.5,2,3\n')
    expect(withoutIds({ headline: {}, charts: { x: [{ key: 'k', label: 'K', value: 1, n: 1, ids: ['secret'] }] } }).charts.x[0]).not.toHaveProperty('ids')
  })
})
