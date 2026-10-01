import { describe, it, expect } from 'vitest'
import { RESET_MODES, readResetRule } from '@clm/types'
import { RESET_MODE_LABEL, resetOnForMode, resetRuleProblem, toggleResetItem } from './reset-rule-form'

describe('"Ask again after a change" on a workflow step (docs/41 Part 18)', () => {
  it('names every mode in plain words, "After any change" first (the default)', () => {
    expect(RESET_MODES.map(m => RESET_MODE_LABEL[m])).toEqual(['After any change', 'When the document changes', 'When these clauses change', 'When these fields change', 'Never'])
    expect(readResetRule(undefined).mode).toBe('always')
  })
  it('stores a word for the plain modes, and a list for the two that name things', () => {
    expect(resetOnForMode('never', undefined)).toBe('never')
    expect(resetOnForMode('clause_text_changes', 'always')).toEqual({ mode: 'clause_text_changes', clauseTypes: [] })
    expect(resetOnForMode('fields', { mode: 'fields', fields: ['value'] })).toEqual({ mode: 'fields', fields: ['value'] })
  })
  it('adds and takes off clause types and fields', () => {
    const on = toggleResetItem({ mode: 'clause_text_changes', clauseTypes: [] }, 'governing_law')
    expect(on).toEqual({ mode: 'clause_text_changes', clauseTypes: ['governing_law'] })
    expect(toggleResetItem(on, 'governing_law')).toEqual({ mode: 'clause_text_changes', clauseTypes: [] })
  })
  it('asks for at least one field, as the server does; no clause types means any clause', () => {
    expect(resetRuleProblem({ mode: 'fields', fields: [] })).toBe('Pick at least one field.')
    expect(resetRuleProblem({ mode: 'fields', fields: ['currency'] })).toBeNull()
    expect(resetRuleProblem({ mode: 'clause_text_changes', clauseTypes: [] })).toBeNull()
  })
})
