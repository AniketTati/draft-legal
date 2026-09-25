/**
 * Z3 — the dashboard promised approval routing "by value, type, or
 * counterparty". The rules that choose a workflow and approve without a person
 * went in unchecked, a value floor was stored but never read, and the org's
 * default workflow took every contract ahead of one made for its type.
 * Invalid rules are now refused, and valid ones do what they say.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, admin: string
let generalist: string, ndaReviewer: string, dealDesk: string

const step = (approverId: string) => ({ order: 0, name: 'Review', approverId, executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48 })
const createWorkflow = (name: string, approverId: string, triggerRules: unknown, isDefault = false) => app.inject({
  method: 'POST', url: '/api/v1/approvals/workflows', headers: auth(org, ['ADMIN'], admin),
  payload: { name, steps: [step(approverId)], triggerRules, isDefault },
})
async function contract(type: string, value: number | null, currency = 'USD'): Promise<string> {
  const id = await makeContract(org, admin, { title: `Z3 ${type} ${value ?? 'no value'} ${currency}`, type })
  await prisma.contract.update({ where: { id }, data: { value, currency } })
  return id
}
const submit = (contractId: string) => app.inject({
  method: 'POST', url: `/api/v1/contracts/${contractId}/submit-approval`, headers: auth(org, ['ADMIN'], admin), payload: {},
})
async function routedTo(contractId: string): Promise<string[]> {
  const res = await submit(contractId)
  expect(res.statusCode, res.body).toBe(201)
  const steps = await prisma.approvalStep.findMany({ where: { instance: { contractId }, status: 'PENDING' } })
  return steps.map(s => s.approverId)
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Z3 Routing Org')
  admin = await makeUser(org)
  generalist = await makeUser(org)
  ndaReviewer = await makeUser(org)
  dealDesk = await makeUser(org)
})

afterAll(async () => { await cleanupAll(); await closeApp() })

describe('approval routing rules', () => {
  it('refuses rules naming an unknown contract type, a limit that is missing or negative, or an unknown rule', async () => {
    for (const triggerRules of [
      { contractTypes: ['NOT_A_TYPE'] },
      { contractTypes: 'NDA' },
      { autoApproveRules: [{ contractType: 'NDA', maxValue: -5 }] },
      { autoApproveRules: [{ contractType: 'NDA' }] },
      { autoApproveRules: [{ contractType: 'SOMETHING', maxValue: 100 }] },
      { valueThreshold: 'lots' },
      { currency: 'dollars' },
      { contractType: 'NDA' },
    ]) {
      const res = await createWorkflow('Z3 invalid', generalist, triggerRules)
      expect(res.statusCode, JSON.stringify(triggerRules)).toBe(400)
      expect(res.json().error).toMatch(/^triggerRules/)
    }
    expect(await prisma.workflowDefinition.count({ where: { orgId: org } })).toBe(0)
  })

  it('sends each contract to the workflow made for it, and approves small NDAs at once', async () => {
    // The default, for everything else, is the oldest: it used to take every contract.
    expect((await createWorkflow('Everything else', generalist, {}, true)).statusCode).toBe(201)
    expect((await createWorkflow('NDAs', ndaReviewer, {
      contractTypes: ['NDA'], currency: 'USD', autoApproveRules: [{ contractType: 'NDA', maxValue: 10_000 }],
    })).statusCode).toBe(201)
    expect((await createWorkflow('Large MSAs', dealDesk, { contractTypes: ['MSA'], valueThreshold: 100_000 })).statusCode).toBe(201)

    const smallNda = await contract('NDA', 5_000)
    expect((await submit(smallNda)).json()).toMatchObject({ status: 'AUTO_APPROVED' })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: smallNda } })).status).toBe('APPROVED')

    expect(await routedTo(await contract('NDA', 50_000))).toEqual([ndaReviewer])
    // No value, or a value in another currency, always goes to a person.
    expect(await routedTo(await contract('NDA', null))).toEqual([ndaReviewer])
    expect(await routedTo(await contract('NDA', 5_000, 'EUR'))).toEqual([ndaReviewer])

    expect(await routedTo(await contract('MSA', 250_000))).toEqual([dealDesk])
    expect(await routedTo(await contract('MSA', 40_000))).toEqual([generalist])
    // An MSA of unknown size gets the more careful review.
    expect(await routedTo(await contract('MSA', null))).toEqual([dealDesk])
    expect(await routedTo(await contract('SOW', 1_000))).toEqual([generalist])
  })

  it('runs the workflow the sender chose, or refuses: never another in its place', async () => {
    const res = await createWorkflow('Retired', generalist, {})
    await prisma.workflowDefinition.update({ where: { id: res.json().id }, data: { isActive: false } })
    const nda = await contract('NDA', 50_000)
    const sent = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${nda}/submit-approval`, headers: auth(org, ['ADMIN'], admin),
      payload: { workflowDefinitionId: res.json().id },
    })
    expect(sent.statusCode).toBe(422)
    expect(await prisma.approvalInstance.count({ where: { contractId: nda } })).toBe(0)
  })
})
