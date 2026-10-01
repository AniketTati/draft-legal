/**
 * docs/41 Part 10 — the canvas reads defined terms in curly quotes too (the
 * first version matched straight quotes only and missed DOCX contracts), and
 * flags a lower-case one-word term only where the sentence points at it.
 */
import { describe, it, expect } from 'vitest'
import { extractTerms, findFlags, findUses } from './DefinedTermGuard'

describe('extractTerms', () => {
  it('reads curly and straight quotes', () => {
    const text = 'Acme Inc. (the “Supplier”) and Beta (“Customer”). “Confidential Information” means secrets. "Fees" shall mean the charges.'
    expect(extractTerms(text).map(t => t.term)).toEqual(['Supplier', 'Customer', 'Confidential Information', 'Fees'])
  })

  it('points at the term in the text', () => {
    const text = 'Beta Ltd (the “Customer”) buys.'
    const [t] = extractTerms(text)
    expect(text.slice(t.index, t.index + t.term.length)).toBe('Customer')
  })
})

describe('findFlags', () => {
  it('flags a multi-word term in another case, and a one-word term only after "the"', () => {
    const text = 'Keep the confidential information safe. Other services are extra. Pay for the services.'
    const flags = findFlags(text, ['Confidential Information', 'Services'])
    expect(flags.map(f => f.found)).toEqual(['confidential information', 'services'])
    expect(flags[1].from).toBe(text.lastIndexOf('services'))
  })

  it('leaves the term\'s own definition alone', () => {
    const text = '“Services” means the services in Schedule 1. Pay for the services.'
    expect(findFlags(text, ['Services']).map(f => f.from)).toEqual([text.lastIndexOf('services')])
  })

  it('leaves capitals alone (headings)', () => {
    expect(findFlags('SERVICES. The Services start now.', ['Services'])).toEqual([])
  })
})

describe('findUses', () => {
  it('finds uses, longest term first', () => {
    const uses = findUses('The Customer Data of the Customer.', ['Customer', 'Customer Data'])
    expect(uses.map(u => u.term).sort()).toEqual(['Customer', 'Customer Data'])
    expect(uses.find(u => u.term === 'Customer')!.from).toBe('The Customer Data of the '.length)
  })
})
