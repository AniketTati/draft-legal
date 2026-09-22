/**
 * S1 — GET /organization is readable by every member, so it must never carry
 * the Slack signing secret or bot token stored under settings.slack. With the
 * signing secret a member could forge signed Slack Approve/Reject clicks.
 *
 * PATCH merges settings shallowly, so it must also refuse to overwrite the
 * server-managed `slack` key — otherwise a client echoing back the redacted
 * summary (WelcomeChecklist does exactly this) would wipe the real config.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

const SIGNING_SECRET = 'it-slack-signing-secret-0123456789'
const BOT_TOKEN = 'xoxb-it-bot-token-0123456789'

let app: TestApp
let org: string

async function storedSlack(): Promise<Record<string, unknown>> {
  const row = await prisma.organization.findUnique({ where: { id: org }, select: { settings: true } })
  return (row?.settings as Record<string, unknown>).slack as Record<string, unknown>
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Org Settings Org')
  await prisma.organization.update({
    where: { id: org },
    data: {
      settings: {
        onboardingCompleted: true,
        slack: { teamId: 'T123', signingSecret: SIGNING_SECRET, botToken: BOT_TOKEN, configuredAt: '2026-09-01T00:00:00.000Z' },
      },
    },
  })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('GET /organization does not leak integration secrets', () => {
  it('a low-privilege member (SALES_REP) sees neither Slack secret', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/organization', headers: auth(org, ['SALES_REP']) })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(SIGNING_SECRET)
    expect(res.body).not.toContain(BOT_TOKEN)
    const body = res.json()
    expect(body.settings.onboardingCompleted).toBe(true)
    expect(body.settings.slack).toEqual({
      connected: true,
      teamId: 'T123',
      configuredAt: '2026-09-01T00:00:00.000Z',
      hasSigningSecret: true,
      hasBotToken: true,
    })
  })

  it('an ADMIN does not get the secrets from this route either', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/organization', headers: auth(org, ['ADMIN']) })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(SIGNING_SECRET)
    expect(res.body).not.toContain(BOT_TOKEN)
  })
})

describe('PATCH /organization cannot overwrite server-managed settings', () => {
  it('echoing the redacted settings back keeps the real Slack config and applies the flag', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/organization', headers: auth(org, ['ADMIN']) })
    const current = get.json().settings
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/organization', headers: auth(org, ['ADMIN']),
      payload: { settings: { ...current, welcomeChecklistDismissed: true } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(SIGNING_SECRET)
    expect(res.body).not.toContain(BOT_TOKEN)
    expect(res.json().settings.welcomeChecklistDismissed).toBe(true)

    const slack = await storedSlack()
    expect(slack.signingSecret).toBe(SIGNING_SECRET)
    expect(slack.botToken).toBe(BOT_TOKEN)
  })

  // LEGAL_OPS holds configure:integration (so may PATCH) but not
  // configure:organization (so may not use the Slack admin routes).
  it.each([['ADMIN'], ['LEGAL_OPS']])('a forged or blank slack key from %s is ignored', async (role) => {
    for (const forged of [{ teamId: 'TEVIL', signingSecret: 'attacker' }, null, {}]) {
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/organization', headers: auth(org, [role]),
        payload: { settings: { slack: forged } },
      })
      expect(res.statusCode).toBe(200)
      const slack = await storedSlack()
      expect(slack.teamId).toBe('T123')
      expect(slack.signingSecret).toBe(SIGNING_SECRET)
    }
  })
})
