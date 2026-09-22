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
import type { NotificationJob, EscalationJob, SigningReminderJob } from '../lib/queue.js'
import { sendSigningEmailForSigner } from '../lib/signing-email.js'
import { sendEmail, isEmailConfigured } from '../lib/mailer.js'
// L6 #3 — the delivery path. Lives in lib/ rather than here because importing
// this file constructs a BullMQ Worker as a side effect, so nothing could
// import it to check whether the preference gate is actually honoured.
import { deliverNotification } from '../lib/notification-delivery.js'
import { handleEscalate } from '../lib/approval-escalation.js'

// ─── notify ───────────────────────────────────────────────────────────────────
// The body lives in lib/notification-delivery.ts so it can be imported and
// exercised without constructing this file's BullMQ Worker. See that module
// for why that mattered.

async function handleNotify(data: NotificationJob): Promise<void> {
  await deliverNotification(data)
}

// ─── escalate ─────────────────────────────────────────────────────────────────
// The body lives in lib/approval-escalation.ts so it can be tested without
// constructing this file's BullMQ Worker.

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
