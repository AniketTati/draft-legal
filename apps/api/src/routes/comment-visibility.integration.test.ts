/**
 * docs/41 Part 16 — comment visibility and anchors.
 *
 * A thread is internal unless someone marks it external. The portal reads and
 * writes external threads only. A thread's anchor is re-found by its words in
 * later versions, or the thread is orphaned.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { signPortalToken } from './share.js'

let app: TestApp
let org: string, other: string, owner: string, contract: string, v1: string, v2: string, portalToken: string

const H = () => auth(org, ['ADMIN'], owner)
const post = (payload: Record<string, unknown>, headers = H()) =>
  app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/comments`, headers, payload })
const patch = (id: string, payload: Record<string, unknown>, headers = H()) =>
  app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}/comments/${id}`, headers, payload })
const list = (q = '') => app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/comments${q}`, headers: H() })
const portalList = () => app.inject({ method: 'GET', url: `/api/v1/portal/${portalToken}/comments` })
const portalPost = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/portal/${portalToken}/comments`, payload })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Comment Visibility Org')
  other = await makeOrg('Comment Visibility Other Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Visibility MSA', status: 'UNDER_NEGOTIATION' })
  const text1 = 'The Supplier shall indemnify the Customer. Fees are payable within 30 days.'
  v1 = (await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, htmlContent: `<p>${text1}</p>`, plainText: text1, createdById: owner } })).id
  const text2 = 'Preamble added here. The Supplier shall  indemnify\nthe Customer. Fees are payable within 60 days.'
  v2 = (await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 2, htmlContent: `<p>${text2}</p>`, plainText: text2, createdById: owner } })).id
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v2 } })
  const token = randomBytes(32).toString('hex')
  await prisma.contractShareLink.create({
    data: { orgId: org, contractId: contract, token, permissions: ['read', 'comment'], expiresAt: new Date(Date.now() + 3600_000), createdById: owner },
  })
  portalToken = signPortalToken({ token, contractId: contract, orgId: org, permissions: ['read', 'comment'] }, 3600)
})

afterAll(async () => { await cleanupAll(); await closeApp() })

describe('visibility', () => {
  let internalId: string, externalId: string

  it('a new thread is internal; one can be posted external; a reply follows its thread', async () => {
    const a = await post({ body: 'Our fallback is 45 days.' })
    expect(a.statusCode).toBe(201)
    expect(a.json().visibility).toBe('internal')
    internalId = a.json().id
    const b = await post({ body: 'Please confirm the notice address.', visibility: 'external' })
    expect(b.json().visibility).toBe('external')
    externalId = b.json().id
    const reply = await post({ body: 'Internal aside', parentId: externalId, visibility: 'internal' })
    expect(reply.json().visibility).toBe('external')
    expect((await post({ body: 'x', visibility: 'secret' })).statusCode).toBe(400)
  })

  it('the portal sees only external threads, and never our user ids', async () => {
    const res = await portalList()
    expect(res.statusCode).toBe(200)
    const ids = res.json().data.map((t: { id: string }) => t.id)
    expect(ids).toContain(externalId)
    expect(ids).not.toContain(internalId)
    expect(res.body).not.toContain(owner)
  })

  it('marking a thread external or internal moves it, with its replies, and is audited', async () => {
    const r = await patch(internalId, { visibility: 'external' })
    expect(r.statusCode).toBe(200)
    expect(r.json().visibility).toBe('external')
    expect((await portalList()).json().data.map((t: { id: string }) => t.id)).toContain(internalId)
    await post({ body: 'reply in it', parentId: internalId })
    expect((await patch(internalId, { visibility: 'internal' })).statusCode).toBe(200)
    const replies = await prisma.contractComment.findMany({ where: { parentId: internalId } })
    expect(replies.every(c => c.visibility === 'internal')).toBe(true)
    expect((await portalList()).json().data.map((t: { id: string }) => t.id)).not.toContain(internalId)
    const audit = await prisma.auditEvent.findFirst({ where: { orgId: org, action: 'COMMENT_VISIBILITY_CHANGED' }, orderBy: { createdAt: 'desc' } })
    expect(audit?.metadata).toMatchObject({ commentId: internalId, from: 'external', to: 'internal' })
    // A reply can't be marked on its own.
    expect((await patch(replies[0].id, { visibility: 'external' })).statusCode).toBe(400)
  })

  it('needs the right to edit the contract', async () => {
    const viewer = auth(org, ['VIEWER'])
    expect((await patch(externalId, { visibility: 'internal' }, viewer)).statusCode).toBe(403)
  })

  it('the internal list filters by visibility', async () => {
    const ext = (await list('?visibility=external')).json().data
    expect(ext.every((t: { visibility: string }) => t.visibility === 'external')).toBe(true)
  })

  it('what the counterparty posts is external, and they can reply only in external threads', async () => {
    const c = await portalPost({ body: 'We need 60 days.', authorName: 'Pat (Acme)' })
    expect(c.statusCode).toBe(201)
    expect(c.json().visibility).toBe('external')
    expect((await portalPost({ body: 'ok', parentId: externalId })).statusCode).toBe(201)
    expect((await portalPost({ body: 'peek', parentId: internalId })).statusCode).toBe(404)
    // Their thread stays external.
    expect((await patch(c.json().id, { visibility: 'internal' })).statusCode).toBe(409)
  })
})

describe('anchors', () => {
  it('stays where it was in its own version, and is re-found by its words in a later one', async () => {
    const quote = 'The Supplier shall indemnify the Customer.'
    const r = await post({ body: 'Mutual?', anchor: { quote, start: 0, end: quote.length, versionId: v1 } })
    expect(r.statusCode).toBe(201)
    expect(r.json().anchor).toMatchObject({ quote, versionId: v1 })
    const same = (await list(`?versionId=${v1}`)).json().data.find((t: { id: string }) => t.id === r.json().id)
    expect(same).toMatchObject({ anchorState: 'anchored', anchorStart: 0 })
    // v2 moved it and changed its spacing: found again, whitespace ignored.
    const later = (await list()).json().data.find((t: { id: string }) => t.id === r.json().id)
    expect(later.anchorState).toBe('moved')
    expect(later.anchorStart).toBe('Preamble added here. '.length)
  })

  it('is orphaned when its words are gone', async () => {
    const quote = 'within 30 days'
    const r = await post({ body: 'Too short', anchor: { quote, start: 60, end: 74, versionId: v1 } })
    const t = (await list()).json().data.find((x: { id: string }) => x.id === r.json().id)
    expect(t).toMatchObject({ anchorState: 'orphaned', anchorStart: null })
  })

  it('refuses an anchor on another contract\'s version', async () => {
    const owner2 = await makeUser(org)
    const c2 = await makeContract(org, owner2, { title: 'Other' })
    const v = await prisma.contractVersion.create({ data: { contractId: c2, versionNumber: 1, htmlContent: '<p>x</p>', plainText: 'x', createdById: owner2 } })
    expect((await post({ body: 'x', anchor: { quote: 'x', start: 0, end: 1, versionId: v.id } })).statusCode).toBe(400)
  })
})

describe('tenant isolation', () => {
  it('another org can neither read nor mark the threads', async () => {
    const theirs = auth(other, ['ADMIN'])
    expect((await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/comments`, headers: theirs })).statusCode).toBe(404)
    const one = await prisma.contractComment.findFirstOrThrow({ where: { contractId: contract, parentId: null } })
    expect((await patch(one.id, { visibility: 'external' }, theirs)).statusCode).toBe(404)
  })
})
