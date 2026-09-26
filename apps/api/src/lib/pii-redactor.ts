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

/**
 * X36 — the longest leading run of whole groups that passes the kind's
 * check, for a match that fails it as a whole because another group follows
 * the value: a card's next column ("4111 1111 1111 1111 12/27"), or the word
 * after a grouped IBAN (X37, "BE68 5390 0754 7034 BANK").
 */
function validHead(kind: PiiKind, matched: string): string | null {
  const group = kind === 'CC' ? /\d+/g : kind === 'IBAN' ? /[A-Z0-9]+/g : null
  if (!group) return null
  const ends = [...matched.matchAll(group)].map(m => (m.index ?? 0) + m[0].length)
  for (let k = ends.length - 2; k >= 0; k--) {
    const head = matched.slice(0, ends[k])
    const chars = head.replace(/[^A-Z0-9]/g, '')
    if (chars.length < (kind === 'CC' ? 13 : 12)) break
    if (kind === 'CC' && chars.length > 19) continue
    if (oneLineBreakAtMost(head) && (kind === 'CC' ? luhnValid(chars) : ibanValid(chars))) return head
  }
  return null
}

/** X37 — the IBAN check: the first four characters moved to the end, letters as 10–35, mod 97 is 1. */
function ibanValid(value: string): boolean {
  const s = value.replace(/\s/g, '')
  let rem = 0
  for (const c of s.slice(4) + s.slice(0, 4)) {
    const v = c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return rem === 1
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

/**
 * X52 — a value may be split by one line break: text extracted from a PDF
 * breaks lines wherever the layout wrapped, at a space between groups or
 * after a hyphen. More than one break is a column of numbers, not one value
 * (X27).
 */
const LINE_BREAK = String.raw`[^\S\r\n]*\r?\n[^\S\r\n]*`
function oneLineBreakAtMost(s: string): boolean {
  return (s.match(/\n/g) ?? []).length <= 1
}
/** A card's group separator: any single space, or a dash (X27). */
const GROUP_SEP = String.raw`(?:[^\S\r\n]|-)`
const CARD_WORDS = /\b(?:card|credit|debit|visa|mastercard|amex|american express|cvv|cvc|pan)\b/i
const BANK_WORDS = /\b(?:iban|swift|bic|bank|wire|remit|account\s*(?:no|number|#))\b/i

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
  /**
   * X52 — a pattern whose match crosses a line break: the match also needs
   * one of these words on its own lines or the line before, and a match that
   * isn't a value lets the scan resume after its line break (the value may
   * start on the next line).
   */
  near?: RegExp
}> = [
  // Credit card — 13-19 digits, optionally separated by space/dash.
  // We strip separators before Luhn-checking. Any single space counts, not
  // just U+0020: Word and the editor write card numbers with no-break or thin
  // spaces (X27), and those went out whole.
  //
  // Luhn is only a 1-in-10 filter, so roughly one in ten long reference
  // numbers passes it: an agreement id, an invoice number, a claim number.
  // Contracts are full of those, and redacting one changes what the document
  // says. Require a payment-ish word nearby before treating a bare digit run
  // as a card number.
  {
    kind: 'CC',
    rx: /\b(?:\d(?:[^\S\r\n]|-)?){12,18}\d\b/g,
    validate: (m) => luhnValid(m[0].replace(/\D/g, '')),
    requiresContext: CARD_WORDS,
  },
  // X52 — a grouped card number that a line wrap split: card-shaped groups
  // only (a first group of 4 digits, the rest of 4-6, the last of 3-6) with
  // one line break between two of them, and a card word close by. Looser,
  // a number ending one line was joined to the next line's card, and the
  // pair failed Luhn and hid it; and dates, phone numbers or amounts on
  // consecutive lines passed as cards. It runs after the pattern above, so
  // a card on one line is already taken.
  {
    kind: 'CC',
    rx: new RegExp(String.raw`\b\d{4}(?:${GROUP_SEP}\d{4,6}){0,3}${LINE_BREAK}(?:\d{4,6}${GROUP_SEP}){0,3}\d{3,6}\b`, 'g'),
    validate: (m) => {
      const digits = m[0].replace(/\D/g, '')
      return digits.length >= 13 && digits.length <= 19 && oneLineBreakAtMost(m[0]) && luhnValid(digits)
    },
    requiresContext: CARD_WORDS,
    near: CARD_WORDS,
  },
  // IBAN — letters AA + 2 digits + up to 30 alphanumerics.
  //
  // Same problem in a different shape: this pattern happily eats an uppercase
  // document reference like "AB1234567890123456". Anchor it to banking words.
  //
  // X37 — also as printed in contracts, in groups of four ("GB29 NWBK 6016
  // 1331 9268 19"); each space is optional, so the unspaced form still
  // matches. 12 to 35 characters without spaces.
  {
    kind: 'IBAN',
    rx: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    // Allowing spaces also admits all-caps text ("US10 YEAR NOTE"); every
    // real IBAN carries a mod-97 check, as a card carries Luhn.
    validate: (m) => ibanValid(m[0]),
    requiresContext: BANK_WORDS,
  },
  // X52 — a grouped IBAN that a line wrap split: groups of four with one
  // line break between two of them, and a banking word close by (as for
  // cards above).
  {
    kind: 'IBAN',
    rx: new RegExp(String.raw`\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){0,6}${LINE_BREAK}(?:[A-Z0-9]{4} ){0,6}[A-Z0-9]{1,4}\b`, 'g'),
    validate: (m) => oneLineBreakAtMost(m[0]) && ibanValid(m[0]),
    requiresContext: BANK_WORDS,
    near: BANK_WORDS,
  },
  // SSN — NNN-NN-NNNN. Excludes obvious invalids (000-, 666-, 9XX-).
  {
    kind: 'SSN',
    rx: new RegExp(String.raw`\b(?!000|666|9\d\d)(\d{3})-(?:${LINE_BREAK})?(?!00)(\d{2})-(?:${LINE_BREAK})?(?!0000)(\d{4})\b`, 'g'),
    validate: (m) => oneLineBreakAtMost(m[0]),
  },
  // ITIN — 9NN-NN-NNNN (always starts with 9, second group 70-99 etc.)
  {
    kind: 'ITIN',
    rx: new RegExp(String.raw`\b9\d{2}-(?:${LINE_BREAK})?\d{2}-(?:${LINE_BREAK})?\d{4}\b`, 'g'),
    validate: (m) => oneLineBreakAtMost(m[0]),
  },
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
 * Hash a PII value to a short, stable pseudonym for tokenize mode — 8 hex
 * chars, enough for "are these two refs the same person?" within a document.
 *
 * X23 — keyed. A plain SHA-256 of an SSN, a date of birth or a phone number
 * cut to 32 bits is reversed by trying every value, so whoever received the
 * text (the LLM provider included) could undo tokenize mode. An HMAC under a
 * server secret can't be. The API and the worker must share the key: round-trip
 * tokens (pii-policy.ts) are made in one and resolved in the other. Without
 * either env var the key is per-process, and every round trip across them
 * breaks, hence the warning.
 */
const PSEUDONYM_KEY = process.env.PII_TOKEN_SECRET || process.env.INTERNAL_SERVICE_SECRET || (() => {
  console.warn('[pii] neither PII_TOKEN_SECRET nor INTERNAL_SERVICE_SECRET is set: PII tokens use a per-process key and can\'t be resolved by another service')
  return crypto.randomBytes(32).toString('hex')
})()

/** `length` hex chars of the keyed hash; round-trip tokens use 16 (collisions stay negligible at census scale). */
export function pseudonym(value: string, length = 8): string {
  return crypto.createHmac('sha256', PSEUDONYM_KEY).update(value).digest('hex').slice(0, length)
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
  /** Replacement for a match, in place of the mode's (X23: round-trip tokens, see pii-policy.ts). */
  token?: (kind: PiiKind, value: string) => string
}

/**
 * X52 — `text.replace(rx, …)` for the patterns whose matches cross a line
 * break. A match needs `near` on its own lines or the line before, and one
 * that isn't a value lets the scan resume after its line break rather than
 * after the whole match, since the value may start on the next line.
 */
function replaceAcrossLines(
  text: string,
  rx: RegExp,
  near: RegExp,
  replace: (whole: string, first: unknown) => string | null,
): string {
  const scan = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`)
  let out = ''
  let last = 0
  for (let m = scan.exec(text); m; m = scan.exec(text)) {
    const start = m.index
    const end = start + m[0].length
    const lineStart = text.lastIndexOf('\n', start - 1)
    const from = lineStart <= 0 ? 0 : text.lastIndexOf('\n', lineStart - 1) + 1
    const lineEnd = text.indexOf('\n', end)
    const replacement = near.test(text.slice(from, lineEnd === -1 ? text.length : lineEnd)) ? replace(m[0], m[1]) : null
    if (replacement === null) {
      scan.lastIndex = start + m[0].indexOf('\n') + 1
      continue
    }
    out += text.slice(last, start) + replacement
    last = scan.lastIndex = end
  }
  return out + text.slice(last)
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

  for (const { kind, rx, validate, requiresContext, near } of PATTERNS) {
    if (!enabled.has(kind)) continue
    // Context is judged against the ORIGINAL input: an earlier pattern may
    // already have replaced the very word that justifies this one.
    if (requiresContext && !requiresContext.test(input)) continue
    // The replacement for one match, or null when it isn't a value. `first`
    // is the first capture group, where the pattern has one.
    const replace = (whole: string, first: unknown): string | null => {
      // What is replaced, and what follows it unchanged.
      let matched = whole
      let rest = ''
      // Run optional validator (e.g. Luhn for CC).
      if (validate) {
        const m = whole.match(new RegExp(rx.source))
        if (!m) return null
        if (!validate(m as RegExpExecArray)) {
          // X36 — a card number followed by another digit group ("…1111
          // 12/27", a table's next column) fails the check as a whole.
          const head = validHead(kind, whole)
          if (!head) return null
          matched = head
          rest = whole.slice(head.length)
        }
      }
      counts[kind] = (counts[kind] ?? 0) + 1
      if (options.token) {
        // A DOB or passport match starts with its keyword ("DOB: …"); only the
        // value becomes the token, so the keyword stays in the text and can't
        // travel with the token to where the model puts it.
        const value = (kind === 'DOB' || kind === 'PASSPORT') && typeof first === 'string' ? first : matched
        return matched.slice(0, matched.length - value.length) + options.token(kind, value) + rest
      }
      if (mode === 'tokenize') {
        return `[PII:${kind}:${pseudonym(matched)}]` + rest
      }
      return `[REDACTED:${kind}]` + rest
    }
    text = near
      ? replaceAcrossLines(text, rx, near, replace)
      // The args layout differs depending on capturing groups; the matched
      // substring is always args[0], the first group args[1].
      : text.replace(rx, (...args) => replace(args[0] as string, args[1]) ?? (args[0] as string))
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { text, counts, total }
}
