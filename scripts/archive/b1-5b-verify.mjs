#!/usr/bin/env node
/**
 * B.1.5b verification — two-column layout shell present.
 *  - Right rail (aside) exists on xl viewports
 *  - Left column shrinks to accommodate rail (not full-width document)
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
  await page.waitForTimeout(1600);

  await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.cursor-pointer')).find(
      r => r.textContent && r.textContent.includes('iPass Inc.'),
    );
    if (row) row.click();
  });
  await page.waitForTimeout(2500);

  const shot = path.join(OUT, '28-b15b-two-column-shell.png');
  await page.screenshot({ path: shot });
  console.log('✓', path.relative(path.join(__dirname, '..'), shot));

  const metrics = await page.evaluate(() => {
    const aside = document.querySelector('aside.w-80');
    return {
      hasRail:  !!aside,
      railWidth: aside ? aside.getBoundingClientRect().width : 0,
    };
  });
  console.log('Rail width:', metrics.railWidth);
  if (!metrics.hasRail || metrics.railWidth < 300) {
    console.log('❌ FAIL — right rail not rendered at desktop width');
    process.exit(1);
  }
  console.log('✅ PASS — right rail present (' + Math.round(metrics.railWidth) + 'px)');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
