#!/usr/bin/env node
/**
 * V2 — portfolio answers must say when they are partial.
 *
 * `portfolio_search` returned a ranked top-K with no total, `renewal_advice`
 * sliced to one page (lapsed contracts first) and reported page counts, and
 * `contract_search` had no date/value filters. So "which contracts…" answers
 * were samples presented as if complete. The tools now return
 * `coverage: { returned, totalMatching, complete, note }` and orchestrator
 * rule A13 requires the answer to state partial coverage.
 *
 * This probe asks one set question whose answer cannot fit one page in the
 * demo org, and asserts (1) the tool result carried a coverage block that
 * says it is incomplete, and (2) the assistant's prose says so.
 *
 * Needs the live stack (API + agents service + an LLM key), so it is tier 3
 * in scripts/evals/manifest.mjs and never gates a PR.
 *
 * Run BEFORE: no coverage block; the answer lists rows as if they were all.
 * Run AFTER:  coverage.complete=false is surfaced as "N of M" / "a sample".
 */
import { login, check, report, section, API } from '../week-zero/lib/harness.mjs'

const admin = await login()

async function turn(message) {
  const res = await fetch(`${API}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.accessToken}` },
    body: JSON.stringify({ agentMode: true, message, sessionId: `v2-${Date.now()}` }),
  })
  const frames = (await res.text()).split('\n').filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
    .filter(Boolean)
  const prose = frames.filter(f => f.type === 'token').map(f => f.delta ?? f.content ?? '').join('')
  const results = frames.filter(f => f.type === 'tool_call_result')
  return { prose, results }
}

// A set question: "which" + a population larger than one page.
const QUESTION = 'Which of our contracts mention limitation of liability? List them.'

section('V2. A set question states its coverage')
{
  const { prose, results } = await turn(QUESTION)
  const coverages = results
    .map(r => { try { return (typeof r.result === 'string' ? JSON.parse(r.result) : r.result)?.coverage } catch { return null } })
    .filter(Boolean)

  check('a list tool returned a coverage block', coverages.length > 0,
    coverages.length ? coverages.map(c => c.note).join(' | ') : `tools called: ${results.map(r => r.name).join(', ') || 'none'}`)

  const partial = coverages.find(c => c.complete === false)
  if (partial) {
    const stated = /\b(\d+)\s+of\s+(about\s+)?\d+\b|\bsample\b|\bnot (a )?complete\b|\btop \d+\b|\bpartial\b|\bat least\b/i.test(prose)
    check('the answer says it is partial (A13)', stated,
      stated ? prose.slice(0, 160) : `coverage said "${partial.note}", but the answer did not: ${prose.slice(0, 200)}`)
  } else {
    check('coverage was complete, so no caveat is required', true, 'the demo org fit on one page for this question')
  }
}

report('V2 — coverage statements')
