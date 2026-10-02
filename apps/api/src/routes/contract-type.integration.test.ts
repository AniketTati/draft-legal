/**
 * docs/39 A13 — a contract's type: the AI's reading of the whole contract
 * kept beside the type it was filed as, a person's type settled, and a
 * retype reading only the new type's own fields.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { readTypeFields, clearTypeFieldsMark } from '../lib/type-fields-read.js'
import { onAgentJobFailed } from '../lib/agent-job-failure.js'

let app: TestApp
let org: string, owner: string, contract: string

const internal = () => ({ 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-internal-service': 'agents', 'x-org-id': org })
const admin = () => auth(org, ['ADMIN'], owner)
const meta = async () => (await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).metadata as Record<string, unknown>

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Contract Type Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Cloud Migration', type: 'MSA' })
  const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: owner, plainText: 'STATEMENT OF WORK No. 3 under the Master Services Agreement dated 1 January 2024. Deliverables: a migrated data platform. Project manager: Dana Reyes.' } })
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('the AI’s reading of the whole contract', () => {
  it('is kept beside the type it was filed as, and cleared when a new analysis agrees', async () => {
    await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: internal(), payload: { metadata: { _typeOpinion: { type: 'SOW' } } } })
    expect((await meta())._typeOpinion).toEqual({ type: 'SOW' })
    await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: internal(), payload: { metadata: { _typeOpinion: null } } })
    expect((await meta())._typeOpinion).toBeUndefined()
  })

  it('keeping the type settles it: a person’s type, no opinion left', async () => {
    await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: internal(), payload: { metadata: { _typeOpinion: { type: 'SOW' } } } })
    const keep = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/retype`, headers: admin(), payload: { contractType: 'MSA' } })
    expect(keep.json()).toMatchObject({ status: 'done', contractType: 'MSA' })
    const m = await meta()
    expect(m._typeSource).toBe('person')
    expect(m._typeOpinion).toBeUndefined()
    // Nothing to read again: the analysis is as it was.
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).analysisStatus).toBe('DONE')
  })
})

describe('a retype', () => {
  it('reads only the new type’s own fields — never over a value a person set', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/retype`, headers: admin(), payload: { contractType: 'SOW' } })
    expect(r.json()).toMatchObject({ status: 'queued', contractType: 'SOW', analysisStatus: 'ANALYZING' })
    // A person already knows the project manager.
    await app.inject({ method: 'PUT', url: `/api/v1/contracts/${contract}/fields/project_manager`, headers: admin(), payload: { value: 'Dana Reyes (PMP)' } })

    const asked: string[][] = []
    const out = await readTypeFields({
      contractId: contract, orgId: org, contractType: 'SOW',
      call: async body => {
        asked.push(body.fields.map(f => f.fieldKey))
        return {
          deliverables: { value: 'A migrated data platform', confidence: 0.9, quote: 'Deliverables: a migrated data platform' },
          project_manager: { value: 'Dana Reyes', confidence: 0.9, quote: 'Project manager: Dana Reyes' },
          governing_msa: { value: 'Master Services Agreement dated 1 January 2024', confidence: 0.85, quote: 'under the Master Services Agreement dated 1 January 2024' },
        }
      },
    })
    // Only the SOW's fields were asked for.
    expect(asked[0]).toContain('deliverables')
    expect(asked[0]).not.toContain('governingLaw')
    expect(out?.written).toEqual(expect.arrayContaining(['deliverables', 'governing_msa']))
    const row = (key: string) => prisma.contractFieldValue.findFirst({ where: { contractId: contract, fieldKey: key } })
    expect(await row('deliverables')).toMatchObject({ value: 'A migrated data platform', source: 'ai', kind: 'type' })
    expect(await row('project_manager')).toMatchObject({ value: 'Dana Reyes (PMP)', source: 'user', suggestion: { value: 'Dana Reyes' } })
  })

  it('needs edit rights', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/retype`, headers: auth(org, ['VIEWER'], owner), payload: { contractType: 'NDA' } })).statusCode).toBe(403)
  })

  it('refuses a type that isn’t one', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/retype`, headers: admin(), payload: { contractType: 'SANDWICH' } })
    expect(r.statusCode).toBe(400)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).type).toBe('SOW')
  })

  it('changing values it already had can be undone, as after a re-analysis', async () => {
    await readTypeFields({
      contractId: contract, orgId: org, contractType: 'SOW',
      call: async () => ({ deliverables: { value: 'A data platform, migrated', confidence: 0.9, quote: 'Deliverables: a migrated data platform' } }),
    })
    const run = await prisma.fieldValueRun.findFirst({ where: { contractId: contract, kind: 'reanalysis' }, orderBy: { createdAt: 'desc' } })
    const changes = run?.changes as Array<{ fieldKey: string; before: { value: unknown } | null; after: unknown }>
    expect(changes.find(c => c.fieldKey === 'deliverables')).toMatchObject({ before: { value: 'A migrated data platform' }, after: 'A data platform, migrated' })
    // Named as the panel names it, in the list of what changed.
    const latest = (await app.inject({ method: 'GET', url: `/api/v1/field-runs/contract/${contract}/latest`, headers: admin() })).json().run
    expect(latest.changes.find((c: { fieldKey: string }) => c.fieldKey === 'deliverables')).toMatchObject({ label: 'Deliverables', beforeDisplay: 'A migrated data platform' })
  })

  it('for a type given up since, reads nothing', async () => {
    // Retyped to SOW above; a read still queued for an NDA has nothing to do.
    const out = await readTypeFields({ contractId: contract, orgId: org, contractType: 'NDA', call: async () => { throw new Error('should not be asked') } })
    expect(out).toEqual({ written: [], read: 0 })
  })
})

describe('the read, on the contract', () => {
  let c2: string
  const row = () => prisma.contract.findUniqueOrThrow({ where: { id: c2 } })
  const mark = async () => ((await row()).metadata as Record<string, any>)._typeFieldsRead

  beforeAll(async () => {
    c2 = await makeContract(org, owner, { title: 'Data Platform Build', type: 'NDA' })
    const v = await prisma.contractVersion.create({ data: { contractId: c2, versionNumber: 1, createdById: owner, plainText: 'STATEMENT OF WORK No. 4. Deliverables: a data platform.' } })
    await prisma.contract.update({ where: { id: c2 }, data: { currentVersionId: v.id, analysisStatus: 'DONE' } })
  })

  it('is marked while it runs; a failed read leaves the analysis standing and says why; it can be read again', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${c2}/retype`, headers: admin(), payload: { contractType: 'SOW' } })).json())
      .toMatchObject({ status: 'queued', analysisStatus: 'ANALYZING' })
    expect(await mark()).toMatchObject({ type: 'SOW' })
    expect((await mark()).error).toBeUndefined()

    // Its last attempt fails: the rest of the analysis stands.
    await onAgentJobFailed({ name: 'extract-type-fields', data: { contractId: c2, orgId: org, contractType: 'SOW' }, attemptsMade: 3, opts: { attempts: 3 } }, new Error('provider down'))
    expect(await row()).toMatchObject({ analysisStatus: 'DONE', analysisError: null })
    expect(await mark()).toMatchObject({ type: 'SOW', error: 'provider down' })

    // Try again: the same type, read again.
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${c2}/retype`, headers: admin(), payload: { contractType: 'SOW', reread: true } })).json())
      .toMatchObject({ status: 'queued', analysisStatus: 'ANALYZING' })
    expect(await mark()).toMatchObject({ type: 'SOW' })
    expect((await mark()).error).toBeUndefined()
  })

  it('is cleared by its own read only — a later retype’s read is its own', async () => {
    await clearTypeFieldsMark(c2, 'NDA')
    expect(await mark()).toMatchObject({ type: 'SOW' })
    await clearTypeFieldsMark(c2, 'SOW')
    expect(await mark()).toBeUndefined()
  })

  it('an earlier failure is gone once the type is kept', async () => {
    await onAgentJobFailed({ name: 'extract-type-fields', data: { contractId: c2, orgId: org, contractType: 'SOW' }, attemptsMade: 3, opts: { attempts: 3 } }, new Error('provider down'))
    expect((await mark()).error).toBe('provider down')
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${c2}/retype`, headers: admin(), payload: { contractType: 'SOW' } })
    expect(await mark()).toBeUndefined()
  })
})
