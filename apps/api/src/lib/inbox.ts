/**
 * docs/41 Part 6 — the inbox: one list per question, counted by contract.
 *
 * The Approvals page counted two different things under labels that didn't
 * say so (steps waiting on me; every open workflow), and the badge came from
 * a third query. Now:
 *
 *   - Needs my action: contracts waiting on me, each once, with what I must
 *     do — approve (my step, or my role's pooled step), decide an exception,
 *     fix and resubmit (returned, I own it), decide after a decline, respond
 *     to the counterparty (Negotiate, our turn, mine), send for signature
 *     (approved, mine), take back a voided or declined signature, sign.
 *     The sidebar badge is this list's length (`needsMyActionCount` is the
 *     same query).
 *   - Waiting on others: contracts I own or submitted that someone else has,
 *     who has them and since when.
 *   - Team (configure:workflow): every contract in flight, with what it
 *     waits on; filters for stuck (an approval step nobody can decide),
 *     aging (the turn older than N days) and stage.
 * Deleted contracts and a diligence room's are never listed.
 */
import { stageLine, sinceWords, STAGE_LABEL, type Stage, type StageState, type Turn } from '@clm/types'
import { prisma } from './prisma.js'
import { approvalProgress, roleIdsOf, holdersOf } from './workflow-engine.js'
import { positionOf } from './lifecycle.js'

export type InboxActionKind =
  | 'approve' | 'decide_exception' | 'sign'
  | 'fix_and_resubmit' | 'decide_declined' | 'respond_to_counterparty'
  | 'send_for_signature' | 'take_back_signature'

/** The order actions lead a row in, most pressing first. */
const PRIORITY: InboxActionKind[] = ['approve', 'decide_exception', 'sign', 'fix_and_resubmit', 'decide_declined', 'take_back_signature', 'respond_to_counterparty', 'send_for_signature']

const LABEL: Record<InboxActionKind, string> = {
  approve: 'Approve',
  decide_exception: 'Decide exception',
  sign: 'Sign',
  fix_and_resubmit: 'Fix and resubmit',
  decide_declined: 'Declined — decide what next',
  respond_to_counterparty: 'Respond to counterparty',
  send_for_signature: 'Send for signature',
  take_back_signature: 'Signature stopped — take it back',
}

export interface InboxAction {
  kind: InboxActionKind
  label: string
  /** Since when it has waited. */
  since: string
  stepId?: string
  instanceId?: string
  findingId?: string
  signatureRequestId?: string
  /** The step's name, or the reason it came back. */
  detail?: string | null
}

export interface InboxRow {
  contractId: string
  title: string
  type: string
  counterpartyName: string | null
  value: number | null
  currency: string | null
  stage: Stage
  stageState: StageState
  turn: Turn
  turnSince: string
  /** "Negotiate · Counterparty's turn · 2 days". */
  line: string
  owner: { id: string; name: string }
  actions: InboxAction[]
  /** The action the row leads with. */
  primary: InboxAction | null
  /** Who has it now, by name, and since when (Waiting on others, Team). */
  waitingOn: { who: string; names: string[]; since: string; sinceWords: string | null } | null
  approvals: { approved: number; total: number } | null
  /** Team: an approval nobody can decide. */
  stuck?: string | null
}

const CONTRACT_SELECT = {
  id: true, orgId: true, title: true, type: true, counterpartyName: true, value: true, currency: true,
  status: true, stage: true, stageState: true, turn: true, turnSince: true, turnOwnerId: true, ownerId: true,
  owner: { select: { id: true, name: true, email: true } },
} as const

type ContractRow = Awaited<ReturnType<typeof loadContracts>>[number]

/** Live contracts only: not deleted, not a diligence room's. */
const LIVE = { deletedAt: null, diligenceRoomId: null } as const

function loadContracts(orgId: string, ids: string[]) {
  return prisma.contract.findMany({ where: { orgId, id: { in: ids }, ...LIVE }, select: CONTRACT_SELECT })
}

const iso = (d: Date) => d.toISOString()

/** The approval steps the user may decide now: theirs or their role's, at their request's current step. */
async function myOpenSteps(orgId: string, userId: string) {
  const roleIds = await roleIdsOf(userId, prisma)
  const steps = await prisma.approvalStep.findMany({
    where: {
      orgId, status: 'PENDING',
      OR: [{ approverId: userId }, { approverId: null, approverRoleId: { in: roleIds } }],
    },
    select: { id: true, kind: true, contractId: true, approvalInstanceId: true, stepOrder: true, stepName: true, findingId: true, createdAt: true },
  })
  const instanceIds = [...new Set(steps.map(s => s.approvalInstanceId).filter((x): x is string => !!x))]
  const instances = instanceIds.length
    ? await prisma.approvalInstance.findMany({ where: { id: { in: instanceIds }, orgId, status: { in: ['PENDING', 'ESCALATED'] } }, select: { id: true, contractId: true, currentStepOrder: true } })
    : []
  const byId = new Map(instances.map(i => [i.id, i]))
  // F-66 — a later step isn't anyone's to decide yet.
  return steps
    .map(s => ({ ...s, contractId: s.contractId ?? (s.approvalInstanceId ? byId.get(s.approvalInstanceId)?.contractId ?? null : null) }))
    .filter(s => s.kind === 'clause_exception' || (s.approvalInstanceId && byId.get(s.approvalInstanceId)?.currentStepOrder === s.stepOrder))
}

/** Signatures waiting on the user (a linked signer, their turn in a sequential order). */
async function mySignatures(orgId: string, userId: string) {
  const signers = await prisma.signer.findMany({
    where: { userId, status: 'PENDING', signatureRequest: { is: { orgId, status: 'PENDING' } } },
    select: { id: true, signOrder: true, createdAt: true, signatureRequest: { select: { id: true, contractId: true, signOrder: true, createdAt: true, signers: { select: { signOrder: true, status: true } } } } },
  })
  return signers.filter(s => s.signatureRequest.signOrder !== 'SEQUENTIAL' || !s.signatureRequest.signers.some(o => o.signOrder < s.signOrder && o.status !== 'SIGNED'))
}

/** Pure: one row's actions in order, and the one it leads with. */
export function orderActions(actions: InboxAction[]): { actions: InboxAction[]; primary: InboxAction | null } {
  const sorted = [...actions].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.since.localeCompare(b.since))
  return { actions: sorted, primary: sorted[0] ?? null }
}

/** What each contract waits for from the user. Keys are contract ids. */
async function myActions(orgId: string, userId: string): Promise<Map<string, InboxAction[]>> {
  const out = new Map<string, InboxAction[]>()
  const add = (contractId: string | null, a: Omit<InboxAction, 'label'>) => {
    if (!contractId) return
    out.set(contractId, [...(out.get(contractId) ?? []), { ...a, label: LABEL[a.kind] }])
  }
  const [steps, signatures, mine] = await Promise.all([
    myOpenSteps(orgId, userId),
    mySignatures(orgId, userId),
    // Contracts whose move is mine: returned, declined, our turn in a
    // negotiation, approved and ready to send, a signature that stopped.
    prisma.contract.findMany({
      where: {
        orgId, ...LIVE,
        OR: [
          { ownerId: userId, stageState: 'returned' },
          { ownerId: userId, stage: 'approve', stageState: 'declined' },
          { ownerId: userId, stage: 'approve', stageState: 'approved' },
          { ownerId: userId, stage: 'sign', stageState: { in: ['declined', 'voided'] } },
          { stage: 'negotiate', stageState: 'with_us', turn: 'internal', turnOwnerId: userId },
        ],
      },
      select: { id: true, stage: true, stageState: true, turnSince: true },
    }),
  ])
  for (const s of steps) {
    add(s.contractId, s.kind === 'clause_exception'
      ? { kind: 'decide_exception', since: iso(s.createdAt), stepId: s.id, findingId: s.findingId ?? undefined, detail: s.stepName.replace(/^Exception: /, '') }
      : { kind: 'approve', since: iso(s.createdAt), stepId: s.id, instanceId: s.approvalInstanceId ?? undefined, detail: s.stepName })
  }
  for (const s of signatures) add(s.signatureRequest.contractId, { kind: 'sign', since: iso(s.signatureRequest.createdAt), signatureRequestId: s.signatureRequest.id })
  // The reason a returned or declined contract came back.
  const backIds = mine.filter(c => c.stageState === 'returned' || (c.stage === 'approve' && c.stageState === 'declined')).map(c => c.id)
  const reasons = backIds.length ? await prisma.approvalInstance.findMany({
    where: { orgId, contractId: { in: backIds }, status: 'REJECTED' },
    orderBy: { decidedAt: 'desc' },
    select: { contractId: true, steps: { where: { decision: { in: ['RETURNED', 'DECLINED', 'REJECTED'] } }, select: { comment: true }, take: 1 } },
  }) : []
  const reasonOf = (id: string) => reasons.find(r => r.contractId === id)?.steps[0]?.comment ?? null
  for (const c of mine) {
    const since = iso(c.turnSince)
    if (c.stageState === 'returned') add(c.id, { kind: 'fix_and_resubmit', since, detail: reasonOf(c.id) })
    else if (c.stage === 'approve' && c.stageState === 'declined') add(c.id, { kind: 'decide_declined', since, detail: reasonOf(c.id) })
    else if (c.stage === 'approve' && c.stageState === 'approved') add(c.id, { kind: 'send_for_signature', since })
    else if (c.stage === 'sign') add(c.id, { kind: 'take_back_signature', since })
    else if (c.stage === 'negotiate') add(c.id, { kind: 'respond_to_counterparty', since })
  }
  return out
}

/** Who a contract waits on, by name: its approvers, its signers, the counterparty, or its owner. */
async function waitingOn(contracts: ContractRow[]): Promise<Map<string, InboxRow['waitingOn'] & { approvals: InboxRow['approvals']; stuck: string | null }>> {
  const out = new Map<string, InboxRow['waitingOn'] & { approvals: InboxRow['approvals']; stuck: string | null }>()
  if (!contracts.length) return out
  const ids = contracts.map(c => c.id)
  const orgId = contracts[0].orgId
  const [instances, requests] = await Promise.all([
    prisma.approvalInstance.findMany({
      where: { orgId, contractId: { in: ids }, status: { in: ['PENDING', 'ESCALATED', 'APPROVED', 'AUTO_APPROVED'] } },
      orderBy: { submittedAt: 'desc' },
      select: { id: true, contractId: true, status: true, currentStepOrder: true, definition: { select: { steps: true } }, steps: { select: { stepOrder: true, status: true, decision: true, kind: true, approverId: true, approverRoleId: true, createdAt: true } } },
    }),
    prisma.signatureRequest.findMany({
      where: { orgId, contractId: { in: ids }, status: 'PENDING' },
      select: { contractId: true, signers: { where: { status: 'PENDING' }, select: { name: true } } },
    }),
  ])
  const userIds = new Set<string>(contracts.map(c => c.turnOwnerId).filter((x): x is string => !!x))
  const roleIds = new Set<string>()
  for (const i of instances) for (const s of i.steps) { if (s.approverId) userIds.add(s.approverId); if (s.approverRoleId) roleIds.add(s.approverRoleId) }
  const [users, roles] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, email: true, status: true, deletedAt: true } }),
    roleIds.size ? prisma.role.findMany({ where: { id: { in: [...roleIds] } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  const nameOf = (id: string | null) => { const u = id ? users.find(x => x.id === id) : null; return u?.name || u?.email || 'someone' }
  const holders = new Map<string, number>()
  for (const r of roleIds) holders.set(r, (await holdersOf(r, orgId, prisma)).length)

  for (const c of contracts) {
    const inst = instances.find(i => i.contractId === c.id)
    const since = iso(c.turnSince)
    let who = ''
    let names: string[] = []
    let stuck: string | null = null
    if (c.turn === 'approvers' && !(inst && (inst.status === 'PENDING' || inst.status === 'ESCALATED'))) {
      // Waiting for approval with no request open (set by hand before
      // approvals were kept, or a request withdrawn): no one can approve it.
      who = 'Approvers'
      stuck = 'Waiting for approval, but no request for approval is open. Submit it again.'
    } else if (c.turn === 'approvers' && inst) {
      const pending = inst.steps.filter(s => s.kind === 'approval' && s.status === 'PENDING' && s.stepOrder === inst.currentStepOrder)
      names = pending.map(s => s.approverId ? nameOf(s.approverId) : `anyone with the ${roles.find(r => r.id === s.approverRoleId)?.name ?? 'approver'} role`)
      who = 'Approvers'
      if (!pending.length) stuck = 'No one is assigned the current approval step.'
      else if (pending.every(s => s.approverId ? users.find(u => u.id === s.approverId)?.status !== 'ACTIVE' || !!users.find(u => u.id === s.approverId)?.deletedAt : !holders.get(s.approverRoleId!))) {
        stuck = 'The current approval step’s approver can’t act (no longer active, or nobody holds the role).'
      }
    } else if (c.turn === 'signers') {
      who = 'Signers'
      names = requests.find(r => r.contractId === c.id)?.signers.map(s => s.name) ?? []
    } else if (c.turn === 'counterparty') {
      who = 'Counterparty'
      names = c.counterpartyName ? [c.counterpartyName] : []
    } else if (c.turn === 'internal') {
      who = nameOf(c.turnOwnerId ?? c.ownerId)
      names = [who]
    }
    out.set(c.id, {
      who, names, since, sinceWords: sinceWords(c.turnSince),
      approvals: inst ? approvalProgress(inst) : null,
      stuck,
    })
  }
  return out
}

function rowOf(c: ContractRow, actions: InboxAction[], wait: (InboxRow['waitingOn'] & { approvals: InboxRow['approvals']; stuck: string | null }) | undefined): InboxRow {
  const p = positionOf(c)
  const ordered = orderActions(actions)
  return {
    contractId: c.id, title: c.title, type: c.type, counterpartyName: c.counterpartyName,
    value: c.value != null ? Number(c.value) : null, currency: c.currency,
    stage: p.stage, stageState: p.stageState, turn: p.turn, turnSince: iso(c.turnSince),
    line: stageLine({ stage: p.stage, stageState: p.stageState, turn: p.turn, turnSince: c.turnSince }),
    owner: { id: c.ownerId, name: c.owner?.name || c.owner?.email || 'Someone' },
    ...ordered,
    waitingOn: wait ? { who: wait.who, names: wait.names, since: wait.since, sinceWords: wait.sinceWords } : null,
    approvals: wait?.approvals ?? null,
    ...(wait?.stuck !== undefined && { stuck: wait.stuck }),
  }
}

/** Needs my action: one row per contract, oldest first. */
export async function needsMyAction(orgId: string, userId: string): Promise<InboxRow[]> {
  const actions = await myActions(orgId, userId)
  const contracts = await loadContracts(orgId, [...actions.keys()])
  const waits = await waitingOn(contracts)
  return contracts
    .map(c => rowOf(c, actions.get(c.id) ?? [], waits.get(c.id)))
    .filter(r => r.actions.length > 0)
    .sort((a, b) => (a.primary?.since ?? '').localeCompare(b.primary?.since ?? ''))
}

/** The badge: the number of rows of Needs my action (the same query). */
export async function needsMyActionCount(orgId: string, userId: string): Promise<number> {
  return (await needsMyAction(orgId, userId)).length
}

const IN_FLIGHT: Stage[] = ['request', 'draft', 'negotiate', 'approve', 'sign']

/** Waiting on others: what I own or submitted that someone else has now. */
export async function waitingOnOthers(orgId: string, userId: string, exclude: Set<string>): Promise<InboxRow[]> {
  const submitted = await prisma.approvalInstance.findMany({
    where: { orgId, submittedById: userId, status: { in: ['PENDING', 'ESCALATED'] } },
    select: { contractId: true },
  })
  const rows = await prisma.contract.findMany({
    where: {
      orgId, ...LIVE, stage: { in: IN_FLIGHT },
      OR: [{ ownerId: userId }, { id: { in: submitted.map(s => s.contractId) } }],
      NOT: { OR: [{ turn: 'internal', turnOwnerId: userId }, { turn: 'internal', turnOwnerId: null }] },
    },
    select: CONTRACT_SELECT,
    orderBy: { turnSince: 'asc' },
    take: 500,
  })
  const contracts = rows.filter(c => !exclude.has(c.id))
  const waits = await waitingOn(contracts)
  return contracts.map(c => rowOf(c, [], waits.get(c.id)))
}

export interface TeamFilters {
  /** Only approvals nobody can decide. */
  stuck?: boolean
  /** Only contracts whose turn is older than this many days. */
  agingDays?: number
  stage?: Stage
}

/** Team: every contract in flight, with what it waits on (Legal Ops). */
export async function teamInFlight(orgId: string, f: TeamFilters, now: Date = new Date()): Promise<InboxRow[]> {
  const rows = await prisma.contract.findMany({
    where: {
      orgId, ...LIVE,
      stage: f.stage ? f.stage : { in: IN_FLIGHT },
      ...(f.agingDays && { turnSince: { lte: new Date(now.getTime() - f.agingDays * 86_400_000) } }),
      ...(f.stuck && { stage: 'approve', stageState: 'pending' }),
    },
    select: CONTRACT_SELECT,
    orderBy: { turnSince: 'asc' },
    take: 500,
  })
  const waits = await waitingOn(rows)
  const out = rows.map(c => rowOf(c, [], waits.get(c.id)))
  return f.stuck ? out.filter(r => !!r.stuck) : out
}

/** "Approve · Waiting for approval": a stage in words, for the filters. */
export const stageWords = (s: Stage) => STAGE_LABEL[s]
