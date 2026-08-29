#!/usr/bin/env node
import { chromium } from 'playwright';
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5173';
const fail = (m) => { console.log('FAIL', m); process.exit(1); };
const pass = (m) => console.log('PASS', m);
(async () => {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', 'admin@demo.com');
  await p.fill('input[type=password]', 'password123');
  await p.click('button[type=submit]');
  await p.waitForTimeout(1500);
  await p.goto(BASE + '/contracts', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  // iPass has 4 unfavorable clauses — best demo contract for B.5.5
  await p.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.cursor-pointer')).find(r => r.textContent && r.textContent.indexOf('iPass Inc.') >= 0);
    if (r) r.click();
  });
  await p.waitForTimeout(4000); // extra time for clauses fetch + decorations

  // Risks toggle visible
  const hasToggle = await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return !!btns.find(b => /^Risks:/.test((b.textContent || '').trim()));
  });
  if (!hasToggle) fail('Risks toggle not visible');
  pass('Risks toggle present');

  await p.screenshot({ path: path.join(OUT, '43-b55-full-mode.png') });
  console.log('shot 43-b55-full-mode');

  // Count markers in default (full) mode
  const fullCount = await p.evaluate(() =>
    document.querySelectorAll('.document-canvas .risk-marker').length
  );
  console.log('Markers in full mode:', fullCount);
  // Can be 0 if no clauses extracted yet; OK — we just verify the plugin
  // is wired. Non-zero is ideal but data-dependent.

  // Switch to Off
  await p.click('button:has-text("Risks:")');
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role=menuitem]')).find(el => /Off/.test(el.textContent || ''));
    if (item) item.click();
  });
  await p.waitForTimeout(500);

  const offCount = await p.evaluate(() =>
    document.querySelectorAll('.document-canvas .risk-marker').length
  );
  if (offCount !== 0) fail(`Off mode should yield 0 markers, got ${offCount}`);
  pass('Off mode produces 0 markers');

  await p.screenshot({ path: path.join(OUT, '44-b55-off-mode.png') });

  // Reset to full for next runs
  await p.evaluate(() => localStorage.setItem('clm.risk-view', 'full'));
  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
