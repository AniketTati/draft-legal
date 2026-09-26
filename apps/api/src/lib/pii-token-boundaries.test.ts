/**
 * X27 — round-trip tokens have to survive the text being cut to a window,
 * a reply cut short, and a word-level diff.
 */
import { describe, it, expect } from 'vitest'
import htmldiff from 'node-htmldiff'
import { sliceOutsideTokens, dropPartialToken, withWholeTokens, valueLeftInMarkup, plainSpacesHtml, htmlTextForms, valueAcross, unresolvedPiiTokens } from './pii-policy.js'

const A = '[PII:SSN:1a2b3c4d5e6f7a8b]'
const B = '[PII:SSN:99887766aabbccdd]'

describe('sliceOutsideTokens', () => {
  const text = `before ${A} after`   // the token spans 7..33

  it('moves a start that lands inside a token past it, and an end back before it', () => {
    expect(sliceOutsideTokens(text, 10, text.length)).toBe(' after')
    expect(sliceOutsideTokens(text, 0, 20)).toBe('before ')
  })

  it('leaves cuts outside tokens, and whole tokens, alone', () => {
    expect(sliceOutsideTokens(text, 0, 7)).toBe('before ')
    expect(sliceOutsideTokens(text, 7, 33)).toBe(A)
    expect(sliceOutsideTokens(text, -50, 500)).toBe(text)
  })

  it('returns nothing for a window inside one token', () => {
    expect(sliceOutsideTokens(text, 10, 20)).toBe('')
  })
})

describe('dropPartialToken', () => {
  it('drops a token cut off at the end, however short', () => {
    for (const cut of ['[', '[P', '[PII', '[PII:', '[PII:SS', '[PII:SSN:', '[PII:SSN:1a2b3c']) {
      expect(dropPartialToken(`Paid to ${cut}`), cut).toBe('Paid to ')
    }
  })

  it('keeps whole tokens and ordinary text, in nested values too', () => {
    expect(dropPartialToken({ a: [`x ${A}`, 'y [1]'], n: 3 })).toEqual({ a: [`x ${A}`, 'y [1]'], n: 3 })
    expect(dropPartialToken({ a: ['z [PII:SS'] })).toEqual({ a: ['z '] })
  })
})

describe('withWholeTokens', () => {
  const diff = ([a, b]: string[]) => htmldiff(`<p>${a}</p>`, `<p>${b}</p>`)

  it('keeps a changed token whole on each side of the diff (htmldiff alone splits it at ":")', async () => {
    expect(diff([`SSN ${A} here`, `SSN ${B} here`])).toContain('[PII:SSN:<del')
    const out = await withWholeTokens([`SSN ${A} here`, `SSN ${B} here`], diff)
    expect(out).toMatch(/<del[^>]*>\[PII:SSN:1a2b3c4d5e6f7a8b\]<\/del>/)
    expect(out).toMatch(/<ins[^>]*>\[PII:SSN:99887766aabbccdd\]<\/ins>/)
  })

  it('an unchanged token is not a change, and text next to a token keeps its place', async () => {
    expect(await withWholeTokens([`SSN ${A}.`, `SSN ${A}.`], diff)).toBe(`<p>SSN ${A}.</p>`)
    expect(await withWholeTokens([`x${A}5`, `x${A}5 y`], ([a, b]) => `${a}|${b}`)).toBe(`x${A}5|x${A}5 y`)
  })
})

describe('valueLeftInMarkup', () => {
  it('sees a value the markup splits, which no exact replacement reaches', () => {
    expect(valueLeftInMarkup('<p>SSN 123-45-<b>6789</b>.</p>')).toBe(true)
  })

  it('and a card number whatever spaces the HTML keeps', () => {
    expect(valueLeftInMarkup('<p>Credit card 4111&nbsp;1111  1111\u20091111</p>')).toBe(true)
  })

  it('does not count a value already tokenized, or text without values', () => {
    expect(valueLeftInMarkup(`<p>SSN <b>${A}</b>.</p>`)).toBe(false)
    expect(valueLeftInMarkup('<p>No values <i>here</i>.</p>')).toBe(false)
  })
})

describe('HTML text forms', () => {
  it('makes space entities and runs of whitespace one plain space', () => {
    expect(plainSpacesHtml('<p>4111&nbsp;1111&#160;1111\u202f1111\n\t end</p>')).toBe('<p>4111 1111 1111 1111 end</p>')
  })

  it('reads a value split by markup, and a label and value in separate cells', () => {
    const [, joined, spaced] = htmlTextForms('<p>SSN 123-45-<b>6789</b></p><table><tr><td>Card</td><td>4111 1111 1111 1111</td></tr></table>')
    expect(joined).toContain('123-45-6789')
    expect(spaced).toContain('Card 4111 1111 1111 1111')
  })
})

describe('valueAcross', () => {
  it('sees a value the cursor splits', () => {
    expect(valueAcross('The SSN is 123-45-', '6789 on file.')).toBe(true)
    expect(valueAcross('Paid by credit card 4111 1111 ', '1111 1111 monthly.')).toBe(true)
  })

  it('not a value wholly on one side, or a token', () => {
    expect(valueAcross('The SSN is 123-45-6789', ' on file.')).toBe(false)
    expect(valueAcross(`The SSN is ${A}`, ' on file.')).toBe(false)
    expect(valueAcross('Nothing here, ', 'nor here.')).toBe(false)
  })
})

describe('unresolvedPiiTokens', () => {
  it('sees a placeholder however the model mangled it', () => {
    for (const p of ['[PII:SSN]', '[PII:SSN:1a2]', 'PII:SSN:1a2b3c4d', '[REDACTED]', '[REDACTED:SSN]', A]) {
      expect(unresolvedPiiTokens(`x ${p} y`), p).toHaveLength(1)
    }
  })

  it('but not one the original already had, or prose about PII', () => {
    expect(unresolvedPiiTokens('see [REDACTED] above', 'the filing says [REDACTED] above')).toHaveLength(0)
    expect(unresolvedPiiTokens('PII: names and addresses')).toHaveLength(0)
  })
})
