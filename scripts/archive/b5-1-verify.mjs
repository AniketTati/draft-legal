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
    const rows = Array.from(document.querySelectorAll('.cursor-pointer'));
    const r = rows.find(r => r.textContent && r.textContent.indexOf('WPT Enterprises') >= 0);
    if (r) r.click();
  });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: path.join(OUT, '36-b51-wpt-ready.png') });
  console.log('shot 36-b51-wpt-ready');

  const ready = await p.evaluate(() => {
    const canvas = document.querySelector('.document-canvas');
    const pdf = document.querySelector('.rpv-core__viewer');
    const pm = document.querySelector('.document-canvas .ProseMirror');
    const font = pm ? getComputedStyle(pm).fontFamily : '';
    return { hasCanvas: !!canvas, hasPdf: !!pdf, hasProseMirror: !!pm, font };
  });
  if (!ready.hasCanvas) fail('no .document-canvas');
  if (ready.hasPdf) fail('PDF viewer still present');
  if (!ready.hasProseMirror) fail('no ProseMirror');
  if (!/(Times|Georgia|serif)/i.test(ready.font)) fail('non-serif font: ' + ready.font);
  pass('WPT ready · canvas+serif · no PDF');

  // FAILED state test
  await p.goto(BASE + '/contracts', { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.cursor-pointer')).find(r => r.textContent && r.textContent.indexOf('Unnamed Contract') >= 0);
    if (r) r.click();
  });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: path.join(OUT, '37-b51-failed-or-empty.png') });
  console.log('shot 37-b51-failed-or-empty');
  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
