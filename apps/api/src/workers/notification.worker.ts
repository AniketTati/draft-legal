/**
 * Notification Worker — Phase 06
 * Handles 'notify' and 'escalate' jobs from notificationQueue.
 *
 * 'notify'   — writes a Notification row to DB; optionally sends email via nodemailer
 *              if SMTP_HOST is configured (non-blocking; DB notification is authoritative).
 * 'escalate' — fires when a step's escalation timer expires without a decision.
 *              Idempotent: if step already decided, exits immediately.
 */
import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { queueNotification } from '../lib/queue.js'
import type { NotificationJob, EscalationJob, SigningReminderJob } from '../lib/queue.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { sendSigningEmailForSigner } from '../lib/signing-email.js'
import { sendEmail, isEmailConfigured } from '../lib/mailer.js'

// ─── notify ───────────────────────────────────────────────────────────────────

async function handleNotify(data: NotificationJob): Promise<void> {
  // 1. Write Notification row
  await prisma.notification.create({
    data: {
      orgId:        data.orgId,
      userId:       data.userId,
      type:         data.type,
      title:        data.title,
      body:         data.body,
      resourceType: data.resourceType,
      resourceId:   data.resourceId,
    },
  })

  // 2. Optional email — only if a provider is configured; failure does NOT
  // fail the job (the DB notification is authoritative).
  if (data.email && isEmailConfigured()) {
    sendEmail({ to: data.email, subject: data.title, text: data.body })
      .then((r) => {
        if (!r.sent) console.warn('[notify] email failed for userId=%s: %s', data.userId, r.reason)
      })
      .catch((err) => console.warn('[notify] email error for userId=%s: %s', data.userId, err.message))
  } else {
    console.info('[notify] no email provider configured — notification written to DB for userId=%s type=%s', data.userId, data.type)
  }
}

// ─── escalate ─────────────────────────────────────────────────────────────────

async function handleEscalate(data: EscalationJob): Promise<void> {
  const { instanceId, stepId, orgId, escalateTo } = data

  // Idempotent: if step is already decided, skip
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId } })
  if (!step || step.status !== 'PENDING') {
    console.info('[escalate] step %s already decided (status=%s) — skipping', stepId, step?.status)
    return
  }

  if (escalateTo) {
    // Reassign: mark original step ESCALATED, create new PENDING step for escalateTo
    const instance = await prisma.approvalInstance.findUnique({ where: { id: instanceId } })

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

    const contract = instance
      ? await prisma.contract.findUnique({ where: { id: instance.contractId } })
      : null
    const escalateeUser = await prisma.user.findUnique({ where: { id: escalateTo } })

    queueNotification({
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
    // No escalateTo: flag the step and instance as ESCALATED — surface to submitter
    await prisma.$transaction([
      prisma.approvalStep.update({
        where: { id: stepId },
        data:  { status: 'ESCALATED' },
      }),
      prisma.approvalInstance.update({
        where: { id: instanceId },
        data:  { status: 'ESCALATED' },
      }),
    ])

    // Notify the original approver again
    const approver = await prisma.user.findUnique({ where: { id: step.approverId } })
    queueNotification({
      orgId,
      userId:       step.approverId,
      type:         'ESCALATION',
      title:        'Approval overdue — action required',
      body:         `An approval assigned to you is overdue. Please review and decide.`,
      resourceType: 'approval_step',
      resourceId:   stepId,
      email:        approver?.email ?? undefined,
    })
  }

  createAuditEvent({
    orgId,
    action:       AuditAction.APPROVAL_ESCALATED,
    resourceType: 'approval_instance',
    resourceId:   instanceId,
    metadata:     { stepId, escalateTo: escalateTo ?? null },
  }).catch(() => {})
}

// ─── signing-reminder ─────────────────────────────────────────────────────────
// Phase 07 Step 8 — re-emails any still-PENDING signers on a SignatureRequest
// that hasn't completed/voided/expired yet. Idempotent: rechecks state at
// fire time, so a request that completed before T-3d is a no-op.

async function handleSigningReminder(data: SigningReminderJob): Promise<void> {
  const sr = await prisma.signatureRequest.findUnique({
    where: { id: data.signatureRequestId },
    include: { signers: true },
  })
  if (!sr) {
    console.info('[signing-reminder] sr %s no longer exists — skipping', data.signatureRequestId)
    return
  }
  // Lazy-expire: if expiresAt has passed, mark EXPIRED instead of nudging.
  if (sr.expiresAt && sr.expiresAt < new Date() && sr.status === 'PENDING') {
    await prisma.signatureRequest.update({
      where: { id: sr.id },
      data:  { status: 'EXPIRED' },
    })
    await prisma.signatureEvent.create({
      data: { signatureRequestId: sr.id, kind: 'VOIDED', metadata: { autoExpired: true } },
    })
    console.info('[signing-reminder] sr %s expired before reminder — auto-marked EXPIRED', sr.id)
    return
  }
  if (sr.status !== 'PENDING') {
    console.info('[signing-reminder] sr %s is %s (not PENDING) — skipping reminder', sr.id, sr.status)
    return
  }
  const pending = sr.signers.filter(s => s.status === 'PENDING')
  if (pending.length === 0) {
    console.info('[signing-reminder] sr %s has no still-pending signers — skipping', sr.id)
    return
  }

  // Pull contract + org metadata for the email body
  const contract = await prisma.contract.findUnique({
    where: { id: sr.contractId },
    select: { title: true, type: true, org: { select: { name: true } } },
  })
  const sender = await prisma.user.findUnique({
    where: { id: sr.createdById },
    select: { name: true },
  })
  if (!contract) return

  const baseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:5173'
  // For SEQUENTIAL flows, only nudge the lowest-signOrder bucket of
  // still-pending signers — others aren't yet eligible to sign.
  const minOrder = sr.signOrder === 'SEQUENTIAL'
    ? Math.min(...pending.map(s => s.signOrder))
    : Infinity
  const nudge = sr.signOrder === 'SEQUENTIAL'
    ? pending.filter(s => s.signOrder === minOrder)
    : pending
  for (const s of nudge) {
    sendSigningEmailForSigner({
      signer: s,
      baseUrl,
      senderName: sender?.name ?? null,
      orgName: contract.org?.name ?? 'draftLegal',
      contractTitle: contract.title,
      contractType: contract.type,
      message: data.kind === 'final'
        ? '⚠ Final reminder — this signature link expires soon.'
        : 'Friendly reminder: a signature is still needed on this document.',
      expiresAt: sr.expiresAt,
    })
  }

  // Append a REMINDED audit event so the activity timeline shows it
  await prisma.signatureEvent.create({
    data: {
      signatureRequestId: sr.id,
      kind: 'REMINDED',
      metadata: { kind: data.kind, signersNotified: nudge.length },
    },
  })
  console.info('[signing-reminder] sr %s — sent %s reminder to %d signer(s)',
    sr.id, data.kind, nudge.length)
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export const notificationWorker = new Worker(
  'notifications',
  async (job) => {
    if (job.name === 'notify')           await handleNotify(job.data as NotificationJob)
    if (job.name === 'escalate')         await handleEscalate(job.data as EscalationJob)
    if (job.name === 'signing-reminder') await handleSigningReminder(job.data as SigningReminderJob)
  },
  { connection: redis, concurrency: 5 },
)

notificationWorker.on('failed', (job, err) => {
  console.error('[notification-worker] job %s/%s failed: %s', job?.name, job?.id, err.message)
})
