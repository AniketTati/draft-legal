import { describe, it, expect } from 'vitest'
import { rankFields, cleanedFor, type MatchableField } from './field-match'

const f = (key: string, label: string, type: MatchableField['type'], extra: Partial<MatchableField> = {}): MatchableField =>
  ({ key, label, type, value: null, ...extra })

// The core fields as a contract's Fields panel lists them.
const FIELDS: MatchableField[] = [
  f('effectiveDate', 'Effective date', 'date'),
  f('initialTerm', 'Initial term', 'duration'),
  f('expiryDate', 'Expiry date', 'date'),
  f('autoRenew', 'Auto-renews', 'boolean'),
  f('renewalTerm', 'Renewal term', 'duration'),
  f('nonRenewalNotice', 'Non-renewal notice', 'duration'),
  f('terminationForConvenience', 'Termination for convenience', 'boolean'),
  f('terminationNotice', 'Termination notice', 'duration'),
  f('noticePeriodDays', 'Notice period (unconfirmed)', 'duration', { legacy: true, value: { value: 30, unit: 'days' } }),
  f('executionDate', 'Signed on', 'date'),
  f('counterpartyName', 'Counterparty', 'text'),
  f('counterpartyAddress', 'Counterparty address', 'longtext'),
  f('value', 'Contract value', 'number'),
  f('valueBasis', 'Value is', 'select', { options: ['Total', 'Annual', 'Monthly', 'Other'] }),
  f('currency', 'Currency', 'text'),
  f('paymentTermsDays', 'Payment terms', 'number', { unit: 'days' }),
  f('paymentFrequency', 'Billing', 'select', { options: ['One-time', 'Monthly', 'Quarterly', 'Annually', 'Milestones', 'Other'] }),
  f('governingLaw', 'Governing law', 'text'),
  f('venue', 'Disputes heard in', 'text'),
  f('liabilityCapAmount', 'Liability cap', 'number'),
  f('ipOwnership', 'IP ownership', 'longtext'),
]

const top = (text: string, n = 1) => rankFields(FIELDS, text).slice(0, n).map(m => m.field.key)

describe('rankFields', () => {
  it('reads a notice as a notice, and the one the passage names first', () => {
    expect(top("thirty (30) days' written notice", 2).sort()).toEqual(['nonRenewalNotice', 'terminationNotice'])
    expect(top("either party may terminate this Agreement for convenience on thirty (30) days' written notice")).toEqual(['terminationNotice'])
    // "terminate" doesn't name the renewal term.
    expect(top("either party may terminate this Agreement for convenience on thirty (30) days' written notice", 3)).not.toContain('renewalTerm')
    const [m] = rankFields(FIELDS, "thirty (30) days' written notice")
    expect(m.display).toBe('30 days')
  })

  it('reads money as the contract value, unless the passage is about the cap', () => {
    expect(top('USD 12,500 per month')).toEqual(['value'])
    expect(rankFields(FIELDS, 'USD 12,500 per month')[0].value).toBe(12500)
    expect(top("each party's total liability shall not exceed USD 1,000,000")).toEqual(['liabilityCapAmount'])
    // …even when the cap is empty and the value isn't, and money is never a count of days.
    const filled = FIELDS.map(x => (x.key === 'value' ? { ...x, value: 9000 } : x))
    const ranked = rankFields(filled, 'USD 12,500 per month').filter(m => m.score >= 1).map(m => m.field.key)
    expect(ranked[0]).toBe('value')
    expect(ranked).not.toContain('liabilityCapAmount')
    expect(ranked).not.toContain('paymentTermsDays')
    // The currency is offered too, as its code.
    const currency = rankFields(FIELDS, 'USD 12,500 per month').find(m => m.field.key === 'currency')!
    expect(currency.value).toBe('USD')
  })

  it('reads a date, and the date the passage names', () => {
    expect(top('March 1, 2026', 3).sort()).toEqual(['effectiveDate', 'executionDate', 'expiryDate'])
    expect(top('entered into as of March 1, 2026 (the "Effective Date")')).toEqual(['effectiveDate'])
    expect(rankFields(FIELDS, 'March 1, 2026')[0].value).toBe('2026-03-01')
  })

  it('reads a numbers-only date the way the org writes dates (A11)', () => {
    expect(rankFields(FIELDS, 'effective 03/04/2025')[0].value).toBe('2025-03-04')
    expect(rankFields(FIELDS, 'effective 03/04/2025', { dateOrder: 'DMY' })[0].value).toBe('2025-04-03')
  })

  it('takes the state out of a governing-law sentence', () => {
    const [m] = rankFields(FIELDS, 'This Agreement is governed by the laws of the State of New York.')
    expect(m.field.key).toBe('governingLaw')
    expect(m.value).toBe('New York')
  })

  it('takes the name out of a party description', () => {
    const [m] = rankFields(FIELDS, 'Northwind Analytics LLC, a Delaware limited liability company')
    expect(m.field.key).toBe('counterpartyName')
    expect(m.value).toBe('Northwind Analytics LLC')
  })

  it('offers a yes for a term the passage states, and a no when it denies it', () => {
    const renew = rankFields(FIELDS, 'This Agreement shall automatically renew for successive one-year terms')
    expect(renew.slice(0, 2).map(m => m.field.key).sort()).toEqual(['autoRenew', 'renewalTerm'])
    expect(renew.find(m => m.field.key === 'autoRenew')!.value).toBe(true)
    const no = rankFields(FIELDS, 'This Agreement shall not renew automatically').find(m => m.field.key === 'autoRenew')!
    expect(no.value).toBe(false)
  })

  it('reads payment terms as days, and a billing choice', () => {
    expect(top('payable within forty-five (45) days of invoice')).toEqual(['paymentTermsDays'])
    // Neither an amount ("payable" is not a fee) nor a notice (it says no notice).
    const strong = rankFields(FIELDS, 'payable within thirty (30) days of receipt of a correct invoice').filter(m => m.score >= 1).map(m => m.field.key)
    expect(strong).not.toContain('value')
    expect(strong).not.toContain('nonRenewalNotice')
    expect(rankFields(FIELDS, 'invoiced monthly in arrears').find(m => m.field.key === 'paymentFrequency')?.value).toBe('Monthly')
  })

  it('never offers a legacy field, or a type the passage doesn\'t read as', () => {
    const keys = rankFields(FIELDS, 'thirty (30) days').map(m => m.field.key)
    expect(keys).not.toContain('noticePeriodDays')
    expect(rankFields(FIELDS, 'the Services described in Exhibit A').map(m => m.field.key)).not.toContain('effectiveDate')
  })
})

describe('cleanedFor', () => {
  it('leaves a field that needs the words as they are', () => {
    const ip = FIELDS.find(x => x.key === 'ipOwnership')!
    expect(cleanedFor(ip, '  "All deliverables are works made for hire."  ')).toBe('All deliverables are works made for hire')
  })
  it('reads the courts of a venue clause', () => {
    const venue = FIELDS.find(x => x.key === 'venue')!
    expect(cleanedFor(venue, 'exclusive jurisdiction of the state and federal courts located in Wilmington, Delaware')).toBe('Wilmington')
  })
})
