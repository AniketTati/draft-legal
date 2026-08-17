# Agent eval suite

Runs the checks in `manifest.mjs` by tier and produces an exit code CI gates on.
Design and reasoning: `docs/37-AGENT-EVAL-PLAN.md`, ADR-01.

```bash
node scripts/evals/run.mjs --tier t1                    # static, free, no services
node scripts/evals/run.mjs --tier t1,t2                 # + stack, still no model
node scripts/evals/run.mjs --tier t1 --check-baseline    # fail on regression or coverage loss
node scripts/evals/run.mjs --tier t1 --baseline          # accept the current state
```

## Tiers — cost and determinism, not subject

| | Needs | Cost | Runs | Size (2026-08-16) |
|---|---|---|---|---|
| **t1** | nothing | $0 | blocking, every PR (incl. forks) | 5 checks · 58 assertions |
| **t2** | Postgres, API, replay fixtures | $0 | blocking, every PR | 13 checks · 172 assertions |
| **t3** | all of the above + a model key | real money | nightly on `main`, never a PR | 11 checks · 235 assertions |

t1 and t2 need **no API key**, which is what makes them safe to block fork PRs
on — this repo is public, and forks cannot read secrets.

A t2 check may stub the model rather than replay it. `l15-empty-turn` drives
`run_agent_chat_stream` with a stub LLM and `needs: ['venv']` only — no
database, no API, no key — which is how model-response HANDLING gets tested on
every PR while the model itself stays out of the loop.

**The nightly t3 workflow is not enabled**, and would fail on first dispatch:
`.github/workflows/nightly-evals.yml` has no `services:`, no install and no
service boot, so every check skips and `--strict` turns that into exit 1. Treat
t3 as "run it by hand on a booted stack" until that job is built.

## What a green t2 does NOT mean

**t2 replays the model.** It answers *"does our code do the right thing given
what the model said"* — tool dispatch, the confirm gate, RBAC, error surfacing,
memory replay. That is most of the agent, and it is where every defect in
`docs/36` actually lived.

It is **blind to prompt regressions by construction.** If you edit
`AGENT_SYSTEM_PROMPT` and the model would now choose a different tool, t2 will
not notice: it is serving a recording made before your edit. That is t3's job.
**Do not read a green t2 as "the prompt is fine."**

## Replay

```bash
AGENT_REPLAY_MODE=record  # capture real responses to apps/agents/evals/replay/
AGENT_REPLAY_MODE=replay  # serve them back; no key, no network, no cost
```

Fixtures are keyed on `(session_id, call_index)` — deliberately **not** a hash
of the messages. The system prompt is in every message list, so hashing would
invalidate every fixture on a one-line prompt edit and make replay annoying
enough that people stop using it. Call-order keying survives prompt edits while
still catching the code making a different *number or order* of model calls.

Use a stable `sessionId` (`replay:<case-name>`). The tools are **not** stubbed —
a replayed turn still hits the real database. Only the model is replaced.

A missing fixture is a loud error, never a silent live call.

## Before you push

```bash
node scripts/evals/preflight.mjs              # committed state
node scripts/evals/preflight.mjs --worktree   # include uncommitted edits
```

`git archive HEAD` into a temp dir and runs the suite there: tracked files only,
no `node_modules`, no `.venv`, a different absolute path. **A local pass does not
predict CI**, because your machine has all of those. This suite's first two CI
runs were red for exactly three reasons a local run cannot surface — a static
Prisma import in the shared harness, thirteen checks hardcoding
`/Users/<someone>/…`, and a "tier 1" check shelling out to the Python venv.

`--worktree` overlays uncommitted edits, but only **tracked** ones. A brand new
check file that has not been `git add`ed does not exist as far as preflight is
concerned — it reports the check as MISSING and fails, which is correct and is
exactly what CI would do. `git add` it first.

## Preconditions are facts, not settings

`needs` entries are probed, and each probe asserts the fact the manifest reads
it as — not a weaker one nearby. Four of them used to assert the weaker version,
and all four reported "fine" when they could not check:

| probe | asserted | should assert |
|---|---|---|
| `db` | `DATABASE_URL` is set | a database answers on that host/port |
| `playwright` | `node_modules/playwright` exists | a browser binary exists |
| `model` | a key string is non-empty | it is long enough to be a real key |
| `personas` | a login succeeds | …as the address the seeder actually creates |

The `model` one bites hardest: `router.py`'s `_platform_resolve` takes the FIRST
provider in the tier list that has a key, so a junk `ANTHROPIC_API_KEY` does not
fall through to a working one — it captures resolution and 401s every case,
which reads exactly like a model regression.

If you add a `needs` entry, probe the thing itself. A precondition that can only
ever answer one way hides the suite it guards.

## Adding a check

1. Write it in `scripts/agent-loops/` using the shared harness (`check`,
   `section`, `report`).
2. Add it to `manifest.mjs` with a tier and its `needs`. An unlisted check
   **fails the run** — a check nothing runs is the failure mode this suite
   exists to end.
3. **Watch it fail before you trust it.** Across `docs/36`, thirty-eight
   assertions passed against broken code — about one in seven — and none were
   caught by review or CI. Reverting the fix is the only thing that ever caught
   them.
4. Re-baseline: `--baseline`.

`needs` is enforced, not documentation: an unmet precondition SKIPS loudly. A
skip is never a pass — "could not check" and "checked and fine" must not share
an exit code.
