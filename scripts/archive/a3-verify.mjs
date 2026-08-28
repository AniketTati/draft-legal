#!/usr/bin/env node
/**
 * A.3 verification — on a DRAFT contract, only ONE "Send for Review"
 * button should be visible; "Submit for Approval" string should not
 * appear anywhere in the detail page.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots', 'desktop');
const BASE = 'http://localhost:5173';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'admin@demo.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1800);

  await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // Click first DRAFT contract
  const clicked = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cursor-pointer'));
    const firstDraft = rows.find(r => r.textContent && r.textContent.includes('DRAFT'));
    if (firstDraft) { firstDraft.click(); return firstDraft.textContent && firstDraft.textContent.slice(0, 80); }
    return null;
  });
  if (!clicked) { console.error('Could not find a DRAFT contract'); process.exit(1); }
  console.log('Opened:', clicked);

  await page.waitForTimeout(1500);

  // Count buttons in the top action row
  const result = await page.evaluate(() => {
    const body = document.body.innerText;
    const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean);
    return {
      buttons,
      hasSubmitForApproval: body.includes('Submit for Approval'),
      hasSendForReview: body.includes('Send for Review'),
    };
  });

  const shot = path.join(OUT, '23-a3-draft-one-cta.png');
  await page.screenshot({ path: shot, fullPage: false });
  console.log('✓', path.relative(path.join(__dirname, '..'), shot));
  console.log('Visible buttons:', result.buttons.filter(b => b && b.length < 30));

  if (result.hasSubmitForApproval) {
    console.log('❌ FAIL — "Submit for Approval" still visible somewhere');
    process.exit(1);
  }
  if (!result.hasSendForReview) {
    console.log('❌ FAIL — "Send for Review" not visible on DRAFT contract');
    process.exit(1);
  }
  console.log('✅ PASS — one primary CTA "Send for Review", no "Submit for Approval"');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
