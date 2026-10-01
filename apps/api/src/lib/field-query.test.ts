/**
 * docs/39 D3 — field conditions as the assistant writes them, read into
 * filters: the field by its name (or key), the operator in words or
 * symbols, the value in the field's own shape.
 */
import { describe, it, expect } from 'vitest'
import { CORE_FIELDS, describeFieldFilter, type CatalogField } from '@clm/types'
import { parseFieldCondition, resolveFieldRef, coerceFilterValue } from './field-query.js'

const catalog: CatalogField[] = [
  ...CORE_FIELDS.filter(f => !f.legacy).map(f => ({ key: f.key, label: f.label, type: f.type, kind: 'core' as const, contractTypes: null, options: f.options, unit: f.unit })),
  { key: 'confidentiality_period', label: 'Confidentiality period', type: 'duration', kind: 'custom', contractTypes: ['SOW'] },
  { key: 'region', label: 'Region', type: 'select', kind: 'custom', contractTypes: null, options: ['EMEA', 'Americas', 'APAC'] },
  { key: 'services', label: 'Services', type: 'multiselect', kind: 'custom', contractTypes: null, options: ['Hosting', 'Support'] },
  { key: 'expense_approver', label: 'Expense approver', type: 'text', kind: 'custom', contractTypes: ['SOW'] },
  { key: 'fee', label: 'Fee', type: 'currency', kind: 'custom', contractTypes: null },
]

const parsed = (text: string) => {
  const r = parseFieldCondition(catalog, text)
  if (!r.ok) throw new Error(r.detail)
  return r.filter
}

describe('reading a field condition', () => {
  it('finds the field by its name as people say it, or by its key', () => {
    expect(parsed('confidentiality period >= 3 years')).toEqual({ key: 'confidentiality_period', op: 'gte', value: { value: 3, unit: 'years' } })
    expect(parsed('Confidentiality Period at least 36 months')).toEqual({ key: 'confidentiality_period', op: 'gte', value: { value: 36, unit: 'months' } })
    expect(parsed('paymentTermsDays > 30')).toEqual({ key: 'paymentTermsDays', op: 'gt', value: 30 })
    expect(parsed('payment terms is less than 45')).toEqual({ key: 'paymentTermsDays', op: 'lt', value: 45 })
    expect(resolveFieldRef(catalog, 'governing law')?.key).toBe('governingLaw')
    expect(resolveFieldRef(catalog, 'jurisdiction')?.key).toBe('governingLaw')
  })

  it('reads choices, yes/no, words, dates and missing values', () => {
    expect(parsed('region in emea, APAC')).toEqual({ key: 'region', op: 'any_of', value: ['EMEA', 'APAC'] })
    expect(parsed('region is Americas')).toEqual({ key: 'region', op: 'any_of', value: ['Americas'] })
    expect(parsed('region is not EMEA')).toEqual({ key: 'region', op: 'is_not', value: 'EMEA' })
    expect(parsed('services includes Support')).toEqual({ key: 'services', op: 'contains', value: 'Support' })
    expect(parsed('auto-renews = yes')).toEqual({ key: 'autoRenew', op: 'is', value: true })
    expect(parsed('governing law in England and Wales, Delaware')).toEqual({ key: 'governingLaw', op: 'any_of', value: ['England and Wales', 'Delaware'] })
    expect(parsed('governing law contains "New York"')).toEqual({ key: 'governingLaw', op: 'contains', value: 'New York' })
    expect(parsed('expiry date between 2026-01-01 and 2026-12-31')).toEqual({ key: 'expiryDate', op: 'between', value: '2026-01-01', to: '2026-12-31' })
    expect(parsed('expiry date before 31 March 2027')).toEqual({ key: 'expiryDate', op: 'lt', value: '2027-03-31' })
    expect(parsed('expense approver is empty')).toEqual({ key: 'expense_approver', op: 'empty' })
    expect(parsed('expense approver has a value')).toEqual({ key: 'expense_approver', op: 'present' })
  })

  it('takes money with its currency, however it is written', () => {
    expect(parsed('contract value >= USD 100,000')).toEqual({ key: 'value', op: 'gte', value: 100000, currency: 'USD' })
    expect(parsed('contract value over €50k')).toEqual({ key: 'value', op: 'gt', value: 50000, currency: 'EUR' })
    expect(parsed('fee between 1000 and 5000')).toEqual({ key: 'fee', op: 'between', value: 1000, to: 5000 })
  })

  it('says what it couldn’t read, with the fields it might have meant', () => {
    const unknown = parseFieldCondition(catalog, 'confidentiality term > 2 years')
    expect(unknown.ok).toBe(false)
    expect(!unknown.ok && unknown.detail).toContain('Confidentiality period (confidentiality_period)')
    const garbled = parseFieldCondition(catalog, 'region roughly EMEA')
    expect(!garbled.ok && garbled.detail).toContain('Couldn\'t read "region roughly EMEA". Fields with a similar name: Region (region)')
  })

  it('reads back as the chip does', () => {
    expect(describeFieldFilter('Confidentiality period', 'duration', parsed('confidentiality period >= 3 years'))).toBe('Confidentiality period ≥ 3 years')
    expect(coerceFilterValue(catalog.find(f => f.key === 'region')!, 'any_of', 'apac')).toEqual(['APAC'])
  })
})
