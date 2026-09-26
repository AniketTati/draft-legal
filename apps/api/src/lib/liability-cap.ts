/**
 * DD1 — a liability cap, read from its words and measured, so that no model
 * has to do the arithmetic.
 *
 * Playbooks state their limits in months of fees and in multiples of the
 * annual value ("6–24 months of fees", "at most 3× annual contract value").
 * Contracts state caps as a multiple of the fees over a period ("two (2)
 * times the fees paid or payable in the twelve (12) months preceding the
 * event giving rise to the claim"), as an amount, or as the greater or lesser
 * of the two. The playbook check used to leave the conversion to the chat
 * model, which reasoned that 2× a year's fees "could exceed 3× annual value
 * depending on payment schedule". Here it is computed from the words, or,
 * when the words don't give it, left unknown. Nothing is estimated.
 */

export interface LiabilityCap {
  /** The sentence that states it, as written. */
  sentence: string
  /** For a cap on some claims only (a super-cap): the words saying which. */
  condition: string | null
  /** Whose liability it limits: both parties ("each party's"), one of them, or not said. */
  binds: 'both' | 'one' | null
  /** The one party it limits, as the contract names it ("Supplier"). */
  party: string | null
  /** A fixed amount. */
  amount: { value: number; currency: string } | null
  /** A multiple of the fees over the months before the claim. Null months: the fees in total. */
  multiple: number | null
  periodMonths: number | null
  /** "the greater of" / "the lesser of" the amount and the fees. */
  combine: 'greater' | 'lesser' | null
  /** multiple × periodMonths, when both are known and nothing is combined with them. */
  monthsOfFees: number | null
  /** monthsOfFees ÷ 12: how many years' fees. */
  timesAnnualFees: number | null
  /** The cap in one sentence, with its arithmetic. */
  statement: string
}

// ── Numbers written as words ────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}
const UNIT_WORD = `(?:${Object.keys(UNITS).join('|')})`
/** "twenty-four", "one hundred fifty", "thirty six". */
const WORDS_RUN = new RegExp(`\\b${UNIT_WORD}(?:[\\s-]+(?:hundred|${UNIT_WORD}))*\\b`, 'gi')

function wordsToNumber(words: string): number | null {
  let total = 0
  for (const w of words.toLowerCase().split(/[\s-]+/).filter(Boolean)) {
    if (w === 'hundred') total = (total || 1) * 100
    else if (w in UNITS) total += UNITS[w]
    else return null
  }
  return total
}

/**
 * The words with their numbers as numerals, for reading only:
 * "two (2) times" → "2 times", "twelve (12) months" → "12 months",
 * "one hundred fifty percent (150%)" → "150%", "twice" → "2 times",
 * "one and one-half times" → "1.5 times".
 */
export function numeralized(text: string): string {
  let s = text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ')
  // A number in words with its numeral in brackets: the numeral says it.
  s = s.replace(new RegExp(`\\b${UNIT_WORD}(?:[\\s-]+(?:hundred|and|a|half|${UNIT_WORD}))*(\\s+(?:per\\s*cent|percent))?\\s*\\((\\d+(?:\\.\\d+)?)\\s*(%?)\\)`, 'gi'),
    (_m, pct: string | undefined, num: string, sign: string) => `${num}${pct || sign ? '%' : ''}`)
  s = s.replace(new RegExp(`\\b(${UNIT_WORD})\\s+and\\s+(?:a|one)[\\s-]+half\\b`, 'gi'), (_m, w: string) => String(UNITS[w.toLowerCase()] + 0.5))
  s = s.replace(/\btwice\b/gi, '2 times').replace(/\bdouble\b(?=\s+(?:the|all|any|its|such)\b)/gi, '2 times')
  s = s.replace(WORDS_RUN, run => String(wordsToNumber(run) ?? run))
  s = s.replace(/(\d)\s*(?:per\s*cent|percent)\b/gi, '$1%')
  // The same number restated in brackets after its unit: "2 times (2x)", "12 months (12)".
  s = s.replace(/(\d+(?:\.\d+)?)\s*(times|months?|years?|%)\s*\(\s*\d+(?:\.\d+)?\s*(?:x|×|%|times|months?|years?)?\s*\)/gi, '$1 $2')
  return s
}

// ── Money ───────────────────────────────────────────────────────────────────

const CURRENCY: Record<string, string> = { '$': 'USD', 'us$': 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP', '₹': 'INR', inr: 'INR', cad: 'CAD', aud: 'AUD', chf: 'CHF', '¥': 'JPY', jpy: 'JPY' }
const SCALE: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, mn: 1e6, billion: 1e9, bn: 1e9 }
const MONEY_BEFORE = /(US\$|USD|EUR|GBP|INR|CAD|AUD|CHF|JPY|\$|€|£|₹|¥)\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*(thousand|million|billion|mn|bn|k|m)\b)?/i
const MONEY_AFTER = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(thousand|million|billion)?\s*(US dollars|dollars|USD|EUR|euros?|GBP|pounds(?: sterling)?)\b/i

function moneyIn(s: string): { value: number; currency: string; index: number; length: number } | null {
  const a = MONEY_BEFORE.exec(s)
  const b = MONEY_AFTER.exec(s)
  if (a && (!b || a.index <= b.index)) {
    const value = Number(a[2].replace(/,/g, '') + (a[3] ?? '')) * (SCALE[(a[4] ?? '').toLowerCase()] ?? 1)
    return { value, currency: CURRENCY[a[1].toLowerCase()] ?? a[1].toUpperCase(), index: a.index, length: a[0].length }
  }
  if (b) {
    const value = Number(b[1].replace(/,/g, '') + (b[2] ?? '')) * (SCALE[(b[3] ?? '').toLowerCase()] ?? 1)
    const word = b[4].toLowerCase()
    return { value, currency: /dollar|usd/.test(word) ? 'USD' : /eur/.test(word) ? 'EUR' : 'GBP', index: b.index, length: b[0].length }
  }
  return null
}

// ── Sentences that state a cap ──────────────────────────────────────────────

/**
 * The text's sentences. A list's items stay with the sentence that
 * introduces them ("the greater of:\n(a) $1,000,000; and\n(b) …"), and
 * sentences run together without a space ('claim."Excluded Claims" means')
 * are parted.
 */
export function sentencesOf(text: string): string[] {
  const chunks: string[] = []
  for (const line of text.split(/\n+/).map(l => l.trim()).filter(Boolean)) {
    const prev = chunks[chunks.length - 1]
    if (prev && (/[:;,]$|\b(?:and|or)$/i.test(prev) || /^\(?(?:[a-z]|[ivx]{1,4}|\d{1,2})[.)]\s/i.test(line))) chunks[chunks.length - 1] = `${prev} ${line}`
    else chunks.push(line)
  }
  return chunks
    // "…; provided that for breaches of Section 6, the cap shall be…" is a cap of its own.
    .flatMap(c => c.split(/(?<=[a-z0-9)\]][.;])(?=["“][A-Z])|(?<=[.;])\s+(?=["“(]?[A-Z])|;\s+(?=(?:[Pp]rovided|[Hh]owever|[Ee]xcept|[Ss]ave|[Bb]ut|[Nn]otwithstanding)\b)/))
    .map(s => s.trim())
    .filter(Boolean)
}

const LIABLE = /\bliab(?:le|ility|ilities)\b|\bcap(?:ped)?\b/i
/** Where the cap's measure begins: right after these words. */
const CAP_VERB = new RegExp([
  String.raw`\b(?:not|in\s+no\s+event|under\s+no\s+circumstances)\b[^.;]{0,80}?\bexceed\b`,
  String.raw`\bnot\s+to\s+exceed\b`,
  // Not "including but not limited to".
  String.raw`(?<!\bnot\s)\blimited\s+to\b`,
  String.raw`\bcap(?:ped)?\s+(?:shall|will)\s+be\b`,
  String.raw`\bcap(?:ped)?\s+(?:is|at|of)\b`,
  String.raw`\bin\s+excess\s+of\b`,
].join('|'), 'i')

const FEES = /\b(fees|charges|amounts?|sums|consideration|payments?|price|compensation)\b/i
const MONTHS_OF_FEES = /(\d+(?:\.\d+)?)\s*[- ]?\s*(months?|years?)'?\s*(?:worth\s+)?(?:of\s+)?(?:the\s+)?(?:total\s+|aggregate\s+)?(?:fees|charges|payments|amounts)/i

const WHO_BOTH = /\b(?:each|either|neither)\s+party\b|\bthe\s+parties\b|\bboth\s+parties\b|\bmutual/gi
const WHO_ONE = /\b(supplier|provider|service\s+provider|vendor|licensor|licensee|company|contractor|consultant|customer|client|seller|buyer|processor|controller)(?:'s)?\s+(?:(?:total|aggregate|cumulative|entire|maximum|overall)\s+)*liabilit/gi

/** The claims a super-cap is for. Only a specific kind: "for all claims" is the general cap. */
const LEADING_CONDITION = /^\s*(?:(?:provided,?\s+(?:however,?\s+)?that|however|except\s+that|notwithstanding[^,]{0,160}),?\s*)?(?:for|with\s+respect\s+to|in\s+respect\s+of|in\s+relation\s+to|in\s+the\s+case\s+of|as\s+to|as\s+regards|regarding)\s+([^,]{5,260}),/i
const TRAILING_CONDITION = /\b(?:for|with\s+respect\s+to|in\s+respect\s+of|in\s+relation\s+to)\s+((?:any\s+)?(?:claims?|breach(?:es)?|losses|liabilit(?:y|ies)|damages)\b[^.;]{0,220})/i
const SPECIFIC = /\bbreach(?:es)?\s+of\b|\bsection\b|\bclause\b|confidential|\bdata\b|privacy|security|indemni|intellectual\s+property|infring|gross\s+negligence|wil+ful|fraud|death|personal\s+injury/i

function lastMatch(re: RegExp, s: string): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null
  for (const m of s.matchAll(re)) last = m
  return last
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100))
const months = (n: number) => `${fmt(n)} month${n === 1 ? '' : 's'}`
const money = (m: { value: number; currency: string }) => `${m.currency} ${m.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

/** The fees part of a measure: its multiple and period, or null when it names no fees. */
function feesMeasure(measure: string): { multiple: number; periodMonths: number | null } | null {
  const direct = MONTHS_OF_FEES.exec(measure)
  if (direct) {
    const n = Number(direct[1])
    return { multiple: 1, periodMonths: /year/i.test(direct[2]) ? n * 12 : n }
  }
  const f = FEES.exec(measure)
  if (!f) return null
  const before = measure.slice(Math.max(0, f.index - 80), f.index)
  const after = measure.slice(f.index, f.index + 200)
  let multiple = 1
  const times = /(\d+(?:\.\d+)?)\s*(?:times|x|×)\s+(?:the\s+|of\s+the\s+|all\s+)?(?:[a-z-]+\s+){0,4}$/i.exec(before)
  const pct = /(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:the\s+)?(?:[a-z-]+\s+){0,4}$/i.exec(before)
  if (times) multiple = Number(times[1])
  else if (pct) multiple = Number(pct[1]) / 100
  let periodMonths: number | null = null
  const period = /(\d+)\s*[- ]?\s*(months?|years?)\b/i.exec(after)
  if (period) periodMonths = /year/i.test(period[2]) ? Number(period[1]) * 12 : Number(period[1])
  else if (/\b(?:annual|yearly|per\s+(?:annum|year)|(?:prior|preceding|previous|last|past|contract|calendar)\s+year)\b/i.test(before + after)) periodMonths = 12
  return { multiple, periodMonths }
}

function describe(cap: Omit<LiabilityCap, 'statement'>): string {
  const who = cap.condition ? `For ${cap.condition}` : cap.binds === 'both' ? "Each party's cap" : cap.party ? `${cap.party}'s cap` : 'The cap'
  const fees = cap.multiple == null ? null
    : cap.periodMonths == null
      ? `${fmt(cap.multiple)} × the fees paid under the agreement in total (how many months of fees that is depends on how long it has run)`
      : `${fmt(cap.multiple)} × the fees of the ${months(cap.periodMonths)} before the claim`
  const amount = cap.amount ? money(cap.amount) : null
  const measure = cap.combine && amount && fees ? `the ${cap.combine} of ${amount} and ${fees}` : fees ?? amount ?? ''
  const sum = cap.monthsOfFees != null && cap.timesAnnualFees != null
    ? ` = ${months(cap.monthsOfFees)} of fees, ${fmt(cap.timesAnnualFees)} times a year's fees`
    : ''
  return `${who}: ${measure}${sum}.`
}

/** Every cap the text states: the general one first, then caps for some claims only. */
export function liabilityCaps(text: string): LiabilityCap[] {
  const caps: LiabilityCap[] = []
  for (const sentence of sentencesOf(text)) {
    if (!LIABLE.test(sentence)) continue
    const read = numeralized(sentence)
    const verb = CAP_VERB.exec(read)
    if (!verb) continue
    const subject = read.slice(0, verb.index + verb[0].length)
    let measure = read.slice(verb.index + verb[0].length)

    let condition: string | null = null
    const leading = LEADING_CONDITION.exec(read)
    if (leading && SPECIFIC.test(leading[1])) condition = leading[1].trim()
    else {
      const trailing = TRAILING_CONDITION.exec(measure)
      if (trailing && trailing.index > 0 && SPECIFIC.test(trailing[1])) {
        condition = trailing[1].trim()
        measure = measure.slice(0, trailing.index)
      }
    }

    const combineWord = /\bthe\s+(greater|higher|larger|lesser|lower|smaller)\s+of\b/i.exec(measure)?.[1]?.toLowerCase()
    const combine = combineWord ? (/greater|higher|larger/.test(combineWord) ? 'greater' : 'lesser') : null
    const found = moneyIn(measure)
    const fees = feesMeasure(found ? measure.slice(0, found.index) + ' ' + measure.slice(found.index + found.length) : measure)
    if (!found && !fees) continue
    const amount = found ? { value: found.value, currency: found.currency } : null
    // With no "greater/lesser of", a fees word beside an amount only describes
    // it ("fees in excess of $1,000,000"): the cap is the amount.
    const combined = !!(combine && amount && fees)
    const measured = amount && !combined ? null : fees

    const bothAt = lastMatch(WHO_BOTH, subject)?.index ?? -1
    const oneMatch = lastMatch(WHO_ONE, subject)
    const oneAt = oneMatch?.index ?? -1
    const binds: LiabilityCap['binds'] = bothAt < 0 && oneAt < 0 ? null : bothAt > oneAt ? 'both' : 'one'
    const party = binds === 'one' && oneMatch ? oneMatch[1].replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()) : null
    const monthsOfFees = !combined && measured?.periodMonths != null ? measured.multiple * measured.periodMonths : null
    const cap: Omit<LiabilityCap, 'statement'> = {
      sentence,
      condition,
      binds,
      party,
      amount,
      multiple: measured?.multiple ?? null,
      periodMonths: measured?.periodMonths ?? null,
      combine: combined ? combine : null,
      monthsOfFees,
      timesAnnualFees: monthsOfFees != null ? monthsOfFees / 12 : null,
    }
    caps.push({ ...cap, statement: describe(cap) })
  }
  // A super-cap that doesn't say whose liability it limits limits the same as the general cap.
  const general = caps.find(c => !c.condition)
  for (const c of caps) {
    if (c.condition && !c.binds && general?.binds) { c.binds = general.binds; c.party = general.party; c.statement = describe(c) }
  }
  return [...caps.filter(c => !c.condition), ...caps.filter(c => c.condition)]
}

// ── Judging a playbook limit ────────────────────────────────────────────────

export interface CapBound { min?: number; max?: number; units?: string }
export interface CapBoundResult {
  /** Null when the words don't give the figure the limit is in. */
  passed: boolean | null
  value: number | null
  reason: string
}

type Metric = 'monthsOfFees' | 'timesAnnualFees' | 'amount'
function metricOf(units: string | undefined): Metric | null {
  const u = (units ?? '').toLowerCase()
  if (/month/.test(u)) return 'monthsOfFees'
  if (/(annual|year|yr)/.test(u) && /(\bx\b|×|times|multiple|value|fees)/.test(u)) return 'timesAnnualFees'
  if (/(usd|eur|gbp|inr|\$|€|£|dollar|amount|currency)/.test(u)) return 'amount'
  return null
}

function rangeText(b: CapBound): string {
  const u = b.units ? ` ${b.units}` : ''
  if (b.min != null && b.max != null) return `${fmt(b.min)}–${fmt(b.max)}${u}`
  if (b.max != null) return `at most ${fmt(b.max)}${u}`
  return `at least ${fmt(b.min ?? 0)}${u}`
}

const sizeOf = (c: LiabilityCap) => c.monthsOfFees != null
  ? `${months(c.monthsOfFees)} of fees (${fmt(c.timesAnnualFees ?? 0)} times a year's fees)`
  : c.amount && !c.combine ? money(c.amount) : 'a size the words don\'t give'

/**
 * A playbook limit on the cap, judged on the general cap. A super-cap for
 * some claims is a separate term that playbooks set separately (the demo
 * org's preferred position: "2x annual fees, super-cap of 3x for data
 * breach"); it is reported, not judged. Null when the limit isn't in a
 * measure of the cap this reads (months of fees, a multiple of a year's
 * fees, an amount).
 */
export function evaluateCapBound(caps: readonly LiabilityCap[], bound: CapBound): CapBoundResult | null {
  const metric = metricOf(bound.units)
  if (!metric) return null
  const limit = ` The playbook's limit is ${rangeText(bound)}.`
  const general = caps.find(c => !c.condition) ?? null
  const others = caps.filter(c => c.condition)
  const alsoSaid = others.length
    ? ` Separately, ${others.length === 1 ? 'a cap for some claims is' : 'caps for some claims are'} ${others.map(sizeOf).join('; ')}.`
    : ''
  if (!general) {
    return { passed: null, value: null, reason: (caps.length ? 'Only caps for some claims are stated.' : 'No cap is stated in these words.') + alsoSaid + limit }
  }
  const within = (v: number) => (bound.min == null || v >= bound.min) && (bound.max == null || v <= bound.max)
  const unitWord = metric === 'monthsOfFees' ? ' months of fees' : metric === 'timesAnnualFees' ? " times a year's fees" : ''
  const shown = (v: number) => metric === 'amount' ? money({ value: v, currency: general.amount?.currency ?? '' })
    : metric === 'monthsOfFees' ? `${months(v)} of fees` : `${fmt(v)}${unitWord}`

  let value: number | null = null
  if (metric === 'monthsOfFees') value = general.monthsOfFees
  if (metric === 'timesAnnualFees') value = general.timesAnnualFees
  if (metric === 'amount' && general.amount && !general.combine) value = general.amount.value
  if (value != null) {
    const passed = within(value)
    return { passed, value, reason: `${general.statement} That is ${shown(value)}, ${passed ? 'within' : 'outside'} the limit.${alsoSaid}${limit}` }
  }

  // The greater (at least) or the lesser (at most) of an amount and the fees.
  if (general.combine && general.multiple != null && general.periodMonths != null && metric !== 'amount') {
    const months = general.multiple * general.periodMonths
    const v = metric === 'monthsOfFees' ? months : months / 12
    if (general.combine === 'greater') {
      if (bound.max != null && v > bound.max) return { passed: false, value: null, reason: `${general.statement} That is at least ${shown(v)}, above the limit.${alsoSaid}${limit}` }
      if (bound.max == null && bound.min != null && v >= bound.min) return { passed: true, value: null, reason: `${general.statement} That is at least ${shown(v)}.${alsoSaid}${limit}` }
    } else {
      if (bound.min != null && v < bound.min) return { passed: false, value: null, reason: `${general.statement} That is at most ${shown(v)}, below the limit.${alsoSaid}${limit}` }
      if (bound.min == null && bound.max != null && v <= bound.max) return { passed: true, value: null, reason: `${general.statement} That is at most ${shown(v)}.${alsoSaid}${limit}` }
    }
  }
  return { passed: null, value: null, reason: `${general.statement} Its size in${unitWord || ' this measure'} can't be worked out from the words.${alsoSaid}${limit}` }
}
