/**
 * DD2 — following a clause from one version's text into the next
 * (clause-carry.ts): unchanged, changed, or gone.
 */
import { describe, it, expect } from 'vitest'
import { tokensOf, mapText, locate, followSpan, spanText } from './clause-carry.js'

const V1 = [
  '1. SERVICES Supplier shall provide the Services described in the Order Form.',
  '2. FEES Customer shall pay all undisputed invoices within sixty (60) days of the invoice date.',
  '3. LIABILITY Each party’s aggregate liability shall not exceed the fees paid in the twelve (12) months preceding the claim.',
  '4. TERM This Agreement has an initial term of one (1) year.',
].join('\n')
const FEES = 'Customer shall pay all undisputed invoices within sixty (60) days of the invoice date.'
const LIABILITY = 'Each party’s aggregate liability shall not exceed the fees paid in the twelve (12) months preceding the claim.'

function follow(before: string, after: string, clause: string) {
  const a = tokensOf(before), b = tokensOf(after)
  const span = locate(a, clause)
  expect(span, 'the clause is in the old text').not.toBeNull()
  const moved = followSpan(mapText(a, b), span![0], span![1], { text: after, tokens: b })
  return moved && { unchanged: moved.unchanged, text: spanText(after, b, moved.start, moved.end) }
}

describe('following a clause through an edit', () => {
  it('finds an untouched clause, however the text around it changed', () => {
    const v2 = V1.replace('sixty (60)', 'thirty (30)').replace('1. SERVICES', '1. THE SERVICES')
    expect(follow(V1, v2, LIABILITY)).toEqual({ unchanged: true, text: LIABILITY })
  })

  it('gives a rewritten clause its new words', () => {
    const v2 = V1.replace('sixty (60) days', 'thirty (30) days, and late payments bear no interest')
    expect(follow(V1, v2, FEES)).toEqual({
      unchanged: false,
      text: 'Customer shall pay all undisputed invoices within thirty (30) days, and late payments bear no interest of the invoice date.',
    })
  })

  it('includes a rewrite of the clause’s first and last words', () => {
    const v2 = V1.replace(LIABILITY, 'Neither party’s liability shall exceed the fees paid in the twelve (12) months before the claim arose.')
    expect(follow(V1, v2, LIABILITY)).toEqual({
      unchanged: false,
      text: 'Neither party’s liability shall exceed the fees paid in the twelve (12) months before the claim arose.',
    })
  })

  it('reports a deleted clause as gone', () => {
    expect(follow(V1, V1.replace(`2. FEES ${FEES}\n`, ''), FEES)).toBeNull()
    // The last clause too, though its full stop pairs with the new last sentence's.
    const last = '4. TERM This Agreement has an initial term of one (1) year.'
    expect(follow(V1, V1.replace(`\n${last}`, ''), 'This Agreement has an initial term of one (1) year.')).toBeNull()
  })

  it('reads a Word file’s run-together text the same as an edited copy of it', () => {
    const word = 'the claim."Excluded Claims" means the following.'
    const edited = 'the claim.\n"Excluded Claims" means the following.'
    expect(follow(word, edited, '"Excluded Claims" means the following.')).toEqual({ unchanged: true, text: '"Excluded Claims" means the following.' })
    // Curly and straight quotes are the same text.
    expect(follow(V1, V1.replace('party’s', "party's"), LIABILITY)).toMatchObject({ unchanged: true })
  })

  it('locates a clause whose stored words differ a little from the document’s', () => {
    const stored = LIABILITY.replace('aggregate', 'total')
    const span = locate(tokensOf(V1), stored)
    expect(span).not.toBeNull()
    expect(spanText(V1, tokensOf(V1), span![0], span![1])).toBe(LIABILITY)
  })

  it('keeps the punctuation at a clause’s ends, and not the next sentence’s quote', () => {
    const t = 'He said (a) the "Fees" are due.Next "Term" means.'
    const toks = tokensOf(t)
    expect(spanText(t, toks, 2, 7)).toBe('(a) the "Fees" are due.')
    const word = 'the claim."Excluded Claims" means'
    const w = tokensOf(word)
    expect(spanText(word, w, 0, 2)).toBe('the claim.')
    expect(spanText(word, w, 2, 5)).toBe('"Excluded Claims" means')
  })

  it('does not locate a clause that isn’t there', () => {
    expect(locate(tokensOf(V1), 'Supplier may assign this Agreement without consent to any affiliate or successor.')).toBeNull()
  })
})
