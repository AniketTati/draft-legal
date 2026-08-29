/**
 * Tests for the embeddings provider routing + reranker fallback (P7.7.1).
 *
 * Network-dependent code (actual Voyage / OpenAI calls) is exercised
 * via scripts/archive/p77-1-verify.mjs when keys are present; these unit tests
 * cover only the pure logic that we don't want to break silently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { activeEmbedProvider, rerankClauses } from './embeddings.js'

describe('activeEmbedProvider', () => {
  const originalVoyage = process.env.VOYAGE_API_KEY
  const originalOpenAI = process.env.OPENAI_API_KEY

  beforeEach(() => {
    delete process.env.VOYAGE_API_KEY
    delete process.env.OPENAI_API_KEY
  })
  afterEach(() => {
    if (originalVoyage) process.env.VOYAGE_API_KEY = originalVoyage
    else delete process.env.VOYAGE_API_KEY
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI
    else delete process.env.OPENAI_API_KEY
  })

  it('prefers voyage when both keys are set', () => {
    process.env.VOYAGE_API_KEY = 'test-voyage'
    process.env.OPENAI_API_KEY = 'test-openai'
    expect(activeEmbedProvider()).toBe('voyage')
  })

  it('falls back to openai when only that key is set', () => {
    process.env.OPENAI_API_KEY = 'test-openai'
    expect(activeEmbedProvider()).toBe('openai')
  })

  it('throws when no key is configured', () => {
    expect(() => activeEmbedProvider()).toThrow(/No embedding provider configured/)
  })
})

describe('rerankClauses fallback', () => {
  const original = process.env.VOYAGE_API_KEY

  beforeEach(() => { delete process.env.VOYAGE_API_KEY })
  afterEach(() => {
    if (original) process.env.VOYAGE_API_KEY = original
    else delete process.env.VOYAGE_API_KEY
  })

  it('returns identity ordering when no Voyage key is set', async () => {
    const r = await rerankClauses(
      'liability cap',
      [
        { ref: 'a', text: 'apple text' },
        { ref: 'b', text: 'banana text' },
        { ref: 'c', text: 'cherry text' },
      ],
    )
    expect(r.map(x => x.ref)).toEqual(['a', 'b', 'c'])
    // Scores should be monotonically decreasing
    expect(r[0].score).toBeGreaterThan(r[1].score)
    expect(r[1].score).toBeGreaterThan(r[2].score)
  })

  it('respects topK in fallback', async () => {
    const r = await rerankClauses(
      'q',
      [
        { ref: 1, text: 'a' },
        { ref: 2, text: 'b' },
        { ref: 3, text: 'c' },
      ],
      2,
    )
    expect(r.length).toBe(2)
  })

  it('handles empty input gracefully', async () => {
    const r = await rerankClauses('q', [])
    expect(r).toEqual([])
  })
})
