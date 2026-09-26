/**
 * Y5 — a deployed API is strict whatever its NODE_ENV says, unless it is
 * exactly `development` or `test`. Checks keyed on `NODE_ENV !== 'production'`
 * were open on staging and previews (X31, X35, X39), and a placeholder secret
 * passed there (X38).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../app.js'
import { seedPassword } from '../lib/seed-password.js'
import { ssrfGuardEnabled } from '../lib/ssrf-guard.js'
import { devPrint } from '../lib/log-scrub.js'

const strong = () => randomBytes(36).toString('base64url')
const apps: Array<{ close(): Promise<unknown> }> = []

/** The API as it boots with `env` over strong secrets: what a request to it answers. */
async function boot(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries({ JWT_SECRET: strong(), PORTAL_JWT_SECRET: strong(), INTERNAL_SERVICE_SECRET: strong(), ...env })) {
    vi.stubEnv(name, value)
  }
  const app = await buildApp()
  apps.push(app)
  await app.ready()
  return { inject: (url: string) => app.inject({ url }) }
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe.each([['staging'], ['preview'], [undefined]])('with NODE_ENV=%s', (NODE_ENV) => {
  it('a placeholder secret stops the boot', async () => {
    await expect(boot({ NODE_ENV, JWT_SECRET: 'change-me' })).rejects.toThrow(/JWT_SECRET/)
    await expect(boot({ NODE_ENV, INTERNAL_SERVICE_SECRET: 'CHANGE_ME_internal_service_secret_value' })).rejects.toThrow(/INTERNAL_SERVICE_SECRET/)
  })

  it('a development-only relaxation stops the boot', async () => {
    await expect(boot({ NODE_ENV, BULL_BOARD_OPEN: 'true' })).rejects.toThrow(/BULL_BOARD_OPEN/)
    await expect(boot({ NODE_ENV, INBOUND_EMAIL_ALLOW_ALL: '1' })).rejects.toThrow(/INBOUND_EMAIL_ALLOW_ALL/)
  })

  it('Bull Board needs the internal secret, and the production rate limit applies', async () => {
    const app = await boot({ NODE_ENV })
    expect((await app.inject('/admin/queues')).statusCode).toBe(401)
    expect((await app.inject('/health/live')).headers['x-ratelimit-limit']).toBe('1000')
  })

  it('the seed gets no demo password, the SSRF guard is on, and printed links are masked', () => {
    vi.stubEnv('NODE_ENV', NODE_ENV)
    expect(seedPassword().generated).toBe(true)
    expect(ssrfGuardEnabled()).toBe(true)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    devPrint('[signing] ✉  a@b.c  →  https://app.example.com/sign/tok-y5-5512')
    expect(info.mock.calls.flat().join(' ')).toContain('/sign/[REDACTED]')
  })
})

describe('with NODE_ENV=development and the relaxations on', () => {
  it('boots as before: Bull Board open, the development rate limit, the demo seed password, links whole', async () => {
    const app = await boot({ NODE_ENV: 'development', BULL_BOARD_OPEN: 'true', INBOUND_EMAIL_ALLOW_ALL: '1' })
    expect((await app.inject('/admin/queues')).statusCode).not.toBe(401)
    expect((await app.inject('/health/live')).headers['x-ratelimit-limit']).toBe('10000')
    expect(seedPassword()).toEqual({ password: 'password123', generated: false })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    devPrint('[signing] ✉  a@b.c  →  https://app.example.com/sign/tok-y5-5512')
    expect(info.mock.calls.flat().join(' ')).toContain('tok-y5-5512')
  })
})
