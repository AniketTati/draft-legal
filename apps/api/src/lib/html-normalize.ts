/**
 * Word files that come back from the other side often carry their lists as
 * text: re-saved from Pages, Google Docs or a converter, a bulleted item
 * arrives as a paragraph starting "\t•\t". Read that way, a document whose
 * text didn't change compares as dozens of inserted "•" (seen on a
 * counterparty's return: 40 of its 41 changes were bullets).
 *
 * This turns runs of such paragraphs back into the list they were, so a
 * comparison shows only what the other side actually changed.
 */

/** A bullet glyph opening a paragraph, with the whitespace around it. */
const LEADING_BULLET = /^(?:\s|&nbsp;|&#160;)*[•◦▪▫●○■□‣⁃·](?:\s|&nbsp;|&#160;)+/

export function normalizeTextBullets(html: string): string {
  const marked = html.replace(/<p>([\s\S]*?)<\/p>/g, (whole, inner: string) =>
    LEADING_BULLET.test(inner) ? `<li data-text-bullet>${inner.replace(LEADING_BULLET, '')}</li>` : whole)
  if (marked === html) return html
  return marked
    .replace(/(?:<li data-text-bullet>[\s\S]*?<\/li>\s*)+/g, run => `<ul>${run.trim()}</ul>`)
    .replace(/<li data-text-bullet>/g, '<li>')
}
