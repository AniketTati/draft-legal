/**
 * X26 — `_`-prefixed contract metadata is server state: analysis reports and
 * the binder split's `_splitInto`, which a re-split replaces (soft-deletes).
 * PATCH /contracts/:id let any editor write those keys, so a user who couldn't
 * delete a colleague's amendment could list it in _splitInto and re-split.
 * Only the agents service may write them now.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string, contract: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Metadata Reserved Org')
  user = await makeUser(org)
  contract = await makeContract(org, user, { title: 'Binder' })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

const metadata = async () => (await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).metadata as Record<string, unknown>

describe('server-owned metadata keys', () => {
  it('a user can\'t write _splitInto (or any _ key)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['LEGAL_OPS'], user),
      payload: { metadata: { _splitInto: ['someone-elses-amendment'], note: 'x' } },
    })
    expect(res.statusCode).toBe(400)
    expect(await metadata()).not.toHaveProperty('_splitInto')
  })

  it('ordinary metadata still saves', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['LEGAL_OPS'], user),
      payload: { metadata: { costCentre: 'EMEA-42' } },
    })
    expect(res.statusCode).toBe(200)
    expect(await metadata()).toMatchObject({ costCentre: 'EMEA-42' })
  })

  it('the agents service still writes its own reports', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`,
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org },
      payload: { metadata: { _redlineStatus: 'FAILED' } },
    })
    expect(res.statusCode).toBe(200)
    expect(await metadata()).toMatchObject({ _redlineStatus: 'FAILED' })
  })
})

describe('X26 follow-up', () => {
  const agents = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })

  it('not even the agents service can change _splitInto; writing back the stored value is fine', async () => {
    await prisma.contract.update({ where: { id: contract }, data: { metadata: { ...(await metadata()), _splitInto: ['child-a'] } } })
    const forged = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: agents(),
      payload: { metadata: { _splitInto: ['someone-elses-amendment'] } },
    })
    expect(forged.statusCode).toBe(400)
    expect((await metadata())._splitInto).toEqual(['child-a'])
    // redline.py merges and writes the whole metadata back.
    const merged = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: agents(),
      payload: { metadata: { ...(await metadata()), _redlineStatus: 'DONE' } },
    })
    expect(merged.statusCode).toBe(200)
    expect(await metadata()).toMatchObject({ _splitInto: ['child-a'], _redlineStatus: 'DONE' })
  })

  it('a new contract can\'t be created with server-owned metadata', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/contracts', headers: auth(org, ['LEGAL_OPS'], user),
      payload: { title: 'Forged report', type: 'NDA', metadata: { _compliance: { score: 100 } } },
    })
    expect(res.statusCode).toBe(400)
    expect(await prisma.contract.count({ where: { orgId: org, title: 'Forged report' } })).toBe(0)
  })

  it('the review keeps only the org\'s own custom fields (source tripwire)', () => {
    const review = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'routes', 'review.py'), 'utf8')
    expect(review).toContain('wanted_fields = {f.get("fieldKey") for f in custom_fields if isinstance(f, dict)}')
    expect(review).toMatch(/if field_key not in wanted_fields:\n\s+continue/)
  })
})
