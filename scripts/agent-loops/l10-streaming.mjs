#!/usr/bin/env node
/**
 * L10 — the stream is fake, and the proxy corrupts what it carries.
 *
 * orchestrator.py passed streaming=False to resolve_llm, awaited the whole
 * answer with ainvoke, then split the finished string on ' ' and yielded one
 * `token` event per word WITH NO SLEEP. The in-code admission was verbatim:
 * "Word-by-word 'stream' to match the existing UX. Real token streaming lands
 * when we add .astream_events() in a follow-up." Because there was no sleep
 * between yields, the typewriter was a single burst -- the fake-streaming code
 * bought nothing at all over sending one frame. routes/assist.py already had a
 * real llm.astream; the agent chat path just didn't use it.
 *
 * Two transport defects sat on top.
 *
 * agents.ts called `decoder.decode(value)` WITHOUT { stream: true }, while a
 * different handler in the same file got it right and both web clients pass
 * the flag -- an isolated omission, not house style. With 20 000-char tool
 * payloads, frames routinely span TCP segments, and any chunk boundary landing
 * inside a UTF-8 sequence produced U+FFFD in place of an em-dash, curly quote,
 * ellipsis, bullet or currency symbol. Contract text is dense with all five.
 * It is intermittent and load-dependent, so it reads as a model quality
 * problem rather than a proxy bug.
 *
 * And the proxy dropped the X-Accel-Buffering: no header Python set, so behind
 * nginx or an ALB the whole SSE response can be buffered into one write.
 *
 * Run BEFORE: every token frame arrives in one burst after a long silence; a
 *             multibyte-dense payload comes back through the proxy carrying
 *             U+FFFD; X-Accel-Buffering is absent.
 * Run AFTER:  tokens spread across the generation window, bytes survive the
 *             proxy intact, and the buffering hint is forwarded.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { login, db, check, report, section, API } from '../week-zero/lib/harness.mjs'

const REPO = '/Users/temp/Documents/Code/draft-legal'
const prisma = db()
const admin  = await login()
const orgId  = admin.user.orgId
const userId = admin.user.id

const TITLE = 'L10 streaming probe'

// Every one of these is a character contract text is full of, and every one is
// multi-byte in UTF-8 -- so each is a chance for a chunk boundary to land mid
// sequence.
const MULTIBYTE = '— … • “ ” ‘ ’ € £ ¥ § ¶ ± × ÷ → ≤ ≥ ≠'

async function purge() {
  const stale = await prisma.contract.findMany({ where: { orgId, title: TITLE }, select: { id: true } })
  if (!stale.length) return
  const ids = stale.map(c => c.id)
  await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
  const vs = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
  await prisma.contractClause.deleteMany({ where: { versionId: { in: vs.map(v => v.id) } } }).catch(() => {})
  await prisma.contractVersion.deleteMany({ where: { id: { in: vs.map(v => v.id) } } })
  await prisma.contract.deleteMany({ where: { id: { in: ids } } })
}

await purge()

// Pack the body with multibyte characters so a large clause_search result is
// dense with them, then vary the padding so the payload length -- and
// therefore where the chunk boundaries fall -- differs run to run.
const block = (i) => `${'pad '.repeat(60 + i * 7)} ${MULTIBYTE} Service Credit ${MULTIBYTE} clause ${i}`
const plainText = Array.from({ length: 8 }, (_, i) => block(i)).join('\n\n')

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
    htmlContent: `<p>${plainText}</p>`, plainText, createdById: userId,
  },
  select: { id: true },
})
await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })

/**
 * Drive one turn through the NODE PROXY and record when each frame arrived.
 * Reading raw bytes rather than res.text() is the point: the corruption this
 * check is about happens in the proxy's decode, so the check has to observe
 * what actually came over the wire.
 */
async function stream(message, { raw = false } = {}) {
  const t0 = Date.now()
  const res = await fetch(`${API}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.accessToken}` },
    body: JSON.stringify({
      message, agentMode: true, sessionId: `l10-probe-${Date.now()}-${Math.round(t0 % 1e6)}`,
      pageContext: { type: 'contract', id: contract.id, label: TITLE },
    }),
  })

  const chunks = []
  const events = []
  let buf = ''
  const decoder = new TextDecoder('utf-8')
  const reader = res.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    // Decode INCREMENTALLY here -- correctly, with { stream: true } -- so that
    // any U+FFFD found below came from the server, not from this reader.
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        try { events.push({ at: Date.now() - t0, frame: JSON.parse(line.slice(5).trim()) }) } catch { /* skip */ }
      }
    }
  }
  buf += decoder.decode()
  const body = Buffer.concat(chunks)
  return {
    status:  res.status,
    headers: res.headers,
    events,
    text:    body.toString('utf8'),
    bytes:   body,
    totalMs: Date.now() - t0,
    _raw:    raw,
  }
}

// ─── 1. The stream is real ──────────────────────────────────────────────────

section('1. Tokens arrive as they are generated')
{
  // Ask for a long enough answer that generation time dominates. A three
  // sentence reply finishes inside a couple of provider chunks, and the
  // measurement then turns on chunk granularity rather than on whether we
  // stream at all. The discriminator is unaffected either way: before the fix
  // even a long answer arrived in an 8 ms burst.
  const r = await stream(
    'In about 150 words, explain what a limitation of liability clause does, why it matters, and how it interacts with indemnities.')
  const tokens = r.events.filter(e => e.frame.type === 'token')
  const done   = r.events.find(e => e.frame.type === 'done')

  check('the turn produced token frames', tokens.length >= 3,
    `${tokens.length} token frames in ${r.totalMs} ms`)

  if (tokens.length >= 3) {
    const first  = tokens[0].at
    const last   = tokens[tokens.length - 1].at
    const spread = last - first
    const total  = done?.at ?? r.totalMs

    // BEFORE: the whole answer was computed, THEN split on spaces and yielded
    // with no sleep -- so every token frame landed within a few ms of the
    // others, after a multi-second silence. Measured: 8 ms of spread at the
    // end of a 1747 ms turn.
    check('token arrivals are spread across the generation window, not one burst',
      spread > 250,
      `first token at ${first} ms, last at ${last} ms (spread ${spread} ms) of ${total} ms total — a burst means the answer was fully computed before the first frame was sent`)

    // NOT asserted: a time-to-first-token RATIO. On a reasoning-tier model
    // most of the wall clock is the model thinking before it emits anything,
    // which is provider-side and varies by an order of magnitude between
    // providers -- a ratio threshold would measure the model, not this code.
    // What IS ours is whether the answer is delivered in pieces, so assert
    // that directly: no single frame may carry substantially all of it.
    const totalChars = tokens.reduce((n, t) => n + (t.frame.delta ?? '').length, 0)
    const biggest    = Math.max(...tokens.map(t => (t.frame.delta ?? '').length))
    check('no single frame carries the whole answer',
      totalChars > 0 && biggest / totalChars < 0.8,
      `largest frame is ${biggest} of ${totalChars} chars (${Math.round((biggest / totalChars) * 100)}%) — one frame with everything is what "streaming" meant before`)
  }

  // Real streaming that drops the last chunk is worse than fake streaming.
  // The persisted assistant turn is the independent record of what the model
  // actually said, so compare the two.
  const streamed = tokens.map(t => t.frame.delta ?? '').join('')
  const sid = r.events.find(e => e.frame.session_id)?.frame.session_id
  let persisted = null
  if (sid) {
    const py = `
import asyncio, json
from app.memory import get_session_history
print("<<<R>>>" + json.dumps(asyncio.run(get_session_history(${JSON.stringify(sid)}))))
`
    try {
      const out = execFileSync(`${REPO}/apps/agents/.venv/bin/python`, ['-c', py],
        { cwd: `${REPO}/apps/agents`, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
      const hist = JSON.parse(out.split('<<<R>>>')[1])
      persisted = hist.filter(m => m.role === 'assistant').map(m => m.content).join('')
    } catch { /* asserted below */ }
  }
  check('every streamed token made it into the persisted answer',
    persisted != null && streamed.length > 0 && persisted.trim() === streamed.trim(),
    persisted == null
      ? 'could not read the session back'
      : `streamed ${streamed.length} chars, persisted ${persisted.length} — a mismatch means a dropped or duplicated chunk`)
}

// ─── 2. Bytes survive the proxy ─────────────────────────────────────────────
//
// The bug is boundary-dependent, so one payload size proves nothing. Sweep.

section('2. The proxy carries its payload without corrupting it')
{
  // MEASURED CORRECTION to the plan, 2026-08-08. The plan asserted users are
  // seeing U+FFFD in place of em-dashes today. They are not, and cannot be on
  // this path: chat.py serialises every SSE frame with `json.dumps(event)`,
  // whose ensure_ascii defaults to True, so an em-dash crosses the wire as the
  // seven ASCII bytes —. Measured on a response built from a contract
  // packed with em-dashes, curly quotes, ellipses, bullets and currency
  // symbols: 2 546 bytes, ZERO of them above 0x7F.
  //
  // So the missing { stream: true } was a LATENT trap, not an active defect —
  // real, and worth removing, but it was corrupting nothing. It arms itself
  // the moment any frame carries raw UTF-8: ensure_ascii being turned off for
  // payload size, a non-JSON frame type, or a future direct passthrough of
  // document text. Fixing it costs nothing (forwarding bytes is cheaper than
  // decoding them) and the sweep below stays as the regression guard.
  //
  // The assertion is deliberately NOT "an em-dash survives": on an all-ASCII
  // wire that assertion can never fail and would be theatre.
  const results = []
  for (const limit of [3, 5, 8]) {
    const r = await stream(
      `Call clause_search on contract ${contract.id} with query "Service Credit" and limit ${limit}, then quote the matches back to me exactly.`)
    const bad     = (r.text.match(/�/g) ?? []).length
    const highBit = [...r.bytes].filter(b => b > 0x7f).length
    const tool    = r.events.some(e => e.frame.type === 'tool_call_result' && e.frame.name === 'clause_search')
    const prose   = r.events.filter(e => e.frame.type === 'token')
                     .map(e => e.frame.delta ?? '').join('').trim().length
    results.push({ limit, bad, highBit, bytes: r.bytes.length, tool, prose })
  }

  // Tool-call assembly is the thing most at risk from the switch to astream:
  // tool_call fragments arrive split across chunks and only the MERGED
  // AIMessageChunk carries usable .tool_calls. Get the accumulation wrong and
  // the turn either calls nothing or loops without ever answering.
  const withTool = results.filter(x => x.tool)
  check('a tool-using turn still runs its tool and still ends in prose',
    withTool.length > 0 && withTool.every(x => x.prose > 0),
    withTool.length === 0
      ? 'no run called a tool — assembly untested'
      : `${withTool.length} tool-using runs, prose lengths ${withTool.map(x => x.prose).join('/')} chars`)

  check('the sweep carried multi-chunk payloads',
    results.some(x => x.tool) && results.some(x => x.bytes > 2000),
    `sizes: ${results.map(x => `${x.limit}→${x.bytes}B${x.tool ? '' : ' (no tool)'}`).join(', ')}`)

  const corrupted = results.filter(x => x.bad > 0)
  check('no U+FFFD anywhere in the swept responses', corrupted.length === 0,
    corrupted.length
      ? `corrupt at limits ${corrupted.map(x => `${x.limit} (${x.bad} chars)`).join(', ')} — a multi-byte sequence straddled a chunk boundary and the proxy decoded each chunk independently`
      : `${results.length} sizes clean, largest ${Math.max(...results.map(x => x.bytes))} B`)

  // Record the encoding fact the correction above rests on, so that if the
  // wire format ever stops being ASCII this check reports it rather than
  // silently continuing to assert something that no longer holds.
  const anyHighBit = results.some(x => x.highBit > 0)
  check('the SSE wire format is still all-ASCII (json.dumps ensure_ascii)',
    !anyHighBit,
    anyHighBit
      ? `raw UTF-8 now crosses the proxy (${results.map(x => x.highBit).join('/')} high-bit bytes) — the latent decode trap is now LIVE; re-read this section`
      : 'all frames ASCII-escaped, so the decode omission was latent rather than active')
}

// ─── 3. The buffering hint survives ─────────────────────────────────────────

section('3. X-Accel-Buffering is forwarded')
{
  const r = await stream('Say OK.')
  check('the proxy forwards X-Accel-Buffering: no',
    (r.headers.get('x-accel-buffering') ?? '').toLowerCase() === 'no',
    `got ${JSON.stringify(r.headers.get('x-accel-buffering'))} — Python sets it and the proxy dropped it, so behind nginx or an ALB the whole response can be buffered into one write and the chips and answer land together`)
}

// ─── 4. The mechanism, pinned ───────────────────────────────────────────────

section('4. Neither defect can come back quietly')
{
  const agentsTs = fs.readFileSync(`${REPO}/apps/api/src/routes/agents.ts`, 'utf8')
  const orch     = fs.readFileSync(`${REPO}/apps/agents/app/orchestrator.py`, 'utf8')

  // Strip comments before scanning for code. The first version of the check
  // below went red against the FIXED file, because the comment explaining the
  // fix quotes the broken call verbatim. Matching prose instead of behaviour
  // is the single most common way these checks go wrong; the fix is to look
  // only at code.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const agentsCode = stripComments(agentsTs)
  const orchCode   = orch.replace(/^\s*#.*$/gm, '')

  // The proxy hop only forwards bytes. Decoding it at all is the bug class;
  // not decoding is both correct and faster than decoding correctly.
  //
  // Scanned file-wide on purpose. An earlier version of this check sliced from
  // indexOf('/agent/chat'), which matched a COMMENT 160 lines above the read
  // loop, so the slice ended before the defect and the assertion passed green
  // against unfixed code. The whole file is two handlers; a stream-less decode
  // is wrong in either.
  const badDecodes = [...agentsCode.matchAll(/decoder\.decode\(([^)]*)\)/g)]
    .filter(m => !/\bstream\s*:\s*true/.test(m[1]))
  check('no chunk is decoded without { stream: true }',
    badDecodes.length === 0,
    badDecodes.length
      ? `${badDecodes.length} bare decode(s): ${badDecodes.map(m => m[0]).join(', ')} — each splits multi-byte sequences at every chunk boundary`
      : 'none')
  check('the chat proxy writes the raw bytes through',
    /reply\.raw\.write\(Buffer\.from\(value\)\)/.test(agentsCode),
    'forwarding bytes cannot corrupt them')
  check('spend is still measured, from byteLength',
    /streamedChars \+= value\.byteLength/.test(agentsCode),
    'the cost cap reads this counter; dropping the decode must not drop the accounting')

  check('the agent path resolves a streaming client',
    /_tier, org_id=org_id, streaming=True/.test(orchCode),
    'streaming=False cannot produce incremental chunks however it is consumed')
  check('the terminal branch streams instead of splitting a finished string',
    /async for chunk in llm\.astream\(/.test(orchCode) && !/final_text\.split\(" "\)/.test(orchCode),
    'splitting a completed string on spaces is not streaming; with no sleep between yields it is one burst')
}

if (!process.env.KEEP_FIXTURE) await purge()
await prisma.$disconnect()
report('L10 streaming')
