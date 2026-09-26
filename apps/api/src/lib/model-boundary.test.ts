/**
 * Y2 — a tripwire for the model boundary (lib/model-boundary.ts). Every fetch
 * in apps/api/src is either the boundary's own or listed here with its
 * reason: a call that sends no contract text to a model. A new call to the
 * agents service or a model provider fails this test until it goes through
 * `modelFetch`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')

/** Calls that are not to a model, or send it no contract text. Matched on the file and the call's first argument. */
const NOT_MODEL_CALLS: Array<{ file: string; target: string; reason: string }> = [
  { file: 'lib/model-boundary.ts', target: 'url', reason: 'the boundary' },
  { file: 'lib/document.ts', target: '`${agentsUrl}/extract`', reason: 'an uploaded file, for parsing with local OCR: no model reads it, and a binary can\'t be redacted' },
  { file: 'routes/agents.ts', target: '`${AGENTS_URL}/agent/models`', reason: 'lists the models; sends no text' },
  { file: 'routes/admin-ai.ts', target: '\'https://api.openai.com/v1/models?limit=1\'', reason: 'tests an admin\'s key; sends no text' },
  { file: 'routes/admin-ai.ts', target: '\'https://api.anthropic.com/v1/messages\'', reason: 'tests an admin\'s key with a fixed one-word prompt' },
  { file: 'routes/admin-ai.ts', target: '`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`', reason: 'tests an admin\'s key; sends no text' },
  { file: 'routes/agent-threads.ts', target: '`${AGENTS_INTERNAL_URL}/api/internal/ai/tools/${body.toolName}`', reason: 'the API\'s own tool route, applying a confirmed action' },
  { file: 'routes/agent-threads.ts', target: 'undoUrl', reason: 'the API\'s own tool route, undoing an action' },
  { file: 'workers/agent.worker.ts', target: '`${API_INTERNAL_URL}/api/internal/ai/tools/playbook_check`', reason: 'the API\'s own tool route' },
  { file: 'lib/langfuse.ts', target: '`${HOST().replace(/\\/$/, \'\')}/api/public/scores`', reason: 'observability: a rating and the user\'s own feedback comment' },
  { file: 'lib/langfuse.ts', target: '`${HOST().replace(/\\/$/, \'\')}/api/public/traces?${q}`', reason: 'observability: reads traces' },
  { file: 'lib/gotenberg.ts', target: 'metaUrl', reason: 'the cloud metadata server, for an identity token' },
  { file: 'lib/gotenberg.ts', target: '`${GOTENBERG_URL}/forms/chromium/convert/html`', reason: 'renders a PDF in our own service' },
  { file: 'lib/mailer.ts', target: '\'https://api.sendgrid.com/v3/mail/send\'', reason: 'email delivery' },
  { file: 'lib/slack.ts', target: '\'https://slack.com/api/auth.test\'', reason: 'Slack' },
  { file: 'lib/slack.ts', target: '`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`', reason: 'Slack' },
  { file: 'workers/webhook.worker.ts', target: 'wh.url', reason: 'the org\'s own webhook, with the payload it subscribed to' },
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'test-support' ? [] : sources(path)
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [path] : []
  })
}

/** The first argument of every fetch call in `code`, whitespace collapsed. Comments are skipped. */
function fetchTargets(code: string): string[] {
  const text = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  for (const m of text.matchAll(/(?:(?<![\w.$])|globalThis\.)fetch\s*\(/g)) {
    let depth = 0
    let i = m.index! + m[0].length
    const start = i
    for (; i < text.length; i++) {
      const c = text[i]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) { if (depth === 0) break; depth-- }
      else if (c === ',' && depth === 0) break
      else if (c === '`' || c === '\'' || c === '"') {
        // Skip the string, and a template's ${…} along with it.
        const quote = c
        for (i++; i < text.length && text[i] !== quote; i++) {
          if (text[i] === '\\') i++
          else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
            let d = 0
            for (i++; i < text.length; i++) { if (text[i] === '{') d++; else if (text[i] === '}' && --d === 0) break }
          }
        }
      }
    }
    out.push(text.slice(start, i).replace(/\s+/g, ' ').trim())
  }
  return out
}

describe('the model boundary tripwire', () => {
  const found = sources(SRC).flatMap(path => {
    const file = relative(SRC, path)
    return fetchTargets(readFileSync(path, 'utf8')).map(target => ({ file, target }))
  })
  const known = (f: { file: string; target: string }) => NOT_MODEL_CALLS.some(a => a.file === f.file && a.target === f.target)

  it('every fetch in the API is the boundary\'s, or listed as sending no contract text to a model', () => {
    expect(found.filter(f => !known(f))).toEqual([])
  })

  it('every listed call still exists', () => {
    expect(NOT_MODEL_CALLS.filter(a => !found.some(f => f.file === a.file && f.target === a.target))).toEqual([])
  })

  it('finds a direct call, however it is written', () => {
    expect(fetchTargets('const r = await fetch(`${AGENTS_URL}/draft`, { method: "POST" })')).toEqual(['`${AGENTS_URL}/draft`'])
    expect(fetchTargets('await globalThis.fetch(\n  `${base}/x?a=${f(1, 2)}`,\n  init)')).toEqual(['`${base}/x?a=${f(1, 2)}`'])
    expect(fetchTargets('// fetch(x)\n/* fetch(y) */ client.fetch(z)')).toEqual([])
  })
})
