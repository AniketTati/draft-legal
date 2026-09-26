/**
 * seed-approvals.ts — populate WorkflowDefinitions + PENDING ApprovalInstances
 * across the 5 personas, so the agent's "what's in my approval queue?" JTBD
 * has real data to work with.
 *
 * Without this, every persona's user sees an empty approval queue when they
 * land on /approvals — fine for our pass-rate tests (rubric accepts empty),
 * but a deal-killer in a buyer demo.
 *
 * Distribution (50 total PENDING approvals across 5 personas):
 *   Vertex Cloud    12 — 4 Maya / 6 Priya / 2 David
 *   Caldera Health  10 — 4 Lena / 4 Marcus / 2 Aisha
 *   Ironbridge      12 — 3 Margaret / 4 Carla / 2 James / 3 Raj
 *   Lumen Bio        6 — 5 Aria / 1 Ben
 *   Beacon Logistics 10 — 3 Dean / 4 Hannah / 2 Chris / 1 Eli
 *
 * Idempotent: if a workflow + instances already exist for a persona, skip.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/seed-approvals.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface ApproverDist {
  email: string
  count: number
}

interface PersonaSpec {
  slug: string
  primaryAdminEmail: string
  approvers: ApproverDist[]
}

const PERSONAS: PersonaSpec[] = [
  {
    slug: 'vertex-cloud',
    primaryAdminEmail: 'maya.chen@vertex.cloud',
    approvers: [
      { email: 'maya.chen@vertex.cloud',   count: 4 },
      { email: 'priya.patel@vertex.cloud', count: 6 },
      { email: 'david.kim@vertex.cloud',   count: 2 },
    ],
  },
  {
    slug: 'caldera-health',
    primaryAdminEmail: 'lena.park@calderahealth.com',
    approvers: [
      { email: 'lena.park@calderahealth.com',   count: 4 },
      { email: 'marcus.hall@calderahealth.com', count: 4 },
      { email: 'aisha.yusuf@calderahealth.com', count: 2 },
    ],
  },
  {
    slug: 'ironbridge-industrial',
    primaryAdminEmail: 'margaret.obrien@ironbridge-ind.com',
    approvers: [
      { email: 'margaret.obrien@ironbridge-ind.com', count: 3 },
      { email: 'carla.mendez@ironbridge-ind.com',    count: 4 },
      { email: 'james.wright@ironbridge-ind.com',    count: 2 },
      { email: 'raj.sharma@ironbridge-ind.com',      count: 3 },
    ],
  },
  {
    slug: 'lumen-bio',
    primaryAdminEmail: 'aria.volkov@lumenbio.com',
    approvers: [
      { email: 'aria.volkov@lumenbio.com', count: 5 },
      { email: 'ben.foster@lumenbio.com',  count: 1 },
    ],
  },
  {
    slug: 'beacon-logistics',
    primaryAdminEmail: 'dean.whitfield@beaconlogistics.com',
    approvers: [
      { email: 'dean.whitfield@beaconlogistics.com',  count: 3 },
      { email: 'hannah.rivera@beaconlogistics.com',   count: 4 },
      { email: 'chris.park@beaconlogistics.com',      count: 2 },
      { email: 'eli.tran@beaconlogistics.com',        count: 1 },
    ],
  },
]

const RECOMMENDATIONS = ['approve', 'review_required', 'reject_advised'] as const
const RISK_TEMPLATES = [
  { title: 'Liability cap exceeds playbook (2× fees vs 1× standard)', description: 'Our playbook requires 1× annual fees cap; this contract has 2×, materially raising downside.', severity: 'medium' },
  { title: 'Auto-renewal with 60-day notice — non-standard', description: 'Standard is 30-day notice; 60 days extends our exposure window.', severity: 'low' },
  { title: 'Indemnification carve-out missing', description: 'No carve-out for gross negligence claims, increasing potential exposure.', severity: 'medium' },
  { title: 'Sub-processor list not attached', description: 'DPA references a sub-processor list but the schedule is empty.', severity: 'high' },
  { title: 'Termination for convenience absent', description: 'No right to terminate without cause — locks us in for full term.', severity: 'medium' },
]

async function seedPersona(spec: PersonaSpec): Promise<void> {
  const org = await prisma.organization.findUnique({
    where: { slug: spec.slug },
    select: { id: true, name: true },
  })
  if (!org) {
    console.log(`  ✗ ${spec.slug}: org not found`)
    return
  }

  // Resolve approver user ids
  const approverIds: Array<{ email: string; userId: string; count: number }> = []
  for (const a of spec.approvers) {
    const u = await prisma.user.findFirst({
      where: { orgId: org.id, email: a.email },
      select: { id: true },
    })
    if (!u) {
      console.log(`    ⚠ ${spec.slug}: approver ${a.email} not found, skipping`)
      continue
    }
    approverIds.push({ email: a.email, userId: u.id, count: a.count })
  }
  const adminUser = approverIds.find(a => a.email === spec.primaryAdminEmail)
  if (!adminUser) {
    console.log(`    ✗ ${spec.slug}: primary admin missing, skipping persona`)
    return
  }

  // ── 1. Workflow definition (one default per persona) ──────────────────
  let wf = await prisma.workflowDefinition.findFirst({
    where: { orgId: org.id, isDefault: true },
    select: { id: true },
  })
  if (!wf) {
    const created = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'Standard contract approval (3-step)',
        description: 'Legal review → GC approval → Finance sign-off. For MSAs, SOWs, vendor agreements and licenses worth USD 100,000 or more.',
        triggerRules: {
          contractTypes: ['MSA', 'SOW', 'VENDOR_AGREEMENT', 'LICENSE'],
          valueThreshold: 100000, currency: 'USD',
        },
        // FIX (2026-04-30 audit): each step needs a `roleRequired` so
        // resolveApprover() can find a user. Without it, Submit-for-Approval
        // fails with "Cannot resolve approver". Roles map to the seeded
        // org roles (LEGAL_COUNSEL, ADMIN, LEGAL_OPS) so any persona has a
        // matching user for each step.
        steps: [
          { order: 0, name: 'Legal Review',     roleRequired: 'LEGAL_COUNSEL', executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48 },
          { order: 1, name: 'GC Approval',      roleRequired: 'ADMIN',         executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 72 },
          { order: 2, name: 'Finance Sign-off', roleRequired: 'LEGAL_OPS',     executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 96 },
        ],
        isDefault: true,
        isActive: true,
        createdById: adminUser.userId,
      },
      select: { id: true },
    })
    wf = created
    console.log(`    ✓ ${spec.slug}: created Standard 3-step workflow`)
  } else {
    console.log(`    ↷ ${spec.slug}: workflow already exists`)
  }

  // Skip if approvals already exist for this persona
  const existingCount = await prisma.approvalInstance.count({
    where: { orgId: org.id, status: 'PENDING' },
  })
  if (existingCount > 0) {
    console.log(`    ↷ ${spec.slug}: ${existingCount} pending approvals already exist, skipping`)
    return
  }

  // ── 2. Pick contracts in eligible statuses ────────────────────────────
  // Prefer PENDING_APPROVAL → PENDING_REVIEW → UNDER_NEGOTIATION → DRAFT.
  // We want enough that each approver gets their share; total = sum(counts).
  const totalNeeded = approverIds.reduce((s, a) => s + a.count, 0)
  const candidates = await prisma.contract.findMany({
    where: {
      orgId: org.id,
      status: { in: ['PENDING_APPROVAL', 'PENDING_REVIEW', 'UNDER_NEGOTIATION', 'DRAFT'] },
    },
    select: { id: true, title: true, value: true, type: true },
    orderBy: { createdAt: 'desc' },
    take: totalNeeded * 2,   // over-fetch for buffer
  })
  if (candidates.length < totalNeeded) {
    console.log(`    ⚠ ${spec.slug}: only ${candidates.length} eligible contracts, expected ${totalNeeded}`)
  }

  // ── 3. Create approval instances + assign across approvers ────────────
  let candIdx = 0
  let createdInstances = 0
  for (const ap of approverIds) {
    for (let i = 0; i < ap.count; i++) {
      if (candIdx >= candidates.length) break
      const c = candidates[candIdx++]
      const rec = RECOMMENDATIONS[(candIdx + i) % RECOMMENDATIONS.length]
      const risk = RISK_TEMPLATES[(candIdx + i) % RISK_TEMPLATES.length]
      const aiSummary = `${c.type} contract with ${c.value ? `$${Math.round(Number(c.value) / 1000)}k value` : 'no value set'}. ` +
        (rec === 'approve' ? 'Terms align with our playbook; recommend approval.' :
         rec === 'review_required' ? 'One non-standard term flagged below; review before approving.' :
         'Multiple material risks; recommend rejection or material renegotiation.')

      const instance = await prisma.approvalInstance.create({
        data: {
          orgId: org.id,
          contractId: c.id,
          workflowDefinitionId: wf.id,
          status: 'PENDING',
          currentStepOrder: 0,
          submittedById: adminUser.userId,
          aiSummary,
          keyRisks: [risk],
          nonStandardTerms: rec === 'approve' ? [] : [risk.title],
          approvalRecommendation: rec,
        },
        select: { id: true },
      })
      // One PENDING step at order 0, assigned to this approver
      await prisma.approvalStep.create({
        data: {
          approvalInstanceId: instance.id,
          orgId: org.id,
          stepOrder: 0,
          stepName: 'Legal Review',
          approverId: ap.userId,
          status: 'PENDING',
        },
      })
      createdInstances++
    }
  }
  console.log(`    ✓ ${spec.slug}: created ${createdInstances} pending approvals (${approverIds.map(a => `${a.email.split('@')[0]}=${a.count}`).join(', ')})`)
}

async function main() {
  console.log('━━━ Seeding ApprovalInstances + WorkflowDefinitions ━━━\n')
  for (const spec of PERSONAS) {
    await seedPersona(spec)
  }

  console.log('\n━━━ Final stats ━━━')
  for (const spec of PERSONAS) {
    const org = await prisma.organization.findUnique({ where: { slug: spec.slug }, select: { id: true } })
    if (!org) continue
    const wfCount = await prisma.workflowDefinition.count({ where: { orgId: org.id } })
    const aiPending = await prisma.approvalInstance.count({ where: { orgId: org.id, status: 'PENDING' } })
    const stepPending = await prisma.approvalStep.count({ where: { orgId: org.id, status: 'PENDING' } })
    console.log(`  ${spec.slug.padEnd(24)} workflows=${wfCount}  pending_instances=${aiPending}  pending_steps=${stepPending}`)
  }
}

main()
  .catch(e => { console.error('seed-approvals failed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
