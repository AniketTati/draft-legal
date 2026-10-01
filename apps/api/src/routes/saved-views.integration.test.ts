/**
 * docs/39 D3 — saved views of the contracts list: private to whoever saved
 * them unless shared; only the owner (or someone who configures contracts)
 * changes or deletes one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, ana: string, ben: string, boss: string

const as = (user: string, roles = ['LEGAL_COUNSEL']) => auth(org, roles, user)
const list = async (user: string, roles?: string[]) =>
  ((await app.inject({ method: 'GET', url: '/api/v1/saved-views?page=contracts', headers: as(user, roles) })).json().views as Array<{ id: string; name: string; mine: boolean; shared: boolean }>)
const query = {
  filters: { type: 'SOW', riskBand: 'high' },
  fieldFilters: [{ key: 'confidentiality_period', op: 'gte', value: { value: 3, unit: 'years' } }],
  columns: ['confidentiality_period', 'value'],
  sort: { key: 'value', dir: 'desc' },
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Saved Views Org')
  ana = await makeUser(org)
  ben = await makeUser(org)
  boss = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('saved views', () => {
  let privateId: string, sharedId: string

  it('keeps a view to whoever saved it, and shows a shared one to everyone', async () => {
    const mine = await app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: as(ana), payload: { name: 'Long NDAs', query } })
    expect(mine.statusCode).toBe(201)
    privateId = mine.json().view.id
    expect(mine.json().view).toMatchObject({ name: 'Long NDAs', shared: false, mine: true, query: { columns: ['confidentiality_period', 'value'] } })
    const shared = await app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: as(ana), payload: { name: 'Big SOWs', shared: true, query } })
    sharedId = shared.json().view.id

    expect((await list(ana)).map(v => v.name)).toEqual(['Big SOWs', 'Long NDAs'])
    expect(await list(ben)).toEqual([expect.objectContaining({ name: 'Big SOWs', mine: false })])
  })

  it('lets only the owner, or someone who configures contracts, change or delete it', async () => {
    const rename = (user: string, id: string, roles?: string[]) =>
      app.inject({ method: 'PATCH', url: `/api/v1/saved-views/${id}`, headers: as(user, roles), payload: { name: 'Renamed' } })
    expect((await rename(ben, sharedId)).statusCode).toBe(403)
    // Someone else's private view: as if it didn't exist.
    expect((await rename(ben, privateId)).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/saved-views/${privateId}`, headers: as(ben) })).statusCode).toBe(404)

    const own = await app.inject({ method: 'PATCH', url: `/api/v1/saved-views/${privateId}`, headers: as(ana), payload: { shared: true, query: { ...query, columns: ['value'] } } })
    expect(own.json().view).toMatchObject({ shared: true, name: 'Long NDAs', query: { columns: ['value'] } })

    expect((await rename(boss, sharedId, ['ADMIN'])).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/saved-views/${sharedId}`, headers: as(boss, ['ADMIN']) })).statusCode).toBe(204)
    expect((await list(ana)).map(v => v.name)).toEqual(['Long NDAs'])
  })

  it('refuses a view it couldn’t open again', async () => {
    const bad = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: as(ana), payload })
    expect((await bad({ name: ' ', query })).statusCode).toBe(422)
    expect((await bad({ name: 'Odd', query: { ...query, filters: { colour: 'red' } } })).statusCode).toBe(422)
    expect((await bad({ name: 'Odd', query: { ...query, fieldFilters: [{ key: 'value', op: 'roughly' }] } })).statusCode).toBe(422)
  })

  it('caps how many views one person keeps', async () => {
    await prisma.savedView.createMany({ data: Array.from({ length: 49 }, (_, i) => ({ orgId: org, ownerId: ben, name: `View ${i}`, query: {} })) })
    expect((await app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: as(ben), payload: { name: 'Fiftieth', query } })).statusCode).toBe(201)
    const over = await app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: as(ben), payload: { name: 'One too many', query } })
    expect(over.statusCode).toBe(409)
  })
})
