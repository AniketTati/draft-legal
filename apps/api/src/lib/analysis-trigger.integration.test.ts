/**
 * docs/41 P0.1 — every version a person relies on is analysed, and the
 * contract says truthfully what its analysis describes.
 *
 * The queues are faked (what was queued is what's checked); Prisma and the
 * routes are real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const { queued, delayed } = vi.hoisted(() => ({
  queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
  delayed: new Map<string, { name: string; data: Record<string, unknown>; delay?: number }>(),
}))
vi.mock('./queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./queue.js')>()
  const rec = (name: string) => vi.fn((data: Record<string, unknown>) => { queued.push({ name, data }) })
  return {
    ...real,
    queueDraftContract: rec('draft-contract'),
    queueExtractAi: rec('extract-ai'),
    queueClassifyDocument: rec('classify-document'),
    queueParseDocument: rec('parse-document'),
    queueRefreshVersion: rec('refresh-version'),
    queuePlaybookReview: rec('playbook-review'),
    queueEmbedContract: vi.fn(),
    agentQueue: {
      getJob: async (id: string) => {
        const j = delayed.get(id)
        return j ? { remove: async () => { delayed.delete(id) } } : undefined
      },
      add: async (name: string, data: Record<string, unknown>, opts: { jobId: string; delay?: number }) => {
        delayed.set(opts.jobId, { name, data, delay: opts.delay })
      },
    },
  }
})

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { saveDraftVersion } from './draft-save.js'
import { finishAnalysis, scheduleCheckpointAnalysis, runCheckpointAnalysis, checkpointJobId, NO_CLAUSES_ERROR, onVersionCreated } from './analysis-trigger.js'
import { analysisState } from '@clm/types'

let app: TestApp
let org: string, user: string, templateId: string

const NDA_HTML = `<div class="generated-contract"><section><h2>Confidentiality</h2><p>${'The Recipient shall keep the Confidential Information secret. '.repeat(40)}</p></section>`
  + `<section><h2>Governing Law</h2><p>This Agreement is governed by the laws of <span class="template-variable-unfilled" data-variable="governingLaw" data-key="governingLaw">[[governingLaw]]</span>.</p></section></div>`

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Analysis Trigger Org')
  user = await makeUser(org)
  const t = await prisma.template.create({
    data: { orgId: org, name: 'Mutual NDA', contractType: 'NDA', createdById: user, isPublished: true, variables: [{ key: 'governingLaw', label: 'Governing Law', type: 'enum' }] as never },
  })
  templateId = t.id
})

afterAll(async () => {
  await prisma.template.deleteMany({ where: { orgId: org } })
  await prisma.contractRequest.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

beforeEach(() => { queued.length = 0; delayed.clear() })

describe('a draft from a request', () => {
  it('convert passes the classifier\'s terms to drafting', async () => {
    const r = await prisma.contractRequest.create({
      data: {
        orgId: org, title: 'NDA with Acme', type: 'NDA', description: 'NDA governed by New York law', requestedById: user, status: 'SUBMITTED',
        metadata: { _aiClassification: { contractType: 'NDA', extractedTerms: { governingLaw: 'New York', duration: null, counterparty: 'Acme' } } } as never,
      },
    })
    const res = await app.inject({ method: 'POST', url: `/api/v1/requests/${r.id}/convert`, headers: auth(org, ['ADMIN'], user) })
    expect(res.statusCode).toBe(201)
    const job = queued.find(q => q.name === 'draft-contract')
    expect(job?.data.extractedTerms).toEqual({ governingLaw: 'New York', counterparty: 'Acme' })
    const contract = await prisma.contract.findUniqueOrThrow({ where: { id: res.json().contractId } })
    expect((contract.metadata as { _draftContext?: { extractedTerms?: unknown } })._draftContext?.extractedTerms).toEqual({ governingLaw: 'New York', counterparty: 'Acme' })
  })

  it('the saved draft is current, recorded, and queued for analysis', async () => {
    const id = await makeContract(org, user, { title: 'Request NDA', type: 'NDA' })
    await prisma.contract.update({ where: { id }, data: { analysisStatus: 'DRAFTING' } })
    const saved = await saveDraftVersion({
      contractId: id, orgId: org, userId: user, changeNote: 'AI-generated first draft', source: 'request',
      result: { html: NDA_HTML, usedTemplateId: templateId, usedTemplateName: 'Mutual NDA', variableValues: { governingLaw: null }, missingFields: ['governingLaw'], unfilledVariables: ['governingLaw'], variableSources: { governingLaw: 'unresolved' } },
    })
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(c.currentVersionId).toBe(saved.versionId)
    // Never DONE unread: queued for its analysis, for this version.
    expect(c.analysisStatus).toBe('EXTRACTING')
    expect(queued).toContainEqual({ name: 'extract-ai', data: expect.objectContaining({ contractId: id, versionId: saved.versionId, contractType: 'NDA', typeLocked: true }) })
    const meta = c.metadata as { _template?: { id: string; missingFields: string[]; unfilled: string[]; sources?: Record<string, string> } }
    expect(meta._template).toMatchObject({ id: templateId, missingFields: ['governingLaw'], unfilled: ['governingLaw'], sources: { governingLaw: 'unresolved' } })
    const audit = await prisma.auditEvent.findFirst({ where: { orgId: org, resourceId: id, action: 'CONTRACT_DRAFTED' } })
    expect(audit?.metadata).toMatchObject({ source: 'request', templateId, unfilled: ['governingLaw'] })
  })

  it('a draft added to an existing contract becomes its current version and is analysed', async () => {
    const id = await makeContract(org, user, { title: 'Existing NDA', type: 'NDA' })
    const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: '<p>old</p>', plainText: 'old' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v1.id, analysisStatus: 'DONE' } })
    const saved = await saveDraftVersion({ contractId: id, orgId: org, userId: user, changeNote: 'AI draft', source: 'agent_draft', result: { html: NDA_HTML } })
    expect(saved.versionNumber).toBe(2)
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(c.currentVersionId).toBe(saved.versionId)
    expect(c.analysisStatus).toBe('EXTRACTING')
  })

  it('a version with no text is NOT_ANALYSED, never DONE', async () => {
    const id = await makeContract(org, user, { title: 'Empty', type: 'OTHER' })
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: '', plainText: '' } })
    expect(await onVersionCreated(id, v.id, 'generated')).toBe('not_analysed')
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(c.analysisStatus).toBe('NOT_ANALYSED')
    expect(analysisState(c).kind).toBe('not_analysed')
  })

  it('a blank contract made by POST /contracts is NOT_ANALYSED', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/contracts', headers: auth(org, ['ADMIN'], user), payload: { title: 'Blank', type: 'NDA' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().analysisStatus).toBe('NOT_ANALYSED')
  })
})

describe('finishing an analysis', () => {
  async function versioned(text: string) {
    const id = await makeContract(org, user, { title: 'Finish', type: 'NDA' })
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: `<p>${text}</p>`, plainText: text } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'INDEXING' } })
    return { id, v }
  }

  it('a long document with no clauses fails, saying so', async () => {
    const { id, v } = await versioned('word '.repeat(400))
    expect(await finishAnalysis(id, v.id, 0)).toEqual({ done: false })
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(c.analysisStatus).toBe('FAILED')
    expect(c.analysisError).toBe(NO_CLAUSES_ERROR)
  })

  it('a finished analysis is stamped with its version, and goes stale when the version moves', async () => {
    const { id, v } = await versioned('A short cover note.')
    expect(await finishAnalysis(id, v.id, 3)).toEqual({ done: true })
    let c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(c.analysisStatus).toBe('DONE')
    expect(analysisState(c)).toEqual({ kind: 'done', versionId: v.id, versionNumber: 1, clauses: 3 })
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: user, htmlContent: '<p>edited</p>', plainText: 'edited' } })
    c = await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
    expect(analysisState(c)).toEqual({ kind: 'stale', analysedVersionId: v.id, analysedVersionNumber: 1 })
    // Analysing v2 measures it against v1.
    await finishAnalysis(id, v2.id, 2)
    c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect((c.metadata as { _analysis: { baselineVersionId: string } })._analysis.baselineVersionId).toBe(v.id)
  })
})

describe('edit checkpoints', () => {
  it('one waiting checkpoint per contract: a later save pushes it back', async () => {
    const id = await makeContract(org, user)
    expect(await scheduleCheckpointAnalysis(id, org)).toBe(true)
    expect(await scheduleCheckpointAnalysis(id, org)).toBe(true)
    const jobs = [...delayed.entries()].filter(([k]) => k.startsWith(checkpointJobId(id)))
    expect(jobs).toHaveLength(1)
    expect(jobs[0][1]).toMatchObject({ name: 'analysis-checkpoint', delay: 120_000 })
  })

  it('an edited version is analysed when the checkpoint fires; the same words are not read again', async () => {
    const id = await makeContract(org, user, { type: 'NDA' })
    const text = 'The Recipient shall keep the Confidential Information secret.'
    const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: `<p>${text}</p>`, plainText: text } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v1.id, analysisStatus: 'INDEXING' } })
    await finishAnalysis(id, v1.id, 1)

    // Same words (an undone edit): the stamp moves, nothing is queued.
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: user, htmlContent: `<p>${text}</p>`, plainText: text } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
    expect(await runCheckpointAnalysis({ contractId: id, orgId: org })).toBe('unchanged text')
    expect(queued).toHaveLength(0)

    const v3 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 3, createdById: user, htmlContent: '<p>changed</p>', plainText: `${text} Except as required by law.` } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v3.id } })
    expect(await runCheckpointAnalysis({ contractId: id, orgId: org })).toBe('queued_extract')
    expect(queued).toContainEqual({ name: 'extract-ai', data: expect.objectContaining({ versionId: v3.id, triggeredBy: 'checkpoint' }) })
  })

  it('an editor save schedules the checkpoint', async () => {
    const id = await makeContract(org, user, { type: 'NDA' })
    const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: '<p>one</p>', plainText: 'one' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v1.id } })
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/html-version`, headers: auth(org, ['ADMIN'], user), payload: { htmlContent: '<p>two</p>' } })
    expect(res.statusCode).toBe(201)
    expect(delayed.has(checkpointJobId(id))).toBe(true)
    // The checkpoint's analysis includes the review: none asked for separately.
    expect(queued.find(q => q.name === 'refresh-version')?.data.review).toBe(false)
  })
})
