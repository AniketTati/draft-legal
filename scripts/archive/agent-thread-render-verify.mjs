#!/usr/bin/env node
/**
 * Agent thread render fix — verify.
 *
 * Bug: /agent?thread=<id> went blank when the thread owned by the
 * logged-in user contained any messages with non-string content.
 *
 * Root cause: backend stores AgentMessage.content as Json, concretely
 * as `[{ type: 'text', text: '...' }]` blocks (Anthropic-shape) so it
 * can also carry tool_use / tool_result blocks. AgentHomePage was
 * passing this raw array straight into JSX (`{message.content}`),
 * triggering React's "Objects are not valid as a React child" — which
 * unwinds the entire route to a blank page when there's no boundary.
 *
 * Fix:
 *   - Normalize content via normalizeMessageContent() on load.
 *   - Wrap the route in an ErrorBoundary so a future shape regression
 *     can't blank the entire app.
 *
 * Checks:
 *   (1) AgentHomePage exports normalizeMessageContent helper.
 *   (2) The page useEffect calls normalizeMessageContent on .content.
 *   (3) ErrorBoundary component exists.
 *   (4) App.tsx wraps the /agent route in ErrorBoundary.
 *   (5) End-to-end: as the thread owner (admin@demo.com),
 *       /agent?thread=cmoenp3dc00042286wdk4v5ht renders with NO
 *       page errors and the message body is visible.
 */
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'desktop')
fs.mkdirSync(OUT, { recursive: true })

const BASE = 'http://localhost:5173'
const THREAD = 'cmoenp3dc00042286wdk4v5ht'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

// ── (1)+(2) Static checks
console.log('\n=== (1)+(2) AgentHomePage normalizes message content ===')
const page = fs.readFileSync(path.join(REPO_ROOT, 'apps/web/src/pages/AgentHomePage.tsx'), 'utf8')
check(/function normalizeMessageContent/.test(page), `normalizeMessageContent helper defined`)
check(/content: normalizeMessageContent\(m\.content\)/.test(page), `useEffect uses normalizer on load`)
check(/Anthropic-shape/.test(page) || /array of `\{ type:/.test(page), `comment explains the storage shape`)

// ── (3)+(4) ErrorBoundary
console.log('\n=== (3)+(4) ErrorBoundary wraps /agent ===')
const eb = fs.readFileSync(path.join(REPO_ROOT, 'apps/web/src/components/common/ErrorBoundary.tsx'), 'utf8')
check(/class ErrorBoundary extends Component/.test(eb), `ErrorBoundary class component present`)
const app = fs.readFileSync(path.join(REPO_ROOT, 'apps/web/src/App.tsx'), 'utf8')
check(/<ErrorBoundary[\s\S]+?<AgentHomePage/.test(app), `App.tsx wraps AgentHomePage in ErrorBoundary`)

// ── (5) End-to-end render
console.log('\n=== (5) /agent?thread=<id> renders for the thread owner ===')
const br = await chromium.launch({ headless: true })
const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
const errors = []
p.on('pageerror', e => errors.push('[pageerror] ' + e.message))

await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await p.fill('input[type="email"]', 'admin@demo.com')
await p.fill('input[type="password"]', 'password123')
await p.click('button[type="submit"]')
await p.waitForTimeout(1500)
await p.goto(`${BASE}/agent?thread=${THREAD}`, { waitUntil: 'networkidle' })
await p.waitForTimeout(3500)

const root = await p.getByTestId('agent-home').count()
check(root === 1, `agent-home root is mounted (got ${root})`)
check(errors.length === 0, `no React render errors thrown (got ${errors.length}: ${errors[0]?.slice(0, 120) ?? ''})`)

const bodyText = await p.evaluate(() => document.body.innerText || '')
check(/compliance-sweep/i.test(bodyText) || /sweep/i.test(bodyText),
      `thread title surfaces in the rail`)
check(/contracts? in/i.test(bodyText) || /summary of/i.test(bodyText) || /executed/i.test(bodyText),
      `assistant message body surfaces in the canvas`)

await p.screenshot({ path: path.join(OUT, '241-agent-thread-render-fix.png'), fullPage: false })
await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All agent-thread-render-fix checks pass')
