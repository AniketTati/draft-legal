/**
 * docs/41 Part 16, step 6 — Ask AI on selected words: the instruction and
 * the words go to the rewriter (mocked: no model), three drafts come back
 * with a reason each; repeats and unchanged words are dropped.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const agents = vi.hoisted(() => ({ calls: [] as Array<{ url: string; body: Record<string, unknown> }>, variants: [] as Array<Record<string, string>> }))
vi.mock('../lib/model-boundary.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/model-boundary.js')>()),
  modelFetch: vi.fn(async (url: string, init: { body: string }) => {
    agents.calls.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ variants: agents.variants }), { status: 200, headers: { 'content-type': 'application/json' } })
  }),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, other: string, contract: string
const words = 'The Supplier may terminate on 10 days notice.'

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Ask AI Org')
  other = await makeOrg('Ask AI Other Org')
  contract = await makeContract(org, await makeUser(org), { title: 'Ask AI MSA', status: 'UNDER_NEGOTIATION' })
})
afterAll(async () => { await cleanupAll(); await closeApp() })

const ask = (payload: Record<string, unknown>, headers = auth(org, ['ADMIN'])) =>
  app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/ask-ai`, headers, payload })

describe('POST /contracts/:id/ask-ai', () => {
  it('sends the words and the instruction, and returns up to three drafts with why', async () => {
    agents.variants = [
      { proposedText: 'Either party may terminate on 30 days notice.', rationale: 'Mutual, and a month to prepare.' },
      { proposedText: words, rationale: 'Unchanged.' },
      { proposedText: 'Either party may terminate on 60 days written notice.', rationale: 'Longer, and in writing.' },
      { proposedText: 'Either party may terminate on 30 days notice.', rationale: 'A repeat.' },
    ]
    const r = await ask({ selectedText: words, instruction: 'Make it mutual and longer' })
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json()
    expect(body.suggestionId).toEqual(expect.any(String))
    expect(body.drafts.map((d: { text: string }) => d.text)).toEqual([
      'Either party may terminate on 30 days notice.',
      'Either party may terminate on 60 days written notice.',
    ])
    expect(body.drafts[0].rationale).toBe('Mutual, and a month to prepare.')
    const call = agents.calls.at(-1)!
    expect(call.url).toMatch(/\/redline_propose$/)
    expect(call.body).toMatchObject({ instructions: 'Make it mutual and longer', clauseText: words })
  })

  it('needs words and an instruction', async () => {
    expect((await ask({ selectedText: words, instruction: ' ' })).statusCode).toBe(400)
    expect((await ask({ selectedText: '', instruction: 'x' })).statusCode).toBe(400)
  })

  it('says so when nothing new came back', async () => {
    agents.variants = [{ proposedText: words, rationale: '' }]
    const r = await ask({ selectedText: words, instruction: 'Rewrite' })
    expect(r.statusCode).toBe(502)
    expect(r.json().detail).toMatch(/No drafts/)
  })

  it('needs the right to edit, and another org gets not found', async () => {
    expect((await ask({ selectedText: words, instruction: 'x' }, auth(org, ['VIEWER']))).statusCode).toBe(403)
    expect((await ask({ selectedText: words, instruction: 'x' }, auth(other, ['ADMIN']))).statusCode).toBe(404)
  })
})
