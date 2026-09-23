/**
 * X36 — the chat tools cut contract text into excerpts and redacted each on
 * its own: a value across a cut went out as a fragment no pattern matches,
 * and a card number whose "card" was outside the excerpt went out whole.
 * `cutAndRedact` finds the values in the whole text and never cuts one.
 */
import { describe, it, expect } from 'vitest'
import { cutAndRedact } from './pii-policy.js'

const ph = (kind: string) => `[REDACTED:${kind}]`

describe('cutAndRedact', () => {
  it('moves a cut inside a value to its start, so no piece carries a fragment', () => {
    const text = 'The Employee SSN 123-45-6789 is on file.'
    const at = text.indexOf('123-45')
    // The first N characters, N inside the SSN: the value is left out.
    expect(cutAndRedact({ text, cuts: [[0, at + 6]] }, ph).pieces).toEqual(['The Employee SSN '])
    // A window starting inside it takes the whole value, redacted.
    expect(cutAndRedact({ text, cuts: [[at + 4, text.length]] }, ph).pieces).toEqual(['[REDACTED:SSN] is on file.'])
  })

  it('keeps adjacent windows adjacent when a value spans their seam', () => {
    const text = 'aaa 123-45-6789 bbb'
    const seam = text.indexOf('123') + 3
    const { pieces } = cutAndRedact({ text, cuts: [[0, seam], [seam, text.length]] }, ph)
    expect(pieces).toEqual(['aaa ', '[REDACTED:SSN] bbb'])
  })

  it('finds a value by a keyword outside the piece', () => {
    const text = `Payment is by credit card.${' x'.repeat(60)} Charged to 4111 1111 1111 1111 monthly.`
    const start = text.indexOf('Charged')
    expect(cutAndRedact({ text, cuts: [[start, text.length]] }, ph).pieces).toEqual(['Charged to [REDACTED:CC] monthly.'])
  })

  it('counts what it replaced, and leaves text without values as cut', () => {
    const text = 'SSN 123-45-6789 and 123-45-6789'
    expect(cutAndRedact({ text, cuts: [[0, text.length]] }, ph).counts).toEqual({ SSN: 2 })
    expect(cutAndRedact({ text: 'nothing here', cuts: [[0, 7], [-5, 99]] }, ph).pieces).toEqual(['nothing', 'nothing here'])
  })
})

describe('cutAndRedact, reviewed', () => {
  it('replaces overlapping values as one run, leaving no tail', () => {
    // A card and a passport number that overlap inside the reference.
    const text = 'Card: 4111111111111111. Passport No. 11119999. Ref 41111111111111119999 end'
    const at = text.indexOf('Ref')
    expect(cutAndRedact({ text, cuts: [[at, text.length]] }, ph).pieces[0]).toMatch(/^Ref \[REDACTED:(CC|PASSPORT)\] end$/)
  })

  it('stays fast with thousands of values in a long text', () => {
    // 5,000 distinct SSNs in about 1 MB: a scan per value took seconds.
    const ssns = Array.from({ length: 5_000 }, (_, i) => `${String(100 + (i % 500)).padStart(3, '0')}-${String(10 + Math.floor(i / 500)).padStart(2, '0')}-${String(1000 + i).padStart(4, '0')}`)
    const text = ssns.map(v => `Employee record ${'x'.repeat(170)} SSN ${v}.`).join('\n')
    const started = Date.now()
    const { pieces, counts } = cutAndRedact({ text, cuts: Array.from({ length: 50 }, (_, i) => [i * 20_000, i * 20_000 + 5_000]) }, ph)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(pieces.join('')).not.toMatch(/\d{3}-\d{2}-\d{4}/)
    expect(counts.SSN).toBeGreaterThan(0)
  })
})
