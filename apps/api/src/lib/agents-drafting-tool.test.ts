/**
 * C12 — the chat drafting tool must propose (confirm card), not create.
 * Source-level tripwire, like agents-internal-headers.test.ts: CI has no
 * Python test runner, and a regression here silently re-opens contract
 * creation with no confirmation, no undo and no permission check on apply.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tool = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'tools', 'contract_create_from_template.py'), 'utf8')

describe('contract_create_from_template (agent tool)', () => {
  it('returns an awaitingConfirmation card with the create route\'s args', () => {
    expect(tool).toMatch(/"awaitingConfirmation":\s*True/)
    for (const key of ['templateId', 'variables', 'title', 'contractType']) expect(tool).toContain(`"${key}"`)
    expect(tool).toMatch(/"reversible":\s*True/)
  })

  it('carries no hard-coded contract terms', () => {
    // Code only: the module docstring explains the old bug by naming them.
    const code = tool
      .replace(/^[\s\S]*?"""[\s\S]*?"""/, '')
      .split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    expect(code).not.toMatch(/California/)
    expect(code).not.toMatch(/2[- ]year/)
  })
})
