/**
 * Integration-test helpers — one shared Fastify app + Prisma, plus factories
 * for orgs/users/contracts and an ordered per-org cleanup.
 *
 * Auth: the JWT path sets req.user straight from the verified token (no DB user
 * lookup), and RBAC resolves from DEFAULT_ROLE_PERMISSIONS when a role isn't
 * seeded — so minting a token for a role is enough to exercise permissions.
 */
import { randomUUID } from 'node:crypto'
import { buildApp } from '../app.js'
import { prisma } from '../lib/prisma.js'
import { signAccessToken } from '../lib/jwt.js'

export { prisma } from '../lib/prisma.js'

// buildApp returns a more specific FastifyInstance than the generic one, so
// capture its exact type for the shared singleton + test annotations.
export type TestApp = Awaited<ReturnType<typeof buildApp>>

let _app: TestApp | null = null

export async function getApp(): Promise<TestApp> {
  if (!_app) {
    const app = await buildApp()
    await app.ready()
    _app = app
  }
  return _app
}

export async function closeApp(): Promise<void> {
  if (_app) { await _app.close(); _app = null }
  await prisma.$disconnect().catch(() => {})
}

const createdOrgs = new Set<string>()

export async function makeOrg(name = 'IntegrationTest Org'): Promise<string> {
  const org = await prisma.organization.create({
    data: { name, slug: `it-${randomUUID()}` },
    select: { id: true },
  })
  createdOrgs.add(org.id)
  return org.id
}

export async function makeUser(orgId: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      orgId,
      email: `it-${randomUUID()}@test.local`,
      passwordHash: 'x',
      name: 'Integration User',
    },
    select: { id: true },
  })
  return user.id
}

/** Bearer header for a principal in `orgId` holding `roles`. */
export function auth(orgId: string, roles: string[] = ['ADMIN'], sub?: string): Record<string, string> {
  const token = signAccessToken({ sub: sub ?? `it-user-${randomUUID()}`, orgId, roles })
  return { authorization: `Bearer ${token}` }
}

export async function makeContract(
  orgId: string,
  ownerId: string,
  over: Partial<{ title: string; type: string; status: string }> = {},
): Promise<string> {
  const c = await prisma.contract.create({
    data: {
      orgId,
      ownerId,
      createdBy: ownerId,
      title:  over.title  ?? 'Integration Contract',
      type:   over.type   ?? 'NDA',
      status: over.status ?? 'DRAFT',
    },
    select: { id: true },
  })
  return c.id
}

/** A workflow definition with one sequential step assigned to `approverId`. */
export async function makeWorkflow(orgId: string, createdById: string, approverId: string): Promise<string> {
  const wf = await prisma.workflowDefinition.create({
    data: {
      orgId,
      name: 'Integration Approval',
      createdById,
      isActive: true,
      isDefault: false,
      triggerRules: {},
      steps: [{
        order: 0, name: 'Legal Review', approverId,
        executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48,
      }] as unknown as object,
    },
    select: { id: true },
  })
  return wf.id
}

/** Delete every row created for the test orgs, leaf tables first (few relations
 *  cascade). Resilient — a missing table/row never fails teardown. */
export async function cleanupAll(): Promise<void> {
  for (const orgId of createdOrgs) {
    const contracts = await prisma.contract.findMany({ where: { orgId }, select: { id: true } }).catch(() => [])
    const cids = contracts.map(c => c.id)
    const srs = cids.length
      ? await prisma.signatureRequest.findMany({ where: { contractId: { in: cids } }, select: { id: true } }).catch(() => [])
      : []
    const srIds = srs.map(s => s.id)

    const del = async (fn: () => Promise<unknown>) => { await fn().catch(() => {}) }
    await del(() => prisma.signatureEvent.deleteMany({ where: { signatureRequestId: { in: srIds } } }))
    await del(() => prisma.signer.deleteMany({ where: { signatureRequestId: { in: srIds } } }))
    await del(() => prisma.signatureRequest.deleteMany({ where: { id: { in: srIds } } }))
    await del(() => prisma.approvalStep.deleteMany({ where: { orgId } }))
    await del(() => prisma.approvalInstance.deleteMany({ where: { orgId } }))
    await del(() => prisma.contractVersion.deleteMany({ where: { contractId: { in: cids } } }))
    await del(() => prisma.notification.deleteMany({ where: { orgId } }))
    await del(() => prisma.auditEvent.deleteMany({ where: { orgId } }))
    await del(() => prisma.contract.deleteMany({ where: { orgId } }))
    await del(() => prisma.workflowDefinition.deleteMany({ where: { orgId } }))
    // Agent threads hold a userId FK, so they have to go before the users do.
    // Tool calls and messages cascade from the thread.
    await del(() => prisma.agentThread.deleteMany({ where: { orgId } }))
    await del(() => prisma.userRole.deleteMany({ where: { user: { orgId } } }))
    await del(() => prisma.user.deleteMany({ where: { orgId } }))
    await del(() => prisma.organization.delete({ where: { id: orgId } }))
  }
  createdOrgs.clear()
}
