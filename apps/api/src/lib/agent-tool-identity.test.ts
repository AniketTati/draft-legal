/**
 * X9 tripwire (no Python test runner in CI). The agent's read tools are
 * checked against the chatting user's permissions server-side (S2, X9): the
 * API resolves the user from `userId` in the tool's request. A Python tool
 * that forgets to send it is treated as a service call — org scope, no
 * checks — which is how template_list and matter_list served roles REST
 * refuses. Every tool whose API handler checks the caller must send userId,
 * and pass a 403's reason on to the model.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const api = readFileSync(join(process.cwd(), 'src', 'routes', 'internal-ai.ts'), 'utf8')
const toolsDir = join(process.cwd(), '..', 'agents', 'app', 'tools')

// Tools whose handler resolves the caller (scopeOr403) — derived, not listed.
const checked = [...api.matchAll(/app\.post\('\/tools\/([a-z_]+)'/g)]
  .map(m => {
    const start = m.index!
    const next = api.indexOf("app.post('/tools/", start + 10)
    return { name: m[1], body: api.slice(start, next === -1 ? undefined : next) }
  })
  .filter(t => t.body.includes('scopeOr403('))
  .map(t => t.name)

describe('agent read tools identify the chatting user', () => {
  it('finds the caller-checked tools', () => {
    expect(checked).toEqual(expect.arrayContaining(['contract_get', 'playbook_check', 'org_memory', 'approval_list', 'template_list', 'matter_list']))
  })

  for (const name of checked) {
    const file = join(toolsDir, `${name}.py`)
    if (!existsSync(file)) continue   // no chat tool of that name (called elsewhere)
    it(`${name}.py sends the caller as userId`, () => {
      expect(readFileSync(file, 'utf8')).toMatch(/"userId":\s*(_?user_id)/)
    })
  }

  for (const name of ['playbook_check', 'approval_list', 'org_memory', 'template_list', 'matter_list']) {
    it(`${name}.py tells the model why it was refused`, () => {
      expect(readFileSync(join(toolsDir, `${name}.py`), 'utf8')).toMatch(/"error": "permission_denied", "detail": detail/)
    })
  }
})
