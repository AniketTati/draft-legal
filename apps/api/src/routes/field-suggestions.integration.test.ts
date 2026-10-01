/**
 * docs/39 C3 — someone who can't add fields asks for one from words they
 * highlighted; whoever can add fields is told, and adds it (with the value it
 * was asked with, saved on its contract) or declines it; the asker hears back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { keyFromLabel } from './field-suggestions.js'

let app: TestApp
let org: string, admin: string, rep: string, contract: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Field Suggestion Org')
  admin = await makeUser(org)
  rep = await makeUser(org)
  const adminRole = await prisma.role.findFirst({ where: { name: 'ADMIN', orgId: null } })
  if (adminRole) await prisma.userRole.create({ data: { userId: admin, roleId: adminRole.id } })
  contract = await makeContract(org, rep, { title: 'Supply MSA', type: 'MSA' })
  await prisma.contract.update({ where: { id: contract }, data: { analysisStatus: 'DONE' } })
})

afterAll(async () => {
  await prisma.fieldSuggestion.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

const asRep = () => auth(org, ['SALES_REP'], rep)
const asAdmin = () => auth(org, ['ADMIN'], admin)

describe('suggested fields', () => {
  it('makes a key from a label', () => {
    expect(keyFromLabel('PO number')).toBe('po_number')
    expect(keyFromLabel('Durée du préavis')).toBe('duree_du_preavis')
    expect(keyFromLabel('3rd-party audit')).toBe('field_3rd_party_audit')
  })

  it('someone who can’t add fields can ask for one, once; a field that exists is pointed to', async () => {
    const ask = () => app.inject({
      method: 'POST', url: '/api/v1/field-suggestions', headers: asRep(),
      payload: { label: 'PO number', fieldType: 'text', contractType: 'MSA', example: { contractId: contract, quote: 'Purchase Order PO-7781', value: 'PO-7781' } },
    })
    const first = await ask()
    expect(first.statusCode).toBe(201)
    expect(first.json().suggestion).toMatchObject({ fieldKey: 'po_number', status: 'PENDING', suggestedById: rep })
    const again = await ask()
    expect(again.json()).toMatchObject({ duplicate: true, suggestion: { id: first.json().suggestion.id } })

    // Only the admins may see and act on them.
    expect((await app.inject({ method: 'GET', url: '/api/v1/field-suggestions', headers: asRep() })).statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/api/v1/field-suggestions', headers: asAdmin() })
    expect(list.json().data[0]).toMatchObject({ label: 'PO number', exampleContractTitle: 'Supply MSA' })
  })

  it('an admin adds it: the field exists, the contract has the value it was asked with, and the asker is told', async () => {
    const [s] = (await app.inject({ method: 'GET', url: '/api/v1/field-suggestions', headers: asAdmin() })).json().data
    const res = await app.inject({ method: 'POST', url: `/api/v1/field-suggestions/${s.id}/add`, headers: asAdmin(), payload: { helpText: 'The customer PO the contract names' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ exampleSaved: true, field: { fieldKey: 'po_number', helpText: 'The customer PO the contract names', contractType: 'MSA' } })
    const fields = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/fields`, headers: asAdmin() })).json().fields as Array<{ key: string; value: unknown; source: string }>
    expect(fields.find(f => f.key === 'po_number')).toMatchObject({ value: 'PO-7781', source: 'highlight' })
    expect((await app.inject({ method: 'POST', url: `/api/v1/field-suggestions/${s.id}/add`, headers: asAdmin() })).statusCode).toBe(409)
    // Asking for it now points to the field.
    const late = await app.inject({ method: 'POST', url: '/api/v1/field-suggestions', headers: asRep(), payload: { label: 'PO Number', fieldType: 'text' } })
    expect(late.statusCode).toBe(409)
  })

  it('an admin declines one, with a reason', async () => {
    const ask = await app.inject({ method: 'POST', url: '/api/v1/field-suggestions', headers: asRep(), payload: { label: 'Lucky number', fieldType: 'number' } })
    const res = await app.inject({ method: 'POST', url: `/api/v1/field-suggestions/${ask.json().suggestion.id}/decline`, headers: asAdmin(), payload: { reason: 'Not something we track' } })
    expect(res.json().suggestion).toMatchObject({ status: 'DECLINED', reason: 'Not something we track' })
  })

  it('an example must come from a contract the asker can see', async () => {
    const other = await makeOrg('Elsewhere')
    const theirs = await makeContract(other, await makeUser(other), { title: 'Not yours' })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/field-suggestions', headers: asRep(),
      payload: { label: 'Secret field', fieldType: 'text', example: { contractId: theirs, quote: 'x', value: 'x' } },
    })
    expect(res.statusCode).toBe(404)
  })
})
