#!/usr/bin/env node
/**
 * L3 — every agent failure renders as an empty bubble.
 *
 * Both web clients `throw` from inside the per-frame parse `try`, whose `catch`
 * was written to tolerate one malformed SSE frame:
 *
 *   AgentHomePage.tsx  `throw new Error(evt.error …)` → `catch { // ignore parse errors }`
 *   SideAgentRail.tsx  `throw new Error(parsed.error …)` → `catch (e) { if (NODE_ENV !== 'production') console.warn(…) }`
 *
 * So the throw never reaches the outer catch. The rail's careful three-tier
 * ladder — "An admin needs to add an OpenAI or Anthropic API key…" — is dead
 * code for every SSE-delivered failure, and a production build does not even
 * log. `chat.py` returns HTTP 200 and streams the failure, so the `!res.ok`
 * path the ladder DOES fire on is never taken either.
 *
 * ── Why this check stubs the stream ──────────────────────────────────────────
 *
 * The first version of this check forced a real provider failure by writing a
 * deliberately invalid BYOK key (the W0-3 pattern). That was not deterministic:
 * the run succeeded anyway — "Agent response complete." — because the platform
 * key still resolves. Worse, the check PASSED regardless, because /agent
 * auto-loads the most recent thread and an earlier failed turn's text was still
 * persisted in it. It was asserting on last run's output.
 *
 * So the browser half now serves a canned error frame with `page.route`. That
 * is the honest unit under test: the defect is entirely in what the client does
 * with a correct error frame, not in producing one. Section 1 separately pins
 * the server side — every envelope it can emit must be typed — which is where
 * the real `chat.py` bug lived.
 *
 * Every turn starts from "New conversation" for the same reason: stale threads
 * are how the earlier version fooled itself.
 *
 * Run BEFORE: an empty assistant bubble on both surfaces, and the untyped
 *             envelope does not even match AgentHomePage's error branch.
 * Run AFTER:  a human-readable message, a retry control, and the turn persists.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../node_modules/playwright/index.mjs'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const WEB = process.env.WEB_BASE ?? 'http://localhost:5173'

// ─── 1. Every error envelope the server can emit is typed ───────────────────

section('1. The server types every error envelope it emits')
{
  // The clients dispatch on `type`. An envelope without one is not a
  // near-miss — AgentHomePage's `evt.type === 'error'` test never sees it at
  // all, so the failure is dropped before any rendering decision.
  const files = ['apps/agents/app/routes/chat.py', 'apps/agents/app/orchestrator.py']
  const untyped = []
  for (const f of files) {
    const src = fs.readFileSync(`${REPO}/${f}`, 'utf8')
    const lines = src.split('\n')

    // Only envelopes that are actually YIELDED down the SSE stream count. A
    // json.dumps carrying "error" can equally be a tool RESULT body — those
    // travel inside a tool_call_result frame and have no business carrying a
    // frame type. Resolve the variable names that reach `yield f"data: {…}"`
    // and judge only those.
    const emitted = new Set(
      [...src.matchAll(/yield\s+f"data:\s*\{(\w+)\}/g)].map(m => m[1]),
    )
    lines.forEach((line, i) => {
      const assign = /^\s*(\w+)\s*=\s*json\.dumps\(\{(.*)$/.exec(line)
      if (!assign) return
      const [, name, rest] = assign
      if (!emitted.has(name)) return
      if (!/"error"/.test(rest)) return
      if (/"type"/.test(rest)) return
      untyped.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`)
    })
  }
  check('no SSE error envelope is emitted without a type field', untyped.length === 0,
    untyped.join(' | ') || 'all error emitters typed')
}

// ─── Browser ────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
const page = await ctx.newPage()

const SHOTS = new URL('.', import.meta.url).pathname
const shot = n => page.screenshot({ path: `${SHOTS}l3-${n}.png` })

/** Serve a canned SSE stream for the next chat call. */
async function stubChat(frames) {
  await page.unroute('**/api/v1/agent/chat').catch(() => {})
  await page.route('**/api/v1/agent/chat', route => route.fulfill({
    status: 200,                       // the server really does return 200 on failure
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n',
  }))
}

await page.goto(WEB, { waitUntil: 'domcontentloaded' })
await page.fill('input[type=email]', 'admin@demo.com')
await page.fill('input[type=password]', 'password123')
await page.click('button[type=submit]')
await page.waitForLoadState('networkidle').catch(() => {})
const skip = page.locator('text=Skip setup').first()
if (await skip.count()) { await skip.click().catch(() => {}); await page.waitForTimeout(800) }

const COMPOSER = 'textarea[placeholder*="Ask anything"]'

async function sendOnAgentPage(text) {
  await page.goto(`${WEB}/agent`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1000)
  // Always a fresh thread: /agent auto-loads the most recent one, and asserting
  // against a previous run's persisted failure is exactly how this check
  // fooled itself once already.
  await page.locator('button:has-text("New conversation")').first().click().catch(() => {})
  await page.waitForTimeout(600)
  const box = page.locator(COMPOSER).first()
  await box.fill(text)
  await box.press('Enter')
  await page.waitForTimeout(3000)
}

const KEY_ERROR = 'RuntimeError: no LLM api key configured for org'

// ─── 2. A typed error frame ─────────────────────────────────────────────────

section('2. /agent renders a typed error frame')
{
  await stubChat([{ type: 'error', error: KEY_ERROR }])
  await sendOnAgentPage('Which contracts expire soon?')
  await shot('1-typed')

  const text = await page.locator('body').innerText()
  check('the failure is stated on screen, not left as an empty bubble',
    /isn't configured|not configured|API key|temporarily unavailable|ran into a problem/i.test(text),
    'an empty bubble is indistinguishable from a hung request')
  check('the message is actionable, naming what to fix',
    /API key|AI Config/i.test(text),
    'the three-tier ladder should have selected the no-key branch')
  check('a retry control is offered',
    await page.locator('[data-testid=agent-error-retry]').count() > 0,
    'a diagnosis with no way forward leaves the user on a dead thread')
}

// ─── 3. The untyped legacy envelope ─────────────────────────────────────────

section('3. /agent renders the UNTYPED legacy envelope too')
{
  // routes/chat.py's non-agentMode handler emitted a bare {"error": …}. Even
  // once that is typed at the source, the client should not depend on it.
  await stubChat([{ error: KEY_ERROR }])
  await sendOnAgentPage('Second question, untyped failure.')
  await shot('2-untyped')

  const text = await page.locator('body').innerText()
  check('an untyped {error} envelope still surfaces',
    /isn't configured|not configured|API key|ran into a problem/i.test(text),
    'evt.type === "error" alone never matched this envelope')
}

// ─── 4. The failed turn survives a reload ───────────────────────────────────

section('4. A failed turn is still there after a refresh')
{
  await page.unroute('**/api/v1/agent/chat').catch(() => {})
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(2500)
  await shot('3-reloaded')

  const text = await page.locator('body').innerText()
  check('the failed turn persisted',
    /Second question, untyped failure/i.test(text),
    'the persistence guard is assembled.trim().length > 0, so a failed turn used to vanish — the user could not show anyone what happened')
}

// ─── 5. The side rail ───────────────────────────────────────────────────────

section('5. The side rail surfaces it as well')
{
  await stubChat([{ type: 'error', error: KEY_ERROR }])
  await page.goto(`${WEB}/contracts`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)

  const opener = page.locator('[data-testid=open-agent-rail], button:has-text("Assistant"), button:has-text("Ask")').first()
  if (await opener.count()) { await opener.click().catch(() => {}); await page.waitForTimeout(1200) }

  const box = page.locator('textarea').last()
  const has = await box.count() > 0
  check('the rail composer is reachable', has)
  if (has) {
    await box.fill('Summarise my riskiest contract.')
    await box.press('Enter')
    await page.waitForTimeout(3500)
    await shot('4-rail')
    const text = await page.locator('body').innerText()
    check('the rail surfaces the failure',
      /isn't configured|not configured|API key|temporarily unavailable|ran into a problem/i.test(text),
      'its friendly ladder existed but was dead code for SSE-delivered errors')
  }
}

// ─── 6. A healthy turn is unchanged ─────────────────────────────────────────

section('6. A successful turn shows no error chrome')
{
  await stubChat([
    { session_id: 'l3-ok-session' },
    { type: 'token', delta: 'All good.' },
  ])
  await sendOnAgentPage('A question that succeeds.')
  await shot('5-healthy')

  check('the reply renders', /All good\./.test(await page.locator('body').innerText()))
  check('no error control is shown on a healthy turn',
    await page.locator('[data-testid=agent-error-retry]').count() === 0)
}

await browser.close()
console.log(`\nScreenshots: ${SHOTS}l3-*.png`)
report('L3 agent error surface')
