export type Industry = {
  slug: string
  label: string
  hero: string
  intro: string
  contracts: { type: string; share: string; note: string }[]
  jtbds: string[]
  compliance: string[]
  features: { title: string; body: string }[]
  persona: { org: string; size: string }
}

export const industries: Record<string, Industry> = {
  saas: {
    slug: 'saas',
    label: 'SaaS',
    hero: 'CLM for B2B SaaS legal teams.',
    intro:
      'Sales-led B2B SaaS teams move 50-200 NDAs and MSAs/quarter, with DPAs flowing in from every enterprise customer. Draft Legal handles the volume without slowing the deal.',
    contracts: [
      { type: 'NDA (mutual + sales)', share: '40%', note: 'high-volume, low-touch' },
      { type: 'MSA (customer)', share: '20%', note: 'liability cap, governing law, term' },
      { type: 'SOW / Order Form', share: '15%', note: 'pricing, scope, milestones' },
      { type: 'DPA + sub-processor', share: '10%', note: 'GDPR, sub-processor list' },
      { type: 'Vendor agreement', share: '10%', note: 'inbound from procurement' },
      { type: 'Partner / reseller', share: '5%', note: 'rev share, channel' },
    ],
    jtbds: [
      'Show me NDAs expiring in next 30 days that I should renew.',
      "What's our exposure with Snowflake across all contracts?",
      'Find the most-recent MSA template — I need to draft for Ramp.',
      'Are there any DPAs without a sub-processor list?',
      "What's stuck in my approval queue and why?",
      'Sara wants to send an NDA to Plaid — does our sales playbook allow it?',
      'Show all contracts with auto-renew clauses expiring in Q3.',
      "Compare our current Stripe order form to last year's.",
    ],
    compliance: [
      'GDPR checks on a DPA, run on demand, including sub-processor terms',
      'CCPA/CPRA checks for California privacy law',
      'A Data Processing Addendum template (GDPR/CCPA) to start from',
    ],
    features: [
      {
        title: 'Sales-ops drafting',
        body: 'Sara in Sales Ops starts an NDA from legal\'s own template, and sees only her own contracts. Approval rules can approve NDAs under a value limit automatically.',
      },
      {
        title: 'Counterparty roll-ups',
        body: 'A Snowflake page that shows every MSA, DPA, SOW, and vendor agreement with them — and their total value.',
      },
      {
        title: 'Auto-renewal alerts',
        body: 'The Renewals view lists auto-renewal and notice-due dates, overdue first, and the contract owner gets a renewal alert every week from 90 days out.',
      },
      {
        title: 'CRM-native drafting',
        body: 'Planned: pull customer data from Salesforce or HubSpot directly into the contract — no copy-paste from CRM to Word.',
      },
    ],
    persona: { org: 'a sales-led B2B SaaS company', size: '~800 employees, ~$80M ARR' },
  },
  healthcare: {
    slug: 'healthcare',
    label: 'Healthcare',
    hero: 'CLM for healthcare and digital-health legal teams.',
    intro:
      'Healthcare contracts are compliance landmines: BAAs, DPAs, sub-processor lists, regulatory exhibits. Draft Legal helps your team stay compliant without becoming a bottleneck.',
    contracts: [
      { type: 'BAA (Business Associate Agreement)', share: '30%', note: 'HIPAA-required' },
      { type: 'DPA + sub-processor', share: '25%', note: 'patient data flows' },
      { type: 'MSA (customer)', share: '20%', note: 'hospitals, payers, pharma' },
      { type: 'Vendor', share: '15%', note: 'EHR, infrastructure, services' },
      { type: 'Clinical research / DUA', share: '10%', note: 'data use agreements' },
    ],
    jtbds: [
      'Which BAAs let the vendor use subcontractors, and on what terms?',
      'Which DPAs name a transfer mechanism for data leaving the EU?',
      'Which vendors have signed a BAA with us, and when do those BAAs expire?',
      'Find every contract with Epic — MSA, BAA, DPA, support.',
      "What's our HIPAA breach-notification window across customers?",
    ],
    compliance: [
      'HIPAA checks on BAAs, run per contract',
      'A Business Associate Agreement template (healthcare industry pack)',
      'GDPR checks, including international transfer terms',
      'California privacy law (CCPA/CPRA) checks',
    ],
    features: [
      {
        title: 'HIPAA checks on BAAs',
        body: 'A BAA isn\'t one of the fixed contract types (it\'s filed as Other), but the HIPAA check tests it for permitted uses, safeguards, breach notification, subcontractor flow-down and more.',
      },
      {
        title: 'Your own BAA fields',
        body: 'Add custom fields such as covered entity, business associate and breach-notice window, and the Review Agent extracts them from each contract.',
      },
      {
        title: 'Read-only access for compliance',
        body: 'Give your DPO or Privacy Officer the built-in Viewer role: they see every contract and its compliance results, and can\'t change anything.',
      },
      {
        title: 'Self-hosting and PHI',
        body: 'Run Draft Legal in your own VPC: the database and files stay on your infrastructure. With AI features on, contract text goes to the model provider you configure, under your own keys. ID numbers, emails, phone numbers and dates of birth are masked first by default; names, addresses and health details are not. Without an AI key the app still runs.',
      },
    ],
    persona: { org: 'a digital-health platform', size: '~600 employees, ~$60M ARR' },
  },
  manufacturing: {
    slug: 'manufacturing',
    label: 'Manufacturing',
    hero: 'CLM for procurement-heavy manufacturers.',
    intro:
      'Manufacturers run hundreds of supplier contracts across plants and geographies. Procurement teams need contract visibility that legal won\'t bottleneck.',
    contracts: [
      { type: 'Supplier MSA', share: '35%', note: 'tier-1 and tier-2 suppliers' },
      { type: 'SOW / PO', share: '25%', note: 'project-specific scopes' },
      { type: 'NDA (vendor)', share: '15%', note: 'pre-RFQ' },
      { type: 'Customer agreement', share: '15%', note: 'OEM and distributor' },
      { type: 'M&A / divestiture', share: '10%', note: 'asset purchases, carve-outs' },
    ],
    jtbds: [
      'Show me every contract we have with Bosch.',
      'Which supplier MSAs are up for renewal in Q4?',
      'Find all contracts where we agreed to LD penalties > $1M.',
      'Which supplier contracts have a force majeure clause, and what does it leave out?',
      'Pull every contract that needs SOC 2 evidence from the supplier.',
    ],
    compliance: [
      'Clause-library language for conflict minerals (Dodd-Frank §1502)',
      'Clause-library language for sanctions and export controls',
      'A Master Supply Agreement template (manufacturing industry pack)',
      'Diligence rooms for M&A and carve-out reviews',
    ],
    features: [
      {
        title: 'Plant groupings',
        body: 'Group each plant\'s contracts in a matter to see them together. Access is by role and org-wide: there are no per-plant permissions.',
      },
      {
        title: 'Diligence rooms',
        body: 'For M&A, upload a target\'s contracts in batches: each is analysed, and the room gives you one table of value, term and risk to compare and export as CSV. Room documents stay out of your own portfolio\'s search and figures.',
      },
      {
        title: 'ERP integration',
        body: 'Planned: sync supplier records with SAP / Oracle / NetSuite so contract metadata flows into your purchasing systems.',
      },
      {
        title: 'Supplier pages',
        body: 'A Bosch page that shows every contract, their total value, expiry dates, and risk scores across the supplier relationship.',
      },
    ],
    persona: { org: 'a PE-backed manufacturer', size: '~5,000 employees, ~$1.2B revenue' },
  },
  biotech: {
    slug: 'biotech',
    label: 'Biotech',
    hero: 'CLM for biotech, pharma, and research-stage life sciences.',
    intro:
      'Biotech contracts revolve around IP, MTAs, and research collaborations. Draft Legal helps a two-person legal team keep up.',
    contracts: [
      { type: 'Research collaboration', share: '25%', note: 'with universities, pharma' },
      { type: 'MTA (Material Transfer)', share: '20%', note: 'inbound and outbound' },
      { type: 'IP assignment', share: '15%', note: 'employee, contractor, founder' },
      { type: 'License (in / out)', share: '15%', note: 'patent licensing' },
      { type: 'CRO / vendor MSA', share: '15%', note: 'clinical and pre-clinical' },
      { type: 'Confidentiality / NDA', share: '10%', note: 'pre-collaboration' },
    ],
    jtbds: [
      'Find every MTA where we transferred materials to Stanford.',
      'Which employment agreements are missing IP assignment language?',
      'What licenses do we have in-licensed from Genentech?',
      'Pull every research collaboration where we share IP rights.',
      'Which of our CRO MSAs say who owns the study data?',
    ],
    compliance: [
      'Clause-library language for GLP / GMP, IRB and IACUC (biotech industry pack)',
      'Background-IP, joint-invention and clinical-data ownership clauses',
      'A Material Transfer Agreement template (biotech industry pack)',
      'Clause-library language for sanctions and export controls',
    ],
    features: [
      {
        title: 'Simple MTA requests',
        body: 'Scientists file an MTA request through the intake form. The Intake Agent classifies it, and someone on legal picks it up with the facts already filled in.',
      },
      {
        title: 'IP clause search',
        body: 'Find background-IP, joint-invention and data-ownership language across every agreement, in plain English, with the clause quoted.',
      },
      {
        title: 'License terms repository',
        body: 'In- and out-licenses with their license type, field of use, territory, royalty structure and sublicensing rights extracted and cited — searchable in plain English.',
      },
      {
        title: 'Diligence prep',
        body: 'When bankers or acquirers ask, export the contract list as CSV and download any document.',
      },
    ],
    persona: { org: 'a pre-clinical biotech', size: '~80 employees, $35M raised' },
  },
  logistics: {
    slug: 'logistics',
    label: 'Logistics',
    hero: 'CLM for 3PLs, freight, and supply-chain operators.',
    intro:
      'Customer SLAs and carrier agreements define your business. Draft Legal helps Ops and Legal track the obligations that matter — penalties, carve-outs, peak-season terms.',
    contracts: [
      { type: 'Customer SLA / TSA', share: '35%', note: 'service-level commitments' },
      { type: 'Carrier agreement', share: '30%', note: 'freight providers, drayage' },
      { type: 'Lease (warehouse)', share: '15%', note: 'real estate footprint' },
      { type: 'Vendor / equipment', share: '10%', note: 'WMS, telematics, robots' },
      { type: 'NDA + insurance', share: '10%', note: 'pre-contract' },
    ],
    jtbds: [
      'Show me customer SLAs with on-time delivery thresholds below 95%.',
      'Which carrier agreements have a fuel surcharge, and how is it calculated?',
      'Find every contract with peak-season volume commitments.',
      'What cargo insurance do our carrier agreements require?',
      'Pull every customer agreement at the Memphis hub.',
    ],
    compliance: [
      'Clause-library language for DOT / FMCSA compliance and hazardous materials',
      'Clause-library language for cargo liability (Carmack) and insurance',
      'A Transportation Services Agreement template (logistics industry pack)',
      'Clause-library language for fuel surcharges and demurrage / detention',
    ],
    features: [
      {
        title: 'Hub groupings',
        body: 'Group each hub\'s customer agreements in a matter, so Hannah in Atlanta and Chris in Memphis each find their hub\'s contracts together. Access is by role and org-wide: there are no per-hub permissions.',
      },
      {
        title: 'SLA obligation tracking',
        body: 'SLAs get their own fields — service targets, service-credit formula and cap — and the contract owner gets a reminder a week before a dated obligation is due. Actual performance isn\'t monitored.',
      },
      {
        title: 'Carrier rate lookups',
        body: 'Search carrier agreements in plain English for a lane, an equipment type or a fuel-surcharge formula, and get the clauses that mention it. Ops gets the answer without legal triage.',
      },
      {
        title: 'Insurance terms',
        body: 'Insurance requirements are extracted with the other contract terms and are searchable, and dated obligations the contract states get a reminder a week before they\'re due. Certificates of insurance aren\'t tracked.',
      },
    ],
    persona: { org: 'a third-party logistics (3PL) provider', size: '~1,200 employees, ~$280M revenue' },
  },
}
