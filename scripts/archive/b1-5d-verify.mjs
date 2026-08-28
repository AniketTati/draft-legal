#!/usr/bin/env node
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
const BASE = 'http://localhost:5173';
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.fill('input[type="email"]', 'admin@demo.com');
  await p.fill('input[type="password"]', 'password123');
  await p.click('button[type="submit"]');
  await p.waitForTimeout(1600);
  await p.goto(BASE + '/contracts', { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.cursor-pointer')).find(
      r => r.textContent && r.textContent.includes('WPT Enterprises'));
    if (row) row.click();
  });
  await p.waitForTimeout(2500);
  const shot = path.join(OUT, '30-b15d-rail-risks-clauses.png');
  await p.screenshot({ path: shot });
  console.log('✓', path.relative(path.join(__dirname, '..'), shot));
  // Expand Risks + Clauses
  await p.evaluate(() => {
    document.querySelectorAll('aside button').forEach(btn => {
      const t = btn.textContent || '';
      if (/(Risks|Clauses|Clause Flags)/.test(t)) btn.click();
    });
  });
  await p.waitForTimeout(400);
  const shot2 = path.join(OUT, '31-b15d-rail-expanded.png');
  await p.screenshot({ path: shot2 });
  console.log('✓', path.relative(path.join(__dirname, '..'), shot2));
  await b.close();
})();
