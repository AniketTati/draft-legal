# Langfuse eval + observability harness

Evaluation and production analysis for every LLM surface in the product —
document classification and obligation extraction at one end, the in-editor AI
Assistant and the conversational Chat Agent at the other.

Strategy and where this came from: `docs/operations/LANGFUSE-EVALS.md`.

```bash
pnpm langfuse:up          # local Langfuse, once
pnpm evals:setup          # corpora + dashboards + always-on judges (idempotent)
pnpm evals:check          # before you ship — gates on failure
pnpm evals:review         # what production did (add --score to judge it first)
```

That is the whole day-to-day surface. `pnpm evals` lists everything else —
traffic generation, human annotation, promotion, run comparison — each still a
single-purpose script you can run directly.

| Command | When | What it does |
| --- | --- | --- |
| `evals:setup` | once, and after changing rubrics | Pushes the golden corpora, builds both dashboards, registers Langfuse's own continuous evaluators |
| `evals:check` | before shipping · in CI | Self-tests the harness, then runs the curated corpora. Non-zero exit on real failure |
| `evals:review` | daily / after a release | Volume, cost, latency, errors, quality by surface, plus findings |

### Why there are two judges

`evals:setup` registers evaluators **inside Langfuse**, which score new traffic
by themselves. `pnpm evals score` does the same grading from a script. Both
exist on purpose, and they are not redundant:

- **The Langfuse evaluators are the default.** Always on, no one has to remember
  anything, and they keep working when nobody is looking at the repo.
- **The script is for CI and for backfills** — it needs no UI configuration,
  version-controls with the code, and can re-score a window you have already
  collected (after fixing a rubric, say). An in-platform evaluator only ever
  sees new data.

Both read the same rubric text from `scorers.mjs`, so a `groundedness` from
either means the same thing. If they ever disagree, that is a bug, not a signal.

### Three sources of quality signal, and why you need all three

| | Catches | Blind to |
| --- | --- | --- |
| **Judge** (`score-production.mjs`) | Anything a rubric anticipated, at scale, cheaply | Failures nobody wrote a rubric for. Is itself sometimes confidently wrong. |
| **Human** (`annotate.mjs`) | Everything, including what the rubrics missed | Doesn't scale. Slow. |
| **User** (`POST /api/v1/agent/feedback`) | What actually mattered to the person who asked | Sparse, biased toward extremes, no explanation |

The judge is the only one that scales, which is exactly why it needs the other
two: the human labels tell you whether to believe it, and the user votes tell
you whether it is measuring anything people care about.

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
| `traffic.mjs` | Drive real user journeys across every surface (dev only — spends budget) |
| `analyze.mjs` | The production review, out of the metrics API |
| `score-production.mjs` | Judge every step of real traces and post the scores (online eval) |
| `annotate.mjs` | Human annotation queue + judge-vs-human calibration |
| `score-sessions.mjs` | Grade whole conversations — context carried across turns |
| `evaluators.mjs` | Register Langfuse's OWN continuous evaluators (runs without us) |
| `promote.mjs` | Promote failing production traces into the golden corpus |
| `compare.mjs` | Diff two dataset runs — aggregate and per-case |
| `dashboards.mjs` | Create the standing dashboard via the API |
| `datasets/` | The corpora |

## Generating a traffic corpus

`traffic.mjs` uses your real contracts when you give it a corpus file. Produce
one from the local database:

```bash
docker exec clm_postgres psql -U clm -d clm_dev -tAc "
select json_agg(row_to_json(t)) from (
  select c.id, c.title, c.type, c.\"counterpartyName\", c.\"orgId\", c.\"expiryDate\"::text,
         left(regexp_replace(v.\"plainText\", '\s+', ' ', 'g'), 3500) as text
  from contracts c join contract_versions v on v.id = c.\"currentVersionId\"
  where v.\"plainText\" is not null and length(v.\"plainText\") > 400
  order by c.type, random() limit 40) t;" > corpus.json
```

Without `--corpus` it falls back to two synthetic contracts, so the script runs
anywhere — but the analysis is only about *your* system if you feed it your data.

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
| `judge:groundedness` | every claim traceable to the source — catches fluent invention *(a.k.a. faithfulness)* |
| `judge:correctness` | same substance as expected *(a.k.a. answer correctness)* |
| `judge:helpfulness` | useful to a busy contracts lawyer |
| `judge:citation` | points at the clause it relied on *(a.k.a. attribution)* |
| `judge:tool_selection` | **step-level** — was calling this tool the right move? *(a.k.a. tool-call accuracy)* |
| `judge:retrieval_sufficiency` | **step-level** — did the tool return what was needed? *(a.k.a. context recall)* |
| `judge:instruction_following` | did it do what was actually asked, in the form asked? |
| `judge:legal_caution` | analysis vs unhedged legal advice — a legal-product risk |
| `judge:pii_restraint` | personal data it did not need to repeat |
| `judge:professional_tone` | would a partner send this to a client unedited? |
| `judge:session_coherence` | **session-level** — context carried across turns *(a.k.a. multi-turn coherence)* |

The last two grade an **observation inside a turn**, not the final answer, and
they exist to split one failure into two. "The agent was wrong" has two causes
with opposite fixes: the tool returned bad data, or the tool returned good data
and the model misread it. One score on the answer cannot tell them apart. On the
first real run this paid for itself immediately —
`renewal_advice · retrieval_sufficiency 4/4` next to
`agent.chat · groundedness 7/10` says the lookup was fine and the reading was
not, which points at the tool's *description* rather than its query.

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
