/**
 * Finding a quoted passage in a document's text (docs/39 A4, B2).
 *
 * The extraction quotes the contract, but a quote is rarely byte-for-byte:
 * line breaks become spaces, curly quotes straight, "–" a hyphen. These find
 * a quote — or a clause by its first and last words — in a version's
 * plainText, ignoring those differences, and answer with character offsets in
 * the original text: what the document view highlights and what a clause's
 * full text is cut from.
 */

export interface NormalizedText {
  /** Lower-case, one space for any run of whitespace, plain quotes and dashes. */
  norm: string
  /** norm[i] came from original[map[i]]; map[norm.length] = original.length. */
  map: number[]
}

export function normalizeForSearch(s: string): NormalizedText {
  const norm: string[] = []
  const map: number[] = []
  let space = false
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]
    if (/\s/.test(ch)) {
      if (space || norm.length === 0) continue
      ch = ' '
      space = true
    } else {
      space = false
      if (ch === '‘' || ch === '’' || ch === '`') ch = "'"
      else if (ch === '“' || ch === '”') ch = '"'
      else if (ch === '–' || ch === '—' || ch === '−') ch = '-'
      else ch = ch.toLowerCase()
    }
    norm.push(ch)
    map.push(i)
  }
  map.push(s.length)
  return { norm: norm.join(''), map }
}

function normNeedle(s: string): string {
  return normalizeForSearch(s).norm.trim()
}

export interface Span { start: number; end: number }

/** Where `quote` sits in the text, at or after `from` (an original offset). */
export function findQuote(text: NormalizedText, quote: string, from = 0): Span | null {
  const needle = normNeedle(quote)
  if (needle.length < 3) return null
  const fromNorm = text.map.findIndex(o => o >= from)
  const at = text.norm.indexOf(needle, Math.max(0, fromNorm))
  if (at < 0) return null
  return { start: text.map[at], end: text.map[at + needle.length - 1] + 1 }
}

/**
 * A clause by its opening and closing words: from where `startsWith` begins
 * to where the first `endsWith` after it ends. Refuses a span longer than
 * `maxLength` characters — two stray matches, not a clause.
 */
export function findSpan(text: NormalizedText, startsWith: string, endsWith: string, opts: { from?: number; maxLength?: number } = {}): Span | null {
  const head = findQuote(text, startsWith, opts.from ?? 0)
  if (!head) return null
  const tail = findQuote(text, endsWith, head.start)
  if (!tail || tail.end <= head.start) return null
  const span = { start: head.start, end: Math.max(head.end, tail.end) }
  return span.end - span.start > (opts.maxLength ?? 20_000) ? null : span
}
