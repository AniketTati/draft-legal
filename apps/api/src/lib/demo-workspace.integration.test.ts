/**
 * Z9 — the demo workspace works out of the box. After the standard setup it
 * had 6 of the 9 roles and no Sales Rep, base contracts stuck on "Processing
 * starting…", no approval workflow, nothing indexed for search, and the
 * AI-demo contracts had no clauses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SystemRole, TriggerRulesSchema, pickWorkflow } from '@clm/types'
import { makeOrg, cleanupAll, cleanupOrg, prisma } from '../test-support/helpers.js'
import { DEMO_CONTRACTS, DEMO_USERS, seedDemoWorkspace } from './demo-workspace.js'
import { resolveApprovers, type WorkflowStepDef } from './workflow-engine.js'

const repo = (path: string) => readFileSync(join(__dirname, '..', '..', '..', '..', path), 'utf8')
let org: string

beforeAll(async () => {
  // The demo logins are unique across orgs: clear what an interrupted run left.
  for (const left of await prisma.organization.findMany({ where: { name: 'Z9 Demo Workspace' }, select: { id: true } })) {
    await cleanupOrg(left.id)
  }
  org = await makeOrg('Z9 Demo Workspace')
  await seedDemoWorkspace(prisma, org, 'not-a-real-hash')
  // Run twice, as setup and demo:seed may: nothing is duplicated.
  await seedDemoWorkspace(prisma, org, 'not-a-real-hash')
})
afterAll(async () => { await cleanupAll() })

describe('a freshly seeded demo workspace', () => {
  it('has every role, and a login for each persona the demo walks through', async () => {
    const roles = await prisma.role.findMany({ where: { orgId: org }, select: { name: true, permissions: true } })
    expect(roles.map(r => r.name).sort()).toEqual(Object.values(SystemRole).sort())
    for (const r of roles) expect((r.permissions as unknown[]).length, r.name).toBeGreaterThan(0)

    for (const persona of DEMO_USERS) {
      const user = await prisma.user.findUnique({
        where:  { orgId_email: { orgId: org, email: persona.email } },
        select: { userRoles: { select: { role: { select: { name: true } } } } },
      })
      expect(user?.userRoles.map(ur => ur.role.name), persona.email).toEqual([persona.role])
    }
    expect(DEMO_USERS.map(u => u.role)).toEqual(expect.arrayContaining([SystemRole.SALES_REP, SystemRole.CONTRACT_MANAGER, SystemRole.LEGAL_COUNSEL]))
  })

  it('shows its contracts as analysed, not "Processing starting…"', async () => {
    const contracts = await prisma.contract.findMany({ where: { orgId: org }, select: { analysisStatus: true } })
    expect(contracts).toHaveLength(DEMO_CONTRACTS.length)
    expect(new Set(contracts.map(c => c.analysisStatus))).toEqual(new Set(['DONE']))
  })

  it('can send a contract for review: a default workflow, with valid rules and approvers who exist', async () => {
    const workflows = await prisma.workflowDefinition.findMany({ where: { orgId: org, deletedAt: null } })
    expect(workflows).toHaveLength(1)
    const [wf] = workflows
    expect(wf.isDefault && wf.isActive).toBe(true)
    expect(TriggerRulesSchema.safeParse(wf.triggerRules).success).toBe(true)
    expect(pickWorkflow(workflows, { type: 'MSA', value: 300_000 })?.id).toBe(wf.id)
    for (const step of wf.steps as unknown as WorkflowStepDef[]) {
      expect(await resolveApprovers(step, org, prisma), step.name).not.toEqual([])
    }
  })

  it('the demo scripts find it by slug, the AI-demo contracts get clauses, setup indexes search, and one command loads it all', () => {
    for (const script of ['seed-demo-portfolio.ts', 'seed-demo-full.ts', 'seed-playbook-rules.ts']) {
      expect(repo(`apps/api/scripts/${script}`), script).toContain('slug: DEMO_ORG_SLUG')
    }
    expect(repo('apps/api/scripts/seed-ai-demo.ts')).toContain('numberedSections(plainText)')
    const setup = repo('scripts/setup.sh').split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    expect(setup).toContain('pnpm --filter api backfill-es-index')
    const demoSeed = JSON.parse(repo('apps/api/package.json')).scripts['demo:seed'] as string
    for (const step of ['prisma/seed.ts', 'seed-ai-demo.ts', 'seed-demo-portfolio.ts', 'seed-demo-full.ts', 'backfill-es-index.ts']) expect(demoSeed).toContain(step)
  })
})
