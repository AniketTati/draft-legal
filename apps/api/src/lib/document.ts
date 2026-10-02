import { createRequire } from 'module'
import mammoth from 'mammoth'
import { docxTrackedParagraphs } from './ooxml/docx-redline.js'
import { withSuggestions } from './ooxml/docx-suggestions.js'
import { zipInflatedSize, MAX_OFFICE_INFLATED_BYTES } from './file-type.js'
import { normalizeTextBullets } from './html-normalize.js'
import { ocrInBatches, type BatchReply, type PageQuality, type PageStart } from './ocr-batches.js'
import { convertToPdf } from './gotenberg.js'
import { PDFDocument } from 'pdf-lib'

const require = createRequire(import.meta.url)
// pdf-parse v1 is CJS — require() returns the function directly
const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string }>

// P2.4 — each section + paragraph carries {page, bbox} so downstream
// (citations, PDF highlight, section-scoped redlines) can anchor the
// exact region. bbox = [x0, y0, x1, y1] in PDF points (origin top-left).
export interface ExtractedParagraph {
  text:  string
  page?: number | null
  bbox?: number[] | null
}
export interface ExtractedSection {
  id:         string
  ref:        string           // '9.2' / 'Article IX' / ''
  title:      string
  level:      number           // 1-6, matches <h*> depth
  page?:      number | null
  bbox?:      number[] | null
  paragraphs: ExtractedParagraph[]
  children:   ExtractedSection[]
}
export interface ExtractedNav {
  id:    string
  ref:   string
  title: string
  level: number
  depth: number
  paragraphCount: number
  page?: number | null
  bbox?: number[] | null
}

export type ExtractResult = {
  plainText: string
  htmlContent: string
  mimeType: string
  // P2.1 — populated only by the PyMuPDF+OCR Python path. Null on the
  // pdf-parse fallback (we don't have OCR there). The upload worker
  // persists these onto ContractVersion.metadata so the HITL queue,
  // trust badges, and re-index decisions can see them.
  pageCount?:   number
  ocrApplied?:  boolean
  ocrPages?:    number
  ocrBackend?:  string | null
  // P2.2 — nested section tree + flat nav list. Persisted on
  // ContractVersion.metadata.structure so TOC / section-anchored UIs
  // don't re-parse the HTML.
  structure?: {
    sections: ExtractedSection[]
    nav:      ExtractedNav[]
  }
  /** docs/39 A12 — a legacy .doc or a scan kept as an image, as the PDF it was read from (kept to be shown and downloaded). */
  convertedPdf?: Buffer
  /** docs/39 A7 — a scan read in batches: how sure the engine was of each page, what it couldn't read, where each page starts. */
  ocr?: {
    quality:    PageQuality[]
    pageStarts: PageStart[]
    unread:     number[]
    truncated:  boolean
  }
}

export interface ExtractOptions {
  /** A7 — a scan's pages read so far, of all to read. */
  onOcrProgress?(done: number, of: number): Promise<void> | void
  /** docs/41 C4 — a Word file's tracked changes kept as suggestions in the
   *  HTML (lib/ooxml/docx-suggestions), for a contract's version. */
  suggestions?: boolean
}

/**
 * X11 — extracted text is data, not markup. Built into HTML unescaped, an
 * uploaded `<img src=x onerror=…>` or `<iframe src=…>` was stored as live
 * HTML in htmlContent. (& < > only: the text never lands in an attribute.)
 */
export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function extractDocument(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  // The stored type is detected from the bytes at upload; the filename is
  // client-supplied, so it only decides when the type is unknown (legacy rows).
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const known = mimeType === 'application/pdf' || mimeType === DOCX || mimeType === 'text/plain' || mimeType in TO_PDF
  const is = (type: string, ext: string) => mimeType === type || (!known && filename.endsWith(ext))

  if (is('application/pdf', '.pdf')) {
    return extractPdf(buffer, opts)
  }

  // docs/39 A12 — a legacy .doc, or a scan kept as an image: made a PDF, read as one
  // (a scan through OCR, A7), and the PDF kept to be shown.
  const conversion = TO_PDF[mimeType]
  if (conversion) {
    const pdf = await conversion(buffer)
    const read = await extractPdf(pdf, opts)
    return { ...read, mimeType, convertedPdf: pdf }
  }

  if (is(DOCX, '.docx')) {
    return extractDocx(buffer, opts)
  }

  if (is('text/plain', '.txt')) {
    const text = buffer.toString('utf-8')
    return { plainText: text, htmlContent: `<pre>${escapeText(text)}</pre>`, mimeType: 'text/plain' }
  }

  throw new Error(`Unsupported file type: ${mimeType} (${filename})`)
}

/** A PNG or JPEG scan as a one-page PDF, the page the size of the image (at 150 dpi). */
async function imageToPdf(image: Buffer, kind: 'png' | 'jpg'): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const embedded = kind === 'png' ? await doc.embedPng(image) : await doc.embedJpg(image)
  const scale = 72 / 150
  const page = doc.addPage([embedded.width * scale, embedded.height * scale])
  page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
  return Buffer.from(await doc.save())
}

/** docs/39 A12 — the files read as the PDF they are made into. */
const TO_PDF: Record<string, (file: Buffer) => Promise<Buffer>> = {
  'application/msword': file => convertToPdf(file, 'contract.doc'),
  'image/tiff':         file => convertToPdf(file, 'scan.tiff'),
  'image/png':          file => imageToPdf(file, 'png'),
  'image/jpeg':         file => imageToPdf(file, 'jpg'),
}

/** A request's time for the digital text, and for one batch of a scan's pages. */
const EXTRACT_TIMEOUT_MS = 60_000
const OCR_BATCH_TIMEOUT_MS = 180_000

type AgentsExtract = BatchReply & {
  pageCount?:  number
  /** A7 — the file is a scan; with `ocr: 'none'`, not read yet. */
  scanned?:    boolean
  structure?: {
    sections: ExtractedSection[]
    nav:      ExtractedNav[]
  }
}

async function extractPdf(buffer: Buffer, opts: ExtractOptions = {}): Promise<ExtractResult> {
  // Primary: pdfplumber via Python agents service (layout-aware, structure-preserving)
  const agentsUrl = process.env.AGENTS_URL ?? 'http://localhost:8002'
  const call = async (file: Uint8Array, fields: Record<string, string>, timeoutMs: number): Promise<AgentsExtract> => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(file)], { type: 'application/pdf' }), 'contract.pdf')
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    const res = await fetch(`${agentsUrl}/extract`, {
      method: 'POST',
      body: form,
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw Object.assign(new Error(`the extraction service answered ${res.status}`), { status: res.status })
    return await res.json() as AgentsExtract
  }
  try {
    // A7 — the digital text first, and whether it's a scan; a scan's pages
    // are then read a batch at a time. (An agents service from before reads a
    // scan's first 40 pages here, as it always did.)
    const data = await call(buffer, { ocr: 'none' }, EXTRACT_TIMEOUT_MS)
    if (data.scanned && !data.ocrApplied && data.pageCount) {
      const ocr = await ocrInBatches(buffer, data.pageCount, {
        read: (chunk, from) => call(chunk, { ocr: 'auto', pageOffset: String(from) }, OCR_BATCH_TIMEOUT_MS),
        progress: opts.onOcrProgress,
      })
      if (ocr.plainText.trim()) {
        console.info('[document] scan read in batches pages=%d ocrPages=%d unread=%d truncated=%s', data.pageCount, ocr.ocrPages, ocr.unread.length, ocr.truncated)
        return {
          plainText:   ocr.plainText,
          htmlContent: ocr.htmlContent,
          mimeType:    'application/pdf',
          pageCount:   data.pageCount,
          ocrApplied:  true,
          ocrPages:    ocr.ocrPages,
          ocrBackend:  ocr.ocrBackend,
          ocr: { quality: ocr.quality, pageStarts: ocr.pageStarts, unread: ocr.unread, truncated: ocr.truncated },
        }
      }
    }
    if (data.htmlContent && data.plainText) {
      console.info(
        '[document] pdfplumber extraction OK htmlLen=%d pages=%d ocr=%s sections=%d',
        data.htmlContent.length,
        data.pageCount ?? -1,
        data.ocrApplied ? (data.ocrBackend ?? 'yes') : 'no',
        data.structure?.nav?.length ?? -1,
      )
      return {
        plainText:   data.plainText,
        htmlContent: data.htmlContent,
        mimeType:    'application/pdf',
        pageCount:   data.pageCount,
        ocrApplied:  data.ocrApplied,
        ocrPages:    data.ocrPages,
        ocrBackend:  data.ocrBackend ?? null,
        structure:   data.structure,
      }
    }
  } catch (err) {
    console.warn('[document] pdfplumber unreachable or refused (%s), falling back to pdf-parse', (err as Error).message)
  }

  // Fallback: pdf-parse (always available, no structure)
  let data: { text: string }
  try {
    data = await pdfParse(buffer)
  } catch (err) {
    throw new Error(`PDF parse failed: ${(err as Error).message} — file may be corrupted or password-protected`)
  }
  const rawText = data.text
  const plainText = rawText.replace(/\s+/g, ' ').trim()
  const htmlContent = rawText
    .split(/\n{2,}|\f/)
    .map(block => block.replace(/\n/g, ' ').trim())
    .filter(block => block.length > 2)
    .map(block => `<p>${escapeText(block)}</p>`)
    .join('\n')
  return { plainText, htmlContent, mimeType: 'application/pdf' }
}

async function extractDocx(buffer: Buffer, opts: ExtractOptions = {}): Promise<ExtractResult> {
  // X13 — refuse a zip bomb before mammoth expands it (files stored before
  // the upload check existed, or reached some other way).
  if (zipInflatedSize(buffer, MAX_OFFICE_INFLATED_BYTES) === null) {
    throw new Error(`DOCX expands to more than ${MAX_OFFICE_INFLATED_BYTES / 1024 / 1024} MB when opened, or is damaged — not processed`)
  }
  const result = await mammoth.convertToHtml({ buffer })
  const plainText = await mammoth.extractRawText({ buffer })
  // Lists re-saved as "\t•\t" text read as lists again, so a returned
  // file compares by what changed, not by its bullets.
  let htmlContent = normalizeTextBullets(result.value)
  if (opts.suggestions) {
    // A file we can't read for its changes still reads as mammoth read it.
    const tracked = await docxTrackedParagraphs(buffer).catch(() => [])
    htmlContent = withSuggestions(htmlContent, tracked).html
  }
  return {
    plainText: plainText.value.replace(/\s+/g, ' ').trim(),
    htmlContent,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
}
