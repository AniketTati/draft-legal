/**
 * docs/39 E1 — a person tags a clause the AI missed, redraws one it cut
 * short, sets one of the wrong type right, and says one isn't a clause —
 * and a re-analysis keeps all of that.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { storeClauseSegments } from '../lib/embeddings.js'

let app: TestApp
let org: string, owner: string, other: string, contract: string, versionId: string

const TEXT = [
  '1. SERVICES. The Supplier provides the services in Schedule 1.',
  '2. FEES. Fees are payable within thirty (30) days of invoice.',
  '3. NON-SOLICITATION. During the term and for twelve (12) months after, neither party shall solicit for employment any employee of the other party who worked on the services.',
  '4. NOTICES. Notices must be in writing and sent to the addresses above.',
].join('\n\n')

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Clause Tag Org')
  owner = await makeUser(org)
  other = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Services MSA', type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: owner, plainText: TEXT } })
  versionId = v.id
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
  await prisma.contractClause.createMany({ data: [
    { versionId, clauseType: 'payment', content: 'Fees are payable within thirty (30) days of invoice.', sortOrder: 0, docStart: TEXT.indexOf('Fees are'), docEnd: TEXT.indexOf('invoice.') + 8 },
    // Cut short by the AI.
    { versionId, clauseType: 'non_solicitation', content: 'During the term and for twelve (12) months after, neither party shall solicit', sortOrder: 1 },
    // Not a clause at all.
    { versionId, clauseType: 'general', content: '1. SERVICES. The Supplier provides the services in Schedule 1.', sortOrder: 2 },
  ] })
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

const editor = () => auth(org, ['LEGAL_OPS'], owner)
const clauses = async () => (await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/clauses`, headers: editor() })).json().data as Array<{ id: string; clauseType: string; content: string; source: string }>

describe('tagging clauses (E1)', () => {
  it('tags a clause the AI missed, placed in the text', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${contract}/clauses/tag`, headers: editor(),
      payload: { clauseType: 'notice', text: 'Notices must be in writing and sent to the addresses above.' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ action: 'tagged', clause: { clauseType: 'notice' } })
    const row = await prisma.contractClause.findUniqueOrThrow({ where: { id: res.json().clause.id } })
    expect(row).toMatchObject({ source: 'user' })
    expect(TEXT.slice(row.docStart!, row.docEnd!)).toBe('Notices must be in writing and sent to the addresses above.')
  })

  it('redraws a clause the AI cut short when the same kind is tagged over it', async () => {
    const full = 'During the term and for twelve (12) months after, neither party shall solicit for employment any employee of the other party who worked on the services.'
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/clauses/tag`, headers: editor(), payload: { clauseType: 'non_solicitation', text: full } })
    expect(res.json()).toMatchObject({ action: 'redrawn' })
    const now = (await clauses()).filter(c => c.clauseType === 'non_solicitation')
    expect(now).toHaveLength(1)
    expect(now[0]).toMatchObject({ content: full, source: 'user' })
  })

  it('never shrinks a clause: words inside one of the same kind are already covered', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/clauses/tag`, headers: editor(), payload: { clauseType: 'non_solicitation', text: 'neither party shall solicit for employment' } })
    expect(res.json()).toMatchObject({ action: 'covered' })
    const [clause] = (await clauses()).filter(c => c.clauseType === 'non_solicitation')
    expect(clause.content.startsWith('During the term')).toBe(true)
    expect(clause.content.endsWith('worked on the services.')).toBe(true)
  })

  it('sets a clause of the wrong type right, and a refused type is refused', async () => {
    const payment = (await clauses()).find(c => c.clauseType === 'payment')!
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/clauses/${payment.id}/type`, headers: editor(), payload: { clauseType: 'price_adjustment' } })
    expect(res.json()).toMatchObject({ clause: { clauseType: 'price_adjustment' } })
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/contracts/clauses/${payment.id}/type`, headers: editor(), payload: { clauseType: 'made_up' } })).statusCode).toBe(422)
  })

  it('dismisses what isn’t a clause, and a re-analysis leaves it out and keeps the rest', async () => {
    const general = (await clauses()).find(c => c.clauseType === 'general')!
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/clauses/${general.id}/dismiss`, headers: editor() })).statusCode).toBe(200)
    expect((await clauses()).some(c => c.clauseType === 'general')).toBe(false)

    // The AI reads the contract again: the dismissed words come back as a
    // "general" clause, the cut-short clause as its AI copy.
    await storeClauseSegments(versionId, [
      { clauseType: 'general', content: '1. SERVICES. The Supplier provides the services in Schedule 1.', sortOrder: 0 },
      { clauseType: 'payment', content: 'Fees are payable within thirty (30) days of invoice.', sortOrder: 1 },
      { clauseType: 'non_solicitation', content: 'During the term and for twelve (12) months after, neither party shall solicit for employment any employee of the other party who worked on the services.', sortOrder: 2 },
    ], TEXT)
    // The AI's "payment" is the passage a person filed as a price adjustment: left out too.
    const after = await clauses()
    expect(after.map(c => [c.clauseType, c.source]).sort()).toEqual([
      ['non_solicitation', 'user'], ['notice', 'user'], ['price_adjustment', 'user'],
    ].sort())
  })

  it('an own-scope editor can’t touch someone else’s clauses', async () => {
    await prisma.role.create({ data: { orgId: org, name: 'CLAUSE_OWN_EDITOR', permissions: [{ action: 'view', resource: 'contract', scope: 'own' }, { action: 'edit', resource: 'contract', scope: 'own' }] } })
    const { invalidatePermissionCache } = await import('../lib/permissions.js')
    invalidatePermissionCache(org)
    const outsider = auth(org, ['CLAUSE_OWN_EDITOR'], other)
    const notice = (await clauses()).find(c => c.clauseType === 'notice')!
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/clauses/${notice.id}/dismiss`, headers: outsider })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/clauses/tag`, headers: outsider, payload: { clauseType: 'notice', text: 'Notices must be in writing' } })).statusCode).toBe(404)
  })

  it('after an edit not yet analysed, tags onto the version whose clauses the list shows', async () => {
    const id = await makeContract(org, owner, { title: 'Edited, not re-analysed', type: 'MSA' })
    const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: TEXT } })
    await prisma.contractClause.createMany({ data: [
      { versionId: v1.id, clauseType: 'payment', content: 'Fees are payable within thirty (30) days of invoice.', sortOrder: 0 },
      { versionId: v1.id, clauseType: 'confidentiality', content: 'Each party keeps the other party’s information confidential.', sortOrder: 1 },
    ] })
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: owner, plainText: `${TEXT}\n\n5. EXTRA. An edit.` } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/clauses/tag`, headers: editor(), payload: { clauseType: 'notice', text: 'Notices must be in writing and sent to the addresses above.' } })
    expect(res.statusCode).toBe(200)
    const listed = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/clauses`, headers: editor() })).json().data as Array<{ clauseType: string }>
    expect(listed.map(c => c.clauseType).sort()).toEqual(['confidentiality', 'notice', 'payment'])
    await prisma.contract.update({ where: { id }, data: { currentVersionId: null } })
  })
})
