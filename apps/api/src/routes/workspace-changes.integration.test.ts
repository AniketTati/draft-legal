/**
 * docs/41 Part 15 (C2) — the workspace's Changes mode against the database:
 * what changed since the baseline in the document as it stands (the draft
 * changes included), the baseline picker's choices, Counter… drafting
 * counter wording through the agents service (mocked: no model), and that
 * another org reaches none of it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const agents = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: Record<string, unknown> }>, reply: { counterText: 'Liability is capped at twelve months of fees.', counterNote: 'Meets them halfway on the cap.' } as Record<string, unknown> }))
vi.mock('../lib/agents-call.js', () => ({
  callAgents: vi.fn(async (path: string, init: RequestInit) => {
    agents.calls.push({ path, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(agents.reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string, otherOrg: string, outsider: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Changes Org')
  user = await makeUser(org)
  otherOrg = await makeOrg('Changes Other Org')
  outsider = await makeUser(otherOrg)
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

const as = (sub = user, o = org) => auth(o, ['LEGAL_OPS'], sub)

/** v1 generated from a template, v2 the counterparty's, standing on v2. */
async function negotiated() {
  const id = await makeContract(org, user, { title: 'Supply MSA', status: 'IN_NEGOTIATION' })
  const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, htmlContent: '<p data-fp="a1">Liability is capped at the fees paid.</p>', plainText: 'x', createdById: user } })
  // The review's baseline is a version that was analysed (it has clauses).
  await prisma.contractClause.create({ data: { versionId: v1.id, clauseType: 'liability', content: 'Liability is capped at the fees paid.', sortOrder: 0 } })
  const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, htmlContent: '<p>Liability is uncapped.</p>', plainText: 'y', createdById: 'portal:link1' } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
  return { id, v1: v1.id, v2: v2.id }
}

describe('GET /contracts/:id/changes', () => {
  it('shows what changed since the baseline, and offers the template origin and every version', async () => {
    const c = await negotiated()
    const r = await app.inject({ method: 'GET', url: `/api/v1/contracts/${c.id}/changes`, headers: as() })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.baseline).toMatchObject({ versionId: c.v1, versionNumber: 1, reason: 'origin' })
    expect(body.against).toMatchObject({ kind: 'version', versionId: c.v2 })
    expect(body.diffHtml).toMatch(/<del[^>]*>[^<]*capped at the fees paid/)
    expect(body.diffHtml).toMatch(/<ins[^>]*>[^<]*uncapped/)
    expect(body.options.originVersionId).toBe(c.v1)
    expect(body.options.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1])
    expect(body.options.versions[0].fromCounterparty).toBe(true)
  })

  it('compares the draft changes when there are any, against the baseline picked', async () => {
    const c = await negotiated()
    await prisma.contractWorkingCopy.create({ data: { orgId: org, contractId: c.id, baseVersionId: c.v2, html: '<p>Liability is capped at twice the fees paid.</p>', revision: 1, updatedById: user } })
    const r = await app.inject({ method: 'GET', url: `/api/v1/contracts/${c.id}/changes?baseline=${c.v1}`, headers: as() })
    expect(r.statusCode).toBe(200)
    expect(r.json().against.kind).toBe('draft')
    expect(r.json().baseline.reason).toBe('chosen')
    expect(r.json().diffHtml).toMatch(/<ins[^>]*>[^<]*twice/)
  })

  it('is not found for another org, or for a version of another contract', async () => {
    const c = await negotiated()
    const other = await negotiated()
    expect((await app.inject({ method: 'GET', url: `/api/v1/contracts/${c.id}/changes`, headers: as(outsider, otherOrg) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/contracts/${c.id}/changes?baseline=${other.v1}`, headers: as() })).statusCode).toBe(404)
  })
})

describe('POST /contracts/:id/changes/counter', () => {
  it('drafts counter wording with its rationale from the agents service', async () => {
    const c = await negotiated()
    agents.calls.length = 0
    const r = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${c.id}/changes/counter`, headers: as(),
      payload: { ourText: 'Liability is capped at the fees paid.', theirText: 'Liability is uncapped.', clauseType: 'liability' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ counterText: 'Liability is capped at twelve months of fees.', counterNote: 'Meets them halfway on the cap.', suggestionId: expect.any(String) })
    expect(agents.calls).toHaveLength(1)
    expect(agents.calls[0].path).toBe('/redline/counter')
    expect(agents.calls[0].body).toMatchObject({ ourText: 'Liability is capped at the fees paid.', theirText: 'Liability is uncapped.', clauseType: 'liability', orgId: org })
  })

  it('says so when no counter came back, and refuses an empty change', async () => {
    const c = await negotiated()
    agents.reply = { counterText: '', counterNote: '' }
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${c.id}/changes/counter`, headers: as(), payload: { ourText: 'a', theirText: 'b' } })
    expect(r.statusCode).toBe(502)
    expect(r.json().detail).toMatch(/No counter/)
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${c.id}/changes/counter`, headers: as(), payload: { ourText: ' ', theirText: '' } })).statusCode).toBe(400)
  })

  it('is not found for another org', async () => {
    const c = await negotiated()
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${c.id}/changes/counter`, headers: as(outsider, otherOrg), payload: { ourText: 'a', theirText: 'b' } })
    expect(r.statusCode).toBe(404)
  })
})
