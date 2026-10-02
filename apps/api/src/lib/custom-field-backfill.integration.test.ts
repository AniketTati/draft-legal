/**
 * X2 — a custom field only reached contracts analysed after it existed. The
 * backfill fills it in on the org's own, already-analysed contracts of its
 * type, keeps the extraction's confidence and quote, never overwrites a value,
 * and resumes from its saved cursor after a pause or a failure.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('./queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  queueBackfillCustomField: vi.fn(async () => {}),
}))
vi.mock('./elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./elasticsearch.js')>()),
  reindexContract: vi.fn(async () => {}),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { runCustomFieldBackfill, type ExtractFields } from './custom-field-backfill.js'
import { CostCapExceededError } from './costCap.js'
import { queueBackfillCustomField } from './queue.js'

let app: TestApp
let org: string, user: string, def: string
const ids: Record<string, string> = {}

async function contract(name: string, opts: { type?: string; text?: string; status?: string; room?: string; metadata?: Record<string, unknown> } = {}) {
  const id = await makeContract(org, user, { title: name, type: opts.type ?? 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, plainText: opts.text ?? `${name}: payment is due within 45 days.` } })
  await prisma.contract.update({
    where: { id },
    data: { currentVersionId: v.id, analysisStatus: opts.status ?? 'DONE', diligenceRoomId: opts.room ?? null, metadata: (opts.metadata ?? {}) as never },
  })
  ids[name] = id
  return id
}

/** A fake agents service that records which contracts it was asked about. */
function fakeExtract(behave: (contractId: string) => 'ok' | 'cap' | 'error' = () => 'ok') {
  const asked: string[] = []
  const fn: ExtractFields = async ({ contractId }) => {
    asked.push(contractId)
    const b = behave(contractId)
    if (b === 'cap') throw new CostCapExceededError(org, 5, 5, 'block')
    if (b === 'error') throw new Error('model timeout')
    return { payment_terms_days: { value: 45, confidence: 0.9, quote: 'due within 45 days' } }
  }
  return { fn, asked }
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Custom Field Backfill Org')
  user = await makeUser(org)
  def = (await prisma.contractFieldDefinition.create({
    data: { orgId: org, contractType: 'MSA', fieldKey: 'payment_terms_days', fieldLabel: 'Payment terms (days)', fieldType: 'number' },
  })).id
  const room = (await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Falcon', createdById: user } })).id
  await contract('empty-me')
  await contract('already-set', { metadata: { payment_terms_days: 30 } })
  await contract('no-text', { text: '   ' })
  await contract('an-nda', { type: 'NDA' })
  await contract('in-a-room', { room })
  await contract('not-analysed', { status: 'EXTRACTING' })
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null, diligenceRoomId: null } })
  await prisma.diligenceRoom.deleteMany({ where: { orgId: org } })
  await prisma.contractFieldDefinition.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('filling a new custom field in on existing contracts', () => {
  it('fills only the org\'s own analysed contracts of the field\'s type that lack a value, with evidence', async () => {
    const { fn, asked } = fakeExtract()
    const state = await runCustomFieldBackfill({ orgId: org, fieldDefinitionId: def }, fn)
    expect(asked).toEqual([ids['empty-me']])
    expect(state).toMatchObject({ status: 'DONE', processed: 3, filled: 1, failed: 0, total: 3 })

    const filled = (await prisma.contract.findUniqueOrThrow({ where: { id: ids['empty-me'] } })).metadata as Record<string, unknown>
    expect(filled.payment_terms_days).toBe(45)
    expect(filled._customFieldEvidence).toMatchObject({ payment_terms_days: { confidence: 0.9, quote: 'due within 45 days', source: 'ai' } })
    const kept = (await prisma.contract.findUniqueOrThrow({ where: { id: ids['already-set'] } })).metadata as Record<string, unknown>
    expect(kept.payment_terms_days).toBe(30)
    expect((await prisma.contractFieldDefinition.findUniqueOrThrow({ where: { id: def } })).backfill).toMatchObject({ status: 'DONE', filled: 1 })
  })

  it('pauses at the cost cap and resumes from its cursor; a failing contract doesn\'t stop the rest', async () => {
    await contract('later-1')
    await contract('later-2')
    await contract('later-3')
    const first = fakeExtract(id => (id === ids['later-2'] ? 'cap' : id === ids['later-1'] ? 'error' : 'ok'))
    const paused = await runCustomFieldBackfill({ orgId: org, fieldDefinitionId: def }, first.fn)
    expect(paused).toMatchObject({ status: 'PAUSED', failed: 1 })
    expect(first.asked).toEqual([ids['later-1'], ids['later-2']])

    const second = fakeExtract()
    const done = await runCustomFieldBackfill({ orgId: org, fieldDefinitionId: def }, second.fn)
    expect(second.asked).toEqual([ids['later-2'], ids['later-3']])   // resumed after later-1
    expect(done).toMatchObject({ status: 'DONE' })
    expect(((await prisma.contract.findUniqueOrThrow({ where: { id: ids['later-3'] } })).metadata as Record<string, unknown>).payment_terms_days).toBe(45)
  })

  it('never overwrites a value that landed while the model was reading', async () => {
    const racing = await contract('racing')
    await prisma.contractFieldDefinition.update({ where: { id: def }, data: { backfill: { status: 'DONE' } } })
    const state = await runCustomFieldBackfill({ orgId: org, fieldDefinitionId: def }, async ({ contractId }) => {
      if (contractId !== racing) return null   // nothing found elsewhere this pass
      await prisma.contract.update({ where: { id: racing }, data: { metadata: { payment_terms_days: 60 } } })
      return { payment_terms_days: { value: 45, confidence: 0.9, quote: 'x' } }
    })
    expect(((await prisma.contract.findUniqueOrThrow({ where: { id: racing } })).metadata as Record<string, unknown>).payment_terms_days).toBe(60)
    expect(state?.filled).toBe(0)
  })

  it('an admin queues it; others may not', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/field-definitions/${def}/backfill`, headers: auth(org, ['ADMIN'], user) })
    expect(res.statusCode).toBe(202)
    expect(res.json().backfill).toMatchObject({ status: 'QUEUED', mode: 'fill' })
    expect(vi.mocked(queueBackfillCustomField)).toHaveBeenCalledWith({ orgId: org, fieldDefinitionId: def, mode: 'fill' })
    // docs/39 D5 — a re-check is asked for by name.
    const recheck = await app.inject({ method: 'POST', url: `/api/v1/field-definitions/${def}/backfill`, headers: auth(org, ['ADMIN'], user), payload: { mode: 'recheck' } })
    expect(recheck.json().backfill).toMatchObject({ status: 'QUEUED', mode: 'recheck' })
    expect(vi.mocked(queueBackfillCustomField)).toHaveBeenLastCalledWith({ orgId: org, fieldDefinitionId: def, mode: 'recheck' })
    expect((await app.inject({ method: 'POST', url: `/api/v1/field-definitions/${def}/backfill`, headers: auth(org, ['VIEWER'], user) })).statusCode).toBe(403)
  })
})
