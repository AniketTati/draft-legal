/**
 * docs/39 G2 — a value whose words an edit changed, read again from the
 * words that replaced them.
 *
 * Editing a contract in the app ("thirty (30) days" → "sixty (60) days") left
 * its values as they were: the AI's 30 stood, and B2 could only say its words
 * were gone. Here the replacement is found by what surrounded the old words
 * (the words either side of the quote, found again in the new text), and a
 * value is read from it the way the field is typed — the same place in the
 * passage the old value sat, or the first number, length of time, amount or
 * date in it. It is offered beside the value, never written over it.
 */
import { parseFieldValue, type DateOrder, type FieldValueType } from '@clm/types'
import { findQuote, normalizeForSearch } from './text-span.js'

/** Words either side of the quote used to find where it was. */
const SIDE_WORDS = 6
/** A replacement longer than this isn't the same passage rewritten. */
const MAX_REPLACEMENT = 600

function lastWords(s: string, n: number): string {
  return s.trim().split(/\s+/).slice(-n).join(' ')
}
function firstWords(s: string, n: number): string {
  return s.trim().split(/\s+/).slice(0, n).join(' ')
}

/**
 * The words in `newText` that took the place of `quote` in `oldText`: what
 * lies between the words that came just before and just after it. Null when
 * either side can't be found again (the passage was rewritten wholesale).
 */
export function replacedPassage(oldText: string, newText: string, quote: string): string | null {
  const span = findQuote(normalizeForSearch(oldText), quote)
  if (!span) return null
  const before = lastWords(oldText.slice(Math.max(0, span.start - 200), span.start), SIDE_WORDS)
  const after = firstWords(oldText.slice(span.end, span.end + 200), SIDE_WORDS)
  if (before.length < 8 && after.length < 8) return null
  const n = normalizeForSearch(newText)
  const head = before.length >= 3 ? findQuote(n, before) : { start: 0, end: 0 }
  if (!head) return null
  const tail = after.length >= 3 ? findQuote(n, after, head.end) : { start: newText.length, end: newText.length }
  if (!tail || tail.start < head.end || tail.start - head.end > MAX_REPLACEMENT) return null
  const passage = newText.slice(head.end, tail.start).trim()
  return passage || null
}

const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
/** A number written in words, up to ninety-nine: "sixty", "forty-five", "twenty four". */
const WORD_NUMBER = `(?:(?:${Object.keys(TENS).join('|')})(?:[-\\s](?:${Object.keys(UNITS).slice(0, 9).join('|')}))?|${Object.keys(UNITS).join('|')})`

function wordValue(words: string): number | null {
  const parts = words.toLowerCase().split(/[-\s]+/)
  if (parts.length === 1) return UNITS[parts[0]] ?? TENS[parts[0]] ?? null
  const [t, u] = parts
  return TENS[t] !== undefined && UNITS[u] !== undefined && UNITS[u] < 10 ? TENS[t] + UNITS[u] : null
}

/** The first number the passage states: a figure in brackets first ("sixty (60)"), then any figure, then words. */
function firstNumber(passage: string): number | null {
  const bracketed = passage.match(/\((\d[\d,]*(?:\.\d+)?)\)/)
  const figure = bracketed ?? passage.match(/(?<![\w.])(\d[\d,]*(?:\.\d+)?)(?![\w])/)
  if (figure) {
    const n = Number(figure[1].replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  const word = passage.match(new RegExp(`\\b${WORD_NUMBER}\\b`, 'i'))
  return word ? wordValue(word[0]) : null
}

const DATE_PATTERNS = [
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{4}\b/,
]

/**
 * A value of the field's type read from the passage, or undefined when it
 * holds none. `before` is the field's value now and the words it came from:
 * where the old value sat in its quote, the new one is looked for first.
 */
export function readValueFrom(
  type: FieldValueType, passage: string,
  before: { value: unknown; quote: string | null } | null,
  opts: { options?: readonly string[]; dateOrder?: DateOrder; unit?: string } = {},
): unknown {
  const parse = (raw: unknown) => {
    const r = parseFieldValue(type, raw, { options: opts.options, dateOrder: opts.dateOrder })
    return r.ok && r.value !== null && r.value !== '' ? r.value : undefined
  }
  // The same place in the passage the old value's words sat in the old quote.
  if (before?.quote && typeof before.value === 'string' && before.value.trim()) {
    const q = before.quote, v = before.value
    const at = q.toLowerCase().indexOf(v.toLowerCase())
    if (at >= 0) {
      const pre = q.slice(0, at), post = q.slice(at + v.length)
      if (passage.toLowerCase().startsWith(pre.toLowerCase()) && passage.toLowerCase().endsWith(post.toLowerCase())) {
        const got = parse(passage.slice(pre.length, passage.length - post.length).trim())
        if (got !== undefined) return got
      }
    }
  }
  switch (type) {
    case 'number': {
      const n = firstNumber(passage)
      return n === null ? undefined : n
    }
    case 'percentage': {
      const m = passage.match(/(\d+(?:\.\d+)?)\s*(%|per\s?cent)/i)
      return m ? parse(Number(m[1])) : undefined
    }
    case 'duration': {
      const m = passage.match(new RegExp(`(\\d+|\\b${WORD_NUMBER}\\b)\\s*(?:\\((\\d+)\\)\\s*)?(business\\s+|calendar\\s+)?(days?|weeks?|months?|years?)\\b`, 'i'))
      if (!m) return undefined
      const n = m[2] ? Number(m[2]) : /^\d+$/.test(m[1]) ? Number(m[1]) : wordValue(m[1])
      return n === null ? undefined : parse(`${n} ${m[4]}`)
    }
    case 'currency': {
      const m = passage.match(/(?:[$€£₹]|\b(?:USD|EUR|GBP|INR|CAD|AUD|JPY|CHF)\b)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?\b(?:USD|EUR|GBP|INR|CAD|AUD|JPY|CHF)\b/i)
      return m ? parse(m[0]) : undefined
    }
    case 'date': {
      for (const re of DATE_PATTERNS) {
        const m = passage.match(re)
        if (m) return parse(m[0])
      }
      return undefined
    }
    case 'text':
    case 'longtext':
      // Still in the new words: the same value, reworded around.
      if (typeof before?.value === 'string' && before.value.trim() && passage.toLowerCase().includes(before.value.toLowerCase())) return before.value
      // Short enough to be the value itself.
      return passage.length <= 120 ? parse(passage) : undefined
    default:
      // Yes/no and choices aren't read from a fragment: the person decides.
      return undefined
  }
}
