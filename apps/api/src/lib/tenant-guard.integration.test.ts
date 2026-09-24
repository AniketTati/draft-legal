/**
 * Y1 — the tenant guard limits every query on a model with an `orgId` to the
 * request's tenant, whatever the query itself says. Ten cross-org defects
 * (S2, X6, X7, X9, X10, X19–X21, X25, X44) were each a query that forgot to.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { makeOrg, makeUser, makeContract, auth, cleanupAll, closeApp, getApp, prisma } from '../test-support/helpers.js'
import { runInTenantStore, withTenant, withoutTenantGuard } from './tenant-context.js'
import { onTenantGuardBlocked, setTenantGuardEnabled, ORG_MODELS, type TenantGuardBlock } from './tenant-guard.js'
import { requirePermission } from '../middleware/permissions.js'
import { setTenantRlsEnabled } from './tenant-rls.js'
import { errorHandler } from '../middleware/error-handler.js'

const MARK = `y1-${randomUUID().slice(0, 8)}`
let orgA: string, orgB: string, userA: string, userB: string, contractA: string, contractB: string, builtInRole: string
let blocks: TenantGuardBlock[] = []
let unsubscribe: () => void

beforeAll(async () => {
  await getApp()   // the shared client, as the app uses it
  orgA = await makeOrg('Y1 Org A'); orgB = await makeOrg('Y1 Org B')
  userA = await makeUser(orgA); userB = await makeUser(orgB)
  contractA = await makeContract(orgA, userA, { title: `${MARK} A` })
  contractB = await makeContract(orgB, userB, { title: `${MARK} B` })
  builtInRole = (await prisma.role.create({ data: { orgId: null, name: `${MARK}-builtin`, isSystem: true } })).id
  unsubscribe = onTenantGuardBlocked(b => blocks.push(b))
})

afterEach(() => { blocks = []; setTenantGuardEnabled(true); setTenantRlsEnabled(true) })

afterAll(async () => {
  unsubscribe()
  await prisma.role.delete({ where: { id: builtInRole } }).catch(() => {})
  await cleanupAll()
  await closeApp()
})

describe('the tenant guard', () => {
  it('covers every model with an orgId, read from the schema', () => {
    expect([...ORG_MODELS.keys()]).toEqual(expect.arrayContaining(['Contract', 'Matter', 'Invoice', 'Role', 'Skill', 'AuditEvent']))
    expect(ORG_MODELS.get('Role')?.nullable).toBe(true)
    expect(ORG_MODELS.has('ContractVersion')).toBe(false)
  })

  it('an unscoped read by id of another org\'s row finds nothing, and says so', async () => {
    const row = await withTenant(orgA, () => prisma.contract.findUnique({ where: { id: contractB } }))
    expect(row).toBeNull()
    expect(blocks).toEqual([{ model: 'Contract', operation: 'findUnique', tenant: orgA }])
    // Its own row reads as before, and reports nothing.
    blocks = []
    expect((await withTenant(orgA, () => prisma.contract.findUnique({ where: { id: contractA } })))?.id).toBe(contractA)
    expect(blocks).toEqual([])
  })

  it('lists, counts and aggregates see only the tenant\'s rows', async () => {
    const where = { title: { startsWith: MARK } }
    const listed = await withTenant(orgA, () => prisma.contract.findMany({ where, select: { id: true } }))
    expect(listed.map(c => c.id)).toEqual([contractA])
    expect(await withTenant(orgA, () => prisma.contract.count({ where }))).toBe(1)
    const grouped = await withTenant(orgA, () => prisma.contract.groupBy({ by: ['orgId'], where, _count: true }))
    expect(grouped.map(g => g.orgId)).toEqual([orgA])
    // Outside a tenant context, nothing is limited.
    expect(await prisma.contract.count({ where })).toBe(2)
  })

  it('an unscoped update or delete of another org\'s row changes nothing and answers not found', async () => {
    const update = withTenant(orgA, () => prisma.contract.update({ where: { id: contractB }, data: { title: 'hijacked' } }))
    await expect(update).rejects.toMatchObject({ code: 'P2025' })
    expect(blocks.map(b => b.operation)).toEqual(['update'])
    const del = withTenant(orgA, () => prisma.contract.delete({ where: { id: contractB } }))
    await expect(del).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    const bulk = await withTenant(orgA, () => prisma.contract.updateMany({ where: { id: contractB }, data: { title: 'hijacked' } }))
    expect(bulk.count).toBe(0)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractB } })).title).toBe(`${MARK} B`)
  })

  it('refuses to create a row in another org', async () => {
    const create = withTenant(orgA, () => prisma.matter.create({ data: { orgId: orgB, name: `${MARK} planted`, ownerId: userA } as never }))
    // By name: the shared client may come from another test file's copy of the module.
    await expect(create).rejects.toMatchObject({ name: 'TenantGuardError', statusCode: 403 })
    expect(await prisma.matter.count({ where: { name: `${MARK} planted` } })).toBe(0)
  })

  it('built-in roles stay visible to every org', async () => {
    const seen = await withTenant(orgA, () => prisma.role.findMany({ where: { name: `${MARK}-builtin` } }))
    expect(seen.map(r => r.id)).toEqual([builtInRole])
  })

  it('withoutTenantGuard is the explicit way across', async () => {
    const row = await withTenant(orgA, () => withoutTenantGuard(() => prisma.contract.findUnique({ where: { id: contractB } })))
    expect(row?.id).toBe(contractB)
  })
})

describe('the tenant reaches the route handler', () => {
  /** An app wired as app.ts is, with one route that forgets the org. */
  async function appWithUnscopedRoute() {
    const app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('preHandler', (_req, _reply, done) => { runInTenantStore(done) })
    app.post('/leaky/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
      await new Promise(r => setTimeout(r, 5))   // across an await, as real handlers are
      const { id } = req.params as { id: string }
      const row = await prisma.contract.findUnique({ where: { id } })
      if (!row) return reply.status(404).send({ detail: 'Contract not found' })
      const renamed = await prisma.contract.update({ where: { id }, data: { title: (req.body as { title: string }).title } })
      return reply.send({ title: renamed.title })
    })
    await app.ready()
    return app
  }

  it('a route that forgets the org can\'t reach another org\'s contract; its own still works', async () => {
    const app = await appWithUnscopedRoute()
    const foreign = await app.inject({ method: 'POST', url: `/leaky/${contractB}`, headers: auth(orgA, ['ADMIN'], userA), payload: { title: 'hijacked' } })
    expect(foreign.statusCode).toBe(404)
    expect(blocks.map(b => b.model)).toEqual(['Contract'])
    const own = await app.inject({ method: 'POST', url: `/leaky/${contractA}`, headers: auth(orgA, ['ADMIN'], userA), payload: { title: `${MARK} A` } })
    expect(own.statusCode).toBe(200)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractB } })).title).toBe(`${MARK} B`)
    await app.close()
  })

  it('each layer alone stops it; with neither, the route would have leaked', async () => {
    const app = await appWithUnscopedRoute()
    const attempt = () => app.inject({ method: 'POST', url: `/leaky/${contractB}`, headers: auth(orgA, ['ADMIN'], userA), payload: { title: `${MARK} B` } })
    setTenantGuardEnabled(false)                      // row-level security alone
    expect((await attempt()).statusCode).toBe(404)
    setTenantGuardEnabled(true); setTenantRlsEnabled(false)   // the guard alone
    expect((await attempt()).statusCode).toBe(404)
    setTenantGuardEnabled(false)                      // neither: what both prevent
    expect((await attempt()).statusCode).toBe(200)
    await app.close()
  })
})

describe('checks that must look across orgs', () => {
  // Email is unique across every org; the invite checks it everywhere to give
  // a useful answer. Under tenant isolation that lookup is an explicit bypass.
  it('inviting an email another workspace already uses is told so', async () => {
    const app = await getApp()
    const { email } = await prisma.user.findUniqueOrThrow({ where: { id: userB } })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/users/invite', headers: auth(orgA, ['ADMIN'], userA),
      payload: { email, name: 'Someone', roles: ['VIEWER'] },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().detail).toMatch(/already has an account in another workspace/)
  })
})
