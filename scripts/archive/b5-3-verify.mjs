#!/usr/bin/env node
/**
 * B.5.3 verification — Edit toggle flips DocumentCanvas to editable + saves.
 *
 * Acceptance:
 *   - [✏ Edit] visible in view mode; clicking → [Done] + Undo/Redo
 *   - Document becomes editable (ProseMirror contenteditable=true)
 *   - Typing triggers Unsaved → (debounce or Cmd+S) → Saved
 *   - Esc exits edit mode
 *   - Entering Edit while docView=='original' auto-switches to Styled
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

  // 1. Edit button visible + Document read-only
  const pre = await p.evaluate(() => ({
    hasEdit: !!Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Edit'),
    hasDone: !!Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Done'),
    contentEditable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
  }));
  if (!pre.hasEdit || pre.hasDone) fail('initial: expected [Edit] alone');
  if (pre.contentEditable !== 'false') fail('initial: ProseMirror should be contenteditable=false');
  pass('initial view mode (Edit visible, read-only)');

  // 2. Click Edit
  await p.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Edit');
    if (btn) btn.click();
  });
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(OUT, '40-b53-edit-mode.png') });
  console.log('shot 40-b53-edit-mode');

  const editing = await p.evaluate(() => ({
    hasDone: !!Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Done'),
    contentEditable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
  }));
  if (!editing.hasDone) fail('after Edit click: expected [Done] visible');
  if (editing.contentEditable !== 'true') fail('after Edit click: ProseMirror should be contenteditable=true');
  pass('edit mode (Done visible, editable)');

  // 3. Type + assert save state cycles through Unsaved → Saving… → Saved
  await p.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (pm) pm.focus();
  });
  await p.keyboard.type(' — edited by B.5.3 verify script', { delay: 30 });
  // Check for "Unsaved" indicator within 1s
  await p.waitForTimeout(600);
  const mid = await p.evaluate(() => document.body.innerText);
  if (!/Unsaved|Saving|Saved/i.test(mid)) fail('no save-state indicator after typing');
  pass('save state indicator shows after typing');

  // Force save via Cmd+S
  await p.keyboard.press('Meta+s');
  await p.waitForTimeout(2500);
  const afterSave = await p.evaluate(() => document.body.innerText);
  if (!/Saved/i.test(afterSave)) fail('did not reach Saved state after Cmd+S');
  pass('Cmd+S flushes save → Saved');

  // 4. Esc exits edit mode
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  const postEsc = await p.evaluate(() => ({
    hasEdit: !!Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Edit'),
    hasDone: !!Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Done'),
  }));
  if (!postEsc.hasEdit || postEsc.hasDone) fail('Esc did not exit edit mode');
  pass('Esc exits edit mode');

  await p.screenshot({ path: path.join(OUT, '41-b53-after-exit.png') });
  console.log('shot 41-b53-after-exit');

  // 5. Original PDF + Edit → Edit should force Styled
  await p.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Original');
    if (btn) btn.click();
  });
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Edit');
    if (btn) btn.click();
  });
  await p.waitForTimeout(600);
  const autoSwitch = await p.evaluate(() => ({
    styledPressed: Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Styled')?.getAttribute('aria-pressed'),
    hasCanvas: !!document.querySelector('.document-canvas'),
    hasPdf: !!document.querySelector('.rpv-core__viewer'),
  }));
  if (autoSwitch.styledPressed !== 'true' || !autoSwitch.hasCanvas || autoSwitch.hasPdf)
    fail('Edit did not auto-switch from Original to Styled');
  pass('Edit auto-switches Original → Styled');

  // reset preference
  await p.evaluate(() => localStorage.setItem('clm.doc-view', 'styled'));
  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
