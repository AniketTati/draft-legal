/**
 * docs/41 P0.4 — a governing law nobody named is a choice to make, not
 * Delaware; and a draft with a choice still open isn't sent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('./queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  queueNotification: vi.fn(),
  queueSigningReminder: vi.fn(async () => ({ id: 'x' })),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

const OPEN = '<p>Governed by the laws of <span class="template-variable-unfilled" data-variable="governingLaw" data-key="governingLaw">[[governingLaw]]</span>.</p>'
const FILLED = '<p>Governed by the laws of <span data-variable="governingLaw">New York</span>.</p>'

async function draft(html: string) {
  const id = await makeContract(org, user, { title: 'Open choice NDA', type: 'NDA', status: 'APPROVED' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: html, plainText: html.replace(/<[^>]+>/g, '') } })
  await prisma.contract.update({
    where: { id },
    data: { currentVersionId: v.id, metadata: { _template: { id: 't', name: 'NDA', variables: [{ key: 'governingLaw', label: 'Governing law', type: 'select' }] } } as never },
  })
  return id
}

const send = (id: string) => app.inject({
  method: 'POST', url: `/api/v1/contracts/${id}/send-for-signature`, headers: auth(org, ['ADMIN'], user),
  payload: { signers: [{ name: 'Pat', email: 'pat@cp.test' }] },
})

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Open Choices Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await prisma.contractShareLink.deleteMany({ where: { orgId: org } })
  await prisma.templateSection.deleteMany({ where: { template: { orgId: org } } })
  await prisma.template.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('a choice still open in the draft', () => {
  it('is listed on the contract\'s checks', async () => {
    const id = await draft(OPEN)
    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/checks`, headers: auth(org, ['ADMIN'], user) })
    expect(res.json().openChoices).toEqual([{ key: 'governingLaw', label: 'Governing law' }])
  })

  it('blocks sending for signature, with the reason', async () => {
    const id = await draft(OPEN)
    const res = await send(id)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'OPEN_CHOICES', detail: '1 choice is still open in the draft (Governing law). Choose it in the Variables panel before sending it for signature.' })
    expect(await prisma.signatureRequest.count({ where: { contractId: id } })).toBe(0)
  })

  it('blocks sending to the counterparty', async () => {
    const id = await draft(OPEN)
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/share`, headers: auth(org, ['ADMIN'], user), payload: { permissions: ['read'] } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('OPEN_CHOICES')
  })

  it('a filled draft goes out', async () => {
    const id = await draft(FILLED)
    const res = await send(id)
    expect(res.json().code).not.toBe('OPEN_CHOICES')
    expect(res.statusCode).toBeLessThan(300)
  })
})

describe('the assistant\'s drafting plan', () => {
  async function template(variables: unknown[]) {
    return (await prisma.template.create({
      data: {
        orgId: org, name: `NDA ${Math.random()}`, contractType: 'NDA', isPublished: true, createdById: user, variables: variables as object,
        sections: { create: [{ title: 'Law', content: '<p>Governed by {{governingLaw}} law; courts of {{venueLocation}}.</p>', sortOrder: 0 }] },
      },
    })).id
  }
  const plan = (templateId: string, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/api/internal/ai/tools/contract_draft',
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, userId: user, userMessage: 'NDA with Initech', templateId, contractType: 'NDA', counterpartyName: 'Initech', ...extra },
  })

  it('leaves governing law to choose when nobody named one and the org has no default of its own', async () => {
    const t = await template([{ key: 'governingLaw', defaultValue: 'Delaware' }, { key: 'venueLocation', defaultValue: 'Wilmington, Delaware' }])
    const p = (await plan(t)).json()
    expect(p.variables.governingLaw).toBeUndefined()
    expect(p.variables.venueLocation).toBeUndefined()
    expect(p.unfilledVariables).toEqual(expect.arrayContaining(['governingLaw', 'venueLocation']))
  })

  it('fills it from a default the org made its own', async () => {
    const t = await template([{ key: 'governingLaw', defaultValue: 'Delaware', orgDefault: true }, { key: 'venueLocation', defaultValue: 'Wilmington, Delaware', orgDefault: true }])
    const p = (await plan(t)).json()
    expect(p.variables).toMatchObject({ governingLaw: 'Delaware', venueLocation: 'Wilmington, Delaware' })
  })

  it('uses the law the request named', async () => {
    const t = await template([{ key: 'governingLaw', defaultValue: 'Delaware' }])
    const p = (await plan(t, { governingLaw: 'New York' })).json()
    expect(p.variables.governingLaw).toBe('New York')
  })
})
