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
  // iPass has 4 unfavorable clauses — our demo case.
  await p.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.cursor-pointer')).find(r => r.textContent && r.textContent.indexOf('iPass Inc.') >= 0);
    if (r) r.click();
  });
  await p.waitForTimeout(4000);

  // Log diagnostic state
  const diag = await p.evaluate(() => ({
    markers: document.querySelectorAll('.document-canvas .risk-marker').length,
    riskPref: localStorage.getItem('clm.risk-view'),
    riskToggle: Array.from(document.querySelectorAll('button'))
      .find(b => /^Risks:/.test((b.textContent || '').trim()))?.textContent?.trim(),
    canvas: !!document.querySelector('.document-canvas'),
    proseMirror: !!document.querySelector('.ProseMirror'),
    pmTextLen: document.querySelector('.ProseMirror')?.innerText?.length || 0,
  }));
  console.log('diag:', JSON.stringify(diag));
  if (diag.markers === 0) fail('no risk markers on iPass — check diag above');

  // Click the first risk marker
  await p.evaluate(() => {
    const m = document.querySelector('.document-canvas .risk-marker');
    if (m) (m).click();
  });
  await p.waitForTimeout(500);

  const drawerOpen = await p.evaluate(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const dump = asides.map(a => ({
      visible: a.getBoundingClientRect().width > 0,
      width: a.getBoundingClientRect().width,
      first80: a.innerText.slice(0, 80),
    }));
    console.log('asides dump', JSON.stringify(dump));
    const drawer = asides.find(a => /HIGH RISK|DEVIATION|NOTED/.test(a.innerText));
    if (!drawer) return { visible: false, dump };
    const text = drawer.innerText;
    return {
      visible: drawer.getBoundingClientRect().width > 0,
      dump,
      hasHighRiskOrDeviation: /HIGH RISK|DEVIATION/.test(text),
      hasWhy: /Why this matters/i.test(text),
      hasActions: /Accept AI suggestion/.test(text) && /Edit manually/.test(text) && /Mark reviewed/.test(text),
    };
  });
  console.log('drawer:', JSON.stringify(drawerOpen));
  if (!drawerOpen || !drawerOpen.visible) fail('drawer not visible');
  if (!drawerOpen.hasHighRiskOrDeviation) fail('severity pill missing');
  if (!drawerOpen.hasWhy) fail('Why section missing');
  if (!drawerOpen.hasActions) fail('Actions missing');
  pass('drawer opens with severity + Why + actions');

  await p.screenshot({ path: path.join(OUT, '45-b56-drawer-open.png') });
  console.log('shot 45-b56-drawer-open');

  // Read the current counter, then click Next, then expect it to change.
  const readIdx = () => p.evaluate(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const drawer = asides.find(a => /HIGH RISK|DEVIATION|NOTED/.test(a.innerText));
    if (!drawer) return null;
    const m = drawer.innerText.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { cur: +m[1], total: +m[2] } : null;
  });
  const before = await readIdx();
  if (!before) fail('could not read counter');
  console.log('counter before Next:', before);

  // If we're already at last, nav backward first; otherwise forward.
  const goForward = before.cur < before.total;
  if (goForward) {
    await p.click('aside button[aria-label^="Next"]');
  } else {
    await p.click('aside button[aria-label^="Previous"]');
  }
  await p.waitForTimeout(300);

  const after = await readIdx();
  console.log('counter after nav:', after);
  if (!after || after.cur === before.cur) fail('nav did not change counter');
  pass(`nav: ${before.cur} → ${after.cur}`);

  // Read state pill before + after Mark reviewed click
  const readState = () => p.evaluate(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const drawer = asides.find(a => /HIGH RISK|DEVIATION|NOTED/.test(a.innerText));
    // State pill is the uppercase "Unreviewed" | "Reviewed" | "Resolved" chip
    const pill = drawer.querySelector('span.capitalize');
    return pill?.textContent?.trim().toLowerCase() ?? null;
  });
  const stateBefore = await readState();
  console.log('state before Mark Reviewed:', stateBefore);

  await p.evaluate(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const drawer = asides.find(a => /HIGH RISK|DEVIATION|NOTED/.test(a.innerText));
    const btn = Array.from(drawer.querySelectorAll('button')).find(b => /Mark reviewed/i.test(b.textContent || ''));
    if (btn) btn.click();
  });
  await p.waitForTimeout(400);

  const stateAfter = await readState();
  console.log('state after Mark Reviewed:', stateAfter);
  if (stateAfter !== 'reviewed') fail(`expected state 'reviewed', got '${stateAfter}'`);
  pass('Mark reviewed advances state pill to reviewed');

  // Esc closes — drawer's HIGH RISK should disappear, regular rail OVERVIEW returns
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  const afterEsc = await p.evaluate(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const hasDrawer = asides.some(a => /HIGH RISK|DEVIATION/.test(a.innerText) && a.getBoundingClientRect().width > 0);
    const hasRail = asides.some(a => /OVERVIEW/.test(a.innerText) && a.getBoundingClientRect().width > 0);
    return { hasDrawer, hasRail };
  });
  console.log('after Esc:', JSON.stringify(afterEsc));
  if (afterEsc.hasDrawer) fail('drawer still visible after Esc');
  if (!afterEsc.hasRail) fail('regular rail not restored after Esc');
  pass('Esc closes drawer and restores regular rail');

  await p.screenshot({ path: path.join(OUT, '46-b56-after-esc.png') });
  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
