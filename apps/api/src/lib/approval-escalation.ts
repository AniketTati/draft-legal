/**
 * Approval-step escalation — runs when a step's escalation timer expires
 * without a decision. Idempotent: a step already decided is left alone.
 *
 * Lives in lib/ (not the worker file) so it can be exercised without
 * constructing the notification worker's BullMQ Worker, like
 * notification-delivery.ts.
 *
 * C2 — with no `escalateTo` (the workflow builder's default) the step and the
 * instance used to become ESCALATED. That took the step out of every queue,
 * /decide only accepts PENDING steps, and nothing could withdraw it, so the
 * contract sat in PENDING_APPROVAL forever. Now the step stays with its
 * approver, who is reminded, and the org's admins are told it is overdue with
 * nobody to escalate to.
 */
import { prisma } from './prisma.js'
import { queueNotification } from './queue.js'
import type { EscalationJob, NotificationJob } from './queue.js'
import { createAuditEvent } from './audit.js'
import { AuditAction } from '@clm/types'

export async function handleEscalate(
  data: EscalationJob,
  notify: (n: NotificationJob) => void = queueNotification,
): Promise<void> {
  const { instanceId, stepId, orgId, escalateTo } = data

  // Idempotent: if step is already decided, skip
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId } })
  if (!step || step.status !== 'PENDING') {
    console.info('[escalate] step %s already decided (status=%s) — skipping', stepId, step?.status)
    return
  }

  const instance = await prisma.approvalInstance.findUnique({ where: { id: instanceId } })
  const contract = instance
    ? await prisma.contract.findUnique({ where: { id: instance.contractId }, select: { title: true } })
    : null
  let adminsNotified = 0

  if (escalateTo) {
    // Reassign: mark original step ESCALATED, create new PENDING step for escalateTo
    await prisma.$transaction([
      prisma.approvalStep.update({
        where: { id: stepId },
        data:  { status: 'ESCALATED', decidedAt: new Date() },
      }),
      prisma.approvalStep.create({
        data: {
          approvalInstanceId: instanceId,
          orgId,
          stepOrder:  step.stepOrder,
          stepName:   step.stepName,
          approverId: escalateTo,
          status:     'PENDING',
          escalateAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // default 48h for escalated step
        },
      }),
    ])

    const escalateeUser = await prisma.user.findUnique({ where: { id: escalateTo } })

    notify({
      orgId,
      userId:       escalateTo,
      type:         'ESCALATION',
      title:        'Contract escalated to you for approval',
      body:         `"${contract?.title ?? 'Contract'}" approval was not acted upon and has been escalated to you.`,
      resourceType: 'approval_instance',
      resourceId:   instanceId,
      email:        escalateeUser?.email ?? undefined,
    })
  } else {
    // No escalation target: leave the step PENDING with its approver — still
    // in their queue and still decidable — and chase both the approver and
    // the people who can reassign it.
    const approver = await prisma.user.findUnique({ where: { id: step.approverId } })
    notify({
      orgId,
      userId:       step.approverId,
      type:         'ESCALATION',
      title:        'Approval overdue — action required',
      body:         `"${contract?.title ?? 'A contract'}" is waiting on your approval and is overdue. Please review and decide.`,
      resourceType: 'approval_instance',
      resourceId:   instanceId,
      email:        approver?.email ?? undefined,
    })

    const admins = await prisma.user.findMany({
      where: {
        orgId,
        deletedAt: null,
        status: 'ACTIVE',
        id: { not: step.approverId },
        userRoles: { some: { role: { name: 'ADMIN' } } },
      },
      select: { id: true, email: true },
      take: 10,
    })
    for (const admin of admins) {
      notify({
        orgId,
        userId:       admin.id,
        type:         'ESCALATION',
        title:        'Approval overdue — no escalation target',
        body:         `"${contract?.title ?? 'A contract'}" has waited past its deadline on step "${step.stepName}" `
                    + `(${approver?.name ?? 'the assigned approver'}), and the workflow names no one to escalate to. `
                    + `The approver can still decide; delegate the step or set an escalation target on the workflow.`,
        resourceType: 'approval_instance',
        resourceId:   instanceId,
        email:        admin.email ?? undefined,
      })
    }
    adminsNotified = admins.length
  }

  createAuditEvent({
    orgId,
    action:       AuditAction.APPROVAL_ESCALATED,
    resourceType: 'approval_instance',
    resourceId:   instanceId,
    metadata:     { stepId, escalateTo: escalateTo ?? null, ...(escalateTo ? {} : { adminsNotified }) },
  }).catch(() => {})
}
