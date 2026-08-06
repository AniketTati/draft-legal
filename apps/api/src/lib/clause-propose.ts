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
import { prisma } from './prisma.js'

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8000'

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

export type ProposeResult =
  | { ok: true;  data: ProposalPayload }
  | { ok: false; status: number; detail: string; upstream?: string }

export async function proposeClauseAlternatives(args: {
  contractId:   string
  orgId:        string
  clauseId?:    string
  clauseType?:  string
  instructions?: string
}): Promise<ProposeResult> {
  const { contractId, orgId, clauseId, clauseType, instructions } = args

  if (!clauseId && !clauseType) {
    return { ok: false, status: 400, detail: 'Either clauseId or clauseType is required' }
  }

  const contract = await prisma.contract.findFirst({
    where:  { id: contractId, orgId, deletedAt: null },
    select: { id: true, title: true, type: true, currentVersionId: true },
  })
  if (!contract) return { ok: false, status: 404, detail: 'Contract not found' }
  if (!contract.currentVersionId) {
    return { ok: false, status: 400, detail: 'Contract has no current version' }
  }

  // clauseId wins; else the first non-sub-chunk clause of that type.
  const clause = clauseId
    ? await prisma.contractClause.findFirst({
        where: { id: clauseId, versionId: contract.currentVersionId },
      })
    : await prisma.contractClause.findFirst({
        where:   { versionId: contract.currentVersionId, isSubChunk: false, clauseType: clauseType! },
        orderBy: { sortOrder: 'asc' },
      })
  if (!clause) return { ok: false, status: 404, detail: 'Clause not found' }

  // Map clauseType → ClauseCategory → preferred PlaybookPosition.
  const category = await prisma.clauseCategory.findFirst({
    where: {
      orgId,
      // Same normalisation rule as playbook_check.
      name: { equals: clause.clauseType.replace(/_/g, ' '), mode: 'insensitive' },
    },
    select: { id: true, name: true },
  })
  let preferred: { content: string; rules: unknown } | null = null
  if (category) {
    const pos = await prisma.playbookPosition.findFirst({
      where:  { orgId, clauseCategoryId: category.id, positionType: 'preferred' },
      select: { content: true, rules: true },
    })
    if (pos) preferred = pos
  }

  const pyRes = await fetch(`${AGENTS_URL}/redline_propose`, {
    method:  'POST',
    headers: {
      'content-type':      'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({
      clauseText:       clause.content,
      clauseType:       clause.clauseType,
      category:         category?.name,
      preferredContent: preferred?.content ?? null,
      rules:            preferred?.rules ?? null,
      contractType:     contract.type,
      instructions,
      orgId,                       // per-org BYOK key + Langfuse tracing
    }),
  })
  if (!pyRes.ok) {
    const err = await pyRes.text().catch(() => '')
    return { ok: false, status: 502, detail: 'redline_propose failed', upstream: err.slice(0, 300) }
  }
  const proposal = await pyRes.json() as { variants?: ProposalVariant[]; error?: string }

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
