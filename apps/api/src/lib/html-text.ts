/**
 * X67 — the text of an HTML body, as it reads.
 *
 * Inline markup (bold, italics, links, spans…) joins what it wraps, as a
 * browser renders it; every other tag (paragraphs, headings, list items, table
 * cells, line breaks) separates. Replacing every tag with a space split
 * `219-09-<strong>9999</strong>` into `219-09- 9999`, which no PII pattern
 * matches: an editor save stored an SSN whose last group was bolded in a form
 * the redaction could not see, on its way to a model.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var',
])

export function htmlToText(html: string): string {
  return html
    // A quoted attribute value may hold a `>`.
    .replace(/<\/?([a-z][a-z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (_tag, name: string) => (INLINE_TAGS.has(name.toLowerCase()) ? '' : ' '))
    .replace(/<!--[\s\S]*?-->|<[^>]*>/g, ' ')   // comments, doctypes
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
