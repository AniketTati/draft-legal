/**
 * X67 — the text of an HTML body, as it reads.
 *
 * Inline markup (bold, italics, links, spans…) joins what it wraps, as a
 * browser renders it. Replacing every tag with a space split
 * `219-09-<strong>9999</strong>` into `219-09- 9999`, which no PII pattern
 * matches: an editor save stored an SSN whose last group was bolded in a form
 * the redaction could not see, on its way to a model.
 *
 * X67 review:
 *   - Blocks and line breaks become line breaks, so a value broken by `<br>`
 *     reads as one wrapped across a line, which the redaction handles (X52).
 *     Table cells stay side by side, separated by a space.
 *   - Where markup alone separates a letter from a digit (`<b>SSN</b>219-…`,
 *     `Card<b>4111 …</b>`) the two are kept apart, as the old conversion did,
 *     so a label never glues onto a value. Superscripts and subscripts
 *     (footnote markers) separate too.
 *   - Entities are decoded: `219&#45;09&#45;9999` is an SSN.
 *   - Linear time. The tag patterns never scan past the next `<`, and
 *     comments are cut by position; `<a` repeated over 160 KB used to block
 *     the event loop for a minute.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'kbd', 'label', 'mark', 'nobr', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'time', 'tt',
  'u', 'var', 'wbr',
])
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
])
const JOIN = ''   // an inline tag, until the characters around it are known
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function withoutComments(html: string): string {
  let out = ''
  let at = 0
  for (;;) {
    const open = html.indexOf('<!--', at)
    if (open < 0) return out + html.slice(at)
    const close = html.indexOf('-->', open + 4)
    if (close < 0) return out + html.slice(at, open)   // an unclosed comment runs to the end
    out += html.slice(at, open) + ' '
    at = close + 3
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi, (whole, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()]
    const code = dec ? Number(dec) : parseInt(hex, 16)
    if (code === 0xE000) return ''
    if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return whole
    return String.fromCodePoint(code)
  })
}

const isLetter = (c: string) => /\p{L}/u.test(c)
const isDigit = (c: string) => /\p{N}/u.test(c)

export function htmlToText(html: string): string {
  const tagged = withoutComments(html.replace(//g, ''))
    .replace(/<\/?([a-z][a-z0-9-]*)\b(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/gi, (_tag, name: string) => {
      const n = name.toLowerCase()
      return INLINE_TAGS.has(n) ? JOIN : BLOCK_TAGS.has(n) ? '\n' : ' '
    })
    .replace(/<[^<>]*>/g, ' ')   // doctypes, processing instructions, malformed tags
  return decodeEntities(tagged)
    // Joined, unless markup was all that kept a letter and a digit apart.
    .replace(/+/g, (run, at: number, text: string) => {
      const a = text[at - 1] ?? ''
      const b = text[at + run.length] ?? ''
      return (isLetter(a) && isDigit(b)) || (isDigit(a) && isLetter(b)) ? ' ' : ''
    })
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
