/**
 * docs/41 Part 13 — the deterministic parts of an amendment: its operative
 * words, the relationship spellings, the effective view, the redline and the
 * obligations a replaced clause takes with it.
 */
import { describe, it, expect, vi } from 'vitest'
vi.mock('./prisma.js', () => ({ prisma: {} }))
vi.mock('./clause-propose.js', () => ({ proposeClauseAlternatives: vi.fn() }))
import { normaliseRelationshipType, familyLabel, familyShortLabel, type AmendmentChangeSpec } from '@clm/types'
import {
  amendmentHtml, amendmentRedlineItems, changeSentence, obligationsReplaced, proposedTextsFromHtml, redlineSegments, sectionName,
} from './amendments.js'
import { assembleEffectiveView } from './family.js'

const fees: AmendmentChangeSpec = {
  kind: 'clause', clauseId: 'c5', clauseType: 'payment_terms', sectionRef: '§5', parentText: 'Fees are $100 per month, payable in 30 days.',
  newText: 'Fees are $120 per month, payable in 45 days.', action: 'replace', source: 'ai',
}

describe('relationship types', () => {
  it('reads older spellings as the relationship they meant', () => {
    expect(normaliseRelationshipType('exhibit_only')).toBe('exhibit')
    expect(normaliseRelationshipType('Statement of Work')).toBe('sow')
    expect(normaliseRelationshipType('addendum')).toBe('amendment')
    expect(normaliseRelationshipType('whatever')).toBe('other')
    expect(normaliseRelationshipType('')).toBeNull()
  })
  it('names numbered members', () => {
    expect(familyLabel('amendment', 2)).toBe('Amendment No. 2')
    expect(familyLabel('sow', 3)).toBe('SOW #3')
    expect(familyLabel('exhibit', 1)).toBeNull()
    expect(familyShortLabel('amendment', 1)).toBe('A1')
  })
})

describe('operative words', () => {
  it('names a section by its number, else by its type', () => {
    expect(sectionName('§5', 'payment_terms')).toBe('Section 5')
    expect(sectionName('5.1', 'x')).toBe('Section 5.1')
    expect(sectionName(null, 'limitation_of_liability')).toBe('the limitation of liability clause')
  })
  it('writes a replace, a delete and a term change', () => {
    expect(changeSentence(fees)).toBe('Section 5 of the Agreement is deleted in its entirety and replaced with the following:')
    expect(changeSentence({ ...fees, action: 'delete', newText: '' })).toBe('Section 5 of the Agreement is deleted in its entirety.')
    expect(changeSentence({ kind: 'term', key: 'expiryDate', label: 'Expiry date', from: '2025-12-31', to: '2026-12-31', source: 'user' }))
      .toBe('The Expiry date is amended to read: 2026-12-31.')
  })
  it('builds the document with the new words marked as the AI draft, escaped', () => {
    const html = amendmentHtml({
      label: 'Amendment No. 1', parentTitle: 'Master <Services>', parentEffectiveDate: '2024-01-01', counterpartyName: 'Acme',
      effectiveDate: '2024-07-01', changes: [fees],
    })
    expect(html).toContain('<h1>Amendment No. 1 to Master &lt;Services&gt;</h1>')
    expect(html).toContain('July 1, 2024')
    expect(html).toContain('data-amendment-text="0" data-ai-suggested="true"')
    expect(html).toContain('remains in full force and effect')
  })
})

describe('effective view', () => {
  const clauses = [
    { id: 'c1', clauseType: 'term', sectionRef: '§1', content: 'Term is one year.' },
    { id: 'c5', clauseType: 'payment_terms', sectionRef: '§5', content: fees.parentText },
  ]
  it('applies signed amendments in order and marks the section', () => {
    const r = assembleEffectiveView(clauses, [
      { id: 'a1', title: 'A1', number: 1, relationshipType: 'amendment', effectiveDate: '2024-07-01', signed: true, changes: [fees] },
      { id: 'a2', title: 'A2', number: 2, relationshipType: 'amendment', effectiveDate: null, signed: false, changes: [{ ...fees, newText: 'unsigned' }] },
    ])
    const s = r.sections.find(x => x.clauseId === 'c5')!
    expect(s.text).toBe(fees.newText)
    expect(s.originalText).toBe(fees.parentText)
    expect(s.amendedBy).toEqual([{ contractId: 'a1', label: 'Amendment No. 1', short: 'A1', effectiveDate: '2024-07-01', action: 'replace' }])
    expect(r.sections[0].amendedBy).toEqual([])
  })
  it('places a change by section number when the clause id moved, else lists it', () => {
    const r = assembleEffectiveView(clauses, [
      { id: 'a1', title: 'A1', number: 1, relationshipType: 'amendment', effectiveDate: null, signed: true, changes: [
        { ...fees, clauseId: 'gone' }, { ...fees, clauseId: 'gone', sectionRef: '§9' },
      ] },
    ])
    expect(r.sections[1].text).toBe(fees.newText)
    expect(r.unplaced).toHaveLength(1)
  })
})

describe('amendment redline', () => {
  it('marks words deleted and inserted, runs merged', () => {
    const segs = redlineSegments('Fees are $100 per month.', 'Fees are $120 per month.')
    expect(segs).toEqual([
      { op: 'equal', text: 'Fees are ' }, { op: 'delete', text: '$100 ' }, { op: 'insert', text: '$120 ' }, { op: 'equal', text: 'per month.' },
    ])
  })
  it('reads the words a person edited from the document', () => {
    const m = proposedTextsFromHtml('<blockquote data-amendment-text="0" data-ai-suggested="true"><p>One &amp; two</p><p>Three</p></blockquote>')
    expect(m.get(0)).toBe('One & two\n\nThree')
  })
  it('compares the effective words with the edited ones', () => {
    const items = amendmentRedlineItems([fees], () => 'Fees are $110 per month, payable in 30 days.', new Map([[0, 'Fees are $130 per month, payable in 45 days.']]))
    expect(items[0]).toMatchObject({ name: 'Section 5', action: 'replace', current: 'Fees are $110 per month, payable in 30 days.', proposed: 'Fees are $130 per month, payable in 45 days.' })
    expect(items[0].segments.some(s => s.op === 'delete' && s.text.includes('$110'))).toBe(true)
  })
  it('falls back to the words recorded at drafting', () => {
    const [it0] = amendmentRedlineItems([{ ...fees, action: 'delete', newText: '' }], () => null, new Map())
    expect(it0.current).toBe(fees.parentText)
    expect(it0.proposed).toBe('')
  })
})

describe('obligations a replaced clause takes with it', () => {
  it('matches by section number or by quote inside the clause', () => {
    const obs = [
      { id: 'o1', sectionRef: 'Section 5', quote: 'x' },
      { id: 'o2', sectionRef: null, quote: 'payable in 30 days' },
      { id: 'o3', sectionRef: null, quote: 'payable in 30 days.' + ' something else entirely here' },
      { id: 'o4', sectionRef: '§7', quote: 'Notice must be given in writing.' },
    ]
    expect(obligationsReplaced(obs, [fees]).map(o => o.id)).toEqual(['o1'])
    expect(obligationsReplaced([{ id: 'o5', sectionRef: null, quote: 'Fees are $100 per month' }], [fees]).map(o => o.id)).toEqual(['o5'])
  })
})
