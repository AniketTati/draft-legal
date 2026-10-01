/**
 * docs/41 Part 1 — a request drafted the way the assistant drafts.
 *
 * The request → draft worker used to send one sentence to the draft agent,
 * which worked out the contract type again with an LLM, let an LLM pick among
 * the org's templates by name, and let an LLM fill every variable, defaults
 * included. Now the same planner as the assistant (lib/draft-plan.ts) picks
 * the template and decides the clause slots, by rule; the agent only reads
 * values out of the request's words, each with the words it read it from
 * ({key, value, quote}), and a value whose quote isn't in the request is
 * dropped. The intake classifier's terms count only where the request says
 * them in so many words.
 *
 * `planFromRequest` is the same plan without the extractor: what the request
 * page shows before drafting (which template, which clause choices are
 * decided and which are left to make).
 */
import type { ConditionFacts, EvidencedValue } from '@clm/types'
import { prisma } from './prisma.js'
import { callAgents } from './agents-call.js'
import { chooseTemplate, planDraft, type DraftPlan, type TemplateChoice } from './draft-plan.js'
import { draftSource } from './template-snapshot.js'
import { quoteIn, sentenceNaming } from './clause-resolution.js'
import { requestTerms, type DraftAgentResult } from './draft-save.js'

export interface RequestDraftContext {
  requestTitle: string
  requestDescription: string
  contractType: string
  counterpartyName?: string
  estimatedValue?: number
  /** What the intake classifier read from the request (governing law, duration…). */
  extractedTerms?: Record<string, unknown>
  /** docs/41 Part 1 — what the requester picked on the request page. */
  templateId?: string
  slotChoices?: Record<string, string>
}

export interface ExtractedValue { key: string; value: string; quote: string }

/** Reads values out of a request's words: the agents service's variable extractor. */
export type VariableExtractor = (input: {
  orgId: string
  contractId: string
  requestText: string
  variables: Array<{ key: string; label: string; type?: string; options?: string[] }>
}) => Promise<ExtractedValue[]>

/** A fact a variant's condition can test, asked of the extractor alongside the template's variables. */
const FACT_VARIABLES = [
  { key: 'counterpartyCountry', label: 'Country the counterparty is based in (ISO 3166 two-letter code)', type: 'text' },
  { key: 'governingLaw', label: 'Governing law the request asks for', type: 'text' },
]

export const requestTextOf = (ctx: Pick<RequestDraftContext, 'requestTitle' | 'requestDescription'>) =>
  [ctx.requestTitle, ctx.requestDescription].filter(s => s && s.trim()).join('\n')

/** The agents service's extractor (POST /draft/extract-variables). */
export const agentsExtractVariables: VariableExtractor = async ({ orgId, contractId, requestText, variables }) => {
  const res = await callAgents('/draft/extract-variables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body: JSON.stringify({ org_id: orgId, user_message: requestText, variables }),
  }, { orgId, toolName: 'draft_extract_variables', scope: contractId, contractId, context: requestText })
  if (!res.ok) throw new Error(`Agents /draft/extract-variables returned ${res.status}`)
  const reply = await res.json() as { values?: Array<Partial<ExtractedValue>> }
  return (reply.values ?? []).filter((v): v is ExtractedValue => typeof v?.key === 'string' && typeof v.value === 'string' && typeof v.quote === 'string')
}

/** The classifier's terms that the request's words say, each with the sentence that says it. */
function quotedTerms(ctx: RequestDraftContext, text: string): Record<string, { value: string; quote: string }> {
  const out: Record<string, { value: string; quote: string }> = {}
  for (const [key, v] of Object.entries(requestTerms(ctx.extractedTerms))) {
    const quote = sentenceNaming(text, [String(v)])
    if (quote) out[key] = { value: String(v), quote }
  }
  return out
}

async function plan(input: {
  orgId: string
  ctx: RequestDraftContext
  choice: Extract<TemplateChoice, { ok: true }>
  extracted: ExtractedValue[]
}): Promise<DraftPlan> {
  const { ctx } = input
  const text = requestTextOf(ctx)
  const classified = quotedTerms(ctx, text)
  const read = new Map(input.extracted.map(e => [e.key, e]))
  // Governing law: the classifier's, else the extractor's — with its words either way.
  const law = classified.governingLaw ?? read.get('governingLaw')
  // A classifier value with no words to show is still offered to the clause
  // slots, which may find it by one of a variant's own names ("NY").
  const lawRaw = law ?? (typeof ctx.extractedTerms?.governingLaw === 'string' ? { value: ctx.extractedTerms.governingLaw, quote: null } : undefined)
  const requestValues: Record<string, EvidencedValue | undefined> = lawRaw ? { governingLaw: { value: lawRaw.value, quote: lawRaw.quote, source: 'request' } } : {}
  const country = read.get('counterpartyCountry')
  const facts: ConditionFacts = {
    ...(ctx.estimatedValue != null && { value: ctx.estimatedValue }),
    ...(country && { 'counterparty.country': country.value.trim().toUpperCase() }),
  }
  return planDraft({
    orgId: input.orgId,
    userMessage: text,
    contractType: input.choice.contractType,
    counterpartyName: ctx.counterpartyName,
    title: ctx.requestTitle,
    term: classified.duration?.value,
    effectiveDate: classified.startDate?.value,
    via: 'request',
    extracted: input.extracted.filter(e => e.key !== 'governingLaw' && e.key !== 'counterpartyCountry'),
    requestValues,
    requestText: text,
    slotChoices: ctx.slotChoices,
    facts,
    choice: input.choice,
  })
}

/** What the request page shows before drafting: the plan, with no LLM call. */
export async function planFromRequest(orgId: string, ctx: RequestDraftContext): Promise<{ choice: TemplateChoice; plan: DraftPlan | null }> {
  const choice = await chooseTemplate({ orgId, templateId: ctx.templateId, contractType: ctx.contractType })
  if (!choice.ok) return { choice, plan: null }
  return { choice, plan: await plan({ orgId, ctx, choice, extracted: [] }) }
}

/**
 * The request's draft: template and clause slots by rule, values the
 * extractor read with their quotes. Throws when no template can be chosen
 * (the convert route refuses before queuing in that case).
 */
export async function draftFromRequest(
  input: { orgId: string; contractId: string; ctx: RequestDraftContext },
  extract: VariableExtractor = agentsExtractVariables,
): Promise<DraftAgentResult> {
  const { orgId, contractId, ctx } = input
  const choice = await chooseTemplate({ orgId, templateId: ctx.templateId, contractType: ctx.contractType })
  if (!choice.ok) throw new Error(`${choice.error}: ${choice.detail}`)
  const source = await draftSource(orgId, choice.template)
  const text = requestTextOf(ctx)

  const declared = (Array.isArray(source?.snapshot.variables) ? source!.snapshot.variables : []) as Array<{ key?: string; label?: string; type?: string; options?: string[] }>
  const variables = [
    ...declared.filter(d => d?.key).map(d => ({ key: d.key!, label: d.label ?? d.key!, ...(d.type && { type: d.type }), ...(d.options && { options: d.options }) })),
    ...FACT_VARIABLES.filter(f => !declared.some(d => d?.key === f.key)),
  ]
  const raw = text.trim() && variables.length ? await extract({ orgId, contractId, requestText: text, variables }) : []
  // Every value the agent read must quote the request's own words.
  const extracted = raw.filter(e => e.value.trim() && e.quote.trim() && quoteIn(text, e.quote))

  const p = await plan({ orgId, ctx, choice, extracted })
  if (!p.ok) throw new Error(`${p.error}: ${p.detail}`)
  await prisma.template.update({ where: { id: p.templateId }, data: { usageCount: { increment: 1 } } }).catch(() => {})
  return {
    html: p.html,
    usedTemplateId: p.templateId,
    usedTemplateName: p.templateName,
    contractType: p.contractType,
    variableValues: p.variables,
    variableSources: Object.fromEntries(p.origin.variables.map(v => [v.key, v.source])),
    missingFields: p.unfilledVariables,
    unfilledVariables: p.unfilledVariables,
    origin: p.origin,
  }
}
