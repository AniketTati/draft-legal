/**
 * Finding a value's words on the page: quotes and dashes however typed, and —
 * docs/39 A10 — a PDF table's row, which the contract's text writes
 * "cell | cell", found where the page shows the cells side by side.
 */
import { describe, it, expect } from 'vitest'
import { pdfSearchPattern } from './SourceHighlight'

describe('the words of a quote on the PDF', () => {
  it('match however the page spaces them, with its quotes and dashes', () => {
    const p = pdfSearchPattern('the Customer’s “Affiliates” — as defined')!
    expect(p.test('the Customer\'s "Affiliates" - as defined')).toBe(true)
  })

  it('from a table row, match the cells without the separators', () => {
    const p = pdfSearchPattern('Enterprise | USD 120,000 | 500')!
    expect(p.test('Enterprise USD 120,000 500')).toBe(true)
    p.lastIndex = 0
    expect(p.test('EnterpriseUSD 120,000500')).toBe(true)
  })
})
