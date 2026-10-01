/**
 * docs/41 P0.9 — only a contract the binder split carved out of a scanned
 * bundle is "split" from its parent; an amendment, or an exhibit linked by
 * hand, is not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Family Banner Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { parentContractId: null } })
  await cleanupAll()
  await closeApp()
})

const family = (id: string) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/family`, headers: auth(org, ['ADMIN'], user) }).then(r => r.json())

describe('GET /contracts/:id/family — splitFromParent', () => {
  it('is true only for a child the split recorded', async () => {
    const bundle = await makeContract(org, user, { title: 'Scanned bundle' })
    const split = await makeContract(org, user, { title: 'MSA (pages 1-4)' })
    const handExhibit = await makeContract(org, user, { title: 'Schedule A' })
    const amendment = await makeContract(org, user, { title: 'Amendment No. 1' })
    await prisma.contract.update({ where: { id: split }, data: { parentContractId: bundle, relationshipType: 'exhibit_only' } })
    await prisma.contract.update({ where: { id: handExhibit }, data: { parentContractId: bundle, relationshipType: 'exhibit_only' } })
    await prisma.contract.update({ where: { id: amendment }, data: { parentContractId: bundle, relationshipType: 'amendment' } })
    await prisma.contract.update({ where: { id: bundle }, data: { metadata: { _splitInto: [split] } } })

    expect(await family(split)).toMatchObject({ parent: { id: bundle }, relationshipType: 'exhibit_only', splitFromParent: true })
    expect(await family(handExhibit)).toMatchObject({ relationshipType: 'exhibit_only', splitFromParent: false })
    expect(await family(amendment)).toMatchObject({ relationshipType: 'amendment', splitFromParent: false })
  })
})
