/**
 * docs/39 A4/B2 — finding quotes and clauses in a version's text.
 */
import { describe, it, expect } from 'vitest'
import { normalizeForSearch, findQuote, findSpan } from './text-span.js'

const DOC = `12. LIMITATION OF LIABILITY.\n12.1 Neither party shall be liable for indirect,\nincidental or consequential damages.\n12.2 Each party’s total liability shall not exceed the fees paid in the twelve (12) months before the claim.\n\n13. INDEMNITY. Vendor shall defend Customer against third-party claims.`

describe('findQuote', () => {
  const t = normalizeForSearch(DOC)
  it('finds a quote across line breaks, case and curly quotes', () => {
    const span = findQuote(t, "each party's TOTAL liability shall not exceed")!
    expect(DOC.slice(span.start, span.end)).toBe('Each party’s total liability shall not exceed')
    const wrapped = findQuote(t, 'liable for indirect, incidental')!
    expect(DOC.slice(wrapped.start, wrapped.end)).toBe('liable for indirect,\nincidental')
  })
  it('searches from an offset and refuses what is not there', () => {
    const first = findQuote(t, 'party')!
    const later = findQuote(t, 'party', first.end)!
    expect(later.start).toBeGreaterThan(first.start)
    expect(findQuote(t, 'force majeure')).toBeNull()
    expect(findQuote(t, 'ab')).toBeNull()
  })
})

describe('findSpan', () => {
  const t = normalizeForSearch(DOC)
  it('cuts a whole clause from its first and last words', () => {
    const span = findSpan(t, '12.1 Neither party shall be liable', 'twelve (12) months before the claim.')!
    const text = DOC.slice(span.start, span.end)
    expect(text.startsWith('12.1 Neither party')).toBe(true)
    expect(text.endsWith('before the claim.')).toBe(true)
    expect(text).toContain('12.2')
  })
  it('refuses an end before the start, or a span too long to be a clause', () => {
    expect(findSpan(t, 'Vendor shall defend', 'Neither party shall be liable')).toBeNull()
    expect(findSpan(t, '12. LIMITATION', 'third-party claims.', { maxLength: 50 })).toBeNull()
  })
})
