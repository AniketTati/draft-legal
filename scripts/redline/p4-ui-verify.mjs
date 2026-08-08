#!/usr/bin/env node
/**
 * Phase 4 UI — a reviewer downloads the redline as Word.
 *
 * The API check proves the bytes are right. This proves a person can get them:
 * open Compare, pick two versions, press the button, and have a real .docx land
 * on disk.
 *
 * That last part is the point of driving a browser here rather than asserting
 * on the DOM. A download can fail in ways no rendering check sees — a missing
 * Authorization header (which is how ContractEditor's own download silently
 * does nothing), a blob built with the wrong MIME type, an anchor that never
 * fires. So this intercepts the actual download event and unzips what arrived.
 */
import { chromium } from '../../node_modules/playwright/index.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { login, db, check, report, section } from '../week-zero/lib/harness.mjs'

const WEB = process.env.WEB_BASE ?? 'http://localhost:5173'
const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id
const TITLE = 'P4 UI docx probe'
const TMP = '/private/tmp/claude-501/-Users-temp-Documents-Code-draft-legal/6e3930ba-b18b-4214-9388-1e0e6c9cf636/scratchpad'

const V1 = '<h2>9. Limitation of Liability</h2><p>Liability is capped at 12 months of fees.</p>'
const V2 = '<h2>9. Limitation of Liability</h2><p>Liability is capped at 24 months of fees.</p>'

async function purge() {
  const stale = await prisma.contract.findMany({ where: { orgId, title: TITLE }, select: { id: true } })
  if (!stale.length) return
  const ids = stale.map(c => c.id)
  await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
  const vs = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
  const vIds = vs.map(v => v.id)
  await prisma.contractClause.deleteMany({ where: { versionId: { in: vIds } } })
  await prisma.versionDiffCache.deleteMany({ where: { contractId: { in: ids } } }).catch(() => {})
  await prisma.contractVersion.deleteMany({ where: { id: { in: vIds } } })
  await prisma.contract.deleteMany({ where: { id: { in: ids } } })
}

await purge()
const contract = await prisma.contract.create({
  data: { org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
    title: TITLE, type: 'MSA', status: 'DRAFT', analysisStatus: 'DONE' },
  select: { id: true },
})
const mk = (n, html) => prisma.contractVersion.create({
  data: { contractId: contract.id, versionNumber: n, htmlContent: html,
    plainText: html.replace(/<[^>]+>/g, ' '), createdById: userId },
  select: { id: true },
})
await mk(1, V1)
const v2 = await mk(2, V2)
await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: v2.id } })

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))

const SHOTS = new URL('.', import.meta.url).pathname
const shot = n => page.screenshot({ path: `${SHOTS}p4-${n}.png` })

await page.goto(WEB, { waitUntil: 'domcontentloaded' })
await page.fill('input[type=email]', 'admin@demo.com')
await page.fill('input[type=password]', 'password123')
await page.click('button[type=submit]')
await page.waitForLoadState('networkidle').catch(() => {})
const skip = page.locator('text=Skip setup').first()
if (await skip.count()) { await skip.click().catch(() => {}); await page.waitForTimeout(900) }

await page.goto(`${WEB}/contracts/${contract.id}`, { waitUntil: 'domcontentloaded' })
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(1500)

// ─── 1. Compare opens on two versions ───────────────────────────────────────

section('1. A reviewer can open Compare')
{
  const btn = page.locator('button:has-text("Compare")').first()
  check('the Compare entry point is present', await btn.count() > 0)
  if (await btn.count()) {
    await btn.click()
    await page.waitForTimeout(2500)
  }
  await shot('1-compare')
  const body = await page.locator('body').innerText()
  check('the diff renders rather than an empty state',
    !/Only one version exists/i.test(body), 'two versions were seeded')

  // Found by looking at the screenshot rather than by an assertion: every
  // version chip read "Unknown". CompareMode's whole premise is attribution —
  // who proposed this change — and the versions route returned only the raw
  // createdById while the UI read createdByName.
  check('each version names its author, not "Unknown"',
    !/Unknown/.test(body), 'the version chips should carry a real name')
}

// ─── 2. The download control is reachable ───────────────────────────────────

section('2. The Word export is offered where the versions are chosen')
{
  const dl = page.locator('[data-testid=download-redline-docx]')
  const present = await dl.count() > 0
  check('the "Word (tracked)" button is present', present,
    'it belongs beside the version pickers — that is where the two ids exist')
  if (present) {
    check('it is enabled once two versions are selected', await dl.first().isEnabled())
  }
}

// ─── 3. Pressing it delivers a real .docx ───────────────────────────────────

section('3. The download actually arrives, and is a Word file')
{
  const dl = page.locator('[data-testid=download-redline-docx]')
  let saved = ''
  let suggested = ''
  if (await dl.count()) {
    const waitDl = page.waitForEvent('download', { timeout: 45_000 }).catch(() => null)
    await dl.first().click()
    const download = await waitDl
    if (download) {
      suggested = download.suggestedFilename()
      saved = `${TMP}/p4-ui.docx`
      await download.saveAs(saved).catch(() => { saved = '' })
    }
    await page.waitForTimeout(800)
    await shot('2-downloaded')
  }

  check('a download event fired', !!saved,
    saved ? `saved ${suggested}` : 'no download — a 401 from a missing auth header looks exactly like this')

  if (saved && fs.existsSync(saved)) {
    const buf = fs.readFileSync(saved)
    const isZip = buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    check('the downloaded bytes are a ZIP container, not a PDF or JSON', isZip,
      `first bytes ${buf.subarray(0, 4).toString('hex')}`)
    check('the filename says which versions it spans', /v1.*v2/.test(suggested), suggested)

    let xml = ''
    try { xml = execFileSync('unzip', ['-p', saved, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64e6 }) } catch {}
    check('the file the browser received carries tracked changes',
      /<w:ins\b/.test(xml) && /<w:del\b/.test(xml),
      `${(xml.match(/<w:ins\b/g) ?? []).length} ins, ${(xml.match(/<w:del\b/g) ?? []).length} del`)
    check('the changed figure is the one the reviewer saw',
      /<w:delText[^>]*>12<\/w:delText>/.test(xml) && /24/.test(xml),
      'the diff on screen showed 12 -> 24')
  }
}

// ─── 4. Nothing broke on the way ────────────────────────────────────────────

section('4. The surface is clean')
{
  const fatal = errors.filter(e => /is not a function|Cannot read|undefined is not/i.test(e))
  check('no fatal console errors', fatal.length === 0, fatal.slice(0, 2).join(' | ') || 'clean')
  check('no download error banner shown',
    await page.locator('[data-testid=docx-download-error]').count() === 0)
}

await browser.close()
if (!process.env.KEEP_FIXTURE) await purge()
await prisma.$disconnect()
console.log(`\nScreenshots: ${SHOTS}p4-*.png`)
report('P4 docx export UI')
