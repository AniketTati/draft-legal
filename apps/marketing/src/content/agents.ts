export type Agent = {
  slug: string
  name: string
  blurb: string
  capability: string
  status: 'live' | 'planned'
}

export const agents: Agent[] = [
  {
    slug: 'intake',
    name: 'Intake Agent',
    blurb: 'Triages new contract requests',
    capability: 'Classifies each request — type, priority, counterparty, value, governing law — so the person who assigns it starts with the facts.',
    status: 'live',
  },
  {
    slug: 'classify',
    name: 'Classify Agent',
    blurb: 'Identifies the contract type',
    capability: 'Sorts each upload into one of 10 contract types — NDA, MSA, SOW, SLA, DPA, order form and more — or Other, with a confidence score.',
    status: 'live',
  },
  {
    slug: 'review',
    name: 'Review Agent',
    blurb: 'Extracts key terms with citations',
    capability: '14 universal + 9-16 type-specific fields, each cited to the contract with a confidence score. Low-confidence values are flagged for review.',
    status: 'live',
  },
  {
    slug: 'ask',
    name: 'Ask Agent',
    blurb: 'Q&A across one or many contracts',
    capability: 'Hybrid BM25 + pgvector search returns answers with clause-level citations.',
    status: 'live',
  },
  {
    slug: 'portfolio',
    name: 'Portfolio Agent',
    blurb: 'Multi-document analysis',
    capability: '"What\'s our exposure with Snowflake?" — searches the whole portfolio, states the true total and says when an answer rests on a sample.',
    status: 'live',
  },
  {
    slug: 'draft',
    name: 'Draft Agent',
    blurb: 'Generates first drafts from your templates',
    capability: "Fills your template from the request, the counterparty record and template defaults, and flags the terms it couldn't fill.",
    status: 'live',
  },
  {
    slug: 'redline',
    name: 'Redline Agent',
    blurb: 'Negotiates counterparty redlines',
    capability: 'Scores each change the other side made — before, as proposed and with your counter — writes counter-language, and returns it in their Word file as tracked changes.',
    status: 'live',
  },
  {
    slug: 'playbook-review',
    name: 'Playbook Review Agent',
    blurb: 'Checks their paper against your playbook',
    capability: 'Rates each clause of a contract you received — preferred, acceptable, fallback or walkaway — before any redline exists.',
    status: 'live',
  },
  {
    slug: 'approval',
    name: 'Approval Agent',
    blurb: 'Briefs approvers on each contract',
    capability: 'Writes the AI summary, risk flags and recommendation each approver sees. Workflows route by contract type and value, in sequence or in parallel.',
    status: 'live',
  },
  {
    slug: 'obligation',
    name: 'Obligation Agent',
    blurb: 'Tracks obligations after signature',
    capability: 'Extracts payment, renewal, audit and reporting obligations from the contract and reminds the contract owner a week before each is due.',
    status: 'live',
  },
  {
    slug: 'compliance',
    name: 'Compliance Agent',
    blurb: 'Checks GDPR, HIPAA, SOX and CCPA/CPRA terms',
    capability: 'Run on demand per contract: says which frameworks apply and whether each required clause is present, partial, missing or risky, quoting the text.',
    status: 'live',
  },
  {
    slug: 'detect-binder',
    name: 'Binder Agent',
    blurb: 'Splits PDFs into individual contracts',
    capability: 'Multi-doc PDFs (M&A diligence rooms) auto-split into separate contracts with metadata.',
    status: 'live',
  },
]

export const agentStats = {
  total: agents.length,
  live: agents.filter((a) => a.status === 'live').length,
  planned: agents.filter((a) => a.status === 'planned').length,
}
