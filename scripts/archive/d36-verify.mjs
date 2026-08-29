#!/usr/bin/env node
/**
 * D.3.6 verify — AuditEvent rows written for apply + undo.
 *
 * Reuses the D.3.5 flow (create thread, apply comment, undo). After both
 * actions, queries the agent AI audit log and asserts two new rows:
 *   - AGENT_TOOL_APPLIED with toolName=comment_add, status=success
 *   - AGENT_TOOL_UNDONE with toolName=comment_add
 * Each carries threadId + toolCallId for cross-reference with ToolCall rows.
 *
 * NOTE: AuditEvent list endpoint filtered to AI actions lives at
 * /api/v1/admin/ai/audit. Our new event types aren't in that AI allow-list
 * (they're agent-side, not admin-side). So this smoke queries the DB
 * directly via a helper script since Node doesn't expose an open audit
 * endpoint for non-admin actions.
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-ai-demo.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr || r.stdout); process.exit(1) }
}

function queryAuditEvents(action) {
  // Shell out to a tiny tsx one-liner to fetch recent audit rows.
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_recent-audit.ts', action], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) return []
  try { return JSON.parse(r.stdout || '[]') } catch { return [] }
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
  const msa = (list.contracts ?? list.data ?? []).find(c => /Acme.*Master Services/i.test(c.title ?? ''))

  await page.goto(`http://localhost:5173/contracts/${msa.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  await page.getByTestId('side-agent-composer').fill('Hi.')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(800)

  const probe = `D.3.6 audit probe ${Date.now()}`
  const t0 = Date.now()
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail }))
  }, {
    id: 'act_d36',
    toolName: 'comment_add',
    summary: 'Add audit probe comment',
    args: { contractId: msa.id, clauseRef: '§1', body: probe },
    target: `${msa.title} · §1`,
    reversible: true,
    status: 'awaiting_confirmation',
  })
  await page.waitForTimeout(300)

  // Apply
  await page.getByTestId('action-preview-apply').click()
  await page.getByTestId('action-preview-receipt').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(400)

  // Undo
  await page.getByTestId('action-preview-undo').click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="action-preview-receipt"]')?.getAttribute('data-status') === 'undone',
    { timeout: 10_000 }
  )

  // Query AuditEvent rows for the apply + undo
  const applied = queryAuditEvents('AGENT_TOOL_APPLIED').filter(e => e.createdAt >= new Date(t0).toISOString())
  check(applied.length >= 1, `(apply) AGENT_TOOL_APPLIED row written (got ${applied.length} in window)`)
  const a = applied[0]
  check(a?.metadata?.toolName === 'comment_add',
        `(apply) metadata.toolName = comment_add (got ${a?.metadata?.toolName})`)
  check(a?.metadata?.status === 'success',
        `(apply) metadata.status = success (got ${a?.metadata?.status})`)
  check(typeof a?.metadata?.threadId === 'string',
        `(apply) metadata.threadId present`)
  check(typeof a?.metadata?.latencyMs === 'number',
        `(apply) metadata.latencyMs present (${a?.metadata?.latencyMs}ms)`)
  check(a?.resourceType === 'agent_tool_call',
        `(apply) resourceType = agent_tool_call`)

  const undone = queryAuditEvents('AGENT_TOOL_UNDONE').filter(e => e.createdAt >= new Date(t0).toISOString())
  check(undone.length >= 1, `(undo) AGENT_TOOL_UNDONE row written (got ${undone.length})`)
  const u = undone[0]
  check(u?.resourceId === a?.resourceId,
        `(undo) resourceId matches the applied ToolCall (${u?.resourceId} vs ${a?.resourceId})`)
  check(u?.metadata?.toolName === 'comment_add',
        `(undo) metadata.toolName = comment_add`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.3.6 AuditEvent checks pass')
})().catch(e => { console.error(e); process.exit(1) })
