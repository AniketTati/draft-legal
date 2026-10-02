/**
 * docs/39 H2 — the variables a draft's text is marked with, read from its HTML.
 */
import { describe, it, expect } from 'vitest'
import { labelOfKey, templateOf, variablesIn } from './draft-variables.js'

describe('variablesIn', () => {
  it('lists each variable once, in order, with its first words — a blank, and one inside other marks', () => {
    const html = '<p><strong><span data-variable="client">Smith &amp; Co</span></strong> pays <span data-variable="fees">1,200</span> to '
      + '<span class="template-variable-unfilled" data-variable="supplier" data-key="supplier">[[supplier]]</span> for '
      + '<span data-variable="client">Smith &amp; Co</span>. <span style="color:red">Not one</span></p>'
    expect(variablesIn(html)).toEqual([
      { key: 'client', text: 'Smith & Co', unfilled: false, count: 2 },
      { key: 'fees', text: '1,200', unfilled: false, count: 1 },
      { key: 'supplier', text: '[[supplier]]', unfilled: true, count: 1 },
    ])
  })

  it('reads the blanks of a draft made before its values were marked', () => {
    expect(variablesIn('<p>From <span class="template-variable-unfilled" data-key="start_date">[[start_date]]</span>.</p>'))
      .toEqual([{ key: 'start_date', text: '[[start_date]]', unfilled: true, count: 1 }])
    expect(variablesIn(null)).toEqual([])
  })
})

describe('names and templates', () => {
  it('names a variable from its key when the template doesn’t', () => {
    expect(labelOfKey('customer_name')).toBe('Customer name')
    expect(labelOfKey('poNumber')).toBe('PO number')
    expect(labelOfKey('vat_id')).toBe('VAT ID')
  })

  it('reads the template a draft came from out of its metadata', () => {
    expect(templateOf({ _template: { id: 't1', name: 'NDA', variables: [] } })).toMatchObject({ id: 't1', name: 'NDA' })
    expect(templateOf({})).toBeNull()
    expect(templateOf(null)).toBeNull()
  })
})
