/**
 * docs/41 Part 18 — where a contract is (its stage), what is happening in it
 * (the state within the stage), and who must act (the turn).
 *
 * `status` came first and mixed the three: UNDER_NEGOTIATION said nothing of
 * whose move it was, a returned approval and a fresh draft were both DRAFT,
 * and PENDING_SIGNATURE had no way out. The stage is now what the product
 * reasons about; `status` stays as a column derived from the stage and state
 * (`statusFor`), because webhooks, analytics, the search index and API
 * clients read it. The mapping both ways is documented in
 * docs/47-STAGE-STATE-TURN.md.
 *
 * Everything here is pure, shared by the API (the transition service,
 * lib/lifecycle.ts) and the web (the status banner).
 */

export const STAGES = ['request', 'draft', 'negotiate', 'approve', 'sign', 'active', 'closed'] as const
export type Stage = (typeof STAGES)[number]

/** The states each stage can be in. The first is where a move into the stage lands by default. */
export const STAGE_STATES = {
  request:   ['submitted', 'in_triage', 'more_info', 'declined'],
  draft:     ['drafting', 'ready', 'returned'],
  negotiate: ['with_us', 'with_counterparty', 'returned'],
  approve:   ['pending', 'approved', 'declined'],
  sign:      ['out_for_signature', 'declined', 'voided'],
  // 'renewing' — fix-up 18: we decided to renew (or renegotiate); not "expiring".
  active:    ['active', 'expiring', 'auto_renewed', 'renewing'],
  closed:    ['expired', 'terminated', 'superseded', 'cancelled', 'archived'],
} as const satisfies Record<Stage, readonly string[]>

export type StageState = (typeof STAGE_STATES)[Stage][number]

export const TURNS = ['internal', 'counterparty', 'approvers', 'signers', 'none'] as const
export type Turn = (typeof TURNS)[number]

export interface StagePoint { stage: Stage; state: StageState }

export function isStage(s: unknown): s is Stage {
  return typeof s === 'string' && (STAGES as readonly string[]).includes(s)
}

export function isStateOf(stage: Stage, state: unknown): state is StageState {
  return typeof state === 'string' && (STAGE_STATES[stage] as readonly string[]).includes(state)
}

/** The state a move into `stage` lands in when no state is named. */
export function defaultState(stage: Stage): StageState {
  return STAGE_STATES[stage][0]
}

// ─── status ⇄ stage ───────────────────────────────────────────────────────────

/**
 * The legacy `status` for a stage and state. Kept as a column for a release
 * (docs/41 §6.12): webhooks, analytics and API clients read it.
 *
 * Two choices worth knowing: an approval *declined* ("do not proceed") reads
 * DRAFT, as a rejected approval always did; a contract cancelled or
 * superseded reads ARCHIVED, the nearest status there is.
 */
export function statusFor(stage: Stage, state: StageState): string {
  switch (stage) {
    case 'request':   return 'DRAFT'
    case 'draft':     return state === 'ready' ? 'PENDING_REVIEW' : 'DRAFT'
    case 'negotiate': return 'UNDER_NEGOTIATION'
    case 'approve':   return state === 'approved' ? 'APPROVED' : state === 'declined' ? 'DRAFT' : 'PENDING_APPROVAL'
    case 'sign':      return 'PENDING_SIGNATURE'
    case 'active':    return 'EXECUTED'
    case 'closed':    return state === 'expired' ? 'EXPIRED' : state === 'terminated' ? 'TERMINATED' : 'ARCHIVED'
  }
}

/**
 * The stage and state a legacy `status` stands for: how existing rows were
 * migrated, and what an import or an old client that names a status gets.
 * UNDER_NEGOTIATION lands "with us"; the migration then looks at who moved
 * last (docs/47).
 */
export function stageForStatus(status: string | null | undefined): StagePoint {
  switch (status) {
    case 'PENDING_REVIEW':    return { stage: 'draft', state: 'ready' }
    case 'UNDER_NEGOTIATION': return { stage: 'negotiate', state: 'with_us' }
    case 'PENDING_APPROVAL':  return { stage: 'approve', state: 'pending' }
    case 'APPROVED':          return { stage: 'approve', state: 'approved' }
    case 'REJECTED':          return { stage: 'draft', state: 'returned' }
    case 'PENDING_SIGNATURE': return { stage: 'sign', state: 'out_for_signature' }
    case 'EXECUTED':          return { stage: 'active', state: 'active' }
    case 'EXPIRED':           return { stage: 'closed', state: 'expired' }
    case 'TERMINATED':        return { stage: 'closed', state: 'terminated' }
    case 'ARCHIVED':          return { stage: 'closed', state: 'archived' }
    default:                  return { stage: 'draft', state: 'drafting' }
  }
}

/** Whose move it is in a stage and state, when nothing more specific is known. */
export function turnFor(stage: Stage, state: StageState): Turn {
  switch (stage) {
    case 'request':   return 'internal'
    case 'draft':     return 'internal'
    case 'negotiate': return state === 'with_counterparty' ? 'counterparty' : 'internal'
    case 'approve':   return state === 'pending' ? 'approvers' : 'internal'
    case 'sign':      return state === 'out_for_signature' ? 'signers' : 'internal'
    case 'active':
    case 'closed':    return 'none'
  }
}

// ─── Allowed transitions ──────────────────────────────────────────────────────

/** What made a move. Moves a person makes by hand are `manual`; the rest come from a flow. */
export type TransitionSource =
  | 'manual'        // a person, from the contract page or the API (edit:contract)
  | 'approval'      // the approval workflow: submit, decide, return, decline, reset
  | 'signature'     // the signing flow: sent, all signed, voided, declined
  | 'counterparty'  // a counterparty's upload or emailed redline
  | 'send'          // we sent it to the counterparty (share link, email, download for them)
  | 'edit'          // a change to the document or its terms
  | 'agent'         // the assistant, for the user (same rules as manual)
  | 'revert'        // a move back with a reason: out of signing, back to drafting
  | 'cancel'        // cancelled, with a reason
  | 'undo_cancel'   // an admin bringing a cancelled contract back
  | 'dates'         // the daily date job: expiring, expired
  | 'import'        // created from an import or a request
  | 'undo'          // the exact reversal of a move just made (an assistant action undone)
  | 'system'

/**
 * Which stage may follow which, and how. A move within a stage (a change of
 * state or turn) is always allowed here; the flow that makes it checks its
 * own conditions. Moves that go backwards need a reason.
 *
 * Not allowed, on purpose:
 *   - active → negotiate (or any working stage): a signed contract changes
 *     through an amendment, never by reopening it;
 *   - closed → anything, except an admin undoing a cancellation;
 *   - into approve except through the approval workflow (submit), and into
 *     sign except through the signing flow.
 */
export interface TransitionRule {
  /** Sources that may make this move. */
  via: TransitionSource[]
  /** Going backwards: a reason is required. */
  back?: boolean
}

export const TRANSITIONS: Record<Stage, Partial<Record<Stage, TransitionRule>>> = {
  request: {
    draft:     { via: ['import', 'manual', 'system'] },
    closed:    { via: ['cancel'] },
  },
  draft: {
    negotiate: { via: ['send', 'counterparty', 'manual', 'agent'] },
    approve:   { via: ['approval'] },
    // Only where the org lets contracts be signed without approval (the signing gate).
    sign:      { via: ['signature'] },
    closed:    { via: ['cancel'] },
  },
  negotiate: {
    draft:     { via: ['manual', 'agent', 'revert'], back: true },
    approve:   { via: ['approval'] },
    sign:      { via: ['signature'] },
    closed:    { via: ['cancel'] },
  },
  approve: {
    // Return (changes needed), a counterparty's version, an edit that resets approval.
    draft:     { via: ['approval', 'revert', 'edit', 'counterparty'], back: true },
    negotiate: { via: ['approval', 'revert', 'counterparty', 'edit'], back: true },
    sign:      { via: ['signature'] },
    // Signed outside the product (wet ink): recorded by hand.
    active:    { via: ['manual', 'agent', 'signature'] },
    closed:    { via: ['cancel'] },
  },
  sign: {
    // Revert after the envelope was voided or declined (docs/41 P0.8).
    approve:   { via: ['revert'], back: true },
    negotiate: { via: ['revert', 'counterparty'], back: true },
    draft:     { via: ['revert'], back: true },
    active:    { via: ['signature', 'manual'] },
    closed:    { via: ['cancel'] },
  },
  active: {
    closed:    { via: ['dates', 'manual', 'agent', 'system'] },
  },
  closed: {
    // An admin undoing a cancellation (the stage it came from), or a renewed
    // contract whose new expiry date is in the future again.
    request:   { via: ['undo_cancel'] },
    draft:     { via: ['undo_cancel'] },
    negotiate: { via: ['undo_cancel'] },
    approve:   { via: ['undo_cancel'] },
    sign:      { via: ['undo_cancel'] },
    active:    { via: ['dates', 'undo_cancel'] },
  },
}

/** Stages a contract can be cancelled from: any before it is signed. */
export const CANCELLABLE: readonly Stage[] = ['request', 'draft', 'negotiate', 'approve', 'sign']

export interface TransitionCheck {
  from: StagePoint
  to: StagePoint
  source: TransitionSource
  reason?: string | null
  /** The actor may undo a cancellation (an admin). */
  isAdmin?: boolean
}

/** Why a move isn't allowed, or null when it is. Pure. */
export function transitionRefusal(c: TransitionCheck): string | null {
  const { from, to, source } = c
  if (!isStage(to.stage) || !isStateOf(to.stage, to.state)) return `“${to.stage}/${to.state}” is not a stage and state a contract can be in.`
  // Putting back where it was before a move just made (the caller checks it is that move).
  if (source === 'undo') return null
  if (to.stage === 'closed' && to.state === 'cancelled') {
    if (!CANCELLABLE.includes(from.stage)) return `A contract can only be cancelled before it is signed (this one is ${STAGE_LABEL[from.stage]}).`
    if (!c.reason?.trim()) return 'Say why the contract is cancelled.'
    return null
  }
  if (from.stage === 'closed' && from.state === 'cancelled' && to.stage !== 'closed') {
    if (source !== 'undo_cancel') return 'A cancelled contract can only be brought back by an admin, with a reason.'
    if (!c.isAdmin) return 'Only an admin can bring a cancelled contract back.'
    if (!c.reason?.trim()) return 'Say why the contract is brought back.'
    return null
  }
  if (from.stage === to.stage) {
    // A change of state or turn within the stage: the flow decides. Closed
    // states are final, except expired after a new expiry date.
    if (from.stage === 'closed' && from.state !== to.state && !(from.state === 'expired' && to.state === 'archived')) {
      return `A ${STATE_LABEL[from.state].toLowerCase()} contract stays ${STATE_LABEL[from.state].toLowerCase()}.`
    }
    return null
  }
  // Only an expired contract comes back on dates (renewed, or extended).
  if (from.stage === 'closed' && from.state !== 'expired' && from.state !== 'cancelled') {
    return `A ${STATE_LABEL[from.state].toLowerCase()} contract stays closed; only an expired one comes back when its dates change.`
  }
  // A declined approval means "do not proceed": nothing — by hand, the
  // assistant or the signing flow — takes it on to signature or into force.
  // It goes back to drafting (or is submitted again) first.
  if (from.stage === 'approve' && from.state === 'declined' && (to.stage === 'sign' || to.stage === 'active')) {
    return 'The approval was declined, so this contract can’t go to signature or be marked signed. Change it and submit it for approval again, or cancel it.'
  }
  const rule = TRANSITIONS[from.stage][to.stage]
  if (!rule) {
    if (from.stage === 'active' && (to.stage === 'negotiate' || to.stage === 'draft')) {
      return 'A signed contract is not reopened. Changes after signature are made with an amendment.'
    }
    return `A contract can't move from ${STAGE_LABEL[from.stage]} to ${STAGE_LABEL[to.stage]}.`
  }
  if (!rule.via.includes(source)) {
    if (to.stage === 'approve') return 'A contract goes to approval by being submitted for approval.'
    if (to.stage === 'sign') return 'A contract goes to signature by sending it for signature.'
    return `A contract can't be moved from ${STAGE_LABEL[from.stage]} to ${STAGE_LABEL[to.stage]} this way.`
  }
  if (rule.back && !c.reason?.trim() && source !== 'counterparty' && source !== 'edit' && source !== 'approval') {
    return `Say why it goes back to ${STAGE_LABEL[to.stage]}.`
  }
  return null
}

// ─── Words ────────────────────────────────────────────────────────────────────

export const STAGE_LABEL: Record<Stage, string> = {
  request: 'Request', draft: 'Draft', negotiate: 'Negotiate', approve: 'Approve',
  sign: 'Sign', active: 'Active', closed: 'Closed',
}

export const STATE_LABEL: Record<StageState, string> = {
  submitted: 'Submitted', in_triage: 'In triage', more_info: 'More information needed',
  drafting: 'Drafting', ready: 'Ready', returned: 'Returned for changes',
  with_us: 'With us', with_counterparty: 'With the counterparty',
  pending: 'Waiting for approval', approved: 'Approved', declined: 'Declined',
  out_for_signature: 'Out for signature', voided: 'Signature voided',
  active: 'Active', expiring: 'Expiring soon', auto_renewed: 'Renewed automatically', renewing: 'Renewing',
  expired: 'Expired', terminated: 'Terminated', superseded: 'Superseded', cancelled: 'Cancelled', archived: 'Archived',
}

export const TURN_LABEL: Record<Turn, string> = {
  internal: 'Our turn', counterparty: "Counterparty's turn", approvers: "Approvers' turn", signers: "Signers' turn", none: '',
}

/** "Sign (signature voided)": a stage and its state, for refusals and messages. */
export function stagePhrase(stage: Stage, state: StageState): string {
  const s = STATE_LABEL[state]
  return s && s.toLowerCase() !== STAGE_LABEL[stage].toLowerCase() ? `${STAGE_LABEL[stage]} (${s.toLowerCase()})` : STAGE_LABEL[stage]
}

/** The stages the banner's progress bar shows, in order (Closed is shown as a state of the last). */
export const PROGRESS_STAGES: readonly Stage[] = ['request', 'draft', 'negotiate', 'approve', 'sign', 'active']

/** "2 days", "3 hours", "just now": how long the turn has stood. */
export function sinceWords(since: Date | string | null | undefined, now: Date = new Date()): string | null {
  if (!since) return null
  const t = since instanceof Date ? since.getTime() : new Date(since).getTime()
  if (Number.isNaN(t)) return null
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60000))
  if (mins < 60) return mins < 2 ? 'just now' : `${mins} minutes`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** "Negotiate · Counterparty's turn · 2 days": the banner's line. */
export function stageLine(c: { stage: Stage; stageState: StageState; turn: Turn; turnSince?: Date | string | null }, now?: Date): string {
  const parts: string[] = [STAGE_LABEL[c.stage]]
  const state = STATE_LABEL[c.stageState]
  // The state says something the stage doesn't (not "Active · Active").
  if (state && state.toLowerCase() !== STAGE_LABEL[c.stage].toLowerCase() && !(c.stage === 'negotiate' && c.stageState !== 'returned')) parts.push(state)
  if (c.turn !== 'none') {
    parts.push(TURN_LABEL[c.turn])
    const since = sinceWords(c.turnSince ?? null, now)
    if (since && since !== 'just now') parts.push(since)
  }
  return parts.join(' · ')
}

// ─── Approval reset rules (docs/41 Part 18) ───────────────────────────────────

/**
 * When an approval already given is asked for again, per workflow step:
 *   - always: any change at all (a new version, or a change to its terms);
 *   - any_document_change: a new version of the document;
 *   - clause_text_changes: the text of a clause of the listed types changes
 *     (all clause types when none are listed);
 *   - fields: one of the listed fields changes (type, value, currency, a custom field…);
 *   - never.
 * A clause exception resets only when its own clause's text changes.
 */
export type ResetMode = 'always' | 'any_document_change' | 'clause_text_changes' | 'fields' | 'never'
export interface ResetRule { mode: ResetMode; clauseTypes?: string[]; fields?: string[] }

export const RESET_MODES: readonly ResetMode[] = ['always', 'any_document_change', 'clause_text_changes', 'fields', 'never']

/** A step's rule as stored (a word or an object), read leniently; `always` when unset. */
export function readResetRule(raw: unknown): ResetRule {
  if (typeof raw === 'string' && (RESET_MODES as readonly string[]).includes(raw)) return { mode: raw as ResetMode }
  if (raw && typeof raw === 'object') {
    const r = raw as { mode?: unknown; clauseTypes?: unknown; fields?: unknown }
    const list = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
    if (Array.isArray((raw as { fields?: unknown }).fields) && r.mode === undefined) return { mode: 'fields', fields: list(r.fields) }
    if (typeof r.mode === 'string' && (RESET_MODES as readonly string[]).includes(r.mode)) {
      return { mode: r.mode as ResetMode, ...(r.mode === 'clause_text_changes' && { clauseTypes: list(r.clauseTypes) }), ...(r.mode === 'fields' && { fields: list(r.fields) }) }
    }
  }
  return { mode: 'always' }
}

/** What changed, as the reset rules read it. */
export interface ChangeSet {
  /** A new version of the document was made. */
  document: boolean
  /** Clause types whose text changed (added, removed or edited). `null`: not known (treat every clause as changed). */
  clauseTypes: string[] | null
  /** Fields that changed. */
  fields: string[]
}

/** Whether an approval given under `rule` is asked for again after `change`. Pure. */
export function resets(rule: ResetRule, change: ChangeSet): boolean {
  switch (rule.mode) {
    case 'never': return false
    case 'always': return change.document || change.fields.length > 0
    case 'any_document_change': return change.document
    case 'clause_text_changes': {
      if (!change.document) return false
      if (change.clauseTypes === null) return true
      const covered = rule.clauseTypes ?? []
      return covered.length === 0 ? change.clauseTypes.length > 0 : change.clauseTypes.some(t => covered.includes(t))
    }
    case 'fields': return (rule.fields ?? []).some(f => change.fields.includes(f))
  }
}

/** "Reset when covered clauses change": the rule in words, for the workflow builder and notifications. */
export function resetRuleWords(rule: ResetRule): string {
  switch (rule.mode) {
    case 'always': return 'Ask again after any change'
    case 'any_document_change': return 'Ask again when the document changes'
    case 'clause_text_changes': return rule.clauseTypes?.length ? `Ask again when these clauses change: ${rule.clauseTypes.join(', ')}` : 'Ask again when any clause’s text changes'
    case 'fields': return rule.fields?.length ? `Ask again when these fields change: ${rule.fields.join(', ')}` : 'Ask again when listed fields change'
    case 'never': return 'Never ask again'
  }
}

// ─── Approval outcomes (docs/41 Part 4) ───────────────────────────────────────

/**
 * An approver's decision on a request for approval of one version:
 *   - approved;
 *   - returned: changes needed — the contract goes back to its working stage,
 *     the owner fixes it and resubmits;
 *   - declined: do not proceed — the contract stays where it is, and the
 *     owner decides whether to cancel it.
 * `REJECTED` is what older clients (Slack, the assistant) send: a return.
 */
export type ApprovalDecision = 'APPROVED' | 'RETURNED' | 'DECLINED' | 'DELEGATED'
export function readDecision(d: unknown): ApprovalDecision | null {
  if (d === 'REJECTED') return 'RETURNED'
  return d === 'APPROVED' || d === 'RETURNED' || d === 'DECLINED' || d === 'DELEGATED' ? d : null
}

// ─── Requests (docs/41 Parts 4, 18: the Request stage) ───────────────────────

/**
 * How a request moves by hand. Accepting it is drafting it (POST
 * /requests/:id/convert), not a status set here; declining it needs a
 * reason, kept with it and shown to the requester ("Decline request").
 */
export const REQUEST_TRANSITIONS: Record<string, string[]> = {
  SUBMITTED:        ['IN_REVIEW', 'MORE_INFO_NEEDED', 'REJECTED'],
  IN_REVIEW:        ['SUBMITTED', 'MORE_INFO_NEEDED', 'REJECTED'],
  MORE_INFO_NEEDED: ['SUBMITTED', 'IN_REVIEW', 'REJECTED'],
  REJECTED:         ['SUBMITTED'],
  ACCEPTED:         ['COMPLETED'],
  COMPLETED:        [],
}

/** Why a request can't move from `from` to `to`, or null. */
export function requestTransitionRefusal(from: string, to: string, reason?: string | null): string | null {
  if (from === to) return null
  if (to === 'ACCEPTED') return 'A request is accepted by drafting the contract from it.'
  if (!(REQUEST_TRANSITIONS[from] ?? []).includes(to)) return `A request can't move from ${from.toLowerCase().replace(/_/g, ' ')} to ${to.toLowerCase().replace(/_/g, ' ')}.`
  if (to === 'REJECTED' && !reason?.trim()) return 'Say why the request is declined.'
  return null
}
