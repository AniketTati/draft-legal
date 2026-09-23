/**
 * X32 — htmldiff is synchronous and grows faster than the text: 45 KB took
 * 0.2 s, 354 KB 5.6 s, and a large low-vocabulary pair minutes, all on the
 * request thread, where it stalled every other request on the instance. The
 * diff now runs on a worker thread, with a time limit.
 */
import { describe, it, expect } from 'vitest'
// @ts-ignore — no type definitions for node-htmldiff
import htmldiff from 'node-htmldiff'
import { computeVersionDiff, htmlDiff, DiffTooLargeError } from './diff.js'

const WORDS = 'the party shall provide notice within thirty days of any breach including liability indemnity confidentiality termination payment'.split(' ')

/** A deterministic contract-like document of `paras` paragraphs. */
function doc(paras: number): string {
  let seed = 7
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  return Array.from({ length: paras }, () =>
    `<p>${Array.from({ length: 40 + Math.floor(next() * 40) }, () => WORDS[Math.floor(next() * WORDS.length)]).join(' ')}</p>`,
  ).join('')
}

/** The same document with a few paragraphs edited. */
function edited(html: string): string {
  return html.split('</p>').map((p, i) => (i % 40 === 3 ? p.replace('notice', 'written notice').replace('thirty', 'sixty') : p)).join('</p>')
}

describe('computeVersionDiff', () => {
  it('gives the same diff and counts as htmldiff', async () => {
    const a = '<p>Liability is capped at twelve months of fees.</p>'
    const b = '<p>Liability is capped at three months of fees.</p>'
    const out = await computeVersionDiff(a, b)
    expect(out.diffHtml).toBe(htmldiff(a, b))
    expect(out.stats).toEqual({ insertions: 1, deletions: 1 })
  })

  it('leaves the event loop free while a large diff runs', async () => {
    const a = doc(250)
    const b = edited(a)
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 5)
    const out = await computeVersionDiff(a, b)
    clearInterval(timer)
    expect(out.stats.insertions).toBeGreaterThan(0)
    // On the request thread not one fired; a loaded machine may fire fewer
    // than it could, so this asks only that the loop kept turning.
    expect(ticks).toBeGreaterThanOrEqual(5)
  })
})

describe('htmlDiff', () => {
  it('gives up past its time limit, and says so', async () => {
    const a = doc(400)
    const started = Date.now()
    await expect(htmlDiff(a, edited(a), { timeoutMs: 100 })).rejects.toBeInstanceOf(DiffTooLargeError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('reports a failure inside the diff as an error, not a hang', async () => {
    await expect(htmlDiff(null as unknown as string, '<p>x</p>')).rejects.toThrow()
  })
})
