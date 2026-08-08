#!/usr/bin/env node
/**
 * Agents dependency check — does requirements.txt actually install, and does it
 * install the same library line the code is written against?
 *
 * This exists because those are two different questions and we were failing
 * both without noticing:
 *
 *   1. CI's "Test Agents (Python)" job broke at `pip install` on 2026-08-06.
 *      Its only other step is `pytest tests/ || true` against a directory that
 *      does not exist, so the install IS the job. A red X there is the whole
 *      signal.
 *
 *   2. More quietly: the local dev venv runs the langchain 1.x line, while
 *      requirements.txt pinned langchain-core and langgraph below 1.0. Even if
 *      resolution had succeeded, the agents container would have run different
 *      major versions of the LLM framework than anything we ever tested. That
 *      is the kind of gap you only find by resolving the file rather than
 *      trusting it.
 *
 * So we resolve inside python:3.11-slim — the exact base image
 * apps/agents/Dockerfile builds from and the same Python CI's setup-python
 * pins — and then assert on the versions that come out, not just the exit
 * code. Installing and importing on the host would prove nothing: the host
 * venv is already populated with the versions we are trying to verify.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const AGENTS = fileURLToPath(new URL('../../apps/agents/', import.meta.url))
const IMAGE = 'python:3.11-slim'
// A named volume keeps the wheel cache between runs; a cold resolve of the
// langchain stack is otherwise a couple of minutes every time.
const CACHE = 'draftlegal-pipcache'

/**
 * Run a command inside the base image with the agents dir mounted read-only.
 *
 * The timeout is part of the assertion, not just plumbing. An unsatisfiable
 * requirements.txt does not fail fast — pip backtracks through every version of
 * every candidate first. The broken file took over ten minutes here before
 * giving up. A resolve that cannot finish in a few minutes is a broken file in
 * every way that matters, so we let the clock be the verdict.
 */
function inImage(script, { timeout = 900_000 } = {}) {
  try {
    const stdout = execFileSync('docker', [
      'run', '--rm',
      '-v', `${AGENTS}:/agents:ro`,
      '-v', `${CACHE}:/root/.cache/pip`,
      '-w', '/agents',
      IMAGE, 'bash', '-lc', script,
    ], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: stdout }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

// ─── 1. It resolves at all ──────────────────────────────────────────────────

section('1. requirements.txt resolves on the image we actually ship')

// --dry-run stops before downloading wheels: we only want the resolver's
// verdict, and it reaches ResolutionImpossible in seconds.
const DUMP = [
  'import json',
  'd = json.load(open("/tmp/r.json"))',
  'for i in d["install"]:',
  '    print(i["metadata"]["name"].lower() + "==" + i["metadata"]["version"])',
].join('\n')

// base64 rather than interpolating the script: it survives the trip through
// JS → sh -c → file without anything re-interpreting quotes or backslashes.
const resolve = inImage(
  `set -o pipefail
pip install --quiet --dry-run --report /tmp/r.json -r requirements.txt >/dev/null 2>/tmp/err || { cat /tmp/err; exit 1; }
echo ${Buffer.from(DUMP).toString('base64')} | base64 -d > /tmp/dump.py
python /tmp/dump.py`,
  { timeout: 300_000 },
)

check(`pip can resolve requirements.txt on ${IMAGE}, quickly`, resolve.ok,
  resolve.ok ? 'resolver found a consistent set'
             : (resolve.out.match(/ERROR: (?:Cannot install|ResolutionImpossible).*/)?.[0]
                ?? resolve.out.trim().split('\n').slice(-3).join(' | ')
                ?? 'timed out backtracking').slice(0, 300))

const resolved = new Map(
  resolve.out.split('\n').filter(l => l.includes('==')).map(l => l.trim().split('==')),
)

// ─── 2. It resolves to the line the code is written against ─────────────────

section('2. The resolved versions match the line the code runs on')
{
  // Series, not exact versions: patch and minor drift is fine, a silent jump
  // to a different major of the LLM framework inside the agents container is
  // not. Both the 0.3 and 1.x lines import cleanly, which is exactly why the
  // resolved series has to be asserted rather than assumed — nothing would
  // otherwise notice production quietly changing line.
  const EXPECTED_SERIES = {
    'langchain':              '0.3',
    'langchain-core':         '0.3',
    'langchain-anthropic':    '0.3',
    'langchain-openai':       '0.3',
    'langgraph':              '0.6',
    'langchain-google-genai': '2.',
    'langfuse':               '4.',
  }
  for (const [pkg, series] of Object.entries(EXPECTED_SERIES)) {
    const got = resolved.get(pkg)
    check(`${pkg} resolves on the ${series}x line`,
      !!got && got.startsWith(series),
      got ? `resolved ${got}` : 'not in the resolved set')
  }

  // The mixed set that broke the dev venv installs happily and only shows up
  // here: langchain-anthropic 0.3.x forbids langchain-core 1.x, but pip will
  // leave that unsatisfied if the two are installed in separate steps.
  const consistent = inImage(
    'pip install --quiet -r requirements.txt >/dev/null 2>&1 && pip check',
  )
  check('the installed set is internally consistent (pip check)', consistent.ok,
    consistent.ok ? 'no broken requirements'
                  : consistent.out.trim().split('\n').slice(0, 2).join(' | ').slice(0, 300))
}

// ─── 3. The app imports under exactly that set ──────────────────────────────

section('3. The agents app imports under the resolved set')
{
  // Resolution succeeding still does not mean the code runs: langchain 1.x
  // moved imports around. main.py pulls in every route module, so importing it
  // exercises the whole surface in one line.
  const boot = inImage(
    'pip install --quiet -r requirements.txt >/tmp/i 2>&1 || { tail -5 /tmp/i; exit 1; }; ' +
    'cd /tmp && cp -r /agents/app /agents/main.py . && ' +
    'python -c "import main; print(\'IMPORT_OK\', len(main.app.routes), \'routes\')"',
  )
  check('main.py imports cleanly (every route module loads)',
    boot.ok && boot.out.includes('IMPORT_OK'),
    boot.ok ? boot.out.trim().split('\n').pop()
            : boot.out.trim().split('\n').slice(-4).join(' | ').slice(0, 300))

  // The `langchain` meta-package is in requirements.txt for exactly one
  // reason: langfuse's LangChain integration needs it. If that import breaks
  // the pin has no purpose, and tracing goes dark silently — which is the
  // failure mode app/tracing.py was written to shout about.
  const lf = inImage(
    'pip install --quiet -r requirements.txt >/dev/null 2>&1; ' +
    'python -c "from langfuse.langchain import CallbackHandler; print(\'LANGFUSE_OK\')"',
  )
  check('langfuse CallbackHandler imports — tracing will not go dark',
    lf.ok && lf.out.includes('LANGFUSE_OK'),
    lf.ok ? 'langfuse.langchain loads' : lf.out.trim().split('\n').slice(-3).join(' | ').slice(0, 300))
}

report('Agents dependency resolution')
