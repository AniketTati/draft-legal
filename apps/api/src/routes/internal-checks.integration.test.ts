/**
 * X35 — internal-only checks that let callers through outside production, or
 * with their secret unset. On staging and previews each was open to anyone:
 * - Bull Board (job payloads; retry and remove) whenever NODE_ENV wasn't
 *   'production';
 * - the chunk-and-index callback, which compared the header with an unset
 *   secret (undefined === undefined);
 * - the inbound-email webhook, which took unauthenticated mail when its
 *   secret was unset.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const { chunked } = vi.hoisted(() => ({ chunked: [] as unknown[] }))
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueChunkAndIndex: (job: unknown) => { chunked.push(job) },
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let contract: string, version: string

beforeAll(async () => {
  app = await getApp()
  const org = await makeOrg('Internal Checks Org')
  const owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Chunked' })
  version = (await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: owner, plainText: 'x' } })).id
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

/** Runs `fn` with an environment variable set (or unset), then puts it back. */
async function withEnv(name: string, value: string | undefined, fn: () => Promise<void>) {
  const saved = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await fn()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

const secret = () => process.env.INTERNAL_SERVICE_SECRET as string

describe('Bull Board', () => {
  it('needs the internal secret outside production too, unless a developer opts in', async () => {
    expect(process.env.NODE_ENV).not.toBe('production')
    const get = (headers: Record<string, string> = {}, url = '/admin/queues') => app.inject({ method: 'GET', url, headers })
    expect((await get()).statusCode).toBe(401)
    expect((await get({ 'x-internal-secret': 'wrong' })).statusCode).toBe(401)
    expect((await get({ 'x-internal-secret': secret() })).statusCode).toBe(200)
    // Paths the router decodes still reach Bull Board, so they need the secret too.
    for (const url of ['/%61dmin/queues/api/queues', '/admin/queue%73/api/queues', '/admin/queues/api/redis/stats']) {
      expect((await get({}, url)).statusCode, url).toBe(401)
    }

    await withEnv('BULL_BOARD_OPEN', 'true', async () => {
      expect((await get()).statusCode).toBe(200)
      // …never in production.
      await withEnv('NODE_ENV', 'production', async () => {
        expect((await get()).statusCode).toBe(401)
      })
    })
  })
})

describe('the chunk-and-index callback', () => {
  it('refuses every caller while the secret is unset', async () => {
    const url = `/api/v1/contracts/${contract}/versions/${version}/chunk`
    await withEnv('INTERNAL_SERVICE_SECRET', undefined, async () => {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401)
    })
    expect(chunked).toHaveLength(0)
    expect((await app.inject({ method: 'POST', url, headers: { 'x-internal-secret': secret() } })).statusCode).toBe(202)
    expect(chunked).toHaveLength(1)
  })
})

describe('the inbound-email webhook', () => {
  it('refuses mail while its secret is unset, in every environment', async () => {
    const mail = { to: `contract-${contract}@inbound.example.test`, from: 'someone@example.test', subject: 'Revised draft', text: 'See attached.' }
    await withEnv('INBOUND_EMAIL_SECRET', undefined, async () => {
      for (const url of ['/api/v1/inbound/email', '/api/v1/%69nbound/email', '/%61pi/v1/inbound/email']) {
        expect((await app.inject({ method: 'POST', url, payload: mail })).statusCode, url).toBe(503)
      }
    })
    // With the secret set, no path variant gets past it without the header.
    await withEnv('INBOUND_EMAIL_SECRET', 'inbound-test-secret', async () => {
      for (const url of ['/api/v1/inbound/email', '/api/v1/%69nbound/email']) {
        expect((await app.inject({ method: 'POST', url, payload: mail })).statusCode, url).toBe(401)
      }
    })
  })
})
