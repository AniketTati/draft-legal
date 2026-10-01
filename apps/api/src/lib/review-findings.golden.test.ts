/**
 * docs/41 P1 — golden cases for the review findings and the recommendation
 * policy (Part 7's "Testing"): no database, no model.
 *
 *   - delete Governing Law → "Deleted since v1" (required), never Ready;
 *   - cut Exclusions in half → a material cut;
 *   - a template draft left unchanged → every clause Standard, Ready;
 *   - junk typed into a clause → unreadable text, and the clause changed;
 *   - never analysed → Can't recommend;
 *   - a fallback position → "Fallback", still Ready; a position that needs
 *     approval → Needs exception; past a walkaway → Escalate.
 */
import { describe, it, expect } from 'vitest'
import type { TemplateSection } from '@prisma/client'
import { computeFindings, positionCheckTargets, pairClauses, type ClauseIn, type CategoryIn, type FindingDraft, type ReviewInput } from './review-findings.js'
import { policy, type PolicyFinding, type GuardInput } from './recommendation-guard.js'
import { generateDocument, type TemplateWithSections } from './template-engine.js'
import { originSections, standardSpans, standardSourceOf, fingerprint } from './fingerprint.js'
import { htmlToText } from './html-text.js'

const CATEGORIES: CategoryIn[] = [
  { id: 'cat-conf', name: 'Confidentiality', presence: 'required', presenceContractTypes: ['NDA'] },
  { id: 'cat-gov', name: 'Governing Law', presence: 'required', presenceContractTypes: ['NDA'] },
  { id: 'cat-term', name: 'Term & Termination', presence: 'required', presenceContractTypes: ['NDA'] },
  { id: 'cat-misc', name: 'Miscellaneous', presence: 'optional', presenceContractTypes: [] },
]

const CONF = 'The Recipient shall hold the Confidential Information in strict confidence, shall use it only for the Purpose, and shall not disclose it to any third party without the prior written consent of the Discloser.'
const EXCL = 'Confidential Information does not include information that: (a) is or becomes generally available to the public other than through a breach of this Agreement; (b) was lawfully known to the Recipient before disclosure; (c) is lawfully received from a third party without restriction; or (d) is independently developed by the Recipient without use of the Confidential Information.'
const GOV = 'This Agreement is governed by the laws of the State of New York, without regard to its conflict-of-laws principles.'
const TERM = 'This Agreement continues for two years from the Effective Date unless terminated earlier by either party on thirty days written notice.'
const MISC = 'This Agreement is the entire agreement between the parties about its subject and replaces all earlier discussions.'

let n = 0
const clause = (clauseType: string, content: string, extra: Partial<ClauseIn> = {}): ClauseIn => ({ id: `c${++n}`, clauseType, content, sectionRef: null, sortOrder: n, ...extra })
const textOf = (cs: ClauseIn[]) => cs.map(c => c.content).join('\n\n')

function review(current: ClauseIn[], baseline: ClauseIn[] | null, extra: Partial<ReviewInput> = {}) {
  return computeFindings({
    contractType: 'NDA', categories: CATEGORIES, positions: [],
    current, currentText: extra.currentText ?? textOf(current),
    baseline: baseline ? { clauses: baseline, text: textOf(baseline), versionNumber: 1 } : null,
    ...extra,
  })
}

const asPolicy = (fs: FindingDraft[]): PolicyFinding[] => fs.map((f, i) => ({ id: `f${i}`, kind: f.kind, severity: f.severity, status: f.status ?? 'open', title: f.title }))
const done: GuardInput['analysis'] = { kind: 'done', versionId: 'v2', versionNumber: 2, clauses: 3 }
const label = (fs: FindingDraft[], over: Partial<GuardInput> = {}) =>
  policy({ analysis: done, clauseCount: 3, riskScore: 0.1, findings: asPolicy(fs), counterpartyVersionAfterAnalysis: null, ...over })

describe('golden: Governing Law deleted', () => {
  it('is "Governing Law — deleted since v1 (required)" with the deleted words, and is not Ready', () => {
    const v1 = [clause('confidentiality', CONF), clause('termination', TERM), clause('governing_law', GOV)]
    const v2 = [clause('confidentiality', CONF), clause('termination', TERM)]
    const { findings } = review(v2, v1)
    expect(findings[0]).toMatchObject({
      kind: 'deleted', key: 'deleted|governing_law', severity: 'high', categoryId: 'cat-gov',
      title: 'Governing Law — deleted since v1 (required)',
      evidence: { baselineQuote: GOV },
    })
    // Said once: not also "not detected".
    expect(findings.filter(f => f.kind === 'missing_required')).toEqual([])
    const r = label(findings)
    expect(r.label).toBe('review')
    expect(r.reasons[0].text).toBe('Governing Law — deleted since v1 (required)')
  })

  it('is remembered on the next version while the clause stays gone', () => {
    const carried = review([clause('confidentiality', CONF), clause('termination', TERM)], [clause('confidentiality', CONF), clause('termination', TERM), clause('governing_law', GOV)]).findings
    const next = review([clause('confidentiality', CONF), clause('termination', `${TERM} Either party may renew.`)], [clause('confidentiality', CONF), clause('termination', TERM)], { carriedDeleted: carried })
    expect(next.findings.map(f => f.key)).toContain('deleted|governing_law')
  })

  it('a clause whose words are still there, read as part of another, is not deleted', () => {
    const v1 = [clause('confidentiality', CONF), clause('governing_law', GOV), clause('termination', TERM)]
    const merged = clause('confidentiality', `${CONF} ${GOV}`)
    const { findings } = review([merged, clause('termination', TERM)], v1, { currentText: `${CONF} ${GOV}\n\n${TERM}` })
    expect(findings.filter(f => f.kind === 'deleted')).toEqual([])
  })
})

describe('golden: Exclusions cut in half', () => {
  it('is a material cut, with the words before and after', () => {
    const half = 'Confidential Information does not include information that: (a) is or becomes generally available to the public other than through a breach of this Agreement.'
    const { findings } = review(
      [clause('confidentiality', CONF), clause('confidentiality_exclusions', half), clause('governing_law', GOV), clause('termination', TERM)],
      [clause('confidentiality', CONF), clause('confidentiality_exclusions', EXCL), clause('governing_law', GOV), clause('termination', TERM)],
    )
    const cut = findings.find(f => f.kind === 'material_cut')
    expect(cut).toMatchObject({ evidence: { quote: half, baselineQuote: EXCL } })
    expect(cut!.title).toMatch(/— cut by \d+% since v1$/)
    expect(label(findings).label).toBe('review')
  })
})

describe('golden: a template draft left unchanged', () => {
  const template: TemplateWithSections = {
    id: 'tpl1', orgId: 'o', name: 'Mutual NDA', description: null, contractType: 'NDA', variables: [], isPublished: true, version: 3, usageCount: 0,
    createdById: 'u', createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    sections: [
      { id: 's1', title: '1. Confidentiality', content: `<p>${CONF.replace('the Purpose', '{{purpose}}')}</p>` },
      { id: 's2', title: '2. Term', content: `<p>${TERM}</p>` },
      { id: 's3', title: '3. Governing Law', content: '<p>This Agreement is governed by the laws of {{governing_law}}, without regard to its conflict-of-laws principles.</p>' },
    ].map((s, i) => ({ ...s, templateId: 'tpl1', sortOrder: i, conditionalLogic: null, clauseRefs: [], createdAt: new Date(), updatedAt: new Date() })) as TemplateSection[],
  }
  const generated = generateDocument({ template, variables: { purpose: 'evaluating a partnership', governing_law: 'the State of New York' } })
  const text = htmlToText(generated.html)
  const filled = [
    clause('confidentiality', CONF.replace('the Purpose', 'evaluating a partnership')),
    clause('termination', TERM),
    clause('governing_law', 'This Agreement is governed by the laws of the State of New York, without regard to its conflict-of-laws principles.'),
  ]

  it('stamps every section with the fingerprint of its words, variables as placeholders', () => {
    expect(generated.origin.sections).toHaveLength(3)
    expect(generated.origin.sections[0]).toMatchObject({ sectionId: 's1', source: 'template:tpl1:3:s1' })
    expect(generated.html).toContain(`data-fp="${generated.origin.sections[0].fp}"`)
    const read = originSections(generated.html)
    expect(read.map(s => s.verified)).toEqual([true, true, true])
    expect(read[0].variables).toEqual({ purpose: 'evaluating a partnership' })
    // The same fingerprint from the filled text and its values.
    expect(fingerprint(htmlToText(`<h2>1. Confidentiality</h2>${CONF.replace('the Purpose', 'evaluating a partnership')}`), { purpose: 'evaluating a partnership' })).toBe(generated.origin.sections[0].fp)
  })

  it('is all Standard, sends nothing to the model, and is Ready', () => {
    const spans = standardSpans(originSections(generated.html), text, generated.html)
    for (const c of filled) c.standardSource = standardSourceOf(c.content, spans)
    expect(filled.map(c => c.standardSource)).toEqual(['template:tpl1:3:s1', 'template:tpl1:3:s2', 'template:tpl1:3:s3'])
    const { findings, changedClauseIds } = review(filled, null, { currentText: text })
    expect(findings).toEqual([])
    expect(positionCheckTargets(filled, changedClauseIds)).toEqual([])
    expect(label(findings).label).toBe('ready_to_approve')
  })

  it('one word changed in Purpose is no longer standard, and goes to review as changed', () => {
    const edited = text.replace('only for evaluating a partnership', 'only for evaluating any partnership')
    const spans = standardSpans(originSections(generated.html), edited, generated.html)
    const conf = { ...filled[0], id: 'c-new', content: filled[0].content.replace('evaluating a partnership', 'evaluating any partnership'), standardSource: null as string | null }
    conf.standardSource = standardSourceOf(conf.content, spans)
    expect(conf.standardSource).toBeNull()
    expect(standardSourceOf(filled[1].content, spans)).toBe('template:tpl1:3:s2')
    const current = [conf, { ...filled[1], standardSource: 'template:tpl1:3:s2' }, { ...filled[2], standardSource: 'template:tpl1:3:s3' }]
    const { findings, changedClauseIds } = review(current, filled.map(c => ({ ...c })), { currentText: edited })
    expect(findings.map(f => f.kind)).toEqual(['modified'])
    expect(positionCheckTargets(current, changedClauseIds).map(c => c.id)).toEqual(['c-new'])
  })

  it('a variable changed through the variable editor is still standard', () => {
    const html = generated.html.replace('>the State of New York<', '>the State of Delaware<')
    const spans = standardSpans(originSections(generated.html), htmlToText(html), html)
    expect(standardSourceOf('This Agreement is governed by the laws of the State of Delaware, without regard to its conflict-of-laws principles.', spans)).toBe('template:tpl1:3:s3')
  })
})

describe('golden: junk typed into a clause', () => {
  it('is unreadable text, and the clause changed', () => {
    const junk = `${MISC} asdkjh qwpoeiru zxmcnvb lkjasd.`
    const v1 = [clause('confidentiality', CONF), clause('governing_law', GOV), clause('termination', TERM), clause('general', MISC)]
    const v2 = [v1[0], v1[1], v1[2], clause('general', junk)]
    const { findings, changedClauseIds } = review(v2, v1)
    const unreadable = findings.find(f => f.kind === 'unreadable_text')
    expect(unreadable).toMatchObject({ severity: 'high', clauseId: v2[3].id, evidence: { quote: 'asdkjh qwpoeiru zxmcnvb lkjasd' } })
    expect(findings.find(f => f.kind === 'modified')).toMatchObject({ clauseId: v2[3].id, evidence: { quote: junk, baselineQuote: MISC } })
    expect(changedClauseIds).toEqual([v2[3].id])
    expect(label(findings).label).toBe('review')
  })

  it('junk as a paragraph of its own is found too', () => {
    const v1 = [clause('confidentiality', CONF), clause('governing_law', GOV), clause('termination', TERM)]
    const { findings } = review(v1.map(c => ({ ...c })), v1, { currentText: `${textOf(v1)}\n\nfghjkl xcvbnm` })
    expect(findings.map(f => f.kind)).toEqual(['unreadable_text'])
  })

  it('an ordinary edit is not junk', () => {
    const v1 = [clause('confidentiality', CONF), clause('governing_law', GOV), clause('termination', TERM)]
    const edited = clause('termination', `${TERM} Property, liberty and certainty of HIPAA and GDPR obligations survive.`)
    const { findings } = review([v1[0], v1[1], edited], v1)
    expect(findings.map(f => f.kind)).toEqual(['modified'])
  })
})

describe('golden: never analysed', () => {
  it("is Can't recommend, with the reason", () => {
    const r = policy({ analysis: { kind: 'not_analysed', reason: null }, clauseCount: 0, riskScore: null, findings: [], counterpartyVersionAfterAnalysis: null })
    expect(r.label).toBe('cant_recommend')
    expect(r.reasons.map(x => x.text)).toEqual(['this contract has not been analysed', 'its risk score is unknown'])
  })

  it('stale, failed, running and empty analyses are Can\'t recommend too; an unknown risk score is never Ready', () => {
    const base = { clauseCount: 3, riskScore: 0.1, findings: [], counterpartyVersionAfterAnalysis: null }
    expect(policy({ ...base, analysis: { kind: 'stale', analysedVersionId: 'v1', analysedVersionNumber: 1 } }).label).toBe('cant_recommend')
    expect(policy({ ...base, analysis: { kind: 'failed', error: 'x' } }).label).toBe('cant_recommend')
    expect(policy({ ...base, analysis: { kind: 'running', status: 'EXTRACTING' } }).label).toBe('cant_recommend')
    expect(policy({ ...base, analysis: done, clauseCount: 0 }).label).toBe('cant_recommend')
    expect(policy({ ...base, analysis: done, riskScore: null })).toMatchObject({ label: 'review', reasons: [{ code: 'risk_unknown' }] })
    expect(policy({ ...base, analysis: done, counterpartyVersionAfterAnalysis: { versionNumber: 3 } }).label).toBe('review')
  })
})

describe('golden: positions', () => {
  const POSITIONS = [
    { id: 'p-pref', clauseCategoryId: 'cat-conf', positionType: 'preferred', content: 'Five years.', rules: null },
    { id: 'p-fb', clauseCategoryId: 'cat-conf', positionType: 'fallback', content: 'Three years.', rules: null },
    { id: 'p-walk', clauseCategoryId: 'cat-conf', positionType: 'walkaway', content: 'Under one year.', rules: null },
  ]
  const v1 = [clause('confidentiality', CONF), clause('governing_law', GOV), clause('termination', TERM)]
  const changed = (verdict: ClauseIn['positionVerdict']) => [clause('confidentiality', `${CONF} These obligations last three years.`, { positionVerdict: verdict }), v1[1], v1[2]]

  it('a clause at your fallback position is "Fallback", the change is settled, and it is still Ready', () => {
    const { findings } = review(changed({ positionId: 'p-fb', verdict: 'meets_fallback', quote: 'last three years', explanation: 'Three years is your fallback.' }), v1, { positions: POSITIONS })
    const fallback = findings.find(f => f.kind === 'position_fallback')
    expect(fallback).toMatchObject({ severity: 'low', source: 'llm', positionId: 'p-fb', title: 'Confidentiality: your fallback position', evidence: { quote: 'last three years' } })
    expect(findings.find(f => f.kind === 'modified')).toMatchObject({ status: 'resolved', resolutionNote: 'Matches your fallback position.' })
    const r = label(findings)
    expect(r.label).toBe('ready_to_approve')
    expect(r.reasons[0].text).toBe('1 clause is at a fallback position your playbook allows')
  })

  it('a position that needs approval is Needs exception', () => {
    const { findings } = review(changed({ positionId: 'p-fb', verdict: 'needs_approval', quote: 'last three years', explanation: 'Worse than your fallback.' }), v1, { positions: POSITIONS })
    expect(findings.find(f => f.kind === 'needs_approval_position')).toMatchObject({ severity: 'high', title: 'Confidentiality: a position that needs approval' })
    expect(label(findings).label).toBe('needs_exception')
  })

  it('past a walkaway position is critical, and Escalate', () => {
    const { findings } = review(changed({ positionId: 'p-walk', verdict: 'not_met', quote: 'last three years', explanation: 'Below your walkaway.' }), v1, { positions: POSITIONS })
    expect(findings.find(f => f.kind === 'position_not_met')).toMatchObject({ severity: 'critical' })
    expect(label(findings).label).toBe('escalate')
  })

  it('an accepted finding no longer holds it back', () => {
    const { findings } = review(changed({ positionId: 'p-fb', verdict: 'needs_approval', quote: 'last three years', explanation: 'x' }), v1, { positions: POSITIONS })
    const decided = asPolicy(findings).map(f => ({ ...f, status: f.kind === 'needs_approval_position' || f.kind === 'modified' ? 'accepted' : f.status }))
    expect(policy({ analysis: done, clauseCount: 3, riskScore: 0.1, findings: decided, counterpartyVersionAfterAnalysis: null }).label).toBe('ready_to_approve')
  })

  it("a rule your playbook sets is checked on every clause, without a model", () => {
    const positions = [{ id: 'p-r', clauseCategoryId: 'cat-gov', positionType: 'preferred', content: '', rules: { must_not: [{ id: 'no-de', description: 'No Delaware law', check: 'contains', value: 'Delaware', severity: 'high' }] } }]
    const de = clause('governing_law', 'This Agreement is governed by the laws of Delaware.')
    const { findings } = review([clause('confidentiality', CONF), de, clause('termination', TERM)], null, { positions })
    expect(findings).toEqual([expect.objectContaining({ kind: 'position_not_met', key: 'rule|cat-gov|no-de', clauseId: de.id, source: 'deterministic', title: 'Governing Law: No Delaware law', evidence: expect.objectContaining({ quote: 'This Agreement is governed by the laws of Delaware.' }) })])
  })
})

describe('required clauses', () => {
  it('a required clause never found is "not detected", which on its own asks for review, not an exception', () => {
    const { findings } = review([clause('confidentiality', CONF), clause('termination', TERM)], null)
    expect(findings).toEqual([expect.objectContaining({ kind: 'missing_required', title: 'Governing Law — not detected', severity: 'medium' })])
    expect(label(findings).label).toBe('review')
  })
})

describe('pairing clauses', () => {
  it('pairs by type and words, so a reordered contract has no changes', () => {
    const a = [clause('confidentiality', CONF), clause('governing_law', GOV)]
    const b = [clause('governing_law', GOV), clause('confidentiality', CONF)]
    const { pairs, gone, added } = pairClauses(a, b)
    expect(pairs).toHaveLength(2)
    expect(gone).toEqual([])
    expect(added).toEqual([])
  })
})
