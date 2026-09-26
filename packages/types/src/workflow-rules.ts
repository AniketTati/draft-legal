/**
 * Z3 — which approval workflow a contract goes to, and when it is approved at
 * once. Shared by the API, which routes, and the web app, which shows the
 * sender the workflow that will run, so the two cannot disagree.
 *
 * A workflow's `triggerRules`:
 *   contractTypes     the types it is for; empty or absent means every type
 *   valueThreshold    it is only for contracts worth at least this much
 *   currency          what the values in these rules are in (USD if absent)
 *   autoApproveRules  a contract of `contractType` ('ANY' for every type)
 *                     worth at most `maxValue` is approved without a person
 */
import { z } from 'zod'
import { ContractType } from './enums'

const amount = z.number().finite().nonnegative()

export const AutoApproveRuleSchema = z.object({
  contractType: z.union([z.literal('ANY'), z.nativeEnum(ContractType)]),
  maxValue:     amount,
}).strict()

export const TriggerRulesSchema = z.object({
  contractTypes:    z.array(z.nativeEnum(ContractType)).optional(),
  valueThreshold:   amount.optional(),
  currency:         z.string().regex(/^[A-Z]{3}$/, 'a three-letter currency code, such as USD').optional(),
  autoApproveRules: z.array(AutoApproveRuleSchema).max(20).optional(),
}).strict()

export type AutoApproveRule = z.infer<typeof AutoApproveRuleSchema>
export type TriggerRules = z.infer<typeof TriggerRulesSchema>

export interface RoutedContract {
  type:      string
  value:     number | null | undefined
  currency?: string | null
}

export interface RoutableWorkflow {
  isDefault:    boolean
  createdAt:    Date | string
  triggerRules?: unknown
}

/** A workflow's rules as stored. Rules saved before they were checked keep their sound parts. */
export function readTriggerRules(raw: unknown): TriggerRules {
  const parsed = TriggerRulesSchema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    contractTypes:    Array.isArray(r.contractTypes) ? r.contractTypes.filter((t): t is ContractType => (Object.values(ContractType) as unknown[]).includes(t)) : undefined,
    valueThreshold:   amount.safeParse(r.valueThreshold).success ? (r.valueThreshold as number) : undefined,
    currency:         typeof r.currency === 'string' ? r.currency : undefined,
    autoApproveRules: Array.isArray(r.autoApproveRules)
      ? r.autoApproveRules.flatMap(x => { const p = AutoApproveRuleSchema.safeParse(x); return p.success ? [p.data] : [] })
      : undefined,
  }
}

/** The contract's value in the rules' currency, or null when it can't be compared. */
function valueIn(rules: TriggerRules, c: RoutedContract): number | null {
  if (c.value == null || !Number.isFinite(c.value)) return null
  return (c.currency ?? 'USD') === (rules.currency ?? 'USD') ? c.value : null
}

/**
 * Whether a workflow's rules cover this contract. A contract whose value is
 * unknown, or in another currency, counts as meeting any value floor, so it
 * gets the more careful review.
 */
export function workflowApplies(triggerRules: unknown, c: RoutedContract): boolean {
  const rules = readTriggerRules(triggerRules)
  const types = rules.contractTypes ?? []
  if (types.length > 0 && !types.includes(c.type as ContractType)) return false
  const value = valueIn(rules, c)
  return rules.valueThreshold == null || value == null || value >= rules.valueThreshold
}

/**
 * The workflow a contract goes to when the sender doesn't choose one: of the
 * workflows that cover it, one naming its type before one for every type,
 * then the highest value floor, then the default, then the oldest. When none
 * covers it, the default workflow; failing that, none.
 */
export function pickWorkflow<W extends RoutableWorkflow>(workflows: W[], c: RoutedContract): W | null {
  const time = (w: W) => new Date(w.createdAt).getTime()
  const named = (w: W) => (readTriggerRules(w.triggerRules).contractTypes ?? []).length > 0 ? 1 : 0
  const floor = (w: W) => readTriggerRules(w.triggerRules).valueThreshold ?? -1
  const fitting = workflows
    .filter(w => workflowApplies(w.triggerRules, c))
    .sort((a, b) =>
      named(b) - named(a)
      || floor(b) - floor(a)
      || Number(b.isDefault) - Number(a.isDefault)
      || time(a) - time(b))
  return fitting[0] ?? workflows.find(w => w.isDefault) ?? null
}

/**
 * Whether a workflow approves this contract without a person. Only a known
 * value, in the rules' currency, at or under a matching rule's limit: a
 * contract with no value always goes to a person (Wave 1.6).
 */
export function autoApproves(triggerRules: unknown, c: RoutedContract): boolean {
  const rules = readTriggerRules(triggerRules)
  const value = valueIn(rules, c)
  if (value == null) return false
  return (rules.autoApproveRules ?? []).some(r =>
    (r.contractType === 'ANY' || r.contractType === c.type) && value <= r.maxValue)
}
