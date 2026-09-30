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
    blurb: 'Capture contract requests through an intake form or the API, classified before anyone picks them up.',
    agent: 'Intake + Classify Agents',
    details: [
      'Auto-classify type, priority, counterparty, value, governing law',
      'Planned: pull data from Salesforce, HubSpot, and ticketing tools',
      'A person assigns each request to its legal owner, with the classification filled in',
    ],
  },
  {
    slug: 'draft',
    step: 2,
    name: 'Draft',
    blurb: 'Generate first drafts from your templates — not generic AI output.',
    agent: 'Draft Agent',
    details: [
      'Your templates and clause library, not invented language',
      'Filled from the request, the counterparty record and template defaults',
      'Terms it couldn\'t fill are flagged for you, not guessed',
    ],
  },
  {
    slug: 'negotiate',
    step: 3,
    name: 'Negotiate',
    blurb: 'Counterparty redlines come back? The agent reads them, rates them, and counters.',
    agent: 'Redline + Playbook Review Agents',
    details: [
      'Each change scored for risk — before, as proposed and with your counter — with the reasons',
      'Counter-language goes back in their own Word file, as tracked changes',
      'Their paper: upload it, redline it against your playbook, share it, take their return and compare',
      'Returns by portal link or email — or download a working copy, edit it in Google Docs and upload it back',
    ],
  },
  {
    slug: 'approve',
    step: 4,
    name: 'Approve',
    blurb: 'Sequential or parallel approval workflows that match how your team actually works.',
    agent: 'Approval Agent',
    details: [
      'Route by contract type and value; auto-approve under a value limit you set per type',
      'Approver sees an AI summary, risk flags and a recommendation',
      'Approve from Slack (Teams gets notification cards) so legal doesn\'t become a bottleneck',
    ],
  },
  {
    slug: 'sign',
    step: 5,
    name: 'Sign',
    blurb: 'E-signature built in — not an AI agent. No third-party e-sign vendor in the data path.',
    agent: 'Built-in e-signature',
    details: [
      'Every signer, internal or external, signs through a personal link',
      'A certificate page records each signer\'s name, time, IP and browser',
      'Word or PDF in, sealed PDF out: one PAdES/X.509 seal, so any later change shows',
    ],
  },
  {
    slug: 'track',
    step: 6,
    name: 'Track',
    blurb: 'After signature is when the work starts. Obligations, renewals, payments — all tracked.',
    agent: 'Obligation Agent + invoice matching',
    details: [
      'Auto-extract renewal dates, payment schedules, audit rights',
      'Reminders to the contract owner a week before each deadline; renewals weekly from 90 days out',
      'Renewals view: what auto-renews and when notice is due, overdue first',
      'Invoice matching by vendor, date and currency, with the amount checked against the contract total',
    ],
  },
]
