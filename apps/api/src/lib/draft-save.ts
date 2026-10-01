/**
 * docs/41 P0.1 — a draft the draft agent wrote, saved as a version of its
 * contract, by the request → convert worker and by /agent/draft adding a
 * version to an existing contract.
 *
 * The worker used to keep only the HTML: it dropped which template was used,
 * the values it was filled with and what was missing, set no current version
 * (so the contract page and the playbook redline had nothing to stand on),
 * wrote no audit event and marked the contract's analysis DONE without
 * analysing anything. Now the draft is recorded as the assistant path records
 * it (docs/39 H2: `metadata._template`), its values become the contract's
 * fields (H3), it is on the record (CONTRACT_DRAFTED), and the version is
 * analysed like any other (lib/analysis-trigger.ts).
 */
import { AuditAction, type DraftOrigin } from '@clm/types'
import { prisma } from './prisma.js'
import { htmlToText } from './html-text.js'
import { createAuditEvent } from './audit.js'
import { setValuesFromTemplate } from './field-store.js'
import { onVersionCreated } from './analysis-trigger.js'

/** What POST /draft on the agents service answers (apps/agents draft_agent.run_draft). */
export interface DraftAgentResult {
  html?: string
  error?: string | null
  usedTemplateId?: string
  usedTemplateName?: string
  contractType?: string
  variableValues?: Record<string, unknown>
  /** docs/41 P0.4 — where each legal choice's value came from (request_value, org_default, unresolved…). */
  variableSources?: Record<string, string>
  missingFields?: string[]
  unfilledVariables?: string[]
  reviewNotes?: string
  /**
   * docs/41 Part 1 — why the draft says what it says: the template version,
   * each clause slot's decision and each value's source (lib/draft-plan.ts).
   * Saved as `metadata._origin` and on the CONTRACT_DRAFTED event.
   */
  origin?: DraftOrigin
}

/**
 * The intake classifier's terms worth passing to drafting: the ones it read
 * from the request, dropping the nulls it fills the rest with.
 */
export function requestTerms(extracted: Record<string, unknown> | null | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const key of ['governingLaw', 'duration', 'startDate', 'counterparty', 'estimatedValue']) {
    const v = extracted?.[key]
    if (typeof v === 'string' && v.trim() && !/^(null|none|n\/a|unknown)$/i.test(v.trim())) out[key] = v.trim()
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
  }
  return out
}

/** `metadata._template`, from the template row and the agent's own record of the draft. */
async function templateRecord(orgId: string, result: DraftAgentResult) {
  const template = result.usedTemplateId
    ? await prisma.template.findFirst({ where: { id: result.usedTemplateId, orgId }, select: { id: true, name: true, version: true, variables: true } })
    : null
  if (!template) return null
  return {
    id: template.id,
    name: template.name,
    // The published version it was drafted from, when the planner recorded one.
    version: result.origin?.templateId === template.id ? result.origin.templateVersion : template.version,
    variables: template.variables,
    values: result.variableValues ?? {},
    ...(result.variableSources && { sources: result.variableSources }),
    missingFields: result.missingFields ?? [],
    unfilled: result.unfilledVariables ?? [],
  }
}

export async function saveDraftVersion(input: {
  contractId: string
  orgId: string
  userId: string
  result: DraftAgentResult
  changeNote: string
  /** Where the draft was asked for: a converted request, or /agent/draft adding a version. */
  source: 'request' | 'agent_draft'
}): Promise<{ versionId: string; versionNumber: number }> {
  const { contractId, orgId, userId, result } = input
  const html = result.html ?? ''
  const latest = await prisma.contractVersion.findFirst({
    where: { contractId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  const template = await templateRecord(orgId, result)
  const version = await prisma.contractVersion.create({
    data: {
      contractId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      htmlContent:   html,
      plainText:     htmlToText(html),
      mimeType:      'text/html',
      fileSize:      Buffer.byteLength(html),
      changeNote:    input.changeNote,
      createdById:   userId,
    },
  })
  if (template) {
    // jsonb_set: the convert route wrote _draftContext, and other keys may be
    // written meanwhile.
    await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_template}', ${JSON.stringify(template)}::jsonb) WHERE id = ${contractId}`
  }
  if (result.origin) {
    await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_origin}', ${JSON.stringify(result.origin)}::jsonb) WHERE id = ${contractId}`
  }

  // docs/39 H3 — the values the draft was filled with are its fields (set
  // from the template); the analysis that follows reads the rest.
  if (result.variableValues && Object.keys(result.variableValues).length) {
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { counterpartyName: true } })
    await setValuesFromTemplate({
      orgId, contractId, userId,
      variables: { ...result.variableValues, ...(contract?.counterpartyName ? { counterparty_name: contract.counterpartyName } : {}) },
      audit: { source: 'template' },
      templateVariables: (template?.variables ?? null) as Array<{ key: string; field?: string | null }> | null,
    }).catch(err => console.warn('[draft-save] template values not saved as fields contractId=%s: %s', contractId, (err as Error).message))
  }

  await createAuditEvent({
    orgId,
    userId,
    action:       AuditAction.CONTRACT_DRAFTED,
    resourceType: 'contract',
    resourceId:   contractId,
    metadata: {
      source:        input.source,
      versionNumber: version.versionNumber,
      templateId:    template?.id ?? null,
      templateName:  template?.name ?? result.usedTemplateName ?? null,
      unfilled:      result.unfilledVariables ?? [],
      ...(result.variableSources && { sources: result.variableSources }),
      ...(result.origin && { origin: result.origin }),
    },
  }).catch(err => console.warn('[draft-save] audit failed contractId=%s: %s', contractId, (err as Error).message))

  await onVersionCreated(contractId, version.id, input.source === 'request' ? 'generated' : 'added')
  return { versionId: version.id, versionNumber: version.versionNumber }
}
