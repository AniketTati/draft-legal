#!/usr/bin/env node
/**
 * B.5.10 verification — Approver Mode + Decision Strip.
 *
 * JTBD (docs/26 §4 matrix for the "Approver" persona, cells 3,5,6,7,8):
 *   "Decide quickly with enough signal to trust the decision."
 *
 *   Old world: scattered tabs (Approval / Ask / Overview / Clauses),
 *   no one-glance signal, no in-page CTAs without navigating away.
 *   New world: top strip compresses AI Confidence · Risk · Recommendation
 *   · Top blocker into one row with Approve / Reject / Delegate CTAs
 *   right there. Risk markers recolor amber — softer tone for the
 *   decision-maker persona per docs/26 §3 (amber inline risks in State 4).
 *
 * Assumes: seed shell `scripts/b5-10-seed-approval.sh` has already been
 * run — it creates a PENDING approval step on the WPT contract for
 * admin@demo.com so the strip actually renders.
 *
 * Gates:
 *   1. On load, strip appears above the document when the viewer is the
 *      pending approver. No strip for users who aren't in the queue.
 *   2. Strip shows: AI Confidence %, Risk %, AI Recommendation chip, Top
 *      blocker text, Approve/Reject/Delegate buttons.
 *   3. Risk markers carry the amber tone class (document-canvas--tone-amber).
 *   4. Clicking "Reject" expands an inline comment row (no modal pop).
 *      Approving is one click + optional note.
 *
 * We do NOT decide the step here — that would clear the pending row and
 * break re-runs of the verify. We exercise the UI interactions up to but
 * not including the final mutate.
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

  // ── Login + navigate ─────────────────────────────────────────────
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', 'admin@demo.com');
  await p.fill('input[type=password]', 'password123');
  await p.click('button[type=submit]');
  await p.waitForTimeout(1500);
  await p.goto(BASE + '/contracts', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.cursor-pointer'))
      .find(r => r.textContent && r.textContent.indexOf('WPT Enterprises') >= 0);
    if (r) r.click();
  });
  await p.waitForTimeout(3000);

  // ── 1. Strip appears ─────────────────────────────────────────────
  const strip = await p.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Approval decision strip"]');
    if (!region) return { found: false };
    const txt = region.textContent || '';
    const btns = Array.from(region.querySelectorAll('button')).map(b => b.textContent?.trim() ?? '');
    return {
      found:       true,
      awaiting:    /Awaiting your decision/i.test(txt),
      hasConfidence: /Confidence/i.test(txt),
      hasRisk:     /Risk\s+\d+%/i.test(txt),
      hasRec:      /AI:\s*(Approve|Reject|Review)/i.test(txt),
      hasTopBlocker: /Top blocker/i.test(txt),
      buttons:     btns,
    };
  });
  console.log('strip:', JSON.stringify(strip));
  if (!strip.found) fail('DecisionStrip not rendered — seed may not have run, or approver detection broke');
  if (!strip.awaiting) fail('Strip missing "Awaiting your decision" label');
  if (!strip.hasConfidence) fail('Strip missing AI Confidence');
  if (!strip.hasRisk) fail('Strip missing Risk %');
  if (!strip.hasRec) fail('Strip missing AI Recommendation chip');
  if (!strip.hasTopBlocker) fail('Strip missing Top blocker');
  if (!strip.buttons.some(b => /Approve/.test(b))) fail('Approve button missing');
  if (!strip.buttons.some(b => /Reject/.test(b)))  fail('Reject button missing');
  if (!strip.buttons.some(b => /Delegate/.test(b))) fail('Delegate button missing');
  pass('DecisionStrip rendered with full signal + 3 CTAs');

  await p.screenshot({ path: path.join(OUT, '54-b510-approver-mode.png'), fullPage: false });

  // ── 2. Risk markers use amber tone class ─────────────────────────
  const toneCheck = await p.evaluate(() => {
    const art = document.querySelector('article.document-canvas');
    return {
      hasToneClass: !!art && art.classList.contains('document-canvas--tone-amber'),
    };
  });
  if (!toneCheck.hasToneClass) fail('DocumentCanvas missing document-canvas--tone-amber class in approver mode');
  pass('Document canvas tone shifted to amber');

  // ── 3. Reject expands inline comment row ─────────────────────────
  // Pick the Reject button (not the "AI: Reject..." recommendation chip —
  // that's a div, not a button with Reject as its only word).
  await p.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('[role="region"][aria-label="Approval decision strip"] button'));
    const btn = buttons.find(b => (b.textContent || '').trim().startsWith('Reject'));
    if (btn) btn.click();
  });
  await p.waitForTimeout(400);
  const rejectExpanded = await p.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Approval decision strip"]');
    const ta = region?.querySelector('textarea');
    return {
      hasTextarea: !!ta,
      placeholder: ta?.getAttribute('placeholder') || '',
      confirmDisabled: !!Array.from(region?.querySelectorAll('button') ?? [])
        .find(b => /Confirm Reject/.test(b.textContent || '') && b.hasAttribute('disabled')),
    };
  });
  console.log('reject-expand:', JSON.stringify(rejectExpanded));
  if (!rejectExpanded.hasTextarea) fail('Reject should expand a required-comment textarea');
  if (!/Reason for rejection/i.test(rejectExpanded.placeholder)) fail('Reject textarea placeholder missing');
  if (!rejectExpanded.confirmDisabled) fail('Confirm Reject should be disabled until comment is entered');
  pass('Reject expands inline required-comment row, Confirm disabled until filled');

  await p.screenshot({ path: path.join(OUT, '55-b510-reject-row.png'), fullPage: false });

  // ── 4. Cancel then Approve path is one-click + optional note ─────
  await p.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('[role="region"][aria-label="Approval decision strip"] button'));
    const cancel = buttons.find(b => /^Cancel$/.test((b.textContent || '').trim()));
    if (cancel) cancel.click();
  });
  await p.waitForTimeout(200);
  await p.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('[role="region"][aria-label="Approval decision strip"] button'));
    const btn = buttons.find(b => (b.textContent || '').trim().startsWith('Approve'));
    if (btn) btn.click();
  });
  await p.waitForTimeout(400);
  const approveExpanded = await p.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Approval decision strip"]');
    const inp = region?.querySelector('input[type=text], input:not([type])');
    const confirm = Array.from(region?.querySelectorAll('button') ?? [])
      .find(b => /Confirm Approve/.test(b.textContent || ''));
    return {
      hasInput:          !!inp,
      confirmEnabled:    !!confirm && !confirm.hasAttribute('disabled'),
    };
  });
  console.log('approve-expand:', JSON.stringify(approveExpanded));
  if (!approveExpanded.hasInput) fail('Approve should show an optional-note input');
  if (!approveExpanded.confirmEnabled) fail('Confirm Approve should be enabled even without a note');
  pass('Approve path shows optional note, Confirm enabled immediately');

  await p.screenshot({ path: path.join(OUT, '56-b510-approve-row.png'), fullPage: false });

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
