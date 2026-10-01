/**
 * docs/41 P1 — GET /contracts/:id/review and the finding actions, on a real
 * database: the golden cases end to end (a template draft unchanged, a
 * deletion, junk typed in and analysed incrementally), who may accept a
 * finding, the fixes making new versions, and another org seeing none of it.
 * The model is never called: the redline proposal is faked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const queued = vi.hoisted(() => [] as Array<{ name: string; data: Record<string, unknown> }>)
vi.mock('../lib/queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/queue.js')>()
  const rec = (name: string) => vi.fn((data: Record<string, unknown>) => { queued.push({ name, data }) })
  return {
    ...real,
    queueEmbedContract: vi.fn(),
    queueNotification: vi.fn(),
    queueRefreshVersion: rec('refresh-version'),
    queuePlaybookReview: rec('playbook-review'),
    queuePlaybookRedline: rec('playbook-redline'),
    queueExtractAi: rec('extract-ai'),
    queueClassifyDocument: rec('classify-document'),
    agentQueue: { getJob: async () => undefined, add: async () => undefined },
  }
})
vi.mock('../lib/clause-propose.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/clause-propose.js')>()),
  proposeClauseAlternatives: vi.fn(async ({ clauseId }: { clauseId: string }) => {
    const { prisma } = await import('../lib/prisma.js')
    const c = await prisma.contractClause.findUniqueOrThrow({ where: { id: clauseId } })
    return {
      ok: true,
      data: {
        contract: { id: 'x', title: 'x', type: 'NDA' },
        clause: { id: c.id, clauseType: c.clauseType, sectionRef: null, originalText: c.content },
        category: null, hasPlaybook: true,
        variants: [{ aggression: 'moderate', proposedText: 'The obligations of confidentiality last five years.', rationale: 'Your preferred position is five years.', changes: [] }],
      },
    }
  }),
}))

import type { TemplateSection } from '@prisma/client'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, grantRole, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { finishAnalysis, runCheckpointAnalysis } from '../lib/analysis-trigger.js'
import { afterAnalysis } from '../lib/presence-rules.js'
import { generateDocument } from '../lib/template-engine.js'
import { htmlToText } from '../lib/html-text.js'

let app: TestApp
let org: string, other: string, owner: string, counsel: string, manager: string
let playbookId: string

const CONF = 'The Recipient shall hold the Confidential Information in strict confidence, shall use it only for the Purpose, and shall not disclose it to any third party without the prior written consent of the Discloser.'
const GOV = 'This Agreement is governed by the laws of the State of New York, without regard to its conflict-of-laws principles.'
const TERM = 'This Agreement continues for two years from the Effective Date unless terminated earlier by either party on thirty days written notice.'
const MISC = 'This Agreement is the entire agreement between the parties about its subject and replaces all earlier discussions.'

const as = (o = org, roles = ['ADMIN'], sub = owner) => auth(o, roles, sub)
const getReview = (id: string, o = org) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/review`, headers: as(o) })
const post = (url: string, payload: object = {}, headers = as()) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload })

async function version(id: string, n: number, html: string, clauses: Array<[string, string]>) {
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: n, createdById: owner, htmlContent: html, plainText: htmlToText(html) } })
  for (const [i, [clauseType, content]] of clauses.entries()) await prisma.contractClause.create({ data: { versionId: v.id, clauseType, content, sortOrder: i } })
  return v
}
const html = (cs: Array<[string, string]>) => cs.map(c => `<p>${c[1]}</p>`).join('\n')

async function analysed(id: string, v: { id: string }, clauses: number) {
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'INDEXING', riskScore: 0.1 } })
  await finishAnalysis(id, v.id, clauses)
  await afterAnalysis(id, v.id)
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Review Org')
  other = await makeOrg('Review Other Org')
  owner = await makeUser(org)
  counsel = await makeUser(org)
  manager = await makeUser(org)
  await grantRole(org, counsel, 'LEGAL_COUNSEL')
  await grantRole(org, manager, 'CONTRACT_MANAGER')
  await prisma.clauseCategory.createMany({
    data: [
      { id: `${org}-conf`, orgId: org, name: 'Confidentiality', presence: 'required', presenceContractTypes: ['NDA'] },
      { id: `${org}-gov`, orgId: org, name: 'Governing Law', presence: 'required', presenceContractTypes: ['NDA'] },
      { id: `${org}-term`, orgId: org, name: 'Term & Termination', presence: 'required', presenceContractTypes: ['NDA'] },
    ],
  })
  playbookId = (await prisma.playbook.create({ data: { orgId: org, name: 'Default playbook', isDefaultForType: true } })).id
  await prisma.playbookPosition.createMany({
    data: [
      { orgId: org, playbookId, clauseCategoryId: `${org}-gov`, positionType: 'preferred', content: '<p>This Agreement is governed by the laws of the State of New York.</p>', createdById: owner },
      { orgId: org, playbookId, clauseCategoryId: `${org}-conf`, positionType: 'preferred', content: '<p>The obligations of confidentiality last five years.</p>', createdById: owner },
    ],
  })
})

afterAll(async () => {
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } }).catch(() => {})
  await cleanupAll()
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } }).catch(() => {})
  await closeApp()
})

describe('golden: a template draft left unchanged', () => {
  it('is all Standard, from the template by name, with nothing to check and Ready', async () => {
    const template = await prisma.template.create({ data: { orgId: org, name: 'Mutual NDA', contractType: 'NDA', version: 3, createdById: owner } })
    const sections = await Promise.all([
      ['1. Confidentiality', `<p>${CONF.replace('the Purpose', '{{purpose}}')}</p>`],
      ['2. Term', `<p>${TERM}</p>`],
      ['3. Governing Law', `<p>${GOV}</p>`],
    ].map(([title, content], i) => prisma.templateSection.create({ data: { templateId: template.id, title, content, sortOrder: i } })))
    const generated = generateDocument({ template: { ...template, sections: sections as TemplateSection[] }, variables: { purpose: 'evaluating a partnership' } })
    const id = await makeContract(org, owner, { title: 'NDA from template', type: 'NDA' })
    const v1 = await version(id, 1, generated.html, [['confidentiality', CONF.replace('the Purpose', 'evaluating a partnership')], ['termination', TERM], ['governing_law', GOV]])
    await analysed(id, v1, 3)

    const res = await getReview(id)
    expect(res.statusCode).toBe(200)
    const r = res.json()
    expect(r.recommendation).toMatchObject({ label: 'ready_to_approve', text: 'Ready to approve' })
    expect(r.counts).toMatchObject({ needsAttention: 0, notDetected: 0, standard: 3 })
    expect(r.clauses.map((c: { reviewStatus: string; label: string }) => `${c.reviewStatus}:${c.label}`)).toEqual(['standard:Standard', 'standard:Standard', 'standard:Standard'])
    expect(r.clauses[0].definition).toContain('From template Mutual NDA v3, unchanged.')
    expect(r.playbook).toMatchObject({ name: 'Default playbook', why: 'default_for_type' })
    const clauses = await prisma.contractClause.findMany({ where: { versionId: v1.id } })
    expect(clauses.every(c => c.provenance === 'template' && c.sourceRef?.startsWith(`template:${template.id}:3:`))).toBe(true)
    // Nowhere in what the panel shows is "market".
    expect(JSON.stringify(r).toLowerCase()).not.toContain('market')
  })
})

describe('golden: Governing Law deleted, and the fixes', () => {
  let id: string
  let findingId: string

  it('says "deleted since v1 (required)" with the words, and the recommendation is Review', async () => {
    id = await makeContract(org, owner, { title: 'NDA — Acme', type: 'NDA' })
    const v1 = await version(id, 1, html([['c', CONF], ['t', TERM], ['g', GOV]]), [['confidentiality', CONF], ['termination', TERM], ['governing_law', GOV]])
    await analysed(id, v1, 3)
    const v2 = await version(id, 2, html([['c', CONF], ['t', TERM]]), [['confidentiality', CONF], ['termination', TERM]])
    await analysed(id, v2, 2)

    const r = (await getReview(id)).json()
    expect(r.baseline).toMatchObject({ versionNumber: 1, reason: 'analysed' })
    expect(r.recommendation.label).toBe('review')
    const f = r.groups.needsAttention[0]
    expect(f).toMatchObject({ kind: 'deleted', title: 'Governing Law — deleted since v1 (required)', label: 'Deleted since v1', reviewStatus: 'deleted' })
    expect(f.evidence.baselineQuote).toBe(GOV)
    expect(f.actions).toEqual(['insert_standard', 'accept', 'resolve'])
    expect(r.recommendation.reasons[0].findingIds).toEqual([f.id])
    findingId = f.id
  })

  it('accepting needs the right to change the playbook, and is audited', async () => {
    const asManager = await post(`/contracts/${id}/findings/${findingId}/accept`, { note: 'fine' }, as(org, ['CONTRACT_MANAGER'], manager))
    expect(asManager.statusCode).toBe(403)
    const accepted = await post(`/contracts/${id}/findings/${findingId}/accept`, { note: 'New York law is set in the master agreement.' }, as(org, ['LEGAL_COUNSEL'], counsel))
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({ status: 'accepted', resolutionNote: 'New York law is set in the master agreement.' })
    const audit = await prisma.auditEvent.findFirst({ where: { orgId: org, resourceId: id, action: 'REVIEW_FINDING_DECIDED' } })
    expect(audit?.metadata).toMatchObject({ findingId, decision: 'accepted', kind: 'deleted' })
    const r = (await getReview(id)).json()
    expect(r.groups.accepted.map((f: { id: string }) => f.id)).toContain(findingId)
    expect(r.recommendation.label).toBe('ready_to_approve')
    // Twice: no.
    expect((await post(`/contracts/${id}/findings/${findingId}/accept`, {}, as(org, ['LEGAL_COUNSEL'], counsel))).statusCode).toBe(409)
    // Reopened: back to Review.
    expect((await post(`/contracts/${id}/findings/${findingId}/reopen`)).statusCode).toBe(200)
    expect((await getReview(id)).json().recommendation.label).toBe('review')
  })

  it('"Insert standard language" puts your preferred wording in as a new version', async () => {
    const res = await post(`/contracts/${id}/findings/${findingId}/insert-standard`)
    expect(res.statusCode).toBe(201)
    const v3 = await prisma.contractVersion.findUniqueOrThrow({ where: { id: res.json().versionId } })
    expect(v3.versionNumber).toBe(3)
    expect(v3.changeNote).toBe('Added your standard Governing Law language')
    expect(v3.plainText).toContain('governed by the laws of the State of New York.')
    expect((await prisma.reviewFinding.findUniqueOrThrow({ where: { id: findingId } })).status).toBe('resolved')
  })
})

describe('golden: junk typed into a clause, analysed incrementally', () => {
  it('only the change is read again: unreadable text and a changed clause, one clause to the position check', async () => {
    const id = await makeContract(org, owner, { title: 'NDA — junk', type: 'NDA' })
    const clauses: Array<[string, string]> = [['confidentiality', CONF], ['termination', TERM], ['governing_law', GOV], ['general', MISC]]
    const v1 = await version(id, 1, html(clauses), clauses)
    await analysed(id, v1, 4)
    // An editor save: the same words but junk in the last clause, no clauses of its own yet.
    const junk = `${MISC} asdkjh qwpoeiru zxmcnvb lkjasd.`
    const v2html = html([...clauses.slice(0, 3), ['general', junk]])
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: owner, htmlContent: v2html, plainText: htmlToText(v2html) } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
    queued.length = 0

    expect(await runCheckpointAnalysis({ contractId: id, orgId: org })).toBe('incremental')
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { contractId: id, versionId: v2.id } })
    expect(run).toMatchObject({ mode: 'incremental', reason: 'checkpoint', status: 'done' })
    expect((run.steps as Array<{ name: string }>).map(s => s.name)).toEqual(['carry', 'index', 'findings'])
    expect(queued).toContainEqual({ name: 'playbook-review', data: { contractId: id, orgId: org, versionId: v2.id } })
    expect(queued.find(q => q.name === 'extract-ai')).toBeUndefined()

    const r = (await getReview(id)).json()
    expect(r.analysis.kind).toBe('done')
    const kinds = r.groups.needsAttention.map((f: { kind: string }) => f.kind)
    expect(kinds).toContain('unreadable_text')
    expect(kinds).toContain('modified')
    expect(r.groups.needsAttention.find((f: { kind: string }) => f.kind === 'unreadable_text').evidence.quote).toBe('asdkjh qwpoeiru zxmcnvb lkjasd')
    expect(r.recommendation.label).toBe('review')
    // The clauses your playbook covers are unchanged since v1 (Term has no position: not covered).
    expect(r.clauses.filter((c: { reviewStatus: string }) => c.reviewStatus === 'unchanged')).toHaveLength(2)
  })
})

describe('golden: never analysed', () => {
  it("Can't recommend, and no findings made up", async () => {
    const id = await makeContract(org, owner, { title: 'Unread NDA', type: 'NDA' })
    const v = await version(id, 1, html([['c', CONF]]), [])
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'NOT_ANALYSED' } })
    const r = (await getReview(id)).json()
    expect(r.recommendation).toMatchObject({ label: 'cant_recommend', text: "Can't recommend" })
    expect(r.recommendation.reasons[0].text).toBe('this contract has not been analysed')
    expect(r.counts.needsAttention + r.counts.notDetected).toBe(0)
  })
})

describe('not detected, tagged', () => {
  it('tagging the clause where it is resolves "not detected"', async () => {
    const id = await makeContract(org, owner, { title: 'NDA — law under Misc', type: 'NDA' })
    const text = `${MISC} ${GOV}`
    const v1 = await version(id, 1, html([['c', CONF], ['t', TERM], ['m', text]]), [['confidentiality', CONF], ['termination', TERM], ['general', text]])
    await analysed(id, v1, 3)
    let r = (await getReview(id)).json()
    const missing = r.groups.notDetected[0]
    expect(missing).toMatchObject({ kind: 'missing_required', title: 'Governing Law — not detected', label: 'Not detected', actions: ['tag_clause', 'insert_standard', 'resolve'] })
    expect((await post(`/contracts/${id}/findings/${missing.id}/accept`, {}, as(org, ['LEGAL_COUNSEL'], counsel))).statusCode).toBe(409)
    const tagged = await post(`/contracts/${id}/findings/${missing.id}/tag`, { text: GOV })
    expect(tagged.statusCode).toBe(200)
    expect(tagged.json().clause.clauseType).toBe('governing_law')
    r = (await getReview(id)).json()
    expect(r.groups.notDetected).toEqual([])
  })
})

describe('redline to your position', () => {
  it('stages a rewrite for one finding, and applying it makes a version and resolves the finding', async () => {
    const id = await makeContract(org, owner, { title: 'NDA — short term', type: 'NDA' })
    const v1 = await version(id, 1, html([['c', CONF], ['t', TERM], ['g', GOV]]), [['confidentiality', CONF], ['termination', TERM], ['governing_law', GOV]])
    await analysed(id, v1, 3)
    const edited = `${CONF} These obligations last one year.`
    const v2 = await version(id, 2, html([['c', edited], ['t', TERM], ['g', GOV]]), [['confidentiality', edited], ['termination', TERM], ['governing_law', GOV]])
    await analysed(id, v2, 3)
    const f = (await getReview(id)).json().groups.needsAttention.find((x: { kind: string }) => x.kind === 'modified')
    expect(f.actions).toContain('redline')

    // Nothing staged: nothing applied.
    expect((await post(`/contracts/${id}/findings/${f.id}/redline/apply`)).statusCode).toBe(409)
    const staged = await post(`/contracts/${id}/findings/${f.id}/redline`)
    expect(staged.statusCode).toBe(200)
    expect(staged.json()).toMatchObject({ proposedText: 'The obligations of confidentiality last five years.', originalText: edited })
    const applied = await post(`/contracts/${id}/findings/${f.id}/redline/apply`)
    expect(applied.statusCode).toBe(201)
    expect(applied.json().newVersionNumber).toBe(3)
    expect((await prisma.reviewFinding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe('resolved')
  })

  it('"Fix all fixable" stages one batch for the findings it can fix', async () => {
    const id = await makeContract(org, owner, { title: 'NDA — fix all', type: 'NDA' })
    const v1 = await version(id, 1, html([['c', CONF], ['t', TERM], ['g', GOV]]), [['confidentiality', CONF], ['termination', TERM], ['governing_law', GOV]])
    await analysed(id, v1, 3)
    const edited = `${CONF} These obligations last one year.`
    const v2 = await version(id, 2, html([['c', edited], ['t', TERM], ['g', GOV]]), [['confidentiality', edited], ['termination', TERM], ['governing_law', GOV]])
    await analysed(id, v2, 3)
    queued.length = 0
    const res = await post(`/contracts/${id}/review/fix-all`)
    expect(res.statusCode).toBe(202)
    const job = queued.find(q => q.name === 'playbook-redline')!
    const conf = await prisma.contractClause.findFirstOrThrow({ where: { versionId: v2.id, clauseType: 'confidentiality' } })
    expect(job.data).toMatchObject({ contractId: id, versionId: v2.id, aggression: 'moderate', targets: { clauseIds: [conf.id] } })
    expect((job.data.targets as { hints: Record<string, { category: string }> }).hints[conf.id].category).toBe('Confidentiality')
  })
})

describe('tenant isolation', () => {
  it('another org can read and change none of it', async () => {
    const id = await makeContract(org, owner, { title: 'NDA — private', type: 'NDA' })
    const v1 = await version(id, 1, html([['c', CONF], ['t', TERM]]), [['confidentiality', CONF], ['termination', TERM]])
    await analysed(id, v1, 2)
    const f = (await getReview(id)).json().groups.notDetected[0]
    const theirs = as(other, ['ADMIN'], undefined as unknown as string)
    expect((await getReview(id, other)).statusCode).toBe(404)
    for (const path of ['accept', 'resolve', 'reopen', 'tag', 'insert-standard', 'redline', 'redline/apply']) {
      const res = await post(`/contracts/${id}/findings/${f.id}/${path}`, path === 'tag' ? { text: CONF } : {}, theirs)
      expect([403, 404]).toContain(res.statusCode)
    }
    expect((await post(`/contracts/${id}/review/fix-all`, {}, theirs)).statusCode).toBe(404)
    expect((await prisma.reviewFinding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe('open')
  })
})
