# Langfuse eval harness

Offline evaluation for every LLM surface in the product — document
classification and obligation extraction at one end, conversational chat at the
other. Cases live in `datasets/*.json`, run against the real product, and land
in Langfuse as a **dataset run** you can compare against every previous run.

Strategy, the online half, and where this came from: `docs/operations/LANGFUSE-EVALS.md`.

```bash
pnpm langfuse:up                                   # local Langfuse (once)
pnpm evals:push                                    # corpus → Langfuse
pnpm evals:selftest                                # prove the harness works — no model, no cost
pnpm evals:run -- --dataset extraction             # real run (needs agents-service + a key)
pnpm evals:run -- --dataset chat --run-name pr-482
```

## Why this is not `dataset.runExperiment()`

The Langfuse SDK has an experiment runner. It traces the task function *in the
calling process* — but our task function is an HTTP call to a service that
produces its own trace, with the prompts, token counts and cost in it. Using
the SDK would create a hollow JS wrapper trace next to the real one and score
the wrong one.

So the harness runs the product, **finds the trace the product emitted**, and
attaches the run item and scores to that. Four endpoints over `fetch`, no new
dependency — which also keeps it usable in the fork PRs that cannot read
secrets.

## Layout

| File | |
| --- | --- |
| `lf.mjs` | Langfuse HTTP client — datasets, items, run items, scores, trace lookup |
| `targets.mjs` | How a case is executed: `classify`, `obligations`, `chat`, `stub` |
| `scorers.mjs` | Deterministic scorers + the LLM judge and its rubrics |
| `push.mjs` | `datasets/*.json` → Langfuse (idempotent) |
| `run.mjs` | Execute a dataset as a run, score it, report |
| `selftest.mjs` | Grades the harness itself — registered as `langfuse-harness` (t2) |
| `datasets/` | The corpora |

## A case

```json
{
  "id": "clf-nda-mutual",
  "target": "classify",
  "input":  { "plainText": "MUTUAL NON-DISCLOSURE AGREEMENT …" },
  "expectedOutput": { "contractType": "NDA" },
  "scorers": ["field_match:contractType", "not_empty:reason", "latency_ms"],
  "metadata": { "addedAt": "2026-08-29", "difficulty": "easy" }
}
```

`id` is yours and stable. Langfuse upserts on it, so re-pushing edits in place
instead of duplicating the corpus — which is what lets a case keep its score
history across an edit. Rename an id and you have created a new case with no
past.

The file format is JSON, not the YAML `docs/37` ADR-01 anticipated: the
workspace has no YAML parser, JSON is the dataset API's own wire format, and
promptfoo — the off-ramp the ADR was protecting — reads JSON too.

## Scorers

Deterministic first. A judge is for questions a string comparison cannot
answer; reaching for one where `field_match` would do buys nondeterminism,
latency and a model bill for nothing.

| Scorer | |
| --- | --- |
| `field_match:<path>` | `output[path]` equals `expectedOutput[path]`, case-insensitive |
| `contains:<path>` | output contains the expected substring |
| `not_empty:<path>` | field present and non-empty |
| `json_subset` | every leaf of `expectedOutput` appears in output (arrays: length only) |
| `tool_used:<name>` | the chat turn called that tool |
| `no_tool` | the turn answered without calling anything |
| `latency_ms` | recorded as a metric; never fails a case |
| `judge:groundedness` | every claim traceable to the source — catches fluent invention |
| `judge:correctness` | same substance as expected |
| `judge:helpfulness` | useful to a busy contracts lawyer |
| `judge:citation` | points at the clause it relied on |

The judge uses `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_API_KEY` (in
that order), overridable with `EVAL_JUDGE_MODEL`. **Prefer a judge from a
different family than the system under test** — a model grading its own output
scores it generously, which inflates every number in the suite.

With no key, judge scorers **skip**. They never score 0. "Could not check" and
"checked and fine" must not share an exit code, and neither may "could not
check" and "checked and broken".

## Exit codes

`run.mjs` exits non-zero when a case **errors**, or when `--threshold` is given
and the pass rate falls short. Failing assertions alone do not fail the run.

That is deliberate. A judged corpus is a measurement, not a gate: you read it by
comparing this run to the last one in the UI. Wiring a quality score to a
pass/fail exit code is how assertions get loosened until they stop
discriminating — the failure ADR-01 was written to avoid. Use `--threshold` when
you want a floor (a nightly, say), not on every PR.

`selftest.mjs` is the opposite and *is* a gate: its outcomes are known in
advance, so it exits non-zero the moment the harness misgrades one.

## Adding a surface

1. Add a function to `TARGETS` in `targets.mjs` returning `{ output, sessionId, meta }`.
2. Add a `datasets/<name>.json` whose cases use it.
3. `pnpm evals:push && pnpm evals:run -- --dataset <name>`.

Return a real `sessionId` if the surface has one — that is how the run links to
the product's own trace rather than a harness stand-in. Endpoints with no
session concept get one via the `x-eval-session-id` header, which
`apps/agents/main.py` binds to the request's traces.

## Trace linking, and the `[harness]` marker

Each line of a run prints `[product]` or `[harness]`:

- **`product`** — linked to the trace the agents service emitted. Prompts, token
  counts and cost are all in it. This is what you want.
- **`harness`** — the product's trace could not be found within
  `--trace-wait-ms` (default 20s), so the case is anchored to a trace the
  harness made from its own view. The score is still valid; the trace has no
  model internals.

All `[harness]` usually means the agents service is running without Langfuse
configured, so it never traced at all. Ingestion is asynchronous — a couple of
seconds is normal, and the poll exists because reading once attributes every
fast case to "no trace found".
