/**
 * docs/41 Part 13 — the deterministic parts of an amendment: its operative
 * words, the relationship spellings, the effective view, the redline and the
 * obligations a replaced clause takes with it.
 */
import { describe, it, expect, vi } from 'vitest'
vi.mock('./prisma.js', () => ({ prisma: {} }))
import { normaliseRelationshipType, familyLabel, familyShortLabel, type AmendmentChangeSpec } from '@clm/types'
import {
  amendmentHtml, amendmentRedlineItems, changeSentence, closingAfterChanges, obligationsReplaced, proposedTextsFromDocument, proposedTextsFromHtml,
  redlineSegments, sectionName,
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

describe('the words being signed, after the editor saved (fix-up 14)', () => {
  const term: AmendmentChangeSpec = { kind: 'term', key: 'expiryDate', label: 'Expiry date', from: '2025-12-31', to: '2027-12-31', source: 'user' }
  const notice: AmendmentChangeSpec = { ...fees, clauseId: 'c9', clauseType: 'termination', sectionRef: '9', newText: 'Either party may end this on 60 days notice.' }
  const drafted = amendmentHtml({ label: 'Amendment No. 1', parentTitle: 'MSA', parentEffectiveDate: null, counterpartyName: null, effectiveDate: null, changes: [fees, term, notice] })
  // What a TipTap save leaves: the blockquote, without its data-* attributes.
  const saved = (html: string) => html.replace(/ data-amendment-[a-z]+="\d+"/g, '').replace(/ data-ai-suggested="true"/g, '')

  it('reads the marker while the document keeps it', () => {
    expect(proposedTextsFromDocument([fees, term, notice], drafted).get(0)).toBe(fees.newText)
  })
  it('finds the words after the change’s own sentence once the marker is gone', () => {
    const html = saved(drafted).replace('payable in 45 days', 'payable in 60 days')
    expect(html).not.toContain('data-amendment-text')
    const m = proposedTextsFromDocument([fees, term, notice], html)
    expect(m.get(0)).toBe('Fees are $120 per month, payable in 60 days.')
    expect(m.get(2)).toBe(notice.newText)
    expect(m.has(1)).toBe(false)
  })
  it('reads suggestions as accepted, and a quote turned into paragraphs', () => {
    const html = saved(drafted)
      .replace('payable in 45 days', 'payable in <del data-change-id="s1">45</del><ins data-change-id="s1">50</ins> days')
      .replace(/<\/?blockquote>/g, '')
    const m = proposedTextsFromDocument([fees, term, notice], html)
    expect(m.get(0)).toBe('Fees are $120 per month, payable in 50 days.')
  })
  it('stops at a reworded change and at the block that followed the changes in a template', () => {
    const tpl = `<h1>Amendment</h1><p><strong>1.</strong> Section 5 of the Agreement is deleted in its entirety and replaced with the following:</p><p>New fees.</p><p>Second paragraph.</p><h2>Signatures</h2><p>Signed by the parties</p>`
    const endsBefore = closingAfterChanges(tpl.replace('New fees.</p><p>Second paragraph.', 'X'), [{ ...fees, newText: 'X' }])
    expect(endsBefore).toBe('signatures')
    expect(proposedTextsFromDocument([fees], tpl, { endsBefore }).get(0)).toBe('New fees.\n\nSecond paragraph.')
    const reworded = `<p>1. Section 5 of the Agreement is replaced by:</p><p>New fees.</p><p>2. The Expiry date is amended to read: 2028.</p>`
    expect(proposedTextsFromDocument([fees, term], reworded).get(0)).toBe('New fees.')
  })
  it('reads a document that only has plain text', () => {
    const plain = '1. Section 5 of the Agreement is deleted in its entirety and replaced with the following:\n\nNew fees.\n\nExcept as amended by this Amendment, the Agreement remains in force.'
    expect(proposedTextsFromDocument([fees], null, { plainText: plain }).get(0)).toBe('New fees.')
  })
})
