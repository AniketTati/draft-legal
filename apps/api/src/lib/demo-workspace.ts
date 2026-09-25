/**
 * Z9 — the demo workspace: admin@demo.com's organization as `pnpm db:seed`
 * sets it up. Moved out of prisma/seed.ts so a test can check what a fresh
 * seed gives a demo, which on a fresh install was:
 *   - 6 of the 9 roles, and no Sales Rep or Contract Manager to log in as;
 *   - base contracts stuck on "Processing starting…" (never analysed);
 *   - no approval workflow, so "Send for review" had nowhere to go.
 *
 * Idempotent: rows that exist are kept. Contracts the seed made, still waiting
 * for analysis that will never run, are marked analysed.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { SystemRole } from '@clm/types'
import { DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLE_DESCRIPTIONS } from './permissions.js'

/** The demo organization's slug: the demo scripts find it by this. */
export const DEMO_ORG_SLUG = 'demo-corp'
export const DEMO_ORG_NAME = 'Demo Org, Inc.'

/** One login per persona the demo guide walks through. */
export const DEMO_USERS: ReadonlyArray<{ email: string; name: string; role: SystemRole }> = [
  { email: 'admin@demo.com',     name: 'Admin User',      role: SystemRole.ADMIN },
  { email: 'legal@demo.com',     name: 'Legal Counsel',   role: SystemRole.LEGAL_COUNSEL },
  { email: 'contracts@demo.com', name: 'Casey Contracts', role: SystemRole.CONTRACT_MANAGER },
  { email: 'sales@demo.com',     name: 'Sam Sales',       role: SystemRole.SALES_REP },
]

/** The workflow "Send for review" uses when no other fits (Z3, pickWorkflow). */
export const DEMO_WORKFLOW = {
  name:        'Standard approval',
  description: 'Legal reviews each contract sent for approval. NDAs up to USD 10,000 are approved at once.',
  triggerRules: { currency: 'USD', autoApproveRules: [{ contractType: 'NDA', maxValue: 10_000 }] },
  steps: [
    { order: 0, name: 'Legal review', roleRequired: SystemRole.LEGAL_COUNSEL, executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48 },
  ],
}

export const DEMO_CONTRACTS = [
  {
    title: 'Acme Corp — Master Services Agreement',
    type: 'MSA', status: 'EXECUTED',
    counterpartyName: 'Acme Corporation',
    value: 250000, currency: 'USD',
    effectiveDate: new Date('2025-01-15'), expiryDate: new Date('2027-01-14'),
    riskScore: 0.2, tags: ['enterprise', 'active'],
    summary: 'MSA governing all professional services engagements with Acme Corporation including SLA, liability caps, and IP ownership.',
    keyTerms: { governingLaw: 'Delaware', liabilityCap: '$500,000', autoRenew: true, noticePeriod: '90 days' },
  },
  {
    title: 'Globex — NDA',
    type: 'NDA', status: 'EXECUTED',
    counterpartyName: 'Globex Industries',
    value: null, currency: 'USD',
    effectiveDate: new Date('2025-03-01'), expiryDate: new Date('2027-03-01'),
    riskScore: 0.1, tags: ['nda', 'active'],
    summary: 'Mutual non-disclosure agreement with Globex Industries for evaluation of a potential partnership.',
    keyTerms: { governingLaw: 'California', confidentiality: true, autoRenew: false, noticePeriod: '30 days' },
  },
  {
    title: 'Initech — Software License Agreement',
    type: 'LICENSE', status: 'APPROVED',
    counterpartyName: 'Initech Solutions',
    value: 48000, currency: 'USD',
    effectiveDate: new Date('2025-06-01'), expiryDate: new Date('2026-05-31'),
    riskScore: 0.35, tags: ['software', 'annual'],
    summary: 'Annual software license for Initech analytics platform covering 50 users with enterprise support tier.',
    keyTerms: { governingLaw: 'Texas', liabilityCap: '$96,000', autoRenew: true, noticePeriod: '60 days' },
  },
  {
    title: 'Umbrella Corp — Vendor Agreement',
    type: 'VENDOR_AGREEMENT', status: 'UNDER_NEGOTIATION',
    counterpartyName: 'Umbrella Corporation',
    value: 120000, currency: 'USD',
    effectiveDate: null, expiryDate: null,
    riskScore: 0.65, tags: ['vendor', 'pending'],
    summary: 'Vendor agreement for cloud infrastructure services. Currently under negotiation on liability clauses and SLA terms.',
    keyTerms: { governingLaw: 'New York', liabilityCap: 'TBD', autoRenew: null, confidentiality: true },
  },
  {
    title: 'Stark Industries — SOW #12',
    type: 'SOW', status: 'EXECUTED',
    counterpartyName: 'Stark Industries',
    value: 85000, currency: 'USD',
    effectiveDate: new Date('2025-02-01'), expiryDate: new Date('2025-08-31'),
    riskScore: 0.15, tags: ['consulting', 'completed'],
    summary: 'Statement of work for Q1-Q2 2025 consulting engagement covering systems integration and staff augmentation.',
    keyTerms: { governingLaw: 'New York', terminationRights: '30-day notice', autoRenew: false },
  },
  {
    title: 'Wayne Enterprises — Partnership Agreement',
    type: 'PARTNERSHIP', status: 'PENDING_APPROVAL',
    counterpartyName: 'Wayne Enterprises',
    value: 500000, currency: 'USD',
    effectiveDate: null, expiryDate: null,
    riskScore: 0.45, tags: ['strategic', 'high-value'],
    summary: 'Strategic partnership agreement for co-development and joint go-to-market of enterprise security solutions.',
    keyTerms: { governingLaw: 'Delaware', confidentiality: true, autoRenew: false, noticePeriod: '180 days' },
  },
  {
    title: 'Pied Piper — SLA',
    type: 'SLA', status: 'EXECUTED',
    counterpartyName: 'Pied Piper Inc.',
    value: 36000, currency: 'USD',
    effectiveDate: new Date('2025-04-01'), expiryDate: new Date('2026-03-31'),
    riskScore: 0.2, tags: ['sla', 'active'],
    summary: 'Service level agreement guaranteeing 99.9% uptime for Pied Piper middleware platform with defined response and resolution times.',
    keyTerms: { governingLaw: 'California', autoRenew: true, noticePeriod: '60 days', liabilityCap: '$72,000' },
  },
  {
    title: 'Dunder Mifflin — Employment Agreement',
    type: 'EMPLOYMENT', status: 'EXECUTED',
    counterpartyName: 'Dunder Mifflin',
    value: 150000, currency: 'USD',
    effectiveDate: new Date('2025-01-01'), expiryDate: null,
    riskScore: 0.1, tags: ['hr', 'active'],
    summary: 'Employment agreement for VP of Sales covering compensation, IP assignment, non-compete, and severance terms.',
    keyTerms: { governingLaw: 'Pennsylvania', noticePeriod: '60 days', confidentiality: true },
  },
  {
    title: 'Veridian Dynamics — Research NDA',
    type: 'NDA', status: 'EXPIRED',
    counterpartyName: 'Veridian Dynamics',
    value: null, currency: 'USD',
    effectiveDate: new Date('2023-06-01'), expiryDate: new Date('2025-06-01'),
    riskScore: 0.05, tags: ['nda', 'expired'],
    summary: 'One-way NDA covering proprietary research shared during technology evaluation. Expired June 2025.',
    keyTerms: { governingLaw: 'California', confidentiality: true, autoRenew: false },
  },
  {
    title: 'Massive Dynamic — Cloud Services MSA',
    type: 'MSA', status: 'DRAFT',
    counterpartyName: 'Massive Dynamic',
    value: 300000, currency: 'USD',
    effectiveDate: null, expiryDate: null,
    riskScore: 0.5, tags: ['cloud', 'draft'],
    summary: 'Draft MSA for managed cloud services engagement. Pending internal legal review before sending to counterparty.',
    keyTerms: { governingLaw: 'New York', liabilityCap: 'TBD', autoRenew: null, confidentiality: true },
  },
]

export async function seedDemoWorkspace(prisma: PrismaClient, orgId: string, passwordHash: string): Promise<{ adminId: string }> {
  // ── Roles: every system role, with its default permissions ──────────────
  const roleMap: Record<string, string> = {}
  for (const name of Object.values(SystemRole)) {
    const permissions = (DEFAULT_ROLE_PERMISSIONS[name] ?? []) as unknown as Prisma.InputJsonValue
    const role = await prisma.role.upsert({
      where:  { orgId_name: { orgId, name } },
      update: { permissions, description: DEFAULT_ROLE_DESCRIPTIONS[name] ?? null },
      create: { orgId, name, isSystem: true, permissions, description: DEFAULT_ROLE_DESCRIPTIONS[name] ?? null },
    })
    roleMap[name] = role.id
  }

  // ── Users: one per persona. Existing users keep their password and roles ─
  const userIds: Record<string, string> = {}
  for (const u of DEMO_USERS) {
    const user = await prisma.user.upsert({
      where:  { orgId_email: { orgId, email: u.email } },
      update: {},
      create: { orgId, email: u.email, passwordHash, name: u.name, userRoles: { create: { roleId: roleMap[u.role] } } },
    })
    userIds[u.email] = user.id
  }
  const adminId = userIds['admin@demo.com']

  // ── Counterparties ───────────────────────────────────────────────────────
  const cpMap: Record<string, string> = {}
  for (const name of [...new Set(DEMO_CONTRACTS.map(c => c.counterpartyName))]) {
    const cp = await prisma.counterparty.upsert({
      where:  { orgId_name: { orgId, name } },
      update: {},
      create: { orgId, name },
    })
    cpMap[name] = cp.id
  }

  // ── Contracts ─────────────────────────────────────────────────────────────
  // Their summary, terms and risk are written here, so they are analysed as
  // made: without analysisStatus they showed "Processing starting…" forever.
  for (const c of DEMO_CONTRACTS) {
    const existing = await prisma.contract.findFirst({ where: { orgId, title: c.title } })
    if (existing) continue
    await prisma.contract.create({
      data: {
        orgId,
        ownerId: adminId,
        title: c.title,
        type: c.type,
        status: c.status,
        counterpartyId: cpMap[c.counterpartyName],
        counterpartyName: c.counterpartyName,
        value: c.value,
        currency: c.currency,
        effectiveDate: c.effectiveDate,
        expiryDate: c.expiryDate,
        riskScore: c.riskScore,
        summary: c.summary,
        keyTerms: c.keyTerms,
        tags: c.tags,
        analysisStatus: 'DONE',
        versions: {
          create: {
            versionNumber: 1,
            htmlContent: `<h1>${c.title}</h1><p>${c.summary}</p>`,
            plainText: `${c.title}\n\n${c.summary}`,
            changeNote: 'Initial version',
            createdById: adminId,
          },
        },
      },
    })
  }
  await prisma.contract.updateMany({
    where: { orgId, title: { in: DEMO_CONTRACTS.map(c => c.title) }, analysisStatus: 'PENDING' },
    data:  { analysisStatus: 'DONE' },
  })

  // ── The default approval workflow ───────────────────────────────────────
  // Earlier seeds (seed-approvals.ts, seed-demo-lifecycle.ts) described a
  // workflow by routing no rule performs; say what its rules do (Z3).
  await prisma.workflowDefinition.updateMany({
    where: { orgId, description: { contains: 'or non-standard liability terms' } },
    data:  { description: 'Legal review → GC approval → Finance sign-off. For MSAs, SOWs, vendor agreements and licenses worth USD 100,000 or more.' },
  })
  const hasDefault = await prisma.workflowDefinition.findFirst({ where: { orgId, isDefault: true, deletedAt: null } })
  if (!hasDefault) {
    await prisma.workflowDefinition.create({
      data: {
        orgId,
        name:         DEMO_WORKFLOW.name,
        description:  DEMO_WORKFLOW.description,
        triggerRules: DEMO_WORKFLOW.triggerRules,
        steps:        DEMO_WORKFLOW.steps,
        isDefault:    true,
        isActive:     true,
        createdById:  adminId,
      },
    })
  }

  // ── Signature requests, one per status the filter tabs expose ─────────────
  //
  // Nothing seeded these, so signature_requests was empty on every fresh
  // database and the signatures page had four tabs that all read zero. The UI
  // check (scripts/agent-loops/l6b-ui-verify.mjs:125) picks a non-ALL tab with
  // a non-zero count to prove switching tabs actually re-filters; with every
  // bucket empty it had nothing to switch to and failed honestly, run after
  // run, naming this gap.
  //
  // One request per status so the filter is exercised rather than merely
  // rendered. Idempotent: keyed on the contract, skipped if any already exist.
  const sigStatuses = [
    { status: 'PENDING',   signer: 'PENDING' },
    { status: 'COMPLETED', signer: 'SIGNED' },
    { status: 'VOIDED',    signer: 'PENDING' },
    { status: 'EXPIRED',   signer: 'PENDING' },
  ] as const
  const existingSigs = await prisma.signatureRequest.count({ where: { orgId } })
  if (existingSigs === 0) {
    const signable = await prisma.contract.findMany({
      where: { orgId },
      select: { id: true, title: true, versions: { select: { id: true }, take: 1 } },
      orderBy: { createdAt: 'asc' },
      take: sigStatuses.length,
    })
    for (const [i, c] of signable.entries()) {
      const versionId = c.versions[0]?.id
      if (!versionId) continue
      const s = sigStatuses[i]
      await prisma.signatureRequest.create({
        data: {
          orgId,
          contractId: c.id,
          versionId,
          status: s.status,
          createdById: adminId,
          message: `Please countersign "${c.title}".`,
          completedAt: s.status === 'COMPLETED' ? new Date() : null,
          voidedAt:    s.status === 'VOIDED'    ? new Date() : null,
          voidedReason: s.status === 'VOIDED' ? 'Superseded by a renegotiated version' : null,
          // Past expiry for EXPIRED so the row is consistent with its status
          // rather than merely labelled — a filter test over incoherent rows
          // proves nothing about the filter.
          expiresAt: s.status === 'EXPIRED'
            ? new Date(Date.now() - 7 * 86_400_000)
            : new Date(Date.now() + 30 * 86_400_000),
          signers: {
            create: {
              email: 'signer@counterparty.test',
              name:  'Alex Signer',
              role:  'Authorised Signatory',
              signOrder: 1,
              // Unique per row; not a credential — this database is seed data.
              token: `seed-${orgId.slice(-6)}-${i}-${s.status.toLowerCase()}`,
              status: s.signer,
              signedAt: s.signer === 'SIGNED' ? new Date() : null,
              signedName: s.signer === 'SIGNED' ? 'Alex Signer' : null,
            },
          },
        },
      })
    }
  }

  return { adminId }
}
