/**
 * docs/39 D3 — the contracts list by field values: a captured term can be
 * filtered on (in its own terms: a duration as a duration, money with its
 * currency), sorted by and shown as a column.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import type { FieldFilter } from '@clm/types'
import { parseCsv } from '../lib/csv.js'

let app: TestApp
let org: string, owner: string, rep: string
const ids: Record<string, string> = {}

const admin = () => auth(org, ['ADMIN'], owner)
const setField = (id: string, key: string, value: unknown) =>
  app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/${key}`, headers: admin(), payload: { value } })
const query = (payload: Record<string, unknown>, headers = admin()) =>
  app.inject({ method: 'POST', url: '/api/v1/contracts/query', headers, payload })
const titles = async (payload: Record<string, unknown>) => {
  const r = await query(payload)
  expect(r.statusCode).toBe(200)
  return (r.json().data as Array<{ title: string }>).map(c => c.title)
}
const where = (...filters: FieldFilter[]) => ({ where: filters, sort: { key: 'title', dir: 'asc' } })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Field Query Org')
  owner = await makeUser(org)
  rep = await makeUser(org)
  await prisma.contractFieldDefinition.createMany({
    data: [
      { orgId: org, fieldKey: 'confidentiality_period', fieldLabel: 'Confidentiality period', fieldType: 'duration', contractType: 'SOW' },
      { orgId: org, fieldKey: 'region', fieldLabel: 'Region', fieldType: 'select', options: ['EMEA', 'Americas', 'APAC'] },
      { orgId: org, fieldKey: 'services', fieldLabel: 'Services', fieldType: 'multiselect', options: ['Hosting', 'Support', 'Training'] },
      { orgId: org, fieldKey: 'expense_approver', fieldLabel: 'Expense approver', fieldType: 'text', contractType: 'SOW' },
    ],
  })
  const make = async (title: string, type: string, values: Record<string, unknown>, ownerId = owner) => {
    const id = await makeContract(org, ownerId, { title, type })
    for (const [k, v] of Object.entries(values)) expect((await setField(id, k, v)).statusCode).toBe(200)
    ids[title] = id
  }
  await make('Alpha SOW', 'SOW', { confidentiality_period: '5 years', region: 'EMEA', services: ['Hosting', 'Support'], value: '120,000', currency: 'USD', expiryDate: '2027-03-31', expense_approver: 'Jordan Rivera' })
  await make('Beta SOW', 'SOW', { confidentiality_period: '24 months', region: 'Americas', services: ['Training'], value: '80000', currency: 'EUR', expiryDate: '2026-12-31' })
  await make('Gamma SOW', 'SOW', { region: 'APAC', value: '40000', currency: 'USD' })
  await make('Delta MSA', 'MSA', { autoRenew: 'yes', governingLaw: 'Delaware', value: '250000', currency: 'USD' })
  await make('Rep NDA', 'NDA', { governingLaw: 'New York' }, rep)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('the field catalogue', () => {
  it('lists core, contract-type and the org’s own fields, each with the types it applies to', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/contracts/fields', headers: admin() })
    expect(r.statusCode).toBe(200)
    const byKey = new Map((r.json().fields as Array<{ key: string; kind: string; type: string; contractTypes: string[] | null }>).map(f => [f.key, f]))
    expect(byKey.get('value')).toMatchObject({ kind: 'core', type: 'number', contractTypes: null })
    expect(byKey.get('deliverables')).toMatchObject({ kind: 'type', contractTypes: ['SOW'] })
    expect(byKey.get('confidentiality_period')).toMatchObject({ kind: 'custom', type: 'duration', contractTypes: ['SOW'] })
    expect(byKey.get('region')).toMatchObject({ kind: 'custom', type: 'select', contractTypes: null })
    // The pre-split notice period is for the Review Queue to sort out, not a column.
    expect(byKey.has('noticePeriodDays')).toBe(false)
  })
})

describe('filtering by a field', () => {
  it('compares a duration as a length of time, whatever unit it was written in', async () => {
    expect(await titles(where({ key: 'confidentiality_period', op: 'gte', value: { value: 3, unit: 'years' } }))).toEqual(['Alpha SOW'])
    expect(await titles(where({ key: 'confidentiality_period', op: 'between', value: { value: 1, unit: 'years' }, to: { value: 30, unit: 'months' } }))).toEqual(['Beta SOW'])
    expect(await titles({ ...where({ key: 'confidentiality_period', op: 'empty' }), type: 'SOW' })).toEqual(['Gamma SOW'])
  })

  it('filters the contract value, with its currency when one is given', async () => {
    expect(await titles(where({ key: 'value', op: 'between', value: 50000, to: 150000 }))).toEqual(['Alpha SOW', 'Beta SOW'])
    expect(await titles(where({ key: 'value', op: 'gte', value: 50000, currency: 'EUR' }))).toEqual(['Beta SOW'])
  })

  it('filters dates, choices, yes/no and words', async () => {
    expect(await titles(where({ key: 'expiryDate', op: 'lte', value: '2027-01-31' }))).toEqual(['Beta SOW'])
    expect(await titles(where({ key: 'region', op: 'any_of', value: ['EMEA', 'APAC'] }))).toEqual(['Alpha SOW', 'Gamma SOW'])
    expect(await titles(where({ key: 'region', op: 'is_not', value: 'EMEA' }))).not.toContain('Alpha SOW')
    expect(await titles(where({ key: 'services', op: 'any_of', value: ['Support', 'Training'] }))).toEqual(['Alpha SOW', 'Beta SOW'])
    expect(await titles(where({ key: 'autoRenew', op: 'is', value: true }))).toEqual(['Delta MSA'])
    expect(await titles(where({ key: 'governingLaw', op: 'contains', value: 'dela' }))).toEqual(['Delta MSA'])
    expect(await titles(where({ key: 'expense_approver', op: 'contains', value: 'rivera' }))).toEqual(['Alpha SOW'])
    // Two filters: both hold.
    expect(await titles(where({ key: 'region', op: 'present' }, { key: 'value', op: 'lte', value: 50000 }))).toEqual(['Gamma SOW'])
  })

  it('says what is wrong with a filter rather than ignoring it', async () => {
    const unknown = await query({ where: [{ key: 'no_such_field', op: 'present' }] })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().detail).toContain('no_such_field')
    const wrongOp = await query({ where: [{ key: 'autoRenew', op: 'gte', value: 3 }] })
    expect(wrongOp.statusCode).toBe(400)
    expect(wrongOp.json().detail).toContain('Auto-renews')
  })
})

describe('sorting, columns and pages', () => {
  it('sorts by a field, empty values last either way', async () => {
    const asc = await titles({ type: 'SOW', sort: { key: 'confidentiality_period', dir: 'asc' } })
    expect(asc).toEqual(['Beta SOW', 'Alpha SOW', 'Gamma SOW'])
    const desc = await titles({ type: 'SOW', sort: { key: 'confidentiality_period', dir: 'desc' } })
    expect(desc).toEqual(['Alpha SOW', 'Beta SOW', 'Gamma SOW'])
  })

  it('returns the chosen fields as columns, as people read them', async () => {
    const r = await query({ type: 'SOW', columns: ['confidentiality_period', 'value', 'region', 'services'], sort: { key: 'title', dir: 'asc' } })
    const alpha = r.json().data[0]
    expect(alpha.title).toBe('Alpha SOW')
    expect(alpha.fields.confidentiality_period).toMatchObject({ value: { value: 5, unit: 'years' }, display: '5 years', source: 'user', verified: true })
    expect(alpha.fields.value).toMatchObject({ value: 120000, display: 'USD 120,000' })
    expect(alpha.fields.services.display).toBe('Hosting, Support')
    const gamma = r.json().data[2]
    expect(gamma.fields.confidentiality_period).toMatchObject({ value: null, display: '' })
  })

  it('pages with an offset and says how many match', async () => {
    const first = await query({ sort: { key: 'title', dir: 'asc' }, limit: 2 })
    expect(first.json()).toMatchObject({ total: 5, offset: 0, hasMore: true })
    const last = await query({ sort: { key: 'title', dir: 'asc' }, limit: 2, offset: 4 })
    expect(last.json()).toMatchObject({ total: 5, hasMore: false })
    expect(last.json().data.map((c: { title: string }) => c.title)).toEqual(['Rep NDA'])
    expect((await query({ limit: 2, offset: 10 })).json()).toMatchObject({ data: [], total: 5, hasMore: false })
  })

  it('keeps a search’s matches in their order', async () => {
    const order = [ids['Gamma SOW'], ids['Alpha SOW'], ids['Delta MSA']]
    expect(await titles({ ids: order })).toEqual(['Gamma SOW', 'Alpha SOW', 'Delta MSA'])
    expect(await titles({ ids: order, where: [{ key: 'region', op: 'present' }] })).toEqual(['Gamma SOW', 'Alpha SOW'])
  })

  it('shows an own-scope caller only their contracts', async () => {
    const r = await query({}, auth(org, ['SALES_REP'], rep))
    expect(r.statusCode).toBe(200)
    expect(r.json().data.map((c: { title: string }) => c.title)).toEqual(['Rep NDA'])
  })
})

describe('charting a field', () => {
  interface Bucket { label: string; count: number; filters: FieldFilter[] }
  interface Dist { buckets: Bucket[]; empty: Bucket; total: number; other: number; currency: string | null; currencies: Array<{ code: string; count: number }>; contractType: string | null }
  const chart = async (key: string, extra = '') => {
    const r = await app.inject({ method: 'GET', url: `/api/v1/analytics/by-field?key=${key}${extra}`, headers: admin() })
    expect(r.statusCode).toBe(200)
    return r.json() as Dist
  }
  // Every bar opens exactly the contracts it counts.
  const opensItsOwn = async (d: Dist) => {
    for (const b of [...d.buckets, d.empty]) {
      const listed = (await query({ where: b.filters, ...(d.contractType && { type: d.contractType }) })).json().total
      expect({ bar: b.label, listed }).toEqual({ bar: b.label, listed: b.count })
    }
  }
  const bars = (d: Dist) => d.buckets.map(b => [b.label, b.count])

  it('counts yes and no, and the contracts never read for the field', async () => {
    const d = await chart('autoRenew')
    expect(bars(d)).toEqual([['Yes', 1], ['No', 0]])
    expect(d.empty.count).toBe(4)
    await opensItsOwn(d)
  })

  it('counts each choice, and words as they are most often written', async () => {
    const region = await chart('region')
    expect(bars(region)).toEqual([['EMEA', 1], ['Americas', 1], ['APAC', 1]])
    await opensItsOwn(region)
    const law = await chart('governingLaw')
    expect(bars(law).sort()).toEqual([['Delaware', 1], ['New York', 1]])
    await opensItsOwn(law)
  })

  it('charts a field of one contract type over that type only, a bar per length of time', async () => {
    const d = await chart('confidentiality_period')
    expect(d.contractType).toBe('SOW')
    expect(d.total).toBe(3)
    expect(bars(d)).toEqual([['24 months', 1], ['5 years', 1]])
    expect(d.empty.count).toBe(1)
    await opensItsOwn(d)
  })

  it('charts money one currency at a time, and says how much is in others', async () => {
    const usd = await chart('value')
    expect(usd.currency).toBe('USD')
    expect(usd.currencies).toEqual([{ code: 'USD', count: 3 }, { code: 'EUR', count: 1 }])
    expect(usd.other).toBe(1)
    expect(usd.buckets.map(b => b.count)).toEqual([1, 1, 1])
    await opensItsOwn(usd)
    const eur = await chart('value', '&currency=EUR')
    expect(bars(eur)).toEqual([['EUR 80,000', 1]])
    await opensItsOwn(eur)
  })

  it('groups many amounts into ranges, each bar opening its range', async () => {
    for (let i = 1; i <= 10; i++) {
      const id = await makeContract(org, owner, { title: `Licence ${i}`, type: 'LICENSE' })
      await setField(id, 'paymentTermsDays', String(i * 10))
    }
    const d = await chart('paymentTermsDays', '&contractType=LICENSE')
    expect(d.buckets.length).toBeGreaterThan(2)
    expect(d.buckets.reduce((s, b) => s + b.count, 0)).toBe(10)
    expect(d.buckets[0].label).toMatch(/^Under /)
    expect(d.buckets[d.buckets.length - 1].label).toMatch(/or more$/)
    await opensItsOwn(d)
    await prisma.contract.updateMany({ where: { orgId: org, type: 'LICENSE' }, data: { deletedAt: new Date() } })
  })

  it('charts dates by month, each bar opening its month', async () => {
    const d = await chart('expiryDate')
    expect(bars(d)).toEqual([['Dec 2026', 1], ['Mar 2027', 1]])
    await opensItsOwn(d)
  })

  it('says why a field can’t be charted', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/analytics/by-field?key=ipOwnership', headers: admin() })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/v1/analytics/by-field?key=nope', headers: admin() })).statusCode).toBe(404)
  })
})

describe('the assistant searching by field', () => {
  const search = (payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/api/internal/ai/tools/contract_search',
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents' },
    // No user: a service call, org-wide (the caller's own scope is agent-scope's to test).
    payload: { orgId: org, limit: 20, ...payload },
  })
  type Hit = { title: string; fields?: Record<string, string | null> }

  it('filters by conditions written as the user said them, and shows those values', async () => {
    const r = (await search({ fieldConditions: ['confidentiality period >= 3 years'] })).json()
    expect(r.totalMatching).toBe(1)
    expect(r.results.map((h: Hit) => [h.title, h.fields])).toEqual([['Alpha SOW', { 'Confidentiality period': '5 years' }]])

    const law = (await search({ fieldConditions: ['governing law in Delaware, New York'], fields: ['contract value'], sortBy: 'value', sortOrder: 'desc' })).json()
    expect(law.results.map((h: Hit) => [h.title, h.fields?.['Contract value'], h.fields?.['Governing law']])).toEqual([
      ['Delta MSA', 'USD 250,000', 'Delaware'],
      ['Rep NDA', null, 'New York'],
    ])
  })

  it('sorts by a field, empty values last', async () => {
    const r = (await search({ type: 'SOW', sortByField: 'Confidentiality period', sortOrder: 'asc' })).json()
    expect(r.results.map((h: Hit) => h.title)).toEqual(['Beta SOW', 'Alpha SOW', 'Gamma SOW'])
  })

  it('answers a field it can’t find with the ones it might mean', async () => {
    const r = (await search({ fieldConditions: ['confidentiality term > 2 years'] })).json()
    expect(r.error).toBe('unknown_field')
    expect(r.note).toContain('Confidentiality period (confidentiality_period)')
    const bad = (await search({ fieldConditions: ['auto-renews >= 3'] })).json()
    expect(bad.error).toBe('invalid_field_filter')
  })
})

describe('exporting the list', () => {
  const exportCsv = (payload: Record<string, unknown>, headers = admin()) =>
    app.inject({ method: 'POST', url: '/api/v1/contracts/query/export', headers, payload })
  const parse = (body: string) => parseCsv(body.replace(/^\uFEFF/, '').trim())

  it('downloads the list as filtered and sorted, its field columns in their own shapes', async () => {
    const r = await exportCsv({ type: 'SOW', where: [{ key: 'region', op: 'present' }], columns: ['confidentiality_period', 'region', 'value', 'services'], sort: { key: 'title', dir: 'asc' } })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.headers['x-total-count']).toBe('3')
    expect(r.body.startsWith('﻿')).toBe(true)
    const [head, ...rows] = parse(r.body)
    // Contract value has its own fixed columns; it isn't repeated.
    // B3 — and what a person checked on each.
    expect(head).toEqual(['Title', 'Type', 'Status', 'Counterparty', 'Effective date', 'Expiry date', 'Contract value', 'Currency', 'Risk score', 'Created', 'Confidentiality period', 'Region', 'Services', 'Values checked', 'Not yet checked', 'Link'])
    expect(rows.map(r => r[0])).toEqual(['Alpha SOW', 'Beta SOW', 'Gamma SOW'])
    const alpha = rows[0]
    expect(alpha.slice(5, 8)).toEqual(['2027-03-31', '120000', 'USD'])
    expect(alpha.slice(10, 13)).toEqual(['5 years', 'EMEA', 'Hosting, Support'])
    expect(alpha[alpha.length - 1]).toMatch(/\/contracts\/[a-z0-9]+$/)
  })

  it('can’t be made to run a formula when opened', async () => {
    const id = await makeContract(org, owner, { title: '=HYPERLINK("https://evil.example","x")', type: 'NDA' })
    const r = await exportCsv({ ids: [id] })
    expect(r.body).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`)
    await prisma.contract.update({ where: { id }, data: { deletedAt: new Date() } })
  })

  it('needs the export right, and is audited', async () => {
    expect((await exportCsv({}, auth(org, ['VIEWER'], owner))).statusCode).toBe(403)
    await exportCsv({ where: [{ key: 'region', op: 'any_of', value: ['EMEA'] }] })
    const event = await prisma.auditEvent.findFirst({ where: { orgId: org, action: 'CONTRACTS_EXPORTED' }, orderBy: { createdAt: 'desc' } })
    expect(event?.metadata).toMatchObject({ rows: 1, matched: 1, where: [{ key: 'region', op: 'any_of' }] })
  })
})

describe('contracts analysed before the field store', () => {
  it('reads their values in before a field filter needs them', async () => {
    const id = await makeContract(org, owner, { title: 'Legacy SOW', type: 'SOW' })
    await prisma.contract.update({
      where: { id },
      data: {
        metadata: { region: 'EMEA' },
        keyTerms: { paymentTermsDays: 45 },
        fieldConfidence: { paymentTermsDays: { confidence: 0.9 } },
      },
    })
    expect(await prisma.contractFieldValue.count({ where: { contractId: id } })).toBe(0)
    expect(await titles(where({ key: 'paymentTermsDays', op: 'gte', value: 30 }))).toEqual(['Legacy SOW'])
    expect(await titles(where({ key: 'region', op: 'is_not', value: 'EMEA' }))).not.toContain('Legacy SOW')
  })
})
