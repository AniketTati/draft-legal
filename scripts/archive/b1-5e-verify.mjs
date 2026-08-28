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
  // Expand History
  await p.evaluate(() => {
    document.querySelectorAll('aside button').forEach(btn => { if ((btn.textContent||'').includes('History')) btn.click(); });
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, '32-b15e-history-expanded.png') });
  console.log('✓ scripts/screenshots/desktop/32-b15e-history-expanded.png');
  await b.close();
})();
