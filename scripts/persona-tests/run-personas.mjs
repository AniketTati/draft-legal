#!/usr/bin/env node
/**
 * run-personas.mjs — multi-turn agent stress-test across all 5 personas.
 *
 * Each persona file at personas/<slug>.mjs exports:
 *   { persona, primaryUser, conversations: [...] }
 *
 * Each conversation has 1+ turns sent on the same sessionId. Per-turn
 * rubric in lib-multi.mjs. Pass = all turns pass.
 *
 * Output:
 *   scripts/persona-tests/output/multi/<persona>/<conv-id>.json — full transcript
 *   scripts/persona-tests/output/multi/scorecard.json
 *   scripts/persona-tests/output/multi/summary.md
 *
 * Args:
 *   node run-personas.mjs              # all 5
 *   node run-personas.mjs vertex       # one persona only
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { login } from './lib.mjs'
import { runConversations, PASSWORD } from './lib-multi.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'output', 'multi')
fs.mkdirSync(OUT, { recursive: true })

const ALL_PERSONAS = ['vertex', 'caldera', 'ironbridge', 'lumen', 'beacon']
const filter = process.argv[2]
const personas = filter ? ALL_PERSONAS.filter(p => p === filter) : ALL_PERSONAS
if (personas.length === 0) {
  console.error(`Unknown persona "${filter}". Available: ${ALL_PERSONAS.join(', ')}`)
  process.exit(1)
}

const allResults = []
const startTime = Date.now()

for (const slug of personas) {
  const filePath = path.join(__dirname, 'personas', `${slug}.mjs`)
  if (!fs.existsSync(filePath)) {
    console.log(`⏭  ${slug} — no persona file yet, skipping`)
    continue
  }
  const mod = await import(filePath)
  const { persona, primaryUser, conversations } = mod.default

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`▶  ${persona}  ·  ${conversations.length} conversations  ·  primary user ${primaryUser}`)
  console.log('═'.repeat(72))

  // Pre-login each unique user that conversations touch (serial, to dodge audit-chain race)
  const uniqueUsers = [...new Set(conversations.flatMap(c => [c.user]))]
  const tokenByEmail = new Map()
  for (const email of uniqueUsers) {
    try {
      const { accessToken } = await login(email, PASSWORD)
      tokenByEmail.set(email, accessToken)
      process.stdout.write('.')
    } catch (e) {
      console.log(`\n   ✗ login failed for ${email}: ${e.message.slice(0, 60)}`)
    }
  }
  process.stdout.write('\n')

  // Pick a sensible "default" token for cases where conversation.user is unset
  const defaultToken = tokenByEmail.get(primaryUser) ?? tokenByEmail.values().next().value
  if (!defaultToken) {
    console.log(`   ✗ No usable login for ${persona} — skipping`)
    continue
  }

  fs.mkdirSync(path.join(OUT, persona), { recursive: true })

  const personaResults = []
  for (const conv of conversations) {
    const token = tokenByEmail.get(conv.user) ?? defaultToken
    const r = await runConversations({
      token, persona,
      conversations: [conv],
    })
    const result = r.results[0]
    personaResults.push(result)

    const passedTurns = result.turns.filter(t => t.ok).length
    const tag = result.ok ? '✓' : '✗'
    console.log(`  ${tag} ${conv.id.padEnd(40)}  ${passedTurns}/${result.turns.length} turns  ${result.latencyMsTotal}ms  · ${conv.title}`)
    for (const t of result.turns) {
      if (!t.ok) {
        for (const f of t.fails) console.log(`        T${t.turn}: ${f}`)
      }
    }

    fs.writeFileSync(
      path.join(OUT, persona, `${conv.id}.json`),
      JSON.stringify(result, null, 2),
    )
  }

  const turnTotal = personaResults.reduce((s, r) => s + r.turns.length, 0)
  const turnPass  = personaResults.reduce((s, r) => s + r.turns.filter(t => t.ok).length, 0)
  const turnShrug = personaResults.reduce((s, r) => s + r.turns.filter(t => t.shrugPass).length, 0)
  const turnSlow  = personaResults.reduce((s, r) => s + r.turns.filter(t => t.overBudget).length, 0)
  const convPass  = personaResults.filter(r => r.ok).length
  console.log(`\n  ${persona}: ${convPass}/${personaResults.length} conversations · ${turnPass}/${turnTotal} turns${turnShrug ? ` · ${turnShrug} passed on a shrug` : ''}`)

  allResults.push({
    persona,
    convPass, convTotal: personaResults.length,
    turnPass, turnTotal, turnShrug, turnSlow,
    results: personaResults,
  })
}

const totalDuration = Date.now() - startTime
const totalConv = allResults.reduce((s, p) => s + p.convTotal, 0)
const totalConvPass = allResults.reduce((s, p) => s + p.convPass, 0)
const totalTurn = allResults.reduce((s, p) => s + p.turnTotal, 0)
const totalTurnPass = allResults.reduce((s, p) => s + p.turnPass, 0)
const totalShrug = allResults.reduce((s, p) => s + p.turnShrug, 0)
const totalSlow  = allResults.reduce((s, p) => s + (p.turnSlow ?? 0), 0)

console.log(`\n${'═'.repeat(72)}`)
console.log(`✓ Done — ${totalConvPass}/${totalConv} conversations · ${totalTurnPass}/${totalTurn} turns · ${(totalDuration / 1000).toFixed(1)}s`)
// Canonical summary line for scripts/evals/run.mjs (/^(.+): (\d+)\/(\d+) passed\s*$/).
// Turns rather than conversations: the turn is what lib-multi actually grades,
// so it is the number that drops when coverage is lost.
console.log(`Persona journeys: ${totalTurnPass}/${totalTurn} passed`)
// Read this NEXT TO the pass count, never instead of it. A shrug pass is a
// turn that went green while the agent declined to answer — the rubric's
// graceful-empty bypass suppressed the checks, or the only mustMentionAny
// phrase it matched was one meaning "no answer". They are not failures; they
// are turns the suite did not actually examine. If this number climbs while
// the pass rate holds, the agent is getting more evasive and the headline
// cannot see it.
console.log(`  of which passed on a shrug: ${totalShrug}/${totalTurnPass} (${totalTurnPass ? ((totalShrug / totalTurnPass) * 100).toFixed(0) : 0}%)`)
// Latency is reported BESIDE the pass rate, never inside it. It used to share
// the same `fails` array as content failures, so a slow runner failed rows in
// correlated bursts and a latency regression was indistinguishable from a
// correctness one.
console.log(`  over latency budget:        ${totalSlow}/${totalTurn} turns`)
console.log('═'.repeat(72))
for (const p of allResults) {
  console.log(`  ${p.persona.padEnd(24)} ${p.convPass}/${p.convTotal} conv · ${p.turnPass}/${p.turnTotal} turns · ${p.turnShrug} shrug`)
}

// Persist scorecard
fs.writeFileSync(path.join(OUT, 'scorecard.json'), JSON.stringify({
  ranAt: new Date().toISOString(),
  totalConv, totalConvPass, totalTurn, totalTurnPass, totalShrug, totalSlow,
  totalDurationMs: totalDuration,
  personas: allResults.map(p => ({
    persona: p.persona,
    convPass: p.convPass, convTotal: p.convTotal,
    turnPass: p.turnPass, turnTotal: p.turnTotal, turnShrug: p.turnShrug,
    conversations: p.results.map(r => ({
      id: r.id, title: r.title, type: r.type, user: r.user,
      ok: r.ok,
      turns: r.turns.length,
      turnsPassed: r.turns.filter(t => t.ok).length,
      turnsShrug: r.turns.filter(t => t.shrugPass).length,
      latencyMsTotal: r.latencyMsTotal,
    })),
  })),
}, null, 2))

// Markdown summary
const md = []
md.push(`# Multi-turn persona test summary\n`)
md.push(`**Run at:** ${new Date().toISOString()}`)
md.push(`**Duration:** ${(totalDuration / 1000).toFixed(1)}s`)
md.push(`**Result:** ${totalConvPass}/${totalConv} conversations · ${totalTurnPass}/${totalTurn} turns\n`)
md.push(`**Passed on a shrug:** ${totalShrug}/${totalTurnPass} — turns that went green while the agent`)
md.push(`declined to answer. Not failures; turns the rubric did not actually examine.\n`)
md.push(`## Per-persona\n`)
md.push(`| Persona | Conv | Turns | Shrug |`)
md.push(`|---|---|---|---|`)
for (const p of allResults) {
  md.push(`| ${p.persona} | ${p.convPass}/${p.convTotal} | ${p.turnPass}/${p.turnTotal} | ${p.turnShrug} |`)
}
md.push(`\n## Failures\n`)
for (const p of allResults) {
  for (const r of p.results) {
    if (r.ok) continue
    md.push(`- **${r.id}** (${r.type}): ${r.title}`)
    for (const t of r.turns) {
      if (!t.ok) for (const f of t.fails) md.push(`  - T${t.turn}: ${f}`)
    }
  }
}
fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n'))

if (totalConvPass < totalConv) process.exit(1)
