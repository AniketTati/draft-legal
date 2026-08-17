import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { seedOrgDefaults } from '../src/lib/org-seed.js'
import { DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLE_DESCRIPTIONS } from '../src/lib/permissions.js'

const prisma = new PrismaClient()

const DEMO_CONTRACTS = [
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

async function main() {
  console.log('Seeding database...')

  // ── Org ─────────────────────────────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { slug: 'demo-corp' },
    update: {},
    create: { name: 'Demo Corp', slug: 'demo-corp', subscriptionTier: 'PRO' },
  })

  // ── Roles ────────────────────────────────────────────────────────────────
  const roleNames = ['ADMIN', 'LEGAL_COUNSEL', 'LEGAL_OPS', 'CONTRACT_MANAGER', 'APPROVER', 'VIEWER']
  const roleMap: Record<string, string> = {}

  for (const name of roleNames) {
    const role = await prisma.role.upsert({
      where: { orgId_name: { orgId: org.id, name } },
      update: {
        permissions: DEFAULT_ROLE_PERMISSIONS[name] ?? [],
        description: DEFAULT_ROLE_DESCRIPTIONS[name] ?? null,
      },
      create: {
        orgId: org.id,
        name,
        isSystem: true,
        permissions: DEFAULT_ROLE_PERMISSIONS[name] ?? [],
        description: DEFAULT_ROLE_DESCRIPTIONS[name] ?? null,
      },
    })
    roleMap[name] = role.id
  }

  // ── Users ────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash('password123', 12)

  const admin = await prisma.user.upsert({
    where: { orgId_email: { orgId: org.id, email: 'admin@demo.com' } },
    update: {},
    create: {
      orgId: org.id, email: 'admin@demo.com', passwordHash: hash,
      name: 'Admin User',
      userRoles: { create: { roleId: roleMap['ADMIN'] } },
    },
  })

  await prisma.user.upsert({
    where: { orgId_email: { orgId: org.id, email: 'legal@demo.com' } },
    update: {},
    create: {
      orgId: org.id, email: 'legal@demo.com', passwordHash: hash,
      name: 'Legal Counsel',
      userRoles: { create: { roleId: roleMap['LEGAL_COUNSEL'] } },
    },
  })

  // ── Counterparties ───────────────────────────────────────────────────────
  const counterpartyNames = [...new Set(DEMO_CONTRACTS.map(c => c.counterpartyName))]
  const cpMap: Record<string, string> = {}

  for (const name of counterpartyNames) {
    const cp = await prisma.counterparty.upsert({
      where: { orgId_name: { orgId: org.id, name } },
      update: {},
      create: { orgId: org.id, name },
    })
    cpMap[name] = cp.id
  }

  // ── Contracts ─────────────────────────────────────────────────────────────
  for (const c of DEMO_CONTRACTS) {
    const existing = await prisma.contract.findFirst({
      where: { orgId: org.id, title: c.title },
    })
    if (existing) continue

    await prisma.contract.create({
      data: {
        orgId: org.id,
        ownerId: admin.id,
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
        versions: {
          create: {
            versionNumber: 1,
            htmlContent: `<h1>${c.title}</h1><p>${c.summary}</p>`,
            plainText: `${c.title}\n\n${c.summary}`,
            changeNote: 'Initial version',
            createdById: admin.id,
          },
        },
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
  const existingSigs = await prisma.signatureRequest.count({ where: { orgId: org.id } })
  if (existingSigs === 0) {
    const signable = await prisma.contract.findMany({
      where: { orgId: org.id },
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
          orgId: org.id,
          contractId: c.id,
          versionId,
          status: s.status,
          createdById: admin.id,
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
              token: `seed-${org.id.slice(-6)}-${i}-${s.status.toLowerCase()}`,
              status: s.signer,
              signedAt: s.signer === 'SIGNED' ? new Date() : null,
              signedName: s.signer === 'SIGNED' ? 'Alex Signer' : null,
            },
          },
        },
      })
    }
  }

  console.log(`✓ Org: ${org.name}`)
  console.log(`✓ Users: admin@demo.com / legal@demo.com  (password: password123)`)
  console.log(`✓ Counterparties: ${counterpartyNames.length}`)
  console.log(`✓ Demo contracts: ${DEMO_CONTRACTS.length}`)
  console.log(`✓ Signature requests: ${await prisma.signatureRequest.count({ where: { orgId: org.id } })} (one per status)`)

  // ── Base data (templates, clauses, playbook) for ALL orgs ────────────────
  const allOrgs = await prisma.organization.findMany()
  for (const seedOrg of allOrgs) {
    // Find the first admin-role user or any user in this org
    const seedAdmin = await prisma.user.findFirst({
      where: { orgId: seedOrg.id },
      orderBy: { createdAt: 'asc' },
    })
    if (!seedAdmin) continue
    await seedBaseData(seedOrg.id, seedOrg.slug, seedAdmin.id)
    console.log(`✓ Base data seeded for org: ${seedOrg.name}`)
  }
}

async function seedBaseData(orgId: string, orgSlug: string, adminId: string) {
  return seedOrgDefaults(orgId, orgSlug, adminId)
}


main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
