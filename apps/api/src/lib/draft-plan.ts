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
import { prisma } from './prisma.js'
import { generateDocument, type TemplateWithSections } from './template-engine.js'

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
}

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
    }
  | { ok: false; status: 404 | 422; error: string; detail: string; templates?: Array<{ id: string; name: string; contractType: string | null }> }

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

export async function planDraft(input: DraftPlanInput): Promise<DraftPlan> {
  const base = { orgId: input.orgId, deletedAt: null, isPublished: true }
  const include = { sections: { orderBy: { sortOrder: 'asc' as const } } }

  let contractType = input.contractType?.toUpperCase() ?? null
  let template: TemplateWithSections | null

  if (input.templateId) {
    template = await prisma.template.findFirst({ where: { ...base, id: input.templateId }, include })
    if (!template) {
      return { ok: false, status: 404, error: 'TEMPLATE_NOT_FOUND', detail: 'No published template with that id in this organization.' }
    }
    contractType = contractType ?? template.contractType ?? 'OTHER'
  } else {
    contractType = contractType ?? inferContractType(input.userMessage)
    if (!contractType) {
      return {
        ok: false, status: 422, error: 'CONTRACT_TYPE_AMBIGUOUS',
        detail: `Could not tell which contract to draft. Pass contract_type (${DRAFT_CONTRACT_TYPES.join(' | ')}) or a template_id from template_list.`,
      }
    }
    template = await prisma.template.findFirst({
      where: { ...base, contractType }, include, orderBy: { updatedAt: 'desc' },
    })
    if (!template) {
      // Untyped templates are real options too — match them by what they say they are.
      const words = TYPE_WORDS[contractType] ?? [contractType.toLowerCase()]
      const untyped = await prisma.template.findMany({ where: { ...base, contractType: null }, include, orderBy: { updatedAt: 'desc' } })
      template = untyped.find(t => {
        const text = `${t.name} ${t.description ?? ''}`.toLowerCase()
        return words.some(w => text.includes(w))
      }) ?? null
    }
    if (!template) {
      const templates = await prisma.template.findMany({
        where: base, select: { id: true, name: true, contractType: true }, orderBy: { updatedAt: 'desc' }, take: 20,
      })
      return {
        ok: false, status: 422, error: 'NO_TEMPLATE_MATCH',
        detail: templates.length
          ? `No published ${contractType} template. Pick one of the org's published templates by id, or create a ${contractType} template in Templates first.`
          : `Your org has no published templates yet. Create a ${contractType} template in Templates first.`,
        templates,
      }
    }
  }

  // Clause-library references the template's sections point at.
  const clauseRefs = template.sections.flatMap(s => (Array.isArray(s.clauseRefs) ? (s.clauseRefs as string[]) : []))
  const clauseItems = clauseRefs.length
    ? await prisma.clauseLibraryItem.findMany({ where: { id: { in: clauseRefs }, orgId: input.orgId, deletedAt: null } })
    : []
  const clauseMap = new Map(clauseItems.map(c => [c.id, c]))
  const keys = templateKeys(template, clauseItems.map(c => c.content))
  const byNorm = new Map(keys.map(k => [norm(k), k]))

  const variables: Record<string, string> = {}
  const fill = (aliases: string[], value: string | undefined | null) => {
    if (!value?.trim()) return
    for (const a of aliases) {
      const key = byNorm.get(a)
      if (key && variables[key] === undefined) variables[key] = value.trim()
    }
  }

  // 1. What the user said. Free-form terms first, matched to template keys.
  for (const [k, v] of Object.entries(input.terms ?? {})) {
    const key = byNorm.get(norm(k))
    if (key && typeof v === 'string' && v.trim()) variables[key] = v.trim()
  }
  fill(ALIASES.counterparty, input.counterpartyName)
  fill(ALIASES.governingLaw, input.governingLaw)
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
  const declared = Array.isArray(template.variables) ? template.variables as Array<{ key?: string; defaultValue?: unknown }> : []
  const lawKey = declared.find(d => d?.key && ALIASES.governingLaw.includes(norm(d.key)))
  const lawChanged = !!input.governingLaw?.trim() && lawKey?.defaultValue != null
    && norm(String(lawKey.defaultValue)) !== norm(input.governingLaw)
  for (const d of declared) {
    if (lawChanged && d?.key && /venue|forum|courtlocation|courts/.test(norm(d.key))) continue
    if (d?.key && partyFactOf(d.key, ourRole)?.side === 'theirs') continue
    if (d?.key && variables[d.key] === undefined && d.defaultValue != null && String(d.defaultValue).trim()) {
      variables[d.key] = String(d.defaultValue)
    }
  }

  // 3. Our side is a fact, not a guess; the counterparty takes the other role.
  const org = await prisma.organization.findUnique({ where: { id: input.orgId }, select: { name: true } })
  fill(ALIASES.ourCompany, org?.name)
  fill(ALIASES.ourRole, org?.name)
  fill(ALIASES.theirRole, input.counterpartyName)
  if (rolesByName) {
    const [ours, theirs] = weSell(template.name) ? ['providername', 'customername'] : ['customername', 'providername']
    fill([ours], org?.name)
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
    if (value?.trim()) variables[key] = value.trim()
  }

  const generated = generateDocument({ template, variables, clauseMap })
  const counterpartyName = input.counterpartyName?.trim() || null
  const title = input.title?.trim()
    || (counterpartyName ? `${counterpartyName} — ${contractType}` : `Draft — ${template.name}`)

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
  }
}
