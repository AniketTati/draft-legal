/**
 * docs/41 Part 18 — "Ask again after a change", as the workflow builder edits
 * it. A step's approval is asked for again when the contract changes after
 * it was given; each step says which changes count. The rule is stored on
 * the step as `resetOn`: a word ('always', 'never'…) or, for the two modes
 * that name things, { mode, clauseTypes } / { mode, fields }. The rule itself
 * (and how it is read) lives in @clm/types lifecycle.ts.
 */
import { readResetRule, type ResetMode, type ResetRule } from '@clm/types'

export const RESET_MODE_LABEL: Record<ResetMode, string> = {
  always:              'After any change',
  any_document_change: 'When the document changes',
  clause_text_changes: 'When these clauses change',
  fields:              'When these fields change',
  never:               'Never',
}

/** The contract fields a step can watch, as people name them. */
export const RESET_FIELD_LABEL: Record<string, string> = {
  value:         'Value',
  currency:      'Currency',
  type:          'Contract type',
  expiryDate:    'Expiry date',
  effectiveDate: 'Effective date',
}

export type StoredResetOn = ResetRule | ResetMode

/** What a step stores after its mode is chosen, keeping any list it already had for that mode. */
export function resetOnForMode(mode: ResetMode, prev: unknown): StoredResetOn {
  const was = readResetRule(prev)
  if (mode === 'clause_text_changes') return { mode, clauseTypes: was.mode === mode ? was.clauseTypes ?? [] : [] }
  if (mode === 'fields') return { mode, fields: was.mode === mode ? was.fields ?? [] : [] }
  return mode
}

/** The rule with one clause type or field added or taken off. */
export function toggleResetItem(prev: unknown, item: string): StoredResetOn {
  const r = readResetRule(prev)
  const flip = (xs: string[] = []) => (xs.includes(item) ? xs.filter(x => x !== item) : [...xs, item])
  if (r.mode === 'clause_text_changes') return { mode: r.mode, clauseTypes: flip(r.clauseTypes) }
  if (r.mode === 'fields') return { mode: r.mode, fields: flip(r.fields) }
  return r.mode
}

/** What is wrong with a step's rule before it is saved (the server says the same), or null. */
export function resetRuleProblem(stored: unknown): string | null {
  const r = readResetRule(stored)
  if (r.mode === 'fields' && !(r.fields ?? []).length) return 'Pick at least one field.'
  return null
}
