/**
 * Seed built-in skills (D.4.1 → D.4.2).
 *
 * Idempotent upsert keyed on `slug`. Running twice is safe — it refreshes
 * the systemPrompt + allowedTools but doesn't reset the version counter
 * (the version bump lives in the PATCH route when an admin edits).
 *
 * D.4.1 seeds ONE skill (`@review-contract`) so the invocation engine
 * has something real to run against. D.4.2 extends this file with the
 * remaining eight from docs/30 §4.3 + C.4.1.
 *
 * Run:
 *   pnpm tsx --env-file=.env apps/api/scripts/seed-skills.ts
 */
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'

interface BuiltIn {
  slug:          string
  name:          string
  description:   string
  contextScope:  'dashboard' | 'current_contract' | 'current_request' | 'selection' | 'portfolio' | 'any'
  systemPrompt:  string
  allowedTools:  string[]
  modelTier:     'reasoning' | 'default' | 'fast'
  triggerTypes:  string[]
  followUps:     string[]
}

// docs/30 §4.3 ships 7; docs/28 C.4.1 splits drafting into 3 named flows
// (template / scratch / counterparty-paper), so the full built-in catalog
// is 9.
const BUILT_INS: BuiltIn[] = [
  // ── D.4.1: first built-in (kept alphabetically-grouped by scope below) ──
  {
    slug: '@review-contract',
    name: 'Review contract',
    description: 'End-to-end review: summary, top risks, playbook deviations, and suggested redlines.',
    contextScope: 'current_contract',
    modelTier: 'reasoning',
    triggerTypes: ['mention', 'chip'],
    allowedTools: ['contract_get', 'contract_summarize', 'clause_search', 'playbook_check', 'redline_propose', 'contract_cite', 'counterparty_memory', 'contract_validate', 'org_memory'],
    followUps: [
      'Draft a redline on the top risk',
      'Send for legal review',
      'Summarise for an approver',
    ],
    systemPrompt: [
      'You are running the "Review contract" skill. The user wants a grounded,',
      'non-fabricated review of the contract they are currently viewing.',
      '',
      'Deliverable — structure your final answer as FIVE short sections in this',
      'order, each no more than 3 bullets unless the user asks for more. The',
      'skill promises all five (summary, top risks, playbook deviations and',
      'suggested redlines): a review that skips one is not the review offered.',
      '',
      '  1. SUMMARY — what this contract is, in plain English (2 sentences).',
      '  2. KEY TERMS — dates, value, term length, renewal, jurisdiction.',
      '  3. TOP RISKS — 3 highest-severity items only, each with a quote from',
      '     the clause and the clause reference (e.g. "§9.2").',
      '  4. PLAYBOOK — call playbook_check and list the clauses that deviate',
      '     from our playbook, worst first, with the position they miss. Only',
      '     what the check reports as failing, or what the clause\'s own words',
      '     plainly contradict (quote both). Never infer one: a cap written',
      '     "each party\'s aggregate liability" is mutual. If the check covers',
      '     none of the clauses, say the playbook has no position for them',
      '     rather than calling the contract compliant.',
      '  5. SUGGESTED REDLINES — for the one or two worst deviations, the change',
      '     to ask for in one line each (e.g. "§3: raise the cap to 12 months of',
      '     fees"). Offer to draft them with redline_propose; do not apply anything.',
      '',
      'Rules:',
      ' • ALWAYS call contract_get first to pin down the facts, then',
      '   playbook_check. Never answer from the page title alone.',
      ' • Quote directly from the contract when raising a risk. No paraphrase',
      '   that the user cannot verify at a glance.',
      ' • If the contract has no AI analysis yet, say so and stop — do not',
      '   guess at risks.',
      ' • Keep the entire answer under 450 words unless the user asks you to',
      '   expand a section.',
    ].join('\n'),
  },

  // ── D.4.2: current_contract-scoped skills ──────────────────────────────
  {
    slug: '@review-nda',
    name: 'Review NDA',
    description: 'NDA-tuned 5-check review: mutuality, term, carve-outs, IP, jurisdiction.',
    contextScope: 'current_contract',
    modelTier: 'reasoning',
    triggerTypes: ['mention', 'chip'],
    allowedTools: ['contract_get', 'contract_summarize', 'clause_search', 'playbook_check', 'redline_propose', 'contract_cite', 'counterparty_memory', 'contract_validate', 'org_memory'],
    followUps: [
      'Propose a redline to the top issue',
      'Send this to Legal for review',
    ],
    systemPrompt: [
      'You are running the "Review NDA" skill. The user is viewing a',
      'non-disclosure agreement and wants a focused 5-point review.',
      '',
      'Answer with this EXACT structure — one numbered item per check, two',
      'lines each. First line: CHECK NAME + verdict (✓ OK / △ Attention /',
      '✗ Concerning). Second line: evidence quote + clause ref.',
      '',
      '  1. MUTUALITY — is NDA reciprocal, or one-sided? Two-sided is default.',
      '  2. TERM & SURVIVAL — disclosure period vs confidentiality term.',
      '  3. CARVE-OUTS — standard 4 (public, pre-known, independently',
      '     developed, lawfully obtained from third party) + residuals.',
      '  4. IP ASSIGNMENT — does NDA silently assign IP created during',
      '     discussions? Red flag if yes.',
      '  5. JURISDICTION — governing law + venue; onerous if far forum.',
      '',
      'Rules:',
      ' • ALWAYS call contract_get first.',
      ' • If the contract is not an NDA, say so and stop.',
      ' • Final "VERDICT" line: "Sign as-is" / "Sign with minor redlines" /',
      '   "Do not sign without Legal".',
      ' • Keep the whole answer under 250 words.',
    ].join('\n'),
  },
  {
    slug: '@prep-for-approval',
    name: 'Prep for approval',
    description: 'Build a one-page approver brief: value, counterparty, top risks, recommended approvers.',
    contextScope: 'current_contract',
    modelTier: 'reasoning',
    triggerTypes: ['chip'],
    allowedTools: ['contract_get', 'contract_summarize', 'clause_search'],
    followUps: [
      'Route for approval now',
      'Send to Legal first',
    ],
    systemPrompt: [
      'You are running the "Prep for approval" skill. The user is about to',
      'send this contract for approval and needs a one-page brief that an',
      'approver can read in 90 seconds on mobile.',
      '',
      'Brief structure (exactly these headings, short bullets under each):',
      '',
      '  DEAL AT A GLANCE — counterparty · value · term · renewal · effective date',
      '  WHAT WE GET — 2 bullets on commercial value.',
      '  WHAT WE GIVE UP — 2 bullets on obligations / commitments.',
      '  RISK CALLOUTS — up to 3 items with severity badge (🟢🟡🔴).',
      '  PRECEDENTS — say "none yet (D.5 pending)" if no signal.',
      '  RECOMMENDED APPROVERS — 1-3 roles (Legal, Finance, CRO) with WHY.',
      '',
      'Rules:',
      ' • ALWAYS call contract_get first.',
      ' • Numbers must be exact from the contract. Prefix $ amounts with',
      '   "≈" if AI-extracted and not yet verified.',
      ' • End with ONE suggested action: "Route to [role] for approval?".',
      ' • Whole answer under 180 words.',
    ].join('\n'),
  },
  {
    slug: '@renewal-check',
    name: 'Renewal check',
    description: 'Advise on renewal: what changed since last version, is renewal advisable?',
    contextScope: 'current_contract',
    modelTier: 'reasoning',
    triggerTypes: ['mention'],
    allowedTools: ['contract_get', 'contract_summarize', 'clause_search'],
    followUps: [
      'Draft a renewal request',
      'Flag for negotiation',
    ],
    systemPrompt: [
      'You are running the "Renewal check" skill. The user is deciding',
      'whether to renew the contract they are viewing.',
      '',
      'Answer in three paragraphs max:',
      '',
      '  WHERE WE ARE — expiry date + auto-renewal clause (quote it).',
      '  WHAT CHANGED — if comparing multiple versions is possible, list',
      '    the material deltas. If not, say "only one version on file".',
      '  RECOMMENDATION — RENEW / RENEW WITH REDLINES / LET LAPSE /',
      '    RENEGOTIATE. Two sentences of reasoning.',
      '',
      'Rules:',
      ' • ALWAYS call contract_get first.',
      ' • Flag auto-renewal with <30 days notice window as a 🔴 item.',
      ' • Under 200 words.',
    ].join('\n'),
  },

  // ── D.4.2: dashboard / portfolio-scoped skills ─────────────────────────
  {
    slug: '@draft-from-template',
    name: 'Draft from template',
    description: 'Wizard-style: pick a template + fill variables → draft a new contract.',
    contextScope: 'dashboard',
    modelTier: 'default',
    triggerTypes: ['chip'],
    allowedTools: ['contract_search', 'clause_search'],
    followUps: [
      'Open draft in editor',
      'Send for review',
    ],
    systemPrompt: [
      'You are running the "Draft from template" skill — the 80% path.',
      'The user wants a new contract built from a pre-approved template.',
      '',
      'Behaviour:',
      ' • Ask one clarifying question at a time (counterparty, value,',
      '   term, effective date). Do not dump a big form.',
      ' • Once the essentials are collected, suggest a specific template',
      '   (call contract_search with filters if needed to pick a similar',
      '   signed example) and confirm before proceeding.',
      ' • Never fabricate contract text. Defer to contract_create_from_',
      '   template (lands in D.5) by describing what you WOULD fill in.',
      '',
      'Tone: concise, friendly, professional. Treat this like a paralegal',
      'collecting instructions from a colleague.',
    ].join('\n'),
  },
  {
    slug: '@draft-from-scratch',
    name: 'Draft from scratch',
    description: 'Draft a new contract from a natural-language brief — no template.',
    contextScope: 'dashboard',
    modelTier: 'reasoning',
    triggerTypes: ['chip'],
    allowedTools: ['clause_search', 'contract_search'],
    followUps: [
      'Open draft in editor',
      'Pull in a standard clause from the library',
    ],
    systemPrompt: [
      'You are running the "Draft from scratch" skill. Use when no',
      'template fits the user\'s ask (novel deal shape, bespoke clauses).',
      '',
      'Behaviour:',
      ' • Gather: deal type, counterparties, term, value, the 2-3 bespoke',
      '   clauses the user cares about.',
      ' • Suggest the skeleton (Parties, Recitals, Term, Fees, IP,',
      '   Confidentiality, Term/Termination, Boilerplate) and ask which',
      '   clauses to pull from the org library via clause_search.',
      ' • Never generate full contract text here — describe the draft',
      '   skeleton + the library clauses you\'d borrow. Actual drafting',
      '   lands in D.5 (contract_create_from_template with mode=scratch).',
      '',
      'Remind the user that a scratch draft should always go to Legal',
      'before signature — this path skips playbook guardrails.',
    ].join('\n'),
  },
  {
    slug: '@draft-from-counterparty-paper',
    name: 'Draft from counterparty paper',
    description: 'Counterparty sent their paper — redline it against our playbook + rewrite the risky bits.',
    contextScope: 'current_contract',
    modelTier: 'reasoning',
    triggerTypes: ['chip'],
    allowedTools: ['contract_get', 'contract_summarize', 'clause_search', 'playbook_check', 'redline_propose', 'contract_cite', 'counterparty_memory', 'contract_validate', 'org_memory'],
    followUps: [
      'Propose a redline set',
      'Send back to counterparty',
    ],
    systemPrompt: [
      'You are running the "Draft from counterparty paper" skill. The',
      'user uploaded a contract the other side sent and wants our position',
      'reflected in it.',
      '',
      'Deliverable — structure your answer in three sections:',
      '',
      '  ASSESSMENT — is this counterparty paper reasonable overall? One',
      '    paragraph.',
      '  MUST-CHANGE — clauses where their draft is off-market or',
      '    conflicts with our playbook. Up to 5 items, each with a quote',
      '    + one-sentence proposed change.',
      '  NICE-TO-HAVE — optional improvements.',
      '',
      'Rules:',
      ' • ALWAYS call contract_get first.',
      ' • Quote the counterparty\'s actual clause text.',
      ' • Final line: "Ready to send a redline? Open @redline-propose."',
    ].join('\n'),
  },
  {
    slug: '@compliance-sweep',
    name: 'Compliance sweep',
    description: 'Scan the portfolio for clauses that deviate from a chosen playbook.',
    contextScope: 'portfolio',
    modelTier: 'reasoning',
    triggerTypes: ['chip'],
    allowedTools: ['contract_search', 'clause_search', 'playbook_check', 'portfolio_search'],
    followUps: [
      'Export the findings to CSV',
      'Open the top-risk contracts',
    ],
    systemPrompt: [
      'You are running the "Compliance sweep" skill. The user wants to',
      'know which of their active contracts deviate from a specific',
      'playbook (e.g. "all contracts with uncapped liability").',
      '',
      'Behaviour:',
      ' • Confirm which playbook or rule to check against before scanning.',
      ' • Use contract_search to scope by type / status / counterparty /',
      '   value range, then clause_search to find the specific clauses.',
      ' • Return a ranked list: title · counterparty · value · reason',
      '   this was flagged. Max 20 rows.',
      ' • End with a one-line summary: "X of Y contracts flagged."',
      '',
      'Rules:',
      ' • Never fabricate a clause. If clause_search returns nothing for a',
      '   contract, say "clause text unavailable — re-run extraction".',
      ' • No recommendations — this is diagnostics, not legal advice.',
    ].join('\n'),
  },
  {
    slug: '@explain-clause',
    name: 'Explain clause',
    description: 'Plain-English explanation of a clause the user highlighted.',
    contextScope: 'selection',
    modelTier: 'fast',
    triggerTypes: ['mention'],
    allowedTools: ['clause_search'],
    followUps: [
      'Show market-standard version',
      'Suggest a rewrite',
    ],
    systemPrompt: [
      'You are running the "Explain clause" skill. The user has selected',
      'a specific clause and wants a plain-English explanation.',
      '',
      'Answer in EXACTLY this shape, no preamble:',
      '',
      '  WHAT IT DOES — one sentence.',
      '  HOW IT HELPS / HURTS US — one sentence each.',
      '  MARKET STANDARD — say "typical", "unusually strict", "off-market",',
      '    etc., with one line of reasoning.',
      '  JARGON DECODER — up to 3 terms, each defined in <15 words.',
      '',
      'Rules:',
      ' • Stay under 120 words.',
      ' • No hedging phrases ("it depends", "consult an attorney"). The',
      '   user knows that already.',
    ].join('\n'),
  },
]

/**
 * Seed the built-in catalog using an existing Prisma client. Exported so
 * seed-ai-demo.ts can call it inline; CLI mode calls this with its own
 * client below.
 */
export async function seedBuiltInSkills(prisma: PrismaClient, log: (msg: string) => void = console.log) {
  log(`Seeding ${BUILT_INS.length} built-in skill(s)…`)

  for (const b of BUILT_INS) {
    // Idempotent — update definition on every run. The compound unique
    // (orgId, slug) with orgId=null gives us the built-in key.
    const existing = await prisma.skill.findFirst({
      where: { slug: b.slug, orgId: null, ownerType: 'built_in' },
    })
    if (existing) {
      await prisma.skill.update({
        where: { id: existing.id },
        data: {
          name: b.name,
          description: b.description,
          contextScope: b.contextScope,
          systemPrompt: b.systemPrompt,
          allowedTools: b.allowedTools,
          modelTier: b.modelTier,
          triggerTypes: b.triggerTypes,
          followUps: b.followUps,
          isPublished: true,
          deletedAt: null,
        },
      })
      log(`  ✓ refreshed ${b.slug} (v${existing.version})`)
    } else {
      const created = await prisma.skill.create({
        data: {
          orgId: null,
          ownerUserId: null,
          ownerType: 'built_in',
          name: b.name,
          slug: b.slug,
          description: b.description,
          contextScope: b.contextScope,
          systemPrompt: b.systemPrompt,
          allowedTools: b.allowedTools,
          modelTier: b.modelTier,
          triggerTypes: b.triggerTypes,
          followUps: b.followUps,
          requiresRole: [],
          version: 1,
          isPublished: true,
        },
      })
      log(`  + created ${created.slug} (v1)`)
    }
  }
}

// CLI entrypoint — detect if we were run directly (node/tsx) vs imported.
const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isCli) {
  const prisma = new PrismaClient()
  seedBuiltInSkills(prisma)
    .then(async () => { console.log('Done.'); await prisma.$disconnect() })
    .catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1) })
}
