/**
 * AI demo seed — deterministic contracts with real bodies for smoke tests.
 *
 * Existing prisma/seed.ts creates contract rows with metadata only
 * (title + short summary as plainText). That makes it impossible to tell
 * whether the agent's `contract_get` tool is actually reading the document
 * or just regurgitating the title/type. This seed fixes that by loading
 * four full contract bodies from fixtures/ai-demo/*.txt and attaching them
 * as ContractVersion.plainText + htmlContent.
 *
 * Runs against admin@demo.com's org by default. Wipes prior AI-demo
 * artifacts (the four contracts it created) so re-runs are idempotent.
 *
 * Smoke scripts call this before running so the fact assertions
 * ("mentions $500,000 liability cap", "99.9% uptime", etc.) reference
 * real text that's guaranteed to be in the DB.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/seed-ai-demo.ts          # default: seed
 *   pnpm tsx --env-file=.env scripts/seed-ai-demo.ts clear    # remove only
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHtmlToPdfAndStore } from '../src/lib/gotenberg.js'
import { seedBuiltInSkills } from './seed-skills.js'
import { seedPlaybookRules } from './seed-playbook-rules.js'
import { ensureBucket } from '../src/lib/storage.js'
import { numberedSections } from '../src/lib/numbered-sections.js'
import { legalChunkAndStore, CLAUSES_INDEX } from '../src/lib/legal-chunker.js'
import { es } from '../src/lib/elasticsearch.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures/ai-demo')

const prisma = new PrismaClient()

// Canonical title → fixture file. Titles are the idempotency key — prior
// runs delete any contract matching these titles before re-creating.
interface FixtureContract {
  title: string
  fixture: string
  type: string
  status: string
  counterpartyName: string
  value: number | null
  currency: string
  effectiveDate: Date | null
  expiryDate: Date | null
  riskScore: number | null
  summary: string
  keyTerms: Record<string, unknown>
  tags: string[]
  // Facts smoke tests can assert are present in plainText. These live with
  // the fixture so tests can grep for them authoritatively.
  factsCallout: string[]
}

const FIXTURES_LIST: FixtureContract[] = [
  {
    title: 'Globex — Mutual NDA',
    fixture: 'nda-globex.txt',
    type: 'NDA',
    status: 'EXECUTED',
    counterpartyName: 'Globex Industries',
    value: null,
    currency: 'USD',
    effectiveDate: new Date('2026-03-01'),
    expiryDate:    new Date('2028-03-01'),
    riskScore: 0.12,
    summary: 'Mutual non-disclosure agreement between Demo Org and Globex Industries. 2-year term, $50,000 liquidated damages per breach, California governing law.',
    keyTerms: {
      governingLaw: 'California',
      term: '2 years',
      liquidatedDamages: '$50,000',
      confidentialityDuration: '5 years post-termination',
      noticePeriod: '30 days',
    },
    tags: ['nda', 'ai-demo', 'executed'],
    factsCallout: [
      '$50,000 liquidated damages per breach',
      '2-year term',
      'California governing law',
      '30-day termination notice',
    ],
  },
  {
    title: 'Acme Corporation — Master Services Agreement',
    fixture: 'msa-acme.txt',
    type: 'MSA',
    status: 'EXECUTED',
    counterpartyName: 'Acme Corporation',
    value: 250_000,
    currency: 'USD',
    effectiveDate: new Date('2026-01-15'),
    expiryDate:    new Date('2028-01-14'),
    riskScore: 0.28,
    summary: 'Master services agreement with Acme Corporation. Delaware law, $500,000 liability cap with carve-outs for confidentiality and indemnification, auto-renews 1-year with 90-day notice of non-renewal, JAMS arbitration in Wilmington.',
    keyTerms: {
      governingLaw: 'Delaware',
      initialTerm: '2 years',
      autoRenew: true,
      noticeOfNonRenewal: '90 days',
      liabilityCap: '$500,000',
      liabilityCarveOuts: ['indemnification', 'confidentiality', 'gross negligence or willful misconduct'],
      paymentTerms: 'Net 30',
      disputeResolution: 'JAMS arbitration (Wilmington, DE)',
    },
    tags: ['msa', 'ai-demo', 'executed', 'enterprise'],
    factsCallout: [
      '$500,000 liability cap',
      '90-day notice of non-renewal',
      'Net 30 payment terms',
      'Delaware governing law',
      'JAMS arbitration',
      'Professional liability insurance of $5,000,000',
    ],
  },
  {
    title: 'Umbrella Corporation — SLA',
    fixture: 'sla-umbrella.txt',
    type: 'SLA',
    status: 'EXECUTED',
    counterpartyName: 'Umbrella Corporation',
    value: null,
    currency: 'USD',
    effectiveDate: new Date('2026-02-01'),
    expiryDate:    null,
    riskScore: 0.45,
    summary: 'Service level agreement with Umbrella Corporation for the analytics platform. 99.9% monthly uptime target, tiered service credits (10% / 25% / 50%), 15-minute Sev 1 response, 4-hour RPO / 12-hour RTO, SOC 2 Type II.',
    keyTerms: {
      uptimeTarget: '99.9%',
      sev1ResponseTime: '15 minutes',
      sev1ResolutionTarget: '4 hours',
      serviceCreditTiers: { '<99.9%': '10%', '<99.0%': '25%', '<95.0%': '50%' },
      rpo: '4 hours',
      rto: '12 hours',
      securityCertification: 'SOC 2 Type II',
      incidentNotificationWindow: '48 hours',
    },
    tags: ['sla', 'ai-demo', 'executed'],
    factsCallout: [
      '99.9% monthly uptime target',
      '15-minute Sev 1 response',
      '4-hour Recovery Point Objective',
      '12-hour Recovery Time Objective',
      'SOC 2 Type II certification',
      '48-hour incident notification',
    ],
  },
  {
    title: 'Stark Industries — SOW #12 (Arc Reactor Integration)',
    fixture: 'sow-stark.txt',
    type: 'SOW',
    status: 'EXECUTED',
    counterpartyName: 'Stark Industries',
    value: 85_000,
    currency: 'USD',
    effectiveDate: new Date('2026-01-15'),
    expiryDate:    new Date('2026-03-31'),
    riskScore: 0.18,
    summary: 'Fixed-fee statement of work for the Arc Reactor Integration project. 5 milestones, $85,000 total fee, Net 30 payment, 90-day warranty on integration code.',
    keyTerms: {
      totalFee: '$85,000',
      milestones: 5,
      paymentTerms: 'Net 30',
      warrantyPeriod: '90 days',
      duration: 'Jan 15 – Mar 31, 2026',
      keyPersonnel: ['Jessica Wu', 'Raj Patel'],
    },
    tags: ['sow', 'ai-demo', 'executed', 'consulting'],
    factsCallout: [
      '5 milestones',
      '$85,000 total fixed fee',
      'Net 30 payment terms',
      '90-day warranty on integration code',
      'Jessica Wu is a Key Personnel',
    ],
  },

  // ── Launch-video portfolio comparables ─────────────────────────────────────
  // Four executed 8–11 week SOWs clustered around the $145k median so the
  // launch-video portfolio-query demo ("Vendor quoted us $200k — fair?")
  // returns a real comparison. Add a contract here only if it should appear
  // in that comparison.
  {
    title: 'Vertex Cloud Holdings — SOW #04 (Multi-Region Data Pipeline)',
    fixture: 'sow-vertex-cloud-132k.txt',
    type: 'SOW',
    status: 'EXECUTED',
    counterpartyName: 'Vertex Cloud Holdings',
    value: 132_000,
    currency: 'USD',
    effectiveDate: new Date('2026-02-16'),
    expiryDate:    new Date('2026-04-10'),
    riskScore: 0.16,
    summary: 'Multi-region streaming data pipeline build for Vertex Cloud — 8 weeks, 4 milestones, $132,000 total fee, Net 30. Migrates 12 legacy batch jobs to streaming with cross-region failover.',
    keyTerms: {
      totalFee: '$132,000',
      milestones: 4,
      paymentTerms: 'Net 30',
      duration: '8 weeks (Feb 16 – Apr 10, 2026)',
      keyPersonnel: ['Sam Okafor', 'Priya Raman'],
    },
    tags: ['sow', 'ai-demo', 'executed', 'data-engineering', 'portfolio-comparable'],
    factsCallout: [
      '$132,000 total fixed fee',
      '8-week duration',
      '4 milestones',
      'Multi-region streaming pipeline (us-east-1 + us-west-2)',
    ],
  },
  {
    title: 'Caldera Health Networks — SOW #07 (HIPAA EHR Integration)',
    fixture: 'sow-caldera-health-148k.txt',
    type: 'SOW',
    status: 'EXECUTED',
    counterpartyName: 'Caldera Health Networks',
    value: 148_000,
    currency: 'USD',
    effectiveDate: new Date('2026-02-02'),
    expiryDate:    new Date('2026-04-17'),
    riskScore: 0.34,
    summary: 'HIPAA-compliant FHIR R4 EHR integration for Caldera Health — 11 weeks, 4 milestones, $148,000 total fee, Net 45 (healthcare addendum). Includes PHI tokenization and pen-test.',
    keyTerms: {
      totalFee: '$148,000',
      milestones: 4,
      paymentTerms: 'Net 45',
      duration: '11 weeks (Feb 2 – Apr 17, 2026)',
      keyPersonnel: ['Aisha Bello', 'Marcus Hu'],
    },
    tags: ['sow', 'ai-demo', 'executed', 'healthcare', 'hipaa', 'portfolio-comparable'],
    factsCallout: [
      '$148,000 total fixed fee',
      '11-week duration',
      'HIPAA-compliant FHIR R4 integration',
      'PHI tokenization with rotating keys',
      'Net 45 payment terms (healthcare addendum)',
    ],
  },
  {
    title: 'Ironbridge Industrial Group — SOW #03 (Supply-Chain ERP Integration)',
    fixture: 'sow-ironbridge-142k.txt',
    type: 'SOW',
    status: 'EXECUTED',
    counterpartyName: 'Ironbridge Industrial Group',
    value: 142_000,
    currency: 'USD',
    effectiveDate: new Date('2025-12-01'),
    expiryDate:    new Date('2026-01-30'),
    riskScore: 0.22,
    summary: 'SAP ERP integration with three supplier portals via EDI X12 (850/855/856/810) for Ironbridge — 9 weeks, 4 milestones, $142,000 total fee, Net 30.',
    keyTerms: {
      totalFee: '$142,000',
      milestones: 4,
      paymentTerms: 'Net 30',
      duration: '9 weeks (Dec 1, 2025 – Jan 30, 2026)',
      keyPersonnel: ['Diego Salinas', 'Yuki Tanaka'],
    },
    tags: ['sow', 'ai-demo', 'executed', 'erp', 'supply-chain', 'portfolio-comparable'],
    factsCallout: [
      '$142,000 total fixed fee',
      '9-week duration',
      'SAP integration with 3 supplier portals',
      'EDI X12 transactions (850, 855, 856, 810)',
    ],
  },
  {
    title: 'Lumen Bio — SOW #08 (LIMS Modernization & Genomics Data Lake)',
    fixture: 'sow-lumen-bio-158k.txt',
    type: 'SOW',
    status: 'EXECUTED',
    counterpartyName: 'Lumen Bio, Inc.',
    value: 158_000,
    currency: 'USD',
    effectiveDate: new Date('2026-03-16'),
    expiryDate:    new Date('2026-05-22'),
    riskScore: 0.31,
    summary: 'Cloud LIMS migration + genomics data lake build for Lumen Bio — 10 weeks, 4 milestones, $158,000 total fee, Net 30. Includes GxP / 21 CFR Part 11 validation.',
    keyTerms: {
      totalFee: '$158,000',
      milestones: 4,
      paymentTerms: 'Net 30',
      duration: '10 weeks (Mar 16 – May 22, 2026)',
      keyPersonnel: ['Hina Sato', 'Priya Raman'],
    },
    tags: ['sow', 'ai-demo', 'executed', 'lifesciences', 'gxp', 'portfolio-comparable'],
    factsCallout: [
      '$158,000 total fixed fee',
      '10-week duration',
      'Cloud LIMS + genomics data lake',
      'GxP / 21 CFR Part 11 validation',
    ],
  },

  // ── The vendor quote being evaluated in the launch video ───────────────────
  // Status IN_REVIEW (not EXECUTED) — this is the "we just got this quote, is
  // it fair?" doc that triggers the portfolio comparison.
  {
    title: 'Helix Systems — Project Lattice (DRAFT, vendor quote)',
    fixture: 'sow-helix-200k.txt',
    type: 'SOW',
    status: 'IN_REVIEW',
    counterpartyName: 'Helix Systems, LLC',
    value: 200_000,
    currency: 'USD',
    effectiveDate: new Date('2026-06-01'),
    expiryDate:    new Date('2026-07-24'),
    riskScore: 0.62, // higher: 15% mobilization fee, no Key Personnel named, identical scope priced ~38% above comparables
    summary: 'INCOMING VENDOR QUOTE — Helix Systems proposal for an 8-week multi-region streaming data platform. $200,000 fixed fee. Status: under internal review. Compare against Vertex Cloud SOW #04 (identical scope, $132k).',
    keyTerms: {
      totalFee: '$200,000',
      milestones: 4,
      paymentTerms: 'Net 30 + 15% non-refundable mobilization fee on execution',
      duration: '8 weeks (Jun 1 – Jul 24, 2026, proposed)',
      vendor: 'Helix Systems, LLC',
      keyPersonnel: 'Not named (TBD)',
    },
    tags: ['sow', 'ai-demo', 'in-review', 'vendor-quote', 'portfolio-subject'],
    factsCallout: [
      '$200,000 proposed total fixed fee',
      '8-week duration (same scope as Vertex Cloud SOW #04 at $132k)',
      '15% non-refundable mobilization fee on execution',
      'No Key Personnel named',
      'Quote valid for 30 days',
    ],
  },
]

async function findSeedAdmin() {
  const admin = await prisma.user.findFirst({
    where: { email: 'admin@demo.com' },
    select: { id: true, orgId: true },
  })
  if (!admin) {
    throw new Error('seed user admin@demo.com not found — run the baseline `pnpm prisma db seed` first')
  }
  // Wave E.3 — the fixture bodies write "Demo Org, Inc." as the user's
  // side of every contract. The counterparty-pick heuristic in the review
  // agent filters out parties whose name matches the Organization row's
  // name. If the DB org name is anything else (the admin seed historically
  // set it to "Acme" in some runs) the filter can't identify "us" and ends
  // up saving "Demo Org, Inc." as the counterparty. Realign here so the
  // AI-demo seed is the authoritative source of truth for the user org.
  await prisma.organization.update({
    where: { id: admin.orgId },
    data: { name: 'Demo Org, Inc.' },
  })
  return admin
}

async function clearAiDemoContracts(orgId: string) {
  // Find every contract matching our canonical titles.
  const titles = FIXTURES_LIST.map(f => f.title)
  const toDelete = await prisma.contract.findMany({
    where: { orgId, title: { in: titles } },
    select: { id: true },
  })
  const ids = toDelete.map(c => c.id)
  if (ids.length === 0) return 0

  // Wipe dependent rows before the contracts themselves.
  //
  // Order matters:
  //   1. ContractClause is keyed to versionId (not contractId) — delete via
  //      version lookup
  //   2. ContractShareLink / ContractComment / VersionDiffCache / ApprovalInstance
  //      are keyed directly on contractId
  //   3. Null out Contract.currentVersionId before deleting ContractVersion
  //      so the self-referential FK doesn't block deletion
  //   4. Delete ContractVersion by contractId
  //   5. Delete Contract
  const versionIds = (await prisma.contractVersion.findMany({
    where: { contractId: { in: ids } },
    select: { id: true },
  })).map(v => v.id)

  if (versionIds.length > 0) {
    await prisma.contractClause.deleteMany({ where: { versionId: { in: versionIds } } })
  }
  await prisma.contractComment.deleteMany({   where: { contractId: { in: ids } } })
  await prisma.contractShareLink.deleteMany({ where: { contractId: { in: ids } } })
  await prisma.versionDiffCache.deleteMany({  where: { contractId: { in: ids } } })
  // Z9 — rows a demo leaves on these contracts, which blocked a re-seed: an
  // approval's steps, a signature request's signers and events. Invoices and
  // other contracts are unlinked, not deleted.
  await prisma.approvalStep.deleteMany({      where: { instance: { contractId: { in: ids } } } })
  await prisma.approvalInstance.deleteMany({  where: { contractId: { in: ids } } })
  const requestIds = (await prisma.signatureRequest.findMany({ where: { contractId: { in: ids } }, select: { id: true } })).map(r => r.id)
  await prisma.signatureEvent.deleteMany({    where: { signatureRequestId: { in: requestIds } } })
  await prisma.signer.deleteMany({            where: { signatureRequestId: { in: requestIds } } })
  await prisma.signatureRequest.deleteMany({  where: { id: { in: requestIds } } })
  await prisma.invoice.updateMany({           where: { contractId: { in: ids } }, data: { contractId: null } })
  await prisma.contract.updateMany({          where: { parentContractId: { in: ids } }, data: { parentContractId: null } })
  await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
  await prisma.contractVersion.deleteMany({   where: { contractId: { in: ids } } })
  await prisma.contract.deleteMany({ where: { id: { in: ids } } })
  // Z9 — and from search: a re-seed recreates these contracts under new ids,
  // and the old documents stayed, so search listed each twice, once as a 404.
  try {
    await es.deleteByQuery({ index: 'contracts', body: { query: { ids: { values: ids } } }, refresh: true })
    await es.deleteByQuery({ index: CLAUSES_INDEX, body: { query: { terms: { contractId: ids } } }, refresh: true })
  } catch (e) {
    console.warn(`  ⚠ search index not cleared (${(e as Error).message.slice(0, 80)}) — run backfill-es-index`)
  }
  return ids.length
}

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

function plainToHtml(text: string, title: string): string {
  // Keep it simple — one <h1>, then <p> per blank-line-separated paragraph.
  const paragraphs = text.split(/\n\s*\n/)
  return `<h1>${escapeHtml(title)}</h1>\n` + paragraphs.map(p =>
    `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`
  ).join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] as string))
}

async function seed(orgId: string, ownerId: string) {
  // Ensure counterparties exist (the demo seed creates them; if an AI-demo
  // run removed them earlier, we re-create with the minimal shape).
  for (const f of FIXTURES_LIST) {
    await prisma.counterparty.upsert({
      where: { orgId_name: { orgId, name: f.counterpartyName } },
      update: {},
      create: { orgId, name: f.counterpartyName },
    })
  }

  const cpLookup = new Map(
    (await prisma.counterparty.findMany({ where: { orgId } })).map(c => [c.name, c.id])
  )

  for (const f of FIXTURES_LIST) {
    const plainText = loadFixture(f.fixture)
    const htmlContent = plainToHtml(plainText, f.title)

    const contract = await prisma.contract.create({
      data: {
        orgId,
        ownerId,
        title: f.title,
        type: f.type,
        status: f.status,
        counterpartyId: cpLookup.get(f.counterpartyName),
        counterpartyName: f.counterpartyName,
        value: f.value ?? undefined,
        currency: f.currency,
        effectiveDate: f.effectiveDate,
        expiryDate: f.expiryDate,
        riskScore: f.riskScore,
        summary: f.summary,
        keyTerms: f.keyTerms,
        tags: f.tags,
        analysisStatus: 'DONE',
      },
    })

    // Render a real PDF from the fixture HTML via Gotenberg + upload to
    // MinIO. If Gotenberg is down we fall back to a text-only version so
    // the seed still completes (the tool tests don't need the PDF — only
    // the user-facing "Original" toggle does).
    let s3Key: string | null = null
    let fileSize: number | null = null
    try {
      const res = await renderHtmlToPdfAndStore({
        html: htmlContent,
        keyPrefix: `${orgId}/contracts/${contract.id}/original`,
        filename: `${f.type.toLowerCase()}.pdf`,
      })
      s3Key = res.s3Key
      fileSize = res.size
    } catch (e) {
      console.warn(`  ⚠ Gotenberg render failed for ${f.title}: ${(e as Error).message} — skipping PDF`)
    }

    const version = await prisma.contractVersion.create({
      data: {
        contractId: contract.id,
        versionNumber: 1,
        htmlContent,
        plainText,
        changeNote: 'AI-demo seed — fixture body',
        createdById: ownerId,
        s3Key,
        mimeType: s3Key ? 'application/pdf' : null,
        fileSize,
      },
    })

    await prisma.contract.update({
      where: { id: contract.id },
      data: { currentVersionId: version.id },
    })

    // Z9 — clause rows from the fixture's numbered sections, so the Clauses
    // tab, clause search and the playbook check work before any analysis.
    // Analysis, when run, replaces them with typed and rated clauses.
    const clauses = []
    for (const [i, section] of numberedSections(plainText).entries()) {
      clauses.push(await prisma.contractClause.create({
        data: { versionId: version.id, clauseType: section.clauseType, content: section.content, sectionRef: `Section ${section.number}`, sortOrder: i },
        select: { id: true, clauseType: true, content: true, sortOrder: true },
      }))
    }
    let clauseInfo = `${clauses.length} clauses`
    try {
      await legalChunkAndStore(version.id, contract.id, orgId, clauses, {
        title: f.title, type: f.type, jurisdiction: (f.keyTerms as { governingLaw?: string } | undefined)?.governingLaw ?? null,
      })
    } catch (e) {
      clauseInfo += `, not in clause search (${(e as Error).message.slice(0, 80)})`
    }

    const lenKb = (plainText.length / 1024).toFixed(1)
    const pdfInfo = s3Key ? `, PDF ${(fileSize! / 1024).toFixed(1)} KB → ${s3Key}` : ', no PDF'
    console.log(`  ✓ ${f.type.padEnd(4)} ${f.title}  (${lenKb} KB plainText${pdfInfo}, ${clauseInfo})`)
  }
}

async function main() {
  const mode = process.argv[2] ?? 'seed'
  if (!['seed', 'clear'].includes(mode)) {
    console.error('Usage: seed-ai-demo.ts [seed|clear]')
    process.exit(1)
  }

  const admin = await findSeedAdmin()
  const removed = await clearAiDemoContracts(admin.orgId)
  if (removed > 0) console.log(`  (removed ${removed} prior AI-demo contract(s))`)

  if (mode === 'clear') {
    console.log('✓ AI-demo contracts cleared')
    await prisma.$disconnect()
    return
  }

  // Make sure the MinIO bucket exists before any upload — a fresh dev box
  // without prior /health probes hasn't triggered this yet.
  try { await ensureBucket() } catch (e) {
    console.warn(`  ⚠ ensureBucket failed: ${(e as Error).message} — PDFs will be skipped`)
  }

  await seed(admin.orgId, admin.id)
  console.log(`✓ AI-demo seed complete: ${FIXTURES_LIST.length} contract(s) created in org ${admin.orgId}`)

  // D.4.2 — also refresh the built-in skill catalog so a fresh demo env
  // boots with the 9 built-ins registered (the hero chips + rail @mention
  // autocomplete depend on this).
  await seedBuiltInSkills(prisma, msg => console.log(`  ${msg}`))

  // P1.2 — structured playbook rules for the Limitation of Liability
  // category so playbook_check emits concrete violations, not just prose
  // comparison.
  await seedPlaybookRules(prisma, msg => console.log(`  ${msg}`))

  await prisma.$disconnect()
}

main().catch(async e => {
  console.error('seed-ai-demo failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
