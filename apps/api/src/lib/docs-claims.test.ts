/**
 * H3 — README, CHANGELOG, BUILD_TRACKER and the evals README must describe
 * the product as it is. A doc tripwire over the statements the truth pass
 * corrected (evidence per statement in FIX_TRACKER.md H3).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = (...p: string[]) => readFileSync(join(process.cwd(), '..', '..', ...p), 'utf8')

describe('docs claims', () => {
  it('README no longer overstates the agents, citations or benchmarks', () => {
    const readme = repo('README.md')
    expect(readme).not.toMatch(/Seven specialist agents/)
    expect(readme).not.toMatch(/on a LangGraph orchestrator/)
    expect(readme).not.toMatch(/cited to the source page/)
    expect(readme).not.toMatch(/pricing benchmarks/i)
  })

  it('CHANGELOG keeps its history and corrects the collab claim in place', () => {
    const log = repo('CHANGELOG.md')
    expect(log).toMatch(/durable Yjs collab\s+persistence/)          // history kept
    expect(log).toMatch(/Correction \(2026-09-23, FIX_TRACKER H3\)/)
    expect(log).toMatch(/live multi-user co-editing is not available/)
  })

  it('BUILD_TRACKER no longer marks unbuilt work done, or shipped work deferred', () => {
    const bt = repo('BUILD_TRACKER.md')
    expect(bt).not.toMatch(/^- \[x\] RBAC manager: admin UI to create roles/m)
    expect(bt).not.toMatch(/^- \[x\] Admin settings panel/m)
    expect(bt).not.toMatch(/^- \[x\] ContractDetailPage: "Ask AI" tab/m)
    expect(bt).not.toMatch(/^- \[ \] X\.509 \/ PAdES cryptographic signing \(deferred to V1\.5\)/m)
  })

  it('the evals README matches what CI runs', () => {
    const ci = repo('.github', 'workflows', 'ci.yml')
    // What CI actually runs (a TODO comment in ci.yml mentions t2 — not a run step).
    expect(ci).toMatch(/run: node scripts\/evals\/run\.mjs --tier t1 --check-baseline/)
    expect(ci).not.toMatch(/run:[^\n]*--tier[^\n]*t2/)
    expect(repo('scripts', 'evals', 'README.md')).not.toMatch(/\| \*\*t2\*\* \|[^\n]*\| blocking, every PR \|/)
  })
})
