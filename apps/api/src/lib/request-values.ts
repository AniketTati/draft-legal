/**
 * docs/41 browser QA — what a request's words may put into a draft.
 *
 * Values read from a request (the intake classifier's terms, the variable
 * extractor's values) are checked here before the planner sees them, without
 * a model:
 *   - a mention that says there is no value ("no law", "not specified",
 *     "TBD") is no value: the request titled "QA NDA no law" was read as
 *     asking for the governing law "no law";
 *   - a value goes into a sentence, so it must fit it: "in connection with
 *     {{purpose}}" read "in connection with evaluate a 12-month pilot".
 */

/** A value that says there is none, or that it is still to be decided. */
const ABSENT = /^(?:(?:no|none|nil|n\/?a|tbd|tbc|tba|unknown|unspecified|undecided|not\s+applicable)\b|not\s+(?:yet\s+)?(?:specified|stated|given|known|decided|chosen|set|agreed)\b|to\s+be\s+(?:determined|decided|confirmed|agreed|advised)\b|none\s+(?:specified|stated)\b)/i

/** A legal choice decides a clause (which law, which courts): its words must name one. */
const LEGAL_CHOICE = /law|venue|jurisdiction|forum|court|arbitrat|dispute/i

/** Words that say the request names no such choice ("no law", "without a governing law", "law not specified"). */
const NEGATED = /\b(?:no|not|without|tbd|unspecified|undecided)\b[^.;\n]{0,25}\b(?:law|laws|venue|jurisdiction|forum|courts?)\b|\b(?:law|laws|venue|jurisdiction|forum|courts?)\b[^.;\n]{0,15}\b(?:not\s+(?:yet\s+)?(?:specified|stated|decided|chosen|agreed)|tbd|tbc|to\s+be\s+(?:determined|decided|agreed))\b/i

const clean = (s: string) => s.trim().replace(/^["“'‘(]+|["”'’).]+$/g, '').trim()

export function isAbsentValue(value: string): boolean {
  const v = clean(value)
  return !v || ABSENT.test(v)
}

export const isLegalChoiceKey = (key: string) => LEGAL_CHOICE.test(key)

/**
 * Whether a value read from the request may be used: never one that says
 * there is none, and for a legal choice never one whose words deny it.
 */
export function namesAValue(key: string, value: string, quote?: string | null): boolean {
  if (isAbsentValue(value)) return false
  if (isLegalChoiceKey(key) && quote && NEGATED.test(quote)) {
    // "New York law, not Delaware law" still names New York; "no law" names nothing.
    const v = clean(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const named = new RegExp(`\\b${v}\\b`, 'i').test(quote)
    const denied = new RegExp(`\\b(?:no|not|without)\\s+(?:the\\s+)?(?:laws?\\s+of\\s+)?${v}\\b`, 'i').test(quote)
    if (!named || denied) return false
  }
  return true
}
