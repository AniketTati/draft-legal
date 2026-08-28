#!/usr/bin/env node
/**
 * D.0.8a verify — log in as admin, navigate to AI Config tab, screenshot.
 *
 * Asserts:
 *  - AI Config tab renders real content (not PlaceholderTab)
 *  - Heading reads "AI Config"
 *  - Model routing section shows all 6 tier rows
 *  - Each tier has a <select> with at least one option (platform default)
 *  - Placeholder cards for D.0.8b–e are visible with landing badges
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright';

const OUT = path.join(REPO_ROOT, 'scripts/screenshots/desktop/50-d08a-ai-config.png');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Login
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'admin@demo.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 });
  await page.waitForTimeout(800);

  // Go to Admin Org page, AI Config tab
  await page.goto('http://localhost:5173/admin/org', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // Click AI Config tab (sidebar button)
  await page.getByRole('button', { name: /ai config/i }).click();
  await page.waitForTimeout(1500); // let settings query resolve

  // ── Assertions ─────────────────────────────────────────────────────────
  let fail = 0;
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++; };

  const headingCount = await page.getByRole('heading', { name: /^ai config$/i, level: 1 }).count();
  check(headingCount === 1, 'AI Config <h1> is rendered');

  const modelHeadingCount = await page.getByRole('heading', { name: /model routing/i, level: 2 }).count();
  check(modelHeadingCount === 1, 'Model routing <h2> is rendered');

  // Six tier labels (one per row)
  for (const label of ['Reasoning', 'Default', 'Fast', 'Embeddings', 'Rerank', 'Vision / OCR']) {
    const visible = await page.getByText(label, { exact: true }).first().isVisible().catch(() => false);
    check(visible, `tier row "${label}" is visible`);
  }

  const selects = await page.locator('select').count();
  check(selects === 6, `there are 6 model <select> dropdowns (got ${selects})`);

  // The "Platform default" option should be present in each
  const optionsWithPlatform = await page.locator('select option', { hasText: /platform default/i }).count();
  check(optionsWithPlatform >= 6, `"Platform default" option in every row (got ${optionsWithPlatform})`);

  // Placeholder cards for D.0.8b–e
  for (const tag of ['D.0.8b', 'D.0.8c', 'D.0.8d', 'D.0.8e']) {
    const has = await page.getByText(tag, { exact: true }).first().isVisible().catch(() => false);
    check(has, `landing badge "${tag}" visible for its placeholder section`);
  }

  // "Coming soon" text from the old placeholder should NOT appear
  const placeholderLeaked = await page.getByText(/coming soon/i).count();
  check(placeholderLeaked === 0, `old "Coming soon" placeholder is gone (got ${placeholderLeaked} instance(s))`);

  // Save button is disabled until an edit is made
  const saveButton = page.getByRole('button', { name: /saved|save changes/i });
  const savedText = await saveButton.first().textContent();
  check(/saved/i.test(savedText ?? ''), `Save button reads "Saved" when no edits are pending (got "${savedText?.trim()}")`);

  await page.screenshot({ path: OUT, fullPage: true });
  console.log(`\nScreenshot saved → ${OUT}`);

  await browser.close();
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1); }
  console.log('\n✓ All D.0.8a UI checks pass');
})().catch(async e => { console.error(e); process.exit(1); });
