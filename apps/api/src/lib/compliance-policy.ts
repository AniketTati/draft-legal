/**
 * Compliance applicability (docs/41 Part 9): facts + the org's policy →
 * which frameworks apply, and why. Deterministic: no model is asked whether
 * GDPR applies; the AI only reads facts, each with a quote.
 *
 * Every answer is yes, no or unsure:
 *   - a fact counts when a person confirmed it, or the AI read it with
 *     confidence ≥ FACT_CONFIDENCE_THRESHOLD; otherwise it is unknown;
 *   - a rule holds when all its conditions do, fails when one fails, and is
 *     unsure otherwise; a framework applies when one of its rules holds.
 * An unsure framework asks ONE question: the first unknown fact a rule
 * needs, in COMPLIANCE_FACT_KEYS order, that nobody has answered yet.
 */
import {
  COMPLIANCE_FACT_KEYS, COMPLIANCE_FACTS, COMPLIANCE_FRAMEWORK_IDS, COMPLIANCE_FRAMEWORK_LABELS,
  type ComplianceFactEvidence, type ComplianceFactKey, type ComplianceFrameworkId, type ComplianceQuestion,
  type FrameworkApplicability, type PolicyCondition, type PolicyRule,
} from '@clm/types'

export const FACT_CONFIDENCE_THRESHOLD = 0.6

/** The rules an org has until an admin changes them. */
export const DEFAULT_COMPLIANCE_POLICY: PolicyRule[] = [
  { id: 'gdpr-eu-subjects', framework: 'GDPR', enabled: true, when: [{ fact: 'personal_data', op: 'is_true' }, { fact: 'data_subject_regions', op: 'includes_any', values: ['EU'] }] },
  { id: 'gdpr-eu-party', framework: 'GDPR', enabled: true, when: [{ fact: 'personal_data', op: 'is_true' }, { fact: 'party_jurisdictions', op: 'includes_any', values: ['EU'] }] },
  { id: 'uk-gdpr-uk-subjects', framework: 'UK_GDPR', enabled: true, when: [{ fact: 'personal_data', op: 'is_true' }, { fact: 'data_subject_regions', op: 'includes_any', values: ['UK'] }] },
  { id: 'uk-gdpr-uk-party', framework: 'UK_GDPR', enabled: true, when: [{ fact: 'personal_data', op: 'is_true' }, { fact: 'party_jurisdictions', op: 'includes_any', values: ['UK'] }] },
  { id: 'hipaa-health-covered', framework: 'HIPAA', enabled: true, when: [{ fact: 'health_data', op: 'is_true' }, { fact: 'hipaa_covered_entity', op: 'is_true' }] },
  { id: 'ccpa-california', framework: 'CCPA', enabled: true, when: [{ fact: 'personal_data', op: 'is_true' }, { fact: 'data_subject_regions', op: 'includes_any', values: ['US-CA'] }] },
  { id: 'sox-public-reporting', framework: 'SOX', enabled: true, when: [{ fact: 'financial_reporting_impact', op: 'is_true' }, { fact: 'public_company', op: 'is_true' }] },
  { id: 'pci-card-data', framework: 'PCI_DSS', enabled: true, when: [{ fact: 'payment_card_data', op: 'is_true' }] },
]

/** A fact as stored (ContractFact). */
export interface StoredFact {
  key: string
  value: unknown
  quote: string | null
  confidence: number
  confirmedAt: Date | string | null
}

// EU and EEA members: GDPR applies to all of them.
const EU_EEA = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'EEA', 'EUROPEAN UNION',
])
const ALIASES: Record<string, string> = {
  GB: 'UK', 'UNITED KINGDOM': 'UK', ENGLAND: 'UK', SCOTLAND: 'UK', WALES: 'UK', 'NORTHERN IRELAND': 'UK',
  USA: 'US', 'UNITED STATES': 'US', CALIFORNIA: 'US-CA', CA_US: 'US-CA', 'US_CA': 'US-CA',
}

/**
 * Region codes as the rules compare them: "GB" is "UK", "California" is "US-CA";
 * and, for a fact's value (`widen`), "DE" is also in the "EU", "US-CA" also in the "US".
 * A rule's own codes are not widened: a rule for "US-CA" isn't one for all the US.
 */
export function normaliseRegions(values: unknown, widen = true): Set<string> {
  const out = new Set<string>()
  for (const raw of Array.isArray(values) ? values : [values]) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const v = raw.trim().toUpperCase()
    const code = ALIASES[v] ?? v
    out.add(code)
    if (!widen) continue
    if (EU_EEA.has(code)) out.add('EU')
    if (code.startsWith('US-')) out.add('US')
  }
  return out
}

type Tri = true | false | null

interface FactState {
  fact?: StoredFact
  /** The value the rules may use; undefined when unknown. */
  value?: unknown
  confirmed: boolean
}

function stateOf(facts: Map<string, StoredFact>, key: ComplianceFactKey): FactState {
  const fact = facts.get(key)
  if (!fact) return { confirmed: false }
  const confirmed = !!fact.confirmedAt
  const usable = fact.value !== null && fact.value !== undefined && (confirmed || fact.confidence >= FACT_CONFIDENCE_THRESHOLD)
  return { fact, value: usable ? fact.value : undefined, confirmed }
}

function test(cond: PolicyCondition, state: FactState): Tri {
  if (state.value === undefined) return null
  if (cond.op === 'is_true') return state.value === true ? true : state.value === false ? false : null
  const have = normaliseRegions(state.value)
  const want = normaliseRegions(cond.values ?? [], false)
  return [...want].some(w => have.has(w))
}

function evidenceOf(key: ComplianceFactKey, state: FactState): ComplianceFactEvidence {
  return {
    key,
    label: COMPLIANCE_FACTS[key].label,
    value: state.fact?.value ?? null,
    quote: state.fact?.quote ?? null,
    confidence: state.fact?.confidence ?? 0,
    confirmed: state.confirmed,
  }
}

export interface PolicyEvaluation {
  frameworks: FrameworkApplicability[]
  question: ComplianceQuestion | null
}

/**
 * Evaluate the rules over the facts. `added` are frameworks someone added
 * by hand: they apply whatever the facts say.
 */
export function evaluatePolicy(rules: PolicyRule[], factList: StoredFact[], added: string[] = []): PolicyEvaluation {
  const facts = new Map(factList.map(f => [f.key, f]))
  const states = new Map(COMPLIANCE_FACT_KEYS.map(k => [k, stateOf(facts, k)] as const))
  const enabled = rules.filter(r => r.enabled)
  const frameworks: FrameworkApplicability[] = []
  const unknownNeeded = new Set<ComplianceFactKey>()

  for (const framework of COMPLIANCE_FRAMEWORK_IDS) {
    const own = enabled.filter(r => r.framework === framework)
    const byHand = added.includes(framework)
    if (!own.length && !byHand) continue
    let holds: PolicyRule | undefined
    const failing = new Map<ComplianceFactKey, ComplianceFactEvidence>()
    const unknown = new Map<ComplianceFactKey, ComplianceFactEvidence>()
    for (const rule of own) {
      const results = rule.when.map(c => ({ c, r: test(c, states.get(c.fact)!) }))
      const failed = results.find(x => x.r === false)
      if (failed) { failing.set(failed.c.fact, evidenceOf(failed.c.fact, states.get(failed.c.fact)!)); continue }
      if (results.every(x => x.r === true)) { holds = rule; break }
      for (const x of results) if (x.r === null) unknown.set(x.c.fact, evidenceOf(x.c.fact, states.get(x.c.fact)!))
    }
    const label = COMPLIANCE_FRAMEWORK_LABELS[framework]
    if (holds) {
      frameworks.push({
        framework, label, applies: 'yes', ruleId: holds.id, addedByUser: byHand || undefined,
        because: holds.when.map(c => evidenceOf(c.fact, states.get(c.fact)!)),
      })
    } else if (byHand) {
      frameworks.push({ framework, label, applies: 'yes', addedByUser: true, because: [] })
    } else if (unknown.size) {
      for (const k of unknown.keys()) unknownNeeded.add(k)
      frameworks.push({ framework, label, applies: 'unsure', because: [...unknown.values()] })
    } else {
      frameworks.push({ framework, label, applies: 'no', because: [...failing.values()] })
    }
  }

  // One question: the first unknown fact a rule needs that nobody has answered ("Not sure" counts as answered).
  const key = COMPLIANCE_FACT_KEYS.find(k => unknownNeeded.has(k) && !states.get(k)!.confirmed && COMPLIANCE_FACTS[k].question)
  const spec = key ? COMPLIANCE_FACTS[key] : null
  const question: ComplianceQuestion | null = key && spec ? {
    key,
    text: spec.question!,
    kind: spec.kind,
    options: spec.kind === 'boolean'
      ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'unsure', label: 'Not sure' }]
      : [...(spec.options ?? []), { value: 'unsure', label: 'Not sure' }],
  } : null

  return { frameworks, question }
}

/** The frameworks that apply. */
export const applyingFrameworks = (e: PolicyEvaluation): ComplianceFrameworkId[] =>
  e.frameworks.filter(f => f.applies === 'yes').map(f => f.framework)
