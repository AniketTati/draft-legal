#!/usr/bin/env node
/**
 * P7.5.3 verify — Langfuse tracing wired into Python agent service.
 *
 * The tracing module (D.0.7) was already in place but wasn't being
 * called from the Python /extract_obligations and /renewal_advice
 * routes — they used build_llm() directly instead of resolve_llm(),
 * skipping the callback handler attachment.
 *
 * After this fix:
 *   - obligations.py + renewals.py go through resolve_llm()
 *   - llm.ainvoke is called with config={"callbacks": [handler]}
 *   - Falls back gracefully when LANGFUSE_* keys aren't set
 *
 * Checks:
 *   (1) tracing.py exports get_callback + tracing_enabled
 *   (2) router.py builds the callback handler via get_callback()
 *   (3) obligations.py uses resolve_llm + passes callbacks to ainvoke
 *   (4) renewals.py uses resolve_llm + passes callbacks to ainvoke
 *   (5) Both routes have a build_llm() fallback for local dev
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import fs from 'node:fs'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

const APP = path.join(REPO_ROOT, 'apps/agents/app')

console.log('\n=== (1) tracing.py exports ===')
const tracing = fs.readFileSync(`${APP}/tracing.py`, 'utf8')
check(/def get_callback/.test(tracing), `get_callback defined`)
check(/def tracing_enabled/.test(tracing), `tracing_enabled defined`)

console.log('\n=== (2) router.py wires callbacks via get_callback ===')
const router = fs.readFileSync(`${APP}/router.py`, 'utf8')
check(/from \.tracing import get_callback/.test(router), `router imports get_callback`)
check(/handler = get_callback/.test(router), `router instantiates handler`)
check(/callbacks=\[handler\] if handler else \[\]/.test(router), `router exposes callbacks list`)

console.log('\n=== (3) obligations.py uses resolve_llm + passes callbacks ===')
const obl = fs.readFileSync(`${APP}/routes/obligations.py`, 'utf8')
check(/from app.router import resolve_llm/.test(obl), `obligations imports resolve_llm`)
check(/await resolve_llm\(\s*["']default/m.test(obl), `obligations calls resolve_llm`)
check(/config=\{"callbacks": callbacks\}/.test(obl), `obligations passes callbacks to ainvoke`)

console.log('\n=== (4) renewals.py uses resolve_llm + passes callbacks ===')
const ren = fs.readFileSync(`${APP}/routes/renewals.py`, 'utf8')
check(/from app.router import resolve_llm/.test(ren), `renewals imports resolve_llm`)
check(/await resolve_llm\(\s*["']default/m.test(ren), `renewals calls resolve_llm`)
check(/config=\{"callbacks": callbacks\}/.test(ren), `renewals passes callbacks to ainvoke`)

console.log('\n=== (5) build_llm fallback for local dev ===')
check(/build_llm\(provider, model/.test(obl), `obligations has build_llm fallback`)
check(/build_llm\(provider, model/.test(ren), `renewals has build_llm fallback`)

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All P7.5.3 Langfuse-wiring checks pass')
