/**
 * X53 — source tripwire, like agents-internal-headers.test.ts (no Python
 * runner in CI): the chat's redline tool can take the section the user named,
 * sends it as the sectionRef the Node route reads, and relays a miss's clause
 * list to the model rather than cutting it off.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'tools', 'redline_propose.py'), 'utf8')

describe('redline_propose tool', () => {
  it('takes the section the user named and sends it as sectionRef', () => {
    expect(src).toMatch(/section_ref: str \| None = Field\(/)
    expect(src).toMatch(/payload\["sectionRef"\]\s*=\s*section_ref/)
  })

  it('relays the whole error, clause list included', () => {
    const cap = Number(/redline_propose_failed.*r\.text\[:(\d+)\]/.exec(src)?.[1])
    expect(cap).toBeGreaterThanOrEqual(16_000)
  })
})
