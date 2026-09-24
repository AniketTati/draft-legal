/**
 * S1 — GET /organization is readable by every member, so it must never carry
 * the Slack signing secret or bot token stored under settings.slack. With the
 * signing secret a member could forge signed Slack Approve/Reject clicks.
 *
 * PATCH merges settings shallowly, so it must also refuse to overwrite the
 * server-managed `slack` key — otherwise a client echoing back the redacted
 * summary (WelcomeChecklist does exactly this) would wipe the real config.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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

// X5 — PATCH /organization is open to configure:integration (LEGAL_OPS). PII
// redaction is a data-protection control: switching it off sends SSNs, card
// numbers and dates of birth to the LLM providers, so it needs the admin
// permission the rest of the AI config needs, a valid value, and an audit row.
describe('PATCH /organization protects piiRedactionMode', () => {
  const patch = (roles: string[], settings: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: auth(org, roles), payload: { settings } })
  const mode = async () =>
    ((await prisma.organization.findUniqueOrThrow({ where: { id: org }, select: { settings: true } })).settings as Record<string, unknown>).piiRedactionMode

  it('LEGAL_OPS cannot switch redaction off', async () => {
    const res = await patch(['LEGAL_OPS'], { piiRedactionMode: 'off' })
    expect(res.statusCode).toBe(403)
    expect(await mode()).toBeUndefined()
  })

  it('LEGAL_OPS still saves ordinary settings', async () => {
    expect((await patch(['LEGAL_OPS'], { welcomeChecklistDismissed: true })).statusCode).toBe(200)
  })

  it('only the three real modes are accepted', async () => {
    expect((await patch(['ADMIN'], { piiRedactionMode: 'none' })).statusCode).toBe(400)
    expect(await mode()).toBeUndefined()
  })

  it('an ADMIN can change it, and the change is audited', async () => {
    expect((await patch(['ADMIN'], { piiRedactionMode: 'tokenize' })).statusCode).toBe(200)
    expect(await mode()).toBe('tokenize')
    const events = await prisma.auditEvent.findMany({ where: { orgId: org, action: 'AI_SETTINGS_UPDATED', resourceType: 'organization' } })
    expect(events).toHaveLength(1)
    expect(events[0].metadata).toEqual({ changed: { piiRedactionMode: { from: null, to: 'tokenize' } } })
    // Saving the same value again is not a change.
    await patch(['ADMIN'], { piiRedactionMode: 'tokenize' })
    expect(await prisma.auditEvent.count({ where: { orgId: org, action: 'AI_SETTINGS_UPDATED' } })).toBe(1)
  })

  it('if the audit row cannot be written, the change is not applied either', async () => {
    const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('audit store unavailable'))
    const res = await patch(['ADMIN'], { piiRedactionMode: 'off' })
    spy.mockRestore()
    expect(res.statusCode).toBe(500)
    expect(await mode()).toBe('tokenize')
  })

  it('built-in object names are ordinary keys, not protected ones', async () => {
    expect((await patch(['LEGAL_OPS'], { constructor: 'x', toString: 'y' })).statusCode).toBe(200)
    expect((await patch(['ADMIN'], { hasOwnProperty: 'z' })).statusCode).toBe(200)
  })
})

// X59 — the General tab sends what its fields hold, and an empty logo field is
// ''. The schema required a URL, so an org without a logo could not save its
// name or colour at all.
describe('PATCH /organization logo and brand colour', () => {
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: auth(org, ['ADMIN']), payload })
  const stored = () => prisma.organization.findUniqueOrThrow({ where: { id: org }, select: { name: true, logoUrl: true, brandColor: true } })

  it('saves with an empty logo field, which clears the logo', async () => {
    await prisma.organization.update({ where: { id: org }, data: { logoUrl: 'https://cdn.example.com/logo.png', brandColor: '#123456' } })
    const res = await patch({ name: 'Org Settings Org Renamed', logoUrl: '', brandColor: '' })
    expect(res.statusCode).toBe(200)
    expect(res.json().logoUrl).toBeNull()
    expect(await stored()).toEqual({ name: 'Org Settings Org Renamed', logoUrl: null, brandColor: null })
  })

  it('a real logo URL still saves, and anything else is still refused', async () => {
    expect((await patch({ logoUrl: 'https://cdn.example.com/new.png' })).statusCode).toBe(200)
    expect((await patch({ logoUrl: 'not a url' })).statusCode).toBe(422)
    expect((await stored()).logoUrl).toBe('https://cdn.example.com/new.png')
  })
})

// X61 — Admin → Integrations gates on configure:organization because every
// route behind its tabs does. Legal Ops has configure:integration only.
describe('Admin → Integrations routes need configure:organization', () => {
  const urls = ['/api/v1/admin/integrations/api-keys', '/api/v1/admin/integrations/webhooks',
    '/api/v1/admin/integrations/slack', '/api/v1/admin/integrations/health']

  it('refuse Legal Ops, and answer an admin', async () => {
    for (const url of urls) {
      expect((await app.inject({ method: 'GET', url, headers: auth(org, ['LEGAL_OPS']) })).statusCode, url).toBe(403)
      expect((await app.inject({ method: 'GET', url, headers: auth(org, ['ADMIN']) })).statusCode, url).toBe(200)
    }
  })
})
