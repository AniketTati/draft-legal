#!/usr/bin/env node
/**
 * B.5.2 verification — [Styled | Original] toggle.
 *
 * Acceptance:
 *   - Toggle renders with Styled / Original options
 *   - Styled is default (aria-pressed="true")
 *   - Document-canvas visible, PDF viewer absent
 *   - Clicking Original swaps canvas → PDF viewer
 *   - Preference persists across reload
 */
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

  await p.screenshot({ path: path.join(OUT, '38-b52-styled.png') });
  console.log('shot 38-b52-styled');

  const initial = await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const sb = btns.find(b => b.textContent === 'Styled');
    const ob = btns.find(b => b.textContent === 'Original');
    return {
      hasStyled: !!sb,
      hasOriginal: !!ob,
      styledPressed: sb && sb.getAttribute('aria-pressed'),
      originalPressed: ob && ob.getAttribute('aria-pressed'),
      hasCanvas: !!document.querySelector('.document-canvas'),
      hasPdf: !!document.querySelector('.rpv-core__viewer'),
    };
  });
  if (!initial.hasStyled || !initial.hasOriginal) fail('toggle missing');
  if (initial.styledPressed !== 'true') fail('styled not default');
  if (!initial.hasCanvas || initial.hasPdf) fail('wrong view on init');
  pass('initial Styled view');

  await p.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Original');
    if (btn) btn.click();
  });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: path.join(OUT, '39-b52-original.png') });
  console.log('shot 39-b52-original');

  const after = await p.evaluate(() => ({
    hasCanvas: !!document.querySelector('.document-canvas'),
    hasPdf: !!document.querySelector('.rpv-core__viewer'),
    originalPressed: Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Original')?.getAttribute('aria-pressed'),
  }));
  if (after.hasCanvas || !after.hasPdf) fail('did not swap to PDF');
  if (after.originalPressed !== 'true') fail('original not pressed');
  pass('swap to Original PDF');

  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const reloaded = await p.evaluate(() => ({
    originalPressed: Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Original')?.getAttribute('aria-pressed'),
    hasPdf: !!document.querySelector('.rpv-core__viewer'),
  }));
  if (reloaded.originalPressed !== 'true') fail('pref not persisted');
  if (!reloaded.hasPdf) fail('PDF not rendered after reload');
  pass('preference persisted across reload');

  // Reset for subsequent runs
  await p.evaluate(() => localStorage.setItem('clm.doc-view', 'styled'));
  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
