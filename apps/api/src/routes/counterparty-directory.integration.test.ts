/**
 * docs/39 A14 — a contract's counterparty links to its directory entry by any
 * name the company goes by; A8 — the org's own companies are never the
 * counterparty, and contracts that name one can be put right.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { runExtractionJob, type ExtractionDeps, type ReviewRun } from '../lib/extraction-job.js'

let app: TestApp
let org: string, owner: string, acme: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })
const admin = () => auth(org, ['ADMIN'], owner)
const linkOf = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id }, select: { counterpartyId: true } })).counterpartyId

/** What an extraction saves: the counterparty it picked, and the parties it read. */
async function extracted(title: string, counterparty: string, parties: string[] = [counterparty], extra: Record<string, unknown> = {}) {
  const id = await makeContract(org, owner, { title, type: 'MSA' })
  const r = await app.inject({
    method: 'PATCH', url: `/api/v1/contracts/${id}`, headers: internal(),
    payload: {
      counterpartyName: counterparty,
      keyTerms: { parties: parties.map(name => ({ name })), ...extra },
      fieldConfidence: { parties: { confidence: 0.85, quote: `between ${parties.join(' and ')}` } },
    },
  })
  expect(r.statusCode).toBe(200)
  return id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Demo Org, Inc.')
  owner = await makeUser(org)
  acme = (await prisma.counterparty.create({ data: { orgId: org, name: 'Acme Corp.' } })).id
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('a contract’s counterparty links to its directory entry', () => {
  it('by any spelling of the company: case, punctuation, legal form, a defined term', async () => {
    const a = await extracted('Acme MSA', 'ACME CORPORATION, INC.')
    const b = await extracted('Acme NDA', 'The Acme Corporation (“Acme”)')
    expect(await linkOf(a)).toBe(acme)
    expect(await linkOf(b)).toBe(acme)
    // Acme's page now has both, though neither says "Acme Corp.".
    const page = (await app.inject({ method: 'GET', url: `/api/v1/counterparties/${acme}`, headers: admin() })).json()
    expect(page.contracts.map((c: { id: string }) => c.id).sort()).toEqual([a, b].sort())
  })

  it('follows the name: another company relinks, one not in the directory unlinks', async () => {
    const globex = (await prisma.counterparty.create({ data: { orgId: org, name: 'Globex' } })).id
    const id = await extracted('Moving MSA', 'Acme Corporation')
    expect(await linkOf(id)).toBe(acme)
    const put = (value: string) => app.inject({ method: 'PUT', url: `/api/v1/contracts/${id}/fields/counterpartyName`, headers: admin(), payload: { value } })
    expect((await put('Globex Inc.')).statusCode).toBe(200)
    expect(await linkOf(id)).toBe(globex)
    await put('Initrode Ltd')
    expect(await linkOf(id)).toBeNull()
  })

  it('an entry added, or given another name, links the contracts that name it — never a placeholder', async () => {
    const a = await extracted('Umbrella MSA', 'Umbrella Corporation')
    const b = await extracted('Umbrella SOW', 'UMBRELLA CORP')
    const blank = await extracted('Template', '[Company Name]')
    const created = await app.inject({ method: 'POST', url: '/api/v1/counterparties', headers: admin(), payload: { name: 'Umbrella Corp' } })
    expect(created.statusCode).toBe(201)
    expect(created.json().linkedContracts).toBe(2)
    expect(await linkOf(a)).toBe(created.json().id)
    expect(await linkOf(b)).toBe(created.json().id)
    expect(await linkOf(blank)).toBeNull()

    const c = await extracted('Big Blue MSA', 'International Business Machines Corporation')
    const ibm = (await prisma.counterparty.create({ data: { orgId: org, name: 'IBM' } })).id
    expect(await linkOf(c)).toBeNull() // initials are only a suggestion
    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/counterparties/${ibm}`, headers: admin(), payload: { legalName: 'International Business Machines Corp.' } })
    expect(renamed.json().linkedContracts).toBe(1)
    expect(await linkOf(c)).toBe(ibm)
  })

  it('an entry deleted before comes back when added again, with the contracts naming it', async () => {
    const gone = (await prisma.counterparty.create({ data: { orgId: org, name: 'Soylent', deletedAt: new Date() } })).id
    const id = await extracted('Soylent MSA', 'Soylent Corporation')
    expect(await linkOf(id)).toBeNull()
    const again = await app.inject({ method: 'POST', url: '/api/v1/counterparties', headers: admin(), payload: { name: 'Soylent', legalName: 'Soylent Corporation' } })
    expect(again.statusCode).toBe(201)
    expect(again.json()).toMatchObject({ id: gone, deletedAt: null, legalName: 'Soylent Corporation', linkedContracts: 1 })
  })
})

describe('an entry’s names, edited', () => {
  it('renamed, it keeps the old name; an alias taken off moves its contracts to the entry that has it, or none', async () => {
    const piper = (await prisma.counterparty.create({ data: { orgId: org, name: 'Pied Piper' } })).id
    const old = await extracted('Piper MSA', 'Pied Piper Inc.')
    const other = await extracted('Nucleus MSA', 'Nucleus Software')
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/v1/counterparties/${piper}`, headers: admin(), payload }).then(r => r.json())
    expect(await linkOf(old)).toBe(piper)

    expect((await patch({ name: 'Pied Piper Holdings' })).aliases).toEqual(['Pied Piper'])
    expect(await linkOf(old)).toBe(piper)

    // Someone links Nucleus here by mistake, then takes the name off again.
    expect((await patch({ aliases: ['Pied Piper', 'Nucleus Software'] })).linkedContracts).toBe(1)
    expect(await linkOf(other)).toBe(piper)
    const nucleus = (await prisma.counterparty.create({ data: { orgId: org, name: 'Nucleus Software, Inc.' } })).id
    const r = await patch({ aliases: ['Pied Piper'] })
    expect(r.unlinkedContracts).toBe(1)
    expect(await linkOf(other)).toBe(nucleus)
    expect(await linkOf(old)).toBe(piper)
  })
})

describe('a contract’s counterparty, as its page shows it', () => {
  const get = (id: string) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/counterparty`, headers: admin() }).then(r => r.json())

  it('names the entry it links to, else the entries it might be, else what adding it would call it', async () => {
    expect(await get(await extracted('Linked', 'Acme Corp'))).toMatchObject({ linked: { id: acme, name: 'Acme Corp.' }, suggestions: [], ours: false })
    const holdings = await get(await extracted('Holdings MSA', 'Acme Holdings Private Limited'))
    expect(holdings.linked).toBeNull()
    expect(holdings.suggestions).toEqual([expect.objectContaining({ id: acme, name: 'Acme Corp.' })])
    const fresh = await get(await extracted('New', 'Hooli XYZ, Inc., a Delaware corporation'))
    expect(fresh).toMatchObject({ linked: null, suggestions: [], directoryName: 'Hooli XYZ, Inc.' })
  })

  it('links to the entry a person picks: the name becomes an alias and the next contract naming it links itself', async () => {
    const first = await extracted('Holdings SOW', 'Acme Holdings Pvt. Ltd.')
    const other = await extracted('Holdings NDA', 'ACME HOLDINGS PRIVATE LIMITED')
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${first}/counterparty/link`, headers: admin(), payload: { counterpartyId: acme } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ linked: { id: acme }, aliasAdded: 'Acme Holdings Pvt. Ltd.' })
    expect(await linkOf(other)).toBe(acme)
    expect((await prisma.counterparty.findUniqueOrThrow({ where: { id: acme } })).aliases).toContain('Acme Holdings Pvt. Ltd.')
    expect(await linkOf(await extracted('Later', 'Acme Holdings Private Ltd'))).toBe(acme)

    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${first}/counterparty/link`, headers: auth(org, ['VIEWER'], owner), payload: { counterpartyId: acme } })).statusCode).toBe(403)
  })
})

describe('Counterparties › names not in the directory', () => {
  it('groups the spellings of a company, most contracts first, with the entry it might be', async () => {
    await extracted('Stark 1', 'Stark Industries')
    await extracted('Stark 2', 'STARK INDUSTRIES, INC.')
    await extracted('Stark 3', 'Stark Industries')
    await extracted('Wayne', 'Wayne Enterprises')
    const r = (await app.inject({ method: 'GET', url: '/api/v1/counterparties/unlinked', headers: admin() })).json()
    const stark = r.groups.find((g: { key: string }) => g.key === 'starkindustries')
    expect(stark).toMatchObject({ names: ['Stark Industries', 'STARK INDUSTRIES, INC.'], count: 3, suggestion: null, ours: false })
    expect(r.groups.findIndex((g: { key: string }) => g.key === 'starkindustries')).toBeLessThan(r.groups.findIndex((g: { key: string }) => g.key === 'wayneenterprises'))
    expect(r.groups.some((g: { names: string[] }) => g.names.includes('[Company Name]'))).toBe(false)

    const add = await app.inject({ method: 'POST', url: '/api/v1/counterparties', headers: admin(), payload: { name: 'Stark Industries', aliases: ['STARK INDUSTRIES, INC.'] } })
    expect(add.json().linkedContracts).toBe(3)
    expect(add.json().aliases).toEqual([]) // the same company as its name: nothing to add
  })

  it('another name for an entry links the contracts using it', async () => {
    const id = await extracted('Wayne 2', 'Wayne Ent.')
    const wayne = (await prisma.counterparty.create({ data: { orgId: org, name: 'Wayne Enterprises' } })).id
    const r = await app.inject({ method: 'POST', url: `/api/v1/counterparties/${wayne}/aliases`, headers: admin(), payload: { names: ['Wayne Ent.', 'wayne enterprises'] } })
    expect(r.json()).toMatchObject({ added: ['Wayne Ent.'], linkedContracts: 2 })
    expect(await linkOf(id)).toBe(wayne)
  })
})

describe('Analytics › top counterparties', () => {
  it('counts a company once whatever its contracts call it, with totals per currency', async () => {
    const signed = async (title: string, name: string, value: number, currency: string) => {
      const id = await extracted(title, name)
      await prisma.contract.update({ where: { id }, data: { status: 'EXECUTED', value, currency } })
    }
    await signed('Initech 1', 'Initech LLC', 100_000, 'USD')
    await signed('Initech 2', 'INITECH, L.L.C.', 50_000, 'USD')
    await signed('Initech 3', 'Initech', 20_000, 'EUR')
    await signed('Acme deal', 'Acme Corp', 120_000, 'USD')
    const rows = (await app.inject({ method: 'GET', url: '/api/v1/analytics/top-counterparties', headers: admin() })).json().data
    const initech = rows.find((r: { counterparty: string }) => /initech/i.test(r.counterparty))
    expect(initech).toMatchObject({
      counterpartyId: null, count: 3, names: ['Initech LLC', 'INITECH, L.L.C.', 'Initech'],
      totals: [{ currency: 'USD', amount: 150_000, count: 2 }, { currency: 'EUR', amount: 20_000, count: 1 }],
    })
    // Ranked by dollars (the portfolio's currency): Initech's euros don't add to them.
    expect(rows[0]).toMatchObject({ counterparty: 'Initech LLC' })
    expect(rows.find((r: { counterpartyId: string | null }) => r.counterpartyId === acme)).toMatchObject({ counterparty: 'Acme Corp.', count: 1 })
  })
})

describe('our entities (A8)', () => {
  const entities = (payload: Record<string, unknown>, roles = ['ADMIN'], method: 'PUT' | 'POST' = 'PUT') =>
    app.inject({ method, url: '/api/v1/organization/entities', headers: auth(org, roles, owner), payload })

  it('are kept one per company, never the org’s own name, by those who configure contracts', async () => {
    const r = await entities({ entities: ['Demo UK Ltd', 'DEMO UK LIMITED', 'Demo Org Inc', '  Demo GmbH ', '[Company Name]'] })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ orgName: 'Demo Org, Inc.', entities: ['Demo UK Ltd', 'Demo GmbH'] })
    expect((await entities({ name: 'Demo Labs LLC' }, ['ADMIN'], 'POST')).json().entities).toEqual(['Demo UK Ltd', 'Demo GmbH', 'Demo Labs LLC'])
    expect((await entities({ entities: [] }, ['LEGAL_COUNSEL'])).statusCode).toBe(403)
    // The org's settings form can't write the list around its checks.
    await app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: admin(), payload: { settings: { ourEntities: ['Anything'] } } })
    expect((await app.inject({ method: 'GET', url: '/api/v1/organization/entities', headers: admin() })).json().entities).toEqual(['Demo UK Ltd', 'Demo GmbH', 'Demo Labs LLC'])
  })

  it('go to the extraction with the org’s name', async () => {
    const id = await makeContract(org, owner, { title: 'Upload.pdf', type: 'MSA' })
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: 'AGREEMENT between Demo UK Ltd and Initech LLC.' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
    let body: Record<string, unknown> | null = null
    const run: ReviewRun = { contract: { analysisStatus: 'DONE', counterpartyName: 'Initech LLC' }, version: {}, failed: false }
    const deps: ExtractionDeps = {
      async review(b) { body = b; return new Response(JSON.stringify(run), { status: 200 }) },
      async reviewLegacy() { return new Response('{}') },
      async api(method, path, orgId, payload) {
        const res = await app.inject({ method, url: path, payload: payload as never, headers: { ...internal(), 'x-org-id': orgId } })
        return { status: res.statusCode, text: res.body }
      },
    }
    const job = { data: { contractId: id, versionId: v.id, orgId: org }, attemptsMade: 0, opts: { attempts: 3 }, async updateData() {} }
    expect(await runExtractionJob(job, deps)).toBe('saved')
    expect(body).toMatchObject({ orgName: 'Demo Org, Inc.', ourEntities: ['Demo UK Ltd', 'Demo GmbH', 'Demo Labs LLC'] })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: null } })
  })

  it('a counterparty that is one of them is flagged, with the other parties to choose from', async () => {
    const id = await extracted('Intercompany-ish', 'DEMO UK LIMITED', ['DEMO UK LIMITED', 'Initech LLC'])
    const v = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/counterparty`, headers: admin() })).json()
    expect(v).toMatchObject({ ours: true, others: ['Initech LLC'] })
  })

  it('are put right in one go where the other party is known, as a run a person can undo', async () => {
    const fix = await extracted('Fix me', 'Demo GmbH', ['Demo GmbH', 'Vandelay Industries'], { counterpartyAddress: '1 Unter den Linden, Berlin' })
    const two = await extracted('Two others', 'Demo GmbH', ['Demo GmbH', 'Kramerica', 'Pendant Publishing'])
    const person = await extracted('A person said so', 'Demo Labs LLC', ['Demo Labs LLC', 'Initech LLC'])
    await app.inject({ method: 'PUT', url: `/api/v1/contracts/${person}/fields/counterpartyName`, headers: admin(), payload: { value: 'Demo Labs LLC' } })

    const before = (await app.inject({ method: 'GET', url: '/api/v1/organization/entities', headers: admin() })).json()
    expect(before.namingUs.total).toBeGreaterThanOrEqual(4)

    const r = await app.inject({ method: 'POST', url: '/api/v1/organization/entities/pick-other-party', headers: admin() })
    expect(r.statusCode).toBe(200)
    const out = r.json()
    const leftIds = out.left.map((c: { id: string }) => c.id)
    expect(leftIds).toEqual(expect.arrayContaining([two, person]))
    expect(leftIds).not.toContain(fix)
    const field = (key: string) => prisma.contractFieldValue.findUnique({ where: { contractId_fieldKey: { contractId: fix, fieldKey: key } } })
    expect(await field('counterpartyName')).toMatchObject({ value: 'Vandelay Industries', source: 'ai', quote: 'between Demo GmbH and Vandelay Industries' })
    expect(await field('counterpartyAddress')).toMatchObject({ value: null, issue: expect.stringContaining('one of your companies') })
    expect((await field('counterpartyName'))).toBeTruthy()
    expect((await prisma.contractFieldValue.findUnique({ where: { contractId_fieldKey: { contractId: person, fieldKey: 'counterpartyName' } } }))?.value).toBe('Demo Labs LLC')

    const undo = await app.inject({ method: 'POST', url: `/api/v1/field-runs/${out.runId}/undo`, headers: admin() })
    expect(undo.statusCode).toBe(200)
    expect((await field('counterpartyName'))?.value).toBe('Demo GmbH')
    expect((await field('counterpartyAddress'))?.value).toBe('1 Unter den Linden, Berlin')
  })
})
