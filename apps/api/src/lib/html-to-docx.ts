/**
 * HTML (an htmldiff blob) → WordprocessingML with real tracked changes.
 *
 * Input is the output of `computeVersionDiff()`: the contract's HTML with
 * `<ins>` / `<del>` wrapped around what changed, plus `data-diff-node` on whole
 * blocks that were added or removed. Output is docx-node content the caller
 * packs into a .docx.
 *
 * Decisions worth knowing before editing this:
 *
 *   - REVISION IDS COME FROM ONE MONOTONIC COUNTER. Word silently drops the
 *     second of two revisions sharing a `w:id`, so the change simply vanishes
 *     from the review pane. `docx` will happily serialise duplicates, so
 *     uniqueness has to be structural here rather than asserted in a test.
 *
 *   - HYPERLINKS WRAP RUNS, NEVER THE REVERSE. `new InsertedTextRun({ children:
 *     [new ExternalHyperlink(...)] })` compiles, runs, and emits a
 *     `<w:externalHyperlink/>` element that does not exist in OOXML — the link
 *     text disappears and no relationship is written. Nothing catches it.
 *     TipTap ships Link with autolink enabled, so contracts do contain <a>.
 *
 *   - <pre> IS NOT FLATTENED TO TEXT. A .txt upload becomes ONE <pre> holding
 *     the entire contract (lib/document.ts), so any branch that flattens a
 *     block to its text content would drop every tracked change in those
 *     documents behind a successful-looking export.
 *
 *   - DELETIONS USE DeletedTextRun, which emits <w:delText>. A deletion whose
 *     text sits in <w:t> renders in Word as ordinary body text: no
 *     strikethrough, nothing to reject, and the reviewer never learns the
 *     counterparty removed it.
 */
import {
  Paragraph, TextRun, InsertedTextRun, DeletedTextRun, ExternalHyperlink,
  Table, TableRow, TableCell, HeadingLevel, WidthType, AlignmentType, TableLayoutType,
} from 'docx'
import { parseFragment } from 'parse5'

/**
 * Usable text width in twips: US Letter (12240) less docx's default one-inch
 * margins (1440 each). Tables are laid out against this, because a table with
 * no explicit grid collapses to almost nothing.
 */
const USABLE_PAGE_TWIPS = 12240 - 1440 * 2

export interface RevisionMeta {
  author: string
  /** xsd:dateTime, no milliseconds — see toRevisionDate(). */
  date:   string
}

/** Numbering reference registered by the caller for <ol>. */
export const ORDERED_LIST_REF = 'redline-ordered'

type Node = {
  nodeName: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Node[]
}

type Rev = 'ins' | 'del' | null

interface Fmt {
  bold?:      boolean
  italics?:   boolean
  strike?:    boolean
  underline?: boolean
  highlight?: boolean
  link?:      string
}

const HEADINGS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6,
}

const attr = (n: Node, name: string) => n.attrs?.find(a => a.name === name)?.value
const isText = (n: Node) => n.nodeName === '#text'

/**
 * One counter per document. Not a module global: two exports running
 * concurrently in the same process would interleave ids and collide.
 */
class RevIds {
  private n = 1
  next(): number { return this.n++ }
}

/** Which revision, if any, this element declares for the whole block. */
function blockRev(n: Node): Rev {
  const m = attr(n, 'data-diff-node')
  return m === 'ins' || m === 'del' ? m : null
}

/** Merge an element's own formatting into the inherited set. */
function fmtFor(n: Node, inherited: Fmt): Fmt {
  const f: Fmt = { ...inherited }
  switch (n.nodeName) {
    case 'strong': case 'b':      f.bold = true; break
    case 'em': case 'i':          f.italics = true; break
    case 'u':                     f.underline = true; break
    case 's': case 'strike':      f.strike = true; break
    case 'mark':                  f.highlight = true; break
    case 'a': {
      const href = attr(n, 'href')
      if (href) f.link = href
      break
    }
    case 'span': {
      const style = attr(n, 'style') ?? ''
      if (/font-weight:\s*(bold|[6-9]00)/.test(style)) f.bold = true
      if (/font-style:\s*italic/.test(style))          f.italics = true
      if (/text-decoration:[^;]*underline/.test(style)) f.underline = true
      if (/text-decoration:[^;]*line-through/.test(style)) f.strike = true
      break
    }
  }
  return f
}

/** Block alignment from an inline style, when present. */
function alignmentOf(n: Node): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  const style = attr(n, 'style') ?? ''
  const m = /text-align:\s*(left|right|center|justify)/.exec(style)
  if (!m) return undefined
  return ({ left: AlignmentType.LEFT, right: AlignmentType.RIGHT,
    center: AlignmentType.CENTER, justify: AlignmentType.JUSTIFIED } as const)[m[1] as 'left']
}

export class DocxMapper {
  private ids = new RevIds()

  constructor(private meta: RevisionMeta) {}

  private stamp() {
    return { id: this.ids.next(), author: this.meta.author, date: this.meta.date }
  }

  /** Build the run(s) for one piece of text under a revision + formatting state. */
  private runsFor(text: string, rev: Rev, fmt: Fmt): (TextRun | InsertedTextRun | DeletedTextRun | ExternalHyperlink)[] {
    if (!text) return []
    // Preserve hard breaks inside a run rather than collapsing them: a .txt
    // contract is one <pre> and its newlines are its only structure.
    const parts = text.split('\n')
    const style = {
      bold: fmt.bold, italics: fmt.italics,
      ...(fmt.underline ? { underline: {} } : {}),
      ...(fmt.strike ? { strike: true } : {}),
      ...(fmt.highlight ? { highlight: 'yellow' as const } : {}),
    }

    const made = parts.flatMap((part, i) => {
      const opts = { ...style, text: part, ...(i > 0 ? { break: 1 } : {}) }
      if (rev === 'ins') return [new InsertedTextRun({ ...opts, ...this.stamp() })]
      if (rev === 'del') return [new DeletedTextRun({ ...opts, ...this.stamp() })]
      return [new TextRun(opts)]
    })

    // The link must be the OUTER element. Inverting this emits a non-existent
    // <w:externalHyperlink/> and silently drops the text.
    return fmt.link ? [new ExternalHyperlink({ children: made, link: fmt.link })] : made
  }

  /** Walk inline content, accumulating runs. */
  private inline(nodes: Node[], rev: Rev, fmt: Fmt, out: any[] = []): any[] {
    for (const n of nodes) {
      if (isText(n)) { out.push(...this.runsFor(n.value ?? '', rev, fmt)); continue }
      if (n.nodeName === 'br') { out.push(new TextRun({ break: 1 })); continue }

      // <ins>/<del> can nest inside formatting and vice versa; track both.
      const nextRev: Rev = n.nodeName === 'ins' ? 'ins' : n.nodeName === 'del' ? 'del' : rev
      this.inline(n.childNodes ?? [], nextRev, fmtFor(n, fmt), out)
    }
    return out
  }

  private paragraph(n: Node, rev: Rev, extra: Record<string, unknown> = {}): Paragraph {
    const children = this.inline(n.childNodes ?? [], rev, {})
    // A block marked wholly inserted/deleted must revise its PARAGRAPH MARK
    // too, or accepting a deletion leaves an empty paragraph behind — an
    // orphan bullet or a blank line in the executed contract.
    const mark = rev === 'ins' ? { run: { insertion: this.stamp() } }
      : rev === 'del' ? { run: { deletion: this.stamp() } }
      : {}
    const align = alignmentOf(n)
    return new Paragraph({
      children,
      ...(align ? { alignment: align } : {}),
      ...mark,
      ...extra,
    })
  }

  private listItems(list: Node, ordered: boolean, rev: Rev, depth: number, out: (Paragraph | Table)[]) {
    for (const li of list.childNodes ?? []) {
      if (li.nodeName !== 'li') continue
      const liRev = blockRev(li) ?? rev
      // Nested lists live inside the <li>; emit the item, then recurse.
      const inlineKids = (li.childNodes ?? []).filter(c => c.nodeName !== 'ul' && c.nodeName !== 'ol')
      out.push(this.paragraph({ ...li, childNodes: inlineKids }, liRev,
        ordered
          ? { numbering: { reference: ORDERED_LIST_REF, level: depth } }
          : { bullet: { level: depth } }))
      for (const kid of li.childNodes ?? []) {
        if (kid.nodeName === 'ul') this.listItems(kid, false, liRev, depth + 1, out)
        if (kid.nodeName === 'ol') this.listItems(kid, true,  liRev, depth + 1, out)
      }
    }
  }

  private table(n: Node, rev: Rev): Table {
    const rows: TableRow[] = []
    /** Widest row, in grid columns — a colspan occupies several. */
    let columns = 0
    const collectRows = (node: Node) => {
      for (const c of node.childNodes ?? []) {
        if (c.nodeName === 'tr') {
          const rowRev = blockRev(c) ?? rev
          const cells: TableCell[] = []
          let span = 0
          for (const cell of c.childNodes ?? []) {
            if (cell.nodeName !== 'td' && cell.nodeName !== 'th') continue
            const cellRev = blockRev(cell) ?? rowRev
            const isHeader = cell.nodeName === 'th'
            // Header emphasis belongs on the RUNS. Setting bold on the
            // paragraph mark alone (a tempting shortcut) bolds nothing visible.
            const kids = this.inline(cell.childNodes ?? [], cellRev, isHeader ? { bold: true } : {})
            const colspan = Math.max(1, Number(attr(cell, 'colspan') ?? 1) || 1)
            span += colspan
            cells.push(new TableCell({
              children: [new Paragraph({ children: kids })],
              ...(colspan > 1 ? { columnSpan: colspan } : {}),
              ...(Number(attr(cell, 'rowspan') ?? 1) > 1 ? { rowSpan: Number(attr(cell, 'rowspan')) } : {}),
            }))
          }
          if (cells.length) {
            columns = Math.max(columns, span)
            rows.push(new TableRow({
              children: cells,
              ...(rowRev === 'ins' ? { insertion: this.stamp() } : {}),
              ...(rowRev === 'del' ? { deletion:  this.stamp() } : {}),
            }))
          }
        } else if (c.nodeName === 'thead' || c.nodeName === 'tbody' || c.nodeName === 'tfoot') {
          collectRows(c)
        }
      }
    }
    collectRows(n)

    // The column grid must be supplied explicitly. Without it docx emits
    // <w:gridCol w:w="100"/> — 100 TWIPS, about 0.07 inch — and the table
    // collapses to a sliver that wraps one character per line. Found by opening
    // a generated file in Google Docs; "Tier" rendered vertically as T/i/e/r.
    //
    // Width in DXA rather than the percentage form for the same reason: docx
    // serialises `WidthType.PERCENTAGE` as w:w="100%", where Word's own files
    // use fiftieths of a percent as an integer (w:w="5000").
    const cols = Math.max(columns, 1)
    const each = Math.floor(USABLE_PAGE_TWIPS / cols)
    return new Table({
      rows,
      columnWidths: Array.from({ length: cols }, () => each),
      width: { size: each * cols, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
    })
  }

  /** Map one block-level node into zero or more docx blocks. */
  private block(n: Node, inheritedRev: Rev, out: (Paragraph | Table)[]) {
    const rev = blockRev(n) ?? inheritedRev

    if (isText(n)) {
      // Bare text between blocks — htmldiff can leave this when structure
      // shifts. Dropping it would silently lose contract language.
      if ((n.value ?? '').trim()) out.push(new Paragraph({ children: this.runsFor(n.value ?? '', rev, {}) }))
      return
    }

    switch (n.nodeName) {
      case 'p':
        out.push(this.paragraph(n, rev)); return
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        out.push(this.paragraph(n, rev, { heading: HEADINGS[n.nodeName] })); return
      case 'blockquote':
        out.push(this.paragraph(n, rev, { indent: { left: 720 } })); return
      case 'pre':
        // Walked, never flattened — see the header note about .txt uploads.
        out.push(this.paragraph(n, rev, { style: 'Monospace' })); return
      case 'ul': this.listItems(n, false, rev, 0, out); return
      case 'ol': this.listItems(n, true,  rev, 0, out); return
      case 'table': out.push(this.table(n, rev)); return
      case 'ins': case 'del': {
        // A whole block wrapped in <ins>/<del> rather than marked with
        // data-diff-node — carry the revision down to its children.
        const r: Rev = n.nodeName === 'ins' ? 'ins' : 'del'
        for (const c of n.childNodes ?? []) this.block(c, r, out)
        return
      }
      case 'div': case 'section': case 'article': case 'body': case 'html':
        for (const c of n.childNodes ?? []) this.block(c, rev, out)
        return
      default: {
        // Unknown element: if it holds block children, descend; otherwise
        // treat it as inline content in its own paragraph rather than dropping.
        const kids = n.childNodes ?? []
        const hasBlocks = kids.some(k => ['p', 'ul', 'ol', 'table', 'blockquote', 'pre', 'div'].includes(k.nodeName)
          || HEADINGS[k.nodeName])
        if (hasBlocks) { for (const c of kids) this.block(c, rev, out); return }
        const runs = this.inline(kids, rev, {})
        if (runs.length) out.push(new Paragraph({ children: runs }))
      }
    }
  }

  /** Entry point: an htmldiff blob becomes document body content. */
  map(diffHtml: string): (Paragraph | Table)[] {
    const frag = parseFragment(diffHtml) as unknown as Node
    const out: (Paragraph | Table)[] = []
    for (const n of frag.childNodes ?? []) this.block(n, null, out)
    // Word requires at least one block; an empty body opens as a repair prompt.
    if (!out.length) out.push(new Paragraph({ children: [] }))
    return out
  }
}
