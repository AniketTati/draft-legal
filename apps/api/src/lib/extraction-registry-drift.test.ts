/**
 * docs/39 A2/A3 tripwire — a source-level guard, like agents-prompt-templates.
 *
 * The extraction prompt (agents review_agent.py) names the fields the model
 * returns, and the API files them by those names. When the two drifted, the
 * second-pass recovery asked for `governing_law` and `total_value` while
 * everything downstream read `governingLaw` and `value`, so what it found was
 * lost. There is no Python test runner in CI, so this reads the source: every
 * key the prompt asks for must be a canonical field in the registry.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coreField } from '@clm/types'

const REVIEW_AGENT = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'agents', 'review_agent.py'), 'utf8')

function rawFieldKeys(): string[] {
  const block = REVIEW_AGENT.split('"rawFields": {', 2)[1].split('"clauseFlags"', 2)[0]
  return [...block.matchAll(/^\s*"([A-Za-z]+)":/gm)].map(m => m[1])
}

describe('extraction prompt ↔ field registry', () => {
  it('asks only for canonical field names', () => {
    const keys = rawFieldKeys()
    expect(keys.length).toBeGreaterThan(10)
    for (const k of keys) {
      const def = coreField(k)
      expect(def, `${k} is not in CORE_FIELDS`).toBeDefined()
      expect(def?.key, `${k} is an old spelling of ${def?.key}`).toBe(k)
      expect(def?.legacy, `${k} is a legacy field and must not be extracted`).toBeFalsy()
    }
  })

  it('recovers missing fields under the names the first pass writes', () => {
    const hints = REVIEW_AGENT.split('_REQUIRED_FIELD_HINTS = {', 2)[1].split('\n}', 1)[0]
    const recovered = [...hints.matchAll(/^\s*"([A-Za-z]+)":/gm)].map(m => m[1])
    expect(recovered.length).toBeGreaterThan(0)
    for (const k of recovered) expect(rawFieldKeys(), k).toContain(k)
  })
})
