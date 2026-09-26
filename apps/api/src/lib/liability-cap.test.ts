/**
 * DD1 — caps measured from their words (liability-cap.ts). The first case is
 * §3 of the Brightwave agreement, where the review said a 2× cap "could
 * exceed 3× annual value depending on payment schedule".
 */
import { describe, it, expect } from 'vitest'
import { liabilityCaps, evaluateCapBound, numeralized, sentencesOf } from './liability-cap.js'

const BRIGHTWAVE = `3. LIMITATION OF LIABILITY Except for the Excluded Claims set forth below, each party's aggregate liability arising out of or related to this Agreement shall not exceed two (2) times the fees paid or payable in the twelve (12) months preceding the event giving rise to the claim. For claims arising from a breach of Section 6 (Confidentiality) involving unauthorized disclosure of Customer Data, the aggregate liability cap shall be three (3) times the fees paid or payable in the twelve (12) months preceding the event giving rise to the claim."Excluded Claims" means:(a) either party's indemnification obligations under Section 4 (Indemnification);(b) a breach of Section 6 (Confidentiality) (except as specifically provided above for Customer Data);(c) Customer's payment obligations under Section 2 (FEES AND PAYMENT);(d) either party's gross negligence or willful misconduct; and(e) either party's infringement or misappropriation of the other party's intellectual property rights.`

const MONTHS = { min: 6, max: 24, units: 'months of fees' }
const ANNUAL = { max: 3, units: 'x annual contract value' }

describe('liabilityCaps', () => {
  it('measures the Brightwave caps: 24 months of fees, and 36 for Customer Data claims', () => {
    const [general, superCap, ...rest] = liabilityCaps(BRIGHTWAVE)
    expect(rest).toEqual([])
    expect(general).toMatchObject({ condition: null, binds: 'both', multiple: 2, periodMonths: 12, monthsOfFees: 24, timesAnnualFees: 2, amount: null })
    expect(general.statement).toBe("Each party's cap: 2 × the fees of the 12 months before the claim = 24 months of fees, 2 times a year's fees.")
    expect(superCap.condition).toMatch(/^claims arising from a breach of Section 6 \(Confidentiality\) involving unauthorized disclosure of Customer Data$/)
    expect(superCap).toMatchObject({ binds: 'both', multiple: 3, periodMonths: 12, monthsOfFees: 36, timesAnnualFees: 3 })
  })

  it('judges the playbook limits on the general cap and reports the super-cap', () => {
    const caps = liabilityCaps(BRIGHTWAVE)
    const months = evaluateCapBound(caps, MONTHS)!
    expect(months).toMatchObject({ passed: true, value: 24 })
    expect(months.reason).toContain('That is 24 months of fees, within the limit.')
    expect(months.reason).toContain("Separately, a cap for some claims is 36 months of fees (3 times a year's fees).")
    expect(months.reason).toContain("The playbook's limit is 6–24 months of fees.")
    expect(evaluateCapBound(caps, ANNUAL)).toMatchObject({ passed: true, value: 2 })
  })

  it('fails a cap outside the limit', () => {
    const caps = liabilityCaps('Each party’s total liability shall not exceed three (3) times the fees paid in the twelve (12) months before the claim.')
    expect(evaluateCapBound(caps, MONTHS)).toMatchObject({ passed: false, value: 36 })
    expect(evaluateCapBound(caps, ANNUAL)).toMatchObject({ passed: true, value: 3 })
    expect(evaluateCapBound(liabilityCaps('Liability is limited to three (3) months of fees.'), MONTHS)).toMatchObject({ passed: false, value: 3 })
  })

  it('reads an amount, and leaves a months limit unjudged for it', () => {
    const [cap] = liabilityCaps("Supplier's total liability under this Agreement shall not exceed $500,000.")
    expect(cap).toMatchObject({ binds: 'one', party: 'Supplier', amount: { value: 500_000, currency: 'USD' }, multiple: null, monthsOfFees: null })
    expect(cap.statement).toBe("Supplier's cap: USD 500,000.")
    expect(evaluateCapBound([cap], MONTHS)).toMatchObject({ passed: null })
    expect(evaluateCapBound([cap], { max: 1_000_000, units: 'USD' })).toMatchObject({ passed: true, value: 500_000 })
    expect(liabilityCaps('Each party’s liability shall not exceed one million US dollars (US$1,000,000).')[0].amount).toEqual({ value: 1_000_000, currency: 'USD' })
  })

  it('reads the greater of an amount and the fees, across a list', () => {
    const [cap] = liabilityCaps("Each party's total liability shall not exceed the greater of:\n(a) $1,000,000; and\n(b) the fees paid by Customer in the twelve (12) months preceding the claim.")
    expect(cap).toMatchObject({ combine: 'greater', amount: { value: 1_000_000, currency: 'USD' }, multiple: 1, periodMonths: 12, monthsOfFees: null })
    expect(cap.statement).toBe("Each party's cap: the greater of USD 1,000,000 and 1 × the fees of the 12 months before the claim.")
    // At least 12 months of fees: above a 6-month ceiling whatever the fees; unknown against 24.
    expect(evaluateCapBound([cap], { max: 6, units: 'months of fees' })).toMatchObject({ passed: false })
    expect(evaluateCapBound([cap], MONTHS)).toMatchObject({ passed: null })
  })

  it('reads percentages, "twice", fractions, years and "N months of fees"', () => {
    expect(liabilityCaps("In no event shall either party's aggregate liability exceed one hundred fifty percent (150%) of the fees paid in the preceding twelve months.")[0])
      .toMatchObject({ binds: 'both', multiple: 1.5, periodMonths: 12, monthsOfFees: 18 })
    expect(liabilityCaps('Liability shall be limited to twice the annual fees.')[0]).toMatchObject({ multiple: 2, periodMonths: 12, monthsOfFees: 24 })
    expect(liabilityCaps('Each party’s liability shall not exceed one and one-half times the fees paid in the prior year.')[0]).toMatchObject({ multiple: 1.5, monthsOfFees: 18 })
    expect(liabilityCaps('The Provider’s liability is limited to twelve (12) months of fees.')[0]).toMatchObject({ binds: 'one', party: 'Provider', multiple: 1, periodMonths: 12, monthsOfFees: 12 })
    expect(liabilityCaps('Liability shall not exceed the fees paid during the two (2) year period before the claim.')[0]).toMatchObject({ periodMonths: 24, monthsOfFees: 24 })
  })

  it('reads a multiple restated in brackets, and a one-month cap', () => {
    // Both from redlined versions of the Brightwave agreement in the demo workspace.
    const [twice] = liabilityCaps("Except for the excluded liabilities set forth below, each party's aggregate liability arising out of or related to this Agreement shall not exceed two times (2x) the fees paid or payable by Customer in the twelve (12) months immediately preceding the event giving rise to the claim.")
    expect(twice).toMatchObject({ binds: 'both', multiple: 2, periodMonths: 12, monthsOfFees: 24 })
    const [month] = liabilityCaps('LIMITATION OF LIABILITY Supplier’s aggregate liability under this Agreement shall not exceed the fees paid in the one (1) month preceding the claim.')
    expect(month.statement).toBe("Supplier's cap: 1 × the fees of the 1 month before the claim = 1 month of fees, 0.08 times a year's fees.")
    expect(evaluateCapBound([month], MONTHS)).toMatchObject({ passed: false, value: 1 })
    expect(evaluateCapBound([month], MONTHS)!.reason).toContain('That is 1 month of fees, outside the limit.')
  })

  it('says when the fees have no period, instead of guessing one', () => {
    const [cap] = liabilityCaps("Supplier's liability shall not exceed the total fees paid under this Agreement.")
    expect(cap).toMatchObject({ multiple: 1, periodMonths: null, monthsOfFees: null })
    expect(cap.statement).toContain('in total')
    expect(evaluateCapBound([cap], MONTHS)).toMatchObject({ passed: null })
  })

  it('tells a super-cap from a general cap', () => {
    // "for all claims" is the general cap.
    const [general] = liabilityCaps("Supplier's liability shall not exceed $2,000,000 for all claims arising under this Agreement.")
    expect(general.condition).toBeNull()
    const caps = liabilityCaps("Each party's liability shall not exceed the fees paid in the 12 months before the claim; provided that, for breaches of Section 6 (Data Protection), the cap shall be two (2) times the fees paid in the 12 months before the claim.")
    expect(caps.map(c => [c.condition, c.monthsOfFees])).toEqual([[null, 12], ['breaches of Section 6 (Data Protection)', 24]])
    expect(caps[1].binds).toBe('both')
  })

  it('takes the party nearest the cap', () => {
    expect(liabilityCaps("Except for Customer's liability for payment, each party's aggregate liability shall not exceed the fees paid in the 12 months before the claim.")[0].binds).toBe('both')
    expect(liabilityCaps("Customer's aggregate liability shall not exceed the fees paid in the 12 months before the claim.")[0].binds).toBe('one')
  })

  it('does not read "including but not limited to" as a cap', () => {
    expect(liabilityCaps('Neither party shall be liable for indirect damages, including but not limited to lost profits or fees.')).toEqual([])
    expect(liabilityCaps('Customer shall pay all fees within 30 days. Late payments bear interest.')).toEqual([])
  })
})

describe('numeralized and sentencesOf', () => {
  it('writes numbers as numerals', () => {
    expect(numeralized('two (2) times the fees in the twelve (12) months')).toBe('2 times the fees in the 12 months')
    expect(numeralized('one hundred fifty percent (150%) of')).toBe('150% of')
    expect(numeralized('twenty-four months and thirty six months')).toBe('24 months and 36 months')
    expect(numeralized('two and three')).toBe('2 and 3')
    expect(numeralized('two times (2x) the fees in the twelve (12) months')).toBe('2 times the fees in the 12 months')
  })

  it('parts sentences run together, and keeps a list with its sentence', () => {
    expect(sentencesOf('the claim."Excluded Claims" means:(a) x')).toEqual(['the claim.', '"Excluded Claims" means:(a) x'])
    expect(sentencesOf('the greater of:\n(a) $1; and\n(b) the fees.')).toEqual(['the greater of: (a) $1; and (b) the fees.'])
  })
})
