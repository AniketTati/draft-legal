#!/usr/bin/env node
/**
 * L6b — the nine dead-control categories left after the first pass.
 *
 * l6-dead-controls.mjs covers the five fixed earlier (#14 catch-all, #2 bell,
 * #5 counterparty CTA, #4 diligence CSV, #9 portal .docx). This covers the
 * rest, in the same spirit: click the control, then assert the CONSEQUENCE --
 * a mail row, a DB row, a URL change, real bytes. Asserting that a click did
 * not throw is what let all fourteen ship.
 *
 *   #3  notification prefs  — eleven controls that persist and are never read.
 *                             grep for `preferences` across apps/api/src returns
 *                             ONE hit: users.ts echoing the blob back.
 *                             handleNotify emails unconditionally. The comment
 *                             in SettingsPage claiming the worker reads these
 *                             flags is factually false. Users turn email off,
 *                             see a green "Saved", and keep getting mail forever.
 *   #13 telemetry           — nine live call sites posting to a route that was
 *                             never registered. flush() short-circuits to
 *                             console.debug on localhost, which is why nobody
 *                             noticed. Any decision made on "nobody uses
 *                             Compare" rests on no data at all.
 *   #8  Replace All         — runs replaceAll over SERIALIZED HTML. Replacing
 *                             "p" with "q" rewrites every <p> tag; searching
 *                             "Smith & Co" never matches because the HTML holds
 *                             "Smith &amp; Co". This one corrupts documents.
 *   #1  editor exports      — six buttons whose onExport prop no mount site
 *                             passes; the fallback bare-fetches a guarded route,
 *                             401s, and `if (!resp?.ok) return` swallows it.
 *   #7  contract Download   — no try/catch, no error state, ungated, while the
 *                             sibling handleViewPdf has both.
 *   #10 bulk approve        — per-item catch { failed++ } then an unconditional
 *                             close after 600 ms, with the failure count
 *                             rendered in success green.
 *   #11 send reminder       — no onError; 409s render as nothing at all.
 *   #12 signature badges    — counts reduced over the already-filtered response,
 *                             so selecting any tab zeroes every other badge.
 *   #6  artifact exports    — declared with neither href nor tool, so the click
 *                             throws "This action has nothing to apply" and
 *                             flashes an unlabeled red icon for 2.5s.
 *
 * Run BEFORE: preferences are ignored, telemetry 404s, Replace All corrupts
 *             tags, and the rest fail silently.
 * Run AFTER:  each does what its label says, or is gone.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { login, db, check, report, section, API } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const read = p => { try { return fs.readFileSync(`${REPO}/${p}`, 'utf8') } catch { return '' } }
const stripTs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

// The services read DATABASE_URL from the repo-root .env; child processes this
// check spawns need it passed through explicitly.
const dbUrl = () => {
  try {
    return /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(`${REPO}/.env`, 'utf8'))?.[1]
      ?.trim().replace(/^["']|["']$/g, '') ?? ''
  } catch { return '' }
}

const prisma = db()
const admin  = await login()
const orgId  = admin.user.orgId
const userId = admin.user.id

// ─── 1. Notification preferences are actually read ──────────────────────────
//
// The behavioural assertion is the one that counts: set a flag false, queue a
// notification of that type, and assert no email was attempted. Then flip it
// back and assert one was -- a check that only proves suppression proves half
// of it, and a worker that never emails would pass the first half.

section('1. Turning a notification off turns it off')
{
  // Both files matter: the decision lives in lib/, and the worker has to
  // actually consult it. Reading only one would pass with the other missing.
  const worker = read('apps/api/src/workers/notification.worker.ts')
  const prefsLib = read('apps/api/src/lib/notification-prefs.ts')
  const code   = stripTs(worker) + '\n' + stripTs(prefsLib)

  // Audit 2026-08-08 — the previous regex here was an alternation whose second
  // branch matched the bare token `!gate.emailed` anywhere in the file. It
  // never required the branch to RETURN, so dropping the early return would
  // have kept this green while mail kept going out. Scope to the delivery
  // function and require the gate to short-circuit BEFORE the send.
  const delivery = stripTs(read('apps/api/src/lib/notification-delivery.ts'))
  //
  // Scoped to the gate's OWN block. A first attempt sliced from `!gate.emailed`
  // to `sendEmail(` and required a `return` somewhere in between — which passed
  // against the dropped-return regression, because the `if (!isEmailConfigured())`
  // block sitting between them has a return of its own. That is the identical
  // window-swallowing mistake this audit was cleaning up, reproduced while
  // cleaning it up.
  const gateBlock = (/if \(!gate\.emailed\) \{([\s\S]*?)\n {2}\}/.exec(delivery) || ['', ''])[1]
  check('the delivery path was located', delivery.length > 0,
    'an unreadable path makes every assertion below pass trivially')
  check('it awaits the preference gate', /await shouldEmail\(/.test(delivery),
    'a decision function nothing calls is not a fix')
  check('the suppression branch was located', gateBlock.length > 0,
    'if this is empty the assertion below is vacuous')
  check('the gate short-circuits the send rather than only logging it',
    gateBlock.length > 0 && /\breturn\b/.test(gateBlock),
    'gate computed, suppression logged, `return` dropped — sendEmail still runs and the user keeps getting mail')

  check('handleNotify loads the recipient preferences',
    /preferences/.test(code),
    'grep for `preferences` across apps/api/src used to return exactly one hit: users.ts echoing the blob straight back')

  check('there is a type→preference mapping',
    /APPROVAL_REQUEST[\s\S]{0,120}approvalRequested/.test(code),
    'the toggle is per notification TYPE, so something has to map one to the other')

  check("digest 'off' suppresses everything",
    /digest/.test(code) && /'off'|"off"/.test(code),
    'the digest selector offers off; if it is not honoured it is another dead control')

  // The false claim that hid this for so long.
  const settings = read('apps/web/src/pages/SettingsPage.tsx')
  check('SettingsPage no longer claims the worker reads flags it does not',
    !/Backend already[\s\S]{0,200}reads these flags before sending/.test(settings)
    || /preferences/.test(code),
    'the comment asserted the delivery side honoured these toggles while handleNotify emailed unconditionally')

  // Behavioural: does an email actually get suppressed?
  const probe = await import('node:child_process')
  const script = `
    import { PrismaClient } from '@prisma/client'
    const prisma = new PrismaClient()
    const u = await prisma.user.findUnique({ where: { id: ${JSON.stringify(userId)} }, select: { preferences: true } })
    console.log('<<<P>>>' + JSON.stringify(u?.preferences ?? null))
    await prisma.$disconnect()
  `
  void probe; void script

  const before = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } })
  const prefsOf = (p) => (p && typeof p === 'object' ? p : {})
  try {
    // OFF → no email attempted.
    await prisma.user.update({
      where: { id: userId },
      data: { preferences: { ...prefsOf(before?.preferences), notifications: { approvalRequested: false } } },
    })
    const off = await callWorker('APPROVAL_REQUEST')
    check('an APPROVAL_REQUEST is not emailed when approvalRequested is false',
      off?.emailed === false,
      `worker reported emailed=${off?.emailed} (${off?.reason ?? 'no reason'}) — the user saw a green "Saved" and kept getting mail`)

    // ON → email attempted. Proving suppression alone would also pass for a
    // worker that never emails anyone.
    await prisma.user.update({
      where: { id: userId },
      data: { preferences: { ...prefsOf(before?.preferences), notifications: { approvalRequested: true } } },
    })
    const on = await callWorker('APPROVAL_REQUEST')
    check('the same notification IS emailed when the flag is true',
      on?.emailed === true,
      `worker reported emailed=${on?.emailed} (${on?.reason ?? 'no reason'}) — suppressing everything is not honouring a preference`)
  } finally {
    // Always restore. A probe that leaves the workspace mutated turns the next
    // unrelated check red for reasons that look like a code regression.
    await prisma.user.update({ where: { id: userId }, data: { preferences: before?.preferences ?? {} } })
  }
}

/**
 * Ask the worker's own decision function whether it would email, without
 * standing up BullMQ. Importing the module under test is the point -- a
 * reimplementation here would pass while the worker still emailed.
 */
async function callWorker(type) {
  const { execFileSync } = await import('node:child_process')
  // A temp .mts file rather than `tsx -e`: the inline form compiles to CJS and
  // rejects the top-level await this needs.
  const tmp = `${REPO}/apps/api/.l6b-probe.mts`
  fs.writeFileSync(tmp, `
    import { shouldEmail } from './src/lib/notification-prefs.js'
    const r = await shouldEmail(${JSON.stringify(userId)}, ${JSON.stringify(type)})
    process.stdout.write('<<<R>>>' + JSON.stringify(r))
  `)
  try {
    const out = execFileSync('pnpm', ['exec', 'tsx', tmp], {
      cwd: `${REPO}/apps/api`, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || dbUrl() },
    })
    return JSON.parse(out.split('<<<R>>>')[1])
  } catch (e) {
    return { emailed: null, reason: String(e.stderr ?? e.message).slice(-200) }
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* */ }
  }
}

// ─── 2. Telemetry either lands somewhere or is gone ─────────────────────────

section('2. Telemetry is not posting into the void')
{
  const tel = read('apps/web/src/lib/telemetry.ts')
  const telemetryExists = tel.length > 0

  if (!telemetryExists) {
    // Was `check(..., true, ...)` — a hardcoded pass, and the title names an
    // invariant that is actually testable. Deleting telemetry.ts while leaving
    // its importers behind is a build break, and the hardcoded form reported
    // that as success. Currently dead code (the file exists), which is exactly
    // when a trap like this gets written and never noticed.
    const residual = fs.readdirSync(`${REPO}/apps/web/src`, { recursive: true })
      .filter(f => /\.tsx?$/.test(String(f)))
      .filter(f => /from ['"].*lib\/telemetry|trackEvent\(/
        .test(fs.readFileSync(`${REPO}/apps/web/src/${f}`, 'utf8')))
    check('lib/telemetry.ts was deleted along with its call sites', residual.length === 0,
      residual.length
        ? `telemetry.ts is gone but ${residual.length} file(s) still reference it: ${residual.slice(0, 5).join(', ')}`
        : 'leaving instrumentation everyone believes is live is the worse option')
  } else {
    const res = await fetch(`${API}/api/v1/telemetry/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.accessToken}` },
      // Exactly the shape lib/telemetry.ts buffers and posts.
      body: JSON.stringify({ events: [{ event: 'l6b_probe', at: Date.now(), props: { probe: true } }] }),
    })
    check('POST /api/v1/telemetry/events is registered', res.status !== 404,
      `HTTP ${res.status} — nine live call sites posted here and app.ts never registered the route; flush() short-circuits to console.debug on localhost, which is why nobody noticed`)
    check('it accepts a well-formed batch', res.status < 300,
      `HTTP ${res.status} ${(await res.text()).slice(0, 140)}`)
  }
}

// ─── 3. Replace All operates on the document, not on its serialization ──────

section('3. Replace All cannot corrupt the markup')
{
  const editor = read('apps/web/src/components/editor/ContractEditor.tsx')
    || read('apps/web/src/components/ContractEditor.tsx')
  const code = stripTs(editor)

  check('ContractEditor was located', editor.length > 0)
  check('Replace All no longer runs over getHTML()',
    !/getHTML\(\)[\s\S]{0,80}replaceAll/.test(code),
    'replacing "p" with "q" over serialized HTML rewrites every <p> tag; and "Smith & Co" never matches because the HTML holds "Smith &amp; Co"')
  check('it walks the ProseMirror document instead',
    /state\.doc\.descendants|descendants\(/.test(code),
    'the document tree holds text as text, so entities and tag names are not in scope to be corrupted')
  // Audit 2026-08-08 — VERIFIED DEAD by checking out the pre-fix file and
  // running the old regex over it: it returned true. It searched the whole
  // 33 KB file and matched unrelated toolbar calls (undo, bold, clause
  // insert), so it was green against the original
  // getHTML().replaceAll + setContent, which discarded undo history entirely.
  const frBody = (/const handleFindReplace[\s\S]*?\n {2}\}, \[[^\]]*\]\)/.exec(code) || [''])[0]
  check('handleFindReplace was located', frBody.length > 0)
  check('the replacement is one undoable transaction',
    frBody.length > 0
    && (frBody.match(/\.run\(\)|dispatch\(/g) || []).length === 1
    && !/editor\.commands\./.test(frBody)
    && /editor\.chain\(\)[\s\S]*for\s*\([\s\S]*insertContentAt/.test(frBody),
    'the chain must open before the loop and run once after it; a per-match commands.*/dispatch inside the loop makes ctrl-Z undo one replacement at a time')
}

// ─── 4. Downloads go through the authenticated client ───────────────────────
//
// middleware/auth.ts accepts only `Authorization: Bearer`, there is no cookie
// fallback, and only the axios client attaches the token. So window.open, a
// bare <a href="/api/...">, and plain fetch() are all automatic 401s against a
// guarded route. CompareMode is the correct pattern and its own comment
// already named ContractEditor as the anti-pattern.

section('4. Editor and contract downloads are authenticated and handled')
{
  const editor = read('apps/web/src/components/editor/ContractEditor.tsx')
    || read('apps/web/src/components/ContractEditor.tsx')
  const detail = read('apps/web/src/pages/ContractDetailPage.tsx')

  // This first went green against BROKEN code: the regex allowed only a
  // backtick before /api/v1 and the source uses a single quote. Match any
  // quoting, and assert on the positive form too.
  // Audit 2026-08-08 — both halves used to be file-global. The positive half
  // was already satisfied by api.get('/clauses') and two api.post calls that
  // predate this fix, so it proved nothing about handleExport.
  const ed = stripTs(editor)
  const hxStart = ed.indexOf('const handleExport')
  const hxBody  = hxStart >= 0 ? ed.slice(hxStart, ed.indexOf('}, [editor, onExport])', hxStart)) : ''
  check('handleExport was located', hxBody.length > 0)
  check('the editor export path uses the api client, not a bare fetch',
    hxBody.length > 0 && !/\bfetch\(/.test(hxBody) && /api\.post\(/.test(hxBody),
    'a bare fetch carries no Authorization header, so a permission-guarded export route 401s every time')

  // Audit 2026-08-08 — this negative-matched the literal `resp`, but the code
  // now names the response `res`, so the natural regression would slip past.
  // Assert the positive property instead: the failure reaches a rendered state.
  check('a failed export is surfaced rather than swallowed',
    /catch\s*\(/.test(hxBody) && /setExportError\(/.test(hxBody)
    && /exportError &&/.test(ed) && !/\.ok\)\s*return\b/.test(hxBody),
    'a silent return on failure is why six buttons appeared to do nothing at all')

  // This first went green against BROKEN code too: a 600-char window after
  // `handleDownload` swallowed the NEXT function, handleViewPdf, which does
  // have a try/catch. Scope to handleDownload's own body, and require the
  // failure to reach a rendered error state rather than just being caught.
  const dl = stripTs(detail)
  const dlStart = dl.indexOf('const handleDownload')
  const dlBody  = dlStart >= 0 ? dl.slice(dlStart, dl.indexOf('const handleViewPdf', dlStart)) : ''
  check('contract Download catches its own failure', /catch\s*\(/.test(dlBody),
    'no try/catch at all, while the sibling handleViewPdf immediately below has one')
  check('the failure is rendered, not just caught', /setDownloadError/.test(dlBody) && /downloadError &&/.test(dl),
    'on an agent-drafted or pasted-HTML contract the route 404s and the menu simply closed')
}

// ─── 5. Failures are shown where the action was taken ───────────────────────

section('5. Partial failures are reported, not styled as success')
{
  const approvals = read('apps/web/src/pages/ApprovalsPage.tsx')
  const sig       = read('apps/web/src/components/contracts/SignatureStatus.tsx')
  const sigPage   = read('apps/web/src/pages/SignaturesPage.tsx')

  check('bulk approve does not auto-close when something failed',
    /if \([^)]*(length === 0|!failed)[^)]*\)\s*setTimeout\(\(\) => onDone/.test(stripTs(approvals)),
    'an unconditional setTimeout(onDone, 600) closed the dialog over a failure count rendered in emerald success green'  )
  check('bulk approve keeps the server-side reason',
    !/catch\s*\{\s*failed\+\+\s*\}/.test(stripTs(approvals)),
    'a bare catch discards the per-step detail the server sent, so nobody learns which items failed or why')

  check('send reminder surfaces its error',
    /onError/.test(stripTs(sig)),
    'signatures.ts returns 409 for non-PENDING and for all-responded; with no onError the button stays "Send reminder" and no email was sent')
  check('SignatureStatus was located', sig.length > 0,
    'an unreadable path made every assertion here pass trivially')
  check('reminder state is per-row',
    !/remindMut\.isSuccess/.test(stripTs(sig)),
    'one mutation object is shared across every row, so reading isSuccess off it made every row claim "Reminder sent" as soon as any one succeeded')

  // This matched `total: number` in the query's TYPE declaration, which was
  // present all along. What matters is where the counts are reduced FROM.
  const sp = stripTs(sigPage)
  check('badge counts are not reduced over the filtered response',
    !/const counts = items\.reduce/.test(sp),
    '`items` is the CURRENT tab\'s response, so selecting any tab zeroed every other badge')
  check('the ALL badge reads a total rather than the page length',
    !/'ALL' \? items\.length/.test(sp),
    "the query's own `total` was never read")
}

// ─── 6. Artifact actions do something or are not offered ────────────────────

section('6. Artifact actions are wired or withdrawn')
{
  const artifact = read('apps/web/src/components/agent/artifact-from-tool.ts')
  const pane     = read('apps/web/src/components/agent/ArtifactPane.tsx')
  const code     = stripTs(artifact)

  // Either every declared action can act, or it is not declared. The same file
  // already records deleting save_draft / send_for_review for this exact
  // reason; these three survived that cleanup.
  const actions = [...code.matchAll(/\{[^{}]*\bid:\s*'([a-z-]+)'[^{}]*\}/g)]
  const exportish = actions.filter(m => /export|csv|memo/i.test(m[0]))
  const unwired  = exportish.filter(m => !/href|tool:|onClick|handler|clientAction/.test(m[0]))
  check('no artifact action is declared with neither href nor tool',
    unwired.length === 0,
    unwired.length
      ? `${unwired.length} unwired: ${unwired.map(m => m[1]).join(', ')} — AgentHomePage throws "This action has nothing to apply" and ArtifactPane flashes an unlabeled red icon for 2.5s, while still rendering a Download icon that makes it look wired`
      : 'every export action carries a way to act')

  // Anchored on the CATCH, not on the word "error" appearing somewhere near
  // ActionButton -- `state === 'error'` alone satisfied that and was always true.
  const paneCode = stripTs(pane)
  check('the catch keeps the thrown message instead of discarding it',
    !/\}\s*catch\s*\{\s*\n\s*setState\('error'\)/.test(paneCode)
    && /catch \(err\)[\s\S]{0,200}setErrorMessage/.test(paneCode),
    'a bare `catch {}` threw the reason away and flashed an unlabeled red icon for 2.5s')
  check('the message is rendered next to the control',
    /errorMessage &&[\s\S]{0,300}role="alert"/.test(paneCode),
    'a user who cannot read the reason cannot tell a permissions problem from an unwired button')
}

await prisma.$disconnect()
report('L6b dead controls')
