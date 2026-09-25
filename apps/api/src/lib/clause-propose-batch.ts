/**
 * Propose rewrites for many clauses in one pass.
 *
 * The single-clause path (`clause-propose.ts`) asks the model for three
 * aggression variants so a human can pick a posture. A whole-document redline
 * picks the posture once and keeps one rewrite per clause, so looping that path
 * would cost N reasoning-tier calls to produce 3N variants and discard 2N.
 *
 * Two things this does that the single-clause path does not:
 *
 *   1. Sends ALL position types for a clause's category, not just `preferred`.
 *      A negotiator aims at `acceptable` or `fallback` when `preferred` is
 *      unreachable; the rewriter could not see those positions at all.
 *   2. Loads every clause's playbook context separately and sends it alongside
 *      that clause. Handing the model many clauses and one shared playbook
 *      yields plausible rewrites aimed at the wrong targets, and nothing in the
 *      output would say so.
 *
 * Concurrency is bounded inside the Python route rather than here, so any
 * caller gets the limit — see `_BATCH_CONCURRENCY` in `app/routes/assist.py`.
 */
import { redactJson, restorePii } from './pii-policy.js'
import { prisma } from './prisma.js'
import { matchCategory, normalisedKey } from './clause-category.js'
import { htmlBlocks } from './ooxml/html-blocks.js'
import { modelFetch } from './model-boundary.js'

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8002'

/** How hard to push. Chosen once for the whole document, not per clause. */
export type Aggression = 'least' | 'moderate' | 'aggressive'

export interface BatchProposal {
  clauseId:      string
  clauseType:    string | null
  /** Absent when this clause could not be rewritten — see `error`. */
  proposedText?: string
  rationale?:    string
  changes?:      Array<{ before: string; after: string; reason?: string }>
  aggression?:   Aggression
  /**
   * Why this clause has no rewrite. Present instead of `proposedText`, never
   * omitted: a missing entry is indistinguishable from a clause that needed no
   * change, which is exactly the silent miss this feature exists to remove.
   */
  error?:        string
}

export interface BatchProposeResult {
  proposals: BatchProposal[]
  requested: number
  succeeded: number
  failed:    number
  model?:    string
  provider?: string
}

export type ProposeBatchOutcome =
  | { ok: true;  data: BatchProposeResult }
  | { ok: false; status: number; detail: string; upstream?: string }

export async function proposeClauseBatch(args: {
  orgId:        string
  contractId:   string
  clauseIds:    string[]
  aggression?:  Aggression
  instructions?: string
  /**
   * Per clause, what the playbook review said: the category it judged the
   * clause against (by name) and why it deviates. The category is used before
   * the clause type's own match, and the reason goes to the rewriter.
   */
  hints?:       Record<string, { category?: string; issue?: string }>
}): Promise<ProposeBatchOutcome> {
  const { orgId, contractId, clauseIds, aggression = 'moderate', instructions, hints = {} } = args

  if (clauseIds.length === 0) {
    return { ok: false, status: 400, detail: 'clauseIds is required' }
  }

  const contract = await prisma.contract.findFirst({
    where:  { id: contractId, orgId, deletedAt: null },
    select: { id: true, type: true, currentVersionId: true },
  })
  if (!contract) return { ok: false, status: 404, detail: 'Contract not found' }
  if (!contract.currentVersionId) {
    return { ok: false, status: 400, detail: 'Contract has no current version' }
  }

  // Scoped to the current version: a clauseId from an older version would
  // rewrite text that is no longer in the document.
  const clauses = await prisma.contractClause.findMany({
    where:  { id: { in: clauseIds }, versionId: contract.currentVersionId },
    select: { id: true, clauseType: true, content: true, sectionRef: true },
  })
  // Each clause is rewritten on its own, and two clauses of one section
  // ("Supplier's liability is capped…", "Customer's liability is unlimited")
  // each came back restating the whole liability regime: two caps, saying
  // different things. Each rewriter now sees its section's other clauses.
  const all = await prisma.contractClause.findMany({
    where:   { versionId: contract.currentVersionId, isSubChunk: false },
    orderBy: { sortOrder: 'asc' },
    select:  { id: true, clauseType: true, content: true, sectionRef: true },
  })
  const siblingsOf = (cl: { id: string; sectionRef: string | null }) => cl.sectionRef
    ? all.filter(o => o.sectionRef === cl.sectionRef && o.id !== cl.id)
        .slice(0, 4)
        .map(o => ({ clauseType: o.clauseType, text: o.content.slice(0, 600), alsoRewritten: clauseIds.includes(o.id) }))
    : []
  if (clauses.length === 0) {
    return { ok: false, status: 404, detail: 'No matching clauses on the current version' }
  }

  // Categories and positions, fetched once for the whole batch rather than per
  // clause — an org has on the order of 3-20 categories.
  const categories = await prisma.clauseCategory.findMany({
    where:  { orgId },
    select: { id: true, name: true },
  })
  const positions = await prisma.playbookPosition.findMany({
    where: {
      orgId,
      OR: [
        { contractTypes: { isEmpty: true } },
        { contractTypes: { has: contract.type } },
      ],
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { clauseCategoryId: true, positionType: true, content: true, rules: true },
  })
  const positionsByCategory = new Map<string, typeof positions>()
  for (const p of positions) {
    const arr = positionsByCategory.get(p.clauseCategoryId) ?? []
    arr.push(p)
    positionsByCategory.set(p.clauseCategoryId, arr)
  }

  const items = clauses.map(cl => {
    const named = hints[cl.id]?.category
    const category = (named && categories.find(c => normalisedKey(c.name) === normalisedKey(named)))
      || matchCategory(categories, cl.clauseType)
    const forClause = category ? (positionsByCategory.get(category.id) ?? []) : []
    return {
      clauseId:   cl.id,
      clauseText: cl.content,
      clauseType: cl.clauseType,
      category:   category?.name ?? null,
      // Every position type, ordered so `preferred` leads.
      positions:  forClause.map(p => ({ positionType: p.positionType, content: p.content })),
      // Rules come from the preferred position — they express the standard,
      // and the fallbacks are prose alternatives to it.
      rules:      (forClause.find(p => p.positionType === 'preferred')?.rules ?? null) as unknown,
      issue:      hints[cl.id]?.issue ?? null,
      siblings:   siblingsOf(cl),
      sectionRef: cl.sectionRef,
    }
  })

  const version = await prisma.contractVersion.findUnique({
    where: { id: contract.currentVersionId }, select: { plainText: true, htmlContent: true },
  })
  const document = version?.plainText ?? ''
  const source = [items, document]
  // The agreement's headings, so a rewrite that refers elsewhere in the
  // agreement names the section ("Section 4 (Indemnification)") rather than
  // leaving "[INSERT RELEVANT SECTION]", which the rewriter refuses.
  // The agreement's own names for the parties and things ("Supplier",
  // "Customer"): playbook language says "Provider" and "Client", and rewrites
  // carried those into a contract that defines neither.
  const definedTerms = [...new Set([...document.matchAll(/\(\s*(?:the\s+|each\s+a\s+)?["\u201c]([A-Z][A-Za-z&' -]{1,40})["\u201d]\s*\)/g)].map(m => m[1].trim()))].slice(0, 40)
  const sections = htmlBlocks(version?.htmlContent ?? '')
    .filter(b => /^h[1-6]$/.test(b.kind) || /^\d{1,2}\.\s+[A-Z]/.test(b.text))
    .map(b => b.text.slice(0, 120))
    .slice(0, 60)

  const res = await modelFetch(`${AGENTS_URL}/redline_propose_batch`, {
    method:  'POST',
    headers: {
      'content-type':      'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    // X23 — the clauses go to the model under the org's PII policy, as
    // round-trip tokens (judged against the whole document): proposals are
    // text to splice into the contract, so the values are put back below.
    body: JSON.stringify({
      clauses:      await redactJson(orgId, items, { surface: 'redline_propose_batch', contractId, roundTrip: contractId, valuesFrom: source }),
      aggression,
      contractType: contract.type,
      instructions,
      orgId,
      sections: await redactJson(orgId, sections, { surface: 'redline_propose_batch', contractId, roundTrip: contractId, valuesFrom: source }),
      definedTerms: await redactJson(orgId, definedTerms, { surface: 'redline_propose_batch', contractId, roundTrip: contractId, valuesFrom: source }),
    }),
  }, { orgId, surface: 'redline_propose_batch', contractId, userAuthored: ['instructions'] })
  if (!res.ok) {
    const upstream = await res.text().catch(() => '')
    return { ok: false, status: 502, detail: 'redline_propose_batch failed', upstream: upstream.slice(0, 300) }
  }

  const body = restorePii(await res.json() as BatchProposeResult, source, contractId)

  // Any clause the caller asked for that the service did not answer on gets an
  // explicit entry. Silence here would read as "no change needed".
  const answered = new Set((body.proposals ?? []).map(p => p.clauseId))
  const missing: BatchProposal[] = clauseIds
    .filter(id => !answered.has(id))
    .map(id => ({
      clauseId:   id,
      clauseType: clauses.find(c => c.id === id)?.clauseType ?? null,
      error:      clauses.some(c => c.id === id) ? 'no_response' : 'clause_not_on_current_version',
    }))

  const proposals = [...(body.proposals ?? []), ...missing]
  return {
    ok: true,
    data: {
      proposals,
      requested: clauseIds.length,
      succeeded: proposals.filter(p => p.proposedText).length,
      failed:    proposals.filter(p => p.error).length,
      model:     body.model,
      provider:  body.provider,
    },
  }
}
