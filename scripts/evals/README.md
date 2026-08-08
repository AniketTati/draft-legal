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

| | Needs | Cost | Runs |
|---|---|---|---|
| **t1** | nothing | $0 | blocking, every PR (incl. forks) |
| **t2** | Postgres, API, replay fixtures | $0 | blocking, every PR |
| **t3** | all of the above + a model key | real money | nightly on `main`, never a PR |

t1 and t2 need **no API key**, which is what makes them safe to block fork PRs
on — this repo is public, and forks cannot read secrets.

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
