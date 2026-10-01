/**
 * docs/39 B1 tripwire — TYPE_FIELDS (packages/types) mirrors TYPE_SCHEMAS in
 * the agents service, which the extraction prompts with. The Fields panel
 * shows and edits the TS copy; if the lists drift, a field the model fills
 * would have no editor, or an editor would offer a field the model never
 * fills. There is no Python test runner in CI, so this reads the source.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TYPE_FIELDS } from '@clm/types'

const SOURCE = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'agents', 'review_agent.py'), 'utf8')

function pythonTypeSchemas(): Record<string, Array<{ key: string; type: string }>> {
  const block = SOURCE.split('TYPE_SCHEMAS: dict[str, list[dict]] = {', 2)[1].split('\n}\n', 1)[0]
  const out: Record<string, Array<{ key: string; type: string }>> = {}
  let current: string | null = null
  for (const line of block.split('\n')) {
    const head = line.match(/^\s*"([A-Z_]+)":\s*\[/)
    if (head) { current = head[1]; out[current] = []; continue }
    const field = line.match(/"key":\s*"([a-z_0-9]+)".*?"type":\s*"(\w+)"/)
    if (field && current) out[current].push({ key: field[1], type: field[2] })
  }
  return out
}

describe('TYPE_FIELDS ↔ TYPE_SCHEMAS', () => {
  it('lists the same fields, in order, with the same types', () => {
    const python = pythonTypeSchemas()
    expect(Object.keys(python).length).toBeGreaterThan(5)
    const ts = Object.fromEntries(Object.entries(TYPE_FIELDS).map(([t, fs]) => [t, fs.map(f => ({ key: f.key, type: f.type }))]))
    expect(ts).toEqual(python)
  })
})
