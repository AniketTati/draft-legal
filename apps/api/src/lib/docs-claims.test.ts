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
    // X72 — X1 shipped page jumps; and the portfolio example asks what the
    // agent answers (your own contracts), not a market-rate verdict.
    expect(readme).not.toMatch(/jump-to-page is planned/)
    expect(readme).not.toMatch(/Is that fair\?/)
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
    expect(bt).toMatch(/Admin settings panel \(`AdminOrgPage\.tsx` — General \/ Alert Rules \/ AI Config \/ Audit Log \//)   // X72
  })

  it('the evals README matches what CI runs', () => {
    const ci = repo('.github', 'workflows', 'ci.yml')
    const readme = repo('scripts', 'evals', 'README.md')
    // t1 on every PR, as the README says.
    expect(ci).toMatch(/run: node scripts\/evals\/run\.mjs --tier t1 --check-baseline/)
    expect(readme).toMatch(/\| \*\*t1\*\* \|[^\n]*\| blocking, every PR/)
    // t2 is "blocking, every PR" in the README only while a job runs it on
    // pull requests (main added agent-evals-t2; before it, the README had to
    // say t2 was not yet in CI).
    const t2Runs = /run:[^\n]*--tier[^\n]*t2/.test(ci)
    expect(/\| \*\*t2\*\* \|[^\n]*\| blocking, every PR \|/.test(readme)).toBe(t2Runs && /^\s*pull_request:/m.test(ci))
  })
})
