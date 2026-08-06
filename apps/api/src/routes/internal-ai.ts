/**
 * Internal AI router endpoint (D.0.3)
 *
 * Called by the Python agents service to resolve "given (orgId, tier),
 * give me the (provider, model, apiKey) tuple to use right now."
 *
 * Auth: x-internal-secret header (shared INTERNAL_SERVICE_SECRET).
 *       Refuses requests without it. This endpoint MUST never be exposed
 *       publicly — it returns plaintext API keys.
 *
 * Production hardening (v1.1):
 *   - Bind only to loopback in production
 *   - Cache resolution per (orgId, tier) for ~30s in Redis
 *   - Audit-log every resolution call
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { resolveLlm, NoProviderAvailable, type Tier } from '../lib/aiRouter.js'
import { prisma } from '../lib/prisma.js'
import { resolveApprovers, checkAutoApprove, type WorkflowStepDef } from '../lib/workflow-engine.js'
import { generateDocument } from '../lib/template-engine.js'
import { searchClauses } from '../lib/embeddings.js'
import { advancedSearch, indexContract } from '../lib/elasticsearch.js'
import { queueClassifyDocument, queueParseDocument } from '../lib/queue.js'
import { applyPiiPolicy, applyPiiPolicyBatch } from '../lib/pii-policy.js'
import { proposeClauseAlternatives } from '../lib/clause-propose.js'
import { proposeClauseBatch } from '../lib/clause-propose-batch.js'
import { applyClauseProposal } from '../lib/clause-apply.js'
import { rrfScore } from '../lib/rrf.js'
import { normalisedKey } from '../lib/clause-category.js'

const TIERS: Tier[] = ['reasoning', 'default', 'fast', 'embed', 'rerank', 'vision_ocr']

// P1.3 — used to call Python /playbook_judge from the Node playbook_check
// handler. Matches agent-threads.ts's AGENTS_INTERNAL_URL pattern.
const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8000'
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? ''

// D.5.1 — normalise clauseType ("limitation_of_liability") +
// ClauseCategory.name ("Limitation of Liability") to the same key so a
// lightweight join works without a formal FK. Shared with clause-propose so
// the checker and the rewriter resolve a clause to the same category.


// ── P7.5.1 — PII redaction for the multi-excerpt agent tools ────────────
// Most tools in this file return MANY document-derived excerpts per call
// (a deal list, a check list, a citation list, a comparison matrix).
// Running the single-value `applyPiiPolicy` per excerpt would re-read the
// org policy N times and write N PII_REDACTED audit rows for what the
// user experienced as ONE action, burying the audit trail it exists to
// provide. `applyPiiPolicyBatch` does one policy read and emits one audit
// event for the whole page; this wrapper adds two things on top:
//
//   1. Null-safety. Excerpts and summaries are routinely null. Callers
//      pass the sparse array straight through and get nulls back in the
//      same positions, so response shape and ordering never change.
//   2. Errors never break the tool call — but they must not silently
//      ship raw PII either. A thrown policy lookup is retried once with
//      an explicit force-redact, which skips the org-settings DB read
//      (the only realistic failure point, since `redactPii` itself is
//      pure regex). Only if that ALSO throws do we withhold the text.
const REDACTION_UNAVAILABLE = '[text withheld: PII redaction unavailable]'

async function redactExcerpts(
  orgId: string,
  values: Array<string | null | undefined>,
  opts: { surface: string; contractId?: string; userId?: string },
): Promise<Array<string | null>> {
  // Compact to the positions that actually carry text, remembering where
  // each came from so we can put the redacted values back in place.
  const idx: number[] = []
  const texts: string[] = []
  values.forEach((v, i) => {
    if (typeof v === 'string' && v.length > 0) { idx.push(i); texts.push(v) }
  })
  const out: Array<string | null> = values.map(v => (typeof v === 'string' ? v : null))
  if (texts.length === 0) return out

  let redacted: string[]
  try {
    redacted = (await applyPiiPolicyBatch(orgId, texts, opts)).texts
  } catch (err) {
    console.error(`[internal-ai] PII redaction failed for ${opts.surface}; retrying force-redact:`, err)
    try {
      redacted = (await applyPiiPolicyBatch(orgId, texts, { ...opts, override: 'redact' })).texts
    } catch (err2) {
      console.error(`[internal-ai] force-redact failed for ${opts.surface}; withholding text:`, err2)
      redacted = texts.map(() => REDACTION_UNAVAILABLE)
    }
  }
  idx.forEach((position, k) => { out[position] = redacted[k] ?? REDACTION_UNAVAILABLE })
  return out
}

// ── P1.2 — Structured playbook rules (docs/28 C.2.1) ────────────────────
// `PlaybookPosition.rules` is free-form JSON; we runtime-type it via
// the shape below. Everything optional — orgs can ship must_have without
// must_not, bounds-only configs, etc.
/**
 * One severity vocabulary for the whole playbook surface.
 *
 * The structured-rules path used `low|medium|high|walkaway`; the LLM review
 * path (playbook_review_agent.py) emits `low|medium|high|critical`. Both write
 * into the same field, so an org whose rules say `critical` was silently
 * mis-ranked. `critical` is accepted here and treated as equivalent to
 * `walkaway` — both mean "a human must look at this before it goes anywhere".
 */
type PlaybookSeverity = 'low' | 'medium' | 'high' | 'critical' | 'walkaway'
type PlaybookRuleCheck = 'contains' | 'regex' | 'present' | 'absent'

interface PlaybookRule {
  id?:          string
  description:  string
  check:        PlaybookRuleCheck
  value:        string     // substring / regex source / marker token
  severity:     PlaybookSeverity
}

interface PlaybookBound {
  min?:         number
  max?:         number
  units?:       string
  severity:     PlaybookSeverity
  description?: string
}

interface PlaybookRules {
  must_have?:   PlaybookRule[]
  must_not?:    PlaybookRule[]
  bounds?:      Record<string, PlaybookBound>
  variables?:   Array<{ key: string; type: string; required?: boolean; default?: unknown }>
}

// Ascending. `critical` and `walkaway` are peers — different words for the same
// stop condition, arriving from the LLM path and the rules path respectively.
const SEVERITY_ORDER: PlaybookSeverity[] = ['low', 'medium', 'high', 'critical', 'walkaway']

/**
 * Rank a severity, tolerating values written by hand into a rules JSON.
 *
 * `SEVERITY_ORDER.indexOf(x)` returns -1 for anything unrecognised, and -1 is
 * LOWER than every real rank — so an unknown severity lost to the next `low`
 * that came along. That is how a `critical` violation ended up reported as
 * `low`. Unknown values now rank at the TOP: if we cannot interpret how
 * serious something is, the safe reading is "serious".
 */
function severityRank(sev: string | undefined | null): number {
  if (!sev) return -1
  const i = SEVERITY_ORDER.indexOf(sev as PlaybookSeverity)
  return i === -1 ? SEVERITY_ORDER.length : i
}

/**
 * Walk a rules object against a clause's text. Returns one entry per
 * evaluated rule with `{passed, ...}`. "Bounds" checks compile to
 * "no strong assertion" today (P1.3 will pair them with an LLM judge);
 * they appear in the output so the agent LLM can reason over them.
 */
function evaluatePlaybookRules(
  rules:        PlaybookRules,
  clauseText:   string,
  positionType: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const text = clauseText.toLowerCase()

  for (const r of rules.must_have ?? []) {
    const passed = ruleMatches(r, text)
    out.push({
      kind: 'must_have', position: positionType,
      ruleId: r.id, description: r.description, severity: r.severity,
      check: r.check, value: r.value,
      // "passed" for a must_have rule means the match hit.
      passed,
    })
  }
  for (const r of rules.must_not ?? []) {
    const hit = ruleMatches(r, text)
    out.push({
      kind: 'must_not', position: positionType,
      ruleId: r.id, description: r.description, severity: r.severity,
      check: r.check, value: r.value,
      // For must_not we flip: "passed" means the text does NOT contain it.
      passed: !hit,
    })
  }
  for (const [key, b] of Object.entries(rules.bounds ?? {})) {
    out.push({
      kind: 'bound', position: positionType,
      boundKey: key, description: b.description, severity: b.severity,
      min: b.min, max: b.max, units: b.units,
      // Leave `passed` null — bounds need numeric extraction which we
      // defer to P1.3 (two-stage compare). The agent LLM can still see
      // the bound and reason over the clause text.
      passed: null,
    })
  }
  return out
}

function ruleMatches(rule: PlaybookRule, lowerText: string): boolean {
  switch (rule.check) {
    case 'contains': return lowerText.includes(rule.value.toLowerCase())
    case 'regex':
      try { return new RegExp(rule.value, 'i').test(lowerText) }
      catch { return false }
    case 'present':  return lowerText.includes(rule.value.toLowerCase())
    case 'absent':   return !lowerText.includes(rule.value.toLowerCase())
    default:         return false
  }
}

function pickWorstSeverity(
  violations: Array<Record<string, unknown>>,
): PlaybookSeverity | null {
  let worst: PlaybookSeverity | null = null
  for (const v of violations) {
    if (v.passed === true || v.passed === null) continue // no violation
    const sev = v.severity as PlaybookSeverity | undefined
    if (!sev) continue
    if (!worst || severityRank(sev) > severityRank(worst)) {
      worst = sev
    }
  }
  return worst
}

function ruleCountOf(rules: PlaybookRules | null): number {
  if (!rules) return 0
  return (rules.must_have?.length ?? 0)
       + (rules.must_not?.length  ?? 0)
       + Object.keys(rules.bounds ?? {}).length
}

const ResolveSchema = z.object({
  orgId: z.string().min(1),
  tier:  z.enum(TIERS as [Tier, ...Tier[]]),
})

// D.1.4a/b — shape of agent tool inputs. orgId is enforced at this boundary
// so any tool call from Python is scoped to a single tenant.
const ContractGetSchema = z.object({
  orgId:      z.string().min(1),
  contractId: z.string().min(1),
  // How much of the plaintext to return. LLM context is precious — the
  // default keeps us well under a default tier's context window even for
  // long contracts, while letting callers opt into more on demand.
  maxChars:   z.number().int().min(100).max(200_000).default(12_000),
})

const ContractSearchSchema = z.object({
  orgId:            z.string().min(1),
  query:            z.string().optional(),           // text search in title/counterparty
  status:           z.string().optional(),
  type:             z.string().optional(),
  counterpartyName: z.string().optional(),
  limit:            z.number().int().min(1).max(50).default(10),
  // P3 fix (2026-04-29): the agent used to mentally sort 50 results when
  // asked "top 3 by value" — and hallucinate counterparties / values that
  // weren't in the slice. Giving the tool a real sort eliminates that
  // failure mode: the LLM just reads the first N rows the DB returned.
  sortBy:    z.enum(['updatedAt', 'value', 'effectiveDate', 'expiryDate', 'createdAt', 'riskScore']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
})

const ContractSummarizeSchema = z.object({
  orgId:      z.string().min(1),
  contractId: z.string().min(1),
})

// D.5.1 — playbook_check read tool. Returns the contract's clauses
// alongside the matching org playbook positions (if any), so the main
// agent LLM can reason about deviations with full context in one turn.
//
// We deliberately don't call /compare (the LLM judge) inside this tool
// — that would add N extra LLM round-trips per contract check. The
// agent already has a capable LLM in hand and can do the comparison
// itself from the structured output. Later in D.5.9 we can opt-in to
// judge-mode for very long contracts.
const PlaybookCheckSchema = z.object({
  orgId:      z.string().min(1),
  contractId: z.string().min(1),
  // How many clauses to examine. The default stays small because an agent
  // turn can't absorb more, but the ceiling has to admit a whole contract:
  // this endpoint is the input to full-document redlining, and a hard 400 at
  // 30 meant a 43-clause agreement could not be checked at all. When the cap
  // does bite, `summary.truncated` says so rather than the caller having to
  // infer it.
  maxClauses: z.number().int().min(1).max(500).default(10),
  // P1.3 — opt into the LLM judge pass. When true, we call the Python
  // /playbook_judge endpoint for every check that has structured rules
  // + bounds, and merge the judge's verdict back in (filling extracted
  // bound values, overwriting passed for rules the keyword matcher got
  // wrong, etc.). Off by default because it adds an LLM round-trip per
  // clause — the agent caller should only set it when they specifically
  // want the deeper judgment.
  judge:      z.boolean().default(false),
})

// P3.1 — contract_cite. Returns passages that match the query, each
// anchored to a {page, bbox, sectionRef} triple pulled from the
// version's structure tree (P2.4 legwork). Powers clickable "§9.2 · p.2"
// pills in the rail — click → the contract opens at that section.
const ContractCiteSchema = z.object({
  orgId:      z.string().min(1),
  contractId: z.string().min(1),
  query:      z.string().min(1),
  limit:      z.number().int().min(1).max(10).default(5),
})

// P5.1 — obligations_list. Lists obligations (from
// Contract.metadata.obligations) for a specific contract OR across
// the org. Populated by /contracts/:id/extract-obligations (manual
// trigger) or automatically after post-signature status changes.
const ObligationsListSchema = z.object({
  orgId:       z.string().min(1),
  contractId:  z.string().optional(),
  dueWithin:   z.number().int().min(1).max(365).optional(),
  type:        z.string().optional(),
  limit:       z.number().int().min(1).max(100).default(30),
})

// P5.3 — renewal_advice tool. Reads cached Contract.metadata.renewalAdvice
// OR (when contractId is omitted) aggregates every contract expiring
// within `leadDays` days into a portfolio view the agent can summarise
// ("3 contracts come up for renewal this quarter; 2 recommend renew,
// 1 recommends renegotiate"). Read-only; the actual LLM run is the
// authenticated POST /contracts/:id/renewal-advice endpoint.
const RenewalAdviceSchema = z.object({
  orgId:       z.string().min(1),
  contractId:  z.string().optional(),
  leadDays:    z.number().int().min(1).max(365).default(90),
  limit:       z.number().int().min(1).max(50).default(20),
})

// P4.4 — org_memory. Unified "what's our institutional position on X?"
// retrieval across three org-owned sources:
//   • Playbook positions      (preferred/acceptable/fallback/walkaway)
//   • Clause library items    (approved drafting snippets)
//   • Past-deal excerpts      (from counterparty_memory for contracts
//                              where this clause type was signed)
// Returns a single structured bundle the agent can answer "we typically
// ask for 12 months of fees, we've accepted 24 months for strategic
// accounts" from a single tool call.
const OrgMemorySchema = z.object({
  orgId:        z.string().min(1),
  topic:        z.string().min(1).max(200),
  clauseType:   z.string().optional(),
  contractType: z.string().optional(),
  limit:        z.number().int().min(1).max(20).default(8),
})

// P4.5 — thin wrappers for four REST endpoints the agent needs
// read-only access to: approvals, counterparties, requests, custom
// field definitions. Each follows the same pattern: validate with Zod,
// filter by orgId, return the shape the LLM wants.
const ApprovalListSchema = z.object({
  orgId:   z.string().min(1),
  userId:  z.string().min(1),
  status:  z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'ESCALATED']).optional(),
  // When set to 'my-queue', only pending steps assigned to userId.
  scope:   z.enum(['my-queue', 'all']).default('my-queue'),
  limit:   z.number().int().min(1).max(100).default(20),
})

const CounterpartyGetSchema = z.object({
  orgId:   z.string().min(1),
  // EITHER an id OR a name (fuzzy). Caller picks what they have.
  id:      z.string().optional(),
  name:    z.string().optional(),
})

// P3 audit (2026-04-29): the agent had no way to answer
// "name 5 of my counterparties" without mining contract_search and
// dedupe-ing — which capped at the first ~50 contracts. counterparty_list
// returns the org's counterparties directly, optionally ranked by
// contract count or by total contract value.
const CounterpartyListSchema = z.object({
  orgId:     z.string().min(1),
  query:     z.string().optional(),
  // Rank counterparties by:
  //   'contracts'  — number of contracts (most prolific first)
  //   'value'      — sum of contract values (biggest accounts first)
  //   'name'       — alphabetical
  //   'recent'     — most-recently-touched
  sortBy:    z.enum(['contracts', 'value', 'name', 'recent']).default('contracts'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  limit:     z.number().int().min(1).max(50).default(20),
})

const RequestListSchema = z.object({
  orgId:       z.string().min(1),
  status:      z.string().optional(),
  assignedToId: z.string().optional(),
  priority:    z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  type:        z.string().optional(),
  limit:       z.number().int().min(1).max(100).default(20),
})

const CustomFieldListSchema = z.object({
  orgId:        z.string().min(1),
  contractType: z.string().optional(),
})

// Persona-test fix #1 — matter_list. The agent had no way to answer
// "what matters do I own?" / "what's open right now?" so it'd fall back
// to obligations_list or request_list and return wrong-domain results.
// Matters are how legal teams group related contracts (M&A, hub renewals,
// pilot programs); making them queryable is table-stakes for our personas.
const MatterListSchema = z.object({
  orgId:            z.string().min(1),
  ownerId:          z.string().optional(),  // filter to matters owned by this user
  status:           z.enum(['OPEN', 'CLOSED', 'ARCHIVED']).optional(),
  counterpartyName: z.string().optional(),  // fuzzy substring on counterpartyName
  query:            z.string().optional(),  // free-text on matter name + description
  limit:            z.number().int().min(1).max(100).default(25),
})

// Draft-flow fix — agent had no usable tool to create a contract draft
// from a free-text user request. The existing contract_create_from_template
// handler (line ~2525) requires a templateId + variables; the agent
// doesn't know which template id to use. This new handler wraps the
// /draft pipeline (Python run_draft → template selection from message)
// and persists a Contract + ContractVersion in DRAFT status, returning
// the artifact-shaped payload the AgentHomePage Doc artifact expects.
const ContractDraftFromIntentSchema = z.object({
  orgId:            z.string().min(1),
  userId:           z.string().min(1),
  // Free-form description of what to draft. The Python pipeline parses
  // this for type + counterparty + intent.
  userMessage:      z.string().min(1).max(2000),
  // Optional structured hints — passed through as `context`. The Python
  // pipeline uses these as defaults when the message is ambiguous.
  contractType:     z.string().optional(),   // 'NDA' | 'MSA' | 'SOW' | 'VENDOR_AGREEMENT' | …
  counterpartyName: z.string().optional(),
  // Title for the new Contract row. If omitted, derived from message + cp.
  title:            z.string().optional(),
})

// P3.4 — contract_validate. Fast lexical + structural checks the
// drafter/reviewer shouldn't have to eyeball. Three passes:
//   • Defined-term drift — "Company" in §1 vs "the company" / "Customer"
//     later. We extract defined terms from hereinafter-style phrasing
//     + quoted role nouns, then flag inconsistent casing / alternates.
//   • Unresolved cross-refs — "Section ___" / "§ ___" / "Exhibit ___"
//     where the blank never got filled.
//   • Dangling section references — "see Section 12.3" when the
//     structure tree has no §12.3.
// Each issue carries {kind, severity, message, excerpt, page?, ref?}.
const ContractValidateSchema = z.object({
  orgId:      z.string().min(1),
  contractId: z.string().min(1),
  maxIssues:  z.number().int().min(1).max(200).default(50),
})

// P3.3 — counterparty_memory. Surface prior-deal intelligence for a
// specific counterparty. For every contract the org has signed with
// them (or currently negotiating), aggregate:
//   • dealCount, totalValue, signedSince, lastSignedAt
//   • severity distribution of the counterparty's clauses (favorable
//     / neutral / unfavorable / unusual) based on the AI risk scoring
//   • per-deal excerpts of a specific clauseType if asked
//
// Answers "what's this counterparty's pattern?" questions natively
// instead of sending the agent on an O(N) contract_get hunt.
const CounterpartyMemorySchema = z.object({
  orgId:             z.string().min(1),
  counterpartyName:  z.string().min(1),
  clauseType:        z.string().optional(), // e.g. 'limitation_of_liability'
  limit:             z.number().int().min(1).max(30).default(10),
})

// P3.2 — portfolio_search. RRF fusion (BM25 on contract metadata +
// pgvector on clause embeddings) over the whole org's contract
// portfolio. Returns hits at CLAUSE granularity so the agent can say
// "Acme MSA §9.2 caps at $500k" not just "Acme MSA looks relevant".
// Unlike contract_search which matches title/counterparty, this reads
// the actual clause bodies — required for "which MSAs have uncapped
// liability?" class of question.
const PortfolioSearchSchema = z.object({
  orgId:            z.string().min(1),
  query:            z.string().min(1).max(500),
  topK:             z.number().int().min(1).max(30).default(10),
  // Optional filters — pass through to ES. Keeps portfolio_search
  // useful for scoped queries ("uncapped liability in MSAs signed 2025").
  contractType:     z.string().optional(),
  status:           z.string().optional(),
  counterpartyName: z.string().optional(),
})

const ClauseSearchSchema = z.object({
  orgId:      z.string().min(1),
  contractId: z.string().min(1),
  query:      z.string().min(1),
  limit:      z.number().int().min(1).max(20).default(5),
  // How many chars of context to return around each match.
  windowChars: z.number().int().min(50).max(2_000).default(400),
})

// D.3.2 — first write tool. Input surface is deliberately narrow so the
// agent can't accidentally post a comment with a wrong anchor. The Apply
// RPC in agent-threads.ts validates this same shape.
const CommentAddSchema = z.object({
  orgId:      z.string().min(1),
  contractId: z.string().min(1),
  authorId:   z.string().min(1),
  versionId:  z.string().optional(),
  clauseRef:  z.string().max(120).optional(),
  body:       z.string().min(1).max(5_000),
  parentId:   z.string().optional(),
})

// D.3.3 — second write tool. Requests are net-new work items; the agent
// might create one after the user says "send this to legal for review".
const RequestCreateSchema = z.object({
  orgId:            z.string().min(1),
  requestedById:    z.string().min(1),
  title:            z.string().min(1).max(200),
  type:             z.string().min(1), // ContractType enum — validated via Prisma
  counterpartyName: z.string().max(200).optional(),
  description:      z.string().min(1).max(5_000),
  estimatedValue:   z.number().nonnegative().optional(),
  priority:         z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
})

// P1.5 — redline_apply. Takes the chosen variant's proposedText and
// lands it as a new ContractVersion (n+1), swapping the target clause's
// content. Reversible via currentVersionId flip-back.
//
// OOXML-native tracked changes (real <w:ins>/<w:del> in .docx) are a
// standalone ~2d follow-up — the docs/30 roadmap estimate's separate.
// We persist the structured `changes[]` in ContractVersion.metadata so
// that future OOXML serializer reads them without re-running the LLM.
const RedlineApplySchema = z.object({
  orgId:        z.string().min(1),
  userId:       z.string().min(1),
  contractId:   z.string().min(1),
  clauseId:     z.string().min(1),
  proposedText: z.string().min(1).max(20_000),
  aggression:   z.enum(['least', 'moderate', 'aggressive']).optional(),
  rationale:    z.string().max(2_000).optional(),
  changes:      z.array(z.object({
    before: z.string().max(5_000),
    after:  z.string().max(5_000),
    reason: z.string().max(500).optional(),
  })).max(40).optional(),
  // Zod strips unknown keys, so this has to be declared or the flag silently
  // never reaches applyClauseProposal and the route always refuses.
  allowAppendFallback: z.boolean().optional(),
})

// P1.4 — redline_propose. Read-only: generates THREE variant rewrites
// (least / moderate / aggressive) for a specific clause in one call.
// Grounded in the contract's clause + matching playbook position +
// rules. The agent shows all three variants; the user picks one + fires
// redline_apply (P1.5) to turn it into a new ContractVersion.
// Phase 1 — batch rewrite for whole-document redlining. One aggression for the
// document rather than three variants per clause: the pipeline keeps one
// rewrite, so asking for three triples the cost of output it discards.
const RedlineProposeBatchSchema = z.object({
  orgId:        z.string().min(1),
  contractId:   z.string().min(1),
  clauseIds:    z.array(z.string().min(1)).min(1).max(200),
  aggression:   z.enum(['least', 'moderate', 'aggressive']).default('moderate'),
  instructions: z.string().max(2_000).optional(),
})

const RedlineProposeSchema = z.object({
  orgId:       z.string().min(1),
  contractId:  z.string().min(1),
  // Target a clause. One of clauseId | clauseType must be provided.
  clauseId:    z.string().optional(),
  clauseType:  z.string().optional(),
  // Free-text direction from the user ("make the cap 6 months"), passed
  // through to the LLM alongside the playbook rules.
  instructions: z.string().max(2_000).optional(),
})

// P1.1 — contract_create_from_template. Fires the existing template
// engine to produce HTML, then persists a new Contract + ContractVersion
// as a DRAFT. Reversible via soft-delete. This is the tool that makes
// @draft-from-template go from "describe the draft" to "land a draft".
const ContractCreateFromTemplateSchema = z.object({
  orgId:            z.string().min(1),
  userId:           z.string().min(1),   // ownerId / createdById
  templateId:       z.string().min(1),
  // Agent-supplied fill. Anything missing from the template's variable
  // list surfaces as `unfilledVariables` in the output so the rail can
  // tell the user "add these five fields before signature".
  variables:        z.record(z.unknown()).default({}),
  title:            z.string().max(200).optional(),
  counterpartyName: z.string().max(200).optional(),
})

// D.5.6 — approval_route write tool input. Inline workflow-driven path;
// escalation queue + AI summary queue are skipped for the agent-driven
// route (those depend on BullMQ workers that the internal-ai router
// doesn't import — those side-effects can be added in a follow-up
// without changing this tool's UI surface).
const ApprovalRouteSchema = z.object({
  orgId:      z.string().min(1),
  userId:     z.string().min(1),  // submitter — from JWT
  contractId: z.string().min(1),
  // Optional: explicit workflow. If absent, pick the first active
  // workflow whose triggerRules.contractTypes matches.
  workflowDefinitionId: z.string().optional(),
  comment:    z.string().max(2_000).optional(),
})

// D.5.5 — third write tool. Workflow-shaped: a single action enum covers
// the most common operational mutations on a contract so the agent
// doesn't have to learn a menu of PATCH shapes. Reversibility is decided
// per action — status/owner/tag changes restore; retype + re_analyze
// kick off side-effecting pipelines and are NOT reversible via the
// 15-minute undo window (would require unrolling an async job graph).
const ContractUpdateSchema = z.object({
  orgId:      z.string().min(1),
  userId:     z.string().min(1),  // auditor / actor — injected from JWT
  contractId: z.string().min(1),
  action: z.enum([
    'set_status',
    'assign_owner',
    'add_tag',
    'remove_tag',
    'retype',
    're_analyze',
  ]),
  // Per-action payload. Validated again after the action is known.
  payload: z.record(z.unknown()).default({}),
})

export async function internalAiRoutes(app: FastifyInstance) {
  // ── x-internal-secret guard for every route in this plugin ─────────────────
  app.addHook('preHandler', async (req, reply) => {
    const secret = req.headers['x-internal-secret']
    if (!secret || secret !== process.env.INTERNAL_SERVICE_SECRET) {
      return reply.status(401).send({ detail: 'Internal endpoint — bad secret' })
    }
  })

  // ── POST /internal/ai/resolve ──────────────────────────────────────────────
  // Body:  { orgId: string, tier: Tier }
  // Returns: { provider, model, apiKey, source: 'platform'|'byok', tier }
  // Errors: 400 invalid input, 503 NoProviderAvailable
  app.post('/resolve', async (req, reply) => {
    let body
    try {
      body = ResolveSchema.parse(req.body)
    } catch (err) {
      return reply.status(400).send({
        detail: 'Invalid request',
        issues: (err as { issues?: unknown }).issues ?? String(err),
      })
    }
    try {
      const resolved = await resolveLlm(body.orgId, body.tier)
      return reply.send(resolved)
    } catch (err) {
      if (err instanceof NoProviderAvailable) {
        return reply.status(503).send({
          detail: err.message,
          tier: err.tier,
          attempted: err.attempted,
        })
      }
      app.log.error({ err }, 'aiRouter resolve failed')
      return reply.status(500).send({ detail: 'Internal error' })
    }
  })

  // ── POST /internal/ai/tools/contract_get (D.1.4a) ──────────────────────────
  // The Python agents service calls this when the model invokes the
  // `contract_get` tool. Every tool endpoint takes an explicit orgId so we
  // can enforce tenant scoping at this boundary rather than trusting what
  // the LLM eventually outputs as arguments.
  //
  // Returns a compact snapshot — title, counterparty, status, risk, key
  // terms, plus the latest version's plaintext truncated to maxChars so
  // the model's context window doesn't blow up on a 400-page MSA.
  app.post('/tools/contract_get', async (req, reply) => {
    let body
    try { body = ContractGetSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, jurisdiction: true,
        value: true, currency: true,
        effectiveDate: true, expiryDate: true,
        summary: true, keyTerms: true, riskScore: true, riskFactors: true,
        currentVersionId: true, updatedAt: true,
      },
    })
    if (!contract) {
      return reply.status(404).send({ detail: 'Contract not found in this org' })
    }

    // Grab the current (or latest) version's plaintext. Truncate aggressively.
    const version = contract.currentVersionId
      ? await prisma.contractVersion.findUnique({
          where: { id: contract.currentVersionId },
          select: { versionNumber: true, plainText: true, createdAt: true },
        })
      : await prisma.contractVersion.findFirst({
          where: { contractId: contract.id },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true, plainText: true, createdAt: true },
        })

    const fullText      = version?.plainText ?? ''
    const truncated     = fullText.length > body.maxChars
    const truncatedText = truncated ? fullText.slice(0, body.maxChars) : fullText

    // P21 production audit (2026-04-29). Apply PII redaction at the
    // boundary BEFORE the agents service ships the text to OpenAI /
    // Anthropic. Default org policy is 'redact' (set 2026-04-29);
    // orgs that need raw text for extraction quality can opt out via
    // settings.piiRedactionMode = 'off'. The redactor catches SSN,
    // ITIN, CC, passport, IBAN, phone, email, DOB, IP, API key.
    // Summary string also goes through (LLMs cite the summary too).
    const [redactedPlainText, redactedSummary] = await Promise.all([
      applyPiiPolicy(body.orgId, truncatedText, { surface: 'contract_get.plainText', contractId: contract.id }),
      contract.summary
        ? applyPiiPolicy(body.orgId, contract.summary, { surface: 'contract_get.summary', contractId: contract.id })
        : Promise.resolve({ text: '', mode: 'off', counts: {}, total: 0 } as const),
    ])

    return reply.send({
      id:               contract.id,
      title:            contract.title,
      type:             contract.type,
      status:           contract.status,
      counterpartyName: contract.counterpartyName,
      jurisdiction:     contract.jurisdiction,
      value:            contract.value != null ? Number(contract.value) : null,
      currency:         contract.currency,
      effectiveDate:    contract.effectiveDate,
      expiryDate:       contract.expiryDate,
      summary:          contract.summary ? redactedSummary.text : null,
      keyTerms:         contract.keyTerms,
      riskScore:        contract.riskScore,
      riskFactors:      contract.riskFactors,
      version: {
        number:    version?.versionNumber ?? null,
        createdAt: version?.createdAt ?? null,
      },
      plainText:        redactedPlainText.text,
      plainTextLength:  fullText.length,
      truncated,
      updatedAt:        contract.updatedAt,
      // Surface mode + counts so the agent can mention "I redacted N
      // PII items" if it wants to be transparent. Optional — most
      // turns ignore this.
      _piiPolicy:       redactedPlainText.mode === 'off'
        ? null
        : { mode: redactedPlainText.mode, total: redactedPlainText.total + redactedSummary.total },
    })
  })

  // ── POST /internal/ai/tools/contract_search (D.1.4b) ───────────────────────
  // Natural-language + structured-filter list search over the org's contracts.
  // Returns minimal cards (title, type, status, counterparty, risk, dates) —
  // the agent typically follows up with contract_get for a specific id.
  app.post('/tools/contract_search', async (req, reply) => {
    let body
    try { body = ContractSearchSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const where: Record<string, unknown> = { orgId: body.orgId, deletedAt: null }
    if (body.status)           where.status           = body.status
    if (body.type)             where.type             = body.type
    if (body.counterpartyName) where.counterpartyName = { contains: body.counterpartyName, mode: 'insensitive' }

    // Text query: hit title + counterpartyName. Full-text via Elasticsearch
    // is out of scope for D.1.4b — the ES integration layer already exists
    // for /search but the agent-tool path stays on Postgres ILIKE until
    // D5 when we add contract_rag.
    //
    // Defensive: some LLMs (notably gpt-4o) pass "*" or "%" thinking it's a
    // SQL/glob wildcard. Treat those + empty string as match-all so the agent
    // doesn't get a false-empty result and tell the user "no contracts exist."
    // This was a real bug — see commit history for "Assistant vs Ask".
    const rawQuery = body.query?.trim() ?? ''
    const isWildcard = ['*', '%', '.*', '.+', 'all', 'any', '*.*'].includes(rawQuery.toLowerCase())
    if (rawQuery && !isWildcard) {
      (where as any).OR = [
        { title:            { contains: rawQuery, mode: 'insensitive' } },
        { counterpartyName: { contains: rawQuery, mode: 'insensitive' } },
        { summary:          { contains: rawQuery, mode: 'insensitive' } },
      ]
    }

    // Build the sort clause. For `value` and `riskScore`, we need to
    // tolerate NULLs — Postgres puts NULLs first by default on ASC and
    // last on DESC, which matches what the LLM expects ("top 3 by value
    // descending" should NOT lead with rows that have null value).
    const orderBy: Record<string, 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls: 'first' | 'last' }> = {}
    if (body.sortBy === 'value' || body.sortBy === 'riskScore') {
      orderBy[body.sortBy] = { sort: body.sortOrder, nulls: 'last' }
    } else {
      orderBy[body.sortBy] = body.sortOrder
    }

    // P63 audit (2026-05-02). Run findMany + count in parallel so
    // we can return BOTH the page (`results`) and the true total
    // (`totalMatching`). The agent was treating `total === results.length`
    // as the org's contract count, which made "how many MSAs do I
    // have" answers wrong (50 = page size ≠ 154 = real total).
    const [contracts, totalMatching] = await Promise.all([
      prisma.contract.findMany({
        where: where as never,
        select: {
          id: true, title: true, type: true, status: true,
          counterpartyName: true, riskScore: true,
          effectiveDate: true, expiryDate: true,
          value: true, currency: true, updatedAt: true,
        },
        orderBy: orderBy as never,
        take: body.limit,
      }),
      prisma.contract.count({ where: where as never }),
    ])

    // A1 — semantic fallback. If a query was provided AND keyword search
    // returned 0 hits, try pgvector clause-similarity to surface contracts
    // whose CONTENT matches the query even though title/counterparty/summary
    // don't. The agent's UX expectation: "I asked about steel suppliers and
    // it found nothing" → "I asked about steel suppliers and it found 4."
    // Without this, the agent falsely tells the user "no matches" when
    // semantically-related contracts exist.
    let usedFallback = false
    let fallbackResults: typeof contracts = []
    if (contracts.length === 0 && rawQuery && !isWildcard) {
      try {
        const clauseHits = await searchClauses(rawQuery, body.orgId, body.limit * 4)
        const seen = new Set<string>()
        const orderedIds: string[] = []
        for (const hit of clauseHits) {
          if (!seen.has(hit.contractId)) {
            seen.add(hit.contractId)
            orderedIds.push(hit.contractId)
            if (orderedIds.length >= body.limit) break
          }
        }
        if (orderedIds.length > 0) {
          // Re-apply structural filters (status / type / counterpartyName) to
          // the semantic hits. Otherwise we'd ignore the agent's filters.
          const semanticWhere: Record<string, unknown> = {
            orgId:     body.orgId,
            deletedAt: null,
            id:        { in: orderedIds },
          }
          if (body.status)           semanticWhere.status           = body.status
          if (body.type)             semanticWhere.type             = body.type
          if (body.counterpartyName) semanticWhere.counterpartyName = { contains: body.counterpartyName, mode: 'insensitive' }
          const fallbackHits = await prisma.contract.findMany({
            where: semanticWhere as never,
            select: {
              id: true, title: true, type: true, status: true,
              counterpartyName: true, riskScore: true,
              effectiveDate: true, expiryDate: true,
              value: true, currency: true, updatedAt: true,
            },
          })
          // Preserve semantic-rank order
          const byId = new Map(fallbackHits.map(c => [c.id, c]))
          fallbackResults = orderedIds.map(id => byId.get(id)).filter(Boolean) as typeof contracts
          usedFallback = fallbackResults.length > 0
        }
      } catch (err) {
        // Fallback is best-effort; log and proceed without it.
        req.log.warn({ err, query: rawQuery }, '[contract_search] semantic fallback failed')
      }
    }
    const finalResults = usedFallback ? fallbackResults : contracts

    return reply.send({
      // P63 — keep `total` as the page size for back-compat, but
      // surface `totalMatching` (real DB count satisfying `where`) and
      // a clear `pageSize`. The agent's prompt now tells it to read
      // `totalMatching` for "how many" questions, not `total`/results
      // length — see app/orchestrator.py.
      total:         finalResults.length,
      pageSize:      finalResults.length,
      totalMatching: usedFallback ? fallbackResults.length : totalMatching,
      results: finalResults.map(c => ({
        ...c,
        value: c.value != null ? Number(c.value) : null,
      })),
      // Surface the fallback to the agent so it can mention "I broadened the
      // search" in its prose synthesis if it wants to be transparent.
      ...(usedFallback ? { searchMode: 'semantic-fallback', note: 'No keyword matches; expanded to clause-content semantic search.' } : {}),
    })
  })

  // ── POST /internal/ai/tools/contract_cite (P3.1) ───────────────────────────
  // Find passages matching a query and annotate each with a PDF anchor
  // (page + bbox + sectionRef) pulled from the version's structure
  // tree. Distinct from clause_search because the contract caller
  // wants to CITE — i.e. show the user exactly where in the PDF the
  // claim came from.
  //
  // Return shape: { contractId, citations: [{ quote, page, bbox,
  //                                          sectionRef, sectionTitle }] }
  app.post('/tools/contract_cite', async (req, reply) => {
    let body
    try { body = ContractCiteSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: { id: true, title: true, type: true, currentVersionId: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found in this org' })

    const versionId = contract.currentVersionId ?? (await prisma.contractVersion.findFirst({
      where: { contractId: contract.id },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    }))?.id
    if (!versionId) {
      return reply.send({ contractId: contract.id, title: contract.title, citations: [] })
    }
    const version = await prisma.contractVersion.findUnique({
      where: { id: versionId },
      select: { plainText: true, metadata: true },
    })
    const plainText = version?.plainText ?? ''
    if (!plainText) {
      return reply.send({ contractId: contract.id, title: contract.title, citations: [] })
    }

    const md = (version?.metadata ?? {}) as Record<string, unknown>
    const structure = (md.structure ?? {}) as {
      sections?: Array<{ ref: string; title: string; level: number; page?: number; bbox?: number[]; paragraphs?: Array<{ text: string; page?: number; bbox?: number[] }>; children?: unknown[] }>
    }

    // Flatten every section + its paragraphs into a [{text, page, bbox,
    // ref, title}] pool we can substring-match against.
    type Node = { text: string; page: number | null; bbox: number[] | null; ref: string; title: string }
    const pool: Node[] = []
    function walk(nodes: Array<{ ref: string; title: string; level: number; page?: number; bbox?: number[]; paragraphs?: Array<{ text: string; page?: number; bbox?: number[] }>; children?: unknown[] }> | undefined) {
      if (!nodes) return
      for (const s of nodes) {
        pool.push({
          text: `${s.ref ? s.ref + ' ' : ''}${s.title}`,
          page: s.page ?? null,
          bbox: s.bbox ?? null,
          ref: s.ref,
          title: s.title,
        })
        for (const p of s.paragraphs ?? []) {
          pool.push({
            text: p.text,
            page: p.page ?? s.page ?? null,
            bbox: p.bbox ?? s.bbox ?? null,
            ref: s.ref,
            title: s.title,
          })
        }
        walk(s.children as never)
      }
    }
    walk(structure.sections)

    // Rank pool by overlap with the query. Token-set overlap — fast,
    // deterministic, no embedding call. Real RAG ranking lives in P3.2.
    const q = body.query.toLowerCase()
    const qTokens = new Set(q.split(/\s+/).filter(t => t.length > 2))
    const scored = pool.map(n => {
      const text = n.text.toLowerCase()
      // Direct substring bonus — highest signal for a verifiable quote.
      const substrHit = text.includes(q) ? 1 : 0
      // Token overlap as the base score.
      const tokens = text.split(/\s+/).filter(t => t.length > 2)
      const matched = [...qTokens].filter(t => text.includes(t)).length
      const overlap = qTokens.size ? matched / qTokens.size : 0
      return { n, score: substrHit * 1 + overlap * 0.5, substrHit }
    })
    scored.sort((a, b) => b.score - a.score)

    // Keep only non-trivial matches; skip duplicates by (ref, title).
    const seen = new Set<string>()
    const citations: Array<Record<string, unknown>> = []
    for (const s of scored) {
      if (s.score < 0.1) break
      const key = `${s.n.ref}::${s.n.title}`
      if (seen.has(key)) continue
      seen.add(key)
      // Trim the text to 400 chars so the UI pill has something
      // scannable without blowing the message payload.
      const snippet = s.n.text.length > 400 ? s.n.text.slice(0, 397) + '...' : s.n.text
      citations.push({
        quote:        snippet,
        page:         s.n.page,
        bbox:         s.n.bbox,
        sectionRef:   s.n.ref || null,
        sectionTitle: s.n.title,
        score:        Number(s.score.toFixed(3)),
        exact:        s.substrHit === 1,
      })
      if (citations.length >= body.limit) break
    }

    // P7.5.1 — the quotes are verbatim document text headed for the LLM, so
    // redact them. One batch call for the whole citation list: a 20-citation
    // answer is one user action and gets one audit row. Ordering and every
    // other field (page, bbox, sectionRef, sectionTitle, score, exact) are
    // structural anchors the citation UI depends on and stay untouched.
    const redactedQuotes = await redactExcerpts(
      body.orgId,
      citations.map(c => (typeof c.quote === 'string' ? c.quote : null)),
      { surface: 'contract_cite.quote', contractId: contract.id },
    )
    citations.forEach((c, i) => {
      const q = redactedQuotes[i]
      if (typeof q === 'string') c.quote = q
    })

    return reply.send({
      contractId: contract.id,
      title:      contract.title,
      type:       contract.type,
      query:      body.query,
      citations,
      warning:    pool.length === 0
        ? 'Contract has no structured section metadata — re-upload to anchor citations.'
        : undefined,
    })
  })

  // ── POST /internal/ai/tools/contract_validate (P3.4) ───────────────────────
  // Lightweight validators that catch the dumb-but-embarrassing errors
  // that survive human review. No LLM calls — these are regex +
  // structure-tree lookups that run in ~50ms on a typical contract.
  app.post('/tools/contract_validate', async (req, reply) => {
    let body
    try { body = ContractValidateSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: { id: true, title: true, type: true, currentVersionId: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found in this org' })

    const versionId = contract.currentVersionId ?? (await prisma.contractVersion.findFirst({
      where: { contractId: contract.id },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    }))?.id
    if (!versionId) {
      return reply.send({
        contractId: contract.id, title: contract.title,
        issues: [], totalIssues: 0,
        warning: 'No version yet — nothing to validate.',
      })
    }

    const version = await prisma.contractVersion.findUnique({
      where: { id: versionId },
      select: { plainText: true, metadata: true },
    })
    const text = version?.plainText ?? ''
    if (!text) {
      return reply.send({
        contractId: contract.id, title: contract.title,
        issues: [], totalIssues: 0,
        warning: 'No plaintext on current version — validators need extracted text.',
      })
    }

    const issues: Array<Record<string, unknown>> = []

    // ── Pass 1: extract defined terms ──────────────────────────────
    // Common contract patterns:
    //   (i)  hereinafter the "Customer" / hereinafter, "Customer"
    //   (ii) ("Customer")   — inline term quoted after a party name
    //   (iii) "the Company" — direct all-caps-or-initial-cap quoted noun
    const definedTerms = new Set<string>()
    // "hereinafter … 'X'" — any text between the keyword and the
    // first quoted word. Catches "hereinafter the \"Customer\"",
    // "hereinafter, \"Provider\"", "hereinafter referred to as \"Seller\"".
    for (const m of text.matchAll(/hereinafter[^"]{0,60}"([A-Z][A-Za-z]+)"/gi)) {
      if (m[1]) definedTerms.add(m[1])
    }
    // Inline "("Customer")" form used after party names.
    for (const m of text.matchAll(/\(\s*"([A-Z][A-Za-z]+)"\s*\)/g)) {
      if (m[1]) definedTerms.add(m[1])
    }
    // Parenthetical "(the \"Customer\")" with an optional "the".
    for (const m of text.matchAll(/\(\s*(?:the\s+)?"([A-Z][A-Za-z]+)"\s*\)/gi)) {
      if (m[1]) definedTerms.add(m[1])
    }

    // Defined-term drift — for each defined term, count occurrences
    // of the exact form and of the lower-case variant. When both
    // appear the author likely introduced inconsistency.
    for (const term of definedTerms) {
      const exact = (text.match(new RegExp(`\\b${term}\\b`, 'g')) ?? []).length
      const lower = (text.match(new RegExp(`\\b${term.toLowerCase()}\\b`, 'g')) ?? []).length
      if (exact >= 1 && lower >= 1) {
        const firstLower = text.indexOf(term.toLowerCase())
        const excerpt = text.slice(Math.max(0, firstLower - 40), firstLower + 80)
        issues.push({
          kind:     'defined_term_drift',
          severity: 'medium',
          message:  `Defined term "${term}" is used ${exact}x, but lowercase "${term.toLowerCase()}" appears ${lower}x — may be referring to the same party inconsistently.`,
          term,
          excerpt,
        })
      }
    }

    // ── Pass 2: unresolved blank cross-refs ────────────────────────
    // "see Section ___" or "Section ___" with underscores/tabs inside.
    const blankRefPatterns = [
      /Section\s+[_]{2,}/gi,
      /§\s*[_]{2,}/g,
      /Exhibit\s+[_]{2,}/gi,
      /Schedule\s+[_]{2,}/gi,
      /Article\s+[_]{2,}/gi,
    ]
    for (const pat of blankRefPatterns) {
      for (const m of text.matchAll(pat)) {
        if (issues.length >= body.maxIssues) break
        const idx = m.index ?? 0
        issues.push({
          kind:     'unresolved_crossref',
          severity: 'high',
          message:  `Placeholder reference "${m[0]}" was never filled in.`,
          excerpt:  text.slice(Math.max(0, idx - 30), idx + (m[0]?.length ?? 0) + 40),
          match:    m[0],
        })
      }
    }

    // ── Pass 3: dangling section references ────────────────────────
    // "see Section 12.3" when the structure tree has no §12.3. Needs
    // the P2.2 structure tree persisted. Skip this pass if there's
    // no structure.
    const md = (version?.metadata ?? {}) as Record<string, unknown>
    const structure = (md.structure ?? {}) as { nav?: Array<{ ref: string }> }
    const refsInDoc = new Set((structure.nav ?? []).map(n => (n.ref ?? '').trim()).filter(Boolean))

    if (refsInDoc.size > 0) {
      // "Section 9.2", "§ 9.2", "Section 12"
      const refCallouts = text.matchAll(/\b(?:Section|§)\s+(\d+(?:\.\d+)*)\b/g)
      for (const m of refCallouts) {
        if (issues.length >= body.maxIssues) break
        const ref = m[1]
        if (!ref) continue
        if (!refsInDoc.has(ref)) {
          const idx = m.index ?? 0
          issues.push({
            kind:     'dangling_section_ref',
            severity: 'medium',
            message:  `Reference to "Section ${ref}" but no such section exists in the document.`,
            excerpt:  text.slice(Math.max(0, idx - 40), idx + (m[0]?.length ?? 0) + 40),
            ref,
          })
        }
      }
    }

    // ── Severity ordering for a final summary count ────────────────
    const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0 }
    for (const i of issues) {
      const s = (i.severity as string | undefined) ?? 'low'
      bySeverity[s] = (bySeverity[s] ?? 0) + 1
    }

    // ── PII redaction at the agent boundary ────────────────────────
    // Every `excerpt` here is a raw slice of version.plainText, so all
    // three passes (defined_term_drift, unresolved_crossref,
    // dangling_section_ref) leak stored document text to the LLM.
    // Redact them in ONE batch: a single policy read and a single
    // PII_REDACTED audit row for what is one user action, rather than
    // up to maxIssues (200) rows.
    //
    // Deliberately NOT redacted: `term` / `definedTerms` (the drift
    // matcher only admits /[A-Z][A-Za-z]+/, a single alphabetic word —
    // it is a defined-term label the product reasons over, and no
    // redactor pattern can match it anyway), `match` / `ref` (regex-
    // constrained to "Section ___" placeholders and digit refs), and
    // the `message` strings, which are built purely from those fields
    // plus occurrence counts — no free document text.
    const visibleIssues = issues.slice(0, body.maxIssues)
    try {
      const excerptIdx: number[] = []
      const excerpts: string[] = []
      visibleIssues.forEach((issue, i) => {
        if (typeof issue.excerpt === 'string') {
          excerptIdx.push(i)
          excerpts.push(issue.excerpt)
        }
      })
      if (excerpts.length > 0) {
        const redacted = await applyPiiPolicyBatch(body.orgId, excerpts, {
          surface: 'contract_validate.excerpt',
          contractId: contract.id,
        })
        excerptIdx.forEach((issueIndex, k) => {
          const issue = visibleIssues[issueIndex]
          if (issue) issue.excerpt = redacted.texts[k] ?? issue.excerpt
        })
      }
    } catch (err) {
      // Redaction must never break the tool call. Fall through with a
      // loud log; the excerpts stay raw for this one response.
      console.error('[contract_validate] PII redaction failed:', err)
    }

    return reply.send({
      contractId: contract.id,
      title:      contract.title,
      type:       contract.type,
      issues:     visibleIssues,
      totalIssues: issues.length,
      bySeverity,
      definedTerms: [...definedTerms],
      structureAvailable: refsInDoc.size > 0,
    })
  })

  // ── POST /internal/ai/tools/counterparty_memory (P3.3) ─────────────────────
  // Return prior-deal intelligence for a named counterparty — deal
  // count, aggregate value, severity distribution, per-deal excerpts
  // of a specific clauseType when asked. Powers "what's our history
  // with Acme?" questions the agent should always be able to answer
  // without spelunking O(N) contracts.
  app.post('/tools/counterparty_memory', async (req, reply) => {
    let body
    try { body = CounterpartyMemorySchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    // Match on counterpartyName OR via Counterparty.name — fuzzy ILIKE.
    // An exact name is ideal; substring match covers minor variations
    // ("Acme Corp" vs "Acme Corporation"). Use icontains.
    const contracts = await prisma.contract.findMany({
      where: {
        orgId: body.orgId,
        deletedAt: null,
        OR: [
          { counterpartyName: { contains: body.counterpartyName, mode: 'insensitive' } },
          { counterparty: { name: { contains: body.counterpartyName, mode: 'insensitive' } } },
        ],
      },
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true,
        value: true, currency: true,
        effectiveDate: true, expiryDate: true,
        riskScore: true, riskFactors: true,
        summary: true,
        currentVersionId: true,
        createdAt: true, updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: body.limit,
    })

    if (contracts.length === 0) {
      return reply.send({
        counterpartyName: body.counterpartyName,
        dealCount: 0,
        deals: [],
        aggregate: { totalValue: 0, currencies: [], types: [], severityDistribution: {}, signedSince: null, lastSignedAt: null },
        warning: `No prior contracts found matching counterparty "${body.counterpartyName}".`,
      })
    }

    // Per-deal clause excerpts when clauseType is specified. One query
    // for all versions involved — not N.
    const versionIds = contracts.map(c => c.currentVersionId).filter(Boolean) as string[]
    const clauses = body.clauseType && versionIds.length > 0
      ? await prisma.contractClause.findMany({
          where: {
            versionId: { in: versionIds },
            isSubChunk: false,
            clauseType: body.clauseType,
          },
          select: {
            id: true, versionId: true, clauseType: true,
            content: true, sectionRef: true, riskRating: true,
          },
        })
      : []
    const clausesByVersion = new Map<string, typeof clauses>()
    for (const cl of clauses) {
      const arr = clausesByVersion.get(cl.versionId) ?? []
      arr.push(cl)
      clausesByVersion.set(cl.versionId, arr)
    }

    // Severity distribution across ALL clauses on these contracts —
    // not just the filtered clauseType. Gives the agent "Acme tends to
    // push unfavorable IP clauses" intuition for free.
    const allClauses = versionIds.length > 0
      ? await prisma.contractClause.findMany({
          where: { versionId: { in: versionIds }, isSubChunk: false },
          select: { riskRating: true },
        })
      : []
    const severityDistribution: Record<string, number> = {
      favorable:   0,
      neutral:     0,
      unfavorable: 0,
      unusual:     0,
      unrated:     0,
    }
    for (const cl of allClauses) {
      const key = cl.riskRating ?? 'unrated'
      severityDistribution[key] = (severityDistribution[key] ?? 0) + 1
    }

    // Per-deal shape — a card the UI can render quickly.
    const deals = contracts.map(c => {
      const versionClauses = c.currentVersionId ? (clausesByVersion.get(c.currentVersionId) ?? []) : []
      // When clauseType specified: attach the matching excerpt + risk.
      // When not: attach the top-risk clause (unfavorable > unusual > others).
      let excerpt: string | null = null
      let sectionRef: string | null = null
      let riskRating: string | null = null
      if (body.clauseType && versionClauses.length > 0) {
        const cl = versionClauses[0]
        excerpt = cl.content.slice(0, 400)
        sectionRef = cl.sectionRef
        riskRating = cl.riskRating
      }
      return {
        contractId:       c.id,
        title:            c.title,
        type:             c.type,
        status:           c.status,
        counterpartyName: c.counterpartyName,
        value:            c.value != null ? Number(c.value) : null,
        currency:         c.currency,
        effectiveDate:    c.effectiveDate,
        expiryDate:       c.expiryDate,
        riskScore:        c.riskScore,
        summary:          c.summary ? c.summary.slice(0, 280) : null,
        excerpt,
        sectionRef,
        riskRating,
        createdAt:        c.createdAt,
      }
    })

    // P7.5.1 — redact the two document-derived fields on each deal card
    // before they leave for the LLM: the clause `excerpt` (verbatim
    // contract text) and `summary` (an LLM summary OF contract text, so
    // it can carry PII straight out of the document).
    //
    // Structured metadata stays raw on purpose — counterpartyName is the
    // whole point of this tool, and title/type/status/dates/ids/riskScore
    // are product data the UI and the agent's reasoning depend on.
    //
    // One batch per field: two policy reads and two audit rows for the
    // whole call regardless of how many deals came back, versus 2N if we
    // called the single-value helper per card.
    {
      const excerptIdx: number[] = []
      const excerptTexts: string[] = []
      const summaryIdx: number[] = []
      const summaryTexts: string[] = []
      deals.forEach((d, i) => {
        if (d.excerpt) { excerptIdx.push(i); excerptTexts.push(d.excerpt) }
        if (d.summary) { summaryIdx.push(i); summaryTexts.push(d.summary) }
      })
      const [redactedExcerpts, redactedSummaries] = await Promise.all([
        redactExcerpts(body.orgId, excerptTexts, { surface: 'counterparty_memory.excerpt' }),
        redactExcerpts(body.orgId, summaryTexts, { surface: 'counterparty_memory.summary' }),
      ])
      excerptIdx.forEach((dealIndex, k) => {
        const d = deals[dealIndex]
        if (d) d.excerpt = redactedExcerpts[k] ?? d.excerpt
      })
      summaryIdx.forEach((dealIndex, k) => {
        const d = deals[dealIndex]
        if (d) d.summary = redactedSummaries[k] ?? d.summary
      })
    }

    // Aggregate signals.
    const totalValue = contracts.reduce((acc, c) => acc + (c.value != null ? Number(c.value) : 0), 0)
    const currencies = [...new Set(contracts.map(c => c.currency).filter(Boolean) as string[])]
    const types = [...new Set(contracts.map(c => c.type).filter(Boolean))]
    const signedDates = contracts
      .map(c => c.effectiveDate)
      .filter(Boolean) as Date[]
    const signedSince = signedDates.length > 0
      ? new Date(Math.min(...signedDates.map(d => d.getTime()))).toISOString()
      : null
    const lastSignedAt = signedDates.length > 0
      ? new Date(Math.max(...signedDates.map(d => d.getTime()))).toISOString()
      : null

    return reply.send({
      counterpartyName: body.counterpartyName,
      dealCount:        contracts.length,
      deals,
      aggregate: {
        totalValue,
        currencies,
        types,
        severityDistribution,
        signedSince,
        lastSignedAt,
        avgRiskScore: (() => {
          const withRisk = contracts.filter(c => c.riskScore != null)
          if (withRisk.length === 0) return null
          return withRisk.reduce((acc, c) => acc + (c.riskScore ?? 0), 0) / withRisk.length
        })(),
      },
      clauseTypeFilter: body.clauseType ?? null,
    })
  })

  // ── POST /internal/ai/tools/portfolio_search (P3.2) ────────────────────────
  // Hybrid RAG across the org's contract portfolio.
  //   • Dense — pgvector cosine similarity on clause embeddings
  //   • Lexical — Elasticsearch BM25 on contract metadata
  //   • Merged via Reciprocal Rank Fusion (k=60) so a hit that places
  //     well in either source gets credit.
  //
  // Returns clause-granularity hits with {contractId, clauseId,
  //   excerpt, page, sectionRef, fusedScore, denseRank, bm25Rank} so
  // the agent can cite specific clauses AND filter: "give me the
  // top 10 liability clauses across all MSAs signed 2025".
  app.post('/tools/portfolio_search', async (req, reply) => {
    let body
    try { body = PortfolioSearchSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    // Dense — pgvector clause similarity. Caps at 2× topK so RRF has
    // room to rerank. Wrapped in try so an embedding failure (missing
    // API key, embeddings not yet run) doesn't kill lexical results.
    type DenseHit = {
      contractId: string; versionId: string; clauseId: string
      clauseType: string; content: string; similarity: number
    }
    let dense: DenseHit[] = []
    try {
      dense = await searchClauses(body.query, body.orgId, body.topK * 2)
    } catch (err) {
      app.log.warn({ err }, '[portfolio_search] searchClauses failed, falling back to BM25 only')
    }

    // Lexical — ES advanced search on contract metadata. Result shape
    // is {hits: [{id, score, highlights}]}. We treat each contract as
    // a candidate container and later zip with any clause hits from
    // `dense` belonging to it.
    let bm25: Array<{ id?: string; score?: number | null }> = []
    try {
      const filters: Record<string, unknown> = { q: body.query }
      if (body.contractType)     filters.type            = body.contractType
      if (body.status)           filters.status          = body.status
      if (body.counterpartyName) filters.counterpartyName = body.counterpartyName
      const esRes = await advancedSearch(body.orgId, filters as never, body.topK * 2)
      bm25 = esRes.hits
    } catch (err) {
      app.log.warn({ err }, '[portfolio_search] ES advancedSearch failed, dense only')
    }

    // RRF fusion. Track dense/bm25 rank separately so the caller can
    // see which source carried each hit (useful for the UI: "matched
    // on clause text" vs "matched on title").
    const fused = new Map<string, {
      contractId: string
      clauseId?:  string
      denseRank?: number
      bm25Rank?:  number
      score:      number
    }>()

    dense.forEach((h, rank) => {
      const key = `${h.contractId}::${h.clauseId}`
      const prev = fused.get(key)
      const rrf = rrfScore(rank)
      fused.set(key, {
        contractId: h.contractId,
        clauseId:   h.clauseId,
        denseRank:  rank + 1,
        bm25Rank:   prev?.bm25Rank,
        score:      (prev?.score ?? 0) + rrf,
      })
    })

    // For BM25 hits we don't get a clauseId; only a contractId. We
    // create a contract-level entry whose best-scoring clause (if any)
    // from the dense pool we attach for context.
    bm25.forEach((h, rank) => {
      if (!h.id) return
      // Pick the dense hit with highest similarity for this contract
      // to carry the excerpt + anchor; null if no dense match.
      const contractDense = dense.filter(d => d.contractId === h.id)
      const best = contractDense[0]
      const key = best ? `${h.id}::${best.clauseId}` : h.id
      const prev = fused.get(key)
      const rrf = rrfScore(rank)
      fused.set(key, {
        contractId: h.id,
        clauseId:   best?.clauseId,
        denseRank:  prev?.denseRank,
        bm25Rank:   rank + 1,
        score:      (prev?.score ?? 0) + rrf,
      })
    })

    // Over-fetch before filtering so we can apply typed filters to the
    // dense side even when ES is unavailable (otherwise a dense-only
    // run ignores {contractType, status, counterpartyName}).
    const overRanked = [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, body.topK * 3)

    const contractIds = [...new Set(overRanked.map(r => r.contractId))]
    const contracts = await prisma.contract.findMany({
      where: {
        id: { in: contractIds },
        orgId: body.orgId,
        deletedAt: null,
        ...(body.contractType     ? { type:             body.contractType }     : {}),
        ...(body.status           ? { status:           body.status }           : {}),
        ...(body.counterpartyName ? { counterpartyName: { contains: body.counterpartyName, mode: 'insensitive' } } : {}),
      },
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, value: true, currency: true, riskScore: true,
        currentVersionId: true,
      },
    })
    const contractById = new Map(contracts.map(c => [c.id, c]))
    // Post-filter: drop hits whose contract didn't pass the Prisma
    // filters. Then truncate to topK.
    const ranked = overRanked
      .filter(r => contractById.has(r.contractId))
      .slice(0, body.topK)

    // Load clauses referenced by the top ranked hits (for excerpt +
    // sectionRef + anchor). One query, not N.
    const clauseIds = ranked.map(r => r.clauseId).filter(Boolean) as string[]
    const clauses = clauseIds.length > 0
      ? await prisma.contractClause.findMany({
          where: { id: { in: clauseIds } },
          select: { id: true, content: true, clauseType: true, sectionRef: true, versionId: true },
        })
      : []
    const clauseById = new Map(clauses.map(cl => [cl.id, cl]))

    // Fetch structure metadata for the versions covered, to get
    // {page, bbox} for each clause's sectionRef.
    const versionIds = [...new Set(clauses.map(c => c.versionId))]
    const versions = versionIds.length > 0
      ? await prisma.contractVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, metadata: true },
        })
      : []
    type NavEntry = { ref: string; title: string; page?: number; bbox?: number[] }
    const navByVersion = new Map<string, NavEntry[]>()
    for (const v of versions) {
      const nav = ((v.metadata as { structure?: { nav?: NavEntry[] } } | null)?.structure?.nav) ?? []
      navByVersion.set(v.id, nav)
    }

    const hits = ranked.map(r => {
      const c = contractById.get(r.contractId)
      const clause = r.clauseId ? clauseById.get(r.clauseId) : undefined
      const nav = clause ? (navByVersion.get(clause.versionId) ?? []) : []
      const navHit = clause?.sectionRef
        ? nav.find(n => clause.sectionRef?.includes(n.ref) || n.ref === clause.sectionRef)
        : undefined
      return {
        contractId:    r.contractId,
        contractTitle: c?.title ?? '(unknown)',
        contractType:  c?.type ?? null,
        contractStatus: c?.status ?? null,
        counterpartyName: c?.counterpartyName ?? null,
        value:         c?.value != null ? Number(c.value) : null,
        currency:      c?.currency ?? null,
        clauseId:      r.clauseId ?? null,
        clauseType:    clause?.clauseType ?? null,
        sectionRef:    clause?.sectionRef ?? null,
        excerpt:       clause ? clause.content.slice(0, 500) : null,
        page:          navHit?.page ?? null,
        bbox:          navHit?.bbox ?? null,
        fusedScore:    Number(r.score.toFixed(4)),
        denseRank:     r.denseRank ?? null,
        bm25Rank:      r.bm25Rank ?? null,
      }
    })

    // P7.5.1 — hits[].excerpt is raw clause text bound for the LLM; redact it.
    // One batch call across the whole result set, so a topK=20 search costs one
    // policy read and one audit row. NOTE: no contractId — these hits span many
    // contracts, and attributing the audit row to an arbitrary one of them
    // would be worse than leaving it request-scoped. Ranking inputs and the
    // structured metadata (titles, counterparty, clauseType, sectionRef,
    // page/bbox, scores) are untouched, so ordering is unchanged.
    const redactedExcerpts = await redactExcerpts(
      body.orgId,
      hits.map(h => h.excerpt),
      { surface: 'portfolio_search.excerpt' },
    )
    hits.forEach((h, i) => {
      const e = redactedExcerpts[i]
      if (typeof e === 'string') h.excerpt = e
    })

    return reply.send({
      query:   body.query,
      hits,
      total:   hits.length,
      sources: {
        // Adaptive-router signal: did we actually get to use both
        // ranking sources, or was one down? The agent can read this
        // and mention in the answer "Elasticsearch was unavailable;
        // results are dense-only" if relevant.
        dense: dense.length > 0,
        bm25:  bm25.length > 0,
      },
    })
  })

  // ── POST /internal/ai/tools/contract_summarize (D.1.4b) ────────────────────
  // Returns only the summary-shaped fields — title, type, dates, counterparty,
  // riskScore/Factors, keyTerms, AI summary, short plainText snippet. The
  // agent uses this when the user asks for a high-level overview and doesn't
  // need the full body (which contract_get provides). Smaller context,
  // faster + cheaper than contract_get for summary-style questions.
  app.post('/tools/contract_summarize', async (req, reply) => {
    let body
    try { body = ContractSummarizeSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, jurisdiction: true,
        effectiveDate: true, expiryDate: true, value: true, currency: true,
        summary: true, keyTerms: true, riskScore: true, riskFactors: true,
        currentVersionId: true,
      },
    })
    if (!contract) {
      return reply.status(404).send({ detail: 'Contract not found in this org' })
    }

    // A short opening snippet gives the model something to anchor on even
    // when contract.summary is null (e.g., analysis hasn't run yet).
    const version = contract.currentVersionId
      ? await prisma.contractVersion.findUnique({
          where: { id: contract.currentVersionId },
          select: { plainText: true },
        })
      : null
    const snippet = (version?.plainText ?? '').slice(0, 1_500)

    // P21 PII boundary. Both document-derived blobs this tool returns —
    // the AI summary (written from contract text) and the plainText
    // snippet — go through one batch call: one policy read, ONE audit
    // row for what the user experienced as a single tool call.
    // Structured metadata (counterparty, title, dates, riskFactors) is
    // deliberately left raw: the product depends on it.
    let summaryOut = contract.summary
    let snippetOut = snippet
    try {
      const redacted = await applyPiiPolicyBatch(
        body.orgId,
        [contract.summary ?? '', snippet],
        { surface: 'contract_summarize.summary+plainTextSnippet', contractId: contract.id },
      )
      // Keep `summary: null` null — don't turn an absent summary into ''.
      summaryOut = contract.summary != null ? (redacted.texts[0] ?? contract.summary) : null
      snippetOut = redacted.texts[1] ?? snippet
    } catch (err) {
      // Redaction must never break the tool call.
      console.error('[contract_summarize] PII redaction failed, returning unredacted text:', err)
    }

    return reply.send({
      id:               contract.id,
      title:            contract.title,
      type:             contract.type,
      status:           contract.status,
      counterpartyName: contract.counterpartyName,
      jurisdiction:     contract.jurisdiction,
      effectiveDate:    contract.effectiveDate,
      expiryDate:       contract.expiryDate,
      value:            contract.value != null ? Number(contract.value) : null,
      currency:         contract.currency,
      summary:          summaryOut,
      keyTerms:         contract.keyTerms,
      riskScore:        contract.riskScore,
      riskFactors:      contract.riskFactors,
      plainTextSnippet: snippetOut,
    })
  })

  // ── POST /internal/ai/tools/clause_search (D.1.4b) ─────────────────────────
  // Find passages inside a contract matching a natural-language query. Returns
  // a list of {index, beforeContext, match, afterContext, sectionHint} so the
  // model can cite the specific clause instead of summarizing the whole body.
  //
  // D.1.4b uses windowed text search over plainText — the ContractClause
  // extraction pipeline (docs/28 Wave 2) populates structured clauses later,
  // at which point we'll union the two sources.
  app.post('/tools/clause_search', async (req, reply) => {
    let body
    try { body = ClauseSearchSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: { id: true, title: true, currentVersionId: true },
    })
    if (!contract) {
      return reply.status(404).send({ detail: 'Contract not found in this org' })
    }

    const version = contract.currentVersionId
      ? await prisma.contractVersion.findUnique({
          where: { id: contract.currentVersionId },
          select: { plainText: true },
        })
      : await prisma.contractVersion.findFirst({
          where: { contractId: contract.id },
          orderBy: { versionNumber: 'desc' },
          select: { plainText: true },
        })

    const text = version?.plainText ?? ''
    if (!text) {
      return reply.send({ contractId: contract.id, title: contract.title, matches: [] })
    }

    // Case-insensitive sliding-window match. Not fancy — a real BM25 pass
    // lives on the ES side which D5 will light up. What matters today is
    // that the agent can find the right SECTION and cite it verbatim.
    const q = body.query.trim()
    const lower = text.toLowerCase()
    const qLower = q.toLowerCase()
    const matches: Array<{
      index: number
      beforeContext: string
      match: string
      afterContext: string
      sectionHint: string | null
    }> = []

    let cursor = 0
    while (matches.length < body.limit) {
      const idx = lower.indexOf(qLower, cursor)
      if (idx === -1) break
      const half = Math.floor(body.windowChars / 2)
      const start = Math.max(0, idx - half)
      const end   = Math.min(text.length, idx + q.length + half)
      const before = text.slice(start, idx)
      const match  = text.slice(idx, idx + q.length)
      const after  = text.slice(idx + q.length, end)

      // Best-effort section heading detection: look backwards for a line
      // starting with a digit + dot + optional dot (e.g. "9.2", "3.1.4").
      const backscan = text.slice(Math.max(0, idx - 500), idx)
      const sectionMatch = backscan.match(/\n\s*(\d+(?:\.\d+)*)[.\s)]/g)
      const sectionHint = sectionMatch ? sectionMatch[sectionMatch.length - 1].trim() : null

      matches.push({ index: idx, beforeContext: before, match, afterContext: after, sectionHint })
      cursor = idx + q.length
    }

    // P7.5.1 — every window here is verbatim contract text going to the LLM:
    // the match itself and both context sides. Flatten all three fields of all
    // matches into ONE batch (3N strings, one policy read, one audit row) and
    // map back by index, so ordering and shape are unchanged. `index` and
    // `sectionHint` are positional/structural metadata and stay raw.
    const flatWindows: string[] = []
    for (const m of matches) flatWindows.push(m.beforeContext, m.match, m.afterContext)
    const redactedWindows = await redactExcerpts(body.orgId, flatWindows, {
      surface: 'clause_search.excerpt',
      contractId: contract.id,
    })
    matches.forEach((m, i) => {
      const before = redactedWindows[i * 3]
      const mid    = redactedWindows[i * 3 + 1]
      const after  = redactedWindows[i * 3 + 2]
      if (typeof before === 'string') m.beforeContext = before
      if (typeof mid    === 'string') m.match         = mid
      if (typeof after  === 'string') m.afterContext  = after
    })

    return reply.send({
      contractId: contract.id,
      title: contract.title,
      query: body.query,
      matches,
      totalMatches: matches.length,
    })
  })

  // ── POST /internal/ai/tools/playbook_check (D.5.1) ─────────────────────────
  // Read tool. Pairs the contract's extracted clauses with the org's
  // playbook positions for each clause category, so the agent LLM can
  // reason about deviations. Returns structured shape:
  //
  //   {
  //     contract: { title, type, totalClauses },
  //     checks: [
  //       { clauseType, sectionRef, excerpt, riskRating,
  //         category:  { id, name },
  //         positions: [{ type, content, notes, riskThreshold }] }
  //     ],
  //     unmapped: string[]  // clauseTypes with no matching org category
  //   }
  //
  // Matching rule: clauseType → ClauseCategory.name via lightweight
  // normalisation (underscores→spaces, lower-case equal). Orgs whose
  // playbook categories don't align with the extractor's clauseType
  // vocab won't get matches — that's a data-quality issue to flag.
  app.post('/tools/playbook_check', async (req, reply) => {
    let body
    try { body = PlaybookCheckSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: { id: true, title: true, type: true, currentVersionId: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found in this org' })

    const versionId = contract.currentVersionId ?? (await prisma.contractVersion.findFirst({
      where: { contractId: contract.id }, orderBy: { versionNumber: 'desc' }, select: { id: true },
    }))?.id
    if (!versionId) {
      return reply.send({
        contract: { id: contract.id, title: contract.title, type: contract.type, totalClauses: 0 },
        checks: [], unmapped: [],
        warning: 'No version has been processed for this contract yet.',
      })
    }

    // All non-sub-chunk clauses, in document order, limited.
    const clauses = await prisma.contractClause.findMany({
      where: { versionId, isSubChunk: false },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, clauseType: true, content: true, sectionRef: true,
        riskRating: true, reviewState: true,
      },
      take: body.maxClauses,
    })
    // Counted separately from the page above: reporting clauses.length as the
    // total made a capped run indistinguishable from a complete one, so a
    // caller could not tell whether it had seen the whole contract.
    const totalClauseCount = await prisma.contractClause.count({
      where: { versionId, isSubChunk: false },
    })

    // Org's categories + positions. Fetch all in one shot; we filter to
    // matching ones per clause in memory (3-20 categories per org is the
    // empirical shape — not worth a per-clause query).
    const categories = await prisma.clauseCategory.findMany({
      where: { orgId: body.orgId },
      select: { id: true, name: true },
    })
    const categoryByNormalisedName = new Map<string, { id: string; name: string }>()
    for (const c of categories) {
      categoryByNormalisedName.set(normalisedKey(c.name), { id: c.id, name: c.name })
    }

    // Load every position for the contract's type (or type-agnostic).
    // We also pull `rules` (P1.2) — the structured playbook schema the
    // evaluator walks to emit concrete violations.
    const positions = await prisma.playbookPosition.findMany({
      where: {
        orgId: body.orgId,
        OR: [
          { contractTypes: { isEmpty: true } },
          { contractTypes: { has: contract.type } },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        clauseCategoryId: true,
        positionType: true, content: true, notes: true, riskThreshold: true,
        rules: true,
      },
    })
    const positionsByCategory = new Map<string, typeof positions>()
    for (const p of positions) {
      const arr = positionsByCategory.get(p.clauseCategoryId) ?? []
      arr.push(p)
      positionsByCategory.set(p.clauseCategoryId, arr)
    }

    const checks: Array<Record<string, unknown>> = []
    const unmapped = new Set<string>()
    // Clauses we looked at but could not judge. Previously these were dropped
    // on the floor: absent from checks[] AND from unmapped[], so a contract
    // whose clauses mostly had no playbook coverage came back looking clean.
    // "We found nothing wrong" and "we did not look" have to be distinguishable,
    // because a redlining pipeline treats the first as done.
    const uncovered: Array<{ clauseId: string; clauseType: string; sectionRef: string | null; reason: string }> = []
    for (const cl of clauses) {
      const key = normalisedKey(cl.clauseType)
      const category = categoryByNormalisedName.get(key)
      if (!category) { unmapped.add(cl.clauseType); continue }
      const matchingPositions = positionsByCategory.get(category.id) ?? []
      if (matchingPositions.length === 0) {
        uncovered.push({
          clauseId: cl.id, clauseType: cl.clauseType, sectionRef: cl.sectionRef,
          reason: 'no_positions_for_category',
        })
        continue
      }
      // A position with prose but no `rules` JSON produces zero violations,
      // which reads identically to "every rule passed". Say which it was.
      if (!matchingPositions.some(p => ruleCountOf(p.rules as PlaybookRules | null) > 0)) {
        uncovered.push({
          clauseId: cl.id, clauseType: cl.clauseType, sectionRef: cl.sectionRef,
          reason: 'positions_have_no_rules',
        })
        continue
      }

      // P1.2 — evaluate every position's `rules` (if any) against the
      // clause text. Combine hits into a single violations[] for the
      // clause so the agent LLM can see "3 violations, severity high"
      // without having to pick through positions.
      const violations: Array<Record<string, unknown>> = []
      for (const pos of matchingPositions) {
        const rules = pos.rules as PlaybookRules | null
        if (!rules) continue
        violations.push(...evaluatePlaybookRules(rules, cl.content, pos.positionType))
      }
      const worstSeverity = pickWorstSeverity(violations)

      checks.push({
        // Required to chain into a rewrite: redline_propose and redline_apply
        // both key on clauseId, and it was selected here but never emitted, so
        // a caller had to re-derive it from (clauseType, sectionRef).
        clauseId:    cl.id,
        clauseType:  cl.clauseType,
        sectionRef:  cl.sectionRef,
        excerpt:     cl.content.slice(0, 800),
        riskRating:  cl.riskRating,
        reviewState: cl.reviewState,
        category:    { id: category.id, name: category.name },
        positions:   matchingPositions.map(p => ({
          positionType:  p.positionType,
          content:       p.content.slice(0, 800),
          notes:         p.notes,
          riskThreshold: p.riskThreshold,
          // Bubble up rules summary per position so the caller knows
          // which position rendered which violation.
          ruleCount:     ruleCountOf(p.rules as PlaybookRules | null),
        })),
        // P1.2 — structured evaluation output.
        violations,
        worstSeverity,   // null | 'low' | 'medium' | 'high' | 'critical' | 'walkaway'
        // `passed` used to be the COUNT of passing rules, which made
        // `if (check.passed)` read backwards — truthy whenever a single rule
        // passed, however many failed alongside it. It is now the verdict, and
        // the counts live under names that say they are counts.
        passed:          violations.every(v => v.passed !== false),
        passedCount:     violations.filter(v => v.passed === true).length,
        failedCount:     violations.filter(v => v.passed === false).length,
        // Kept for the artifact renderer, which reads `failed` as a number.
        failed:          violations.filter(v => v.passed === false).length,
      })
    }

    // P7.5.1 — redact the verbatim clause text ONCE, here, before it is
    // used anywhere downstream. This is the highest-stakes redaction in
    // the file because `excerpt` feeds TWO separate third-party LLM
    // hops in the same turn:
    //   1. the tool result returned to the agent's model, and
    //   2. `clauseText` on the Python /playbook_judge call below.
    // Overwriting the value in place (rather than redacting at each
    // call site) guarantees the two hops see the same text and that
    // neither can be added later without redaction.
    //
    // Deliberately AFTER evaluatePlaybookRules, which ran against raw
    // `cl.content` above: rule matching, violations[], worstSeverity and
    // the passed/failed counts are all computed from the original text,
    // so scoring is bit-for-bit unchanged by this addition.
    //
    // `positions[].content` is NOT redacted — that is the org's own
    // playbook language, not document-derived text.
    {
      const excerptIdx: number[] = []
      const excerptTexts: string[] = []
      checks.forEach((ck, i) => {
        if (typeof ck.excerpt === 'string' && ck.excerpt.length > 0) {
          excerptIdx.push(i)
          excerptTexts.push(ck.excerpt)
        }
      })
      const redacted = await redactExcerpts(body.orgId, excerptTexts, {
        surface: 'playbook_check.excerpt',
        contractId: contract.id,
      })
      excerptIdx.forEach((checkIndex, k) => {
        const ck = checks[checkIndex]
        if (ck) ck.excerpt = redacted[k] ?? ck.excerpt
      })
    }

    // P1.3 — when the caller opted into the judge, run each check's
    // rules through Python /playbook_judge for extracted-bound values +
    // corrected pass/fail. One LLM call per check, fired in parallel to
    // keep wall-time tolerable on a 10-clause response.
    /**
     * Document-level rollup.
     *
     * Every consumer previously had to recompute this — the artifact renderer
     * sums `failed` itself — and none of them could see what had NOT been
     * examined. A redlining pipeline needs both: which clauses deviate, and
     * how much of the document the answer actually covers.
     */
    const buildSummary = (rows: Array<Record<string, unknown>>) => {
      const allViolations = rows.flatMap(r => (r.violations as Array<Record<string, unknown>>) ?? [])
      const deviating = rows.filter(r => (r.failedCount as number) > 0)
      return {
        worstSeverity:   pickWorstSeverity(allViolations),
        deviationCount:  deviating.length,
        checkedClauses:  rows.length,
        coveredClauses:  rows.length,
        uncoveredClauses: uncovered.length + unmapped.size,
        totalClauses:    totalClauseCount,
        // True when the cap stopped us short of the whole document. Without
        // this a capped run and a complete one look identical.
        truncated:       totalClauseCount > clauses.length,
        requiresHumanGate: allViolations.some(v =>
          v.passed === false &&
          (v.severity === 'walkaway' || v.severity === 'critical')),
      }
    }

    if (body.judge && checks.length > 0) {
      // Bounded fan-out. Each judged check is its own LLM round-trip, and this
      // used to be an unbounded Promise.all — survivable only because
      // maxClauses was capped at 30. Raising that cap to admit a whole
      // contract turned the same line into "up to 500 simultaneous model
      // calls", which would exhaust the provider rate limit and take the
      // request down with it. Order is preserved: results are written back by
      // index, not by completion.
      const JUDGE_CONCURRENCY = 6
      const judged: Array<Record<string, unknown>> = new Array(checks.length)
      const judgeOne = async (ck: Record<string, unknown>) => {
        // Pick the rules to judge: prefer the "preferred" position's
        // rules (that's what we're measuring against). Skip if none.
        const preferredPos = (ck.positions as Array<{ positionType: string }>)
          .find(p => p.positionType === 'preferred')
        const pos = positionsByCategory
          .get((ck.category as { id: string }).id)
          ?.find(p => p.positionType === 'preferred')
        if (!preferredPos || !pos?.rules) return ck
        try {
          const judgeRes = await fetch(`${AGENTS_URL}/playbook_judge`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-secret': INTERNAL_SECRET,
            },
            body: JSON.stringify({
              clauseText: ck.excerpt,
              positionType: 'preferred',
              rules: pos.rules,
              orgId: body.orgId,   // per-org BYOK key + Langfuse tracing
            }),
          })
          if (!judgeRes.ok) return ck
          const judged = await judgeRes.json() as {
            bestMatchPositionType?: string
            confidence?: number
            mustHave?: Array<{ id: string; passed: boolean; evidence?: string }>
            mustNot?:  Array<{ id: string; passed: boolean; evidence?: string }>
            bounds?:   Array<{ key: string; extracted_value?: unknown; extracted_unit?: string | null; passed: boolean | null; reason?: string }>
            error?: string
          }
          if (judged.error) return { ...ck, judgeError: judged.error }

          // Overlay the judge's verdicts onto the existing violations[].
          const byId = new Map<string, { passed: boolean; evidence?: string }>()
          for (const v of judged.mustHave ?? []) byId.set(v.id, { passed: v.passed, evidence: v.evidence })
          for (const v of judged.mustNot ?? [])  byId.set(v.id, { passed: v.passed, evidence: v.evidence })
          const boundsByKey = new Map<string, NonNullable<typeof judged.bounds>[number]>()
          for (const b of judged.bounds ?? []) boundsByKey.set(b.key, b)

          const merged = (ck.violations as Array<Record<string, unknown>>).map(v => {
            if (v.kind === 'must_have' || v.kind === 'must_not') {
              const hit = byId.get(v.ruleId as string)
              if (hit) return { ...v, passed: hit.passed, evidence: hit.evidence, judged: true }
            }
            if (v.kind === 'bound') {
              const hit = boundsByKey.get(v.boundKey as string)
              if (hit) return {
                ...v,
                extractedValue: hit.extracted_value,
                extractedUnit:  hit.extracted_unit,
                passed:         hit.passed,
                reason:         hit.reason,
                judged:         true,
              }
            }
            return v
          })
          const worst = pickWorstSeverity(merged)
          return {
            ...ck,
            violations: merged,
            worstSeverity: worst,
            // Same shape as the non-judge branch. This used to emit `passed`
            // as a count and no failedCount at all, so turning on judge mode
            // silently reverted the field semantics AND left buildSummary
            // counting zero deviations.
            passed:      merged.every(v => v.passed !== false),
            passedCount: merged.filter(v => v.passed === true).length,
            failedCount: merged.filter(v => v.passed === false).length,
            failed:      merged.filter(v => v.passed === false).length,
            bestMatch: judged.bestMatchPositionType,
            judgeConfidence: judged.confidence,
          }
        } catch {
          return ck
        }
      }

      // Fixed-size worker pool pulling from a shared cursor.
      let cursor = 0
      await Promise.all(
        Array.from({ length: Math.min(JUDGE_CONCURRENCY, checks.length) }, async () => {
          for (;;) {
            const i = cursor++
            if (i >= checks.length) return
            judged[i] = await judgeOne(checks[i])
          }
        }),
      )

      return reply.send({
        contract: {
          id:            contract.id,
          title:         contract.title,
          type:          contract.type,
          totalClauses:  totalClauseCount,
        },
        summary:  buildSummary(judged),
        checks:   judged,
        uncovered,
        unmapped: [...unmapped],
        judged: true,
      })
    }

    return reply.send({
      contract: {
        id:            contract.id,
        title:         contract.title,
        type:          contract.type,
        totalClauses:  totalClauseCount,
      },
      summary: buildSummary(checks),
      checks,
      uncovered,
      unmapped: [...unmapped],
    })
  })

  // ── POST /internal/ai/tools/redline_propose (P1.4) ─────────────────────────
  // Read-only tool. Returns 3 aggression-variant rewrites of a target
  // clause, grounded in the matching playbook position + rules. No
  // mutation — the user picks a variant, the rail fires redline_apply
  // (P1.5) to land it as a new ContractVersion.
  app.post('/tools/redline_propose', async (req, reply) => {
    let body
    try { body = RedlineProposeSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    // Shared with the user-facing POST /contracts/:id/clauses/:clauseId/suggest
    // so the chat agent and the review drawer produce identical proposals.
    const result = await proposeClauseAlternatives({
      contractId:   body.contractId,
      orgId:        body.orgId,
      clauseId:     body.clauseId,
      clauseType:   body.clauseType,
      instructions: body.instructions,
    })
    if (!result.ok) {
      return reply.status(result.status).send({ detail: result.detail, upstream: result.upstream })
    }
    return reply.send(result.data)
  })


  // ── POST /internal/ai/tools/redline_propose_batch (Phase 1) ────────────────
  // Read-only. Rewrites many clauses in one round-trip, each grounded in its
  // OWN playbook positions — see lib/clause-propose-batch.ts for why that
  // separation matters. Concurrency is bounded on the Python side.
  app.post('/tools/redline_propose_batch', async (req, reply) => {
    let body
    try { body = RedlineProposeBatchSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    const result = await proposeClauseBatch({
      orgId:        body.orgId,
      contractId:   body.contractId,
      clauseIds:    body.clauseIds,
      aggression:   body.aggression,
      instructions: body.instructions,
    })
    if (!result.ok) {
      return reply.status(result.status).send({ detail: result.detail, upstream: result.upstream })
    }
    return reply.send(result.data)
  })

  // ── POST /internal/ai/tools/comment_add (D.3.2) ────────────────────────────
  // First write tool. Creates a ContractComment row — anchored to a version
  // or clauseRef when supplied. Validates cross-tenant scope + contract
  // existence before writing. Used by the thread apply-action RPC after the
  // user approves an ActionPreview card; never exposed publicly.
  app.post('/tools/comment_add', async (req, reply) => {
    let body
    try { body = CommentAddSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    // Scope gate — contract must live in the stated org.
    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: { id: true },
    })
    if (!contract) {
      return reply.status(404).send({ detail: 'Contract not found in this org' })
    }

    // When versionId is supplied, confirm it belongs to this contract.
    if (body.versionId) {
      const v = await prisma.contractVersion.findFirst({
        where: { id: body.versionId, contractId: body.contractId },
        select: { id: true },
      })
      if (!v) return reply.status(404).send({ detail: 'Version not found on this contract' })
    }

    const comment = await prisma.contractComment.create({
      data: {
        orgId:      body.orgId,
        contractId: body.contractId,
        versionId:  body.versionId,
        clauseRef:  body.clauseRef,
        parentId:   body.parentId,
        authorId:   body.authorId,
        body:       body.body,
      },
      select: {
        id: true, contractId: true, versionId: true, clauseRef: true,
        authorId: true, body: true, createdAt: true,
      },
    })
    return reply.send({ comment, reversible: true })
  })

  // ── POST /internal/ai/tools/request_create (D.3.3) ─────────────────────────
  // Creates a ContractRequest row. Source is hard-coded to 'chat' so the
  // requests list can distinguish AI-initiated from web-form submissions.
  app.post('/tools/request_create', async (req, reply) => {
    let body
    try { body = RequestCreateSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const request = await prisma.contractRequest.create({
      data: {
        orgId:            body.orgId,
        title:            body.title,
        type:             body.type,
        status:           'SUBMITTED',
        source:           'chat',
        requestedById:    body.requestedById,
        counterpartyName: body.counterpartyName,
        description:      body.description,
        estimatedValue:   body.estimatedValue,
        priority:         body.priority,
      },
      select: {
        id: true, title: true, type: true, status: true, priority: true,
        counterpartyName: true, estimatedValue: true, createdAt: true,
      },
    })
    return reply.send({ request, reversible: true })
  })

  // ── POST /internal/ai/tools/request_create/undo (D.3.5 pattern) ────────────
  // Wave 3.9 — soft-delete via the deletedAt column (which ContractRequest has),
  // consistent with every request read path (all filter deletedAt:null) and with
  // the contract undo. The old code wrote status='CANCELLED', which is NOT a
  // member of the RequestStatus enum, corrupting status filters/counts.
  app.post('/tools/request_create/undo', async (req, reply) => {
    const body = z.object({
      orgId:     z.string().min(1),
      requestId: z.string().min(1),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ detail: 'Invalid request', issues: body.error.issues })
    }
    const existing = await prisma.contractRequest.findFirst({
      where: { id: body.data.requestId, orgId: body.data.orgId, deletedAt: null },
      select: { id: true },
    })
    if (!existing) {
      return reply.status(404).send({ detail: 'Request not found or already undone' })
    }
    await prisma.contractRequest.update({
      where: { id: existing.id },
      data:  { deletedAt: new Date() },
    })
    return reply.send({ ok: true, undone: true, requestId: existing.id })
  })

  // ── POST /internal/ai/tools/contract_update (D.5.5) ────────────────────────
  // Workflow-shaped write tool for the most common operational mutations
  // on a contract. One endpoint, action enum, per-action payload validation.
  //
  // Reversibility:
  //   set_status, assign_owner, add_tag, remove_tag → reversible (we
  //   snapshot the previous value into the tool-call output; the undo
  //   adapter restores it)
  //   retype, re_analyze → NOT reversible (kicks off async pipelines that
  //   write to keyTerms / clauses / riskScore — rolling those back isn't
  //   a matter of a single UPDATE)
  app.post('/tools/contract_update', async (req, reply) => {
    let body
    try { body = ContractUpdateSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const existing = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: {
        id: true, title: true, type: true, status: true,
        ownerId: true, tags: true, analysisStatus: true,
      },
    })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found in this org' })

    // Valid status transitions — mirror the REST PATCH handler's table so
    // the agent can't skip through states the UI would reject.
    const VALID_TRANSITIONS: Record<string, string[]> = {
      DRAFT:             ['PENDING_REVIEW', 'PENDING_APPROVAL'],
      PENDING_REVIEW:    ['DRAFT', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL'],
      UNDER_NEGOTIATION: ['PENDING_REVIEW', 'PENDING_APPROVAL'],
      PENDING_APPROVAL:  ['APPROVED', 'REJECTED'],
      APPROVED:          ['EXECUTED', 'PENDING_SIGNATURE'],
      EXECUTED:          ['ARCHIVED'],
      EXPIRED:           ['ARCHIVED'],
      REJECTED:          ['DRAFT'],
    }

    // Each action is its own switch branch so reversibility + the undo
    // snapshot can be computed exactly where the mutation happens.
    if (body.action === 'set_status') {
      const nextStatus = String(body.payload.status ?? '')
      const allowed = VALID_TRANSITIONS[existing.status] ?? []
      if (!allowed.includes(nextStatus)) {
        return reply.status(409).send({
          detail: `Cannot transition from ${existing.status} to ${nextStatus}`,
          allowed,
        })
      }
      await prisma.contract.update({
        where: { id: existing.id },
        data:  { status: nextStatus },
      })
      return reply.send({
        ok: true,
        reversible: true,
        action: 'set_status',
        contractId: existing.id,
        snapshot: { status: existing.status }, // for undo
        diff: [{ field: 'status', before: existing.status, after: nextStatus }],
      })
    }

    if (body.action === 'assign_owner') {
      const nextOwnerId = body.payload.ownerId == null ? null : String(body.payload.ownerId)
      // Contract.ownerId is non-nullable — an owner is required. Reject an
      // unassign attempt rather than violating the DB constraint.
      if (!nextOwnerId) return reply.status(400).send({ detail: 'ownerId is required for assign_owner' })
      const user = await prisma.user.findFirst({
        where: { id: nextOwnerId, orgId: body.orgId, deletedAt: null },
        select: { id: true },
      })
      if (!user) return reply.status(404).send({ detail: 'User not found in this org' })
      await prisma.contract.update({
        where: { id: existing.id },
        data:  { ownerId: nextOwnerId },
      })
      return reply.send({
        ok: true,
        reversible: true,
        action: 'assign_owner',
        contractId: existing.id,
        snapshot: { ownerId: existing.ownerId },
        diff: [{ field: 'ownerId', before: existing.ownerId, after: nextOwnerId }],
      })
    }

    if (body.action === 'add_tag' || body.action === 'remove_tag') {
      const tag = String(body.payload.tag ?? '').trim()
      if (!tag) return reply.status(400).send({ detail: 'payload.tag required' })
      const current = new Set(existing.tags ?? [])
      const before = [...current]
      if (body.action === 'add_tag') current.add(tag)
      else                           current.delete(tag)
      const next = [...current]
      await prisma.contract.update({
        where: { id: existing.id },
        data:  { tags: next },
      })
      return reply.send({
        ok: true,
        reversible: true,
        action: body.action,
        contractId: existing.id,
        snapshot: { tags: before },
        diff: [{ field: 'tags', before: before.join(', ') || '∅', after: next.join(', ') || '∅' }],
      })
    }

    // retype / re_analyze — NOT reversible. We still run them, but the
    // caller surface (agent-threads.ts) will set reversible=false on the
    // ToolCall row so the UI doesn't render an Undo button.
    // Wave 3.9 — re-run analysis by enqueuing a worker job, mirroring the REST
    // /:id/analyze path so the contract can't wedge. If the latest version
    // already has parsed text, smart-resume via classify (CLASSIFYING). If it
    // has an uploaded doc but no parsed text yet, do a full re-parse
    // (PENDING) — enqueuing classify would silently no-op and strand the
    // contract in CLASSIFYING. Returns false if there's nothing to analyze.
    const reanalyze = async (): Promise<boolean> => {
      const latest = await prisma.contractVersion.findFirst({
        where: { contractId: existing.id },
        orderBy: { versionNumber: 'desc' },
        select: { id: true, plainText: true, s3Key: true, mimeType: true },
      })
      if (!latest) return false
      if (latest.plainText && latest.plainText.trim()) {
        await prisma.contract.update({ where: { id: existing.id }, data: { analysisStatus: 'CLASSIFYING' } })
        queueClassifyDocument({ contractId: existing.id, versionId: latest.id, orgId: body.orgId })
        return true
      }
      if (latest.s3Key) {
        const filename = latest.mimeType === 'application/pdf' ? 'contract.pdf'
          : latest.mimeType?.includes('wordprocessingml') ? 'contract.docx'
          : 'contract.txt'
        await prisma.contract.update({ where: { id: existing.id }, data: { analysisStatus: 'PENDING' } })
        queueParseDocument({ contractId: existing.id, versionId: latest.id, s3Key: latest.s3Key, mimeType: latest.mimeType ?? 'application/pdf', filename, orgId: body.orgId })
        return true
      }
      return false
    }

    if (body.action === 'retype') {
      const nextType = String(body.payload.type ?? '')
      if (!nextType) return reply.status(400).send({ detail: 'payload.type required' })
      await prisma.contract.update({ where: { id: existing.id }, data: { type: nextType } })
      await reanalyze()  // best-effort re-analysis; retype still succeeds without a version
      return reply.send({
        ok: true,
        reversible: false,
        action: 'retype',
        contractId: existing.id,
        diff: [{ field: 'type', before: existing.type, after: nextType }],
      })
    }

    if (body.action === 're_analyze') {
      const queued = await reanalyze()
      if (!queued) {
        return reply.status(409).send({ detail: 'Nothing to analyze — this contract has no document to (re)parse yet.' })
      }
      return reply.send({
        ok: true,
        reversible: false,
        action: 're_analyze',
        contractId: existing.id,
        // No diff — user-facing effect is "analysis re-runs in the background".
      })
    }

    return reply.status(400).send({ detail: `Unknown action ${body.action}` })
  })

  // ── POST /internal/ai/tools/contract_update/undo (D.5.5 reversible paths) ──
  // Restores the snapshot the tool call produced. The thread-undo adapter
  // reads `snapshot` off the original tool-call output and posts it back
  // here with the contractId + action so this endpoint knows which
  // column to write.
  app.post('/tools/contract_update/undo', async (req, reply) => {
    const body = z.object({
      orgId:      z.string().min(1),
      contractId: z.string().min(1),
      action:     z.enum(['set_status', 'assign_owner', 'add_tag', 'remove_tag']),
      snapshot:   z.record(z.unknown()),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ detail: 'Invalid request', issues: body.error.issues })
    }

    const existing = await prisma.contract.findFirst({
      where: { id: body.data.contractId, orgId: body.data.orgId, deletedAt: null },
      select: { id: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found' })

    const data: Record<string, unknown> = {}
    if (body.data.action === 'set_status') {
      data.status = String(body.data.snapshot.status ?? '')
      if (!data.status) return reply.status(400).send({ detail: 'snapshot.status missing' })
    } else if (body.data.action === 'assign_owner') {
      data.ownerId = body.data.snapshot.ownerId == null ? null : String(body.data.snapshot.ownerId)
    } else if (body.data.action === 'add_tag' || body.data.action === 'remove_tag') {
      const tags = body.data.snapshot.tags
      if (!Array.isArray(tags)) return reply.status(400).send({ detail: 'snapshot.tags missing' })
      data.tags = tags.map(String)
    }

    await prisma.contract.update({
      where: { id: existing.id },
      data,
    })
    return reply.send({ ok: true, undone: true, contractId: existing.id })
  })

  // ── POST /internal/ai/tools/comment_add/undo (D.3.5) ───────────────────────
  // Soft-deletes a ContractComment row created via the comment_add tool.
  // Scope is enforced by orgId + commentId match. Returns {ok, undone:true}
  // so the thread's apply handler can update the ToolCall.rolledBackAt.
  //
  // Why soft-delete: the comment might already have replies or be
  // referenced from an audit trail; hard-delete loses those links. The
  // GET /comments endpoint already filters on deletedAt IS NULL so the
  // user sees it disappear.
  app.post('/tools/comment_add/undo', async (req, reply) => {
    const body = z.object({
      orgId:     z.string().min(1),
      commentId: z.string().min(1),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ detail: 'Invalid request', issues: body.error.issues })
    }

    const existing = await prisma.contractComment.findFirst({
      where: { id: body.data.commentId, orgId: body.data.orgId, deletedAt: null },
      select: { id: true, createdAt: true },
    })
    if (!existing) {
      return reply.status(404).send({ detail: 'Comment not found or already undone' })
    }

    await prisma.contractComment.update({
      where: { id: existing.id },
      data:  { deletedAt: new Date() },
    })
    return reply.send({ ok: true, undone: true, commentId: existing.id })
  })

  // ── POST /internal/ai/tools/approval_route (D.5.6) ─────────────────────────
  // Route a contract into its approval workflow. Inline happy path — the
  // REST /submit-approval endpoint has the full behaviour (escalation
  // queue, AI summary, notification) but coupling to those requires the
  // BullMQ handles, which this plugin doesn't import. Agent-driven routes
  // skip those queues; the approver still sees the item when they open
  // /approvals (the dashboard query doesn't depend on notification).
  app.post('/tools/approval_route', async (req, reply) => {
    let body
    try { body = ApprovalRouteSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: { id: true, title: true, type: true, status: true, value: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    if (!['DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION'].includes(contract.status)) {
      return reply.status(409).send({
        detail: `Cannot submit a contract with status ${contract.status} for approval`,
      })
    }
    const existing = await prisma.approvalInstance.findFirst({
      where: { contractId: contract.id, status: { in: ['PENDING', 'ESCALATED'] } },
    })
    if (existing) {
      return reply.status(409).send({ detail: 'Contract already has an active approval workflow', instanceId: existing.id })
    }

    // Resolve workflow — explicit id first, else first matching active.
    let workflow = body.workflowDefinitionId
      ? await prisma.workflowDefinition.findFirst({
          where: { id: body.workflowDefinitionId, orgId: body.orgId, deletedAt: null, isActive: true },
        })
      : null
    if (!workflow) {
      const candidates = await prisma.workflowDefinition.findMany({
        where: { orgId: body.orgId, isActive: true, deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })
      for (const c of candidates) {
        const rules = (c.triggerRules as Record<string, unknown>) ?? {}
        const types = (rules.contractTypes as string[] | undefined) ?? []
        if (types.length === 0 || types.includes(contract.type)) { workflow = c; break }
      }
    }
    if (!workflow) {
      return reply.status(422).send({ detail: 'No active approval workflow found for this org' })
    }

    const stepDefs: WorkflowStepDef[] = Array.isArray(workflow.steps)
      ? (workflow.steps as unknown as WorkflowStepDef[])
      : []
    if (stepDefs.length === 0) {
      return reply.status(422).send({ detail: 'Workflow has no steps configured' })
    }
    const firstStepDef = stepDefs.sort((a, b) => a.order - b.order)[0]
    const triggerRules = (workflow.triggerRules as Record<string, unknown>) ?? {}
    const contractValue = contract.value != null ? Number(contract.value) : null

    // Auto-approve path — matches the REST handler's fast lane.
    if (checkAutoApprove(contract.type, contractValue, triggerRules)) {
      const instance = await prisma.approvalInstance.create({
        data: {
          orgId: body.orgId,
          contractId: contract.id,
          workflowDefinitionId: workflow.id,
          status: 'AUTO_APPROVED',
          currentStepOrder: 0,
          submittedById: body.userId,
          decidedAt: new Date(),
          aiSummary: body.comment ?? 'Auto-approved based on org rules.',
          approvalRecommendation: 'approve',
        },
      })
      await prisma.contract.update({
        where: { id: contract.id },
        data:  { status: 'APPROVED' },
      })
      return reply.send({
        ok: true,
        reversible: true,
        instanceId: instance.id,
        contractId: contract.id,
        previousStatus: contract.status,
        autoApproved: true,
        workflowDefinitionId: workflow.id,
      })
    }

    // Normal path — resolve the first approver(s) + create instance + step(s).
    // Wave 3.8 — a parallel first step fans out to all its approvers at once.
    const firstApproverIds = await resolveApprovers(firstStepDef, body.orgId, prisma as never)
    if (firstApproverIds.length === 0) {
      return reply.status(422).send({
        detail: `Cannot resolve approver for step "${firstStepDef.name}"`,
      })
    }
    const escalateAt = new Date(Date.now() + (firstStepDef.dueSoonHours ?? 48) * 60 * 60 * 1000)

    const { inst, steps } = await prisma.$transaction(async (tx) => {
      const inst = await tx.approvalInstance.create({
        data: {
          orgId: body.orgId,
          contractId: contract.id,
          workflowDefinitionId: workflow!.id,
          status: 'PENDING',
          currentStepOrder: firstStepDef.order,
          submittedById: body.userId,
        },
      })
      const steps = await Promise.all(firstApproverIds.map(approverId =>
        tx.approvalStep.create({
          data: {
            approvalInstanceId: inst.id,
            orgId: body.orgId,
            stepOrder: firstStepDef.order,
            stepName:  firstStepDef.name,
            approverId,
            status: 'PENDING',
            escalateAt,
          },
        }),
      ))
      await tx.contract.update({
        where: { id: contract.id },
        data:  { status: 'PENDING_APPROVAL' },
      })
      return { inst, steps }
    })

    return reply.send({
      ok: true,
      reversible: true,
      instanceId: inst.id,
      // Keep the singular fields for backward-compat (first of the batch), plus
      // the full set for parallel steps.
      stepId: steps[0].id,
      stepIds: steps.map(s => s.id),
      contractId: contract.id,
      previousStatus: contract.status,
      workflowDefinitionId: workflow.id,
      firstApproverId: firstApproverIds[0],
      approverIds: firstApproverIds,
      currentStepOrder: firstStepDef.order,
      autoApproved: false,
    })
  })

  // ── POST /internal/ai/tools/approval_route/undo (D.5.6) ────────────────────
  // Cancel the approval instance + restore the contract's previous status.
  // Blocks if anyone has already approved a step (decidedAt set) — that
  // would leak partial approvals into an audit trail the undo can't
  // meaningfully unwind.
  app.post('/tools/approval_route/undo', async (req, reply) => {
    const body = z.object({
      orgId:          z.string().min(1),
      instanceId:     z.string().min(1),
      contractId:     z.string().min(1),
      previousStatus: z.string().min(1),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ detail: 'Invalid request', issues: body.error.issues })
    }

    const instance = await prisma.approvalInstance.findFirst({
      where: { id: body.data.instanceId, orgId: body.data.orgId },
      include: { steps: { select: { id: true, status: true, decidedAt: true } } },
    })
    if (!instance) return reply.status(404).send({ detail: 'Approval instance not found' })

    // If any step already has a decision, refuse the undo. The approver
    // acted — rolling that back silently would erase an audit record.
    if (instance.steps.some(s => s.decidedAt != null)) {
      return reply.status(409).send({
        detail: 'An approver has already acted on this request — cannot undo',
      })
    }
    if (instance.status === 'CANCELLED' || instance.status === 'APPROVED' ||
        instance.status === 'REJECTED'  || instance.status === 'AUTO_APPROVED') {
      // Already in a terminal state (AUTO_APPROVED included) — still let
      // us rewind AUTO_APPROVED because no human acted; real APPROVED /
      // REJECTED / CANCELLED refuse.
      if (instance.status !== 'AUTO_APPROVED') {
        return reply.status(409).send({ detail: `Instance already ${instance.status}` })
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.approvalInstance.update({
        where: { id: instance.id },
        data:  { status: 'CANCELLED', decidedAt: new Date() },
      })
      await tx.approvalStep.updateMany({
        where: { approvalInstanceId: instance.id, status: 'PENDING' },
        data:  { status: 'SKIPPED' },
      })
      await tx.contract.update({
        where: { id: body.data.contractId },
        data:  { status: body.data.previousStatus },
      })
    })
    return reply.send({ ok: true, undone: true, instanceId: instance.id })
  })

  // ── POST /internal/ai/tools/redline_apply (P1.5) ───────────────────────────
  // Take a variant from redline_propose and land it as a new
  // ContractVersion (n+1). Replaces the target clause's content in the
  // version HTML + plaintext. Reversible: undo flips currentVersionId
  // back and soft-deletes the new version by appending "(reverted)" to
  // its changeNote — the row itself stays as an audit trail.
  //
  // We deliberately keep the diff surface structured (metadata.redline)
  // so a future OOXML serializer can read the same rows and emit real
  // Word tracked changes without re-running the LLM.
  app.post('/tools/redline_apply', async (req, reply) => {
    let body
    try { body = RedlineApplySchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    // Shared with the user-facing POST /contracts/:id/clauses/:clauseId/apply
    // so the agent-thread flow and the review drawer splice identically.
    const applied = await applyClauseProposal({
      orgId:        body.orgId,
      userId:       body.userId,
      contractId:   body.contractId,
      clauseId:     body.clauseId,
      proposedText: body.proposedText,
      aggression:   body.aggression,
      rationale:    body.rationale,
      changes:      body.changes,
      allowAppendFallback: body.allowAppendFallback === true,
    })
    if (!applied.ok) {
      return reply.status(applied.status).send({ detail: applied.detail, code: applied.code })
    }
    return reply.send(applied.data)
  })

  // ── POST /internal/ai/tools/redline_apply/undo (P1.5) ──────────────────────
  // Flip currentVersionId back + mark the reverted version with a
  // changeNote suffix so the history view shows the round-trip.
  app.post('/tools/redline_apply/undo', async (req, reply) => {
    const body = z.object({
      orgId:             z.string().min(1),
      contractId:        z.string().min(1),
      previousVersionId: z.string().min(1),
      newVersionId:      z.string().min(1),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ detail: 'Invalid request', issues: body.error.issues })
    }
    const contract = await prisma.contract.findFirst({
      where: { id: body.data.contractId, orgId: body.data.orgId, deletedAt: null },
      select: { id: true, currentVersionId: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    // Idempotency — if we've already been undone, return 409.
    if (contract.currentVersionId === body.data.previousVersionId) {
      return reply.status(409).send({ detail: 'Already reverted to previous version' })
    }
    await prisma.$transaction(async (tx) => {
      await tx.contract.update({
        where: { id: contract.id },
        data:  { currentVersionId: body.data.previousVersionId },
      })
      // Annotate the reverted version — don't delete it.
      const v = await tx.contractVersion.findUnique({
        where: { id: body.data.newVersionId },
        select: { changeNote: true },
      })
      if (v) {
        await tx.contractVersion.update({
          where: { id: body.data.newVersionId },
          data:  {
            changeNote: `${v.changeNote ?? ''}  (reverted via undo)`.trim(),
          },
        })
      }
    })
    return reply.send({ ok: true, undone: true, currentVersionId: body.data.previousVersionId })
  })

  // ── POST /internal/ai/tools/contract_create_from_template (P1.1) ───────────
  // Generate a draft from a template + persist it as a new Contract +
  // ContractVersion(v1). Reversible via soft-delete on the contract row.
  //
  // This is the tool that turns @draft-from-template into an actual
  // drafting flow — today the skill only describes the draft in natural
  // language. Wired behind Intent Preview so the user sees {template,
  // variables, unfilled} before a row lands.
  app.post('/tools/contract_create_from_template', async (req, reply) => {
    let body
    try { body = ContractCreateFromTemplateSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const template = await prisma.template.findFirst({
      where: { id: body.templateId, orgId: body.orgId, deletedAt: null },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    })
    if (!template) return reply.status(404).send({ detail: 'Template not found in this org' })

    // Resolve clause library references the template's sections point at.
    // Mirrors POST /templates/:id/generate so the output HTML matches what
    // the template preview would show.
    const allClauseRefs = template.sections.flatMap(s =>
      Array.isArray(s.clauseRefs) ? (s.clauseRefs as string[]) : [],
    )
    const clauseItems = allClauseRefs.length
      ? await prisma.clauseLibraryItem.findMany({
          where: { id: { in: allClauseRefs }, orgId: body.orgId, deletedAt: null },
        })
      : []
    const clauseMap = new Map(clauseItems.map(c => [c.id, c]))

    const generated = generateDocument({
      template,
      variables: body.variables as Record<string, string>,
      clauseMap,
    })

    const title =
      body.title?.trim() ||
      (body.counterpartyName
        ? `${template.name} — ${body.counterpartyName}`
        : `Draft — ${template.name}`)
    const contractType = template.contractType ?? 'OTHER'
    const plainText = htmlToPlainText(generated.html)

    const created = await prisma.$transaction(async (tx) => {
      const contract = await tx.contract.create({
        data: {
          orgId: body.orgId,
          title,
          type: contractType,
          status: 'DRAFT',
          counterpartyName: body.counterpartyName,
          ownerId: body.userId,
          // Contract uses `createdBy` (not `createdById`) and has no
          // `updatedById` column — mirrors what POST /contracts does.
          createdBy: body.userId,
          // analysisStatus stays null — user will kick off analyze when
          // they're ready (a fresh template-generated draft doesn't need
          // AI risk-scoring on minute one).
          tags: ['template-draft'],
        },
      })
      const version = await tx.contractVersion.create({
        data: {
          contractId: contract.id,
          versionNumber: 1,
          htmlContent: generated.html,
          plainText,
          changeNote: `Generated from template "${template.name}"`,
          createdById: body.userId,
        },
      })
      await tx.contract.update({
        where: { id: contract.id },
        data:  { currentVersionId: version.id },
      })
      // Bump the template's usage counter for the /templates admin view.
      await tx.template.update({
        where: { id: template.id },
        data:  { usageCount: { increment: 1 } },
      })
      return { contract, version }
    })

    // Wave 3.2 — index the new draft in ES so it's findable via
    // portfolio_search / contract_search immediately (mirrors the AI-draft
    // sibling below). We have the real plainText here. Fire-and-forget.
    indexContract(created.contract.id, {
      orgId:            body.orgId,
      title:            created.contract.title,
      type:             created.contract.type,
      status:           created.contract.status,
      counterpartyName: created.contract.counterpartyName ?? undefined,
      plainText,
      tags:             created.contract.tags,
      createdAt:        created.contract.createdAt.toISOString(),
    }).catch(() => { /* swallow */ })

    return reply.send({
      ok: true,
      reversible: true,
      contractId: created.contract.id,
      versionId:  created.version.id,
      title:      created.contract.title,
      type:       created.contract.type,
      sectionsIncluded:   generated.sectionsIncluded,
      sectionsExcluded:   generated.sectionsExcluded,
      unfilledVariables:  generated.unfilledVariables,
      // Diff surface for the ActionPreview card — show what got filled.
      diff: [
        { field: 'title',  before: null, after: title },
        { field: 'type',   before: null, after: contractType },
        { field: 'status', before: null, after: 'DRAFT' },
      ],
    })
  })

  // ── POST /internal/ai/tools/contract_create_from_template/undo (P1.1) ──────
  // Soft-delete the contract. We don't remove its ContractVersion — keeping
  // it around is cheap and preserves the diff history if the user un-undoes
  // (rare but possible via manual admin).
  app.post('/tools/contract_create_from_template/undo', async (req, reply) => {
    const body = z.object({
      orgId:      z.string().min(1),
      contractId: z.string().min(1),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ detail: 'Invalid request', issues: body.error.issues })
    }
    const existing = await prisma.contract.findFirst({
      where: { id: body.data.contractId, orgId: body.data.orgId, deletedAt: null },
      select: { id: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found or already undone' })
    await prisma.contract.update({
      where: { id: existing.id },
      data:  { deletedAt: new Date() },
    })
    return reply.send({ ok: true, undone: true, contractId: existing.id })
  })

  // ── POST /internal/ai/tools/obligations_list (P5.1) ────────────────────────
  // Surface obligations the org is tracking. When contractId is set,
  // returns that contract's obligations; otherwise aggregates across
  // the org (useful for "what's due next quarter?"). Filters by type
  // + upcoming-window.
  app.post('/tools/obligations_list', async (req, reply) => {
    let body
    try { body = ObligationsListSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    // P8 Step 1 — read from the Obligation table, not contract.metadata.
    const where: Record<string, unknown> = { orgId: body.orgId }
    if (body.contractId) where.contractId = body.contractId
    if (body.type)       where.type = body.type

    // Pull contracts up-front so we can join titles + flag contracts
    // that haven't been extracted yet (the empty-state diagnostic).
    const contractWhere: Record<string, unknown> = { orgId: body.orgId, deletedAt: null }
    if (body.contractId) contractWhere.id = body.contractId
    const contracts = await prisma.contract.findMany({
      where: contractWhere as never,
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, effectiveDate: true, expiryDate: true,
      },
      take: body.contractId ? 1 : 500,
    })
    const contractById = new Map(contracts.map(c => [c.id, c]))

    const obligations = await prisma.obligation.findMany({
      where: where as never,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      take: 5_000,
    })

    // P7.7.3 / F-83 — recurring obligations (monthly / quarterly / annual)
    // shouldn't be dropped just because their FIRST dueDate is in the
    // past. Treat any non-"once"/"one_time" recurrence as still active.
    const RECURRING = new Set(['monthly', 'quarterly', 'annual', 'annually', 'weekly', 'biennial'])
    const items: Array<Record<string, unknown>> = []
    const cutoff = body.dueWithin
      ? Date.now() + body.dueWithin * 24 * 3600 * 1000
      : null

    const seen = new Set<string>()
    for (const o of obligations) {
      const c = contractById.get(o.contractId)
      if (!c) continue
      seen.add(c.id)
      if (cutoff) {
        const isRecurring = RECURRING.has((o.recurrence ?? '').toLowerCase())
        if (o.dueDate && !isRecurring) {
          const due = o.dueDate.getTime()
          if (isNaN(due) || due > cutoff) continue
        }
      }
      items.push({
        id:               o.id,
        type:             o.type,
        description:      o.description,
        owner:            o.owner,
        dueDate:          o.dueDate ? o.dueDate.toISOString().slice(0, 10) : null,
        recurrence:       o.recurrence,
        trigger:          o.trigger,
        quote:            o.quote,
        severity:         o.severity,
        sectionRef:       o.sectionRef,
        status:           o.status,
        completedAt:      o.completedAt?.toISOString() ?? null,
        notifiedAt:       o.notifiedAt?.toISOString() ?? null,
        contractId:       c.id,
        contractTitle:    c.title,
        contractType:     c.type,
        contractStatus:   c.status,
        counterpartyName: c.counterpartyName,
      })
    }
    // P7.7.3 — track contracts that had no obligations at all so we can
    // hint at what to run next when the answer is empty.
    const contractsWithoutObligations = contracts
      .filter(c => !seen.has(c.id))
      .map(c => ({ id: c.id, title: c.title }))

    return reply.send({
      items: items.slice(0, body.limit),
      total: items.length,
      contractId: body.contractId ?? null,
      // P7.7.3 / F-83 — When the answer is empty, surface "X contracts
      // have no extracted obligations" so the chat can suggest running
      // /extract-obligations rather than saying "no obligations" when
      // really we never asked the LLM.
      diagnostic: items.length === 0 && contractsWithoutObligations.length > 0
        ? {
            kind: 'no_obligations_extracted',
            message: `${contractsWithoutObligations.length} contract${contractsWithoutObligations.length === 1 ? '' : 's'} have not had obligations extracted yet. Run "Extract obligations" on the relevant contract pages first.`,
            contractsAwaitingExtraction: contractsWithoutObligations.slice(0, 5),
          }
        : null,
    })
  })

  // ── POST /internal/ai/tools/renewal_advice (P5.3) ──────────────────────────
  // Read-only surface over Contract.metadata.renewalAdvice + expiryDate.
  // Called by the renewal_advice agent tool so the chat can answer
  // "what do you recommend we do about the Acme MSA renewal?" with
  // the cached LLM output + the recommendation counts across any
  // upcoming-window portfolio view.
  app.post('/tools/renewal_advice', async (req, reply) => {
    let body
    try { body = RenewalAdviceSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const where: Record<string, unknown> = { orgId: body.orgId, deletedAt: null }
    if (body.contractId) {
      where.id = body.contractId
    } else {
      const now = Date.now()
      where.expiryDate = {
        lte: new Date(now + body.leadDays * 24 * 3600 * 1000),
        gte: new Date(now - 30 * 24 * 3600 * 1000),
      }
      where.status = 'EXECUTED'
    }

    const contracts = await prisma.contract.findMany({
      where: where as never,
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, metadata: true, effectiveDate: true,
        expiryDate: true, value: true, currency: true,
      },
      take: body.contractId ? 1 : Math.min(body.limit * 3, 300),
      orderBy: { expiryDate: 'asc' },
    })

    type Advice = {
      recommendation?: string; confidence?: string; rationale?: string
      negotiationPoints?: Array<Record<string, unknown>>
      riskFlags?: string[]; timeline?: string; generatedAt?: string
    }
    const items = contracts.map(c => {
      const md = (c.metadata ?? {}) as {
        renewalAdvice?: Advice
        renewalDecision?: string
        renewalNotifiedAt?: string
      }
      const expiry = c.expiryDate ? c.expiryDate.getTime() : null
      const daysOut = expiry
        ? Math.round((expiry - Date.now()) / (24 * 3600 * 1000))
        : null
      return {
        contractId:       c.id,
        contractTitle:    c.title,
        contractType:     c.type,
        contractStatus:   c.status,
        counterpartyName: c.counterpartyName,
        expiryDate:       c.expiryDate ? c.expiryDate.toISOString().slice(0, 10) : null,
        daysUntilExpiry:  daysOut,
        value:            c.value ? c.value.toString() : null,
        currency:         c.currency,
        renewalAdvice:    md.renewalAdvice ?? null,
        renewalDecision:  md.renewalDecision ?? null,
        renewalNotifiedAt: md.renewalNotifiedAt ?? null,
      }
    }).slice(0, body.limit)

    // Portfolio-level recommendation counts
    const counts: Record<string, number> = { renew: 0, renegotiate: 0, let_expire: 0, pause: 0, unadvised: 0 }
    for (const it of items) {
      const r = it.renewalAdvice?.recommendation
      if (r && counts[r] !== undefined) counts[r]++
      else counts.unadvised++
    }

    return reply.send({
      items,
      total:  items.length,
      counts,
      contractId: body.contractId ?? null,
    })
  })

  // ── POST /internal/ai/tools/org_memory (P4.4) ──────────────────────────────
  // One-stop retrieval over the org's institutional memory:
  //   1. Playbook positions for the matching category
  //   2. Approved clause library items tagged with the topic
  //   3. Representative excerpts from signed contracts (via clause
  //      search over the same topic + clauseType)
  // The agent can answer "what's our typical liability cap?" from a
  // single call instead of chaining playbook_check + clause_search +
  // counterparty_memory itself.
  app.post('/tools/org_memory', async (req, reply) => {
    let body
    try { body = OrgMemorySchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    // Pick the category that best matches the topic — normalise both
    // sides (docs/28 C.2.1 match rule).
    const topicKey = normalisedKey(body.topic)
    const categories = await prisma.clauseCategory.findMany({
      where: { orgId: body.orgId },
      select: { id: true, name: true },
    })
    const matchCategory = categories.find(c => {
      const k = normalisedKey(c.name)
      return k === topicKey || k.includes(topicKey) || topicKey.includes(k)
    })

    // 1) Playbook positions for that category (type-filtered when set).
    const playbook = matchCategory
      ? await prisma.playbookPosition.findMany({
          where: {
            orgId: body.orgId,
            clauseCategoryId: matchCategory.id,
            ...(body.contractType
              ? { OR: [{ contractTypes: { isEmpty: true } }, { contractTypes: { has: body.contractType } }] }
              : {}),
          },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true, positionType: true, content: true, notes: true,
            riskThreshold: true, contractTypes: true, rules: true,
          },
        })
      : []

    // 2) Clause-library items tagged with the topic or under that
    //    category, approved-only by default.
    const clauseLibrary = await prisma.clauseLibraryItem.findMany({
      where: {
        orgId: body.orgId,
        deletedAt: null,
        isApproved: true,
        OR: [
          { title:  { contains: body.topic, mode: 'insensitive' } },
          { tags:   { has: body.topic.toLowerCase() } },
          ...(matchCategory ? [{ categoryId: matchCategory.id }] : []),
        ],
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: body.limit,
      select: {
        id: true, title: true, content: true, tags: true,
        riskRating: true, categoryId: true, updatedAt: true,
      },
    })

    // 3) Past-deal representative excerpts. Pull clauses from contracts
    //    of the matching clauseType (if supplied, else by category name
    //    normalised to clauseType), cap at topK.
    const clauseTypeFilter = body.clauseType
      ?? (matchCategory ? matchCategory.name.replace(/\s+/g, '_').toLowerCase() : undefined)

    const pastDeals: Array<Record<string, unknown>> = []
    if (clauseTypeFilter) {
      const clauses = await prisma.contractClause.findMany({
        where: {
          clauseType: clauseTypeFilter,
          isSubChunk: false,
          version: {
            contract: {
              orgId: body.orgId,
              deletedAt: null,
              ...(body.contractType ? { type: body.contractType } : {}),
              status: { in: ['EXECUTED', 'APPROVED', 'PENDING_SIGNATURE'] },
            },
          },
        },
        orderBy: { id: 'desc' },
        take: body.limit,
        select: {
          id: true, clauseType: true, content: true, sectionRef: true,
          riskRating: true,
          version: {
            select: {
              contractId: true,
              contract: {
                select: {
                  title: true, counterpartyName: true, status: true,
                  effectiveDate: true,
                },
              },
            },
          },
        },
      })
      for (const cl of clauses) {
        pastDeals.push({
          clauseId:         cl.id,
          contractId:       cl.version?.contractId ?? null,
          contractTitle:    cl.version?.contract?.title ?? null,
          counterpartyName: cl.version?.contract?.counterpartyName ?? null,
          status:           cl.version?.contract?.status ?? null,
          effectiveDate:    cl.version?.contract?.effectiveDate ?? null,
          sectionRef:       cl.sectionRef,
          riskRating:       cl.riskRating,
          excerpt:          cl.content.slice(0, 500),
        })
      }

      // P7.5.1 — `excerpt` is verbatim clause text from executed deals,
      // pulled across many contracts and shipped to the LLM. Redact the
      // whole page in one batch: one policy read, one PII_REDACTED audit
      // row for the call. No contractId on the audit event because the
      // excerpts span multiple contracts.
      //
      // Everything else on the card is structured metadata the agent
      // needs to answer the question at all (which deal, whose, when,
      // what section, how risky) and stays raw.
      const excerptIdx: number[] = []
      const excerptTexts: string[] = []
      pastDeals.forEach((d, i) => {
        if (typeof d.excerpt === 'string' && d.excerpt.length > 0) {
          excerptIdx.push(i)
          excerptTexts.push(d.excerpt)
        }
      })
      const redacted = await redactExcerpts(body.orgId, excerptTexts, {
        surface: 'org_memory.excerpt',
      })
      excerptIdx.forEach((dealIndex, k) => {
        const d = pastDeals[dealIndex]
        if (d) d.excerpt = redacted[k] ?? d.excerpt
      })
    }

    return reply.send({
      topic:           body.topic,
      contractType:    body.contractType ?? null,
      clauseType:      clauseTypeFilter ?? null,
      matchedCategory: matchCategory ?? null,
      playbook:        playbook.map(p => ({
        positionType:  p.positionType,
        content:       p.content,
        notes:         p.notes,
        riskThreshold: p.riskThreshold,
        contractTypes: p.contractTypes,
        hasRules:      !!p.rules && Object.keys((p.rules ?? {}) as object).length > 0,
      })),
      clauseLibrary,
      pastDeals,
      summary: {
        playbookCount:     playbook.length,
        clauseLibraryCount: clauseLibrary.length,
        pastDealCount:     pastDeals.length,
      },
    })
  })

  // ── POST /internal/ai/tools/approval_list (P4.5) ───────────────────────────
  // "What's pending my approval?" — my-queue by default, with
  // filters when the caller wants something else.
  app.post('/tools/approval_list', async (req, reply) => {
    let body
    try { body = ApprovalListSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const stepWhere: Record<string, unknown> = { orgId: body.orgId }
    if (body.scope === 'my-queue') {
      stepWhere.approverId = body.userId
      stepWhere.status = body.status ?? 'PENDING'
    } else if (body.status) {
      stepWhere.status = body.status
    }

    const steps = await prisma.approvalStep.findMany({
      where: stepWhere as never,
      orderBy: { createdAt: 'asc' },
      take: body.limit,
    })
    if (steps.length === 0) return reply.send({ items: [], total: 0 })

    const instanceIds = [...new Set(steps.map(s => s.approvalInstanceId))]
    const instances = await prisma.approvalInstance.findMany({
      where: { id: { in: instanceIds } },
      select: {
        id: true, status: true, submittedAt: true, submittedById: true,
        contractId: true, aiSummary: true, approvalRecommendation: true,
      },
    })
    const contractIds = [...new Set(instances.map(i => i.contractId))]
    const contracts = await prisma.contract.findMany({
      where: { id: { in: contractIds }, orgId: body.orgId, deletedAt: null },
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, value: true, currency: true, riskScore: true,
      },
    })
    const instById = new Map(instances.map(i => [i.id, i]))
    const ctrById  = new Map(contracts.map(c => [c.id, c]))

    const items = steps.map(s => {
      const inst = instById.get(s.approvalInstanceId)
      const ctr  = inst ? ctrById.get(inst.contractId) : null
      return {
        stepId:     s.id,
        stepName:   s.stepName,
        stepOrder:  s.stepOrder,
        status:     s.status,
        escalateAt: s.escalateAt,
        instanceId: s.approvalInstanceId,
        contract:   ctr ?? null,
        instance:   inst ? {
          status:                 inst.status,
          submittedAt:            inst.submittedAt,
          aiSummary:              inst.aiSummary?.slice(0, 400) ?? null,
          approvalRecommendation: inst.approvalRecommendation,
        } : null,
      }
    })
    return reply.send({ items, total: items.length, scope: body.scope })
  })

  // ── POST /internal/ai/tools/counterparty_get (P4.5) ────────────────────────
  app.post('/tools/counterparty_get', async (req, reply) => {
    let body
    try { body = CounterpartyGetSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    if (!body.id && !body.name) {
      return reply.status(400).send({ detail: 'Either id or name is required' })
    }

    const where: Record<string, unknown> = { orgId: body.orgId, deletedAt: null }
    if (body.id)   where.id = body.id
    if (body.name) where.name = { contains: body.name, mode: 'insensitive' }

    const cps = await prisma.counterparty.findMany({
      where: where as never,
      select: {
        id: true, name: true, legalName: true,
        email: true, phone: true, address: true,
        website: true, crmId: true, contacts: true,
        createdAt: true, updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: body.id ? 1 : 10,
    })
    if (cps.length === 0) {
      return reply.status(404).send({ detail: 'No counterparty matched' })
    }

    const items = await Promise.all(cps.map(async cp => {
      const contractCount = await prisma.contract.count({
        where: { counterpartyId: cp.id, orgId: body.orgId, deletedAt: null },
      })
      return {
        id:            cp.id,
        name:          cp.name,
        legalName:     cp.legalName,
        email:         cp.email,
        phone:         cp.phone,
        address:       cp.address,
        website:       cp.website,
        crmId:         cp.crmId,
        contacts:      cp.contacts, // already JSON: [{name, email, role, phone}]
        contractCount,
        createdAt:     cp.createdAt,
        updatedAt:     cp.updatedAt,
      }
    }))
    return reply.send({ items, total: items.length })
  })

  // ── POST /internal/ai/tools/counterparty_list (P3 audit, 2026-04-29) ──────
  // List counterparties for the org with their contract count + total value.
  // Ranking is done in the DB so the agent doesn't have to. Closes the
  // "name 5 of my counterparties" hallucination path.
  app.post('/tools/counterparty_list', async (req, reply) => {
    let body
    try { body = CounterpartyListSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const where: Record<string, unknown> = { orgId: body.orgId, deletedAt: null }
    if (body.query?.trim()) {
      where.OR = [
        { name:      { contains: body.query.trim(), mode: 'insensitive' } },
        { legalName: { contains: body.query.trim(), mode: 'insensitive' } },
      ]
    }

    // Pull the candidate set first (counterparties), then aggregate stats
    // separately. This is simpler than a raw SQL groupBy, and the org-scoped
    // counterparty count never exceeds a few hundred in practice.
    const cps = await prisma.counterparty.findMany({
      where: where as never,
      select: { id: true, name: true, legalName: true, updatedAt: true },
      orderBy: body.sortBy === 'name'   ? { name: body.sortOrder } :
               body.sortBy === 'recent' ? { updatedAt: body.sortOrder } :
                                          { name: 'asc' },
      take: body.sortBy === 'name' || body.sortBy === 'recent' ? body.limit : 200,
    })

    // Stats per counterparty: contractCount + sumValue.
    const stats = await prisma.contract.groupBy({
      by: ['counterpartyId'],
      where: { orgId: body.orgId, deletedAt: null, counterpartyId: { in: cps.map(c => c.id) } },
      _count: { _all: true },
      _sum:   { value: true },
    })
    const byId = new Map(stats.map(s => [
      s.counterpartyId,
      { contractCount: s._count._all, sumValue: Number(s._sum.value ?? 0) },
    ]))

    const enriched = cps.map(c => {
      const s = byId.get(c.id) ?? { contractCount: 0, sumValue: 0 }
      return {
        id:            c.id,
        name:          c.name,
        legalName:     c.legalName,
        contractCount: s.contractCount,
        sumValue:      s.sumValue,
        updatedAt:     c.updatedAt,
      }
    })

    let sorted = enriched
    if (body.sortBy === 'contracts') {
      sorted = enriched.sort((a, b) => body.sortOrder === 'desc'
        ? b.contractCount - a.contractCount
        : a.contractCount - b.contractCount)
    } else if (body.sortBy === 'value') {
      sorted = enriched.sort((a, b) => body.sortOrder === 'desc'
        ? b.sumValue - a.sumValue
        : a.sumValue - b.sumValue)
    }

    return reply.send({ total: sorted.length, items: sorted.slice(0, body.limit) })
  })

  // ── POST /internal/ai/tools/request_list (P4.5) ────────────────────────────
  app.post('/tools/request_list', async (req, reply) => {
    let body
    try { body = RequestListSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const where: Record<string, unknown> = { orgId: body.orgId, deletedAt: null }
    if (body.status)       where.status       = body.status
    if (body.assignedToId) where.assignedToId = body.assignedToId
    if (body.priority)     where.priority     = body.priority
    if (body.type)         where.type         = body.type

    const requests = await prisma.contractRequest.findMany({
      where: where as never,
      select: {
        id: true, requestNumber: true, title: true, type: true, status: true,
        priority: true, source: true, counterpartyName: true,
        description: true, estimatedValue: true,
        requestedById: true, assignedToId: true,
        createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: body.limit,
    })

    return reply.send({
      items:    requests,
      total:    requests.length,
      filters:  {
        status: body.status, assignedToId: body.assignedToId,
        priority: body.priority, type: body.type,
      },
    })
  })

  // ── POST /internal/ai/tools/matter_list (persona-test fix #1) ──────────────
  // Returns the org's matters with optional filters. Designed for the
  // agent to answer "what matters do I own?" / "what's open right now?"
  // without falling back to obligations_list or request_list.
  app.post('/tools/matter_list', async (req, reply) => {
    let body
    try { body = MatterListSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const where: Record<string, unknown> = { orgId: body.orgId, deletedAt: null }
    if (body.ownerId)          where.ownerId = body.ownerId
    if (body.status)           where.status  = body.status
    if (body.counterpartyName) where.counterpartyName = { contains: body.counterpartyName, mode: 'insensitive' }
    if (body.query) {
      where.OR = [
        { name:        { contains: body.query, mode: 'insensitive' } },
        { description: { contains: body.query, mode: 'insensitive' } },
      ]
    }

    const matters = await prisma.matter.findMany({
      where: where as never,
      select: {
        id: true, name: true, description: true, status: true,
        counterpartyName: true, ownerId: true, tags: true,
        createdAt: true, updatedAt: true,
        _count: { select: { contracts: true, requests: true, threads: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: body.limit,
    })

    return reply.send({
      items: matters.map(m => ({
        id: m.id, name: m.name, description: m.description, status: m.status,
        counterpartyName: m.counterpartyName, ownerId: m.ownerId, tags: m.tags,
        createdAt: m.createdAt, updatedAt: m.updatedAt,
        contractCount: m._count.contracts,
        requestCount:  m._count.requests,
        threadCount:   m._count.threads,
      })),
      total:   matters.length,
      filters: {
        ownerId: body.ownerId, status: body.status,
        counterpartyName: body.counterpartyName, query: body.query,
      },
    })
  })

  // ── POST /internal/ai/tools/contract_draft ────────────────────────────────
  // Intent-based drafting: takes a free-text user_message, picks the org's
  // best-fit published template by contractType, renders via generateDocument
  // (same engine as POST /templates/:id/generate), and persists a new
  // Contract + ContractVersion in DRAFT status. Returns the artifact-shaped
  // payload the AgentHomePage Doc artifact expects.
  //
  // Distinct from /tools/contract_create_from_template (line ~2525) which
  // requires an explicit templateId + pre-resolved variables. The agent
  // rarely knows the templateId or the variable shape; this handler removes
  // both gaps by doing template lookup + variable inference in one step.
  //
  // Implemented entirely in Node (no Python /draft hop) because the existing
  // /api/v1/templates endpoint is auth-gated by user permission and the
  // Python pipeline's x-internal-secret was being ignored — empty results,
  // NO_TEMPLATE_MATCH every time. Direct Prisma access bypasses that mess.
  app.post('/tools/contract_draft', async (req, reply) => {
    let body
    try { body = ContractDraftFromIntentSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    // Infer contract type from the explicit hint OR by sniffing the message.
    const lowerMsg = body.userMessage.toLowerCase()
    const inferredType =
      body.contractType ??
      (lowerMsg.includes(' nda') || lowerMsg.startsWith('nda') || lowerMsg.includes('non-disclosure') || lowerMsg.includes('confidential disclosure') ? 'NDA' :
       lowerMsg.includes(' msa') || lowerMsg.includes('master service') ? 'MSA' :
       lowerMsg.includes(' sow') || lowerMsg.includes('statement of work') ? 'SOW' :
       lowerMsg.includes('vendor') ? 'VENDOR_AGREEMENT' :
       lowerMsg.includes('license') ? 'LICENSE' :
       lowerMsg.includes('employment') || lowerMsg.includes('offer letter') ? 'EMPLOYMENT' :
       lowerMsg.includes(' dpa') || lowerMsg.includes('data processing') ? 'DATA_PROCESSING' :
       null)

    if (!inferredType) {
      return reply.status(422).send({
        error: 'CONTRACT_TYPE_AMBIGUOUS',
        detail: 'Could not determine contract type from the message. Pass contract_type explicitly (NDA | MSA | SOW | VENDOR_AGREEMENT | LICENSE | EMPLOYMENT | DATA_PROCESSING).',
      })
    }

    // Find the best-fit published template for this org + type. Prefer the
    // most-recently-updated published one if multiple exist.
    const template = await prisma.template.findFirst({
      where: {
        orgId: body.orgId, deletedAt: null,
        contractType: inferredType,
        isPublished: true,
      },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    })
    if (!template) {
      return reply.status(422).send({
        error: 'NO_TEMPLATE_MATCH',
        detail: `Your org doesn't have a published ${inferredType} template. Create one in Templates first, or I can quote draft text inline.`,
      })
    }

    // Resolve clause library references the template's sections point at.
    // Mirrors what /tools/contract_create_from_template does and what
    // POST /templates/:id/generate does for preview.
    const allClauseRefs = template.sections.flatMap(s =>
      Array.isArray(s.clauseRefs) ? (s.clauseRefs as string[]) : [],
    )
    const clauseItems = allClauseRefs.length
      ? await prisma.clauseLibraryItem.findMany({
          where: { id: { in: allClauseRefs }, orgId: body.orgId, deletedAt: null },
        })
      : []
    const clauseMap = new Map(clauseItems.map(c => [c.id, c]))

    // Build a sensible default variable map. The agent can iterate later
    // by editing the contract directly. Variable keys we recognize:
    const today = new Date().toISOString().slice(0, 10)
    const orgName = (await prisma.organization.findUnique({
      where: { id: body.orgId }, select: { name: true },
    }))?.name ?? 'Our Organization'
    const variables: Record<string, string> = {
      counterparty_name: body.counterpartyName ?? '[Counterparty Name]',
      counterpartyName:  body.counterpartyName ?? '[Counterparty Name]',
      counterparty:      body.counterpartyName ?? '[Counterparty Name]',
      our_company:       orgName,
      our_org_name:      orgName,
      effective_date:    today,
      effectiveDate:     today,
      date:              today,
      governing_law:     'California',
      governingLaw:      'California',
      term_years:        '2',
      term:              '2 years',
    }

    const generated = generateDocument({
      template,
      variables,
      clauseMap,
    })

    // Title fallback: counterparty + type if both known, else template name.
    const computedTitle = body.title?.trim()
      || (body.counterpartyName ? `${body.counterpartyName} — ${inferredType}` : `Draft — ${template.name}`)

    const plainText = generated.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const created = await prisma.$transaction(async (tx) => {
      const contract = await tx.contract.create({
        data: {
          orgId:            body.orgId,
          title:            computedTitle,
          type:             inferredType,
          status:           'DRAFT',
          counterpartyName: body.counterpartyName ?? null,
          ownerId:          body.userId,
          createdBy:        body.userId,
          analysisStatus:   'DONE',
          tags:             ['agent-draft'],
        },
      })
      const version = await tx.contractVersion.create({
        data: {
          contractId:    contract.id,
          versionNumber: 1,
          htmlContent:   generated.html,
          plainText,
          changeNote:    `AI-drafted from template "${template.name}"`,
          createdById:   body.userId,
        },
      })
      await tx.contract.update({
        where: { id: contract.id },
        data:  { currentVersionId: version.id },
      })
      await tx.template.update({
        where: { id: template.id },
        data:  { usageCount: { increment: 1 } },
      })
      return { contract, version }
    })

    // Index the new draft in ES so it's findable via portfolio_search /
    // contract_search immediately. Fire-and-forget.
    indexContract(created.contract.id, {
      orgId:            body.orgId,
      title:            created.contract.title,
      type:             created.contract.type,
      status:           created.contract.status,
      counterpartyName: created.contract.counterpartyName ?? undefined,
      plainText,
      tags:             created.contract.tags,
      createdAt:        created.contract.createdAt.toISOString(),
    }).catch(() => { /* swallow */ })

    return reply.send({
      // Fields consumed by artifact-from-tool.ts (Doc artifact)
      title:    created.contract.title,
      subtitle: body.counterpartyName ? `Draft ${inferredType} for ${body.counterpartyName}` : `Draft ${inferredType}`,
      html:     generated.html,
      contractId: created.contract.id,
      // Metadata for the agent's natural-language summary
      contractType:     inferredType,
      counterpartyName: created.contract.counterpartyName,
      templateName:     template.name,
      versionId:        created.version.id,
      sectionsIncluded: generated.sectionsIncluded,
      unfilledVariables: generated.unfilledVariables,
    })
  })

  // ── POST /internal/ai/tools/custom_field_list (P4.5) ───────────────────────
  app.post('/tools/custom_field_list', async (req, reply) => {
    let body
    try { body = CustomFieldListSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }

    const where: Record<string, unknown> = { orgId: body.orgId, deletedAt: null }
    if (body.contractType) {
      // Custom fields are scoped to a single contractType OR apply
      // to all types (null). Match both.
      where.OR = [
        { contractType: body.contractType },
        { contractType: null },
      ]
    }

    const defs = await prisma.contractFieldDefinition.findMany({
      where: where as never,
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, fieldKey: true, fieldLabel: true, helpText: true,
        fieldType: true, required: true, options: true,
        contractType: true, sortOrder: true,
      },
    })

    return reply.send({
      items:        defs,
      total:        defs.length,
      contractType: body.contractType ?? null,
    })
  })

  // ── POST /internal/ai/tools/compliance_get (Phase 10 — Compliance Agent) ───
  // Read the persisted regulatory compliance report from
  // Contract.metadata._compliance (written by POST /contracts/:id/
  // compliance-check). Fast read — the agent answers "is this GDPR
  // compliant?" from the stored report instead of re-running the LLM
  // pass; when none exists it tells the user where to run one.
  const ComplianceGetSchema = z.object({
    orgId:      z.string().min(1),
    contractId: z.string().min(1),
  })
  app.post('/tools/compliance_get', async (req, reply) => {
    let body
    try { body = ComplianceGetSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    const contract = await prisma.contract.findFirst({
      where: { id: body.contractId, orgId: body.orgId, deletedAt: null },
      select: { id: true, title: true, type: true, metadata: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found in this org' })
    const report = ((contract.metadata ?? {}) as Record<string, unknown>)._compliance ?? null
    return reply.send({
      contractId: contract.id,
      title:      contract.title,
      type:       contract.type,
      report,
      note: report
        ? undefined
        : 'No compliance check has been run on this contract yet. The user can run one from the Compliance section on the contract page (or POST /contracts/:id/compliance-check).',
    })
  })

  // ── POST /internal/ai/tools/portfolio_compare ──────────────────────────────
  // P-fix #2 (2026-05-02). Multi-doc compare. Closes the "compare these N
  // contracts side-by-side" gap that Harvey/Ironclad serve natively.
  // Inputs: contractIds[2..10] + topics[1..10]. Outputs a structured
  // matrix (topic × contract) so the agent renders a real table, not a
  // 3× parallel portfolio_search prose synthesis.
  const PortfolioCompareSchema = z.object({
    orgId:        z.string(),
    contractIds:  z.array(z.string()).min(2).max(10),
    topics:       z.array(z.string().min(2).max(80)).min(1).max(10),
    excerptChars: z.number().int().min(50).max(800).default(220),
  })
  app.post('/tools/portfolio_compare', async (req, reply) => {
    let body
    try { body = PortfolioCompareSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    const contracts = await prisma.contract.findMany({
      where: { id: { in: body.contractIds }, orgId: body.orgId, deletedAt: null },
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, value: true, currency: true,
        currentVersionId: true,
      },
    })
    const versionIds = contracts.map(c => c.currentVersionId).filter(Boolean) as string[]
    const versions = versionIds.length > 0 ? await prisma.contractVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, contractId: true, plainText: true },
    }) : []
    const textByContract = new Map(versions.map(v => [v.contractId, v.plainText ?? '']))
    const half = Math.floor(body.excerptChars / 2)
    const matrix = body.topics.map(topic => {
      const tLower = topic.toLowerCase()
      const perContract = contracts.map(c => {
        const text = textByContract.get(c.id) ?? ''
        if (!text) return { contractId: c.id, sectionRef: null, excerpt: '', found: false }
        const lower = text.toLowerCase()
        const idx = lower.indexOf(tLower)
        if (idx === -1) return { contractId: c.id, sectionRef: null, excerpt: '', found: false }
        const start = Math.max(0, idx - half)
        const end   = Math.min(text.length, idx + topic.length + half)
        const excerpt = text.slice(start, end)
        const back = text.slice(Math.max(0, idx - 500), idx)
        const sec = back.match(/\n\s*(\d+(?:\.\d+)*)[.\s)]/g)
        const sectionRef = sec ? sec[sec.length - 1].trim().replace(/[.\s)]+$/, '') : null
        return { contractId: c.id, sectionRef, excerpt, found: true }
      })
      const foundCount = perContract.filter(p => p.found).length
      return { topic, foundCount, perContract }
    })

    // P21 PII boundary. Every cell excerpt is raw document text bound for
    // the LLM. A 10-topic × 10-contract matrix is up to 100 excerpts, so
    // flatten and redact in ONE batch call (one policy read, one audit
    // row) and map back by position — order, scoring and `found` flags
    // are untouched. Structured cell fields (contractId, sectionRef) and
    // the contracts[] metadata block stay raw on purpose.
    let redactedMatrix = matrix
    try {
      const flat = matrix.flatMap(row => row.perContract.map(cell => cell.excerpt))
      const { texts } = await applyPiiPolicyBatch(body.orgId, flat, {
        surface: 'portfolio_compare.excerpt',
      })
      let i = 0
      redactedMatrix = matrix.map(row => ({
        ...row,
        perContract: row.perContract.map(cell => {
          const text = texts[i++]
          return { ...cell, excerpt: text ?? cell.excerpt }
        }),
      }))
    } catch (err) {
      // Redaction must never break the tool call.
      console.error('[portfolio_compare] PII redaction failed, returning unredacted excerpts:', err)
    }

    return reply.send({
      contracts: contracts.map(c => ({
        id: c.id, title: c.title, type: c.type, status: c.status,
        counterpartyName: c.counterpartyName,
        value: c.value != null ? Number(c.value) : null,
        currency: c.currency,
      })),
      topics: body.topics,
      matrix: redactedMatrix,
    })
  })
}

// Minimal HTML → plaintext helper for storing the generated body as
// searchable text. A heavier sanitiser (striptags + list bullets) isn't
// needed today — later D.5 phases (F.2 structural extractor) will
// replace this with a proper tree walker.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
