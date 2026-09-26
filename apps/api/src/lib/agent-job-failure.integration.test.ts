/**
 * X57 — a failed redline analysis marked the contract's whole analysis FAILED
 * and left the Negotiate panel on "Analyzing redlines…". A follow-on job's
 * failure is now its own: the redline records its failure and reason, and the
 * analysis status stays as it was.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { onAgentJobFailed } from './agent-job-failure.js'
import { makeOrg, makeUser, makeContract, cleanupAll, prisma } from '../test-support/helpers.js'

let org: string, user: string

beforeAll(async () => {
  org = await makeOrg('Agent Job Failure Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
})

const lastAttempt = (name: string, contractId: string) => ({ name, data: { contractId }, attemptsMade: 2, opts: { attempts: 2 } })
const analysed = async (metadata: Record<string, unknown> = {}) => {
  const id = await makeContract(org, user, { title: 'Analysed MSA' })
  await prisma.contract.update({ where: { id }, data: { analysisStatus: 'DONE', metadata: metadata as never } })
  return id
}
const read = (id: string) => prisma.contract.findUniqueOrThrow({ where: { id }, select: { analysisStatus: true, analysisError: true, metadata: true } })

describe('a failed agents job', () => {
  it('a redline analysis records its own failure and reason; the analysis and other metadata are untouched', async () => {
    const id = await analysed({ _redlineStatus: 'ANALYZING', _typeFields: { a: 1 } })
    await onAgentJobFailed(lastAttempt('redline-analysis', id), new Error('Agents /redline returned 503: unavailable'))
    const row = await read(id)
    expect(row.analysisStatus).toBe('DONE')
    expect(row.metadata).toEqual({
      _redlineStatus: 'FAILED',
      _redlineError: 'The redline analysis could not run: Agents /redline returned 503: unavailable',
      _typeFields: { a: 1 },
    })
  })

  it('an approval summary or a playbook pass leaves the analysis as it was', async () => {
    for (const name of ['approval-summary', 'playbook-review', 'playbook-redline']) {
      const id = await analysed()
      await onAgentJobFailed(lastAttempt(name, id), new Error('provider error'))
      expect((await read(id)).analysisStatus, name).toBe('DONE')
    }
  })

  it('an analysis stage still marks the analysis FAILED, with the reason', async () => {
    const id = await analysed()
    await onAgentJobFailed(lastAttempt('extract-ai', id), new Error('Agents /review returned 500'))
    expect(await read(id)).toMatchObject({ analysisStatus: 'FAILED', analysisError: 'Agents /review returned 500' })
  })

  it('nothing changes while a retry is still to come', async () => {
    const id = await analysed({ _redlineStatus: 'ANALYZING' })
    await onAgentJobFailed({ ...lastAttempt('redline-analysis', id), attemptsMade: 1 }, new Error('flaky'))
    expect(await read(id)).toMatchObject({ analysisStatus: 'DONE', metadata: { _redlineStatus: 'ANALYZING' } })
  })
})
