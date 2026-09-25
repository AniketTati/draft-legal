import { describe, it, expect } from 'vitest'
import { redlineTargets } from './playbook-redline-targets.js'
import { matchCategory } from './clause-category.js'

describe('what "Redline against playbook" rewrites', () => {
  const review = {
    versionId: 'v2',
    findings: [
      { clauseId: 'fees', clauseType: 'Fees & Payment', reasoning: 'Uncapped 12% increase; we cap at 7%.', recommendation: 'reject', severity: 'critical' },
      { clauseId: 'lol', clauseType: 'Limitation of Liability', reasoning: 'Cap under 6 months of fees.', recommendation: 'reject', severity: 'critical' },
      { clauseId: 'law', clauseType: 'Governing Law', reasoning: 'Delaware, as we want.', recommendation: 'accept', severity: 'low' },
    ],
  }
  const checks = [
    { clauseId: 'lol', failedCount: 1, worstSeverity: 'high' },
    { clauseId: 'conf', failedCount: 0, worstSeverity: null },
  ]

  it('covers every clause the review flagged, as well as those the rules caught, with the review\'s reason', () => {
    const t = redlineTargets(checks, review, 'v2')
    expect(t.clauseIds).toEqual(['lol', 'fees'])
    expect(t.hints.fees).toEqual({ category: 'Fees & Payment', issue: 'Uncapped 12% increase; we cap at 7%.' })
    expect(t.severity.get('fees')).toBe('critical')
    expect(t.severity.get('lol')).toBe('high')
  })

  it('ignores a review of another version, whose clause rows are not this one\'s', () => {
    expect(redlineTargets(checks, review, 'v3').clauseIds).toEqual(['lol'])
    expect(redlineTargets([], null, 'v3').clauseIds).toEqual([])
  })
})

describe('matching a clause type to a playbook category', () => {
  const categories = ['Fees & Payment', 'Term & Termination', 'Limitation of Liability', 'Confidentiality', 'Data Protection & Privacy', 'Governing Law']
    .map((name, i) => ({ id: String(i), name }))
  const of = (t: string) => matchCategory(categories, t)?.name ?? null

  it('finds the category a person named for the extractor\'s type', () => {
    expect(of('limitation_of_liability')).toBe('Limitation of Liability')
    expect(of('payment')).toBe('Fees & Payment')
    expect(of('price_adjustment')).toBe('Fees & Payment')
    expect(of('auto_renewal')).toBe('Term & Termination')
    expect(of('termination')).toBe('Term & Termination')
    expect(of('uncapped_liability')).toBe('Limitation of Liability')
    expect(of('data_protection')).toBe('Data Protection & Privacy')
  })

  it('matches nothing rather than something wrong', () => {
    expect(of('general')).toBeNull()
    expect(of('insurance')).toBeNull()
  })
})
