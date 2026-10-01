/**
 * docs/41 P1 (Part 3) — playbooks as objects: made, given types, one default
 * per type; a contract says which it uses and why; another org sees none.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, other: string, admin: string, category: string

const as = (o = org) => auth(o, ['ADMIN'], o === org ? admin : undefined)
const post = (url: string, payload: unknown, o = org) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: as(o), payload: payload as object })
const patch = (url: string, payload: unknown, o = org) => app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers: as(o), payload: payload as object })
const get = (url: string, o = org) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as(o) })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Playbooks Org')
  other = await makeOrg('Playbooks Other Org')
  admin = await makeUser(org)
  category = (await prisma.clauseCategory.create({ data: { orgId: org, name: 'Confidentiality' } })).id
})

afterAll(async () => {
  await prisma.playbookPosition.deleteMany({ where: { orgId: { in: [org, other] } } })
  await prisma.contract.updateMany({ where: { orgId: { in: [org, other] } }, data: { playbookId: null } })
  await prisma.playbook.deleteMany({ where: { orgId: { in: [org, other] } } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('playbooks', () => {
  it('a position with no playbook goes into the default one, made for it', async () => {
    const res = await post('/playbook/positions', { clauseCategoryId: category, positionType: 'preferred', content: '<p>Five years.</p>' })
    expect(res.statusCode).toBe(201)
    const list = (await get('/playbook/playbooks')).json()
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({ name: 'Default playbook', contractTypes: [], isDefaultForType: true, positionCount: 1, version: 2 })
    expect(res.json().playbookId).toBe(list.data[0].id)
  })

  it('resolves a contract\'s playbook in order, and says why', async () => {
    const nda = await makeContract(org, admin, { title: 'NDA', type: 'NDA' })
    let r = (await get(`/contracts/${nda}/playbook`)).json()
    expect(r).toMatchObject({ why: 'default_for_type', playbook: { name: 'Default playbook' }, positionCount: 1 })

    // A typed default beats the all-types one.
    const sales = (await post('/playbook/playbooks', { name: 'Sales NDA', contractTypes: ['NDA'], isDefaultForType: true })).json()
    r = (await get(`/contracts/${nda}/playbook`)).json()
    expect(r).toMatchObject({ why: 'default_for_type', playbook: { id: sales.id } })
    expect(r.explanation).toContain('using Sales NDA')

    // A second typed default takes the default from the first.
    const vendor = (await post('/playbook/playbooks', { name: 'Vendor NDA', contractTypes: ['NDA'], isDefaultForType: true })).json()
    expect((await prisma.playbook.findUniqueOrThrow({ where: { id: sales.id } })).isDefaultForType).toBe(false)
    expect((await get(`/contracts/${nda}/playbook`)).json().playbook.id).toBe(vendor.id)

    // No default for NDAs at all, three cover it: ask.
    await patch(`/playbook/playbooks/${vendor.id}`, { isDefaultForType: false })
    const all = (await get('/playbook/playbooks')).json().data.find((p: { name: string }) => p.name === 'Default playbook')
    await patch(`/playbook/playbooks/${all.id}`, { isDefaultForType: false })
    r = (await get(`/contracts/${nda}/playbook`)).json()
    expect(r).toMatchObject({ why: 'ambiguous', playbook: null })
    expect(r.candidates).toHaveLength(3)

    // Chosen on the contract.
    const chose = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${nda}/playbook`, headers: as(), payload: { playbookId: sales.id } })
    expect(chose.statusCode).toBe(200)
    expect(chose.json()).toMatchObject({ why: 'explicit', playbook: { id: sales.id } })

    // Renamed: the new name is what it says.
    await patch(`/playbook/playbooks/${sales.id}`, { name: 'Sales NDA (2026)' })
    expect((await get(`/contracts/${nda}/playbook`)).json().playbook.name).toBe('Sales NDA (2026)')
  })

  it('another org sees and changes none of it', async () => {
    const mine = (await get('/playbook/playbooks')).json().data[0]
    expect((await get('/playbook/playbooks', other)).json().data).toEqual([])
    expect((await patch(`/playbook/playbooks/${mine.id}`, { name: 'Taken' }, other)).statusCode).toBe(404)
    const nda = await makeContract(org, admin, { title: 'NDA 2', type: 'NDA' })
    expect((await get(`/contracts/${nda}/playbook`, other)).statusCode).toBe(404)
    const theirs = await makeContract(other, await makeUser(other), { title: 'Their NDA', type: 'NDA' })
    const put = await app.inject({ method: 'PUT', url: `/api/v1/contracts/${theirs}/playbook`, headers: as(other), payload: { playbookId: mine.id } })
    expect(put.statusCode).toBe(404)
  })

  it('a playbook with positions is not deleted', async () => {
    const all = (await get('/playbook/playbooks')).json().data.find((p: { positionCount: number }) => p.positionCount > 0)
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/playbook/playbooks/${all.id}`, headers: as() })
    expect(res.statusCode).toBe(409)
  })
})
