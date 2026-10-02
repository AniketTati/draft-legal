/**
 * docs/41 browser QA — values as a document writes them: "The Contract value
 * is amended to read: 300000." and a renewal letter "dated 2025-03-01".
 */
import { describe, it, expect } from 'vitest'
import { parseCurrency, parseDate } from '@clm/types'
import { documentDate, documentMoney, documentValue, documentVariables } from './document-values.js'
import { generateDocument, type TemplateWithSections } from './template-engine.js'
import { termChangeAsWritten, changeSentence } from './amendments.js'

describe('money in a document', () => {
  it('has its currency and grouping', () => {
    expect(documentMoney('300000', 'USD')).toBe('USD 300,000')
    expect(documentMoney(1250.5, 'eur')).toBe('EUR 1,250.50')
    expect(documentMoney('1,000,000', null)).toBe('USD 1,000,000')
    expect(documentMoney('EUR 5,000', 'USD')).toBe('EUR 5,000')
    expect(documentMoney('five thousand dollars', 'USD')).toBe('five thousand dollars')
  })
  it('reads back as the amount it was', () => {
    expect(parseCurrency(documentMoney('300000', 'GBP'))).toMatchObject({ amount: 300000, currency: 'GBP' })
  })
})

describe('dates in a document', () => {
  it('are written as the org writes them, and read back as the same day', () => {
    expect(documentDate('2025-03-01')).toBe('March 1, 2025')
    expect(documentDate('2025-03-01', 'DMY')).toBe('1 March 2025')
    expect(documentDate('2025-03-01T00:00:00.000Z')).toBe('March 1, 2025')
    expect(documentDate('next Tuesday')).toBe('next Tuesday')
    expect(parseDate(documentDate('2025-03-01', 'DMY'), 'DMY')?.iso).toBe('2025-03-01')
    expect(parseDate(documentDate('2025-03-01'))?.iso).toBe('2025-03-01')
  })
})

describe('a value by what it is', () => {
  const style = { dateOrder: 'MDY' as const, currency: 'EUR' }
  it('a core field by its type, a template variable by its type or its name', () => {
    expect(documentValue('value', '300000', style)).toBe('EUR 300,000')
    expect(documentValue('expiryDate', '2027-12-31', style)).toBe('December 31, 2027')
    expect(documentValue('agreementDate', '2025-03-01', style, 'date')).toBe('March 1, 2025')
    expect(documentValue('feeAmount', '5000', style, 'number')).toBe('EUR 5,000')
    expect(documentValue('noticeDays', '90', style, 'number')).toBe('90')
    expect(documentValue('purpose', 'evaluating a pilot', style, 'text')).toBe('evaluating a pilot')
    // No currency known (a draft from a template): the amount isn't given one.
    expect(documentValue('feeAmount', '5000', { dateOrder: 'DMY' }, 'number')).toBe('5000')
    expect(documentValue('effectiveDate', '2026-06-01', { dateOrder: 'DMY' })).toBe('1 June 2026')
  })
  it('keeps the variables themselves as stored', () => {
    const vars = { agreementDate: '2025-03-01', renewalTerm: '12 months' }
    expect(documentVariables(vars, [{ key: 'agreementDate', type: 'date' }], style)).toEqual({ agreementDate: 'March 1, 2025', renewalTerm: '12 months' })
    expect(vars.agreementDate).toBe('2025-03-01')
  })
})

describe('where values are written into documents', () => {
  it('a template, given the style', () => {
    const template = {
      id: 't1', version: 1, variables: [{ key: 'agreementDate', type: 'date' }],
      sections: [{ id: 's1', title: 'Renewal', sortOrder: 0, content: '<p>dated {{agreementDate}}</p>', clauseRefs: [], conditionalLogic: null }],
    } as unknown as TemplateWithSections
    expect(generateDocument({ template, variables: { agreementDate: '2025-03-01' }, style: { dateOrder: 'DMY' } }).html).toContain('dated <span data-variable="agreementDate">1 March 2025</span>')
    expect(generateDocument({ template, variables: { agreementDate: '2025-03-01' } }).html).toContain('2025-03-01')
  })
  it("an amendment's term change", () => {
    const ch = termChangeAsWritten({ kind: 'term' as const, key: 'value', label: 'Contract value', from: '250000', to: '300000', source: 'user' as const }, { dateOrder: 'MDY', currency: 'USD' })
    expect(changeSentence(ch)).toBe('The Contract value is amended to read: USD 300,000.')
    expect(ch.from).toBe('USD 250,000')
  })
})
