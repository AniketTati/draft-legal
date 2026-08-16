#!/usr/bin/env node
/**
 * sanity.mjs — pre-benchmark sanity checks against the test bench.
 *
 * Runs SHALLOW but BROAD checks on a few anchor contracts to catch
 * infrastructure-level issues (multi-turn, phrasing, cross-user, tenant
 * isolation, content fidelity, empty handling) BEFORE we trust the bench
 * for a full benchmark re-run after product fixes.
 *
 * 3 anchors × 6 scenarios = 18 sanity turns. Sequential, single persona at
 * a time, so failures are clearly attributable.
 *
 * Anchors (one per "kind of bug we want to surface"):
 *   1. Vertex / Snowflake MSA      — standard well-known doc-type flow
 *   2. Caldera / Pfizer BAA        — known search-gap (BAA stored as OTHER+tag)
 *   3. Beacon / Walmart SLA        — SLA-specific clauses, big contract
 *
 * Scenarios per anchor:
 *   S1  Direct lookup by title                (content fidelity)
 *   S2  Same query rephrased                  (phrasing tolerance)
 *   S3  Multi-turn refinement                 (sessionId context retention)
 *   S4  Different user same org               (data is org-scoped)
 *   S5  Empty / fake counterparty             (graceful no-results)
 *   S6  Cross-tenant isolation                (no leaks across orgs)
 *
 * Output: scripts/persona-tests/output/sanity-report.md  + sanity-results.json
 */
import { login, askAgent } from './lib.mjs'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'output')
fs.mkdirSync(OUT, { recursive: true })

const PASSWORD = 'password123'

// ──────────── Anchor definitions ─────────────────────────────────────────
//
// Each anchor pins a real seeded contract title. The sanity scenarios
// reference these exact titles or counterparty names.
const ANCHORS = [
  {
    id: 'vertex-snowflake-msa',
    persona: 'Vertex Cloud',
    primaryUser: 'maya.chen@vertex.cloud',
    secondaryUser: 'priya.patel@vertex.cloud',
    counterparty: 'Snowflake',
    contractTitle: 'Snowflake — Master Services Agreement',
    docType: 'MSA',
    seededValue: '1,405,931',
    crossTenantCounterparty: 'Mayo Clinic',     // exists in Caldera, NOT in Vertex
    crossTenantPersonaHint: 'Caldera Health',
  },
  {
    id: 'caldera-pfizer-baa',
    persona: 'Caldera Health',
    primaryUser: 'lena.park@calderahealth.com',
    secondaryUser: 'marcus.hall@calderahealth.com',
    counterparty: 'Pfizer',
    contractTitle: 'Pfizer — Business Associate Agreement',
    docType: 'BAA',
    seededValue: null,
    crossTenantCounterparty: 'ArcelorMittal',   // exists in Ironbridge, NOT in Caldera
    crossTenantPersonaHint: 'Ironbridge Industrial',
  },
  {
    id: 'beacon-walmart-sla',
    persona: 'Beacon Logistics',
    primaryUser: 'hannah.rivera@beaconlogistics.com',
    secondaryUser: 'dean.whitfield@beaconlogistics.com',
    counterparty: 'Walmart',
    contractTitle: null,                         // resolved at runtime — we'll find one
    docType: 'SLA',
    seededValue: null,
    crossTenantCounterparty: 'Snowflake',        // exists in Vertex, NOT in Beacon
    crossTenantPersonaHint: 'Vertex Cloud',
  },
]

// Cache tokens (serial pre-login to avoid the audit-chain race)
const tokenCache = new Map()
async function getToken(email) {
  if (tokenCache.has(email)) return tokenCache.get(email)
  const { accessToken } = await login(email, PASSWORD)
  tokenCache.set(email, accessToken)
  return accessToken
}

const allUsers = [...new Set(ANCHORS.flatMap(a => [a.primaryUser, a.secondaryUser]))]
console.log(`▶ Sanity checks — ${ANCHORS.length} anchors × 6 scenarios = ${ANCHORS.length * 6} turns`)
console.log(`  pre-login ${allUsers.length} users (serial)…`)
for (const email of allUsers) {
  try { await getToken(email); process.stdout.write('.') }
  catch (e) { console.log(`\n    ✗ ${email}: ${e.message.slice(0, 80)}`) }
}
console.log()

const results = []
let pass = 0, fail = 0

function record(anchor, scenario, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ [${anchor.id}] ${scenario}`) }
  else    { fail++; console.log(`  ✗ [${anchor.id}] ${scenario}\n      ${detail}`) }
  results.push({ anchorId: anchor.id, scenario, ok, detail })
}

// ──────────── Run scenarios per anchor ───────────────────────────────────

for (const anchor of ANCHORS) {
  console.log(`\n═══ ${anchor.persona} — ${anchor.counterparty} ${anchor.docType} ═══`)
  const primaryToken = await getToken(anchor.primaryUser)
  const secondaryToken = await getToken(anchor.secondaryUser)

  // Resolve contract title if not set (Beacon Walmart SLA — pick whichever exists)
  let resolvedTitle = anchor.contractTitle
  if (!resolvedTitle) {
    const r = await fetch(`http://localhost:3001/api/v1/contracts?counterpartyName=${encodeURIComponent(anchor.counterparty)}&type=SLA&limit=1`, {
      headers: { Authorization: `Bearer ${primaryToken}` },
    }).then(x => x.json()).catch(() => ({ data: [] }))
    resolvedTitle = r.data?.[0]?.title ?? `${anchor.counterparty} — Customer Service Level Agreement`
    console.log(`  resolved anchor title: ${resolvedTitle}`)
  }

  // ── S1 — Direct lookup by title (content fidelity) ────────────────────
  {
    const sid = `sanity-${anchor.id}-s1`
    const r = await askAgent({
      token: primaryToken,
      sessionId: sid,
      message: `Tell me about the ${resolvedTitle}. What's the governing law and key terms?`,
      agentMode: true,
    })
    const usedTool = r.tools.length > 0
    const mentionsCounterparty = r.assistantText.toLowerCase().includes(anchor.counterparty.toLowerCase())
    const ok = !r.error && usedTool && mentionsCounterparty
    record(anchor, 'S1 direct lookup',
      ok,
      `tools=[${r.tools.map(t => t.name).join(',')}]  mentionsCP=${mentionsCounterparty}  err=${r.error ?? 'none'}  text="${r.assistantText.slice(0, 140)}…"`)
  }

  // ── S2 — Same query rephrased (phrasing tolerance) ─────────────────────
  {
    const phrasings = [
      `What contracts do we have with ${anchor.counterparty}?`,
      `Pull up everything ${anchor.counterparty}-related from our portfolio.`,
      `Show me all ${anchor.counterparty} agreements.`,
    ]
    const responses = []
    for (let i = 0; i < phrasings.length; i++) {
      const r = await askAgent({
        token: primaryToken,
        sessionId: `sanity-${anchor.id}-s2-${i}`,
        message: phrasings[i],
        agentMode: true,
      })
      responses.push(r)
    }
    const allCalledTool = responses.every(r => r.tools.length > 0)
    const allMentionCp = responses.every(r => r.assistantText.toLowerCase().includes(anchor.counterparty.toLowerCase()))
    record(anchor, 'S2 phrasing tolerance (3 variants)',
      allCalledTool && allMentionCp,
      `toolsHit=${responses.map(r => r.tools.length > 0 ? '1' : '0').join('/')}  cpMention=${responses.map(r => r.assistantText.toLowerCase().includes(anchor.counterparty.toLowerCase()) ? '1' : '0').join('/')}`)
  }

  // ── S3 — Multi-turn refinement (sessionId context retention) ──────────
  {
    const sid = `sanity-${anchor.id}-s3`
    const turn1 = await askAgent({
      token: primaryToken,
      sessionId: sid,
      message: `Show me all our ${anchor.counterparty} contracts.`,
      agentMode: true,
    })
    const turn2 = await askAgent({
      token: primaryToken,
      sessionId: sid,           // SAME session
      message: 'Of those, which are currently EXECUTED?',
      agentMode: true,
    })
    // The follow-up "of those" requires context from turn 1. PASS if turn 2:
    //   (a) references the counterparty in the response (proves it knew which
    //       set "those" pointed to), AND
    //   (b) provides a sensible refined answer (mentions "executed", or lists
    //       contracts, or correctly says no executed ones).
    // The agent may legitimately answer WITHOUT a new tool call — turn 1's
    // tool result is already in the conversation context, and re-calling
    // would be wasteful. So tool-count is NOT a pass criterion.
    const lower2 = turn2.assistantText.toLowerCase()
    const knewContext = lower2.includes(anchor.counterparty.toLowerCase())
        || turn2.tools.some(t => JSON.stringify(t.args ?? {}).toLowerCase().includes(anchor.counterparty.toLowerCase()))
    const refinedSensibly = lower2.includes('executed') || lower2.includes('not find') || lower2.includes('no contract') || /\d/.test(turn2.assistantText)
    record(anchor, 'S3 multi-turn refinement',
      knewContext && refinedSensibly && !turn2.error,
      `knewContext=${knewContext}  refined=${refinedSensibly}  tools=[${turn2.tools.map(t => t.name).join(',')}]  text="${turn2.assistantText.slice(0, 140)}…"`)
  }

  // ── S4 — Different user same org (org-scoped data) ─────────────────────
  {
    const q = `How many ${anchor.counterparty} contracts do we have, and what's the total value?`
    const [r1, r2] = await Promise.all([
      askAgent({ token: primaryToken,   sessionId: `sanity-${anchor.id}-s4-a`, message: q, agentMode: true }),
      askAgent({ token: secondaryToken, sessionId: `sanity-${anchor.id}-s4-b`, message: q, agentMode: true }),
    ])
    const cpOk1 = r1.assistantText.toLowerCase().includes(anchor.counterparty.toLowerCase())
    const cpOk2 = r2.assistantText.toLowerCase().includes(anchor.counterparty.toLowerCase())
    // Both users in the same org should be able to see this counterparty's contracts.
    // We don't require IDENTICAL answers (different prompts ==> different phrasings),
    // we just require both to find the data.
    record(anchor, 'S4 cross-user same-org both find data',
      cpOk1 && cpOk2,
      `${anchor.primaryUser.split('@')[0]}=${cpOk1}  ${anchor.secondaryUser.split('@')[0]}=${cpOk2}`)
  }

  // ── S5 — Empty / fake counterparty (no hallucination) ──────────────────
  {
    const fakeCp = 'ZyzzlphaxNotARealCo'
    const r = await askAgent({
      token: primaryToken,
      sessionId: `sanity-${anchor.id}-s5`,
      message: `What contracts do we have with ${fakeCp}?`,
      agentMode: true,
    })
    const lower = r.assistantText.toLowerCase()
    const correctlySaysNone =
      lower.includes('no contract') || lower.includes('not find') || lower.includes("couldn't find") ||
      lower.includes('no record') || lower.includes('no result') || lower.includes("don't have") ||
      lower.includes('do not have') || lower.includes('no agreement') || lower.includes('none')
    // Critical: must NOT mention any other real counterparty as if it were the fake one
    const hallucinatesAsFake = false  // we don't have a great heuristic; record below
    record(anchor, 'S5 empty result for fake counterparty',
      correctlySaysNone,
      `text="${r.assistantText.slice(0, 200)}…"`)
  }

  // ── S6 — Cross-tenant isolation ─────────────────────────────────────────
  {
    // Primary user (e.g. Vertex Maya) asks about Mayo Clinic — exists in
    // Caldera org only. Vertex shouldn't see Mayo Clinic's data.
    const r = await askAgent({
      token: primaryToken,
      sessionId: `sanity-${anchor.id}-s6`,
      message: `What contracts do we have with ${anchor.crossTenantCounterparty}?`,
      agentMode: true,
    })
    const lower = r.assistantText.toLowerCase()
    const correctlyIsolated =
      lower.includes('no contract') || lower.includes('not find') || lower.includes("couldn't find") ||
      lower.includes('no record') || lower.includes('no result') || lower.includes("don't have") ||
      lower.includes('do not have') || lower.includes('no agreement') || lower.includes('none')
    record(anchor, `S6 tenant isolation (no ${anchor.crossTenantCounterparty} from ${anchor.crossTenantPersonaHint})`,
      correctlyIsolated,
      `text="${r.assistantText.slice(0, 200)}…"`)
  }
}

// ──────────── Report ─────────────────────────────────────────────────────

const total = pass + fail
console.log(`\n${'═'.repeat(70)}`)
console.log(`✓ Sanity checks: ${pass}/${total} passed${fail ? `  (${fail} failed — see above)` : ''}`)
// Canonical summary line for scripts/evals/run.mjs (/^(.+): (\d+)\/(\d+) passed\s*$/).
// The line above matches that regex ONLY when nothing fails — the trailing
// "(N failed — see above)" breaks it — so this suite was countable exclusively
// while green, and a run WITH failures reported as "no summary line" i.e. a
// crash. Verified: this run exited 1 with real failures and the runner logged
// ERRO 0/0. A suite that becomes unreadable precisely when it has something to
// report is worse than one that never ran.
console.log(`Persona sanity: ${pass}/${total} passed`)
console.log(`${'═'.repeat(70)}`)

const grouped = new Map()  // by scenario name
for (const r of results) {
  if (!grouped.has(r.scenario)) grouped.set(r.scenario, [])
  grouped.get(r.scenario).push(r)
}
console.log(`\nBy scenario:`)
for (const [scenario, rs] of grouped.entries()) {
  const ok = rs.filter(r => r.ok).length
  console.log(`  ${ok === rs.length ? '✓' : '✗'} ${scenario.padEnd(50)} ${ok}/${rs.length}`)
}

// Persist
fs.writeFileSync(path.join(OUT, 'sanity-results.json'), JSON.stringify({
  ranAt: new Date().toISOString(),
  total, pass, fail,
  results,
}, null, 2))

const md = []
md.push(`# Sanity Check — Test Bench Pre-Flight\n`)
md.push(`**Run at:** ${new Date().toISOString()}`)
md.push(`**Result:** ${pass}/${total} passed\n`)
md.push(`## Anchors\n`)
for (const a of ANCHORS) {
  md.push(`- **${a.persona}** — ${a.counterparty} ${a.docType} (primary: ${a.primaryUser}, secondary: ${a.secondaryUser})`)
}
md.push(`\n## By scenario\n`)
md.push(`| Scenario | Pass |`)
md.push(`|---|---|`)
for (const [scenario, rs] of grouped.entries()) {
  const ok = rs.filter(r => r.ok).length
  md.push(`| ${scenario} | ${ok}/${rs.length} |`)
}
md.push(`\n## All results\n`)
for (const r of results) {
  md.push(`- ${r.ok ? '✓' : '✗'} **${r.anchorId}** — ${r.scenario}`)
  if (!r.ok || r.detail) md.push(`  - \`${r.detail}\``)
}
fs.writeFileSync(path.join(OUT, 'sanity-report.md'), md.join('\n'))

console.log(`\nResults: ${path.join(OUT, 'sanity-results.json')}`)
console.log(`Report:  ${path.join(OUT, 'sanity-report.md')}`)

if (fail > 0) process.exit(1)
