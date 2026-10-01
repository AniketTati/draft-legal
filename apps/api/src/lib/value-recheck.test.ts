/**
 * docs/39 G2 — the words that replaced a value's quote, and the value in them.
 */
import { describe, it, expect } from 'vitest'
import { readValueFrom, replacedPassage } from './value-recheck.js'

const OLD = 'Section 5. Payment. Customer shall pay all undisputed invoices within thirty (30) days of the invoice date. Late payments bear interest.'

describe('replacedPassage', () => {
  it('finds what took the old words’ place by the words either side', () => {
    const now = OLD.replace('within thirty (30) days', 'within sixty (60) days')
    expect(replacedPassage(OLD, now, 'within thirty (30) days')).toBe('within sixty (60) days')
  })

  it('gives up when the passage was rewritten wholesale, or the quote was never there', () => {
    expect(replacedPassage(OLD, 'An entirely new agreement.', 'within thirty (30) days')).toBeNull()
    expect(replacedPassage(OLD, OLD, 'net ninety days')).toBeNull()
  })
})

describe('readValueFrom', () => {
  it('reads a number, a length of time, an amount, a percentage and a date', () => {
    expect(readValueFrom('number', 'within sixty (60) days', null)).toBe(60)
    expect(readValueFrom('number', 'within forty-five days', null)).toBe(45)
    expect(readValueFrom('duration', 'for a period of twenty-four (24) months', null)).toEqual({ value: 24, unit: 'months' })
    expect(readValueFrom('duration', 'no less than 90 days', null)).toEqual({ value: 90, unit: 'days' })
    expect(readValueFrom('currency', 'fees of USD 150,000 per year', null)).toEqual({ amount: 150000, currency: 'USD' })
    expect(readValueFrom('percentage', 'interest at 1.5% per month', null)).toBe(1.5)
    expect(readValueFrom('date', 'until December 31, 2028', null)).toBe('2028-12-31')
  })

  it('reads a word value from where the old one sat in its quote', () => {
    const before = { value: 'New York', quote: 'governed by the laws of the State of New York' }
    expect(readValueFrom('text', 'governed by the laws of the State of California', before)).toBe('California')
  })

  it('keeps a word value the new words still hold, however they were reworded around it', () => {
    const before = { value: 'New York', quote: 'governed by the laws of the State of New York' }
    expect(readValueFrom('text', 'governed by and construed under the laws of the State of New York', before)).toBe('New York')
  })

  it('reads nothing it can’t: a yes/no, a choice, a passage with no value of the type', () => {
    expect(readValueFrom('boolean', 'shall automatically renew', null)).toBeUndefined()
    expect(readValueFrom('number', 'within a reasonable time', null)).toBeUndefined()
    expect(readValueFrom('date', 'on the effective date', null)).toBeUndefined()
  })
})
