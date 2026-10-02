/**
 * docs/41 Part 15 — a counterparty's version against the database: its
 * findings worked out (A), then the redline agent's advice on each change
 * kept on its finding (the agents service mocked: no model), once per
 * (version, baseline); the job queued for counterparty versions only; and
 * the status banner's counts with "Review changes".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const agents = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: Record<string, unknown> }> }))
vi.mock('./agents-call.js', () => ({
  callAgents: vi.fn(async (path: string, init: RequestInit) => {
    agents.calls.push({ path, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({
      changes: [{
        changeId: 'change_001', clauseType: 'limitation_of_liability',
        ourText: 'The liability of each party is capped at the fees paid in the twelve months before the claim.',
        theirText: 'The liability of each party is unlimited for any claim of any kind.',
        recommendation: 'reject', reasoning: 'Unlimited liability is outside your playbook.', severity: 'high',
        counterText: 'Liability is capped at twice the fees paid.', counterNote: 'Meets them partway.',
      }],
      summary: 'Analyzed 1 changes', error: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }),
}))

import { computeAndStoreFindings } from './review-findings.js'
import { changeAdviceStep, queueChangeAdviceStep } from './change-advice.js'
import { agentQueue } from './queue.js'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Change Advice Org')
  user = await makeUser(org)
})

afterAll(async () => {
  const contracts = await prisma.contract.findMany({ where: { orgId: org }, select: { id: true } })
  for (const c of contracts) await agentQueue.getJobs(['waiting', 'delayed', 'prioritized']).then(js => Promise.all(js.filter(j => j.data?.contractId === c.id).map(j => j.remove()))).catch(() => {})
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

const CAP = 'The liability of each party is capped at the fees paid in the twelve months before the claim.'
const UNLIMITED = 'The liability of each party is unlimited for any claim of any kind.'

/** v1 ours (analysed), v2 the counterparty's with the cap removed, standing on v2. */
async function counterpartySent(createdById = 'portal:link1') {
  const id = await makeContract(org, user, { title: 'Supply MSA', status: 'IN_NEGOTIATION' })
  await prisma.contract.update({ where: { id }, data: { stage: 'negotiate', stageState: 'with_us', turn: 'internal' } })
  const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, htmlContent: `<p>${CAP}</p>`, plainText: CAP, createdById: user } })
  await prisma.contractClause.create({ data: { versionId: v1.id, clauseType: 'limitation_of_liability', content: CAP, sortOrder: 0 } })
  const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, htmlContent: `<p>${UNLIMITED}</p>`, plainText: UNLIMITED, createdById } })
  await prisma.contractClause.create({ data: { versionId: v2.id, clauseType: 'limitation_of_liability', content: UNLIMITED, sortOrder: 0 } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })
  await computeAndStoreFindings(id, v1.id)
  await computeAndStoreFindings(id, v2.id)
  return { id, v1: v1.id, v2: v2.id }
}

describe('advice on a counterparty version\'s changes', () => {
  it('keeps the agent\'s advice on the change finding, keyed by the baseline, once', async () => {
    const c = await counterpartySent()
    agents.calls.length = 0
    const out = await changeAdviceStep(c.id, c.v2)
    expect(out.counts).toEqual({ changes: 1, advised: 1 })
    expect(agents.calls).toHaveLength(1)
    expect(agents.calls[0].path).toBe('/redline/score')
    expect(String(agents.calls[0].body.diffHtml)).toMatch(/<ins[^>]*>[^<]*unlimited/)

    const finding = await prisma.reviewFinding.findFirstOrThrow({ where: { versionId: c.v2, kind: { in: ['modified', 'material_cut'] } } })
    expect(finding.advice).toMatchObject({ recommendation: 'reject', reasoning: 'Unlimited liability is outside your playbook.', counterText: 'Liability is capped at twice the fees paid.', baselineVersionId: c.v1 })
    const v2 = await prisma.contractVersion.findUniqueOrThrow({ where: { id: c.v2 }, select: { metadata: true } })
    expect((v2.metadata as { _changeAdvice?: unknown })._changeAdvice).toMatchObject({ baselineVersionId: c.v1, changes: 1, advised: 1 })

    // The same pair again: nothing to do. A recompute keeps the advice.
    expect((await changeAdviceStep(c.id, c.v2)).skipped).toMatch(/already advised/)
    expect(agents.calls).toHaveLength(1)
    await computeAndStoreFindings(c.id, c.v2)
    const again = await prisma.reviewFinding.findFirstOrThrow({ where: { id: finding.id } })
    expect(again.advice).toMatchObject({ recommendation: 'reject' })
  })

  it('is for the counterparty\'s versions only: ours are not scored or queued', async () => {
    const c = await counterpartySent(user)
    expect((await changeAdviceStep(c.id, c.v2)).skipped).toBe('not a counterparty version')
    await queueChangeAdviceStep(c.id, c.v2)
    expect(await agentQueue.getJob(`change-advice-${c.id}-${c.v2}`)).toBeUndefined()

    const theirs = await counterpartySent()
    await queueChangeAdviceStep(theirs.id, theirs.v2)
    const job = await agentQueue.getJob(`change-advice-${theirs.id}-${theirs.v2}`)
    expect(job?.name).toBe('change-advice')
    await job?.remove()
  })

  it('shows on the banner as the version, its changes and what needs attention, with Review changes', async () => {
    const c = await counterpartySent()
    await changeAdviceStep(c.id, c.v2)
    const r = await app.inject({ method: 'GET', url: `/api/v1/contracts/${c.id}/stage`, headers: auth(org, ['LEGAL_OPS'], user) })
    expect(r.statusCode).toBe(200)
    const s = r.json()
    expect(s.next).toMatchObject({ kind: 'review_changes', label: 'Review changes' })
    expect(s.counterparty).toMatchObject({ versionNumber: 2, advised: true })
    expect(s.counterparty.changes).toBeGreaterThanOrEqual(1)
    expect(s.counterparty.needAttention).toBeGreaterThanOrEqual(1)

    const review = await app.inject({ method: 'GET', url: `/api/v1/contracts/${c.id}/review`, headers: auth(org, ['LEGAL_OPS'], user) })
    const advised = [...review.json().groups.needsAttention].find((f: { advice?: unknown }) => f.advice)
    expect(advised?.advice).toMatchObject({ recommendation: 'reject' })
  })
})
