/**
 * docs/39 C5 — the assistant sets a field's value, or adds a field, only on
 * an Apply card: the card says what the value is now and who set it (never a
 * silent overwrite), the write is the person's, and it can be undone while
 * nobody has changed it since.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, grantRole, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, maya: string, contract: string, thread: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents' })
const preview = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/internal/ai/tools/contract_field_preview', headers: internal(), payload: { orgId: org, ...payload } })
const apply = (toolName: string, args: Record<string, unknown>, roles = ['ADMIN'], user = owner) =>
  app.inject({ method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/apply`, headers: auth(org, roles, user), payload: { toolName, args } })
const undo = (toolCallId: string) =>
  app.inject({ method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/${toolCallId}/undo`, headers: auth(org, ['ADMIN'], owner) })
const field = async (key: string) => prisma.contractFieldValue.findUnique({ where: { contractId_fieldKey: { contractId: contract, fieldKey: key } } })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Agent Field Tools Org')
  owner = await makeUser(org)
  // The preview resolves the user's own roles, as it does for every chat.
  await grantRole(org, owner, 'ADMIN')
  maya = await prisma.user.create({ data: { orgId: org, email: `maya-${Date.now()}@test.local`, passwordHash: 'x', name: 'Maya Chen' }, select: { id: true } }).then(u => u.id)
  contract = await makeContract(org, owner, { title: 'Acme MSA', type: 'MSA' })
  // The AI read net 30.
  await app.inject({
    method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: { ...internal(), 'x-org-id': org },
    payload: { keyTerms: { paymentTermsDays: 30 }, fieldConfidence: { paymentTermsDays: { confidence: 0.8, quote: 'net thirty (30) days' } } },
  })

  // The API calls itself at the base agent-threads.ts derives from the env (PORT or API_URL), so
  // route that same base back into the app rather than assuming :3001.
  const self = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.startsWith(`${self}/api/`)) {
      const res = await app.inject({
        method: (init?.method ?? 'GET') as 'POST',
        url: url.slice(self.length),
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      })
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  })
  thread = (await app.inject({ method: 'POST', url: '/api/v1/agent/threads', headers: auth(org, ['ADMIN'], owner), payload: {} })).json().id
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.toolCall.deleteMany({ where: { thread: { orgId: org } } }).catch(() => {})
  await cleanupAll()
  await closeApp()
})

describe('what the card says before anything is written', () => {
  it('finds the field by the name the user said, reads the value in its terms, and names what it replaces', async () => {
    const r = (await preview({ userId: owner, contractId: contract, field: 'payment terms', value: '45 days' })).json()
    expect(r).toMatchObject({
      ok: true, contractTitle: 'Acme MSA', field: { key: 'paymentTermsDays', label: 'Payment terms' },
      display: '45 days', before: { display: '30 days', source: 'ai', checked: false },
    })
  })

  it('says why it can’t: an unknown field (with the ones it might be), a placeholder, a value the field can’t hold', async () => {
    const unknown = (await preview({ userId: owner, contractId: contract, field: 'payment term length', value: '45' })).json()
    expect(unknown.error).toBe('unknown_field')
    expect(unknown.note).toContain('Payment terms (paymentTermsDays)')
    expect((await preview({ userId: owner, contractId: contract, field: 'governing law', value: '[REDACTED:SSN]' })).json().error).toBe('placeholder')
    expect((await preview({ userId: owner, contractId: contract, field: 'auto-renews', value: 'perhaps' })).json().error).toBe('invalid_value')
  })

  it('refuses someone who can’t edit contracts', async () => {
    const reader = await makeUser(org)
    await grantRole(org, reader, 'VIEWER')
    const r = await preview({ userId: reader, contractId: contract, field: 'payment terms', value: '45 days' })
    expect(r.statusCode).toBe(403)
  })
})

describe('Apply, and its undo', () => {
  it('writes the value as the person, and puts the AI’s back on undo', async () => {
    const r = await apply('contract_field_set', { contractId: contract, field: 'paymentTermsDays', value: '45 days' })
    expect(r.statusCode).toBe(200)
    expect(r.json().result).toMatchObject({ ok: true, reversible: true, diff: [{ field: 'Payment terms', before: '30 days', after: '45 days' }] })
    expect(await field('paymentTermsDays')).toMatchObject({ value: 45, source: 'user', updatedById: owner })
    expect(((await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).keyTerms as Record<string, unknown>).paymentTermsDays).toBe(45)

    const u = await undo(r.json().toolCallId)
    expect(u.statusCode).toBe(200)
    expect(await field('paymentTermsDays')).toMatchObject({ value: 30, source: 'ai', verifiedAt: null, quote: 'net thirty (30) days' })
  })

  it('leaves a value someone changed since', async () => {
    const r = await apply('contract_field_set', { contractId: contract, field: 'paymentTermsDays', value: '60' })
    await prisma.contractFieldValue.update({ where: { contractId_fieldKey: { contractId: contract, fieldKey: 'paymentTermsDays' } }, data: { updatedById: maya } })
    const u = await undo(r.json().toolCallId)
    expect(u.statusCode).toBe(409)
    expect((await field('paymentTermsDays'))?.value).toBe(60)
  })

  it('adds a field for those who configure contracts, removed on undo while it holds nothing', async () => {
    const r = await apply('field_create', { label: 'PO number', fieldType: 'text', contractType: 'MSA', helpText: 'The customer PO' })
    expect(r.json().result.fieldDefinition).toMatchObject({ fieldKey: 'po_number', fieldLabel: 'PO number', contractType: 'MSA' })
    expect((await undo(r.json().toolCallId)).statusCode).toBe(200)
    expect(await prisma.contractFieldDefinition.count({ where: { orgId: org, fieldKey: 'po_number' } })).toBe(0)

    const again = await apply('field_create', { label: 'PO number', fieldType: 'text' })
    await apply('contract_field_set', { contractId: contract, field: 'PO number', value: 'PO-4417' })
    expect((await undo(again.json().toolCallId)).statusCode).toBe(409)

    expect((await apply('field_create', { label: 'Region', fieldType: 'text' }, ['LEGAL_COUNSEL'])).statusCode).toBe(403)
  })
})
