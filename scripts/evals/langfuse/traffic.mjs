#!/usr/bin/env node
/**
 * Production-shaped traffic against the agents service, so Langfuse has
 * something real to analyse.
 *
 * This is not a load test and not an eval. It exists because an observability
 * setup you have never looked at real traffic through is a guess: you cannot
 * tell which surfaces are slow, which are expensive, or which fail, from an
 * empty dashboard. It drives every LLM surface the product has — document
 * extraction, the in-editor AI Assistant, and the Chat Agent — with text from
 * the LOCAL CORPUS, grouped into sessions that look like real user journeys.
 *
 *   node scripts/evals/langfuse/traffic.mjs --corpus corpus.json --journeys 8
 *   node scripts/evals/langfuse/traffic.mjs --dry-run          # print the plan
 *
 * Journeys, not isolated calls, because Langfuse's Sessions view is how people
 * actually review production: one contract being taken through intake →
 * classification → obligations → compliance reads as a unit, and a slow step is
 * visible in the context of what the user was trying to do. A pile of unrelated
 * traces cannot show you that.
 *
 * Corpus: pass `--corpus <file>` with a JSON array of
 * `{id,title,type,counterpartyName,orgId,expiryDate,text}`. Generate one from
 * the local database (see README). Without it a small synthetic corpus is used,
 * so the script runs anywhere — but the analysis is only about YOUR data if you
 * feed it your data.
 *
 * THIS SPENDS REAL MODEL BUDGET. Every request is a live LLM call. Default is
 * deliberately small; --journeys raises it linearly.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

const AGENTS = process.env.AGENTS_BASE ?? 'http://localhost:8003'
const SECRET = process.env.INTERNAL_SERVICE_SECRET ?? ''

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const dryRun      = process.argv.includes('--dry-run')
const journeyCount = Number(arg('journeys', '6'))
const concurrency  = Number(arg('concurrency', '3'))
const runLabel     = arg('run', `traffic-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`)
const corpusPath   = arg('corpus', null)

// ─── Corpus ──────────────────────────────────────────────────────────────────

const SYNTHETIC = [{
  id: 'syn-1', title: 'Northwind — Mutual NDA', type: 'NDA', counterpartyName: 'Northwind Systems',
  orgId: null, expiryDate: '2027-03-14',
  text: 'MUTUAL NON-DISCLOSURE AGREEMENT. This Agreement is entered into by Northwind Systems Inc. and Calder Analytics Ltd. The receiving party shall hold all Confidential Information in strict confidence for three (3) years and shall not disclose it to any third party. Each party shall return or destroy Confidential Information within thirty (30) days of written request. Governing law: Delaware.',
}, {
  id: 'syn-2', title: 'Helio Cloud — MSA', type: 'MSA', counterpartyName: 'Helio Cloud',
  orgId: null, expiryDate: '2027-01-01',
  text: 'MASTER SERVICES AGREEMENT. Provider shall perform services described in Statements of Work. Customer shall pay each invoice within thirty (30) days. The initial term is twelve (12) months and renews automatically unless either party gives sixty (60) days written notice. Provider shall notify Customer of any Security Incident within seventy-two (72) hours. Liability is capped at fees paid in the preceding twelve months.',
}]

const corpus = corpusPath ? JSON.parse(fs.readFileSync(corpusPath, 'utf8')) : SYNTHETIC
if (!Array.isArray(corpus) || !corpus.length) throw new Error(`corpus at ${corpusPath} is empty`)
const pick = (i) => corpus[i % corpus.length]

// Simulated operators. Chat carries user_id natively, which is what makes the
// per-user breakdowns in Langfuse mean anything.
const USERS = ['ana.mensah', 'ravi.iyer', 'jo.okafor', 'mika.laine']

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function call(path, body, { sessionId, timeoutMs = 180_000 }) {
  const started = Date.now()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${AGENTS}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': SECRET,
        'x-internal-service': 'traffic',
        // Correlation → becomes the Langfuse session for surfaces that have no
        // session of their own (apps/agents/app/tracing.py). Chat sends its own
        // session_id in the body, which takes precedence — by design.
        'x-eval-session-id': sessionId,
        'x-eval-run': runLabel,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, ms: Date.now() - started, bytes: text.length, body: text.slice(0, 400) }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, bytes: 0, body: `${e.name}: ${e.message}` }
  } finally {
    clearTimeout(t)
  }
}

/** Chat is SSE — drain it and count the frames rather than parsing every token. */
async function chat(message, { sessionId, orgId, userId, agentMode = true, timeoutMs = 200_000 }) {
  const started = Date.now()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${AGENTS}/agent/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': SECRET,
        'x-internal-service': 'traffic',
        'x-eval-run': runLabel,
      },
      body: JSON.stringify({
        message, session_id: sessionId, org_id: orgId, user_id: userId, agent_mode: agentMode,
      }),
      signal: controller.signal,
    })
    const text = await res.text()
    const tools = [...text.matchAll(/"type":\s*"tool_call_start"[^}]*"name":\s*"([^"]+)"/g)].map((m) => m[1])
    return { ok: res.ok, status: res.status, ms: Date.now() - started, bytes: text.length, tools, body: text.slice(-300) }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, bytes: 0, tools: [], body: `${e.name}: ${e.message}` }
  } finally {
    clearTimeout(t)
  }
}

// ─── Journeys ────────────────────────────────────────────────────────────────
//
// Each returns a list of {label, run} steps sharing one session id.

function intakeJourney(n) {
  const c = pick(n)
  const s = `traffic-intake-${n}-${randomUUID().slice(0, 6)}`
  const org = c.orgId ?? undefined
  return {
    name: `intake:${c.type}`, sessionId: s, family: 'extraction',
    steps: [
      { label: 'intake.classify', run: () => call('/intake-classify', {
        title: c.title, description: `New ${c.type} with ${c.counterpartyName ?? 'counterparty'} for review and signature.`,
        counterpartyName: c.counterpartyName, orgId: org }, { sessionId: s }) },
      { label: 'classify.detect', run: () => call('/classify', { plainText: c.text, orgId: org }, { sessionId: s }) },
      { label: 'obligations.extract', run: () => call('/extract_obligations', {
        plainText: c.text, contractType: c.type ?? 'general commercial', effectiveDate: '2026-01-01', orgId: org }, { sessionId: s }) },
      { label: 'compliance.check', run: () => call('/check_compliance', {
        plainText: c.text, contractType: c.type ?? 'general commercial', frameworks: ['GDPR', 'SOC2'], orgId: org }, { sessionId: s }) },
    ],
  }
}

function assistantJourney(n) {
  const c = pick(n + 1)
  const s = `traffic-assist-${n}-${randomUUID().slice(0, 6)}`
  const org = c.orgId ?? undefined
  // A clause-sized slice, which is what the editor actually sends.
  const clause = c.text.slice(0, 700)
  return {
    name: `assistant:${c.type}`, sessionId: s, family: 'assistant',
    steps: [
      { label: 'assist.classify_clause', run: () => call('/classify_clause', {
        clauseText: clause, contractType: c.type ?? 'general commercial', orgId: org }, { sessionId: s }) },
      { label: 'assist.rewrite', run: () => call('/assist', {
        selected_text: clause, action: 'rewrite', contract_type: c.type ?? 'general commercial', orgId: org }, { sessionId: s }) },
      { label: 'assist.simplify', run: () => call('/assist', {
        selected_text: clause, action: 'simplify', contract_type: c.type ?? 'general commercial', orgId: org }, { sessionId: s }) },
      { label: 'assist.redline_propose', run: () => call('/redline_propose', {
        clauseText: clause, clauseType: 'liability', contractType: c.type ?? 'general commercial',
        instructions: 'Reduce our exposure without making it unacceptable to the counterparty.', orgId: org }, { sessionId: s }) },
      { label: 'assist.complete', run: () => call('/complete', {
        contextBefore: clause.slice(0, 400), contextAfter: '', contractType: c.type ?? 'general commercial', orgId: org }, { sessionId: s }) },
    ],
  }
}

function chatJourney(n) {
  const c = pick(n + 2)
  const s = `traffic-chat-${n}-${randomUUID().slice(0, 6)}`
  const user = USERS[n % USERS.length]
  const org = c.orgId
  // Multi-turn and stateful on purpose: turn 3 refers back to turn 2, which is
  // where session memory either works or quietly does not.
  return {
    name: 'chat:portfolio', sessionId: s, family: 'chat',
    steps: [
      { label: 'chat.turn1', run: () => chat('How many contracts are expiring in the next 90 days?', { sessionId: s, orgId: org, userId: user }) },
      { label: 'chat.turn2', run: () => chat(`Which of those involve ${c.counterpartyName ?? 'our largest counterparty'}?`, { sessionId: s, orgId: org, userId: user }) },
      { label: 'chat.turn3', run: () => chat('What should we do about the first one?', { sessionId: s, orgId: org, userId: user }) },
    ],
  }
}

function renewalJourney(n) {
  const c = pick(n + 3)
  const s = `traffic-renewal-${n}-${randomUUID().slice(0, 6)}`
  const user = USERS[(n + 1) % USERS.length]
  return {
    name: `renewal:${c.type}`, sessionId: s, family: 'extraction',
    steps: [
      { label: 'renewal.advice', run: () => call('/renewal_advice', {
        plainText: c.text, contractType: c.type ?? 'general commercial', counterparty: c.counterpartyName,
        expiryDate: c.expiryDate ?? '2026-12-31', orgId: c.orgId ?? undefined }, { sessionId: s }) },
      { label: 'chat.followup', run: () => chat(`Summarise the renewal risk for ${c.title}.`, { sessionId: s, orgId: c.orgId, userId: user }) },
    ],
  }
}

/**
 * The cases that make a dashboard worth opening.
 *
 * Traffic made only of well-formed happy paths produces a green dashboard that
 * proves nothing — you learn what your system does when nothing is wrong, which
 * you already knew. Each of these is a failure mode this product can really
 * have.
 */
function edgeJourney(n) {
  const c = pick(n)
  const s = `traffic-edge-${n}-${randomUUID().slice(0, 6)}`
  const user = USERS[(n + 2) % USERS.length]
  return {
    name: 'edge-cases', sessionId: s, family: 'edge',
    steps: [
      // Nothing to classify. Does it say so, or invent a type?
      { label: 'edge.empty_classify', run: () => call('/classify', { plainText: '   ' }, { sessionId: s }) },
      // Boilerplate with no duties in it. Does it invent an obligation?
      { label: 'edge.no_obligations', run: () => call('/extract_obligations', {
        plainText: 'GOVERNING LAW. This Agreement shall be governed by the laws of the State of Delaware. ENTIRE AGREEMENT. This Agreement supersedes all prior negotiations.',
        contractType: 'NDA', effectiveDate: '2026-03-14' }, { sessionId: s }) },
      // A contract that does not exist. A confident answer here is the most
      // damaging failure this product has.
      { label: 'edge.unknown_contract', run: () => chat(
        'What is the governing law of contract ZZZ-DOES-NOT-EXIST-9999?', { sessionId: s, orgId: c.orgId, userId: user }) },
      // The cheap-path check: does 'hi' cost a tool call?
      { label: 'edge.greeting', run: () => chat('hi', { sessionId: s, orgId: c.orgId, userId: user }) },
    ],
  }
}

/**
 * Questions that CANNOT be answered with one tool call.
 *
 * The traffic above produced at most one tool per turn and exercised two of
 * about thirty tools, so every trace had the same shape and the tracing was
 * never really tested. A single-tool trace cannot show you a chained lookup, a
 * tool that fails mid-turn, or a model that picks the second tool badly after
 * picking the first one well — which are the failures agents actually have.
 *
 * Each of these forces at least two calls: find something, then look inside it.
 */
function multiToolJourney(n) {
  const c = pick(n + 4)
  const s = `traffic-multi-${n}-${randomUUID().slice(0, 6)}`
  const user = USERS[(n + 3) % USERS.length]
  const party = c.counterpartyName ?? 'our largest counterparty'
  return {
    name: 'chat:multi-tool', sessionId: s, family: 'chat',
    steps: [
      // search → then read INSIDE the result
      { label: 'multi.find_then_read', run: () => chat(
        `Find our agreement with ${party} and tell me what it says about limitation of liability.`,
        { sessionId: s, orgId: c.orgId, userId: user }) },
      // history → then the renewal position for the same party
      { label: 'multi.history_then_renewal', run: () => chat(
        `What's our history with ${party}, and is anything with them expiring soon?`,
        { sessionId: s, orgId: c.orgId, userId: user }) },
      // Two NAMED contracts, so the comparison lands on documents that have
      // text. "our three largest MSAs" sends the agent at the highest-value
      // rows, and 294 of 421 contracts in this database have no version
      // attached — so that phrasing tests the seed data, not the agent.
      { label: 'multi.compare', run: () => chat(
        `Compare the ${c.counterpartyName ?? 'Acme'} agreement and the ${pick(n + 6).counterpartyName ?? 'Globex'} agreement ` +
        'on liability caps and termination rights.',
        { sessionId: s, orgId: c.orgId, userId: user }) },
    ],
  }
}

/**
 * A turn whose FIRST tool call fails. The interesting question is what the agent
 * does next — recover with a different lookup, or give up and guess. Nothing in
 * the happy-path traffic ever exercises that path.
 */
function recoveryJourney(n) {
  const c = pick(n + 5)
  const s = `traffic-recover-${n}-${randomUUID().slice(0, 6)}`
  const user = USERS[(n + 1) % USERS.length]
  return {
    name: 'chat:recovery', sessionId: s, family: 'edge',
    steps: [
      { label: 'recover.bad_id_then_search', run: () => chat(
        `Tell me the liability cap in contract cm-not-a-real-id-000. If you can't find it, search for ${c.counterpartyName ?? 'Acme'} instead.`,
        { sessionId: s, orgId: c.orgId, userId: user }) },
      { label: 'recover.ambiguous', run: () => chat(
        'Show me the one about data protection.',
        { sessionId: s, orgId: c.orgId, userId: user }) },
    ],
  }
}

const BUILDERS = [intakeJourney, assistantJourney, chatJourney, renewalJourney, multiToolJourney, recoveryJourney]
const journeys = []
for (let i = 0; i < journeyCount; i++) journeys.push(BUILDERS[i % BUILDERS.length](i))
journeys.push(edgeJourney(0))   // always exactly one — it is a probe, not a load

// --only multi,recovery → run just those. For iterating on one journey shape
// without paying for the whole mix.
const only = arg('only', null)
const selected = only
  ? journeys.filter((j) => only.split(',').some((k) => j.name.includes(k.trim())))
  : journeys
if (!selected.length) { console.error(`\n✗ --only ${only} matched no journey\n`); process.exit(1) }
journeys.length = 0
journeys.push(...selected)

const totalSteps = journeys.reduce((n, j) => n + j.steps.length, 0)

console.log(`\ntraffic run "${runLabel}"`)
console.log(`  agents:   ${AGENTS}`)
console.log(`  corpus:   ${corpusPath ?? 'built-in synthetic'} (${corpus.length} contracts)`)
console.log(`  journeys: ${journeys.length}  ·  LLM calls: ~${totalSteps}  ·  concurrency ${concurrency}\n`)
for (const j of journeys) console.log(`  ${j.family.padEnd(10)} ${j.name.padEnd(24)} ${j.steps.length} steps  session=${j.sessionId}`)

if (dryRun) { console.log('\n[dry-run] nothing sent\n'); process.exit(0) }
if (!SECRET) { console.error('\n✗ INTERNAL_SERVICE_SECRET is not set — the agents service will 401 every request.\n'); process.exit(1) }

console.log('\nrunning (real model calls — this costs money and takes minutes)…\n')

const results = []
async function runJourney(j) {
  for (const step of j.steps) {
    const r = await step.run()
    results.push({ journey: j.name, family: j.family, session: j.sessionId, label: step.label, ...r })
    const mark = r.ok ? '·' : '✗'
    const extra = r.tools?.length ? ` tools=[${r.tools.join(',')}]` : ''
    console.log(`  ${mark} ${step.label.padEnd(26)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms${extra}`)
    if (!r.ok) console.log(`      ${r.body.slice(0, 200)}`)
  }
}

let idx = 0
await Promise.all(Array.from({ length: Math.min(concurrency, journeys.length) }, async () => {
  for (;;) {
    const i = idx++
    if (i >= journeys.length) return
    await runJourney(journeys[i])
  }
}))

// ─── Summary ─────────────────────────────────────────────────────────────────

const ok = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)
const lat = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b)
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0)

console.log(`\n  ${ok}/${results.length} calls succeeded`)
console.log(`  latency  p50 ${pct(0.5)}ms   p95 ${pct(0.95)}ms   max ${lat.at(-1) ?? 0}ms`)

const byFamily = new Map()
for (const r of results) {
  const a = byFamily.get(r.family) ?? { n: 0, ok: 0, ms: 0 }
  a.n++; if (r.ok) { a.ok++; a.ms += r.ms }
  byFamily.set(r.family, a)
}
// Tool coverage. A trace that only ever calls one tool cannot show you a chained
// lookup or a bad second choice, so "how many tools, how often more than one" is
// the number that says whether this traffic exercised the agent or just pinged it.
const toolCalls = results.flatMap((r) => r.tools ?? [])
if (toolCalls.length) {
  const perTurn = results.filter((r) => r.tools).map((r) => r.tools.length)
  const multi = perTurn.filter((n) => n > 1).length
  const byTool = new Map()
  for (const name of toolCalls) byTool.set(name, (byTool.get(name) ?? 0) + 1)
  console.log(`\n  tool calls: ${toolCalls.length} across ${perTurn.length} chat turns` +
    `  ·  ${multi} turn(s) used more than one tool  ·  ${byTool.size} distinct tools`)
  for (const [name, n] of [...byTool].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name.padEnd(24)} ${n}`)
  }
}

console.log('\n  by surface family:')
for (const [f, a] of [...byFamily].sort()) {
  console.log(`    ${f.padEnd(12)} ${String(a.ok).padStart(2)}/${String(a.n).padEnd(3)} ok   avg ${a.ok ? Math.round(a.ms / a.ok) : 0}ms`)
}

if (failed.length) {
  console.log(`\n  ${failed.length} failed:`)
  for (const f of failed.slice(0, 12)) console.log(`    ${f.label.padEnd(26)} ${f.status} ${f.body.slice(0, 140)}`)
}

const sessions = [...new Set(results.map((r) => r.session))]
console.log(`\n  ${sessions.length} sessions written. Traces are ingested asynchronously — give it a few seconds.`)
console.log(`  Review: ${process.env.LANGFUSE_HOST ?? 'http://localhost:3100'} → Tracing → Sessions\n`)
