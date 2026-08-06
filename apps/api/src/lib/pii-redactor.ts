/**
 * PII Redactor (P7.5.1)
 *
 * Redacts well-formed personal identifiers from document text BEFORE
 * it leaves the trust boundary (i.e. before being sent to a third-party
 * LLM). Optional per-org via `OrgSettings.piiRedactionMode`:
 *   - 'off'        — pass-through (default for now; backwards-compat)
 *   - 'redact'     — replace matches with `[REDACTED:KIND]`
 *   - 'tokenize'   — replace with `[PII:KIND:HASH]` (reversible if you
 *                    keep the map; we don't store it server-side, the
 *                    map lives in memory of the in-flight request)
 *
 * What we catch (high-precision regexes — false-positive rate over
 * false-negative on first pass; we'll tune with eval data):
 *   SSN              123-45-6789
 *   ITIN             9NN-NN-NNNN (US tax id for non-residents)
 *   Credit card      Luhn-validated 13-19 digits with optional spaces/dashes
 *   US passport      9-digit standalone after the literal "passport"
 *   EU passport      letter + 8 digits after "passport"
 *   IBAN             country code + 2 digits + up to 30 alphanumerics
 *   US phone         (NNN) NNN-NNNN or NNN-NNN-NNNN
 *   E.164 phone      +<country><number>
 *   Email            standard RFC-5322ish
 *   Date of birth    YYYY-MM-DD or MM/DD/YYYY tagged as DOB when near
 *                    the literal "date of birth" / "DOB" / "born"
 *   IP address       v4 dotted quad
 *   API key          common prefixes (sk-, pk_, ghp_, AIza, etc.)
 *
 * What we DON'T catch (intentional — too noisy or domain-specific):
 *   Generic person names      ("John Smith")
 *   Generic addresses          ("123 Main St")
 *   Counterparty contact info  (email of the other side IS what the
 *                               contract is FOR — redacting it breaks
 *                               extraction)
 *
 * Design notes:
 *   - Pure function. No side effects. Returns the redacted text +
 *     a per-kind count. Caller decides whether/how to log.
 *   - Order matters: long-prefix patterns (IBAN, credit card) first,
 *     then narrower (SSN), then phone/email last.
 *   - We emit a stable pseudonym when mode === 'tokenize' so the LLM
 *     can still reason about identity without seeing the value
 *     (e.g. "two contracts mention [PII:SSN:7a9f]" vs "two SSNs").
 */
import crypto from 'node:crypto'

export type PiiMode = 'off' | 'redact' | 'tokenize'

export type PiiKind =
  | 'SSN'
  | 'ITIN'
  | 'CC'
  | 'PASSPORT'
  | 'IBAN'
  | 'PHONE'
  | 'EMAIL'
  | 'DOB'
  | 'IP'
  | 'API_KEY'

export interface RedactionResult {
  text: string
  counts: Partial<Record<PiiKind, number>>
  total: number
}

// Luhn check for credit-card validation. Eliminates the bulk of
// false positives (random 16-digit numbers happen in legal text:
// agreement IDs, file ids, etc.).
function luhnValid(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

const PATTERNS: Array<{
  kind: PiiKind
  rx: RegExp
  validate?: (m: RegExpExecArray) => boolean
  /**
   * When set, the pattern only fires if this also matches somewhere in the
   * surrounding text. Used for patterns whose shape is common in ordinary
   * contract language (long digit runs, uppercase reference codes) and which
   * therefore need a nearby word to justify treating a match as an identifier.
   */
  requiresContext?: RegExp
}> = [
  // Credit card — 13-19 digits, optionally separated by space/dash.
  // We strip separators before Luhn-checking.
  //
  // Luhn is only a 1-in-10 filter, so roughly one in ten long reference
  // numbers passes it: an agreement id, an invoice number, a claim number.
  // Contracts are full of those, and redacting one changes what the document
  // says. Require a payment-ish word nearby before treating a bare digit run
  // as a card number.
  {
    kind: 'CC',
    rx: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => luhnValid(m[0].replace(/[ -]/g, '')),
    requiresContext: /\b(?:card|credit|debit|visa|mastercard|amex|american express|cvv|cvc|pan)\b/i,
  },
  // IBAN — letters AA + 2 digits + up to 30 alphanumerics.
  //
  // Same problem in a different shape: this pattern happily eats an uppercase
  // document reference like "AB1234567890123456". Anchor it to banking words.
  {
    kind: 'IBAN',
    rx: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
    requiresContext: /\b(?:iban|swift|bic|bank|wire|remit|account\s*(?:no|number|#))\b/i,
  },
  // SSN — NNN-NN-NNNN. Excludes obvious invalids (000-, 666-, 9XX-).
  {
    kind: 'SSN',
    rx: /\b(?!000|666|9\d\d)(\d{3})-(?!00)(\d{2})-(?!0000)(\d{4})\b/g,
  },
  // ITIN — 9NN-NN-NNNN (always starts with 9, second group 70-99 etc.)
  { kind: 'ITIN', rx: /\b9\d{2}-\d{2}-\d{4}\b/g },
  // Passport — keyword-anchored to avoid false positives on order #s.
  // Matches: "Passport: A12345678" / "passport no. AB1234567" / etc.
  {
    kind: 'PASSPORT',
    rx: /\b(?:passport|passport\s*(?:no\.?|number|#))[:\s.#]*([A-Z]?\d{6,9})\b/gi,
  },
  // Email — RFC-5322ish but pragmatic.
  { kind: 'EMAIL', rx: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // E.164 phone — +<countrycode><number>, 9-15 digits total.
  { kind: 'PHONE', rx: /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,9}\b/g },
  // US phone — (NNN) NNN-NNNN or NNN-NNN-NNNN.
  //
  // The leading `\b` used to sit before the optional `(`, where a word
  // boundary can never match — so "(415) 555-0142" matched from the digits
  // onward and the replacement left an orphaned "(" behind, corrupting the
  // sentence. Make the parenthesised and bare forms explicit alternatives.
  { kind: 'PHONE', rx: /(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g },
  // DOB — keyword-anchored YYYY-MM-DD or MM/DD/YYYY.
  {
    kind: 'DOB',
    rx: /\b(?:DOB|date\s+of\s+birth|born(?:\s+on)?)[:\s,]*((?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}\/\d{1,2}\/\d{4}))/gi,
  },
  // IPv4
  { kind: 'IP', rx: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g },
  // API keys — common provider prefixes.
  { kind: 'API_KEY', rx: /\b(?:sk-[A-Za-z0-9-_]{16,}|pk_(?:test|live)_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{36}|AIza[A-Za-z0-9_-]{35}|xox[bpoa]-[A-Za-z0-9-]{10,})\b/g },
]

/**
 * Hash a PII value to a short, stable pseudonym for tokenize mode.
 * We use SHA-256 truncated to 8 hex chars — collision-resistant enough
 * for "are these two refs the same person?" within one document, and
 * short enough not to bloat the prompt.
 */
function pseudonym(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/**
 * Kinds skipped by default when redacting CONTRACT text.
 *
 * An email address in a notice clause is not incidental personal data — it is
 * the operative term ("notices shall be sent to legal@acme.com"), and a lawyer
 * asking "where do I send termination notice?" needs the answer. Same for the
 * counterparty's switchboard number in a signature block. The module has always
 * documented this ("Counterparty contact info… redacting it breaks
 * extraction") but redacted them anyway.
 *
 * Callers handling genuinely personal records rather than contract bodies can
 * opt back in with `kinds`.
 */
export const CONTRACT_TEXT_EXEMPT: PiiKind[] = ['EMAIL', 'PHONE']

export interface RedactOptions {
  /** Restrict redaction to these kinds. Defaults to everything except CONTRACT_TEXT_EXEMPT. */
  kinds?: PiiKind[]
}

export function redactPii(
  input: string,
  mode: PiiMode = 'redact',
  options: RedactOptions = {},
): RedactionResult {
  if (mode === 'off' || !input) {
    return { text: input, counts: {}, total: 0 }
  }
  const enabled = new Set<PiiKind>(
    options.kinds ?? PATTERNS.map(p => p.kind).filter(k => !CONTRACT_TEXT_EXEMPT.includes(k)),
  )
  const counts: Partial<Record<PiiKind, number>> = {}
  let text = input

  for (const { kind, rx, validate, requiresContext } of PATTERNS) {
    if (!enabled.has(kind)) continue
    // Context is judged against the ORIGINAL input: an earlier pattern may
    // already have replaced the very word that justifies this one.
    if (requiresContext && !requiresContext.test(input)) continue
    text = text.replace(rx, (...args) => {
      // The args layout differs depending on capturing groups; the
      // matched substring is always args[0].
      const matched = args[0] as string
      // Run optional validator (e.g. Luhn for CC).
      if (validate) {
        const m = matched.match(new RegExp(rx.source))
        if (!m) return matched
        if (!validate(m as RegExpExecArray)) return matched
      }
      counts[kind] = (counts[kind] ?? 0) + 1
      if (mode === 'tokenize') {
        return `[PII:${kind}:${pseudonym(matched)}]`
      }
      return `[REDACTED:${kind}]`
    })
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { text, counts, total }
}
