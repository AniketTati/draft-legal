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

async function contractWith(title: string, text: string): Promise<string> {
  const id = await makeContract(org, user, { title })
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
