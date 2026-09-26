/**
 * X4 — organization.settings is one JSON blob that several routes write. Each
 * read the whole blob and wrote the whole blob back, so concurrent writes
 * undid each other: an industry-pack install (which awaits a slow seed
 * between its read and its write) reverted an ADMIN's piiRedactionMode change
 * made meanwhile, while the audit log said the change had happened.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// The seed is slow in real life (~0.5s); that window is the race. Stand it in
// with a fixed delay instead of seeding a real org.
vi.mock('../lib/org-seed.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/org-seed.js')>()),
  seedOrgDefaults: vi.fn(async () => { await new Promise(r => setTimeout(r, 400)) }),
}))

import { getApp, closeApp, makeOrg, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string
const settings = async () =>
  (await prisma.organization.findUniqueOrThrow({ where: { id: org }, select: { settings: true } })).settings as Record<string, unknown>

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Settings Race Org')
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('concurrent settings writes do not undo each other', () => {
  it('an industry-pack install in flight does not revert an ADMIN\'s PII change', async () => {
    await prisma.organization.update({ where: { id: org }, data: { settings: { piiRedactionMode: 'off' } } })
    const install = app.inject({
      method: 'POST', url: '/api/v1/organization/install-industry-pack', headers: auth(org, ['LEGAL_OPS']), payload: { packId: 'saas' },
    })
    await new Promise(r => setTimeout(r, 100))   // the install has read settings and is seeding
    const change = await app.inject({
      method: 'PATCH', url: '/api/v1/organization', headers: auth(org, ['ADMIN']), payload: { settings: { piiRedactionMode: 'redact' } },
    })
    expect(change.statusCode).toBe(200)
    expect((await install).statusCode).toBe(200)
    expect(await settings()).toMatchObject({ piiRedactionMode: 'redact', installedIndustryPacks: ['saas'] })
  })

  it('parallel writes of different keys all land', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `raceKey${i}`)
    const results = await Promise.all(keys.map(k => app.inject({
      method: 'PATCH', url: '/api/v1/organization', headers: auth(org, ['LEGAL_OPS']), payload: { settings: { [k]: true } },
    })))
    expect(results.every(r => r.statusCode === 200)).toBe(true)
    const s = await settings()
    for (const k of keys) expect(s[k], k).toBe(true)
    expect(s.piiRedactionMode).toBe('redact')
  })

  it('installing a second pack keeps the first, once', async () => {
    for (const packId of ['healthcare', 'saas']) {
      await app.inject({ method: 'POST', url: '/api/v1/organization/install-industry-pack', headers: auth(org, ['LEGAL_OPS']), payload: { packId } })
    }
    expect(((await settings()).installedIndustryPacks as string[]).sort()).toEqual(['healthcare', 'saas'])
  })
})
