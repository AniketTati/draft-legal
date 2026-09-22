/**
 * X6 — a Slack team id names a workspace, not an org, and any admin can type
 * any team id into Admin → Integrations → Slack. The inbound routes took the
 * first org listing the team id and checked Slack's signature against THAT
 * org's secret, so a second org claiming the same team id broke the real
 * org's Slack (every command and button click failed verification). The org
 * is now the one whose signing secret actually signed the request — which also
 * keeps two orgs that genuinely share a workspace working.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
const TEAM = `T-X6-${Date.now()}`

async function slackOrg(name: string, secret: unknown, contractTitle: string, team = TEAM, teamVerified: boolean | 'legacy' = false) {
  const org = await makeOrg(name)
  const slack: Record<string, unknown> = { teamId: team, signingSecret: secret, configuredAt: new Date().toISOString() }
  if (teamVerified !== 'legacy') slack.teamVerified = teamVerified   // a pre-X6 config has no flag at all
  await prisma.organization.update({ where: { id: org }, data: { settings: { slack } as never } })
  await makeContract(org, await makeUser(org), { title: contractTitle })
  return org
}

function command(secret: string, text: string, team = TEAM) {
  const body = new URLSearchParams({ team_id: team, text, user_id: 'U123', command: '/contract' }).toString()
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
  return app.inject({
    method: 'POST', url: '/api/v1/slack/commands', payload: body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
  })
}

beforeAll(async () => {
  app = await getApp()
  // The squatter claims the team id FIRST, so "first match" resolves to it.
  await slackOrg('X6 Squatter', 'squatter-secret', 'Squatter Thing')
  await slackOrg('X6 Real Org', 'real-secret', 'Acme Master Services')
  await slackOrg('X6 Sister Org', 'sister-secret', 'Acme Sister Deal')
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('Slack requests resolve to the org whose secret signed them', () => {
  it('the real org still works after another org claims its team id', async () => {
    const res = await command('real-secret', 'search Acme')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Acme Master Services')
    expect(res.body).not.toContain('Acme Sister Deal')
  })

  it('an org sharing the workspace with its own app gets its own results', async () => {
    const res = await command('sister-secret', 'search Acme')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Acme Sister Deal')
    expect(res.body).not.toContain('Acme Master Services')
  })

  it('a request no org signed is still refused', async () => {
    expect((await command('nobodys-secret', 'search Acme')).statusCode).toBe(401)
  })

  it('a request not sent as a urlencoded Slack body is refused', async () => {
    // Its own team, so the only candidate is the org whose secret signed it.
    const JTEAM = `T-X6J-${Date.now()}`
    await slackOrg('X6 Json Org', 'json-secret', 'Json Contract', JTEAM)
    const ts = String(Math.floor(Date.now() / 1000))
    // Signed over an empty body: with no raw body to check, that used to pass.
    const sig = `v0=${crypto.createHmac('sha256', 'json-secret').update(`v0:${ts}:`).digest('hex')}`
    const res = await app.inject({
      method: 'POST', url: '/api/v1/slack/commands', payload: { team_id: JTEAM, text: 'search Json' },
      headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('a verified owner cannot be crowded out', () => {
  const VTEAM = `T-X6V-${Date.now()}`
  const NTEAM = `T-X6N-${Date.now()}`

  beforeAll(async () => {
    // Twenty squatters claim the team first — more than the candidates tried.
    for (let i = 0; i < 20; i++) await slackOrg(`X6 Squatter ${i}`, `squat-${i}`, `Squat ${i}`, VTEAM)
    await slackOrg('X6 Verified Owner', 'owner-secret', 'Owner Contract Zeta', VTEAM, true)
    // A row with a non-string secret, older than the real org on its team.
    await slackOrg('X6 Broken Row', 12345, 'Broken', NTEAM)
    await slackOrg('X6 Beside Broken', 'beside-secret', 'Beside Contract Eta', NTEAM)
  })

  it('the verified owner is found however many squatters came first', async () => {
    const res = await command('owner-secret', 'search Zeta', VTEAM)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Owner Contract Zeta')
  })

  it('a config saved before verification existed ranks by age, not behind every new claim', async () => {
    const LTEAM = `T-X6L-${Date.now()}`
    await slackOrg('X6 Legacy Owner', 'legacy-secret', 'Legacy Contract Theta', LTEAM, 'legacy')
    for (let i = 0; i < 20; i++) await slackOrg(`X6 New Squatter ${i}`, `new-squat-${i}`, `NewSquat ${i}`, LTEAM)
    const res = await command('legacy-secret', 'search Theta', LTEAM)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Legacy Contract Theta')
  })

  it('an interaction naming its team as a non-string is refused, not a 500', async () => {
    for (const team of [123, { id: 'x' }, ['T1'], true]) {
      const body = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: team } }) }).toString()
      const ts = String(Math.floor(Date.now() / 1000))
      const sig = `v0=${crypto.createHmac('sha256', 'real-secret').update(`v0:${ts}:${body}`).digest('hex')}`
      const res = await app.inject({
        method: 'POST', url: '/api/v1/slack/interactions', payload: body,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
      })
      expect(res.statusCode, JSON.stringify(team)).toBe(401)
    }
    const nullPayload = await app.inject({
      method: 'POST', url: '/api/v1/slack/interactions', payload: 'payload=null',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(nullPayload.statusCode).toBe(400)
  })

  it('a malformed row doesn\'t take the team down for everyone', async () => {
    const res = await command('beside-secret', 'search Eta', NTEAM)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Beside Contract Eta')
  })
})

describe('saving the Slack config verifies the workspace with the bot token', () => {
  let org: string
  const PTEAM = `T-X6P-${Date.now()}`
  beforeAll(async () => {
    org = await makeOrg('X6 Put Org')
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'https://slack.com/api/auth.test') {
        const token = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '')
        const body = token === 'xoxb-good' ? { ok: true, team_id: PTEAM }
          : token === 'xoxb-elsewhere' ? { ok: true, team_id: 'T-SOMEONE-ELSE' }
          : { ok: false, error: 'invalid_auth' }
        return new Response(JSON.stringify(body))
      }
      return realFetch(input as never, init)
    })
  })
  afterAll(() => { vi.restoreAllMocks() })

  const put = (botToken: string) => app.inject({
    method: 'PUT', url: '/api/v1/admin/integrations/slack', headers: auth(org, ['ADMIN']),
    payload: { teamId: PTEAM, signingSecret: 'put-secret', botToken },
  })

  it('a token for this workspace verifies it', async () => {
    const res = await put('xoxb-good')
    expect(res.statusCode).toBe(200)
    expect(res.json().teamVerified).toBe(true)
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/integrations/slack', headers: auth(org, ['ADMIN']) })
    expect(get.json().teamVerified).toBe(true)
  })

  it('a token for another workspace, or one Slack rejects, is refused', async () => {
    expect((await put('xoxb-elsewhere')).statusCode).toBe(400)
    expect((await put('xoxb-revoked')).statusCode).toBe(400)
  })
})
