/**
 * The one line on a tool chip: what the assistant asked the tool for.
 *
 * It read `counterpartyName` (the tool sends `counterparty_name`) and showed
 * no date, value or sort filter at all, so "expiring in the next 60 days"
 * searched as 2024 showed as "limit=50", and nobody could see why it found
 * nothing.
 */
export interface EntityHint { kind: 'contract' | 'counterparty' | 'matter'; title: string }

export function summarizeArgs(args: Record<string, unknown>, entityHint?: EntityHint): string {
  const keys = Object.keys(args)
  if (keys.length === 0 && !entityHint) return ''
  const pick = (...names: string[]) => {
    for (const k of names) if (typeof args[k] === 'string' && (args[k] as string).trim()) return args[k] as string
    return undefined
  }
  const num = (k: string) => (typeof args[k] === 'number' ? (args[k] as number) : undefined)

  // When the result named the entity it resolved, lead with that, kept to a line.
  if (entityHint?.title) {
    const title = entityHint.title.length > 36 ? entityHint.title.slice(0, 35) + '…' : entityHint.title
    const q = pick('query')
    return q ? `${title} · "${q}"` : title
  }

  // contract_get / contract_summarize / clause_search
  const id = pick('contract_id', 'contractId')
  if (id) {
    const q = pick('query')
    return q ? `${id.slice(0, 6)}… · "${q}"` : `${id.slice(0, 6)}…`
  }

  // contract_search, portfolio_search
  const range = (from?: string, to?: string) => (from && to ? `${from}…${to}` : from ? `from ${from}` : to ? `to ${to}` : '')
  const bits: string[] = []
  const q = pick('query')
  if (q) bits.push(`"${q}"`)
  const type = pick('type', 'contract_type')
  if (type) bits.push(`type=${type}`)
  const status = pick('status')
  if (status) bits.push(`status=${status}`)
  const cp = pick('counterparty_name', 'counterpartyName', 'counterparty')
  if (cp) bits.push(`counterparty=${cp}`)
  const expires = range(pick('expiry_from', 'expiryFrom'), pick('expiry_to', 'expiryTo'))
  if (expires) bits.push(`expires ${expires}`)
  const effective = range(pick('effective_from', 'effectiveFrom'), pick('effective_to', 'effectiveTo'))
  if (effective) bits.push(`effective ${effective}`)
  const min = num('value_min'), max = num('value_max')
  if (min != null || max != null) bits.push(min != null && max != null ? `value ${min}–${max}` : min != null ? `value ≥ ${min}` : `value ≤ ${max}`)
  const sort = pick('sort_by', 'sortBy')
  if (sort) bits.push(`by ${sort}${pick('sort_order', 'sortOrder') === 'asc' ? ' ↑' : ''}`)
  const limit = num('limit')
  if (limit != null && limit !== 10) bits.push(`limit=${limit}`)
  if (bits.length > 0) return bits.join(' · ')

  // Anything else: the arguments themselves, cut to a line.
  const s = JSON.stringify(args)
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}
