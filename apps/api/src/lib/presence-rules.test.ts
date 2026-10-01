import { describe, it, expect } from 'vitest'
import { presenceFindings, applicableRules, type PresenceRule, type ClauseLike } from './presence-rules.js'
import { guardReasons, guardedLabel } from './recommendation-guard.js'

const STANDALONE = ['NDA', 'MSA']
const RULES: PresenceRule[] = [
  { id: 'c-conf', name: 'Confidentiality', presence: 'required', presenceContractTypes: ['NDA'] },
  { id: 'c-disp', name: 'Dispute Resolution', presence: 'required', presenceContractTypes: STANDALONE },
  { id: 'c-term', name: 'Term & Termination', presence: 'required', presenceContractTypes: STANDALONE },
  { id: 'c-lol', name: 'Limitation of Liability', presence: 'required', presenceContractTypes: ['MSA'] },
  { id: 'c-nc', name: 'Non-Compete', presence: 'not_allowed', presenceContractTypes: [] },
  { id: 'c-fees', name: 'Fees & Payment', presence: 'optional', presenceContractTypes: [] },
]
const GOV = { clauseType: 'governing_law', content: 'This Agreement is governed by the laws of the State of New York.', sectionRef: '9' }
const CONF = { clauseType: 'confidentiality', content: 'The Recipient shall hold the Confidential Information in strict confidence.' }
const TERM = { clauseType: 'termination', content: 'Either party may terminate on thirty days notice.' }
const EXCL = { clauseType: 'confidentiality', content: Array.from({ length: 40 }, (_, i) => `exclusion${i}`).join(' ') }

const run = (current: ClauseLike[], baseline: ClauseLike[] | null, contractType = 'NDA') => presenceFindings({
  rules: RULES, contractType, current, baseline,
  versionId: 'v5', baselineVersionId: baseline ? 'v4' : null, baselineVersionNumber: baseline ? 4 : null,
})

describe('presence rules (docs/41 P0.3)', () => {
  it('only the rules for this type, never the optional ones', () => {
    expect(applicableRules(RULES, 'NDA').map(r => r.id)).toEqual(['c-conf', 'c-disp', 'c-term', 'c-nc'])
    expect(applicableRules(RULES, 'SOW').map(r => r.id)).toEqual(['c-nc'])
  })

  it('a deleted governing law is "Deleted since v4", required, with the deleted text — first', () => {
    const f = run([CONF, TERM], [CONF, TERM, GOV])
    expect(f[0]).toMatchObject({
      kind: 'deleted', clauseType: 'governing_law', label: 'Governing Law', required: true, severity: 'high',
      message: 'Governing Law — deleted since v4 (required).', baselineVersionId: 'v4', versionId: 'v5',
    })
    expect(f[0].evidence.text).toContain('State of New York')
    // Said once: not also "not detected".
    expect(f.filter(x => x.kind === 'not_detected')).toHaveLength(0)
  })

  it('deleted even while another clause still covers its category', () => {
    const dispute = { clauseType: 'dispute_resolution', content: 'Disputes go to arbitration.' }
    const f = run([CONF, TERM, dispute], [CONF, TERM, GOV, dispute])
    expect(f.map(x => `${x.kind}:${x.clauseType}`)).toEqual(['deleted:governing_law'])
  })

  it('a required clause never found is "not detected", worded as such', () => {
    const f = run([TERM, GOV], null)
    expect(f).toEqual([expect.objectContaining({ kind: 'not_detected', label: 'Confidentiality', required: true, severity: 'medium' })])
    expect(f[0].message).toMatch(/not detected\. Find it in the document or confirm it's missing/)
  })

  it('a clause cut by more than 30% is flagged with before and after', () => {
    const half = { clauseType: 'confidentiality', content: EXCL.content.split(' ').slice(0, 20).join(' ') }
    const f = run([half, TERM, GOV], [EXCL, TERM, GOV])
    expect(f).toEqual([expect.objectContaining({ kind: 'cut', clauseType: 'confidentiality', required: true })])
    expect(f[0].message).toBe('Confidentiality — cut by 50% since v4.')
  })

  it('a clause the playbook doesn\'t allow', () => {
    const f = run([CONF, TERM, GOV, { clauseType: 'non_compete', content: 'No competing for two years.' }], null)
    expect(f).toEqual([expect.objectContaining({ kind: 'not_allowed_present', label: 'Non-Compete' })])
  })
})

describe('the approval guard (docs/41 P0.2)', () => {
  const done = { kind: 'done' as const, versionId: 'v5', versionNumber: 5, clauses: 3 }
  it('a null risk score is unknown — never ready', () => {
    const r = guardReasons({ analysis: done, clauseCount: 3, riskScore: null, findings: [], counterpartyVersionAfterAnalysis: null })
    expect(r.map(x => x.code)).toEqual(['risk_unknown'])
    expect(guardedLabel('approve', { passes: false })).toBe('cant_recommend')
  })

  it('ready only when every check passes', () => {
    expect(guardReasons({ analysis: done, clauseCount: 3, riskScore: 0.1, findings: [], counterpartyVersionAfterAnalysis: null })).toEqual([])
    expect(guardedLabel('approve', { passes: true })).toBe('approve')
  })

  it('missing, stale and empty analysis, deletions and a later counterparty version all hold it back', () => {
    const deleted = run([CONF, TERM], [CONF, TERM, GOV])
    const codes = (a: Parameters<typeof guardReasons>[0]) => guardReasons(a).map(x => x.code)
    expect(codes({ analysis: { kind: 'not_analysed', reason: null }, clauseCount: 0, riskScore: null, findings: [], counterpartyVersionAfterAnalysis: null })).toEqual(['analysis_missing', 'risk_unknown'])
    expect(codes({ analysis: { kind: 'stale', analysedVersionId: 'v4', analysedVersionNumber: 4 }, clauseCount: 3, riskScore: 0.1, findings: deleted, counterpartyVersionAfterAnalysis: null })).toEqual(['analysis_stale', 'required_deleted'])
    expect(codes({ analysis: done, clauseCount: 0, riskScore: 0.1, findings: [], counterpartyVersionAfterAnalysis: { versionNumber: 6 } })).toEqual(['no_clauses', 'counterparty_version'])
  })
})
