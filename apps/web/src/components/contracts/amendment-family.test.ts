/**
 * docs/41 Part 13 — what the amendment dialog sends, and how big a family is.
 */
import { describe, it, expect } from 'vitest'
import { changesPayload, type ChangeDraft } from './AmendmentChangesPicker'
import { familySize, type FamilyMember } from './FamilyPanel'

const clause = (over: Partial<Extract<ChangeDraft, { kind: 'clause' }>> = {}): ChangeDraft => ({
  kind: 'clause', clauseId: 'c5', name: 'Section 5', parentText: 'Old', action: 'replace', newText: 'New words', instruction: '45 days', source: 'ai', quote: null, note: null, ...over,
})

describe('changesPayload', () => {
  it('sends a replace with its words, a delete without, and a term with its new value', () => {
    expect(changesPayload([clause(), clause({ clauseId: 'c6', action: 'delete', newText: '' }), { kind: 'term', key: 'expiryDate', label: 'Expiry date', from: '2025-12-31', to: ' 2027-12-31 ' }])).toEqual([
      { kind: 'clause', clauseId: 'c5', action: 'replace', newText: 'New words', source: 'ai', instruction: '45 days' },
      { kind: 'clause', clauseId: 'c6', action: 'delete', newText: undefined, source: 'ai', instruction: '45 days' },
      { kind: 'term', key: 'expiryDate', label: 'Expiry date', from: '2025-12-31', to: '2027-12-31' },
    ])
  })
  it('is not ready while a replace has no words or a term no value', () => {
    expect(changesPayload([clause({ newText: '  ' })])).toBeNull()
    expect(changesPayload([{ kind: 'term', key: 'k', label: 'K', from: null, to: '' }])).toBeNull()
  })
})

describe('familySize', () => {
  const m = (id: string, children: FamilyMember[] = []): FamilyMember => ({
    id, title: id, status: 'DRAFT', stage: 'draft', relationshipType: 'amendment', number: 1, label: null, effectiveDate: null, signed: false, changesTerms: true, children,
  })
  it('counts every member below the top agreement', () => {
    expect(familySize(m('msa'))).toBe(0)
    expect(familySize(m('msa', [m('a1'), m('sow', [m('co1')])]))).toBe(3)
  })
})
