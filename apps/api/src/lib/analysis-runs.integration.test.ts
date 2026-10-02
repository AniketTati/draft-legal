/**
 * docs/41 P1 (Part 11) — every analysis step records itself on its
 * version's run; a failed step says where it stopped, Analysis health lists
 * it by step and retries it, and another org sees none of it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const queued = vi.hoisted(() => ({ review: [] as unknown[], extract: [] as unknown[], compliance: [] as unknown[] }))
vi.mock('./queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  queueEmbedContract: vi.fn(),
  queueNotification: vi.fn(),
  queuePlaybookReview: vi.fn((p: unknown) => { queued.review.push(p) }),
  queueExtractAi: vi.fn((p: unknown) => { queued.extract.push(p) }),
  queueClassifyDocument: vi.fn(),
  queueComplianceReview: vi.fn((p: unknown, o?: unknown) => { queued.compliance.push(o ? { ...(p as object), ...(o as object) } : p) }),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { onVersionCreated, finishAnalysis } from './analysis-trigger.js'
import { afterAnalysis } from './presence-rules.js'
import { runJobStep, latestRun, stepFailed } from './analysis-runs.js'
import { complianceStep } from './version-review-steps.js'

let app: TestApp
let org: string, other: string, owner: string

const TEXT = 'The Recipient shall hold the Confidential Information in strict confidence. '.repeat(30)

async function contractWithVersion(title: string) {
  const id = await makeContract(org, owner, { title, type: 'NDA' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, htmlContent: `<p>${TEXT}</p>`, plainText: TEXT } })
  return { id, v }
}

const job = (name: string, attemptsMade = 0, attempts = 2) => ({ name, attemptsMade, opts: { attempts } })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Analysis Runs Org')
  other = await makeOrg('Analysis Runs Other Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('a run, step by step', () => {
  it('opens on the trigger and records extract, index and findings until done', async () => {
    const { id, v } = await contractWithVersion('Run NDA')
    expect(await onVersionCreated(id, v.id, 'generated')).toBe('queued_extract')
    let run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run).toMatchObject({ orgId: org, versionId: v.id, reason: 'generated', status: 'queued' })

    await runJobStep(job('extract-ai'), { contractId: id, versionId: v.id }, async () => {
      await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'confidentiality', content: TEXT.slice(0, 200) } })
    })
    await runJobStep(job('chunk-and-index'), { contractId: id, versionId: v.id }, async () => {
      await finishAnalysis(id, v.id, 1)
      return { counts: { clauses: 1 }, after: () => afterAnalysis(id, v.id) }
    })
    run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run.status).toBe('done')
    expect(run.finishedAt).not.toBeNull()
    const steps = run.steps as Array<{ name: string; status: string; counts?: Record<string, number> }>
    expect(steps.map(s => `${s.name}:${s.status}`)).toEqual(['extract:done', 'index:done', 'findings:done', 'drafting:done'])
    expect(steps.find(s => s.name === 'index')?.counts).toEqual({ clauses: 1 })

    // The model's position check, after: reopens the run while it runs, closes it after.
    await runJobStep(job('playbook-review'), { contractId: id, versionId: v.id }, async () => ({ skipped: 'no playbook positions' }))
    run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run.status).toBe('done')
    expect((run.steps as Array<{ name: string; status: string }>).find(s => s.name === 'position_check')?.status).toBe('skipped')
  })

  it('a step that throws is retried, then fails the run at that step', async () => {
    const { id, v } = await contractWithVersion('Failing NDA')
    await onVersionCreated(id, v.id, 'uploaded')
    const boom = async () => { throw new Error('the extraction service answered 502') }
    await expect(runJobStep(job('extract-ai', 0, 2), { contractId: id, versionId: v.id }, boom)).rejects.toThrow()
    let run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run.status).toBe('running')
    expect((run.steps as Array<{ status: string }>)[0].status).toBe('retrying')
    await expect(runJobStep(job('extract-ai', 1, 2), { contractId: id, versionId: v.id }, boom)).rejects.toThrow()
    run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run).toMatchObject({ status: 'failed', failedStep: 'extract', error: 'the extraction service answered 502' })
    const view = await latestRun(id)
    expect(view?.failedStepLabel).toBe('reading its fields and clauses')
  })

  it('a document of real length with no clauses fails at the index step, not quietly done', async () => {
    const { id, v } = await contractWithVersion('Empty NDA')
    await onVersionCreated(id, v.id, 'uploaded')
    await runJobStep(job('chunk-and-index'), { contractId: id, versionId: v.id }, async () => {
      const { done } = await finishAnalysis(id, v.id, 0)
      return done ? {} : { failed: 'No clauses found' }
    })
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run).toMatchObject({ status: 'failed', failedStep: 'index' })
  })

  it('a newer version supersedes the open run of the older one', async () => {
    const { id, v } = await contractWithVersion('Moving NDA')
    await onVersionCreated(id, v.id, 'generated')
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: owner, plainText: `${TEXT} More.` } })
    await onVersionCreated(id, v2.id, 'added')
    const runs = await prisma.analysisRun.findMany({ where: { contractId: id }, orderBy: { startedAt: 'asc' } })
    expect(runs.map(r => r.status)).toEqual(['superseded', 'queued'])
  })
})

describe('Analysis health', () => {
  it('lists failed runs by step, retries one, and shows another org nothing', async () => {
    const { id, v } = await contractWithVersion('Health NDA')
    await onVersionCreated(id, v.id, 'generated')
    await runJobStep(job('extract-ai', 0, 1), { contractId: id, versionId: v.id }, async () => { throw new Error('model timed out') }).catch(() => {})

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/analysis/runs?status=failed', headers: auth(org, ['ADMIN'], owner) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const group = body.groups.find((g: { step: string }) => g.step === 'extract')
    expect(group.label).toBe('reading its fields and clauses')
    const row = group.runs.find((r: { contractId: string }) => r.contractId === id)
    expect(row).toMatchObject({ contractTitle: 'Health NDA', versionNumber: 1, error: 'model timed out', current: true })

    // Not an admin: no access. Another org: nothing of this one.
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/analysis/runs', headers: auth(org, ['VIEWER'], owner) })).statusCode).toBe(403)
    const theirs = (await app.inject({ method: 'GET', url: '/api/v1/admin/analysis/runs', headers: auth(other, ['ADMIN']) })).json()
    expect(JSON.stringify(theirs)).not.toContain(id)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/analysis/runs/${row.id}/retry`, headers: auth(other, ['ADMIN']) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/analysis-runs`, headers: auth(other, ['ADMIN']) })).statusCode).toBe(404)

    queued.extract.length = 0
    const retried = await app.inject({ method: 'POST', url: `/api/v1/admin/analysis/runs/${row.id}/retry`, headers: auth(org, ['ADMIN'], owner) })
    expect(retried.statusCode).toBe(202)
    expect(retried.json().retried).toBe('queued_extract')
    expect(queued.extract).toHaveLength(1)
    const runs = (await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/analysis-runs`, headers: auth(org, ['ADMIN'], owner) })).json().data
    expect(runs[0]).toMatchObject({ reason: 'retry', status: 'queued' })
  })

  it('a failed position check is retried alone', async () => {
    const { id, v } = await contractWithVersion('Review NDA')
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
    await onVersionCreated(id, v.id, 'generated')
    await runJobStep(job('chunk-and-index'), { contractId: id, versionId: v.id }, async () => ({ counts: { clauses: 3 }, after: () => afterAnalysis(id, v.id) }))
    await runJobStep(job('playbook-review', 1, 2), { contractId: id, versionId: v.id }, async () => { throw new Error('Agents /playbook-review returned 502') }).catch(() => {})
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run).toMatchObject({ status: 'failed', failedStep: 'position_check' })
    queued.review.length = 0
    const retried = await app.inject({ method: 'POST', url: `/api/v1/admin/analysis/runs/${run.id}/retry`, headers: auth(org, ['ADMIN'], owner) })
    expect(retried.json().retried).toBe('position_check')
    expect(queued.review).toEqual([{ contractId: id, orgId: org, versionId: v.id }])
  })

  it('the compliance step follows the findings as a job, and says why when it could not read the facts (docs/41 Part 9)', async () => {
    const { id, v } = await contractWithVersion('Compliance NDA')
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
    await onVersionCreated(id, v.id, 'generated')
    queued.compliance.length = 0
    await runJobStep(job('chunk-and-index'), { contractId: id, versionId: v.id }, async () => ({ counts: { clauses: 3 }, after: () => afterAnalysis(id, v.id) }))
    expect(queued.compliance).toEqual([{ contractId: id, orgId: org, versionId: v.id }])
    // The agents service is down: the step is skipped with its reason, and the run still ends done.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    try {
      await runJobStep(job('compliance-review', 0, 1), { contractId: id, versionId: v.id }, () => complianceStep(id, v.id))
    } finally {
      fetchSpy.mockRestore()
    }
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run.status).toBe('done')
    const steps = run.steps as Array<{ name: string; status: string; error?: string }>
    expect(steps.map(s => s.name)).toEqual(['index', 'findings', 'drafting', 'compliance'])
    expect(steps.find(s => s.name === 'compliance')).toMatchObject({ status: 'skipped', error: 'the facts could not be read' })
    expect((await latestRun(id))?.steps.find(s => s.name === 'compliance')?.label).toBe('checking the compliance rules that apply')
  })

  it('a failed defined-terms or compliance step is retried alone', async () => {
    const { id, v } = await contractWithVersion('Drafting NDA')
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
    await onVersionCreated(id, v.id, 'generated')
    await runJobStep(job('chunk-and-index'), { contractId: id, versionId: v.id }, async () => ({ counts: { clauses: 3 }, after: () => afterAnalysis(id, v.id) }))
    await stepFailed(id, v.id, 'drafting', 'the checks stopped')
    let run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run).toMatchObject({ status: 'failed', failedStep: 'drafting' })
    const retried = await app.inject({ method: 'POST', url: `/api/v1/admin/analysis/runs/${run.id}/retry`, headers: auth(org, ['ADMIN'], owner) })
    expect(retried.json().retried).toBe('drafting')
    run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id } })
    expect(run).toMatchObject({ status: 'done', failedStep: null })

    await stepFailed(id, v.id, 'compliance', 'the job was lost')
    queued.compliance.length = 0
    const again = await app.inject({ method: 'POST', url: `/api/v1/admin/analysis/runs/${run.id}/retry`, headers: auth(org, ['ADMIN'], owner) })
    expect(again.json().retried).toBe('compliance')
    expect(queued.compliance).toEqual([{ contractId: id, orgId: org, versionId: v.id, again: true }])
  })
})
