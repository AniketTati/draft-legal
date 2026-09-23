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
import { AuditAction } from '@clm/types'

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

async function cancelEscalation(stepId: string): Promise<void> {
  try {
    await notificationQueue.remove(`escalate-${stepId}`)
  } catch {
    // No-op — job may have already run or never existed
  }
}

// ─── Helper: create ApprovalStep rows for a step definition ──────────────────
// Wave 3.8 — creates ONE ApprovalStep per resolved approver at the same
// stepOrder. For a sequential step that's a single row; for a parallel step
// it's the whole concurrent set, which is what makes N-of-M approvals possible.

async function createStepsForDef(
  prisma: PrismaClient,
  instanceId: string,
  orgId: string,
  stepDef: WorkflowStepDef,
  resolvedApproverIds: string[],
): Promise<string[]> {
  const dueSoonHours = stepDef.dueSoonHours ?? 48
  const escalateAt = new Date(Date.now() + dueSoonHours * 60 * 60 * 1000)
  const delayMs = dueSoonHours * 60 * 60 * 1000

  const stepIds: string[] = []
  for (const approverId of resolvedApproverIds) {
    const step = await prisma.approvalStep.create({
      data: {
        approvalInstanceId: instanceId,
        orgId,
        stepOrder:  stepDef.order,
        stepName:   stepDef.name,
        approverId,
        status:     'PENDING',
        escalateAt,
      },
    })

    // Queue escalation delayed job (one per concurrent approver)
    const job = await queueEscalation({
      instanceId,
      stepId:     step.id,
      orgId,
      escalateTo: stepDef.escalateTo,
    }, delayMs)

    // Store job ID on the step so we can cancel it on decision
    await prisma.approvalStep.update({
      where: { id: step.id },
      data:  { escalationJobId: job.id?.toString() },
    })

    stepIds.push(step.id)
  }

  return stepIds
}

// ─── Main engine: advanceWorkflow ─────────────────────────────────────────────
//
// Called after every step decision. Reads current state and transitions the
// instance (and contract) to the next state. All DB writes in a single transaction.

export async function advanceWorkflow(instanceId: string, prisma: PrismaClient): Promise<void> {
  // Load instance + all steps + workflow definition
  const instance = await prisma.approvalInstance.findUnique({
    where:   { id: instanceId },
    include: { steps: true, definition: true },
  })
  if (!instance) throw new Error(`advanceWorkflow: instance not found: ${instanceId}`)
  if (instance.status !== 'PENDING' && instance.status !== 'ESCALATED') return // already terminal

  const stepDefs: WorkflowStepDef[] = Array.isArray(instance.definition.steps)
    ? (instance.definition.steps as unknown as WorkflowStepDef[])
    : []

  const currentDef = stepDefs.find(d => d.order === instance.currentStepOrder)
  const currentSteps = instance.steps.filter(s => s.stepOrder === instance.currentStepOrder)
  const executionMode = currentDef?.executionMode ?? 'sequential'

  // Decide the batch outcome (pure — see evaluateApprovalBatch).
  const { anyRejected, batchResolved, leftoverPendingIds } = evaluateApprovalBatch(
    currentSteps, executionMode, currentDef?.requiredApprovals ?? 1,
  )

  // ── Case 1: Any step REJECTED → reject the whole workflow ─────────────────
  if (anyRejected) {
    // Cancel all pending escalation jobs at this step
    await Promise.all(currentSteps.filter(s => s.status === 'PENDING').map(s => cancelEscalation(s.id)))

    await prisma.$transaction([
      // Reject all still-pending steps
      prisma.approvalStep.updateMany({
        where: { approvalInstanceId: instanceId, status: 'PENDING' },
        data:  { status: 'REJECTED', decidedAt: new Date() },
      }),
      // Close the instance
      prisma.approvalInstance.update({
        where: { id: instanceId },
        data:  { status: 'REJECTED', decidedAt: new Date() },
      }),
      // Revert contract to DRAFT so submitter can edit and resubmit — if it
      // is still waiting on this approval. X24 follow-up: a contract sent for
      // signature, or moved on by a counterparty's upload, meanwhile keeps
      // its status; a late decision used to overwrite even EXECUTED.
      prisma.contract.updateMany({
        where: { id: instance.contractId, status: 'PENDING_APPROVAL' },
        data:  { status: 'DRAFT' },
      }),
    ])

    createAuditEvent({
      orgId:        instance.orgId,
      action:       AuditAction.APPROVAL_DECIDED,
      resourceType: 'approval_instance',
      resourceId:   instanceId,
      metadata:     { decision: 'REJECTED', contractId: instance.contractId },
    }).catch(() => {})

    // Notify submitter
    const contract = await prisma.contract.findUnique({ where: { id: instance.contractId } })
    queueNotification({
      orgId:        instance.orgId,
      userId:       instance.submittedById,
      type:         'APPROVAL_DECIDED',
      title:        'Contract approval rejected',
      body:         `"${contract?.title ?? 'Contract'}" was rejected and returned to Draft.`,
      resourceType: 'approval_instance',
      resourceId:   instanceId,
    })
    return
  }

  // ── Case 2: Is the current batch resolved (required approvals met)? ────────
  if (!batchResolved) return // still waiting for more decisions at this step

  // Wave 3.8 — the batch is APPROVED. For a parallel step that short-circuited
  // on the required count, close any still-PENDING siblings so their escalation
  // timers don't fire and they stop showing as actionable. (Empty for the
  // sequential path, which required no pending steps to get here.)
  if (leftoverPendingIds.length > 0) {
    await Promise.all(leftoverPendingIds.map(id => cancelEscalation(id)))
    await prisma.approvalStep.updateMany({
      where: { id: { in: leftoverPendingIds } },
      data:  { status: 'SKIPPED', decidedAt: new Date() },
    })
  }

  // ── Case 3: Batch resolved as APPROVED — advance or complete ──────────────
  const nextStepDef = stepDefs.find(d => d.order === instance.currentStepOrder + 1)

  if (!nextStepDef) {
    // All steps complete — approve the contract
    await prisma.$transaction([
      prisma.approvalInstance.update({
        where: { id: instanceId },
        data:  { status: 'APPROVED', decidedAt: new Date() },
      }),
      // Only while it is still waiting on this approval (X24 follow-up).
      prisma.contract.updateMany({
        where: { id: instance.contractId, status: 'PENDING_APPROVAL' },
        data:  { status: 'APPROVED' },
      }),
    ])

    createAuditEvent({
      orgId:        instance.orgId,
      action:       AuditAction.APPROVAL_DECIDED,
      resourceType: 'approval_instance',
      resourceId:   instanceId,
      metadata:     { decision: 'APPROVED', contractId: instance.contractId },
    }).catch(() => {})

    const contract = await prisma.contract.findUnique({ where: { id: instance.contractId } })
    queueNotification({
      orgId:        instance.orgId,
      userId:       instance.submittedById,
      type:         'APPROVAL_DECIDED',
      title:        'Contract approved',
      body:         `"${contract?.title ?? 'Contract'}" has been fully approved.`,
      resourceType: 'approval_instance',
      resourceId:   instanceId,
    })
    return
  }

  // Advance to the next step — resolve approver(s) from def (Wave 3.8: plural
  // for parallel steps, single for sequential).
  const nextApproverIds = await resolveApprovers(nextStepDef, instance.orgId, prisma)
  if (nextApproverIds.length === 0) {
    console.warn('[workflow-engine] no approvers found for step %d (def: %j) — skipping', nextStepDef.order, nextStepDef)
    return
  }

  await prisma.approvalInstance.update({
    where: { id: instanceId },
    data:  { currentStepOrder: nextStepDef.order },
  })

  const newStepIds = await createStepsForDef(prisma, instanceId, instance.orgId, nextStepDef, nextApproverIds)

  // Notify each next approver (one notification per concurrent approver).
  const contract = await prisma.contract.findUnique({ where: { id: instance.contractId } })
  const nextApprovers = await prisma.user.findMany({
    where: { id: { in: nextApproverIds } },
    select: { id: true, email: true },
  })
  const emailById = new Map(nextApprovers.map(u => [u.id, u.email]))
  nextApproverIds.forEach((approverId, i) => {
    queueNotification({
      orgId:        instance.orgId,
      userId:       approverId,
      type:         'APPROVAL_REQUEST',
      title:        'Contract awaiting your approval',
      body:         `"${contract?.title ?? 'Contract'}" requires your approval (${nextStepDef.name}).`,
      resourceType: 'approval_step',
      resourceId:   newStepIds[i],
      email:        emailById.get(approverId) ?? undefined,
    })
  })
}

// ─── Auto-approval check ─────────────────────────────────────────────────────
// Called before creating an instance. Returns true if the contract matches an
// auto-approve rule in the workflow's triggerRules.

export function checkAutoApprove(
  contractType: string,
  contractValue: number | null | undefined,
  triggerRules: Record<string, unknown>,
): boolean {
  const rules = (triggerRules.autoApproveRules as Array<{ contractType: string; maxValue: number }>) ?? []
  for (const rule of rules) {
    const typeMatch = rule.contractType === 'ANY' || rule.contractType === contractType
    // Wave 1.6 — fail CLOSED on unknown value. Previously `contractValue == null
    // || contractValue <= rule.maxValue` meant a contract with no value matched
    // ANY threshold and auto-approved — an editor could clear the value to skip
    // human approval entirely. An unknown value must route to human review.
    const valueMatch = contractValue != null && contractValue <= rule.maxValue
    if (typeMatch && valueMatch) return true
  }
  return false
}

// ─── Resolve approverId from a step definition ────────────────────────────────
// Exported so the submit-approval route can use the same logic when creating step 0.

export async function resolveApprover(
  stepDef: WorkflowStepDef,
  orgId: string,
  prisma: PrismaClient,
): Promise<string | null> {
  if (stepDef.approverId) return stepDef.approverId

  if (stepDef.roleRequired) {
    const userRole = await prisma.userRole.findFirst({
      where: {
        user: { orgId, deletedAt: null },
        role: { name: stepDef.roleRequired },
      },
      include: { user: true },
    })
    return userRole?.userId ?? null
  }

  return null
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
  return parallel ? all : all.slice(0, 1)
}
