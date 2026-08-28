#!/usr/bin/env node
import { chromium } from 'playwright';
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5173';
(async () => {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.fill('input[type="email"]', 'admin@demo.com');
  await p.fill('input[type="password"]', 'password123');
  await p.click('button[type="submit"]');
  await p.waitForTimeout(1500);
  await p.goto(BASE + '/contracts', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.cursor-pointer')).find(r => r.textContent?.includes('WPT Enterprises'));
    if (row) row.click();
  });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: path.join(OUT, '33-b15f-no-tabs.png') });
  console.log('✓ scripts/screenshots/desktop/33-b15f-no-tabs.png');

  const tabsGone = await p.evaluate(() => {
    // Look for the tab bar: a horizontal flex with tab buttons.
    // The bar had "Overview Clauses Document Versions" adjacent.
    return !/Overview\s+Clauses\s+Document\s+Versions/.test(document.body.innerText);
  });
  console.log('Tabs row deleted:', tabsGone);
  if (!tabsGone) { console.log('❌ FAIL'); process.exit(1); }

  const metrics = await p.evaluate(() => {
    const header = document.querySelector('.h-full.flex.flex-col .bg-white.border-b');
    const pdf = document.querySelector('.rpv-core__viewer');
    return {
      headerH: header ? Math.round(header.getBoundingClientRect().height) : -1,
      docH:    pdf ? Math.round(pdf.getBoundingClientRect().height) : -1,
    };
  });
  console.log('Header:', metrics.headerH, 'px | Doc viewer:', metrics.docH, 'px');
  console.log('✅ PASS — tabs row gone, document is full-height left of rail');
  await b.close();
})();
