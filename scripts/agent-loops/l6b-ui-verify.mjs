#!/usr/bin/env node
/**
 * L6b UI verification — click the control, then assert the consequence.
 *
 * l6b-dead-controls.mjs asserts the source and the server-side behaviour. This
 * one drives the actual browser, because three of these defects are only
 * visible to a user: a badge that reads zero, an error banner that never
 * renders, and a Replace All that silently rewrites the markup.
 *
 * Login follows the convention already committed in l3-error-surface.mjs and
 * the other Playwright checks: the seeded demo fixture on a local dev server.
 *
 *   #12 signature badges  — counts were reduced over the ALREADY-FILTERED
 *                           response, so selecting any tab zeroed every other
 *                           badge and the ALL badge showed the page length.
 *                           This is the one a user notices immediately and
 *                           cannot explain.
 *   #8  Replace All       — ran replaceAll over serialized HTML. The damage is
 *                           NOT what the plan describes: TipTap's parser drops
 *                           the mangled tag on setContent and re-wraps the
 *                           text, so a bare <p> round-trips intact and an
 *                           assertion on tag names passes against broken code
 *                           (this check made that mistake first). What is
 *                           really destroyed is MARKS -- <strong> mangled to
 *                           <stzong> is discarded along with its formatting --
 *                           and any search containing an escaped character,
 *                           which can never match. Measured: bold runs 1 -> 0.
 *   #1  editor exports    — six buttons that bare-fetched a guarded route,
 *                           401'd, and swallowed it with `if (!resp?.ok)
 *                           return`. The assertion is that a click now
 *                           produces SOMETHING: a download or a visible error.
 *                           Silence is the defect.
 *   #7  contract Download — no try/catch and no error state at all.
 *
 * Run BEFORE: badges zero out, Replace All silently drops bold formatting and
 *             cannot match "Smith & Co" at all, and the two failure paths
 *             render nothing whatsoever.
 * Run AFTER:  badges hold, marks survive, the ampersand search matches, and
 *             failures are legible. Verified by reverting each fix.
 */
import fsSync from 'node:fs'
import { chromium } from 'playwright'
import { db, check, report, section } from '../week-zero/lib/harness.mjs'

const WEB = process.env.WEB ?? 'http://localhost:5173'
const REPO_API = new URL('../../apps/api', import.meta.url).pathname

// Child processes need DATABASE_URL passed explicitly; the services read it
// from the repo-root .env, not from apps/api/.env.
const dbUrl = () => {
  try {
    return /^DATABASE_URL=(.*)$/m.exec(
      fsSync.readFileSync(new URL('../../.env', import.meta.url).pathname, 'utf8'))?.[1]
      ?.trim().replace(/^["']|["']$/g, '') ?? ''
  } catch { return '' }
}
const SHOTS = new URL('.', import.meta.url).pathname

const prisma = db()
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  viewport: { width: 1500, height: 950 },
  acceptDownloads: true,
})
const page = await ctx.newPage()
const shot = n => page.screenshot({ path: `${SHOTS}l6b-${n}.png` }).catch(() => {})

await page.goto(WEB, { waitUntil: 'domcontentloaded' })
await page.fill('input[type=email]', 'admin@demo.com')
await page.fill('input[type=password]', 'password123')
await page.click('button[type=submit]')
await page.waitForLoadState('networkidle').catch(() => {})
const skip = page.locator('text=Skip setup').first()
if (await skip.count()) { await skip.click().catch(() => {}); await page.waitForTimeout(800) }

// Guard. Editing a watched source file restarts the API, and a run that
// happens to land inside that window fails to log in -- which then cascades
// into every later section failing for reasons that look like nine separate
// product defects. Ask once, loudly, instead.
{
  const stillOnLogin = await page.locator('input[type=password]').count() > 0
  if (stillOnLogin) {
    check('logged in', false,
      'still on the sign-in page — the API was probably mid-restart (check /health uptime). Every assertion below would be meaningless.')
    await browser.close()
    await prisma.$disconnect()
    report('L6b UI verification')
    process.exit(1)
  }
}

// ─── 1. Signature filter badges hold when a tab is selected ─────────────────

section('1. Selecting a signature tab does not zero the other badges')
{
  await page.goto(`${WEB}/signatures`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(800)

  const readBadges = async () => {
    const out = {}
    for (const key of ['all', 'pending', 'completed', 'voided', 'expired']) {
      const tab = page.locator(`[data-testid="filter-${key}"]`).first()
      if (!await tab.count()) continue
      const text = (await tab.innerText().catch(() => '')) ?? ''
      const n = /(\d+)\s*$/.exec(text.trim())
      out[key] = n ? Number(n[1]) : null
    }
    return out
  }

  const onAll = await readBadges()
  await shot('signatures-all')
  check('the signatures page rendered its filter tabs', Object.keys(onAll).length > 1,
    `badges on ALL: ${JSON.stringify(onAll)}`)

  // Pick a non-ALL tab that has a non-zero count to switch to, so the
  // comparison is meaningful. If every bucket is empty this cannot be tested
  // and says so rather than passing by default.
  const target = Object.entries(onAll).find(([k, v]) => k !== 'all' && (v ?? 0) > 0)?.[0]
  if (!target) {
    check('a non-empty status bucket exists to switch to', false,
      `all buckets empty (${JSON.stringify(onAll)}) — seed a signature request to exercise this`)
  } else {
    await page.click(`[data-testid="filter-${target}"]`)
    await page.waitForTimeout(1200)
    const after = await readBadges()
    await shot('signatures-filtered')

    // BEFORE: every other badge read 0, because counts were reduced over the
    // filtered response.
    const zeroed = Object.entries(after).filter(([k, v]) => k !== target && (onAll[k] ?? 0) > 0 && v === 0)
    check(`selecting "${target}" leaves the other badges intact`, zeroed.length === 0,
      `before ${JSON.stringify(onAll)} → after ${JSON.stringify(after)}${zeroed.length ? ` — zeroed: ${zeroed.map(z => z[0]).join(', ')}` : ''}`)

    check('the ALL badge does not shrink to the filtered page length',
      after.all === onAll.all,
      `ALL was ${onAll.all}, now ${after.all} — it used to be items.length, the current page`)
  }
}

// ─── 2. Replace All leaves the markup alone ─────────────────────────────────

section('2. Replace All edits text, not tags')
{
  // The editor mounts on the templates page. Find one and open it.
  await page.goto(`${WEB}/templates`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1000)

  // The editor lives inside the template EDIT view, keyed off the card's own
  // edit affordance -- clicking the card body does not open it.
  const editBtn = page.locator('[data-testid^="template-card-title-"]').first()
  if (await editBtn.count()) { await editBtn.click().catch(() => {}); await page.waitForTimeout(1800) }

  // The editor only renders when the template has at least one section; add
  // one if this template has none.
  if (await page.locator('.ProseMirror').count() === 0) {
    const addSection = page.locator('button:has-text("Add section"), button:has-text("Add Section")').first()
    if (await addSection.count()) { await addSection.click().catch(() => {}); await page.waitForTimeout(1200) }
  }
  await shot('template-editor')

  const prose = page.locator('.ProseMirror').first()
  const hasEditor = await prose.count() > 0
  check('a ProseMirror editor is mounted', hasEditor,
    hasEditor ? 'editor found' : 'no template opened an editor — cannot exercise Replace All in the UI')

  if (hasEditor) {
    // NOTE, and the reason this section looks the way it does: a first version
    // asserted that replacing "p" with "q" left the <p> tags intact, and it
    // PASSED against the broken HTML-string implementation. TipTap's schema
    // has no <q> node, so setContent's parser silently drops the mangled tag
    // and re-wraps the text in a fresh paragraph — the round trip repairs the
    // exact damage the assertion was looking for. On a bare paragraph the
    // corruption is invisible.
    //
    // What actually breaks is (a) MARKS, which are dropped when their tag name
    // is mangled and the parser discards the unknown element, and (b) any
    // search containing an HTML-escaped character, which can never match.
    // Both are asserted below, and both go red on the revert.


    // Build a document with a mark and an ampersand, using the toolbar so it
    // goes through the real editor rather than an injected string.
    // Type the whole line FIRST, then select it and apply bold. Clicking the
    // toolbar mid-type moves focus off the editor and the rest of the string
    // goes nowhere -- which silently produced a fixture with no bold run and
    // an assertion that failed for the wrong reason.
    await prose.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Delete')
    await page.keyboard.type('Agreement with Smith & Co covering strong support terms')
    await page.waitForTimeout(300)
    await page.keyboard.press('ControlOrMeta+A')
    await page.waitForTimeout(200)
    const boldBtn = page.locator('button[title="Bold"]').first()
    check('the Bold toolbar button exists', await boldBtn.count() > 0)
    if (await boldBtn.count()) { await boldBtn.click(); await page.waitForTimeout(500) }
    await page.waitForTimeout(400)

    const measure = () => prose.evaluate(el => ({
      html:   el.innerHTML,
      text:   el.innerText,
      bold:   el.querySelectorAll('strong, b').length,
      boldTx: Array.from(el.querySelectorAll('strong, b')).map(n => n.textContent).join('|'),
    }))

    const before = await measure()
    check('the document has a bold run and an ampersand', before.bold > 0 && before.text.includes('&'),
      `bold runs: ${before.bold} (${before.boldTx}), text: ${JSON.stringify(before.text.slice(0, 70))}`)

    const findBtn = page.locator('button[title*="Find" i], button:has-text("Find")').first()
    if (await findBtn.count()) { await findBtn.click().catch(() => {}); await page.waitForTimeout(300) }
    const findInput    = page.locator('input[placeholder="Find..."]').first()
    const replaceInput = page.locator('input[placeholder="Replace..."]').first()
    const replaceAll   = page.locator('button:has-text("Replace All")').first()

    const panelOpen = await findInput.count() > 0 && await replaceAll.count() > 0
    check('the find/replace panel opened', panelOpen)

    if (panelOpen) {
      // (a) THE AMPERSAND CASE. The serialized HTML holds "Smith &amp; Co", so
      // a search for "Smith & Co" matched nothing at all and the user was told
      // nothing about why.
      await findInput.fill('Smith & Co')
      await replaceInput.fill('Acme Industries')
      await replaceAll.click()
      await page.waitForTimeout(700)
      const afterAmp = await measure()
      await shot('replace-ampersand')

      check('a search containing "&" actually matches',
        afterAmp.text.includes('Acme Industries') && !afterAmp.text.includes('Smith & Co'),
        `text is now ${JSON.stringify(afterAmp.text.slice(0, 80))} — over serialized HTML this never matched, because the HTML holds "Smith &amp; Co"`)

      // (b) THE MARK CASE. "strong" is a tag name; replacing a letter in it
      // mangles <strong> into an element the parser does not know, and the
      // bold run is silently dropped along with it.
      const beforeMark = await measure()
      await findInput.fill('r')
      await replaceInput.fill('z')
      await replaceAll.click()
      await page.waitForTimeout(700)
      const afterMark = await measure()
      await shot('replace-mark')

      check('replacing a letter that appears in a tag name keeps the bold run',
        afterMark.bold === beforeMark.bold && afterMark.bold > 0,
        `bold runs ${beforeMark.bold} → ${afterMark.bold} — "strong" contains an r, so over serialized HTML <strong> became <stzong>, which the parser discards along with the formatting`)

      check('the replacement still did its job on the text',
        !afterMark.text.includes('r') && afterMark.text.includes('z'),
        `text: ${JSON.stringify(afterMark.text.slice(0, 80))} — a Replace All that did nothing would pass the assertion above`)
    }
  }
}

// ─── 3. A failed export says so ─────────────────────────────────────────────

section('3. Export buttons produce a download or a visible error, never silence')
{
  const prose = page.locator('.ProseMirror').first()
  if (await prose.count() === 0) {
    check('an editor is available to export from', false, 'no editor mounted')
  } else {
    const exportBtn = page.locator('button[title="Export DOCX"]').first()
    check('the Export DOCX button exists', await exportBtn.count() > 0)

    if (await exportBtn.count()) {
      const downloadPromise = page.waitForEvent('download', { timeout: 12_000 }).catch(() => null)
      await exportBtn.click()
      const download = await downloadPromise
      await page.waitForTimeout(1200)
      await shot('export-docx')

      const banner = page.locator('[data-testid="editor-export-error"]').first()
      const errorShown = await banner.count() > 0
      const errorText  = errorShown ? (await banner.innerText()).trim() : ''

      // BEFORE: neither branch happened. The bare fetch 401'd and
      // `if (!resp?.ok) return` swallowed it, so the button did nothing at all.
      check('clicking Export DOCX produces a download or a visible error',
        download != null || errorShown,
        download ? `downloaded ${download.suggestedFilename()}` :
        errorShown ? `error surfaced: ${errorText.slice(0, 120)}` :
        'NOTHING happened — no download event and no error banner, which is exactly the original defect')
    }
  }
}

// ─── 4. Contract Download reports its failure ───────────────────────────────

section('4. Download on a body-only contract explains itself')
{
  // Seed a contract with no uploaded original, which is what an agent-drafted
  // or pasted-HTML contract looks like. contracts.ts 404s on download for it.
  const org = await prisma.contract.findFirst({ select: { orgId: true, ownerId: true } })
  let probeId = null
  if (org) {
    const c = await prisma.contract.create({
      data: {
        orgId: org.orgId, ownerId: org.ownerId,
        title: 'L6b download-error probe', type: 'NDA', status: 'DRAFT', analysisStatus: 'DONE',
      },
      select: { id: true },
    }).catch(() => null)
    probeId = c?.id ?? null
  }

  check('a body-only contract fixture exists', probeId != null,
    probeId ?? 'could not seed one')

  if (probeId) {
    await page.goto(`${WEB}/contracts/${probeId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1200)

    // Open the Actions menu and click Download.
    const menu = page.locator('button:has-text("Actions"), [data-testid="contract-actions"]').first()
    if (await menu.count()) { await menu.click().catch(() => {}); await page.waitForTimeout(500) }
    const dl = page.locator('[role="menuitem"]:has-text("Download")').first()
    const found = await dl.count() > 0
    check('the Download menu item is reachable', found)

    if (found) {
      await dl.click()
      await page.waitForTimeout(1500)
      await shot('contract-download-error')
      const banner = page.locator('[data-testid="contract-download-error"]').first()
      const shown = await banner.count() > 0
      check('the failure is explained instead of the menu just closing', shown,
        shown ? (await banner.innerText()).trim().slice(0, 140)
              : 'no banner — before this fix there was no try/catch and no error state at all')
    }

    await prisma.contract.deleteMany({ where: { id: probeId } }).catch(() => {})
  }
}

// ─── 5. Bulk approve reports what failed ────────────────────────────────────
//
// Seeded failure: my-queue filters on STEP status and step order, not on the
// parent instance's status. So a PENDING step on an already-closed instance
// shows up in the queue and then 409s on decide -- a real, server-generated
// per-item failure, which is exactly what the bare `catch { failed++ }` used
// to throw away.

section('5. Bulk approve names the items that failed')
{
  const seed = await prisma.contract.findFirst({ select: { id: true, orgId: true, ownerId: true } })
  const me = await prisma.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true } })
  let wfId = null, instId = null

  if (seed && me) {
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: seed.orgId, name: 'l6bui probe workflow', createdById: me.id, isActive: true,
        steps: [{ order: 1, name: 'l6bui review', approverRule: { type: 'user' } }],
      }, select: { id: true },
    }).catch(() => null)
    wfId = wf?.id ?? null

    if (wfId) {
      const inst = await prisma.approvalInstance.create({
        data: {
          orgId: seed.orgId, contractId: seed.id, workflowDefinitionId: wfId,
          // Closed on purpose: decide() 409s "Workflow is already closed".
          status: 'APPROVED', currentStepOrder: 1, submittedById: me.id,
          steps: { create: [
            { orgId: seed.orgId, stepOrder: 1, stepName: 'l6bui review A', approverId: me.id, status: 'PENDING' },
            { orgId: seed.orgId, stepOrder: 1, stepName: 'l6bui review B', approverId: me.id, status: 'PENDING' },
          ] },
        }, select: { id: true },
      }).catch(() => null)
      instId = inst?.id ?? null
    }
  }

  check('two steps that will fail on decide were seeded', instId != null,
    instId ?? 'could not seed — section skipped')

  if (instId) {
    await page.goto(`${WEB}/approvals`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1500)

    const bulkBtn = page.locator('button:has-text("Bulk"), button:has-text("Decide")').first()
    const openable = await bulkBtn.count() > 0
    check('the bulk decision dialog is reachable', openable,
      openable ? 'found' : 'no bulk control on the approvals page')

    if (openable) {
      await bulkBtn.click()
      await page.waitForTimeout(900)
      const submit = page.locator('button:has-text("Approve"), button:has-text("Confirm")').last()
      if (await submit.count()) { await submit.click(); await page.waitForTimeout(4000) }
      await shot('bulk-approve-failures')

      const failList = page.locator('[data-testid="bulk-failure-list"]').first()
      const shown = await failList.count() > 0
      check('the failed items are listed with the server reason', shown,
        shown ? (await failList.innerText()).replace(/\s+/g, ' ').slice(0, 160)
              : 'no failure list — the bare catch discarded the detail and the dialog closed itself over the failure')

      const banner = page.locator('[data-testid="bulk-partial-failure"]').first()
      check('the summary is not styled as success', await banner.count() > 0,
        'the failure count used to render in emerald success green for 600 ms before the dialog closed')

      const stillOpen = await page.locator('button:has-text("Retry")').count() > 0
      check('the dialog stays open and offers a retry', stillOpen,
        'an unconditional setTimeout(onDone, 600) closed it regardless of outcome')
    }

    await prisma.approvalStep.deleteMany({ where: { approvalInstanceId: instId } }).catch(() => {})
    await prisma.approvalInstance.deleteMany({ where: { id: instId } }).catch(() => {})
    if (wfId) await prisma.workflowDefinition.deleteMany({ where: { id: wfId } }).catch(() => {})
  }
}

// ─── 6. Artifact Export CSV downloads a real CSV ────────────────────────────

section('6. The agent artifact export produces a file')
{
  await page.goto(`${WEB}/agent`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1200)

  const fresh = page.locator('button:has-text("New conversation")').first()
  if (await fresh.count()) { await fresh.click().catch(() => {}); await page.waitForTimeout(800) }

  const composer = page.locator('textarea').first()
  const canType = await composer.count() > 0
  check('the agent composer is available', canType)

  let exportBtn = null
  if (canType) {
    // A table artifact is what carries an Export CSV action. Which tool the
    // model picks is not deterministic, so retry rather than pass by default.
    for (let attempt = 1; attempt <= 3 && !exportBtn; attempt++) {
      await composer.fill('List every obligation we are tracking, as a table.')
      await composer.press('Enter')
      await page.waitForTimeout(22_000)
      const candidate = page.locator('[data-testid="artifact-action-export"]').first()
      if (await candidate.count()) { exportBtn = candidate; break }
      // Open the artifact pane if a card is present but collapsed.
      const card = page.locator('[data-testid^="artifact-card"], button:has-text("Open")').first()
      if (await card.count()) { await card.click().catch(() => {}); await page.waitForTimeout(1500) }
      if (await page.locator('[data-testid="artifact-action-export"]').count()) {
        exportBtn = page.locator('[data-testid="artifact-action-export"]').first()
      }
    }
  }
  await shot('agent-artifact')

  check('a table artifact with an Export action rendered', exportBtn != null,
    exportBtn ? 'found' : 'the agent produced no table artifact in 3 attempts — export path not exercised')

  if (exportBtn) {
    const dlPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null)
    await exportBtn.click()
    const dl = await dlPromise
    await page.waitForTimeout(800)

    // BEFORE: the action had neither href nor tool, so the click threw
    // "This action has nothing to apply" and flashed an unlabeled red icon.
    check('clicking Export CSV downloads a file', dl != null,
      dl ? `downloaded ${dl.suggestedFilename()}` : 'no download — the action threw instead')

    if (dl) {
      const path = await dl.path()
      const body = path ? (await import('node:fs')).readFileSync(path, 'utf8') : ''
      check('the file is a non-empty CSV with a header row',
        /,/.test(body.split('\n')[0] ?? '') && body.split('\n').length > 1,
        `${body.length} bytes, first line: ${JSON.stringify((body.split('\n')[0] ?? '').slice(0, 90))}`)
      check('it is not an error page or JSON blob',
        !body.trimStart().startsWith('{') && !body.trimStart().startsWith('<'),
        `starts: ${JSON.stringify(body.slice(0, 40))}`)
    }

    const errLabel = page.locator('[data-testid^="artifact-action-error-"]').first()
    if (await errLabel.count()) {
      check('any failure is labelled rather than a bare icon', true,
        (await errLabel.innerText()).slice(0, 120))
    }
  }
}

// ─── 7. A notification toggle reaches the delivery decision ─────────────────
//
// The one gap the other sections cannot close. Flipping the toggle is only
// half the story: what matters is whether the DELIVERY side then honours it,
// and for two years it did not -- eleven controls persisted and nothing read
// them. This chains the real UI control to the real decision function.
//
// Not covered: the SMTP send itself, which is gated on isEmailConfigured() and
// has no provider in this workspace. Everything up to that gate is asserted.

section('7. Flipping a Settings toggle changes what the worker decides')
{
  const me = await prisma.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, preferences: true } })
  const original = me?.preferences ?? {}

  const decide = async (type) => {
    const { execFileSync } = await import('node:child_process')
    const tmp = `${REPO_API}/.l6bui-probe.mts`
    fsSync.writeFileSync(tmp, `
      import { shouldEmail } from './src/lib/notification-prefs.js'
      const r = await shouldEmail(${JSON.stringify(me?.id ?? '')}, ${JSON.stringify(type)})
      process.stdout.write('<<<R>>>' + JSON.stringify(r))
    `)
    try {
      const out = execFileSync('pnpm', ['exec', 'tsx', tmp], {
        cwd: REPO_API, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || dbUrl() },
      })
      return JSON.parse(out.split('<<<R>>>')[1])
    } catch (e) {
      return { emailed: null, reason: String(e.stderr ?? e.message).slice(-160) }
    } finally { try { fsSync.unlinkSync(tmp) } catch { /* */ } }
  }

  try {
    await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1200)

    const tab = page.locator('button:has-text("Notifications")').first()
    if (await tab.count()) { await tab.click().catch(() => {}); await page.waitForTimeout(1000) }

    const toggle = page.locator('[data-testid="notif-approvalRequested-toggle"]').first()
    const present = await toggle.count() > 0
    check('the "Approval requested from me" toggle is on the page', present,
      present ? 'found' : 'could not reach the notifications tab')

    if (present) {
      // Establish the ON baseline first, so the OFF result below is a change
      // rather than a coincidence.
      const wasOn = await decide('APPROVAL_REQUEST')
      check('the delivery decision starts as send', wasOn?.emailed === true,
        `emailed=${wasOn?.emailed} (${wasOn?.reason})`)

      await toggle.click()
      await page.waitForTimeout(2500)          // let the PATCH land
      await shot('settings-notifications')

      const persisted = await prisma.user.findUnique({
        where: { id: me.id }, select: { preferences: true },
      })
      const stored = persisted?.preferences?.notifications?.approvalRequested
      check('the click persisted through PATCH /users/me', stored === false,
        `stored approvalRequested=${JSON.stringify(stored)} — this half always worked; it is the next assertion that was broken`)

      const nowOff = await decide('APPROVAL_REQUEST')
      check('the worker now declines to email that type', nowOff?.emailed === false,
        `emailed=${nowOff?.emailed} (${nowOff?.reason}) — for eleven controls this stayed true forever, so the user got a green "Saved" and kept getting mail`)

      // A type with no toggle must be unaffected: ESCALATION and DELEGATION are
      // direct assignments to a person, and there is no control to switch them
      // off. Suppressing everything is not honouring a preference.
      const unrelated = await decide('ESCALATION')
      check('an un-suppressible type is still delivered', unrelated?.emailed === true,
        `emailed=${unrelated?.emailed} (${unrelated?.reason})`)
    }
  } finally {
    // Restore whatever the user actually had. See the Wave C incident where a
    // probe left a cap at 0 and made unrelated checks look like regressions.
    if (me?.id) {
      await prisma.user.update({ where: { id: me.id }, data: { preferences: original } }).catch(() => {})
    }
  }
}

await browser.close()
await prisma.$disconnect()
report('L6b UI verification')
