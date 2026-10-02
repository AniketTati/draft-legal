/**
 * Drafting findings (docs/41 Part 10): the defined-terms checks run on each
 * analysed version and stored as its review findings (kind `drafting`), so
 * the Review panel lists them under "Drafting" with the clause review's own
 * actions (accept, mark resolved), and a decision carries to the next version
 * while the words are the same. They never hold back a recommendation:
 * a drafting slip is worth fixing, not a reason not to approve.
 */
import { prisma } from './prisma.js'
import { analyseDefinedTerms, type DefinedTermIssue, type DraftingIssueKind, type GlossaryEntry } from './defined-terms.js'
import { storeFindings, type FindingDraft } from './review-findings.js'

export interface DraftingFinding extends DefinedTermIssue {
  clauseType: null
  versionId: string
}

export interface DefinedTermsForVersion {
  versionId: string
  glossary: GlossaryEntry[]
  issues: DraftingFinding[]
}

/** Names the contract knows already: its title, the counterparty, the parties the AI read. */
function knownNamesOf(contract: { title: string; counterpartyName: string | null; keyTerms: unknown }): string[] {
  const parties = (contract.keyTerms as { parties?: Array<{ name?: unknown }> } | null)?.parties
  return [
    contract.title,
    contract.counterpartyName ?? '',
    ...(Array.isArray(parties) ? parties.map(p => (typeof p?.name === 'string' ? p.name : '')) : []),
  ].filter(Boolean)
}

/**
 * The glossary and the drafting problems of one version (the current one when
 * `versionId` is absent). Null when the contract or version isn't the org's.
 */
export async function definedTermsForVersion(orgId: string, contractId: string, versionId?: string | null): Promise<DefinedTermsForVersion | null> {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null },
    select: { id: true, title: true, counterpartyName: true, keyTerms: true, currentVersionId: true },
  })
  if (!contract) return null
  const version = await prisma.contractVersion.findFirst({
    where: versionId
      ? { id: versionId, contractId }
      : contract.currentVersionId ? { id: contract.currentVersionId, contractId } : { contractId },
    orderBy: { versionNumber: 'desc' },
    select: { id: true, plainText: true, htmlContent: true },
  })
  if (!version) return null
  const { glossary, issues } = analyseDefinedTerms(version.plainText ?? '', {
    html: version.htmlContent, knownNames: knownNamesOf(contract),
  })
  return {
    versionId: version.id,
    glossary,
    issues: issues.map(i => ({ ...i, clauseType: null, versionId: version.id })),
  }
}

/** What to do about each kind, in one plain sentence. */
const ADVICE: Record<DraftingIssueKind, string> = {
  undefined_term: 'Define it, or write it in lower case if it isn’t meant as a defined term.',
  unused_definition: 'Remove the definition, or check whether the clause that used it was deleted.',
  duplicate_definition: 'Keep one definition and remove the other.',
  used_before_defined: 'Move the definition up, or say where the term is defined.',
  capitalisation_drift: 'Write it the way it is defined, so it reads as the defined term.',
}

/** Pure: a version's defined-term problems as review findings. */
export function draftingFindingDrafts(issues: DefinedTermIssue[]): FindingDraft[] {
  const seen = new Set<string>()
  const out: FindingDraft[] = []
  for (const i of issues) {
    // One finding per problem and term: the same key on the next version is the same finding.
    const key = `drafting|${i.kind}|${i.term}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      kind: 'drafting', key, clauseType: null, clauseId: null, categoryId: null, positionId: null,
      severity: i.severity,
      title: i.message,
      explanation: ADVICE[i.kind],
      evidence: {
        quote: i.evidence.quote,
        offsets: { start: i.evidence.offset, end: i.evidence.offset + i.term.length },
        ...(i.related && { relatedQuote: i.related.quote }),
        ruleId: i.kind,
      },
      source: 'deterministic',
    })
  }
  return out
}

/**
 * Run the checks on a version and store them as its drafting findings.
 * Deterministic and cheap (no model call): a step of every analysis
 * (lib/version-review-steps.ts). Returns the issues, or null when the version
 * isn't the contract's.
 */
export async function computeDraftingFindings(contractId: string, versionId: string): Promise<DraftingFinding[] | null> {
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { orgId: true } })
  if (!contract) return null
  const result = await definedTermsForVersion(contract.orgId, contractId, versionId)
  if (!result) return null
  await storeFindings({ orgId: contract.orgId, contractId, versionId, baselineVersionId: null, drafts: draftingFindingDrafts(result.issues), kinds: ['drafting'] })
  // Checked, even with nothing found: a version without the mark was never checked.
  await prisma.$executeRaw`UPDATE contract_versions SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_drafting}', ${JSON.stringify({ checkedAt: new Date().toISOString(), issues: result.issues.length })}::jsonb) WHERE id = ${versionId}`
  return result.issues
}

/** Whether a version's defined terms were checked (its drafting findings are there to read). */
export function draftingChecked(versionMetadata: unknown): boolean {
  return typeof (versionMetadata as { _drafting?: { checkedAt?: unknown } } | null)?._drafting?.checkedAt === 'string'
}
