/**
 * docs/41 Parts 4, 6, 7 — submitting for approval, deciding a step, and
 * clause exceptions: one implementation for every caller.
 *
 * The web (POST /contracts/:id/submit-approval, /approvals/:id/decide), the
 * bulk decision, Slack and the assistant's approval tools each kept their own
 * copy, and they had drifted (the assistant's route skipped escalation and
 * notifications; Slack rejected with no reason). They all call these now.
 *
 *   - submitForApproval: a new request for approval of the version the
 *     contract stands on (versionId), its first step assigned, the contract
 *     moved to Approve (lib/lifecycle.ts). A resubmission after a return is
 *     a new request; the history keeps both.
 *   - decideStep: approve, return (changes needed), decline (do not
 *     proceed) or delegate one step. A reason is required to return or
 *     decline, and may point at findings and clauses. A pooled role step is
 *     claimed by the first holder who decides it.
 *   - requestException: from a review finding, an approval step of kind
 *     `clause_exception` for the category's clause approver; the finding's
 *     status follows it (exception_requested → approved / declined), which is
 *     what the recommendation policy reads.
 */
import {
  AuditAction, pickWorkflow, stagePhrase, readDecision, transitionRefusal, statusFor,
  type ApprovalDecision,
} from '@clm/types'
import { prisma } from './prisma.js'
import { createAuditEvent } from './audit.js'
import { queueApprovalSummary, queueNotification } from './queue.js'
import { fireWebhook } from './webhook-events.js'
import { standingVersion } from './standing-version.js'
import { positionOf, transition } from './lifecycle.js'
import {
  advanceWorkflow, cancelEscalation, checkAutoApprove, createStepsForDef, deciderIdsOf, hasAssignees,
  holdersOf, resolveAssignees, roleIdsOf, type WorkflowStepDef,
} from './workflow-engine.js'

export type FlowError = { ok: false; status: number; error: string; code?: string; instanceId?: string }

// ─── Submit ───────────────────────────────────────────────────────────────────

export interface SubmitArgs {
  orgId: string
  contractId: string
  userId: string
  workflowDefinitionId?: string | null
  comment?: string | null
  via?: 'web' | 'agent'
}

export type SubmitResult = FlowError | {
  ok: true
  autoApproved: boolean
  instanceId: string
  workflowDefinitionId: string
  previousStatus: string
  currentStepOrder: number
  stepName: string
  steps: Array<{ id: string; approverId: string | null; approverRoleId: string | null }>
  approverIds: string[]
  escalateAt: Date | null
}

export async function submitForApproval(a: SubmitArgs): Promise<SubmitResult> {
  const contract = await prisma.contract.findFirst({ where: { id: a.contractId, orgId: a.orgId, deletedAt: null } })
  if (!contract) return { ok: false, status: 404, error: 'Contract not found' }
  const from = positionOf(contract)
  // Draft or Negotiate; or Approve after a decline, reworked and sent again.
  const resubmitAfterDecline = from.stage === 'approve' && from.stageState === 'declined'
  if (from.stage !== 'draft' && from.stage !== 'negotiate' && !resubmitAfterDecline) {
    return { ok: false, status: 409, error: `Only a contract in Draft or Negotiate can be submitted for approval (this one is ${stagePhrase(from.stage, from.stageState)}).` }
  }
  const refusal = transitionRefusal({ from: { stage: from.stage, state: from.stageState }, to: { stage: 'approve', state: 'pending' }, source: 'approval' })
  if (refusal) return { ok: false, status: 409, error: refusal }

  const open = await prisma.approvalInstance.findFirst({ where: { orgId: a.orgId, contractId: a.contractId, status: { in: ['PENDING', 'ESCALATED'] } } })
  if (open) return { ok: false, status: 409, error: 'Contract already has an active approval workflow', instanceId: open.id }

  let workflow = a.workflowDefinitionId
    ? await prisma.workflowDefinition.findFirst({ where: { id: a.workflowDefinitionId, orgId: a.orgId, deletedAt: null, isActive: true } })
    : null
  // Z3 — the workflow the sender chose, or none: never another in its place.
  if (a.workflowDefinitionId && !workflow) return { ok: false, status: 422, error: 'That workflow is inactive or no longer exists. Choose another.' }
  const routed = { type: contract.type, value: contract.value != null ? Number(contract.value) : null, currency: contract.currency }
  if (!workflow) {
    const candidates = await prisma.workflowDefinition.findMany({ where: { orgId: a.orgId, isActive: true, deletedAt: null } })
    workflow = pickWorkflow(candidates, routed)
  }
  if (!workflow) return { ok: false, status: 422, error: 'No active approval workflow found for this org. Create one in Approvals → Manage Workflows.' }

  const stepDefs: WorkflowStepDef[] = Array.isArray(workflow.steps) ? (workflow.steps as unknown as WorkflowStepDef[]) : []
  if (!stepDefs.length) return { ok: false, status: 422, error: 'Workflow has no steps configured' }
  const firstStepDef = [...stepDefs].sort((x, y) => x.order - y.order)[0]
  const triggerRules = (workflow.triggerRules as Record<string, unknown>) ?? {}

  // ── Auto-approval ──────────────────────────────────────────────────────────
  if (checkAutoApprove(contract.type, routed.value, triggerRules, contract.currency)) {
    const instance = await prisma.approvalInstance.create({
      data: {
        orgId: a.orgId, contractId: a.contractId, workflowDefinitionId: workflow.id,
        status: 'AUTO_APPROVED', outcome: 'approved', currentStepOrder: 0, submittedById: a.userId,
        // docs/41 P1 — the version approved: later changes are measured against it.
        versionId: contract.currentVersionId, decidedAt: new Date(),
        aiSummary: a.via === 'agent' && a.comment ? a.comment : 'Auto-approved based on org rules.',
        approvalRecommendation: 'ready_to_approve',
      },
    })
    await transition({
      orgId: a.orgId, contractId: a.contractId, source: 'approval', to: { stage: 'approve', state: 'approved' },
      userId: a.userId, reason: "approved automatically by the org's rules", versionId: contract.currentVersionId, extra: { instanceId: instance.id },
    })
    createAuditEvent({
      orgId: a.orgId, userId: a.userId, action: AuditAction.APPROVAL_SUBMITTED, resourceType: 'contract', resourceId: a.contractId,
      metadata: { instanceId: instance.id, autoApproved: true, versionId: contract.currentVersionId, ...(a.via === 'agent' && { via: 'agent' }) },
    }).catch(() => {})
    queueNotification({
      orgId: a.orgId, userId: a.userId, type: 'APPROVAL_DECIDED', title: 'Contract auto-approved',
      body: `"${contract.title}" was auto-approved based on your org's rules.`, resourceType: 'contract', resourceId: a.contractId,
    })
    return {
      ok: true, autoApproved: true, instanceId: instance.id, workflowDefinitionId: workflow.id, previousStatus: contract.status,
      currentStepOrder: 0, stepName: firstStepDef.name, steps: [], approverIds: [], escalateAt: null,
    }
  }

  // ── A request for approval of this version, its first step assigned ───────
  const assignees = await resolveAssignees(firstStepDef, a.orgId, prisma)
  if (!hasAssignees(assignees)) {
    return { ok: false, status: 422, error: `Cannot resolve approver for step "${firstStepDef.name}". Check the workflow configuration.` }
  }
  const instance = await prisma.approvalInstance.create({
    data: {
      orgId: a.orgId, contractId: a.contractId, workflowDefinitionId: workflow.id,
      status: 'PENDING', currentStepOrder: firstStepDef.order, submittedById: a.userId,
      versionId: contract.currentVersionId,
    },
  })
  const steps = await createStepsForDef(prisma, instance, firstStepDef, assignees)
  const moved = await transition({
    orgId: a.orgId, contractId: a.contractId, source: 'approval', to: { stage: 'approve', state: 'pending' },
    userId: a.userId, versionId: contract.currentVersionId, extra: { instanceId: instance.id },
  })
  if (!moved.ok) {
    // Moved meanwhile (a counterparty's version): the request goes with it.
    await prisma.approvalInstance.update({ where: { id: instance.id }, data: { status: 'CANCELLED', outcome: 'cancelled', decidedAt: new Date() } })
    await prisma.approvalStep.updateMany({ where: { approvalInstanceId: instance.id, status: 'PENDING' }, data: { status: 'SKIPPED' } })
    await Promise.all(steps.map(s => cancelEscalation(s.id)))
    return { ok: false, status: moved.status, error: moved.refusal }
  }

  const notify = [...new Set(steps.flatMap(s => s.notify))]
  const latestVersion = await standingVersion(a.contractId, contract.currentVersionId)
  if (latestVersion) {
    queueApprovalSummary({ instanceId: instance.id, contractId: a.contractId, versionId: latestVersion.id, orgId: a.orgId, approverIds: notify })
  }
  const people = await prisma.user.findMany({ where: { id: { in: notify } }, select: { id: true, email: true } })
  const emailById = new Map(people.map(u => [u.id, u.email]))
  for (const s of steps) {
    for (const userId of s.notify) {
      queueNotification({
        orgId: a.orgId, userId, type: 'APPROVAL_REQUEST', title: 'Contract awaiting your approval',
        body: `"${contract.title}" has been submitted for approval (${firstStepDef.name})${s.approverRoleId ? ' — any one of your role can decide' : ''}.`,
        resourceType: 'approval_step', resourceId: s.id, email: emailById.get(userId) ?? undefined,
      })
    }
  }
  createAuditEvent({
    orgId: a.orgId, userId: a.userId, action: AuditAction.APPROVAL_SUBMITTED, resourceType: 'contract', resourceId: a.contractId,
    metadata: { instanceId: instance.id, workflowId: workflow.id, approverCount: notify.length, versionId: contract.currentVersionId, ...(a.comment?.trim() && { comment: a.comment.trim() }), ...(a.via === 'agent' && { via: 'agent' }) },
  }).catch(() => {})
  // Phase 10 — Slack/webhook subscribers get an actionable card for the first step.
  void fireWebhook(a.orgId, 'approval.submitted', {
    contractId: a.contractId, title: contract.title, type: contract.type,
    value: contract.value != null ? Number(contract.value) : null, currency: contract.currency,
    instanceId: instance.id, stepId: steps[0].id, stepName: firstStepDef.name, approverId: steps[0].approverId,
  })
  const escalateAt = new Date(Date.now() + (firstStepDef.dueSoonHours ?? 48) * 60 * 60 * 1000)
  return {
    ok: true, autoApproved: false, instanceId: instance.id, workflowDefinitionId: workflow.id, previousStatus: contract.status,
    currentStepOrder: firstStepDef.order, stepName: firstStepDef.name,
    steps: steps.map(s => ({ id: s.id, approverId: s.approverId, approverRoleId: s.approverRoleId })),
    approverIds: notify, escalateAt,
  }
}

// ─── Decide ───────────────────────────────────────────────────────────────────

export interface DecideArgs {
  orgId: string
  userId: string
  stepId: string
  /** When the caller names the request too, the step must belong to it. */
  instanceId?: string | null
  /** APPROVED | RETURNED | DECLINED | DELEGATED; REJECTED (older clients) is a return. */
  decision: unknown
  comment?: string | null
  delegateTo?: string | null
  linkedFindingIds?: string[]
  linkedClauseIds?: string[]
  via?: 'web' | 'slack' | 'agent' | 'bulk'
}

export type DecideResult = FlowError | {
  ok: true
  stepId: string
  instanceId: string | null
  contractId: string
  decision: ApprovalDecision
  instanceStatus: string | null
  delegatedTo?: string
}

/** Whether `userId` may decide this step: theirs, or in their role's pool. */
export async function mayDecide(step: { approverId: string | null; approverRoleId: string | null }, userId: string): Promise<boolean> {
  if (step.approverId) return step.approverId === userId
  if (!step.approverRoleId) return false
  return (await roleIdsOf(userId, prisma)).includes(step.approverRoleId)
}

export async function decideStep(a: DecideArgs): Promise<DecideResult> {
  const decision = readDecision(a.decision)
  if (!a.stepId || !decision) return { ok: false, status: 400, error: 'decision must be APPROVED, RETURNED, DECLINED or DELEGATED' }
  const comment = a.comment?.trim() || null
  if ((decision === 'RETURNED' || decision === 'DECLINED') && !comment) {
    return { ok: false, status: 400, error: decision === 'DECLINED' ? 'Say why it should not go ahead.' : 'Say what needs to change (a reason is required to return it).' }
  }
  if (decision === 'DELEGATED' && !a.delegateTo) return { ok: false, status: 400, error: 'delegateTo is required when delegating' }

  const step = await prisma.approvalStep.findFirst({
    where: { id: a.stepId, orgId: a.orgId, status: 'PENDING', ...(a.instanceId && { approvalInstanceId: a.instanceId }) },
  })
  if (!step || !await mayDecide(step, a.userId)) return { ok: false, status: 403, error: 'Step not found or not assigned to you' }

  if (step.kind === 'clause_exception') return decideException(step, decision, comment, a)

  const instance = step.approvalInstanceId ? await prisma.approvalInstance.findFirst({ where: { id: step.approvalInstanceId, orgId: a.orgId } }) : null
  if (!instance) return { ok: false, status: 404, error: 'Approval instance not found' }
  if (instance.status !== 'PENDING' && instance.status !== 'ESCALATED') return { ok: false, status: 409, error: 'Workflow is already closed' }
  // F-66 — a later step isn't anyone's to decide yet.
  if (step.stepOrder !== instance.currentStepOrder) return { ok: false, status: 409, error: 'This step is not open yet: an earlier step is still waiting.' }

  const linked = {
    linkedFindingIds: (a.linkedFindingIds ?? []).filter(x => typeof x === 'string').slice(0, 50),
    linkedClauseIds: (a.linkedClauseIds ?? []).filter(x => typeof x === 'string').slice(0, 50),
  }
  if (linked.linkedFindingIds.length) {
    const ok = await prisma.reviewFinding.count({ where: { id: { in: linked.linkedFindingIds }, orgId: a.orgId, contractId: instance.contractId } })
    if (ok !== linked.linkedFindingIds.length) return { ok: false, status: 400, error: 'A finding pointed at is not this contract’s.' }
  }

  if (decision === 'DELEGATED') {
    const delegatee = await prisma.user.findFirst({ where: { id: a.delegateTo!, orgId: a.orgId, deletedAt: null } })
    if (!delegatee) return { ok: false, status: 400, error: 'Delegatee user not found in this org' }
    const claimed = await prisma.approvalStep.updateMany({
      where: { id: step.id, status: 'PENDING', approverId: step.approverId },
      data: { approverId: a.userId, status: 'DELEGATED', decision: 'DELEGATED', comment, delegatedToId: delegatee.id, decidedAt: new Date() },
    })
    if (!claimed.count) return { ok: false, status: 409, error: 'This step was decided meanwhile. Reload the page.' }
    await cancelEscalation(step.id)
    const created = await prisma.approvalStep.create({
      data: {
        approvalInstanceId: instance.id, orgId: a.orgId, contractId: instance.contractId, kind: 'approval',
        stepOrder: step.stepOrder, stepName: step.stepName, approverId: delegatee.id, status: 'PENDING',
        escalateAt: step.escalateAt, // preserve the original deadline
      },
    })
    const contract = await prisma.contract.findUnique({ where: { id: instance.contractId }, select: { title: true } })
    queueNotification({
      orgId: a.orgId, userId: delegatee.id, type: 'DELEGATION', title: 'Contract approval delegated to you',
      body: `"${contract?.title ?? 'Contract'}" approval has been delegated to you (${step.stepName}).`,
      resourceType: 'approval_step', resourceId: created.id, email: delegatee.email,
    })
    createAuditEvent({
      orgId: a.orgId, userId: a.userId, action: AuditAction.APPROVAL_DECIDED, resourceType: 'approval_step', resourceId: step.id,
      metadata: { decision: 'DELEGATED', delegateTo: delegatee.id, instanceId: instance.id, ...(a.via && a.via !== 'web' && { via: a.via }) },
    }).catch(() => {})
    return { ok: true, stepId: step.id, instanceId: instance.id, contractId: instance.contractId, decision, instanceStatus: instance.status, delegatedTo: delegatee.id }
  }

  // Compare-and-set: a double-click, or another holder of the role deciding
  // at the same moment, must not overwrite a recorded decision. A pooled step
  // is claimed here: its approver becomes whoever decided.
  const decided = await prisma.approvalStep.updateMany({
    where: { id: step.id, status: 'PENDING', approverId: step.approverId },
    data: { approverId: a.userId, status: decision, decision, comment, decidedAt: new Date(), versionId: instance.versionId, ...linked },
  })
  if (!decided.count) return { ok: false, status: 409, error: 'This step was decided meanwhile. Reload the page.' }
  await cancelEscalation(step.id)

  createAuditEvent({
    orgId: a.orgId, userId: a.userId, action: AuditAction.APPROVAL_DECIDED, resourceType: 'approval_step', resourceId: step.id,
    metadata: { decision, instanceId: instance.id, ...(a.via && a.via !== 'web' && { via: a.via }) },
  }).catch(() => {})
  // docs/41 P0.6 — on the contract too, with the reason: its history shows the decision.
  await createAuditEvent({
    orgId: a.orgId, userId: a.userId, action: AuditAction.APPROVAL_DECIDED, resourceType: 'contract', resourceId: instance.contractId,
    metadata: {
      decision, instanceId: instance.id, stepId: step.id, stepName: step.stepName, versionId: instance.versionId,
      ...(decision === 'RETURNED' && { outcome: 'returned', reason: comment }),
      ...(decision === 'DECLINED' && { outcome: 'declined', reason: comment }),
      ...(decision === 'APPROVED' && comment && { comment }),
      ...(linked.linkedFindingIds.length && { linkedFindingIds: linked.linkedFindingIds }),
      ...(linked.linkedClauseIds.length && { linkedClauseIds: linked.linkedClauseIds }),
      ...(!step.approverId && { claimedFromRole: step.approverRoleId }),
      ...(a.via && a.via !== 'web' && { via: a.via }),
    },
  }).catch(err => console.warn('[approval-flow] decision not recorded on the contract: %s', (err as Error).message))

  await advanceWorkflow(instance.id, prisma)
  const updated = await prisma.approvalInstance.findUnique({ where: { id: instance.id }, select: { status: true } })
  // H2 — webhook subscribers; `decision` keeps REJECTED for a return or decline, as before.
  void fireWebhook(a.orgId, 'approval.decided', {
    instanceId: instance.id, contractId: instance.contractId, stepId: step.id,
    decision: decision === 'APPROVED' ? 'APPROVED' : 'REJECTED', outcome: decision.toLowerCase(),
    instanceStatus: updated?.status ?? null, decidedBy: a.userId, ...(a.via && a.via !== 'web' && { via: a.via }),
  })
  return { ok: true, stepId: step.id, instanceId: instance.id, contractId: instance.contractId, decision, instanceStatus: updated?.status ?? null }
}

// ─── Clause exceptions (docs/41 Part 7) ──────────────────────────────────────

/** Findings an exception can be asked for: a position the playbook doesn't give, or a required clause confirmed missing. */
export const EXCEPTION_KINDS = new Set(['needs_approval_position', 'position_not_met', 'missing_required', 'not_allowed_present', 'deleted', 'material_cut', 'modified'])

/** Who decides exceptions for a finding's category: its clause approver (the category, then its parent). */
async function clauseApprover(orgId: string, categoryId: string | null): Promise<{ userId: string | null; roleId: string | null; category: string | null } | null> {
  let id = categoryId
  for (let depth = 0; id && depth < 5; depth++) {
    const c = await prisma.clauseCategory.findFirst({ where: { id, orgId }, select: { name: true, parentCategoryId: true, approverUserId: true, approverRoleId: true } })
    if (!c) return null
    if (c.approverUserId || c.approverRoleId) return { userId: c.approverUserId, roleId: c.approverRoleId, category: c.name }
    id = c.parentCategoryId
  }
  return null
}

export async function requestException(a: { orgId: string; contractId: string; findingId: string; userId: string; reason: string }): Promise<FlowError | { ok: true; stepId: string; approverIds: string[] }> {
  const reason = a.reason?.trim()
  if (!reason) return { ok: false, status: 400, error: 'Say why an exception is needed.' }
  const [contract, finding] = await Promise.all([
    prisma.contract.findFirst({ where: { id: a.contractId, orgId: a.orgId, deletedAt: null }, select: { id: true, title: true, currentVersionId: true, stage: true } }),
    prisma.reviewFinding.findFirst({ where: { id: a.findingId, orgId: a.orgId, contractId: a.contractId } }),
  ])
  if (!contract || !finding) return { ok: false, status: 404, error: 'Finding not found' }
  if (finding.versionId !== contract.currentVersionId) return { ok: false, status: 409, code: 'NOT_CURRENT', error: 'This finding is about an older version. Ask on the version the contract stands on.' }
  if (finding.status !== 'open' && finding.status !== 'exception_declined') return { ok: false, status: 409, code: 'ALREADY_DECIDED', error: finding.status === 'exception_requested' ? 'An exception was already asked for.' : 'This finding was already dealt with.' }
  if (!EXCEPTION_KINDS.has(finding.kind)) return { ok: false, status: 409, code: 'NOT_EXCEPTIONABLE', error: 'An exception can be asked for a clause position, not for this kind of finding.' }

  const approver = await clauseApprover(a.orgId, finding.categoryId)
  if (!approver) {
    const name = finding.categoryId ? (await prisma.clauseCategory.findFirst({ where: { id: finding.categoryId, orgId: a.orgId }, select: { name: true } }))?.name : null
    return {
      ok: false, status: 422, code: 'NO_CLAUSE_APPROVER',
      error: `No one is named to decide exceptions for ${name ? `“${name}”` : 'this clause'}. An admin can name a clause approver in Clauses → categories.`,
    }
  }
  const holders = approver.userId ? [approver.userId] : await holdersOf(approver.roleId!, a.orgId, prisma)
  if (!holders.length) return { ok: false, status: 422, code: 'NO_CLAUSE_APPROVER', error: `No one holds the role that decides exceptions for “${approver.category}”.` }

  const step = await prisma.approvalStep.create({
    data: {
      orgId: a.orgId, kind: 'clause_exception', contractId: a.contractId, findingId: finding.id, clauseType: finding.clauseType,
      versionId: finding.versionId, stepOrder: 0, stepName: `Exception: ${finding.title}`.slice(0, 200),
      approverId: approver.userId, approverRoleId: approver.userId ? null : approver.roleId,
      status: 'PENDING', requestedById: a.userId, requestNote: reason,
    },
  })
  await prisma.reviewFinding.update({
    where: { id: finding.id },
    // resolvedById: the decision carries to later versions while the words stay the same (review-findings.ts storeFindings).
    data: { status: 'exception_requested', resolvedById: a.userId, resolvedAt: new Date(), resolutionNote: reason },
  })
  await createAuditEvent({
    orgId: a.orgId, userId: a.userId, action: AuditAction.EXCEPTION_REQUESTED, resourceType: 'contract', resourceId: a.contractId,
    metadata: { stepId: step.id, findingId: finding.id, title: finding.title, clauseType: finding.clauseType, reason, versionId: finding.versionId, category: approver.category },
  })
  const people = await prisma.user.findMany({ where: { id: { in: holders } }, select: { id: true, email: true } })
  for (const p of people) {
    queueNotification({
      orgId: a.orgId, userId: p.id, type: 'APPROVAL_REQUEST', title: 'Exception to decide',
      body: `An exception is asked for on "${contract.title}": ${finding.title}. Why: “${reason}”.`,
      resourceType: 'approval_step', resourceId: step.id, email: p.email,
    })
  }
  return { ok: true, stepId: step.id, approverIds: holders }
}

async function decideException(
  step: { id: string; orgId: string; contractId: string | null; findingId: string | null; approverId: string | null; requestedById: string | null; stepName: string },
  decision: ApprovalDecision, comment: string | null, a: DecideArgs,
): Promise<DecideResult> {
  if (decision === 'DELEGATED') return { ok: false, status: 400, error: 'An exception is decided, not delegated.' }
  // A return asks for changes: for an exception that is a decline with a reason.
  const approved = decision === 'APPROVED'
  const status = approved ? 'APPROVED' : 'DECLINED'
  const done = await prisma.approvalStep.updateMany({
    where: { id: step.id, status: 'PENDING', approverId: step.approverId },
    data: { approverId: a.userId, status, decision: status, comment, decidedAt: new Date() },
  })
  if (!done.count) return { ok: false, status: 409, error: 'This exception was decided meanwhile. Reload the page.' }
  const finding = step.findingId ? await prisma.reviewFinding.findFirst({ where: { id: step.findingId, orgId: step.orgId } }) : null
  if (finding) {
    await prisma.reviewFinding.update({
      where: { id: finding.id },
      data: { status: approved ? 'exception_approved' : 'exception_declined', resolvedById: a.userId, resolvedAt: new Date(), resolutionNote: comment ?? (approved ? 'Exception approved.' : 'Exception declined.') },
    })
  }
  await createAuditEvent({
    orgId: step.orgId, userId: a.userId, action: AuditAction.EXCEPTION_DECIDED, resourceType: 'contract', resourceId: step.contractId!,
    metadata: { stepId: step.id, findingId: step.findingId, title: finding?.title ?? step.stepName, decision: status, ...(comment && { reason: comment }), ...(a.via && a.via !== 'web' && { via: a.via }) },
  })
  if (step.requestedById) {
    const contract = await prisma.contract.findUnique({ where: { id: step.contractId! }, select: { title: true } })
    queueNotification({
      orgId: step.orgId, userId: step.requestedById, type: 'APPROVAL_DECIDED',
      title: approved ? 'Exception approved' : 'Exception declined',
      body: `${finding?.title ?? 'The exception'} on "${contract?.title ?? 'the contract'}" was ${approved ? 'approved' : 'declined'}${comment ? `: “${comment}”` : '.'}`,
      resourceType: 'contract', resourceId: step.contractId!,
    })
  }
  return { ok: true, stepId: step.id, instanceId: null, contractId: step.contractId!, decision: approved ? 'APPROVED' : 'DECLINED', instanceStatus: null }
}

/** Open exceptions on a contract: they block sending it for signature (docs/41 Part 7). */
export async function openExceptions(orgId: string, contractId: string): Promise<Array<{ id: string; stepName: string }>> {
  return prisma.approvalStep.findMany({
    where: { orgId, contractId, kind: 'clause_exception', status: 'PENDING' },
    select: { id: true, stepName: true },
  })
}

/** Who may decide each of these steps, by step id (their approver, or their role's holders). */
export async function decidersOf(steps: Array<{ id: string; approverId: string | null; approverRoleId: string | null; orgId: string }>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const s of steps) out.set(s.id, await deciderIdsOf(s, prisma))
  return out
}

/** The status a stage and state reads as (re-exported for routes that answer with a status). */
export { statusFor }
