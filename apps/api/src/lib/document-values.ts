/**
 * docs/41 browser QA — a term's value as a document writes it.
 *
 * Values are stored as data ("300000", "2025-03-01"), and went into documents
 * that way: "The Contract value is amended to read: 300000." and a renewal
 * letter "dated 2025-03-01". Money is written with its currency and grouping
 * ("USD 300,000"), dates as the org writes them ("March 1, 2025", or
 * "1 March 2025" for a day-first org). The stored value doesn't change; the
 * analysis and the Variables panel read these words back (parseDate,
 * parseCurrency).
 */
import { coreField, type DateOrder } from '@clm/types'

export interface DocumentStyle {
  dateOrder: DateOrder
  /** The contract's currency, for an amount written without one. */
  currency?: string | null
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2025-03-01" → "March 1, 2025" (MDY) or "1 March 2025" (DMY); anything else as it is. */
export function documentDate(value: string, order: DateOrder = 'MDY'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?$/.exec(value.trim())
  if (!m) return value
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return value
  return order === 'DMY' ? `${d} ${MONTHS[mo - 1]} ${y}` : `${MONTHS[mo - 1]} ${d}, ${y}`
}

/** "300000" → "USD 300,000"; an amount already in words or with a currency is left as written. */
export function documentMoney(value: string | number, currency?: string | null): string {
  const raw = typeof value === 'number' ? String(value) : value.trim()
  if (!/^-?\d[\d,]*(?:\.\d+)?$/.test(raw)) return String(value)
  const n = Number(raw.replace(/,/g, ''))
  if (!Number.isFinite(n)) return String(value)
  const whole = Number.isInteger(n)
  return `${(currency || 'USD').toUpperCase()} ${n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`
}

/** A template variable that holds an amount of money, by its name: fee, price, value, cap… */
const MONEY_KEY = /(?:^|_|[a-z])(?:value|amount|fees?|price|cap|budget|cost|total)$/i
const DATE_KEY = /date$/i

/**
 * One value, by what it is: a core field by its type (Contract value is
 * money), a template variable by its declared type or, failing that, its name.
 */
export function documentValue(key: string, value: string, style: DocumentStyle, declaredType?: string): string {
  const def = coreField(key)
  const type = def ? (def.key === 'value' ? 'currency' : def.type) : declaredType
  if (type === 'date' || (!type && DATE_KEY.test(key)) || (type === 'text' && DATE_KEY.test(key))) return documentDate(value, style.dateOrder)
  // Money only when the currency is known: an amount isn't given one it doesn't have.
  if (style.currency && (type === 'currency' || ((!type || type === 'number' || type === 'text') && MONEY_KEY.test(key)))) return documentMoney(value, style.currency)
  return value
}

/** A template's variables as the document writes them (the variables themselves stay as stored). */
export function documentVariables(
  variables: Record<string, unknown>, defs: unknown, style: DocumentStyle,
): Record<string, unknown> {
  const typeOf = new Map((Array.isArray(defs) ? defs : []).map((d: { key?: string; type?: string }) => [d?.key, d?.type]))
  return Object.fromEntries(Object.entries(variables).map(([k, v]) =>
    [k, typeof v === 'string' && v.trim() ? documentValue(k, v, style, typeOf.get(k)) : v]))
}
