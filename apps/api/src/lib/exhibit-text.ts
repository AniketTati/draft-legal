/**
 * docs/39 A12 — an exhibit's text as the contract's analysis and search read
 * it: after the contract's own, under its name, within what's read; and which
 * exhibit a quote is in. Text only — lib/exhibits.ts reads the files.
 */
import { findQuote, normalizeForSearch } from './text-span.js'

/** The most of one exhibit's text the analysis reads, and of all of them together. */
export const EXHIBIT_READ_MAX = 60_000
export const EXHIBITS_READ_MAX = 150_000

/** The heading an exhibit's text follows in what the analysis reads. */
export const exhibitHeading = (label: string) => `EXHIBIT: ${label}`

/** The contract's text, then each exhibit's under its heading — as much as the analysis reads. */
export function withExhibits(text: string, exhibits: Array<{ label: string; text: string }>): string {
  let room = EXHIBITS_READ_MAX
  const parts = [text]
  for (const e of exhibits) {
    if (room <= 0) break
    const body = e.text.slice(0, Math.min(EXHIBIT_READ_MAX, room))
    room -= body.length
    parts.push(`${exhibitHeading(e.label)}\n\n${body}`)
  }
  return parts.join('\n\n')
}

/** Which exhibit a quote is in, when it isn't in the contract's own text. */
export function exhibitFinder(exhibits: Array<{ s3Key: string; label: string; text: string }>): (quote: string) => { s3Key: string; label: string } | null {
  const texts = exhibits.map(e => ({ ...e, norm: normalizeForSearch(e.text) }))
  return quote => {
    if (!quote.trim()) return null
    const hit = texts.find(e => findQuote(e.norm, quote))
    return hit ? { s3Key: hit.s3Key, label: hit.label } : null
  }
}
