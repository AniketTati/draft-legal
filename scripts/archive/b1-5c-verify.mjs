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
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await p.fill('input[type="email"]', 'admin@demo.com');
  await p.fill('input[type="password"]', 'password123');
  await p.click('button[type="submit"]');
  await p.waitForTimeout(1600);
  await p.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.cursor-pointer')).find(
      r => r.textContent && r.textContent.includes('iPass Inc.'),
    );
    if (row) row.click();
  });
  await p.waitForTimeout(2500);
  const shot = path.join(OUT, '29-b15c-rail-overview-keyterms.png');
  await p.screenshot({ path: shot });
  console.log('✓', path.relative(path.join(__dirname, '..'), shot));

  const railText = await p.evaluate(() => {
    const aside = document.querySelector('aside.w-80');
    return aside ? aside.innerText : '';
  });
  const hasOverview = railText.includes('OVERVIEW') || railText.includes('Overview');
  const hasKeyTerms = railText.includes('KEY TERMS') || railText.includes('Key Terms');
  console.log('Rail includes Overview:', hasOverview);
  console.log('Rail includes Key Terms:', hasKeyTerms);
  if (!hasOverview || !hasKeyTerms) { console.log('❌ FAIL'); process.exit(1); }
  console.log('✅ PASS — Overview + Key Terms rendered in rail');
  await b.close();
})();
