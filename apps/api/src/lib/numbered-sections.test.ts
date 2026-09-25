/**
 * Z9 — clause rows for the AI-demo contracts come from their numbered
 * sections (numbered-sections.ts), typed with the review agent's clause types.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { numberedSections, clauseTypeOfHeading } from './numbered-sections.js'

const FIXTURES = join(__dirname, '..', '..', 'scripts', 'fixtures', 'ai-demo')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
/** The fixtures seed-ai-demo.ts loads. */
const seeded = [...readFileSync(join(__dirname, '..', '..', 'scripts', 'seed-ai-demo.ts'), 'utf8').matchAll(/fixture: '([^']+)'/g)].map(m => m[1])

describe('numberedSections', () => {
  it('splits at numbered headings, keeping each heading with its text', () => {
    const text = 'MASTER AGREEMENT\nPreamble text.\n\n1. PAYMENT\n1.1 Net 30.\n\n2. LIMITATION OF LIABILITY\nCapped at fees paid.\n'
    expect(numberedSections(text)).toEqual([
      { number: '1', heading: 'PAYMENT', content: '1. PAYMENT\n1.1 Net 30.', clauseType: 'payment' },
      { number: '2', heading: 'LIMITATION OF LIABILITY', content: '2. LIMITATION OF LIABILITY\nCapped at fees paid.', clauseType: 'limitation_of_liability' },
    ])
  })

  it('reads the specific type before the general one', () => {
    expect(clauseTypeOfHeading('UNCAPPED LIABILITY')).toBe('uncapped_liability')
    expect(clauseTypeOfHeading('AUTO-RENEWAL')).toBe('auto_renewal')
    expect(clauseTypeOfHeading('TERMINATION FOR CONVENIENCE')).toBe('termination')
    expect(clauseTypeOfHeading('SIGNATURES')).toBe('general')
  })

  it('gives every seeded AI-demo contract its sections, and the MSA its liability clause', () => {
    expect(seeded.length).toBeGreaterThan(3)
    for (const name of seeded) {
      const sections = numberedSections(fixture(name))
      expect(sections.length, name).toBeGreaterThanOrEqual(5)
      expect(sections.some(s => s.clauseType !== 'general'), name).toBe(true)
    }
    // seed-playbook-rules.ts checks the MSA's §9 against the liability playbook.
    expect(numberedSections(fixture('msa-acme.txt')).find(s => s.number === '9')?.clauseType).toBe('limitation_of_liability')
    expect(readdirSync(FIXTURES)).toEqual(expect.arrayContaining(seeded))
  })
})

describe('slidingWindowChunks (legal-chunker.ts)', () => {
  it('ends on a long clause, covering all of it once', async () => {
    const { slidingWindowChunks } = await import('./legal-chunker.js')
    const clause = Array.from({ length: 60 }, (_, i) => `Sentence ${i} of a long limitation of liability clause.`).join(' ')
    expect(clause.length).toBeGreaterThan(2_000)
    const chunks = slidingWindowChunks(clause)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.length).toBeLessThan(10)
    expect(chunks.at(-1)!.charEnd).toBe(clause.length)
  })
})
