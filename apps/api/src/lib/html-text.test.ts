/**
 * X67 — the stored text of an HTML version must read as the document does,
 * or the PII patterns miss values that markup splits or glues.
 */
import { describe, it, expect } from 'vitest'
import { htmlToText } from './html-text.js'
import { redactPii } from './pii-redactor.js'

const hidden = (text: string, ...values: string[]) => {
  const out = redactPii(text, 'redact').text
  return values.every(v => !out.includes(v))
}

describe('htmlToText', () => {
  it('inline markup joins what it wraps, so a partly bolded SSN is still one value', () => {
    const text = htmlToText('<p>Employee SSN 219-09-<strong>9999</strong>, card <em>4111</em> 1111 1111 1111.</p>')
    expect(text).toBe('Employee SSN 219-09-9999, card 4111 1111 1111 1111.')
    expect(hidden(text, '9999', '4111')).toBe(true)
  })

  it('blocks and line breaks become lines; cells stay side by side', () => {
    expect(htmlToText('<h1>Terms</h1><p>One</p><ul><li>a</li><li>b</li></ul>')).toBe('Terms\nOne\na\nb')
    expect(htmlToText('<table><tr><td>Card</td><td>4111</td></tr><tr><td>Due</td><td>net 30</td></tr></table>')).toBe('Card 4111\nDue net 30')
    expect(htmlToText('line<br>next<br/>last')).toBe('line\nnext\nlast')
  })

  it('attributes, comments and non-breaking spaces are not text', () => {
    expect(htmlToText('<a href="https://x.test/a>b">link</a><!-- note -->&nbsp;end')).toBe('link end')
    expect(htmlToText('<SPAN class="x">Up</SPAN><B>per</B>')).toBe('Upper')
  })

  // X67 review — each of these was stored so that a value escaped the redaction.
  it('markup never glues a label onto a value', () => {
    expect(htmlToText('<b>SSN</b>219-09-9999')).toBe('SSN 219-09-9999')
    expect(htmlToText('Card<b>4111 1111 1111 1111</b>')).toBe('Card 4111 1111 1111 1111')
    expect(htmlToText('219-09-9999<sup>1</sup>')).toBe('219-09-9999 1')
    expect(hidden(htmlToText('<b>SSN</b>219-09-9999 and 219-09-9999<sup>1</sup>'), '9999')).toBe(true)
    // …while letters stay letters and digits stay digits
    expect(htmlToText('<b>Con</b>fidential 12<i>34</i>')).toBe('Confidential 1234')
  })

  it('a value broken by a line break reads as one wrapped across a line', () => {
    const text = htmlToText('<p>SSN 219-09-<br>9999</p>')
    expect(text).toBe('SSN 219-09-\n9999')
    expect(hidden(text, '9999')).toBe(true)
  })

  it('decodes entities, and comments or unknown tags never split a value into a hidden form', () => {
    expect(htmlToText('SSN 219&#45;09&#x2d;9999, AT&amp;T, &lt;b&gt;')).toBe('SSN 219-09-9999, AT&T, <b>')
    expect(hidden(htmlToText('SSN 219&#45;09&#45;9999'), '9999')).toBe(true)
    expect(htmlToText('&#1114112; &#xD800; &#57344;x')).toBe('&#1114112; &#xD800; x')
  })

  it('takes linear time on markup built to make a regex backtrack', () => {
    const started = Date.now()
    for (const html of ['<a'.repeat(100_000), '<!--'.repeat(50_000), '<a title="'.repeat(20_000), '<b x=\'a'.repeat(20_000)]) {
      htmlToText(html)
    }
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
