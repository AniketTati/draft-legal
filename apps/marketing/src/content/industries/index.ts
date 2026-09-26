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
      'GDPR / DPA flow with sub-processor tracking',
      'CCPA / state privacy law alignment',
      'SOC 2 / customer security questionnaires from your repository',
    ],
    features: [
      {
        title: 'Sales-ops self-service',
        body: 'Sara in Sales Ops can spin up an NDA herself. Playbook checks ensure she stays inside legal\'s rules — no review-queue ping-pong.',
      },
      {
        title: 'Counterparty roll-ups',
        body: 'A Snowflake page that shows every MSA, DPA, SOW, and vendor agreement with them — and your aggregate exposure.',
      },
      {
        title: 'Auto-renewal alerts',
        body: 'The Obligation Agent extracts every auto-renewal clause and pings the deal owner before the window closes.',
      },
      {
        title: 'CRM-native drafting',
        body: 'Planned: pull customer data from Salesforce or HubSpot directly into the contract — no copy-paste from CRM to Word.',
      },
    ],
    persona: { org: 'Vertex Cloud-shaped B2B SaaS', size: '~800 employees, ~$80M ARR' },
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
      'Which BAAs are missing the latest sub-processor exhibit?',
      'Show me DPAs that haven\'t been updated since the GDPR refresh.',
      'Are we storing PHI with any vendor that doesn\'t have a current BAA?',
      'Find every contract with Epic — MSA, BAA, DPA, support.',
      "What's our HIPAA breach-notification window across customers?",
    ],
    compliance: [
      'HIPAA / HITECH — BAA-aligned templates and required clauses',
      'GDPR / DPA flows for cross-border data',
      'Sub-processor list tracking with version history',
      'State privacy laws (CCPA, CPA, VCDPA, ...)',
    ],
    features: [
      {
        title: 'BAA-aware extraction',
        body: 'The Review Agent knows BAA-specific fields: covered entity, business associate, sub-processor list, breach notification window, audit rights.',
      },
      {
        title: 'Sub-processor tracking',
        body: 'Maintain a single source of truth for which vendors process PHI — flagged when contracts diverge.',
      },
      {
        title: 'Compliance officer dashboard',
        body: 'A non-attorney role (DPO, Privacy Officer) gets a tailored view of compliance flags without seeing the whole legal queue.',
      },
      {
        title: 'Self-host for ePHI',
        body: 'For teams that can\'t put PHI on a third-party SaaS, run Draft Legal in your own VPC. Same code, your infra.',
      },
    ],
    persona: { org: 'Caldera Health-shaped digital-health platform', size: '~600 employees, ~$60M ARR' },
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
      'Show me every contract with Bosch across our 12 plants.',
      'Which supplier MSAs are up for renewal in Q4?',
      'Find all contracts where we agreed to LD penalties > $1M.',
      'What\'s our exposure if Plant 4 goes offline — which contracts have force majeure carve-outs?',
      'Pull every contract that needs SOC 2 evidence from the supplier.',
    ],
    compliance: [
      'Conflict-minerals / supply-chain due diligence',
      'Export control (ITAR, EAR)',
      'Supplier diversity reporting',
      'M&A / carve-out support with diligence rooms',
    ],
    features: [
      {
        title: 'Plant-scoped permissions',
        body: 'Each plant\'s contracts manager sees only their plant\'s contracts — but corporate procurement sees the global rollup.',
      },
      {
        title: 'Diligence rooms',
        body: 'Multi-document analysis for M&A: upload a target\'s 200 contracts, ask "what change-of-control restrictions apply?"',
      },
      {
        title: 'ERP integration',
        body: 'Planned: sync supplier records with SAP / Oracle / NetSuite so contract metadata flows into your purchasing systems.',
      },
      {
        title: 'Supplier pages',
        body: 'A Bosch page that shows every active contract, total spend, expiring agreements, and risk flags across the supplier relationship.',
      },
    ],
    persona: { org: 'Ironbridge Industrial-shaped PE-backed manufacturer', size: '~5,000 employees, ~$1.2B revenue' },
  },
  biotech: {
    slug: 'biotech',
    label: 'Biotech',
    hero: 'CLM for biotech, pharma, and research-stage life sciences.',
    intro:
      'Biotech contracts revolve around IP, MTAs, and research collaborations. Draft Legal gives a 2-person legal team the leverage of a 20-person team.',
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
      'Which IP-assignment agreements are missing for current employees?',
      'What licenses do we have in-licensed from Genentech?',
      'Pull every research collaboration where we share IP rights.',
      'Show me CROs whose MSAs are missing the new compliance exhibit.',
    ],
    compliance: [
      'FDA / regulatory — clinical-trial-related agreements',
      'IP / patent — assignment chain integrity',
      'Export control for research materials',
      'University / NIH compliance (Bayh-Dole, march-in)',
    ],
    features: [
      {
        title: 'Research-friendly interface',
        body: 'Scientists can request MTAs from the same portal they use for purchase orders. Legal stays out of the loop on routine cases.',
      },
      {
        title: 'IP-chain tracking',
        body: 'Audit-ready IP assignment chain: every contributor, every assignment document, every gap surfaced.',
      },
      {
        title: 'License terms repository',
        body: 'In-licensed and out-licensed agreements indexed by field-of-use, exclusivity, royalty terms, milestones — searchable in plain English.',
      },
      {
        title: 'Diligence-ready',
        body: 'Build the data room with one click — Draft Legal generates a categorized index your bankers and acquirers will actually use.',
      },
    ],
    persona: { org: 'Lumen Bio-shaped pre-clinical biotech', size: '~80 employees, $35M raised' },
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
      'Which carrier rates are above market right now?',
      'Find every contract with peak-season volume commitments.',
      'What insurance certificates are expiring in the next 30 days?',
      'Pull every customer agreement at the Memphis hub.',
    ],
    compliance: [
      'Carrier safety / FMCSA',
      'Customer SOC 2 / supply-chain diligence',
      'Insurance certificate tracking',
      'Peak-season volume commitments',
    ],
    features: [
      {
        title: 'Hub-scoped views',
        body: 'Hannah at the Atlanta hub sees Atlanta\'s customer agreements; Chris at Memphis sees his — corporate sees both.',
      },
      {
        title: 'SLA obligation tracking',
        body: 'Auto-extract SLA thresholds, penalty caps, force-majeure triggers, and route alerts to ops when thresholds slip.',
      },
      {
        title: 'Carrier rate lookups',
        body: 'Quick search across carrier MSAs by lane, equipment type, fuel-surcharge formula. Ops gets the answer without legal triage.',
      },
      {
        title: 'Insurance cert reminders',
        body: 'Contracts that require carrier insurance get cert-expiry tracking — automated reminders 60 / 30 / 7 days out.',
      },
    ],
    persona: { org: 'Beacon Logistics-shaped 3PL', size: '~1,200 employees, ~$280M revenue' },
  },
}
