#!/usr/bin/env node
/**
 * D.1.4a verify — contract_get tool end-to-end.
 *
 * Drives the full happy path:
 *   1. Enable the agent rail + navigate to /contracts/:id so the rail
 *      gets a page-context chip.
 *   2. Ask "what kind of contract is this?" — a question that forces a
 *      real read of the document (generic prior knowledge can't answer).
 *   3. Intercept /api/v1/agent/chat and assert the POST body includes
 *      agentMode:true + pageContext with the contract id.
 *   4. Assert the response stream produced at least one tool_call_start
 *      event for contract_get with the right contract id in args.
 *   5. Assert the assistant bubble ends up with real text (not the
 *      "temporarily unavailable" fallback).
 *
 * Plus an API-layer check: the internal Node endpoint enforces org
 * scoping — a cross-tenant contractId returns 404.
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

// Run the AI-demo seed so this smoke talks to a deterministic dataset.
// Real contract bodies (NDA / MSA / SLA / SOW) with facts we can assert on.
function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-ai-demo.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) {
    console.error('seed-ai-demo failed:', r.stderr || r.stdout)
    process.exit(1)
  }
}

;(async () => {
  reseed()

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // Login + enable flag
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })

  // Grab token, then find the SPECIFIC seeded MSA contract so the assertion
  // can reference facts that live only in its plainText body. The MSA has
  // a distinctive "$500,000 liability cap" clause that doesn't appear in
  // the other three fixtures.
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const list = await fetch('http://localhost:3001/api/v1/contracts?page=1&pageSize=50', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const contracts = list?.contracts ?? list?.data ?? []
  const msa = contracts.find(c => /master services agreement/i.test(c.title ?? '') && /acme/i.test(c.title ?? ''))
  const contractId = msa?.id
  check(!!contractId, `found the seeded Acme MSA (${contractId})`)

  // Record the OUTGOING POST body so we can assert agentMode + pageContext
  // without reaching into React state.
  let lastPostBody = null
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().endsWith('/api/v1/agent/chat')) {
      try { lastPostBody = JSON.parse(req.postData() ?? 'null') } catch {}
    }
  })

  // Also capture the RESPONSE stream so we can check for tool_call_start
  // events. Playwright's response.body() is the full SSE payload.
  let lastStreamText = ''
  page.on('response', async resp => {
    if (resp.request().method() === 'POST' && resp.url().endsWith('/api/v1/agent/chat')) {
      try { lastStreamText = await resp.text() } catch {}
    }
  })

  await page.goto(`http://localhost:5173/contracts/${contractId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  // Dismiss any first-visit coach-mark so it doesn't block later clicks.
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Send a question that can ONLY be answered by reading the contract body.
  // The MSA fixture has "$500,000" as the liability cap in Section 9.2. The
  // title, summary, and key terms all contain "$500,000", but since metadata
  // isn't fed to the model in the current prompt, the answer must come from
  // plainText content served by contract_get.
  const composer = page.getByTestId('side-agent-composer')
  await composer.fill('What is the liability cap in this contract? Answer in a single sentence with the dollar amount.')
  await page.getByTestId('side-agent-send').click()

  // Wait for streaming to finish (composer re-enables)
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(400)

  // ── POST body assertions ──────────────────────────────────────────────
  check(lastPostBody?.agentMode === true,
        `(1) agentMode=true sent to proxy (got ${JSON.stringify(lastPostBody?.agentMode)})`)
  check(lastPostBody?.pageContext?.id === contractId,
        `(1) pageContext.id === contract id (got ${lastPostBody?.pageContext?.id})`)

  // ── Stream assertions ────────────────────────────────────────────────
  const hasToolStart = /"type":\s*"tool_call_start"/.test(lastStreamText)
  check(hasToolStart, `(2) stream contains a tool_call_start event`)
  const hasContractGet = /"name":\s*"contract_get"/.test(lastStreamText)
  check(hasContractGet, `(2) the tool call was for contract_get`)
  const hasRightId = lastStreamText.includes(`"contract_id":"${contractId}"`)
    || lastStreamText.includes(`"contract_id": "${contractId}"`)
    || lastStreamText.includes(`\\"contract_id\\": \\"${contractId}\\"`)
  check(hasRightId, `(2) tool args include the correct contract_id`)
  const hasResult = /"type":\s*"tool_call_result"/.test(lastStreamText)
  check(hasResult, `(2) stream contains a tool_call_result event`)

  // Assistant bubble has real text (not the error fallback)
  const assistantText = (await page.getByTestId('side-agent-msg-assistant').first().textContent().catch(() => '')) ?? ''
  check(
    assistantText.trim().length > 0 && !/temporarily unavailable/i.test(assistantText),
    `(3) assistant bubble has real content (got ${JSON.stringify(assistantText.slice(0, 120))})`
  )
  // Grounded-fact assertion: the MSA body states a $500,000 cap in Section 9.2.
  // Accept "$500,000", "500,000", or "500000" — models format dollar amounts
  // inconsistently but all three are unambiguously correct.
  const hasCapFact = /\$?\s?500[,.]?000/.test(assistantText) || /five hundred thousand/i.test(assistantText)
  check(hasCapFact, `(3) answer cites the $500,000 liability cap from body (got ${JSON.stringify(assistantText.slice(0, 200))})`)

  await page.screenshot({ path: `${SHOTS}/68-d14a-tool-grounded-reply.png`, fullPage: false })

  // ── Cross-tenant scoping check via direct curl ───────────────────────
  // Generate a bogus contract id and confirm the internal endpoint returns 404
  // even though we're using the admin's own secret — the query also matches
  // orgId server-side.
  const scopeResp = spawnSync('curl', [
    '-s', '-o', '/dev/null', '-w', '%{http_code}',
    '-X', 'POST',
    '-H', `x-internal-secret: ${process.env.INTERNAL_SERVICE_SECRET || 'change-me-internal-secret-min-32-chars'}`,
    '-H', 'content-type: application/json',
    '-d', JSON.stringify({ orgId: 'org_does_not_exist', contractId }),
    'http://localhost:3001/api/internal/ai/tools/contract_get',
  ], { encoding: 'utf-8' })
  check(scopeResp.stdout?.trim() === '404', `(4) cross-tenant orgId → 404 (got ${scopeResp.stdout})`)

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.1.4a tool checks pass')
})().catch(e => { console.error(e); process.exit(1) })
