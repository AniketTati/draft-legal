/**
 * docs/39 E4 — wording saved to the clause library from a contract:
 * unapproved, filed by its clause type, linked back, never twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, contract: string, liability: string

const TEXT = 'In no event shall either party be liable for any indirect, incidental or consequential damages arising out of this Agreement.'
const save = (payload: Record<string, unknown>, roles = ['ADMIN'], user = owner) =>
  app.inject({ method: 'POST', url: '/api/v1/clauses/from-contract', headers: auth(org, roles, user), payload })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Clause Library Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Acme MSA', type: 'MSA' })
  liability = (await prisma.clauseCategory.create({ data: { orgId: org, name: 'Limitation of Liability' } })).id
})

afterAll(async () => {
  await prisma.clauseLibraryItem.deleteMany({ where: { orgId: org } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('Save to library', () => {
  it('saves the words unapproved, filed under their clause type, linked back to the contract', async () => {
    const r = await save({ contractId: contract, text: TEXT, title: 'No consequential damages', clauseType: 'limitation_of_liability', section: '9.2' })
    expect(r.statusCode).toBe(201)
    const c = r.json().clause
    expect(c).toMatchObject({
      title: 'No consequential damages', isApproved: false, categoryId: liability,
      sourceContractId: contract, sourceSection: '9.2', sourceContract: { id: contract, title: 'Acme MSA' },
    })
    expect(c.content).toBe(`<p>${TEXT}</p>`)
    expect(c.versions[0].note).toBe('Saved from “Acme MSA” §9.2')

    // The library lists it with where it came from.
    const list = (await app.inject({ method: 'GET', url: '/api/v1/clauses?approved=false', headers: auth(org) })).json().data
    expect(list.find((x: { id: string }) => x.id === c.id).sourceContract).toEqual({ id: contract, title: 'Acme MSA' })
  })

  it('the same wording again is the one already there', async () => {
    const r = await save({ contractId: contract, text: `  ${TEXT.toUpperCase()} `, title: 'Again' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ duplicate: true, clause: { title: 'No consequential damages' } })
  })

  it('with no category for its type, it goes to Saved from contracts; markup in the words stays words', async () => {
    const r = await save({ contractId: contract, text: 'Fees are payable <b>net 30</b> & in USD.\n\nLate payments bear interest.', title: 'Payment' })
    expect(r.json().clause).toMatchObject({ category: { name: 'Saved from contracts' } })
    expect(r.json().clause.content).toBe('<p>Fees are payable &lt;b&gt;net 30&lt;/b&gt; &amp; in USD.</p><p>Late payments bear interest.</p>')
  })

  it('needs the right to add clauses, and a contract the reader can see', async () => {
    expect((await save({ contractId: contract, text: TEXT, title: 'x' }, ['VIEWER'])).statusCode).toBe(403)
    expect((await save({ contractId: 'nope', text: 'Some wording worth keeping in the library.', title: 'x' })).statusCode).toBe(404)
    const other = await makeOrg('Other Clause Org')
    const foreign = await makeContract(other, await makeUser(other), { title: 'Theirs' })
    expect((await save({ contractId: foreign, text: 'Some wording worth keeping in the library.', title: 'x' })).statusCode).toBe(404)
  })
})
