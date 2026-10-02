/**
 * Contract field registry (docs/39 A3) — the one list of the fields the
 * extraction produces and people edit: canonical key, label, value type, where
 * a value is stored, and every older spelling that still reads as it.
 *
 * Before this, the same term had several names across the codebase (the
 * notice period had four: noticePeriodDays from extraction, noticePeriod from
 * Review Queue corrections, renewalNoticeDays and noticeDays from seeds), and
 * labels were built from raw keys ("Governing_law"). Extraction, the Review
 * Queue, renewals, export and the Fields panel all read this list now.
 *
 * Also here: the value parser and formatter every screen and route share, so
 * "thirty (30) days" typed in the Fields panel, picked from a highlight or
 * returned by the extractor becomes the same stored value.
 */

import { RENEWAL_TYPE_OPTIONS } from './family'

// ─── Types ────────────────────────────────────────────────────────────────────

export type FieldValueType =
  | 'text' | 'longtext' | 'number' | 'date' | 'boolean'
  | 'select' | 'multiselect'
  | 'currency'    // { amount, currency }
  | 'duration'    // { value, unit }
  | 'percentage'  // number, 5 = 5%
  | 'parties'     // [{ name, role? }]

export type FieldGroup = 'term' | 'parties' | 'commercial' | 'legal'

/** Contract columns a core field is stored in (the canonical copy readers use). */
export type FieldColumn = 'effectiveDate' | 'expiryDate' | 'value' | 'currency' | 'jurisdiction' | 'counterpartyName'

/**
 * Where a value came from. People's values (user, highlight, variable,
 * amendment, import) are never overwritten by extraction; `calculated` (an end
 * date worked out from a start date and a term) is recalculated like the AI's.
 */
// 'renewal' — fix-up 16: an expiry date an automatic renewal moved on.
export type FieldSource = 'ai' | 'calculated' | 'user' | 'highlight' | 'variable' | 'amendment' | 'import' | 'renewal'

/** What kind of field a value belongs to. */
export type FieldKind = 'core' | 'type' | 'custom'

export type DurationUnit = 'days' | 'weeks' | 'months' | 'years'
export interface DurationValue { value: number; unit: DurationUnit }
export interface CurrencyValue { amount: number; currency: string }
export interface PartyValue { name: string; role?: string | null }

export interface CoreFieldDef {
  key: string
  label: string
  type: FieldValueType
  group: FieldGroup
  column?: FieldColumn
  options?: readonly string[]
  /** Older spellings that read as this field (migrated on write). */
  aliases?: readonly string[]
  /** What the value means: shown as a tooltip and given to the extractor. */
  definition: string
  /**
   * A field kept only so existing values stay visible until someone moves
   * them to the field that replaced it (the pre-split notice period, F1).
   */
  legacy?: boolean
  /** A number's unit, shown after it: "30 days". */
  unit?: string
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  term:       'Term & renewal',
  parties:    'Parties',
  commercial: 'Commercial',
  legal:      'Legal',
}

export const PAYMENT_FREQUENCIES = ['One-time', 'Monthly', 'Quarterly', 'Annually', 'Milestones', 'Other'] as const
export const VALUE_BASES = ['Total', 'Annual', 'Monthly', 'Other'] as const

export const CORE_FIELDS: readonly CoreFieldDef[] = [
  // Term & renewal
  { key: 'effectiveDate', label: 'Effective date', type: 'date', group: 'term', column: 'effectiveDate',
    aliases: ['effective_date', 'startDate', 'start_date'],
    definition: 'The date the contract takes effect (for a SOW or an employment, the start date).' },
  { key: 'initialTerm', label: 'Initial term', type: 'duration', group: 'term',
    aliases: ['initialTermLength', 'term_length', 'termLength', 'initial_term'],
    definition: 'How long the first term runs from the effective date (e.g. 12 months).' },
  { key: 'expiryDate', label: 'Expiry date', type: 'date', group: 'term', column: 'expiryDate',
    aliases: ['expiry_date', 'expirationDate', 'endDate', 'end_date'],
    definition: 'The date the current term ends. Worked out from the effective date and the initial term when the contract does not state it.' },
  { key: 'autoRenew', label: 'Auto-renews', type: 'boolean', group: 'term',
    aliases: ['auto_renew', 'autoRenewal'],
    definition: 'Whether the contract renews automatically unless a party gives notice.' },
  { key: 'renewalTerm', label: 'Renewal term', type: 'duration', group: 'term',
    aliases: ['renewalTermLength', 'renewal_term'],
    definition: 'How long each renewal runs (e.g. 12 months).' },
  { key: 'nonRenewalNotice', label: 'Non-renewal notice', type: 'duration', group: 'term',
    aliases: ['nonRenewalNoticeDays', 'renewalNoticeDays', 'renewal_notice_days', 'renewalOptOutPeriod'],
    definition: 'How long before the end of a term a party must give notice to stop the contract renewing automatically.' },
  // docs/41 Part 14 — renewal terms of their own, read with their words and
  // confirmed by people like every other value (the Contract's renewal
  // columns are worked out from them: lib/renewal-terms.ts).
  { key: 'renewalType', label: 'Renewal', type: 'select', group: 'term', options: RENEWAL_TYPE_OPTIONS,
    aliases: ['renewal_type', 'renewalMechanism'],
    definition: 'How the contract renews: Automatic (unless a party gives notice), By agreement (only if both sign up again), Evergreen (runs until a party ends it), or None.' },
  { key: 'optOutWindow', label: 'Earliest notice', type: 'duration', group: 'term',
    aliases: ['opt_out_window', 'noticeWindowStart'],
    definition: 'The earliest a party may give notice to stop a renewal, counted back from the end of a term (e.g. "not more than 120 days before"). Only when the contract sets one.' },
  { key: 'priceUpliftCap', label: 'Renewal price increase cap', type: 'percentage', group: 'commercial',
    aliases: ['price_uplift_cap', 'renewalPriceCap', 'priceIncreaseCap'],
    definition: 'The most the price may rise at a renewal, as a percentage (e.g. 5 for 5%).' },
  { key: 'terminationForConvenience', label: 'Termination for convenience', type: 'boolean', group: 'term',
    aliases: ['termination_for_convenience'],
    definition: 'Whether a party may end the contract early without cause.' },
  { key: 'terminationNotice', label: 'Termination notice', type: 'duration', group: 'term',
    aliases: ['terminationNoticeDays', 'termination_notice_days'],
    definition: 'How much notice a party must give to end the contract early without cause (for convenience).' },
  { key: 'noticePeriodDays', label: 'Notice period (unconfirmed)', type: 'duration', group: 'term',
    aliases: ['noticePeriod', 'noticeDays', 'notice_period_days'], legacy: true,
    definition: 'A notice period found before notices were told apart. Confirm whether it is the non-renewal or the termination notice.' },
  { key: 'executionDate', label: 'Signed on', type: 'date', group: 'term',
    aliases: ['signatureDate', 'agreementDate', 'execution_date'],
    definition: 'The date the contract was signed, when it differs from the effective date.' },

  // Parties
  { key: 'counterpartyName', label: 'Counterparty', type: 'text', group: 'parties', column: 'counterpartyName',
    aliases: ['counterparty'],
    definition: 'The other party to the contract (not us).' },
  { key: 'counterpartyAddress', label: 'Counterparty address', type: 'longtext', group: 'parties',
    aliases: ['counterparty_address'],
    definition: 'The other party\'s address as the contract gives it (registered office or notices address).' },
  { key: 'parties', label: 'Parties', type: 'parties', group: 'parties',
    definition: 'Every party to the contract, with its role.' },
  { key: 'signatories', label: 'Signed by', type: 'longtext', group: 'parties',
    aliases: ['signers'],
    definition: 'Who signed for each party, with their titles.' },

  // Commercial
  { key: 'value', label: 'Contract value', type: 'number', group: 'commercial', column: 'value',
    aliases: ['total_value', 'totalValue', 'contractValue', 'contract_value'],
    definition: 'The amount payable under the contract, as a number.' },
  { key: 'valueBasis', label: 'Value is', type: 'select', group: 'commercial', options: VALUE_BASES,
    aliases: ['value_basis'],
    definition: 'Whether the contract value is the total over the term, a yearly amount or a monthly amount.' },
  { key: 'currency', label: 'Currency', type: 'text', group: 'commercial', column: 'currency',
    definition: 'The three-letter currency code of the contract value (e.g. USD).' },
  { key: 'paymentTermsDays', label: 'Payment terms', type: 'number', group: 'commercial', unit: 'days',
    aliases: ['paymentTerms', 'payment_terms_days'],
    definition: 'Days allowed to pay an invoice (e.g. 30 for net 30).' },
  { key: 'paymentFrequency', label: 'Billing', type: 'select', group: 'commercial', options: PAYMENT_FREQUENCIES,
    aliases: ['payment_frequency', 'billingFrequency'],
    definition: 'How often the contract is invoiced or paid.' },

  // Legal
  { key: 'governingLaw', label: 'Governing law', type: 'text', group: 'legal', column: 'jurisdiction',
    aliases: ['governing_law', 'jurisdiction'],
    definition: 'The law that governs the contract (e.g. New York, England and Wales).' },
  { key: 'venue', label: 'Disputes heard in', type: 'text', group: 'legal',
    aliases: ['forum', 'disputeVenue'],
    definition: 'Where disputes are decided: the courts or arbitration seat the contract names (separate from the governing law).' },
  { key: 'liabilityCapAmount', label: 'Liability cap', type: 'number', group: 'legal',
    aliases: ['liabilityCap', 'liability_cap_amount'],
    definition: 'The maximum total liability under the contract, as an amount.' },
  { key: 'exclusivity', label: 'Exclusivity', type: 'boolean', group: 'legal',
    definition: 'Whether either party is bound to deal exclusively with the other.' },
  { key: 'confidentiality', label: 'Confidentiality obligations', type: 'boolean', group: 'legal',
    definition: 'Whether the contract imposes confidentiality obligations.' },
  { key: 'ipOwnership', label: 'IP ownership', type: 'longtext', group: 'legal',
    aliases: ['ip_ownership'],
    definition: 'Who owns intellectual property created under the contract.' },
  { key: 'terminationRights', label: 'Termination rights', type: 'longtext', group: 'legal',
    aliases: ['termination_rights'],
    definition: 'When and how each party may end the contract.' },
]

const BY_KEY = new Map(CORE_FIELDS.map(f => [f.key, f]))
const BY_ALIAS = new Map<string, CoreFieldDef>()
for (const f of CORE_FIELDS) for (const a of f.aliases ?? []) BY_ALIAS.set(a, f)

/** The core field a key names — its canonical key or any older spelling. */
export function coreField(key: string): CoreFieldDef | undefined {
  return BY_KEY.get(key) ?? BY_ALIAS.get(key)
}

/** The canonical key for a key, or the key itself when it isn't a core field. */
export function canonicalFieldKey(key: string): string {
  return coreField(key)?.key ?? key
}

/** Core fields that live in a Contract column, keyed by column. */
export const CORE_FIELD_BY_COLUMN: Readonly<Record<FieldColumn, CoreFieldDef>> = Object.fromEntries(
  CORE_FIELDS.filter(f => f.column).map(f => [f.column!, f]),
) as Record<FieldColumn, CoreFieldDef>

/** The core fields in display order: by group, then as listed. */
export function coreFieldsInGroup(group: FieldGroup): CoreFieldDef[] {
  return CORE_FIELDS.filter(f => f.group === group)
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

export type DateOrder = 'MDY' | 'DMY'

export interface ParseOptions {
  /** How to read an all-numeric date like 03/04/2025. Default MDY. */
  dateOrder?: DateOrder
  /** Allowed options for select / multiselect. */
  options?: readonly string[]
}

export type ParseResult =
  | { ok: true; value: unknown; display: string; ambiguous?: string }
  | { ok: false; error: string }

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const SCALE: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 }

/** "one hundred and twenty" → 120; null when the words are not a number. */
export function wordsToNumber(text: string): number | null {
  const words = text.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(w => w && w !== 'and')
  if (!words.length) return null
  let total = 0
  let current = 0
  for (const w of words) {
    if (w in SMALL) current += SMALL[w]
    else if (w === 'hundred') current = (current || 1) * 100
    else if (w in SCALE) { total += (current || 1) * SCALE[w]; current = 0 }
    else return null
  }
  return total + current
}

const MULTIPLIER: Record<string, number> = {
  k: 1_000, thousand: 1_000, m: 1_000_000, mm: 1_000_000, mn: 1_000_000, million: 1_000_000,
  b: 1_000_000_000, bn: 1_000_000_000, billion: 1_000_000_000,
}

/**
 * A number from contract text: "1,200,000", "$1.2M", "USD 1.2 million",
 * "thirty (30)", "two times (2x)". Digits in parentheses win over the words
 * before them ("thirty (30)"), as legal drafting repeats a number that way.
 */
export function parseNumber(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  // A model's output can be any shape: anything but text is not a number.
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (!text) return null
  const paren = text.match(/\(\s*(?:[A-Z]{2,3}\s*)?[$€£¥₹]?\s*([\d.,]+)\s*[x%]?\s*\)/i)
  if (paren) {
    const n = Number(paren[1].replace(/,/g, ''))
    if (Number.isFinite(n)) return n
  }
  const m = text.replace(/[\u00a0\s]/g, ' ').match(/(-?\d[\d,]*(?:\.\d+)?)\s*(k|mm|mn|m|b|bn|thousand|million|billion)?\b/i)
  if (m) {
    const base = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(base)) return null
    const mult = m[2] ? MULTIPLIER[m[2].toLowerCase()] ?? 1 : 1
    return base * mult
  }
  const words = text.toLowerCase().replace(/[^a-z\s-]/g, ' ').trim()
  // Only a phrase that is entirely number words ("ninety", "two hundred").
  return wordsToNumber(words)
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function fullYear(y: number): number {
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y
}

/**
 * A calendar date from contract text, as YYYY-MM-DD: "2025-01-05",
 * "January 5, 2025", "5th day of January, 2025", "5 Jan 2025", "01/05/2025".
 * An all-numeric date whose day and month could swap is read by `dateOrder`
 * and reported as ambiguous so the screen can ask.
 */
/**
 * docs/39 A11 — the two ways an all-numeric date in contract text can be
 * read: "03/04/2025" is 4 March (month first) or 3 April (day first). Null
 * when the text has no such date, or its date reads only one way
 * ("31/01/2025", "2025-04-03", "03/03/2025").
 */
export function ambiguousNumericDate(text: string): { written: string; monthFirst: string; dayFirst: string } | null {
  for (const m of text.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/g)) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3])
    if (a === b || a > 12 || b > 12) continue
    const monthFirst = isoDate(y, a, b)
    const dayFirst = isoDate(y, b, a)
    if (monthFirst && dayFirst) return { written: m[0], monthFirst, dayFirst }
  }
  return null
}

export function parseDate(input: string, dateOrder: DateOrder = 'MDY'): { iso: string; ambiguous?: string } | null {
  const text = input.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/\s+/g, ' ')
  if (!text) return null
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/)
  if (m) { const iso = isoDate(+m[1], +m[2], +m[3]); return iso ? { iso } : null }
  m = text.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/)
  if (m) { const iso = isoDate(+m[1], +m[2], +m[3]); return iso ? { iso } : null }
  m = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/)
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3])
    const [month, day] = dateOrder === 'DMY' ? [b, a] : [a, b]
    const iso = isoDate(y, month, day)
    // 31/01/2025 can only be day-first, whatever the default: read it so.
    if (!iso) { const other = isoDate(y, day, month); return other ? { iso: other } : null }
    const swapped = a !== b && a <= 12 && b <= 12
    return swapped ? { iso, ambiguous: `Read as ${dateOrder === 'DMY' ? 'day/month' : 'month/day'} — check the date order.` } : { iso }
  }
  // "January 5, 2025" / "Jan. 5 2025"
  m = text.match(/\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/i)
  if (m && MONTHS[m[1].toLowerCase()]) { const iso = isoDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]); if (iso) return { iso } }
  // "5 January 2025" / "5th day of January, 2025"
  m = text.match(/\b(\d{1,2})\s+(?:day\s+of\s+)?([a-z]{3,9})\.?,?\s+(\d{4})\b/i)
  if (m && MONTHS[m[2].toLowerCase()]) { const iso = isoDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]); if (iso) return { iso } }
  // "January 2025" → first of the month is a guess; refuse rather than invent a day.
  return null
}

const UNIT_WORDS: Record<string, DurationUnit> = {
  day: 'days', days: 'days', d: 'days',
  week: 'weeks', weeks: 'weeks', wk: 'weeks', wks: 'weeks',
  month: 'months', months: 'months', mo: 'months', mos: 'months',
  year: 'years', years: 'years', yr: 'years', yrs: 'years',
}

/**
 * A length of time: "thirty (30) days", "90 calendar days", "3 months",
 * "one (1) year", "12-month". A bare number reads as `defaultUnit`.
 */
export function parseDuration(input: string | number, defaultUnit: DurationUnit = 'days'): DurationValue | null {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? { value: input, unit: defaultUnit } : null
  if (typeof input !== 'string') return null
  const text = input.toLowerCase().replace(/[()]/g, m => (m === '(' ? ' (' : ') '))
  const unitMatch = text.match(/\b(days?|weeks?|wks?|months?|mos?|years?|yrs?|d)\b/)
  const unit = unitMatch ? UNIT_WORDS[unitMatch[1]] : defaultUnit
  const before = (unitMatch ? text.slice(0, unitMatch.index) : text)
    .replace(/\b(business|calendar|working)\b/g, ' ').replace(/-\s*$/, '')
  let n = parseNumber(before)
  // "renews for successive one-year terms": the number words just before the unit.
  if (n == null && unitMatch) {
    const words = before.replace(/[^a-z\s-]/g, ' ').replace(/-/g, ' ').trim().split(/\s+/)
    for (let k = Math.min(4, words.length); k >= 1 && n == null; k--) n = wordsToNumber(words.slice(-k).join(' '))
  }
  if (n == null || n < 0) return null
  return { value: n, unit }
}

/** A money amount with its currency: "$1.2M", "USD 50,000", "€ 12,500", "12,500 GBP". */
export function parseCurrency(input: string | number, defaultCurrency = 'USD'): CurrencyValue | null {
  if (typeof input === 'number') return Number.isFinite(input) ? { amount: input, currency: defaultCurrency } : null
  if (typeof input !== 'string') return null
  const text = input.trim()
  const amount = parseNumber(text)
  if (amount == null) return null
  const SYMBOL: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' }
  const code = text.match(/\b([A-Z]{3})\b/)?.[1]
  const symbol = text.match(/[$€£¥₹]/)?.[0]
  return { amount, currency: code ?? (symbol ? SYMBOL[symbol] : defaultCurrency) }
}

function parseBoolean(input: unknown): boolean | null {
  if (typeof input === 'boolean') return input
  if (typeof input === 'number') return input === 1 ? true : input === 0 ? false : null
  const t = String(input).trim().toLowerCase()
  if (['yes', 'y', 'true', '1', 'auto', 'automatic', 'automatically'].includes(t)) return true
  if (['no', 'n', 'false', '0', 'none'].includes(t)) return false
  return null
}

function matchOption(input: string, options: readonly string[]): string | null {
  const t = input.trim().toLowerCase()
  return options.find(o => o.toLowerCase() === t) ?? null
}

function parseParties(input: unknown): PartyValue[] | null {
  if (Array.isArray(input)) {
    const parties = input
      .map(p => (typeof p === 'string' ? { name: p.trim() } : p && typeof p === 'object' ? { name: String((p as PartyValue).name ?? '').trim(), role: (p as PartyValue).role ?? null } : null))
      .filter((p): p is PartyValue => !!p && !!p.name)
    return parties.length ? parties : null
  }
  const lines = String(input).split(/[;\n]/).map(s => s.trim()).filter(Boolean)
  const parties = lines.map(line => {
    const paren = line.match(/^(.*?)\s*\(([^)]+)\)\s*$/)
    if (paren) return { name: paren[1].trim(), role: paren[2].trim() }
    const colon = line.match(/^([^:]{1,40}):\s*(.+)$/)
    if (colon) return { name: colon[2].trim(), role: colon[1].trim() }
    return { name: line }
  })
  return parties.length ? parties : null
}

/**
 * Parse what a person typed, picked from a highlight or the extractor
 * returned into the stored value for a field type. Empty input clears
 * the value (`value: null`).
 */
export function parseFieldValue(type: FieldValueType, raw: unknown, opts: ParseOptions = {}): ParseResult {
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
    return { ok: true, value: null, display: '—' }
  }
  const text = typeof raw === 'string' ? raw.trim() : raw
  switch (type) {
    case 'text': {
      const v = String(text).replace(/\s+/g, ' ').trim()
      return { ok: true, value: v, display: v }
    }
    case 'longtext': {
      const v = String(text).trim()
      return { ok: true, value: v, display: v }
    }
    case 'number': {
      const n = parseNumber(text as string | number)
      return n == null ? { ok: false, error: 'Enter a number, e.g. 250000.' } : { ok: true, value: n, display: formatFieldValue('number', n) }
    }
    case 'percentage': {
      const n = parseNumber(typeof text === 'string' ? text.replace('%', '') : text as number)
      return n == null ? { ok: false, error: 'Enter a percentage, e.g. 5%.' } : { ok: true, value: n, display: formatFieldValue('percentage', n) }
    }
    case 'date': {
      if (text instanceof Date) {
        const iso = Number.isNaN(text.getTime()) ? null : text.toISOString().slice(0, 10)
        return iso ? { ok: true, value: iso, display: formatFieldValue('date', iso) } : { ok: false, error: 'Enter a date, e.g. 2025-01-31.' }
      }
      const d = parseDate(String(text), opts.dateOrder)
      if (!d) return { ok: false, error: 'Enter a date, e.g. 2025-01-31 or 31 January 2025.' }
      return { ok: true, value: d.iso, display: formatFieldValue('date', d.iso), ...(d.ambiguous ? { ambiguous: d.ambiguous } : {}) }
    }
    case 'boolean': {
      const b = parseBoolean(text)
      return b == null ? { ok: false, error: 'Answer yes or no.' } : { ok: true, value: b, display: b ? 'Yes' : 'No' }
    }
    case 'select': {
      const opts2 = opts.options ?? []
      const v = opts2.length ? matchOption(String(text), opts2) : String(text).trim()
      return v == null ? { ok: false, error: `Pick one of: ${opts2.join(', ')}.` } : { ok: true, value: v, display: v }
    }
    case 'multiselect': {
      const parts = Array.isArray(text) ? text.map(String) : String(text).split(/[,;\n]/)
      const opts2 = opts.options ?? []
      const values: string[] = []
      for (const p of parts.map(s => s.trim()).filter(Boolean)) {
        const v = opts2.length ? matchOption(p, opts2) : p
        if (v == null) return { ok: false, error: `"${p}" isn't one of: ${opts2.join(', ')}.` }
        if (!values.includes(v)) values.push(v)
      }
      return { ok: true, value: values.length ? values : null, display: values.join(', ') || '—' }
    }
    case 'duration': {
      if (text && typeof text === 'object' && 'value' in (text as object) && 'unit' in (text as object)) {
        const d = text as DurationValue
        const unit = UNIT_WORDS[String(d.unit).toLowerCase()]
        const n = Number(d.value)
        return unit && Number.isFinite(n) ? { ok: true, value: { value: n, unit }, display: formatFieldValue('duration', { value: n, unit }) } : { ok: false, error: 'Enter a length of time, e.g. 90 days.' }
      }
      const d = parseDuration(text as string | number)
      return d ? { ok: true, value: d, display: formatFieldValue('duration', d) } : { ok: false, error: 'Enter a length of time, e.g. 90 days or 3 months.' }
    }
    case 'currency': {
      if (text && typeof text === 'object' && 'amount' in (text as object)) {
        const c = text as CurrencyValue
        const amount = Number(c.amount)
        return Number.isFinite(amount) ? { ok: true, value: { amount, currency: String(c.currency || 'USD').toUpperCase() }, display: formatFieldValue('currency', { amount, currency: c.currency }) } : { ok: false, error: 'Enter an amount, e.g. USD 250,000.' }
      }
      const c = parseCurrency(text as string | number)
      return c ? { ok: true, value: c, display: formatFieldValue('currency', c) } : { ok: false, error: 'Enter an amount, e.g. USD 250,000.' }
    }
    case 'parties': {
      const p = parseParties(text)
      return p ? { ok: true, value: p, display: formatFieldValue('parties', p) } : { ok: false, error: 'Enter each party as "Name (Role)", one per line.' }
    }
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** A stored value as people read it. */
export function formatFieldValue(type: FieldValueType, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  switch (type) {
    case 'date': {
      const s = String(value)
      const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s)
      return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    }
    case 'number': {
      const n = typeof value === 'number' ? value : parseNumber(String(value))
      return n == null ? String(value) : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    }
    case 'percentage': {
      const n = typeof value === 'number' ? value : parseNumber(String(value))
      return n == null ? String(value) : `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
    }
    case 'boolean':
      return value === true || value === 'true' ? 'Yes' : value === false || value === 'false' ? 'No' : String(value)
    case 'multiselect':
      return Array.isArray(value) ? value.join(', ') : String(value)
    case 'duration': {
      const d = typeof value === 'object' ? value as DurationValue : parseDuration(value as string | number)
      if (!d) return String(value)
      const unit = d.value === 1 ? d.unit.replace(/s$/, '') : d.unit
      return `${d.value.toLocaleString('en-US')} ${unit}`
    }
    case 'currency': {
      const c = typeof value === 'object' ? value as CurrencyValue : parseCurrency(value as string | number)
      if (!c) return String(value)
      return `${c.currency} ${c.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    }
    case 'parties': {
      const p = Array.isArray(value) ? value as PartyValue[] : parseParties(value) ?? []
      return p.map(x => (x.role ? `${x.name} (${x.role})` : x.name)).join(' · ') || '—'
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}

/** Calendar maths for a duration: the date `d` before `date` (months and years by the calendar). */
export function subtractDuration(date: Date, d: DurationValue): Date {
  const out = new Date(date.getTime())
  if (d.unit === 'days') out.setUTCDate(out.getUTCDate() - d.value)
  else if (d.unit === 'weeks') out.setUTCDate(out.getUTCDate() - d.value * 7)
  else {
    const months = d.unit === 'years' ? d.value * 12 : d.value
    const day = out.getUTCDate()
    out.setUTCDate(1)
    out.setUTCMonth(out.getUTCMonth() - months)
    const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
    out.setUTCDate(Math.min(day, last))
  }
  return out
}

/** Calendar maths for a duration: the date `d` after `date` (months and years by the calendar). */
export function addDuration(date: Date, d: DurationValue): Date {
  return subtractDuration(date, { value: -d.value, unit: d.unit })
}

/**
 * docs/39 F2 — the last day of a term that starts on `start` and runs for
 * `term`: "twelve months from 15 January 2025" ends on 14 January 2026.
 * Returns YYYY-MM-DD.
 */
export function termEndDate(start: string, term: DurationValue): string | null {
  const s = new Date(`${start.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(s.getTime()) || !(term.value > 0)) return null
  const end = addDuration(s, term)
  end.setUTCDate(end.getUTCDate() - 1)
  return end.toISOString().slice(0, 10)
}

/**
 * docs/39 F3 — a contract's value per year, from its value, what the value
 * is (total, annual, monthly) and its initial term. Null when it can't be
 * known: a total without a term, or a basis nobody stated.
 */
export function annualValue(value: number | null | undefined, basis: string | null | undefined, term?: DurationValue | null): number | null {
  if (value == null || !Number.isFinite(value)) return null
  if (basis === 'Annual') return value
  if (basis === 'Monthly') return value * 12
  if (basis === 'Total' && term && term.value > 0) {
    const years = term.unit === 'years' ? term.value : term.unit === 'months' ? term.value / 12 : term.unit === 'weeks' ? term.value / 52 : term.value / 365
    return years > 0 ? value / Math.max(years, 1) : null
  }
  return null
}

/** A duration in whole days (calendar months counted back from `from`, else 30-day months). */
export function durationInDays(d: DurationValue, from?: Date): number {
  if (d.unit === 'days') return d.value
  if (d.unit === 'weeks') return d.value * 7
  if (from) return Math.round((from.getTime() - subtractDuration(from, d).getTime()) / 86_400_000)
  return Math.round(d.value * (d.unit === 'years' ? 365 : 30))
}

/**
 * docs/39 C3 — a custom field's key from its label: "PO number" → "po_number",
 * "Durée du préavis" → "duree_du_preavis". Snake case, starting with a letter,
 * as the field definitions route requires.
 */
export function fieldKeyFromLabel(label: string): string {
  const key = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
  return /^[a-z]/.test(key) ? key : `field_${key}`.slice(0, 64)
}
