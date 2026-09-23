/**
 * Approval Routes — Phase 06
 * Mounted at /api/v1/approvals in app.ts
 *
 * Routes:
 *   GET  /my-queue                          → pending steps assigned to current user
 *   GET  /:instanceId                       → full instance detail
 *   POST /:instanceId/decide                → approve / reject / delegate a step
 *   PATCH /:instanceId/summary             → internal: approval agent patches AI summary
 *   GET  /workflows                         → list org workflow definitions
 *   POST /workflows                         → create workflow
 *   PATCH /workflows/:workflowId           → update workflow
 *   DELETE /workflows/:workflowId          → soft-delete
 *   GET  /notifications                     → notifications for current user
 *   POST /notifications/mark-read           → mark notifications as read
 */
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { requireUser } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { advanceWorkflow } from '../lib/workflow-engine.js'
import { fireWebhook } from '../lib/webhook-events.js'
import { queueNotification, notificationQueue } from '../lib/queue.js'
import { AuditAction } from '@clm/types'
import { restorePii, unresolvedPiiTokens } from '../lib/pii-policy.js'
import { clauseVersionId } from '../lib/clause-version.js'

// Wave 3.8 — validate workflow step definitions at save time. Each step must
// name at least one approver, and a parallel step's requiredApprovals must be
// satisfiable by the explicitly-named approvers (roles resolve at runtime, so
// we only hard-cap when no roles are used). Returns an error string or null.
function validateWorkflowSteps(steps: unknown[]): string | null {
  for (let i = 0; i < steps.length; i++) {
    const s = (steps[i] ?? {}) as {
      name?: string
      approverId?: string
      roleRequired?: string
      approverIds?: unknown
      roleRequireds?: unknown
      executionMode?: string
      requiredApprovals?: number
    }
    const approverIds = Array.isArray(s.approverIds) ? s.approverIds.filter(Boolean) : []
    const roleRequireds = Array.isArray(s.roleRequireds) ? s.roleRequireds.filter(Boolean) : []
    const hasApprover = !!s.approverId || !!s.roleRequired || approverIds.length > 0 || roleRequireds.length > 0
    if (!hasApprover) {
      return `Step ${i + 1} ("${s.name || 'Untitled'}") has no approver — pick a user or role.`
    }
    if (s.executionMode === 'parallel') {
      const req = s.requiredApprovals ?? 1
      if (req < 1) return `Step ${i + 1} requiredApprovals must be at least 1.`
      // Only hard-cap when the approver set is fully explicit (no roles).
      if (roleRequireds.length === 0 && approverIds.length > 0 && req > approverIds.length) {
        return `Step ${i + 1} requires ${req} approvals but only ${approverIds.length} approver(s) are named.`
      }
    }
  }
  return null
}

export async function approvalRoutes(app: FastifyInstance) {

  // ── GET /my-queue — pending approval steps assigned to me ─────────────────
  // P7.2.1 (F-66) — Sequential gating: only return steps whose stepOrder
  // matches the parent instance's currentStepOrder. Without this gate,
  // step-2 approvers see the contract before step-1 has decided, which
  // breaks the workflow's sequential semantics + means the wrong person
  // can pre-approve.
  //
  // Implementation: fetch all PENDING steps for this user, then drop
  // those whose stepOrder isn't current. We can't push the join into
  // the WHERE because Prisma doesn't filter by sibling-row values
  // without raw SQL or a 2nd query — which is exactly what we do.
  app.get('/my-queue', { preHandler: requirePermission('view', 'workflow') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user

    const steps = await prisma.approvalStep.findMany({
      where:   { orgId, approverId: userId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    })

    if (steps.length === 0) return reply.send({ data: [], total: 0 })

    const instanceIds = [...new Set(steps.map(s => s.approvalInstanceId))]
    const instances = await prisma.approvalInstance.findMany({
      where: { id: { in: instanceIds } },
    })

    // P7.2.1 — Drop steps that aren't the currently-active step on
    // their parent instance.
    //
    // P17 audit (2026-04-29) — the previous "tolerate legacy 0 by
    // treating as 1" branch actively broke 0-indexed seeds: instances
    // currentStepOrder=0 + step stepOrder=0 was a perfectly valid state,
    // but the gate flipped current to 1 and dropped the step. Now match
    // them as-is; the only invariant we care about is step.stepOrder ===
    // instance.currentStepOrder (whichever indexing the seed uses).
    const currentByInstance = new Map(instances.map(i => [i.id, i.currentStepOrder]))
    const filteredSteps = steps.filter(s => {
      const cur = currentByInstance.get(s.approvalInstanceId)
      return cur !== undefined && s.stepOrder === cur
    })
    if (filteredSteps.length === 0) return reply.send({ data: [], total: 0 })
    const contractIds = [...new Set(instances.map(i => i.contractId))]
    const contracts = await prisma.contract.findMany({
      where:  { id: { in: contractIds } },
      select: { id: true, title: true, type: true, value: true, counterpartyName: true, status: true },
    })
    const submitterIds = [...new Set(instances.map(i => i.submittedById))]
    const submitters = await prisma.user.findMany({
      where:  { id: { in: submitterIds } },
      select: { id: true, name: true },
    })

    const instanceMap = new Map(instances.map(i => [i.id, i]))
    const contractMap = new Map(contracts.map(c => [c.id, c]))
    const submitterMap = new Map(submitters.map(u => [u.id, u]))

    // P7.2.1 — Build the response from the GATED step list, not the
    // raw query result.
    const data = filteredSteps.map(step => {
      const instance = instanceMap.get(step.approvalInstanceId)
      const contract = instance ? contractMap.get(instance.contractId) : null
      const submitter = instance ? submitterMap.get(instance.submittedById) : null
      return {
        stepId:      step.id,
        instanceId:  step.approvalInstanceId,
        stepOrder:   step.stepOrder,
        stepName:    step.stepName,
        status:      step.status,
        escalateAt:  step.escalateAt,
        createdAt:   step.createdAt,
        contract,
        instance: instance ? {
          id:                    instance.id,
          status:                instance.status,
          submittedAt:           instance.submittedAt,
          submittedByName:       submitter?.name ?? 'Unknown',
          aiSummary:             instance.aiSummary,
          keyRisks:              instance.keyRisks,
          nonStandardTerms:      instance.nonStandardTerms,
          approvalRecommendation: instance.approvalRecommendation,
        } : null,
      }
    })

    return reply.send({ data, total: data.length })
  })


  // ── GET /all — org-wide approval queue (admin / configure scope only) ─────
  // P7.2.2 (F-11) — Admins need to see EVERY in-flight approval, not just
  // their own assigned steps. Default `/my-queue` filters by assignee;
  // this surface returns all PENDING ApprovalInstances in the org for
  // oversight — "where is my org stuck?" — without needing to be added
  // as an approver on each one.
  app.get('/all', { preHandler: requirePermission('configure', 'workflow') }, async (req, reply) => {
    const { orgId } = req.user

    // ESCALATED is included for oversight: older escalations with no target
    // parked instances in that state (C2), and an admin is who can unstick them.
    const instances = await prisma.approvalInstance.findMany({
      where:   { orgId, status: { in: ['PENDING', 'IN_PROGRESS', 'ESCALATED'] } },
      include: {
        steps: {
          where: { status: 'PENDING' },
          orderBy: { stepOrder: 'asc' },
        },
        definition: { select: { steps: true } },
      },
      orderBy: { submittedAt: 'desc' },
      take: 100,
    })

    if (instances.length === 0) return reply.send({ data: [], total: 0 })

    // Resolve contracts + approvers + submitters in batched lookups.
    const contractIds = [...new Set(instances.map(i => i.contractId))]
    const submitterIds = [...new Set(instances.map(i => i.submittedById))]
    const approverIds  = [...new Set(instances.flatMap(i => i.steps.map(s => s.approverId).filter(Boolean)))]

    const [contracts, submitters, approvers] = await Promise.all([
      prisma.contract.findMany({
        where:  { id: { in: contractIds } },
        select: { id: true, title: true, type: true, value: true, counterpartyName: true, status: true, currency: true },
      }),
      prisma.user.findMany({
        where:  { id: { in: submitterIds } },
        select: { id: true, name: true, email: true },
      }),
      approverIds.length
        ? prisma.user.findMany({
            where:  { id: { in: approverIds } },
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve([] as Array<{ id: string; name: string; email: string }>),
    ])
    const contractMap  = new Map(contracts.map(c => [c.id, c]))
    const submitterMap = new Map(submitters.map(u => [u.id, u]))
    const approverMap  = new Map(approvers.map(u => [u.id, u]))

    const data = instances.map(instance => {
      // Step orders are whatever the workflow definition uses — the builder
      // and seed number from 0, older definitions from 1. Match exactly
      // (as /my-queue does); coercing 0 to 1 hid every first-step approval.
      const currentStep = instance.steps.find(s => s.stepOrder === instance.currentStepOrder)
      const defOrders = [...new Set(
        ((instance.definition?.steps ?? []) as Array<{ order?: number }>)
          .map(d => d.order).filter((o): o is number => typeof o === 'number'),
      )].sort((a, b) => a - b)
      const position = defOrders.indexOf(instance.currentStepOrder)
      const submitter = submitterMap.get(instance.submittedById)
      const contract  = contractMap.get(instance.contractId)
      const currentApprover = currentStep ? approverMap.get(currentStep.approverId) : null
      const waitingDays = Math.round((Date.now() - instance.submittedAt.getTime()) / (24 * 60 * 60 * 1000))

      return {
        instanceId:        instance.id,
        contract,
        status:            instance.status,
        submittedAt:       instance.submittedAt,
        submittedByName:   submitter?.name ?? 'Unknown',
        currentStepOrder:  instance.currentStepOrder,
        // 1-based "step N of M" for display, from the workflow definition.
        currentStepPosition: position >= 0 ? position + 1 : null,
        stepCount:         defOrders.length || null,
        currentStepName:   currentStep?.stepName ?? null,
        currentApproverName: currentApprover?.name ?? null,
        currentApproverEmail: currentApprover?.email ?? null,
        waitingDays,
        totalSteps:        instance.steps.length,
        approvalRecommendation: instance.approvalRecommendation,
      }
    })

    return reply.send({ data, total: data.length })
  })


  // ── GET /:instanceId — full instance detail ───────────────────────────────
  app.get('/:instanceId', { preHandler: requirePermission('view', 'workflow') }, async (req, reply) => {
    const { orgId } = req.user
    const { instanceId } = req.params as { instanceId: string }

    // Guard against /workflows, /notifications etc. being caught by this param route
    if (['workflows', 'my-queue', 'notifications'].includes(instanceId)) {
      return reply.status(404).send({ error: 'Not found' })
    }

    const instance = await prisma.approvalInstance.findFirst({
      where:   { id: instanceId, orgId },
      include: { steps: { orderBy: [{ stepOrder: 'asc' }, { createdAt: 'asc' }] } },
    })
    if (!instance) return reply.status(404).send({ error: 'Approval instance not found' })

    const contract = await prisma.contract.findUnique({
      where:  { id: instance.contractId },
      select: { id: true, title: true, type: true, value: true, status: true, counterpartyName: true },
    })
    const submitter = await prisma.user.findUnique({
      where:  { id: instance.submittedById },
      select: { id: true, name: true, email: true },
    })

    // Enrich steps with approver names
    const approverIds = [...new Set(instance.steps.map(s => s.approverId).filter(Boolean))]
    const approvers = approverIds.length
      ? await prisma.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } })
      : []
    const approverMap = new Map(approvers.map(u => [u.id, u]))

    const enrichedSteps = instance.steps.map(s => ({
      ...s,
      approverName: approverMap.get(s.approverId)?.name ?? s.approverId,
    }))

    const definition = await prisma.workflowDefinition.findUnique({
      where:  { id: instance.workflowDefinitionId },
      select: { id: true, name: true, steps: true },
    })

    return reply.send({
      ...instance,
      steps:      enrichedSteps,
      contract,
      submitter,
      definition,
    })
  })


  // ── POST /:instanceId/decide — make a decision on a step ─────────────────
  app.post('/:instanceId/decide', { preHandler: requirePermission('approve', 'workflow') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { instanceId } = req.params as { instanceId: string }
    const { stepId, decision, comment, delegateTo } = req.body as {
      stepId:     string
      decision:   'APPROVED' | 'REJECTED' | 'DELEGATED'
      comment?:   string
      delegateTo?: string
    }

    if (!stepId || !decision) return reply.status(400).send({ error: 'stepId and decision are required' })
    if (!['APPROVED', 'REJECTED', 'DELEGATED'].includes(decision)) {
      return reply.status(400).send({ error: 'decision must be APPROVED, REJECTED, or DELEGATED' })
    }
    if (decision === 'REJECTED' && !comment?.trim()) {
      return reply.status(400).send({ error: 'comment is required when rejecting' })
    }
    if (decision === 'DELEGATED' && !delegateTo) {
      return reply.status(400).send({ error: 'delegateTo is required when delegating' })
    }

    // Verify the step belongs to this instance and org, and this user is the approver
    const step = await prisma.approvalStep.findFirst({
      where: { id: stepId, approvalInstanceId: instanceId, orgId, approverId: userId, status: 'PENDING' },
    })
    if (!step) return reply.status(403).send({ error: 'Step not found or not assigned to you' })

    const instance = await prisma.approvalInstance.findFirst({
      where: { id: instanceId, orgId },
    })
    if (!instance) return reply.status(404).send({ error: 'Approval instance not found' })
    if (instance.status !== 'PENDING' && instance.status !== 'ESCALATED') {
      return reply.status(409).send({ error: 'Workflow is already closed' })
    }

    // Cancel escalation timer for this step
    try { await notificationQueue.remove(`escalate-${stepId}`) } catch { /* no-op */ }

    if (decision === 'DELEGATED') {
      // Guarded at entry (line ~261), but TS doesn't carry that narrowing
      // into this separate block — assert delegateTo is present.
      if (!delegateTo) return reply.status(400).send({ error: 'delegateTo is required when delegating' })
      // Mark current step DELEGATED, create new PENDING step for delegatee
      const delegatee = await prisma.user.findFirst({ where: { id: delegateTo, orgId } })
      if (!delegatee) return reply.status(400).send({ error: 'Delegatee user not found in this org' })

      await prisma.$transaction([
        prisma.approvalStep.update({
          where: { id: stepId },
          data:  { status: 'DELEGATED', decision: 'DELEGATED', comment: comment?.trim(), delegatedToId: delegateTo, decidedAt: new Date() },
        }),
        prisma.approvalStep.create({
          data: {
            approvalInstanceId: instanceId,
            orgId,
            stepOrder:  step.stepOrder,
            stepName:   step.stepName,
            approverId: delegateTo,
            status:     'PENDING',
            escalateAt: step.escalateAt, // preserve original deadline
          },
        }),
      ])

      const contract = await prisma.contract.findUnique({ where: { id: instance.contractId } })
      queueNotification({
        orgId,
        userId:       delegateTo,
        type:         'DELEGATION',
        title:        'Contract approval delegated to you',
        body:         `"${contract?.title ?? 'Contract'}" approval has been delegated to you (${step.stepName}).`,
        resourceType: 'approval_step',
        resourceId:   stepId,
        email:        delegatee.email,
      })

      createAuditEvent({
        orgId,
        userId,
        action:       AuditAction.APPROVAL_DECIDED,
        resourceType: 'approval_step',
        resourceId:   stepId,
        metadata:     { decision: 'DELEGATED', delegateTo, instanceId },
      }).catch(() => {})

      return reply.send({ stepId, decision: 'DELEGATED', delegatedTo: delegateTo })
    }

    // APPROVED or REJECTED
    await prisma.approvalStep.update({
      where: { id: stepId },
      data:  { status: decision, decision, comment: comment?.trim() ?? null, decidedAt: new Date() },
    })

    createAuditEvent({
      orgId,
      userId,
      action:       AuditAction.APPROVAL_DECIDED,
      resourceType: 'approval_step',
      resourceId:   stepId,
      metadata:     { decision, instanceId },
    }).catch(() => {})

    // Run the state machine to advance or close the workflow
    await advanceWorkflow(instanceId, prisma)

    const updatedInstance = await prisma.approvalInstance.findUnique({ where: { id: instanceId } })
    // H2 — advertised to subscribers since P10A, never emitted until now.
    fireWebhook(orgId, 'approval.decided', {
      instanceId, contractId: instance.contractId, stepId, decision,
      instanceStatus: updatedInstance?.status ?? null, decidedBy: userId,
    })
    return reply.send({
      instanceId,
      instanceStatus:     updatedInstance?.status,
      stepId,
      stepDecision:       decision,
    })
  })


  // ── PATCH /:instanceId/summary — internal: agent writes AI summary ────────
  // Called by the Python approval agent after it finishes generating the summary.
  // Protected by internal secret header rather than user JWT.
  app.patch('/:instanceId/summary', async (req, reply) => {
    // X31 — the agents service's secret, in every environment. The check
    // used to apply only in production, so on staging or a preview anyone
    // could rewrite any approval's summary, risks and recommendation.
    const expected = process.env.INTERNAL_SERVICE_SECRET
    if (!expected || req.headers['x-internal-secret'] !== expected) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    // The org it acts for (approval.py sends x-org-id): another org's
    // instance is not found.
    const orgId = (req.headers['x-org-id'] as string | undefined)?.trim()

    const { instanceId } = req.params as { instanceId: string }
    // X27 — the summary was written from clauses the agents service read with
    // round-trip tokens (GET /contracts/:id/clauses); put the values back.
    const instance = await prisma.approvalInstance.findFirst({
      where: { id: instanceId, ...(orgId ? { orgId } : {}) },
      select: { contract: { select: { id: true, currentVersionId: true, keyTerms: true, summary: true } } },
    })
    if (!instance) return reply.status(404).send({ error: 'Approval not found' })
    let summary = req.body as Record<string, unknown>
    if (JSON.stringify(summary ?? null).includes('[PII:')) {
      // The same text the agents service was given: the clauses of the
      // version GET /contracts/:id/clauses picks and that version's text, and
      // the key terms and summary GET /contracts/:id handed over (tokenized
      // against the current version's text, or the latest one's).
      const { contract } = instance
      const versionId = await clauseVersionId(contract.id, contract.currentVersionId)
      const latest = await prisma.contractVersion.findFirst({ where: { contractId: contract.id }, orderBy: { versionNumber: 'desc' }, select: { id: true } })
      const ids = [...new Set([versionId, contract.currentVersionId, latest?.id].filter((v): v is string => !!v))]
      const [versions, clauses] = await Promise.all([
        prisma.contractVersion.findMany({ where: { id: { in: ids }, contractId: contract.id }, select: { plainText: true } }),
        versionId
          ? prisma.contractClause.findMany({ where: { versionId, isSubChunk: false }, orderBy: { sortOrder: 'asc' }, select: { content: true } })
          : Promise.resolve([]),
      ])
      const source = [versions.map(v => v.plainText), clauses.map(c => c.content), contract.keyTerms, contract.summary]
      summary = restorePii(summary, source, contract.id)
      const left = unresolvedPiiTokens(summary, source).length
      if (left) req.log.warn({ instanceId, contractId: contract.id, left }, 'PII placeholders left unresolved in an approval summary')
    }
    const { aiSummary, keyRisks, nonStandardTerms, approvalRecommendation } = summary as {
      aiSummary?:              string
      keyRisks?:               unknown[]
      nonStandardTerms?:       string[]
      approvalRecommendation?: string
    }

    const updated = await prisma.approvalInstance.update({
      where: { id: instanceId },
      data:  {
        ...(aiSummary              !== undefined && { aiSummary }),
        ...(keyRisks               !== undefined && { keyRisks: keyRisks as never }),
        ...(nonStandardTerms       !== undefined && { nonStandardTerms }),
        ...(approvalRecommendation !== undefined && { approvalRecommendation }),
      },
    })

    return reply.send({ id: updated.id, status: 'summary_updated' })
  })


  // ── GET /workflows — list workflow definitions for org ────────────────────
  // U.6.1 — relaxed from `configure:workflow` to `view:workflow` so any
  // user can pick a workflow when sending a contract for review.
  app.get('/workflows', { preHandler: requirePermission('view', 'workflow') }, async (req, reply) => {
    const { orgId } = req.user
    const workflows = await prisma.workflowDefinition.findMany({
      where:   { orgId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })
    return reply.send(workflows)
  })


  // ── POST /workflows — create a new workflow definition ───────────────────
  app.post('/workflows', { preHandler: requirePermission('configure', 'workflow') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { name, description, steps, triggerRules, isDefault } = req.body as {
      name:          string
      description?:  string
      steps:         unknown[]
      triggerRules?: Record<string, unknown>
      isDefault?:    boolean
    }

    if (!name?.trim()) return reply.status(400).send({ error: 'name is required' })
    if (!Array.isArray(steps) || steps.length === 0) return reply.status(400).send({ error: 'steps must be a non-empty array' })
    const stepError = validateWorkflowSteps(steps)
    if (stepError) return reply.status(400).send({ error: stepError })

    // If setting as default, clear any existing default
    if (isDefault) {
      await prisma.workflowDefinition.updateMany({
        where: { orgId, isDefault: true, deletedAt: null },
        data:  { isDefault: false },
      })
    }

    const workflow = await prisma.workflowDefinition.create({
      data: {
        orgId,
        name:         name.trim(),
        description:  description?.trim(),
        steps:        steps as never,
        triggerRules: (triggerRules ?? {}) as never,
        isDefault:    isDefault ?? false,
        createdById:  userId,
      },
    })

    return reply.status(201).send(workflow)
  })


  // ── PATCH /workflows/:workflowId — update a workflow definition ───────────
  app.patch('/workflows/:workflowId', { preHandler: requirePermission('configure', 'workflow') }, async (req, reply) => {
    const { orgId } = req.user
    const { workflowId } = req.params as { workflowId: string }
    const { name, description, steps, triggerRules, isDefault, isActive } = req.body as {
      name?:         string
      description?:  string
      steps?:        unknown[]
      triggerRules?: Record<string, unknown>
      isDefault?:    boolean
      isActive?:     boolean
    }

    const existing = await prisma.workflowDefinition.findFirst({
      where: { id: workflowId, orgId, deletedAt: null },
    })
    if (!existing) return reply.status(404).send({ error: 'Workflow not found' })

    if (steps !== undefined) {
      if (!Array.isArray(steps) || steps.length === 0) return reply.status(400).send({ error: 'steps must be a non-empty array' })
      const stepError = validateWorkflowSteps(steps)
      if (stepError) return reply.status(400).send({ error: stepError })
    }

    if (isDefault) {
      await prisma.workflowDefinition.updateMany({
        where: { orgId, isDefault: true, deletedAt: null, id: { not: workflowId } },
        data:  { isDefault: false },
      })
    }

    const updated = await prisma.workflowDefinition.update({
      where: { id: workflowId },
      data: {
        ...(name        !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description.trim() }),
        ...(steps       !== undefined && { steps: steps as never }),
        ...(triggerRules !== undefined && { triggerRules: triggerRules as never }),
        ...(isDefault   !== undefined && { isDefault }),
        ...(isActive    !== undefined && { isActive }),
      },
    })

    return reply.send(updated)
  })


  // ── DELETE /workflows/:workflowId — soft-delete ───────────────────────────
  app.delete('/workflows/:workflowId', { preHandler: requirePermission('configure', 'workflow') }, async (req, reply) => {
    const { orgId } = req.user
    const { workflowId } = req.params as { workflowId: string }

    const existing = await prisma.workflowDefinition.findFirst({
      where: { id: workflowId, orgId, deletedAt: null },
    })
    if (!existing) return reply.status(404).send({ error: 'Workflow not found' })

    await prisma.workflowDefinition.update({
      where: { id: workflowId },
      data:  { deletedAt: new Date(), isActive: false },
    })

    return reply.status(204).send()
  })


  // ── GET /notifications — notifications for current user ───────────────────
  app.get('/notifications', { preHandler: requireUser }, async (req, reply) => {
    const { sub: userId } = req.user
    const { cursor, limit = '25' } = req.query as Record<string, string>

    const notifications = await prisma.notification.findMany({
      where:   { userId, ...(cursor && { id: { lt: cursor } }) },
      orderBy: { createdAt: 'desc' },
      take:    parseInt(limit, 10),
    })

    const unreadCount = await prisma.notification.count({ where: { userId, read: false } })
    const nextCursor = notifications.length === parseInt(limit, 10)
      ? notifications[notifications.length - 1].id
      : null

    return reply.send({ data: notifications, unreadCount, nextCursor })
  })


  // ── POST /notifications/mark-read — mark notifications as read ────────────
  app.post('/notifications/mark-read', { preHandler: requireUser }, async (req, reply) => {
    const { sub: userId } = req.user
    const { ids } = req.body as { ids?: string[] }

    if (ids && ids.length > 0) {
      await prisma.notification.updateMany({
        where: { id: { in: ids }, userId },
        data:  { read: true, readAt: new Date() },
      })
    } else {
      // Mark all as read
      await prisma.notification.updateMany({
        where: { userId, read: false },
        data:  { read: true, readAt: new Date() },
      })
    }

    return reply.status(204).send()
  })
}
