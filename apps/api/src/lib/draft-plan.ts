/**
 * Drafting plan for the chat assistant (C12) — which template, filled with
 * what — computed WITHOUT creating anything.
 *
 * The assistant's drafting tool used to create the contract mid-stream with
 * no confirmation card and no undo, and filled every template with
 * California law, a 2-year term and today's date whatever the user asked. It
 * also only ever picked a template typed for the contract (untyped templates
 * were unreachable). Now the tool plans here, shows the plan on the same
 * confirm card as the other write tools, and the existing
 * /tools/contract_create_from_template creates it on Apply (undoable).
 *
 * Values come only from (1) what the user said, (2) the template's own
 * declared defaults, and (3) the org's name for our side. Anything else is
 * left visibly blank and reported, never guessed.
 *
 * DD3 — a template default that describes a party (what it is, where it is)
 * is the org's own wording, so it may describe our side only. The other
 * side's come from the user or the counterparty's record: "Initech Inc., a
 * Delaware corporation" came from a default both parties' fields carried.
 */
import { isLegalChoiceVariable, isGoverningLawVariable, type ConditionFacts, type DraftOrigin, type EvidencedValue, type VariableSource } from '@clm/types'
import { prisma } from './prisma.js'
import { generateDocument, type TemplateWithSections } from './template-engine.js'
import { asTemplate, draftSource, type DraftSource } from './template-snapshot.js'
import { resolveSlots, sentenceNaming, type SlotResolution } from './clause-resolution.js'

export const DRAFT_CONTRACT_TYPES = ['NDA', 'MSA', 'SOW', 'VENDOR_AGREEMENT', 'LICENSE', 'EMPLOYMENT', 'DATA_PROCESSING'] as const

export interface DraftPlanInput {
  orgId:             string
  userMessage:       string
  contractType?:     string
  templateId?:       string
  counterpartyName?: string
  title?:            string
  governingLaw?:     string
  term?:             string
  effectiveDate?:    string
  /** Any other stated terms, keyed by the template's variable names (or close to them). */
  terms?:            Record<string, string>
  // ── docs/41 Part 1 — one planner for the assistant and the request path ──
  /** Who stated the terms above: the assistant's user, or a request's own fields. */
  via?:              'assistant' | 'request'
  /** Terms the extractor read from the request's words, each with its quote. */
  extracted?:        Array<{ key: string; value: string; quote: string }>
  /** Values the request named (the intake classifier's governing law), by key. */
  requestValues?:    Record<string, EvidencedValue | undefined>
  /** The request's own words, which a named value is quoted from. */
  requestText?:      string
  /** Clause slot choices a person made: familyId → variant id. */
  slotChoices?:      Record<string, string>
  /** Facts a variant's condition can test (counterparty.country, value…). */
  facts?:            ConditionFacts
  /** The template already chosen (chooseTemplate), so how it was chosen is kept. */
  choice?:           Extract<TemplateChoice, { ok: true }>
}

/** How the template was chosen; the same inputs always choose the same one. */
export type TemplateChoice =
  | { ok: true; template: TemplateWithSections & { publishedVersionId: string | null }; contractType: string; decidedBy: DraftOrigin['templateDecidedBy'] }
  | { ok: false; status: 404 | 409 | 422; error: string; detail: string; templates?: Array<{ id: string; name: string; contractType: string | null }> }

export type DraftPlan =
  | {
      ok: true
      templateId:        string
      templateName:      string
      contractType:      string
      title:             string
      counterpartyName:  string | null
      variables:         Record<string, string>
      html:              string
      unfilledVariables: string[]
      templateVariables: string[]
      /** docs/41 Part 1 — how each clause slot was decided, and where each value came from. */
      origin:            DraftOrigin
      /** familyId → the variant each decided slot uses, for Apply to draft the same text. */
      slotChoices:       Record<string, string>
      /** How each decided slot was decided, and where each value came from — Apply records them. */
      slotDecisions:     Record<string, Pick<SlotResolution, 'decidedBy' | 'ruleId' | 'rule' | 'evidence'>>
      variableSources:   Record<string, VariableSource>
      slots:             SlotResolution[]
    }
  | { ok: false; status: 404 | 409 | 422; error: string; detail: string; templates?: Array<{ id: string; name: string; contractType: string | null }> }

/** Keyword inference, used only when neither a type nor a template was given. */
export function inferContractType(message: string): string | null {
  const m = ` ${message.toLowerCase()} `
  if (m.includes(' nda') || m.includes('non-disclosure') || m.includes('confidential disclosure')) return 'NDA'
  if (m.includes(' msa') || m.includes('master service')) return 'MSA'
  if (m.includes(' sow') || m.includes('statement of work')) return 'SOW'
  if (m.includes('vendor')) return 'VENDOR_AGREEMENT'
  if (m.includes('license')) return 'LICENSE'
  if (m.includes('employment') || m.includes('offer letter')) return 'EMPLOYMENT'
  if (m.includes(' dpa') || m.includes('data processing')) return 'DATA_PROCESSING'
  return null
}

// Words an untyped template's name or description uses for each type.
const TYPE_WORDS: Record<string, string[]> = {
  NDA: ['nda', 'non-disclosure', 'confidentiality'],
  MSA: ['msa', 'master service'],
  SOW: ['sow', 'statement of work'],
  VENDOR_AGREEMENT: ['vendor', 'supplier'],
  LICENSE: ['license', 'licence'],
  EMPLOYMENT: ['employment', 'offer letter'],
  DATA_PROCESSING: ['dpa', 'data processing'],
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

// A draft's default title names its type in words: "Initech — Vendor
// Agreement", not "Initech — VENDOR_AGREEMENT". NDA, MSA, SOW and a
// template's own label ('BAA', 'Order Form') read fine as they are.
const TYPE_IN_WORDS: Record<string, string> = {
  VENDOR_AGREEMENT: 'Vendor Agreement', LICENSE: 'License Agreement', EMPLOYMENT: 'Employment Agreement',
  DATA_PROCESSING: 'Data Processing Agreement', ORDER_FORM: 'Order Form', PARTNERSHIP: 'Partnership Agreement',
  OTHER: 'Agreement',
}
const typeInWords = (contractType: string) => TYPE_IN_WORDS[contractType] ?? contractType

// A stated term fills every template key in its alias group.
const ALIASES = {
  counterparty:  ['counterparty', 'counterpartyname', 'counterpartycompany', 'otherparty'],
  governingLaw:  ['governinglaw', 'jurisdiction', 'governingstate', 'lawstate', 'choiceoflaw'],
  term:          ['term', 'termlength', 'contractterm', 'duration', 'initialterm'],
  // An NDA's term is how long confidentiality lasts ("a 3-year NDA").
  termYears:     ['termyears', 'termyear', 'terminyears', 'confidentialityyears', 'confidentialityterm', 'ndaterm'],
  effectiveDate: ['effectivedate', 'startdate', 'commencementdate'],
  ourCompany:    ['ourcompany', 'ourorgname', 'ourname', 'ourcompanyname'],
  // CC5 — templates that name the parties by role. Our side, and theirs:
  // an offer letter goes to a candidate, a notice to its recipient.
  ourRole:       ['companyname', 'sendername', 'partyaname', 'employername'],
  theirRole:     ['contractorname', 'candidatename', 'recipientname', 'partybname', 'employeename', 'consultantname'],
}

/**
 * Which of a customer/provider template's parties we are. 42 of the seeded
 * templates name the parties so, and both were left blank on every chat
 * draft ("Draft an NDA with Initech" came back with customerName and
 * providerName to fill in). We are the customer, unless the template is
 * written for the seller.
 */
const weSell = (templateName: string) => /\bsell[- ]side\b|\boutbound\b/i.test(templateName)

/** A fact about a party: its entity type, incorporation, address, registration or legal name. */
const PARTY_FACT = /(entitytype|entitydescription|entity|stateofincorporation|jurisdictionofincorporation|incorporation|organizedunder|companytype|registeredaddress|principaladdress|noticeaddress|address|registeredoffice|companynumber|registrationnumber|legalname)$/
const OUR_SIDE = /^(?:our|company|sender|partya|employer)$/

/**
 * Whose fact a template key is: ours, or not ours (the counterparty's, or a
 * party we can't tell, which is never assumed). Null for a key that isn't a
 * fact about a party.
 */
function partyFactOf(key: string, ourRole: string | null): { side: 'ours' | 'theirs'; fact: 'address' | 'legalname' | 'other' } | null {
  const k = norm(key)
  const m = PARTY_FACT.exec(k)
  if (!m) return null
  const prefix = k.slice(0, k.length - m[1].length)
  const fact = /address|registeredoffice/.test(m[1]) ? 'address' : m[1] === 'legalname' ? 'legalname' : 'other'
  return { side: prefix && (prefix === ourRole || OUR_SIDE.test(prefix)) ? 'ours' : 'theirs', fact }
}

function templateKeys(template: TemplateWithSections, clauseContents: string[]): string[] {
  const keys = new Set<string>()
  for (const text of [...template.sections.map(s => s.content), ...clauseContents]) {
    for (const m of text.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) keys.add(m[1])
  }
  return [...keys]
}

/**
 * docs/41 Part 1 — which template a draft is made from, without any LLM:
 *   1. the template asked for (the user picked it);
 *   2. the org's default template for the contract type;
 *   3. the only published template of that type (or, with none typed, the
 *      only untyped one that names the type);
 *   4. otherwise the user picks (409 TEMPLATE_CHOICE_NEEDED, with the list).
 * The request → draft worker, the request page's plan and the assistant's
 * drafting plan all call this, so they can't choose differently.
 */
export async function chooseTemplate(input: { orgId: string; templateId?: string | null; contractType?: string | null; userMessage?: string | null }): Promise<TemplateChoice> {
  const base = { orgId: input.orgId, deletedAt: null, isPublished: true }
  const include = { sections: { orderBy: { sortOrder: 'asc' as const } } }
  // Ties are broken by name and id, never by which was edited last.
  const orderBy = [{ name: 'asc' as const }, { id: 'asc' as const }]

  if (input.templateId) {
    const template = await prisma.template.findFirst({ where: { ...base, id: input.templateId }, include })
    if (!template) {
      return { ok: false, status: 404, error: 'TEMPLATE_NOT_FOUND', detail: 'No published template with that id in this organization.' }
    }
    return { ok: true, template, contractType: input.contractType?.toUpperCase() ?? template.contractType ?? 'OTHER', decidedBy: 'explicit' }
  }
  const contractType = input.contractType?.toUpperCase() ?? inferContractType(input.userMessage ?? '')
  if (!contractType) {
    return {
      ok: false, status: 422, error: 'CONTRACT_TYPE_AMBIGUOUS',
      detail: `Could not tell which contract to draft. Pass contract_type (${DRAFT_CONTRACT_TYPES.join(' | ')}) or a template_id from template_list.`,
    }
  }
  let candidates = await prisma.template.findMany({ where: { ...base, contractType }, include, orderBy })
  const dflt = candidates.find(t => t.isDefaultForType)
  if (dflt) return { ok: true, template: dflt, contractType, decidedBy: 'default_for_type' }
  if (!candidates.length) {
    // Untyped templates are real options too — matched by what they say they are.
    const words = TYPE_WORDS[contractType] ?? [contractType.toLowerCase()]
    const untyped = await prisma.template.findMany({ where: { ...base, contractType: null }, include, orderBy })
    candidates = untyped.filter(t => {
      const text = `${t.name} ${t.description ?? ''}`.toLowerCase()
      return words.some(w => text.includes(w))
    })
  }
  if (candidates.length === 1) return { ok: true, template: candidates[0], contractType, decidedBy: 'only_one' }
  if (candidates.length > 1) {
    return {
      ok: false, status: 409, error: 'TEMPLATE_CHOICE_NEEDED',
      detail: `Your organization has ${candidates.length} published ${contractType} templates and none is marked as the default. Pick one, or mark one as the default for ${contractType} in Templates.`,
      templates: candidates.map(t => ({ id: t.id, name: t.name, contractType: t.contractType })),
    }
  }
  const templates = await prisma.template.findMany({
    where: base, select: { id: true, name: true, contractType: true }, orderBy, take: 20,
  })
  return {
    ok: false, status: 422, error: 'NO_TEMPLATE_MATCH',
    detail: templates.length
      ? `No published ${contractType} template. Pick one of the org's published templates by id, or create a ${contractType} template in Templates first.`
      : `Your org has no published templates yet. Create a ${contractType} template in Templates first.`,
    templates,
  }
}

export async function planDraft(input: DraftPlanInput): Promise<DraftPlan> {
  const chosen = input.choice ?? await chooseTemplate(input)
  if (!chosen.ok) return chosen
  const contractType = chosen.contractType
  // docs/41 Part 1 — drafted from the template as published (its snapshot,
  // with the clause variants pinned then), not from its working copy.
  const source = await draftSource(input.orgId, chosen.template) as DraftSource
  const template = asTemplate(source.snapshot, input.orgId)
  const via = input.via ?? 'assistant'
  const stated: VariableSource = via === 'request' ? 'request_field' : 'user'

  // Clause-library references the template's sections point at.
  const clauseRefs = template.sections.flatMap(s => (Array.isArray(s.clauseRefs) ? (s.clauseRefs as string[]) : []))
  const clauseItems = clauseRefs.length
    ? await prisma.clauseLibraryItem.findMany({ where: { id: { in: clauseRefs }, orgId: input.orgId, deletedAt: null } })
    : []
  const clauseMap = new Map(clauseItems.map(c => [c.id, c]))
  // A slot's variants may carry variables of their own ({{venueLocation}}).
  const slotContents = source.snapshot.sections.flatMap(s => s.slot?.variants.map(v => v.content) ?? [])
  const keys = templateKeys(template, [...clauseItems.map(c => c.content), ...slotContents])
  const byNorm = new Map(keys.map(k => [norm(k), k]))

  const variables: Record<string, string> = {}
  // docs/41 Part 1 — where each value came from, for the draft's origin.
  const sources: Record<string, { source: VariableSource; quote?: string | null }> = {}
  const set = (key: string, value: string, source: VariableSource, quote?: string | null) => {
    variables[key] = value
    sources[key] = { source, ...(quote ? { quote } : {}) }
  }
  const fill = (aliases: string[], value: string | undefined | null, source: VariableSource = stated, quote?: string | null) => {
    if (!value?.trim()) return
    for (const a of aliases) {
      const key = byNorm.get(a)
      if (key && variables[key] === undefined) set(key, value.trim(), source, quote)
    }
  }

  // The law the request named, when its words say so (docs/41: a value with
  // evidence). On the assistant's path the user's own message names it.
  // On the request path a value counts only with the request's words for it.
  const reqLaw = input.requestValues?.governingLaw
  const reqLawQuote = reqLaw?.value?.trim()
    ? reqLaw.quote ?? sentenceNaming(input.requestText ?? input.userMessage, [reqLaw.value])
    : null
  const askedLaw: { value: string; source: VariableSource; quote?: string | null } | null = input.governingLaw?.trim()
    ? { value: input.governingLaw.trim(), source: stated }
    : reqLaw?.value?.trim() && (reqLawQuote || via !== 'request')
      ? { value: reqLaw.value.trim(), source: 'request_value', quote: reqLawQuote }
      : null
  const governingLaw = askedLaw?.value

  // 1. What the user said. Free-form terms first, matched to template keys.
  for (const [k, v] of Object.entries(input.terms ?? {})) {
    const key = byNorm.get(norm(k))
    if (key && typeof v === 'string' && v.trim()) set(key, v.trim(), stated)
  }
  // Our side's name is the org's (step 3), never read from the request: the
  // extractor put the counterparty in customerName too, so both parties were
  // "Initech Solutions".
  const ourNameKeys = new Set<string>([...ALIASES.ourCompany, ...ALIASES.ourRole])
  if (byNorm.has('customername') && byNorm.has('providername')) ourNameKeys.add(weSell(template.name) ? 'providername' : 'customername')
  // What the extractor read from the request — only with the words it read it from.
  for (const e of input.extracted ?? []) {
    const key = byNorm.get(norm(e.key))
    if (ourNameKeys.has(norm(e.key))) continue
    if (key && variables[key] === undefined && e.value?.trim()) set(key, e.value.trim(), 'request_text', e.quote)
  }
  fill(ALIASES.counterparty, input.counterpartyName)
  fill(ALIASES.governingLaw, governingLaw, askedLaw?.source, askedLaw?.quote)
  fill(ALIASES.term, input.term)
  const years = input.term?.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/i)?.[1]
  fill(ALIASES.termYears, years)
  fill(ALIASES.effectiveDate, input.effectiveDate)

  // Which role is ours in a customer/provider template (see weSell).
  const rolesByName = byNorm.has('customername') && byNorm.has('providername')
  const ourRole = rolesByName ? (weSell(template.name) ? 'provider' : 'customer') : null

  // 2. The template's own declared defaults (the org chose these) — except a
  // venue chosen for a governing law the user changed: New York law with the
  // template's "Wilmington, Delaware" courts is left for the user to set; and
  // (DD3) a default describing the other party, which the org can't know.
  const declared = Array.isArray(template.variables) ? template.variables as Array<{ key?: string; label?: string; defaultValue?: unknown; orgDefault?: boolean }> : []
  const lawKey = declared.find(d => d?.key && ALIASES.governingLaw.includes(norm(d.key)))
  const lawChanged = !!governingLaw && lawKey?.defaultValue != null
    && norm(String(lawKey.defaultValue)) !== norm(governingLaw)
  // The law asked for is the one the template's defaults were written for.
  const lawAsDefault = !!governingLaw && !lawChanged
  for (const d of declared) {
    if (lawChanged && d?.key && /venue|forum|courtlocation|courts/.test(norm(d.key))) continue
    // docs/41 P0.4 — a legal choice is filled from a default only when the
    // org made it its own default, or (a venue) when the user asked for the
    // law that default goes with. Otherwise it stays a choice to make.
    if (d?.key && isLegalChoiceVariable(d) && !d.orgDefault && !(lawAsDefault && !isGoverningLawVariable(d))) continue
    if (d?.key && partyFactOf(d.key, ourRole)?.side === 'theirs') continue
    if (d?.key && variables[d.key] === undefined && d.defaultValue != null && String(d.defaultValue).trim()) {
      set(d.key, String(d.defaultValue), d.orgDefault ? 'org_default' : 'template_default')
    }
  }

  // 3. Our side is a fact, not a guess; the counterparty takes the other role.
  const org = await prisma.organization.findUnique({ where: { id: input.orgId }, select: { name: true } })
  fill(ALIASES.ourCompany, org?.name, 'our_org')
  fill(ALIASES.ourRole, org?.name, 'our_org')
  fill(ALIASES.theirRole, input.counterpartyName)
  if (rolesByName) {
    const [ours, theirs] = weSell(template.name) ? ['providername', 'customername'] : ['customername', 'providername']
    fill([ours], org?.name, 'our_org')
    fill([theirs], input.counterpartyName)
  }

  // DD3 — what the counterparty's record says about it: its registered name
  // and address. Its entity type isn't recorded anywhere, so it stays blank.
  const cpName = input.counterpartyName?.trim()
  const record = cpName
    ? await prisma.counterparty.findFirst({
        where: { orgId: input.orgId, deletedAt: null, OR: [{ name: { equals: cpName, mode: 'insensitive' } }, { legalName: { equals: cpName, mode: 'insensitive' } }] },
        select: { legalName: true, address: true },
      })
    : null
  for (const key of keys) {
    const f = partyFactOf(key, ourRole)
    if (f?.side !== 'theirs' || variables[key] !== undefined) continue
    const value = f.fact === 'address' ? record?.address : f.fact === 'legalname' ? record?.legalName : null
    if (value?.trim()) set(key, value.trim(), 'counterparty_record')
  }

  // docs/41 Part 1 — the clause slots: a person's choice, the value the
  // request named, the org's rules, its default; otherwise left to choose.
  const resolved = resolveSlots({
    snapshot: source.snapshot,
    choices: input.slotChoices,
    // A value without words of its own is still offered: a slot may find it by
    // one of its variants' names ("NY"), and quote that.
    requestValues: askedLaw ? { governingLaw: { value: askedLaw.value, quote: askedLaw.quote ?? null } } : reqLaw ? { governingLaw: reqLaw } : {},
    facts: {
      contractType,
      paperSource: 'ours',
      ...(governingLaw && { governingLaw }),
      ...input.facts,
    },
    requestText: input.requestText ?? input.userMessage,
    requireQuote: via === 'request',
  })
  // The variant a slot uses says what its term is (governing law: New York):
  // the draft's fields hear it too.
  for (const [k, v] of Object.entries(resolved.impliedValues)) {
    const key = byNorm.get(norm(k)) ?? (declared.some(d => d?.key === k) ? k : undefined)
    if (key && variables[key] === undefined) set(key, v.value, 'clause_choice')
  }

  const generated = generateDocument({ template, variables, clauseMap, slotText: resolved.slotText })
  const counterpartyName = input.counterpartyName?.trim() || null
  const title = input.title?.trim()
    || (counterpartyName ? `${counterpartyName} — ${typeInWords(contractType)}` : `Draft — ${template.name}`)

  return {
    ok: true,
    templateId:        template.id,
    templateName:      template.name,
    contractType,
    title,
    counterpartyName,
    variables,
    html:              generated.html,
    unfilledVariables: [...new Set(generated.unfilledVariables)],
    templateVariables: keys,
    origin: {
      templateId:        template.id,
      templateName:      template.name,
      templateVersion:   source.snapshot.version,
      templateVersionId: source.templateVersionId,
      templateDecidedBy: chosen.decidedBy,
      slots:             resolved.slots,
      variables:         Object.entries(variables).map(([key, value]) => ({ key, value, source: sources[key]?.source ?? stated, ...(sources[key]?.quote ? { quote: sources[key].quote } : {}) })),
      sections:          generated.sections,
    },
    slotChoices: Object.fromEntries(resolved.slots.filter(s => s.variantId).map(s => [s.familyId, s.variantId!])),
    slotDecisions: Object.fromEntries(resolved.slots.filter(s => s.variantId).map(s => [s.familyId, {
      decidedBy: s.decidedBy, ...(s.ruleId && { ruleId: s.ruleId }), ...(s.rule && { rule: s.rule }), ...(s.evidence && { evidence: s.evidence }),
    }])),
    variableSources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.source])),
    slots:       resolved.slots,
  }
}

/**
 * docs/41 Part 1 — the assistant's Apply: the planned draft made from the
 * template's published snapshot with the same variant in each slot, so the
 * contract says exactly what the confirm card showed. How each slot and
 * value was decided comes from the plan (`decisions`, `variableSources`)
 * when it is given; a slot it doesn't cover is decided again by rule.
 */
export async function renderPlanned(input: {
  orgId: string
  template: { id: string; name: string; publishedVersionId: string | null }
  variables: Record<string, string>
  slotChoices?: Record<string, string>
  decisions?: Record<string, Partial<Pick<SlotResolution, 'decidedBy' | 'ruleId' | 'rule' | 'evidence'>>>
  variableSources?: Record<string, string>
  contractType?: string | null
}): Promise<{ html: string; unfilledVariables: string[]; sectionsIncluded: number; sectionsExcluded: number; origin: DraftOrigin } | null> {
  const source = await draftSource(input.orgId, input.template)
  if (!source) return null
  const template = asTemplate(source.snapshot, input.orgId)
  const clauseRefs = template.sections.flatMap(s => (Array.isArray(s.clauseRefs) ? (s.clauseRefs as string[]) : []))
  const clauseItems = clauseRefs.length
    ? await prisma.clauseLibraryItem.findMany({ where: { id: { in: clauseRefs }, orgId: input.orgId, deletedAt: null } })
    : []
  const resolved = resolveSlots({
    snapshot: source.snapshot,
    choices: input.slotChoices,
    facts: { contractType: input.contractType ?? source.snapshot.contractType ?? undefined, paperSource: 'ours' },
  })
  const slots = resolved.slots.map(s => {
    const planned = input.decisions?.[s.familyId]
    // The plan's reason stands only for the variant it chose.
    return planned?.decidedBy && s.decidedBy === 'user' && input.slotChoices?.[s.familyId] === s.variantId
      ? { ...s, decidedBy: planned.decidedBy, ...(planned.ruleId && { ruleId: planned.ruleId }), ...(planned.rule && { rule: planned.rule }), ...(planned.evidence && { evidence: planned.evidence }) }
      : s
  })
  const generated = generateDocument({ template, variables: input.variables, clauseMap: new Map(clauseItems.map(c => [c.id, c])), slotText: resolved.slotText })
  const KNOWN = new Set<VariableSource>(['user', 'request_field', 'request_value', 'request_text', 'org_default', 'template_default', 'our_org', 'counterparty_record', 'clause_choice'])
  return {
    html: generated.html,
    unfilledVariables: generated.unfilledVariables,
    sectionsIncluded: generated.sectionsIncluded,
    sectionsExcluded: generated.sectionsExcluded,
    origin: {
      templateId: template.id,
      templateName: template.name,
      templateVersion: source.snapshot.version,
      templateVersionId: source.templateVersionId,
      templateDecidedBy: 'explicit',
      slots,
      variables: Object.entries(input.variables).map(([key, value]) => {
        const s = input.variableSources?.[key] as VariableSource | undefined
        return { key, value: String(value), source: s && KNOWN.has(s) ? s : 'user' }
      }),
      sections: generated.sections,
    },
  }
}
