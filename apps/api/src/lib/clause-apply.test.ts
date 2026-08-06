/**
 * Unit coverage for the clause-matching tiers in clause-apply.
 *
 * These run against the exported helpers rather than the database, because the
 * interesting behaviour is entirely in how the clause text is located: the
 * consequences of getting it wrong (editing the wrong clause, or silently
 * appending an amendment the user never approved) are legal, not technical.
 */
import { describe, it, expect } from 'vitest'
import { escapeHtml, __testing } from './clause-apply.js'

const { spliceInto, findNormalizedSpan } = __testing
const id = (s: string) => s

const CLAUSE = 'Liability is capped at the fees paid in the prior twelve months.'
const PROPOSED = 'Liability is capped at two times the fees paid in the prior twelve months.'

describe('spliceInto — match tiers', () => {
  it('replaces on an exact match', () => {
    const body = `<p>Intro.</p><p>${CLAUSE}</p>`
    const r = spliceInto(body, CLAUSE, PROPOSED, escapeHtml)
    expect(r.mode).toBe('exact')
    expect(r.text).toContain(PROPOSED)
    expect(r.text).not.toContain(CLAUSE)
  })

  it('replaces when the document stores the clause HTML-escaped', () => {
    const clause = 'Fees < $50,000 & costs are excluded.'
    const body = `<p>${escapeHtml(clause)}</p>`
    const r = spliceInto(body, clause, PROPOSED, escapeHtml)
    expect(r.mode).toBe('escaped')
    expect(r.text).toContain(PROPOSED)
  })

  it('replaces across whitespace reflow and &nbsp;', () => {
    const drifted = CLAUSE.replace('capped at the fees', 'capped at\n   the&nbsp;fees')
    const r = spliceInto(`<p>${drifted}</p>`, CLAUSE, PROPOSED, escapeHtml)
    expect(r.mode).toBe('normalized')
    expect(r.text).toBe(`<p>${PROPOSED}</p>`)
  })

  it('replaces across smart quotes and en dashes', () => {
    const clause = "The Company's term is 12-24 months."
    const stored = 'The Company’s term is 12–24 months.'
    const r = spliceInto(`<p>${stored}</p>`, clause, 'Replaced.', escapeHtml)
    expect(r.mode).toBe('normalized')
    expect(r.text).toBe('<p>Replaced.</p>')
  })

  it('reports no match rather than guessing', () => {
    const r = spliceInto('<p>Entirely different text.</p>', CLAUSE, PROPOSED, escapeHtml)
    expect(r.mode).toBe('none')
    expect(r.text).toBe('<p>Entirely different text.</p>')
  })

  it('escapes the replacement so proposed language cannot break the document', () => {
    const body = `<p>${CLAUSE}</p>`
    const risky = 'Fees < $50,000 & costs > $1,000 are excluded.'
    const r = spliceInto(body, CLAUSE, risky, escapeHtml)
    expect(r.text).toContain('&lt; $50,000')
    expect(r.text).toContain('&amp; costs')
    expect(r.text).not.toContain('< $50,000')
  })

  it('treats $& in the replacement as literal text, not a substitution pattern', () => {
    // String.replace would expand `$&` to the matched text. Index splicing
    // must not.
    const body = `<p>${CLAUSE}</p>`
    const r = spliceInto(body, CLAUSE, 'Payment of $& and $100 is due.', id)
    expect(r.text).toBe('<p>Payment of $& and $100 is due.</p>')
  })

  it('leaves plain text unescaped when no escaper is supplied', () => {
    const r = spliceInto(CLAUSE, CLAUSE, 'a < b & c', id)
    expect(r.text).toBe('a < b & c')
  })
})

describe('findNormalizedSpan — ambiguity and bounds', () => {
  it('refuses when the clause appears more than once', () => {
    // Picking the first occurrence would edit an arbitrary clause; a miss is
    // recoverable, a wrong edit to a contract is not.
    const body = `<p>${CLAUSE}</p><p>Something else.</p><p>${CLAUSE}</p>`
    // Force the normalized tier by making both copies drift.
    const drifted = body.replace(/ /g, '&nbsp;')
    expect(findNormalizedSpan(drifted, CLAUSE)).toBeNull()
  })

  it('refuses to match on a fragment too short to be distinctive', () => {
    expect(findNormalizedSpan('<p>the fees are due</p>', 'the fees')).toBeNull()
  })

  it('returns a span that indexes the original string exactly', () => {
    const drifted = CLAUSE.replace('capped at', 'capped&nbsp;&nbsp;at')
    const body = `<p>lead-in</p><p>${drifted}</p>`
    const span = findNormalizedSpan(body, CLAUSE)
    expect(span).not.toBeNull()
    expect(body.slice(span![0], span![1])).toBe(drifted)
  })
})
