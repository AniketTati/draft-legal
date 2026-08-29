#!/usr/bin/env node
/**
 * B.5.15 verification — Signer portal (State 5).
 *
 * JTBD (docs/26 §4 "Signer" persona):
 *   "I'm external. I got a link. I want to read the document and sign
 *    it. I don't care about risks, clauses, AI, versions, or anything
 *    else. Show me the doc + one obvious Sign button."
 *
 * Gates:
 *   1. /sign/:token resolves and renders the document (piggy-backing on
 *      the portal contract endpoint until A.4 lands).
 *   2. Page chrome is minimal — no sidebar, no tab-bar, no comments.
 *   3. Sticky Sign bar is present at the bottom with one primary CTA.
 *   4. Clicking Sign opens the placeholder dialog that clearly marks
 *      this as stubbed for A.4 (no silent failure).
 *   5. Bad / expired token shows the "Link unavailable" state.
 */
import { chromium } from 'playwright';
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5173';
const API  = 'http://localhost:3001/api/v1';
const fail = (m) => { console.log('FAIL', m); process.exit(1); };
const pass = (m) => console.log('PASS', m);

const CONTRACT_ID = 'cmn16g4xf001sdew25oas8dcy';

async function adminLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  });
  return (await res.json()).accessToken;
}

(async () => {
  // Seed a 'read' portal link and use its token at /sign/:token.
  const accessToken = await adminLogin();
  const shareRes = await fetch(`${API}/contracts/${CONTRACT_ID}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ label: 'B.5.15 signer verify', permissions: ['read'], expiresInHours: 4 }),
  });
  const share = await shareRes.json();
  const portalJwt = share.portalUrl.split('/portal/')[1];
  pass('Created read-only share link and reused as sign token');

  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await c.newPage();

  // ── 1 & 2. Render + minimal chrome ───────────────────────────────
  await p.goto(`${BASE}/sign/${portalJwt}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);

  const chrome = await p.evaluate(() => {
    const hasAppShellSidebar = !!document.querySelector('nav, aside[class*="sidebar"], [class*="AppShell"]');
    const h1 = document.querySelector('h1')?.textContent || '';
    const hasDocument = !!document.querySelector('.ProseMirror');
    const hasCommentsTab = Array.from(document.querySelectorAll('button'))
      .some(b => /^\s*Comments\s*$/.test(b.textContent || ''));
    return { hasAppShellSidebar, h1, hasDocument, hasCommentsTab };
  });
  console.log('chrome:', JSON.stringify(chrome));
  if (chrome.hasAppShellSidebar) fail('Signer portal should not render the app sidebar');
  if (chrome.hasCommentsTab)     fail('Signer portal must not surface Comments tab');
  if (!/Zynga|WPT/i.test(chrome.h1)) fail('Document title missing');
  if (!chrome.hasDocument)       fail('Document editor not rendered');
  pass('Signer portal minimal chrome — no sidebar, no comments, doc shows');

  // ── 3. Sticky Sign bar present ───────────────────────────────────
  const bar = await p.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Sign bar"]');
    if (!region) return { found: false };
    const btn = Array.from(region.querySelectorAll('button'))
      .find(b => /^\s*Sign\s*$/.test(b.textContent || ''));
    return { found: true, hasSignBtn: !!btn };
  });
  if (!bar.found) fail('Sticky Sign bar missing');
  if (!bar.hasSignBtn) fail('Sign button not found in sticky bar');
  pass('Sticky Sign bar with one primary CTA');

  await p.screenshot({ path: path.join(OUT, '64-b515-signer-portal.png'), fullPage: false });

  // ── 4. Clicking Sign opens placeholder dialog (A.4 marker) ───────
  await p.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Sign bar"]');
    const btn = Array.from(region?.querySelectorAll('button') ?? [])
      .find(b => /^\s*Sign\s*$/.test(b.textContent || ''));
    btn?.click();
  });
  await p.waitForTimeout(400);
  const dialog = await p.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="Signing coming soon"]');
    return { open: !!d, mentionsA4: /A\.4/i.test(d?.textContent || '') };
  });
  if (!dialog.open) fail('Sign click did not open placeholder dialog');
  if (!dialog.mentionsA4) fail('Placeholder dialog should clearly mark the stub (mention A.4)');
  pass('Sign CTA opens A.4 placeholder dialog — no silent failure');

  await p.screenshot({ path: path.join(OUT, '65-b515-signer-sign-click.png'), fullPage: false });

  // ── 5. Bad token → link unavailable state ────────────────────────
  await p.goto(`${BASE}/sign/not-a-real-token`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  const unavailable = await p.evaluate(() => {
    const text = document.body.textContent || '';
    return /Link unavailable/i.test(text);
  });
  if (!unavailable) fail('Bad token should show "Link unavailable"');
  pass('Bad token shows link-unavailable state');

  // Cleanup the seed
  await fetch(`${API}/contracts/${CONTRACT_ID}/share/${share.shareLink.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
