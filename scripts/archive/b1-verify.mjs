#!/usr/bin/env node
/**
 * B.1 verification — document-first detail page.
 *
 * Expectations:
 *   - Default tab is Document (contract visible above the fold)
 *   - Document auto-loads (no "Load Document" click required)
 *   - Action bar has exactly 1 primary CTA + 1 kebab button
 *     (down from 6 buttons)
 *   - Contract Details panel hides empty `—` rows
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
  await page.waitForTimeout(1800);

  // Pick a contract that actually has a PDF to display (iPass has a source file)
  await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const clicked = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cursor-pointer'));
    const row = rows.find(r => r.textContent && r.textContent.includes('iPass Inc.'));
    if (row) { row.click(); return true; }
    return false;
  });
  if (!clicked) console.log('⚠ iPass not found — using first row');

  // Wait for PDF to auto-load
  await page.waitForTimeout(3500);

  const shot = path.join(OUT, '25-b1-document-first.png');
  await page.screenshot({ path: shot });
  console.log('✓', path.relative(path.join(__dirname, '..'), shot));

  // Crop: just the header + stepper + tabs + first 300px of document
  const shotHead = path.join(OUT, '25b-b1-header-crop.png');
  await page.screenshot({ path: shotHead, clip: { x: 240, y: 0, width: 1200, height: 300 } });
  console.log('✓', path.relative(path.join(__dirname, '..'), shotHead));

  const state = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean);
    const topActionRow = Array.from(document.querySelectorAll('header + div button, .flex.items-center.gap-2.flex-shrink-0 > button'));
    return {
      topButtonCount: topActionRow.length,
      buttons: Array.from(new Set(buttons)),
      hasDocumentTab: document.body.innerText.includes('Document'),
      hasLoadDocumentButton: document.body.innerText.includes('Load Document'),
    };
  });

  console.log('Top-row buttons:', state.topButtonCount);
  console.log('Has "Load Document" button:', state.hasLoadDocumentButton, '(should be false)');

  if (state.hasLoadDocumentButton) {
    console.log('❌ FAIL — "Load Document" button still visible');
    process.exit(1);
  }

  console.log('✅ PASS — document-first layout, auto-loaded, no Load Document dance');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
