/**
 * X39 — the webhook worker checked the webhook's URL with the SSRF guard and
 * then fetched it with the default `redirect: 'follow'`. A public URL that
 * answered 302 or 307 with a private or cloud-metadata Location sent the
 * delivery there (307/308 keep the POST and its body), and the stored status
 * told the org admin what the internal endpoint answered.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Importing the worker module starts a BullMQ worker; the test calls the
// delivery handler directly instead.
vi.mock('bullmq', async importOriginal => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: class { on() { return this } },
}))

import { handleWebhookDelivery } from './webhook.worker.js'
import { makeOrg, makeUser, cleanupAll, prisma } from '../test-support/helpers.js'

let org: string, user: string

beforeAll(async () => {
  org = await makeOrg('Webhook Redirect Org')
  user = await makeUser(org)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.webhookDelivery.deleteMany({ where: { webhook: { orgId: org } } })
  await prisma.webhook.deleteMany({ where: { orgId: org } })
  await cleanupAll()
})

describe('a webhook URL that redirects', () => {
  it('is not followed: the delivery fails and says why', async () => {
    const wh = await prisma.webhook.create({
      data: { orgId: org, name: 'Redirecting hook', url: 'https://93.184.215.14/hook', secret: 's', events: [], createdById: user },
    })
    const calls: Array<RequestInit | undefined> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls.push(init)
      return new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    })

    await expect(handleWebhookDelivery({ webhookId: wh.id, event: 'webhook.test', payload: {} } as never)).rejects.toThrow(/redirect/i)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.redirect).toBe('manual')

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { webhookId: wh.id } })
    expect(delivery.succeeded).toBe(false)
    expect(delivery.responseStatus).toBe(307)
    expect(delivery.errorMessage).toMatch(/redirect/i)
  })
})
