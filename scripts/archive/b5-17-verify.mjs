#!/usr/bin/env node
/**
 * B.5.17 verification — Telemetry + onboarding + a11y polish.
 *
 * JTBD (docs/26 §6.12):
 *   "On my first visit, what are the three things I need to know about
 *    this canvas? And once I know them, don't teach me again."
 *
 *   Plus: "Does the canvas work with a keyboard and a screen reader?"
 *
 * Gates:
 *   1. First visit (cleared localStorage): the CoachMarks overlay
 *      renders with a dialog labelled "Getting started" and the "Ask AI"
 *      step visible.
 *   2. "Got it" through all steps marks the overlay as seen.
 *   3. Reload: overlay does NOT reappear.
 *   4. Telemetry: a ⌘K press produces a [telemetry] palette_opened
 *      entry in the console.
 *   5. A11y: risk markers have role=button + aria-label + tabindex so
 *      they're keyboard-operable.
 */
import { chromium } from 'playwright';
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5173';
const fail = (m) => { console.log('FAIL', m); process.exit(1); };
const pass = (m) => console.log('PASS', m);

async function login(p) {
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', 'admin@demo.com');
  await p.fill('input[type=password]', 'password123');
  await p.click('button[type=submit]');
  await p.waitForTimeout(1500);
}

(async () => {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  const consoleLogs = [];
  p.on('console', async m => {
    if (m.type() !== 'debug') return;
    // Pull the serialized args — message.text() stringifies objects to
    // "[Object]", losing the event name. We jsonValue each arg instead.
    try {
      const args = await Promise.all(m.args().map(a => a.jsonValue().catch(() => null)));
      consoleLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    } catch {
      consoleLogs.push(m.text());
    }
  });

  await login(p);

  // Clear any existing coach flag so we always start "first visit".
  await p.evaluate(() => window.localStorage.removeItem('clm.coach.contract-detail.v1'));
  await p.goto(BASE + '/contracts/cmn16g4xf001sdew25oas8dcy', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);

  // ── 1. CoachMarks overlay renders on first visit ─────────────────
  const coach = await p.evaluate(() => {
    const d = document.querySelector('div[role="dialog"][aria-label="Getting started"]');
    return {
      open:    !!d,
      h2:      d?.querySelector('h2')?.textContent || '',
      steps:   d?.querySelectorAll('[aria-label="Guide progress"] span').length ?? 0,
    };
  });
  console.log('coach:', JSON.stringify(coach));
  if (!coach.open) fail('CoachMarks not shown on first visit (localStorage was cleared)');
  if (coach.steps < 3) fail('CoachMarks missing step indicator dots');
  if (!/Ask AI/i.test(coach.h2)) fail('First step should introduce Ask AI / ⌘K');
  pass('CoachMarks overlay renders on first visit with 3-step indicator');

  await p.screenshot({ path: path.join(OUT, '71-b517-coach-step1.png'), fullPage: false });

  // ── 2. Click through: Next → Next → Got it dismisses ──────────────
  for (let i = 0; i < 3; i++) {
    const label = i === 2 ? 'Got it' : 'Next';
    await p.evaluate((lbl) => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => (b.textContent ?? '').trim().startsWith(lbl));
      btn?.click();
    }, label);
    await p.waitForTimeout(250);
  }
  const dismissed = await p.evaluate(() =>
    !document.querySelector('div[role="dialog"][aria-label="Getting started"]'));
  if (!dismissed) fail('CoachMarks should be dismissed after Got it');
  pass('Coach walkthrough completes and dismisses');

  // ── 3. Reload: overlay does NOT reappear ──────────────────────────
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
  const again = await p.evaluate(() =>
    !!document.querySelector('div[role="dialog"][aria-label="Getting started"]'));
  if (again) fail('Coach should not reappear once dismissed');
  pass('Coach does not reappear on reload (localStorage flag respected)');

  // ── 4. Telemetry: ⌘K press logs a palette_opened event ────────────
  consoleLogs.length = 0;
  await p.keyboard.press('Meta+K');
  // The telemetry buffer flushes every 2s in dev. Wait past that.
  await p.waitForTimeout(2400);
  const sawPalette = consoleLogs.some(l => /palette_opened/.test(l));
  if (!sawPalette) {
    console.log('--- console debug logs ---');
    consoleLogs.forEach(l => console.log(l.slice(0, 120)));
    fail('⌘K did not emit a palette_opened telemetry event');
  }
  pass('Telemetry records palette_opened event on ⌘K');

  // ── 5. A11y: risk markers have role/label/tabindex ───────────────
  // Close the palette that ⌘K opened
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  const a11y = await p.evaluate(() => {
    const markers = Array.from(document.querySelectorAll('.risk-marker'));
    if (markers.length === 0) return { count: 0 };
    return {
      count:       markers.length,
      hasRole:     markers.every(m => m.getAttribute('role') === 'button'),
      hasLabel:    markers.every(m => !!m.getAttribute('aria-label')),
      hasTabIdx:   markers.every(m => m.getAttribute('tabindex') === '0'),
      sampleLabel: markers[0].getAttribute('aria-label') || '',
    };
  });
  console.log('a11y:', JSON.stringify(a11y));
  if (a11y.count === 0) {
    console.log('WARN no risk markers found on this contract — a11y smoke skipped');
  } else {
    if (!a11y.hasRole)   fail('Risk markers missing role="button"');
    if (!a11y.hasLabel)  fail('Risk markers missing aria-label');
    if (!a11y.hasTabIdx) fail('Risk markers missing tabindex="0"');
    pass(`Risk markers keyboard-accessible (${a11y.count} markers, sample label: "${a11y.sampleLabel}")`);
  }

  await p.screenshot({ path: path.join(OUT, '72-b517-detail-coach-dismissed.png'), fullPage: false });

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
