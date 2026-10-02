/**
 * docs/39 A7 — how well each page of a scan was read, and what that means for
 * a value read from it.
 *
 * The OCR engine says how sure it was of each page (ocr-batches.ts); a page it
 * was unsure of — a faint, skewed or stamped page — is where misreadings are
 * ("30" for "80"). A value whose words are on such a page asks to be checked
 * against it, whatever the model said.
 */
import { findQuote, normalizeForSearch } from './text-span.js'
import type { PageQuality, PageStart } from './ocr-batches.js'

/** Below this, a page is hard to read. */
export const POOR_SCAN = 0.6

export interface ScanPages { pageStarts: PageStart[]; quality: PageQuality[] }

/** A scanned version's pages, from its metadata; null for a digital one (or one read before pages were kept). */
export function scanPagesOf(metadata: unknown): ScanPages | null {
  const x = (metadata as { extraction?: { ocrApplied?: boolean; pageStarts?: unknown; ocrQuality?: unknown } } | null)?.extraction
  if (!x?.ocrApplied || !Array.isArray(x.pageStarts) || !Array.isArray(x.ocrQuality)) return null
  return { pageStarts: x.pageStarts as PageStart[], quality: x.ocrQuality as PageQuality[] }
}

/** The pages the engine was unsure of, in order. */
export function poorPages(pages: ScanPages): number[] {
  return pages.quality.filter(q => !q.failed && q.confidence != null && q.confidence < POOR_SCAN).map(q => q.page).sort((a, b) => a - b)
}

/** The page a quote is on, when it's one the engine was unsure of; null otherwise. */
export function poorPageReader(plainText: string, pages: ScanPages): (quote: string) => number | null {
  const poor = new Set(poorPages(pages))
  if (!poor.size) return () => null
  const text = normalizeForSearch(plainText)
  const starts = [...pages.pageStarts].sort((a, b) => a.start - b.start)
  return quote => {
    const span = quote.trim() ? findQuote(text, quote) : null
    if (!span) return null
    let page: number | null = null
    for (const s of starts) {
      if (s.start > span.start) break
      page = s.page
    }
    return page !== null && poor.has(page) ? page : null
  }
}

export function poorScanIssue(page: number): string {
  return `Read from page ${page} of the scan, which is hard to read.`
}
