import { describe, it, expect } from 'vitest'
import { fieldsFromVariables, fieldForVariable } from './template-fields.js'
import { fieldDefsFor } from './field-store.js'

const defs = fieldDefsFor('MSA', [
  { fieldKey: 'po_number', fieldLabel: 'PO number', fieldType: 'text', options: null, helpText: null, required: false },
])

describe('template variables as fields (docs/39 H3)', () => {
  it('names a field by its own key, a registry spelling, or a common template name', () => {
    expect(fieldForVariable(defs, 'effectiveDate')?.key).toBe('effectiveDate')
    expect(fieldForVariable(defs, 'effective_date')?.key).toBe('effectiveDate')
    expect(fieldForVariable(defs, 'Governing Law')?.key).toBe('governingLaw')
    expect(fieldForVariable(defs, 'total_fees')?.key).toBe('value')
    expect(fieldForVariable(defs, 'po_number')?.key).toBe('po_number')
    expect(fieldForVariable(defs, 'our_company')).toBeUndefined()
  })

  it('keeps the values that read as their field, typed', () => {
    const values = fieldsFromVariables({
      effective_date: 'March 1, 2025', term_months: 12, fees: '$120,000', governing_law: 'New York',
      auto_renew: 'yes', po_number: 'PO-77', our_company: 'Us Inc', end_date: 'sometime next year', venue: '',
    }, defs)
    expect(Object.fromEntries(values.map(v => [v.key, v.raw]))).toEqual({
      effectiveDate: '2025-03-01', initialTerm: { value: 12, unit: 'months' }, value: 120000,
      governingLaw: 'New York', autoRenew: true, po_number: 'PO-77',
    })
    expect(values.every(v => v.source === 'variable')).toBe(true)
  })

  it('reads a numbers-only date the way the org writes dates', () => {
    expect(fieldsFromVariables({ effective_date: '03/04/2025' }, defs, { dateOrder: 'DMY' })[0].raw).toBe('2025-04-03')
  })

  it('fills the field the template names for a variable first, and none where it names none (docs/39 H1/H2)', () => {
    const named = { start: 'effectiveDate', governing_law: null }
    expect(fieldForVariable(defs, 'start', named)?.key).toBe('effectiveDate')
    expect(fieldForVariable(defs, 'governing_law', named)).toBeUndefined()
    // A variable the template names nothing for is still matched by its name.
    expect(fieldForVariable(defs, 'po_number', named)?.key).toBe('po_number')
    const values = fieldsFromVariables({ start: '2025-06-01', governing_law: 'Delaware', po_number: 'PO-9' }, defs, { named })
    expect(Object.fromEntries(values.map(v => [v.key, v.raw]))).toEqual({ effectiveDate: '2025-06-01', po_number: 'PO-9' })
  })
})
