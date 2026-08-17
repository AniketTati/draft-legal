/**
 * seed-personas.ts — seed 5 customer personas (Vertex Cloud, Caldera Health,
 * Ironbridge Industrial, Lumen Bio, Beacon Logistics) with realistic users,
 * counterparties, contracts, and matters. ~800 contracts total.
 *
 * Designed for stress-testing the agent against real-world buyer profiles.
 * Personas are synthesized from competitor case studies (Ironclad, Icertis,
 * LinkSquares, Evisort, SpotDraft) — see docs/research/personas.md.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/seed-personas.ts            # seed all 5
 *   pnpm tsx --env-file=.env scripts/seed-personas.ts vertex     # seed one
 *   pnpm tsx --env-file=.env scripts/seed-personas.ts clear      # wipe all 5 orgs
 *   pnpm tsx --env-file=.env scripts/seed-personas.ts clear vertex  # wipe one
 *
 * All persona users login with password: password123
 *
 * Idempotent: orgs/users/counterparties upsert; contracts skip if title exists.
 */
import { PrismaClient, Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { seedOrgDefaults } from '../src/lib/org-seed.js'
import { DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLE_DESCRIPTIONS } from '../src/lib/permissions.js'
import { indexContract } from '../src/lib/elasticsearch.js'

const prisma = new PrismaClient()

// ─── Types ──────────────────────────────────────────────────────────────────

type StatusEnum =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'UNDER_NEGOTIATION'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PENDING_SIGNATURE'
  | 'EXECUTED'
  | 'EXPIRED'
  | 'TERMINATED'
  | 'ARCHIVED'

type ContractTypeEnum =
  | 'NDA' | 'MSA' | 'SOW' | 'SLA' | 'VENDOR_AGREEMENT' | 'EMPLOYMENT'
  | 'PARTNERSHIP' | 'LICENSE' | 'DATA_PROCESSING' | 'ORDER_FORM' | 'OTHER'

type RoleName = 'ADMIN' | 'LEGAL_COUNSEL' | 'LEGAL_OPS' | 'CONTRACT_MANAGER' | 'APPROVER' | 'VIEWER'

interface PersonaUser {
  name: string
  email: string
  role: RoleName
  ownerWeight: number   // contract-owner share (0–100); persona total ≤ 100
  jobTitle: string
}

interface DocSpec {
  /** Display label, used in title and tags ("Mutual NDA", "Business Associate Agreement") */
  label: string
  /** Maps to ContractType enum */
  type: ContractTypeEnum
  /** How many contracts to seed of this kind */
  count: number
  /** Value range (USD); null = no value field (e.g. NDAs) */
  valueRange: [number, number] | null
  /** Tags applied to every contract */
  tags: string[]
  /** Body template — uses {{counterparty}} / {{value}} / {{effectiveDate}} / {{expiryDate}} / {{governingLaw}} */
  body: string
  /** Average risk score (0–1); we vary ±0.15 around it */
  baseRisk: number
}

interface MatterSpec {
  name: string
  description: string
  contractCount: number
  /** If set, prefer contracts with one of these counterparties (substring match) */
  preferredCounterparties?: string[]
  status?: 'OPEN' | 'CLOSED' | 'ARCHIVED'
}

interface Persona {
  slug: string
  name: string
  domain: string
  industry: string
  subscriptionTier: 'PRO' | 'ENTERPRISE'
  /** Free-form context shown in console */
  blurb: string
  users: PersonaUser[]
  /** Mix of customers, vendors, and partners — drawn at random for each contract */
  counterparties: string[]
  /** Counterparties that should appear in 3+ contracts (creates exposure-roll-up signal) */
  keyCounterparties: string[]
  /** Status distribution — values are weights (do not need to sum to 100) */
  statusDistribution: Record<StatusEnum, number>
  /** Document mix — sum of counts = total contract count */
  docs: DocSpec[]
  matters: MatterSpec[]
  /** Per-persona PRNG seed for determinism */
  seed: number
  /** Governing-law jurisdictions to spread across contracts */
  jurisdictions: string[]
}

// ─── Body templates ─────────────────────────────────────────────────────────

const BODY_NDA = `<h2>Mutual Non-Disclosure Agreement</h2>
<p>This Mutual Non-Disclosure Agreement ("Agreement") is entered into as of {{effectiveDate}} by and between {{companyName}} and {{counterparty}} (each a "Party"). The purpose of this Agreement is to protect Confidential Information exchanged in connection with potential business discussions between the Parties.</p>
<h3>1. Confidential Information</h3>
<p>"Confidential Information" means any non-public business, technical, financial, or product information disclosed by a Party in writing, orally, or by inspection. The receiving Party shall hold such information in strict confidence using the same degree of care it uses to protect its own information of similar nature, but no less than reasonable care.</p>
<h3>2. Term</h3>
<p>This Agreement is effective as of {{effectiveDate}} and shall remain in effect until {{expiryDate}}. Confidentiality obligations survive termination for a period of three (3) years.</p>
<h3>3. Governing Law</h3>
<p>This Agreement is governed by the laws of the State of {{governingLaw}} without regard to conflict-of-law principles. Any disputes shall be resolved in the state and federal courts located in {{governingLaw}}.</p>`

const BODY_MSA = `<h2>Master Services Agreement</h2>
<p>This Master Services Agreement ("Agreement") is entered into between {{companyName}} ("Provider") and {{counterparty}} ("Client") effective {{effectiveDate}}. This Agreement governs all services rendered to Client through one or more Statements of Work.</p>
<h3>1. Services & SOWs</h3>
<p>Provider shall perform services described in mutually executed Statements of Work. In any conflict between this Agreement and an SOW, this Agreement controls unless the SOW expressly states otherwise.</p>
<h3>2. Fees & Payment</h3>
<p>Total committed value: \${{value}} over the initial term. Invoices are due net thirty (30) days. Late amounts accrue 1.5% interest per month.</p>
<h3>3. Limitation of Liability</h3>
<p>EACH PARTY'S AGGREGATE LIABILITY UNDER THIS AGREEMENT SHALL NOT EXCEED THE FEES PAID OR PAYABLE IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM. NEITHER PARTY SHALL BE LIABLE FOR INDIRECT, CONSEQUENTIAL, OR PUNITIVE DAMAGES.</p>
<h3>4. Term & Termination</h3>
<p>Effective {{effectiveDate}}; expires {{expiryDate}}. Either Party may terminate for material breach upon thirty (30) days' written notice if the breach remains uncured.</p>
<h3>5. Governing Law</h3>
<p>Governed by the laws of {{governingLaw}}; venue in {{governingLaw}}.</p>`

const BODY_SOW = `<h2>Statement of Work</h2>
<p>This Statement of Work ("SOW") is entered into pursuant to the Master Services Agreement between {{companyName}} and {{counterparty}}, effective {{effectiveDate}}. Period of performance: {{effectiveDate}} through {{expiryDate}}.</p>
<h3>Scope</h3>
<p>Provider shall deliver the services and deliverables described herein for a total fixed fee of \${{value}}. Acceptance criteria are mutually agreed in writing. Change orders require written sign-off from both Parties.</p>
<h3>Payment Schedule</h3>
<p>50% upon execution; 50% upon final acceptance.</p>
<h3>Governing Terms</h3>
<p>This SOW is governed by the parent MSA. Governing law: {{governingLaw}}.</p>`

const BODY_DPA = `<h2>Data Processing Addendum</h2>
<p>This Data Processing Addendum ("DPA") supplements the master agreement between {{companyName}} (Processor) and {{counterparty}} (Controller) effective {{effectiveDate}}. This DPA describes the processing of Personal Data on behalf of Controller.</p>
<h3>1. Subject Matter & Duration</h3>
<p>Effective from {{effectiveDate}} through {{expiryDate}}, or until termination of the underlying agreement, whichever is later. Processing is limited to the scope necessary to provide the services.</p>
<h3>2. Sub-processors</h3>
<p>Processor maintains a list of approved sub-processors and notifies Controller at least thirty (30) days prior to onboarding new sub-processors. Controller may object on reasonable grounds.</p>
<h3>3. Data Subject Rights & Breach Notification</h3>
<p>Processor shall assist Controller in responding to data subject requests and shall notify Controller of any Personal Data Breach without undue delay and in any case within seventy-two (72) hours of becoming aware.</p>
<h3>4. Cross-Border Transfers</h3>
<p>Where Personal Data is transferred outside the EEA/UK, the Standard Contractual Clauses (2021/914) apply. Governing law: {{governingLaw}}.</p>`

const BODY_BAA = `<h2>Business Associate Agreement</h2>
<p>This Business Associate Agreement ("BAA") is entered into between {{counterparty}} ("Covered Entity") and {{companyName}} ("Business Associate") effective {{effectiveDate}}, pursuant to the Health Insurance Portability and Accountability Act of 1996 ("HIPAA") and the HITECH Act.</p>
<h3>1. Permitted Uses & Disclosures</h3>
<p>Business Associate may use or disclose Protected Health Information ("PHI") only as necessary to perform services for Covered Entity, as required by law, or as otherwise permitted under HIPAA.</p>
<h3>2. Safeguards</h3>
<p>Business Associate shall implement administrative, physical, and technical safeguards in accordance with the HIPAA Security Rule (45 CFR Part 164, Subpart C) to protect PHI.</p>
<h3>3. Breach Notification</h3>
<p>Business Associate shall notify Covered Entity of any Breach of Unsecured PHI without unreasonable delay and in no event later than thirty (30) days from discovery.</p>
<h3>4. Sub-contractors</h3>
<p>Business Associate shall ensure all sub-contractors handling PHI agree to terms substantially similar to those herein.</p>
<h3>5. Term & Termination</h3>
<p>Effective {{effectiveDate}}; expires {{expiryDate}}. Upon termination, Business Associate shall return or destroy all PHI received under this BAA. Governing law: {{governingLaw}}.</p>`

const BODY_VENDOR = `<h2>Vendor Services Agreement</h2>
<p>This Vendor Services Agreement is entered into between {{companyName}} ("Customer") and {{counterparty}} ("Vendor") effective {{effectiveDate}}.</p>
<h3>Services & Fees</h3>
<p>Vendor shall provide the services described in the applicable order form for a total fee of \${{value}} over the term. Customer shall have a perpetual, royalty-free license to use deliverables paid for under this Agreement.</p>
<h3>Indemnification</h3>
<p>Vendor shall defend, indemnify, and hold Customer harmless against third-party claims arising from Vendor's gross negligence, willful misconduct, or breach of confidentiality. Customer's reciprocal indemnity is limited to claims arising from Customer's misuse of the services.</p>
<h3>Term</h3>
<p>Effective {{effectiveDate}} through {{expiryDate}}. Auto-renewal upon ninety (90) days' notice.</p>
<h3>Governing Law</h3>
<p>{{governingLaw}}.</p>`

const BODY_SUPPLIER = `<h2>Supplier Master Agreement</h2>
<p>This Supplier Master Agreement is entered into between {{companyName}} ("Buyer") and {{counterparty}} ("Supplier") effective {{effectiveDate}}. This Agreement governs all purchase orders issued by Buyer for goods and services described in attached schedules.</p>
<h3>Pricing & Adjustments</h3>
<p>Pricing is firm for the initial twelve (12) months. Annual price adjustments are capped at the lesser of CPI or three percent (3%). Estimated annual spend: \${{value}}.</p>
<h3>Quality & Warranty</h3>
<p>Goods shall conform to specifications and be free of defects for a period of twelve (12) months from delivery. Buyer may reject non-conforming goods for full refund or replacement at Buyer's option.</p>
<h3>Force Majeure</h3>
<p>Neither Party is liable for delays caused by events beyond reasonable control, excluding ordinary supply-chain disruptions and currency fluctuations. Tariff and duty changes are NOT a force majeure event.</p>
<h3>Term</h3>
<p>Effective {{effectiveDate}}; expires {{expiryDate}}. Governing law: {{governingLaw}}.</p>`

const BODY_DISTRIBUTION = `<h2>Distribution & Reseller Agreement</h2>
<p>This Distribution Agreement is entered into between {{companyName}} ("Manufacturer") and {{counterparty}} ("Distributor") effective {{effectiveDate}}.</p>
<h3>Territory & Exclusivity</h3>
<p>Manufacturer grants Distributor a non-exclusive right to distribute the Products in the Territory. Annual minimum purchase commitment: \${{value}}.</p>
<h3>Pricing</h3>
<p>Distributor receives a discount of thirty percent (30%) off list. Pricing reviewed annually; ninety (90) days' notice required for material changes.</p>
<h3>Term</h3>
<p>{{effectiveDate}} – {{expiryDate}}. Renewable in twelve-month increments. Governing law: {{governingLaw}}.</p>`

const BODY_RESEARCH = `<h2>Sponsored Research Agreement</h2>
<p>This Sponsored Research Agreement ("Agreement") is entered into between {{companyName}} ("Sponsor") and {{counterparty}} ("Institution") effective {{effectiveDate}} for the conduct of the research project described in the attached Statement of Work.</p>
<h3>Funding</h3>
<p>Total funding committed: \${{value}}, payable in installments tied to milestone deliverables.</p>
<h3>Intellectual Property</h3>
<p>Inventions made solely by Institution personnel are owned by Institution; Sponsor receives a non-exclusive royalty-free license for internal research use and a first-negotiation option for an exclusive commercial license. Inventions made jointly are jointly owned.</p>
<h3>Publication</h3>
<p>Institution may publish results subject to Sponsor's right to review for patentable subject matter for thirty (30) days prior to submission.</p>
<h3>Term</h3>
<p>{{effectiveDate}} – {{expiryDate}}. Governed by the laws of {{governingLaw}}.</p>`

const BODY_MTA = `<h2>Material Transfer Agreement</h2>
<p>This Material Transfer Agreement ("MTA") is entered into between {{counterparty}} ("Provider") and {{companyName}} ("Recipient") effective {{effectiveDate}} for the transfer of biological or chemical materials described in Appendix A.</p>
<h3>Permitted Use</h3>
<p>Recipient shall use the Material solely for non-commercial internal research purposes for the duration of this Agreement. Recipient shall not transfer the Material to any third party without Provider's written consent.</p>
<h3>Term</h3>
<p>{{effectiveDate}} – {{expiryDate}}. Upon expiration, all unused Material shall be returned or destroyed. Governing law: {{governingLaw}}.</p>`

const BODY_EMPLOYMENT = `<h2>Employment Agreement & IP Assignment</h2>
<p>This Employment Agreement is entered into between {{companyName}} and {{counterparty}} effective {{effectiveDate}}. The annualized base compensation is \${{value}}.</p>
<h3>Duties & At-Will</h3>
<p>Employment is at-will and may be terminated by either Party at any time, with or without cause. Employee shall devote full business time and attention to the duties of their position.</p>
<h3>IP Assignment</h3>
<p>Employee hereby irrevocably assigns to Company all right, title, and interest in any inventions, works of authorship, or other intellectual property conceived or reduced to practice during employment that relate to Company's business.</p>
<h3>Confidentiality</h3>
<p>Employee acknowledges access to Confidential Information and agrees to maintain strict confidentiality during and after employment.</p>
<h3>Governing Law</h3>
<p>{{governingLaw}}. Effective {{effectiveDate}}.</p>`

const BODY_LICENSE = `<h2>License Agreement</h2>
<p>This License Agreement is entered into between {{companyName}} ("Licensor") and {{counterparty}} ("Licensee") effective {{effectiveDate}}. Total license consideration: \${{value}}.</p>
<h3>Grant</h3>
<p>Licensor grants Licensee a non-exclusive, non-transferable license to use the Licensed Technology in the Field for the Term, subject to the terms herein.</p>
<h3>Royalties</h3>
<p>Licensee shall pay royalties of five percent (5%) of Net Sales, with quarterly reporting and minimum annual payment of $50,000.</p>
<h3>Term</h3>
<p>{{effectiveDate}} – {{expiryDate}}. Renewable. Governing law: {{governingLaw}}.</p>`

const BODY_LEASE = `<h2>Lease Agreement</h2>
<p>This Lease Agreement is entered into between {{counterparty}} ("Landlord") and {{companyName}} ("Tenant") effective {{effectiveDate}} for the premises described in Exhibit A.</p>
<h3>Term & Rent</h3>
<p>Lease term: {{effectiveDate}} – {{expiryDate}}. Annual base rent: \${{value}}. CAM and operating expenses billed quarterly.</p>
<h3>Use</h3>
<p>Premises shall be used for warehouse and distribution operations. Tenant may install racking and conveyor systems subject to Landlord's reasonable approval.</p>
<h3>Insurance</h3>
<p>Tenant shall maintain commercial general liability insurance with limits of not less than $5,000,000 per occurrence.</p>
<h3>Governing Law</h3>
<p>{{governingLaw}}.</p>`

const BODY_CARRIER = `<h2>Carrier Transportation Services Agreement</h2>
<p>This Carrier Agreement is entered into between {{companyName}} ("Shipper") and {{counterparty}} ("Carrier") effective {{effectiveDate}}.</p>
<h3>Services</h3>
<p>Carrier shall provide motor/ocean freight services per the attached rate schedule. Estimated annual revenue: \${{value}}.</p>
<h3>Cargo Liability</h3>
<p>Carrier's liability for loss or damage to cargo is limited to $0.50 per pound, except as required by 49 U.S.C. § 14706 (Carmack). Shipper may declare excess value at the time of tender for additional coverage.</p>
<h3>Fuel Surcharge</h3>
<p>Fuel surcharge calculated weekly per the DOE National Average Diesel Index, capped at ten percent (10%) above base linehaul.</p>
<h3>Term</h3>
<p>{{effectiveDate}} – {{expiryDate}}. Governing law: {{governingLaw}}.</p>`

const BODY_CUSTOMER_SLA = `<h2>Customer Service Level Agreement</h2>
<p>This SLA is entered into between {{companyName}} ("Provider") and {{counterparty}} ("Customer") effective {{effectiveDate}}.</p>
<h3>Service Levels</h3>
<p>Provider commits to: (a) order fulfillment within 24 hours of tender; (b) on-time delivery of 98% (measured monthly); (c) inventory accuracy of 99.5%.</p>
<h3>Service Credits</h3>
<p>Failure to meet committed service levels in any month results in service credits equal to 5% of monthly fees per percentage point below commitment, up to 25% of monthly fees.</p>
<h3>Volume Commitments</h3>
<p>Customer commits to minimum annual volume of \${{value}} in revenue. Peak season (Nov-Jan) capacity reservation per Schedule B.</p>
<h3>Term</h3>
<p>{{effectiveDate}} – {{expiryDate}}. Governing law: {{governingLaw}}.</p>`

const BODY_LOI = `<h2>Letter of Intent — Acquisition</h2>
<p>This Letter of Intent ("LOI") is entered into between {{companyName}} ("Buyer") and {{counterparty}} ("Target") effective {{effectiveDate}}.</p>
<h3>Proposed Transaction</h3>
<p>Buyer proposes to acquire 100% of the issued and outstanding equity of Target for a base purchase price of \${{value}}, subject to customary purchase-price adjustments.</p>
<h3>Exclusivity</h3>
<p>Target agrees to a no-shop period of sixty (60) days from the date hereof during which Target shall not solicit or negotiate alternative transactions.</p>
<h3>Non-Binding</h3>
<p>Except for the Exclusivity, Confidentiality, and Governing Law provisions, this LOI is non-binding and does not obligate either Party to consummate the transaction.</p>
<h3>Governing Law</h3>
<p>{{governingLaw}}. Effective through {{expiryDate}}.</p>`

// ─── PRNG (Mulberry32) — deterministic per-persona generation ──────────────

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)]
const pickWeighted = <T>(items: T[], weights: number[], rng: () => number): T => {
  const total = weights.reduce((s, w) => s + w, 0)
  let r = rng() * total
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]
    if (r <= 0) return items[i]
  }
  return items[items.length - 1]
}
const between = (rng: () => number, min: number, max: number): number =>
  Math.round(min + rng() * (max - min))
const dateOffset = (today: Date, days: number): Date => {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

// Today is fixed for determinism: 2026-04-27. Override with SEED_TODAY=YYYY-MM-DD.
//
// The fixed anchor is what makes this corpus reproducible — same script, same
// database, every time — and it should stay the default. But it anchors the
// DATA while the agent answers relative to the real clock, so time-relative
// cases decay as the anchor recedes: the persona corpus asks "expiring in the
// next 90 days" four times and "renewal this year" twice, and those windows
// stop selecting the contracts they were written against.
//
// So: deterministic by default, refreshable on demand. The PRNG seed is
// unaffected, so the contract mix is identical either way — only the dates
// slide.
//
//   pnpm tsx --env-file=../../.env scripts/seed-personas.ts            # 2026-04-27
//   SEED_TODAY=$(date -u +%F) pnpm tsx ... scripts/seed-personas.ts    # today
const SEED_TODAY = process.env.SEED_TODAY
if (SEED_TODAY && Number.isNaN(Date.parse(`${SEED_TODAY}T00:00:00Z`))) {
  throw new Error(`SEED_TODAY must be YYYY-MM-DD, got ${JSON.stringify(SEED_TODAY)}`)
}
const TODAY = new Date(`${SEED_TODAY ?? '2026-04-27'}T00:00:00Z`)

// ─── Persona definitions ───────────────────────────────────────────────────

const VERTEX: Persona = {
  slug: 'vertex-cloud',
  name: 'Vertex Cloud',
  domain: 'vertex.cloud',
  industry: 'B2B SaaS — Observability & Data Infrastructure',
  subscriptionTier: 'PRO',
  blurb: 'Series C SaaS, 800 emp, ~$80M ARR. Sales-led + PLG. Reflects Ironclad/SpotDraft/LinkSquares mid-market sweet spot.',
  seed: 0xa1c2e3f4,
  jurisdictions: ['Delaware', 'California', 'New York'],
  users: [
    { name: 'Maya Chen', email: 'maya.chen@vertex.cloud', role: 'LEGAL_COUNSEL', ownerWeight: 25, jobTitle: 'General Counsel' },
    { name: 'Priya Patel', email: 'priya.patel@vertex.cloud', role: 'LEGAL_COUNSEL', ownerWeight: 35, jobTitle: 'Senior Counsel, Commercial' },
    { name: 'David Kim', email: 'david.kim@vertex.cloud', role: 'LEGAL_OPS', ownerWeight: 30, jobTitle: 'Legal Operations Manager' },
    { name: 'Sara Nguyen', email: 'sara.nguyen@vertex.cloud', role: 'CONTRACT_MANAGER', ownerWeight: 10, jobTitle: 'Sales Operations Director' },
  ],
  keyCounterparties: ['Snowflake', 'Stripe', 'Brex', 'Notion', 'Plaid', 'Ramp', 'AWS', 'Salesforce'],
  counterparties: [
    'Snowflake', 'Stripe', 'Brex', 'Notion', 'Loom', 'Asana', 'Linear', 'Vercel',
    'Plaid', 'Ramp', 'Mercury', 'Retool', 'Airtable', 'ClickUp', 'Monday.com',
    'Lattice', 'Rippling', 'Front', 'Pitch', 'Sourcegraph', 'PagerDuty',
    'Datadog', 'New Relic', 'Splunk', 'Elastic', 'Confluent', 'MongoDB Atlas',
    'AWS', 'Google Cloud', 'Microsoft Azure', 'Salesforce', 'HubSpot', 'Segment',
    'Twilio', 'SendGrid', 'Slack', 'Zoom', 'Okta', '1Password', 'Lattice',
    'Crossbeam', 'Vitally', 'Klue', 'Outreach', 'Gong', 'Chorus', 'Clari',
    'First Republic Tech', 'SVB Capital', 'TechCorp Holdings',
    'Deloitte Digital', 'Accenture', 'Slalom Consulting', 'BCG Digital Ventures',
    'Acme SaaS', 'Globex Industries', 'Initech', 'Massive Dynamic',
    'Cyrus Cybersecurity', 'Helios Energy', 'Northwind Logistics',
    'Sigma Analytics', 'Tarsus Robotics', 'Kepler Bio', 'Atlas Geo',
    'Lumos Lighting', 'Phoenix Foundry', 'Orion Health',
    'Zephyr Networks', 'Nimbus Cloud', 'Cobalt Cybersecurity',
    'Tessera Genomics', 'Verge Media', 'Quartile Marketing',
    'Sienna Brands', 'Maelstrom Games', 'Holos Imaging',
    'Pinnacle Wealth', 'Rivulet Streaming', 'Caldera Compute',
    'Beacon Holdings', 'Northstar Ventures', 'Apex Strategy',
  ],
  statusDistribution: {
    DRAFT: 5, PENDING_REVIEW: 5, UNDER_NEGOTIATION: 8, PENDING_APPROVAL: 5,
    APPROVED: 4, PENDING_SIGNATURE: 3, EXECUTED: 60, EXPIRED: 8, TERMINATED: 1, ARCHIVED: 1,
  },
  docs: [
    { label: 'Mutual NDA', type: 'NDA', count: 60, valueRange: null, tags: ['nda', 'mutual'], body: BODY_NDA, baseRisk: 0.10 },
    { label: 'Master Services Agreement', type: 'MSA', count: 30, valueRange: [50_000, 1_500_000], tags: ['msa', 'enterprise'], body: BODY_MSA, baseRisk: 0.30 },
    { label: 'Order Form', type: 'ORDER_FORM', count: 22, valueRange: [25_000, 500_000], tags: ['order-form', 'sales'], body: BODY_SOW, baseRisk: 0.15 },
    { label: 'Data Processing Addendum', type: 'DATA_PROCESSING', count: 15, valueRange: null, tags: ['dpa', 'gdpr'], body: BODY_DPA, baseRisk: 0.25 },
    { label: 'Vendor MSA', type: 'VENDOR_AGREEMENT', count: 15, valueRange: [10_000, 200_000], tags: ['vendor', 'saas'], body: BODY_VENDOR, baseRisk: 0.20 },
    { label: 'Reseller Agreement', type: 'PARTNERSHIP', count: 5, valueRange: [50_000, 300_000], tags: ['partner', 'reseller'], body: BODY_DISTRIBUTION, baseRisk: 0.30 },
    { label: 'Employment Agreement', type: 'EMPLOYMENT', count: 3, valueRange: [120_000, 280_000], tags: ['employment', 'senior'], body: BODY_EMPLOYMENT, baseRisk: 0.10 },
  ],
  matters: [
    { name: 'Q2 2026 Enterprise Renewals', description: 'Renewal cohort for top-20 enterprise customers expiring Q2.', contractCount: 8, status: 'OPEN' },
    { name: 'Stripe Account Expansion', description: 'Multi-product expansion across Stripe entities.', contractCount: 4, preferredCounterparties: ['Stripe'], status: 'OPEN' },
    { name: 'Plaid Strategic Partnership', description: 'Embedded financial-data partnership negotiation.', contractCount: 3, preferredCounterparties: ['Plaid'], status: 'OPEN' },
    { name: 'GDPR DPA Refresh', description: 'Cross-org sweep to refresh DPAs with current sub-processor list.', contractCount: 6, status: 'OPEN' },
    { name: 'Snowflake Annual Review', description: 'Snowflake MSA + DPA + sub-processor review.', contractCount: 3, preferredCounterparties: ['Snowflake'], status: 'OPEN' },
  ],
}

const CALDERA: Persona = {
  slug: 'caldera-health',
  name: 'Caldera Health',
  domain: 'calderahealth.com',
  industry: 'Health SaaS — Clinical Operations & Interoperability',
  subscriptionTier: 'ENTERPRISE',
  blurb: 'Mid-market health SaaS, 600 emp, $60M ARR. HIPAA + SOC 2. Reflects Evisort regulated-industry sweet spot.',
  seed: 0xb2d3e4f5,
  jurisdictions: ['Delaware', 'New York', 'Massachusetts', 'California'],
  users: [
    { name: 'Dr. Lena Park', email: 'lena.park@calderahealth.com', role: 'LEGAL_COUNSEL', ownerWeight: 35, jobTitle: 'General Counsel' },
    { name: 'Marcus Hall', email: 'marcus.hall@calderahealth.com', role: 'LEGAL_OPS', ownerWeight: 25, jobTitle: 'Privacy Officer / DPO' },
    { name: 'Aisha Yusuf', email: 'aisha.yusuf@calderahealth.com', role: 'LEGAL_COUNSEL', ownerWeight: 30, jobTitle: 'Compliance Counsel' },
    { name: 'Tom Reilly', email: 'tom.reilly@calderahealth.com', role: 'CONTRACT_MANAGER', ownerWeight: 10, jobTitle: 'Procurement Lead' },
  ],
  keyCounterparties: ['Mayo Clinic', 'Cleveland Clinic', 'Kaiser Permanente', 'Pfizer', 'Cigna', 'AWS'],
  counterparties: [
    'Mayo Clinic', 'Cleveland Clinic', 'Kaiser Permanente', 'Ascension', 'HCA Healthcare',
    'NewYork-Presbyterian', 'Mass General Brigham', 'Northwell Health', 'Sutter Health',
    'Geisinger Health System', 'Intermountain Healthcare', 'Banner Health',
    'Pfizer', 'Moderna', 'Genentech', 'Eli Lilly', 'AbbVie', 'Bristol Myers Squibb',
    'Merck', 'Sanofi', 'Novartis', 'Roche', 'Vertex Pharmaceuticals',
    'Anthem', 'Aetna', 'Cigna', 'UnitedHealthcare', 'Humana', 'Centene', 'Molina Healthcare',
    'AWS HIPAA', 'Snowflake', 'Datavant', 'Komodo Health', 'Iron Mountain',
    'Twilio', 'Okta', 'Slack', 'Zoom', 'Stripe', 'Salesforce Health Cloud',
    'Epic Systems', 'Cerner', 'Athenahealth', 'Allscripts',
    'Carbon Health', 'Oscar Health', 'Devoted Health', 'Bright Health',
    'Veradigm', 'Health Catalyst', 'Innovaccer', 'Ribbon Health',
    'Memorial Hermann', 'Tampa General', 'UCSF Health', 'Stanford Health Care',
    'Vanguard Health', 'OneMedical', 'Iora Health', 'Eden Health',
    'Truepill', 'Capsule', 'Alto Pharmacy', 'PillPack',
    'Hinge Health', 'Omada Health', 'Lyra Health',
  ],
  statusDistribution: {
    DRAFT: 4, PENDING_REVIEW: 5, UNDER_NEGOTIATION: 7, PENDING_APPROVAL: 6,
    APPROVED: 3, PENDING_SIGNATURE: 2, EXECUTED: 65, EXPIRED: 5, TERMINATED: 2, ARCHIVED: 1,
  },
  docs: [
    { label: 'Business Associate Agreement', type: 'OTHER', count: 36, valueRange: null, tags: ['baa', 'hipaa', 'compliance'], body: BODY_BAA, baseRisk: 0.20 },
    { label: 'Data Processing Addendum', type: 'DATA_PROCESSING', count: 30, valueRange: null, tags: ['dpa', 'gdpr', 'sub-processor'], body: BODY_DPA, baseRisk: 0.25 },
    { label: 'Master Services Agreement', type: 'MSA', count: 24, valueRange: [100_000, 2_500_000], tags: ['msa', 'health-system'], body: BODY_MSA, baseRisk: 0.30 },
    { label: 'Vendor Agreement', type: 'VENDOR_AGREEMENT', count: 12, valueRange: [15_000, 300_000], tags: ['vendor'], body: BODY_VENDOR, baseRisk: 0.20 },
    { label: 'Mutual NDA', type: 'NDA', count: 12, valueRange: null, tags: ['nda', 'pre-deal'], body: BODY_NDA, baseRisk: 0.10 },
    { label: 'Pilot Agreement', type: 'OTHER', count: 4, valueRange: [50_000, 250_000], tags: ['pilot', 'pharma'], body: BODY_RESEARCH, baseRisk: 0.35 },
    { label: 'Research Partnership', type: 'OTHER', count: 2, valueRange: [200_000, 800_000], tags: ['research', 'rwe'], body: BODY_RESEARCH, baseRisk: 0.40 },
  ],
  matters: [
    { name: 'Ascension Multi-Site Rollout', description: 'BAA + MSA cohort for Ascension hospital network.', contractCount: 6, preferredCounterparties: ['Ascension'], status: 'OPEN' },
    { name: 'Pfizer Real-World Evidence Pilot', description: 'Research partnership + DPA + BAA stack.', contractCount: 4, preferredCounterparties: ['Pfizer'], status: 'OPEN' },
    { name: 'Q2 Privacy Compliance Review', description: 'Cross-org sweep of BAA/DPA/sub-processor disclosures.', contractCount: 12, status: 'OPEN' },
    { name: 'Mayo Clinic Annual Renewal', description: 'BAA + MSA renewal for Mayo Clinic relationship.', contractCount: 4, preferredCounterparties: ['Mayo Clinic'], status: 'OPEN' },
    { name: 'Payer Expansion Initiative', description: 'New BAA + MSA stack with Anthem, Aetna, Cigna.', contractCount: 8, preferredCounterparties: ['Anthem', 'Aetna', 'Cigna'], status: 'OPEN' },
  ],
}

const IRONBRIDGE: Persona = {
  slug: 'ironbridge-industrial',
  name: 'Ironbridge Industrial',
  domain: 'ironbridge-ind.com',
  industry: 'Industrial Manufacturing — HVAC + Steel Fabrication (PE-backed)',
  subscriptionTier: 'ENTERPRISE',
  blurb: 'PE-backed industrial mfr, 5,000 emp, $1.2B revenue, 6 acquired brands. Reflects Icertis procurement-led sweet spot.',
  seed: 0xc3e4f506,
  jurisdictions: ['Delaware', 'Michigan', 'Ohio', 'Texas', 'New York', 'Pennsylvania'],
  users: [
    { name: 'Margaret O\'Brien', email: 'margaret.obrien@ironbridge-ind.com', role: 'ADMIN', ownerWeight: 15, jobTitle: 'General Counsel & VP Legal' },
    { name: 'Raj Sharma', email: 'raj.sharma@ironbridge-ind.com', role: 'CONTRACT_MANAGER', ownerWeight: 20, jobTitle: 'Director of Procurement' },
    { name: 'Carla Mendez', email: 'carla.mendez@ironbridge-ind.com', role: 'CONTRACT_MANAGER', ownerWeight: 35, jobTitle: 'Senior Contracts Manager (Procurement)' },
    { name: 'James Wright', email: 'james.wright@ironbridge-ind.com', role: 'LEGAL_COUNSEL', ownerWeight: 10, jobTitle: 'M&A Counsel' },
    { name: 'Olivia Brennan', email: 'olivia.brennan@ironbridge-ind.com', role: 'CONTRACT_MANAGER', ownerWeight: 20, jobTitle: 'Plant Procurement Specialist (Akron)' },
  ],
  keyCounterparties: ['ArcelorMittal', 'Nucor', 'Honeywell', 'Bechtel', 'Turner Construction', 'Grainger', 'SAP'],
  counterparties: [
    'ArcelorMittal', 'Nucor', 'US Steel', 'Steel Dynamics', 'Cleveland-Cliffs',
    'Honeywell', 'Emerson Electric', 'Schneider Electric', 'Parker Hannifin',
    'GE Industrial', 'Eaton', 'ABB', 'Rockwell Automation', 'Festo', 'Siemens Industrial',
    'Bechtel', 'Turner Construction', 'Skanska USA', 'AECOM', 'Fluor Corporation',
    'Kiewit', 'Whiting-Turner', 'Suffolk Construction', 'McCarthy Building',
    'Mortenson', 'Clayco', 'PCL Construction',
    'W.W. Grainger', 'Fastenal', 'MSC Industrial', 'McMaster-Carr', 'Motion Industries',
    'SAP', 'Oracle', 'Workday', 'Coupa', 'ServiceNow', 'Microsoft 365', 'ADP',
    'XPO Logistics', 'Schneider National', 'J.B. Hunt', 'FedEx Freight',
    'Old Dominion Freight', 'YRC Worldwide', 'Estes Express',
    'Prologis', 'Duke Realty', 'EQT Exeter',
    'Acme Industrial', 'Project Beacon Target', 'Atlas Foundry', 'Phoenix Manufacturing',
    'Helios Energy Systems', 'Cyrus Industrial', 'Hephaestus Steel',
    'Vulcan Forge', 'Anvil Corp', 'Forge Holdings', 'IronWorks LLC',
    'Cascade Coatings', 'Summit Fabrication', 'Apex Industrial',
    'Pinnacle Manufacturing', 'Ridge Manufacturing', 'Bedrock Industries',
    'Lockheed Martin Industrial', 'Boeing Industrial', 'Caterpillar',
    'Deere Industrial', 'Komatsu', 'Hitachi Construction',
    'Liberty Mutual', 'Travelers Insurance', 'AIG Industrial', 'Chubb',
    'Wells Fargo Equipment', 'PNC Financial Services',
    'Tarsus Robotics', 'Lumos Industrial', 'Sienna Manufacturing',
    'Beacon Industrial Holdings', 'Northstar Steel', 'Apex Industrial Holdings',
    'Quincy Compressor', 'Sullair', 'Atlas Copco',
    'Mitsubishi Industrial', 'Hitachi Industrial', 'Kawasaki',
    'BlueOval Steel', 'Kalmar Industrial', 'Linde',
  ],
  statusDistribution: {
    DRAFT: 3, PENDING_REVIEW: 3, UNDER_NEGOTIATION: 5, PENDING_APPROVAL: 4,
    APPROVED: 2, PENDING_SIGNATURE: 2, EXECUTED: 70, EXPIRED: 8, TERMINATED: 2, ARCHIVED: 1,
  },
  docs: [
    { label: 'Supplier Master Agreement', type: 'VENDOR_AGREEMENT', count: 87, valueRange: [25_000, 8_000_000], tags: ['supplier', 'procurement'], body: BODY_SUPPLIER, baseRisk: 0.25 },
    { label: 'Master Services Agreement', type: 'MSA', count: 50, valueRange: [100_000, 5_000_000], tags: ['msa'], body: BODY_MSA, baseRisk: 0.30 },
    { label: 'Statement of Work', type: 'SOW', count: 37, valueRange: [50_000, 1_500_000], tags: ['sow', 'project'], body: BODY_SOW, baseRisk: 0.20 },
    { label: 'Distribution Agreement', type: 'PARTNERSHIP', count: 25, valueRange: [200_000, 3_000_000], tags: ['distribution'], body: BODY_DISTRIBUTION, baseRisk: 0.25 },
    { label: 'NDA', type: 'NDA', count: 25, valueRange: null, tags: ['nda', 'vendor'], body: BODY_NDA, baseRisk: 0.10 },
    { label: 'Letter of Intent', type: 'OTHER', count: 6, valueRange: [50_000_000, 250_000_000], tags: ['m&a', 'loi'], body: BODY_LOI, baseRisk: 0.50 },
    { label: 'Asset Purchase Agreement', type: 'OTHER', count: 6, valueRange: [40_000_000, 200_000_000], tags: ['m&a', 'apa'], body: BODY_LOI, baseRisk: 0.45 },
    { label: 'Equipment Lease', type: 'OTHER', count: 8, valueRange: [80_000, 1_200_000], tags: ['lease', 'equipment'], body: BODY_LEASE, baseRisk: 0.20 },
    { label: 'Executive Employment', type: 'EMPLOYMENT', count: 6, valueRange: [220_000, 600_000], tags: ['employment', 'senior'], body: BODY_EMPLOYMENT, baseRisk: 0.10 },
  ],
  matters: [
    { name: 'Akron Plant Annual Renewals', description: 'Supplier + MSA renewal cohort for Akron facility.', contractCount: 12, status: 'OPEN' },
    { name: 'Project Beacon Acquisition', description: 'NDAs + LOI + APA for pending acquisition.', contractCount: 4, preferredCounterparties: ['Project Beacon Target'], status: 'OPEN' },
    { name: '2026 Steel Tariff Response', description: 'Force-majeure + price-escalation review across steel suppliers.', contractCount: 10, preferredCounterparties: ['ArcelorMittal', 'Nucor', 'US Steel', 'Steel Dynamics'], status: 'OPEN' },
    { name: 'Detroit Plant Expansion', description: 'New equipment + lease + supplier contracts for Detroit expansion.', contractCount: 8, status: 'OPEN' },
    { name: 'Acme Industrial Acquisition', description: 'Closed acquisition — diligence complete, integration phase.', contractCount: 6, preferredCounterparties: ['Acme Industrial'], status: 'CLOSED' },
  ],
}

const LUMEN: Persona = {
  slug: 'lumen-bio',
  name: 'Lumen Bio',
  domain: 'lumenbio.com',
  industry: 'Biotech — Pre-clinical Antibody Discovery',
  subscriptionTier: 'PRO',
  blurb: 'Series A biotech, 80 emp, $35M raised, pre-IND. Reflects LinkSquares solo-GC + Evisort biotech sweet spot.',
  seed: 0xd4f50617,
  jurisdictions: ['Delaware', 'California', 'Massachusetts'],
  users: [
    { name: 'Dr. Aria Volkov', email: 'aria.volkov@lumenbio.com', role: 'ADMIN', ownerWeight: 70, jobTitle: 'General Counsel + Compliance' },
    { name: 'Ben Foster', email: 'ben.foster@lumenbio.com', role: 'LEGAL_OPS', ownerWeight: 25, jobTitle: 'Senior Paralegal' },
    { name: 'Dr. Hideo Yamamoto', email: 'hideo.yamamoto@lumenbio.com', role: 'APPROVER', ownerWeight: 5, jobTitle: 'Chief Scientific Officer' },
  ],
  keyCounterparties: ['Stanford University', 'Pfizer', 'Charles River Laboratories', 'Lonza'],
  counterparties: [
    'Stanford University', 'MIT', 'Harvard Medical School', 'UCSF',
    'Johns Hopkins University', 'MD Anderson Cancer Center',
    'Memorial Sloan Kettering', 'Dana-Farber Cancer Institute',
    'Scripps Research Institute', 'Salk Institute', 'Broad Institute',
    'Pfizer', 'Merck', 'Roche', 'Genentech', 'Bristol Myers Squibb',
    'AstraZeneca', 'Vertex Pharmaceuticals', 'Regeneron', 'Amgen', 'Gilead',
    'Charles River Laboratories', 'Labcorp Drug Development', 'ICON plc',
    'Parexel International', 'IQVIA', 'Medpace',
    'Lonza', 'Catalent', 'Samsung Biologics', 'WuXi Biologics',
    'Thermo Fisher Scientific', 'Sartorius', 'Bio-Rad Laboratories',
    'MilliporeSigma', 'GenScript', 'Twist Bioscience', 'Integrated DNA Technologies',
    'Benchling', 'AWS', 'Snowflake',
    'Regulatory Compliance Associates', 'BioBridge Consulting',
  ],
  statusDistribution: {
    DRAFT: 5, PENDING_REVIEW: 8, UNDER_NEGOTIATION: 10, PENDING_APPROVAL: 7,
    APPROVED: 3, PENDING_SIGNATURE: 2, EXECUTED: 55, EXPIRED: 8, TERMINATED: 1, ARCHIVED: 1,
  },
  docs: [
    { label: 'Confidential Disclosure Agreement', type: 'NDA', count: 20, valueRange: null, tags: ['cda', 'nda', 'pre-deal'], body: BODY_NDA, baseRisk: 0.10 },
    { label: 'Sponsored Research Agreement', type: 'OTHER', count: 16, valueRange: [50_000, 2_500_000], tags: ['research', 'academic'], body: BODY_RESEARCH, baseRisk: 0.35 },
    { label: 'CRO Master Services Agreement', type: 'MSA', count: 12, valueRange: [200_000, 5_000_000], tags: ['cro', 'msa'], body: BODY_MSA, baseRisk: 0.30 },
    { label: 'Employment & IP Assignment', type: 'EMPLOYMENT', count: 12, valueRange: [85_000, 350_000], tags: ['employment', 'ip-assignment'], body: BODY_EMPLOYMENT, baseRisk: 0.10 },
    { label: 'Material Transfer Agreement', type: 'OTHER', count: 8, valueRange: null, tags: ['mta', 'biotech'], body: BODY_MTA, baseRisk: 0.20 },
    { label: 'Vendor SOW', type: 'SOW', count: 8, valueRange: [10_000, 150_000], tags: ['vendor', 'lab'], body: BODY_SOW, baseRisk: 0.15 },
    { label: 'License Agreement', type: 'LICENSE', count: 4, valueRange: [500_000, 10_000_000], tags: ['license', 'ip'], body: BODY_LICENSE, baseRisk: 0.45 },
  ],
  matters: [
    { name: 'Pfizer Antibody Collaboration', description: 'CDA + research collab + upcoming option agreement.', contractCount: 4, preferredCounterparties: ['Pfizer'], status: 'OPEN' },
    { name: 'Stanford CD20 Research Program', description: 'Sponsored research + MTA + publication review.', contractCount: 3, preferredCounterparties: ['Stanford University'], status: 'OPEN' },
    { name: 'IND-Enabling Studies (CRO Selection)', description: 'CRO MSA evaluation + selection for IND-enabling toxicology.', contractCount: 4, preferredCounterparties: ['Charles River Laboratories', 'Labcorp Drug Development', 'ICON plc'], status: 'OPEN' },
    { name: 'Series A Onboarding', description: 'New-hire IP assignment cohort for Series A scale-up.', contractCount: 6, status: 'CLOSED' },
  ],
}

const BEACON: Persona = {
  slug: 'beacon-logistics',
  name: 'Beacon Logistics',
  domain: 'beaconlogistics.com',
  industry: 'Third-Party Logistics — Warehousing + Freight + Last-Mile',
  subscriptionTier: 'ENTERPRISE',
  blurb: 'Mid-market 3PL, 1,200 emp, $280M revenue, 8 hubs. Reflects Ironclad ops + LinkSquares industrial sweet spot.',
  seed: 0xe5061728,
  jurisdictions: ['Delaware', 'Tennessee', 'Texas', 'Georgia', 'California', 'New Jersey', 'Illinois'],
  users: [
    { name: 'Dean Whitfield', email: 'dean.whitfield@beaconlogistics.com', role: 'ADMIN', ownerWeight: 15, jobTitle: 'General Counsel' },
    { name: 'Hannah Rivera', email: 'hannah.rivera@beaconlogistics.com', role: 'CONTRACT_MANAGER', ownerWeight: 35, jobTitle: 'Senior Contracts Manager (Customer)' },
    { name: 'Chris Park', email: 'chris.park@beaconlogistics.com', role: 'CONTRACT_MANAGER', ownerWeight: 30, jobTitle: 'Senior Contracts Manager (Carrier)' },
    { name: 'Eli Tran', email: 'eli.tran@beaconlogistics.com', role: 'LEGAL_COUNSEL', ownerWeight: 20, jobTitle: 'Operations Compliance Counsel' },
  ],
  keyCounterparties: ['Walmart', 'Amazon', 'Target', 'J.B. Hunt', 'Maersk', 'Prologis'],
  counterparties: [
    'Walmart', 'Target', 'Amazon', 'Costco', 'The Home Depot', 'Lowe\'s',
    'Ulta Beauty', 'Wayfair', 'Best Buy', 'Macy\'s', 'Kroger', 'Albertsons',
    'CVS Health', 'Walgreens', 'Dollar General',
    'Shopify', 'ShipStation', 'ShipBob', 'Returnly',
    'J.B. Hunt', 'Schneider National', 'Werner Enterprises', 'Knight-Swift',
    'FedEx Ground', 'UPS Freight', 'Old Dominion Freight', 'Saia',
    'XPO Logistics', 'Estes Express',
    'Maersk', 'MSC Mediterranean Shipping', 'CMA CGM', 'ZIM Integrated', 'Hapag-Lloyd', 'Evergreen Marine',
    'BNSF Railway', 'Union Pacific', 'CSX Transportation', 'Norfolk Southern',
    'Project44', 'FourKites', 'Manhattan Associates', 'Blue Yonder',
    'Oracle Transportation Management', 'SAP TM', 'Descartes Systems',
    'Prologis', 'Duke Realty', 'EQT Exeter',
    'AIG', 'Travelers Insurance', 'Liberty Mutual', 'Chubb',
    'TForce Freight', 'New Penn', 'AAA Cooper Transportation',
    'Crowley Maritime', 'Matson', 'OOCL',
    'Acme Logistics Holdings', 'Atlas Distribution', 'Pinnacle 3PL',
    'Helios Freight', 'Caldera Express', 'Beacon Trucking Group',
  ],
  statusDistribution: {
    DRAFT: 4, PENDING_REVIEW: 4, UNDER_NEGOTIATION: 6, PENDING_APPROVAL: 5,
    APPROVED: 2, PENDING_SIGNATURE: 2, EXECUTED: 65, EXPIRED: 8, TERMINATED: 3, ARCHIVED: 1,
  },
  docs: [
    { label: 'Customer Service Level Agreement', type: 'SLA', count: 60, valueRange: [500_000, 25_000_000], tags: ['sla', 'customer'], body: BODY_CUSTOMER_SLA, baseRisk: 0.30 },
    { label: 'Carrier Transportation Agreement', type: 'VENDOR_AGREEMENT', count: 50, valueRange: [200_000, 12_000_000], tags: ['carrier', 'transport'], body: BODY_CARRIER, baseRisk: 0.25 },
    { label: 'Tech Vendor MSA', type: 'VENDOR_AGREEMENT', count: 30, valueRange: [25_000, 800_000], tags: ['vendor', 'tech'], body: BODY_VENDOR, baseRisk: 0.20 },
    { label: 'Warehouse Lease', type: 'OTHER', count: 20, valueRange: [400_000, 4_500_000], tags: ['lease', 'warehouse'], body: BODY_LEASE, baseRisk: 0.20 },
    { label: 'NDA', type: 'NDA', count: 20, valueRange: null, tags: ['nda', 'rfp'], body: BODY_NDA, baseRisk: 0.10 },
    { label: 'Insurance Policy Rider', type: 'OTHER', count: 10, valueRange: [50_000, 800_000], tags: ['insurance', 'cargo'], body: BODY_VENDOR, baseRisk: 0.20 },
    { label: 'Employment Agreement', type: 'EMPLOYMENT', count: 10, valueRange: [110_000, 320_000], tags: ['employment'], body: BODY_EMPLOYMENT, baseRisk: 0.10 },
  ],
  matters: [
    { name: 'Walmart 2026 RFP Response', description: 'Walmart national 3PL RFP — SLA + carrier + insurance package.', contractCount: 6, preferredCounterparties: ['Walmart'], status: 'OPEN' },
    { name: 'Memphis Hub Renewal Cohort', description: 'Customer SLA + warehouse lease + carrier renewals at Memphis hub.', contractCount: 8, status: 'OPEN' },
    { name: 'Ocean Capacity Diversification 2026', description: 'New ocean carrier agreements to reduce Maersk concentration.', contractCount: 5, preferredCounterparties: ['MSC Mediterranean Shipping', 'CMA CGM', 'ZIM Integrated', 'Hapag-Lloyd'], status: 'OPEN' },
    { name: 'Peak Season Volume Reviews', description: 'Q4 peak volume commitments review across top-10 customers.', contractCount: 10, preferredCounterparties: ['Walmart', 'Amazon', 'Target', 'The Home Depot'], status: 'OPEN' },
    { name: 'Amazon Account Expansion', description: 'New SLA + carrier agreement for Amazon Phoenix hub.', contractCount: 4, preferredCounterparties: ['Amazon'], status: 'OPEN' },
  ],
}

const PERSONAS: Persona[] = [VERTEX, CALDERA, IRONBRIDGE, LUMEN, BEACON]

// ─── Generation ─────────────────────────────────────────────────────────────

interface GeneratedContract {
  title: string
  type: ContractTypeEnum
  status: StatusEnum
  counterparty: string
  ownerEmail: string
  value: number | null
  effectiveDate: Date | null
  expiryDate: Date | null
  jurisdiction: string
  riskScore: number
  summary: string
  htmlContent: string
  plainText: string
  tags: string[]
  keyTerms: Record<string, unknown>
  // U12 audit (2026-04-29). Numeric facets the contracts list filters on.
  // Surfaced for logistics (otdSlaPct) + cloud SLA (uptimeSlaPct) docs so
  // demo flows can answer "OTD < 95%" without invoking the agent.
  metadata: Record<string, unknown>
  matterPreference: string | null  // matter name to attach to (resolved later)
}

const STATUS_ORDER: StatusEnum[] = [
  'DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL',
  'APPROVED', 'PENDING_SIGNATURE', 'EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED',
]

function buildCounterpartyWeights(persona: Persona): { items: string[], weights: number[] } {
  const items = persona.counterparties
  const weights = items.map(name =>
    persona.keyCounterparties.includes(name) ? 4 : 1,
  )
  return { items, weights }
}

function generateContractsFor(persona: Persona): GeneratedContract[] {
  const rng = makeRng(persona.seed)
  const out: GeneratedContract[] = []
  const { items: cps, weights: cpWeights } = buildCounterpartyWeights(persona)

  const userEmails = persona.users.map(u => u.email)
  const userWeights = persona.users.map(u => u.ownerWeight)

  const statuses = STATUS_ORDER
  const statusWeights = statuses.map(s => persona.statusDistribution[s] ?? 0)

  // Title uniqueness within a persona — when the RNG hands us the same
  // counterparty for the same doc label twice, we'd otherwise drop the
  // duplicate during DB insert. Append `(2)`, `(3)`, … to keep counts honest.
  const seenTitles = new Set<string>()
  const uniqueTitle = (base: string): string => {
    if (!seenTitles.has(base)) { seenTitles.add(base); return base }
    let n = 2
    while (seenTitles.has(`${base} (${n})`)) n++
    const out = `${base} (${n})`
    seenTitles.add(out)
    return out
  }

  for (const doc of persona.docs) {
    for (let i = 0; i < doc.count; i++) {
      const counterparty = pickWeighted(cps, cpWeights, rng)
      const ownerEmail = pickWeighted(userEmails, userWeights, rng)
      const status = pickWeighted(statuses, statusWeights, rng)
      const jurisdiction = pick(persona.jurisdictions, rng)

      // Date generation depends on status:
      //   - EXECUTED / APPROVED / PENDING_SIGNATURE: signed in past, not yet expired
      //   - EXPIRED / TERMINATED / ARCHIVED: expired in past
      //   - DRAFT / PENDING_REVIEW / UNDER_NEGOTIATION / PENDING_APPROVAL: maybe no dates yet
      let effectiveDate: Date | null = null
      let expiryDate: Date | null = null
      if (status === 'EXECUTED' || status === 'APPROVED' || status === 'PENDING_SIGNATURE') {
        effectiveDate = dateOffset(TODAY, -between(rng, 30, 720))
        expiryDate = dateOffset(effectiveDate, between(rng, 365, 1095))
      } else if (status === 'EXPIRED' || status === 'TERMINATED' || status === 'ARCHIVED') {
        const expiredDaysAgo = between(rng, 5, 365)
        expiryDate = dateOffset(TODAY, -expiredDaysAgo)
        effectiveDate = dateOffset(expiryDate, -between(rng, 365, 1095))
      } else if (rng() < 0.3) {
        effectiveDate = dateOffset(TODAY, between(rng, 0, 60))
        expiryDate = dateOffset(effectiveDate, between(rng, 365, 1095))
      }

      const value = doc.valueRange
        ? between(rng, doc.valueRange[0], doc.valueRange[1])
        : null

      const riskScore = Math.max(0.05, Math.min(0.95, doc.baseRisk + (rng() - 0.5) * 0.3))

      // Title formats vary per type to feel real
      let baseTitle: string
      if (doc.type === 'NDA') {
        baseTitle = `${counterparty} — ${doc.label}`
      } else if (doc.label === 'Letter of Intent' || doc.label === 'Asset Purchase Agreement') {
        baseTitle = `Project ${counterparty} — ${doc.label}`
      } else if (doc.label === 'Employment Agreement' || doc.label === 'Executive Employment' || doc.label === 'Employment & IP Assignment') {
        const empSlot = ['VP', 'Director', 'Senior Manager', 'Principal Engineer'][Math.floor(rng() * 4)]
        baseTitle = `${empSlot} ${doc.label.replace('Agreement', '').trim()} — ${counterparty}`
      } else if (doc.label === 'Order Form' || doc.label === 'Statement of Work' || doc.label === 'Vendor SOW') {
        const sowNum = Math.floor(rng() * 24) + 1
        baseTitle = `${counterparty} — ${doc.label} #${sowNum}`
      } else {
        baseTitle = `${counterparty} — ${doc.label}`
      }
      const title = uniqueTitle(baseTitle)

      // Effective date for body templating
      const effDateStr = effectiveDate ? effectiveDate.toISOString().slice(0, 10) : 'TBD'
      const expDateStr = expiryDate ? expiryDate.toISOString().slice(0, 10) : 'TBD'
      const valueStr = value ? value.toLocaleString('en-US') : 'TBD'

      const html = doc.body
        .replace(/{{counterparty}}/g, counterparty)
        .replace(/{{companyName}}/g, persona.name)
        .replace(/{{effectiveDate}}/g, effDateStr)
        .replace(/{{expiryDate}}/g, expDateStr)
        .replace(/{{value}}/g, valueStr)
        .replace(/{{governingLaw}}/g, jurisdiction)

      const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

      const summary = `${doc.label} between ${persona.name} and ${counterparty}. Effective ${effDateStr}, expires ${expDateStr}. Governing law: ${jurisdiction}.${value ? ` Value: $${valueStr}.` : ''}`

      const keyTerms: Record<string, unknown> = {
        governingLaw: jurisdiction,
        autoRenew: rng() > 0.4,
        noticePeriod: pick(['30 days', '60 days', '90 days', '180 days'], rng),
      }
      if (value) {
        keyTerms.contractValue = value
      }
      if (doc.type === 'MSA' || doc.label.toLowerCase().includes('msa')) {
        keyTerms.liabilityCap = pick(['12 months fees', '24 months fees', '$1M', '$5M', '2× annual fees'], rng)
      }
      if (doc.tags.includes('hipaa')) {
        keyTerms.hipaaCovered = true
        keyTerms.breachNotificationDays = 30
      }

      // U12 numeric facets — write into metadata for filterable docs.
      // Logistics carrier docs get otdSlaPct in [88, 99]; cloud / SLA
      // docs get uptimeSlaPct in [99.0, 99.99]. Distribution is right-
      // skewed so most contracts comfortably meet target and a clear
      // tail below threshold lights up the "OTD < 95%" filter.
      const metadata: Record<string, unknown> = {}
      if (doc.tags.includes('carrier') || doc.tags.includes('transport') || doc.tags.includes('3pl')) {
        // Right-skewed: 70% chance ≥95, 30% below. Spread 88-99.
        const meetsTarget = rng() < 0.7
        const otd = meetsTarget
          ? 95 + Math.round(rng() * 40) / 10  // 95.0–99.0
          : 88 + Math.round(rng() * 60) / 10  // 88.0–94.0
        metadata.otdSlaPct = otd
      }
      if (doc.type === 'SLA' || doc.tags.includes('sla') || doc.tags.includes('cloud') || doc.tags.includes('saas')) {
        // SLA docs: 99.0 to 99.99 — three-9s baseline
        const uptime = 99 + Math.round(rng() * 99) / 100
        metadata.uptimeSlaPct = uptime
      }

      out.push({
        title,
        type: doc.type,
        status,
        counterparty,
        ownerEmail,
        value,
        effectiveDate,
        expiryDate,
        jurisdiction,
        riskScore: Math.round(riskScore * 100) / 100,
        summary,
        htmlContent: html,
        plainText,
        tags: [...doc.tags, status.toLowerCase()],
        keyTerms,
        metadata,
        matterPreference: null,
      })
    }
  }

  return out
}

// ─── Per-persona seeding ────────────────────────────────────────────────────

interface SeedSummary {
  org: string
  users: number
  counterparties: number
  contracts: number
  contractsByType: Record<string, number>
  matters: number
}

async function seedPersona(persona: Persona): Promise<SeedSummary> {
  console.log(`\n─── ${persona.name} (${persona.domain}) ───`)
  console.log(`    ${persona.blurb}`)

  // ── Org ────────────────────────────────────────────────────────────────
  // Persona orgs are pre-configured demo environments — mark onboarding as
  // complete so admin hero users (e.g. Lumen Bio's Aria Volkov) aren't
  // blocked by the OnboardingWizard overlay on first sign-in. Without this
  // flag the wizard renders as `fixed inset-0 z-50` and intercepts every
  // click, breaking demo capture for any admin-hero persona.
  const existingOrg = await prisma.organization.findUnique({ where: { slug: persona.slug } })
  const existingSettings = (existingOrg?.settings as Record<string, unknown> | null) ?? {}
  const orgSettings = {
    ...existingSettings,
    industry:              persona.industry,
    blurb:                 persona.blurb,
    onboardingCompleted:   true,
    onboardingCompletedAt:
      typeof existingSettings.onboardingCompletedAt === 'string'
        ? existingSettings.onboardingCompletedAt
        : new Date().toISOString(),
  }
  const org = await prisma.organization.upsert({
    where: { slug: persona.slug },
    update: {
      name: persona.name,
      subscriptionTier: persona.subscriptionTier,
      settings: orgSettings,
    },
    create: {
      slug: persona.slug,
      name: persona.name,
      subscriptionTier: persona.subscriptionTier,
      settings: orgSettings,
    },
  })
  console.log(`    ✓ Org`)

  // ── Roles ──────────────────────────────────────────────────────────────
  const roleNames: RoleName[] = ['ADMIN', 'LEGAL_COUNSEL', 'LEGAL_OPS', 'CONTRACT_MANAGER', 'APPROVER', 'VIEWER']
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

  // ── Users ──────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash('password123', 12)
  const userByEmail = new Map<string, string>()
  for (const u of persona.users) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        orgId: org.id,
      },
      create: {
        orgId: org.id,
        email: u.email,
        passwordHash: hash,
        name: u.name,
        preferences: { jobTitle: u.jobTitle },
      },
    })
    userByEmail.set(u.email, user.id)
    // Ensure role
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: roleMap[u.role] } },
      update: {},
      create: { userId: user.id, roleId: roleMap[u.role] },
    })
  }
  console.log(`    ✓ ${persona.users.length} users`)

  // ── Counterparties ─────────────────────────────────────────────────────
  const cpByName = new Map<string, string>()
  for (const name of persona.counterparties) {
    const cp = await prisma.counterparty.upsert({
      where: { orgId_name: { orgId: org.id, name } },
      update: {},
      create: { orgId: org.id, name },
    })
    cpByName.set(name, cp.id)
  }
  console.log(`    ✓ ${persona.counterparties.length} counterparties`)

  // ── Org defaults (templates / clauses / playbook) ──────────────────────
  const adminEmail = persona.users.find(u => u.role === 'ADMIN')?.email ?? persona.users[0].email
  const adminUserId = userByEmail.get(adminEmail)!
  await seedOrgDefaults(org.id, persona.slug, adminUserId)
  console.log(`    ✓ Default templates/clauses/playbook (via seedOrgDefaults)`)

  // ── Contracts ──────────────────────────────────────────────────────────
  const generated = generateContractsFor(persona)
  let createdCount = 0
  let skippedCount = 0
  const byType: Record<string, number> = {}
  const generatedByTitle = new Map<string, GeneratedContract>()

  for (const c of generated) {
    // Idempotency: skip if title exists
    const existing = await prisma.contract.findFirst({
      where: { orgId: org.id, title: c.title },
      select: { id: true },
    })
    if (existing) {
      skippedCount++
      continue
    }
    const ownerId = userByEmail.get(c.ownerEmail)!
    const cpId = cpByName.get(c.counterparty)!

    const created = await prisma.contract.create({
      data: {
        orgId: org.id,
        ownerId,
        title: c.title,
        type: c.type,
        status: c.status,
        counterpartyId: cpId,
        counterpartyName: c.counterparty,
        value: c.value !== null ? new Prisma.Decimal(c.value) : null,
        currency: 'USD',
        effectiveDate: c.effectiveDate,
        expiryDate: c.expiryDate,
        jurisdiction: c.jurisdiction,
        riskScore: c.riskScore,
        summary: c.summary,
        keyTerms: c.keyTerms as Prisma.JsonObject,
        // U12 — surface OTD / uptime SLA numeric fields for the
        // contracts list facet to filter on.
        metadata: c.metadata as Prisma.JsonObject,
        tags: c.tags,
        analysisStatus: 'DONE',
        overallConfidence: 0.85,
        versions: {
          create: {
            versionNumber: 1,
            htmlContent: c.htmlContent,
            plainText: c.plainText,
            changeNote: 'Initial version',
            createdById: ownerId,
          },
        },
      },
    })
    // Persona-test fix #2: also index in Elasticsearch so portfolio_search
    // and contract_search can find these contracts. Without this, the agent's
    // search tools only see whatever was previously indexed (the original
    // demo seed of ~10) and falls back to "no results" for everything else.
    // Fire-and-forget — a single failure shouldn't abort the seed loop.
    indexContract(created.id, {
      orgId: org.id,
      title: c.title,
      type: c.type,
      status: c.status,
      counterpartyName: c.counterparty,
      jurisdiction: c.jurisdiction,
      plainText: c.plainText,
      summary: c.summary,
      tags: c.tags,
      riskScore: c.riskScore,
      effectiveDate: c.effectiveDate?.toISOString(),
      expiryDate: c.expiryDate?.toISOString(),
      createdAt: created.createdAt.toISOString(),
      keyTerms: c.keyTerms,
    }).catch(err => console.warn(`    ⚠ ES index failed for "${c.title}": ${(err as Error).message.slice(0, 80)}`))
    generatedByTitle.set(c.title, c)
    createdCount++
    byType[c.type] = (byType[c.type] ?? 0) + 1
  }
  console.log(`    ✓ ${createdCount} contracts created (${skippedCount} skipped — already exist)`)
  for (const [type, n] of Object.entries(byType)) {
    console.log(`        · ${type}: ${n}`)
  }

  // ── Matters ────────────────────────────────────────────────────────────
  let matterCount = 0
  let matterSkipped = 0
  for (const m of persona.matters) {
    const existingMatter = await prisma.matter.findFirst({
      where: { orgId: org.id, name: m.name },
      select: { id: true },
    })
    if (existingMatter) { matterSkipped++; continue }

    // Pick a primary counterparty for the matter from preferences (if any)
    const primaryCp = m.preferredCounterparties?.[0]
      ? cpByName.get(m.preferredCounterparties[0]) ?? null
      : null
    const primaryCpName = m.preferredCounterparties?.[0] ?? null

    // Owner: a senior legal user (first ADMIN or LEGAL_COUNSEL)
    const ownerEmail = persona.users.find(u => u.role === 'ADMIN' || u.role === 'LEGAL_COUNSEL')?.email
      ?? persona.users[0].email
    const ownerId = userByEmail.get(ownerEmail)!

    // Find candidate contracts in this org matching the matter preferences
    const candidateContracts = await prisma.contract.findMany({
      where: {
        orgId: org.id,
        matterId: null,
        ...(m.preferredCounterparties && m.preferredCounterparties.length > 0
          ? { counterpartyName: { in: m.preferredCounterparties } }
          : {}),
      },
      select: { id: true },
      take: m.contractCount,
      orderBy: { createdAt: 'desc' },
    })

    const matter = await prisma.matter.create({
      data: {
        orgId: org.id,
        name: m.name,
        description: m.description,
        status: m.status ?? 'OPEN',
        ownerId,
        createdById: ownerId,
        counterpartyId: primaryCp,
        counterpartyName: primaryCpName,
        tags: [],
        contracts: {
          connect: candidateContracts.map(c => ({ id: c.id })),
        },
      },
    })
    matterCount++
    console.log(`    ✓ Matter: ${matter.name} (${candidateContracts.length} contracts)`)
  }
  if (matterSkipped > 0) {
    console.log(`    ✓ ${matterCount} matters created (${matterSkipped} skipped — already exist)`)
  }
  // S5 — total matter count for the persona summary should include both
  // newly-created and pre-existing matters; otherwise re-seeds report
  // "Total matters: 0" even when matters exist in the DB.
  const totalMatterCount = matterCount + matterSkipped

  return {
    org: persona.name,
    users: persona.users.length,
    counterparties: persona.counterparties.length,
    contracts: createdCount,
    contractsByType: byType,
    matters: totalMatterCount,
  }
}

// ─── Clear (idempotent removal) ─────────────────────────────────────────────

async function clearPersona(persona: Persona): Promise<void> {
  console.log(`\n─── Clearing ${persona.name} (${persona.slug}) ───`)
  const org = await prisma.organization.findUnique({ where: { slug: persona.slug } })
  if (!org) {
    console.log(`    Org not found — nothing to clear`)
    return
  }

  // Delete in dependency order. Matters reference contracts; contracts reference
  // versions/clauses; users reference roles. We work from leaves upward.
  const result = {
    versions: 0, contracts: 0, matters: 0, counterparties: 0,
    matterRequests: 0, approvalSteps: 0, approvalInstances: 0,
    users: 0, threads: 0, messages: 0, toolCalls: 0,
  }

  // Agent threads / messages / tool calls
  const threads = await prisma.agentThread.findMany({ where: { orgId: org.id }, select: { id: true } })
  for (const t of threads) {
    await prisma.toolCall.deleteMany({ where: { threadId: t.id } })
    await prisma.agentMessage.deleteMany({ where: { threadId: t.id } })
  }
  result.threads = threads.length
  await prisma.agentThread.deleteMany({ where: { orgId: org.id } })

  // Approval steps / instances
  result.approvalSteps = (await prisma.approvalStep.deleteMany({ where: { orgId: org.id } })).count
  result.approvalInstances = (await prisma.approvalInstance.deleteMany({ where: { orgId: org.id } })).count

  // Notifications
  await prisma.notification.deleteMany({ where: { orgId: org.id } })

  // Workflow definitions
  await prisma.workflowDefinition.deleteMany({ where: { orgId: org.id } })

  // Contract child rows: comments, share links, signature events, signers, signature requests, clauses, versions
  const contracts = await prisma.contract.findMany({ where: { orgId: org.id }, select: { id: true } })
  const contractIds = contracts.map(c => c.id)
  if (contractIds.length > 0) {
    await prisma.contractComment.deleteMany({ where: { contractId: { in: contractIds } } })
    await prisma.contractShareLink.deleteMany({ where: { contractId: { in: contractIds } } })
    // Signatures cascade through their own scoping; do them via orgId where possible
    await prisma.signatureEvent.deleteMany({ where: { signer: { request: { orgId: org.id } } } }).catch(() => {})
    await prisma.signer.deleteMany({ where: { request: { orgId: org.id } } }).catch(() => {})
    await prisma.signatureRequest.deleteMany({ where: { orgId: org.id } }).catch(() => {})
    await prisma.versionDiffCache.deleteMany({ where: { contractId: { in: contractIds } } }).catch(() => {})

    const versionIds = (await prisma.contractVersion.findMany({
      where: { contractId: { in: contractIds } }, select: { id: true },
    })).map(v => v.id)
    if (versionIds.length > 0) {
      await prisma.contractClause.deleteMany({ where: { versionId: { in: versionIds } } })
    }
    result.versions = (await prisma.contractVersion.deleteMany({ where: { contractId: { in: contractIds } } })).count
  }

  // Contracts: clear matter ref first to avoid FK issues, then delete
  await prisma.contract.updateMany({ where: { orgId: org.id }, data: { matterId: null } })
  result.contracts = (await prisma.contract.deleteMany({ where: { orgId: org.id } })).count

  // Matters
  result.matters = (await prisma.matter.deleteMany({ where: { orgId: org.id } })).count

  // Contract requests
  result.matterRequests = (await prisma.contractRequest.deleteMany({ where: { orgId: org.id } })).count

  // Counterparties
  result.counterparties = (await prisma.counterparty.deleteMany({ where: { orgId: org.id } })).count

  // Templates + clauses + playbook
  const templates = await prisma.template.findMany({ where: { orgId: org.id }, select: { id: true } })
  for (const t of templates) {
    await prisma.templateSection.deleteMany({ where: { templateId: t.id } })
  }
  await prisma.template.deleteMany({ where: { orgId: org.id } })
  await prisma.playbookPosition.deleteMany({ where: { orgId: org.id } })
  await prisma.clauseLibraryItem.deleteMany({ where: { orgId: org.id } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org.id } })

  // Field definitions
  await prisma.contractFieldDefinition.deleteMany({ where: { orgId: org.id } })

  // Audit events
  await prisma.auditEvent.deleteMany({ where: { orgId: org.id } })

  // Skill invocations + skills
  await prisma.skillInvocation.deleteMany({ where: { orgId: org.id } })
  await prisma.skill.deleteMany({ where: { orgId: org.id } })

  // AI keys + settings
  await prisma.orgAiKey.deleteMany({ where: { orgId: org.id } })
  await prisma.orgAiSettings.deleteMany({ where: { orgId: org.id } })
  await prisma.orgUsageDaily.deleteMany({ where: { orgId: org.id } })

  // Users + their role assignments
  const users = await prisma.user.findMany({ where: { orgId: org.id }, select: { id: true } })
  for (const u of users) {
    await prisma.userRole.deleteMany({ where: { userId: u.id } })
  }
  result.users = (await prisma.user.deleteMany({ where: { orgId: org.id } })).count

  // Roles
  await prisma.role.deleteMany({ where: { orgId: org.id } })

  // Org
  await prisma.organization.delete({ where: { id: org.id } })

  console.log(`    ✓ Cleared:`, result)
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function findPersona(slugOrShortName: string): Persona | null {
  const needle = slugOrShortName.toLowerCase()
  return PERSONAS.find(p =>
    p.slug === needle ||
    p.slug.includes(needle) ||
    p.name.toLowerCase().includes(needle),
  ) ?? null
}

async function main() {
  const args = process.argv.slice(2)
  const isClear = args[0] === 'clear'
  const targetSlug = isClear ? args[1] : args[0]

  let targets: Persona[]
  if (targetSlug) {
    const p = findPersona(targetSlug)
    if (!p) {
      console.error(`✗ Persona not found: "${targetSlug}". Available: ${PERSONAS.map(p => p.slug).join(', ')}`)
      process.exit(1)
    }
    targets = [p]
  } else {
    targets = PERSONAS
  }

  if (isClear) {
    console.log(`🗑️  Clearing ${targets.length} persona(s)...`)
    for (const p of targets) {
      await clearPersona(p)
    }
    console.log(`\n✓ Cleared ${targets.length} persona(s).`)
    return
  }

  console.log(`🌱 Seeding ${targets.length} persona(s)...`)
  const summaries: SeedSummary[] = []
  for (const p of targets) {
    const s = await seedPersona(p)
    summaries.push(s)
  }

  // ── Final summary ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`✓ Seeded ${summaries.length} persona(s)`)
  console.log(`${'═'.repeat(70)}\n`)

  const totalUsers = summaries.reduce((s, x) => s + x.users, 0)
  const totalCps = summaries.reduce((s, x) => s + x.counterparties, 0)
  const totalContracts = summaries.reduce((s, x) => s + x.contracts, 0)
  const totalMatters = summaries.reduce((s, x) => s + x.matters, 0)

  console.log(`  Total users:          ${totalUsers}`)
  console.log(`  Total counterparties: ${totalCps}`)
  console.log(`  Total contracts:      ${totalContracts}`)
  console.log(`  Total matters:        ${totalMatters}`)
  console.log()
  for (const s of summaries) {
    console.log(`  ${s.org.padEnd(28)} ${String(s.contracts).padStart(4)} contracts | ${s.matters} matters`)
  }
  console.log()
  console.log(`Login:`)
  for (const p of targets) {
    console.log(`  ${p.name.padEnd(28)} → ${p.users[0].email} (password: password123)`)
  }
}

main()
  .catch(err => {
    console.error('✗ Seed failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
