/**
 * Comment visibility and anchors (docs/41 Part 16, step 7).
 *
 * A thread is internal (our side only) by default, or external — shared with
 * the counterparty through the portal. Replies take their thread's visibility.
 *
 * An anchor remembers the words a comment was left on, where they were, and in
 * which version. When the document moves on we look for the same words again
 * rather than trusting the offsets, which any edit above them would shift.
 */

export const COMMENT_VISIBILITIES = ['internal', 'external'] as const
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number]

export function isCommentVisibility(v: unknown): v is CommentVisibility {
  return v === 'internal' || v === 'external'
}

/** Character offsets into the version's plain text. */
export interface CommentAnchor {
  quote: string
  start: number
  end: number
  versionId: string | null
}

export type AnchorState = 'anchored' | 'moved' | 'orphaned'

export interface ResolvedAnchor {
  state: AnchorState
  start: number | null
  end: number | null
}

export const ORPHANED_ANCHOR_TEXT = 'Text no longer in the document'

/** The anchor's shape from untrusted input, or null when it isn't one. */
export function parseCommentAnchor(raw: unknown): CommentAnchor | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const quote = typeof a.quote === 'string' ? a.quote : ''
  if (!quote.trim() || quote.length > 5000) return null
  const start = Number.isInteger(a.start) && (a.start as number) >= 0 ? (a.start as number) : 0
  const end = Number.isInteger(a.end) && (a.end as number) >= start ? (a.end as number) : start + quote.length
  const versionId = typeof a.versionId === 'string' && a.versionId ? a.versionId : null
  return { quote, start, end, versionId }
}

/** Every index where `needle` occurs in `hay`. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = []
  if (!needle) return out
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i)
  return out
}

/** Of several places the quote appears, the one nearest where it used to be. */
function nearest(hits: number[], was: number): number {
  return hits.reduce((best, h) => (Math.abs(h - was) < Math.abs(best - was) ? h : best), hits[0])
}

/**
 * Collapse runs of whitespace to one space, remembering where each kept
 * character came from so a match maps back to the original text.
 */
function normalise(text: string): { text: string; map: number[] } {
  let out = ''
  const map: number[] = []
  let space = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (/\s/.test(c)) {
      if (!space && out.length) { out += ' '; map.push(i) }
      space = true
    } else {
      out += c
      map.push(i)
      space = false
    }
  }
  if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop() }
  return { text: out, map }
}

/**
 * Where an anchor sits in `text` (the plain text of version `versionId`).
 * Same version: where it was left. Otherwise the exact words, then the words
 * with whitespace ignored; if neither is there the thread is orphaned.
 */
export function resolveCommentAnchor(anchor: CommentAnchor, text: string, versionId: string | null): ResolvedAnchor {
  if (anchor.versionId && anchor.versionId === versionId) {
    return { state: 'anchored', start: anchor.start, end: anchor.end }
  }
  const exact = occurrences(text, anchor.quote)
  if (exact.length) {
    const at = nearest(exact, anchor.start)
    return { state: at === anchor.start ? 'anchored' : 'moved', start: at, end: at + anchor.quote.length }
  }
  const hay = normalise(text)
  const needle = normalise(anchor.quote).text
  const loose = occurrences(hay.text, needle)
  if (needle && loose.length) {
    const at = nearest(loose, anchor.start)
    const start = hay.map[at]
    const end = hay.map[at + needle.length - 1] + 1
    return { state: 'moved', start, end }
  }
  return { state: 'orphaned', start: null, end: null }
}
