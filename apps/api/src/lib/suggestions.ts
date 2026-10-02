/**
 * docs/41 Part 16 (C4) — suggestions (tracked changes made in the editor)
 * in a document's HTML: <ins data-change-id …> and <del data-change-id …>,
 * written by the web editor's TrackChanges marks.
 *
 * Decision: the analysis reads a document as if every pending suggestion
 * were accepted. A suggestion is what the person editing wants the contract
 * to say, so findings, the clause list, search and Changes mode judge that
 * text; the banner and Changes mode say how many suggestions are still
 * pending, so nobody takes the reading for agreed text. The stored HTML keeps
 * the suggestions (who, when), which the Word export turns into w:ins/w:del.
 *
 * Plain <ins>/<del> without data-change-id (a diff's, or struck-through
 * text) are not suggestions and are left as they are.
 */

const TAG = /<(\/?)(ins|del)\b([^>]*)>/gi
const isSuggestion = (attrs: string) => /\bdata-change-id\s*=/i.test(attrs)

/**
 * The HTML as it reads with every suggestion accepted: suggested deletions
 * gone with their words, suggested insertions unwrapped. Linear time.
 */
export function acceptedHtml(html: string): string {
  if (!html || !/data-change-id/i.test(html)) return html
  let out = ''
  let at = 0
  // Open <ins>/<del> elements: whether each is a suggestion.
  const open: Array<{ tag: string; suggestion: boolean }> = []
  // Inside a suggested deletion: depth of the open stack where it started.
  let dropFrom = -1
  for (const m of html.matchAll(TAG)) {
    const [whole, close, rawTag, attrs] = m
    const tag = rawTag.toLowerCase()
    const start = m.index!
    if (dropFrom < 0) out += html.slice(at, start)
    at = start + whole.length
    if (!close) {
      const suggestion = isSuggestion(attrs)
      open.push({ tag, suggestion })
      if (dropFrom < 0 && suggestion && tag === 'del') dropFrom = open.length - 1
      else if (dropFrom < 0 && !suggestion) out += whole
      continue
    }
    // The innermost open element of this name closes.
    let i = open.length - 1
    while (i >= 0 && open[i].tag !== tag) i--
    if (i < 0) { if (dropFrom < 0) out += whole; continue }
    const el = open[i]
    open.length = i
    if (dropFrom >= 0) { if (i <= dropFrom) dropFrom = -1; continue }
    if (!el.suggestion) out += whole
  }
  if (dropFrom < 0) out += html.slice(at)
  return out
}

export interface SuggestionCount { insertions: number; deletions: number; total: number }

/** How many suggestions the HTML holds, by change id (a change split over runs counts once). */
export function countSuggestions(html: string | null | undefined): SuggestionCount {
  const ins = new Set<string>(), del = new Set<string>()
  if (html && /data-change-id/i.test(html)) {
    for (const m of html.matchAll(TAG)) {
      if (m[1]) continue
      const id = /\bdata-change-id\s*=\s*"([^"]*)"/i.exec(m[3])?.[1]
      if (id == null) continue
      ;(m[2].toLowerCase() === 'ins' ? ins : del).add(id)
    }
  }
  return { insertions: ins.size, deletions: del.size, total: ins.size + del.size }
}
