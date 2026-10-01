/**
 * docs/41 Part 18 — the stage, state and turn model (packages/types
 * lifecycle.ts), as a table: every stage reachable, no dead end, the moves
 * the plan forbids refused; the status kept as a column maps both ways;
 * the approval reset rules per mode; a request's own moves.
 */
import { describe, it, expect } from 'vitest'
import {
  STAGES, STAGE_STATES, TRANSITIONS, CANCELLABLE, transitionRefusal, statusFor, stageForStatus, turnFor, defaultState,
  resets, readResetRule, requestTransitionRefusal, stageLine, readDecision,
  type Stage, type StageState, type TransitionSource, type ChangeSet,
} from '@clm/types'
import { manualRefusal, manualTarget } from './contract-status.js'

const SOURCES: TransitionSource[] = ['manual', 'approval', 'signature', 'counterparty', 'send', 'edit', 'agent', 'revert', 'cancel', 'undo_cancel', 'dates', 'import', 'system']
const points = STAGES.flatMap(stage => (STAGE_STATES[stage] as readonly StageState[]).map(state => ({ stage, state })))

/** Every stage and state, and whether a move from one to the next is allowed by any source. */
function allowed(from: { stage: Stage; state: StageState }, to: { stage: Stage; state: StageState }): boolean {
  return SOURCES.some(source => transitionRefusal({ from, to, source, reason: 'because', isAdmin: true }) === null)
}

describe('allowed transitions (property)', () => {
  it('every stage is reachable from a draft, by allowed moves only', () => {
    const seen = new Set<string>(['draft/drafting'])
    const queue = [{ stage: 'draft' as Stage, state: 'drafting' as StageState }]
    while (queue.length) {
      const p = queue.shift()!
      for (const q of points) {
        const k = `${q.stage}/${q.state}`
        if (!seen.has(k) && allowed(p, q)) { seen.add(k); queue.push(q) }
      }
    }
    // Every stage; every state but the request's own (a contract is made from a request, not sent back to one).
    for (const s of STAGES) expect(points.some(p => p.stage === s && seen.has(`${p.stage}/${p.state}`)), s).toBe(true)
    for (const p of points.filter(p => p.stage !== 'request')) expect(seen.has(`${p.stage}/${p.state}`), `${p.stage}/${p.state}`).toBe(true)
  })

  it('no dead ends: every state but a final one has a way out to another stage', () => {
    const final = (p: { stage: Stage; state: StageState }) => p.stage === 'closed' && p.state !== 'cancelled' && p.state !== 'expired'
    for (const p of points) {
      if (final(p)) continue
      const out = points.some(q => q.stage !== p.stage && allowed(p, q))
      expect(out, `${p.stage}/${p.state} has no way out`).toBe(true)
    }
  })

  it('each rule in the table is a move some source may make, and only those sources', () => {
    for (const from of STAGES) {
      for (const [to, rule] of Object.entries(TRANSITIONS[from]) as Array<[Stage, { via: TransitionSource[] }]>) {
        const a = { stage: from, state: from === 'closed' ? 'cancelled' as StageState : defaultState(from) }
        const b = { stage: to, state: defaultState(to) }
        for (const source of SOURCES) {
          if (source === 'cancel' || source === 'undo_cancel') continue
          const r = transitionRefusal({ from: a, to: b, source, reason: 'because', isAdmin: true })
          if (from === 'closed') continue
          expect(r === null, `${from}→${to} via ${source}`).toBe(rule.via.includes(source))
        }
      }
    }
  })

  it('refuses what the plan forbids', () => {
    // Active → Negotiate: an amendment, never a reopening.
    expect(transitionRefusal({ from: { stage: 'active', state: 'active' }, to: { stage: 'negotiate', state: 'with_us' }, source: 'manual', reason: 'x' })).toMatch(/amendment/)
    // Into Approve by hand, into Sign without the signing flow.
    expect(transitionRefusal({ from: { stage: 'draft', state: 'drafting' }, to: { stage: 'approve', state: 'approved' }, source: 'manual' })).toMatch(/submitted for approval/)
    expect(transitionRefusal({ from: { stage: 'approve', state: 'approved' }, to: { stage: 'sign', state: 'out_for_signature' }, source: 'manual' })).toMatch(/signature/)
    // Backwards needs a reason.
    expect(transitionRefusal({ from: { stage: 'sign', state: 'voided' }, to: { stage: 'negotiate', state: 'with_us' }, source: 'revert' })).toMatch(/Say why/)
    expect(transitionRefusal({ from: { stage: 'sign', state: 'voided' }, to: { stage: 'negotiate', state: 'with_us' }, source: 'revert', reason: 'wrong signer' })).toBeNull()
    // Cancelled: from any stage before Active, with a reason; never after.
    for (const s of CANCELLABLE) expect(transitionRefusal({ from: { stage: s, state: defaultState(s) }, to: { stage: 'closed', state: 'cancelled' }, source: 'cancel', reason: 'deal off' })).toBeNull()
    expect(transitionRefusal({ from: { stage: 'draft', state: 'drafting' }, to: { stage: 'closed', state: 'cancelled' }, source: 'cancel' })).toMatch(/why/)
    expect(transitionRefusal({ from: { stage: 'active', state: 'active' }, to: { stage: 'closed', state: 'cancelled' }, source: 'cancel', reason: 'x' })).toMatch(/before it is signed/)
    // Bringing a cancelled contract back: an admin, with a reason.
    const back = { from: { stage: 'closed' as Stage, state: 'cancelled' as StageState }, to: { stage: 'negotiate' as Stage, state: 'with_us' as StageState }, source: 'undo_cancel' as TransitionSource, reason: 'deal is back' }
    expect(transitionRefusal({ ...back, isAdmin: false })).toMatch(/admin/)
    expect(transitionRefusal({ ...back, isAdmin: true })).toBeNull()
    expect(transitionRefusal({ ...back, source: 'manual', isAdmin: true })).toMatch(/admin/)
    // Closed stays closed (an expired one is archived, or comes back on new dates).
    expect(transitionRefusal({ from: { stage: 'closed', state: 'terminated' }, to: { stage: 'active', state: 'active' }, source: 'dates' })).toMatch(/expired/)
    expect(transitionRefusal({ from: { stage: 'closed', state: 'expired' }, to: { stage: 'active', state: 'active' }, source: 'dates' })).toBeNull()
    expect(transitionRefusal({ from: { stage: 'closed', state: 'terminated' }, to: { stage: 'closed', state: 'archived' }, source: 'manual' })).toMatch(/stays/)
  })

  it('a person\'s moves by hand: approval and signature are the flows\' to set', () => {
    expect(manualRefusal({ stage: 'approve', state: 'pending' }, manualTarget('APPROVED')!)).toMatch(/approval workflow/)
    expect(manualRefusal({ stage: 'approve', state: 'pending' }, manualTarget('REJECTED')!)).toMatch(/approval workflow/)
    expect(manualRefusal({ stage: 'draft', state: 'drafting' }, manualTarget('PENDING_APPROVAL')!)).toMatch(/approval workflow/)
    expect(manualRefusal({ stage: 'approve', state: 'approved' }, manualTarget('PENDING_SIGNATURE')!)).toMatch(/signature/)
    expect(manualRefusal({ stage: 'approve', state: 'approved' }, manualTarget('EXECUTED')!)).toBeNull()
    expect(manualRefusal({ stage: 'draft', state: 'ready' }, manualTarget('UNDER_NEGOTIATION')!)).toBeNull()
    expect(manualRefusal({ stage: 'negotiate', state: 'with_us' }, { stage: 'negotiate', state: 'with_counterparty' })).toBeNull()
    expect(manualRefusal({ stage: 'negotiate', state: 'with_us' }, { stage: 'draft', state: 'drafting' })).toMatch(/Say why/)
    expect(manualRefusal({ stage: 'negotiate', state: 'with_us' }, { stage: 'draft', state: 'drafting' }, { reason: 'starting over' })).toBeNull()
  })
})

describe('status, the derived column', () => {
  it('every stage and state has a status, and that status reads back as the same stage', () => {
    for (const p of points) {
      const status = statusFor(p.stage, p.state)
      expect(status).toMatch(/^[A-Z_]+$/)
      // Back to the same stage, except where a status stands for several (docs/47).
      const back = stageForStatus(status)
      if (!['request', 'closed'].includes(p.stage) && !(p.stage === 'approve' && p.state === 'declined') && !(p.stage === 'draft' && p.state === 'returned')) {
        expect(back.stage, `${p.stage}/${p.state} → ${status}`).toBe(p.stage)
      }
    }
  })

  it('every legacy status maps to a stage, and back to itself', () => {
    for (const s of ['DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL', 'APPROVED', 'PENDING_SIGNATURE', 'EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED']) {
      const p = stageForStatus(s)
      expect(statusFor(p.stage, p.state)).toBe(s)
    }
    expect(stageForStatus('REJECTED')).toEqual({ stage: 'draft', state: 'returned' })
    expect(stageForStatus('nonsense')).toEqual({ stage: 'draft', state: 'drafting' })
  })

  it('whose turn a stage and state make it', () => {
    expect(turnFor('negotiate', 'with_counterparty')).toBe('counterparty')
    expect(turnFor('negotiate', 'with_us')).toBe('internal')
    expect(turnFor('approve', 'pending')).toBe('approvers')
    expect(turnFor('approve', 'approved')).toBe('internal')
    expect(turnFor('sign', 'out_for_signature')).toBe('signers')
    expect(turnFor('sign', 'voided')).toBe('internal')
    expect(turnFor('active', 'expiring')).toBe('none')
  })

  it('the banner line names the stage, state and turn in words', () => {
    const now = new Date('2026-10-03T12:00:00Z')
    expect(stageLine({ stage: 'negotiate', stageState: 'with_counterparty', turn: 'counterparty', turnSince: new Date('2026-10-01T10:00:00Z') }, now)).toBe('Negotiate · Counterparty\'s turn · 2 days')
    expect(stageLine({ stage: 'draft', stageState: 'returned', turn: 'internal', turnSince: now }, now)).toBe('Draft · Returned for changes · Our turn')
    expect(stageLine({ stage: 'active', stageState: 'active', turn: 'none' }, now)).toBe('Active')
  })
})

describe('approval reset rules (per workflow step)', () => {
  const doc = (clauseTypes: string[] | null): ChangeSet => ({ document: true, clauseTypes, fields: [] })
  const fields = (...f: string[]): ChangeSet => ({ document: false, clauseTypes: [], fields: f })

  it('always: any change; any_document_change: a new version only', () => {
    expect(resets(readResetRule(undefined), fields('value'))).toBe(true)
    expect(resets(readResetRule('always'), doc([]))).toBe(true)
    expect(resets(readResetRule('any_document_change'), fields('value'))).toBe(false)
    expect(resets(readResetRule('any_document_change'), doc([]))).toBe(true)
  })

  it('clause_text_changes: only the covered clauses (all clauses when none listed); unknown clauses count as changed', () => {
    const covered = readResetRule({ mode: 'clause_text_changes', clauseTypes: ['limitation_of_liability'] })
    expect(resets(covered, doc(['limitation_of_liability']))).toBe(true)
    expect(resets(covered, doc(['confidentiality']))).toBe(false)
    expect(resets(covered, doc(null))).toBe(true)
    expect(resets(covered, fields('value'))).toBe(false)
    expect(resets(readResetRule({ mode: 'clause_text_changes' }), doc(['confidentiality']))).toBe(true)
    expect(resets(readResetRule({ mode: 'clause_text_changes' }), doc([]))).toBe(false)
  })

  it('fields: only the listed fields; never: nothing', () => {
    const value = readResetRule({ mode: 'fields', fields: ['value'] })
    expect(resets(value, fields('value'))).toBe(true)
    expect(resets(value, fields('currency'))).toBe(false)
    expect(resets(value, doc(null))).toBe(false)
    expect(resets(readResetRule({ fields: ['type'] }), fields('type'))).toBe(true)
    expect(resets(readResetRule('never'), doc(null))).toBe(false)
    expect(resets(readResetRule('never'), fields('value'))).toBe(false)
  })
})

describe('decisions and requests', () => {
  it('an older client\'s REJECTED is a return', () => {
    expect(readDecision('REJECTED')).toBe('RETURNED')
    expect(readDecision('DECLINED')).toBe('DECLINED')
    expect(readDecision('nope')).toBeNull()
  })

  it('declining a request needs a reason; accepting it is drafting it', () => {
    expect(requestTransitionRefusal('SUBMITTED', 'REJECTED')).toMatch(/why/)
    expect(requestTransitionRefusal('SUBMITTED', 'REJECTED', 'Out of scope')).toBeNull()
    expect(requestTransitionRefusal('SUBMITTED', 'ACCEPTED')).toMatch(/drafting/)
    expect(requestTransitionRefusal('COMPLETED', 'SUBMITTED')).toMatch(/can't move/)
    expect(requestTransitionRefusal('REJECTED', 'SUBMITTED')).toBeNull()
  })
})
