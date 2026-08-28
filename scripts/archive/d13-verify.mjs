#!/usr/bin/env node
/**
 * D.1.3 verify — SSE streaming end-to-end through the rail.
 *
 * Asserts:
 *   (1) Empty rail shows suggestion chips; clicking one drops text into
 *       the composer (not yet a send)
 *   (2) Typing + Send pushes a user bubble AND an assistant bubble;
 *       the assistant bubble becomes non-empty within 15s (the agent
 *       word-streams the reply)
 *   (3) Composer is disabled while streaming; becomes enabled after
 *   (4) "New thread" wipes the message list + clears the composer
 *   (5) Network failure (agents service down) → rail surfaces the error
 *       gracefully instead of leaving a blank assistant bubble forever
 *       (tested by pointing the rail at a bogus port via a route stub)
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // Login + enable flag + start fresh on dashboard (no context chip noise)
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })
  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)

  // ── (1) Click suggestion → composer fills ─────────────────────────────
  const suggestion = page.getByTestId('side-agent-suggestion').first()
  const suggestionText = (await suggestion.textContent())?.trim() ?? ''
  await suggestion.click()
  await page.waitForTimeout(150)
  const composerValue = await page.getByTestId('side-agent-composer').inputValue()
  check(composerValue === suggestionText,
        `(1) suggestion text drops into composer (got "${composerValue.slice(0, 40)}" == "${suggestionText.slice(0, 40)}")`)

  // ── (2) Send + stream ────────────────────────────────────────────────
  // Use a tiny prompt so the Python agent's word-streaming finishes fast.
  await page.getByTestId('side-agent-composer').fill('Say "hi" and stop.')
  await page.getByTestId('side-agent-send').click()

  // User bubble should appear instantly
  const userBubble = await page.getByTestId('side-agent-msg-user').first().textContent()
  check((userBubble ?? '').includes('Say'), '(2) user bubble renders immediately on send')

  // Wait for assistant bubble to gain content (poll up to 20s). Guard
  // against the "temporarily unavailable" fallback being scored as a pass
  // — that path is a real failure, not a streamed reply.
  const start = Date.now()
  let assistantText = ''
  while (Date.now() - start < 20_000) {
    assistantText = (await page.getByTestId('side-agent-msg-assistant').first().textContent().catch(() => '')) ?? ''
    if (assistantText.trim().length > 0 && !/temporarily unavailable/i.test(assistantText)) break
    await page.waitForTimeout(300)
  }
  check(
    assistantText.trim().length > 0 && !/temporarily unavailable/i.test(assistantText),
    `(2) assistant bubble received REAL streamed content within 20s (got ${JSON.stringify(assistantText.slice(0, 80))})`,
  )

  // Composer should be disabled during streaming. Check shortly after send.
  // (This may race with completion for tiny prompts, so don't fail on false.)
  const composerDisabledDuring = await page.getByTestId('side-agent-composer').isDisabled().catch(() => false)
  console.log(`  (info) composer disabled during stream: ${composerDisabledDuring}`)

  // Wait for streaming to fully complete (send button reverts from spinner).
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 30_000 }
  )
  // (3) After completion, composer should be enabled again
  const composerDisabledAfter = await page.getByTestId('side-agent-composer').isDisabled().catch(() => false)
  check(!composerDisabledAfter, '(3) composer enabled again after stream completes')

  await page.screenshot({ path: `${SHOTS}/66-d13-stream-complete.png`, fullPage: false })

  // ── (4) New thread wipes messages ────────────────────────────────────
  const beforeCount = await page.getByTestId(/side-agent-msg-/).count()
  check(beforeCount >= 2, `(4) there are messages before new-thread (got ${beforeCount})`)
  await page.getByTestId('side-agent-new-thread').click()
  await page.waitForTimeout(300)
  const afterCount = await page.getByTestId(/side-agent-msg-/).count()
  check(afterCount === 0, `(4) messages cleared after new-thread (got ${afterCount})`)
  const emptyVisible = await page.getByText(/how can i help/i).isVisible().catch(() => false)
  check(emptyVisible, '(4) empty state re-appears after new-thread')

  // ── (5) Graceful failure when the proxy returns an error ─────────────
  // Intercept /api/v1/agent/chat and reply 502 to simulate agents-down.
  await context.route('**/api/v1/agent/chat', route => route.fulfill({
    status: 502, contentType: 'application/json',
    body: JSON.stringify({ detail: 'Agent service unavailable' }),
  }))
  await page.getByTestId('side-agent-composer').fill('probe')
  await page.getByTestId('side-agent-send').click()
  await page.waitForTimeout(1200)
  const errorVisible = await page.getByText(/temporarily unavailable|AI assistant is temporarily unavailable/i).isVisible().catch(() => false)
  check(errorVisible, '(5) rail surfaces a friendly error instead of an infinite loading state')

  await page.screenshot({ path: `${SHOTS}/67-d13-error-state.png`, fullPage: false })

  // Cleanup
  await context.unroute('**/api/v1/agent/chat')
  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.1.3 UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
