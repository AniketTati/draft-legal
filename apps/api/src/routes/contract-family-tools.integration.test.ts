/**
 * Amendments were invisible to the assistant. The contract page shows a
 * contract's family (GET /contracts/:id/family), but none of the chat's
 * contract tools returned the links, so an amended price or term read as the
 * original. contract_get and contract_summarize now return the family, and
 * contract_search and counterparty_memory rows carry the link.
 *
 * And a renewal prep compares what was billed against the negotiated
 * pricing: invoice_list gives the assistant a contract's or a vendor's
 * invoices, scoped as the Invoices page is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, grantRole, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, other: string, admin: string, rep: string
let base: string, amendment: string, exhibit: string, stray: string

async function tool(name: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/internal/ai/tools/${name}`,
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, ...payload },
  })
}

const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id)

// The amendment's document, with a value the org's PII policy redacts.
const SSN = '123-45-6789'
const AMENDMENT_TEXT = `Section 3.2 is amended by replacing "thirty (30) days" with "sixty (60) days". Notices to the signatory, SSN ${SSN}.`

async function invoice(orgId: string, createdById: string, over: { contractId?: string; vendorName: string; invoiceNumber: string; amount: number; invoiceDate: string; status?: string; description?: string }) {
  await prisma.invoice.create({
    data: {
      orgId, createdById,
      contractId: over.contractId ?? null,
      vendorName: over.vendorName, invoiceNumber: over.invoiceNumber,
      amount: over.amount, currency: 'USD', invoiceDate: new Date(over.invoiceDate),
      status: over.status ?? 'PENDING', description: over.description ?? null,
    },
  })
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Contract Family Org')
  admin = await makeUser(org)
  rep = await makeUser(org)
  await grantRole(org, admin, 'ADMIN')
  await grantRole(org, rep, 'SALES_REP')

  // The rep owns the base contract and its exhibit; the amendment is the admin's.
  base = await makeContract(org, rep, { title: 'Acme Family — License', type: 'LICENSE', status: 'EXECUTED' })
  amendment = await makeContract(org, admin, { title: 'Acme Family — License — Amendment No. 1', type: 'LICENSE', status: 'EXECUTED' })
  exhibit = await makeContract(org, rep, { title: 'Acme Family — License — Exhibit A', type: 'OTHER' })
  await prisma.contract.update({ where: { id: base }, data: { counterpartyName: 'Acme Family' } })
  await prisma.contract.update({ where: { id: amendment }, data: { counterpartyName: 'Acme Family', parentContractId: base, relationshipType: 'amendment' } })
  await prisma.contract.update({ where: { id: exhibit }, data: { counterpartyName: 'Acme Family', parentContractId: base, relationshipType: 'exhibit_only' } })
  const v = await prisma.contractVersion.create({
    data: { contractId: amendment, versionNumber: 1, createdById: admin, plainText: AMENDMENT_TEXT, htmlContent: `<p>${AMENDMENT_TEXT}</p>` },
  })
  await prisma.contract.update({ where: { id: amendment }, data: { currentVersionId: v.id, summary: 'Extends the notice period from 30 to 60 days.' } })

  // Another org's contract that points at ours (bad data) never shows.
  other = await makeOrg('Contract Family Other Org')
  const outsider = await makeUser(other)
  stray = await makeContract(other, outsider, { title: 'Stray amendment' })
  await prisma.contract.update({ where: { id: stray }, data: { parentContractId: base, relationshipType: 'amendment' } })

  // Invoices: two on the base contract (out of date order), one on the admin's
  // amendment, an unmatched one each from the rep and the admin, and another
  // org's invoice from the same vendor.
  await invoice(org, admin, { contractId: base, vendorName: 'Acme Family Inc.', invoiceNumber: 'AF-2', amount: 1500.5, invoiceDate: '2026-06-15', status: 'DISPUTED', description: '100 seats @ $15.005' })
  await invoice(org, admin, { contractId: base, vendorName: 'Acme Family Inc.', invoiceNumber: 'AF-1', amount: 1000, invoiceDate: '2026-03-15', status: 'RECONCILED', description: '100 seats @ $10' })
  await invoice(org, admin, { contractId: amendment, vendorName: 'Acme Family Inc.', invoiceNumber: 'AF-3', amount: 200, invoiceDate: '2026-07-01' })
  await invoice(org, rep, { vendorName: 'Acme Family Billing', invoiceNumber: 'AF-U1', amount: 50, invoiceDate: '2026-08-01' })
  await invoice(org, admin, { vendorName: 'Acme Family Billing', invoiceNumber: 'AF-U2', amount: 60, invoiceDate: '2026-08-02' })
  await invoice(other, outsider, { vendorName: 'Acme Family Inc.', invoiceNumber: 'OUTSIDE-1', amount: 999, invoiceDate: '2026-05-01' })
})

afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { orgId: { in: [org, other] } } }).catch(() => {})
  await prisma.contract.update({ where: { id: stray }, data: { parentContractId: null } }).catch(() => {})
  await cleanupAll()
  await closeApp()
})

describe('the assistant sees a contract\'s amendments', () => {
  it('contract_get on the base contract lists what is linked under it', async () => {
    const res = await tool('contract_get', { contractId: base })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.relationshipType).toBeNull()
    expect(body.family.parent).toBeNull()
    expect(body.family.children.map((c: { id: string; relationshipType: string }) => [c.id, c.relationshipType]))
      .toEqual([[amendment, 'amendment'], [exhibit, 'exhibit_only']])
    expect(body.family.siblings).toEqual([])
    expect(body.familyNote).toMatch(/^A later contract changes this one's terms/)
  })

  it('shows what the amendment says inline, redacted, so its terms are not skipped', async () => {
    const body = (await tool('contract_get', { contractId: base })).json()
    const [amended, attached] = body.family.children
    expect(amended.text).toContain('replacing "thirty (30) days" with "sixty (60) days"')
    expect(amended.text).not.toContain(SSN)
    expect(amended).toMatchObject({ summary: 'Extends the notice period from 30 to 60 days.', textTruncated: false })
    // An exhibit changes no terms: listed, not quoted.
    expect(attached.text).toBeUndefined()
    expect(body.familyNote).toContain('What each says is in its `text`')
    expect(body.familyNote).toContain('the latest amendment wins')
  })

  it('contract_get on an amendment names the contract it amends', async () => {
    const body = (await tool('contract_get', { contractId: amendment })).json()
    expect(body.relationshipType).toBe('amendment')
    expect(body.family.parent).toMatchObject({ id: base, title: 'Acme Family — License', relationshipType: null })
    expect(ids(body.family.siblings)).toEqual([exhibit])
    expect(body.familyNote).toContain('This contract amends "Acme Family — License"')
  })

  it('an exhibit changes no terms, so it gets no note', async () => {
    const body = (await tool('contract_get', { contractId: exhibit })).json()
    expect(body.relationshipType).toBe('exhibit_only')
    expect(body.family.parent?.id).toBe(base)
    expect(ids(body.family.siblings)).toEqual([amendment])
    expect(body.familyNote).toBeUndefined()
  })

  it('contract_summarize, which the assistant prefers for key terms, shows the family too', async () => {
    const res = await tool('contract_summarize', { contractId: base })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(ids(body.family.children)).toEqual([amendment, exhibit])
    expect(body.familyNote).toMatch(/^A later contract changes this one's terms/)
  })

  it('counterparty_memory and contract_search rows carry the link', async () => {
    const mem = (await tool('counterparty_memory', { counterpartyName: 'Acme Family' })).json()
    const deal = (id: string) => mem.deals.find((d: { contractId: string }) => d.contractId === id)
    expect(deal(amendment)).toMatchObject({ parentContractId: base, relationshipType: 'amendment' })
    expect(deal(base)).toMatchObject({ parentContractId: null, relationshipType: null })

    const search = (await tool('contract_search', { query: 'Acme Family' })).json()
    expect(search.results.find((r: { id: string }) => r.id === exhibit)).toMatchObject({ parentContractId: base, relationshipType: 'exhibit_only' })
  })

  it('an own-scope caller sees only the relatives it owns', async () => {
    const body = (await tool('contract_get', { contractId: base, userId: rep })).json()
    expect(ids(body.family.children)).toEqual([exhibit])
    expect(body.familyNote).toBeUndefined()

    // From the exhibit, the rep sees the base contract (theirs) but not the admin's amendment.
    const own = (await tool('contract_get', { contractId: exhibit, userId: rep })).json()
    expect(own.family.parent?.id).toBe(base)
    expect(own.family.siblings).toEqual([])
  })
})

describe('invoice_list', () => {
  type Item = { invoiceNumber: string; amount: number; contractId: string | null; contractTitle: string | null; status: string; description: string | null }
  const numbers = (items: Item[]) => items.map(i => i.invoiceNumber)

  it('lists a contract\'s invoices oldest first, with totals', async () => {
    const res = await tool('invoice_list', { contractId: base })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(numbers(body.items)).toEqual(['AF-1', 'AF-2'])
    expect(body.items[1]).toMatchObject({ amount: 1500.5, currency: 'USD', invoiceDate: '2026-06-15', status: 'DISPUTED', description: '100 seats @ $15.005', contractId: base, contractTitle: 'Acme Family — License', counterpartyName: 'Acme Family' })
    expect(body.total).toBe(2)
    expect(body.billedTotal).toEqual({ USD: 2500.5 })
    expect(body.byStatus).toEqual({ RECONCILED: 1, DISPUTED: 1 })
  })

  it('finds a vendor\'s invoices by the vendor billed or the contract\'s counterparty, in this org only', async () => {
    const body = (await tool('invoice_list', { counterpartyName: 'acme family' })).json()
    expect(numbers(body.items)).toEqual(['AF-1', 'AF-2', 'AF-3', 'AF-U1', 'AF-U2'])
    expect(body.billedTotal).toEqual({ USD: 2810.5 })

    const disputed = (await tool('invoice_list', { counterpartyName: 'Acme Family', status: 'DISPUTED' })).json()
    expect(numbers(disputed.items)).toEqual(['AF-2'])
  })

  it('an own-scope caller sees its own contracts\' invoices and the unmatched ones it entered', async () => {
    const body = (await tool('invoice_list', { counterpartyName: 'Acme Family', userId: rep })).json()
    expect(numbers(body.items)).toEqual(['AF-1', 'AF-2', 'AF-U1'])
  })

  it('says so when nothing is on file', async () => {
    const body = (await tool('invoice_list', { contractId: exhibit })).json()
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
    expect(body.note).toMatch(/No invoices on file/)
  })
})

describe('renewal_advice follows the amendments', () => {
  const DAY = 24 * 60 * 60 * 1000
  let renewing: string, itsAmendment: string
  const expiry = new Date(Date.now() + 80 * DAY)

  beforeAll(async () => {
    renewing = await makeContract(org, admin, { title: 'Renewing License', type: 'LICENSE', status: 'EXECUTED' })
    itsAmendment = await makeContract(org, admin, { title: 'Renewing License — Amendment No. 1', type: 'LICENSE', status: 'EXECUTED' })
    await prisma.contract.update({ where: { id: renewing }, data: { expiryDate: expiry, keyTerms: { autoRenew: true, noticeDays: 30 } } })
    await prisma.contract.update({
      where: { id: itsAmendment },
      data: { expiryDate: expiry, keyTerms: { noticePeriodDays: 60 }, parentContractId: renewing, relationshipType: 'amendment' },
    })
  })

  it('works the notice deadline out from the period the amendment set', async () => {
    const [item] = (await tool('renewal_advice', { contractId: renewing })).json().items
    expect(item).toMatchObject({ noticeDays: 60, noticePeriodSetBy: 'Renewing License — Amendment No. 1', autoRenews: true })
    expect(item.noticeDeadline).toBe(new Date(expiry.getTime() - 60 * DAY).toISOString().slice(0, 10))
  })

  it('contract_search cards carry the terms a benchmark compares, not the raw key terms', async () => {
    const card = (await tool('contract_search', { query: 'Renewing License' })).json().results
      .find((r: { id: string }) => r.id === renewing)
    expect(card.terms).toEqual({ autoRenew: true, noticeDays: 30 })
    expect(card.keyTerms).toBeUndefined()
  })

  it('lists the contract as the renewal, not its amendment as another one', async () => {
    const ids = (await tool('renewal_advice', { leadDays: 180, limit: 50 })).json().items.map((i: { contractId: string }) => i.contractId)
    expect(ids).toContain(renewing)
    expect(ids).not.toContain(itsAmendment)
  })
})
