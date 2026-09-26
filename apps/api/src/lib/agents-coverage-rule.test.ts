/**
 * V2 — the orchestrator must tell the model to state partial coverage.
 * Source tripwire (CI has no Python test runner): the tool output carries the
 * numbers, and this rule is what makes the answer say them.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const prompt = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'orchestrator.py'), 'utf8')

describe('orchestrator rule A13 — coverage', () => {
  it('requires partial answers to say so, using the tools\' coverage block', () => {
    expect(prompt).toMatch(/A13 — COVERAGE/)
    expect(prompt).toContain('coverage.complete')
    expect(prompt).toMatch(/not a complete list/)
  })

  it('points date and value questions at the new filters', () => {
    expect(prompt).toMatch(/expiry_\*\/effective_\*\/value_\*/)
  })
})
