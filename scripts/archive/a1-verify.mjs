#!/usr/bin/env node
/**
 * A.1 verification — open the editor on a previously-broken contract and
 * screenshot it. Before A.1 + cleanup, the editor showed
 *   "No suitable template found. Please create a template first."
 * as the contract body. After, it should open with an empty (or real)
 * editor, not the error string.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
const BASE = 'http://localhost:5173';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'admin@demo.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard)?$/, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // Click the first contract that was in the contaminated set:
  // "Unnamed Contract - No Identified Parties"
  const firstRow = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('p')).find(
      (p) => p.textContent && p.textContent.includes('Unnamed Contract'),
    );
    if (!p) return null;
    const row = p.closest('.cursor-pointer');
    if (row) row.click();
    return true;
  });
  if (!firstRow) { console.error('Could not find "Unnamed Contract" row'); process.exit(1); }

  await page.waitForTimeout(1500);

  // Click "Open in Editor"
  await page.getByRole('button', { name: /open in editor/i }).click();
  await page.waitForTimeout(2500);

  const shot = path.join(OUT, '22-a1-editor-after-fix.png');
  await page.screenshot({ path: shot, fullPage: false });
  console.log('✓', path.relative(path.join(__dirname, '..'), shot));

  // Also check that the editor body does NOT contain the poison string.
  const body = await page.evaluate(() => document.body.innerText);
  const poisoned = body.includes('No suitable template found');
  console.log(poisoned
    ? '❌ FAIL — editor still shows "No suitable template found"'
    : '✅ PASS — editor no longer shows the template-error string');

  await browser.close();
  process.exit(poisoned ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
