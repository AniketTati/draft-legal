/**
 * docs/41 Part 17 — field mappings and the ownership rule: Salesforce values
 * are parsed for their draftLegal field, outbound values take Salesforce's
 * shapes, and once a contract is frozen a changed value is a conflict, never
 * a write.
 */
import { describe, it, expect } from 'vitest'
import {
  applyInboundMapping, applyOutboundMapping, planInboundChange, isFrozen, sameValue, describeConflict,
  mappingsForType, isValidDlField, payloadHash, readPath, toSalesforceValue, type FieldMapping,
} from './mapping.js'

const m = (over: Partial<FieldMapping>): FieldMapping => ({ externalObject: 'Opportunity', externalField: 'Amount', dlField: 'value', direction: 'inbound', ...over })

describe('what a mapping may point at', () => {
  it('takes registry keys, request fields and template variables, nothing else', () => {
    expect(isValidDlField('value')).toBe(true)
    expect(isValidDlField('governingLaw')).toBe(true)
    expect(isValidDlField('title')).toBe(true)
    expect(isValidDlField('var:governing_state')).toBe(true)
    // An older spelling is not a target: the canonical key is.
    expect(isValidDlField('governing_law')).toBe(false)
    // A legacy field is kept for reading, never mapped into.
    expect(isValidDlField('noticePeriodDays')).toBe(false)
    expect(isValidDlField('var:1bad')).toBe(false)
    expect(isValidDlField('ownerId')).toBe(false)
  })
})

describe('inbound mapping', () => {
  const mappings = [
    m({}),
    m({ externalField: 'CloseDate', dlField: 'effectiveDate' }),
    m({ externalObject: 'Account', externalField: 'Name', dlField: 'counterpartyName', locked: true }),
    m({ externalField: 'Account.BillingCountry', dlField: 'var:country' }),
    m({ externalField: 'Payment_Days__c', dlField: 'paymentTermsDays' }),
    m({ externalField: 'Description', dlField: 'description', direction: 'outbound' }),
  ]

  it('reads each mapped field, parses it for its type and keeps the locks', () => {
    const r = applyInboundMapping(mappings, {
      Opportunity: { Id: '006000000000001AAA', Amount: 45000, CloseDate: '2026-11-30', Account: { BillingCountry: 'DE' }, Payment_Days__c: 'net 30', Description: 'ignored' },
      Account: { Name: 'Acme GmbH' },
    })
    const byField = Object.fromEntries(r.values.map(v => [v.dlField, v]))
    expect(byField.value.value).toBe(45000)
    expect(byField.effectiveDate.value).toBe('2026-11-30')
    expect(byField.counterpartyName).toMatchObject({ value: 'Acme GmbH', locked: true })
    expect(byField['var:country'].value).toBe('DE')
    // An outbound-only mapping never reads from Salesforce.
    expect(byField.description).toBeUndefined()
    expect(r.issues).toEqual([])
  })

  it('reports a value that does not parse rather than guessing', () => {
    const r = applyInboundMapping([m({ externalField: 'CloseDate', dlField: 'effectiveDate' })], { Opportunity: { CloseDate: 'next quarter' } })
    expect(r.values).toEqual([])
    expect(r.issues).toEqual([expect.objectContaining({ dlField: 'effectiveDate', externalField: 'Opportunity.CloseDate' })])
  })

  it('skips a field the record did not send, and keeps an empty one as empty', () => {
    const r = applyInboundMapping([m({}), m({ externalField: 'CloseDate', dlField: 'effectiveDate' })], { Opportunity: { Amount: null } })
    expect(r.values).toEqual([expect.objectContaining({ dlField: 'value', value: null })])
  })

  it('a type-specific mapping wins over the all-types one for the same field', () => {
    const all = [m({}), m({ contractType: 'MSA', externalField: 'Annual_Value__c' }), m({ contractType: 'NDA', externalField: 'X', dlField: 'title' })]
    const forMsa = mappingsForType(all, 'MSA')
    expect(forMsa.map(x => x.externalField)).toEqual(['Annual_Value__c'])
    expect(mappingsForType(all, 'SOW').map(x => x.externalField)).toEqual(['Amount'])
  })

  it('follows relationship paths', () => {
    expect(readPath({ Account: { Owner: { Email: 'a@b.co' } } }, 'Account.Owner.Email')).toBe('a@b.co')
    expect(readPath({ Account: null }, 'Account.Name')).toBeUndefined()
  })
})

describe('outbound mapping', () => {
  it('writes only outbound and both-ways fields, in Salesforce shapes', () => {
    const out = applyOutboundMapping([
      m({ externalObject: 'Opportunity', externalField: 'Amount', dlField: 'value', direction: 'both' }),
      m({ externalObject: 'DL_Contract__c', externalField: 'Renewal_Notice_Days__c', dlField: 'nonRenewalNotice', direction: 'outbound' }),
      m({ externalObject: 'DL_Contract__c', externalField: 'Law__c', dlField: 'governingLaw', direction: 'inbound' }),
    ], { value: 45000, nonRenewalNotice: { value: 2, unit: 'months' }, governingLaw: 'New York' })
    expect(out.Opportunity).toEqual({ Amount: 45000 })
    expect(out.DL_Contract__c.Renewal_Notice_Days__c).toBeGreaterThanOrEqual(59)
    expect(out.DL_Contract__c.Law__c).toBeUndefined()
  })

  it('formats dates, currency and parties', () => {
    expect(toSalesforceValue('date', new Date('2026-01-15T10:00:00Z'))).toBe('2026-01-15')
    expect(toSalesforceValue('date', '2026-01-15T00:00:00.000Z')).toBe('2026-01-15')
    expect(toSalesforceValue('currency', { amount: 12, currency: 'EUR' })).toBe(12)
    expect(toSalesforceValue('parties', [{ name: 'Acme' }, { name: 'Us Inc' }])).toBe('Acme; Us Inc')
    expect(toSalesforceValue('number', null)).toBeNull()
  })
})

describe('field ownership: frozen at signing', () => {
  const incoming = [
    { dlField: 'value', value: 45000, locked: false, externalObject: 'Opportunity', externalField: 'Amount' },
    { dlField: 'effectiveDate', value: '2026-11-30', locked: false, externalObject: 'Opportunity', externalField: 'CloseDate' },
  ]

  it('writes changed values before signing', () => {
    const plan = planInboundChange({ frozen: false, incoming, current: { value: 40000, effectiveDate: '2026-11-30' } })
    expect(plan.write.map(v => v.dlField)).toEqual(['value'])
    expect(plan.unchanged).toEqual(['effectiveDate'])
    expect(plan.conflicts).toEqual([])
  })

  it('holds a change as a conflict once the contract is out for signature or signed', () => {
    const plan = planInboundChange({ frozen: true, incoming, current: { value: 40000, effectiveDate: '2026-11-30' } })
    expect(plan.write).toEqual([])
    expect(plan.conflicts).toEqual([{ dlField: 'value', externalObject: 'Opportunity', externalField: 'Amount', current: 40000, incoming: 45000 }])
    expect(describeConflict(plan.conflicts[0])).toBe('Salesforce changed Contract value: 40,000 → 45,000')
  })

  it('freezes on signature and after, not before; a stored stage decides when there is one', () => {
    for (const s of ['PENDING_SIGNATURE', 'EXECUTED', 'EXPIRED', 'TERMINATED']) expect(isFrozen({ status: s })).toBe(true)
    for (const s of ['DRAFT', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL', 'APPROVED']) expect(isFrozen({ status: s })).toBe(false)
    expect(isFrozen({ status: 'APPROVED', stage: 'Sign' })).toBe(true)
    expect(isFrozen({ status: 'EXECUTED', stage: 'Review' })).toBe(false)
  })

  it('compares stored values as values: a decimal string, a date-time and a day are the same', () => {
    expect(sameValue('40000.00', 40000)).toBe(true)
    expect(sameValue(new Date('2026-11-30T00:00:00Z'), '2026-11-30')).toBe(true)
    expect(sameValue({ value: 30, unit: 'days' }, { unit: 'days', value: 30 })).toBe(true)
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue(40000, 45000)).toBe(false)
  })
})

describe('payload hash', () => {
  it('is the same for the same content in any key order, and differs otherwise', () => {
    expect(payloadHash({ a: 1, b: [1, 2] })).toBe(payloadHash({ b: [1, 2], a: 1 }))
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }))
  })
})
