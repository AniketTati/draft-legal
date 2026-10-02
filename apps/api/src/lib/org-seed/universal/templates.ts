/**
 * Universal templates — 20 contract templates covering the most-used
 * commercial agreements.
 *
 * Each template is composed of ordered `TemplateSection` rows. Section
 * content is plain HTML with `{{variable}}` placeholders, resolved at
 * generation time from the values supplied for `Template.variables`.
 *
 * Re-running the seed is safe: existing templates (matched by orgId + name)
 * are skipped, not duplicated. Sections are only inserted when the template
 * is newly created — re-running does not modify existing template content.
 */

export interface SeedTemplateVariable {
  key: string
  label: string
  type: 'string' | 'number' | 'date' | 'enum'
  required: boolean
  defaultValue?: string | number
  /** docs/41 P0.4 — the org chose this default (a legal choice is filled from it only then). */
  orgDefault?: boolean
  options?: string[]   // for enum types
  helpText?: string
}

export interface SeedTemplateSection {
  title: string
  sortOrder: number
  content: string
  /** docs/41 Part 1 — a clause slot over this seeded family (families.ts), by name. */
  slotFamily?: string
}

export interface SeedTemplate {
  name: string
  description: string
  contractType: string | null
  variables: SeedTemplateVariable[]
  sections: SeedTemplateSection[]
  isPublished: boolean
  /** docs/41 Part 1 — the template drafting uses for its type when nobody picks one. */
  isDefaultForType?: boolean
}

// ─── Common variables reused across multiple templates ─────────────────────
const PARTIES_VARS: SeedTemplateVariable[] = [
  { key: 'customerName',       label: 'Customer Name',          type: 'string', required: true },
  { key: 'customerEntity',     label: 'Customer Entity Type',   type: 'string', required: true, defaultValue: 'a Delaware corporation' },
  { key: 'customerAddress',    label: 'Customer Address',       type: 'string', required: true },
  { key: 'providerName',       label: 'Provider Name',          type: 'string', required: true },
  { key: 'providerEntity',     label: 'Provider Entity Type',   type: 'string', required: true, defaultValue: 'a Delaware corporation' },
  { key: 'providerAddress',    label: 'Provider Address',       type: 'string', required: true },
  { key: 'effectiveDate',      label: 'Effective Date',         type: 'date',   required: true },
]

const PAYMENT_VARS: SeedTemplateVariable[] = [
  { key: 'currency',           label: 'Currency',               type: 'string', required: true, defaultValue: 'USD' },
  { key: 'paymentTermsDays',   label: 'Payment Terms (days)',   type: 'number', required: true, defaultValue: 30 },
]

// docs/41 P0.4 — Delaware is offered as the default, not chosen: without
// `orgDefault` a draft whose request names no law leaves it as a choice to
// make. An org (a demo org) that wants Delaware filled sets orgDefault
// (scripts/set-template-org-default.ts).
const GOVERNING_LAW_VARS: SeedTemplateVariable[] = [
  { key: 'governingLaw',       label: 'Governing Law',          type: 'enum',   required: true, defaultValue: 'Delaware', options: ['Delaware', 'New York', 'California', 'Texas', 'England and Wales'] },
  { key: 'venueLocation',      label: 'Venue Location',         type: 'string', required: true, defaultValue: 'Wilmington, Delaware' },
]

/**
 * docs/41 Part 1 — a template's governing-law sentence becomes a clause slot
 * over the seeded Governing Law family, so the law is decided by rule (the
 * request's words, the org's default) and not left in a variable a model
 * filled. What follows the sentence (venue, jury waiver…) stays literal text
 * in its own section.
 */
export function withGoverningLawSlot(t: SeedTemplate): SeedTemplate {
  const sections: SeedTemplateSection[] = []
  for (const s of t.sections) {
    const m = /^<p>([^<]*\{\{governingLaw\}\}[^.]*\.)\s*(.*)<\/p>$/.exec(s.content)
    if (!/^Governing Law/.test(s.title) || !m) { sections.push(s); continue }
    sections.push({ title: 'Governing Law', sortOrder: s.sortOrder, content: '', slotFamily: 'Governing Law' })
    const rest = m[2].trim()
    if (rest) {
      const title = s.title === 'Governing Law' ? 'Jurisdiction and Venue' : s.title.replace(/^Governing Law and /, '')
      sections.push({ title, sortOrder: s.sortOrder + 1, content: `<p>${rest}</p>` })
    }
  }
  return { ...t, sections }
}

// ─── The 22 templates ─────────────────────────────────────────────────────
/** As first seeded, governing law as literal text (scripts/backfill-clause-families.ts recognises it). */
export const UNIVERSAL_TEMPLATES_LITERAL: SeedTemplate[] = [
  // 1. Mutual NDA
  {
    name: 'Mutual Non-Disclosure Agreement',
    description: 'Two-way NDA for use during pre-contract diligence, partnership exploration, or any reciprocal exchange of confidential information.',
    contractType: 'NDA',
    isPublished: true,
    isDefaultForType: true,
    variables: [...PARTIES_VARS, ...GOVERNING_LAW_VARS,
      { key: 'purpose',         label: 'Purpose of Disclosure', type: 'string', required: true, helpText: 'e.g., "evaluating a potential commercial partnership"' },
      // docs/41 Part 2 — the playbook's preferred term (5 years, trade secrets
      // for as long as they last). 3 years is its fallback, so the template
      // was flagged by its own playbook.
      { key: 'confidentialityYears', label: 'Confidentiality Term (years)', type: 'number', required: true, defaultValue: 5 },
    ],
    sections: [
      { title: 'Preamble',            sortOrder: 10, content: `<p>This Mutual Non-Disclosure Agreement (this "Agreement") is entered into as of {{effectiveDate}} (the "Effective Date") by and between {{customerName}}, {{customerEntity}}, with an address at {{customerAddress}}, and {{providerName}}, {{providerEntity}}, with an address at {{providerAddress}} (each a "Party" and collectively, the "Parties").</p>` },
      { title: 'Purpose',             sortOrder: 20, content: `<p>The Parties wish to share certain confidential information in connection with {{purpose}} (the "Purpose").</p>` },
      { title: 'Definition',          sortOrder: 30, content: `<p>"Confidential Information" means any non-public information disclosed by one Party (the "Discloser") to the other Party (the "Recipient"), in any form, that is identified as confidential or that a reasonable person would understand to be confidential given the nature of the information and the circumstances of disclosure.</p>` },
      { title: 'Obligations',         sortOrder: 40, content: `<p>The Recipient will (a) use the Confidential Information solely for the Purpose; (b) protect the Confidential Information using at least the same degree of care it uses for its own confidential information of similar importance, but no less than a reasonable degree of care; and (c) limit access to those of its representatives who have a need to know and who are bound by obligations of confidentiality no less protective than this Agreement.</p>` },
      { title: 'Exclusions',          sortOrder: 50, content: `<p>This Agreement does not apply to information that the Recipient can demonstrate (a) was already in its lawful possession without confidentiality obligations before disclosure; (b) is or becomes publicly available through no fault of the Recipient; (c) is rightfully received from a third party without confidentiality obligations; or (d) is independently developed without use of the Discloser's Confidential Information.</p>` },
      { title: 'Term',                sortOrder: 60, content: `<p>The obligations of confidentiality continue for {{confidentialityYears}} years from the date of disclosure, or, with respect to trade secrets, for so long as the information remains a trade secret under applicable law.</p>` },
      { title: 'Governing Law',       sortOrder: 70, content: `<p>This Agreement is governed by the laws of {{governingLaw}}, without giving effect to its conflict-of-laws principles. The Parties consent to the exclusive jurisdiction and venue of the state and federal courts located in {{venueLocation}}.</p>` },
      { title: 'Miscellaneous',       sortOrder: 80, content: `<p>This Agreement is the entire agreement between the Parties on this subject, may be amended only in a signed writing, may be executed in counterparts (including by electronic signature), and is binding on permitted successors and assigns. No license to any intellectual property is granted, express or implied, except as expressly set forth in this Agreement.</p>` },
    ],
  },

  // 2. One-Way NDA (Customer Receives)
  {
    name: 'One-Way Non-Disclosure Agreement (Inbound)',
    description: 'One-way NDA for evaluating an inbound proposal where only the other party will disclose confidential information.',
    contractType: 'NDA',
    isPublished: true,
    variables: [...PARTIES_VARS, ...GOVERNING_LAW_VARS,
      { key: 'purpose',         label: 'Purpose of Disclosure', type: 'string', required: true },
    ],
    sections: [
      { title: 'Preamble',            sortOrder: 10, content: `<p>This One-Way Non-Disclosure Agreement is entered into as of {{effectiveDate}} between {{customerName}} ("Recipient") and {{providerName}} ("Discloser").</p>` },
      { title: 'Confidential Information', sortOrder: 20, content: `<p>"Confidential Information" means any non-public information Discloser provides to Recipient in connection with {{purpose}}, whether marked confidential or reasonably understood to be confidential.</p>` },
      { title: 'Obligations',         sortOrder: 30, content: `<p>Recipient will not disclose Confidential Information to any third party and will use it solely to evaluate {{purpose}}. Standard exclusions apply for publicly-known, prior-known, independently-developed, or third-party-sourced information.</p>` },
      { title: 'Term',                sortOrder: 40, content: `<p>Obligations continue for five (5) years from disclosure, or, with respect to trade secrets, for so long as the information remains a trade secret under applicable law.</p>` },
      { title: 'Governing Law',       sortOrder: 50, content: `<p>{{governingLaw}} law governs. Exclusive jurisdiction in {{venueLocation}}.</p>` },
    ],
  },

  // 3. MSA — Buy-Side
  {
    name: 'Master Services Agreement (Buy-Side)',
    description: 'Customer-favorable master services agreement covering professional services delivered under one or more SOWs.',
    contractType: 'MSA',
    isPublished: true,
    isDefaultForType: true,
    variables: [...PARTIES_VARS, ...PAYMENT_VARS, ...GOVERNING_LAW_VARS,
      { key: 'initialTerm',     label: 'Initial Term (years)',  type: 'number', required: true, defaultValue: 1 },
      { key: 'liabilityCapMultiple', label: 'Liability Cap (months of fees)', type: 'number', required: true, defaultValue: 12 },
    ],
    sections: [
      { title: 'Preamble',            sortOrder: 10,  content: `<p>This Master Services Agreement (this "Agreement") is entered into as of {{effectiveDate}} by and between {{customerName}} ("Customer") and {{providerName}} ("Provider").</p>` },
      { title: 'Services and SOWs',   sortOrder: 20,  content: `<p>Provider will perform the professional services ("Services") described in one or more Statements of Work ("SOWs") executed by the Parties under this Agreement. Each SOW will reference this Agreement and specify scope, deliverables, timeline, fees, and any project-specific terms.</p>` },
      { title: 'Change Control',      sortOrder: 30,  content: `<p>Any change to a SOW's scope, deliverables, schedule, or fees requires a written change order signed by an authorized representative of each Party.</p>` },
      { title: 'Acceptance',          sortOrder: 40,  content: `<p>Customer will review each Deliverable within ten (10) business days of delivery and will either accept the Deliverable in writing or provide written notice of material non-conformity. If Customer does not respond within the review period, the Deliverable is deemed accepted.</p>` },
      { title: 'Fees and Payment',    sortOrder: 50,  content: `<p>Customer will pay all undisputed fees within {{paymentTermsDays}} days of receipt of Provider's invoice. All amounts are in {{currency}}. Fees are exclusive of taxes (other than taxes on Provider's income). Customer may dispute amounts in good faith within fifteen (15) days of receipt and the Parties will resolve in good faith within thirty (30) days.</p>` },
      { title: 'Confidentiality',     sortOrder: 60,  content: `<p>Each Party will protect the other's Confidential Information using at least the same degree of care it uses for its own (no less than reasonable care) for five (5) years from disclosure, indefinitely for trade secrets. Standard exclusions apply.</p>` },
      { title: 'Intellectual Property', sortOrder: 70, content: `<p>Customer owns all work product specifically created for Customer under SOWs ("Work Product"), excluding Provider's Background IP. Provider grants Customer a perpetual, royalty-free license to use Background IP as embedded in Work Product. No license to use Customer feedback for Provider's general products without prior written consent.</p>` },
      { title: 'Warranties',          sortOrder: 80,  content: `<p>Provider warrants that the Services will be performed in a professional and workmanlike manner consistent with industry standards. Provider further warrants that the Services and any Provider-provided materials will not infringe a third party's intellectual property and will not contain malicious code. Customer must report breach within thirty (30) days; sole remedy is re-performance.</p>` },
      { title: 'Indemnification',     sortOrder: 90,  content: `<p>Provider will defend Customer against third-party claims that the Services infringe IP rights, with standard remedies (cure, modify, refund). Mutual indemnification for bodily injury and tangible property damage caused by gross negligence or willful misconduct.</p>` },
      { title: 'Limitation of Liability', sortOrder: 100, content: `<p>Except for Excluded Claims (confidentiality, IP indemnity, payment, gross negligence/willful misconduct), each Party's aggregate liability is capped at the fees paid or payable in the {{liabilityCapMultiple}} months preceding the claim. Neither Party is liable for consequential, indirect, or punitive damages.</p>` },
      { title: 'Term and Termination', sortOrder: 110, content: `<p>This Agreement begins on the Effective Date and continues for {{initialTerm}} years, then renews annually unless either Party gives sixty (60) days' notice of non-renewal. Either Party may terminate for the other's uncured material breach after thirty (30) days' written notice. Customer may terminate for convenience on sixty (60) days' notice. Pro-rata refund of prepaid unused fees on termination for cause.</p>` },
      { title: 'Governing Law',       sortOrder: 120, content: `<p>{{governingLaw}} law governs, without regard to its conflict-of-laws principles. Exclusive jurisdiction and venue in {{venueLocation}}. JURY TRIAL WAIVED. Each Party may seek equitable relief for breach of confidentiality or IP.</p>` },
      { title: 'Miscellaneous',       sortOrder: 130, content: `<p>Notices in writing by hand, courier, or certified mail. Entire agreement (no PO terms apply). Severability. Counterparts and e-signatures permitted. Independent contractors. Assignment requires consent (not unreasonably withheld), except to a successor in M&A. Customer has right to terminate on Provider's change of control to a competitor.</p>` },
    ],
  },

  // 4. SOW — Generic
  {
    name: 'Statement of Work (Generic)',
    description: 'Generic SOW template referencing an existing MSA. Use for professional services engagements.',
    contractType: 'SOW',
    isPublished: true,
    isDefaultForType: true,
    variables: [
      { key: 'msaReference',    label: 'Referenced MSA',         type: 'string', required: true, helpText: 'e.g., "MSA dated [date]"' },
      { key: 'customerName',    label: 'Customer Name',          type: 'string', required: true },
      { key: 'providerName',    label: 'Provider Name',          type: 'string', required: true },
      { key: 'sowNumber',       label: 'SOW Number',             type: 'string', required: true },
      { key: 'sowEffectiveDate', label: 'SOW Effective Date',    type: 'date',   required: true },
      { key: 'projectDescription', label: 'Project Description', type: 'string', required: true },
      { key: 'startDate',       label: 'Project Start',          type: 'date',   required: true },
      { key: 'endDate',         label: 'Project End',            type: 'date',   required: false },
      { key: 'totalFees',       label: 'Total Fees',             type: 'number', required: true },
      { key: 'currency',        label: 'Currency',               type: 'string', required: true, defaultValue: 'USD' },
    ],
    sections: [
      { title: 'Reference',           sortOrder: 10, content: `<p>This Statement of Work #{{sowNumber}} ("SOW") is entered into as of {{sowEffectiveDate}} under and incorporates the terms of the {{msaReference}} between {{customerName}} ("Customer") and {{providerName}} ("Provider").</p>` },
      { title: 'Project Description', sortOrder: 20, content: `<p>Provider will perform the following services for Customer: {{projectDescription}}.</p>` },
      { title: 'Deliverables',        sortOrder: 30, content: `<p>The deliverables for this SOW are: [list each Deliverable with description and acceptance criteria].</p>` },
      { title: 'Schedule',            sortOrder: 40, content: `<p>Project starts on {{startDate}} and is targeted for completion by {{endDate}}. Specific milestone dates are set forth in the project schedule attached as Exhibit A.</p>` },
      { title: 'Fees',                sortOrder: 50, content: `<p>Total fees for this SOW are {{totalFees}} {{currency}}, payable per the payment terms in the MSA. [Insert fixed-fee schedule, T&M rates, or milestone-based invoicing as applicable.]</p>` },
      { title: 'Key Personnel',       sortOrder: 60, content: `<p>Provider's key personnel for this SOW are: [list with roles]. Substitutions require Customer's prior approval (not unreasonably withheld).</p>` },
      { title: 'Customer Responsibilities', sortOrder: 70, content: `<p>Customer will: (a) provide timely access to systems, data, and personnel reasonably required; (b) designate a project sponsor; and (c) provide written approval at each Deliverable acceptance milestone.</p>` },
    ],
  },

  // 5. SaaS Subscription Agreement
  {
    name: 'SaaS Subscription Agreement',
    description: 'Cloud-hosted subscription service agreement with uptime SLA and data protection terms.',
    contractType: 'SaaS',
    isPublished: true,
    variables: [...PARTIES_VARS, ...PAYMENT_VARS, ...GOVERNING_LAW_VARS,
      { key: 'serviceName',     label: 'Service Name',           type: 'string', required: true },
      { key: 'subscriptionTerm', label: 'Subscription Term (months)', type: 'number', required: true, defaultValue: 12 },
      { key: 'authorizedUsers', label: 'Authorized Users (count)', type: 'number', required: true },
      { key: 'uptimePercent',   label: 'Uptime SLA (%)',         type: 'string', required: true, defaultValue: '99.9%' },
    ],
    sections: [
      { title: 'Preamble',            sortOrder: 10,  content: `<p>This SaaS Subscription Agreement is entered into as of {{effectiveDate}} between {{customerName}} ("Customer") and {{providerName}} ("Provider"), under which Provider grants Customer access to {{serviceName}} (the "Services").</p>` },
      { title: 'Subscription and License', sortOrder: 20, content: `<p>Subject to payment of fees and compliance with this Agreement, Provider grants Customer a worldwide, non-exclusive, non-transferable license during the Term to access and use the Services for Customer's internal business purposes, for up to {{authorizedUsers}} Authorized Users.</p>` },
      { title: 'Customer Data',       sortOrder: 30,  content: `<p>As between the Parties, Customer owns all Customer Data. Provider has a limited license to access and use Customer Data solely to provide and improve the Services. Provider will return or delete Customer Data within thirty (30) days of termination.</p>` },
      { title: 'Service Levels',      sortOrder: 40,  content: `<p>Provider will use commercially reasonable efforts to make the Services available at least {{uptimePercent}} of the time, measured monthly, excluding Scheduled Maintenance and Force Majeure. Service credits are available per the schedule in Exhibit B. Chronic failure (3 consecutive months below SLA, or 4 of any rolling 12) entitles Customer to terminate for cause and receive a pro-rata refund.</p>` },
      { title: 'Data Protection',     sortOrder: 50,  content: `<p>To the extent Provider processes Personal Data on Customer's behalf, the Parties will execute the Data Processing Addendum (Exhibit C). Provider will notify Customer of any Security Incident within 72 hours of becoming aware.</p>` },
      { title: 'Security',            sortOrder: 60,  content: `<p>Provider will maintain SOC 2 Type II certification and implement industry-standard administrative, technical, and physical safeguards. Encryption in transit (TLS 1.2+) and at rest (AES-256). MFA enforced for administrative access. Annual penetration testing.</p>` },
      { title: 'Fees and Renewals',   sortOrder: 70,  content: `<p>Subscription fees per the Order Form, due on {{paymentTermsDays}}-day terms in {{currency}}. Subscription renews automatically for successive {{subscriptionTerm}}-month periods unless either party gives sixty (60) days' notice of non-renewal. Provider may increase fees at renewal by no more than 5% or CPI, whichever is lower.</p>` },
      { title: 'Term and Termination', sortOrder: 80, content: `<p>Initial Subscription Term begins on the Effective Date and continues for {{subscriptionTerm}} months. Either Party may terminate for the other's uncured material breach after thirty (30) days' written notice. On termination for cause by Customer, Customer receives a pro-rata refund of prepaid unused fees.</p>` },
      { title: 'IP Ownership',        sortOrder: 90,  content: `<p>Provider retains all right, title, and interest in the Services. Customer retains all right, title, and interest in Customer Data. Customer's Feedback grants Provider a perpetual royalty-free license to improve the Services.</p>` },
      { title: 'Warranties and Disclaimer', sortOrder: 100, content: `<p>Provider warrants that the Services will materially conform to its published Documentation. Customer's sole remedy for breach is service credits or, if uncured for thirty (30) days, termination and refund. EXCEPT AS EXPRESSLY STATED, THE SERVICES ARE PROVIDED "AS IS" AND PROVIDER DISCLAIMS ALL OTHER WARRANTIES.</p>` },
      { title: 'Indemnification',     sortOrder: 110, content: `<p>Provider will defend Customer against third-party IP infringement claims with standard remedies. Customer will defend Provider against claims arising from Customer Data or Customer's misuse of the Services.</p>` },
      { title: 'Limitation of Liability', sortOrder: 120, content: `<p>Each Party's aggregate liability is capped at twelve (12) months' fees. Super-cap of 3x for breach of data protection obligations. Standard carve-outs (confidentiality, IP indemnity, payment, gross negligence/willful misconduct, indemnification). No consequential damages.</p>` },
      { title: 'Governing Law and Miscellaneous', sortOrder: 130, content: `<p>{{governingLaw}} law governs. Exclusive jurisdiction in {{venueLocation}}. Jury trial waived. Entire agreement. Severability. Counterparts and e-signatures. Independent contractors. Assignment requires consent except in M&A.</p>` },
    ],
  },

  // 6. Order Form
  {
    name: 'Order Form (Subscription)',
    description: 'Order form for SaaS subscription. Use under an executed master subscription agreement.',
    contractType: 'Order Form',
    isPublished: true,
    variables: [
      { key: 'agreementReference', label: 'Master Agreement Reference', type: 'string', required: true },
      { key: 'customerName',    label: 'Customer Name',          type: 'string', required: true },
      { key: 'providerName',    label: 'Provider Name',          type: 'string', required: true },
      { key: 'orderEffectiveDate', label: 'Order Effective Date', type: 'date',  required: true },
      { key: 'subscriptionStart', label: 'Subscription Start',   type: 'date',   required: true },
      { key: 'subscriptionEnd', label: 'Subscription End',       type: 'date',   required: true },
      { key: 'serviceTier',     label: 'Service Tier',           type: 'string', required: true },
      { key: 'seatCount',       label: 'Seat Count',             type: 'number', required: true },
      { key: 'annualFee',       label: 'Annual Fee',             type: 'number', required: true },
      { key: 'currency',        label: 'Currency',               type: 'string', required: true, defaultValue: 'USD' },
      { key: 'paymentTermsDays', label: 'Payment Terms (days)',  type: 'number', required: true, defaultValue: 30 },
    ],
    sections: [
      { title: 'Reference and Effective Date', sortOrder: 10, content: `<p>This Order Form, effective {{orderEffectiveDate}}, is entered into under and subject to the terms of the {{agreementReference}} between {{customerName}} ("Customer") and {{providerName}} ("Provider"). Capitalized terms have the meanings given in the master agreement.</p>` },
      { title: 'Order Details',       sortOrder: 20, content: `<p><strong>Service Tier:</strong> {{serviceTier}}<br><strong>Authorized Seats:</strong> {{seatCount}}<br><strong>Subscription Term:</strong> {{subscriptionStart}} through {{subscriptionEnd}}</p>` },
      { title: 'Fees and Payment',    sortOrder: 30, content: `<p>Annual subscription fee: {{annualFee}} {{currency}}, payable in advance on receipt of invoice on net-{{paymentTermsDays}} terms. Pricing is firm for the initial subscription term.</p>` },
      { title: 'Renewal',             sortOrder: 40, content: `<p>This Order Form renews automatically for successive 12-month periods unless either Party gives 60 days' written notice of non-renewal before the end of the then-current term. Renewal pricing may increase by no more than 5% or CPI, whichever is lower.</p>` },
      { title: 'Signature',           sortOrder: 50, content: `<p>The Parties execute this Order Form by signature below. This Order Form may be signed in counterparts and by electronic signature.</p>` },
    ],
  },

  // 7. DPA
  {
    name: 'Data Processing Addendum (GDPR/CCPA)',
    description: 'Cross-jurisdiction DPA covering GDPR controller-processor obligations and CCPA service provider obligations.',
    contractType: 'DPA',
    isPublished: true,
    variables: [...PARTIES_VARS,
      { key: 'underlyingAgreement', label: 'Underlying Agreement', type: 'string', required: true, helpText: 'Name of the master agreement this DPA supplements' },
    ],
    sections: [
      { title: 'Scope',               sortOrder: 10,  content: `<p>This Data Processing Addendum ("DPA") supplements the {{underlyingAgreement}} between {{customerName}} ("Controller" / "Business") and {{providerName}} ("Processor" / "Service Provider") and applies to all processing of Personal Data by Processor on behalf of Controller.</p>` },
      { title: 'Definitions',         sortOrder: 20,  content: `<p>"Personal Data", "Processing", "Controller", "Processor", "Business", "Service Provider", and "Data Subject" have the meanings given in applicable Data Protection Laws (including GDPR and CCPA/CPRA).</p>` },
      { title: 'Roles and Instructions', sortOrder: 30, content: `<p>Controller is the Controller (Business) and Processor is the Processor (Service Provider). Processor will Process Personal Data only on Controller's documented instructions, including with regard to international transfers, unless required to do otherwise by applicable law.</p>` },
      { title: 'Security Measures',   sortOrder: 40,  content: `<p>Processor will implement appropriate technical and organizational measures, including encryption in transit and at rest, access controls with MFA for admin, regular security testing, and incident response. Processor maintains SOC 2 Type II.</p>` },
      { title: 'Sub-Processors',      sortOrder: 50,  content: `<p>Controller authorizes Processor to engage Sub-Processors listed at the URL provided in the master agreement. Processor will notify Controller of new Sub-Processors at least 30 days in advance and Controller may object on reasonable data-protection grounds. Processor remains liable for its Sub-Processors.</p>` },
      { title: 'Cross-Border Transfers', sortOrder: 60, content: `<p>For transfers of EU/EEA Personal Data to countries without an adequacy decision, the Standard Contractual Clauses (Module 2, Controller-to-Processor) are incorporated and govern such transfers. Processor will implement supplementary measures as required.</p>` },
      { title: 'Data Subject Rights', sortOrder: 70,  content: `<p>Processor will, taking into account the nature of Processing, reasonably assist Controller in responding to Data Subject requests at no additional charge during the Term.</p>` },
      { title: 'Security Incidents',  sortOrder: 80,  content: `<p>Processor will notify Controller of any Security Incident affecting Personal Data without undue delay and in any event within 72 hours of becoming aware, with the information reasonably required for Controller's own notifications.</p>` },
      { title: 'Audits',              sortOrder: 90,  content: `<p>Processor will make available to Controller all information reasonably necessary to demonstrate compliance with this DPA, and allow audits (including inspections) by Controller or its designated auditor no more than once per year and following a Security Incident, on 30 days' notice, during normal business hours. The Parties may agree to substitute Processor's most recent SOC 2 or ISO 27001 report.</p>` },
      { title: 'Return or Deletion',  sortOrder: 100, content: `<p>Upon termination, Processor will, at Controller's choice, return all Personal Data or delete it (including copies) within 30 days, unless retention is required by applicable law, and confirm in writing upon request.</p>` },
      { title: 'Liability',           sortOrder: 110, content: `<p>The liability provisions of the underlying agreement apply to claims under this DPA, except that the parties' aggregate liability for breach of this DPA is the super-cap (3x annual fees) where the underlying agreement provides one.</p>` },
    ],
  },

  // 8. Employment Offer Letter
  {
    name: 'Employment Offer Letter (At-Will)',
    description: 'Standard US at-will employment offer letter with non-compete-free terms (US state-dependent).',
    contractType: 'Employment',
    isPublished: true,
    variables: [
      { key: 'companyName',     label: 'Company Name',           type: 'string', required: true },
      { key: 'candidateName',   label: 'Candidate Name',         type: 'string', required: true },
      { key: 'jobTitle',        label: 'Job Title',              type: 'string', required: true },
      { key: 'managerName',     label: 'Reporting Manager',      type: 'string', required: true },
      { key: 'startDate',       label: 'Start Date',             type: 'date',   required: true },
      { key: 'baseSalary',      label: 'Annual Base Salary',     type: 'number', required: true },
      { key: 'currency',        label: 'Currency',               type: 'string', required: true, defaultValue: 'USD' },
      { key: 'workLocation',    label: 'Work Location',          type: 'string', required: true },
      { key: 'equityShares',    label: 'Equity Grant (RSU/Options)', type: 'string', required: false },
    ],
    sections: [
      { title: 'Salutation',          sortOrder: 10, content: `<p>Dear {{candidateName}},</p><p>On behalf of {{companyName}} (the "Company"), I am pleased to offer you the position of {{jobTitle}}, reporting to {{managerName}}, starting on {{startDate}}.</p>` },
      { title: 'Compensation',        sortOrder: 20, content: `<p>Your annual base salary will be {{baseSalary}} {{currency}}, payable in accordance with the Company's standard payroll schedule, less applicable withholdings.</p>` },
      { title: 'Equity',              sortOrder: 30, content: `<p>Subject to Board approval, you will be granted {{equityShares}}, on the Company's standard vesting schedule (1-year cliff, 4-year total). Grants are subject to the terms of the Company's equity incentive plan.</p>` },
      { title: 'Benefits',            sortOrder: 40, content: `<p>You will be eligible to participate in the Company's standard benefits programs (health, dental, vision, 401(k), PTO) on the terms and effective dates set forth in the applicable plan documents.</p>` },
      { title: 'Work Location',       sortOrder: 50, content: `<p>Your work location will be {{workLocation}}. The Company reserves the right to modify work location and arrangements consistent with applicable law and Company policy.</p>` },
      { title: 'At-Will Employment',  sortOrder: 60, content: `<p>Your employment with the Company is at-will, which means that you or the Company may terminate the employment relationship at any time, with or without cause, and with or without notice. This offer letter is not a contract of employment for any particular duration.</p>` },
      { title: 'Confidentiality and IP', sortOrder: 70, content: `<p>As a condition of employment, you will be required to sign the Company's Confidential Information and Invention Assignment Agreement.</p>` },
      { title: 'Contingencies',       sortOrder: 80, content: `<p>This offer is contingent on (a) satisfactory completion of standard background and reference checks; (b) verification of your right to work in the United States; and (c) your signing the Company's standard onboarding documents.</p>` },
      { title: 'Acceptance',          sortOrder: 90, content: `<p>To accept this offer, please sign and return this letter by [date]. We look forward to having you join the team.</p>` },
    ],
  },

  // 9. Independent Contractor Agreement
  {
    name: 'Independent Contractor Agreement',
    description: 'Agreement engaging an individual contractor for services; includes IP assignment and contractor-status protections.',
    contractType: 'Contractor',
    isPublished: true,
    variables: [
      { key: 'companyName',     label: 'Company Name',           type: 'string', required: true },
      { key: 'contractorName',  label: 'Contractor Name',        type: 'string', required: true },
      { key: 'effectiveDate',   label: 'Effective Date',         type: 'date',   required: true },
      { key: 'servicesDescription', label: 'Services Description', type: 'string', required: true },
      { key: 'rate',            label: 'Hourly or Project Rate', type: 'string', required: true },
      { key: 'currency',        label: 'Currency',               type: 'string', required: true, defaultValue: 'USD' },
    ],
    sections: [
      { title: 'Engagement',          sortOrder: 10, content: `<p>{{companyName}} (the "Company") engages {{contractorName}} (the "Contractor") to perform the following services beginning {{effectiveDate}}: {{servicesDescription}}.</p>` },
      { title: 'Compensation',        sortOrder: 20, content: `<p>Contractor will be compensated at {{rate}} {{currency}}, invoiced monthly, payable net 30. Contractor is responsible for all taxes on the compensation.</p>` },
      { title: 'Independent Contractor', sortOrder: 30, content: `<p>Contractor is an independent contractor, not an employee, agent, partner, or joint venturer of the Company. Contractor controls the manner and means of performance and will not be eligible for any Company employee benefits.</p>` },
      { title: 'IP Assignment',       sortOrder: 40, content: `<p>All deliverables and work product Contractor creates for the Company are works made for hire under the U.S. Copyright Act and the Company's sole property. To the extent any work product is not a work made for hire, Contractor irrevocably assigns all right, title, and interest to the Company.</p>` },
      { title: 'Confidentiality',     sortOrder: 50, content: `<p>Contractor will treat all non-public information about the Company as confidential, both during and after the engagement, for a period of five (5) years (indefinitely for trade secrets).</p>` },
      { title: 'Term and Termination', sortOrder: 60, content: `<p>Either party may terminate this Agreement at any time on 14 days' written notice, or immediately for material breach. On termination, Contractor will deliver to the Company all work product and Company materials in Contractor's possession.</p>` },
      { title: 'Indemnity',           sortOrder: 70, content: `<p>Contractor will indemnify the Company against third-party claims arising from Contractor's negligence, breach of this Agreement, or violation of applicable law in performing the services.</p>` },
    ],
  },

  // 10. Reseller Agreement
  {
    name: 'Reseller Agreement (Non-Exclusive)',
    description: 'Non-exclusive reseller agreement permitting a partner to resell the Company\'s product, with revenue-share and approved-territory terms.',
    contractType: 'Reseller',
    isPublished: true,
    variables: [...PARTIES_VARS, ...GOVERNING_LAW_VARS,
      { key: 'companyProduct',  label: 'Product/Service Name',   type: 'string', required: true },
      { key: 'resellerName',    label: 'Reseller Name',          type: 'string', required: true },
      { key: 'territory',       label: 'Approved Territory',     type: 'string', required: true, defaultValue: 'United States' },
      { key: 'discount',        label: 'Reseller Discount (%)',  type: 'number', required: true, defaultValue: 20 },
      { key: 'initialTerm',     label: 'Initial Term (years)',   type: 'number', required: true, defaultValue: 1 },
    ],
    sections: [
      { title: 'Appointment',         sortOrder: 10,  content: `<p>{{providerName}} (the "Company") appoints {{resellerName}} ("Reseller") as a non-exclusive reseller of {{companyProduct}} (the "Product") in {{territory}} (the "Territory"). Reseller may market and resell the Product to end customers in the Territory subject to this Agreement.</p>` },
      { title: 'Reseller Obligations', sortOrder: 20, content: `<p>Reseller will (a) market the Product accurately and consistently with Company materials; (b) ensure end-customer agreements meet or exceed the Company's then-current minimum end-user terms; (c) provide first-line support; and (d) not modify, decompile, or reverse-engineer the Product.</p>` },
      { title: 'Pricing and Payment', sortOrder: 30,  content: `<p>Reseller pays the Company the Company's list price for the Product less {{discount}}% per Order Form. Net 30 from invoice. Reseller is free to set its end-customer pricing.</p>` },
      { title: 'Trademark License',   sortOrder: 40,  content: `<p>The Company grants Reseller a limited, non-exclusive, non-transferable license to use the Company's trademarks solely for marketing and reselling the Product, subject to the Company's brand guidelines and a right of approval over specific marketing collateral.</p>` },
      { title: 'IP and Ownership',    sortOrder: 50,  content: `<p>The Company retains all right, title, and interest in the Product, including all updates, modifications, and derivatives. Nothing in this Agreement grants Reseller any ownership rights.</p>` },
      { title: 'End-User Agreements', sortOrder: 60,  content: `<p>Reseller will require each end customer to sign the Company's standard end-user license or service terms (or equivalent) before receiving access to the Product. Reseller will not modify the end-user terms without the Company's written consent.</p>` },
      { title: 'Term and Termination', sortOrder: 70, content: `<p>This Agreement begins on the Effective Date and continues for {{initialTerm}} years, renewing for 1-year terms unless either party gives 60 days' non-renewal notice. Either party may terminate for material breach after 30 days' cure notice. Effects: Reseller will cease marketing the Product and may continue to support existing end customers for the remainder of their then-current terms.</p>` },
      { title: 'Indemnification and Liability', sortOrder: 80, content: `<p>The Company will indemnify Reseller against third-party IP infringement claims regarding the Product. Reseller will indemnify the Company against third-party claims arising from Reseller's marketing statements, breach, or unauthorized modifications. Each party's liability is capped at the fees paid in the prior 12 months, with standard carve-outs.</p>` },
      { title: 'Governing Law',       sortOrder: 90,  content: `<p>{{governingLaw}} law governs. Exclusive jurisdiction in {{venueLocation}}.</p>` },
    ],
  },

  // 11-20: smaller templates
  // 11. Mutual Termination Letter
  {
    name: 'Mutual Termination Letter',
    description: 'Letter agreement memorializing the mutual termination of an existing contract.',
    contractType: 'Termination',
    isPublished: true,
    isDefaultForType: true,
    variables: [
      { key: 'partyAName',      label: 'Party A Name',           type: 'string', required: true },
      { key: 'partyBName',      label: 'Party B Name',           type: 'string', required: true },
      { key: 'agreementName',   label: 'Agreement Being Terminated', type: 'string', required: true },
      { key: 'agreementDate',   label: 'Original Agreement Date', type: 'date',   required: true },
      { key: 'effectiveDate',   label: 'Termination Effective Date', type: 'date', required: true },
    ],
    sections: [
      { title: 'Termination',         sortOrder: 10, content: `<p>{{partyAName}} and {{partyBName}} hereby mutually terminate the {{agreementName}} dated {{agreementDate}} (the "Agreement"), effective {{effectiveDate}} (the "Termination Date").</p>` },
      { title: 'Wind-Down',           sortOrder: 20, content: `<p>Each party will perform any remaining obligations through the Termination Date. No new orders, SOWs, or work will be initiated after the Termination Date.</p>` },
      { title: 'Final Settlement',    sortOrder: 30, content: `<p>The parties confirm that, except for amounts owed for services performed through the Termination Date and obligations that by their nature survive termination (including confidentiality, IP, indemnification, and limitation of liability), neither party has any further obligation to the other under the Agreement.</p>` },
      { title: 'Releases',            sortOrder: 40, content: `<p>Each party releases the other from all claims arising under or related to the Agreement through the Termination Date, except for claims of fraud, willful misconduct, or breach of obligations that survive termination.</p>` },
    ],
  },

  // 12. Vendor MSA (Sell-Side)
  {
    name: 'Master Services Agreement (Sell-Side)',
    description: 'Provider-favorable MSA — use when you (the Provider) are the seller. Standard caps, no termination for convenience by Customer during initial term.',
    contractType: 'MSA',
    isPublished: true,
    variables: [...PARTIES_VARS, ...PAYMENT_VARS, ...GOVERNING_LAW_VARS,
      { key: 'initialTerm',     label: 'Initial Term (years)',   type: 'number', required: true, defaultValue: 1 },
    ],
    sections: [
      { title: 'Preamble',            sortOrder: 10, content: `<p>This Master Services Agreement is entered into as of {{effectiveDate}} between {{customerName}} ("Customer") and {{providerName}} ("Provider").</p>` },
      { title: 'Services',            sortOrder: 20, content: `<p>Provider will perform Services described in SOWs executed by the Parties.</p>` },
      { title: 'Fees and Payment',    sortOrder: 30, content: `<p>Customer will pay all fees within {{paymentTermsDays}} days of invoice, in {{currency}}. Late fees of 1% per month or the max permitted by law on overdue amounts. Annual price escalation up to 5%.</p>` },
      { title: 'Term and Termination', sortOrder: 40, content: `<p>Initial term of {{initialTerm}} years, renewing annually unless either Party gives 60 days' non-renewal notice. Termination for material breach with 30-day cure period. NO TERMINATION FOR CONVENIENCE during the Initial Term.</p>` },
      { title: 'IP',                  sortOrder: 50, content: `<p>Provider retains ownership of all pre-existing IP and Provider tools/methodologies. Customer-specific work product assigned to Customer on payment in full. Provider may use anonymized data and learnings for product improvement.</p>` },
      { title: 'Warranties',          sortOrder: 60, content: `<p>Provider warrants Services will be performed in a workmanlike manner. SOLE REMEDY for breach is re-performance. ALL OTHER WARRANTIES DISCLAIMED.</p>` },
      { title: 'Limitation of Liability', sortOrder: 70, content: `<p>Provider's liability is capped at 12 months' fees, with limited carve-outs only for confidentiality, IP indemnity, and payment. NO CONSEQUENTIAL DAMAGES.</p>` },
      { title: 'Governing Law',       sortOrder: 80, content: `<p>{{governingLaw}} law governs. Exclusive jurisdiction in {{venueLocation}}. Jury trial waived.</p>` },
    ],
  },

  // 13. Software License Agreement (On-Premises)
  {
    name: 'Software License Agreement (Perpetual, On-Premises)',
    description: 'Perpetual license for on-premises software with annual maintenance/support fees.',
    contractType: 'License',
    isPublished: true,
    variables: [...PARTIES_VARS, ...PAYMENT_VARS, ...GOVERNING_LAW_VARS,
      { key: 'softwareName',    label: 'Software Name',          type: 'string', required: true },
      { key: 'licenseFee',      label: 'License Fee',            type: 'number', required: true },
      { key: 'annualSupport',   label: 'Annual Support Fee',     type: 'number', required: true },
    ],
    sections: [
      { title: 'License Grant',       sortOrder: 10, content: `<p>{{providerName}} ("Licensor") grants {{customerName}} ("Licensee") a perpetual, worldwide, non-exclusive, non-transferable license to use {{softwareName}} (the "Software") for Licensee's internal business purposes.</p>` },
      { title: 'Fees',                sortOrder: 20, content: `<p>License fee of {{licenseFee}} due on signing. Annual support and maintenance fee of {{annualSupport}} due in advance each year, payable on net-{{paymentTermsDays}} terms.</p>` },
      { title: 'Restrictions',        sortOrder: 30, content: `<p>Licensee will not (a) sublicense, resell, or transfer the Software; (b) reverse-engineer, decompile, or disassemble the Software; (c) modify or create derivative works; or (d) use the Software to provide services to third parties (other than Affiliates).</p>` },
      { title: 'Support and Updates', sortOrder: 40, content: `<p>While Licensee pays the annual support fee, Licensor will provide bug fixes, security updates, and new feature releases. Severity-based response targets per Exhibit A.</p>` },
      { title: 'IP and Audit',        sortOrder: 50, content: `<p>Licensor retains all IP in the Software. Licensor may audit Licensee's use no more than once per year on 30 days' notice; if material under-licensing is found, Licensee will pay the shortfall plus reasonable audit costs.</p>` },
      { title: 'Warranties',          sortOrder: 60, content: `<p>Licensor warrants the Software will materially conform to its Documentation for 90 days from delivery. Sole remedy is correction or refund. All other warranties disclaimed.</p>` },
      { title: 'Liability and Indemnity', sortOrder: 70, content: `<p>Licensor's IP infringement indemnity covers the Software when used as licensed. Liability cap: license fee plus 12 months' support fees. No consequential damages.</p>` },
      { title: 'Governing Law',       sortOrder: 80, content: `<p>{{governingLaw}} law. Jurisdiction in {{venueLocation}}.</p>` },
    ],
  },

  // 14. Beta / Evaluation Agreement
  {
    name: 'Beta Evaluation Agreement',
    description: 'Short-term agreement allowing a customer to evaluate a beta or pre-release product at no charge.',
    contractType: 'Beta',
    isPublished: true,
    variables: [...PARTIES_VARS,
      { key: 'betaProduct',     label: 'Beta Product',           type: 'string', required: true },
      { key: 'evaluationPeriodDays', label: 'Evaluation Period (days)', type: 'number', required: true, defaultValue: 90 },
    ],
    sections: [
      { title: 'Beta License',        sortOrder: 10, content: `<p>{{providerName}} ("Provider") grants {{customerName}} ("Customer") a limited, non-exclusive, non-transferable, revocable license to access and use {{betaProduct}} (the "Beta Product") for the sole purpose of internal evaluation during the Evaluation Period.</p>` },
      { title: 'Evaluation Period',   sortOrder: 20, content: `<p>The evaluation period runs for {{evaluationPeriodDays}} days from the Effective Date. Either Party may terminate this Agreement and the evaluation at any time on written notice.</p>` },
      { title: '"AS IS"',             sortOrder: 30, content: `<p>THE BETA PRODUCT IS PROVIDED "AS IS" WITHOUT ANY WARRANTY OF ANY KIND. CUSTOMER ASSUMES ALL RISK OF EVALUATION. The Beta Product may contain defects, may not function as documented, and is not intended for use in production environments.</p>` },
      { title: 'Feedback',            sortOrder: 40, content: `<p>Customer will provide reasonable feedback about its experience. Customer grants Provider a perpetual, royalty-free, worldwide license to use the Feedback for any purpose without compensation or attribution.</p>` },
      { title: 'Confidentiality',     sortOrder: 50, content: `<p>The Beta Product and any related materials are Provider's Confidential Information. Customer will not disclose them, run benchmarks, or publish reviews without Provider's prior written consent.</p>` },
      { title: 'No Liability',        sortOrder: 60, content: `<p>PROVIDER'S TOTAL LIABILITY UNDER THIS AGREEMENT IS LIMITED TO $100. NO CONSEQUENTIAL OR INDIRECT DAMAGES.</p>` },
    ],
  },

  // 15. Co-Marketing Agreement
  {
    name: 'Co-Marketing Agreement',
    description: 'Agreement between two companies to jointly promote each other\'s products through co-branded marketing activities.',
    contractType: 'Marketing',
    isPublished: true,
    variables: [...PARTIES_VARS, ...GOVERNING_LAW_VARS,
      { key: 'marketingActivities', label: 'Marketing Activities', type: 'string', required: true, helpText: 'e.g., joint webinar, co-authored whitepaper' },
      { key: 'termMonths',      label: 'Term (months)',          type: 'number', required: true, defaultValue: 12 },
    ],
    sections: [
      { title: 'Purpose',             sortOrder: 10, content: `<p>{{customerName}} and {{providerName}} will collaborate on the following co-marketing activities: {{marketingActivities}}.</p>` },
      { title: 'Trademark License',   sortOrder: 20, content: `<p>Each Party grants the other a limited, non-exclusive, royalty-free license to use its name and logo solely for the co-marketing activities. Each Party retains approval rights over specific marketing materials.</p>` },
      { title: 'Costs',               sortOrder: 30, content: `<p>Each Party bears its own costs unless otherwise agreed in writing. No payment or fee is owed by either Party except as expressly agreed.</p>` },
      { title: 'IP Ownership',        sortOrder: 40, content: `<p>Each Party retains ownership of its own marks, content, and pre-existing IP. Jointly-created marketing materials are jointly owned; each Party may use them for its own marketing without accounting.</p>` },
      { title: 'Term and Termination', sortOrder: 50, content: `<p>This Agreement runs for {{termMonths}} months from the Effective Date and may be terminated by either Party on 30 days' notice. Trademark licenses terminate automatically.</p>` },
      { title: 'Disclaimer',          sortOrder: 60, content: `<p>Neither Party is liable to the other for any indirect or consequential damages. Each Party's liability is capped at $10,000.</p>` },
      { title: 'Governing Law',       sortOrder: 70, content: `<p>{{governingLaw}} law. Jurisdiction in {{venueLocation}}.</p>` },
    ],
  },

  // 16. Mutual IP Submission / Idea Submission
  {
    name: 'Mutual Idea Submission Agreement',
    description: 'Pre-development NDA + IP framework for parties exchanging ideas that may lead to a joint project.',
    contractType: 'NDA',
    isPublished: false,  // less common — start unpublished
    variables: [...PARTIES_VARS, ...GOVERNING_LAW_VARS,
      { key: 'projectArea',     label: 'Project Area',           type: 'string', required: true },
    ],
    sections: [
      { title: 'Background',          sortOrder: 10, content: `<p>{{customerName}} and {{providerName}} wish to share ideas concerning {{projectArea}} (the "Project Area") to evaluate a possible joint project.</p>` },
      { title: 'Confidentiality',     sortOrder: 20, content: `<p>Each Party will treat the other's submissions as Confidential Information under standard mutual NDA terms (3-year term; indefinite for trade secrets).</p>` },
      { title: 'IP Ownership of Submissions', sortOrder: 30, content: `<p>Each Party retains full ownership of the ideas, concepts, and IP it submits to the other. Neither Party acquires any license, express or implied, to the other's submissions by reason of the disclosure under this Agreement.</p>` },
      { title: 'No Obligation to Proceed', sortOrder: 40, content: `<p>Neither Party is obligated to pursue any project or to grant a license to the other's submissions. Any future collaboration requires a separate signed agreement.</p>` },
      { title: 'Governing Law',       sortOrder: 50, content: `<p>{{governingLaw}} law.</p>` },
    ],
  },

  // 17. SOW — Fixed Fee
  {
    name: 'Statement of Work — Fixed Fee',
    description: 'SOW for a defined-scope, fixed-fee engagement with milestone-based payments.',
    contractType: 'SOW',
    isPublished: true,
    variables: [
      { key: 'msaReference',    label: 'Referenced MSA',         type: 'string', required: true },
      { key: 'customerName',    label: 'Customer Name',          type: 'string', required: true },
      { key: 'providerName',    label: 'Provider Name',          type: 'string', required: true },
      { key: 'sowNumber',       label: 'SOW Number',             type: 'string', required: true },
      { key: 'projectDescription', label: 'Project Description', type: 'string', required: true },
      { key: 'fixedFee',        label: 'Total Fixed Fee',        type: 'number', required: true },
      { key: 'currency',        label: 'Currency',               type: 'string', required: true, defaultValue: 'USD' },
    ],
    sections: [
      { title: 'Reference',           sortOrder: 10, content: `<p>This Fixed-Fee SOW #{{sowNumber}} is entered into under the {{msaReference}} between {{customerName}} and {{providerName}}.</p>` },
      { title: 'Scope',               sortOrder: 20, content: `<p>{{projectDescription}}</p>` },
      { title: 'Fixed Fee',           sortOrder: 30, content: `<p>The total fixed fee for this SOW is {{fixedFee}} {{currency}}, regardless of actual hours expended.</p>` },
      { title: 'Payment Milestones',  sortOrder: 40, content: `<p>The fixed fee is invoiced as follows: (a) 25% on SOW signing; (b) 50% on acceptance of the interim Deliverable; (c) 25% on acceptance of the final Deliverable. Payment per the MSA payment terms.</p>` },
      { title: 'Change Orders',       sortOrder: 50, content: `<p>Any change to the scope or schedule requires a written change order. Out-of-scope work will be billed on a time-and-materials basis at Provider's then-current rates.</p>` },
    ],
  },

  // 18. SOW — Time & Materials
  {
    name: 'Statement of Work — Time and Materials',
    description: 'SOW for an open-ended T&M engagement with hourly rates and a not-to-exceed cap.',
    contractType: 'SOW',
    isPublished: true,
    variables: [
      { key: 'msaReference',    label: 'Referenced MSA',         type: 'string', required: true },
      { key: 'customerName',    label: 'Customer Name',          type: 'string', required: true },
      { key: 'providerName',    label: 'Provider Name',          type: 'string', required: true },
      { key: 'sowNumber',       label: 'SOW Number',             type: 'string', required: true },
      { key: 'projectDescription', label: 'Project Description', type: 'string', required: true },
      { key: 'hourlyRate',      label: 'Average Hourly Rate',    type: 'string', required: true },
      { key: 'notToExceedCap',  label: 'Not-to-Exceed Cap',      type: 'number', required: true },
      { key: 'currency',        label: 'Currency',               type: 'string', required: true, defaultValue: 'USD' },
    ],
    sections: [
      { title: 'Reference',           sortOrder: 10, content: `<p>This T&M SOW #{{sowNumber}} is entered into under the {{msaReference}} between {{customerName}} and {{providerName}}.</p>` },
      { title: 'Scope',               sortOrder: 20, content: `<p>{{projectDescription}}. Provider will perform the work on a time-and-materials basis.</p>` },
      { title: 'Rates',               sortOrder: 30, content: `<p>Provider's rates are set out in Exhibit A. The blended average rate is {{hourlyRate}} {{currency}} per hour.</p>` },
      { title: 'Not-to-Exceed Cap',   sortOrder: 40, content: `<p>Total fees and expenses under this SOW will not exceed {{notToExceedCap}} {{currency}} without Customer's prior written approval. Provider will notify Customer when 80% of the cap has been reached.</p>` },
      { title: 'Invoicing',           sortOrder: 50, content: `<p>Provider will invoice monthly for hours worked and expenses incurred, with detailed time entries. Payment per MSA terms.</p>` },
    ],
  },

  // 19. Termination Notice (Unilateral)
  {
    name: 'Termination Notice (Unilateral)',
    description: 'Formal written notice to terminate an existing agreement (for cause or for convenience as applicable).',
    contractType: 'Termination',
    isPublished: true,
    variables: [
      { key: 'senderName',      label: 'Sender Name',            type: 'string', required: true },
      { key: 'recipientName',   label: 'Recipient Name',         type: 'string', required: true },
      { key: 'agreementName',   label: 'Agreement Name',         type: 'string', required: true },
      { key: 'agreementDate',   label: 'Agreement Date',         type: 'date',   required: true },
      { key: 'terminationBasis', label: 'Basis for Termination', type: 'enum',   required: true, options: ['material breach (cure period applies)', 'convenience (per agreement notice provisions)', 'insolvency'], defaultValue: 'convenience (per agreement notice provisions)' },
      { key: 'effectiveDate',   label: 'Termination Effective Date', type: 'date', required: true },
    ],
    sections: [
      { title: 'Notice of Termination', sortOrder: 10, content: `<p>Dear {{recipientName}},</p><p>This letter serves as formal written notice that {{senderName}} hereby terminates the {{agreementName}} dated {{agreementDate}} (the "Agreement") on the basis of {{terminationBasis}}, effective {{effectiveDate}}.</p>` },
      { title: 'Basis',               sortOrder: 20, content: `<p>The specific facts giving rise to this termination are set forth below. [Describe the breach or cite the notice provision being invoked.]</p>` },
      { title: 'Effects of Termination', sortOrder: 30, content: `<p>From and after the Termination Effective Date, the parties' respective rights and obligations will be governed by the survival and post-termination provisions of the Agreement. {{senderName}} reserves all rights and remedies available to it under the Agreement and at law.</p>` },
    ],
  },

  // 20. Mutual Amendment
  {
    name: 'Amendment to Existing Agreement',
    description: 'General-purpose amendment to modify, add to, or replace specific terms of an existing agreement.',
    contractType: 'Amendment',
    isPublished: true,
    variables: [
      { key: 'partyAName',      label: 'Party A Name',           type: 'string', required: true },
      { key: 'partyBName',      label: 'Party B Name',           type: 'string', required: true },
      { key: 'agreementName',   label: 'Agreement Being Amended', type: 'string', required: true },
      { key: 'originalDate',    label: 'Original Agreement Date', type: 'date',  required: true },
      { key: 'amendmentNumber', label: 'Amendment Number',       type: 'string', required: true, defaultValue: '1' },
      { key: 'effectiveDate',   label: 'Amendment Effective Date', type: 'date', required: true },
    ],
    sections: [
      { title: 'Preamble',            sortOrder: 10, content: `<p>This Amendment No. {{amendmentNumber}} (this "Amendment") to the {{agreementName}} dated {{originalDate}} (the "Agreement") is entered into as of {{effectiveDate}} between {{partyAName}} and {{partyBName}}. Capitalized terms used but not defined have the meanings given in the Agreement.</p>` },
      { title: 'Amendments',          sortOrder: 20, content: `<p>The Agreement is amended as follows: [List each amendment using "Section X is amended to read in its entirety: ...", "Section Y is deleted in its entirety", or "The following Section Z is added: ..."]</p>` },
      { title: 'Ratification',        sortOrder: 30, content: `<p>Except as amended by this Amendment, the Agreement remains in full force and effect.</p>` },
      { title: 'Conflicts',           sortOrder: 40, content: `<p>In the event of a conflict between this Amendment and the Agreement, this Amendment controls.</p>` },
      { title: 'Counterparts',        sortOrder: 50, content: `<p>This Amendment may be executed in counterparts (including by electronic signature), each of which is deemed an original.</p>` },
    ],
  },

  // 21–22. docs/41 Part 14 — what a renewal decision drafts: a short letter
  // extending the term (renew as is, renewing by agreement) and the notice
  // that stops a renewal (let it lapse, end it). lib/renewal-decisions.ts
  // fills the variables from the agreement and its renewal terms.
  {
    name: 'Renewal letter',
    description: 'A short letter agreement renewing an existing agreement for another term on the same terms.',
    contractType: 'RENEWAL_LETTER',
    isPublished: true,
    isDefaultForType: true,
    variables: [
      { key: 'senderName',        label: 'Our company',             type: 'string', required: true },
      { key: 'recipientName',     label: 'Counterparty',            type: 'string', required: true },
      { key: 'agreementName',     label: 'Agreement',               type: 'string', required: true },
      { key: 'agreementDate',     label: 'Agreement date',          type: 'date',   required: false },
      { key: 'currentExpiryDate', label: 'Current end date',        type: 'date',   required: true },
      { key: 'renewalTerm',       label: 'Renewal term',            type: 'string', required: true, defaultValue: '12 months' },
      { key: 'newExpiryDate',     label: 'New end date',            type: 'date',   required: true },
    ],
    sections: [
      { title: 'Renewal',      sortOrder: 10, content: `<p>Dear {{recipientName}},</p><p>We refer to the {{agreementName}} dated {{agreementDate}} (the "Agreement"), whose current term ends on {{currentExpiryDate}}. The parties agree to renew the Agreement for a further term of {{renewalTerm}}, so that it ends on {{newExpiryDate}}.</p>` },
      { title: 'Same terms',   sortOrder: 20, content: `<p>Except for its term, the Agreement continues on the same terms. Capitalised terms not defined in this letter have the meanings given in the Agreement.</p>` },
      { title: 'Agreement',   sortOrder: 30, content: `<p>Please sign below to confirm your agreement. This letter may be signed in counterparts, including by electronic signature.</p><p>{{senderName}}</p>` },
    ],
  },
  {
    name: 'Notice of non-renewal',
    description: 'Written notice that an agreement will not renew at the end of its current term.',
    contractType: 'NON_RENEWAL_NOTICE',
    isPublished: true,
    isDefaultForType: true,
    variables: [
      { key: 'senderName',        label: 'Our company',             type: 'string', required: true },
      { key: 'recipientName',     label: 'Counterparty',            type: 'string', required: true },
      { key: 'agreementName',     label: 'Agreement',               type: 'string', required: true },
      { key: 'agreementDate',     label: 'Agreement date',          type: 'date',   required: false },
      { key: 'currentExpiryDate', label: 'End of current term',     type: 'date',   required: true },
      { key: 'noticeDays',        label: 'Notice period (days)',    type: 'number', required: false },
    ],
    sections: [
      { title: 'Notice',          sortOrder: 10, content: `<p>Dear {{recipientName}},</p><p>We refer to the {{agreementName}} dated {{agreementDate}} (the "Agreement"). This letter is our written notice, given under the Agreement's renewal provisions ({{noticeDays}} days' notice), that the Agreement will not renew and will end at the end of its current term on {{currentExpiryDate}}.</p>` },
      { title: 'Until then',      sortOrder: 20, content: `<p>Until that date both parties continue to perform the Agreement. The provisions of the Agreement that survive its end continue to apply.</p>` },
      { title: 'Sender',          sortOrder: 30, content: `<p>{{senderName}}</p>` },
    ],
  },
]

export const UNIVERSAL_TEMPLATES: SeedTemplate[] = UNIVERSAL_TEMPLATES_LITERAL.map(withGoverningLawSlot)
