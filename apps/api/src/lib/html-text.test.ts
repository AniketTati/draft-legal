/**
 * X67 — the stored text of an HTML version must read as the document does,
 * or the PII patterns miss values that inline markup splits.
 */
import { describe, it, expect } from 'vitest'
import { htmlToText } from './html-text.js'
import { redactPii } from './pii-redactor.js'

describe('htmlToText', () => {
  it('inline markup joins what it wraps, so a partly bolded SSN is still one value', () => {
    const text = htmlToText('<p>Employee SSN 219-09-<strong>9999</strong>, card <em>4111</em> 1111 1111 1111.</p>')
    expect(text).toBe('Employee SSN 219-09-9999, card 4111 1111 1111 1111.')
    const redacted = redactPii(text, 'redact')
    expect(redacted.text).not.toContain('9999')
    expect(redacted.text).not.toContain('4111')
  })

  it('blocks, cells and line breaks still separate', () => {
    expect(htmlToText('<h1>Terms</h1><p>One</p><ul><li>a</li><li>b</li></ul>')).toBe('Terms One a b')
    expect(htmlToText('<table><tr><td>Card</td><td>4111</td></tr></table>')).toBe('Card 4111')
    expect(htmlToText('line<br>next<br/>last')).toBe('line next last')
  })

  it('attributes, comments and non-breaking spaces are not text', () => {
    expect(htmlToText('<a href="https://x.test/a>b">link</a><!-- note -->&nbsp;end')).toBe('link end')
    expect(htmlToText('<SPAN class="x">Up</SPAN><B>per</B>')).toBe('Upper')
  })
})
