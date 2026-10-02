/**
 * docs/41 Parts 9, 10 with Part 7 — defined-term problems and compliance
 * gaps as review findings, and how the recommendation weighs them: drafting
 * never holds it back; a high compliance gap holds it at Review; a lesser
 * one is listed only. No database, no model.
 */
import { describe, it, expect } from 'vitest'
import { analyseDefinedTerms } from './defined-terms.js'
import { draftingFindingDrafts } from './drafting-findings.js'
import { complianceFindingDrafts, complianceSeverity } from './compliance-findings.js'
import { textHashOf, type ComplianceReport } from './compliance-check.js'
import { policy, type GuardInput, type PolicyFinding } from './recommendation-guard.js'
import type { FindingDraft } from './review-findings.js'
import type { PolicyEvaluation } from './compliance-policy.js'

const TEXT = [
  'DATA PROCESSING AGREEMENT',
  'This Agreement is between Acme GmbH (“Customer”) and Beta Inc. (“Supplier”).',
  '“Exclusions” means the matters in Schedule 2.',
  'Supplier shall protect the data and deliver the Deliverables to Customer.',
].join('\n')

const done: GuardInput['analysis'] = { kind: 'done', versionId: 'v1', versionNumber: 1, clauses: 3 }
const asPolicy = (fs: FindingDraft[]): PolicyFinding[] => fs.map((f, i) => ({ id: `f${i}`, kind: f.kind, severity: f.severity, status: 'open', title: f.title }))
const label = (fs: FindingDraft[]) => policy({ analysis: done, clauseCount: 3, riskScore: 0.1, findings: asPolicy(fs), counterpartyVersionAfterAnalysis: null })

describe('drafting findings', () => {
  const drafts = draftingFindingDrafts(analyseDefinedTerms(TEXT).issues)

  it('are one finding per problem and term, with the words and what to do', () => {
    const unused = drafts.find(d => d.key === 'drafting|unused_definition|Exclusions')
    expect(unused).toMatchObject({
      kind: 'drafting', severity: 'low', source: 'deterministic', clauseId: null,
      title: '“Exclusions” is defined but not used.',
      explanation: 'Remove the definition, or check whether the clause that used it was deleted.',
      evidence: { quote: expect.stringContaining('“Exclusions” means'), offsets: { start: TEXT.indexOf('Exclusions') }, ruleId: 'unused_definition' },
    })
    expect(drafts.find(d => d.key === 'drafting|undefined_term|Deliverables')).toMatchObject({ severity: 'medium' })
    expect(new Set(drafts.map(d => d.key)).size).toBe(drafts.length)
  })

  it('never hold the recommendation back', () => {
    expect(drafts.length).toBeGreaterThan(1)
    expect(label(drafts)).toEqual({ label: 'ready_to_approve', reasons: [] })
  })
})

describe('compliance findings', () => {
  const hash = textHashOf(TEXT)
  const evaluation: Pick<PolicyEvaluation, 'frameworks'> = {
    frameworks: [
      { framework: 'GDPR', label: 'GDPR', applies: 'yes', ruleId: 'r1', because: [
        { key: 'personal_data', label: 'Personal data', value: true, quote: 'Supplier will process employee personal data', confidence: 0.9, confirmed: false },
        { key: 'data_subject_regions', label: 'Where the people in the data are', value: ['EU'], quote: null, confidence: 0.8, confirmed: false },
      ] },
      { framework: 'HIPAA', label: 'HIPAA', applies: 'no', because: [] },
    ],
  }
  const check = (id: string, status: 'present' | 'partial' | 'missing' | 'risky', severity: 'low' | 'medium' | 'high' | 'critical') =>
    ({ id, requirement: `Requirement ${id}`, status, severity, finding: `Finding ${id}.`, quote: status === 'risky' ? 'the quoted words' : null, sectionRef: null, recommendation: `Fix ${id}.` })
  const report = (checks: ReturnType<typeof check>[], textHash = hash): ComplianceReport => ({
    frameworks: [
      { framework: 'GDPR', applicable: true, applicabilityReason: '', status: 'gaps', score: 60, checks },
      // Checked once, no longer applies: its results are not findings.
      { framework: 'HIPAA', applicable: true, applicabilityReason: '', status: 'gaps', score: 60, checks: [check('h1', 'missing', 'high')] },
    ],
    overall: { status: 'gaps', summary: '', criticalCount: 0 }, checkedAt: '2026-10-01T00:00:00Z', frameworksRequested: ['GDPR', 'HIPAA'], versionId: 'v1', textHash,
  })

  it('rate a missing requirement high or medium, a partly met one medium or low, and never critical', () => {
    expect(complianceSeverity({ status: 'missing', severity: 'critical' })).toBe('high')
    expect(complianceSeverity({ status: 'missing', severity: 'medium' })).toBe('medium')
    expect(complianceSeverity({ status: 'risky', severity: 'high' })).toBe('high')
    expect(complianceSeverity({ status: 'partial', severity: 'high' })).toBe('medium')
    expect(complianceSeverity({ status: 'partial', severity: 'low' })).toBe('low')
    expect(complianceSeverity({ status: 'present', severity: 'high' })).toBeNull()
  })

  it('are the gaps of the frameworks that apply, with why the framework applies', () => {
    const drafts = complianceFindingDrafts(evaluation, report([check('g1', 'missing', 'high'), check('g2', 'present', 'high'), check('g3', 'risky', 'medium')]), hash)
    expect(drafts.map(d => d.key)).toEqual(['compliance|GDPR|g1', 'compliance|GDPR|g3'])
    expect(drafts[0]).toMatchObject({
      kind: 'compliance', severity: 'high', source: 'llm',
      title: 'GDPR: Requirement g1 — missing',
      explanation: 'Finding g1. Fix g1. GDPR applies to this contract: personal data; where the people in the data are: EU.',
      evidence: { relatedQuote: 'Supplier will process employee personal data', ruleId: 'GDPR:g1' },
    })
    expect(drafts[1]).toMatchObject({ severity: 'medium', title: 'GDPR: Requirement g3 — at risk', evidence: { quote: 'the quoted words' } })
  })

  it('come only from a check of the same words', () => {
    expect(complianceFindingDrafts(evaluation, report([check('g1', 'missing', 'high')], 'other'), hash)).toEqual([])
    expect(complianceFindingDrafts(evaluation, null, hash)).toEqual([])
  })

  it('hold the recommendation at Review when high, and only then', () => {
    const high = complianceFindingDrafts(evaluation, report([check('g1', 'missing', 'high')]), hash)
    expect(label(high)).toMatchObject({ label: 'review', reasons: [{ code: 'review', text: 'GDPR: Requirement g1 — missing' }] })
    const medium = complianceFindingDrafts(evaluation, report([check('g1', 'missing', 'medium'), check('g2', 'partial', 'high')]), hash)
    expect(medium.length).toBe(2)
    expect(label(medium).label).toBe('ready_to_approve')
  })
})
