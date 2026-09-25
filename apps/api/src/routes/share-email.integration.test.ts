/**
 * Z5 — share-link emails went out through SMTP only, so a deployment on
 * SendGrid (the provider that works on Cloud Run) sent nothing, while the
 * dialog decided "sent" from SMTP_HOST alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const sent: Array<{ to: string; subject: string; replyTo?: string }> = []
vi.mock('../lib/mailer.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/mailer.js')>()),
  sendEmail: async (args: { to: string; subject: string; replyTo?: string }) => { sent.push(args); return { sent: true, via: 'sendgrid' } },
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, contract: string
const saved = { SENDGRID_API_KEY: process.env.SENDGRID_API_KEY, SMTP_HOST: process.env.SMTP_HOST, INBOUND_EMAIL_DOMAIN: process.env.INBOUND_EMAIL_DOMAIN }

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Z5 Share Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Z5 shared contract' })
})
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await cleanupAll(); await closeApp()
})

const share = (recipientEmail: string) => app.inject({
  method: 'POST', url: `/api/v1/contracts/${contract}/share`, headers: auth(org, ['ADMIN'], owner),
  payload: { permissions: ['read', 'upload'], recipientEmail },
})

describe('share-link email', () => {
  it('goes out through SendGrid when that is the configured provider, and says so', async () => {
    process.env.SENDGRID_API_KEY = 'SG.z5-test-key'
    delete process.env.SMTP_HOST
    process.env.INBOUND_EMAIL_DOMAIN = 'inbound.example.test'
    sent.length = 0

    const res = await share('counsel@counterparty.test')
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ emailedTo: 'counsel@counterparty.test', emailDelivered: true })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({
      to: 'counsel@counterparty.test',
      subject: expect.stringContaining('Z5 shared contract'),
      replyTo: `contracts+${contract}@inbound.example.test`,
    })
  })

  it('says nothing was sent when no provider is configured', async () => {
    delete process.env.SENDGRID_API_KEY
    delete process.env.SMTP_HOST
    sent.length = 0
    const res = await share('other@counterparty.test')
    expect(res.json()).toMatchObject({ emailDelivered: false })
    await new Promise(r => setTimeout(r, 100))
    expect(sent).toEqual([])
  })
})
