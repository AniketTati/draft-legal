export type Stage = {
  slug: string
  step: number
  name: string
  blurb: string
  agent: string
  details: string[]
}

export const lifecycle: Stage[] = [
  {
    slug: 'intake',
    step: 1,
    name: 'Intake',
    blurb: 'Capture every contract request through an intake form or the API — and route it.',
    agent: 'Intake + Classify Agents',
    details: [
      'Auto-classify type, priority, counterparty, value, jurisdiction',
      'Planned: pull data from Salesforce, HubSpot, and ticketing tools',
      'Route to the right legal owner or auto-approve simple NDAs',
    ],
  },
  {
    slug: 'draft',
    step: 2,
    name: 'Draft',
    blurb: 'Generate first drafts from your templates and playbook — not generic AI output.',
    agent: 'Draft Agent',
    details: [
      'Templates + clause library + playbook positions, not invented language',
      'Pull customer data from your CRM into the draft',
      'Every deviation from playbook flagged with severity and rationale',
    ],
  },
  {
    slug: 'negotiate',
    step: 3,
    name: 'Negotiate',
    blurb: 'Counterparty redlines come back? The agent reads them, rates them, and counters.',
    agent: 'Redline Agent',
    details: [
      'Detect every deviation from your standard / fallback positions',
      'Auto-generate counter-language ranked by deal-breaker risk',
      'Email-inbound or portal-driven flows — both work',
    ],
  },
  {
    slug: 'approve',
    step: 4,
    name: 'Approve',
    blurb: 'Sequential or parallel approval workflows that match how your team actually works.',
    agent: 'Approval Agent',
    details: [
      'Route by value, contract type, jurisdiction, counterparty risk',
      'Approver sees an AI summary + risk flags + diff vs. template',
      'Approve from Slack (Teams gets notification cards) so legal doesn\'t become a bottleneck',
    ],
  },
  {
    slug: 'sign',
    step: 5,
    name: 'Sign',
    blurb: 'Self-hosted electronic signature. No third-party vendor in the data path.',
    agent: 'Signature Agent',
    details: [
      'Internal signers via JWT, external via tokenized link',
      'PDF/A-compliant outputs with embedded signing certificates',
      'Audit trail per page, per signer, per IP',
    ],
  },
  {
    slug: 'track',
    step: 6,
    name: 'Track',
    blurb: 'After signature is when the work starts. Obligations, renewals, payments — all tracked.',
    agent: 'Obligation + Invoice Agents',
    details: [
      'Auto-extract renewal dates, payment schedules, audit rights',
      'Alerts to the right owner before deadlines, not after',
      'Reconcile invoices against contracted rates and flag overruns',
    ],
  },
]
