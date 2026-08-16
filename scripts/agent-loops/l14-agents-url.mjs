#!/usr/bin/env node
/**
 * L14 — the API dials the port the agents service actually binds.
 *
 * Found 2026-08-16 by running the suite on a clean stack. Every service was up
 * and healthy, `/health` answered on both ports, the eval runner reported
 * `agents=yes replay=yes` — and every agent chat 500ed with ECONNREFUSED.
 *
 * The split was total. `apps/agents/package.json` binds `${AGENTS_PORT:-8002}`,
 * the shared harness probes 8002 and `scripts/evals/run.mjs` probes 8002; but
 * `.env.example` shipped `AGENTS_URL=http://localhost:8000` and all fourteen
 * call sites in apps/api fell back to 8000. So a fresh checkout that followed
 * the documented setup booted both services and could not talk between them.
 * BUILD_TRACKER.md:1193 even claims the 8002 dev script "matches `.env`
 * AGENTS_URL" — it did not.
 *
 * Two independent failure modes, both guarded here:
 *
 *   1. PORT DRIFT. The port is written down in six places and nothing compared
 *      them. Changing the bind port silently breaks every caller.
 *   2. PHANTOM ENV NAMES. `playbook.ts:177` read `AGENT_SERVICE_URL`, a
 *      variable set by no env file, no example and no deploy manifest — so in
 *      Cloud Run, where AGENTS_URL is a real https:// URL, it fell back to
 *      localhost. Its own catch turns an unreachable agents service into a 200
 *      with no AI comparison, so it degraded silently in production. A typo in
 *      an env var name is invisible precisely because `??` makes it look
 *      deliberate.
 *
 * Static analysis only — tier 1. No services, no database, no model.
 *
 * Run BEFORE: .env.example says 8000, fourteen call sites default to 8000, and
 *             playbook.ts reads an env var nothing defines.
 * Run AFTER:  one port everywhere, and every agents-URL env name is one a
 *             deploy actually sets.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const read = p => { try { return fs.readFileSync(`${REPO}/${p}`, 'utf8') } catch { return '' } }

/** Walk apps/api/src for .ts files. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(`${REPO}/${dir}`, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

// ─── 1. One port, agreed by everything that names it ────────────────────────

section('1. The bound port and the dialled port are the same number')

const agentsPkg = read('apps/agents/package.json')
const BOUND = agentsPkg.match(/AGENTS_PORT:-(\d{4,5})/)?.[1]

check('the agents service declares the port it binds', !!BOUND,
  `apps/agents/package.json → ${JSON.stringify(BOUND)} — this is the source of truth; everything else must agree with it`)

{
  // Each entry is a place that independently writes the port down. Any one of
  // them drifting is a broken stack, so each gets its own assertion rather
  // than a single "they all match" that hides WHICH one moved.
  const sites = [
    ['.env.example AGENTS_URL', read('.env.example').match(/^AGENTS_URL=.*localhost:(\d{4,5})/m)?.[1]],
    ['the shared harness AGENTS default', read('scripts/week-zero/lib/harness.mjs').match(/AGENTS_BASE \?\? 'http:\/\/localhost:(\d{4,5})'/)?.[1]],
    ['the eval runner agents probe', read('scripts/evals/run.mjs').match(/AGENTS_BASE \?\? 'http:\/\/localhost:(\d{4,5})'/)?.[1]],
  ]
  for (const [label, port] of sites) {
    check(`${label} is ${BOUND}`, port === BOUND,
      `got ${JSON.stringify(port)}, service binds ${BOUND} — a mismatch here is ECONNREFUSED on every agent turn, with both services reporting healthy`)
  }
}

// ─── 2. No caller in apps/api falls back to a different port ────────────────

section('2. Every apps/api fallback points at the same service')
{
  // Scoped to fallbacks whose env var NAMES the agents service. apps/api also
  // dials redis, elasticsearch, gotenberg and the frontend on their own ports,
  // and a blanket "every localhost port equals BOUND" would flag all of them —
  // a check that fires on correct code gets muted, and then it guards nothing.
  const AGENTS_ENV = /^AGENTS?(_[A-Z]+)*_URL$|^AGENT_SERVICE_URL$/
  const offenders = []
  for (const f of walk('apps/api/src')) {
    for (const m of read(f).matchAll(/process\.env\.([A-Z_]+)\s*\?\?\s*'http:\/\/localhost:(\d{4,5})'/g)) {
      const [, name, port] = m
      // AGENTS_API_URL is the API's own base, not the agents service — it is
      // excluded by name below rather than by port, so a real drift still bites.
      if (AGENTS_ENV.test(name) && name !== 'AGENTS_API_URL' && port !== BOUND) {
        offenders.push(`${f.replace('apps/api/src/', '')} ${name}→${port}`)
      }
    }
  }
  check('no apps/api call site dials a port the agents service does not bind',
    offenders.length === 0,
    offenders.length
      ? `${offenders.length} site(s): ${offenders.slice(0, 8).join(', ')}`
      : `every agents-service fallback in apps/api uses ${BOUND}`)
}

// ─── 3. Every agents-URL env name is one a deploy actually sets ─────────────

// Deliberately covers EVERY localhost fallback in apps/api, not just the agents
// service. Broadening it past its original scope is what caught PUBLIC_APP_URL:
// four files built Slack and Teams deep links from a name set nowhere, so every
// notification link in production pointed at localhost:5173.
section('3. No call site reads an env var nothing defines')
{
  // Where a deploy could plausibly set it. If a name appears in none of these,
  // the `??` fallback is not a fallback — it is the only branch that ever runs.
  const defined = ['.env.example', 'env.api.example.yaml', 'env.api.yaml',
    'docker-compose.selfhost.yml', 'docker-compose.yml']
    .map(read).join('\n')

  // Any process.env.<NAME> used to build an agents-service URL.
  const names = new Set()
  for (const f of walk('apps/api/src')) {
    const src = read(f)
    for (const m of src.matchAll(/process\.env\.([A-Z_]+)\s*\?\?\s*'http:\/\/localhost:\d{4,5}'/g)) {
      names.add(m[1])
    }
  }

  check('env names with a localhost fallback were found to check', names.size > 0,
    `found: ${[...names].join(', ') || 'NONE — the regex above has gone stale, which would make this whole section vacuous'}`)

  for (const name of names) {
    check(`${name} is set by at least one env file or deploy manifest`,
      new RegExp(`^\\s*${name}[:=]`, 'm').test(defined),
      `${name} appears in no env file, example or compose manifest, so in a real deployment the localhost fallback is not a fallback — it is the ONLY branch that ever runs, and \`??\` makes that look deliberate`)
  }
}

report('L14 agents-service URL agreement')
