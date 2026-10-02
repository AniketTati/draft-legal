/**
 * docs/41 Part 9 — applicability is facts + policy, deterministic: each
 * default rule, the confidence threshold, "unsure" asking one question, and
 * frameworks added by hand.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_COMPLIANCE_POLICY, FACT_CONFIDENCE_THRESHOLD, evaluatePolicy, applyingFrameworks, normaliseRegions, type StoredFact } from './compliance-policy.js'

const fact = (key: string, value: unknown, over: Partial<StoredFact> = {}): StoredFact =>
  ({ key, value, quote: value === true || Array.isArray(value) ? `quote for ${key}` : null, confidence: 0.9, confirmedAt: null, ...over })

/** Everything known and absent, so one rule at a time can be switched on. */
const NOTHING: StoredFact[] = [
  fact('personal_data', false), fact('data_subject_regions', []), fact('party_jurisdictions', ['IN']),
  fact('health_data', false), fact('hipaa_covered_entity', false), fact('payment_card_data', false),
  fact('financial_reporting_impact', false), fact('public_company', false),
]
const with_ = (...facts: StoredFact[]) => [...NOTHING.filter(f => !facts.some(n => n.key === f.key)), ...facts]
const applies = (facts: StoredFact[], added: string[] = []) => applyingFrameworks(evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, facts, added))

describe('default rules', () => {
  it('nothing regulated: nothing applies, and nothing is asked', () => {
    const e = evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, NOTHING)
    expect(e.frameworks.every(f => f.applies === 'no')).toBe(true)
    expect(e.question).toBeNull()
    // Why not: the facts that rule it out.
    expect(e.frameworks.find(f => f.framework === 'GDPR')!.because.map(b => b.key)).toEqual(['personal_data'])
  })

  it('GDPR: personal data of people in the EU, or a party in the EU', () => {
    expect(applies(with_(fact('personal_data', true), fact('data_subject_regions', ['FR'])))).toEqual(['GDPR'])
    expect(applies(with_(fact('personal_data', true), fact('party_jurisdictions', ['DE', 'US'])))).toEqual(['GDPR'])
    expect(applies(with_(fact('data_subject_regions', ['FR'])))).toEqual([])      // no personal data
  })

  it('UK GDPR: personal data with the UK', () => {
    expect(applies(with_(fact('personal_data', true), fact('data_subject_regions', ['GB'])))).toEqual(['UK_GDPR'])
    expect(applies(with_(fact('personal_data', true), fact('party_jurisdictions', ['UK'])))).toEqual(['UK_GDPR'])
  })

  it('HIPAA: health data and a covered entity or business associate', () => {
    expect(applies(with_(fact('health_data', true), fact('hipaa_covered_entity', true)))).toEqual(['HIPAA'])
    expect(applies(with_(fact('health_data', true)))).toEqual([])
  })

  it('CCPA: personal data of California residents (not the rest of the US)', () => {
    expect(applies(with_(fact('personal_data', true), fact('data_subject_regions', ['US-CA'])))).toEqual(['CCPA'])
    expect(applies(with_(fact('personal_data', true), fact('data_subject_regions', ['California'])))).toEqual(['CCPA'])
    expect(applies(with_(fact('personal_data', true), fact('data_subject_regions', ['US'])))).toEqual([])
  })

  it('SOX: a public company and financial reporting', () => {
    expect(applies(with_(fact('financial_reporting_impact', true), fact('public_company', true)))).toEqual(['SOX'])
    expect(applies(with_(fact('financial_reporting_impact', true)))).toEqual([])
  })

  it('PCI DSS: card data', () => {
    expect(applies(with_(fact('payment_card_data', true)))).toEqual(['PCI_DSS'])
  })

  it('says why, with the quotes of the rule that holds', () => {
    const e = evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, with_(fact('personal_data', true), fact('data_subject_regions', ['DE'])))
    const gdpr = e.frameworks.find(f => f.framework === 'GDPR')!
    expect(gdpr).toMatchObject({ applies: 'yes', ruleId: 'gdpr-eu-subjects', label: 'GDPR' })
    expect(gdpr.because.map(b => b.quote)).toEqual(['quote for personal_data', 'quote for data_subject_regions'])
  })
})

describe('unsure facts', () => {
  it('a known fact rules a framework out even while another is unsure', () => {
    // Personal data is uncertain, but nobody involved is in the EU: GDPR is out, CCPA too.
    const e = evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, with_(fact('personal_data', true, { confidence: FACT_CONFIDENCE_THRESHOLD - 0.1 })))
    expect(e.frameworks.find(f => f.framework === 'GDPR')!.applies).toBe('no')
    expect(e.frameworks.find(f => f.framework === 'CCPA')!.applies).toBe('no')
    expect(e.question).toBeNull()
  })

  it('missing facts make a framework unsure and ask ONE question, the first needed', () => {
    const e = evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, [])
    expect(new Set(e.frameworks.map(f => f.applies))).toEqual(new Set(['unsure']))
    expect(e.question).toMatchObject({ key: 'personal_data', kind: 'boolean' })
    expect(e.question!.options.map(o => o.value)).toEqual(['yes', 'no', 'unsure'])
  })

  it('once personal data is known, it asks where the people are', () => {
    const e = evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, [fact('personal_data', true), fact('party_jurisdictions', ['US'])])
    expect(e.frameworks.find(f => f.framework === 'GDPR')!.applies).toBe('unsure')
    expect(e.question).toMatchObject({ key: 'data_subject_regions', kind: 'list' })
    expect(e.question!.options.map(o => o.value)).toContain('US-CA')
  })

  it('a low-confidence fact is unsure; a confirmed one counts at any confidence', () => {
    const low = [fact('personal_data', true, { confidence: 0.3 }), fact('data_subject_regions', ['DE'])]
    expect(evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, low).frameworks.find(f => f.framework === 'GDPR')!.applies).toBe('unsure')
    const confirmed = [fact('personal_data', true, { confidence: 0.3, confirmedAt: new Date() }), fact('data_subject_regions', ['DE'])]
    expect(evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, confirmed).frameworks.find(f => f.framework === 'GDPR')!.applies).toBe('yes')
  })

  it('"Not sure" (a confirmed null) is not asked again', () => {
    const e = evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, [fact('personal_data', null, { confirmedAt: new Date() })])
    expect(e.frameworks.find(f => f.framework === 'GDPR')!.applies).toBe('unsure')
    expect(e.question?.key).not.toBe('personal_data')
  })
})

describe('the org\'s own rules', () => {
  it('a disabled rule never applies; a framework with no rules is not listed', () => {
    const rules = DEFAULT_COMPLIANCE_POLICY.map(r => (r.framework === 'PCI_DSS' ? { ...r, enabled: false } : r)).filter(r => r.framework !== 'SOX')
    const e = evaluatePolicy(rules, with_(fact('payment_card_data', true)))
    expect(applyingFrameworks(e)).toEqual([])
    expect(e.frameworks.map(f => f.framework)).not.toContain('PCI_DSS')
    expect(e.frameworks.map(f => f.framework)).not.toContain('SOX')
  })

  it('a framework added by hand applies whatever the facts say', () => {
    const e = evaluatePolicy(DEFAULT_COMPLIANCE_POLICY, NOTHING, ['HIPAA'])
    expect(e.frameworks.find(f => f.framework === 'HIPAA')).toMatchObject({ applies: 'yes', addedByUser: true })
  })
})

describe('normaliseRegions', () => {
  it('reads EU members as the EU, GB as the UK, and California as US-CA and the US', () => {
    expect([...normaliseRegions(['de', 'GB', 'california'])].sort()).toEqual(['DE', 'EU', 'UK', 'US', 'US-CA'])
    expect([...normaliseRegions('NO')]).toContain('EU')
    expect(normaliseRegions(null).size).toBe(0)
  })
})
