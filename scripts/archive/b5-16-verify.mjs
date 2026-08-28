#!/usr/bin/env node
/**
 * B.5.16 verification — Responsive contract detail (State 7).
 *
 * JTBD (docs/26 §4 row "Responsive"):
 *   "I pulled this up on my iPad / phone between meetings. Everything
 *    must still fit and stay usable."
 *
 *   The rail is the piece that doesn't fit at narrow viewports.
 *   B.5.16 turns it into a slide-in drawer (tablet) / bottom sheet
 *   (mobile) while keeping the full two-column layout at ≥1280.
 *
 * Gates (three viewports):
 *   1. Desktop 1440×900: rail is visible statically, no trigger pill.
 *   2. Tablet 1024×768:  rail hidden; "Details" trigger pill visible;
 *       clicking it slides the rail in from the right.
 *   3. Mobile 375×812:   same pattern but the rail becomes a bottom
 *       sheet (pulls up from the bottom edge).
 *   4. Esc closes the drawer on < xl viewports.
 */
import { chromium } from 'playwright';
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5173';
const fail = (m) => { console.log('FAIL', m); process.exit(1); };
const pass = (m) => console.log('PASS', m);

async function openDetail(p) {
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', 'admin@demo.com');
  await p.fill('input[type=password]', 'password123');
  await p.click('button[type=submit]');
  await p.waitForTimeout(1500);
  // Navigate directly to WPT so the viewport width stays consistent
  // through the test (list → detail can reflow differently).
  await p.goto(BASE + '/contracts/cmn16g4xf001sdew25oas8dcy', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
}

async function railInfo(p) {
  return p.evaluate(() => {
    const aside = document.querySelector('aside[aria-label="Contract rail"]');
    if (!aside) return { exists: false };
    const r = aside.getBoundingClientRect();
    const trigger = document.querySelector('button[aria-label="Open details rail"]');
    const backdrop = document.querySelector('.fixed.inset-0.z-30.bg-black\\/20');
    return {
      exists: true,
      visibleWidth: r.width,
      visibleHeight: r.height,
      top: r.top,
      right: window.innerWidth - r.right,
      hasTrigger: !!trigger,
      hasBackdrop: !!backdrop,
      onScreen: r.left < window.innerWidth && r.right > 0 && r.top < window.innerHeight && r.bottom > 0,
    };
  });
}

(async () => {
  const b = await chromium.launch({ headless: true });

  // ── 1. Desktop 1440×900 ─────────────────────────────────────────
  {
    const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    await openDetail(p);
    const info = await railInfo(p);
    console.log('desktop:', JSON.stringify(info));
    if (!info.exists)           fail('<aside> missing on desktop');
    if (info.visibleWidth < 200) fail('Rail should be a static column ≥200px wide on desktop');
    if (info.hasTrigger)         fail('Floating trigger should NOT render at xl+');
    pass('Desktop (1440): static rail, no trigger pill');
    await p.screenshot({ path: path.join(OUT, '66-b516-desktop.png'), fullPage: false });
    await c.close();
  }

  // ── 2. Tablet 1024×768 ─────────────────────────────────────────
  {
    const c = await b.newContext({ viewport: { width: 1024, height: 768 } });
    const p = await c.newPage();
    await openDetail(p);
    const closed = await railInfo(p);
    console.log('tablet (closed):', JSON.stringify(closed));
    if (!closed.hasTrigger) fail('Tablet should show the floating trigger pill when rail is closed');
    // Rail should be off-screen (translate-x-full pushes it past the right edge)
    if (closed.onScreen && closed.visibleWidth > 10) fail('Tablet rail should be off-screen when closed');
    pass('Tablet (1024) closed: trigger visible, rail off-screen');
    await p.screenshot({ path: path.join(OUT, '67-b516-tablet-closed.png'), fullPage: false });

    // Click trigger → drawer slides in
    await p.click('button[aria-label="Open details rail"]');
    await p.waitForTimeout(400);
    const open = await railInfo(p);
    console.log('tablet (open):', JSON.stringify(open));
    if (!open.hasBackdrop) fail('Tablet rail open should show backdrop');
    if (!open.onScreen)    fail('Tablet rail should be on-screen after clicking trigger');
    pass('Tablet (1024) open: drawer slides in, backdrop shows');
    await p.screenshot({ path: path.join(OUT, '68-b516-tablet-open.png'), fullPage: false });

    // Esc closes
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    const afterEsc = await railInfo(p);
    if (afterEsc.hasBackdrop) fail('Esc did not close the drawer');
    pass('Tablet: Esc closes the drawer');
    await c.close();
  }

  // ── 3. Mobile 375×812 ──────────────────────────────────────────
  {
    const c = await b.newContext({ viewport: { width: 375, height: 812 } });
    const p = await c.newPage();
    await openDetail(p);
    const closed = await railInfo(p);
    console.log('mobile (closed):', JSON.stringify(closed));
    if (!closed.hasTrigger && closed.visibleHeight > 100) {
      fail('Mobile: expected bottom-sheet peek to be thin (≤ ~80px) when closed OR a trigger pill');
    }
    pass('Mobile (375): closed rail either peek-height or hidden with trigger');
    await p.screenshot({ path: path.join(OUT, '69-b516-mobile-closed.png'), fullPage: false });

    // Mobile: the peek header itself is the trigger (no separate pill).
    await p.evaluate(() => {
      const aside = document.querySelector('aside[aria-label="Contract rail"]');
      const header = aside && aside.querySelector('div.cursor-pointer');
      if (header) header.click();
    });
    await p.waitForTimeout(500);
    const open = await railInfo(p);
    console.log('mobile (open):', JSON.stringify(open));
    if (open.visibleHeight < 200) fail('Mobile sheet should expand when opened');
    pass('Mobile: peek-header toggles bottom sheet expanded');
    await p.screenshot({ path: path.join(OUT, '70-b516-mobile-open.png'), fullPage: false });
    await c.close();
  }

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
