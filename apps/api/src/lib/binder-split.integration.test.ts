/**
 * C10 — binder splitting must never duplicate children, and a non-PDF binder
 * must be refused with a clear message instead of failing inside pdf-lib.
 *
 * Object storage is faked (CI runs no MinIO) and child parse jobs are not
 * queued; everything else — Prisma, the split route, pdf-lib — is real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { UnrecoverableError } from 'bullmq'

const { store } = vi.hoisted(() => ({ store: new Map<string, Uint8Array>() }))

vi.mock('./storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage.js')>()),
  s3: {
    send: async (cmd: { constructor: { name: string }; input: { Key: string; Body?: Uint8Array } }) => {
      if (cmd.constructor.name === 'PutObjectCommand') { store.set(cmd.input.Key, cmd.input.Body as Uint8Array); return {} }
      if (cmd.constructor.name === 'GetObjectCommand') {
        const body = store.get(cmd.input.Key)
        if (!body) throw new Error(`NoSuchKey ${cmd.input.Key}`)
        return { Body: (async function* () { yield body })() }
      }
      return {}
    },
  },
}))
vi.mock('./queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  queueParseDocument: vi.fn(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { splitBinder, splitPrefix, SPLIT_REQUIRES_PDF } from './binder-split.js'

let app: TestApp
let org: string, owner: string

async function threePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const t of ['MSA', 'DPA', 'SOW']) doc.addPage().drawText(`${t} agreement`)
  return doc.save()
}

async function binder(title: string, file: Uint8Array, mimeType: string): Promise<string> {
  const id = await makeContract(org, owner, { title, status: 'DRAFT' })
  const key = `${org}/contracts/${id}/original`
  store.set(key, file)
  await prisma.contractVersion.create({
    data: { contractId: id, versionNumber: 1, createdById: owner, s3Key: key, mimeType, htmlContent: 'x', plainText: 'x' },
  })
  return id
}

const liveChildren = (parentId: string) => prisma.contract.findMany({
  where: { parentContractId: parentId, deletedAt: null }, select: { id: true, title: true },
  orderBy: { title: 'asc' },
})

const TWO   = [{ pageStart: 1, pageEnd: 1, title: 'MSA' }, { pageStart: 2, pageEnd: 3, title: 'DPA and SOW' }]
const THREE = [{ pageStart: 1, pageEnd: 1, title: 'MSA' }, { pageStart: 2, pageEnd: 2, title: 'DPA' }, { pageStart: 3, pageEnd: 3, title: 'SOW' }]

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Binder Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null, parentContractId: null, diligenceRoomId: null } })
  await prisma.diligenceRoom.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('binder split', () => {
  it('splits, and a re-split replaces the children instead of duplicating them', async () => {
    const id = await binder('Binder A', await threePagePdf(), 'application/pdf')

    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: TWO })
    expect((await liveChildren(id)).map(c => c.title)).toEqual(['DPA and SOW', 'MSA'])

    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: THREE })
    const after = await liveChildren(id)
    expect(after.map(c => c.title)).toEqual(['DPA', 'MSA', 'SOW'])
    const parent = await prisma.contract.findUnique({ where: { id } })
    expect((parent?.metadata as { _splitInto: string[] })._splitInto.sort()).toEqual(after.map(c => c.id).sort())
    expect(parent?.analysisStatus).toBe('DONE')

    // A retried job (same splits again) is idempotent too.
    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: THREE })
    expect(await liveChildren(id)).toHaveLength(3)
  })

  it('leaves a manually attached exhibit alone', async () => {
    const id = await binder('Binder B', await threePagePdf(), 'application/pdf')
    const manual = await makeContract(org, owner, { title: 'Manual exhibit' })
    await prisma.contract.update({ where: { id: manual }, data: { parentContractId: id, relationshipType: 'exhibit_only' } })
    await prisma.contractVersion.create({
      data: { contractId: manual, versionNumber: 1, createdById: owner, s3Key: `${org}/contracts/${manual}/exhibit.pdf` },
    })

    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: TWO })
    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: THREE })
    expect((await liveChildren(id)).map(c => c.title).sort()).toEqual(['DPA', 'MSA', 'Manual exhibit', 'SOW'].sort())
  })

  it('refuses a re-split that would replace a contract that has moved on', async () => {
    const id = await binder('Binder C', await threePagePdf(), 'application/pdf')
    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: TWO })
    const [first] = await liveChildren(id)
    await prisma.contract.update({ where: { id: first.id }, data: { status: 'UNDER_NEGOTIATION' } })

    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${id}/split`, headers: auth(org, ['ADMIN'], owner),
      payload: { splits: THREE },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().detail).toMatch(/moved on/)

    // The worker holds the same line if the job was queued anyway.
    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: THREE })
    expect(await liveChildren(id)).toHaveLength(2)
    const parent = await prisma.contract.findUnique({ where: { id } })
    expect((parent?.metadata as { _splitError?: string })._splitError).toMatch(/moved on/)
  })

  it('refuses a DOCX binder with the fix, at the route and without worker retries', async () => {
    const docx = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from('not really a pdf')])
    const id = await binder('DOCX binder', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')

    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${id}/split`, headers: auth(org, ['ADMIN'], owner),
      payload: { splits: TWO },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().detail).toBe(SPLIT_REQUIRES_PDF)

    const err = await splitBinder({ contractId: id, orgId: org, userId: owner, splits: TWO }).catch(e => e)
    expect(err).toBeInstanceOf(UnrecoverableError)
    expect(err.message).toBe(SPLIT_REQUIRES_PDF)
    expect(await liveChildren(id)).toHaveLength(0)
  })

  it('a binder in a diligence room splits into documents that stay in the room (C11)', async () => {
    const roomId = (await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Project Heron', createdById: owner } })).id
    const id = await binder('Room binder', await threePagePdf(), 'application/pdf')
    await prisma.contract.update({ where: { id }, data: { diligenceRoomId: roomId } })
    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: TWO })
    const children = await prisma.contract.findMany({ where: { parentContractId: id, deletedAt: null }, select: { diligenceRoomId: true } })
    expect(children).toHaveLength(2)
    expect(children.every(c => c.diligenceRoomId === roomId)).toBe(true)
  })

  it('children live under the binder\'s split prefix', async () => {
    const id = await binder('Binder D', await threePagePdf(), 'application/pdf')
    await splitBinder({ contractId: id, orgId: org, userId: owner, splits: TWO })
    const keys = [...store.keys()].filter(k => k.startsWith(splitPrefix(org, id)))
    expect(keys).toHaveLength(2)
  })
})
