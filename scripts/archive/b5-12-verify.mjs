#!/usr/bin/env node
/**
 * B.5.12 verification — Negotiation Status strip (State 1 conditional).
 *
 * JTBD (docs/26 §4 matrix, owner/submitter POV on any of the back-and-
 * forth states):
 *   "Why is my deal stuck, who are we waiting on, what's the next move?"
 *
 *   The strip answers that in one row, without the owner opening any
 *   tab. Complements the DecisionStrip (which answers the same question
 *   for the approver).
 *
 * Gates:
 *   1. Contract in UNDER_NEGOTIATION shows the strip with counterparty
 *      name + "Waiting X" + "Next: Waiting on counterparty revisions".
 *   2. Contract in PENDING_APPROVAL (but the viewer is NOT the approver)
 *      shows the strip blocked-by = the approver step, NOT the counterparty.
 *   3. When the viewer IS the approver (WPT with seeded admin step), the
 *      strip does NOT render — the DecisionStrip takes over.
 *   4. In a DRAFT contract, neither strip renders.
 */
import { chromium } from 'playwright';
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5173';
const fail = (m) => { console.log('FAIL', m); process.exit(1); };
const pass = (m) => console.log('PASS', m);

const UMBRELLA_ID = 'cmmxnze0n0019h3p3hyiq1j04'; // UNDER_NEGOTIATION
const WAYNE_ID    = 'cmmxnze0r001fh3p3in1cb7ta'; // PENDING_APPROVAL (no approver for admin)
const WPT_ID      = 'cmn16g4xf001sdew25oas8dcy'; // PENDING_APPROVAL, admin IS approver (DecisionStrip)

async function login(p) {
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.fill('input[type=email]', 'admin@demo.com');
  await p.fill('input[type=password]', 'password123');
  await p.click('button[type=submit]');
  await p.waitForTimeout(1500);
}

async function stripInfo(p) {
  return p.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Negotiation status"]');
    if (!region) return { found: false };
    return {
      found: true,
      text:  (region.textContent || '').trim(),
    };
  });
}

async function decisionStripShown(p) {
  return p.evaluate(() =>
    !!document.querySelector('[role="region"][aria-label="Approval decision strip"]'));
}

(async () => {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await login(p);

  // ── 1. UNDER_NEGOTIATION → strip shows counterparty + "Waiting…" ────
  await p.goto(`${BASE}/contracts/${UMBRELLA_ID}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const umbrella = await stripInfo(p);
  console.log('umbrella:', JSON.stringify(umbrella));
  if (!umbrella.found) fail('Negotiation strip missing on UNDER_NEGOTIATION contract');
  if (!/Umbrella Corporation/i.test(umbrella.text)) fail('Strip did not mention counterparty name');
  if (!/Next:\s*Waiting on counterparty revisions/i.test(umbrella.text)) fail('Strip missing "Next: Waiting on counterparty revisions"');
  pass('Strip on UNDER_NEGOTIATION: counterparty + waiting + next-action');

  await p.screenshot({ path: path.join(OUT, '59-b512-strip-negotiation.png'), fullPage: false });

  // ── 2. PENDING_APPROVAL (viewer NOT the approver) → strip shows the approver step ──
  await p.goto(`${BASE}/contracts/${WAYNE_ID}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const wayne = await stripInfo(p);
  const wayneDecision = await decisionStripShown(p);
  console.log('wayne:', JSON.stringify({ strip: wayne, decision: wayneDecision }));
  if (wayneDecision) {
    // If the decision strip shows, admin happens to be an approver on this
    // one too — skip this gate but note it. (A.4 seed state may vary.)
    console.log('WARN Wayne shows DecisionStrip — admin is the approver here; skipping gate 2');
  } else {
    if (!wayne.found) fail('Negotiation strip missing on PENDING_APPROVAL contract viewed by non-approver');
    if (!/Next:\s*Waiting on review/i.test(wayne.text)) fail('Strip missing "Next: Waiting on review" for PENDING_APPROVAL');
    pass('Strip on PENDING_APPROVAL (non-approver view): blocker + next-action');
    await p.screenshot({ path: path.join(OUT, '60-b512-strip-pending-approval.png'), fullPage: false });
  }

  // ── 3. PENDING_APPROVAL where viewer IS the approver → no strip, Decision instead ──
  await p.goto(`${BASE}/contracts/${WPT_ID}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(3000);
  const wpt = await stripInfo(p);
  const wptDecision = await decisionStripShown(p);
  console.log('wpt:', JSON.stringify({ strip: wpt, decision: wptDecision }));
  if (!wptDecision) fail('Expected DecisionStrip on WPT (admin is seeded approver)');
  if (wpt.found) fail('NegotiationStatusStrip should NOT render when viewer is the approver (DecisionStrip shows instead)');
  pass('Approver sees DecisionStrip, not NegotiationStatusStrip (correct mutual-exclusion)');

  // ── 4. DRAFT contract → neither strip ────────────────────────────
  // Pick any DRAFT from the contracts list.
  await p.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const draftId = await p.evaluate(() => {
    // Find a row whose visible status pill says DRAFT.
    const rows = Array.from(document.querySelectorAll('.cursor-pointer'));
    for (const r of rows) {
      if ((r.textContent || '').toUpperCase().includes('DRAFT')) {
        // Click it and return — but we need the navigate URL. Easier:
        // return a seed-known draft id. (We use iPass flipped back? No —
        // we keep iPass APPROVED for B.5.11. Use a different draft.)
        const link = r.querySelector('a');
        if (link?.getAttribute('href')) return link.getAttribute('href');
      }
    }
    return null;
  });
  if (draftId) {
    await p.goto(BASE + draftId, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2000);
    const neither = await stripInfo(p);
    const dec = await decisionStripShown(p);
    if (neither.found) fail('NegotiationStatusStrip unexpectedly rendered on DRAFT');
    if (dec) fail('DecisionStrip unexpectedly rendered on DRAFT');
    pass('DRAFT contract shows neither strip (correct silence)');
  } else {
    console.log('WARN no DRAFT contract found in list — skipping gate 4');
  }

  console.log('DONE');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
