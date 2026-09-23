/**
 * X36 — the chat tools cut contract text into excerpts and redacted each on
 * its own: a value across a cut went out as a fragment no pattern matches,
 * and a card number whose "card" was outside the excerpt went out whole.
 * `cutAndRedact` finds the values in the whole text and never cuts one.
 */
import { describe, it, expect } from 'vitest'
import { cutAndRedact, documentValues } from './pii-policy.js'

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
  it('leaves no tail where values overlap inside a longer number', () => {
    // A card and a passport number whose digits overlap inside the reference.
    // X40: a value is not matched as part of a longer number, so the 20-digit
    // reference is left whole, as the detector itself reads it (before, it
    // came out as `[REDACTED:CC]9999`); the values themselves are redacted.
    const text = 'Card: 4111111111111111. Passport No. 11119999. Ref 41111111111111119999 end'
    const at = text.indexOf('Ref')
    expect(cutAndRedact({ text, cuts: [[at, text.length]] }, ph).pieces[0]).toBe('Ref 41111111111111119999 end')
    expect(cutAndRedact({ text, cuts: [[0, at]] }, ph).pieces[0]).toBe('Card: [REDACTED:CC]. Passport No. [REDACTED:PASSPORT]. ')
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

describe('cutAndRedact with the document a piece came from (X40)', () => {
  it('finds a value by a keyword only the document has', () => {
    const text = 'Charges go to 4111 1111 1111 1111 monthly.'
    const valuesFrom = `Payment is by corporate credit card.\nBilling. ${text}`
    expect(cutAndRedact({ text, cuts: [[0, text.length]] }, ph).pieces).toEqual([text])   // the clause alone: not a card
    expect(cutAndRedact({ text, cuts: [[0, text.length]], valuesFrom }, ph).pieces).toEqual(['Charges go to [REDACTED:CC] monthly.'])
  })
})

describe('cutAndRedact with a document, reviewed', () => {
  it('replaces a document value only where it stands alone', () => {
    const valuesFrom = 'Passport No. 12345678. Date of birth: 1/2/1980.'
    const text = 'Account 912345678 and passport 12345678; on 11/2/1980, born 1/2/1980.'
    expect(cutAndRedact({ text, cuts: [[0, text.length]], valuesFrom }, ph).pieces[0])
      .toBe('Account 912345678 and passport [REDACTED:PASSPORT]; on 11/2/1980, born [REDACTED:DOB].')
  })

  it('brings only the kinds that need a keyword: section numbers read as IPs stay put', () => {
    const valuesFrom = 'Wire to server 10.1.2.3 per Section 10.1.2.3.'
    const text = 'See Section 10.1.2.3a.'
    expect(cutAndRedact({ text, cuts: [[0, text.length]], valuesFrom }, ph).pieces).toEqual([text])
  })

  it('stays fast with a document full of values and many pieces', () => {
    const ips = Array.from({ length: 20_000 }, (_, i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`)
    const dobs = Array.from({ length: 1_000 }, (_, i) => `Date of birth: ${1 + (i % 12)}/${1 + (i % 28)}/${1950 + (i % 50)}`)
    const valuesFrom = `${ips.join(' ')} ${dobs.join('. ')} Paid by credit card.`
    const found = documentValues(valuesFrom)
    const clauses = Array.from({ length: 500 }, (_, i) => `Clause ${i}: the party born ${1 + (i % 12)}/${1 + (i % 28)}/${1950 + (i % 50)} pays monthly.`)
    const started = Date.now()
    const pieces = clauses.map(text => cutAndRedact({ text, cuts: [[0, text.length]] }, ph, found).pieces[0])
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(pieces.join('\n')).not.toMatch(/\d+\/\d+\/\d{4}/)
  })
})
