export type LearnArticle = {
  slug: string
  title: string
  category: 'Concept' | 'Contract type' | 'Process'
  tldr: string
  sections: { heading: string; body: string }[]
  relatedSlugs: string[]
  productLink?: { label: string; href: string }
}

const placeholderTldr = (slug: string) =>
  `Quick overview of ${slug.replace(/-/g, ' ')} for legal, ops, and procurement teams. Full guide coming soon — meanwhile, see the related concepts below.`

const placeholderSections = (slug: string) => [
  {
    heading: `What is ${slug.replace(/-/g, ' ')}?`,
    body: `This article is being written. We're keeping the page live so the URL is stable, search engines can find it, and you can bookmark it. In the meantime, the related guides below cover overlapping ground.`,
  },
]

export const learnArticles: Record<string, LearnArticle> = {
  'contract-lifecycle-management': {
    slug: 'contract-lifecycle-management',
    title: 'What is Contract Lifecycle Management (CLM)?',
    category: 'Concept',
    tldr: 'Contract Lifecycle Management (CLM) is the systematic management of contracts from request through drafting, negotiation, approval, signature, and post-signature obligations. Modern CLM software replaces shared drives, email chains, and ad-hoc Word documents with a single platform that tracks every contract\'s state, stores executed copies, enforces approval policies, and surfaces obligations like renewals before they lapse.',
    sections: [
      {
        heading: 'What is Contract Lifecycle Management?',
        body: 'CLM covers six stages: (1) intake, where a request enters the system; (2) drafting, where a first version is created from templates; (3) negotiation, where redlines are exchanged with the counterparty; (4) approval, where stakeholders sign off; (5) signature, where the contract is executed; and (6) post-signature tracking, where obligations like renewals, payments, and audits are managed. CLM software ties these stages together with workflow, a searchable repository, and increasingly, AI agents that handle routine work.',
      },
      {
        heading: 'Why does CLM matter?',
        body: 'Most companies lose money on contracts they don\'t actively manage. Auto-renewals trigger because nobody saw them coming. Liability caps drift because templates aren\'t enforced. Approvals stall in email. CLM doesn\'t solve these by accident — it solves them by giving every contract a state machine, every clause a source of truth, and every obligation an owner.',
      },
      {
        heading: 'How does CLM work in practice?',
        body: 'A request comes in (a sales rep needs an MSA, a procurement manager needs a supplier agreement). The system classifies it, and someone on legal takes it on and drafts from the right template. The redline back from the counterparty is checked against your playbook. Approvals route by value or contract type. Signature happens in-platform. After signature, the system extracts renewal dates, payment milestones, and audit rights, and alerts owners as deadlines approach.',
      },
      {
        heading: 'CLM vs. eSignature vs. Contract Repository',
        body: 'Standalone eSignature tools only handle signing. Contract repositories store executed contracts but do not manage drafting or approvals. Full CLM covers the whole lifecycle. Modern AI-first platforms (like draftLegal) collapse these into one product: agents handle drafting and review, the repository indexes everything, and signature is built in.',
      },
      {
        heading: 'What to look for in a CLM platform',
        body: 'Agent-first AI (not bolted-on chatbots), full lifecycle coverage, transparent pricing, fast time-to-value (weeks, not quarters), and ideally open source you can self-host, so your contracts don\'t live in a black box.',
      },
    ],
    relatedSlugs: ['ai-contract-review', 'ai-contract-drafting', 'contract-repository', 'contract-approval-workflow', 'obligation-management'],
    productLink: { label: 'See how Draft Legal handles each lifecycle stage →', href: '/product' },
  },
  'ai-contract-review': {
    slug: 'ai-contract-review',
    title: 'What is AI Contract Review?',
    category: 'Concept',
    tldr: 'AI contract review uses large language models to read a contract, extract key terms (parties, value, dates, liability, IP, governing law), flag deviations from your standards, and rate risk. Done well, it shortens the first read while keeping a human in the loop for judgment calls. Done poorly, it hallucinates clauses that don\'t exist — which is why citations and confidence scores matter.',
    sections: [
      {
        heading: 'What is AI contract review?',
        body: 'AI contract review automates the first read of a contract: extracting structured data (counterparty, value, term, jurisdiction), summarizing key obligations, comparing against your template or fallback positions, and flagging anything unusual. The output is a structured analysis — not a vague chatbot response. Modern systems extract 14+ universal fields (across all contracts) plus 9-16 type-specific fields per contract type, with confidence scores and citations.',
      },
      {
        heading: 'How does AI contract review work?',
        body: 'A document is parsed (PDF/DOCX → text), split into clauses, and passed to an LLM with tightly scoped prompts. The agent extracts each field, validates it against expected formats and ranges, and scores confidence. For deviation analysis, the extracted clauses are compared against your playbook or fallback library. Risk is scored based on the size and direction of each deviation.',
      },
      {
        heading: 'What does good AI contract review look like?',
        body: 'Three signals: (1) every extracted value comes with a citation back to the exact contract quote, so you can verify; (2) confidence scores are surfaced (red / yellow / green), so reviewers know where to look; (3) the system flags what\'s missing, not just what\'s present — a missing liability cap is more dangerous than a high one.',
      },
      {
        heading: 'AI contract review accuracy',
        body: 'Accuracy varies widely by contract type, prompt quality, and model, and a vendor\'s benchmark is not your paper. Always test on a representative sample of your own contracts before committing to a vendor.',
      },
      {
        heading: 'Common pitfalls',
        body: 'One-pass extraction without validation. No citations. Vague risk scoring with no rubric. Overconfidence on edge cases (regulatory exhibits, jurisdictional clauses). The fix: agents that show their work — plan, extract, validate, score — with humans gating destructive actions.',
      },
    ],
    relatedSlugs: ['ai-contract-drafting', 'contract-redlining', 'clause-library', 'contract-lifecycle-management'],
    productLink: { label: 'See how Draft Legal reviews the other side\'s paper →', href: '/product#negotiate' },
  },
  'ai-contract-drafting': {
    slug: 'ai-contract-drafting',
    title: 'AI Contract Drafting Explained',
    category: 'Concept',
    tldr: 'AI contract drafting generates first-draft contracts from your templates and clause library, filling in the parties and terms from the request and your counterparty records, and flagging what it couldn\'t fill. The good ones assemble approved language rather than writing clauses from scratch. Done right, "draft me an MSA for Ramp" gets you a first draft to review, not a blank page.',
    sections: [
      {
        heading: 'What is AI contract drafting?',
        body: 'AI drafting takes a request (counterparty, deal type, key terms) and produces a first draft. The agent picks the right template, with your standard clauses in it, fills in counterparty and deal data, and flags the terms it couldn\'t fill.',
      },
      {
        heading: 'Where does the drafted language come from?',
        body: 'The good systems don\'t write clauses from scratch — they build from your templates and a curated clause library. Your library is your moat: the standard liability cap, the approved governing-law options, the IP language you\'ve negotiated to death. The agent fills in the template, and a person checks the draft against your playbook rules ("MSA liability cap = 12 months ARR, never less") before it goes out.',
      },
      {
        heading: 'AI drafting vs. template assembly',
        body: 'Template assembly (the old way) means filling blanks in a Word template. AI drafting goes further: it picks the right template and fills it from what you asked for and what you already know about the counterparty, so a human reviews a filled-in draft instead of a blank form.',
      },
      {
        heading: 'What makes AI drafting actually useful',
        body: 'Three things: (1) template-bound — it drafts from the templates and clauses legal has approved; (2) data-aware — it fills in parties and terms from the request and your counterparty records, not from the user\'s memory, and says what it couldn\'t fill; (3) reviewed — a person checks the draft against your playbook before it goes out.',
      },
    ],
    relatedSlugs: ['clause-library', 'ai-contract-review', 'contract-redlining', 'contract-lifecycle-management'],
    productLink: { label: 'See the Draft Agent in action →', href: '/product#draft' },
  },
  'contract-redlining': {
    slug: 'contract-redlining',
    title: 'What is Contract Redlining?',
    category: 'Process',
    tldr: 'Contract redlining is the negotiation process where parties exchange marked-up versions of a contract showing proposed changes. AI-powered redlining checks each change against your standard positions, scores its risk, and drafts counter-language aimed at your playbook position for you to review. The goal: stay in control of negotiation without re-reading the entire contract every round.',
    sections: [
      {
        heading: 'What is contract redlining?',
        body: 'Redlining means showing edits to a contract — additions, deletions, replacements — typically with tracked changes in Word. Each side proposes language, the other side counter-proposes, and the contract converges through 2-5 rounds of edits. Modern CLM platforms make this less manual by auto-detecting deviations and proposing counter-language.',
      },
      {
        heading: 'How does AI-powered redlining work?',
        body: 'When a counterparty\'s redline arrives, the agent compares each changed clause with your playbook positions — preferred, acceptable, fallback, and walkaway. Every change gets a recommendation (accept, counter, or reject), a category ("liability", "IP", "termination"), and a risk score before the change, as proposed, and with your counter-proposal, with the reasons. Where it recommends a counter, the AI drafts language aimed at your playbook position for the negotiator to review. The negotiator stays in control.',
      },
      {
        heading: 'Redlining best practices',
        body: 'Maintain a clause library with 2-3 fallback positions per major term. Use playbooks to encode "non-negotiable" lines (e.g., "we never agree to unlimited liability"). Track every round in version-controlled storage so you can see the negotiation trail. Flag deal-breakers immediately so deals don\'t die at signature.',
      },
      {
        heading: 'Word tracked changes and CLM redlining',
        body: 'Most counterparties negotiate in Word, so a CLM has to meet them there. Draft Legal works on the other side\'s Word file and sends your redline back as tracked changes, scoring the risk of each change before, as proposed, and with your counter. You can also download a working copy, edit it in Google Docs, and upload it back as the next version. For volume, that beats re-reading every round by hand.',
      },
    ],
    relatedSlugs: ['ai-contract-review', 'clause-library', 'ai-contract-drafting', 'contract-approval-workflow'],
    productLink: { label: 'See the Redline Agent →', href: '/product#negotiate' },
  },
  'clause-library': {
    slug: 'clause-library',
    title: 'What is a Clause Library?',
    category: 'Concept',
    tldr: 'A clause library is a curated, versioned repository of pre-approved contract language — your "always", "preferred", "fallback", and "must-not" positions on every major term. It\'s the backbone of consistent contracts, fast drafting, and disciplined negotiation. Without one, every contract is a fresh start; with one, your AI drafts from language you\'ve already vetted and measures redlines against it.',
    sections: [
      {
        heading: 'What is a clause library?',
        body: 'A clause library is a structured collection of contract language organized by topic (liability, IP, indemnification, governing law, ...). For each topic, you maintain multiple positions: your preferred language, fallback options when the counterparty pushes back, and red-line positions you won\'t cross.',
      },
      {
        heading: 'Why every legal team needs one',
        body: 'Without a library, every drafter starts from a different version, every negotiation reinvents the same arguments, and inconsistent terms creep into your portfolio. A library fixes all three: drafting becomes assembly, negotiation becomes reference, and your portfolio reflects deliberate choices instead of drift.',
      },
      {
        heading: 'How AI uses your clause library',
        body: 'The Draft Agent builds drafts from your templates and the library clauses they use — not from generic training data. The Redline Agent compares counterparty proposals with your playbook positions and drafts counter-language aimed at them, for a lawyer to review. Language that comes from your own library is easier to check than text a model wrote from scratch.',
      },
      {
        heading: 'Building a clause library that actually gets used',
        body: 'Start small: 5 topics, 3 positions each. Tag every clause with metadata (contract type, jurisdiction, deal stage). Version every change. Make it searchable in plain English ("show me my IP-ownership fallbacks"). Drafters and AI both pull from it.',
      },
    ],
    relatedSlugs: ['ai-contract-drafting', 'contract-redlining', 'contract-lifecycle-management'],
    productLink: { label: 'How Draft Legal manages your clause library →', href: '/product#draft' },
  },
  'nda': {
    slug: 'nda',
    title: 'What is a Non-Disclosure Agreement (NDA)?',
    category: 'Contract type',
    tldr: 'A Non-Disclosure Agreement (NDA) is a contract where parties agree to keep specific information confidential. The two main flavors are mutual (both sides share confidential info) and one-way (only one side does). NDAs are usually the first contract signed in any business relationship — sales, partnerships, M&A, hiring — and they\'re the highest-volume contract type for most legal teams.',
    sections: [
      {
        heading: 'What is an NDA?',
        body: 'An NDA defines what information is confidential, who can see it, how long the obligation lasts, and what happens if it\'s breached. Standard NDAs are 2-5 pages; complex ones (M&A, deep technology disclosure) can stretch to 20+.',
      },
      {
        heading: 'Mutual NDA vs. one-way NDA',
        body: 'Mutual NDAs protect both sides — common when two companies are evaluating a partnership or both will share sensitive info. One-way (or "unilateral") NDAs protect a single discloser — common when one party shares confidential info with a vendor, contractor, or candidate.',
      },
      {
        heading: 'Key clauses in every NDA',
        body: '1) Definition of confidential information (broad enough to cover what you care about, narrow enough to be enforceable). 2) Permitted uses. 3) Term (typically 2-5 years). 4) Carve-outs (publicly available info, independently developed, legally required disclosures). 5) Return or destruction of info on termination. 6) Governing law and jurisdiction.',
      },
      {
        heading: 'Common NDA pitfalls',
        body: 'Overly broad confidentiality definitions that the counterparty won\'t sign. Term too long for the actual sensitivity of the info. Missing carve-outs that make compliance practically impossible. Vague remedies that make breach unenforceable. AI-assisted review flags these for a lawyer to check, so they aren\'t left to a tired manual read.',
      },
      {
        heading: 'AI for NDAs',
        body: 'NDAs are the perfect use case for agent-first CLM: high volume, predictable structure, low judgment per contract. A well-tuned system extracts the key terms and checks them against your playbook, so a person only has to look closely at the unusual ones. In Draft Legal, approval rules can approve NDAs under a value limit automatically.',
      },
    ],
    relatedSlugs: ['msa', 'dpa', 'contract-redlining', 'ai-contract-review'],
    productLink: { label: 'NDA template guide →', href: '/templates/nda' },
  },
  'msa': {
    slug: 'msa',
    title: 'What is a Master Service Agreement (MSA)?',
    category: 'Contract type',
    tldr: 'A Master Service Agreement (MSA) is the umbrella contract between a service provider and a customer, covering the long-term commercial terms — pricing structure, liability, IP, payment, term and termination, governing law. Specific projects then attach as Statements of Work (SOWs) under the MSA. MSAs are negotiated once and govern many SOWs, which makes them the highest-leverage contract type for B2B SaaS, professional services, and procurement.',
    sections: [
      {
        heading: 'What is an MSA?',
        body: 'An MSA sets the rules of engagement between two companies. Once it\'s signed, individual projects (SOWs, Order Forms) reference the MSA for the boilerplate and add only project-specific terms — scope, deliverables, price, schedule. This separation lets you renegotiate the relationship once a year instead of every project.',
      },
      {
        heading: 'MSA vs. SOW',
        body: 'MSA = umbrella terms (one-time negotiation). SOW = project-specific work and price (negotiated each engagement). The SOW points back to the MSA: "this SOW is governed by the MSA dated X." If the MSA is well-drafted, SOWs are short and easy to close.',
      },
      {
        heading: 'Key clauses to negotiate',
        body: 'Liability cap (typically capped at 12 months of fees, with carve-outs). Indemnification (mutual, with cap-aligned exceptions). IP ownership (work-for-hire? licensed back?). Payment terms (NET 30 vs. NET 60 — material to cash flow). Term and termination (auto-renew? convenience termination?). Governing law and venue. Insurance requirements. Confidentiality. Draft Legal reads a liability cap from its wording — "two times (2x) the fees paid in the twelve months" is 24 months of fees — notes whose cap it is, keeps super-caps apart, and checks it against your playbook limits.',
      },
      {
        heading: 'MSA negotiation strategy',
        body: 'Identify your "must-haves" upfront — typically the liability cap and IP terms. Maintain fallback positions for every key clause so negotiators don\'t reinvent positions. Use a clause library: when the counterparty proposes alternative language, pull from your pre-approved fallbacks instead of drafting fresh.',
      },
      {
        heading: 'AI for MSAs',
        body: 'MSAs are heavier than NDAs but follow predictable structure. AI extracts the key terms, compares them against your standards, and flags the ones that need human attention. The Draft Agent fills a first draft from your template and the counterparty\'s details; when their redline comes back, often as a Word file with tracked changes, the Redline Agent scores each change before, as proposed, and with your counter-proposal.',
      },
    ],
    relatedSlugs: ['nda', 'sow', 'dpa', 'contract-redlining', 'clause-library'],
    productLink: { label: 'MSA template guide →', href: '/templates/msa' },
  },
}

export const learnIndex = Object.values(learnArticles)

export const stubLearnEntry = (slug: string): LearnArticle => ({
  slug,
  title: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  category: 'Concept',
  tldr: placeholderTldr(slug),
  sections: placeholderSections(slug),
  relatedSlugs: ['contract-lifecycle-management', 'ai-contract-review'],
})
