/**
 * docs/41 Part 4 — choosing between their text and ours in Compare is not an
 * approval decision. Its buttons say what they do ("Accept change", "Keep
 * original"), in neutral colours, and none is called "Reject": that word was
 * read as an approver's decision. Rendered to a string (no browser).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import { ChangesList } from './CompareMode'

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim())

describe('Compare', () => {
  it('labels each change "Accept change" / "Keep original", never "Reject"', () => {
    const html = renderToString(
      <ChangesList
        changes={[{ id: 'c0', type: 'ins', text: 'within 30 days' }, { id: 'c1', type: 'del', text: 'within 60 days' }]}
        totalChanges={2}
        decisions={{ c1: 'reject' }}
        onDecide={() => {}}
      />,
    )
    const labels = buttons(html)
    expect(labels.filter(l => l === 'Accept change')).toHaveLength(2)
    expect(labels.filter(l => l === 'Keep original')).toHaveLength(2)
    expect(labels.some(l => /reject/i.test(l))).toBe(false)
    // A choice, not a verdict: no green or red on the buttons.
    expect(html).not.toMatch(/<button[^>]*class="[^"]*(risk-|brand-)/)
  })

  it('has bulk buttons "Accept all changes" / "Keep all originals", and no "Reject" label anywhere', () => {
    const src = readFileSync(join(__dirname, 'CompareMode.tsx'), 'utf8')
    expect(src).toContain('Accept all changes')
    expect(src).toContain('Keep all originals')
    expect(src).not.toMatch(/>\s*Reject/)
    expect(src).not.toMatch(/\/>\s*Reject/)
    expect(src).not.toContain('variant="danger"')
  })
})
