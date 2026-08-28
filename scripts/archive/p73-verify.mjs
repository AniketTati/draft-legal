#!/usr/bin/env node
/**
 * P7.3 verify — Genspark-style /agent route.
 *
 *   (1) /agent route renders for any logged-in user
 *   (2) Sidebar nav shows "AI Assistant" item linking to /agent
 *   (3) Side rail is suppressed on /agent (the page IS the chat)
 *   (4) Conversation list rail + composer + starter prompts present
 *   (5) Persona-curated starters: Maya (Legal) ≠ Lisa (Procurement)
 *   (6) Send a starter → tool calls fire, response streams
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1680, height: 1100 } })
  const page = await ctx.newPage()

  // ── (1) /agent renders
  console.log('\n=== (1) F-NEW — /agent route renders ===')
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.goto(`${BASE}/agent`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  check(page.url().endsWith('/agent'), `URL is /agent (got ${page.url()})`)
  check(await page.getByTestId('agent-home').isVisible(), `agent-home root visible`)

  // ── (2) Sidebar nav item
  console.log('\n=== (2) Sidebar AI Assistant nav item ===')
  const sidebarLink = page.locator('a[href="/agent"]:has-text("AI Assistant"), a[href="/agent"] >> text=AI Assistant').first()
  check(await sidebarLink.isVisible(), `sidebar 'AI Assistant' link visible`)

  // ── (3) Side rail suppressed
  console.log('\n=== (3) Side rail suppressed on /agent ===')
  // The right-side rail's title is "AI Assistant" — but the same text
  // appears in the sidebar + header. Look specifically for the rail's
  // composer textarea testid; the rail composer is `side-agent-composer`.
  const railComposer = await page.getByTestId('side-agent-composer').count()
  check(railComposer === 0, `side-agent-composer NOT mounted (got ${railComposer})`)

  // ── (4) New conversation rail + composer + starters
  console.log('\n=== (4) Conversation rail + composer + starters ===')
  check(await page.getByTestId('agent-new-conversation').isVisible(), `+ New conversation button visible`)
  check(await page.getByTestId('agent-composer').isVisible(), `composer textarea visible`)
  const mayaStarters = await page.locator('[data-testid^="starter-prompt-"]').count()
  check(mayaStarters >= 3, `≥3 starter prompts visible (got ${mayaStarters})`)

  // ── (5) Persona-curated — Maya vs Lisa
  console.log('\n=== (5) Persona-curated starters ===')
  const mayaTexts = await page.locator('[data-testid^="starter-prompt-"]').allInnerTexts()
  await ctx.clearCookies()
  await page.evaluate(() => localStorage.clear())
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'lisa@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.goto(`${BASE}/agent`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const lisaTexts = await page.locator('[data-testid^="starter-prompt-"]').allInnerTexts()
  const mayaJoined = mayaTexts.join('|')
  const lisaJoined = lisaTexts.join('|')
  check(mayaJoined !== lisaJoined, `Maya's starters differ from Lisa's`)
  check(/playbook|liability|negotiation/i.test(mayaJoined), `Maya's starters mention playbook/liability/negotiation`)
  check(/renewal|vendor|cloudwave/i.test(lisaJoined), `Lisa's starters mention renewal/vendor/cloudwave`)

  // ── (6) Click starter → tool call fires, response streams
  console.log('\n=== (6) End-to-end starter → tool call → response ===')
  await page.getByTestId('starter-prompt-0').click()
  await page.waitForTimeout(10_000)  // let it stream + finish
  // Tool chips render mid-stream + persist; some short answers won't call
  // tools at all. Check that EITHER chips appeared or the response is
  // grounded enough (≥200 chars). Both failing means the stream broke.
  const toolChips = await page.getByTestId('agent-tool-chips').count()
  const messages = await page.getByTestId('agent-messages').innerText()
  check(messages.length > 100, `assistant response has substantive text (got ${messages.length} chars)`)
  check(toolChips >= 1 || messages.length > 200, `tool chips OR ≥200 char response (chips=${toolChips}, chars=${messages.length})`)

  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/202-p73-agent-home.png'),
    fullPage: false,
  })

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.3 agent-home checks pass')
})().catch(e => { console.error(e); process.exit(1) })
