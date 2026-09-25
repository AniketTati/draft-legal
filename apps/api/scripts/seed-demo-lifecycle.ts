/**
 * seed-demo-lifecycle.ts — populate Approvals, Signatures, and Obligations
 * for the DEMO org (admin@demo.com / "Demo Corp") so the launch-video
 * lifecycle scene shows real data in action instead of empty states.
 *
 * The existing seed-approvals.ts only targets the 5 persona orgs, so the
 * demo org's /approvals, /signatures, /obligations pages were all empty
 * ("No approval workflows defined yet", "No signature requests yet",
 * "All clear"). This fills all three for the demo org specifically.
 *
 * Idempotent: clears prior lifecycle rows for the demo org before seeding,
 * so re-runs are safe.
 *
 * Usage:
 *   pnpm tsx --env-file=../../.env scripts/seed-demo-lifecycle.ts
 */
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'node:crypto'

const prisma = new PrismaClient()

// Dates are computed relative to a fixed "today" passed in so the demo
// always shows the same spread of upcoming / due-soon / overdue items.
// (The video is recorded once; deterministic dates keep re-runs identical.)
const TODAY = new Date('2026-05-30T12:00:00Z')
const day = (n: number) => new Date(TODAY.getTime() + n * 24 * 60 * 60 * 1000)

function token() {
  return randomBytes(24).toString('hex')
}

async function main() {
  console.log('━━━ Seeding demo-org lifecycle (approvals · signatures · obligations) ━━━\n')

  const admin = await prisma.user.findFirst({
    where: { email: 'admin@demo.com' },
    select: { id: true, orgId: true, name: true, email: true },
  })
  if (!admin) throw new Error('admin@demo.com not found — run prisma/seed.ts first')
  const orgId = admin.orgId

  // A second user to act as counter-approver / counter-signer if one exists.
  const second = await prisma.user.findFirst({
    where: { orgId, email: { not: 'admin@demo.com' } },
    select: { id: true, name: true, email: true },
  })
  const reviewer = second ?? admin

  // All demo contracts with their current version (needed for sig requests).
  const contracts = await prisma.contract.findMany({
    where: { orgId },
    select: { id: true, title: true, type: true, value: true, currentVersionId: true, counterpartyName: true },
    orderBy: { createdAt: 'desc' },
  })
  if (contracts.length === 0) throw new Error('no contracts in demo org — run seed-ai-demo.ts first')
  console.log(`  Found ${contracts.length} contracts in demo org ${orgId}`)

  const byTitle = (frag: string) => contracts.find(c => c.title.toLowerCase().includes(frag.toLowerCase()))
  const withVersion = contracts.filter(c => c.currentVersionId)

  // ── 0. Clear prior demo lifecycle rows (idempotent) ───────────────────
  const sigReqs = await prisma.signatureRequest.findMany({ where: { orgId }, select: { id: true } })
  const sigIds = sigReqs.map(s => s.id)
  if (sigIds.length) {
    await prisma.signer.deleteMany({ where: { signatureRequestId: { in: sigIds } } })
    await prisma.signatureEvent.deleteMany({ where: { signatureRequestId: { in: sigIds } } }).catch(() => {})
    await prisma.signatureRequest.deleteMany({ where: { orgId } })
  }
  await prisma.obligation.deleteMany({ where: { orgId } })
  const apprInstances = await prisma.approvalInstance.findMany({ where: { orgId }, select: { id: true } })
  if (apprInstances.length) {
    await prisma.approvalStep.deleteMany({ where: { orgId } })
    await prisma.approvalInstance.deleteMany({ where: { orgId } })
  }
  console.log('  Cleared prior lifecycle rows\n')

  // ════════════════════════════════════════════════════════════════════
  // 1. APPROVALS — workflow + a spread of statuses
  // ════════════════════════════════════════════════════════════════════
  let wf = await prisma.workflowDefinition.findFirst({ where: { orgId, isDefault: true }, select: { id: true } })
  if (!wf) {
    wf = await prisma.workflowDefinition.create({
      data: {
        orgId,
        name: 'Standard contract approval (3-step)',
        description: 'Legal review → GC approval → Finance sign-off. For MSAs, SOWs, vendor agreements and licenses worth USD 100,000 or more.',
        triggerRules: { contractTypes: ['MSA', 'SOW', 'VENDOR_AGREEMENT', 'LICENSE'], valueThreshold: 100000, currency: 'USD' },
        steps: [
          { order: 0, name: 'Legal Review',     roleRequired: 'LEGAL_COUNSEL', executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48 },
          { order: 1, name: 'GC Approval',      roleRequired: 'ADMIN',         executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 72 },
          { order: 2, name: 'Finance Sign-off', roleRequired: 'LEGAL_OPS',     executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 96 },
        ],
        isDefault: true,
        isActive: true,
        createdById: admin.id,
      },
      select: { id: true },
    })
    console.log('  ✓ workflow: Standard 3-step approval created')
  } else {
    console.log('  ↷ workflow already exists')
  }

  // Pick contracts for approvals — the high-value SOWs make the queue read well.
  const apprPicks = [
    { c: byTitle('Helix'),    rec: 'review_required', risk: { title: 'Quote 38% above portfolio median', description: 'Helix $200k vs $137k median for comparable 8-week SOWs. Counter recommended.', severity: 'high' } },
    { c: byTitle('Lumen'),    rec: 'approve',         risk: { title: 'GxP validation terms standard', description: 'Terms align with our life-sciences playbook.', severity: 'low' } },
    { c: byTitle('Caldera'),  rec: 'review_required', risk: { title: 'Net 45 exceeds standard Net 30', description: 'Healthcare addendum extends payment window; confirm acceptable.', severity: 'medium' } },
    { c: byTitle('Acme'),     rec: 'review_required', risk: { title: 'Liability cap at $500k (2× fees)', description: 'Playbook prefers 1× annual fees; this is 2×.', severity: 'medium' } },
  ].filter(p => p.c)

  let apprCount = 0
  for (const [i, p] of apprPicks.entries()) {
    const c = p.c!
    const valueK = c.value ? `$${Math.round(Number(c.value) / 1000)}k` : 'no value'
    const aiSummary = `${c.type} with ${c.counterpartyName ?? 'counterparty'} (${valueK}). ` +
      (p.rec === 'approve' ? 'Terms align with our playbook; recommend approval.'
        : 'One non-standard term flagged; review before approving.')

    // First instance gets two approved steps + one pending (mid-flight, reads richest).
    // Others sit at step 0 pending.
    const midFlight = i === 0
    const instance = await prisma.approvalInstance.create({
      data: {
        orgId, contractId: c.id, workflowDefinitionId: wf.id,
        status: 'PENDING',
        currentStepOrder: midFlight ? 2 : 0,
        submittedById: admin.id,
        aiSummary,
        keyRisks: [p.risk],
        nonStandardTerms: p.rec === 'approve' ? [] : [p.risk.title],
        approvalRecommendation: p.rec,
      },
      select: { id: true },
    })

    if (midFlight) {
      await prisma.approvalStep.createMany({
        data: [
          { approvalInstanceId: instance.id, orgId, stepOrder: 0, stepName: 'Legal Review', approverId: reviewer.id, status: 'APPROVED', decidedAt: day(-2), comment: 'Reviewed — cap noted, proceeding.' },
          { approvalInstanceId: instance.id, orgId, stepOrder: 1, stepName: 'GC Approval',  approverId: admin.id,    status: 'APPROVED', decidedAt: day(-1), comment: 'Approved pending finance.' },
          { approvalInstanceId: instance.id, orgId, stepOrder: 2, stepName: 'Finance Sign-off', approverId: reviewer.id, status: 'PENDING' },
        ],
      })
    } else {
      await prisma.approvalStep.create({
        data: { approvalInstanceId: instance.id, orgId, stepOrder: 0, stepName: 'Legal Review', approverId: admin.id, status: 'PENDING' },
      })
    }
    apprCount++
  }
  console.log(`  ✓ approvals: ${apprCount} instances (1 mid-flight w/ 2 approved steps, ${apprCount - 1} pending)`)

  // ════════════════════════════════════════════════════════════════════
  // 2. SIGNATURES — a completed one + two awaiting
  // ════════════════════════════════════════════════════════════════════
  const sigSpecs = [
    { c: byTitle('Vertex'),  status: 'COMPLETED', signers: [
        { name: 'Morgan Leigh', email: 'morgan.leigh@democorp.com', role: 'signer', status: 'SIGNED', signedAt: day(-5) },
        { name: 'Elena Vasquez', email: 'elena.vasquez@vertex.cloud', role: 'signer', status: 'SIGNED', signedAt: day(-4) },
      ], completedAt: day(-4) },
    { c: byTitle('Caldera'), status: 'PENDING', signers: [
        { name: 'Morgan Leigh', email: 'morgan.leigh@democorp.com', role: 'signer', status: 'SIGNED', signedAt: day(-1) },
        { name: 'Dr. Jonathan Reyes', email: 'j.reyes@calderahealth.com', role: 'signer', status: 'PENDING', signedAt: null },
      ] },
    { c: byTitle('Ironbridge'), status: 'PENDING', signers: [
        { name: 'Morgan Leigh', email: 'morgan.leigh@democorp.com', role: 'signer', status: 'PENDING', signedAt: null },
        { name: 'Hans Müller', email: 'h.muller@ironbridge-ind.com', role: 'signer', status: 'PENDING', signedAt: null },
      ] },
  ].filter(s => s.c && s.c.currentVersionId)

  let sigCount = 0
  for (const spec of sigSpecs) {
    const c = spec.c!
    const sr = await prisma.signatureRequest.create({
      data: {
        orgId, contractId: c.id, versionId: c.currentVersionId!,
        status: spec.status,
        signOrder: 'SEQUENTIAL',
        message: `Please countersign the executed ${c.type} with ${c.counterpartyName ?? 'the counterparty'}.`,
        createdById: admin.id,
        expiresAt: day(14),
        completedAt: spec.status === 'COMPLETED' ? spec.completedAt : null,
      },
      select: { id: true },
    })
    for (const [i, s] of spec.signers.entries()) {
      await prisma.signer.create({
        data: {
          signatureRequestId: sr.id,
          email: s.email, name: s.name, role: s.role, signOrder: i + 1,
          status: s.status, signedAt: s.signedAt ?? null,
          signedName: s.status === 'SIGNED' ? s.name : null,
          token: token(),
        },
      })
    }
    sigCount++
  }
  console.log(`  ✓ signatures: ${sigCount} requests (1 completed, ${sigCount - 1} awaiting)`)

  // ════════════════════════════════════════════════════════════════════
  // 3. OBLIGATIONS — a realistic spread of upcoming / due-soon / overdue
  // ════════════════════════════════════════════════════════════════════
  const oblSpecs = [
    { c: byTitle('Vertex'),  type: 'renewal', desc: 'Renewal notice — give 60-day notice before auto-renew', owner: 'provider', due: day(38), sev: 'medium', quote: 'This Agreement auto-renews unless either party gives 60 days written notice.', rec: 'annually' },
    { c: byTitle('Caldera'), type: 'report',  desc: 'Annual SOC 2 Type II report due to customer', owner: 'provider', due: day(12), sev: 'high', quote: 'Provider shall furnish a current SOC 2 Type II report annually.', rec: 'annually' },
    { c: byTitle('Acme'),    type: 'compliance', desc: 'Proof of $5M professional liability insurance', owner: 'provider', due: day(5), sev: 'high', quote: 'Provider shall maintain professional liability insurance of $5,000,000.', rec: 'annually' },
    { c: byTitle('Lumen'),   type: 'payment', desc: 'Milestone 3 invoice — GxP validation complete', owner: 'customer', due: day(21), sev: 'medium', quote: 'Milestone 3 fee of $48,000 due on acceptance.', rec: 'one-time' },
    { c: byTitle('Stark'),   type: 'payment', desc: 'Final milestone payment overdue', owner: 'customer', due: day(-7), sev: 'high', quote: 'Final fee due Net 30 from invoice.', rec: 'one-time', status: 'OVERDUE' },
    { c: byTitle('Ironbridge'), type: 'audit', desc: 'Q2 supplier compliance audit', owner: 'either', due: day(45), sev: 'low', quote: 'Either party may audit compliance quarterly.', rec: 'quarterly' },
  ].filter(o => o.c)

  let oblCount = 0
  for (const o of oblSpecs) {
    await prisma.obligation.create({
      data: {
        orgId, contractId: o.c!.id,
        type: o.type, description: o.desc, owner: o.owner,
        dueDate: o.due, recurrence: o.rec, severity: o.sev,
        quote: o.quote, status: (o as { status?: string }).status ?? 'OPEN',
        sectionRef: '§' + (oblCount + 3) + '.1',
      },
    })
    oblCount++
  }
  console.log(`  ✓ obligations: ${oblCount} (mix of upcoming / due-soon / 1 overdue)`)

  // ── Final stats ───────────────────────────────────────────────────────
  console.log('\n━━━ Final demo-org counts ━━━')
  console.log(`  approvals (pending):   ${await prisma.approvalInstance.count({ where: { orgId, status: 'PENDING' } })}`)
  console.log(`  signatures (total):    ${await prisma.signatureRequest.count({ where: { orgId } })}`)
  console.log(`  obligations (total):   ${await prisma.obligation.count({ where: { orgId } })}`)
}

main()
  .catch(e => { console.error('seed-demo-lifecycle failed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
