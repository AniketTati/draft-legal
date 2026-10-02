/**
 * Which field a highlighted passage is the value of (docs/39 C2).
 *
 * A reader who selects "thirty (30) days' written notice" means a notice;
 * "USD 12,500 per month" means the contract value; "governed by the laws of
 * the State of New York" means the governing law, and its value is "New
 * York", not the sentence. Each field scores on whether the words read as
 * its type, whether they name it, and whether it is still empty; the value
 * offered is the passage cleaned for that field.
 */
import { parseFieldValue, type DateOrder, type FieldValueType } from '@clm/types'

export interface MatchableField {
  key: string
  label: string
  type: FieldValueType
  options?: string[]
  legacy?: boolean
  /** A number's unit ("days" for payment terms). */
  unit?: string
  value: unknown
}

export interface FieldMatch<F extends MatchableField> {
  field: F
  /** The value the passage gives this field, or the passage itself when it doesn't read as one. */
  value: unknown
  /** How the value reads ("30 days"); null when the passage doesn't read as the field's type. */
  display: string | null
  score: number
}

const UNIT = /\b(days?|weeks?|months?|years?)\b/i
const MONEY = /[$€£¥₹]|\b[A-Z]{3}\s?\d|\d\s?[A-Z]{3}\b/
const PERCENT = /%|\bper\s?cent\b/i
/** Label words too common in contracts to say which field a passage is about. */
const GENERIC = new Set(['date', 'value', 'name', 'type', 'other', 'with', 'from', 'this', 'that', 'days', 'period'])

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** The words a field is known by: its label's, and its key's ("nonRenewalNotice" → non renewal notice). */
function stems(f: MatchableField): string[] {
  const words = `${f.label} ${f.key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')}`
    .toLowerCase().split(/[^a-z]+/)
    .filter(w => w.length >= 4 && !GENERIC.has(w))
  return [...new Set(words.map(w => w.slice(0, 6)))]
}

/**
 * The words contracts use for a core field that its label doesn't have:
 * payment terms are "payable within", an effective date is "as of".
 */
const CUES: Record<string, RegExp> = {
  effectiveDate: /\b(effective|commenc|as of|start)/i,
  expiryDate: /\b(expir|until|end(s|ing)? on|through)/i,
  executionDate: /\b(signed|executed|execution|dated)/i,
  initialTerm: /\b(initial|commenc|begin|period of)/i,
  renewalTerm: /\b(renew|successive|additional)/i,
  autoRenew: /\b(automatic|renew)/i,
  nonRenewalNotice: /\b(non-?renew|not to renew|prevent.*renew|notice of non)/i,
  terminationNotice: /\b(terminat)/i,
  terminationForConvenience: /\b(convenience|without cause|any reason)/i,
  counterpartyAddress: /\b(address|office|located at|street|suite)\b/i,
  signatories: /\b(by:|name:|title:|signature|authori[sz]ed)/i,
  value: /\b(fee|price|pay|total|consideration|compensation)/i,
  paymentTermsDays: /\b(payab|payment|invoice|net\s?\d)/i,
  paymentFrequency: /\b(monthly|quarterly|annual|yearly|invoic|in arrears|in advance|milestone)/i,
  governingLaw: /\b(govern|laws of|construed)/i,
  venue: /\b(court|jurisdiction|venue|arbitrat|forum)/i,
  liabilityCapAmount: /\b(liabilit|exceed|cap|aggregate)/i,
  ipOwnership: /\b(intellectual property|ownership|owned by|work made for hire|deliverables)/i,
  confidentiality: /\b(confidential)/i,
  exclusivity: /\b(exclusiv)/i,
  terminationRights: /\b(terminat)/i,
}

/** Words a passage must have to be this field: a notice period says "notice". */
const NEEDS: Record<string, RegExp> = {
  nonRenewalNotice: /\b(notice|notify|notif)/i,
  terminationNotice: /\b(notice|notify|notif)/i,
  liabilityCapAmount: /\b(liabilit|exceed|cap\b|aggregate)/i,
}

/** Words that say a passage is about a neighbouring field instead. */
const AGAINST: Record<string, RegExp> = {
  initialTerm: /\b(renew|successive|notice|payab|invoice)/i,
  renewalTerm: /\b(initial|notice|payab|invoice)/i,
  nonRenewalNotice: /\b(convenience|without cause|breach)/i,
  terminationNotice: /\b(non-?renew|not to renew)/i,
  effectiveDate: /\b(expir|terminat|until)/i,
  expiryDate: /\b(effective as of|commenc)/i,
}

function names(f: MatchableField, text: string, words: string[]): number {
  let hits = 0
  for (const s of stems(f)) {
    // A short word must be itself: "term" is not "terminate".
    const hit = s.length < 5
      ? words.some(w => w === s || w === `${s}s`)
      : words.some(w => w.length >= 4 && (w.startsWith(s) || (w.length >= 5 && s.startsWith(w))))
    if (hit) hits++
  }
  if (CUES[f.key]?.test(text)) hits++
  return Math.min(hits, 2) - (AGAINST[f.key]?.test(text) ? 1 : 0)
}

/**
 * The option a passage names: "invoiced monthly in arrears" → Monthly.
 * "Other" is never read from text: every contract says "the other party".
 */
function optionIn(text: string, options: string[]): string | null {
  for (const o of options) {
    if (/^other$/i.test(o)) continue
    const stem = o.toLowerCase().replace(/ly$/, '').replace(/s$/, '')
    if (new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text)) return o
  }
  return null
}

/** Surrounding quotes and stray punctuation off a selection. */
function trimmed(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
    .replace(/^[\s"'“”‘’([]+/, '')
    .replace(/[\s"'“”‘’)\],.;:]+$/, '')
}

const JURISDICTION = /(?:laws?|courts?)\s+(?:located\s+)?(?:of|in)\s+(?:the\s+)?(?:State\s+of\s+|Commonwealth\s+of\s+|Province\s+of\s+)?([A-Z][A-Za-z.'\- ]*?[A-Za-z])(?=\s*(?:[,.;(]|without|and|$))/
const ENTITY = /^(.+?),\s+(?:a|an)\s+.*\b(?:company|corporation|partnership|limited|LLC|LLP|Inc|Ltd|GmbH|S\.?A|plc)\b/i

/**
 * The passage as this field's value: "the laws of the State of New York" →
 * "New York" for a law or venue; "Northwind Analytics LLC, a Delaware
 * limited liability company" → "Northwind Analytics LLC" for a party name.
 */
export function cleanedFor(f: MatchableField, text: string): string {
  const t = trimmed(text)
  if (f.type !== 'text') return t
  const about = `${f.key} ${f.label}`.toLowerCase()
  if (/law|jurisdiction|venue|court/.test(about)) {
    const m = t.match(JURISDICTION)
    if (m) return m[1].trim()
  }
  if (/counterparty|party|name|vendor|customer|supplier/.test(about)) {
    const m = t.match(ENTITY)
    if (m) return trimmed(m[1])
  }
  if (/currency/.test(about)) {
    const code = t.match(/\b[A-Z]{3}\b/)?.[0] ?? SYMBOLS[t.match(/[$€£¥₹]/)?.[0] ?? '']
    if (code) return code
  }
  return t
}

const SYMBOLS: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' }

/** A number that is an amount of money: the contract value, a fee, a cap. */
const moneyish = (f: MatchableField) => !f.unit && /value|amount|fee|price|cost|cap/i.test(`${f.key} ${f.label}`)
/** A field naming a party. */
const partyish = (f: MatchableField) => /counterparty|party|vendor|customer|supplier|signator/i.test(`${f.key} ${f.label}`)
const LEGAL_ENTITY = /\b(LLC|LLP|Inc|Ltd|Limited|Corporation|Corp|GmbH|plc|S\.?A)\b/

/** How well the passage fits one field; `display` is null when it doesn't read as the field's type. */
export function matchField<F extends MatchableField>(f: F, text: string, opts: { dateOrder?: DateOrder } = {}): FieldMatch<F> {
  const clean = cleanedFor(f, text)
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  const option = f.type === 'select' && f.options?.length ? optionIn(text, f.options) : null
  const parsed = f.type === 'boolean'
    // A passage stating a term is the evidence it applies: "renews automatically" → Yes.
    ? parseFieldValue('boolean', /\b(not|no|never|neither|nor)\b/i.test(text) ? 'no' : 'yes')
    : parseFieldValue(f.type, option ?? clean, { options: f.options, dateOrder: opts.dateOrder })
  const fits = parsed.ok && parsed.value !== null
  let score: number
  switch (f.type) {
    case 'date': score = fits ? 4 : 0; break
    // "USD 12,500 per month" is a rate, not a length of time.
    case 'duration': score = fits ? (UNIT.test(text) && !MONEY.test(text) ? 4 : 0.5) : 0; break
    // The contract value is a number; with no other clue, money is most often it.
    case 'currency': score = fits ? (MONEY.test(text) ? 3.5 : 0.5) : 0; break
    // A count of days needs days, and no money: "USD 12,500 per month" is not 12,500 days.
    case 'number': score = !fits ? 0
      : f.unit ? (UNIT.test(text) && !MONEY.test(text) ? 3.5 : 0)
      : MONEY.test(text) ? (moneyish(f) ? 4 : 1) : 0.5; break
    case 'percentage': score = fits ? (PERCENT.test(text) ? 4 : 0.3) : 0; break
    case 'select': score = fits ? 3 : 0; break
    case 'multiselect': score = fits ? 2 : 0; break
    // A list of parties names companies or gives roles: ("Company").
    case 'parties': score = fits && (LEGAL_ENTITY.test(text) || /\(\s*["“]?[A-Z][A-Za-z ]+["”]?\s*\)/.test(text)) ? 2 : 0; break
    case 'boolean': score = 0.5; break
    // Any words are text: a text field is a match only when the passage names it.
    case 'longtext': score = clean.length > 80 ? 1.5 : 0.5; break
    default: score = 0.5
  }
  // An amount field's words ("payable", "fee") say nothing without an amount.
  const named = f.type === 'number' && moneyish(f) && !MONEY.test(text) ? 0 : names(f, text, words)
  if (fits || f.type === 'text' || f.type === 'longtext') score += named * 3
  if (f.type === 'text' && partyish(f) && LEGAL_ENTITY.test(text)) score += 3
  if (f.type === 'text' && /currency/i.test(f.key) && MONEY.test(text)) score += 2
  if (fits && isEmpty(f.value) && score >= 1) score += 0.5
  // Not what the field is about, however well the words read as its type.
  if (NEEDS[f.key] && !NEEDS[f.key].test(text)) score = Math.min(score, 0.5)
  return {
    field: f,
    value: fits ? (parsed as { value: unknown }).value : clean,
    display: fits ? (parsed as { display: string }).display : null,
    score,
  }
}

/** Every field the passage could fill, best first. Legacy fields take no new values. */
export function rankFields<F extends MatchableField>(fields: F[], text: string, opts: { dateOrder?: DateOrder } = {}): FieldMatch<F>[] {
  return fields
    .filter(f => !f.legacy)
    .map(f => matchField(f, text, opts))
    .filter(m => m.display !== null && m.score > 0)
    .sort((a, b) => b.score - a.score)
}
