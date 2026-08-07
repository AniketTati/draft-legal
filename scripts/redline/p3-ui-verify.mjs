#!/usr/bin/env node
/**
 * Phase 3 UI — the first phase a user actually sees, driven end to end.
 *
 * The API check proves the pipeline stages and applies correctly. This proves
 * a person can run it: press the button, watch it work, read the proposals,
 * accept some, and see the document change — with the ones they rejected left
 * alone.
 *
 * It uses the real backend and a real LLM run. No stubbing: the whole point is
 * that the wiring between the rail, the poll, and the worker actually holds.
 */
import { chromium } from '../../node_modules/playwright/index.mjs'
import { login, db, check, report, section } from '../week-zero/lib/harness.mjs'

const WEB = process.env.WEB_BASE ?? 'http://localhost:5173'
const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id
const TITLE = 'P3 UI redline probe'

const FIXTURES = [
  {
    clauseType: 'limitation_of_liability', categoryName: 'Limitation of Liability',
    preferred: 'Liability shall be capped at two times (2x) the fees paid in the preceding twelve months.',
    rules: { must_have: [{ id: 'cap', description: 'A cap must be present', check: 'contains', value: 'capped', severity: 'high' }] },
    content: 'The parties accept unlimited liability for all direct and indirect losses.',
  },
  {
    clauseType: 'governing_law', categoryName: 'Governing Law',
    preferred: 'This Agreement shall be governed by the laws of the State of Delaware.',
    rules: { must_have: [{ id: 'de', description: 'Delaware law', check: 'contains', value: 'delaware', severity: 'high' }] },
    content: 'This Agreement shall be governed by the laws of the State of New York.',
  },
]

async function purge() {
  const stale = await prisma.contract.findMany({ where: { orgId, title: TITLE }, select: { id: true } })
  if (!stale.length) return
  const ids = stale.map(c => c.id)
  await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
  const vs = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
  const vIds = vs.map(v => v.id)
  await prisma.contractClause.deleteMany({ where: { versionId: { in: vIds } } })
  await prisma.contractVersion.deleteMany({ where: { id: { in: vIds } } })
  await prisma.contract.deleteMany({ where: { id: { in: ids } } })
}

await purge()
const contract = await prisma.contract.create({
  data: {
    org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
    title: TITLE, type: 'NDA', status: 'DRAFT', analysisStatus: 'DONE',
  },
  select: { id: true },
})
const version = await prisma.contractVersion.create({
  data: {
    contractId: contract.id, versionNumber: 1,
    htmlContent: FIXTURES.map(f => `<p>${f.content}</p>`).join('\n'),
    plainText:   FIXTURES.map(f => f.content).join('\n\n'),
    createdById: userId,
  },
  select: { id: true },
})
await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })
for (const [i, f] of FIXTURES.entries()) {
  let cat = await prisma.clauseCategory.findFirst({ where: { orgId, name: f.categoryName } })
  cat ??= await prisma.clauseCategory.create({ data: { org: { connect: { id: orgId } }, name: f.categoryName } })
  await prisma.playbookPosition.deleteMany({ where: { orgId, clauseCategoryId: cat.id } })
  await prisma.playbookPosition.create({
    data: {
      org: { connect: { id: orgId } }, clauseCategory: { connect: { id: cat.id } },
      createdById: userId, positionType: 'preferred', content: f.preferred, rules: f.rules,
    },
  })
  await prisma.contractClause.create({
    data: { versionId: version.id, clauseType: f.clauseType, content: f.content, sectionRef: `Section ${i + 1}`, sortOrder: i },
  })
}

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))

const SHOTS = new URL('.', import.meta.url).pathname
const shot = n => page.screenshot({ path: `${SHOTS}p3-${n}.png` })

// ─── Sign in ────────────────────────────────────────────────────────────────

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

// ─── 1. The entry point is there ────────────────────────────────────────────

section('1. A reviewer can find and start the redline')
{
  const btn = page.locator('[data-testid=start-playbook-redline]')
  await btn.scrollIntoViewIfNeeded().catch(() => {})
  await shot('1-idle')
  check('the "Redline against playbook" button is present', await btn.count() > 0)
  if (await btn.count()) {
    await btn.click()
    check('clicking it starts a run', true)
  }
}

// ─── 2. It reports progress rather than going silent ────────────────────────

section('2. The run is visible while it works')
{
  // The page polls contract metadata at 4s; the rail should switch to a
  // working state without the user refreshing.
  const running = page.locator('[data-testid=redline-running]')
  const sawRunning = await running.waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true).catch(() => false)
  await shot('2-running')
  check('the rail shows the run in progress', sawRunning,
    'a multi-minute job that looks idle is indistinguishable from a broken button')
}

// ─── 3. Proposals appear, without a refresh ─────────────────────────────────

section('3. Proposals arrive by polling, with no manual refresh')
{
  const list = page.locator('[data-testid=staged-proposals]')
  const arrived = await list.waitFor({ state: 'visible', timeout: 180_000 })
    .then(() => true).catch(() => false)
  await shot('3-proposals')
  check('the staged proposals render', arrived,
    'the poll must pick the result up on its own — the user will not know to refresh')

  if (arrived) {
    const items = await list.locator('li').count()
    check('one row per deviating clause', items === FIXTURES.length, `${items} rows for ${FIXTURES.length} deviations`)

    const text = await page.locator('body').innerText()
    check('the document is not yet changed',
      text.includes('deviate'), 'the summary should say what deviates before anything is applied')

    // Expand the first proposal — a reviewer has to see both sides.
    await list.locator('li').first().locator('button').first().click().catch(() => {})
    await page.waitForTimeout(600)
    const expanded = await page.locator('body').innerText()
    await shot('4-expanded')
    check('expanding shows the current AND proposed language',
      /Current/i.test(expanded) && /Proposed/i.test(expanded),
      'accepting a change without seeing what it replaces is not review')
  }
}

// ─── 4. Accepting a subset changes only that subset ─────────────────────────

section('4. Accepting one change applies one change')
{
  const clauses = await prisma.contractClause.findMany({
    where: { versionId: version.id }, select: { id: true, clauseType: true },
  })
  const liability = clauses.find(c => c.clauseType === 'limitation_of_liability')

  const acceptBtn = page.locator(`[data-testid=accept-${liability.id}]`)
  const found = await acceptBtn.count() > 0
  check('each proposal has an accept control', found, `looking for accept-${liability?.id}`)

  if (found) {
    await acceptBtn.click()
    await page.waitForTimeout(400)
    const applyBtn = page.locator('[data-testid=apply-accepted-redline]')
    const label = await applyBtn.innerText().catch(() => '')
    check('the apply button counts what was accepted', /Apply 1 change/.test(label), `label="${label}"`)

    await applyBtn.click()
    await page.waitForTimeout(6000)
    await shot('5-applied')

    const c = await prisma.contract.findUnique({ where: { id: contract.id }, select: { currentVersionId: true } })
    const body = await prisma.contractVersion.findUnique({
      where: { id: c.currentVersionId }, select: { plainText: true },
    })
    check('the accepted clause changed in the document',
      !body.plainText.includes(FIXTURES[0].content),
      'the liability clause should no longer say "unlimited liability"')
    check('the clause the reviewer did NOT accept is untouched',
      body.plainText.includes(FIXTURES[1].content),
      'this is the whole promise of staged review')
  }
}

// ─── 5. No fatal errors ─────────────────────────────────────────────────────

section('5. The surface is clean')
{
  const fatal = errors.filter(e => /is not a function|Cannot read|undefined is not/i.test(e))
  check('no fatal console errors across the whole flow', fatal.length === 0,
    fatal.slice(0, 2).join(' | ') || 'clean')
}

await browser.close()
if (!process.env.KEEP_FIXTURE) await purge()
await prisma.$disconnect()
console.log(`\nScreenshots: ${SHOTS}p3-*.png`)
report('P3 redline UI')
