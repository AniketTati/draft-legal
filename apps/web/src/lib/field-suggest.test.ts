import { describe, it, expect } from 'vitest'
import { inferFieldType, labelFromContext } from './field-suggest'

describe('inferFieldType (docs/39 C3)', () => {
  it.each([
    ['PO-7781', 'text'],
    ['thirty (30) days', 'duration'],
    ['USD 12,500', 'currency'],
    ['15%', 'percentage'],
    ['March 1, 2026', 'date'],
    ['250,000', 'number'],
    ['Yes', 'boolean'],
    ['The Supplier shall maintain insurance of not less than the amounts set out in Schedule 4 at all times during the Term.', 'longtext'],
  ])('%s is %s', (text, type) => {
    expect(inferFieldType(text)).toBe(type)
  })
})

describe('labelFromContext', () => {
  it('reads a defined term after the words', () => {
    expect(labelFromContext('The product will launch on ', ' (the "Launch Date"), unless')).toBe('Launch Date')
    expect(labelFromContext('', ', (hereinafter “Service Credit”) payable')).toBe('Service Credit')
  })
  it('reads a label before the words', () => {
    expect(labelFromContext('Order details.\nPurchase Order No.: ', '')).toBe('Purchase Order No.')
    expect(labelFromContext('Account number - ', '')).toBe('Account number')
  })
  it('names nothing when nothing reads as a name', () => {
    expect(labelFromContext('The parties agree that the fees shall be paid within ', ' of invoice.')).toBe('')
    expect(labelFromContext('This is a long sentence that ends with a colon and is not a label at all: ', '')).toBe('')
  })
})
