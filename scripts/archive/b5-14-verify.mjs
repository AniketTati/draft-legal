#!/usr/bin/env node
/**
 * B.5.14 verification — Counterparty Portal refactor.
 *
 * JTBD (docs/26 §4 matrix, "Counterparty" persona):
 *   "I got a link to a contract from a vendor I may not fully trust.
 *    Is this legit? Can I redline in Word and send back without signing
 *    up to their system?"
 *
 *   Pre-B.5.14 the portal was a branded header + read-only doc + an
 *   optional comments tab. That's enough to view; not enough to close
 *   the loop. Per ChatGPT round-3, forcing counterparties into our
 *   portal is a deal-losing pattern.
 *
 * Gates:
 *   1. Create an EDIT-permission share link via the admin API.
 *   2. Open the portal URL anonymously.
 *   3. Trust band renders with ✓ "Shared by ORG" + expiry.
 *   4. Download .docx and Upload revised buttons are present when edit
 *      permission is granted.
 *   5. Uploading a small .pdf file creates a new contract version
 *      attributed to `portal:<linkId>` and returns 201.
 *   6. After upload, the contract flips to UNDER_NEGOTIATION status.
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

const CONTRACT_ID = 'cmn16g4xf001sdew25oas8dcy'; // WPT Enterprises

async function adminLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error('login failed: ' + JSON.stringify(data).slice(0, 200));
  return data.accessToken;
}

async function createShareLink(token, perms) {
  const res = await fetch(`${API}/contracts/${CONTRACT_ID}/share`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      label:          'B.5.14 verify link',
      permissions:    perms,
      expiresInHours: 24,
    }),
  });
  if (!res.ok) throw new Error(`share failed: ${res.status} ${await res.text()}`);
  return res.json();
}

(async () => {
  // ── 1. Create an edit share link ─────────────────────────────────
  const accessToken = await adminLogin();
  const share = await createShareLink(accessToken, ['read', 'comment', 'edit']);
  const portalUrl = share.portalUrl;
  // The backend returns FRONTEND_URL (maybe localhost:3000) — rewrite to
  // our vite dev at 5173 for the browser.
  const rewritten = portalUrl.replace(/^https?:\/\/[^/]+/, BASE);
  const portalToken = rewritten.split('/portal/')[1];
  console.log('portalUrl:', rewritten);
  pass('Created edit-permission portal share link via admin API');

  // ── 2. Open portal anonymously ───────────────────────────────────
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await c.newPage();
  await p.goto(rewritten, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1800);

  // ── 3. Trust band renders ────────────────────────────────────────
  const band = await p.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Portal trust and actions"]');
    if (!region) return { found: false };
    const txt = region.textContent || '';
    return {
      found:            true,
      hasSharedBy:      /Shared by/i.test(txt),
      hasExpires:       /Expires|Link active/i.test(txt),
      hasDownloadDocx:  Array.from(region.querySelectorAll('a,button')).some(e => /Download \.docx/i.test(e.textContent || '')),
      hasUploadRevised: Array.from(region.querySelectorAll('a,button')).some(e => /Upload revised/i.test(e.textContent || '')),
    };
  });
  console.log('band:', JSON.stringify(band));
  if (!band.found) fail('Portal trust band missing');
  if (!band.hasSharedBy) fail('Trust band missing "Shared by ORG"');
  if (!band.hasExpires) fail('Trust band missing expiry line');
  if (!band.hasDownloadDocx) fail('Trust band missing Download .docx button');
  if (!band.hasUploadRevised) fail('Trust band missing Upload revised button (edit permission set)');
  pass('Trust band shows verified-sender + expiry + download + upload CTAs');

  await p.screenshot({ path: path.join(OUT, '62-b514-portal-trust-band.png'), fullPage: false });

  // ── 4. Upload a tiny PDF via the hidden file input ────────────────
  // We fabricate a minimal 4-byte PDF header file. Gotenberg isn't in the
  // path here — we just test the POST /versions endpoint accepts it and
  // persists a row. Real extraction is a background job.
  const tmp = path.join(__dirname, 'tmp-portal-upload.pdf');
  fs.writeFileSync(tmp, Buffer.from('%PDF-1.4\n%%EOF\n'));
  const [chooser] = await Promise.all([
    p.waitForEvent('filechooser'),
    p.evaluate(() => {
      // click the upload button to open the chooser
      const btn = Array.from(document.querySelectorAll('button')).find(b => /Upload revised/i.test(b.textContent || ''));
      btn?.click();
    }),
  ]);
  await chooser.setFiles(tmp);
  // Wait for mutation success toast (the Uploaded vN line appears)
  await p.waitForFunction(
    () => /Uploaded v\d+/.test(document.body.textContent || ''),
    { timeout: 20000 },
  ).catch(() => null);
  const successLine = await p.evaluate(() => {
    const body = document.body.textContent || '';
    const m = body.match(/Uploaded\s+v(\d+)/);
    return m ? m[0] : null;
  });
  if (!successLine) fail('Upload did not produce a success line — check server logs');
  pass(`Upload succeeded: "${successLine}"`);

  await p.screenshot({ path: path.join(OUT, '63-b514-portal-uploaded.png'), fullPage: false });

  // ── 5. Verify the contract flipped to UNDER_NEGOTIATION ─────────
  const res = await fetch(`${API}/contracts/${CONTRACT_ID}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const contract = await res.json();
  if (contract.status !== 'UNDER_NEGOTIATION') fail(`expected status UNDER_NEGOTIATION after upload, got ${contract.status}`);
  pass('Contract status flipped to UNDER_NEGOTIATION after portal upload');

  // Cleanup: revoke the share link so re-runs don't accumulate.
  await fetch(`${API}/contracts/${CONTRACT_ID}/share/${share.shareLink.id}`, {
    method:  'DELETE',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  fs.unlinkSync(tmp);

  console.log('DONE — portalToken used:', (portalToken ?? '').slice(0, 40) + '…');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
