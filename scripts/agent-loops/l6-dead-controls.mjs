#!/usr/bin/env node
/**
 * L6 — controls in the app that do nothing.
 *
 * The plan lists 14 categories / 25 controls. This check covers the subset
 * fixed in this pass, chosen by consequence rather than by ease:
 *
 *   #14 no catch-all route  — the force multiplier. Every bad link renders full
 *                             chrome around an empty page instead of a 404, so
 *                             a broken link is indistinguishable from a broken
 *                             app and cannot be diagnosed from the outside.
 *   #2  notification bell   — APPROVAL_REQUEST emits `approval_step`, which
 *                             matches neither branch, so the most actionable
 *                             notification in the product greys out. And
 *                             `approval_instance` navigates to /approvals/<id>,
 *                             a route that does not exist.
 *   #5  counterparty CTA    — "New contract" goes to /contracts/new, which
 *                             matches /contracts/:id with id='new' and renders
 *                             "Contract not found". It is the ONLY create CTA in
 *                             that page's zero-contracts empty state.
 *   #4  diligence CSV       — window.open against a permission-guarded route,
 *                             so the user gets a tab of 401 JSON. The correct
 *                             pattern is two files over in ObligationsPage.
 *   #9  portal .docx        — POSTs HTML to Gotenberg's document->PDF route and
 *                             stamps a .docx name and MIME type on the result.
 *                             Word refuses to open it, and the audience is the
 *                             COUNTERPARTY.
 *
 * The mechanism behind several is one auth fact: middleware/auth.ts accepts
 * only `Authorization: Bearer`, and only the axios client attaches it. So any
 * window.open, bare <a href="/api/...">, or plain fetch() against a guarded
 * route is an automatic 401. CompareMode's own comment already named
 * ContractEditor as the anti-pattern, without anyone fixing it.
 *
 * Run BEFORE: no catch-all, the bell drops its most important notification
 *             type, the counterparty CTA 404s, CSV opens a JSON tab, and the
 *             portal serves PDF bytes as .docx.
 * Run AFTER:  each one does what its label says, or is gone.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const read = p => { try { return fs.readFileSync(`${REPO}/${p}`, 'utf8') } catch { return '' } }

const app      = read('apps/web/src/App.tsx')
const bell     = read("apps/web/src/components/approvals/NotificationBell.tsx")
  || read('apps/web/src/components/NotificationBell.tsx')
const cparty   = read('apps/web/src/pages/CounterpartyDetailPage.tsx')
const diligence= read('apps/web/src/pages/DiligenceRoomDetailPage.tsx')
const portal   = read('apps/api/src/routes/portal.ts')
const contracts= read('apps/api/src/routes/contracts.ts')

// ─── 1. A bad link must be diagnosable ──────────────────────────────────────

section('1. Unknown routes render a NotFound, not empty chrome')
{
  check('the router has a catch-all route', /path=["']\*["']/.test(app),
    'without one, AppShell renders its Outlet as null — full navigation around a blank page, which reads as a broken app rather than a bad link')
}

// ─── 2. The bell routes its most actionable notification ────────────────────

section('2. The notification bell handles approval notifications')
{
  check('the bell was located', bell.length > 0, 'NotificationBell.tsx')
  check('approval_step is handled',
    /approval_step/.test(bell),
    'workflow-engine and notification.worker both emit approval_step for APPROVAL_REQUEST; it matched neither branch, so the row greyed out')
  // Matched only the TEMPLATE-LITERAL spelling of the bug, so the assertion
  // was one syntax away from vacuous: reintroducing it as
  // `navigate('/approvals/' + n.id)` left the check green. Verified.
  //
  // The proposition does not care how the string is built, so neither should
  // the test: read every navigate() argument and ask whether any of them
  // addresses a CHILD of /approvals. `navigate('/approvals')` has no trailing
  // slash and is unaffected.
  const navTargets = [...bell.matchAll(/navigate\(([^)]+)\)/g)].map(m => m[1])
  const deepApproval = navTargets.some(t => t.includes('/approvals/'))
  check('approval navigation targets a route that exists',
    !deepApproval || /path=["']approvals\/:/.test(app),
    deepApproval
      ? `it navigates under /approvals/<id>, which App.tsx does not register: ${navTargets.filter(t => t.includes('/approvals/')).join(' | ')}`
      : `${navTargets.length} navigate() target(s), none addressing a child of /approvals`)
}

// ─── 3. The counterparty create CTA ─────────────────────────────────────────

section('3. "New contract" from a counterparty goes somewhere real')
{
  check('it no longer navigates to /contracts/new',
    !/['"`]\/contracts\/new['"`]/.test(cparty),
    "/contracts/new matches /contracts/:id with id='new' and renders \"Contract not found\" — and it is the only create CTA in that page's empty state")
}

// ─── 4. Downloads go through the authenticated client ───────────────────────

section('4. Guarded downloads use the axios client, not window.open')
{
  const opensGuarded = /window\.open\([^)]*\/api\/v1\//.test(diligence)
  check('the diligence export does not window.open a guarded route', !opensGuarded,
    opensGuarded
      ? 'only the axios client attaches the Bearer token, so this opens a tab of 401 JSON'
      : 'routed through the authenticated client')
  // The old form was `blob || !/Export CSV/i`, which is an escape hatch keyed
  // on a BUTTON LABEL: break the download and rename the button, and it goes
  // green. Anchor on the export call itself, which is the thing that has to be
  // right, and require it to exist — a silently deleted export should be
  // visible here rather than passing as "nothing to check".
  const exportLines = diligence.split('\n').filter(l => /\/export\?format=csv/.test(l))
  const allBlob = exportLines.every(l => /api\.get\(/.test(l) && /responseType:\s*'blob'/.test(l))
  check('it requests a blob through api.get',
    exportLines.length > 0 && allBlob,
    exportLines.length === 0
      ? 'no CSV export call found at all — it was removed, or the route changed and this check is now blind'
      : `${exportLines.length} export call(s); every one must use api.get with responseType blob — the working pattern is two files over in ObligationsPage.tsx`)
}

// ─── 5. Nothing serves PDF bytes as a Word document ─────────────────────────

section('5. No endpoint labels a PDF as .docx')
{
  // Gotenberg's /forms/libreoffice/convert converts documents TO PDF. Stamping
  // the wordprocessingml MIME type on its output produces a file Word refuses
  // to open. The portal one is served to the COUNTERPARTY.
  // Assert the CALL, not the word. A looser version matched the explanatory
  // comments left behind by the fix and reported it as unfixed -- the same
  // "match the text, not the behaviour" mistake that has recurred all wave.
  const liar = src => /fetch\(\s*`\$\{GOTENBERG_URL\}\/forms\/libreoffice\/convert`/.test(src)
  check('the portal does not serve libreoffice-convert output as .docx',
    !liar(portal),
    "the route's own comment says the point is \"download .docx -> redline locally -> upload back\"")
  check('contracts.ts does not serve libreoffice-convert output as .docx',
    !liar(contracts),
    'POST /contracts/export with format=docx returned PDF bytes under a Word MIME type')
}

report('L6 dead controls (subset)')
