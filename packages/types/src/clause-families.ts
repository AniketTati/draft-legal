// ─── Clause families, variants and drafting origin — docs/41 Part 1 ─────────
//
// A clause family is one clause the org has approved alternatives for
// (Governing law), each alternative a library clause (a variant) with an
// optional condition that picks it for a draft. Drafting decides a slot by a
// fixed order — the user's choice, then a value the request named (matched
// exactly), then the first condition that holds, then the family's default —
// and when none decides, the draft asks. Never an LLM.
//
// The condition language and its evaluator live here so the API (drafting,
// lint) and the web app (the condition builder's preview) read conditions
// the same way.

/** What a condition can test: facts about the request or contract being drafted. */
export const CONDITION_KEYS = [
  { key: 'counterparty.country', label: 'Counterparty country', type: 'text' },
  { key: 'governingLaw',         label: 'Governing law asked for', type: 'text' },
  { key: 'value',                label: 'Contract value', type: 'number' },
  { key: 'contractType',         label: 'Contract type', type: 'text' },
  { key: 'paperSource',          label: 'Whose paper (ours or theirs)', type: 'text' },
] as const

export type ConditionKey = (typeof CONDITION_KEYS)[number]['key']
export type ConditionScalar = string | number | boolean

export type ClauseCondition =
  | { op: 'eq' | 'neq'; key: string; value: ConditionScalar }
  | { op: 'in'; key: string; value: ConditionScalar[] }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; key: string; value: number }
  | { op: 'and' | 'or'; all: ClauseCondition[] }

/** The facts a condition is judged on. A missing fact makes a test false, never true. */
export type ConditionFacts = Record<string, ConditionScalar | null | undefined>

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()
const present = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''

/** Whether a condition holds for these facts. Malformed conditions never hold. */
export function conditionHolds(cond: ClauseCondition | null | undefined, facts: ConditionFacts): boolean {
  if (!cond || typeof cond !== 'object') return false
  switch (cond.op) {
    case 'and': return Array.isArray(cond.all) && cond.all.length > 0 && cond.all.every(c => conditionHolds(c, facts))
    case 'or':  return Array.isArray(cond.all) && cond.all.some(c => conditionHolds(c, facts))
    default: break
  }
  const fact = facts[(cond as { key: string }).key]
  if (!present(fact)) return false
  switch (cond.op) {
    case 'eq':  return norm(fact) === norm(cond.value)
    case 'neq': return norm(fact) !== norm(cond.value)
    case 'in':  return Array.isArray(cond.value) && cond.value.some(v => norm(v) === norm(fact))
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = Number(fact), b = Number(cond.value)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      return cond.op === 'gt' ? a > b : cond.op === 'gte' ? a >= b : cond.op === 'lt' ? a < b : a <= b
    }
    default: return false
  }
}

/** Whether a value is a well-formed condition (from a request body or a stored row). */
export function isClauseCondition(c: unknown, depth = 0): c is ClauseCondition {
  if (!c || typeof c !== 'object' || depth > 4) return false
  const o = c as Record<string, unknown>
  if (o.op === 'and' || o.op === 'or') return Array.isArray(o.all) && o.all.length > 0 && o.all.length <= 20 && o.all.every(x => isClauseCondition(x, depth + 1))
  if (typeof o.key !== 'string' || !o.key.trim() || o.key.length > 64) return false
  const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  if (o.op === 'eq' || o.op === 'neq') return scalar(o.value)
  if (o.op === 'in') return Array.isArray(o.value) && o.value.length > 0 && o.value.length <= 100 && o.value.every(scalar)
  if (o.op === 'gt' || o.op === 'gte' || o.op === 'lt' || o.op === 'lte') return typeof o.value === 'number' && Number.isFinite(o.value)
  return false
}

const KEY_LABEL: Record<string, string> = Object.fromEntries(CONDITION_KEYS.map(k => [k.key, k.label.toLowerCase()]))
const OP_WORDS: Record<string, string> = { eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most' }

/** A condition in words: "Counterparty country is one of GB, IE". */
export function describeCondition(cond: ClauseCondition | null | undefined): string {
  if (!cond) return 'No condition'
  if (cond.op === 'and' || cond.op === 'or') return cond.all.map(c => (c.op === 'and' || c.op === 'or') ? `(${describeCondition(c)})` : describeCondition(c)).join(cond.op === 'and' ? ' and ' : ' or ')
  const test = cond as Exclude<ClauseCondition, { op: 'and' | 'or' }>
  const label = KEY_LABEL[test.key] ?? test.key
  const subject = label.charAt(0).toUpperCase() + label.slice(1)
  if (test.op === 'in') return `${subject} is one of ${test.value.join(', ')}`
  return `${subject} ${OP_WORDS[test.op] ?? test.op} ${String(test.value)}`
}

/** A value as the library compares it with a variant's names: case, punctuation and "the State of" aside. */
export function matchKey(v: unknown): string {
  return norm(v).replace(/^(the\s+)?(state|commonwealth|laws?)\s+of\s+(the\s+)?/, '').replace(/\s+law$/, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
}

// ─── Slot resolution ────────────────────────────────────────────────────────

/** How a slot's variant was decided, in the order drafting tries them. */
export type SlotDecidedBy = 'user' | 'request_value' | 'rule' | 'default' | 'unresolved'

export interface SlotVariant {
  id: string
  label: string
  version: number
  content: string
  condition: ClauseCondition | null
  matchValues: string[]
  isDefault: boolean
  order: number
}

export interface SlotFamily {
  id: string
  name: string
  requestKey: string | null
}

/** A request value, with the words it was read from when there are any. */
export interface EvidencedValue { value: string; quote?: string | null; source?: string }

export interface SlotDecision {
  familyId: string
  familyName: string
  decidedBy: SlotDecidedBy
  variantId: string | null
  variantLabel: string | null
  variantVersion: number | null
  /** The variant whose condition held (decidedBy rule). */
  ruleId?: string
  rule?: string
  evidence?: { key: string; value: string; quote?: string | null }
  /** Why it is unresolved, in words. */
  reason?: string
}

/**
 * Decide a slot. Deterministic: the same inputs give the same variant.
 *   1. the user's explicit choice;
 *   2. a value the request named for the family's key, matched to a variant
 *      by its names exactly (a named value nothing matches is NOT passed over
 *      for a default: the draft asks);
 *   3. the first variant (in order) whose condition holds;
 *   4. the family's default;
 *   5. unresolved.
 */
export function resolveSlot(input: {
  family: SlotFamily
  variants: SlotVariant[]
  choice?: string | null
  requestValues?: Record<string, EvidencedValue | undefined>
  facts?: ConditionFacts
}): SlotDecision {
  const { family } = input
  const variants = [...input.variants].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  const base = { familyId: family.id, familyName: family.name }
  const pick = (v: SlotVariant, decidedBy: SlotDecidedBy, extra: Partial<SlotDecision> = {}): SlotDecision =>
    ({ ...base, decidedBy, variantId: v.id, variantLabel: v.label, variantVersion: v.version, ...extra })

  if (input.choice) {
    const chosen = variants.find(v => v.id === input.choice)
    if (chosen) return pick(chosen, 'user')
  }
  const asked = family.requestKey ? input.requestValues?.[family.requestKey] : undefined
  if (asked && String(asked.value ?? '').trim()) {
    const want = matchKey(asked.value)
    const hit = variants.find(v => [v.label, ...v.matchValues].some(n => matchKey(n) === want))
    if (hit) return pick(hit, 'request_value', { evidence: { key: family.requestKey!, value: asked.value, quote: asked.quote ?? null } })
    return {
      ...base, decidedBy: 'unresolved', variantId: null, variantLabel: null, variantVersion: null,
      evidence: { key: family.requestKey!, value: asked.value, quote: asked.quote ?? null },
      reason: `The request asks for ${asked.value}, and no approved ${family.name.toLowerCase()} clause is for it.`,
    }
  }
  for (const v of variants) {
    if (v.condition && conditionHolds(v.condition, input.facts ?? {})) {
      return pick(v, 'rule', { ruleId: v.id, rule: describeCondition(v.condition) })
    }
  }
  const dflt = variants.find(v => v.isDefault)
  if (dflt) return pick(dflt, 'default')
  return {
    ...base, decidedBy: 'unresolved', variantId: null, variantLabel: null, variantVersion: null,
    reason: variants.length ? 'No rule decided it and there is no default.' : 'This clause has no approved wording yet.',
  }
}

/** The key an unresolved slot's blank carries in the draft (an open choice). */
export const slotChoiceKey = (familyId: string) => `slot_${familyId.replace(/[^A-Za-z0-9_]/g, '_')}`

// ─── A draft's origin (metadata._origin) ────────────────────────────────────

/** Where a draft variable's value came from. */
export type VariableSource =
  | 'user' | 'request_field' | 'request_value' | 'request_text'
  | 'org_default' | 'template_default' | 'our_org' | 'counterparty_record' | 'clause_choice'

export interface DraftOrigin {
  templateId: string
  templateName: string
  /** The published snapshot's version the draft was made from. */
  templateVersion: number
  templateVersionId: string | null
  /** How the template was chosen. */
  templateDecidedBy: 'explicit' | 'default_for_type' | 'only_one'
  slots: Array<SlotDecision & { sectionId: string; options: Array<{ id: string; label: string }> }>
  variables: Array<{ key: string; value: string; source: VariableSource; quote?: string | null }>
  sections: Array<{ sectionId: string; slot?: string; fp: string; source: string }>
}

export const SLOT_DECIDED_BY_LABEL: Record<SlotDecidedBy, string> = {
  user: 'Chosen by a person',
  request_value: 'Named in the request',
  rule: 'Picked by your rule',
  default: 'Your default',
  unresolved: 'Choice needed',
}
