#!/usr/bin/env node
/**
 * B.5.13 verification — Compare Versions mode (State 9).
 *
 * JTBD (docs/26 §4 row "Compare versions", Legal + Sales + Approver):
 *   "Show me what changed between these two versions, who changed it,
 *    and let me decide."
 *
 *   Negotiation outcomes depend on this. The old approach buried the
 *   diff in a tab called "Negotiate". B.5.13 elevates it to a first-
 *   class fullscreen mode reachable from a single header button.
 *
 * Gates:
 *   1. "Compare" button appears in the header when the contract has
 *      >= 2 versions.
 *   2. Clicking it opens a fullscreen dialog labelled "Compare versions"
 *      with two version picker dropdowns.
 *   3. The diff renders (insertions/deletions count visible).
 *   4. Attribution chips show author + relative date for both picks.
 *   5. Filter chips (All / Theirs / Ours / Pending) are present.
 *   6. Esc closes the mode and returns to the detail page.
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
  // WPT Enterprises has 14 versions — guaranteed candidate for comparison.
  await p.goto(BASE + '/contracts/cmn16g4xf001sdew25oas8dcy', { waitUntil: 'networkidle' });
  await p.waitForTimeout(3000);

  // ── 1. Compare button in header ──────────────────────────────────
  const hasCompareBtn = await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('header button, .bg-white button, [class*="border-b"] button'));
    return btns.some(b => /^\s*Compare\s*$/.test((b.textContent || '').replace(/\s+/g, ' ')));
  });
  if (!hasCompareBtn) fail('"Compare" header button not found on a contract with 2+ versions');
  pass('"Compare" button visible in header');

  // ── 2. Click → fullscreen dialog opens ──────────────────────────
  await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => /^\s*Compare\s*$/.test((b.textContent || '').replace(/\s+/g, ' ')));
    btn?.click();
  });
  await p.waitForTimeout(600);
  const dialogInfo = await p.evaluate(() => {
    const dlg = document.querySelector('div[role="dialog"][aria-label="Compare versions"]');
    if (!dlg) return { open: false };
    const selects = dlg.querySelectorAll('select');
    const filterBtns = Array.from(dlg.querySelectorAll('button')).map(b => (b.textContent || '').trim());
    return {
      open: true,
      pickerCount: selects.length,
      hasAll:      filterBtns.some(t => /^all$/i.test(t)),
      hasTheirs:   filterBtns.some(t => /^theirs$/i.test(t)),
      hasOurs:     filterBtns.some(t => /^ours$/i.test(t)),
      hasPending:  filterBtns.some(t => /^pending$/i.test(t)),
    };
  });
  console.log('dialog:', JSON.stringify(dialogInfo));
  if (!dialogInfo.open) fail('Compare dialog did not open');
  if (dialogInfo.pickerCount < 2) fail('Expected two version-picker dropdowns');
  pass('Compare mode opens as fullscreen dialog with two version pickers');

  // ── 3. Diff renders ──────────────────────────────────────────────
  const diffStats = await p.waitForFunction(
    () => {
      const dlg = document.querySelector('div[role="dialog"][aria-label="Compare versions"]');
      if (!dlg) return false;
      const txt = dlg.textContent || '';
      return /\d+\s*added/i.test(txt) && /\d+\s*removed/i.test(txt);
    },
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  if (!diffStats) {
    const snap = await p.evaluate(() => document.querySelector('div[role="dialog"][aria-label="Compare versions"]')?.textContent?.slice(0, 200));
    console.log('dialog text:', snap);
    fail('Diff stats ("X added, Y removed") never rendered');
  }
  pass('Diff rendered with insertion/deletion stats');

  // ── 4. Attribution chips present ─────────────────────────────────
  const attrInfo = await p.evaluate(() => {
    const dlg = document.querySelector('div[role="dialog"][aria-label="Compare versions"]');
    const txt = dlg?.textContent || '';
    return {
      hasV: /v\d+/.test(txt),
      hasRelDate: /(today|yesterday|\d+d ago|[A-Z][a-z]{2}\s+\d+)/.test(txt),
    };
  });
  if (!attrInfo.hasV) fail('Attribution chips missing version label');
  if (!attrInfo.hasRelDate) fail('Attribution chips missing relative date');
  pass('Attribution chips show version + relative date');

  // ── 5. Filter chips present ──────────────────────────────────────
  if (!(dialogInfo.hasAll && dialogInfo.hasTheirs && dialogInfo.hasOurs && dialogInfo.hasPending)) {
    fail('Expected filter chips All / Theirs / Ours / Pending');
  }
  pass('Filter chips present (stubs until v1.1)');

  await p.screenshot({ path: path.join(OUT, '61-b513-compare-mode.png'), fullPage: false });

  // ── 6. Esc closes ────────────────────────────────────────────────
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  const closed = await p.evaluate(() =>
    !document.querySelector('div[role="dialog"][aria-label="Compare versions"]'));
  if (!closed) fail('Esc did not close Compare mode');
  pass('Esc returns to detail page');

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
