/**
 * X36 — the chat tools cut contract text into excerpts (the first N
 * characters, a window around a match, a clause's opening) and redacted each
 * on its own. A value across a cut went out as a fragment no pattern
 * matches (`123-45-6`), and a card number whose "card" fell outside the
 * excerpt went out whole. The fixtures have no digits besides the values,
 * so any digit in an excerpt is a leak.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

const SSN = '123-45-6789'
const CARD = '4111 1111 1111 1111'

let app: TestApp
let org: string, user: string

async function contractWith(title: string, text: string, status?: string): Promise<string> {
  const id = await makeContract(org, user, { title, ...(status ? { status } : {}) })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, plainText: text, htmlContent: `<p>${text}</p>` } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  return id
}

async function tool(name: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST', url: `/api/internal/ai/tools/${name}`,
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, ...payload },
  })
  expect(res.statusCode, `${name}: ${res.body.slice(0, 200)}`).toBe(200)
  return res.json()
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Chat Tool Cuts Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await prisma.contractClause.deleteMany({ where: { id: { startsWith: 'it-x36-' } } })
  await prisma.contractClause.deleteMany({ where: { id: { startsWith: 'it-x40-' } } })
  await prisma.obligation.deleteMany({ where: { orgId: org } })
  await prisma.playbookPosition.deleteMany({ where: { orgId: org } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('excerpts cut from a longer text', () => {
  it('contract_get: the cut to maxChars never splits a value, and a card is known by a keyword past the cut', async () => {
    const text = `Charged monthly to ${CARD}. ${'Terms apply. '.repeat(20)}The Employee SSN ${SSN} is on file. ${'More terms. '.repeat(20)}All payments are made by credit card.`
    const id = await contractWith('Get', text)
    const out = await tool('contract_get', { contractId: id, maxChars: text.indexOf(SSN) + 6 })
    expect(out.plainText).toContain('The Employee SSN')
    expect(out.plainText).not.toMatch(/\d/)
  })

  it('contract_summarize: the same for its 1,500-character snippet', async () => {
    // The SSN starts at 1,494: the cut at 1,500 falls inside it.
    const text = `Charged monthly to ${CARD}. ${'Terms apply. '.repeat(200)}`.slice(0, 1_493) + ` ${SSN} is on file. All payments are made by credit card.`
    const id = await contractWith('Summarize', text)
    const out = await tool('contract_summarize', { contractId: id })
    expect(out.plainTextSnippet.length).toBeGreaterThan(1_000)
    expect(out.plainTextSnippet).not.toMatch(/\d/)
  })

  it('clause_search and portfolio_compare: a window edge never splits a value', async () => {
    // The window after "Employee" ends 4 characters into the SSN.
    const text = `The Employee ${'q'.repeat(20)} ${SSN} is on file.`
    const a = await contractWith('Search A', text)
    const b = await contractWith('Search B', text)
    const search = await tool('clause_search', { contractId: a, query: 'Employee', windowChars: 52 })
    expect(search.matches.length).toBeGreaterThan(0)
    for (const m of search.matches) expect(`${m.beforeContext}|${m.match}|${m.afterContext}`).not.toMatch(/\d/)

    const compare = await tool('portfolio_compare', { contractIds: [a, b], topics: ['Employee'], excerptChars: 52 })
    const cells = compare.matrix.flatMap((row: { perContract: Array<{ excerpt: string; found: boolean }> }) => row.perContract)
    expect(cells.filter((c: { found: boolean }) => c.found)).toHaveLength(2)
    for (const c of cells) expect(c.excerpt).not.toMatch(/\d/)
  })

  it('contract_validate: an issue window starting inside a value takes it whole, redacted', async () => {
    // The unresolved reference's window starts 30 characters back, inside the SSN.
    const id = await contractWith('Validate', `The Employee SSN ${SSN} ${'w'.repeat(23)}see Section ___ below.`)
    const out = await tool('contract_validate', { contractId: id })
    const issue = out.issues.find((i: { kind: string }) => i.kind === 'unresolved_crossref')
    expect(issue.excerpt).toContain('[REDACTED:SSN]')
    expect(issue.excerpt).not.toMatch(/\d/)
  })

  it('counterparty_memory: a clause cut to 400 characters never ends in part of a value', async () => {
    const id = await contractWith('Memory', 'Payment terms.')
    await prisma.contract.update({ where: { id }, data: { counterpartyName: 'Cuts Counterparty LLC' } })
    const versionId = (await prisma.contract.findUniqueOrThrow({ where: { id } })).currentVersionId as string
    await prisma.contractClause.create({
      data: { id: `it-x36-${versionId}`, versionId, clauseType: 'payment', content: `${'p'.repeat(394)} ${SSN} is the payee's number.` },
    })
    const out = await tool('counterparty_memory', { counterpartyName: 'Cuts Counterparty', clauseType: 'payment' })
    const deal = out.deals.find((d: { contractId: string }) => d.contractId === id)
    expect(deal.excerpt.length).toBeGreaterThan(300)
    expect(deal.excerpt).not.toMatch(/\d/)
  })
})

describe('X40 — values found against the whole contract, not just the clause', () => {
  // The card number is only a card because the contract says "credit card",
  // and not in the clause, paragraph or key term an excerpt is taken from.
  const CLAUSE = `Charges go to ${CARD} monthly.`
  const DOC = `Payment is by corporate credit card. ${'Terms apply. '.repeat(10)}Billing. ${CLAUSE}`
  const LEAK = /4111|1111/

  async function withClause(title: string, status?: string): Promise<string> {
    const id = await contractWith(title, DOC, status)
    const versionId = (await prisma.contract.findUniqueOrThrow({ where: { id } })).currentVersionId as string
    await prisma.contractClause.create({ data: { id: `it-x40-${versionId}`, versionId, clauseType: 'payment', content: CLAUSE } })
    return id
  }

  it('key terms and the summary in contract_get and contract_summarize', async () => {
    const id = await contractWith('Key terms', DOC)
    await prisma.contract.update({ where: { id }, data: { keyTerms: { payment: CARD, note: `Billed to ${CARD}.` }, summary: `Billed monthly to ${CARD}.` } })
    for (const name of ['contract_get', 'contract_summarize']) {
      const out = await tool(name, { contractId: id })
      expect(JSON.stringify(out.keyTerms), name).toContain('[REDACTED:CC]')
      expect(JSON.stringify(out.keyTerms), name).not.toMatch(LEAK)
      expect(out.summary, name).toBe('Billed monthly to [REDACTED:CC].')
    }
  })

  it('obligations_list: an obligation\'s description and quote', async () => {
    const id = await contractWith('Obligations', DOC)
    await prisma.obligation.create({ data: { orgId: org, contractId: id, type: 'payment', description: `Pay ${CARD} monthly.`, quote: CLAUSE } })
    const out = await tool('obligations_list', { contractId: id })
    expect(out.items).toHaveLength(1)
    expect(`${out.items[0].description} ${out.items[0].quote}`).not.toMatch(LEAK)
  })

  it('contract_cite: a paragraph', async () => {
    const id = await contractWith('Cite', DOC)
    const versionId = (await prisma.contract.findUniqueOrThrow({ where: { id } })).currentVersionId as string
    await prisma.contractVersion.update({
      where: { id: versionId },
      data: { metadata: { structure: { sections: [{ ref: '', title: 'Billing', level: 1, paragraphs: [{ text: CLAUSE }] }] } } },
    })
    const out = await tool('contract_cite', { contractId: id, query: 'charges go monthly' })
    expect(out.citations.length).toBeGreaterThan(0)
    for (const c of out.citations) expect(c.quote).not.toMatch(LEAK)
  })

  it('counterparty_memory, playbook_check and org_memory: a clause', async () => {
    const id = await withClause('Clause excerpts', 'EXECUTED')
    await prisma.contract.update({ where: { id }, data: { counterpartyName: 'X40 Card Counterparty', summary: `Billed monthly to ${CARD}.` } })
    const category = await prisma.clauseCategory.create({ data: { orgId: org, name: 'Payment' } })
    await prisma.playbookPosition.create({
      data: {
        orgId: org, clauseCategoryId: category.id, positionType: 'preferred', content: 'Billed monthly.', createdById: user,
        rules: { must_have: [{ description: 'Monthly billing', check: 'contains', value: 'monthly', severity: 'low' }] },
      },
    })

    const memory = await tool('counterparty_memory', { counterpartyName: 'X40 Card Counterparty', clauseType: 'payment' })
    const deal = memory.deals.find((d: { contractId: string }) => d.contractId === id)
    expect(`${deal.excerpt} ${deal.summary}`).not.toMatch(LEAK)

    const check = await tool('playbook_check', { contractId: id })
    const excerpts = check.checks.map((c: { excerpt: string }) => c.excerpt)
    expect(excerpts.length).toBeGreaterThan(0)
    for (const e of excerpts) expect(e).not.toMatch(LEAK)

    const org_ = await tool('org_memory', { topic: 'payment', clauseType: 'payment' })
    const past = org_.pastDeals.filter((d: { contractId: string }) => d.contractId === id)
    expect(past.length).toBeGreaterThan(0)
    for (const d of past) expect(d.excerpt).not.toMatch(LEAK)
  })
})
