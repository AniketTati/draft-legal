/**
 * C13 — a contract whose parse job was lost must not sit PENDING forever,
 * while a backlog of queued uploads and the many contracts that are PENDING
 * by default (nothing to parse) must never be marked FAILED.
 *
 * Real Postgres and a real Redis queue (CI provides both).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Job } from 'bullmq'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma } from '../test-support/helpers.js'
import { documentQueue } from './queue.js'
import { recoverStuckContracts, LOST_JOB_MESSAGE, PENDING_LOST_THRESHOLD_MS } from './stuck-contracts.js'

let org: string, owner: string
const jobs: Job[] = []

async function upload(title: string, minutesAgo: number, parsed = false) {
  const id = await makeContract(org, owner, { title })
  const v = await prisma.contractVersion.create({
    data: { contractId: id, versionNumber: 1, createdById: owner, s3Key: `${org}/contracts/${id}/file.pdf`, plainText: parsed ? 'text' : '' },
  })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id, analysisStatus: 'PENDING' } })
  await prisma.$executeRaw`UPDATE contracts SET "updatedAt" = NOW() - make_interval(mins => ${minutesAgo}::int) WHERE id = ${id}`
  return id
}

const status = async (id: string) =>
  prisma.contract.findUnique({ where: { id }, select: { analysisStatus: true, analysisError: true } })

beforeAll(async () => {
  await getApp()
  org = await makeOrg('Recovery Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  for (const j of jobs) await j.remove().catch(() => {})
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('stuck-contract recovery', () => {
  it('a PENDING upload whose job was lost becomes FAILED with a retry message', async () => {
    const lost = await upload('Lost upload', 45)
    const res = await recoverStuckContracts()
    expect(res.pendingFailed).toBeGreaterThanOrEqual(1)
    expect(await status(lost)).toEqual({ analysisStatus: 'FAILED', analysisError: LOST_JOB_MESSAGE })
  })

  it('a backlog is safe: an old upload whose job is still queued stays PENDING', async () => {
    const queued = await upload('Queued in a backlog', 180)
    jobs.push(await documentQueue.add('parse-document', {
      contractId: queued, versionId: 'v', s3Key: 'k', mimeType: 'application/pdf', filename: 'f.pdf', orgId: org,
    }, { delay: 60 * 60 * 1000 }))
    await recoverStuckContracts()
    expect((await status(queued))?.analysisStatus).toBe('PENDING')
  })

  it('a recent upload is given time to be enqueued', async () => {
    const fresh = await upload('Just uploaded', 5)
    await recoverStuckContracts({ listQueued: async () => new Set() })
    expect((await status(fresh))?.analysisStatus).toBe('PENDING')
  })

  it('contracts PENDING by default with nothing to parse are never touched', async () => {
    const drafted = await makeContract(org, owner, { title: 'Template draft' })
    const v = await prisma.contractVersion.create({
      data: { contractId: drafted, versionNumber: 1, createdById: owner, htmlContent: '<p>x</p>', plainText: 'x' },
    })
    await prisma.contract.update({ where: { id: drafted }, data: { currentVersionId: v.id } })
    const bare = await makeContract(org, owner, { title: 'Imported row' })
    await prisma.$executeRaw`UPDATE contracts SET "updatedAt" = NOW() - INTERVAL '3 days' WHERE id IN (${drafted}, ${bare})`

    await recoverStuckContracts({ listQueued: async () => new Set() })
    expect((await status(drafted))?.analysisStatus).toBe('PENDING')
    expect((await status(bare))?.analysisStatus).toBe('PENDING')
  })

  it('if the queue cannot be read, PENDING contracts are left alone', async () => {
    const unsure = await upload('Queue down', 90)
    const res = await recoverStuckContracts({ listQueued: async () => { throw new Error('ECONNREFUSED') } })
    expect(res.pendingSkipped).toBe('queue-unavailable')
    expect((await status(unsure))?.analysisStatus).toBe('PENDING')
  })

  it('the in-progress sweep still resets a job that died mid-flight', async () => {
    const crashed = await makeContract(org, owner, { title: 'Crashed mid-parse' })
    await prisma.contract.update({ where: { id: crashed }, data: { analysisStatus: 'PARSING' } })
    await prisma.$executeRaw`UPDATE contracts SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${crashed}`
    await recoverStuckContracts({ listQueued: async () => new Set() })
    expect((await status(crashed))?.analysisStatus).toBe('FAILED')
  })

  it('the threshold is 30 minutes', () => {
    expect(PENDING_LOST_THRESHOLD_MS).toBe(30 * 60 * 1000)
  })
})
