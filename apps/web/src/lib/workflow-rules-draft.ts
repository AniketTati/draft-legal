/**
 * Z3 — the workflow builder's "When to use this workflow" fields, as the
 * inputs hold them, and the triggerRules they save. The rules themselves, and
 * how a workflow is chosen, are in @clm/types (workflow-rules.ts).
 */
import { ContractType, readTriggerRules, type AutoApproveRule, type TriggerRules } from '@clm/types'

export const RULE_CONTRACT_TYPES = Object.values(ContractType)
export const RULE_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'CAD', 'AUD', 'SGD', 'CHF']

export const typeLabel = (t: string) => (t === 'ANY' ? 'Any type' : t.replace(/_/g, ' '))

export interface RulesDraft {
  contractTypes:  ContractType[]
  /** Text of the minimum-value input; empty for any value. */
  valueThreshold: string
  currency:       string
  autoApprove:    Array<{ contractType: AutoApproveRule['contractType']; maxValue: string }>
}

export function draftFromRules(raw: unknown): RulesDraft {
  const rules = readTriggerRules(raw)
  return {
    contractTypes:  rules.contractTypes ?? [],
    valueThreshold: rules.valueThreshold != null ? String(rules.valueThreshold) : '',
    currency:       rules.currency ?? 'USD',
    autoApprove:    (rules.autoApproveRules ?? []).map(r => ({ contractType: r.contractType, maxValue: String(r.maxValue) })),
  }
}

const amount = (text: string): number | null => {
  const n = Number(text.replace(/,/g, '').trim())
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null
}

/** What stops the fields being saved, in words for the builder; null when they can be. */
export function rulesDraftError(d: RulesDraft): string | null {
  if (d.valueThreshold.trim() !== '' && amount(d.valueThreshold) == null) return 'The minimum value must be a number, 0 or more.'
  if (d.autoApprove.some(r => amount(r.maxValue) == null)) return 'Give each automatic approval a limit: a number, 0 or more.'
  return null
}

/** The triggerRules to save. Only what is set: an empty field adds no rule. */
export function rulesFromDraft(d: RulesDraft): TriggerRules {
  const threshold = amount(d.valueThreshold)
  const autoApproveRules = d.autoApprove.flatMap(r => {
    const maxValue = amount(r.maxValue)
    return maxValue == null ? [] : [{ contractType: r.contractType, maxValue }]
  })
  return {
    ...(d.contractTypes.length > 0 && { contractTypes: d.contractTypes }),
    ...(threshold != null && { valueThreshold: threshold }),
    ...((threshold != null || autoApproveRules.length > 0) && { currency: d.currency }),
    ...(autoApproveRules.length > 0 && { autoApproveRules }),
  }
}

/** One line for the workflow list: what the rules send here and approve at once. */
export function describeRules(raw: unknown): string {
  const rules = readTriggerRules(raw)
  const money = (n: number) => `${rules.currency ?? 'USD'} ${n.toLocaleString('en-US')}`
  const parts = [
    rules.contractTypes?.length ? rules.contractTypes.map(typeLabel).join(', ') : 'Every type',
  ]
  if (rules.valueThreshold != null) parts.push(`from ${money(rules.valueThreshold)}`)
  for (const r of rules.autoApproveRules ?? []) {
    parts.push(`approves ${r.contractType === 'ANY' ? 'any type' : typeLabel(r.contractType)} up to ${money(r.maxValue)} at once`)
  }
  return parts.join(' · ')
}
