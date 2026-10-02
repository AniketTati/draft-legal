/**
 * docs/39 A3 — the contract field registry and the value parser every screen
 * and route share (packages/types/src/fields.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  CORE_FIELDS, coreField, canonicalFieldKey, CORE_FIELD_BY_COLUMN,
  parseNumber, parseDate, parseDuration, parseCurrency, parseFieldValue, ambiguousNumericDate,
  formatFieldValue, subtractDuration, durationInDays, wordsToNumber, termEndDate, annualValue,
} from '@clm/types'

describe('field registry', () => {
  it('has one definition per key and no alias that names two fields', () => {
    const keys = CORE_FIELDS.map(f => f.key)
    expect(new Set(keys).size).toBe(keys.length)
    const seen = new Map<string, string>()
    for (const f of CORE_FIELDS) {
      for (const a of f.aliases ?? []) {
        expect(keys, `alias ${a} shadows a canonical key`).not.toContain(a)
        expect(seen.get(a), `alias ${a} used by ${seen.get(a)} and ${f.key}`).toBeUndefined()
        seen.set(a, f.key)
      }
    }
  })

  it('reads every older spelling as its canonical field', () => {
    expect(canonicalFieldKey('governing_law')).toBe('governingLaw')
    expect(canonicalFieldKey('jurisdiction')).toBe('governingLaw')
    expect(canonicalFieldKey('total_value')).toBe('value')
    expect(canonicalFieldKey('renewalNoticeDays')).toBe('nonRenewalNotice')
    expect(canonicalFieldKey('noticePeriod')).toBe('noticePeriodDays')
    expect(canonicalFieldKey('liabilityCap')).toBe('liabilityCapAmount')
    expect(canonicalFieldKey('someCustomKey')).toBe('someCustomKey')
    expect(coreField('noticePeriodDays')?.legacy).toBe(true)
  })

  it('maps each contract column to exactly one field', () => {
    expect(CORE_FIELD_BY_COLUMN.jurisdiction.key).toBe('governingLaw')
    expect(CORE_FIELD_BY_COLUMN.value.key).toBe('value')
    const columns = CORE_FIELDS.filter(f => f.column).map(f => f.column)
    expect(new Set(columns).size).toBe(columns.length)
  })
})

describe('parseNumber', () => {
  it.each([
    ['thirty (30)', 30],
    ['$1.2M', 1_200_000],
    ['USD 1,250,000', 1_250_000],
    ['two times (2x) the fees', 2],
    ['ninety', 90],
    ['1.5 million', 1_500_000],
    ['one million dollars (US$1,000,000)', 1_000_000],
    [250000, 250000],
  ])('%s → %s', (input, expected) => {
    expect(parseNumber(input as string | number)).toBe(expected)
  })
  it('refuses text that is not a number', () => {
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('not stated')).toBeNull()
    expect(wordsToNumber('one hundred and twenty')).toBe(120)
  })
})

describe('parseDate', () => {
  it.each([
    ['2025-01-05', '2025-01-05'],
    ['January 5, 2025', '2025-01-05'],
    ['5th day of January, 2025', '2025-01-05'],
    ['5 Jan 2025', '2025-01-05'],
    ['Jan. 5 2025', '2025-01-05'],
    ['2025/1/5', '2025-01-05'],
  ])('%s → %s', (input, iso) => {
    expect(parseDate(input)?.iso).toBe(iso)
  })
  it('reads an all-numeric date by the date order and says when it could swap', () => {
    expect(parseDate('03/04/2025')).toEqual({ iso: '2025-03-04', ambiguous: expect.any(String) })
    expect(parseDate('03/04/2025', 'DMY')?.iso).toBe('2025-04-03')
    // Only one reading is a real date: no question to ask.
    expect(parseDate('31/01/2025')).toEqual({ iso: '2025-01-31' })
    expect(parseDate('01/31/2025', 'DMY')).toEqual({ iso: '2025-01-31' })
  })
  it('refuses an impossible or partial date rather than inventing one', () => {
    expect(parseDate('February 30, 2025')).toBeNull()
    expect(parseDate('January 2025')).toBeNull()
  })
})

describe('parseDuration and parseCurrency', () => {
  it.each([
    ['thirty (30) days', { value: 30, unit: 'days' }],
    ['90 calendar days', { value: 90, unit: 'days' }],
    ['3 months', { value: 3, unit: 'months' }],
    ['one (1) year', { value: 1, unit: 'years' }],
    ['12-month', { value: 12, unit: 'months' }],
    ['sixty (60) days’ prior written notice', { value: 60, unit: 'days' }],
    ['shall renew for successive one-year terms', { value: 1, unit: 'years' }],
    ['for a further period of one hundred twenty days', { value: 120, unit: 'days' }],
  ])('%s', (input, expected) => {
    expect(parseDuration(input)).toEqual(expected)
  })
  it('finds no length of time in words without a number', () => {
    expect(parseDuration('for the days that follow')).toBeNull()
  })
  it('reads a bare number as days', () => {
    expect(parseDuration(45)).toEqual({ value: 45, unit: 'days' })
  })
  it.each([
    ['$1.2M', { amount: 1_200_000, currency: 'USD' }],
    ['EUR 50,000', { amount: 50_000, currency: 'EUR' }],
    ['£500', { amount: 500, currency: 'GBP' }],
    ['12,500 GBP', { amount: 12_500, currency: 'GBP' }],
  ])('%s', (input, expected) => {
    expect(parseCurrency(input)).toEqual(expected)
  })
})

describe('parseFieldValue', () => {
  it('clears on empty input', () => {
    expect(parseFieldValue('date', '  ')).toEqual({ ok: true, value: null, display: '—' })
  })
  it('explains what it expected when it cannot read the input', () => {
    const r = parseFieldValue('date', 'next spring')
    expect(r.ok).toBe(false)
  })
  it('reads yes/no, options and parties', () => {
    expect(parseFieldValue('boolean', 'Yes')).toMatchObject({ ok: true, value: true })
    expect(parseFieldValue('select', 'auto', { options: ['Auto', 'Optional', 'None'] })).toMatchObject({ ok: true, value: 'Auto' })
    expect(parseFieldValue('select', 'maybe', { options: ['Auto', 'None'] }).ok).toBe(false)
    expect(parseFieldValue('multiselect', 'eu, US', { options: ['EU', 'US', 'UK'] })).toMatchObject({ ok: true, value: ['EU', 'US'] })
    expect(parseFieldValue('parties', 'Acme Inc (Vendor); Demo Org (Client)')).toMatchObject({
      ok: true, value: [{ name: 'Acme Inc', role: 'Vendor' }, { name: 'Demo Org', role: 'Client' }],
    })
  })
  it('keeps a structured duration or amount as given', () => {
    expect(parseFieldValue('duration', { value: 2, unit: 'Years' })).toMatchObject({ ok: true, value: { value: 2, unit: 'years' }, display: '2 years' })
    expect(parseFieldValue('currency', { amount: 10, currency: 'eur' })).toMatchObject({ ok: true, value: { amount: 10, currency: 'EUR' } })
  })
})

describe('formatFieldValue', () => {
  it('reads as people write it', () => {
    expect(formatFieldValue('duration', { value: 1, unit: 'years' })).toBe('1 year')
    expect(formatFieldValue('duration', { value: 90, unit: 'days' })).toBe('90 days')
    expect(formatFieldValue('currency', { amount: 1_200_000, currency: 'USD' })).toBe('USD 1,200,000')
    expect(formatFieldValue('date', '2025-01-05')).toBe('Jan 5, 2025')
    expect(formatFieldValue('boolean', false)).toBe('No')
    expect(formatFieldValue('text', null)).toBe('—')
  })
})

describe('calendar maths for notice deadlines', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
  it('counts months and years by the calendar, clamping to month end', () => {
    expect(subtractDuration(d('2026-03-31'), { value: 1, unit: 'months' }).toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(subtractDuration(d('2026-12-31'), { value: 3, unit: 'months' }).toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(subtractDuration(d('2028-02-29'), { value: 1, unit: 'years' }).toISOString().slice(0, 10)).toBe('2027-02-28')
    expect(subtractDuration(d('2026-12-31'), { value: 90, unit: 'days' }).toISOString().slice(0, 10)).toBe('2026-10-02')
  })
  it('gives a duration in days, exactly when it knows the end date', () => {
    expect(durationInDays({ value: 3, unit: 'months' }, d('2026-12-31'))).toBe(92)
    expect(durationInDays({ value: 2, unit: 'weeks' })).toBe(14)
  })
})

describe('term end and yearly value (docs/39 F2/F3)', () => {
  it('ends a term the day before its anniversary', () => {
    expect(termEndDate('2025-01-15', { value: 12, unit: 'months' })).toBe('2026-01-14')
    expect(termEndDate('2025-07-01', { value: 24, unit: 'months' })).toBe('2027-06-30')
    expect(termEndDate('2025-03-15', { value: 1, unit: 'years' })).toBe('2026-03-14')
    expect(termEndDate('2025-03-15', { value: 0, unit: 'years' })).toBeNull()
  })
  it('turns a value into a yearly amount only when it knows how', () => {
    expect(annualValue(96_000, 'Total', { value: 24, unit: 'months' })).toBe(48_000)
    expect(annualValue(15_000, 'Monthly')).toBe(180_000)
    expect(annualValue(100, 'Annual')).toBe(100)
    // A four-month SOW's total is not scaled up to a year.
    expect(annualValue(85_000, 'Total', { value: 4, unit: 'months' })).toBe(85_000)
    expect(annualValue(96_000, 'Total')).toBeNull()
    expect(annualValue(96_000, null)).toBeNull()
  })
})

describe('ambiguousNumericDate (docs/39 A11)', () => {
  it('gives both readings of a date that could go either way', () => {
    expect(ambiguousNumericDate('dated as of 03/04/2025 by the parties')).toEqual({ written: '03/04/2025', monthFirst: '2025-03-04', dayFirst: '2025-04-03' })
    expect(ambiguousNumericDate('on 1.2.25')).toEqual({ written: '1.2.25', monthFirst: '2025-01-02', dayFirst: '2025-02-01' })
  })
  it('says nothing of a date that reads one way', () => {
    expect(ambiguousNumericDate('31/01/2025')).toBeNull()
    expect(ambiguousNumericDate('03/03/2025')).toBeNull()
    expect(ambiguousNumericDate('2025-04-03')).toBeNull()
    expect(ambiguousNumericDate('the first day of April, 2025')).toBeNull()
  })
})

describe('a value of the wrong shape (a model can return anything)', () => {
  it('reads as no value of the type, never a crash', () => {
    const odd = { quote: 'thirty days' } as unknown as string
    expect(parseNumber(odd)).toBeNull()
    expect(parseDuration(odd)).toBeNull()
    expect(parseCurrency(odd)).toBeNull()
    expect(parseFieldValue('number', { quote: 'x' }).ok).toBe(false)
    expect(parseFieldValue('duration', ['30 days']).ok).toBe(false)
  })
})
