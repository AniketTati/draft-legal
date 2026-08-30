import { describe, it, expect } from 'vitest'
import { topicPhrases, findTopic } from './clause-topic.js'

// A realistic fragment: the clause is present, but never under the name an
// agent searches for. This is the exact shape that made portfolio_compare
// report `found: false` on all six cells of a real comparison.
const MSA = `MASTER SERVICES AGREEMENT

3. FEES AND PAYMENT
Customer shall pay each invoice within thirty (30) (net 30) days of receipt.

9. LIMITATION OF LIABILITY
In no event shall either party's aggregate liability under this Agreement
exceed the fees paid in the twelve (12) months preceding the claim.

12. TERMINATION FOR CONVENIENCE
Either party may terminate this Agreement on sixty (60) days prior written
notice. This Agreement shall automatically renew for successive twelve month
renewal terms unless either party gives notice.`

describe('topicPhrases', () => {
  it('expands a known topic to the phrases contracts actually use', () => {
    expect(topicPhrases('liability cap')).toContain('limitation of liability')
  })

  it('always includes the literal topic, so it can only ever match more', () => {
    expect(topicPhrases('liability cap')).toContain('liability cap')
    expect(topicPhrases('some bespoke topic')).toEqual(['some bespoke topic'])
  })

  it('normalises case, hyphens and underscores to one key', () => {
    expect(topicPhrases('Governing_Law')).toEqual(topicPhrases('governing law'))
    expect(topicPhrases('Auto-Renew')).toContain('automatic renewal')
  })

  it('falls back to the singular — agents pluralise inconsistently', () => {
    // "liability caps" was a real agent-generated topic that found nothing.
    expect(topicPhrases('liability caps')).toContain('limitation of liability')
  })
})

describe('findTopic', () => {
  // ── The regression this module exists for ────────────────────────────────
  it('finds a liability clause searched for as "liability cap"', () => {
    const hit = findTopic(MSA, 'liability cap')
    expect(hit).not.toBeNull()
    expect(hit!.matchedPhrase).toBe('limitation of liability')
  })

  it('finds termination searched for as "termination rights"', () => {
    const hit = findTopic(MSA, 'termination rights')
    expect(hit).not.toBeNull()
    expect(MSA.slice(hit!.index).toLowerCase()).toMatch(/^termination for convenience/)
  })

  it('finds auto-renewal phrased as "automatically renew"', () => {
    expect(findTopic(MSA, 'auto-renew')).not.toBeNull()
  })

  it('finds payment terms phrased as "net 30"', () => {
    expect(findTopic(MSA, 'payment terms')).not.toBeNull()
  })

  it('returns the EARLIEST match, so the excerpt lands on the heading', () => {
    // "limitation of liability" (the section 9 heading) precedes "aggregate
    // liability" in the body. Alias order lists them the other way round, so
    // this only passes if position wins over alias order.
    const hit = findTopic(MSA, 'liability cap')!
    expect(hit.index).toBe(MSA.toLowerCase().indexOf('limitation of liability'))
  })

  it('honours fromIndex, so the caller can walk every occurrence', () => {
    const first = findTopic(MSA, 'termination')!
    const second = findTopic(MSA, 'termination', first.index + 1)
    expect(second === null || second.index > first.index).toBe(true)
  })

  it('still returns null when the clause genuinely is absent', () => {
    // The point of the fix is fewer false absences, not zero absences: a tool
    // that never says "not found" is as useless as one that always does.
    expect(findTopic(MSA, 'force majeure')).toBeNull()
  })

  it('matches an exact literal query unchanged (old behaviour preserved)', () => {
    const hit = findTopic(MSA, 'MASTER SERVICES AGREEMENT')
    expect(hit?.index).toBe(0)
  })
})
