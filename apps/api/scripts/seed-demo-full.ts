/**
 * seed-demo-full.ts — fills the entities seed-demo-portfolio.ts left empty, so
 * every screen in the product can be reviewed against real content. Dev only;
 * never point this at production.
 *
 * seed-demo-portfolio.ts gave us 240 realistically-shaped contracts, which is
 * enough to judge the repository and nothing else. Obligations, approvals,
 * signatures, invoices, matters, diligence rooms and comments were all either
 * empty or a handful of rows, so half the product renders as empty states and
 * the design decisions that only fail at volume never get tested.
 *
 * This script writes the connective tissue AROUND the existing portfolio:
 *
 *   matters              14   groups of existing contracts, by negotiation
 *   obligations          90   hung off EXECUTED contracts, ~22 genuinely late
 *   invoices             40   PENDING / MATCHED / RECONCILED / DISPUTED
 *   diligence rooms       3   with their own 45 contracts (see below)
 *   approval instances   25   PENDING / APPROVED / REJECTED, multi-step
 *   signature requests   18   with signers + an event trail
 *   comments             50   threaded, on the busiest contracts
 *   workflow definitions  3   so the workflow list is a list
 *   share links           4   the external commenters point at real links
 *
 * ─── Shape, not volume ──────────────────────────────────────────────────────
 *
 * The distributions are the point, the same way they were for the portfolio:
 *
 *   · ~22 obligations are genuinely OVERDUE — status OPEN with a due date 3 to
 *     120 days in the past. That is what the API's `overdue` bucket and the
 *     obligations KPI actually count (status OVERDUE is a stored label; the
 *     bucket query is `status = OPEN AND dueDate < now`), and the overdue
 *     treatment is the thing we need to see under real pressure.
 *   · Several PENDING approvals sit on admin@demo.com at the CURRENT step, so
 *     "my queue" and the sidebar's "your turn" badge have content. Both
 *     surfaces gate on step.stepOrder === instance.currentStepOrder, and the
 *     dashboard badge additionally does GREATEST(currentStepOrder, 1) — so the
 *     workflows written here are 1-INDEXED, not 0-indexed like the older seed,
 *     otherwise a step-1 assignment is invisible to the badge.
 *   · Signature requests span the four statuses the API supports, and the
 *     PENDING ones carry a mix of signed and unsigned signers so the roster
 *     reads "1 / 3 signed" — which is what "partially signed" means here.
 *   · Invoice values span $1K to $800K, most matched, some disputed, some
 *     floating unattached, because reconciliation UI is only honest when the
 *     unmatched pile exists.
 *
 * ─── Identity and cleanup ───────────────────────────────────────────────────
 *
 * Every row this script writes has an id that starts with `dfull_`, so
 * `--clean` removes exactly what it created and nothing else — including the
 * matterId links it painted onto existing contracts, which are unset rather
 * than deleted. Contracts it creates (diligence-room documents) also carry the
 * `demo-full` tag.
 *
 * Two rows are attached to portfolio contracts beyond the obvious: a
 * ContractVersion per signature request (a request needs a version to freeze),
 * and share links for the external commenters. Both are `dfull_`-prefixed and
 * both come back out on --clean.
 *
 * Ordering note: if you are wiping everything, run THIS script's --clean before
 * seed-demo-portfolio.ts --clean. Approvals and comments hold FK references to
 * portfolio contracts, so removing the contracts first fails on those.
 *
 *   pnpm exec tsx --env-file=../../.env scripts/seed-demo-full.ts
 *   … --clean     remove only the rows this script created
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({ log: ['warn', 'error'] })

/** Every row this script writes has an id starting with this. */
const IDP = 'dfull_'
/** Tag on contracts this script creates (diligence documents). */
const TAG = 'demo-full'
/** The portfolio we attach to. */
const PORTFOLIO_TAG = 'demo-portfolio'

// Deterministic PRNG — a fixture that reshuffles every run is not a fixture.
let _s = 20260810
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
const chance = (p: number) => rnd() < p

/** Captured once. Everything else is an offset from it, so runs reproduce. */
const NOW = Date.now()
const day = 86_400_000
/** `at(-30)` = thirty days ago. Fractional days are fine (hours). */
const at = (days: number) => new Date(NOW + days * day)
/**
 * Same, clamped to the past. Anything that RECORDS something that already
 * happened — a signature, a decision, a reconciliation — must never be
 * future-dated, and the offsets below are built by addition from a send date
 * that can be as recent as yesterday.
 */
const past = (days: number) => at(Math.min(days, -0.02))

const id = (kind: string, n: number) => `${IDP}${kind}_${String(n).padStart(3, '0')}`

/** Deterministic Fisher-Yates — the pools must be shuffled the same way twice. */
function shuffled<T>(xs: readonly T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** A pool you draw from without replacement; wraps around if you overdraw. */
function pool<T>(xs: readonly T[]) {
  const items = shuffled(xs)
  let i = 0
  return {
    next(): T { const v = items[i % items.length]; i++; return v },
    take(n: number): T[] { return Array.from({ length: n }, () => this.next()) },
    size: items.length,
  }
}

// ─── Vocabularies ───────────────────────────────────────────────────────────

type ContractLite = {
  id: string
  title: string
  type: string
  status: string
  value: unknown
  counterpartyId: string | null
  counterpartyName: string | null
}

/** Obligation templates, phrased the way an extractor would land them. */
const OBLIGATIONS: ReadonlyArray<{
  type: string; description: string; quote: string; sectionRef: string
  owner: string; recurrence: string; severity: string
}> = [
  { type: 'payment', description: 'Quarterly platform fee — invoice due Net 30',
    quote: 'Customer shall pay all undisputed fees within thirty (30) days of receipt of a valid invoice.',
    sectionRef: '§5.1', owner: 'customer', recurrence: 'quarterly', severity: 'medium' },
  { type: 'payment', description: 'Annual true-up for usage above committed volume',
    quote: 'Overage above the Committed Volume is invoiced annually in arrears at the rates in Exhibit B.',
    sectionRef: '§5.4', owner: 'customer', recurrence: 'annually', severity: 'medium' },
  { type: 'payment', description: 'Milestone 2 payment on acceptance of the integration build',
    quote: 'The Milestone 2 fee becomes payable upon Customer’s written acceptance of the integration build.',
    sectionRef: '§4.3', owner: 'customer', recurrence: 'one-time', severity: 'high' },
  { type: 'payment', description: 'Prepaid professional-services drawdown expires if unused',
    quote: 'Prepaid Services hours expire twelve (12) months from the Effective Date and are non-refundable.',
    sectionRef: '§6.2', owner: 'customer', recurrence: 'annually', severity: 'low' },
  { type: 'payment', description: 'Final invoice on termination — outstanding fees accelerate',
    quote: 'Upon termination all fees for the remainder of the then-current Term become immediately due.',
    sectionRef: '§11.4', owner: 'customer', recurrence: 'on-event', severity: 'high' },

  { type: 'sla', description: 'Monthly uptime report and SLA credit reconciliation',
    quote: 'Provider shall deliver a monthly availability report; credits are applied against the next invoice.',
    sectionRef: '§7.1', owner: 'provider', recurrence: 'monthly', severity: 'medium' },
  { type: 'sla', description: 'P1 incident RCA within five business days',
    quote: 'Provider shall furnish a root cause analysis within five (5) Business Days of any Severity 1 incident.',
    sectionRef: '§7.5', owner: 'provider', recurrence: 'on-event', severity: 'high' },
  { type: 'sla', description: 'Quarterly service review with the named account team',
    quote: 'The parties shall hold a quarterly service review attended by the named Customer Success Manager.',
    sectionRef: '§7.8', owner: 'either', recurrence: 'quarterly', severity: 'low' },

  { type: 'report', description: 'Annual SOC 2 Type II report furnished to Customer',
    quote: 'Provider shall furnish a current SOC 2 Type II report annually and upon material change of control.',
    sectionRef: '§9.1', owner: 'provider', recurrence: 'annually', severity: 'high' },
  { type: 'report', description: 'Quarterly diversity-spend reporting to procurement',
    quote: 'Supplier shall report diverse-supplier spend under this Agreement each calendar quarter.',
    sectionRef: '§12.6', owner: 'provider', recurrence: 'quarterly', severity: 'low' },
  { type: 'report', description: 'Annual penetration-test summary shared under NDA',
    quote: 'Provider shall share an executive summary of its annual third-party penetration test.',
    sectionRef: '§9.4', owner: 'provider', recurrence: 'annually', severity: 'medium' },

  { type: 'compliance', description: 'Maintain $5M cyber liability cover — certificate on file',
    quote: 'Provider shall maintain cyber liability insurance of not less than $5,000,000 per occurrence.',
    sectionRef: '§10.2', owner: 'provider', recurrence: 'annually', severity: 'high' },
  { type: 'compliance', description: 'Subprocessor list refresh — 30-day objection window',
    quote: 'Provider shall give thirty (30) days’ notice before engaging any new Subprocessor.',
    sectionRef: '§3.4 (DPA)', owner: 'provider', recurrence: 'on-event', severity: 'medium' },
  { type: 'compliance', description: 'Standard Contractual Clauses refresh for EEA transfers',
    quote: 'Transfers of Personal Data outside the EEA are governed by the SCCs annexed hereto.',
    sectionRef: '§8.3 (DPA)', owner: 'either', recurrence: 'annually', severity: 'high' },
  { type: 'compliance', description: 'Background checks evidenced for all onsite personnel',
    quote: 'Supplier shall evidence background screening for each individual assigned to Customer premises.',
    sectionRef: '§10.7', owner: 'provider', recurrence: 'on-event', severity: 'medium' },
  { type: 'compliance', description: 'Export-control certification for restricted jurisdictions',
    quote: 'Each party certifies compliance with applicable export control and sanctions laws.',
    sectionRef: '§14.2', owner: 'either', recurrence: 'annually', severity: 'low' },

  { type: 'renewal', description: 'Auto-renewal — 90-day non-renewal notice window opens',
    quote: 'This Agreement renews for successive twelve-month terms unless notice is given 90 days before expiry.',
    sectionRef: '§3.1', owner: 'customer', recurrence: 'annually', severity: 'high' },
  { type: 'renewal', description: 'Price-escalation cap review before renewal quote lands',
    quote: 'Fees may increase at renewal by no more than the lesser of CPI or five percent (5%).',
    sectionRef: '§5.6', owner: 'customer', recurrence: 'annually', severity: 'medium' },
  { type: 'renewal', description: 'Confirm headcount tier before the renewal true-up',
    quote: 'The Subscription Tier is confirmed against actual Authorized Users at each anniversary.',
    sectionRef: '§2.4', owner: 'customer', recurrence: 'annually', severity: 'low' },

  { type: 'audit', description: 'Annual audit-rights window — 15 business days’ notice',
    quote: 'Customer may audit Provider’s compliance once per year on fifteen (15) Business Days’ notice.',
    sectionRef: '§13.1', owner: 'customer', recurrence: 'annually', severity: 'medium' },
  { type: 'audit', description: 'Quarterly supplier compliance audit — sampled controls',
    quote: 'Either party may audit compliance with the Security Schedule on a quarterly basis.',
    sectionRef: '§13.4', owner: 'either', recurrence: 'quarterly', severity: 'low' },

  { type: 'termination', description: 'Data deletion certificate within 30 days of termination',
    quote: 'Provider shall certify deletion of all Customer Data within thirty (30) days of termination.',
    sectionRef: '§11.7', owner: 'provider', recurrence: 'on-event', severity: 'high' },
  { type: 'termination', description: 'Transition assistance — up to 90 days at then-current rates',
    quote: 'Provider shall furnish transition assistance for up to ninety (90) days following expiry.',
    sectionRef: '§11.9', owner: 'provider', recurrence: 'on-event', severity: 'medium' },

  { type: 'other', description: 'Named-contact refresh for escalation and notice',
    quote: 'Each party shall keep its notice contact current and notify the other of any change.',
    sectionRef: '§15.2', owner: 'either', recurrence: 'annually', severity: 'low' },
  { type: 'other', description: 'Logo-use approval required before any joint press release',
    quote: 'Neither party shall use the other’s marks without prior written approval.',
    sectionRef: '§16.1', owner: 'either', recurrence: 'on-event', severity: 'low' },
]

const COMPLETION_NOTES = [
  'Paid via ACH — remittance advice attached.',
  'Report received and filed in the compliance drive.',
  'Certificate on file; expiry diarised for next year.',
  'Confirmed complete with the account team on the QBR call.',
  'Closed out — counterparty confirmed in writing.',
  'Evidence uploaded; finance has reconciled against the PO.',
] as const

const WAIVER_NOTES = [
  'Waived — superseded by the renewal amendment signed this quarter.',
  'Waived by GC: commercially immaterial for this vendor tier.',
  'Not applicable — the relevant service was never switched on.',
  'Waived pending the consolidated reporting package next quarter.',
  'Waived — obligation sits with the reseller, not us.',
] as const

const MATTERS: ReadonlyArray<{
  name: string; description: string; status: string
  counterparty?: string; tags: string[]; contracts: number
}> = [
  { name: 'Project Atlas — Vendor Consolidation', status: 'OPEN', contracts: 12,
    description: 'Consolidating 40+ overlapping SaaS and services vendors into a preferred-supplier panel ahead of FY27 budgeting. Tracking terminations, novations and the replacement MSAs in one place.',
    tags: ['procurement', 'cost-savings', 'fy27'] },
  { name: 'Series C Financing', status: 'OPEN', contracts: 4,
    description: 'Corporate financing round. Side letters, NDAs with prospective investors, and the diligence request list from lead counsel.',
    tags: ['corporate', 'financing', 'confidential'] },
  { name: 'EMEA Data Transfers — SCC Remediation', status: 'OPEN', contracts: 9,
    description: 'Repapering EEA and UK transfers onto the 2021 SCCs plus the UK Addendum. Every processor touching EEA personal data needs a refreshed DPA.',
    tags: ['privacy', 'emea', 'gdpr'] },
  { name: 'Snowflake — Renewal & Commit Restructure', status: 'OPEN', contracts: 5,
    counterparty: 'Snowflake Computing',
    description: 'Restructuring the annual commit downward with a longer term in exchange. Renewal notice window closes shortly.',
    tags: ['renewal', 'data-platform'] },
  { name: 'Zynga — Master Agreement Renegotiation', status: 'OPEN', contracts: 5,
    counterparty: 'Zynga Inc.',
    description: 'Reopening liability cap and IP ownership on the master agreement following the scope expansion in Q2.',
    tags: ['negotiation', 'high-value'] },
  { name: 'Project Northwind — SaaS Rationalisation FY26', status: 'OPEN', contracts: 10,
    description: 'Engineering-tooling spend review. Identify duplicate capability, consolidate to three vendors, and unwind the rest at renewal.',
    tags: ['procurement', 'engineering'] },
  { name: 'Okta — Identity Platform Migration', status: 'OPEN', contracts: 4,
    counterparty: 'Okta Security',
    description: 'Migration of workforce identity onto a single tenant. Requires a security addendum and updated DPA before cutover.',
    tags: ['security', 'migration'] },
  { name: 'Databricks Enterprise Agreement', status: 'OPEN', contracts: 4,
    counterparty: 'Databricks',
    description: 'Moving from order-form-by-order-form purchasing onto a single enterprise agreement with a shared commit pool.',
    tags: ['data-platform', 'commercial'] },
  { name: 'Q3 Security Addendum Rollout', status: 'OPEN', contracts: 8,
    description: 'Rolling the updated security schedule (MFA, 24-hour breach notice, subprocessor consent) across all tier-1 processors.',
    tags: ['security', 'rollout'] },
  { name: 'Iora Health — HIPAA BAA Refresh', status: 'OPEN', contracts: 4,
    counterparty: 'Iora Health',
    description: 'Refreshing the business associate agreement and minimum-necessary schedules after the platform change.',
    tags: ['healthcare', 'hipaa'] },
  { name: 'Office Lease — 500 Howard St', status: 'OPEN', contracts: 3,
    counterparty: 'Cushman & Wakefield',
    description: 'Sublease of floors 6-7, plus the facilities and security services agreements that ride on the head lease.',
    tags: ['real-estate', 'facilities'] },
  { name: 'Project Sable — Asset Purchase Diligence', status: 'OPEN', contracts: 6,
    description: 'Buy-side diligence on the target’s commercial contracts. Change-of-control and assignment provisions are the gating issue.',
    tags: ['m&a', 'diligence', 'confidential'] },
  { name: 'Baker McKenzie — Panel Review', status: 'CLOSED', contracts: 3,
    counterparty: 'Baker McKenzie LLP',
    description: 'Outside-counsel panel review and rate card renegotiation. Closed — new rate card effective from the start of the fiscal year.',
    tags: ['outside-counsel', 'closed'] },
  { name: 'Twilio — Legacy Termination & Wind-down', status: 'ARCHIVED', contracts: 3,
    counterparty: 'Twilio',
    description: 'Wind-down of the legacy messaging agreement. Data deletion certified; archived for the record.',
    tags: ['termination', 'archive'] },
]

const WORKFLOWS: ReadonlyArray<{
  name: string; description: string
  triggerRules: Record<string, unknown>
  steps: ReadonlyArray<{
    name: string; role: 'admin' | 'legal' | 'either'
    executionMode: 'sequential' | 'parallel'; requiredApprovals: number; dueSoonHours: number
    parallelWith?: 'admin' | 'legal'
  }>
  isDefault?: boolean
}> = [
  {
    name: 'High-value vendor approval (4-step)',
    description: 'Legal → Security → Finance → CFO. Triggers on vendor spend at or above $500k, or any uncapped-liability term.',
    triggerRules: { contractTypes: ['MSA', 'VENDOR_AGREEMENT', 'SOW', 'LICENSE'], valueThreshold: 500_000 },
    steps: [
      { name: 'Legal Review',    role: 'legal',  executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48 },
      { name: 'Security Review', role: 'admin',  executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 72 },
      { name: 'Finance Review',  role: 'legal',  executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 72 },
      { name: 'CFO Sign-off',    role: 'admin',  executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 96 },
    ],
  },
  {
    name: 'NDA fast-track (1-step)',
    description: 'Single legal review. Mutual NDAs on the standard paper under $10k of associated spend auto-approve.',
    triggerRules: {
      contractTypes: ['NDA'],
      autoApproveRules: [{ contractType: 'NDA', maxValue: 10_000 }],
    },
    steps: [
      { name: 'Legal Review', role: 'legal', executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 24 },
    ],
  },
  {
    name: 'Data processing review (parallel privacy + security)',
    description: 'Privacy and Security review concurrently — both must clear — then GC signs off. Triggers on any DPA or contract touching personal data.',
    triggerRules: { contractTypes: ['DATA_PROCESSING', 'MSA', 'ORDER_FORM'], valueThreshold: 0 },
    steps: [
      { name: 'Privacy & Security Review', role: 'either', executionMode: 'parallel', requiredApprovals: 2, dueSoonHours: 48 },
      { name: 'GC Sign-off',               role: 'admin',  executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 72 },
    ],
  },
]

const AI_SUMMARIES: ReadonlyArray<{
  summary: string; risks: Array<{ title: string; description: string; severity: string }>
  nonStandard: string[]; rec: string
}> = [
  {
    summary: 'Liability cap is 1× fees against a $1.2M annual commit — well below our 12× floor for a vendor holding production data.',
    risks: [
      { title: 'Liability cap below policy floor', severity: 'high', description: 'Cap of 1× fees vs the 12× floor for processors holding production data.' },
      { title: 'No security-incident notice window', severity: 'medium', description: 'Security schedule omits a notification deadline; playbook requires 24 hours.' },
    ],
    nonStandard: ['Liability cap below 12 months fees', 'No breach-notification window'],
    rec: 'review_required',
  },
  {
    summary: 'Standard paper with our preferred terms intact. Value sits inside the delegated authority for this category.',
    risks: [{ title: 'No material deviations', severity: 'low', description: 'Clause-by-clause comparison found no departures from the playbook.' }],
    nonStandard: [],
    rec: 'approve',
  },
  {
    summary: 'Auto-renewal with a 90-day notice window and an uncapped uplift. The renewal trap is the commercial issue, not the legal one.',
    risks: [
      { title: 'Uncapped renewal uplift', severity: 'high', description: 'No CPI or percentage cap on renewal pricing.' },
      { title: '90-day notice window', severity: 'medium', description: 'Notice must be diarised or the term rolls automatically.' },
    ],
    nonStandard: ['Auto-renewal with 90-day notice', 'Unilateral price escalation'],
    rec: 'review_required',
  },
  {
    summary: 'Indemnity runs one way and the carve-out for gross negligence is missing. Counsel should not sign this as drafted.',
    risks: [
      { title: 'One-way indemnity', severity: 'high', description: 'Customer indemnifies Provider with no reciprocal obligation.' },
      { title: 'No gross-negligence carve-out', severity: 'high', description: 'Cap applies even to gross negligence and wilful misconduct.' },
    ],
    nonStandard: ['Broad indemnity', 'No carve-out for gross negligence'],
    rec: 'reject_advised',
  },
  {
    summary: 'Data-processing terms are acceptable; the subprocessor list is stale and needs refreshing before signature.',
    risks: [
      { title: 'Stale subprocessor list', severity: 'medium', description: 'Annex III lists two subprocessors that no longer exist.' },
    ],
    nonStandard: ['Subprocessor annex out of date'],
    rec: 'review_required',
  },
]

const APPROVE_COMMENTS = [
  'Reviewed against the playbook — no material deviations.',
  'Cap and indemnity are within policy. Approved.',
  'Approved. Security schedule matches the tier-1 template.',
  'Fine commercially; the term is inside the delegated authority.',
  'Approved subject to the diary note on the renewal window.',
  'Checked the DPA annexes — approved.',
] as const

const REJECT_COMMENTS = [
  'Rejecting: liability cap at 1× fees is below our floor for a processor holding production data. Send it back.',
  'Cannot approve with a one-way indemnity and no gross-negligence carve-out.',
  'Auto-renewal with an uncapped uplift — commercial has to reprice this before it comes back.',
  'Data residency is unspecified and this vendor stores EEA personal data. Rejected pending an SCC annex.',
  'Termination for convenience was struck out entirely. Not acceptable at this spend level.',
] as const

const SIGNER_ROLES = ['CFO', 'General Counsel', 'VP Procurement', 'Chief Revenue Officer', 'Authorized Signatory', 'Head of Legal'] as const
const EXTERNAL_SIGNERS: ReadonlyArray<{ name: string; email: string }> = [
  { name: 'Dana Whitfield',   email: 'dana.whitfield@counterparty.example' },
  { name: 'Marcus Oyelaran',  email: 'm.oyelaran@counterparty.example' },
  { name: 'Priya Raghunathan', email: 'priya.r@counterparty.example' },
  { name: 'Tomás Iglesias',   email: 't.iglesias@counterparty.example' },
  { name: 'Sarah Kleinman',   email: 'skleinman@counterparty.example' },
  { name: 'Henrik Bauer',     email: 'h.bauer@counterparty.example' },
  { name: 'Ada Nwosu',        email: 'ada.nwosu@counterparty.example' },
  { name: 'Julian Frost',     email: 'j.frost@counterparty.example' },
]

const COMMENT_THREADS: ReadonlyArray<{ body: string; clauseRef?: string; replies: string[] }> = [
  { clauseRef: 'Section 8.2 — Limitation of Liability',
    body: 'Their cap is 1× fees. Our floor for anyone holding production data is 12×. Can we get to 12× or at least a super-cap for the data-breach head of loss?',
    replies: [
      'Procurement pushed back — they say 12× is off-paper for this vendor tier. A super-cap at $2M for data breach might land.',
      'A $2M super-cap works for me. Draft it as a carve-out from the general cap rather than raising the cap itself.',
    ] },
  { clauseRef: 'Section 3.1 — Term and Renewal',
    body: 'Auto-renewal with a 90-day notice window. Diarised, but I want the notice period cut to 30 days if we are agreeing to a 3-year term.',
    replies: ['Agreed. I have flagged it in the redline and given them the reasoning.'] },
  { clauseRef: 'Section 12.4 — Assignment',
    body: 'Assignment is permitted without consent on a change of control. Given the acquisition rumours, that is a real exposure — we could wake up contracting with a competitor.',
    replies: [
      'Good catch. Ask for consent-not-to-be-unreasonably-withheld on any assignment to a Competitor as defined.',
      'Redline sent. They have come back accepting the competitor carve-out.',
    ] },
  { body: 'Finance flagged that the payment terms here are Net 45 rather than our standard Net 30. Is that deliberate?',
    replies: ['Yes — traded for a 4% discount on the annual commit. Worth it.'] },
  { clauseRef: 'Exhibit B — Fees',
    body: 'The uplift language has no cap. As drafted they can reprice at renewal by any amount and our only remedy is to walk.',
    replies: [
      'Asking for the lesser of CPI or 5%.',
      'They have agreed to CPI-capped-at-7%. Not our preferred position but within fallback.',
    ] },
  { clauseRef: 'DPA §3.4 — Subprocessors',
    body: 'The subprocessor annex lists two entities that no longer exist. This needs refreshing before we sign anything.',
    replies: ['Chased their privacy team; refreshed annex promised this week.'] },
  { body: 'Do we have the security questionnaire back for this one? I do not want to approve before InfoSec has looked at it.',
    replies: ['InfoSec cleared it yesterday — attaching their sign-off note to the approval.'] },
  { clauseRef: 'Section 9.1 — Compliance Reporting',
    body: 'They will furnish SOC 2 annually but will not commit to a date. We have been burned by that before — can we fix a date?',
    replies: ['Proposed "within 30 days of issuance, and no later than 31 March each year".'] },
  { body: 'Counterparty asked for an extension on turning the redline around. I said end of next week — flagging so nobody chases them in the meantime.',
    replies: [] },
  { clauseRef: 'Section 11.7 — Data Deletion',
    body: 'Deletion certificate within 30 days of termination is fine, but there is no obligation to delete backups. Add "including backups, subject to the retention schedule at Annex IV".',
    replies: ['Added. They accepted without comment.'] },
  { body: 'This is the third order form under the same MSA. Should we roll these into an enterprise agreement at renewal rather than papering each one?',
    replies: ['Yes — I have opened a matter for it so we do not lose the thread.'] },
  { clauseRef: 'Section 7.1 — Service Levels',
    body: 'SLA credits are capped at 5% of monthly fees, which makes the SLA close to decorative. Push for 15% and a termination right at three consecutive misses.',
    replies: [
      'They will do 10% and a termination right at four misses.',
      'Take it. Ten percent with a termination right is a real remedy; five was not.',
    ] },
  { body: 'Noting for the file: business wants this live by the end of the month, so if we are going to escalate the cap we should do it today.',
    replies: [] },
  { clauseRef: 'Section 14.2 — Governing Law',
    body: 'Governing law is set to their home jurisdiction. Our preferred set is Delaware, New York or England & Wales — this is outside it.',
    replies: ['They have agreed to New York with arbitration seated in New York.'] },
  { body: 'Pricing schedule does not match the quote procurement received. Roughly $40k adrift on the annual commit.',
    replies: ['Confirmed — their error. Corrected schedule is in the latest version.'] },
  { clauseRef: 'Section 6.3 — Intellectual Property',
    body: 'They are claiming ownership of anything their team touches, including the configuration we specified. That has to be joint at worst, ours at best.',
    replies: [
      'Standard for their category, unfortunately. Best case is a perpetual, irrevocable licence back to us.',
      'Licence-back is acceptable if it survives termination. Please make that explicit rather than implied.',
    ] },
  { clauseRef: 'Section 10.2 — Insurance',
    body: 'Cyber cover is $2M. Our floor for a processor at this data volume is $5M. Can procurement check whether they can raise it without repricing?',
    replies: ['Procurement asked — they can go to $5M for roughly $6k on the annual fee. Recommend we take it.'] },
  { body: 'Reminder that this one is inside the 90-day renewal window from next Tuesday. If we are not renewing, notice has to be out before then.',
    replies: [
      'Business has confirmed they want to renew, at a reduced commit.',
      'Understood — I will handle it as an amendment rather than letting it auto-roll.',
    ] },
  { clauseRef: 'Section 4.1 — Acceptance',
    body: 'There is no acceptance testing period at all — the deliverable is deemed accepted on delivery. Add a 15-business-day window with a defect right.',
    replies: ['They offered 10 business days. Taking it, with the defect right intact.'] },
  { body: 'Flagging that the counterparty entity on the signature block is a different legal entity from the one named in the recitals.',
    replies: [
      'Well spotted — the recitals name the parent, the signature block names a subsidiary.',
      'Fixed in this version; the contracting entity is now consistent throughout.',
    ] },
  { clauseRef: 'Section 15.4 — Notices',
    body: 'Notices clause still requires registered post. In practice nobody does that, and it makes our termination notice contestable. Add email to a named address.',
    replies: ['Agreed and drafted — email to their legal alias, with post as a belt-and-braces alternative.'] },
]

const EXTERNAL_COMMENTS = [
  'Thanks for the redline. We can accept the cap change but not the indemnity as drafted — our counsel will revert tomorrow.',
  'Confirming receipt. Our legal team is reviewing and we expect to come back by Friday.',
  'We are comfortable with the governing-law change. The payment terms remain an issue on our side.',
  'Our security team has approved the addendum. Attaching the completed questionnaire separately.',
] as const

const DILIGENCE_ROOMS: ReadonlyArray<{
  name: string; description: string; status: string; docs: number
}> = [
  { name: 'Project Meridian — Target Contract Review', status: 'ACTIVE', docs: 18,
    description: 'Buy-side diligence on the target’s commercial contract set. Looking for change-of-control triggers, assignment restrictions, exclusivity and anything that survives closing.' },
  { name: 'FY26 Vendor Consolidation — Top 15 Spend', status: 'ACTIVE', docs: 15,
    description: 'The fifteen largest vendor agreements by spend, pulled together for a single cross-document review of termination rights, notice windows and renewal traps.' },
  { name: 'EMEA Data Transfer Audit — DPA Sweep', status: 'ARCHIVED', docs: 12,
    description: 'Every agreement touching EEA personal data, swept for SCC coverage and subprocessor disclosure. Closed out after the remediation matter was opened.' },
]

const JURISDICTIONS = ['Delaware', 'New York', 'California', 'England & Wales', 'Singapore', 'Ireland', 'Texas', 'Washington'] as const
const DILIGENCE_TYPES = ['MSA', 'NDA', 'SOW', 'SLA', 'VENDOR_AGREEMENT', 'LICENSE', 'DATA_PROCESSING', 'ORDER_FORM', 'PARTNERSHIP'] as const
const DILIGENCE_RISK_FACTORS = [
  'Change of control triggers termination', 'Assignment prohibited without consent',
  'Exclusivity survives closing', 'Uncapped indemnity', 'MFN pricing clause',
  'Auto-renewal with 90-day notice', 'No termination for convenience',
  'Data residency unspecified', 'Liability cap below 12 months fees', 'Source-code escrow obligation',
] as const

// ─── Cleanup ────────────────────────────────────────────────────────────────

async function clean() {
  const w = { id: { startsWith: IDP } }
  const removed: Record<string, number> = {}

  // Children before parents. Comments: replies before the threads they hang off.
  removed.signatureEvents = (await prisma.signatureEvent.deleteMany({ where: w })).count
  removed.signers         = (await prisma.signer.deleteMany({ where: w })).count
  removed.signatureRequests = (await prisma.signatureRequest.deleteMany({ where: w })).count

  removed.invoices    = (await prisma.invoice.deleteMany({ where: w })).count
  removed.obligations = (await prisma.obligation.deleteMany({ where: w })).count

  removed.approvalSteps     = (await prisma.approvalStep.deleteMany({ where: w })).count
  removed.approvalInstances = (await prisma.approvalInstance.deleteMany({ where: w })).count

  const replies = await prisma.contractComment.deleteMany({ where: { id: { startsWith: IDP }, parentId: { not: null } } })
  const threads = await prisma.contractComment.deleteMany({ where: w })
  removed.comments = replies.count + threads.count

  removed.shareLinks = (await prisma.contractShareLink.deleteMany({ where: w })).count

  // Versions we minted for signature requests (portfolio contracts keep their row).
  removed.contractVersions = (await prisma.contractVersion.deleteMany({ where: w })).count

  // Diligence documents are ours outright.
  await prisma.contract.updateMany({ where: { diligenceRoomId: { startsWith: IDP } }, data: { diligenceRoomId: null } })
  removed.contracts       = (await prisma.contract.deleteMany({ where: w })).count
  removed.diligenceRooms  = (await prisma.diligenceRoom.deleteMany({ where: w })).count

  // Matter links were painted onto contracts we do not own — unset, don't delete.
  removed.matterLinksUnset = (await prisma.contract.updateMany({
    where: { matterId: { startsWith: IDP } }, data: { matterId: null },
  })).count
  await prisma.contractRequest.updateMany({ where: { matterId: { startsWith: IDP } }, data: { matterId: null } })
  await prisma.agentThread.updateMany({ where: { matterId: { startsWith: IDP } }, data: { matterId: null } })
  removed.matters = (await prisma.matter.deleteMany({ where: w })).count

  removed.workflowDefinitions = (await prisma.workflowDefinition.deleteMany({ where: w })).count

  const total = Object.values(removed).reduce((a, b) => a + b, 0)
  console.log(`✓ removed ${total} rows tagged ${IDP}*`)
  for (const [k, v] of Object.entries(removed)) if (v) console.log(`   ${k.padEnd(22)} ${String(v).padStart(4)}`)
}

// ─── Seed ───────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--clean')) return clean()

  const org = await prisma.organization.findFirst({ where: { name: 'Demo Org, Inc.' } })
  if (!org) throw new Error('Demo org not found — run `pnpm db:seed` first.')
  const orgId = org.id

  const admin = await prisma.user.findFirst({ where: { orgId, email: 'admin@demo.com' } })
  const legal = await prisma.user.findFirst({ where: { orgId, email: 'legal@demo.com' } })
  if (!admin || !legal) throw new Error('admin@demo.com / legal@demo.com not found — run `pnpm db:seed` first.')

  // Refuse to double-seed: one probe per family is enough, but check the
  // cheap ones so a half-finished run is still detected.
  const already =
    (await prisma.matter.count({ where: { id: { startsWith: IDP } } })) +
    (await prisma.obligation.count({ where: { id: { startsWith: IDP } } })) +
    (await prisma.approvalInstance.count({ where: { id: { startsWith: IDP } } })) +
    (await prisma.diligenceRoom.count({ where: { id: { startsWith: IDP } } }))
  if (already > 0) {
    console.log(`${already} ${IDP}* rows already present — run with --clean first to reshape.`)
    return
  }

  const portfolio = (await prisma.contract.findMany({
    where: { orgId, tags: { has: PORTFOLIO_TAG }, deletedAt: null },
    select: { id: true, title: true, type: true, status: true, value: true, counterpartyId: true, counterpartyName: true },
    orderBy: { id: 'asc' },
  })) as ContractLite[]
  if (portfolio.length === 0) throw new Error(`No ${PORTFOLIO_TAG} contracts — run seed-demo-portfolio.ts first.`)

  const counterparties = await prisma.counterparty.findMany({
    where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' },
  })
  const cpByName = new Map(counterparties.map(c => [c.name, c.id]))

  const byStatus = (s: string) => portfolio.filter(c => c.status === s)
  const executed = byStatus('EXECUTED')

  console.log(`Seeding against "${org.name}" — ${portfolio.length} portfolio contracts in scope.`)

  // ── 1. Matters, and the contracts that belong to them ────────────────────
  // A matter with a counterparty pulls that counterparty's contracts first;
  // the rest draw from a shared pool so nothing lands in two matters.
  const matterEligible = portfolio.filter(c => c.status !== 'ARCHIVED')
  const claimed = new Set<string>()
  const generalPool = pool(matterEligible)

  const matterRows: Array<Record<string, unknown>> = []
  const matterLinks: Array<{ matterId: string; contractIds: string[] }> = []

  MATTERS.forEach((m, i) => {
    const mid = id('mat', i + 1)
    const cpId = m.counterparty ? cpByName.get(m.counterparty) ?? null : null

    const wanted: string[] = []
    if (m.counterparty) {
      for (const c of matterEligible) {
        if (wanted.length >= m.contracts) break
        if (c.counterpartyName === m.counterparty && !claimed.has(c.id)) { wanted.push(c.id); claimed.add(c.id) }
      }
    }
    let guard = 0
    while (wanted.length < m.contracts && guard++ < generalPool.size * 2) {
      const c = generalPool.next()
      if (!claimed.has(c.id)) { wanted.push(c.id); claimed.add(c.id) }
    }

    const openedDaysAgo = int(20, 400)
    matterRows.push({
      id: mid, orgId, name: m.name, description: m.description, status: m.status,
      counterpartyId: cpId, counterpartyName: m.counterparty ?? null,
      ownerId: i % 3 === 0 ? admin.id : legal.id,
      createdById: admin.id,
      tags: [...m.tags, TAG],
      metadata: { seed: TAG },
      createdAt: at(-openedDaysAgo),
      updatedAt: at(-int(0, Math.min(openedDaysAgo, 20))),
      closedAt: m.status === 'OPEN' ? null : at(-int(5, 60)),
    })
    matterLinks.push({ matterId: mid, contractIds: wanted })
  })

  await prisma.matter.createMany({ data: matterRows as never })
  for (const link of matterLinks) {
    if (!link.contractIds.length) continue
    await prisma.contract.updateMany({
      where: { id: { in: link.contractIds } }, data: { matterId: link.matterId },
    })
  }

  // ── 2. Obligations ───────────────────────────────────────────────────────
  // Attached to EXECUTED contracts only — an obligation on a draft is noise.
  // Bucket plan (90 total):
  //   34 OPEN, future-dated (a third of them inside the 30-day "due soon" window)
  //   22 OPEN, past-dated  ← the genuinely overdue slice, 3 to 120 days late
  //    7 OVERDUE (stored label, also past-dated)
  //   22 COMPLETED
  //    5 WAIVED
  const oblContracts = pool(executed)
  type OblBucket = 'open_future' | 'open_late' | 'overdue' | 'completed' | 'waived'
  const oblPlan: OblBucket[] = [
    ...Array<OblBucket>(34).fill('open_future'),
    ...Array<OblBucket>(22).fill('open_late'),
    ...Array<OblBucket>(7).fill('overdue'),
    ...Array<OblBucket>(22).fill('completed'),
    ...Array<OblBucket>(5).fill('waived'),
  ]
  const oblRows: Array<Record<string, unknown>> = []
  // Spread lateness deterministically from 3 to 120 days rather than at random,
  // so the overdue column always contains the full range of severities.
  const lateSpread = (n: number, i: number) => Math.round(3 + (117 * i) / Math.max(1, n - 1))
  let lateIdx = 0
  const lateTotal = oblPlan.filter(b => b === 'open_late').length

  oblPlan.forEach((bucket, i) => {
    const c = oblContracts.next()
    const t = OBLIGATIONS[i % OBLIGATIONS.length]
    const oid = id('obl', i + 1)

    let dueDate: Date
    let status = 'OPEN'
    let completedAt: Date | null = null
    let completedById: string | null = null
    let completionNote: string | null = null
    let evidenceFilename: string | null = null

    if (bucket === 'open_future') {
      dueDate = chance(0.4) ? at(int(1, 30)) : at(int(31, 400))
    } else if (bucket === 'open_late') {
      dueDate = at(-lateSpread(lateTotal, lateIdx++))
    } else if (bucket === 'overdue') {
      status = 'OVERDUE'
      dueDate = at(-int(8, 95))
    } else if (bucket === 'completed') {
      status = 'COMPLETED'
      // Roughly half discharged inside the last month, because the obligations
      // KPI counts "completed in the last 30 days" — an all-historic set makes
      // that tile read zero on a screen full of completed rows.
      dueDate = chance(0.5) ? at(-int(3, 26)) : at(-int(30, 200))
      completedAt = new Date(Math.min(dueDate.getTime() + int(-6, 9) * day, NOW - day))
      completedById = chance(0.5) ? admin.id : legal.id
      completionNote = pick(COMPLETION_NOTES)
      evidenceFilename = chance(0.45) ? `${t.type}-evidence-${int(1000, 9999)}.pdf` : null
    } else {
      status = 'WAIVED'
      dueDate = at(-int(10, 180))
      completionNote = pick(WAIVER_NOTES)
    }

    oblRows.push({
      id: oid, orgId, contractId: c.id,
      type: t.type, description: t.description, owner: t.owner,
      dueDate, recurrence: t.recurrence,
      trigger: t.recurrence === 'on-event' ? 'Triggered by the event described in the quoted clause.' : null,
      quote: t.quote, severity: t.severity, sectionRef: t.sectionRef,
      status, completedAt, completedById, completionNote,
      evidenceFilename,
      evidenceS3Key: evidenceFilename ? `demo/evidence/${oid}.pdf` : null,
      evidenceMimeType: evidenceFilename ? 'application/pdf' : null,
      evidenceSize: evidenceFilename ? int(40_000, 900_000) : null,
      // Notified only where a scanner would plausibly have fired already.
      notifiedAt: (status === 'OPEN' && dueDate.getTime() < NOW + 30 * day) ? at(-int(1, 25)) : null,
      createdAt: at(-int(30, 500)),
    })
  })
  await prisma.obligation.createMany({ data: oblRows as never })

  // ── 3. Invoices ──────────────────────────────────────────────────────────
  // Matched invoices point at real payment obligations; reconciled ones point
  // at obligations that are actually COMPLETED, because that is the state the
  // reconcile endpoint leaves behind. Unmatched invoices are the pile a
  // reconciliation screen exists to work through.
  const paymentOpen = oblRows.filter(o => o.type === 'payment' && o.status === 'OPEN')
  const paymentDone = oblRows.filter(o => o.type === 'payment' && o.status === 'COMPLETED')
  const matchPool = pool(paymentOpen)
  const donePool = pool(paymentDone)
  const invContracts = pool(executed)

  const ORPHAN_VENDORS = [
    'Northgate Facilities Ltd', 'Aperture Print & Mail', 'Helio Translations',
    'Bridgeway Staffing', 'Kestrel Courier Services',
  ] as const
  const INVOICE_DESCRIPTIONS = [
    'Quarterly platform subscription', 'Professional services — sprint 4',
    'Annual true-up, usage above commit', 'Implementation milestone 2',
    'Support and maintenance renewal', 'Overage — API calls above tier',
    'Onboarding and data migration', 'Additional seats, pro-rated',
    'Training workshop (2 days, onsite)', 'Premium support upgrade',
  ] as const

  type InvBucket = 'pending' | 'matched' | 'reconciled' | 'disputed'
  const invPlan: InvBucket[] = [
    ...Array<InvBucket>(10).fill('pending'),
    ...Array<InvBucket>(12).fill('matched'),
    ...Array<InvBucket>(12).fill('reconciled'),
    ...Array<InvBucket>(6).fill('disputed'),
  ]
  const invRows: Array<Record<string, unknown>> = []

  invPlan.forEach((bucket, i) => {
    const n = i + 1
    // Amounts span three orders of magnitude — a tabular figure column is only
    // worth having if the numbers actually differ in width.
    const band = rnd()
    const amount = band < 0.4 ? int(1_000, 24_000)
      : band < 0.75 ? int(24_000, 120_000)
      : band < 0.93 ? int(120_000, 400_000)
      : int(400_000, 800_000)

    const orphan = bucket === 'pending' && chance(0.4)
    const linkedObl = bucket === 'matched' ? matchPool.next()
      : bucket === 'reconciled' ? donePool.next() : null
    const contractId = orphan ? null
      : (linkedObl ? (linkedObl.contractId as string) : invContracts.next().id)
    const contract = contractId ? portfolio.find(c => c.id === contractId) ?? null : null

    const invoiceDate = at(-int(2, 240))
    const netDays = pick([30, 45, 60])
    const status = bucket.toUpperCase()

    invRows.push({
      id: id('inv', n), orgId, contractId,
      matchedObligationId: linkedObl ? (linkedObl.id as string) : null,
      matchScore: linkedObl ? Math.round((0.68 + rnd() * 0.31) * 100) / 100 : null,
      vendorName: orphan ? pick(ORPHAN_VENDORS) : (contract?.counterpartyName ?? pick(ORPHAN_VENDORS)),
      invoiceNumber: `INV-${2025 + (n % 2)}-${String(1000 + n * 7).slice(0, 4)}`,
      amount, currency: 'USD',
      invoiceDate,
      dueDate: new Date(invoiceDate.getTime() + netDays * day),
      description: pick(INVOICE_DESCRIPTIONS),
      status,
      reconciledAt: bucket === 'reconciled' ? new Date(Math.min(invoiceDate.getTime() + int(10, 70) * day, NOW - day)) : null,
      reconciledById: bucket === 'reconciled' ? (chance(0.5) ? admin.id : legal.id) : null,
      disputeReason: bucket === 'disputed'
        ? pick([
            'Amount is $12,400 above the rate card in Exhibit B.',
            'Billed for seats that were deprovisioned in the previous quarter.',
            'Duplicate of INV-2025-1042 — same period, same line items.',
            'Services were not accepted; milestone remains open.',
            'Currency conversion applied at the wrong date; short by 3%.',
            'PO number does not match any open purchase order.',
          ])
        : null,
      notes: chance(0.25) ? 'Received by AP inbox; awaiting cost-centre coding.' : null,
      createdById: chance(0.5) ? admin.id : legal.id,
      createdAt: new Date(invoiceDate.getTime() + int(0, 4) * day),
    })
  })
  await prisma.invoice.createMany({ data: invRows as never })

  // ── 4. Diligence rooms + their documents ─────────────────────────────────
  // These contracts are deliberately NOT part of the main repository (the repo
  // query excludes rows with a diligenceRoomId), so the batch does not distort
  // the portfolio distribution the other seed is careful about.
  const roomRows: Array<Record<string, unknown>> = []
  const diligenceContracts: Array<Record<string, unknown>> = []
  let docN = 0

  DILIGENCE_ROOMS.forEach((r, i) => {
    const rid = id('room', i + 1)
    const opened = int(6, 90)
    roomRows.push({
      id: rid, orgId, name: r.name, description: r.description, status: r.status,
      createdById: admin.id, createdAt: at(-opened), updatedAt: at(-int(0, 5)),
    })

    for (let d = 0; d < r.docs; d++) {
      docN++
      const cp = counterparties[(docN * 7) % counterparties.length]
      const type = pick(DILIGENCE_TYPES)
      // Most documents finish processing; a couple fail and a couple are still
      // running, so the room's progress bar has all three states to render.
      const roll = rnd()
      const analysisStatus = roll < 0.82 ? 'DONE' : roll < 0.90 ? 'ANALYZING' : roll < 0.95 ? 'FAILED' : 'PENDING'
      const riskRoll = rnd()
      const risk = riskRoll < 0.45 ? int(5, 33) : riskRoll < 0.8 ? int(34, 66) : int(67, 94)
      const factors = risk >= 34
        ? [...new Set(Array.from({ length: risk >= 67 ? int(2, 4) : int(1, 2) }, () => pick(DILIGENCE_RISK_FACTORS)))]
        : []

      diligenceContracts.push({
        id: id('dil', docN), orgId, ownerId: admin.id, createdBy: admin.id,
        diligenceRoomId: rid,
        title: `${cp.name.replace(/[.,]/g, '')} — ${type.replace(/_/g, ' ')}`,
        type,
        status: chance(0.82) ? 'EXECUTED' : chance(0.5) ? 'EXPIRED' : 'TERMINATED',
        counterpartyId: cp.id, counterpartyName: cp.name,
        value: type === 'NDA' ? null : int(15_000, 4_200_000),
        currency: 'USD',
        effectiveDate: at(-int(200, 2200)),
        expiryDate: at(int(-300, 900)),
        jurisdiction: pick(JURISDICTIONS),
        riskScore: analysisStatus === 'DONE' ? risk : null,
        riskFactors: analysisStatus === 'DONE' ? factors : [],
        overallConfidence: analysisStatus === 'DONE' ? Math.round((0.55 + rnd() * 0.44) * 100) / 100 : null,
        analysisStatus,
        analysisError: analysisStatus === 'FAILED' ? 'Scanned PDF — OCR confidence below threshold on 6 of 22 pages.' : null,
        summary: analysisStatus === 'DONE'
          ? `${type.replace(/_/g, ' ')} with ${cp.name}. Reviewed for change-of-control, assignment and exclusivity.`
          : null,
        keyTerms: analysisStatus === 'DONE' ? {
          term: `${pick([12, 24, 36, 60])} months`,
          autoRenew: chance(0.5),
          noticeDays: pick([30, 60, 90]),
          changeOfControl: pick(['Consent required', 'Notice only', 'Silent', 'Termination right']),
        } : {},
        tags: [TAG, 'diligence'],
        createdAt: at(-opened + d * 0.02),
      })
    }
  })
  await prisma.diligenceRoom.createMany({ data: roomRows as never })
  await prisma.contract.createMany({ data: diligenceContracts as never })

  // ── 5. Workflow definitions ──────────────────────────────────────────────
  // 1-INDEXED step orders on purpose — see the header note about the
  // dashboard badge's GREATEST(currentStepOrder, 1).
  const wfRows = WORKFLOWS.map((w, i) => ({
    id: id('wf', i + 1), orgId, name: w.name, description: w.description,
    triggerRules: w.triggerRules,
    steps: w.steps.map((s, si) => ({
      order: si + 1,
      name: s.name,
      ...(s.executionMode === 'parallel'
        ? { approverIds: [legal.id, admin.id] }
        : { approverId: s.role === 'admin' ? admin.id : legal.id }),
      executionMode: s.executionMode,
      requiredApprovals: s.requiredApprovals,
      dueSoonHours: s.dueSoonHours,
    })),
    isDefault: false,
    isActive: true,
    createdById: admin.id,
    createdAt: at(-int(60, 300)),
  }))
  await prisma.workflowDefinition.createMany({ data: wfRows as never })

  // ── 6. Approval instances + steps ────────────────────────────────────────
  // 12 PENDING (7 of them parked on admin at the CURRENT step, which is what
  // "my queue" and the sidebar badge read), 8 APPROVED, 5 REJECTED.
  const pendingContracts = pool([...byStatus('PENDING_APPROVAL'), ...byStatus('PENDING_REVIEW')])
  const approvedContracts = pool([...byStatus('APPROVED'), ...executed.slice(0, 40)])
  const rejectedContracts = pool(byStatus('DRAFT'))

  type ApprovalPlan = { kind: 'PENDING' | 'APPROVED' | 'REJECTED'; wf: number; adminTurn: boolean }
  const approvalPlan: ApprovalPlan[] = [
    { kind: 'PENDING',  wf: 0, adminTurn: true },
    { kind: 'PENDING',  wf: 0, adminTurn: true },
    { kind: 'PENDING',  wf: 2, adminTurn: true },
    { kind: 'PENDING',  wf: 0, adminTurn: true },
    { kind: 'PENDING',  wf: 2, adminTurn: true },
    { kind: 'PENDING',  wf: 1, adminTurn: false },
    { kind: 'PENDING',  wf: 0, adminTurn: false },
    { kind: 'PENDING',  wf: 2, adminTurn: true },
    { kind: 'PENDING',  wf: 0, adminTurn: false },
    { kind: 'PENDING',  wf: 1, adminTurn: false },
    { kind: 'PENDING',  wf: 0, adminTurn: true },
    { kind: 'PENDING',  wf: 2, adminTurn: false },
    ...Array.from({ length: 8 }, (_, i): ApprovalPlan => ({ kind: 'APPROVED', wf: i % 3, adminTurn: false })),
    ...Array.from({ length: 5 }, (_, i): ApprovalPlan => ({ kind: 'REJECTED', wf: i % 3, adminTurn: false })),
  ]

  const instanceRows: Array<Record<string, unknown>> = []
  const stepRows: Array<Record<string, unknown>> = []
  /** Contracts that end up with an approval — the "busy" set comments hang off. */
  const busyContracts: ContractLite[] = []
  let stepN = 0

  approvalPlan.forEach((planned, i) => {
    const wf = WORKFLOWS[planned.wf]
    const wfId = id('wf', planned.wf + 1)
    const contract = planned.kind === 'PENDING' ? pendingContracts.next()
      : planned.kind === 'APPROVED' ? approvedContracts.next()
      : rejectedContracts.next()
    busyContracts.push(contract)

    const iid = id('appr', i + 1)
    const submittedDaysAgo = planned.kind === 'PENDING' ? int(1, 21) : int(20, 180)
    const ai = AI_SUMMARIES[i % AI_SUMMARIES.length]
    const hasAi = !(i % 7 === 3) // one in seven has no AI pass yet — that state renders too

    // Where the chain has got to.
    const total = wf.steps.length
    const currentStepOrder = planned.kind === 'PENDING'
      ? (total === 1 ? 1 : int(1, total))
      : total

    instanceRows.push({
      id: iid, orgId, contractId: contract.id, workflowDefinitionId: wfId,
      status: planned.kind,
      currentStepOrder,
      submittedById: chance(0.5) ? admin.id : legal.id,
      aiSummary: hasAi ? ai.summary : null,
      keyRisks: hasAi ? ai.risks : [],
      nonStandardTerms: hasAi ? ai.nonStandard : [],
      approvalRecommendation: hasAi
        ? (planned.kind === 'REJECTED' ? 'reject_advised' : planned.kind === 'APPROVED' ? 'approve' : ai.rec)
        : null,
      submittedAt: at(-submittedDaysAgo),
      decidedAt: planned.kind === 'PENDING' ? null : at(-int(1, Math.max(2, submittedDaysAgo - 1))),
      createdAt: at(-submittedDaysAgo),
    })

    // The step where a REJECTED chain died.
    const rejectAt = planned.kind === 'REJECTED' ? (total === 1 ? 1 : int(1, total)) : -1

    wf.steps.forEach((sdef, si) => {
      const order = si + 1
      // A parallel step is two concurrent rows at the same order — that is what
      // makes an N-of-M timeline show a mix rather than a single lane.
      const approvers: string[] = sdef.executionMode === 'parallel'
        ? [legal.id, admin.id]
        : [sdef.role === 'admin' ? admin.id : legal.id]

      approvers.forEach((approverBase, ai2) => {
        stepN++
        // Park the current step on admin where the plan calls for it.
        const approverId = planned.kind === 'PENDING' && order === currentStepOrder && planned.adminTurn && ai2 === 0
          ? admin.id
          : approverBase

        let status = 'PENDING'
        let decision: string | null = null
        let comment: string | null = null
        let decidedAt: Date | null = null

        if (planned.kind === 'APPROVED') {
          status = 'APPROVED'; decision = 'APPROVED'
          comment = chance(0.6) ? pick(APPROVE_COMMENTS) : null
          decidedAt = past(-submittedDaysAgo + (order + 1) * int(1, 3))
        } else if (planned.kind === 'REJECTED') {
          if (order < rejectAt) {
            status = 'APPROVED'; decision = 'APPROVED'
            comment = chance(0.5) ? pick(APPROVE_COMMENTS) : null
            decidedAt = past(-submittedDaysAgo + order * int(1, 3))
          } else if (order === rejectAt && ai2 === 0) {
            status = 'REJECTED'; decision = 'REJECTED'
            comment = pick(REJECT_COMMENTS)
            decidedAt = past(-submittedDaysAgo + order * int(1, 3))
          } else {
            // The engine closes the rest of the chain when one step rejects.
            status = 'REJECTED'; decision = null
            decidedAt = past(-submittedDaysAgo + order * int(1, 3))
          }
        } else if (order < currentStepOrder) {
          status = 'APPROVED'; decision = 'APPROVED'
          comment = chance(0.55) ? pick(APPROVE_COMMENTS) : null
          decidedAt = past(-submittedDaysAgo + order * int(1, 3))
        } else if (order === currentStepOrder && sdef.executionMode === 'parallel' && ai2 === 1) {
          // Half-decided parallel step: one lane in, one lane still waiting.
          status = chance(0.6) ? 'APPROVED' : 'PENDING'
          if (status === 'APPROVED') {
            decision = 'APPROVED'; comment = pick(APPROVE_COMMENTS)
            decidedAt = at(-int(1, Math.max(2, submittedDaysAgo)))
          }
        }

        stepRows.push({
          id: id('step', stepN), approvalInstanceId: iid, orgId,
          stepOrder: order, stepName: sdef.name, approverId,
          status, decision, comment, decidedAt,
          // Live steps carry an escalation deadline; some have already blown it.
          escalateAt: status === 'PENDING' ? at(chance(0.3) ? -int(1, 6) : int(1, 5)) : null,
          escalationJobId: null,
          createdAt: past(-submittedDaysAgo + order * 0.5),
        })
      })
    })
  })
  await prisma.approvalInstance.createMany({ data: instanceRows as never })
  await prisma.approvalStep.createMany({ data: stepRows as never })

  // ── 7. Signature requests, signers, events ───────────────────────────────
  // A request freezes a version, so each of these contracts gets one minted
  // here (portfolio contracts arrived without any). Statuses are the four the
  // API supports; "partially signed" is a PENDING request with some signers in.
  type SigStatus = 'PENDING' | 'COMPLETED' | 'VOIDED' | 'EXPIRED'
  const sigPending  = pool(byStatus('PENDING_SIGNATURE'))
  const sigDone     = pool(executed.slice(40, 100))
  const sigVoided   = pool(byStatus('UNDER_NEGOTIATION'))
  const sigExpired  = pool([...byStatus('UNDER_NEGOTIATION'), ...byStatus('TERMINATED')])
  const sigPlan: SigStatus[] = [
    ...Array<SigStatus>(7).fill('PENDING'),
    ...Array<SigStatus>(6).fill('COMPLETED'),
    ...Array<SigStatus>(2).fill('VOIDED'),
    ...Array<SigStatus>(3).fill('EXPIRED'),
  ]
  // One request per contract: each mints a version at versionNumber 1, and
  // [contractId, versionNumber] is unique. Two requests on one contract would
  // fail the insert, so the draw skips anything already spoken for.
  const sigUsed = new Set<string>()
  const drawSig = (p: { next(): ContractLite; size: number }): ContractLite => {
    for (let tries = 0; tries < p.size * 2; tries++) {
      const c = p.next()
      if (!sigUsed.has(c.id)) { sigUsed.add(c.id); return c }
    }
    const fallback = p.next()
    sigUsed.add(fallback.id)
    return fallback
  }

  const versionRows: Array<Record<string, unknown>> = []
  const srRows: Array<Record<string, unknown>> = []
  const signerRows: Array<Record<string, unknown>> = []
  const eventRows: Array<Record<string, unknown>> = []
  let signerN = 0
  let eventN = 0
  const extPool = pool(EXTERNAL_SIGNERS)

  sigPlan.forEach((status, i) => {
    const n = i + 1
    const contract = drawSig(
      status === 'PENDING' ? sigPending
        : status === 'COMPLETED' ? sigDone
        : status === 'VOIDED' ? sigVoided : sigExpired,
    )
    busyContracts.push(contract)

    const srId = id('sr', n)
    const verId = id('ver', n)
    const sentDaysAgo = status === 'PENDING' ? int(1, 18) : int(25, 210)

    versionRows.push({
      id: verId, contractId: contract.id, versionNumber: 1,
      htmlContent: `<h1>${contract.title}</h1><p>This ${contract.type.replace(/_/g, ' ')} is entered into between Demo Org, Inc. and ${contract.counterpartyName ?? 'the Counterparty'} and is executed by the signatories below.</p><p>The full form of agreement, its exhibits and schedules are incorporated by reference.</p>`,
      plainText: `${contract.title}\n\nThis ${contract.type.replace(/_/g, ' ')} is entered into between Demo Org, Inc. and ${contract.counterpartyName ?? 'the Counterparty'} and is executed by the signatories below.`,
      changeNote: 'Execution copy sent for signature.',
      createdById: admin.id,
      createdAt: at(-sentDaysAgo - 1),
      metadata: { seed: TAG },
    })

    const signerCount = int(1, 3)
    const sequential = chance(0.55)
    // Give admin@demo.com a real turn on the first three live requests so the
    // sidebar's "signatures awaiting me" badge is not permanently zero. Admin
    // is always signer #1 and always still unsigned, which is what makes them
    // the blocker under both SEQUENTIAL and ANY ordering.
    const adminSigns = status === 'PENDING' && i < 3
    const signersForThis: Array<{
      id: string; name: string; email: string; role: string; order: number; signed: boolean
      declined: boolean; signedAt: Date | null
    }> = []

    for (let s = 0; s < signerCount; s++) {
      signerN++
      const internalFirst = s === 0
      const ext = extPool.next()
      const isAdmin = adminSigns && internalFirst
      const name = isAdmin ? admin.name : internalFirst && chance(0.5) ? legal.name : ext.name
      const email = isAdmin ? admin.email : name === legal.name ? legal.email : ext.email

      // Who has actually signed.
      let signed = false
      let declined = false
      if (status === 'COMPLETED') signed = true
      else if (status === 'PENDING') signed = !isAdmin && s === 0 && signerCount > 1 && chance(0.65)
      else if (status === 'EXPIRED') signed = s === 0 && chance(0.4)
      else if (status === 'VOIDED') { signed = false; declined = s === signerCount - 1 && chance(0.6) }

      const signedAt = signed ? past(-sentDaysAgo + int(1, 4)) : null
      signersForThis.push({
        id: id('sgn', signerN), name, email,
        role: pick(SIGNER_ROLES), order: sequential ? s + 1 : 1,
        signed, declined, signedAt,
      })
    }

    // Admin should be the blocker, not buried behind another signer.
    const signedCount = signersForThis.filter(s => s.signed).length

    srRows.push({
      id: srId, orgId, contractId: contract.id, versionId: verId,
      status,
      signOrder: sequential ? 'SEQUENTIAL' : 'ANY',
      expiresAt: at(-sentDaysAgo + (status === 'EXPIRED' ? int(5, 20) : int(20, 45))),
      message: `Please review and sign the ${contract.type.replace(/_/g, ' ')} with ${contract.counterpartyName ?? 'the counterparty'}. Reach out to legal@demo.com with any questions before signing.`,
      createdById: admin.id,
      createdAt: at(-sentDaysAgo),
      completedAt: status === 'COMPLETED' ? past(-sentDaysAgo + int(2, 9)) : null,
      voidedAt: status === 'VOIDED' ? past(-sentDaysAgo + int(3, 12)) : null,
      voidedReason: status === 'VOIDED'
        ? pick([
            'Superseded — commercial terms reopened after the counterparty’s counter-signature request.',
            'Voided by sender: wrong entity named as the contracting party.',
            'Counterparty declined; renegotiating the liability cap before re-issuing.',
          ])
        : null,
    })

    for (const s of signersForThis) {
      signerRows.push({
        id: s.id, signatureRequestId: srId, email: s.email, name: s.name,
        role: s.role,
        userId: s.email === admin.email ? admin.id : s.email === legal.email ? legal.id : null,
        signOrder: s.order,
        token: `${IDP}tok${String(signerN).padStart(3, '0')}${Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0')}`,
        status: s.signed ? 'SIGNED' : s.declined ? 'DECLINED' : 'PENDING',
        signedAt: s.signedAt,
        declinedAt: s.declined ? past(-sentDaysAgo + int(2, 8)) : null,
        declinedReason: s.declined ? 'Our counsel has not cleared the indemnity as drafted.' : null,
        signedName: s.signed ? s.name : null,
        signedIp: s.signed ? `203.0.113.${int(2, 250)}` : null,
        signedUserAgent: s.signed ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' : null,
        signature: s.signed ? { typed: s.name, font: 'Caveat' } : {},
        createdAt: at(-sentDaysAgo),
      })
    }

    // Event trail: sent, viewed, signed, reminded, and the terminal event.
    const evt = (kind: string, whenDays: number, signerId: string | null, metadata: Record<string, unknown> = {}) => {
      eventN++
      eventRows.push({
        id: id('evt', eventN), signatureRequestId: srId, signerId, kind, metadata,
        ipAddress: signerId ? `203.0.113.${int(2, 250)}` : null,
        userAgent: signerId ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' : null,
        createdAt: past(whenDays),
      })
    }
    evt('SENT', -sentDaysAgo, null, { recipients: signersForThis.length })
    for (const s of signersForThis) {
      if (s.signed || chance(0.6)) evt('VIEWED', -sentDaysAgo + int(0, 2) + 0.2, s.id, {})
      if (s.signed) evt('SIGNED', -sentDaysAgo + int(1, 4) + 0.4, s.id, { name: s.name })
      if (s.declined) evt('DECLINED', -sentDaysAgo + int(2, 8), s.id, { reason: 'Indemnity not cleared' })
    }
    if (status === 'PENDING' && signedCount < signersForThis.length && chance(0.5)) {
      evt('REMINDED', -int(1, Math.max(2, sentDaysAgo - 1)), null, { channel: 'email' })
    }
    if (status === 'COMPLETED') evt('COMPLETED', -sentDaysAgo + int(2, 9) + 0.6, null, {})
    if (status === 'VOIDED') evt('VOIDED', -sentDaysAgo + int(3, 12) + 0.5, null, {})
  })

  await prisma.contractVersion.createMany({ data: versionRows as never })
  await prisma.signatureRequest.createMany({ data: srRows as never })
  await prisma.signer.createMany({ data: signerRows as never })
  await prisma.signatureEvent.createMany({ data: eventRows as never })

  // ── 8. Share links (so external comments point at something real) ────────
  const linkTargets = shuffled(busyContracts).slice(0, 4)
  const shareRows = linkTargets.map((c, i) => ({
    id: id('lnk', i + 1), orgId, contractId: c.id,
    token: `${IDP}share${String(i + 1).padStart(2, '0')}${Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0')}`,
    label: `${c.counterpartyName ?? 'Counterparty'} — review link`,
    invitedEmail: `legal@${(c.counterpartyName ?? 'counterparty').toLowerCase().replace(/[^a-z]/g, '').slice(0, 14) || 'counterparty'}.example`,
    permissions: ['read', 'comment'],
    expiresAt: at(int(5, 40)),
    viewCount: int(0, 14),
    lastViewedAt: chance(0.7) ? at(-int(0, 9)) : null,
    createdById: legal.id,
    createdAt: at(-int(3, 40)),
  }))
  await prisma.contractShareLink.createMany({ data: shareRows as never })

  // ── 9. Comments — threaded, on the contracts that are actually busy ──────
  const commentTargets = shuffled([...new Set(busyContracts.map(c => c.id))]).slice(0, 18)
  const commentRows: Array<Record<string, unknown>> = []
  let cN = 0
  let target = 0

  COMMENT_THREADS.forEach((t, i) => {
    const contractId = commentTargets[target % commentTargets.length]
    target++
    cN++
    const rootId = id('cmt', cN)
    const daysAgo = int(1, 60)
    const resolved = chance(0.35)
    commentRows.push({
      id: rootId, orgId, contractId, versionId: null,
      clauseRef: t.clauseRef ?? null, parentId: null,
      authorId: i % 3 === 0 ? admin.id : legal.id,
      body: t.body,
      resolved,
      resolvedById: resolved ? admin.id : null,
      resolvedAt: resolved ? at(-int(0, Math.max(1, daysAgo - 1))) : null,
      createdAt: at(-daysAgo),
      updatedAt: at(-daysAgo),
    })
    t.replies.forEach((r, ri) => {
      cN++
      commentRows.push({
        id: id('cmt', cN), orgId, contractId, versionId: null,
        clauseRef: t.clauseRef ?? null, parentId: rootId,
        authorId: ri % 2 === 0 ? legal.id : admin.id,
        body: r,
        resolved: false,
        createdAt: at(-daysAgo + (ri + 1) * 0.4),
        updatedAt: at(-daysAgo + (ri + 1) * 0.4),
      })
    })
  })

  // A handful of external (portal) comments — a different author shape the
  // comment panel has to render, and the only one it labels by name.
  EXTERNAL_COMMENTS.forEach((body, i) => {
    const link = shareRows[i % shareRows.length]
    cN++
    const rootId = id('cmt', cN)
    const daysAgo = int(1, 20)
    commentRows.push({
      id: rootId, orgId, contractId: link.contractId, versionId: null,
      clauseRef: null, parentId: null,
      authorId: `portal:${link.id}`,
      body,
      resolved: false,
      createdAt: at(-daysAgo),
      updatedAt: at(-daysAgo),
    })
    cN++
    commentRows.push({
      id: id('cmt', cN), orgId, contractId: link.contractId, versionId: null,
      clauseRef: null, parentId: rootId,
      authorId: legal.id,
      body: 'Acknowledged — we will come back to you on the indemnity by close of business tomorrow.',
      resolved: false,
      createdAt: at(-daysAgo + 0.5),
      updatedAt: at(-daysAgo + 0.5),
    })
  })

  // Threads before replies, so the self-referential FK is always satisfiable.
  await prisma.contractComment.createMany({ data: commentRows.filter(c => c.parentId == null) as never })
  await prisma.contractComment.createMany({ data: commentRows.filter(c => c.parentId != null) as never })

  // ── Summary ──────────────────────────────────────────────────────────────
  const w = { id: { startsWith: IDP } }
  const counts: Array<[string, number]> = [
    ['matters',              await prisma.matter.count({ where: w })],
    ['matter→contract links', await prisma.contract.count({ where: { matterId: { startsWith: IDP } } })],
    ['obligations',          await prisma.obligation.count({ where: w })],
    ['invoices',             await prisma.invoice.count({ where: w })],
    ['diligence rooms',      await prisma.diligenceRoom.count({ where: w })],
    ['diligence documents',  await prisma.contract.count({ where: w })],
    ['workflow definitions', await prisma.workflowDefinition.count({ where: w })],
    ['approval instances',   await prisma.approvalInstance.count({ where: w })],
    ['approval steps',       await prisma.approvalStep.count({ where: w })],
    ['signature requests',   await prisma.signatureRequest.count({ where: w })],
    ['signers',              await prisma.signer.count({ where: w })],
    ['signature events',     await prisma.signatureEvent.count({ where: w })],
    ['contract versions',    await prisma.contractVersion.count({ where: w })],
    ['share links',          await prisma.contractShareLink.count({ where: w })],
    ['comments',             await prisma.contractComment.count({ where: w })],
  ]
  console.log(`\n✓ seeded into "${org.name}"`)
  for (const [k, v] of counts) console.log(`   ${k.padEnd(22)} ${String(v).padStart(4)}`)

  // The distributions that matter, stated rather than assumed.
  const overdueLive = await prisma.obligation.count({
    where: { orgId, status: 'OPEN', dueDate: { lt: new Date(NOW) } },
  })
  const dueSoon = await prisma.obligation.count({
    where: { orgId, status: 'OPEN', dueDate: { gte: new Date(NOW), lte: at(30) } },
  })
  // What "my queue" and the sidebar badge will actually show: a pending step
  // assigned to admin AND sitting at its instance's current step order.
  const adminPending = await prisma.approvalStep.findMany({
    where: { orgId, approverId: admin.id, status: 'PENDING' },
    select: { stepOrder: true, approvalInstanceId: true },
  })
  const instanceOrder = new Map(
    (await prisma.approvalInstance.findMany({
      where: { id: { in: [...new Set(adminPending.map(s => s.approvalInstanceId))] } },
      select: { id: true, currentStepOrder: true },
    })).map(i => [i.id, i.currentStepOrder]),
  )
  const myTurn = adminPending.filter(s => instanceOrder.get(s.approvalInstanceId) === s.stepOrder).length
  const myTurnBadge = adminPending.filter(
    s => s.stepOrder === Math.max(instanceOrder.get(s.approvalInstanceId) ?? 0, 1),
  ).length
  const oblMix = await prisma.obligation.groupBy({ by: ['status'], where: w, _count: true })
  const invMix = await prisma.invoice.groupBy({ by: ['status'], where: w, _count: true })
  const aprMix = await prisma.approvalInstance.groupBy({ by: ['status'], where: w, _count: true })
  const sigMix = await prisma.signatureRequest.groupBy({ by: ['status'], where: w, _count: true })

  const fmt = (rows: Array<{ status: string; _count: number }>) =>
    rows.map(r => `${r.status}=${r._count}`).join('  ')
  console.log(`\n   obligations   ${fmt(oblMix as never)}`)
  console.log(`   · genuinely overdue (OPEN, past due, org-wide): ${overdueLive}`)
  console.log(`   · due inside 30 days:                           ${dueSoon}`)
  console.log(`   invoices      ${fmt(invMix as never)}`)
  console.log(`   approvals     ${fmt(aprMix as never)}`)
  console.log(`   · admin@demo.com "my queue" (current-step, org-wide): ${myTurn}`)
  console.log(`   · admin@demo.com sidebar badge will read:             ${myTurnBadge}`)
  console.log(`   signatures    ${fmt(sigMix as never)}`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
