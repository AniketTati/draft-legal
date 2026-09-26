/**
 * DD8 — two steps of the background workers, reached without starting a
 * worker (which would take jobs off the Redis queue the dev API shares):
 *   - the refresh after an edit (DD5): a version a later save replaced is
 *     not re-indexed or re-embedded, though the delayed review is still
 *     asked for;
 *   - the playbook redline's count of clauses left unchecked (DD5): a long
 *     clause's sub-chunk windows are not clauses.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

vi.mock('./queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  queueEmbedContract: vi.fn(),
  queuePlaybookReviewSoon: vi.fn(),
}))
vi.mock('./elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./elasticsearch.js')>()),
  reindexContract: vi.fn(async () => {}),
}))
vi.mock('./legal-chunker.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./legal-chunker.js')>()),
  legalChunkAndStore: vi.fn(async () => {}),
}))

import { makeOrg, makeUser, makeContract, cleanupAll, prisma } from '../test-support/helpers.js'
import { refreshVersion } from './version-refresh.js'
import { uncheckedClauses } from './playbook-redline-targets.js'
import { queueEmbedContract, queuePlaybookReviewSoon } from './queue.js'
import { reindexContract } from './elasticsearch.js'
import { legalChunkAndStore } from './legal-chunker.js'

let org: string, user: string, contractId: string, v1: string, v2: string

beforeAll(async () => {
  org = await makeOrg('DD8 Worker Steps Org')
  user = await makeUser(org)
  contractId = await makeContract(org, user)
  v1 = (await prisma.contractVersion.create({ data: { contractId, versionNumber: 1, createdById: user, plainText: 'Fees are due in 30 days.' } })).id
  v2 = (await prisma.contractVersion.create({ data: { contractId, versionNumber: 2, createdById: user, plainText: 'Fees are due in 45 days.' } })).id
  await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: v2 } })
  await prisma.contractClause.createMany({
    data: [
      { versionId: v1, clauseType: 'payment', content: 'Fees are due in 30 days.', sortOrder: 0 },
      { versionId: v2, clauseType: 'payment', content: 'Fees are due in 45 days.', sortOrder: 0 },
      // A long clause: its first window, and two more windows of it.
      { versionId: v2, clauseType: 'liability', content: 'Window one.', sortOrder: 1 },
      { versionId: v2, clauseType: 'liability', content: 'Window two.', sortOrder: 1, isSubChunk: true, windowIndex: 1 },
      { versionId: v2, clauseType: 'liability', content: 'Window three.', sortOrder: 1, isSubChunk: true, windowIndex: 2 },
    ],
  })
})

beforeEach(() => vi.clearAllMocks())
afterAll(async () => { await cleanupAll() })

describe('the refresh after an edit', () => {
  it('leaves a version a later save replaced, but still asks for the review', async () => {
    await refreshVersion({ contractId, versionId: v1, orgId: org, fromVersionId: null, review: true })
    expect(vi.mocked(reindexContract)).not.toHaveBeenCalled()
    expect(vi.mocked(legalChunkAndStore)).not.toHaveBeenCalled()
    expect(vi.mocked(queueEmbedContract)).not.toHaveBeenCalled()
    expect(vi.mocked(queuePlaybookReviewSoon)).toHaveBeenCalledWith({ contractId, orgId: org })
  })

  it('indexes, windows and embeds the version the contract stands on', async () => {
    await refreshVersion({ contractId, versionId: v2, orgId: org, fromVersionId: v1, review: false })
    expect(vi.mocked(reindexContract)).toHaveBeenCalledWith(contractId)
    const [, , , clauses] = vi.mocked(legalChunkAndStore).mock.calls[0]
    expect(clauses.map(c => c.content)).toEqual(['Fees are due in 45 days.', 'Window one.'])
    expect(vi.mocked(queueEmbedContract)).toHaveBeenCalledWith(v2)
    expect(vi.mocked(queuePlaybookReviewSoon)).not.toHaveBeenCalled()
  })
})

describe('the redline\'s clauses left unchecked', () => {
  it('counts clauses, not their windows', async () => {
    // Two clauses, one of them read by the review: one left, not three.
    expect(await uncheckedClauses(v2, { versionId: v2, clausesReviewed: 1 }, 99)).toBe(1)
  })

  it('takes the check\'s count when the review was of another version', async () => {
    expect(await uncheckedClauses(v2, { versionId: v1, clausesReviewed: 1 }, 4)).toBe(4)
  })
})
