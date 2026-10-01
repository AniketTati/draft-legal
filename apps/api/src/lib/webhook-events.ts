/**
 * webhook-events.ts (P10A)
 *
 * One-liner helper for emitting a webhook event to every webhook in
 * the org that's subscribed. Safe to call from anywhere — failures
 * are logged but never thrown back to the caller, so wiring this into
 * existing happy-path code is risk-free.
 */
import { prisma } from './prisma.js'
import { queueWebhookDelivery } from './queue.js'
import { noteIntegrationEvent } from './integrations/sync-queue.js'

export async function fireWebhook(
  orgId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // docs/41 Part 17 — the same events keep a connected Salesforce current.
  void noteIntegrationEvent(orgId, event, payload)
  try {
    const webhooks = await prisma.webhook.findMany({
      where: {
        orgId,
        deletedAt: null,
        enabled: true,
        events: { has: event },
      },
      select: { id: true },
    })
    if (webhooks.length === 0) return
    await Promise.all(webhooks.map(w =>
      queueWebhookDelivery({ webhookId: w.id, event, payload })
        .catch(err => console.warn('[webhook] failed to enqueue %s for %s: %s', event, w.id, (err as Error).message))
    ))
  } catch (err) {
    console.warn('[webhook] fireWebhook(%s, %s) failed: %s', orgId, event, (err as Error).message)
  }
}
