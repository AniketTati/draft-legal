/**
 * Workflow Engine — Phase 06
 * Central state machine for approval workflows.
 * Production pattern: DB-backed state machine (used by Ironclad, DocuSign CLM, SAP Ariba).
 * All state lives in Postgres (approval_instances + approval_steps).
 * Escalation timers are BullMQ delayed jobs with deterministic IDs for clean cancellation.
 */
import type { PrismaClient } from '@prisma/client'
import { notificationQueue, queueEscalation, queueNotification } from './queue.js'
import { createAuditEvent } from './audit.js'
import { transition, workingStageBefore } from './lifecycle.js'
import { AuditAction, autoApproves, type ResetRule } from '@clm/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowStepDef {
  order:            number
  name:             string
  approverId?:      string   // specific user (singular — legacy / sequential)
  roleRequired?:    string   // fallback: org user(s) with matching role
  // Wave 3.8 — plural approvers so a `parallel` step can name the full set of
  // concurrent approvers. Both are optional and additive; singular fields still
  // work for existing stored definitions.
  approverIds?:     string[] // specific users (parallel)
  roleRequireds?:   string[] // roles → all matching org users (parallel)
  executionMode:    'sequential' | 'parallel'
  requiredApprovals: number  // for parallel: how many of N must approve (1 = any-one)
  dueSoonHours:     number   // default 48 — used to set escalateAt
  escalateTo?:      string   // userId to reassign to on timeout
  // docs/41 Part 18 — when an approval given at this step is asked for again
  // after a change (packages/types lifecycle.ts readResetRule; `always` when unset).
  resetOn?:         ResetRule | ResetRule['mode']
}

// ─── Pure decision helper (Wave 3.8) ─────────────────────────────────────────
// Given the ApprovalStep rows at the current stepOrder, decide whether the
// batch is rejected, resolved (approved), and which PENDING siblings should be
// closed. Pure + exported so the parallel N-of-M semantics are unit-testable
// without a database. Semantics:
//   • any REJECTED at this order → the whole workflow fails (anyRejected).
//   • parallel: resolved as soon as `requiredApprovals` APPROVE (short-circuit);
//     requiredApprovals is clamped to [1, number of steps] so it can't be
//     unsatisfiable. Remaining PENDING siblings are returned to be SKIPPED.
//   • sequential: resolved when the single approver APPROVED and none pending.

export function evaluateApprovalBatch(
  steps: Array<{ id: string; status: string; decision: string | null }>,
  executionMode: 'sequential' | 'parallel',
  requiredApprovals: number,
): { anyRejected: boolean; batchResolved: boolean; leftoverPendingIds: string[] } {
  const anyRejected = steps.some(s => s.decision === 'REJECTED')
  const approvedCount = steps.filter(s => s.decision === 'APPROVED').length
  const pendingCount = steps.filter(s => s.status === 'PENDING').length

  // Clamp requiredApprovals so an over-configured parallel step can't deadlock.
  // The ceiling is the number of steps that can still yield an approval
  // (already-approved + still-pending) — NOT steps.length: delegation and
  // escalation ADD terminal DELEGATED/ESCALATED rows at the same order without
  // freeing the slot they replaced, so steps.length overcounts and would let
  // the ceiling drift back up to an unsatisfiable value, stranding the batch.
  const approvableCount = approvedCount + pendingCount
  const req = Math.min(
    Math.max(1, requiredApprovals),
    executionMode === 'parallel' && approvableCount > 0 ? approvableCount : Infinity,
  )

  const batchResolved = executionMode === 'parallel'
    ? approvedCount >= req
    : approvedCount >= 1 && pendingCount === 0

  const leftoverPendingIds = (batchResolved && !anyRejected)
    ? steps.filter(s => s.status === 'PENDING').map(s => s.id)
    : []

  return { anyRejected, batchResolved, leftoverPendingIds }
}

// ─── Helper: cancel escalation job ────────────────────────────────────────────

export async function cancelEscalation(stepId: string): Promise<void> {
  try {
    await notificationQueue.remove(`escalate-${stepId}`)
  } catch {
    // No-op — job may have already run or never existed
  }
}

// ─── Who a step is assigned to (docs/41 Part 6) ──────────────────────────────
// A sequential step for a role went to the first user holding the role
// (`userRoles[0]`), so the other holders never saw it. Now it waits in the
// role's pool: one step with `approverRoleId` and no approver; every holder
// sees it, and the first to decide claims it (approverId is set then).

export interface Assignees {
  /** People each given a step of their own. */
  userIds: string[]
  /** A role whose holders share one step, and who holds it now. */
  pool?: { roleId: string; roleName: string; holderIds: string[] }
}

/** The role ids a user holds (for pooled steps). */
export async function roleIdsOf(userId: string, prisma: PrismaClient): Promise<string[]> {
  return (await prisma.userRole.findMany({ where: { userId }, select: { roleId: true } })).map(r => r.roleId)
}

/** The active members of the org holding a role. */
export async function holdersOf(roleId: string, orgId: string, prisma: PrismaClient): Promise<string[]> {
  return (await prisma.userRole.findMany({
    where: { roleId, user: { orgId, deletedAt: null, status: 'ACTIVE' } },
    select: { userId: true },
  })).map(r => r.userId)
}

/** The org's role of that name (its own, or the system's). */
async function roleNamed(name: string, orgId: string, prisma: PrismaClient): Promise<{ id: string; name: string } | null> {
  return prisma.role.findFirst({ where: { name, OR: [{ orgId }, { orgId: null }] }, orderBy: { orgId: { sort: 'desc', nulls: 'last' } }, select: { id: true, name: true } })
}

/** Who a step definition is assigned to: named people, or a sequential role's pool. */
export async function resolveAssignees(stepDef: WorkflowStepDef, orgId: string, prisma: PrismaClient): Promise<Assignees> {
  const named = [...(stepDef.approverIds ?? []), ...(stepDef.approverId ? [stepDef.approverId] : [])].filter(Boolean)
  const roles = [...(stepDef.roleRequireds ?? []), ...(stepDef.roleRequired ? [stepDef.roleRequired] : [])].filter(Boolean)
  if (stepDef.executionMode !== 'parallel' && named.length === 0 && roles.length > 0) {
    const role = await roleNamed(roles[0], orgId, prisma)
    if (!role) return { userIds: [] }
    const holderIds = await holdersOf(role.id, orgId, prisma)
    return holderIds.length ? { userIds: [], pool: { roleId: role.id, roleName: role.name, holderIds } } : { userIds: [] }
  }
  return { userIds: await resolveApprovers(stepDef, orgId, prisma) }
}

/** Whether a step has anyone to decide it. */
export const hasAssignees = (a: Assignees) => a.userIds.length > 0 || !!a.pool?.holderIds.length

/** Everyone who may decide a step now: its approver, or its role's holders. */
export async function deciderIdsOf(step: { approverId: string | null; approverRoleId: string | null; orgId: string }, prisma: PrismaClient): Promise<string[]> {
  if (step.approverId) return [step.approverId]
  if (step.approverRoleId) return holdersOf(step.approverRoleId, step.orgId, prisma)
  return []
}

// ─── Helper: create ApprovalStep rows for a step definition ──────────────────
// Wave 3.8 — ONE ApprovalStep per resolved approver at the same stepOrder
// (a parallel step's whole concurrent set, for N-of-M); a role's pool is one
// step for all its holders.

export async function createStepsForDef(
  prisma: PrismaClient,
  instance: { id: string; orgId: string; contractId: string },
  stepDef: WorkflowStepDef,
  assignees: Assignees,
): Promise<Array<{ id: string; approverId: string | null; approverRoleId: string | null; notify: string[] }>> {
  const dueSoonHours = stepDef.dueSoonHours ?? 48
  const escalateAt = new Date(Date.now() + dueSoonHours * 60 * 60 * 1000)
  const delayMs = dueSoonHours * 60 * 60 * 1000
  const rows: Array<{ approverId: string | null; approverRoleId: string | null; notify: string[] }> = [
    ...assignees.userIds.map(id => ({ approverId: id, approverRoleId: null, notify: [id] })),
    ...(assignees.pool ? [{ approverId: null, approverRoleId: assignees.pool.roleId, notify: assignees.pool.holderIds }] : []),
  ]

  const out: Array<{ id: string; approverId: string | null; approverRoleId: string | null; notify: string[] }> = []
  for (const r of rows) {
    const step = await prisma.approvalStep.create({
      data: {
        approvalInstanceId: instance.id,
        orgId:      instance.orgId,
        contractId: instance.contractId,
        kind:       'approval',
        stepOrder:  stepDef.order,
        stepName:   stepDef.name,
        approverId: r.approverId,
        approverRoleId: r.approverRoleId,
        status:     'PENDING',
        escalateAt,
      },
    })
    // Queue escalation delayed job (one per step); the id is stored so a decision cancels it.
    const job = await queueEscalation({ instanceId: instance.id, stepId: step.id, orgId: instance.orgId, escalateTo: stepDef.escalateTo }, delayMs)
    await prisma.approvalStep.update({ where: { id: step.id }, data: { escalationJobId: job.id?.toString() } })
    out.push({ id: step.id, ...r })
  }
  return out
}

/**
 * The step order that follows `current` in a definition: the next one that
 * exists. A definition numbered 0, 2, 5 used to be approved after step 0,
 * because the engine looked for `current + 1` and, finding none, finished.
 */
export function nextStepOrder(stepDefs: Array<{ order: number }>, current: number): number | null {
  const later = stepDefs.map(d => d.order).filter(o => typeof o === 'number' && o > current)
  return later.length ? Math.min(...later) : null
}

/** A decision that ends the round without approval: a return, a decline (older rows: REJECTED). */
export const isNegative = (decision: string | null | undefined) => decision === 'RETURNED' || decision === 'DECLINED' || decision === 'REJECTED'

// ─── Main engine: advanceWorkflow ─────────────────────────────────────────────
//
// Called after every step decision. Reads current state and moves the
// instance — and, through lib/lifecycle.ts, the contract — on.

export async function advanceWorkflow(instanceId: string, prisma: PrismaClient): Promise<void> {
  const instance = await prisma.approvalInstance.findUnique({
    where:   { id: instanceId },
    include: { steps: true, definition: true },
  })
  if (!instance) throw new Error(`advanceWorkflow: instance not found: ${instanceId}`)
  if (instance.status !== 'PENDING' && instance.status !== 'ESCALATED') return // already terminal

  const stepDefs: WorkflowStepDef[] = Array.isArray(instance.definition?.steps)
    ? (instance.definition!.steps as unknown as WorkflowStepDef[])
    : []

  const currentDef = stepDefs.find(d => d.order === instance.currentStepOrder)
  const currentSteps = instance.steps.filter(s => s.stepOrder === instance.currentStepOrder && s.kind === 'approval')
  const executionMode = currentDef?.executionMode ?? 'sequential'

  // Decide the batch outcome (pure — see evaluateApprovalBatch).
  const { anyRejected, batchResolved, leftoverPendingIds } = evaluateApprovalBatch(
    currentSteps.map(s => ({ ...s, decision: isNegative(s.decision) ? 'REJECTED' : s.decision })), executionMode, currentDef?.requiredApprovals ?? 1,
  )

  // ── Case 1: returned or declined → the round ends ─────────────────────────
  if (anyRejected) {
    const by = currentSteps.find(s => isNegative(s.decision))!
    await closeRound(prisma, instance, by)
    return
  }

  // ── Case 2: Is the current batch resolved (required approvals met)? ────────
  if (!batchResolved) return // still waiting for more decisions at this step

  // Wave 3.8 — close any still-PENDING siblings of a parallel step that
  // short-circuited on the required count.
  if (leftoverPendingIds.length > 0) {
    await Promise.all(leftoverPendingIds.map(id => cancelEscalation(id)))
    await prisma.approvalStep.updateMany({
      where: { id: { in: leftoverPendingIds } },
      data:  { status: 'SKIPPED', decidedAt: new Date() },
    })
  }

  // ── Case 3: Batch resolved as APPROVED — the next existing step, or done ──
  // A later step whose approval still stands (it was not reset by a change,
  // lib/approval-reset.ts) isn't asked again.
  const stillApproved = (order: number) => {
    const def = stepDefs.find(d => d.order === order)
    const approvedAt = instance.steps.filter(s => s.kind === 'approval' && s.stepOrder === order && s.status === 'APPROVED')
    return approvedAt.length > 0 && evaluateApprovalBatch(approvedAt, def?.executionMode ?? 'sequential', def?.requiredApprovals ?? 1).batchResolved
  }
  let nextOrder = nextStepOrder(stepDefs, instance.currentStepOrder)
  while (nextOrder != null && stillApproved(nextOrder)) nextOrder = nextStepOrder(stepDefs, nextOrder)
  const nextStepDef = nextOrder == null ? undefined : stepDefs.find(d => d.order === nextOrder)
  const contract = await prisma.contract.findUnique({ where: { id: instance.contractId }, select: { title: true, ownerId: true } })

  if (!nextStepDef) {
    const done = await prisma.approvalInstance.updateMany({
      where: { id: instanceId, status: { in: ['PENDING', 'ESCALATED'] } },
      data:  { status: 'APPROVED', outcome: 'approved', decidedAt: new Date() },
    })
    if (!done.count) return
    createAuditEvent({
      orgId:        instance.orgId,
      action:       AuditAction.APPROVAL_DECIDED,
      resourceType: 'approval_instance',
      resourceId:   instanceId,
      metadata:     { decision: 'APPROVED', contractId: instance.contractId },
    }).catch(() => {})
    const last = [...instance.steps].filter(s => s.decision === 'APPROVED').sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))[0]
    // Ready to sign — only while it is still waiting on this approval (X24 follow-up).
    await transition({
      orgId: instance.orgId, contractId: instance.contractId, source: 'approval',
      to: { stage: 'approve', state: 'approved' }, onlyFrom: [{ stage: 'approve', state: 'pending' }],
      userId: last?.approverId, versionId: instance.versionId, extra: { instanceId },
    })
    for (const userId of new Set([instance.submittedById, contract?.ownerId].filter((x): x is string => !!x))) {
      queueNotification({
        orgId:        instance.orgId,
        userId,
        type:         'APPROVAL_DECIDED',
        title:        'Contract approved',
        body:         `"${contract?.title ?? 'Contract'}" has been fully approved. It can be sent for signature.`,
        resourceType: 'contract',
        resourceId:   instance.contractId,
      })
    }
    return
  }

  await prisma.approvalInstance.update({
    where: { id: instanceId },
    data:  { currentStepOrder: nextStepDef.order },
  })
  const assignees = await resolveAssignees(nextStepDef, instance.orgId, prisma)
  if (!hasAssignees(assignees)) {
    // Stuck: nobody holds the step. The Team inbox lists it ("no approver");
    // the submitter is told rather than left waiting.
    console.warn('[workflow-engine] no approvers for step %d of %s — the approval is stuck', nextStepDef.order, instanceId)
    queueNotification({
      orgId:        instance.orgId,
      userId:       instance.submittedById,
      type:         'APPROVAL_DECIDED',
      title:        'Approval stuck: no approver',
      body:         `"${contract?.title ?? 'Contract'}" reached "${nextStepDef.name}", which no one can approve. Ask an admin to fix the workflow.`,
      resourceType: 'contract',
      resourceId:   instance.contractId,
    })
    return
  }

  const created = await createStepsForDef(prisma, instance, nextStepDef, assignees)
  const people = await prisma.user.findMany({ where: { id: { in: created.flatMap(s => s.notify) } }, select: { id: true, email: true } })
  const emailById = new Map(people.map(u => [u.id, u.email]))
  for (const s of created) {
    for (const userId of s.notify) {
      queueNotification({
        orgId:        instance.orgId,
        userId,
        type:         'APPROVAL_REQUEST',
        title:        'Contract awaiting your approval',
        body:         `"${contract?.title ?? 'Contract'}" requires your approval (${nextStepDef.name})${s.approverRoleId ? ' — any one of your role can decide' : ''}.`,
        resourceType: 'approval_step',
        resourceId:   s.id,
        email:        emailById.get(userId) ?? undefined,
      })
    }
  }
}

/**
 * docs/41 Part 4 — the round ends without approval.
 *   - Returned (changes needed): the contract goes back to the stage it was
 *     worked in (Negotiate if it was negotiating, otherwise Draft), state
 *     "returned", the owner's turn.
 *   - Declined (do not proceed): it stays in Approve, state "declined", the
 *     owner's turn to decide whether to cancel it.
 * Either way the owner and the submitter are told who and why.
 */
async function closeRound(
  prisma: PrismaClient,
  instance: { id: string; orgId: string; contractId: string; submittedById: string; versionId: string | null; steps: Array<{ id: string; status: string }> },
  by: { approverId: string | null; decision: string | null; comment: string | null },
): Promise<void> {
  const outcome = by.decision === 'DECLINED' ? 'declined' : 'returned'
  const pending = instance.steps.filter(s => s.status === 'PENDING')
  await Promise.all(pending.map(s => cancelEscalation(s.id)))
  const [, closed] = await prisma.$transaction([
    // The others at this round had nothing left to decide.
    prisma.approvalStep.updateMany({ where: { approvalInstanceId: instance.id, status: 'PENDING' }, data: { status: 'SKIPPED', decidedAt: new Date() } }),
    // `status` keeps its older value for readers of it: REJECTED.
    prisma.approvalInstance.updateMany({ where: { id: instance.id, status: { in: ['PENDING', 'ESCALATED'] } }, data: { status: 'REJECTED', outcome, decidedAt: new Date() } }),
  ])
  if (!closed.count) return

  createAuditEvent({
    orgId:        instance.orgId,
    action:       AuditAction.APPROVAL_DECIDED,
    resourceType: 'approval_instance',
    resourceId:   instance.id,
    metadata:     { decision: outcome === 'declined' ? 'DECLINED' : 'RETURNED', outcome, contractId: instance.contractId },
  }).catch(() => {})

  const reason = by.comment?.trim() || null
  const moved = outcome === 'returned'
    ? await transition({
        orgId: instance.orgId, contractId: instance.contractId, source: 'approval',
        to: { stage: await workingStageBefore(instance.orgId, instance.contractId), state: 'returned' },
        onlyFrom: [{ stage: 'approve', state: 'pending' }],
        userId: by.approverId, reason, versionId: instance.versionId, extra: { instanceId: instance.id, outcome },
      })
    : await transition({
        orgId: instance.orgId, contractId: instance.contractId, source: 'approval',
        to: { stage: 'approve', state: 'declined' },
        onlyFrom: [{ stage: 'approve', state: 'pending' }],
        userId: by.approverId, reason, versionId: instance.versionId, extra: { instanceId: instance.id, outcome },
      })

  // docs/41 P0.6 — who returned it and why, to the submitter and the owner.
  const contract = await prisma.contract.findUnique({ where: { id: instance.contractId }, select: { title: true, ownerId: true } })
  const who = by.approverId ? await prisma.user.findUnique({ where: { id: by.approverId }, select: { name: true, email: true } }) : null
  const name = who?.name || who?.email || null
  const stageNow = moved.ok && moved.changed ? moved.to.stage : null
  for (const userId of new Set([instance.submittedById, contract?.ownerId].filter((x): x is string => !!x))) {
    queueNotification({
      orgId:        instance.orgId,
      userId,
      type:         'APPROVAL_DECIDED',
      title:        outcome === 'declined' ? 'Contract declined' : 'Contract returned for changes',
      body:         outcome === 'declined'
        ? declinedBody(contract?.title ?? 'Contract', name, reason)
        : returnedBody(contract?.title ?? 'Contract', name, reason, stageNow === 'draft' || stageNow === 'negotiate' ? stageNow : null),
      resourceType: 'contract',
      resourceId:   instance.contractId,
    })
  }
}

/** docs/41 P0.6 — the notification a returned approval sends: who, why, and where the contract is now. */
export function returnedBody(title: string, by: string | null, reason: string | null, backTo: 'draft' | 'negotiate' | boolean | null): string {
  const who = by ? `${by} returned` : 'An approver returned'
  const why = reason?.trim() ? `: “${reason.trim()}”` : '.'
  const stage = backTo === true ? 'draft' : backTo || null
  return `${who} "${title}" for changes${why}${stage ? ` It is back in ${stage === 'negotiate' ? 'Negotiate' : 'Draft'} to fix and resubmit.` : ''}`
}

/** docs/41 Part 4 — the notification a declined approval sends. */
export function declinedBody(title: string, by: string | null, reason: string | null): string {
  const who = by ? `${by} declined` : 'An approver declined'
  const why = reason?.trim() ? `: “${reason.trim()}”` : '.'
  return `${who} "${title}"${why} It should not go ahead as it is: decide whether to cancel it or rework it and resubmit.`
}

// ─── Auto-approval check ─────────────────────────────────────────────────────
// Called before creating an instance. Returns true if the contract matches an
// auto-approve rule in the workflow's triggerRules. The rule itself lives in
// @clm/types (Z3), shared with the web app. Wave 1.6 — it fails CLOSED on an
// unknown value: an editor must not be able to clear the value to skip human
// approval. Z3 — likewise on a value in another currency than the rules'.

export function checkAutoApprove(
  contractType: string,
  contractValue: number | null | undefined,
  triggerRules: Record<string, unknown>,
  contractCurrency?: string | null,
): boolean {
  return autoApproves(triggerRules, { type: contractType, value: contractValue, currency: contractCurrency })
}

// ─── Resolve approverId from a step definition ────────────────────────────────
// Exported so the submit-approval route can use the same logic when creating step 0.

export async function resolveApprover(
  stepDef: WorkflowStepDef,
  orgId: string,
  prisma: PrismaClient,
): Promise<string | null> {
  if (stepDef.approverId) return (await withDelegates([stepDef.approverId], orgId, prisma))[0]

  if (stepDef.roleRequired) {
    const userRole = await prisma.userRole.findFirst({
      where: {
        user: { orgId, deletedAt: null },
        role: { name: stepDef.roleRequired },
      },
      include: { user: true },
    })
    return userRole ? (await withDelegates([userRole.userId], orgId, prisma))[0] : null
  }

  return null
}

// ─── Out of office (Z4) ───────────────────────────────────────────────────────
// Team › Out of office stores who is away, until when, and their delegate, but
// approvals still went to the absent approver. Now an approver who is away,
// with an active delegate in the org, is replaced by the delegate when a step
// is assigned. One hop: a delegate who is also away still gets it. With no
// delegate the approver keeps it, and escalation applies as before.

export async function withDelegates(
  approverIds: string[],
  orgId: string,
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<string[]> {
  if (approverIds.length === 0) return approverIds
  const away = await prisma.user.findMany({
    where:  {
      id: { in: approverIds }, orgId, outOfOffice: true, delegateToId: { not: null },
      OR: [{ outOfOfficeUntil: null }, { outOfOfficeUntil: { gt: now } }],
    },
    select: { id: true, delegateToId: true },
  })
  if (away.length === 0) return approverIds
  const available = new Set((await prisma.user.findMany({
    where:  { id: { in: away.map(u => u.delegateToId!) }, orgId, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  })).map(u => u.id))
  const delegateOf = new Map(away.filter(u => available.has(u.delegateToId!)).map(u => [u.id, u.delegateToId!]))
  // A step with both an approver and their delegate asks the delegate once.
  return [...new Set(approverIds.map(id => delegateOf.get(id) ?? id))]
}

// ─── Resolve the FULL set of approvers for a step (Wave 3.8) ──────────────────
// Plural resolver used by the parallel path. For a sequential step it collapses
// to a single approver so behaviour is unchanged. Falls back cleanly to the
// singular approverId/roleRequired fields for legacy stored definitions.

export async function resolveApprovers(
  stepDef: WorkflowStepDef,
  orgId: string,
  prisma: PrismaClient,
): Promise<string[]> {
  const parallel = stepDef.executionMode === 'parallel'
  const ids = new Set<string>()

  // Explicit approver ids (plural then singular).
  for (const id of stepDef.approverIds ?? []) if (id) ids.add(id)
  if (stepDef.approverId) ids.add(stepDef.approverId)

  // Roles → users. For parallel, every org user holding any named role becomes
  // a concurrent approver; for sequential, only the first (and only if no
  // explicit approver was named).
  const roles = [...(stepDef.roleRequireds ?? []), ...(stepDef.roleRequired ? [stepDef.roleRequired] : [])].filter(Boolean)
  if (roles.length > 0) {
    const userRoles = await prisma.userRole.findMany({
      where: {
        user: { orgId, deletedAt: null },
        role: { name: { in: roles } },
      },
      select: { userId: true },
    })
    if (parallel) {
      for (const ur of userRoles) ids.add(ur.userId)
    } else if (ids.size === 0 && userRoles[0]) {
      ids.add(userRoles[0].userId)
    }
  }

  const all = [...ids]
  // Sequential always collapses to a single approver.
  return withDelegates(parallel ? all : all.slice(0, 1), orgId, prisma)
}

// ─── Progress (docs/41 Parts 12, 18) ─────────────────────────────────────────

/**
 * "Approvals 1 of 3": the steps of the workflow approved so far, of all its
 * steps. Counted by step of the definition, not by row: a parallel step's
 * three approvers, a delegation or a reset don't count three times.
 */
export function approvalProgress(instance: {
  status: string
  steps: Array<{ stepOrder: number; status: string; decision: string | null; kind?: string }>
  definition?: { steps: unknown } | null
}): { approved: number; total: number } {
  const defs = (Array.isArray(instance.definition?.steps) ? instance.definition!.steps : []) as WorkflowStepDef[]
  const steps = instance.steps.filter(s => (s.kind ?? 'approval') === 'approval')
  const orders = defs.length ? defs.map(d => d.order) : [...new Set(steps.map(s => s.stepOrder))]
  if (instance.status === 'APPROVED' || instance.status === 'AUTO_APPROVED') return { approved: orders.length, total: orders.length }
  const approved = orders.filter(o => {
    const def = defs.find(d => d.order === o)
    const at = steps.filter(s => s.stepOrder === o && s.status === 'APPROVED')
    return at.length > 0 && evaluateApprovalBatch(at.map((s, i) => ({ id: String(i), status: s.status, decision: s.decision })), def?.executionMode ?? 'sequential', def?.requiredApprovals ?? 1).batchResolved
  }).length
  return { approved, total: orders.length }
}
