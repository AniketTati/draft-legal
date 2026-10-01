/**
 * docs/39 A16 — a spreadsheet's rows as text: a CSV (with whichever separator
 * it was saved with — comma, semicolon, tab), or an Excel workbook's first
 * sheet, dates as YYYY-MM-DD and numbers as written. Empty rows and columns
 * are left out; a column with data but no header is named by its letter.
 *
 * An .xlsx is a zip of XML parts, read with JSZip (the API's already, for Word
 * files): the workbook (which sheet comes first), that sheet, the shared
 * strings and the number formats — a date is a number whose format is a date.
 */
import JSZip from 'jszip'
import { parseCsv } from './csv.js'

/** The most rows one import reads. */
export const IMPORT_MAX_ROWS = 1000

export type SheetResult =
  | { ok: true; headers: string[]; rows: string[][]; total: number; sheetName?: string }
  | { ok: false; detail: string }

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

export async function readSpreadsheet(file: Buffer): Promise<SheetResult> {
  if (file.subarray(0, 4).equals(ZIP)) return readXlsx(file)
  if (file.subarray(0, 8).equals(OLE)) return { ok: false, detail: 'This is an older Excel file (.xls). Save it as .xlsx or CSV and try again.' }
  // Excel's "Unicode text" is UTF-16 with a byte order mark.
  let text = file[0] === 0xff && file[1] === 0xfe ? file.subarray(2).toString('utf16le') : file.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.includes('\u0000') || !text.trim()) return { ok: false, detail: 'This file isn’t a spreadsheet: save it as CSV or .xlsx.' }
  return tidy(parseCsv(text, delimiterOf(text)))
}

/** The separator the first line uses most (outside quotes): comma, semicolon, tab or bar. */
export function delimiterOf(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 }
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && ch in counts) counts[ch]++
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return n > 0 ? best : ','
}

/** Column letters as a 0-based index ("A" → 0, "AB" → 27). */
const colIndex = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
const letters = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letters(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)))

/** Headers from the first row with anything in it; the rest as rows, empty ones and empty columns left out. */
function tidy(raw: string[][], sheetName?: string): SheetResult {
  const rows = raw.map(r => (r ?? []).map(c => (c ?? '').replace(/\s+/g, ' ').trim())).filter(r => r.some(Boolean))
  if (rows.length < 2) return { ok: false, detail: 'The spreadsheet needs a header row and at least one row below it.' }
  const width = Math.max(...rows.map(r => r.length))
  const used = Array.from({ length: width }, (_, i) => rows.some(r => r[i]))
  const keep = used.map((u, i) => (u ? i : -1)).filter(i => i >= 0)
  const [head, ...body] = rows.map(r => keep.map(i => r[i] ?? ''))
  const headers = head.map((h, j) => h || `Column ${letters(keep[j])}`)
  return { ok: true, headers, rows: body.slice(0, IMPORT_MAX_ROWS), total: body.length, ...(sheetName && { sheetName }) }
}

// ─── Excel ────────────────────────────────────────────────────────────────────

const attr = (tag: string | undefined, name: string) => (tag ? new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] : undefined)

const decode = (s: string) => s
  .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10))
  })

/** A string item's text: its runs joined, phonetic guides left out. */
const textOf = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decode(m[1])).join('')

/** Built-in number formats that are dates (not times alone). */
const DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58])

/** A custom format that shows a day or a year, once its quoted text and [colour]/[locale] parts are gone. */
const isDateFormat = (code: string) => /[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''))

/** The cell styles (by index) whose number format is a date. */
function dateStyles(xml: string | undefined): Set<number> {
  const out = new Set<number>()
  if (!xml) return out
  const custom = new Map<number, string>()
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), decode(attr(m[0], 'formatCode') ?? ''))
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  let i = 0
  for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? 0)
    if (DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) out.add(i)
    i++
  }
  return out
}

/** An Excel day number as a date (days since 1899-12-30, which absorbs Excel's 1900 leap-year slip). */
function serialToDate(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000)
  return d.toISOString().slice(0, 10)
}

async function readXlsx(file: Buffer): Promise<SheetResult> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(file) } catch { return { ok: false, detail: 'This Excel file couldn’t be opened. Save it again as .xlsx or CSV.' } }
  const workbook = await zip.file('xl/workbook.xml')?.async('string')
  if (!workbook) return { ok: false, detail: 'This isn’t an Excel workbook: save the spreadsheet as .xlsx or CSV.' }
  const first = /<sheet\b[^>]*>/.exec(workbook)?.[0]
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string') ?? ''
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(r => attr(r, 'Id') === attr(first, 'r:id'))
  const target = attr(rel, 'Target') ?? 'worksheets/sheet1.xml'
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  const sheet = await zip.file(path)?.async('string')
  if (!sheet) return { ok: false, detail: 'The workbook has no sheet to read.' }
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string') ?? ''
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]))
  const dates = dateStyles(await zip.file('xl/styles.xml')?.async('string'))

  const rows: string[][] = []
  for (const row of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const at = Number(attr(row[1], 'r')) || rows.length + 1
    const cells: string[] = []
    for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r')
      const col = ref ? colIndex(ref) : cells.length
      const t = attr(c[1], 't')
      const inner = c[2] ?? ''
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      let text = ''
      if (t === 's') text = shared[Number(v)] ?? ''
      else if (t === 'inlineStr') text = textOf(inner)
      else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE'
      else if (t === 'str' || t === 'e') text = decode(v ?? '')
      else if (v !== undefined) text = dates.has(Number(attr(c[1], 's') ?? 0)) ? serialToDate(Number(v)) : v
      cells[col] = text
    }
    rows[at - 1] = Array.from(cells, x => x ?? '')
  }
  return tidy(Array.from(rows, r => r ?? []), decode(attr(first, 'name') ?? '') || undefined)
}
