/**
 * webhook.worker — delivers events to customer-configured webhooks.
 *
 * Each delivery POSTs the event payload as JSON to the webhook's URL
 * with HMAC headers so the receiver can verify authenticity:
 *
 *   X-CLM-Event:        contract.executed
 *   X-CLM-Signature:    sha256=<hmac-sha256(body, webhook.secret)>
 *   X-CLM-Delivery-Id:  <delivery row id>
 *   Content-Type:       application/json
 *
 * Failures retry up to 5 times with exponential backoff. Each attempt
 * is recorded in WebhookDelivery for the customer-facing delivery log.
 */
import { Worker } from 'bullmq'
import crypto from 'node:crypto'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import type { WebhookDeliveryJob } from '../lib/queue.js'
import { formatForSlack } from '../lib/slack-formatter.js'
import { formatForTeams } from '../lib/teams-formatter.js'
import { assertPublicUrl, ssrfGuardEnabled } from '../lib/ssrf-guard.js'

export async function handleWebhookDelivery(data: WebhookDeliveryJob) {
  const wh = await prisma.webhook.findUnique({
    where: { id: data.webhookId },
    select: { id: true, url: true, secret: true, enabled: true, deletedAt: true, events: true, type: true },
  })
  if (!wh || !wh.enabled || wh.deletedAt) {
    console.info('[webhook-worker] webhook %s no longer eligible — skipping', data.webhookId)
    return
  }
  // For real events (not webhook.test), verify the webhook is subscribed to it.
  if (data.event !== 'webhook.test' && !wh.events.includes(data.event)) {
    console.info('[webhook-worker] webhook %s not subscribed to %s', data.webhookId, data.event)
    return
  }

  // Open a delivery row up front so failures still get recorded.
  const delivery = await prisma.webhookDelivery.create({
    data: { webhookId: wh.id, event: data.event, payload: data.payload as never },
  })

  // P10B — when wh.type === 'slack', format the payload as Slack blocks
  // so paste-in Slack incoming-webhook URLs render as messages instead
  // of JSON dumps. Slack ignores the HMAC headers (which is fine; their
  // URL itself is the auth) but we still send the signature for any
  // self-hosted Slack-compatible receiver.
  // Phase 10 — 'teams' formats as an Adaptive Card for Teams Workflows
  // webhooks, same idea as the Slack-blocks path.
  const body = wh.type === 'slack'
    ? JSON.stringify(formatForSlack(data.event, data.payload))
    : wh.type === 'teams'
    ? JSON.stringify(formatForTeams(data.event, data.payload))
    : JSON.stringify({ event: data.event, timestamp: new Date().toISOString(), data: data.payload })
  const signature = crypto.createHmac('sha256', wh.secret).update(body).digest('hex')

  let responseStatus: number | null = null
  let responseBody:   string | null  = null
  let succeeded = false
  let errorMessage: string | null = null

  try {
    // Wave 1.5 — SSRF guard: refuse to POST to a URL that resolves to a
    // private / loopback / link-local / cloud-metadata address (every
    // environment since X35; a self-host that must deliver to its own
    // network opts out via WEBHOOK_ALLOW_PRIVATE_URLS).
    // Throws before the fetch, so an internal target never gets a request.
    await assertPublicUrl(wh.url)
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15_000)
    const r = await fetch(wh.url, {
      method: 'POST',
      headers: {
        'content-type':       'application/json',
        'x-clm-event':        data.event,
        'x-clm-signature':    `sha256=${signature}`,
        'x-clm-delivery-id':  delivery.id,
        'user-agent':         'CLM-Webhooks/1.0',
      },
      body,
      signal: ctrl.signal,
      // X39 — never follow a redirect: the guard above checked this URL only,
      // and a redirect could send the delivery (with 307/308, its body too)
      // to a private or cloud-metadata address.
      redirect: 'manual',
    })
    clearTimeout(t)
    responseStatus = r.status
    // Wave 1.5 — do NOT reflect the response body into the delivery log when
    // the SSRF guard is active: it was an exfiltration channel (a blocked
    // internal endpoint's content leaking to a tenant). Store status only.
    // With the guard turned off (WEBHOOK_ALLOW_PRIVATE_URLS) we keep a
    // capped body for debugging.
    if (ssrfGuardEnabled()) {
      responseBody = null
    } else {
      const text = await r.text().catch(() => '')
      responseBody = text.slice(0, 1000)
    }
    succeeded = r.ok
    if (!succeeded) {
      errorMessage = r.status >= 300 && r.status < 400
        ? `Redirect (${r.status}) not followed: set the webhook to its final URL`
        : `Non-2xx response: ${r.status}`
    }
  } catch (err) {
    errorMessage = (err as Error).message?.slice(0, 500) ?? 'Delivery failed'
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      responseStatus, responseBody, errorMessage,
      attempts: { increment: 1 },
      succeeded,
      deliveredAt: succeeded ? new Date() : null,
    },
  })

  await prisma.webhook.update({
    where: { id: wh.id },
    data: succeeded
      ? { lastDeliveryAt: new Date(), lastDeliveryStatus: 'success', failureCount: 0 }
      : { lastDeliveryAt: new Date(), lastDeliveryStatus: 'failed',  failureCount: { increment: 1 } },
  })

  if (!succeeded) {
    // Throw so BullMQ retries. After 5 attempts the job is moved to
    // failed; the WebhookDelivery row remains with the last error.
    throw new Error(errorMessage ?? 'Webhook delivery failed')
  }
}

export const webhookWorker = new Worker(
  'webhooks',
  async (job) => {
    if (job.name === 'deliver') await handleWebhookDelivery(job.data as WebhookDeliveryJob)
  },
  { connection: redis, concurrency: 5 },
)

webhookWorker.on('failed', (job, err) => {
  console.warn('[webhook-worker] job %s failed (attempt %d): %s', job?.id, job?.attemptsMade, err.message)
})
