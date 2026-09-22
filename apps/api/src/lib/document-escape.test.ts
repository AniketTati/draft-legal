/**
 * X11 — extracted text is data, not markup. The TXT and pdf-parse builders
 * wrapped raw text in <pre>/<p>, so an upload whose text reads
 * `<iframe src=…>` was stored as live HTML in htmlContent.
 */
import { describe, it, expect } from 'vitest'
import { extractDocument, escapeText } from './document.js'

describe('text → HTML escaping', () => {
  it('a text upload is stored as text, whatever it says', async () => {
    const text = '<iframe src="http://elasticsearch:9200/"></iframe> Terms & <b>conditions</b>'
    const out = await extractDocument(Buffer.from(text), 'text/plain', 'contract.txt')
    expect(out.plainText).toBe(text)
    expect(out.htmlContent).toBe('<pre>&lt;iframe src="http://elasticsearch:9200/"&gt;&lt;/iframe&gt; Terms &amp; &lt;b&gt;conditions&lt;/b&gt;</pre>')
    expect(out.htmlContent).not.toMatch(/<(iframe|b)\b/)
  })

  it('escapes exactly & < >', () => {
    expect(escapeText(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d "e" 'f'`)
  })
})
