/**
 * docs/39 I1 — the field scorers the extraction eval grades with
 * (scripts/evals/langfuse/scorers.mjs). A scorer that says "matched" when the
 * value is wrong would report accuracy nobody has; one that says "wrong" for
 * "3 months" vs { value: 3, unit: 'months' } would hide real accuracy. Both
 * are checked here without Langfuse or a model.
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error — a plain .mjs module with no type declarations
import { sameFieldValue, runScorer } from '../../../../scripts/evals/langfuse/scorers.mjs'

const same = (want: unknown, got: unknown) => (sameFieldValue as (w: unknown, g: unknown) => { ok: boolean })(want, got).ok

describe('sameFieldValue', () => {
  it('compares dates by day', () => {
    expect(same('2025-02-01', '2025-02-01T00:00:00.000Z')).toBe(true)
    expect(same('2025-02-01', '2025-01-02')).toBe(false)
  })
  it('compares numbers within half a percent, however written', () => {
    expect(same(1_800_000, '18,00,000')).toBe(true)
    expect(same(250000, '£250,000')).toBe(true)
    expect(same(1_000_000, 'one million dollars ($1,000,000)')).toBe(true)
    expect(same(96000, 48000)).toBe(false)
  })
  it('compares notice periods by amount and unit', () => {
    expect(same({ value: 3, unit: 'months' }, '3 months')).toBe(true)
    expect(same({ value: 3, unit: 'months' }, { value: 3, unit: 'months' })).toBe(true)
    expect(same({ value: 90, unit: 'days' }, 'ninety (90) days')).toBe(true)
    expect(same({ value: 3, unit: 'months' }, '90 days')).toBe(false)
    expect(same({ value: 6, unit: 'weeks' }, '6 weeks')).toBe(true)
  })
  it('holds the model to a labelled absence', () => {
    expect(same(null, null)).toBe(true)
    expect(same(null, '')).toBe(true)
    expect(same(null, { value: 30, unit: 'days' })).toBe(false)
    expect(same({ value: 30, unit: 'days' }, null)).toBe(false)
  })
  it('reads booleans and names', () => {
    expect(same(true, 'yes')).toBe(true)
    expect(same(false, true)).toBe(false)
    expect(same('Delaware', 'State of Delaware')).toBe(true)
    expect(same('England and Wales', 'the laws of England and Wales')).toBe(true)
    expect(same('Delaware', 'New York')).toBe(false)
  })
})

describe('fields_match and field_ok', () => {
  const expectedOutput = { keyTerms: { effectiveDate: '2025-02-01', nonRenewalNotice: { value: 3, unit: 'months' }, value: null } }
  it('scores the share of labelled fields the extraction got right', async () => {
    const output = { keyTerms: { effectiveDate: '2025-01-02', nonRenewalNotice: '3 months', value: null } }
    const r = await (runScorer as (s: string, c: unknown) => Promise<{ value: number; comment: string }>)('fields_match:*', { output, expectedOutput })
    expect(r.value).toBeCloseTo(2 / 3)
    expect(r.comment).toContain('effectiveDate')
  })
  it('gives one field its own verdict', async () => {
    const run = runScorer as (s: string, c: unknown) => Promise<{ name: string; value: number }>
    expect(await run('field_ok:nonRenewalNotice', { output: { keyTerms: { nonRenewalNotice: '3 months' } }, expectedOutput })).toMatchObject({ name: 'field_ok:nonRenewalNotice', value: 1 })
    expect((await run('field_ok:effectiveDate', { output: { keyTerms: {} }, expectedOutput })).value).toBe(0)
  })
})
