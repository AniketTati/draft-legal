import { describe, it, expect } from 'vitest'
import { diffSequences, wordEdits, applyTextEdits, fold } from './sequence-diff.js'

/** A seeded generator, so a failure repeats. */
function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
}

function lcsLength(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1])
  }
  return t[a.length][b.length]
}

describe('diffSequences', () => {
  it('rebuilds both sides, keeping as much in common as can be kept', () => {
    const r = rng(7)
    for (let n = 0; n < 400; n++) {
      const a = Array.from({ length: Math.floor(r() * 30) }, () => 'abcde'[Math.floor(r() * 5)])
      const b = Array.from({ length: Math.floor(r() * 30) }, () => 'abcde'[Math.floor(r() * 5)])
      const ops = diffSequences(a, b, x => x)
      expect(ops.flatMap(o => (o.kind === 'insert' ? [] : [o.a]))).toEqual(a)
      expect(ops.flatMap(o => (o.kind === 'delete' ? [] : [o.b]))).toEqual(b)
      expect(ops.filter(o => o.kind === 'equal').length).toBe(lcsLength(a, b))
    }
  })

  it('handles empty sides', () => {
    expect(diffSequences([], [], x => x)).toEqual([])
    expect(diffSequences(['a'], [], x => x)).toEqual([{ kind: 'delete', a: 'a', ai: 0 }])
    expect(diffSequences([], ['b'], x => x)).toEqual([{ kind: 'insert', b: 'b', bi: 0 }])
  })
})

describe('wordEdits', () => {
  const apply = (from: string, to: string) => applyTextEdits(from, wordEdits(from, to))

  it('turns one text into the other', () => {
    const words = ['the', 'Supplier', 'shall', 'pay', 'thirty', '(30)', 'days', 'fees,', '“Agreement”', '$1,000', 'non-compete', '.']
    const r = rng(11)
    const sentence = () => Array.from({ length: 1 + Math.floor(r() * 14) }, () => words[Math.floor(r() * words.length)]).join(' ')
    for (let n = 0; n < 300; n++) {
      const from = sentence(), to = sentence()
      expect(fold(apply(from, to))).toBe(fold(to))
    }
  })

  it('changes whole words and numbers, and joins a phrase rewritten around a space', () => {
    expect(wordEdits('pay within thirty (30) days', 'pay within sixty (60) days')).toEqual([
      { kind: 'delete', start: 11, end: 17 }, { kind: 'insert', at: 17, text: 'sixty' },
      { kind: 'delete', start: 19, end: 21 }, { kind: 'insert', at: 21, text: '60' },
    ])
    expect(wordEdits('a fee of $1,000,000.00 applies', 'a fee of $2,500,000.00 applies')).toEqual([
      { kind: 'delete', start: 10, end: 22 }, { kind: 'insert', at: 22, text: '2,500,000.00' },
    ])
    // "the Supplier's" → "each Party's aggregate": one change, not three.
    expect(wordEdits("the Supplier's liability", "each Party's aggregate liability")).toEqual([
      { kind: 'delete', start: 0, end: 14 }, { kind: 'insert', at: 14, text: "each Party's aggregate" },
    ])
  })

  it('sees no change in quotes, dashes or spacing', () => {
    expect(wordEdits('The “Services” — as  defined', 'The "Services" - as defined')).toEqual([])
  })
})
