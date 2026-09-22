/**
 * Agents → API header tripwire (C8) — a source-level guard, like
 * index-on-create.test.ts.
 *
 * The Python agents service calls org-scoped /api/v1 routes as a system
 * principal. Without x-org-id, requireAuth resolves the org to 'system' and
 * those routes return 404 / empty results — which is how every Negotiate-tab
 * redline analysis failed. There is no Python test runner in CI, so this
 * reads the Python sources and fails if a fixed caller regresses.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AGENTS = join(process.cwd(), '..', 'agents', 'app')

// Background jobs that act for an org without a user JWT.
const ORG_SCOPED_CALLERS = [
  'routes/redline.py',
  'routes/approval.py',
]

describe('agents service → API internal headers', () => {
  for (const rel of ORG_SCOPED_CALLERS) {
    it(`${rel} sends x-internal-service, x-internal-secret and x-org-id`, () => {
      const src = readFileSync(join(AGENTS, rel), 'utf8')
      expect(src).toMatch(/"x-internal-service":\s*"agents"/)
      expect(src).toMatch(/"x-internal-secret":\s*settings\.internal_service_secret/)
      expect(src, `${rel} omits x-org-id, so its org resolves to 'system'`).toMatch(/"x-org-id":\s*org_id/)
    })
  }

  it('redline.py fetches the playbook from a route that exists', () => {
    const src = readFileSync(join(AGENTS, 'routes/redline.py'), 'utf8')
    expect(src).toContain('/api/v1/playbook/positions')
    expect(src).not.toMatch(/\/api\/v1\/playbook["']/)
  })
})
