/**
 * BB1 — the comparisons behind the Word redline engine: Myers' O(ND) diff over
 * any sequence, and word-level edits between two paragraphs that read the way
 * a lawyer marks up text: whole words and numbers, no comb of one-letter
 * changes, and no noise from curly quotes or doubled spaces.
 */

export type Op<T> =
  | { kind: 'equal'; a: T; b: T; ai: number; bi: number }
  | { kind: 'delete'; a: T; ai: number }
  | { kind: 'insert'; b: T; bi: number }

/** Past this many differences, two sequences are treated as wholly replaced. */
const MAX_EDITS = 2000

/** Myers' diff of `a` into `b`, items compared by `key`. Common ends are matched first. */
export function diffSequences<T>(a: readonly T[], b: readonly T[], key: (x: T) => string): Op<T>[] {
  const ak = a.map(key), bk = b.map(key)
  let pre = 0
  while (pre < ak.length && pre < bk.length && ak[pre] === bk[pre]) pre++
  let suf = 0
  while (suf < ak.length - pre && suf < bk.length - pre && ak[ak.length - 1 - suf] === bk[bk.length - 1 - suf]) suf++

  const ops: Op<T>[] = []
  for (let i = 0; i < pre; i++) ops.push({ kind: 'equal', a: a[i], b: b[i], ai: i, bi: i })
  for (const [kind, i, j] of myers(ak.slice(pre, ak.length - suf), bk.slice(pre, bk.length - suf))) {
    if (kind === 'equal') ops.push({ kind, a: a[pre + i], b: b[pre + j], ai: pre + i, bi: pre + j })
    else if (kind === 'delete') ops.push({ kind, a: a[pre + i], ai: pre + i })
    else ops.push({ kind, b: b[pre + j], bi: pre + j })
  }
  for (let s = suf; s > 0; s--) {
    const i = a.length - s, j = b.length - s
    ops.push({ kind: 'equal', a: a[i], b: b[j], ai: i, bi: j })
  }
  return ops
}

type Step = ['equal' | 'delete' | 'insert', number, number]

function myers(a: string[], b: string[]): Step[] {
  const n = a.length, m = b.length
  if (!n && !m) return []
  const replaceAll = (): Step[] => [
    ...a.map((_, i): Step => ['delete', i, 0]),
    ...b.map((_, j): Step => ['insert', 0, j]),
  ]
  if (!n || !m) return replaceAll()

  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] holds v[-d-1 .. d+1] as it stood before round d.
  const trace: Int32Array[] = []
  let done = false
  for (let d = 0; d <= max && !done; d++) {
    if (d > MAX_EDITS) return replaceAll()
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { done = true; break }
    }
  }

  const steps: Step[] = []
  let x = n, y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]
    const at = (k: number) => vd[k + d + 1]
    const k = x - y
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { steps.push(['equal', x - 1, y - 1]); x--; y-- }
    if (d > 0) steps.push(x === prevX ? ['insert', x, y - 1] : ['delete', x - 1, y])
    x = prevX; y = prevY
  }
  return steps.reverse()
}

// ─── Text ───────────────────────────────────────────────────────────────────

/** What counts as the same text: invisible characters, spaces, quotes and dashes folded. */
export function fold(s: string): string {
  return s
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
}

// A number keeps its separators ("1,000,000.00", "30%"); a word keeps its
// apostrophes and hyphens ("Party's", "non-compete"); anything else is one
// character. Every character of the text belongs to exactly one token.
const TOKEN = /\s+|\d+(?:[.,:/]\d+)*%?|[\p{L}\p{N}]+(?:['’\-‐‑][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu

interface Tok { text: string; start: number }
const tokenize = (s: string): Tok[] => [...s.matchAll(TOKEN)].map(m => ({ text: m[0], start: m.index! }))
const tokenKey = (t: Tok) => (/^\s+$/.test(t.text) ? ' ' : fold(t.text))

/** An edit to one paragraph, at character offsets of the text being edited. */
export type TextEdit =
  | { kind: 'delete'; start: number; end: number }
  | { kind: 'insert'; at: number; text: string }

type Seg =
  | { kind: 'equal'; aStart: number; aEnd: number; bText: string }
  | { kind: 'change'; aStart: number; aEnd: number; ins: string }

/**
 * Word-level edits turning `from` into `to`. Text the two share keeps
 * `from`'s characters; a stretch of spaces, or one short word, caught between
 * two changes joins them, so a rewritten phrase reads as one deletion and one
 * insertion. Punctuation and numbers between changes stay as they are, and
 * nothing joins where `canJoin` says the text's formatting changes.
 */
export function wordEdits(from: string, to: string, canJoin: (start: number, end: number) => boolean = () => true): TextEdit[] {
  const ops = diffSequences(tokenize(from), tokenize(to), tokenKey)

  const segs: Seg[] = []
  let pos = 0
  for (const o of ops) {
    const last = segs[segs.length - 1]
    if (o.kind === 'equal') {
      const aEnd = o.a.start + o.a.text.length
      if (last?.kind === 'equal') { last.aEnd = aEnd; last.bText += o.b.text }
      else segs.push({ kind: 'equal', aStart: o.a.start, aEnd, bText: o.b.text })
      pos = aEnd
      continue
    }
    let seg = last?.kind === 'change' ? last : undefined
    if (!seg) { seg = { kind: 'change', aStart: pos, aEnd: pos, ins: '' }; segs.push(seg) }
    if (o.kind === 'delete') { seg.aEnd = o.a.start + o.a.text.length; pos = seg.aEnd }
    else seg.ins += o.b.text
  }

  const size = (s: Seg) => (s.kind === 'change' ? Math.max(s.aEnd - s.aStart, s.ins.length) : 0)
  for (let merged = true; merged;) {
    merged = false
    for (let i = 1; i < segs.length - 1; i++) {
      const l = segs[i - 1], m = segs[i], r = segs[i + 1]
      if (m.kind !== 'equal' || l.kind !== 'change' || r.kind !== 'change') continue
      const text = from.slice(m.aStart, m.aEnd)
      const joins = /^\s+$/.test(text)
        || (/^\s*\p{L}+\s*$/u.test(text) && text.length <= Math.min(size(l), size(r)))
      if (!joins || !canJoin(l.aStart, Math.max(r.aEnd, m.aEnd))) continue
      segs.splice(i - 1, 3, { kind: 'change', aStart: l.aStart, aEnd: r.aEnd, ins: l.ins + m.bText + r.ins })
      merged = true
      break
    }
  }

  const edits: TextEdit[] = []
  for (const s of segs) {
    if (s.kind !== 'change') continue
    if (s.aEnd > s.aStart) edits.push({ kind: 'delete', start: s.aStart, end: s.aEnd })
    if (s.ins) edits.push({ kind: 'insert', at: s.aEnd, text: s.ins })
  }
  return edits
}

/** Apply edits to a string (what accepting them in Word gives). */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((x, y) => {
    const px = x.kind === 'delete' ? x.start : x.at
    const py = y.kind === 'delete' ? y.start : y.at
    return py - px || (x.kind === 'insert' ? -1 : 1)
  })
  let out = text
  for (const e of sorted) {
    out = e.kind === 'delete' ? out.slice(0, e.start) + out.slice(e.end) : out.slice(0, e.at) + e.text + out.slice(e.at)
  }
  return out
}

/** Word-bag likeness of two paragraphs, 0..1 (Dice). */
export function likeness(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0
  let common = 0
  for (const w of a) if (b.has(w)) common++
  return (2 * common) / (a.size + b.size)
}

export const wordBag = (s: string): Set<string> => new Set(fold(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
