/**
 * Drafting findings (docs/41 Part 10): the defined-terms checks run on a
 * version and stored with it, so the Review panel can list them under
 * "Drafting" without reading the text again.
 *
 * Stored on `contract.metadata._drafting = { versionId, issues, checkedAt }`
 * for now. Each issue already has the shape of a review finding
 * ({ kind, clauseType: null, severity, evidence, versionId }), so moving them
 * into a findings table later is a copy, not a rewrite.
 */
import { prisma } from './prisma.js'
import { analyseDefinedTerms, type DefinedTermIssue, type GlossaryEntry } from './defined-terms.js'

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

/**
 * Run the checks on a version and store them on the contract. Called as part
 * of analysis; deterministic and cheap (no model call). Returns the findings,
 * or null when the version isn't the contract's.
 */
export async function computeDraftingFindings(contractId: string, versionId: string): Promise<DraftingFinding[] | null> {
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { orgId: true } })
  if (!contract) return null
  const result = await definedTermsForVersion(contract.orgId, contractId, versionId)
  if (!result) return null
  const stored = { versionId, issues: result.issues, checkedAt: new Date().toISOString() }
  // One key, written in place: analysis steps running alongside write other keys of the same object.
  await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_drafting}', ${JSON.stringify(stored)}::jsonb) WHERE id = ${contractId} AND "orgId" = ${contract.orgId}`
  return result.issues
}
