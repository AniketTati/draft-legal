/**
 * docs/39 H3 — the values a contract was drafted with, as its fields.
 *
 * A template's variables name the terms the drafter filled in: the
 * counterparty, the effective date, the fees, the term. Those are known, not
 * guesses — but a contract created from a template had no fields until
 * someone ran an analysis, which then guessed them back from the text. Now
 * each variable that names a field becomes that field's value, saved as set
 * from the template (source "variable"): an extraction fills the rest and
 * leaves these alone, as it does anything a person set.
 */
import { canonicalFieldKey, parseFieldValue, type DateOrder } from '@clm/types'
import type { FieldDef, PersonValue } from './field-store.js'

/** Variable names templates use for a core field, beyond the registry's own spellings. */
const VARIABLE_ALIASES: Record<string, string> = {
  counterparty: 'counterpartyName', counterparty_name: 'counterpartyName', counterparty_legal_name: 'counterpartyName',
  counterparty_address: 'counterpartyAddress',
  effective_date: 'effectiveDate', start_date: 'effectiveDate', commencement_date: 'effectiveDate',
  end_date: 'expiryDate', expiry_date: 'expiryDate', expiration_date: 'expiryDate',
  execution_date: 'executionDate', signature_date: 'executionDate',
  term: 'initialTerm', initial_term: 'initialTerm', term_length: 'initialTerm', term_months: 'initialTerm', term_years: 'initialTerm',
  renewal_term: 'renewalTerm', auto_renew: 'autoRenew', auto_renewal: 'autoRenew',
  non_renewal_notice: 'nonRenewalNotice', non_renewal_notice_days: 'nonRenewalNotice',
  termination_notice: 'terminationNotice', termination_notice_days: 'terminationNotice',
  governing_law: 'governingLaw', governing_state: 'governingLaw', jurisdiction: 'governingLaw',
  venue: 'venue', courts: 'venue',
  fees: 'value', fee: 'value', total_fees: 'value', contract_value: 'value', total_value: 'value', amount: 'value', price: 'value',
  currency: 'currency',
  payment_terms: 'paymentTermsDays', payment_terms_days: 'paymentTermsDays', payment_days: 'paymentTermsDays', net_days: 'paymentTermsDays',
  payment_frequency: 'paymentFrequency', billing_frequency: 'paymentFrequency',
  liability_cap: 'liabilityCapAmount',
}

const snake = (key: string) => key.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase()
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/**
 * The field a template variable names, if any. docs/39 H1/H2 — the field
 * its author named (VariableDef.field) comes first; one named "no field"
 * (null) fills none.
 */
export function fieldForVariable(defs: FieldDef[], key: string, named?: Record<string, string | null>): FieldDef | undefined {
  const byKey = (k: string) => defs.find(d => d.key === k)
  if (named && key in named) return named[key] ? byKey(named[key]!) : undefined
  const s = snake(key)
  return byKey(key) ?? byKey(s)
    ?? (VARIABLE_ALIASES[s] ? byKey(VARIABLE_ALIASES[s]) : undefined)
    ?? byKey(canonicalFieldKey(camel(s)))
}

/** A bare number for a length of time takes its unit from the variable's name: term_months = 12 → 12 months. */
function withUnit(key: string, raw: unknown): unknown {
  if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(raw))) return raw
  const unit = /month/i.test(key) ? 'months' : /year/i.test(key) ? 'years' : /week/i.test(key) ? 'weeks' : /day/i.test(key) ? 'days' : null
  return unit ? `${String(raw).trim()} ${unit}` : raw
}

/**
 * The fields a template's filled-in variables give a contract: each variable
 * that names one of its fields and whose value reads as that field's type.
 * Empty values, legacy fields and values that don't read are left out (the
 * extraction reads those from the text).
 */
export function fieldsFromVariables(
  variables: Record<string, unknown> | null | undefined,
  defs: FieldDef[],
  opts: { dateOrder?: DateOrder; named?: Record<string, string | null> } = {},
): PersonValue[] {
  const out = new Map<string, PersonValue>()
  for (const [key, raw] of Object.entries(variables ?? {})) {
    if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) continue
    const def = fieldForVariable(defs, key, opts.named)
    if (!def || def.legacy || out.has(def.key)) continue
    const value = def.type === 'duration' ? withUnit(key, raw) : raw
    const parsed = parseFieldValue(def.type, value, { options: def.options, dateOrder: opts.dateOrder })
    if (!parsed.ok || parsed.value === null) continue
    out.set(def.key, { key: def.key, raw: parsed.value, source: 'variable' })
  }
  return [...out.values()]
}
