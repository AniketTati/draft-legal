#!/usr/bin/env node
/**
 * B.1.5a verification — StatusStepper row gone; StatusPill inline in header.
 *
 * Acceptance:
 *   - The horizontal stepper row ("Draft / In Review / Approval / Approved /
 *     Signature / Executed" laid out horizontally) is no longer rendered.
 *   - Clicking the status pill next to the title opens a popover showing
 *     the vertical lifecycle.
 *   - Header region shrinks by ~96px (was ~168px, target ~72px).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
const BASE = 'http://localhost:5173';
fs.mkdirSync(OUT, { recursive: true });

const fail = (msg) => { console.log('❌ FAIL —', msg); process.exit(1); };
const pass = (msg) => console.log('✅ PASS —', msg);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'admin@demo.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1800);

  await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cursor-pointer'));
    const row = rows.find(r => r.textContent && r.textContent.includes('iPass Inc.'));
    if (row) row.click();
  });
  await page.waitForTimeout(2500);

  // Pill-closed shot (header + start of document)
  const shotClosed = path.join(OUT, '26-b15a-pill-closed.png');
  await page.screenshot({ path: shotClosed, clip: { x: 240, y: 0, width: 1200, height: 220 } });
  console.log('✓', path.relative(path.join(__dirname, '..'), shotClosed));

  // Measure the header height — the white header block
  const headerMetrics = await page.evaluate(() => {
    // The header is the first `bg-white border-b` block under the app main.
    const header = document.querySelector('.h-full.flex.flex-col .bg-white.border-b');
    return header ? { height: header.getBoundingClientRect().height } : null;
  });
  console.log('Header height:', headerMetrics?.height, 'px');
  if (!headerMetrics || headerMetrics.height > 110) {
    fail(`Header should be ≤110px after removing stepper; got ${headerMetrics?.height}`);
  }
  pass(`Header compact (${Math.round(headerMetrics.height)}px)`);

  // Assert no horizontal stepper row in DOM
  const hasHorizontalStepper = await page.evaluate(() => {
    // The old stepper used text labels in a horizontal flex — search for a
    // sibling set containing the sequence "Draft", "In Review", "Approval".
    const body = document.body.innerText;
    // If the layout ever shows "Draft     In Review     Approval" (3+ spaces),
    // the stepper is still there. The StatusPill popover only shows one at a
    // time, or if open, as a vertical list.
    return /Draft\s{3,}In Review\s{3,}Approval/.test(body);
  });
  if (hasHorizontalStepper) fail('Horizontal stepper row still present');
  pass('No horizontal stepper row detected');

  // Open the pill — click the status chip (first button with "Draft" text near title)
  const popoverOpened = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[aria-label*="Contract status"]'));
    if (!btns.length) return false;
    btns[0].click();
    return true;
  });
  if (!popoverOpened) fail('Could not find StatusPill trigger');
  await page.waitForTimeout(300);

  const popoverVisible = await page.evaluate(() => {
    return !!document.querySelector('[role="dialog"][aria-label="Contract lifecycle"]');
  });
  if (!popoverVisible) fail('Popover did not open');
  pass('Popover opens on click');

  const shotOpen = path.join(OUT, '27-b15a-pill-open.png');
  await page.screenshot({ path: shotOpen, clip: { x: 240, y: 0, width: 1200, height: 380 } });
  console.log('✓', path.relative(path.join(__dirname, '..'), shotOpen));

  console.log('\n✅ B.1.5a verification complete');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
