/**
 * C5 — review-queue corrections must write through to the canonical contract
 * columns (the contracts list, renewals and the renewal scan read those, not
 * keyTerms), and "reject" must clear the value as its label says.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, contract: string

const lowConfidence = (quote: string) => ({ confidence: 0.4, quote })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Review Queue Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Needs Review', status: 'EXECUTED' })
  await prisma.contract.update({
    where: { id: contract },
    data: {
      analysisStatus: 'DONE',
      effectiveDate: new Date('2024-01-01'),
      expiryDate: new Date('2025-01-01'),
      value: 1000,
      jurisdiction: 'Delaware',
      keyTerms: { effectiveDate: '2024-01-01', expiryDate: '2025-01-01', value: 1000, governingLaw: 'Delaware', noticePeriod: '30 days' },
      fieldConfidence: {
        effectiveDate: lowConfidence('commencing January 1'),
        expiryDate:    lowConfidence('ending on'),
        value:         lowConfidence('fees of'),
        governingLaw:  lowConfidence('laws of'),
        noticePeriod:  lowConfidence('notice'),
      },
    },
  })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

const admin = () => auth(org, ['ADMIN'], owner)
const verify = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/review-queue/${contract}/verify`, headers: admin(), payload })

describe('review queue corrections', () => {
  it('lists the low-confidence fields, filterable to one contract', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${contract}`, headers: admin() })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((i: { field: string }) => i.field).sort())
      .toEqual(['effectiveDate', 'expiryDate', 'governingLaw', 'noticePeriod', 'value'])
  })

  it('a corrected expiry date, value and governing law reach the columns the list and renewals read', async () => {
    expect((await verify({ field: 'expiryDate', value: '2027-06-30' })).statusCode).toBe(200)
    expect((await verify({ field: 'value', value: '250000' })).statusCode).toBe(200)
    expect((await verify({ field: 'effectiveDate', value: '2024-07-01' })).statusCode).toBe(200)
    expect((await verify({ field: 'governingLaw', value: 'New York' })).statusCode).toBe(200)

    const row = await prisma.contract.findUnique({ where: { id: contract } })
    expect(row?.expiryDate?.toISOString().slice(0, 10)).toBe('2027-06-30')
    expect(row?.effectiveDate?.toISOString().slice(0, 10)).toBe('2024-07-01')
    expect(Number(row?.value)).toBe(250000)
    expect(row?.jurisdiction).toBe('New York')
    // keyTerms stays in step so every reader agrees.
    expect(row?.keyTerms).toMatchObject({ expiryDate: '2027-06-30', value: 250000, governingLaw: 'New York' })

    const list = await app.inject({ method: 'GET', url: '/api/v1/contracts', headers: admin() })
    const listed = list.json().data.find((c: { id: string }) => c.id === contract)
    expect(listed.expiryDate.slice(0, 10)).toBe('2027-06-30')
    expect(Number(listed.value)).toBe(250000)

    // Verified entries leave the queue.
    const q = await app.inject({ method: 'GET', url: `/api/v1/review-queue?contractId=${contract}`, headers: admin() })
    expect(q.json().items.map((i: { field: string }) => i.field)).toEqual(['noticePeriod'])
  })

  it('refuses a correction that is not a date or a number', async () => {
    expect((await verify({ field: 'expiryDate', value: 'next spring' })).statusCode).toBe(400)
    expect((await verify({ field: 'value', value: 'lots' })).statusCode).toBe(400)
  })

  it('reject clears the value, as its label says', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review-queue/${contract}/reject`, headers: admin(),
      payload: { field: 'noticePeriod' },
    })
    expect(res.statusCode).toBe(200)
    const row = await prisma.contract.findUnique({ where: { id: contract } })
    expect(row?.keyTerms).not.toHaveProperty('noticePeriod')
    expect((row?.fieldConfidence as Record<string, { rejectedAt?: string }>).noticePeriod.rejectedAt).toBeTruthy()

    const expiry = await app.inject({
      method: 'POST', url: `/api/v1/review-queue/${contract}/reject`, headers: admin(),
      payload: { field: 'expiryDate' },
    })
    expect(expiry.statusCode).toBe(200)
    expect((await prisma.contract.findUnique({ where: { id: contract } }))?.expiryDate).toBeNull()
  })
})
