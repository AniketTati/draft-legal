/**
 * docs/39 A7 — a scanned PDF read a few pages at a time.
 *
 * The agents service OCR'd a scan inside one request, which the API gave a
 * minute, and stopped at page 40: a longer scan came back cut short, or not at
 * all when the minute ran out first (the upload then failed as "no text").
 * Now the scan's pages go over in small batches, each its own request with
 * retries, up to OCR_MAX_PAGES; the contract shows how far the reading has got,
 * and the version keeps how sure the engine was of each page, which pages it
 * couldn't read, and where each page starts in the text (scan-quality.ts).
 */
import { PDFDocument } from 'pdf-lib'

/** Pages per request: a few seconds each of OCR, well inside a request's time. */
export const OCR_BATCH_PAGES = 8
/** Pages read at most; past this the version says the rest weren't. */
export const OCR_MAX_PAGES = 1000
/** Tries per batch before its pages are left unread. */
const BATCH_TRIES = 2

export interface PageQuality { page: number; confidence: number | null; failed?: boolean }
export interface PageStart { page: number; start: number }

/** What the agents service's /extract answers for one batch. */
export interface BatchReply {
  htmlContent: string
  plainText:   string
  ocrApplied?: boolean
  ocrPages?:   number
  ocrBackend?: string | null
  ocrQuality?: PageQuality[]
  pageStarts?: PageStart[]
}

export interface OcrResult {
  htmlContent: string
  plainText:   string
  ocrPages:    number
  ocrBackend:  string | null
  quality:     PageQuality[]
  pageStarts:  PageStart[]
  /** Pages nothing could read. */
  unread:      number[]
  /** The scan has more pages than OCR_MAX_PAGES; those weren't read. */
  truncated:   boolean
}

export async function ocrInBatches(pdf: Buffer | Uint8Array, pageCount: number, deps: {
  /** One batch: its pages as a PDF of their own, and where its first page sits in the whole. */
  read(chunk: Uint8Array, pageOffset: number): Promise<BatchReply>
  /** Pages read so far, of all to read. */
  progress?(done: number, of: number): Promise<void> | void
  batchPages?: number
  maxPages?: number
}): Promise<OcrResult> {
  const source = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true })
  const pages = pageCount || source.getPageCount()
  const max = deps.maxPages ?? OCR_MAX_PAGES
  const total = Math.min(pages, max)
  const size = deps.batchPages ?? OCR_BATCH_PAGES
  const out: OcrResult = { htmlContent: '', plainText: '', ocrPages: 0, ocrBackend: null, quality: [], pageStarts: [], unread: [], truncated: pages > max }
  const html: string[] = [], plain: string[] = []
  let length = 0

  await deps.progress?.(0, total)
  for (let from = 0; from < total; from += size) {
    const to = Math.min(total, from + size)
    const doc = await PDFDocument.create()
    for (const page of await doc.copyPages(source, Array.from({ length: to - from }, (_, i) => from + i))) doc.addPage(page)
    const chunk = await doc.save()

    let reply: BatchReply | null = null
    for (let t = 1; t <= BATCH_TRIES && !reply; t++) {
      try {
        reply = await deps.read(chunk, from)
      } catch (err) {
        console.warn('[ocr] pages %d-%d, try %d of %d: %s', from + 1, to, t, BATCH_TRIES, (err as Error).message)
      }
    }
    if (!reply) {
      for (let p = from + 1; p <= to; p++) {
        out.unread.push(p)
        out.quality.push({ page: p, confidence: null, failed: true })
      }
    } else {
      const text = reply.plainText ?? ''
      if (text.trim()) {
        if (plain.length) length += 2 // the "\n\n" between batches
        const starts = reply.pageStarts?.length ? reply.pageStarts : [{ page: from + 1, start: 0 }]
        for (const s of starts) out.pageStarts.push({ page: s.page, start: length + s.start })
        plain.push(text)
        html.push(reply.htmlContent ?? '')
        length += text.length
      }
      out.ocrPages += reply.ocrPages ?? 0
      out.ocrBackend = reply.ocrBackend ?? out.ocrBackend
      for (const q of reply.ocrQuality ?? []) {
        out.quality.push(q)
        if (q.failed) out.unread.push(q.page)
      }
    }
    await deps.progress?.(to, total)
  }
  out.plainText = plain.join('\n\n')
  out.htmlContent = html.join('\n')
  return out
}
