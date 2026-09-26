/**
 * Y1 — Postgres row-level security keeps each tenant's queries to its own rows
 * in the database itself: raw SQL and rows reached through relations included,
 * which the Prisma-level guard (lib/tenant-guard.ts) can't see. These tests
 * switch that guard off where it matters, so what they show is the database's.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { makeOrg, makeUser, makeContract, cleanupAll, closeApp, getApp, prisma } from '../test-support/helpers.js'
import { withTenant } from './tenant-context.js'
import { setTenantGuardEnabled, ORG_MODELS } from './tenant-guard.js'
import { TENANT_ROLE } from './tenant-rls.js'

const MARK = `rls-${randomUUID().slice(0, 8)}`
let orgA: string, orgB: string, userA: string, userB: string, contractA: string, contractB: string
let counterpartyB: string, matterA: string, builtInRole: string

/** Tables that hold tenant data without an orgId of their own (see the migration). */
const CHILD_TABLES = ['contract_versions', 'contract_clauses', 'template_sections', 'signers', 'signature_events',
  'agent_messages', 'tool_calls', 'webhook_deliveries', 'version_diff_cache', 'user_roles', 'organizations']

beforeAll(async () => {
  await getApp()
  orgA = await makeOrg('RLS Org A'); orgB = await makeOrg('RLS Org B')
  userA = await makeUser(orgA); userB = await makeUser(orgB)
  contractA = await makeContract(orgA, userA, { title: `${MARK} A` })
  contractB = await makeContract(orgB, userB, { title: `${MARK} B` })
  await prisma.contractVersion.create({ data: { contractId: contractB, versionNumber: 1, createdById: userB, plainText: `${MARK} B text` } })
  counterpartyB = (await prisma.counterparty.create({ data: { orgId: orgB, name: `${MARK} B counterparty` } })).id
  // A link from before X25: Org A's matter naming Org B's counterparty.
  matterA = (await prisma.matter.create({ data: { orgId: orgA, name: `${MARK} matter`, ownerId: userA, createdById: userA, counterpartyId: counterpartyB } })).id
  builtInRole = (await prisma.role.create({ data: { orgId: null, name: `${MARK}-builtin`, isSystem: true } })).id
})

afterEach(() => { setTenantGuardEnabled(true) })

afterAll(async () => {
  await prisma.matter.deleteMany({ where: { id: matterA } })
  await prisma.counterparty.deleteMany({ where: { id: counterpartyB } })
  await prisma.role.deleteMany({ where: { id: builtInRole } })
  await cleanupAll()
  await closeApp()
})

describe('row-level security policies', () => {
  it('every table with tenant data has row-level security, forced, with the tenant policy', async () => {
    const orgTables = [...ORG_MODELS.keys()].map(model => Prisma.dmmf.datamodel.models.find(m => m.name === model)!.dbName ?? model)
    const rows = await prisma.$queryRaw<Array<{ table: string; enabled: boolean; forced: boolean; policy: string | null }>>`
      SELECT c.relname AS "table", c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, p.policyname AS policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'tenant_isolation'
      WHERE c.relkind = 'r'`
    const byTable = new Map(rows.map(r => [r.table, r]))
    for (const table of [...orgTables, ...CHILD_TABLES]) {
      expect(byTable.get(table), table).toMatchObject({ enabled: true, forced: true, policy: 'tenant_isolation' })
    }
  })

  it('a tenant query runs as the tenant role with its tenant: alone, in a batch and in a transaction', async () => {
    const who = 'SELECT current_user AS role, current_setting(\'app.tenant_id\', true) AS tenant'
    const alone = await withTenant(orgA, () => prisma.$queryRawUnsafe<Array<{ role: string; tenant: string }>>(who))
    const [batch] = await withTenant(orgA, () => prisma.$transaction([prisma.$queryRawUnsafe<Array<{ role: string; tenant: string }>>(who)]))
    const inTx = await withTenant(orgA, () => prisma.$transaction(tx => tx.$queryRawUnsafe<Array<{ role: string; tenant: string }>>(who)))
    for (const rows of [alone, batch, inTx]) expect(rows[0]).toEqual({ role: TENANT_ROLE, tenant: orgA })
    // And outside a tenant context, the application's own login, with no tenant.
    const outside = await prisma.$queryRawUnsafe<Array<{ role: string; tenant: string | null }>>(who)
    expect(outside[0].role).not.toBe(TENANT_ROLE)
  })

  // Tests stub $transaction to stage failures (X5, X65). The client is shared by
  // every test file, so a restore that loses the tenant's $transaction breaks
  // every file after it.
  it('stubbing $transaction and restoring it leaves the tenant\'s own in place', async () => {
    const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('stubbed'))
    await expect(prisma.$transaction([])).rejects.toThrow('stubbed')
    spy.mockRestore()
    const [rows] = await withTenant(orgA, () => prisma.$transaction([prisma.$queryRawUnsafe<Array<{ role: string }>>('SELECT current_user AS role')]))
    expect(rows[0].role).toBe(TENANT_ROLE)
  })
})

describe('what the database keeps from another tenant', () => {
  it('raw SQL with no org filter sees only the tenant\'s rows', async () => {
    const like = `${MARK}%`
    const titles = await withTenant(orgA, () => prisma.$queryRaw<Array<{ title: string }>>`SELECT title FROM contracts WHERE title LIKE ${like} ORDER BY title`)
    expect(titles.map(t => t.title)).toEqual([`${MARK} A`])
    const texts = await withTenant(orgA, () => prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM contract_versions WHERE "plainText" LIKE ${like}`)
    expect(texts).toEqual([])
    const orgs = await withTenant(orgA, () => prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM organizations WHERE id IN (${orgA}, ${orgB})`)
    expect(orgs.map(o => o.id)).toEqual([orgA])
    // Outside a tenant context both are there.
    expect((await prisma.$queryRaw<Array<{ title: string }>>`SELECT title FROM contracts WHERE title LIKE ${like}`).length).toBe(2)
  })

  it('a relation to another tenant\'s row loads as nothing', async () => {
    setTenantGuardEnabled(false)
    const matter = await withTenant(orgA, () => prisma.matter.findUnique({ where: { id: matterA }, include: { counterparty: true } }))
    expect(matter?.id).toBe(matterA)
    expect(matter?.counterparty).toBeNull()
  })

  it('with the Prisma guard off, unscoped reads and writes still can\'t reach the other tenant', async () => {
    setTenantGuardEnabled(false)
    expect(await withTenant(orgA, () => prisma.contract.findUnique({ where: { id: contractB } }))).toBeNull()
    await expect(withTenant(orgA, () => prisma.contract.update({ where: { id: contractB }, data: { title: 'hijacked' } }))).rejects.toMatchObject({ code: 'P2025' })
    const raw = await withTenant(orgA, () => prisma.$executeRaw`UPDATE contracts SET title = 'hijacked' WHERE id = ${contractB}`)
    expect(raw).toBe(0)
    // Planting a row in the other tenant fails the policy's check.
    const plant = withTenant(orgA, () => prisma.contract.create({ data: { orgId: orgB, title: `${MARK} planted`, type: 'NDA', ownerId: userB, createdBy: userB } }))
    await expect(plant).rejects.toThrow(/row-level security/)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractB } })).title).toBe(`${MARK} B`)
    expect(await prisma.contract.count({ where: { title: `${MARK} planted` } })).toBe(0)
  })

  it('built-in rows stay readable, and no tenant can create one', async () => {
    setTenantGuardEnabled(false)
    const roles = await withTenant(orgA, () => prisma.role.findMany({ where: { name: `${MARK}-builtin` } }))
    expect(roles.map(r => r.id)).toEqual([builtInRole])
    await expect(withTenant(orgA, () => prisma.role.create({ data: { orgId: null, name: `${MARK}-planted` } }))).rejects.toThrow(/row-level security/)
  })

  it('the tenant\'s own work is unaffected, in and out of transactions', async () => {
    const renamed = await withTenant(orgA, () => prisma.contract.update({ where: { id: contractA }, data: { title: `${MARK} A` } }))
    expect(renamed.id).toBe(contractA)
    const created = await withTenant(orgA, () => prisma.$transaction(async tx => {
      const c = await tx.counterparty.create({ data: { orgId: orgA, name: `${MARK} A counterparty` } })
      return tx.counterparty.findUnique({ where: { id: c.id } })
    }))
    expect(created?.name).toBe(`${MARK} A counterparty`)
    await prisma.counterparty.deleteMany({ where: { id: created!.id } })
  })
})
