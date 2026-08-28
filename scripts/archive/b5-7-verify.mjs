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
  await p.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.cursor-pointer')).find(r => r.textContent && r.textContent.indexOf('iPass Inc.') >= 0);
    if (r) r.click();
  });
  await p.waitForTimeout(4000);

  const readProgress = () => p.evaluate(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const rail = asides.find(a => /OVERVIEW/.test(a.innerText));
    if (!rail) return null;
    const m = rail.innerText.match(/REVIEW PROGRESS\s*(\d+)\s*\/\s*(\d+)/i);
    return m ? { current: +m[1], total: +m[2] } : null;
  });

  const initial = await readProgress();
  console.log('initial progress:', JSON.stringify(initial));
  if (!initial) fail('progress bar missing');
  if (initial.total < 1) fail('total should be > 0 on iPass');
  pass(`initial progress ${initial.current} / ${initial.total}`);

  await p.screenshot({ path: path.join(OUT, '47-b57-progress-initial.png') });

  await p.evaluate(() => {
    const m = document.querySelector('.document-canvas .risk-marker');
    if (m) m.click();
  });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const drawer = asides.find(a => /HIGH RISK|DEVIATION/.test(a.innerText));
    const btn = Array.from(drawer.querySelectorAll('button')).find(b => /^Mark reviewed/i.test((b.textContent || '').trim()));
    if (btn) btn.click();
  });
  await p.waitForTimeout(1000);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);

  const afterMark = await readProgress();
  console.log('after mark:', JSON.stringify(afterMark));
  if (!afterMark || afterMark.current <= initial.current) fail('progress did not advance');
  pass(`progress advanced ${initial.current} → ${afterMark.current}`);

  await p.screenshot({ path: path.join(OUT, '48-b57-progress-after.png') });

  // Persistence check
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(4000);
  const afterReload = await readProgress();
  console.log('after reload:', JSON.stringify(afterReload));
  if (!afterReload || afterReload.current !== afterMark.current) fail('persistence failed');
  pass('progress persisted across reload');

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
