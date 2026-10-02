/**
 * X10 — the agent's write tools checked that the caller's role GRANTS the
 * permission, not its scope. So a custom role with own-scope edit:contract
 * could Apply contract_update / comment_add / approval_route / redline_apply
 * to any contract in the org — including assign_owner to itself, after which
 * the REST own-scope guard (X7) and the signing-token rule (X18) treated it as
 * the owner. No default role has own-scope edit, so this is custom roles only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, repA: string, repB: string, mine: string, theirs: string, thread: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Agent Write Scope Org')
  repA = await makeUser(org)
  repB = await makeUser(org)
  await prisma.role.create({
    data: {
      orgId: org, name: 'OWN_EDITOR',
      permissions: [
        { action: 'view', resource: 'contract', scope: 'own' },
        { action: 'edit', resource: 'contract', scope: 'own' },
      ],
    },
  })
  mine = await makeContract(org, repA, { title: 'A owns this' })
  theirs = await makeContract(org, repB, { title: 'B owns this' })

  // The API calls itself at the base agent-threads.ts derives from the env (PORT or API_URL), so
  // route that same base back into the app rather than assuming :3001.
  const self = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.startsWith(`${self}/api/`)) {
      const res = await app.inject({
        method: (init?.method ?? 'GET') as 'POST',
        url: url.slice(self.length),
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      })
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  })

  const t = await app.inject({ method: 'POST', url: '/api/v1/agent/threads', headers: auth(org, ['OWN_EDITOR'], repA), payload: {} })
  thread = t.json().id
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.toolCall.deleteMany({ where: { thread: { orgId: org } } }).catch(() => {})
  await prisma.contractComment.deleteMany({ where: { orgId: org, parentId: { not: null } } })
  await prisma.contractComment.deleteMany({ where: { orgId: org } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await prisma.templateSection.deleteMany({ where: { template: { orgId: org } } })
  await prisma.template.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

const apply = (roles: string[], user: string, threadId: string, toolName: string, args: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/agent/threads/${threadId}/actions/apply`, headers: auth(org, roles, user), payload: { toolName, args } })

describe('an own-scope editor applies write tools only to its own contracts', () => {
  it('cannot make itself owner of another rep\'s contract', async () => {
    const res = await apply(['OWN_EDITOR'], repA, thread, 'contract_update', { contractId: theirs, action: 'assign_owner', payload: { ownerId: repA } })
    expect(res.statusCode).toBe(404)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: theirs } })).ownerId).toBe(repB)
  })

  it('cannot comment on another rep\'s contract', async () => {
    const res = await apply(['OWN_EDITOR'], repA, thread, 'comment_add', { contractId: theirs, body: 'sneaky' })
    expect(res.statusCode).toBe(404)
    expect(await prisma.contractComment.count({ where: { contractId: theirs } })).toBe(0)
  })

  it('still edits its own contract, and an undo is re-checked against current ownership', async () => {
    const res = await apply(['OWN_EDITOR'], repA, thread, 'contract_update', { contractId: mine, action: 'add_tag', payload: { tag: 'x10' } })
    expect(res.statusCode).toBe(200)
    const toolCallId = res.json().toolCallId ?? res.json().toolCall?.id
    expect(toolCallId).toBeTruthy()
    // Ownership moves on before the undo: the undo is a write on B's contract now.
    await prisma.contract.update({ where: { id: mine }, data: { ownerId: repB } })
    const undo = await app.inject({ method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/${toolCallId}/undo`, headers: auth(org, ['OWN_EDITOR'], repA) })
    expect(undo.statusCode).toBe(404)
    await prisma.contract.update({ where: { id: mine }, data: { ownerId: repA } })
  })

  it('a reply can\'t be filed under another contract\'s comment (any scope)', async () => {
    const theirComment = await prisma.contractComment.create({ data: { orgId: org, contractId: theirs, authorId: repB, body: 'B thread' } })
    const t = await app.inject({ method: 'POST', url: '/api/v1/agent/threads', headers: auth(org, ['LEGAL_OPS'], repB), payload: {} })
    const res = await apply(['LEGAL_OPS'], repB, t.json().id, 'comment_add', { contractId: mine, parentId: theirComment.id, body: 'misfiled' })
    expect(res.statusCode).toBe(404)
    expect(await prisma.contractComment.count({ where: { parentId: theirComment.id } })).toBe(0)

    // A reply misfiled before the fix no longer shows in the other thread.
    await prisma.contractComment.create({ data: { orgId: org, contractId: mine, parentId: theirComment.id, authorId: repA, body: 'OLD MISFILED REPLY' } })
    const list = await app.inject({ method: 'GET', url: `/api/v1/contracts/${theirs}/comments`, headers: auth(org, ['LEGAL_OPS'], repB) })
    expect(list.statusCode).toBe(200)
    expect(list.body).not.toContain('OLD MISFILED REPLY')
  })

  it('undoing a drafted contract re-checks that the caller still owns it', async () => {
    const tpl = await prisma.template.create({
      data: { orgId: org, name: 'X10 NDA', contractType: 'NDA', isPublished: true, createdById: repA, sections: { create: [{ title: 'Terms', content: '<p>Terms.</p>', sortOrder: 0 }] } },
    })
    const t = await app.inject({ method: 'POST', url: '/api/v1/agent/threads', headers: auth(org, ['SALES_REP'], repA), payload: {} })
    const res = await apply(['SALES_REP'], repA, t.json().id, 'contract_create_from_template', { templateId: tpl.id, title: 'X10 draft', contractType: 'NDA' })
    expect(res.statusCode).toBe(200)
    const created = await prisma.contract.findFirstOrThrow({ where: { orgId: org, title: 'X10 draft' } })
    await prisma.contract.update({ where: { id: created.id }, data: { ownerId: repB } })
    const toolCallId = res.json().toolCallId ?? res.json().toolCall?.id
    const undo = await app.inject({ method: 'POST', url: `/api/v1/agent/threads/${t.json().id}/actions/${toolCallId}/undo`, headers: auth(org, ['SALES_REP'], repA) })
    expect(undo.statusCode).toBe(404)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: created.id } })).deletedAt).toBeNull()
  })

  it('an org-scope editor is unaffected', async () => {
    const t = await app.inject({ method: 'POST', url: '/api/v1/agent/threads', headers: auth(org, ['LEGAL_OPS'], repB), payload: {} })
    const res = await apply(['LEGAL_OPS'], repB, t.json().id, 'comment_add', { contractId: mine, body: 'legal ops note' })
    expect(res.statusCode).toBe(200)
  })
})
