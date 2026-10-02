/**
 * docs/41 Part 15 (C2) — the workspace's Changes mode, as pure functions on
 * the diff GET /contracts/:id/changes returns (node-htmldiff: flat <ins> and
 * <del>, never nested). String work only, so it is the same in the browser
 * and in tests.
 *
 * A change is one <del>, one <ins>, or a <del> right before an <ins> (words
 * replaced). The diff runs from the baseline to the document as it stands
 * (the draft changes), so the document already says what <ins> says:
 *   accept         keep their words: the document is unchanged
 *   keep original  put the baseline's words back
 *   counter        put our counter wording in place of both
 */
export interface Change {
  /** `ch` + document order: stable within one diff. */
  id: string
  /** The baseline's words it removed or replaced ('' for an insertion). */
  before: string
  /** The words it put in ('' for a deletion). */
  after: string
  /** Where it is in the diff HTML: [start, end) of the <del>/<ins> run. */
  start: number
  end: number
}

export type ChangeDecision = { kind: 'accept' } | { kind: 'keep' } | { kind: 'counter'; text: string }

const MARK = /<(ins|del)\b[^>]*>([\s\S]*?)<\/\1>/g
const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface Mark { tag: 'ins' | 'del'; inner: string; start: number; end: number }
function marksOf(diffHtml: string): Mark[] {
  return [...diffHtml.matchAll(MARK)].map(m => ({ tag: m[1] as 'ins' | 'del', inner: m[2], start: m.index!, end: m.index! + m[0].length }))
}

/** Each change in the diff, in document order. */
export function changesOf(diffHtml: string): Change[] {
  const marks = marksOf(diffHtml)
  const out: Change[] = []
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]
    const next = marks[i + 1]
    // Words replaced: a deletion followed by an insertion with only space between.
    if (m.tag === 'del' && next?.tag === 'ins' && !diffHtml.slice(m.end, next.start).trim()) {
      out.push({ id: `ch${out.length}`, before: textOf(m.inner), after: textOf(next.inner), start: m.start, end: next.end })
      i++
      continue
    }
    out.push({ id: `ch${out.length}`, before: m.tag === 'del' ? textOf(m.inner) : '', after: m.tag === 'ins' ? textOf(m.inner) : '', start: m.start, end: m.end })
  }
  return out.filter(c => c.before || c.after)
}

/** The same change in a later diff (ids move as changes are decided): by its words. */
export const changeKey = (c: Pick<Change, 'before' | 'after'>) => `${c.before}\u0000${c.after}`

/**
 * The document with the decisions applied: the text for the draft changes.
 * An undecided change stays as the document has it (their words).
 */
export function applyDecisions(diffHtml: string, decisions: Record<string, ChangeDecision>): string {
  const changes = changesOf(diffHtml)
  const byStart = new Map(changes.map(c => [c.start, c]))
  let out = ''
  let at = 0
  for (const m of marksOf(diffHtml)) {
    if (m.start < at) continue
    out += diffHtml.slice(at, m.start)
    const change = byStart.get(m.start)
    const d = change ? decisions[change.id] : undefined
    if (change && d?.kind === 'counter') {
      out += escape(d.text)
      at = change.end
      continue
    }
    // Inside a replacement, each mark on its own: keep → the <del>'s words, else the <ins>'s.
    const end = change?.end ?? m.end
    const run = marksOf(diffHtml.slice(m.start, end))
    for (const r of run) {
      if (d?.kind === 'keep' ? r.tag === 'del' : r.tag === 'ins') out += r.inner
    }
    at = end
  }
  return out + diffHtml.slice(at)
}

/** The diff with each change's marks tagged by its id, for the document to show and scroll to. */
export function taggedDiff(diffHtml: string): string {
  const changes = changesOf(diffHtml)
  let out = ''
  let at = 0
  for (const c of changes) {
    out += diffHtml.slice(at, c.start)
    out += diffHtml.slice(c.start, c.end).replace(/<(ins|del)\b/g, `<$1 data-change-id="${c.id}"`)
    at = c.end
  }
  return out + diffHtml.slice(at)
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The finding a change is about, if any: a change, deletion or addition
 * finding whose quote holds the change's new words (or, for words removed,
 * whose baseline quote holds them).
 */
export function findingFor<F extends { kind: string; evidence: { quote?: string; baselineQuote?: string } }>(change: Pick<Change, 'before' | 'after'>, findings: F[]): F | null {
  const after = norm(change.after)
  const before = norm(change.before)
  const about = findings.filter(f => ['modified', 'added', 'deleted', 'material_cut', 'position_not_met', 'position_fallback', 'needs_approval_position', 'unreadable_text'].includes(f.kind))
  return about.find(f => after.length >= 3 && norm(f.evidence.quote).includes(after))
    ?? about.find(f => before.length >= 3 && norm(f.evidence.baselineQuote).includes(before))
    ?? null
}

/**
 * Where a counter goes in the document, which reads as the diff's new side:
 * in place of their words, or, when they only removed words, just after (or
 * before) the words beside the gap in the same paragraph. Null when there is
 * nothing to find it by.
 */
export type CounterAnchor = { quote: string; at: 'replace' | 'after' | 'before' }
const BLOCK_EDGE = /<\/?(?:p|li|h[1-6]|div|td|th|tr|blockquote|ul|ol|table)\b[^>]*>|<br\s*\/?>/gi
const CONTEXT_CHARS = 60

/** The document's words in a stretch of the diff: deletions dropped, insertions kept. */
const docText = (html: string) => textOf(html.replace(/<del\b[^>]*>[\s\S]*?<\/del>/g, ' '))

export function counterAnchor(diffHtml: string, c: Change): CounterAnchor | null {
  if (c.after) return { quote: c.after, at: 'replace' }
  const beforeHtml = diffHtml.slice(0, c.start).split(BLOCK_EDGE).pop() ?? ''
  const lead = docText(beforeHtml)
  if (lead) return { quote: lead.length > CONTEXT_CHARS ? lead.slice(lead.indexOf(' ', lead.length - CONTEXT_CHARS) + 1) : lead, at: 'after' }
  const afterHtml = diffHtml.slice(c.end).split(BLOCK_EDGE)[0] ?? ''
  const tail = docText(afterHtml)
  if (tail) {
    const cut = tail.length > CONTEXT_CHARS ? tail.lastIndexOf(' ', CONTEXT_CHARS) : -1
    return { quote: cut > 0 ? tail.slice(0, cut) : tail, at: 'before' }
  }
  return null
}
