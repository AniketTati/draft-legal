/**
 * BB1 — the redline engine: their Word file, with our changes as Word tracked
 * changes. Code owns the document's structure; nothing here asks a model.
 *
 * The counterparty sent a .docx with their numbering, styles, headers and
 * footers. Our current version is HTML. `redlineDocx` lines up their
 * paragraphs with ours and writes the differences into THEIR file, word by
 * word, in their runs' formatting (w:ins / w:del), leaving every paragraph it
 * doesn't change as it was. A paragraph it can't change safely (their own
 * tracked changes, a field, an embedded object) is left alone and reported,
 * never guessed at. The result is checked before it is returned: accepting
 * every change must read as our version, and rejecting ours must give their
 * file back.
 *
 * `readDocxReview` reads what a returned file carries besides its text: its
 * comments with the text they're on, and its tracked changes by author
 * (Google Docs exports suggestions as tracked changes).
 */
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { zipInflatedSize, MAX_OFFICE_INFLATED_BYTES } from '../file-type.js'
import { diffSequences, wordEdits, fold, likeness, wordBag, type TextEdit } from './sequence-diff.js'
import type { TextBlock, BlockKind } from './html-blocks.js'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** A file we can't read or write as a Word document; the message is for the user. */
export class DocxError extends Error {}

// ─── XML ────────────────────────────────────────────────────────────────────

function parseXml(xml: string, part: string): Document {
  // No DTDs: a Word part never needs one, and refusing them rules out entity
  // expansion from an untrusted file.
  if (/<!DOCTYPE/i.test(xml)) throw new DocxError(`${part} declares a document type, which a Word file never does`)
  const errors: string[] = []
  let doc: Document | undefined
  try {
    doc = new DOMParser({
      errorHandler: { warning: () => {}, error: (m: string) => { errors.push(m) }, fatalError: (m: string) => { errors.push(m) } },
    }).parseFromString(xml, 'text/xml') as unknown as Document
  } catch {
    errors.push('unreadable')
  }
  if (errors.length || !doc?.documentElement) throw new DocxError(`${part} is not valid XML`)
  return doc
}

const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc as unknown as Node)

const isW = (n: Node | null | undefined, local: string): boolean =>
  !!n && n.nodeType === 1 && (n as Element).namespaceURI === W && (n as Element).localName === local

function children(el: Node | null | undefined): Element[] {
  const out: Element[] = []
  for (let c = el?.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element)
  return out
}
const child = (el: Node | null | undefined, local: string) => children(el).find(c => isW(c, local)) ?? null

function nextElement(n: Node): Element | null {
  for (let s = n.nextSibling; s; s = s.nextSibling) if (s.nodeType === 1) return s as Element
  return null
}
function prevElement(n: Node): Element | null {
  for (let s = n.previousSibling; s; s = s.previousSibling) if (s.nodeType === 1) return s as Element
  return null
}

const attrW = (e: Element | null, name: string) => (e ? e.getAttributeNS(W, name) || e.getAttribute(`w:${name}`) || '' : '')

function el(doc: Document, local: string, attrs: Record<string, string> = {}): Element {
  const e = doc.createElementNS(W, `w:${local}`)
  for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W, `w:${k}`, v)
  return e
}

function setText(t: Element, s: string) {
  while (t.firstChild) t.removeChild(t.firstChild)
  t.appendChild(t.ownerDocument!.createTextNode(s))
  t.setAttributeNS(XML_NS, 'xml:space', 'preserve')
}

function textEl(doc: Document, local: 't' | 'delText', s: string): Element {
  const t = el(doc, local)
  setText(t, s)
  return t
}

// ─── The package ────────────────────────────────────────────────────────────

interface Package { zip: JSZip; docPart: string; doc: Document }

async function openDocx(file: Buffer): Promise<Package> {
  // X13 — inflate nothing past the limit: an untrusted zip can be a bomb.
  if (zipInflatedSize(file, MAX_OFFICE_INFLATED_BYTES) === null) {
    throw new DocxError('This file is damaged, or too large once opened, so it is not a Word document we can read')
  }
  let zip: JSZip
  try { zip = await JSZip.loadAsync(file) } catch { throw new DocxError('This file is not a Word document') }
  // The main part is named by the package's relationships; almost always this.
  let docPart = 'word/document.xml'
  const rels = zip.file('_rels/.rels')
  if (rels) {
    const r = parseXml(await rels.async('string'), '_rels/.rels')
    const list = r.getElementsByTagNameNS(REL_NS, 'Relationship')
    for (let i = 0; i < list.length; i++) {
      const rel = list[i] as Element
      if (/\/officeDocument$/.test(rel.getAttribute('Type') ?? '')) docPart = (rel.getAttribute('Target') ?? docPart).replace(/^\//, '')
    }
  }
  const part = zip.file(docPart)
  if (!part) throw new DocxError('This file is not a Word document (it has no document part)')
  return { zip, docPart, doc: parseXml(await part.async('string'), docPart) }
}

// ─── Reading paragraphs ─────────────────────────────────────────────────────

/** One content element of a paragraph, at offsets of the paragraph's text. */
interface Piece {
  start: number
  end:   number
  /** The run holding it; after `atomize`, a run holds exactly one content element. */
  run:   Element
  kind:  'text' | 'char' | 'tab' | 'break'
}

export interface DocxParagraph {
  el:           Element
  /** The paragraph's text as it reads with every tracked change accepted (as mammoth reads it). */
  text:         string
  pieces:       Piece[]
  kind:         BlockKind
  inTable:      boolean
  inTextBox:    boolean
  sectionBreak: boolean
  /** Why this paragraph can't be rewritten safely, if it can't. */
  unsafe:       string | null
}

/** Elements that only walk through to their runs. */
const CONTAINERS = new Set(['hyperlink', 'smartTag', 'sdt', 'sdtContent', 'customXml', 'bdo', 'dir'])
/** Range and proofing marks, and containers' properties: not content. */
const MARKER = /^(?:bookmark|commentRange|perm|moveFromRange|moveToRange|customXml(?:Ins|Del|MoveFrom|MoveTo)Range)(?:Start|End)$|^proofErr$|^(?:sdt|sdtEnd|smartTag|customXml)Pr$/
const HEADING_STYLE = /^(?:heading|berschrift|titre|titolo|kop|encabezado)\s*([1-6])$/i
const isTextBreak = (br: Element) => { const t = attrW(br, 'type'); return !t || t === 'textWrapping' }

function readParagraph(p: Element, where: { inTable: boolean; inTextBox: boolean }): DocxParagraph {
  const pieces: Piece[] = []
  let text = ''
  let unsafe: string | null = where.inTextBox ? 'a text box' : null
  const flag = (why: string) => { unsafe ??= why }
  const add = (s: string, run: Element, kind: Piece['kind']) => {
    pieces.push({ start: text.length, end: text.length + s.length, run, kind })
    text += s
  }
  let inCode = false

  const readRun = (r: Element, deleted: boolean) => {
    for (const c of children(r)) {
      if (c.namespaceURI !== W) { flag(c.namespaceURI === MC ? 'an embedded object' : 'content we do not edit'); continue }
      const on = !deleted && !inCode
      switch (c.localName) {
        case 'rPr':
          if (child(c, 'rPrChange')) flag('tracked changes')
          break
        // A footnote's marker is its own run and stays where it is: text
        // around it is edited like any other.
        case 'lastRenderedPageBreak': case 'commentReference': case 'annotationRef': case 'ptab': case 'softHyphen':
        case 'footnoteReference': case 'endnoteReference':
          break
        case 'fldChar': {
          flag('a field')
          const type = attrW(c, 'fldCharType')
          if (type === 'begin') inCode = true
          else if (type === 'separate' || type === 'end') inCode = false
          break
        }
        case 'instrText': case 'delInstrText': flag('a field'); break
        case 'delText': flag('tracked changes'); break
        case 't': if (on) add(c.textContent ?? '', r, 'text'); break
        case 'tab': if (on) add('\t', r, 'tab'); break
        case 'br': if (on && isTextBreak(c)) add('\n', r, 'break'); break
        case 'cr': if (on) add('\n', r, 'break'); break
        case 'noBreakHyphen': if (on) add('‑', r, 'char'); break
        case 'drawing': case 'pict': case 'object': flag('an embedded object'); break
        case 'sym': flag('a symbol character'); break
        default: flag('content we do not edit')
      }
    }
  }

  const walk = (node: Element, deleted: boolean) => {
    for (const c of children(node)) {
      if (c.namespaceURI !== W) { flag(/math/.test(c.namespaceURI ?? '') ? 'an equation' : 'content we do not edit'); continue }
      const name = c.localName
      if (name === 'pPr' || MARKER.test(name)) continue
      if (name === 'r') readRun(c, deleted)
      else if (name === 'del' || name === 'moveFrom') { flag('tracked changes'); walk(c, true) }
      else if (name === 'ins' || name === 'moveTo') { flag('tracked changes'); walk(c, deleted) }
      else if (name === 'fldSimple') { flag('a field'); walk(c, deleted) }
      else if (CONTAINERS.has(name)) walk(c, deleted)
      else flag('content we do not edit')
    }
  }
  walk(p, false)

  const pPr = child(p, 'pPr')
  const markRPr = child(pPr, 'rPr')
  if (child(markRPr, 'ins') || child(markRPr, 'del') || child(pPr, 'pPrChange')) flag('tracked changes')
  const style = attrW(child(pPr, 'pStyle'), 'val')
  const heading = HEADING_STYLE.exec(style)
  const kind: BlockKind = heading ? `h${heading[1]}` as BlockKind
    : /^title$/i.test(style) ? 'h1'
    : child(pPr, 'numPr') ? 'li'
    : where.inTable ? 'cell' : 'p'
  return { el: p, text, pieces, kind, inTable: where.inTable, inTextBox: where.inTextBox, sectionBreak: !!child(pPr, 'sectPr'), unsafe }
}

/** The body's paragraphs in document order: tables and text boxes included, the fallback copy of a drawing not. */
function bodyParagraphs(doc: Document): DocxParagraph[] {
  const body = doc.getElementsByTagNameNS(W, 'body')[0] as Element | undefined
  if (!body) throw new DocxError('This Word document has no body')
  const list = body.getElementsByTagNameNS(W, 'p')
  const out: DocxParagraph[] = []
  for (let i = 0; i < list.length; i++) {
    const p = list[i] as Element
    let inTable = false, inTextBox = false, fallback = false
    for (let a = p.parentNode; a && a !== body; a = a.parentNode) {
      if (a.nodeType !== 1) continue
      const e = a as Element
      if (e.namespaceURI === MC && e.localName === 'Fallback') fallback = true
      else if (isW(e, 'txbxContent')) inTextBox = true
      else if (isW(e, 'tc')) inTable = true
    }
    if (!fallback) out.push(readParagraph(p, { inTable, inTextBox }))
  }
  return out
}

// ─── Views (what accepting or rejecting changes gives) ─────────────────────

type Accept = (revision: Element) => boolean

function charOf(k: Element): string {
  if (isW(k, 't') || isW(k, 'delText')) return k.textContent ?? ''
  if (isW(k, 'tab')) return '\t'
  if ((isW(k, 'br') && isTextBreak(k)) || isW(k, 'cr')) return '\n'
  if (isW(k, 'noBreakHyphen')) return '‑'
  return ''
}

function viewText(p: Element, accept: Accept): string {
  let s = ''
  const walk = (node: Element, on: boolean) => {
    for (const c of children(node)) {
      if (c.namespaceURI !== W) continue
      const name = c.localName
      if (name === 'r') { if (on) for (const k of children(c)) s += charOf(k) }
      else if (name === 'ins' || name === 'moveTo') walk(c, on && accept(c))
      else if (name === 'del' || name === 'moveFrom') walk(c, on && !accept(c))
      else if (CONTAINERS.has(name) || name === 'fldSimple') walk(c, on)
    }
  }
  walk(p, true)
  return s
}

/** Non-empty paragraphs as they read with the changes `accept` picks accepted and the rest rejected. */
function viewParagraphs(doc: Document, accept: Accept): string[] {
  const out: string[] = []
  let carry = ''
  for (const { el: p } of bodyParagraphs(doc)) {
    const text = carry + viewText(p, accept)
    const markRPr = child(child(p, 'pPr'), 'rPr')
    const ins = child(markRPr, 'ins'), del = child(markRPr, 'del')
    // A paragraph mark that goes joins this paragraph to the next.
    if ((ins && !accept(ins)) || (del && accept(del))) { carry = text; continue }
    carry = ''
    if (fold(text)) out.push(text)
  }
  if (fold(carry)) out.push(carry)
  return out
}

/** A .docx's non-empty paragraphs with every tracked change accepted, or every one rejected. */
export async function docxParagraphs(file: Buffer, view: 'accepted' | 'original'): Promise<string[]> {
  const { doc } = await openDocx(file)
  return viewParagraphs(doc, () => view === 'accepted')
}

// ─── Writing tracked changes ────────────────────────────────────────────────

interface Revision { author: string; date: string; nextId: () => string }

function revisionEl(doc: Document, kind: 'ins' | 'del', rev: Revision): Element {
  return el(doc, kind, { id: rev.nextId(), author: rev.author, date: rev.date })
}

/** A paragraph's runs in order, through links and content controls, not into a run's content. */
function runsOf(p: Element): Element[] {
  const out: Element[] = []
  const walk = (node: Element) => {
    for (const c of children(node)) {
      if (isW(c, 'r')) out.push(c)
      else if (c.namespaceURI === W && (CONTAINERS.has(c.localName) || c.localName === 'ins' || c.localName === 'del')) walk(c)
    }
  }
  walk(p)
  return out
}

/** Split runs so each holds one content element, in the same formatting. */
function atomize(p: Element) {
  for (const r of runsOf(p)) {
    const rPr = child(r, 'rPr')
    let after = r
    for (const c of children(r).filter(k => !isW(k, 'rPr')).slice(1)) {
      const nr = r.ownerDocument!.createElementNS(W, 'w:r')
      if (rPr) nr.appendChild(rPr.cloneNode(true))
      nr.appendChild(c)
      after.parentNode!.insertBefore(nr, after.nextSibling)
      after = nr
    }
  }
}

/** A paragraph being edited, at offsets of its text before our edits: our insertions skipped, our deletions read. */
function readPieces(p: Element): { pieces: Piece[]; text: string } {
  const pieces: Piece[] = []
  let text = ''
  const walk = (node: Element) => {
    for (const c of children(node)) {
      if (c.namespaceURI !== W) continue
      if (c.localName === 'r') {
        for (const k of children(c)) {
          const s = charOf(k)
          if (!s) continue
          const kind: Piece['kind'] = isW(k, 't') || isW(k, 'delText') ? 'text' : isW(k, 'tab') ? 'tab' : isW(k, 'noBreakHyphen') ? 'char' : 'break'
          pieces.push({ start: text.length, end: text.length + s.length, run: c, kind })
          text += s
        }
      } else if (c.localName === 'del' || CONTAINERS.has(c.localName)) walk(c)
    }
  }
  walk(p)
  return { pieces, text }
}

/** Split a one-text run at `offset` characters; returns [left, right]. */
function splitRun(r: Element, offset: number): [Element, Element] {
  const t = child(r, 't')!
  const s = t.textContent ?? ''
  const right = r.cloneNode(true) as Element
  setText(t, s.slice(0, offset))
  setText(child(right, 't')!, s.slice(offset))
  r.parentNode!.insertBefore(right, r.nextSibling)
  return [r, right]
}

/** A run holding `text` (tabs and line breaks as their elements) in `rPr`'s formatting. */
function newRun(doc: Document, text: string, rPr: Element | null): Element {
  const r = el(doc, 'r')
  if (rPr) r.appendChild(rPr.cloneNode(true))
  for (const part of text.split(/(\t|\n)/)) {
    if (part === '\t') r.appendChild(el(doc, 'tab'))
    else if (part === '\n') r.appendChild(el(doc, 'br'))
    else if (part) r.appendChild(textEl(doc, 't', part))
  }
  return r
}

/** Mark runs deleted: their text becomes w:delText, and neighbours share one w:del. */
function wrapDeleted(runs: Element[], rev: Revision) {
  let open: Element | null = null
  for (const r of runs) {
    if (isW(r.parentNode, 'del')) continue
    const doc = r.ownerDocument!
    const t = child(r, 't')
    if (t) r.replaceChild(textEl(doc, 'delText', t.textContent ?? ''), t)
    if (open && prevElement(r) === open) { open.appendChild(r); continue }
    open = revisionEl(doc, 'del', rev)
    r.parentNode!.insertBefore(open, r)
    open.appendChild(r)
  }
}

/** Where the `n`th word of `s` ends, or -1. */
function nthWordEnd(s: string, n: number): number {
  let seen = 0
  for (const m of s.matchAll(/\S+/g)) if (++seen === n) return m.index! + m[0].length
  return -1
}

const rPrKey = (run: Element | undefined) => {
  const rPr = child(run, 'rPr')
  return rPr ? new XMLSerializer().serializeToString(rPr as unknown as Node) : ''
}

/**
 * Insert `ins` at `at`, as a tracked insertion. `replaces` is the text it
 * takes the place of, when it does.
 */
function insertAt(p: Element, at: number, ins: string, rev: Revision, replaces?: { start: number; end: number }) {
  const doc = p.ownerDocument!
  const { pieces, text } = readPieces(p)
  let prev: Piece | undefined
  for (const pc of pieces) if (pc.start < at) prev = pc
  const next = pieces.find(pc => pc.start >= at)
  const wrapper = revisionEl(doc, 'ins', rev)

  // Replacement words take the formatting of the words they replace, and any
  // words beyond those, the formatting of the text that follows: "Supplier"
  // in bold, replaced by "Vendor and its Affiliates", gives a bold "Vendor".
  const replaced = replaces ? pieces.filter(pc => pc.start < replaces.end && pc.end > replaces.start) : []
  const oldWords = replaces ? (text.slice(replaces.start, replaces.end).match(/\S+/g) ?? []).length : 0
  const cut = oldWords ? nthWordEnd(ins, oldWords) : -1
  if (replaced.length && next && cut > 0 && cut < ins.length
      && new Set(replaced.map(pc => rPrKey(pc.run))).size === 1 && rPrKey(replaced[0].run) !== rPrKey(next.run)) {
    wrapper.appendChild(newRun(doc, ins.slice(0, cut), child(replaced[0].run, 'rPr')))
    wrapper.appendChild(newRun(doc, ins.slice(cut), child(next.run, 'rPr')))
  } else {
    // New words take the formatting of the text they sit in front of; the rest
    // of a word, the formatting of the word it continues.
    const before = at > 0 ? text[at - 1] : ''
    const startsWord = /^\s/.test(ins) || !before || /\s/.test(before)
    const fmt = (startsWord && next ? next.run : prev?.run) ?? next?.run ?? null
    wrapper.appendChild(newRun(doc, ins, child(fmt, 'rPr')))
  }

  let anchor: Element, after: boolean
  if (prev) {
    anchor = prev.kind === 'text' && at < prev.end ? splitRun(prev.run, at - prev.start)[0] : prev.run
    after = true
  } else if (next) {
    anchor = next.run
    after = false
  } else {
    p.appendChild(wrapper)
    return
  }
  // Beside the run: outside a deletion of ours, and outside a link it ends or starts.
  let host = anchor
  for (;;) {
    const parent = host.parentNode as Element
    if (isW(parent, 'del')) { host = parent; continue }
    if (isW(parent, 'hyperlink') && (after ? !nextElement(host) : !prevElement(host))) { host = parent; continue }
    break
  }
  host.parentNode!.insertBefore(wrapper, after ? host.nextSibling : host)
}

/** Apply word edits to one paragraph, in place, as tracked changes. */
function applyEdits(p: Element, edits: readonly TextEdit[], rev: Revision) {
  atomize(p)
  // Right to left, so offsets to the left stay those of the original text.
  const sorted = [...edits].sort((x, y) => {
    const px = x.kind === 'delete' ? x.start : x.at
    const py = y.kind === 'delete' ? y.start : y.at
    return py - px || (x.kind === 'insert' ? -1 : 1)
  })
  for (const e of sorted) {
    if (e.kind === 'insert') {
      const replaces = edits.find((d): d is Extract<TextEdit, { kind: 'delete' }> => d.kind === 'delete' && d.end === e.at)
      insertAt(p, e.at, e.text, rev, replaces)
      continue
    }
    const runs: Element[] = []
    for (const pc of readPieces(p).pieces) {
      if (pc.end <= e.start || pc.start >= e.end || isW(pc.run.parentNode, 'del')) continue
      let run = pc.run
      if (pc.kind === 'text') {
        if (e.end < pc.end) run = splitRun(run, e.end - pc.start)[0]
        if (e.start > pc.start) run = splitRun(run, e.start - pc.start)[1]
      }
      runs.push(run)
    }
    wrapDeleted(runs, rev)
  }
}

/** Track the paragraph mark itself as inserted or deleted. */
function markParagraph(p: Element, kind: 'ins' | 'del', rev: Revision) {
  const doc = p.ownerDocument!
  let pPr = child(p, 'pPr')
  if (!pPr) { pPr = el(doc, 'pPr'); p.insertBefore(pPr, p.firstChild) }
  let rPr = child(pPr, 'rPr')
  if (!rPr) {
    rPr = el(doc, 'rPr')
    // A paragraph's run properties come before its section and change records.
    pPr.insertBefore(rPr, child(pPr, 'sectPr') ?? child(pPr, 'pPrChange'))
  }
  rPr.insertBefore(revisionEl(doc, kind, rev), rPr.firstChild)
}

function deleteParagraph(para: DocxParagraph, rev: Revision) {
  wrapDeleted(runsOf(para.el), rev)
  // Joining it to the next paragraph is right only when one follows, and
  // never across a section break.
  if (!para.sectionBreak && isW(nextElement(para.el), 'p')) markParagraph(para.el, 'del', rev)
}

function newParagraph(doc: Document, text: string, like: DocxParagraph | null, rev: Revision): Element {
  const p = el(doc, 'p')
  const likePPr = child(like?.el, 'pPr')
  const pPr = likePPr ? likePPr.cloneNode(true) as Element : el(doc, 'pPr')
  for (const c of children(pPr)) if (isW(c, 'rPr') || isW(c, 'sectPr') || isW(c, 'pPrChange')) pPr.removeChild(c)
  p.appendChild(pPr)
  const likeRun = like?.pieces.find(pc => pc.kind === 'text')?.run
  const wrapper = revisionEl(doc, 'ins', rev)
  wrapper.appendChild(newRun(doc, text, child(likeRun, 'rPr')))
  p.appendChild(wrapper)
  markParagraph(p, 'ins', rev)
  return p
}

function outermostTable(n: Element): Element | null {
  let found: Element | null = null
  for (let a = n.parentNode; a; a = a.parentNode) {
    if (isW(a, 'tbl')) found = a as Element
    if (isW(a, 'body') || isW(a, 'txbxContent')) break
  }
  return found
}

/** Word opens the file with Track Changes on, so the counterparty's edits are tracked too. */
async function turnOnTracking(zip: JSZip) {
  const part = zip.file('word/settings.xml')
  if (!part) return
  const doc = parseXml(await part.async('string'), 'word/settings.xml')
  const root = doc.documentElement as unknown as Element
  if (child(root, 'trackRevisions')) return
  // CT_Settings is a sequence: trackRevisions goes before the first of these.
  const LATER = new Set([
    'doNotTrackMoves', 'doNotTrackFormatting', 'documentProtection', 'autoFormatOverride', 'styleLockTheme',
    'styleLockQFSet', 'defaultTabStop', 'autoHyphenation', 'consecutiveHyphenLimit', 'hyphenationZone',
    'doNotHyphenateCaps', 'showEnvelope', 'summaryLength', 'clickAndTypeStyle', 'defaultTableStyle',
    'evenAndOddHeaders', 'bookFoldRevPrinting', 'bookFoldPrinting', 'bookFoldPrintingSheets',
    'drawingGridHorizontalSpacing', 'drawingGridVerticalSpacing', 'displayHorizontalDrawingGridEvery',
    'displayVerticalDrawingGridEvery', 'doNotUseMarginsForDrawingGridOrigin', 'drawingGridHorizontalOrigin',
    'drawingGridVerticalOrigin', 'doNotShadeFormData', 'noPunctuationKerning', 'characterSpacingControl',
    'printTwoOnOne', 'strictFirstAndLastChars', 'noLineBreaksAfter', 'noLineBreaksBefore', 'savePreviewPicture',
    'doNotValidateAgainstSchema', 'saveInvalidXml', 'ignoreMixedContent', 'alwaysShowPlaceholderText',
    'doNotDemarcateInvalidXml', 'saveXmlDataOnly', 'useXSLTWhenSaving', 'saveThroughXslt', 'showXMLTags',
    'alwaysMergeEmptyNamespace', 'updateFields', 'hdrShapeDefaults', 'footnotePr', 'endnotePr', 'compat',
    'docVars', 'rsids', 'attachedSchema', 'themeFontLang', 'clrSchemeMapping', 'doNotIncludeSubdocsInStats',
    'doNotAutoCompressPictures', 'forceUpgrade', 'captions', 'readModeInkLockDown', 'smartTagType',
    'schemaLibrary', 'shapeDefaults', 'doNotEmbedSmartTags', 'decimalSymbol', 'listSeparator',
  ])
  const before = children(root).find(c => c.namespaceURI !== W || LATER.has(c.localName)) ?? null
  root.insertBefore(el(doc, 'trackRevisions'), before)
  zip.file('word/settings.xml', serialize(doc))
}

// ─── Their tracked changes ──────────────────────────────────────────────────

function allOf(root: Element, local: string): Element[] {
  const list = root.getElementsByTagNameNS(W, local)
  const out: Element[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i] as Element)
  return out
}

function unwrap(e: Element) {
  const parent = e.parentNode!
  while (e.firstChild) parent.insertBefore(e.firstChild, e)
  parent.removeChild(e)
}

/**
 * Accept every tracked change already in the document: what "their draft as
 * it reads" means when they sent a redline back. Returns how many there were.
 */
function acceptAll(doc: Document): number {
  const body = doc.getElementsByTagNameNS(W, 'body')[0] as Element
  let n = 0
  const remove = (e: Element) => { e.parentNode?.removeChild(e); n++ }
  for (const e of [...allOf(body, 'del'), ...allOf(body, 'moveFrom')]) {
    if (isW(e.parentNode, 'rPr')) continue                            // a paragraph mark: below
    if (isW(e.parentNode, 'trPr')) { remove(e.parentNode!.parentNode as Element); continue } // a deleted row
    remove(e)
  }
  for (const e of [...allOf(body, 'ins'), ...allOf(body, 'moveTo')]) {
    if (isW(e.parentNode, 'rPr') || isW(e.parentNode, 'trPr')) remove(e)
    else { unwrap(e); n++ }
  }
  for (const name of ['rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'tblGridChange', 'trPrChange', 'tcPrChange', 'tblPrExChange', 'numberingChange', 'cellIns']) {
    for (const e of allOf(body, name)) remove(e)
  }
  for (const name of ['moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']) {
    for (const e of allOf(body, name)) e.parentNode?.removeChild(e)
  }
  // A deleted paragraph mark joins the paragraph to the next one.
  for (const p of allOf(body, 'p')) {
    const del = child(child(child(p, 'pPr'), 'rPr'), 'del')
    if (!del) continue
    del.parentNode!.removeChild(del)
    n++
    const next = nextElement(p)
    if (!isW(next, 'p')) continue
    const at = child(next, 'pPr')?.nextSibling ?? next!.firstChild
    for (const c of children(p)) if (!isW(c, 'pPr')) next!.insertBefore(c, at)
    p.parentNode!.removeChild(p)
  }
  return n
}

// ─── The engine ─────────────────────────────────────────────────────────────

export interface RedlineStats {
  modified: number
  inserted: number
  deleted:  number
  /** Changes we would have made but didn't, and why. */
  skipped:  Array<{ text: string; reason: string }>
  /** Accepting every change reads as intended, and rejecting ours gives their file back. */
  verified: boolean
  /** Tracked changes of theirs accepted first, when asked to (`acceptExisting`). */
  acceptedExisting: number
}

/** Whether a stretch of the paragraph's text is all in one formatting (so one change can cover it). */
function sameFormatting(p: DocxParagraph): (start: number, end: number) => boolean {
  const keyOf = new Map<Element, string>()
  const fmt: string[] = []
  for (const pc of p.pieces) {
    let k = keyOf.get(pc.run)
    if (k === undefined) { k = rPrKey(pc.run); keyOf.set(pc.run, k) }
    for (let i = pc.start; i < pc.end; i++) fmt[i] = k
  }
  return (start, end) => {
    for (let i = start + 1; i < end; i++) if (fmt[i] !== fmt[start]) return false
    return true
  }
}

// A bullet typed as text rather than Word numbering: kept from their paragraph.
const BULLET_LABEL = /^[\s\u00a0]*[•◦▪▫●○■□‣⁃·][\s\u00a0]+/
const paraKey = (s: string) => fold(s.replace(BULLET_LABEL, ''))

/** Two paragraphs this alike (word-bag, 0..1) are one paragraph edited, not one removed and one added. */
const PAIR_MIN = 0.34

/** For each of ours, the index of the one of theirs it edits, or -1: in order, most alike overall. */
function pairUp(theirs: readonly DocxParagraph[], ours: readonly TextBlock[]): number[] {
  const pairs = new Array<number>(ours.length).fill(-1)
  const n = theirs.length, m = ours.length
  if (!n || !m) return pairs
  const tb = theirs.map(t => wordBag(t.text)), ob = ours.map(o => wordBag(o.text))
  const score = (i: number, j: number) => { const s = likeness(tb[i], ob[j]); return s >= PAIR_MIN ? s : 0 }
  if (n * m > 250_000) {
    // A huge gap: pair greedily within a window rather than weigh every pair.
    let from = 0
    for (let j = 0; j < m; j++) {
      let best = -1, bestScore = 0
      for (let i = from; i < Math.min(n, from + 60); i++) { const s = score(i, j); if (s > bestScore) { best = i; bestScore = s } }
      if (best >= 0) { pairs[j] = best; from = best + 1 }
    }
    return pairs
  }
  const S = new Float64Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => i * (m + 1) + j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = score(i - 1, j - 1)
      S[at(i, j)] = Math.max(S[at(i - 1, j)], S[at(i, j - 1)], s > 0 ? S[at(i - 1, j - 1)] + s : 0)
    }
  }
  for (let i = n, j = m; i > 0 && j > 0;) {
    const s = score(i - 1, j - 1)
    if (s > 0 && S[at(i, j)] === S[at(i - 1, j - 1)] + s) { pairs[j - 1] = i - 1; i--; j-- }
    else if (S[at(i, j)] === S[at(i - 1, j)]) i--
    else j--
  }
  return pairs
}

/**
 * Their .docx, with `target` (our version's paragraphs, in order) written in
 * as tracked changes by `author`. With `acceptExisting`, tracked changes
 * already in their file are accepted first, so ours are marked against their
 * draft as it reads (a returned redline); otherwise a paragraph holding one
 * is left alone.
 */
export async function redlineDocx(
  original: Buffer,
  target: readonly TextBlock[],
  opts: { author: string; date?: Date; acceptExisting?: boolean },
): Promise<{ docx: Buffer; stats: RedlineStats }> {
  const { zip, docPart, doc } = await openDocx(original)
  const acceptedExisting = opts.acceptExisting ? acceptAll(doc) : 0
  const baseline = viewParagraphs(doc, () => true)
  const body = doc.getElementsByTagNameNS(W, 'body')[0] as Element

  // Revision ids continue past every id already in the document.
  let maxId = 0
  const all = doc.getElementsByTagNameNS(W, '*')
  for (let i = 0; i < all.length; i++) {
    const v = Number(attrW(all[i] as Element, 'id'))
    if (Number.isFinite(v) && v > maxId) maxId = v
  }
  const baseMaxId = maxId
  const rev: Revision = {
    author: opts.author.trim() || 'DraftLegal',
    date:   (opts.date ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    nextId: () => String(++maxId),
  }

  const theirs = bodyParagraphs(doc).filter(p => fold(p.text) !== '')
  const ours = target.filter(b => fold(b.text) !== '')
  const index = new Map(theirs.map((p, i) => [p, i]))
  type Item = DocxParagraph | TextBlock
  const ops = diffSequences<Item>(theirs, ours, x => paraKey(x.text))

  const stats: RedlineStats = { modified: 0, inserted: 0, deleted: 0, skipped: [], verified: false, acceptedExisting }
  const skip = (text: string, reason: string) => stats.skipped.push({ text: text.replace(/\s+/g, ' ').trim().slice(0, 140), reason })
  /** What the document should read, paragraph by paragraph, once every change is accepted. */
  const expected: string[] = []

  const matches = (p: DocxParagraph, b: TextBlock) =>
    !p.inTextBox && p.inTable === b.inTable && (b.kind === 'cell' || p.kind === b.kind)
  const likeFor = (b: TextBlock, near: number): DocxParagraph | null => {
    for (let d = 0; d <= 20; d++) {
      for (const i of d ? [near + d, near - d] : [near]) {
        const p = theirs[i]
        if (p && matches(p, b)) return p
      }
    }
    return theirs[near] ?? theirs[near + 1] ?? null
  }

  const modify = (p: DocxParagraph, b: TextBlock) => {
    let to = b.text
    const label = BULLET_LABEL.exec(p.text)?.[0]
    if (label && !BULLET_LABEL.test(to)) to = label + to
    if (p.unsafe) {
      if (paraKey(p.text) !== paraKey(to)) skip(p.text, `it contains ${p.unsafe}`)
      expected.push(p.text)
      return
    }
    const edits = wordEdits(p.text, to, sameFormatting(p))
    if (edits.length) { applyEdits(p.el, edits, rev); stats.modified++ }
    expected.push(to)
  }

  let cursorEl: Element | null = null
  let cursorIdx = -1
  let gapT: DocxParagraph[] = []
  let gapO: TextBlock[] = []
  const closeGap = (nextEqual: DocxParagraph | null) => {
    const pairs = pairUp(gapT, gapO)
    let nextT = 0
    const pass = (upTo: number) => {
      for (; nextT < upTo; nextT++) {
        const p = gapT[nextT]
        if (p.unsafe) {
          // A text box's paragraphs are often missing from our HTML: not a change we skipped.
          if (!p.inTextBox) skip(p.text, `it contains ${p.unsafe}`)
          expected.push(p.text)
        } else {
          deleteParagraph(p, rev)
          stats.deleted++
        }
        cursorEl = p.el
        cursorIdx = index.get(p)!
      }
    }
    gapO.forEach((b, j) => {
      const i = pairs[j]
      if (i >= 0) {
        pass(i)
        modify(gapT[i], b)
        cursorEl = gapT[i].el
        cursorIdx = index.get(gapT[i])!
        nextT = i + 1
        return
      }
      // A new paragraph: after what it follows, and after paragraphs removed there.
      pass(pairs.slice(j + 1).find(x => x >= 0) ?? gapT.length)
      const following = gapT[nextT] ?? nextEqual
      const near = cursorIdx >= 0 ? cursorIdx : following ? index.get(following)! : 0
      const np = newParagraph(doc, b.text, likeFor(b, near), rev)
      if (cursorEl) {
        const host = (!b.inTable && outermostTable(cursorEl)) || cursorEl
        host.parentNode!.insertBefore(np, host.nextSibling)
      } else if (following) {
        const host = (!b.inTable && outermostTable(following.el)) || following.el
        host.parentNode!.insertBefore(np, host)
      } else {
        body.insertBefore(np, child(body, 'sectPr'))
      }
      cursorEl = np
      stats.inserted++
      expected.push(b.text)
    })
    pass(gapT.length)
    gapT = []
    gapO = []
  }
  for (const op of ops) {
    if (op.kind === 'equal') {
      const p = op.a as DocxParagraph
      closeGap(p)
      expected.push(p.text)
      cursorEl = p.el
      cursorIdx = index.get(p)!
    } else if (op.kind === 'delete') gapT.push(op.a as DocxParagraph)
    else gapO.push(op.b as TextBlock)
  }
  closeGap(null)

  // The check: accepting everything reads as expected; rejecting ours gives theirs back.
  const isOurs = (e: Element) => Number(attrW(e, 'id')) > baseMaxId
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((s, i) => paraKey(s) === paraKey(y[i]))
  stats.verified = same(viewParagraphs(doc, () => true), expected) && same(viewParagraphs(doc, e => !isOurs(e)), baseline)

  zip.file(docPart, serialize(doc))
  if (stats.modified + stats.inserted + stats.deleted + acceptedExisting > 0) await turnOnTracking(zip)
  const docx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { docx, stats }
}

// ─── Reading a returned file ────────────────────────────────────────────────

export interface ReviewComment {
  id:       string
  author:   string
  date:     string | null
  text:     string
  /** The text it is attached to, as it reads with changes accepted. */
  anchor:   string
  /** The comment this one replies to, when the file records threads. */
  parentId: string | null
  resolved: boolean
}
export interface DocxReview {
  comments:  ReviewComment[]
  revisions: { insertions: number; deletions: number; byAuthor: Record<string, number> }
}

/** Comments (with the text they're on) and tracked changes by author. */
export async function readDocxReview(file: Buffer): Promise<DocxReview> {
  const { zip, doc } = await openDocx(file)

  const revisions = { insertions: 0, deletions: 0, byAuthor: {} as Record<string, number> }
  for (const [kind, names] of [['ins', ['ins', 'moveTo']], ['del', ['del', 'moveFrom']]] as const) {
    for (const name of names) {
      const list = doc.getElementsByTagNameNS(W, name)
      for (let i = 0; i < list.length; i++) {
        const e = list[i] as Element
        // A paragraph mark's revision rides with its text's; count the text.
        if (isW(e.parentNode, 'rPr') || isW(e.parentNode, 'trPr')) continue
        if (kind === 'ins') revisions.insertions++
        else revisions.deletions++
        const author = attrW(e, 'author') || 'Unknown'
        revisions.byAuthor[author] = (revisions.byAuthor[author] ?? 0) + 1
      }
    }
  }

  const comments: ReviewComment[] = []
  const part = zip.file('word/comments.xml')
  if (!part) return { comments, revisions }
  const cdoc = parseXml(await part.async('string'), 'word/comments.xml')

  // The text each comment is attached to.
  const anchors = new Map<string, string>()
  const open = new Set<string>()
  const walk = (node: Node, deleted: boolean) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue
      const e = c as Element
      if (isW(e, 'commentRangeStart')) { const id = attrW(e, 'id'); open.add(id); if (!anchors.has(id)) anchors.set(id, '') }
      else if (isW(e, 'commentRangeEnd')) open.delete(attrW(e, 'id'))
      else if (isW(e, 't')) { if (!deleted) for (const id of open) anchors.set(id, (anchors.get(id)! + (e.textContent ?? '')).slice(0, 400)) }
      else if (isW(e, 'p')) { walk(e, deleted); for (const id of open) anchors.set(id, anchors.get(id)! + ' ') }
      else walk(e, deleted || isW(e, 'del') || isW(e, 'moveFrom'))
    }
  }
  const body = doc.getElementsByTagNameNS(W, 'body')[0]
  if (body) walk(body, false)

  // Threads and resolution, where the file records them (Word 2013 on).
  const byPara = new Map<string, { parent: string; done: boolean }>()
  const ext = zip.file('word/commentsExtended.xml')
  if (ext) {
    const edoc = parseXml(await ext.async('string'), 'word/commentsExtended.xml')
    const list = edoc.getElementsByTagNameNS(W15, 'commentEx')
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as Element
      byPara.set(e.getAttributeNS(W15, 'paraId') ?? '', { parent: e.getAttributeNS(W15, 'paraIdParent') ?? '', done: e.getAttributeNS(W15, 'done') === '1' })
    }
  }

  const idOfPara = new Map<string, string>()
  const list = cdoc.getElementsByTagNameNS(W, 'comment')
  const raw: Array<ReviewComment & { para: string }> = []
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as Element
    const id = attrW(c, 'id')
    const paras = c.getElementsByTagNameNS(W, 'p')
    const lines: string[] = []
    let para = ''
    for (let j = 0; j < paras.length; j++) {
      const p = paras[j] as Element
      lines.push(viewText(p, () => true))
      para = p.getAttributeNS(W14, 'paraId') || para
    }
    if (para) idOfPara.set(para, id)
    raw.push({
      id, para,
      author:   attrW(c, 'author') || 'Unknown',
      date:     attrW(c, 'date') || null,
      text:     lines.join('\n').trim(),
      anchor:   fold(anchors.get(id) ?? ''),
      parentId: null,
      resolved: false,
    })
  }
  for (const { para, ...c } of raw) {
    const x = para ? byPara.get(para) : undefined
    comments.push({ ...c, parentId: x?.parent ? idOfPara.get(x.parent) ?? null : null, resolved: !!x?.done })
  }
  return { comments, revisions }
}

// ─── Tracked changes as suggestions (docs/41 C4) ────────────────────────────

/** A run of a paragraph's text: unchanged, or inserted / deleted by someone. */
export interface TrackedSegment { text: string; kind: 'ins' | 'del' | null; author: string; date: string; id: string }
export interface TrackedParagraph {
  /** The paragraph as it reads with every change accepted (as mammoth reads it). */
  accepted: string
  segments: TrackedSegment[]
}

/**
 * The body's paragraphs that carry tracked changes, each as its text in runs
 * marked inserted or deleted with the change's author, date and id. Read so
 * an upload's changes can be shown as suggestions (lib/ooxml/docx-suggestions).
 */
export async function docxTrackedParagraphs(file: Buffer): Promise<TrackedParagraph[]> {
  const { doc } = await openDocx(file)
  const out: TrackedParagraph[] = []
  for (const { el: p } of bodyParagraphs(doc)) {
    const segments: TrackedSegment[] = []
    const add = (text: string, rev: Element | null, kind: 'ins' | 'del' | null) => {
      if (!text) return
      const author = rev ? attrW(rev, 'author') || 'Unknown' : ''
      const date = rev ? attrW(rev, 'date') : ''
      const id = rev ? attrW(rev, 'id') : ''
      const last = segments[segments.length - 1]
      if (last && last.kind === kind && last.author === author && last.id === id) last.text += text
      else segments.push({ text, kind, author, date, id })
    }
    const walk = (node: Element, rev: Element | null, kind: 'ins' | 'del' | null) => {
      for (const c of children(node)) {
        if (c.namespaceURI !== W) continue
        const name = c.localName
        if (name === 'r') { for (const k of children(c)) add(charOf(k), rev, kind) }
        else if (name === 'ins' || name === 'moveTo') walk(c, c, kind === 'del' ? 'del' : 'ins')
        else if (name === 'del' || name === 'moveFrom') walk(c, c, 'del')
        else if (CONTAINERS.has(name) || name === 'fldSimple') walk(c, rev, kind)
      }
    }
    walk(p, null, null)
    if (!segments.some(s => s.kind)) continue
    out.push({ accepted: segments.filter(s => s.kind !== 'del').map(s => s.text).join(''), segments })
  }
  return out
}
