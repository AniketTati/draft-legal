/**
 * Money totals (docs/39 D4) — amounts in different currencies are never added
 * together. The portfolio total on the analytics page summed every executed
 * contract's value and labelled the sum with the most common currency, so
 * €1M and $1M read as "USD 2,000,000". Every total is now one per currency.
 */

export interface CurrencyTotal {
  currency: string
  amount: number
  /** How many values went into it. */
  count: number
}

/** Totals per currency, the most common currency first. Values that aren't numbers are skipped. */
export function totalsByCurrency(
  rows: Iterable<{ value: unknown; currency?: string | null }>,
  defaultCurrency = 'USD',
): CurrencyTotal[] {
  const byCurrency = new Map<string, CurrencyTotal>()
  for (const r of rows) {
    if (r.value === null || r.value === undefined || r.value === '') continue
    const n = Number(r.value)
    if (!Number.isFinite(n)) continue
    const currency = (r.currency || defaultCurrency).toUpperCase()
    const t = byCurrency.get(currency) ?? { currency, amount: 0, count: 0 }
    t.amount += n
    t.count++
    byCurrency.set(currency, t)
  }
  return [...byCurrency.values()].sort((a, b) => b.count - a.count || b.amount - a.amount)
}

/** "USD 4.2M", "EUR 950K", "GBP 12,500". */
export function formatCompactMoney(amount: number, currency: string): string {
  const abs = Math.abs(amount)
  const num = abs >= 1e9 ? `${(amount / 1e9).toFixed(1).replace(/\.0$/, '')}B`
    : abs >= 1e6 ? `${(amount / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    : abs >= 1e4 ? `${Math.round(amount / 1e3).toLocaleString('en-US')}K`
    : amount.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return `${currency} ${num}`
}

/** Every currency's total, most common first: "USD 4.2M · EUR 1.1M"; "—" when there is none. */
export function formatCurrencyTotals(totals: readonly CurrencyTotal[], opts: { max?: number } = {}): string {
  if (!totals.length) return '—'
  const max = opts.max ?? 3
  const shown = totals.slice(0, max).map(t => formatCompactMoney(t.amount, t.currency))
  const more = totals.length - shown.length
  return more > 0 ? `${shown.join(' · ')} · +${more} more` : shown.join(' · ')
}
