#!/usr/bin/env node
/**
 * D.3.2 verify — comment_add via Apply button → real ContractComment row.
 *
 * Flow:
 *   (1) Navigate to a seeded contract so the rail has a page context
 *   (2) Send a user turn via the rail so an AgentThread is persisted
 *   (3) Inject a PendingAction (comment_add) into the latest assistant
 *       message via the dev hook
 *   (4) Click Apply on the card
 *   (5) Poll the contracts comments API until a new comment appears whose
 *       body matches what we injected
 *   (6) Assert the card transitioned to "applied" receipt
 *   (7) Assert a ToolCall row with status=success was written in the DB
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-ai-demo.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr || r.stdout); process.exit(1) }
}

;(async () => {
  reseed()

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })

  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const list = await fetch('http://localhost:3001/api/v1/contracts?page=1&pageSize=50', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const contracts = list?.contracts ?? list?.data ?? []
  const msa = contracts.find(c => /Acme.*Master Services/i.test(c.title ?? ''))
  check(!!msa, `found seeded Acme MSA (${msa?.id})`)

  // (1) Open the contract
  await page.goto(`http://localhost:5173/contracts/${msa.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // (2) Trigger a user turn so a real AgentThread exists + threadIdRef is set
  await page.getByTestId('side-agent-composer').fill('Give me a one-line summary of this contract.')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(800)

  // Count existing comments so we can detect the new one deterministically
  const beforeRes = await fetch(`http://localhost:3001/api/v1/contracts/${msa.id}/comments`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const beforeBody = beforeRes.ok ? await beforeRes.json() : null
  const beforeComments = beforeBody?.data ?? beforeBody?.comments ?? []
  const beforeCount = beforeComments.length

  // (3) Inject the PendingAction
  const uniqueBody = `D.3.2 audit probe ${Date.now()} — wilful misconduct carve-out check`
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail }))
  }, {
    id: 'act_d32',
    toolName: 'comment_add',
    summary: 'Add a comment to §9.2 about wilful misconduct carve-outs.',
    args: {
      contractId: msa.id,
      clauseRef:  '§9.2 Cap on damages',
      body:       uniqueBody,
    },
    target: `${msa.title} · §9.2 Cap on damages`,
    reversible: true,
    status: 'awaiting_confirmation',
  })
  await page.waitForTimeout(400)

  const card = page.getByTestId('action-preview')
  check(await card.isVisible(), '(3) action preview card visible')

  await page.screenshot({ path: `${SHOTS}/87-d32-awaiting-comment.png`, fullPage: false })

  // (4) Click Apply
  await page.getByTestId('action-preview-apply').click()

  // (5) Poll comments API for the new one (real Prisma write)
  const deadline = Date.now() + 15_000
  let foundComment = null
  while (Date.now() < deadline) {
    const r = await fetch(`http://localhost:3001/api/v1/contracts/${msa.id}/comments`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (r.ok) {
      const j = await r.json()
      const rows = j.data ?? j.comments ?? []
      foundComment = rows.find(c => c.body === uniqueBody)
      if (foundComment) break
    }
    await new Promise(ok => setTimeout(ok, 500))
  }
  check(!!foundComment, `(5) ContractComment row created with matching body (beforeCount=${beforeCount})`)
  check(foundComment?.clauseRef === '§9.2 Cap on damages',
        `(5) clauseRef persisted correctly (got ${foundComment?.clauseRef})`)

  // (6) Card transitioned to "applied" receipt
  await page.waitForTimeout(400)
  const receipt = page.getByTestId('action-preview-receipt')
  await receipt.waitFor({ state: 'visible', timeout: 5_000 })
  const status = await receipt.getAttribute('data-status')
  check(status === 'applied', `(6) receipt data-status=applied (got ${status})`)

  await page.screenshot({ path: `${SHOTS}/88-d32-applied-receipt.png`, fullPage: false })

  // (7) ToolCall row recorded — fetch the thread's tool calls
  const thread = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-agent') ?? '{}').state?.activeThread ?? null }
    catch { return null }
  })
  check(!!thread?.id, `(7) activeThread id captured from localStorage (${thread?.id})`)
  if (thread?.id) {
    const tRes = await fetch(`http://localhost:3001/api/v1/agent/threads/${thread.id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const tBody = tRes.ok ? await tRes.json() : null
    const matchTc = (tBody?.toolCalls ?? []).find(tc =>
      tc.toolName === 'comment_add' && tc.status === 'success'
    )
    check(!!matchTc, `(7) ToolCall row recorded with toolName=comment_add status=success`)
  }

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.3.2 comment_add write-path checks pass')
})().catch(e => { console.error(e); process.exit(1) })
