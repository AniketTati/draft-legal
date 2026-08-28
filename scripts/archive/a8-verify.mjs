#!/usr/bin/env node
/**
 * A.8 verification — screenshot the StatusStepper on contracts in
 * different states to prove all path states render correctly.
 *
 * Uses demo data — finds the first contract of each status and caps one
 * screenshot per state.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
const BASE = 'http://localhost:5173';
fs.mkdirSync(OUT, { recursive: true });

// Statuses we want to demonstrate. Maps to known demo data titles.
const TARGETS = [
  { status: 'DRAFT',             matchTitle: 'WPT Enterprises' },
  { status: 'APPROVED',          matchTitle: 'NDA with TechVendor' },
  { status: 'EXECUTED',          matchTitle: 'Dunder Mifflin' },
  { status: 'EXPIRED',           matchTitle: 'Veridian Dynamics' },
  { status: 'PENDING_REVIEW',    matchTitle: 'MSA with Salesforce' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'admin@demo.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1800);

  for (const t of TARGETS) {
    await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    const found = await page.evaluate((match) => {
      const rows = Array.from(document.querySelectorAll('.cursor-pointer'));
      const row = rows.find(r => r.textContent && r.textContent.includes(match));
      if (row) { row.click(); return true; }
      return false;
    }, t.matchTitle);

    if (!found) { console.log(`⚠ skipped ${t.status} — no demo contract with "${t.matchTitle}"`); continue; }

    await page.waitForTimeout(1500);

    // Screenshot just the top region (status bar + stepper) to focus the eye.
    const shot = path.join(OUT, `24-a8-stepper-${t.status.toLowerCase()}.png`);
    await page.screenshot({
      path: shot,
      clip: { x: 240, y: 0, width: 1200, height: 220 },
    });
    console.log('✓', path.relative(path.join(__dirname, '..'), shot));
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
