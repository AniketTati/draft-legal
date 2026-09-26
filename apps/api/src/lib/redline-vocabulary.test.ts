/**
 * C9 — one redline-variant vocabulary across the agent tool, the Node apply
 * schema and the UI. A source-level tripwire (CI has no Python test runner):
 * the agent's redline_apply told the model 'conservative', which the Node
 * schema rejects, so every model-initiated apply of that variant 400'd.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')

function nodeEnum(): string[] {
  const src = read('src', 'routes', 'internal-ai.ts')
  const schema = src.slice(src.indexOf('const RedlineApplySchema'))
  const m = schema.match(/aggression:\s*z\.enum\(\[([^\]]+)\]\)/)
  return (m?.[1] ?? '').split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
}

describe('redline variant vocabulary', () => {
  it('the agent tool offers exactly what the apply route accepts', () => {
    const py = read('..', 'agents', 'app', 'tools', 'redline_apply.py')
    const m = py.match(/AGGRESSION_LEVELS\s*=\s*\(([^)]+)\)/)
    const tool = (m?.[1] ?? '').split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
    expect(tool).toEqual(nodeEnum())
    expect(nodeEnum()).toEqual(['least', 'moderate', 'aggressive'])
  })

  it("the tool's description no longer offers 'conservative'", () => {
    const py = read('..', 'agents', 'app', 'tools', 'redline_apply.py')
    const description = py.slice(py.indexOf('aggression: str | None = Field('), py.indexOf('rationale: str | None'))
    expect(description).not.toContain("'conservative'")
    expect(description).toContain("'least' | 'moderate' | 'aggressive'")
  })

  it('the UI labels the same three variants', () => {
    const ui = read('..', 'web', 'src', 'components', 'agent', 'RedlinePreview.tsx')
    expect(ui).toMatch(/aggression:\s*'least' \| 'moderate' \| 'aggressive'/)
  })
})
