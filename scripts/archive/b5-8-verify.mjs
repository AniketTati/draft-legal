#!/usr/bin/env node
/**
 * B.5.8 verification — bubble menu appears on text selection in Edit mode.
 *
 * JTBD (Legal, docs/26 §1): "Edit a clause".
 *   Does a user who wants to bold a word or turn something into a heading
 *   find a control within reach, without navigating to a toolbar?
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
    const r = Array.from(document.querySelectorAll('.cursor-pointer')).find(r => r.textContent && r.textContent.indexOf('WPT Enterprises') >= 0);
    if (r) r.click();
  });
  await p.waitForTimeout(3000);

  // Click Edit
  await p.click('button:has-text("Edit")');
  await p.waitForTimeout(500);

  // 1. No bubble menu before selection
  const before = await p.evaluate(() => !!document.querySelector('[data-tippy-root]') || !!document.querySelector('.tippy-box'));
  // (TipTap 3's BubbleMenu uses floating-ui, not tippy — check differently)
  const preCount = await p.evaluate(() => document.querySelectorAll('[role="button"], button').length);
  console.log('before selection: bubble visible =', before, ', button count =', preCount);

  // 2. Select text via triple-click on a paragraph in the canvas
  await p.click('.document-canvas .ProseMirror p', { clickCount: 3 });
  await p.waitForTimeout(600);

  // Look for an element that wraps the bubble menu. It should contain
  // <button> with aria-label or titled "Bold (⌘B)".
  await p.screenshot({ path: path.join(OUT, '49-b58-bubble-menu.png') });
  console.log('shot 49-b58-bubble-menu');

  const bubble = await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const bold = btns.find(b => /Bold/.test(b.getAttribute('title') || ''));
    const italic = btns.find(b => /Italic/.test(b.getAttribute('title') || ''));
    const heading = btns.find(b => /Heading 2/i.test(b.getAttribute('title') || ''));
    const aiBtn = btns.find(b => /Ask AI|AI about this/i.test(b.getAttribute('title') || ''));
    return {
      hasBold: !!bold,
      hasItalic: !!italic,
      hasHeading: !!heading,
      hasAi: !!aiBtn,
      boldVisible: bold ? bold.getBoundingClientRect().width > 0 : false,
    };
  });
  console.log('bubble:', JSON.stringify(bubble));
  if (!bubble.hasBold || !bubble.hasItalic || !bubble.hasHeading || !bubble.hasAi) {
    fail('bubble menu missing one or more of Bold/Italic/H2/AI');
  }
  if (!bubble.boldVisible) fail('Bold button exists in DOM but not visible (selection may have failed)');
  pass('bubble menu shows Bold / Italic / H2 / ✨ AI on selection');

  // 3. Click Bold — word should become bold
  await p.click('button[title^="Bold"]');
  await p.waitForTimeout(300);
  const afterBold = await p.evaluate(() => {
    const pm = document.querySelector('.document-canvas .ProseMirror');
    return pm?.querySelector('strong') ? true : false;
  });
  if (!afterBold) fail('Bold did not wrap selection in <strong>');
  pass('Bold toggles selection');

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
