/**
 * CC2 — clause_search showed a fixed window around each match. Asked what a
 * liability cap excludes, the assistant saw "Excluded Claims means: (a)
 * either party's indemnification obligations" cut off, and answered that
 * this was the whole list. A match now comes with its whole paragraph, the
 * section it is under, and whether all of it fitted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

async function contractWith(html: string): Promise<string> {
  const id = await makeContract(org, user, { title: 'CC2 passages' })
  const v = await prisma.contractVersion.create({
    data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: html, plainText: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') },
  })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  return id
}

async function search(contractId: string, query: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/internal/ai/tools/clause_search',
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, contractId, query },
  })
  expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
  return res.json() as { matches: Array<{ beforeContext: string; match: string; afterContext: string; sectionHint: string | null; passageComplete?: boolean }> }
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('CC2 Clause Search Org')
  user = await makeUser(org)
})
afterAll(async () => { await cleanupAll(); await closeApp() })

describe('clause_search passages', () => {
  const html = '<h1>3. LIMITATION OF LIABILITY</h1><ol><li>Each party’s aggregate liability shall not exceed two times the fees paid in the prior twelve months.</li>'
    + '<li>&quot;Excluded Claims&quot; means:<br />(a) either party’s indemnification obligations;<br />(b) a breach of Section 6 (Confidentiality);<br />(c) payment obligations;<br />(d) gross negligence or wilful misconduct; and<br />(e) infringement of intellectual property rights.</li></ol>'
    + '<h1>4. TERM</h1><p>This Agreement lasts one year.</p>'

  it('returns the whole paragraph a match is in, with its section, so a list is never cut short', async () => {
    const id = await contractWith(html)
    const { matches } = await search(id, 'Excluded Claims')
    expect(matches).toHaveLength(1)
    const [m] = matches
    expect(m.afterContext).toContain('(e) infringement of intellectual property rights.')
    expect(m.afterContext).not.toContain('4. TERM')
    expect(m).toMatchObject({ sectionHint: '3. LIMITATION OF LIABILITY', passageComplete: true })
  })

  it('takes what follows a heading that matched on its own', async () => {
    const id = await contractWith(html)
    const { matches } = await search(id, 'limitation of liability')
    expect(matches[0].afterContext).toContain('shall not exceed two times the fees')
  })

  it('says when a paragraph was too long to return whole', async () => {
    const id = await contractWith(`<h1>9. GENERAL</h1><p>${'The parties agree to the following terms. '.repeat(80)}Notices must be in writing.</p>`)
    const { matches } = await search(id, 'Notices')
    expect(matches[0].passageComplete).toBe(false)
    expect(matches[0].afterContext).toContain('must be in writing.')
  })
})

describe('CC7 — a contract with no document text', () => {
  it('clause_search and portfolio_compare say there is no document, not that the clause is missing', async () => {
    const bare = await makeContract(org, user, { title: 'CC7 record only' })
    const res = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/clause_search',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, contractId: bare, query: 'liability cap' },
    })
    expect(res.json()).toMatchObject({ matches: [], documentOnFile: false, note: expect.stringContaining('no document text on file') })

    const withText = await contractWith('<p>Liability is capped at the fees paid.</p>')
    const cmp = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/portfolio_compare',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, contractIds: [bare, withText], topics: ['liability cap'] },
    })
    const out = cmp.json()
    expect(out.contracts.find((c: { id: string }) => c.id === bare)).toMatchObject({ documentOnFile: false })
    expect(out.contracts.find((c: { id: string }) => c.id === withText)).toMatchObject({ documentOnFile: true })
    expect(out.note).toContain('CC7 record only has no document text on file')
  })
})

describe('CC7 — contract_search says why it found nothing', () => {
  const find = async (payload: Record<string, unknown>) => (await app.inject({
    method: 'POST', url: '/api/internal/ai/tools/contract_search',
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, ...payload },
  })).json()

  it('reports a company that matches nothing as a miss, without offering other counterparties\' contracts', async () => {
    const out = await find({ query: 'Globex Corporation' })
    expect(out.results).toEqual([])
    expect(out.searchMode).toBeUndefined()
    expect(out.note).toContain('No contract has a title or counterparty matching "Globex Corporation"')
  })

  it('says how many match without a type filter that emptied the search', async () => {
    const id = await makeContract(org, user, { title: 'Initrode supply', type: 'NDA' })
    await prisma.contract.update({ where: { id }, data: { counterpartyName: 'Initrode' } })
    const out = await find({ query: 'Initrode', type: 'MSA' })
    expect(out.results).toEqual([])
    expect(out.note).toContain('No MSA matched, but 1 contract matches without the type filter')
  })
})

describe('CC8 — contract_summarize names the document\'s sections', () => {
  it('lists the headings, so each point can be cited to the right one', async () => {
    const id = await contractWith('<h1>3. LIMITATION OF LIABILITY</h1><p>Capped.</p><h1>4. INDEMNIFICATION</h1><p>Customer indemnifies Supplier.</p><p>9. NOTICES</p><p>In writing.</p>')
    const res = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_summarize',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, contractId: id },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().sections).toEqual(['3. LIMITATION OF LIABILITY', '4. INDEMNIFICATION', '9. NOTICES'])
  })
})

describe('CC9 — contract_search by words, not one phrase', () => {
  it('finds "Iron Mountain SOW" in a title written "Iron Mountain — SOW", and "our contract with Iron Mountain" too', async () => {
    const id = await makeContract(org, user, { title: 'Iron Mountain — SOW', type: 'SOW' })
    await prisma.contract.update({ where: { id }, data: { counterpartyName: 'Iron Mountain' } })
    const find = async (payload: Record<string, unknown>) => (await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_search',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, ...payload },
    })).json()
    expect((await find({ query: 'Iron Mountain SOW', type: 'SOW' })).results.map((r: { id: string }) => r.id)).toEqual([id])
    expect((await find({ query: 'our contract with Iron Mountain' })).results.map((r: { id: string }) => r.id)).toEqual([id])
    expect((await find({ query: 'Iron Mountain NDA' })).results).toEqual([])
  })
})

describe('CC7 — contract_get on a record with no document', () => {
  it('says the document is not on file', async () => {
    const bare = await makeContract(org, user, { title: 'CC7 record for get' })
    const res = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_get',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, contractId: bare },
    })
    expect(res.json()).toMatchObject({ documentOnFile: false, note: expect.stringContaining('no document text on file') })
  })
})

describe('CC12 — a renewal view says what renews by itself, and by when', () => {
  it('gives each contract its auto-renewal and notice deadline, and a total to state', async () => {
    const id = await makeContract(org, user, { title: 'CC12 renews', status: 'EXECUTED' })
    const expiry = new Date(Date.now() + 60 * 86_400_000)
    await prisma.contract.update({ where: { id }, data: { expiryDate: expiry, keyTerms: { autoRenew: true, noticePeriodDays: 90 } } })
    const res = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/renewal_advice',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, leadDays: 90 },
    })
    const item = res.json().items.find((i: { contractId: string }) => i.contractId === id)
    expect(item).toMatchObject({
      autoRenews: true, noticeDays: 90, noticeDeadlinePassed: true,
      noticeDeadline: new Date(expiry.getTime() - 90 * 86_400_000).toISOString().slice(0, 10),
    })
  })
})
