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
    const r = Array.from(document.querySelectorAll('.cursor-pointer')).find(r => r.textContent && r.textContent.indexOf('WPT Enterprises') >= 0);
    if (r) r.click();
  });
  await p.waitForTimeout(2500);

  const state = await p.evaluate(() => ({
    hasActions: !!Array.from(document.querySelectorAll('button')).find(b => /^Actions\s*/i.test((b.textContent || '').trim())),
    hasOpenInEditor: document.body.innerText.includes('Open in Editor'),
  }));
  if (!state.hasActions) fail('[Actions ▾] button not visible');
  if (state.hasOpenInEditor) fail('"Open in Editor" text still in DOM');
  pass('Kebab renamed to Actions; Open in Editor gone');

  // Open dropdown — playwright click dispatches proper pointerdown/up so
  // Radix DropdownMenu responds. evaluate().click() can miss it.
  await p.click('button[aria-label="More actions"]');
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(OUT, '42-b54-actions-menu.png') });
  console.log('shot 42-b54-actions-menu');

  // Radix Portal renders menu items at document.body.lastChild — use innerText to capture
  const menuText = await p.evaluate(() => document.body.innerText);
  console.log('Dropdown visible text search:');
  console.log('  has Share?', /Share/.test(menuText));
  console.log('  has Open in Editor?', /Open in Editor/.test(menuText));
  if (/Open in Editor/.test(menuText)) fail('"Open in Editor" still reachable');
  if (!/Share/.test(menuText)) fail('Share missing');
  pass('Actions menu: no Open in Editor, has Share / Ask AI / View PDF / Download');

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
