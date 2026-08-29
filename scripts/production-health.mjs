#!/usr/bin/env node
/**
 * production-health.mjs — what the agent is actually doing in production.
 *
 * Stage 1 of the monitoring plan in docs/38: counters over data the product
 * ALREADY records. No judge, no labelling, no new instrumentation, no cost.
 * Every number here is a count of rows in `agent_threads`, `agent_messages`
 * and `tool_calls`.
 *
 * The point is not that these numbers are sufficient — they are not, and the
 * gaps are printed at the bottom rather than left implicit. The point is that
 * an offline eval suite tells you how the agent behaves on 152 asks someone
 * wrote, and this tells you how it behaves on everything real users sent. The
 * second is what the first exists to predict, and until now nothing read it.
 *
 * READ-ONLY. It issues no writes and takes no locks beyond a read.
 *
 *   node scripts/production-health.mjs
 *   node scripts/production-health.mjs --days 7
 *   node scripts/production-health.mjs --org <orgId> --json
 *
 * The two numbers to look at first:
 *
 *   declined          how often the agent said it could not find something.
 *                     The offline suite counts the same thing as a "shrug
 *                     pass" (scripts/persona-tests/lib-multi.mjs). If offline
 *                     shrugs are flat and this climbs, the eval corpus has
 *                     stopped resembling production.
 *
 *   confident-on-empty  a turn where every tool call came back with zero rows
 *                     and the agent answered anyway, without saying so. This
 *                     is the failure that reaches a customer's counsel: the
 *                     difference between reporting what the tool said and
 *                     reporting what the world is. Target is near zero.
 */
import { db } from './week-zero/lib/harness.mjs'
// The SAME decline detector the offline grader uses. Deliberately shared: if
// the two drifted apart, "offline shrug rate" and "production decline rate"
// would stop being comparable, and comparing them is the entire point.
import { GRACEFUL_EMPTY } from './persona-tests/lib-multi.mjs'

const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const DAYS = Number(arg('--days', '30'))
const ORG = arg('--org', null)
const AS_JSON = argv.includes('--json')

if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error('--days must be a positive number')
  process.exit(2)
}

const since = new Date(Date.now() - DAYS * 86_400_000)
const prisma = db()

// ── Shape helpers ───────────────────────────────────────────────────────────

/** AgentMessage.content is LangChain/Anthropic content blocks. */
function messageText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && typeof b === 'object' && typeof b.text === 'string')
    .map(b => b.text).join('\n').trim()
}

/**
 * How many rows did this tool call hand back?
 *
 * Tool output is stored as `{ preview: "<json string>" }`, so it needs one
 * parse before anything can be read out of it. Returns null when the shape is
 * not countable — null is NOT zero, and conflating them would report every
 * unparseable output as an empty result.
 */
function resultCounts(output) {
  let o = output
  if (o && typeof o === 'object' && typeof o.preview === 'string') {
    try { o = JSON.parse(o.preview) } catch { return { returned: null, matching: null } }
  }
  if (!o || typeof o !== 'object') return { returned: null, matching: null }

  let returned = null
  for (const k of ['results', 'hits', 'items', 'contracts', 'clauses', 'rows', 'matches', 'obligations']) {
    if (Array.isArray(o[k])) { returned = o[k].length; break }
  }
  if (returned === null && typeof o.total === 'number') returned = o.total
  // `totalMatching` is what EXISTS; `total` is what came back. They differ
  // when the result set was truncated, and the agent only ever sees the
  // second — which is how a confident answer gets built on a partial set.
  const matching = typeof o.totalMatching === 'number' ? o.totalMatching : null
  return { returned, matching }
}

const median = xs => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'in', 'on', 'to', 'is', 'are', 'what', 'which',
  'show', 'me', 'my', 'our', 'all', 'and', 'or', 'with', 'do', 'we', 'have', 'any', 'that', 'this'])
const words = s => new Set(s.toLowerCase().match(/[a-z0-9$%.]+/g)?.filter(w => !STOP.has(w)) ?? [])
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const w of a) if (b.has(w)) hit++
  return hit / (a.size + b.size - hit)
}

// ── Pull ────────────────────────────────────────────────────────────────────

const threads = await prisma.agentThread.findMany({
  where: { createdAt: { gte: since }, ...(ORG ? { orgId: ORG } : {}) },
  select: {
    id: true, orgId: true, createdAt: true,
    messages: {
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, role: true, content: true, createdAt: true,
        provider: true, model: true, inputTokens: true, outputTokens: true,
        costUsd: true, isByok: true,
      },
    },
    toolCalls: {
      select: {
        id: true, messageId: true, toolName: true, status: true,
        output: true, error: true, latencyMs: true, dryRun: true, createdAt: true,
      },
    },
  },
})

// ── Fold ────────────────────────────────────────────────────────────────────

const tools = new Map()   // toolName → counters
const perThreadTurns = []
let assistantTurns = 0, declined = 0, emptyTurns = 0
let confidentOnEmpty = 0
const confidentOnEmptySamples = []
let reformulations = 0, userAsks = 0
let truncated = 0
let costUsd = 0, byokCalls = 0, attributed = 0, costed = 0
const models = new Map()
const latencies = []

for (const t of threads) {
  const callsByMessage = new Map()
  for (const c of t.toolCalls) {
    if (!callsByMessage.has(c.messageId)) callsByMessage.set(c.messageId, [])
    callsByMessage.get(c.messageId).push(c)

    const row = tools.get(c.toolName) ?? { calls: 0, errors: 0, empty: 0, countable: 0, lat: [] }
    row.calls++
    if (c.status === 'error' || c.error) row.errors++
    const { returned, matching } = resultCounts(c.output)
    if (returned !== null) {
      row.countable++
      if (returned === 0) row.empty++
      if (matching !== null && matching > returned) truncated++
    }
    if (typeof c.latencyMs === 'number') { row.lat.push(c.latencyMs); latencies.push(c.latencyMs) }
    tools.set(c.toolName, row)
  }

  // Segment the thread into turns: one user ask plus every assistant message
  // and tool call that follows it, up to the next user ask. A turn is the unit
  // a user experiences; a message is not.
  const turns = []
  let current = null
  for (const m of t.messages) {
    if (m.role === 'user') {
      if (current) turns.push(current)
      current = { ask: messageText(m.content), assistants: [], calls: [] }
      userAsks++
      continue
    }
    if (!current) continue
    if (m.role === 'assistant') {
      current.assistants.push(m)
      current.calls.push(...(callsByMessage.get(m.id) ?? []))
      if (m.provider || m.model) {
        const key = `${m.provider ?? '?'}/${m.model ?? '?'}`
        models.set(key, (models.get(key) ?? 0) + 1)
        attributed++
      }
      if (m.costUsd != null) { costUsd += Number(m.costUsd); costed++ }
      if (m.isByok) byokCalls++
    }
  }
  if (current) turns.push(current)
  perThreadTurns.push(turns.length)

  // Reformulation: two consecutive asks in one thread that are near-duplicates.
  // The user restating the same question IS the failure signal, and it costs
  // nothing to read.
  for (let i = 1; i < turns.length; i++) {
    if (jaccard(words(turns[i - 1].ask), words(turns[i].ask)) >= 0.6) reformulations++
  }

  for (const turn of turns) {
    if (!turn.assistants.length) continue
    assistantTurns++
    const text = turn.assistants.map(m => messageText(m.content)).join('\n').trim()
    if (!text) { emptyTurns++; continue }

    const isDecline = GRACEFUL_EMPTY.test(text)
    if (isDecline) declined++

    // Confident assertion on an empty result (plan 12.11C). Only counted when
    // at least one call was COUNTABLE and every countable call returned zero —
    // an unparseable output must not masquerade as an empty one.
    const counted = turn.calls
      .map(c => resultCounts(c.output).returned)
      .filter(n => n !== null)
    if (counted.length > 0 && counted.every(n => n === 0) && !isDecline) {
      confidentOnEmpty++
      if (confidentOnEmptySamples.length < 5) {
        confidentOnEmptySamples.push({
          threadId: t.id,
          ask: turn.ask.slice(0, 100),
          tools: turn.calls.map(c => c.toolName),
          reply: text.slice(0, 160),
        })
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—')
const turnCounts = perThreadTurns.filter(n => n > 0)

const summary = {
  window: { days: DAYS, since: since.toISOString(), org: ORG ?? 'all' },
  volume: {
    threads: threads.length,
    threadsWithATurn: turnCounts.length,
    userAsks,
    assistantTurns,
    toolCalls: [...tools.values()].reduce((s, r) => s + r.calls, 0),
  },
  answering: {
    declined, declinedRate: pct(declined, assistantTurns),
    emptyTurns, emptyTurnRate: pct(emptyTurns, assistantTurns),
    confidentOnEmpty, confidentOnEmptyRate: pct(confidentOnEmpty, assistantTurns),
  },
  effort: {
    turnsPerThread: turnCounts.length
      ? { min: Math.min(...turnCounts), median: median(turnCounts), max: Math.max(...turnCounts) }
      : null,
    reformulations, reformulationRate: pct(reformulations, userAsks),
  },
  retrieval: { truncatedResultSets: truncated },
  cost: {
    totalUsd: Number(costUsd.toFixed(4)),
    // Coverage, not just the total. AgentMessage.provider/model/costUsd are
    // nullable and written by only some paths, so an unqualified "$0" reads as
    // "free" when it means "not recorded". The plan (15.0) requires
    // model_version on every graded row; you cannot stamp what nobody writes.
    turnsWithCost: costed, turnsWithModel: attributed, turnsTotal: assistantTurns,
    byokTurns: byokCalls,
    models: Object.fromEntries([...models].sort((a, b) => b[1] - a[1])),
  },
  toolLatencyMs: latencies.length
    ? { n: latencies.length, min: Math.min(...latencies), median: median(latencies), max: Math.max(...latencies) }
    : null,
  tools: Object.fromEntries([...tools].sort((a, b) => b[1].calls - a[1].calls).map(([name, r]) => [name, {
    calls: r.calls,
    errors: r.errors, errorRate: pct(r.errors, r.calls),
    emptyResults: r.empty, emptyRate: pct(r.empty, r.countable),
    countableOutputs: r.countable,
    medianLatencyMs: median(r.lat),
  }])),
  confidentOnEmptySamples,
}

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2))
  await prisma.$disconnect()
  process.exit(0)
}

const bar = '─'.repeat(72)
console.log(`\nAgent production health — last ${DAYS}d${ORG ? ` · org ${ORG}` : ''}`)
console.log(bar)
console.log(`  threads ${summary.volume.threads}   user asks ${userAsks}   answered turns ${assistantTurns}   tool calls ${summary.volume.toolCalls}`)

if (assistantTurns === 0) {
  console.log('\n  No answered turns in this window — nothing to report.')
  console.log('  Widen with --days, or check that the window covers real traffic.\n')
  await prisma.$disconnect()
  process.exit(0)
}

console.log(`\nAnswering`)
console.log(`  declined ("couldn't find that")        ${declined}/${assistantTurns}  ${pct(declined, assistantTurns)}`)
console.log(`  empty turns (no text at all)           ${emptyTurns}/${assistantTurns}  ${pct(emptyTurns, assistantTurns)}`)
console.log(`  CONFIDENT ON AN EMPTY RESULT           ${confidentOnEmpty}/${assistantTurns}  ${pct(confidentOnEmpty, assistantTurns)}   ← target ~0`)

console.log(`\nEffort`)
if (summary.effort.turnsPerThread) {
  const { min, median: med, max } = summary.effort.turnsPerThread
  console.log(`  turns per conversation                 min ${min} · median ${med} · max ${max}`)
}
console.log(`  user restated the same question        ${reformulations}/${userAsks}  ${pct(reformulations, userAsks)}`)

console.log(`\nTools`)
const nameW = Math.max(20, ...[...tools.keys()].map(n => n.length))
console.log(`  ${'tool'.padEnd(nameW)}  calls  errors  empty-result  median ms`)
for (const [name, r] of [...tools].sort((a, b) => b[1].calls - a[1].calls)) {
  console.log(`  ${name.padEnd(nameW)}  ${String(r.calls).padStart(5)}  ${String(r.errors).padStart(6)}`
    + `  ${`${r.empty}/${r.countable}`.padStart(12)}  ${String(median(r.lat) ?? '—').padStart(9)}`)
}
if (truncated) console.log(`\n  ${truncated} call(s) returned fewer rows than matched — the agent saw a partial set.`)

console.log(`\nCost and attribution`)
console.log(`  $${summary.cost.totalUsd} recorded   BYOK turns ${byokCalls}`)
console.log(`  turns carrying a cost   ${costed}/${assistantTurns}  ${pct(costed, assistantTurns)}`)
console.log(`  turns naming a model    ${attributed}/${assistantTurns}  ${pct(attributed, assistantTurns)}`)
for (const [m, n] of [...models].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${m}`)
if (attributed < assistantTurns) {
  console.log(`  NOTE: ${assistantTurns - attributed} turn(s) record no model. The cost line is a`)
  console.log(`        floor, not a total, and those turns cannot be attributed to a model version.`)
}

if (confidentOnEmptySamples.length) {
  console.log(`\nConfident-on-empty samples (read these first)`)
  for (const s of confidentOnEmptySamples) {
    console.log(`\n  thread ${s.threadId}  [${s.tools.join(', ')}]`)
    console.log(`    asked: ${s.ask}`)
    console.log(`    said:  ${s.reply.replace(/\s+/g, ' ')}`)
  }
}

// Stating the blind spots next to the numbers, because a dashboard that omits
// them gets read as a full picture. Each line is a real gap, not a caveat.
console.log(`\n${bar}`)
console.log(`Not measured here — do not read the above as "quality is fine":`)
console.log(`  · whether an answer was CORRECT. Nothing above reads the answer against a source.`)
console.log(`  · per-turn latency. Only tool-call latency is stored, on ${latencies.length} of ${summary.volume.toolCalls} calls.`)
console.log(`  · under-retrieval. "empty-result" catches zero rows, not "returned 3 of the 15 that qualify".`)
console.log(`  · whether the user was satisfied. No edit-before-accept or escalation signal is recorded yet.`)
console.log(bar + '\n')

await prisma.$disconnect()
