/**
 * docs/41 P1 (Part 3) — which playbook applies is decided in code, in a
 * fixed order, and says why.
 */
import { describe, it, expect } from 'vitest'
import { choosePlaybook, type PlaybookSummary } from './playbooks.js'

const pb = (id: string, contractTypes: string[], isDefaultForType = false): PlaybookSummary => ({ id, name: id, contractTypes, isDefaultForType, version: 1 })

describe('choosePlaybook', () => {
  it('uses the one chosen on the contract first', () => {
    const r = choosePlaybook([pb('Sales NDA', ['NDA'], true), pb('Vendor NDA', ['NDA'])], 'NDA', 'Vendor NDA')
    expect(r).toMatchObject({ why: 'explicit', playbook: { id: 'Vendor NDA' } })
  })

  it('then the default naming the type, before an all-types default', () => {
    const r = choosePlaybook([pb('Default', [], true), pb('Sales NDA', ['NDA'], true), pb('Vendor NDA', ['NDA'])], 'NDA', null)
    expect(r).toMatchObject({ why: 'default_for_type', playbook: { id: 'Sales NDA' } })
    expect(r.explanation).toBe('3 playbooks apply — using Sales NDA (the default for NDA contracts).')
    expect(choosePlaybook([pb('Default', [], true), pb('Sales NDA', ['NDA'], true)], 'MSA', null)).toMatchObject({ why: 'default_for_type', playbook: { id: 'Default' } })
  })

  it('then the only one covering the type', () => {
    expect(choosePlaybook([pb('Sales NDA', ['NDA']), pb('MSA', ['MSA'])], 'NDA', null)).toMatchObject({ why: 'only_one', playbook: { id: 'Sales NDA' } })
  })

  it('asks when several apply and none is the default, and says when none does', () => {
    const r = choosePlaybook([pb('A', ['NDA']), pb('B', [])], 'NDA', null)
    expect(r).toMatchObject({ why: 'ambiguous', playbook: null })
    expect(r.candidates.map(c => c.id)).toEqual(['A', 'B'])
    expect(choosePlaybook([pb('A', ['MSA'])], 'NDA', null)).toMatchObject({ why: 'none', playbook: null, explanation: 'No playbook covers NDA contracts.' })
  })

  it('a deleted (unknown) explicit choice falls back to the rules', () => {
    expect(choosePlaybook([pb('A', ['NDA'])], 'NDA', 'gone')).toMatchObject({ why: 'only_one', playbook: { id: 'A' } })
  })
})
