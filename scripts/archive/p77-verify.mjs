#!/usr/bin/env node
/**
 * P7.7 verify — Quality + RAG upgrades.
 *
 * Covers all three P7.7 sub-items in one file because they're each
 * primarily a wiring change with small visible surface:
 *
 *   P7.7.1  voyage-law-2 + voyage-rerank-2.5
 *           - activeEmbedProvider() prefers voyage when key set
 *           - rerankClauses() falls back to identity when key missing
 *           - search/ask wired to over-fetch + rerank
 *
 *   P7.7.2  Anthropic Citations API
 *           - ask_agent.py routes to native citations path on anthropic
 *           - falls back to prompt-mode for openai/gemini
 *           - citations envelope includes verbatim/spanStart/spanEnd
 *             when native, sectionRef/bbox/page always
 *
 *   P7.7.3  Classifier improvements
 *           - obligations_list keeps recurring obligations even when
 *             dueDate is older than 30 days
 *           - obligations_list returns a `diagnostic` block when empty
 *             to suggest running extract-obligations
 *           - assist agent's system prompt reinforces "draft first,
 *             ask questions later"
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

// ── (1) embeddings module unit tests
console.log('\n=== (1) embeddings unit tests ===')
const r = spawnSync('pnpm', ['vitest', 'run', 'src/lib/embeddings.test.ts'], {
  cwd: path.join(REPO_ROOT, 'apps/api'),
  encoding: 'utf8',
})
const out = (r.stdout ?? '') + (r.stderr ?? '')
const passLine = out.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/)
check(r.status === 0, `vitest exits 0`)
check(passLine && passLine[1] === passLine[2], `tests pass ${passLine?.[0] ?? ''}`)

// ── (2) embeddings provider routing surface
console.log('\n=== (2) embeddings.ts exports ===')
const emb = fs.readFileSync(path.join(REPO_ROOT, 'apps/api/src/lib/embeddings.ts'), 'utf8')
check(/export function activeEmbedProvider/.test(emb), `activeEmbedProvider exported`)
check(/export async function rerankClauses/.test(emb), `rerankClauses exported`)
check(/voyage-law-2/.test(emb), `voyage-law-2 model name present`)
check(/api\.voyageai\.com\/v1\/rerank/.test(emb), `rerank-2.5 endpoint wired`)

// ── (3) search.ts uses rerankClauses
console.log('\n=== (3) search.ts wires rerank into /ask ===')
const search = fs.readFileSync(path.join(REPO_ROOT, 'apps/api/src/routes/search.ts'), 'utf8')
check(/rerankClauses/.test(search), `search.ts imports rerankClauses`)
check(/await rerankClauses\(/.test(search), `search.ts calls rerankClauses`)

// ── (4) ask_agent.py has native citations branch
console.log('\n=== (4) ask_agent.py routes to native citations on anthropic ===')
const ask = fs.readFileSync(path.join(REPO_ROOT, 'apps/agents/app/agents/ask_agent.py'), 'utf8')
check(/use_anthropic_citations/.test(ask), `provider routing variable present`)
check(/_ask_anthropic_with_citations/.test(ask), `native citations function defined`)
check(/citations.*enabled.*True/i.test(ask) || /"citations": \{"enabled": True\}/.test(ask),
      `document blocks pass citations: enabled=true`)
check(/cited_text/.test(ask), `cited_text mapped onto envelope`)
check(/spanStart/.test(ask), `spanStart included in citation envelope`)
check(/spanEnd/.test(ask), `spanEnd included in citation envelope`)

// ── (5) obligations_list accepts recurring obligations + emits diagnostic
console.log('\n=== (5) obligations_list improvements (F-83) ===')
const internal = fs.readFileSync(path.join(REPO_ROOT, 'apps/api/src/routes/internal-ai.ts'), 'utf8')
check(/RECURRING\s*=\s*new Set/.test(internal), `RECURRING set defined`)
check(/no_obligations_extracted/.test(internal), `diagnostic kind for empty result`)
check(/contractsAwaitingExtraction/.test(internal), `diagnostic includes contracts list`)

// ── (6) Assist agent system prompt updated for F-84
console.log('\n=== (6) Assist-agent prompt reinforces draft-first behaviour (F-84) ===')
const orch = fs.readFileSync(path.join(REPO_ROOT, 'apps/agents/app/orchestrator.py'), 'utf8')
check(/F-84/.test(orch), `prompt comment references F-84`)
check(/DO NOT[\s\S]{0,80}ask for details first/i.test(orch), `prompt forbids "ask first" pattern`)
check(/contract_search/.test(orch) && /counterparty_memory/.test(orch),
      `prompt names the tools to call up-front`)
check(/Could you provide more details/.test(orch),
      `prompt explicitly bans the bad reply`)

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All P7.7 quality + RAG checks pass')
