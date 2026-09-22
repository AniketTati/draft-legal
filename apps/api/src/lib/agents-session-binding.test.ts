/**
 * X8 tripwire (no Python test runner in CI — same approach as
 * agents-internal-headers.test.ts). The agents service kept chat history in
 * Redis under `session:{session_id}`, an id the client chooses, and replays it
 * (tool results included) into the next turn — so a user who learned another
 * user's id (thread ids show in a matter view) read that user's conversation.
 * History must be keyed by its owner, and every caller must say who that is.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = join(process.cwd(), '..', 'agents', 'app')
const memory = readFileSync(join(app, 'memory.py'), 'utf8')
const orchestrator = readFileSync(join(app, 'orchestrator.py'), 'utf8')

describe('agent chat history is bound to its owner', () => {
  it('the Redis key carries the org and the user, never the session id alone', () => {
    expect(memory).toMatch(/return f"session:\{org_id\}:\{user_id\}:\{session_id\}"/)
    expect(memory).not.toMatch(/f"session:\{session_id\}"/)
  })

  it('reading and writing history require the owner (keyword-only, no default)', () => {
    expect(memory).toMatch(/async def get_session_history\(session_id: str, \*, org_id: str, user_id: str\)/)
    expect(memory).toMatch(/async def append_to_session\(session_id: str, role: str, content: str, \*, org_id: str, user_id: str,/)
  })

  it('every Redis read and write goes through the owner-bound key', () => {
    const calls = memory.match(/\br\.(get|set|setex|delete|getdel)\(/g) ?? []
    const bound = memory.match(/\br\.(get|set|setex|delete|getdel)\(_session_key\(/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    expect(bound.length).toBe(calls.length)
    // …and nothing else reads history around the memory module.
    expect(orchestrator).not.toMatch(/get_redis|["']session:/)
  })

  it('every orchestrator call passes the owner', () => {
    const calls = [...orchestrator.matchAll(/await (get_session_history|append_to_session)\(([\s\S]*?)\)\n/g)]
    expect(calls.length).toBeGreaterThanOrEqual(5)
    for (const [call] of calls) expect(call, call).toMatch(/org_id=org_id,\s*user_id=user_id/)
  })
})
