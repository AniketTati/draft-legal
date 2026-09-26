export type Template = {
  slug: string
  title: string
  shortLabel: string
  audience: string
  tldr: string
  whatItIs: string
  keyClauses: { name: string; body: string }[]
  pitfalls: string[]
  /**
   * A path under apps/marketing/public. Set it only with the file committed:
   * hosting answers a missing file with the site's index.html (X71; a tripwire
   * in apps/api/src/lib/marketing-claims.test.ts checks).
   */
  downloadFile?: string
  publishedComingSoon?: boolean
}

const placeholder = (slug: string, label: string): Template => ({
  slug,
  title: `${label} Template Guide`,
  shortLabel: label,
  audience: 'Legal, ops, and procurement teams',
  tldr: `A plain-English guide to the ${label} is being written, with a downloadable template to follow. Meanwhile, Draft Legal can draft one for you.`,
  whatItIs: `${label} is a contract type used by many B2B teams. We're publishing the full plain-English explainer soon.`,
  keyClauses: [],
  pitfalls: [],
  publishedComingSoon: true,
})

export const templates: Record<string, Template> = {
  nda: {
    slug: 'nda',
    title: 'Mutual NDA Template Guide',
    shortLabel: 'NDA',
    audience: 'Sales, partnerships, M&A, hiring',
    tldr: 'The mutual Non-Disclosure Agreement (NDA) — the kind you sign before any meaningful B2B conversation. Mutual covers both parties; flip the language to one-way if only one side will share. Edit the term, jurisdiction, and definition of confidential information for your situation. We strongly recommend a real lawyer reviews any contract before you sign.',
    whatItIs:
      'A mutual NDA defines what information is confidential, who can see it, how long the obligation lasts, and what happens if it\'s breached. Most B2B sales conversations open with one — exchanged before anyone shares pricing, roadmaps, or customer details.',
    keyClauses: [
      {
        name: 'Definition of Confidential Information',
        body: 'Define this broadly enough to cover what you actually care about — financials, customer data, technical info, business plans — but narrow enough that the other side will sign. "Information marked confidential, or that a reasonable person would understand to be confidential" is a common, defensible standard.',
      },
      {
        name: 'Permitted Uses',
        body: 'Specify the purpose ("evaluating a potential business relationship") and limit use to that purpose. Without this, the receiving party could legally use your info in ways you didn\'t intend.',
      },
      {
        name: 'Term and Survival',
        body: 'NDAs typically run 2-5 years. The confidentiality obligation should survive the term — i.e., even after the NDA expires, info disclosed under it should remain confidential for the survival period.',
      },
      {
        name: 'Carve-outs',
        body: 'Five standard carve-outs: (1) information already public; (2) information already known by the receiver; (3) information independently developed; (4) information from a third party not under NDA; (5) legally required disclosures.',
      },
      {
        name: 'Governing law and venue',
        body: 'Pick a jurisdiction. Delaware is common for US tech; English law and London are common for cross-border deals. The receiving party may push for their home jurisdiction — negotiate.',
      },
    ],
    pitfalls: [
      'Term too long for the actual sensitivity (perpetual NDAs are unenforceable in many jurisdictions).',
      'Confidentiality definition too broad — counterparty won\'t sign or you have no real obligation.',
      'Missing legally-required-disclosure carve-out, which can put parties in impossible positions during litigation.',
      'No remedy clause — what happens on breach? Specific performance? Damages?',
    ],
  },
  msa: {
    slug: 'msa',
    title: 'Master Service Agreement (MSA) Template Guide',
    shortLabel: 'MSA',
    audience: 'B2B SaaS, professional services, agencies',
    tldr: 'The Master Service Agreement (MSA), for B2B SaaS, professional services, and agency engagements. MSAs are negotiated once and govern many SOWs — get this right and project paperwork is fast forever. Customize liability cap, IP terms, and payment terms for your business. Have a real lawyer review before you ship.',
    whatItIs:
      'An MSA is the umbrella agreement between a service provider and a customer. It covers commercial terms, liability, IP, payment, and termination. Specific projects then attach as Statements of Work (SOWs) under the MSA.',
    keyClauses: [
      {
        name: 'Liability cap',
        body: 'Industry standard: 12 months of fees paid under the MSA, with carve-outs for indemnification and confidentiality breach. Customers will push for higher caps — especially enterprise. Negotiate carve-outs harder than the cap itself.',
      },
      {
        name: 'Indemnification',
        body: 'Mutual indemnification is standard. Provider indemnifies for IP infringement; customer indemnifies for misuse of the product. Cap exceptions for fraud, willful misconduct, IP infringement, and confidentiality breach.',
      },
      {
        name: 'IP ownership',
        body: 'Default: each party retains ownership of pre-existing IP; customer owns the deliverables. Be explicit about background IP, derivative works, and license-back rights. Murky IP language is the most common dispute trigger.',
      },
      {
        name: 'Payment terms',
        body: 'NET 30 is standard, but enterprise customers will push NET 60 or NET 90. Cash flow matters — negotiate. Late fees (1.5%/month) and service-suspension rights for non-payment are common.',
      },
      {
        name: 'Term and termination',
        body: 'Initial term + auto-renew is standard. Either side may terminate for convenience with 30-90 days notice; for cause is shorter. Auto-renewal is the most-overlooked clause — use a CLM that tracks expiry windows.',
      },
      {
        name: 'Insurance',
        body: 'Customers will often require Cyber, E&O, GL, and sometimes Workers Comp. $1M-$5M is standard for mid-market; larger for enterprise. Maintain certificates and update annually.',
      },
    ],
    pitfalls: [
      'Liability cap with no carve-outs — devastating in an IP dispute.',
      'Vague IP-ownership language that triggers disputes when work goes well.',
      'Missing or vague auto-renewal terms — silent renewals cost real money.',
      'Insurance requirements that exceed your actual coverage.',
      'Acceptance criteria for deliverables that are subjective — "to customer\'s satisfaction" is unenforceable.',
    ],
  },
  dpa: {
    slug: 'dpa',
    title: 'Data Processing Agreement (DPA) Template Guide',
    shortLabel: 'DPA',
    audience: 'Any company that processes EU/UK personal data',
    tldr: 'The Data Processing Agreement (DPA) under GDPR Article 28. Required when you process personal data on behalf of a customer (controller). Covers the standard SCCs reference for cross-border transfers and a sub-processor list pattern. Adapt for your specific data flows. Real legal review is non-optional for DPAs.',
    whatItIs:
      'A DPA defines the relationship between a data controller (typically your customer) and a data processor (typically you, the SaaS vendor). Required by GDPR for any processing of EU/UK personal data, and increasingly required by US state privacy laws.',
    keyClauses: [
      {
        name: 'Scope of processing',
        body: 'Categories of data, categories of data subjects, processing purposes, duration. Be specific. "All personal data the controller submits to the service" is too vague for sophisticated counterparties.',
      },
      {
        name: 'Sub-processor list',
        body: 'Maintain a public list of every sub-processor that touches personal data (your cloud provider, your email service, your analytics, etc.). Notify customers of changes. Many customers reserve the right to object to new sub-processors.',
      },
      {
        name: 'Data subject rights',
        body: 'Processor must assist controller in responding to data-subject requests (access, deletion, portability). Specify response SLAs.',
      },
      {
        name: 'Security measures',
        body: 'Reference Annex II with specific TOMs (Technical and Organizational Measures): encryption at rest and in transit, access controls, audit logging, vulnerability management, incident response.',
      },
      {
        name: 'Breach notification',
        body: 'GDPR requires notification "without undue delay" — typically 24-72 hours. Specify timing, channel, and required content of breach notice.',
      },
      {
        name: 'International transfers',
        body: 'For EU→US transfers, reference the EU Standard Contractual Clauses (Module 2 for controller-to-processor). For UK, the IDTA. Note any data-residency commitments.',
      },
    ],
    pitfalls: [
      'Sub-processor list missing or stale — auditors will catch it.',
      'TOMs (security measures) too vague — enterprise customers will reject.',
      'Breach notification window unrealistic for your incident-response capability.',
      'International-transfer mechanisms missing for non-EU sub-processors.',
      'No clear deletion/return obligation at the end of processing.',
    ],
  },
  baa: placeholder('baa', 'BAA'),
  sow: placeholder('sow', 'SOW'),
  'employment-agreement': placeholder('employment-agreement', 'Employment Agreement'),
  mta: placeholder('mta', 'MTA'),
}
