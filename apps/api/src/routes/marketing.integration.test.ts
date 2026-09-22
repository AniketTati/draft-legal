/**
 * H1 — the marketing contact form must do what the page tells visitors:
 * save the submission AND tell a human (it used to only save and log).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; text: string }> }))
vi.mock('../lib/mailer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/mailer.js')>()),
  isEmailConfigured: () => true,
  sendEmail: async (args: { to: string; subject: string; text: string }) => { sent.push(args); return { sent: true, via: 'smtp' } },
}))

import { getApp, closeApp, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
const ids: string[] = []
// The route allows 5 submissions/hour/IP in a Redis-backed limiter that
// outlives a test run — give every run its own client address.
const remoteAddress = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`

beforeAll(async () => {
  app = await getApp()
  process.env.MARKETING_CONTACT_EMAIL = 'sales@example.test'
})

afterAll(async () => {
  delete process.env.MARKETING_CONTACT_EMAIL
  await prisma.marketingContact.deleteMany({ where: { id: { in: ids } } })
  await closeApp()
})

describe('POST /api/v1/marketing/contact', () => {
  it('saves the submission and emails the configured inbox', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/marketing/contact', remoteAddress,
      payload: { name: 'Ada Lovelace', email: 'ada@example.test', company: 'Analytical', message: 'Interested in a demo', source: 'contact' },
    })
    expect(res.statusCode).toBe(201)
    ids.push(res.json().id)
    expect(await prisma.marketingContact.count({ where: { id: res.json().id } })).toBe(1)
    await new Promise(r => setTimeout(r, 20))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'sales@example.test', subject: 'New contact: Ada Lovelace (Analytical)' })
    expect(sent[0].text).toContain('Interested in a demo')
  })

  it("rejects the old email-capture body (email + source only) rather than faking success", async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/marketing/contact', remoteAddress, payload: { email: 'lead@example.test', source: 'template_nda' },
    })
    expect(res.statusCode).toBe(400)
  })
})
