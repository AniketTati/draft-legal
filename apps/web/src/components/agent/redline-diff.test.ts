import { describe, it, expect } from 'vitest'
import { redlineDiff, type RedlineProposal, type RedlineVariant } from './RedlinePreview'

const proposal = {
  contract: { id: 'c1', title: 'MSA' },
  clause: { id: 'k1', clauseType: 'governing_law', sectionRef: '7', originalText: 'Governed by the laws of Delaware.' },
  variants: [],
} as unknown as RedlineProposal

describe('the confirm card for a redline (CC8)', () => {
  it('shows the edits it will make, not "original → rewritten"', () => {
    const variant = { aggression: 'moderate', proposedText: 'Governed by the laws of New York.', changes: [{ before: 'Delaware', after: 'New York', reason: 'x' }] } as RedlineVariant
    expect(redlineDiff(proposal, variant)).toEqual([{ field: 'change', before: 'Delaware', after: 'New York' }])
  })

  it('shows the clause before and after when there are no edits listed', () => {
    const variant = { aggression: 'least', proposedText: 'Governed by the laws of New York.', changes: [] } as unknown as RedlineVariant
    expect(redlineDiff(proposal, variant)).toEqual([{ field: 'clause', before: 'Governed by the laws of Delaware.', after: 'Governed by the laws of New York.' }])
  })
})
