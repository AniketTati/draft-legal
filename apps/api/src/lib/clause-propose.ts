/**
 * Clause alternative proposals — playbook-grounded rewrite variants for a
 * single clause.
 *
 * Extracted out of the internal-ai route so a USER-FACING endpoint can reuse it.
 * Every route in internal-ai.ts sits behind the x-internal-secret hook, so the
 * browser could never reach this: the proposer existed but only fired when the
 * chat agent chose to call it. The review drawer needs the same capability
 * directly, hence a shared implementation rather than a self-HTTP call.
 */
import { redactJson, restorePii } from './pii-policy.js'
import { prisma } from './prisma.js'
import { findCategoryForClauseType } from './clause-category.js'
import { modelFetch } from './model-boundary.js'

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8002'

export interface ProposalVariant {
  aggression:   string
  proposedText: string
  rationale:    string
  changes:      Array<{ before: string; after: string; reason: string }>
}

export interface ProposalPayload {
  contract:    { id: string; title: string; type: string }
  clause:      { id: string; clauseType: string; sectionRef: string | null; originalText: string }
  category:    { id: string; name: string } | null
  hasPlaybook: boolean
  variants:    ProposalVariant[]
  error?:      string
}

/** X53 — a clause the caller can target, listed when the one asked for isn't found. */
export interface TargetableClause { id: string; clauseType: string; sectionRef: string | null; content: string }

export type ProposeResult =
  | { ok: true;  data: ProposalPayload }
  | { ok: false; status: number; detail: string; upstream?: string; clauses?: TargetableClause[]; totalClauses?: number }

/** X53 — the clauses listed on a miss, at most. */
export const LISTED_CLAUSES = 60

/**
 * X53 — "§4", "Section 4", "Sections 4", "sect. 4", "4." and "04" name the
 * same section, as do "4 (a)" and "4(a)". "" for a reference with no number
 * left ("§", "Section"), which names no section.
 */
export function sectionKey(ref: string): string {
  return ref.trim().toLowerCase()
    .replace(/^(?:§+|sections?|sect?\.?|clauses?|articles?|art\.?|paragraphs?|para\.?)\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[.:)]+$/, '')
    .replace(/(^|[.(])0+(?=\d)/g, '$1')
}

export async function proposeClauseAlternatives(args: {
  contractId:   string
  orgId:        string
  clauseId?:    string
  clauseType?:  string
  sectionRef?:  string
  instructions?: string
}): Promise<ProposeResult> {
  const { contractId, orgId, clauseId, clauseType, sectionRef, instructions } = args

  if (!clauseId && !clauseType && !sectionRef) {
    return { ok: false, status: 400, detail: 'One of clauseId, clauseType or sectionRef is required' }
  }

  const contract = await prisma.contract.findFirst({
    where:  { id: contractId, orgId, deletedAt: null },
    select: { id: true, title: true, type: true, currentVersionId: true },
  })
  if (!contract) return { ok: false, status: 404, detail: 'Contract not found' }
  if (!contract.currentVersionId) {
    return { ok: false, status: 400, detail: 'Contract has no current version' }
  }

  // clauseId wins; then the section (X53: users name clauses by number), and
  // failing that the first non-sub-chunk clause of the type, if one was given.
  const versionId = contract.currentVersionId
  const wanted = sectionRef ? sectionKey(sectionRef) : ''
  const bySection = async () => wanted
    ? (await prisma.contractClause.findMany({
        where:   { versionId, isSubChunk: false, sectionRef: { not: null } },
        orderBy: { sortOrder: 'asc' },
      })).find(c => sectionKey(c.sectionRef!) === wanted) ?? null
    : null
  const byType = async () => clauseType
    ? await prisma.contractClause.findFirst({
        where:   { versionId, isSubChunk: false, clauseType },
        orderBy: { sortOrder: 'asc' },
      })
    : null
  const clause = clauseId
    ? await prisma.contractClause.findFirst({ where: { id: clauseId, versionId } })
    : (await bySection()) ?? (await byType())
  if (!clause) {
    // X53 — the caller (the chat model) can't see the clause ids: say which
    // clauses there are, so it can retry with one instead of guessing again.
    // Those under the section asked for come first ("12.3" missed: 12.x).
    const all = await prisma.contractClause.findMany({
      where:   { versionId, isSubChunk: false },
      orderBy: { sortOrder: 'asc' },
      select:  { id: true, clauseType: true, sectionRef: true, content: true },
    })
    // X78 — nothing to list: a version not (yet) analysed. A bare "Clause not
    // found" left the chat model to fill the gap, and it invented a list.
    if (all.length === 0) {
      return {
        ok: false, status: 404, clauses: [], totalClauses: 0,
        detail: "This contract's current version has no extracted clauses, so there is none to redline yet. Tell the user; don't guess clause ids or text.",
      }
    }
    const head = wanted.split(/[.(]/)[0]
    const near = (c: TargetableClause) => !!head && !!c.sectionRef && sectionKey(c.sectionRef).split(/[.(]/)[0] === head
    const clauses = [...all.filter(near), ...all.filter(c => !near(c))].slice(0, LISTED_CLAUSES)
    return { ok: false, status: 404, detail: 'Clause not found', clauses, totalClauses: all.length }
  }

  // Map clauseType → ClauseCategory → preferred PlaybookPosition.
  // Shared with playbook_check so the checker and the rewriter cannot disagree
  // about which category a clause belongs to — this used to normalise only
  // underscores, so a hyphenated clauseType silently lost its playbook.
  const category = await findCategoryForClauseType(orgId, clause.clauseType)
  // Load EVERY position type, not just `preferred`. A negotiator aims at
  // `acceptable` or `fallback` when `preferred` is unreachable, and the
  // rewriter previously could not see that language at all — so its "least
  // aggressive" variant had nothing to anchor on but the counterparty's text.
  let preferred: { content: string; rules: unknown } | null = null
  let allPositions: Array<{ positionType: string; content: string }> = []
  if (category) {
    const rows = await prisma.playbookPosition.findMany({
      where:   { orgId, clauseCategoryId: category.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select:  { positionType: true, content: true, rules: true },
    })
    allPositions = rows.map(r => ({ positionType: r.positionType, content: r.content }))
    const pref = rows.find(r => r.positionType === 'preferred')
    if (pref) preferred = { content: pref.content, rules: pref.rules }
  }

  // X23 — the clause goes to the model under the org's PII policy, as
  // round-trip tokens (judged against the whole document): the variants are
  // text to splice into the contract, so the values are put back below.
  const document = (await prisma.contractVersion.findUnique({
    where: { id: contract.currentVersionId }, select: { plainText: true },
  }))?.plainText ?? ''
  const source = [clause.content, document]
  const { clauseText } = await redactJson(orgId, { clauseText: clause.content }, {
    surface: 'redline_propose', contractId: contract.id, roundTrip: contract.id, valuesFrom: source,
  })

  const pyRes = await modelFetch(`${AGENTS_URL}/redline_propose`, {
    method:  'POST',
    headers: {
      'content-type':      'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({
      clauseText,
      clauseType:       clause.clauseType,
      category:         category?.name,
      preferredContent: preferred?.content ?? null,
      // Fallback/acceptable/walkaway language, so the "least aggressive"
      // variant has something of ours to anchor on rather than only the
      // counterparty's text.
      positions:        allPositions,
      rules:            preferred?.rules ?? null,
      contractType:     contract.type,
      instructions,
      orgId,                       // per-org BYOK key + Langfuse tracing
    }),
  }, { orgId, surface: 'redline_propose', contractId, userAuthored: ['instructions'] })
  if (!pyRes.ok) {
    const err = await pyRes.text().catch(() => '')
    return { ok: false, status: 502, detail: 'redline_propose failed', upstream: err.slice(0, 300) }
  }
  const proposal = restorePii(await pyRes.json() as { variants?: ProposalVariant[]; error?: string }, source, contract.id)

  return {
    ok: true,
    data: {
      contract: { id: contract.id, title: contract.title, type: contract.type },
      clause: {
        id:           clause.id,
        clauseType:   clause.clauseType,
        sectionRef:   clause.sectionRef,
        originalText: clause.content,
      },
      category:    category ? { id: category.id, name: category.name } : null,
      hasPlaybook: !!preferred,
      variants:    proposal.variants ?? [],
      error:       proposal.error,
    },
  }
}
