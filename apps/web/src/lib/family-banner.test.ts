import { describe, it, expect } from 'vitest'
import { familyLine } from './family-banner'

const parent = { id: 'p', title: 'Master Agreement' }

describe('familyLine (docs/41 P0.9)', () => {
  it('only a contract the binder split carved out says it was split', () => {
    expect(familyLine({ parent, relationshipType: 'split_part', splitFromParent: true, siblings: [{}, {}] }))
      .toEqual({ kind: 'split', lead: 'Split from scanned file', note: '3 agreements were in that file' })
  })
  it('an amendment says what it amends — never "binder"', () => {
    expect(familyLine({ parent, relationshipType: 'amendment', splitFromParent: false })).toEqual({ kind: 'amendment', lead: 'Amendment to', note: null })
  })
  it('a numbered amendment says its number (docs/41 Part 13)', () => {
    expect(familyLine({ parent, relationshipType: 'amendment', label: 'Amendment No. 2' })?.lead).toBe('Amendment No. 2 to')
    expect(familyLine({ parent, relationshipType: 'sow', label: 'SOW #3' })?.lead).toBe('SOW #3 under')
  })
  it('an exhibit attached by hand, or any other child, is linked', () => {
    expect(familyLine({ parent, relationshipType: 'exhibit', splitFromParent: false })?.kind).toBe('linked')
    expect(familyLine({ parent, relationshipType: 'sow' })?.lead).toBe('Linked to')
  })
  it('no parent, no line', () => {
    expect(familyLine({ parent: null })).toBeNull()
    expect(familyLine(undefined)).toBeNull()
  })
})
