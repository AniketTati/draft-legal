#!/usr/bin/env node
// B.6.12 verify — contract-detail header at 1024 / 1280 / 1440 viewports
// no longer piles controls onto a third line.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
const EMAIL = process.env.E2E_EMAIL ?? 'admin@demo.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'password123'
const OUT = path.resolve('scripts/screenshots/b6')
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()

let fail = 0
function assert(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++ }

async function logIn(page) {
  await page.goto(`${WEB}/login`)
  // Dismiss coach marks before they mount to keep the test focused on
  // the header behaviour.
  await page.evaluate(() => {
    window.localStorage.setItem('clm.coach.contract-detail.v1', 'seen')
  })
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
}

async function openFirstContract(page) {
  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => !document.body.innerText.includes('Loading contracts…'), { timeout: 10_000 })
  const firstRow = page.locator('.grid.cursor-pointer').first()
  await firstRow.click()
  await page.waitForURL(/\/contracts\/[^/]+/)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(800) // Give canvas time to settle
}

async function runAt({ width, name }) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } })
  const page = await ctx.newPage()
  try {
    await logIn(page)
    await openFirstContract(page)
    await page.screenshot({ path: path.join(OUT, `b612-${width}-${name}.png`), fullPage: false })

    // Expect: "Actions" dropdown visible at every width
    const actionsVisible = await page.locator('button:has-text("Actions")').first().isVisible()
    assert(actionsVisible, `[${width}px] Actions dropdown visible`)

    // At 1024: Styled/Original toggle, Risks:, Compare are hidden
    const styledVisible = await page.locator('button:has-text("Styled")').first().isVisible().catch(() => false)
    const risksVisible = await page.locator('button:has-text("Risks:")').first().isVisible().catch(() => false)
    const compareVisible = await page.locator('button:has-text("Compare")').first().isVisible().catch(() => false)
    if (width < 1280) {
      assert(!styledVisible, `[${width}px] Styled toggle hidden (collapsed into Actions)`)
      assert(!risksVisible, `[${width}px] Risks button hidden`)
      assert(!compareVisible, `[${width}px] Compare button hidden`)
    } else {
      assert(styledVisible, `[${width}px] Styled toggle visible at xl`)
      assert(risksVisible, `[${width}px] Risks button visible at xl`)
    }

    // Ask AI visible at ≥ lg (1024); hidden at 768
    const askVisible = await page.locator('button:has-text("Ask AI")').first().isVisible().catch(() => false)
    if (width >= 1024) {
      assert(askVisible, `[${width}px] Ask AI button visible at lg+`)
    }

    // At ≤ lg, open Actions and confirm Styled/Compare are there
    if (width < 1280) {
      await page.locator('button:has-text("Actions")').first().click()
      await page.waitForTimeout(200)
      await page.screenshot({ path: path.join(OUT, `b612-${width}-${name}-menu.png`), fullPage: false })
      const menuHtml = await page.content()
      assert(/View original PDF|Back to styled view/.test(menuHtml), `[${width}px] Actions menu contains the Styled/Original toggle`)
      assert(/Compare versions|Risk markers/.test(menuHtml), `[${width}px] Actions menu contains Compare / Risk markers`)
    }
  } catch (e) {
    console.log(`FATAL [${width}]:`, e.message)
    fail++
  } finally {
    await ctx.close()
  }
}

try {
  await runAt({ width: 1024, name: 'tablet' })
  await runAt({ width: 1280, name: 'laptop' })
  await runAt({ width: 1440, name: 'desktop' })

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.12 checks pass.')
} finally {
  await browser.close()
}
