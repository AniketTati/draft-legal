/**
 * docs/39 H1 — a template's own placeholders found and made variables: named,
 * typed, matched to a field, and rewritten as {{key}} only where they are.
 */
import { describe, it, expect } from 'vitest'
import { CORE_FIELDS, applyTemplateVariables, labelFromPlaceholder, suggestTemplateVariables, templateTokens, variableTypeFor, type CatalogField } from '@clm/types'

const CATALOG: CatalogField[] = CORE_FIELDS.filter(f => !f.legacy).map(f => ({ key: f.key, label: f.label, type: f.type, kind: 'core' as const, contractTypes: null }))

const NDA = [
  '<p>This Agreement is made on [Effective Date] between <strong>[Customer Name]</strong> and Acme Ltd.</p>',
  '<p>[CUSTOMER NAME] shall keep the information confidential for [Number of Years] years. [Reserved]</p>',
  '<p>Governing law: ________. Fees: ________</p>',
  '<p>By: ________ Name: ________ Title: ________</p>',
  '<p>Merge fields: «Supplier Contact» and &lt;&lt;Account Manager&gt;&gt;; typed ones: {{ po_number }}, {{customerName}}, {{notice_days}}.</p>',
]

describe('a template’s placeholders', () => {
  it('are each suggested once, named, typed and matched to a field — signature blanks and [Reserved] left alone', () => {
    const s = suggestTemplateVariables(NDA, [{ key: 'notice_days', label: 'Notice days' }], CATALOG)
    const by = Object.fromEntries(s.map(v => [v.key, v]))
    expect(Object.keys(by).sort()).toEqual(['account_manager', 'customer_name', 'effective_date', 'fees', 'governing_law', 'number_of_years', 'po_number', 'supplier_contact'].sort())
    expect(by.customer_name).toMatchObject({ label: 'Customer name', type: 'text', count: 3, token: false, listed: false })
    expect(by.customer_name.matches.sort()).toEqual(['[CUSTOMER NAME]', '[Customer Name]', '{{customerName}}'].sort())
    expect(by.effective_date).toMatchObject({ type: 'date', field: 'effectiveDate' })
    expect(by.number_of_years.type).toBe('number')
    expect(by.governing_law).toMatchObject({ matches: ['________'], field: 'governingLaw' })
    expect(by.fees.type).toBe('number')
    expect(by.account_manager.matches).toEqual(['&lt;&lt;Account Manager&gt;&gt;'])
    // A spaced token is rewritten; a listed one written as the engine reads it isn't suggested at all.
    expect(by.po_number).toMatchObject({ matches: ['{{ po_number }}'], token: false })
    expect(by.notice_days).toBeUndefined()
  })

  it('named like a variable the list has are rewritten to it, not added', () => {
    const [s] = suggestTemplateVariables(['<p>Signed for [Customer Name].</p>'], [{ key: 'client', label: 'Customer name' }])
    expect(s).toMatchObject({ key: 'client', listed: true })
  })

  it('are rewritten as {{key}} between tags only, and a blank only where its label is that variable’s', () => {
    const picks = suggestTemplateVariables(NDA, [], CATALOG).filter(v => ['customer_name', 'governing_law', 'po_number'].includes(v.key))
    const html = NDA.map(h => applyTemplateVariables(h, picks))
    expect(html[0]).toBe('<p>This Agreement is made on [Effective Date] between <strong>{{customer_name}}</strong> and Acme Ltd.</p>')
    expect(html[1]).toContain('{{customer_name}} shall keep')
    // Governing law's blank is rewritten; the Fees blank beside it isn't.
    expect(html[2]).toBe('<p>Governing law: {{governing_law}}. Fees: ________</p>')
    expect(html[4]).toContain('{{po_number}}, {{customer_name}}, {{notice_days}}')
    expect(applyTemplateVariables('<a title="[Customer Name]">x</a>', picks)).toBe('<a title="[Customer Name]">x</a>')
  })
})

describe('names and types', () => {
  it('read from the placeholder’s words', () => {
    expect(labelFromPlaceholder('insert the Customer’s registered address')).toBe('Customer’s registered address')
    expect(labelFromPlaceholder('VAT NUMBER')).toBe('VAT number')
    expect(labelFromPlaceholder('po number')).toBe('PO number')
    expect(labelFromPlaceholder('Effective Date:')).toBe('Effective date')
    expect(variableTypeFor('Commencement date')).toBe('date')
    expect(variableTypeFor('Monthly fee')).toBe('number')
    expect(variableTypeFor('Supplier address')).toBe('text')
  })

  it('and the tokens a template uses are listed once each', () => {
    expect(templateTokens(['<p>{{a}} and {{ b }}</p>', '<p>{{a}}</p>'])).toEqual(['a', 'b'])
  })
})
