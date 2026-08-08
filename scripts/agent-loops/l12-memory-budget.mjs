#!/usr/bin/env node
/**
 * L12 — session memory grows without bound, and truncates the wrong tools.
 *
 * memory.py trimmed to the last 50 MESSAGES, which is not a size bound. Tool
 * results persist at up to 20_000 chars each for most tools, and the restore
 * loop replays every one of them into the next prompt with no cap. Worst case
 * is 25 tool calls x 20 KB x 25 assistant turns -- megabytes re-sent on EVERY
 * subsequent message, so cost grows quadratically in turn count. Long before
 * the wallet notices, it exceeds the context window and 400s, which L3 then
 * swallowed into a blank bubble.
 *
 * The comment claiming the persisted slice was capped "at the same preview
 * (<=2000 chars typically)" was true before the 20K allowlist was added
 * immediately above it. Being off by 10x is exactly why this was invisible in
 * review.
 *
 * THE MIRROR DEFECT (sections 4-5). A8 tells the model the whole prior listing
 * is still in history, so "quote the second match" is answerable without
 * re-running the search. That promise held only for the three tools A8 names,
 * because all three sit in the 20K streaming allowlist and the persisted slice
 * was taken FROM the streamed preview. Every tool off that allowlist streamed
 * at 800, so `preview[:2000]` could never exceed 800 either. clause_search
 * defaults to 5 x 400-char windows -- roughly 3 KB -- so 800 chars cut it
 * mid-token on a routine call, and the next turn quoted a fragment or silently
 * re-ran the search and returned a DIFFERENT match. That contradiction is the
 * exact failure A8 exists to prevent.
 *
 * Run BEFORE: only a message-count trim, and the persisted slice is whatever
 *             the streamed preview was (up to 20K -- or, for the tools that
 *             matter here, capped at 800).
 * Run AFTER:  a byte ceiling on the log, and a separate cap on what is
 *             persisted for replay, decoupled from the stream cap.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { login, db, check, report, section, API } from '../week-zero/lib/harness.mjs'

const REPO = '/Users/temp/Documents/Code/draft-legal'
const mem  = fs.readFileSync(`${REPO}/apps/agents/app/memory.py`, 'utf8')
const orch = fs.readFileSync(`${REPO}/apps/agents/app/orchestrator.py`, 'utf8')

section('1. The session log has a size bound, not just a message count')
{
  check('memory.py defines a byte ceiling', /MAX_SESSION_BYTES/.test(mem),
    'a message COUNT is not a size bound when one message can carry 500 KB of tool results')
  // Audit 2026-08-08 — this matched the loop HEADER only. Whether it drops the
  // OLDEST or the NEWEST turn is decided in the body, and the body was never
  // inspected — a trim that dropped the newest message would have passed.
  const trimIdx = mem.search(/while\s+len\(encoded\)\s*>\s*MAX_SESSION_BYTES/)
  const trimBody = trimIdx >= 0 ? mem.slice(trimIdx, trimIdx + 600) : ''
  check('the trim loop enforces it', trimIdx >= 0,
    'a byte ceiling nothing enforces is a comment')
  check('it drops the OLDEST entry, not the newest',
    /\.pop\(0\)|del [a-z_]+\[0\]|\[1:\]/.test(trimBody),
    'oldest-first, because the newest turns are the ones the model needs; dropping from the end would silently discard the turn just written')
}

section('2. What is REPLAYED is capped tighter than what is streamed')
{
  check('a separate persist cap exists', /PERSIST_RESULT_CHARS/.test(orch),
    'the persisted slice used to be whatever the streamed preview was -- up to 20K per result, replayed every turn')
  check('the persisted slice is capped by it',
    /persisted\s*=\s*result_str\[:persist_cap\]/.test(orch),
    'must slice result_str, not preview -- see section 4')
  const capMatch = /^PERSIST_RESULT_CHARS\s*=\s*([\d_]+)/m.exec(orch)
  const cap = capMatch ? Number(capMatch[1].replace(/_/g, '')) : Infinity
  check('it is well below the 20K streaming allowlist', cap <= 4000, `PERSIST_RESULT_CHARS = ${cap}`)
  // Audit 2026-08-08 — reading the DEFINITION line proves nothing about the
  // persist site. Nothing here asserted that the non-listing branch actually
  // resolves to PERSIST_RESULT_CHARS, so the constant could sit there unused
  // while the code applied any number it liked.
  check('the non-listing branch resolves to that constant',
    /persist_cap = \([\s\S]{0,200}else PERSIST_RESULT_CHARS/.test(orch),
    'the constant is only a budget if the code that slices actually uses it')
}

// ─── 4. The persisted slice is not derived from the streamed one ────────────
//
// This is the mechanism behind the mirror defect. `persisted = preview[:2000]`
// reads as a 2000-char cap, but `preview` was already cut to the STREAM budget
// -- 800 chars for every tool off the 20K allowlist. So the two numbers
// multiplied instead of the tighter one winning, and the cap that applied was
// whichever was smaller. Bandwidth and replay are different concerns with
// different right answers; they must be sliced from the same source.

section('4. Replay budget is decoupled from stream budget')
{
  check('the persisted slice is taken from the full result, not the preview',
    /persisted\s*=\s*result_str\[/.test(orch) && !/persisted\s*=\s*preview\[/.test(orch),
    'slicing the preview means a tool that streams at 800 can never persist more than 800, whatever the persist cap says')

  check('a listing budget exists for the tools A8 promises are in history',
    /PERSIST_RESULT_CHARS_LISTING/.test(orch),
    'A8 names three tools; the four it does not name are the ones that were truncated')

  const listingSet = /A8_LISTING_TOOLS[^{]*\{([^}]*)\}/s.exec(orch)?.[1] ?? ''
  for (const tool of ['clause_search', 'contract_validate', 'request_list', 'custom_field_list']) {
    check(`${tool} is covered by the listing budget`, listingSet.includes(`"${tool}"`),
      'A8 tells the model the whole prior listing is in history; for this tool it was cut at 800 chars')
  }

  const listMatch = /PERSIST_RESULT_CHARS_LISTING\s*=\s*([\d_]+)/.exec(orch)
  const listCap = listMatch ? Number(listMatch[1].replace(/_/g, '')) : 0
  check('the listing budget fits a default clause_search (5 x 400-char windows)',
    listCap >= 4000, `PERSIST_RESULT_CHARS_LISTING = ${listCap} — 5 windows of 400 chars plus JSON overhead is ~3 KB`)
}

section('3. The bound actually holds when a session is hammered')
{
  // Append far more than the ceiling and confirm the stored log stays under it.
  const py = `
import asyncio, json
from app.memory import append_to_session, get_session_history, MAX_SESSION_BYTES
sid = "l12-budget-probe"
big = "x" * 20_000
async def main():
    for i in range(60):
        await append_to_session(sid, "assistant", "turn %d" % i,
            tool_calls=[{"id": "t%d" % i, "name": "contract_search", "args": {}}],
            tool_results=[{"id": "t%d" % i, "name": "contract_search", "result": big, "truncated": True}])
    h = await get_session_history(sid)
    print("<<<R>>>" + json.dumps({"bytes": len(json.dumps(h)), "ceiling": MAX_SESSION_BYTES, "messages": len(h)}))
asyncio.run(main())
`
  let out = null
  try {
    const raw = execFileSync(`${REPO}/apps/agents/.venv/bin/python`, ['-c', py],
      { cwd: `${REPO}/apps/agents`, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
    out = JSON.parse(raw.split('<<<R>>>')[1])
  } catch (e) {
    out = { _error: String(e.stderr ?? e.message).slice(-300) }
  }
  check('60 turns of 20 KB results stay under the ceiling',
    out && !out._error && out.bytes <= out.ceiling,
    out?._error ?? `${out?.bytes} bytes vs ceiling ${out?.ceiling} (${out?.messages} messages) — before the fix this was ~1.2 MB and climbing`)
  // Audit 2026-08-08 — the assertion above is one-sided: it only says the log
  // is SMALL. A trim that emptied the session entirely, or a get_session_history
  // that returned [], would sail through it while destroying the feature this
  // whole mechanism exists for.
  check('and the most recent turns actually survive',
    out && !out._error && out.messages >= 2,
    `${out?.messages} messages retained — a byte ceiling that keeps nothing is not a budget, it is a delete`)
  check('the retained log is a meaningful fraction of the ceiling',
    out && !out._error && out.bytes > out.ceiling * 0.5,
    `${out?.bytes} of ${out?.ceiling} bytes — trimming far below the ceiling means the budget is not the thing doing the work`)
}

// ─── 5. The A8 promise, end to end ──────────────────────────────────────────
//
// The static checks above pin the mechanism. This one drives a real
// clause_search and reads what the NEXT turn would actually be handed. The
// fixture puts five matches in one contract, each wrapped in its own sentinel
// inside the 400-char window, so "did the whole listing survive replay" is a
// countable question rather than a length comparison.

section('5. A clause_search listing survives into the next turn intact')
{
  const prisma = db()
  const admin  = await login()
  const orgId  = admin.user.orgId
  const userId = admin.user.id
  const TITLE  = 'L12 clause listing probe'

  const purge = async () => {
    const stale = await prisma.contract.findMany({ where: { orgId, title: TITLE }, select: { id: true } })
    if (!stale.length) return
    const ids = stale.map(c => c.id)
    await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
    const vs = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
    await prisma.contractClause.deleteMany({ where: { versionId: { in: vs.map(v => v.id) } } })
    await prisma.contractVersion.deleteMany({ where: { id: { in: vs.map(v => v.id) } } })
    await prisma.contract.deleteMany({ where: { id: { in: ids } } })
  }

  // Five matches, each with a sentinel immediately either side so both land
  // inside the 400-char window (200 before / 200 after). The filler between
  // blocks is longer than a window, so the windows never overlap and the
  // result is a genuine five-entry listing rather than one merged blob.
  const filler = (n, tag) => `${tag} clause text `.repeat(Math.ceil(n / 16)).slice(0, n)
  const plainText = Array.from({ length: 5 }, (_, i) =>
    `${filler(420, `pad${i}`)} ZZMARK${i + 1}A the Service Credit shall apply ZZMARK${i + 1}B ${filler(420, `pad${i}`)}`
  ).join('\n\n')

  await purge()
  const contract = await prisma.contract.create({
    data: {
      org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
      title: TITLE, type: 'MSA', status: 'DRAFT', analysisStatus: 'DONE',
    },
    select: { id: true },
  })
  const version = await prisma.contractVersion.create({
    data: {
      contractId: contract.id, versionNumber: 1,
      htmlContent: `<p>${plainText}</p>`, plainText,
      createdById: userId,
    },
    select: { id: true },
  })
  await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })

  // Which tool the model picks is not deterministic, and this check is about
  // what survives into memory rather than about routing. Name the tool, and
  // retry on a fresh session if the model answered from contract_get instead --
  // an unset trap is a flaky check, not a passing one.
  let sessionId = ''
  let frames = []
  let called = false
  for (let attempt = 1; attempt <= 3 && !called; attempt++) {
    sessionId = `l12-listing-probe-${Date.now()}-${attempt}`
    const res = await fetch(`${API}/api/v1/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({
        message: `Call the clause_search tool on contract ${contract.id} with the query "Service Credit", then list every match it returns. Do not use any other tool.`,
        agentMode: true, sessionId,
        pageContext: { type: 'contract', id: contract.id, label: TITLE },
      }),
    })
    frames = (await res.text()).split('\n').filter(l => l.startsWith('data:'))
      .map(l => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
      .filter(Boolean)
    called = frames.some(f => f.type === 'tool_call_result' && f.name === 'clause_search')
  }

  check('the agent ran clause_search', called,
    called ? 'called' : `frames: ${[...new Set(frames.map(f => f.name ?? f.type))].join(', ')} — the trap was never set after 3 attempts`)

  // Read the persisted session the way the NEXT turn's restore loop will.
  const py = `
import asyncio, json
from app.memory import get_session_history
print("<<<R>>>" + json.dumps(asyncio.run(get_session_history(${JSON.stringify(sessionId)}))))
`
  let history = []
  try {
    const raw = execFileSync(`${REPO}/apps/agents/.venv/bin/python`, ['-c', py],
      { cwd: `${REPO}/apps/agents`, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    history = JSON.parse(raw.split('<<<R>>>')[1])
  } catch { /* asserted below */ }

  const persisted = history
    .flatMap(m => m.tool_results ?? [])
    .filter(r => r.name === 'clause_search')
    .map(r => r.result)

  check('the clause_search result was persisted', persisted.length > 0,
    `${history.length} messages in session, ${persisted.length} clause_search results`)

  const blob = persisted.join('\n')
  const found = [1, 2, 3, 4, 5].filter(i => blob.includes(`ZZMARK${i}A`))
  check('all five matches survived into session memory', found.length === 5,
    `${found.length}/5 sentinels present — before the fix the slice was cut at 800 chars, so turn 2 could only see the first match and "quote the second one" contradicted turn 1`)

  // A slice cut mid-token is worse than a short one: the model is handed
  // syntactically broken JSON and has no way to tell it was truncated.
  let parses = false
  try { JSON.parse(persisted[0] ?? ''); parses = true } catch { parses = false }
  check('the persisted slice is still well-formed JSON', parses,
    parses ? 'parses' : `ends: ${JSON.stringify((persisted[0] ?? '').slice(-60))} — cut mid-token`)

  if (!process.env.KEEP_FIXTURE) await purge()
  await prisma.$disconnect()
}

report('L12 memory budget')
