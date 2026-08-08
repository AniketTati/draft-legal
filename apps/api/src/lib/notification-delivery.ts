/**
 * Notification delivery — the 'notify' job's body, extracted from the worker.
 *
 * It lives here rather than in workers/notification.worker.ts because importing
 * that file constructs a BullMQ Worker as a side effect: it connects to Redis
 * and never exits, so nothing can import it to exercise this logic.
 *
 * That mattered more than it looked. An adversarial audit of the L6b checks
 * found that BOTH probes claiming to verify "turning a notification off turns
 * it off" called `shouldEmail` directly — the pure decision function — and
 * neither ever ran the code that consumes it. The regex meant to tie the two
 * together matched the mere presence of `!gate.emailed`, so dropping the
 * `return` below would have kept every check green while mail kept going out.
 *
 * `deliverNotification` therefore RETURNS its decision instead of only logging
 * it. An outcome nothing can observe is an outcome nothing can test.
 */
import { prisma } from './prisma.js'
import { sendEmail, isEmailConfigured } from './mailer.js'
import { shouldEmail } from './notification-prefs.js'
import type { NotificationJob } from './queue.js'

export interface DeliveryResult {
  /** The in-app Notification row was written. Always true on success. */
  notified: boolean
  /** An email was actually handed to the mailer. */
  emailed:  boolean
  /** Why, in the words the logs use. */
  reason:   string
}

export async function deliverNotification(data: NotificationJob): Promise<DeliveryResult> {
  // 1. The in-app row is written regardless of preferences. The toggles govern
  // EMAIL delivery; suppressing the record too would lose the notification
  // entirely, which is not what "don't email me about this" means.
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

  if (!data.email) {
    return { notified: true, emailed: false, reason: 'no address on the job' }
  }

  // 2. The preference gate. THE `return` BELOW IS LOAD-BEARING — without it
  // the decision is computed, logged, and ignored, which is exactly the shape
  // the audit found nothing was catching.
  const gate = await shouldEmail(data.userId, data.type)
  if (!gate.emailed) {
    console.info('[notify] suppressed by preference for userId=%s type=%s (%s)', data.userId, data.type, gate.reason)
    return { notified: true, emailed: false, reason: gate.reason }
  }

  if (!isEmailConfigured()) {
    console.info('[notify] no email provider configured — notification written to DB for userId=%s type=%s', data.userId, data.type)
    return { notified: true, emailed: false, reason: 'no email provider configured' }
  }

  // Fire-and-forget: a mail failure must not fail the job, because the DB
  // notification is authoritative.
  sendEmail({ to: data.email, subject: data.title, text: data.body })
    .then((r) => {
      if (!r.sent) console.warn('[notify] email failed for userId=%s: %s', data.userId, r.reason)
    })
    .catch((err) => console.warn('[notify] email error for userId=%s: %s', data.userId, err.message))

  return { notified: true, emailed: true, reason: gate.reason }
}
