#!/usr/bin/env node
/**
 * Session-level evaluation — grade the CONVERSATION, not the turn.
 *
 *   node scripts/evals/langfuse/score-sessions.mjs --hours 6
 *   node scripts/evals/langfuse/score-sessions.mjs --hours 24 --min-turns 3 --dry-run
 *
 * Every other scorer here reads one turn in isolation. That misses the failure
 * mode people actually complain about in a chat product: each answer is fine on
 * its own, and the conversation still goes wrong — it forgets which contract you
 * were discussing, re-asks for something you already told it, or contradicts
 * what it said two turns ago. No per-turn score can see any of that, because
 * each turn is individually defensible.
 *
 * Scores anchor to the SESSION (Langfuse accepts sessionId as an anchor in
 * place of a trace id), so the result lands on the conversation rather than on
 * an arbitrary turn inside it.
 *
 * Only multi-turn sessions are graded. Asking "did it maintain context?" of a
 * one-turn conversation produces a meaningless 1 that dilutes the metric.
 */
import { requireConfig, listTraces, postScore, LANGFUSE_HOST } from './lf.mjs'
import { runScorer, judgeAvailable } from './scorers.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const hours    = Number(arg('hours', '6'))
const minTurns = Number(arg('min-turns', '2'))
const limit    = Number(arg('limit', '15'))
const dryRun   = process.argv.includes('--dry-run')

if (!judgeAvailable()) {
  console.error('\n✗ no judge key. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_API_KEY.\n')
  process.exit(1)
}

async function getTrace(id) {
  const res = await fetch(`${cfg.host.replace(/\/$/, '')}/api/public/traces/${id}`, { headers: { Authorization: auth } })
  return res.ok ? res.json() : null
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

function userRequest(trace) {
  const inp = trace.input
  if (Array.isArray(inp)) {
    const users = inp.filter((m) => m?.role === 'user')
    const last = users.at(-1)?.content
    if (last) return asText(last)
  }
  return asText(inp)
}

function assistantAnswer(trace) {
  const obs = (trace.observations ?? []).filter((o) => o.type === 'GENERATION')
  const out = obs.at(-1)?.output ?? trace.output
  const text = asText(out)
  try {
    const parsed = text.trim().startsWith('{') ? JSON.parse(text) : null
    return parsed?.content ? String(parsed.content) : text
  } catch { return text }
}

// ── Group this window's traces into sessions ─────────────────────────────────
const since = Date.now() - hours * 3600_000
const traces = ((await listTraces({ limit: 100 }))?.data ?? [])
  .filter((t) => new Date(t.timestamp).getTime() >= since)
  .filter((t) => t.sessionId)

const bySession = new Map()
for (const t of traces) {
  const arr = bySession.get(t.sessionId) ?? []
  arr.push(t)
  bySession.set(t.sessionId, arr)
}

const multi = [...bySession.entries()]
  .map(([sessionId, ts]) => ({ sessionId, traces: ts.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)) }))
  .filter((s) => s.traces.length >= minTurns)
  .slice(0, limit)

console.log(`\nsession-level scoring — last ${hours}h`)
console.log(`  ${bySession.size} sessions, ${multi.length} with >= ${minTurns} turns\n`)

if (!multi.length) {
  console.log('  No multi-turn sessions in range. Nothing session-level to say.\n')
  process.exit(0)
}

if (dryRun) {
  for (const s of multi) console.log(`  [dry-run] ${s.sessionId.padEnd(34)} ${s.traces.length} turns`)
  console.log()
  process.exit(0)
}

let scored = 0, failed = 0
const failures = []
for (const s of multi) {
  // Rebuild the conversation as a person would read it.
  const lines = []
  for (const [i, t] of s.traces.entries()) {
    const full = await getTrace(t.id)
    if (!full) continue
    const q = userRequest(full).slice(0, 1500)
    const a = assistantAnswer(full).slice(0, 2500)
    if (!q && !a) continue
    lines.push(`--- TURN ${i + 1} ---\nUSER: ${q}\nASSISTANT: ${a}`)
  }
  if (lines.length < minTurns) continue

  const transcript = lines.join('\n\n').slice(0, 24000)

  // Two questions, and a conversation can fail either one alone:
  //   coherence      did it hold the thread — remember, stay consistent?
  //   goal_progress  did it move toward what the user actually wanted?
  // An assistant that remembers everything while steadily walking the user away
  // from their goal scores 1 on the first and is still a bad conversation.
  // Grading only coherence measures whether it was a tidy conversation, not
  // whether it was a useful one.
  const marks = []
  for (const criterion of ['session_coherence', 'session_goal_progress']) {
    try {
      const score = await runScorer(`judge:${criterion}`, {
        input: `A ${lines.length}-turn conversation with the contract assistant.`,
        output: transcript,
      })
      if (!score) continue
      await postScore({
        sessionId: s.sessionId,
        ...score,
        metadata: { sessionEval: true, turns: lines.length },
      })
      scored++
      const ok = Number(score.value) >= 1
      marks.push(`${ok ? '✓' : '✗'} ${criterion.replace('session_', '')}`)
      if (!ok) failures.push({ session: s.sessionId, criterion, why: score.comment })
    } catch (e) {
      failed++
      console.log(`  ! ${s.sessionId} / ${criterion}: ${e.message.slice(0, 130)}`)
    }
  }
  if (marks.length) console.log(`  ${s.sessionId.padEnd(34)} ${lines.length} turns  ${marks.join('  ')}`)
}

if (failures.length) {
  console.log(`\n  ${failures.length} failing session-level verdict(s):`)
  for (const f of failures) {
    console.log(`    ${f.session}  ${f.criterion}`)
    console.log(`        ${String(f.why).slice(0, 220)}`)
  }
}

console.log(`\n  ${scored} session score(s) posted${failed ? `, ${failed} failed` : ''}`)
console.log(`  ${LANGFUSE_HOST} → Tracing → Sessions\n`)
