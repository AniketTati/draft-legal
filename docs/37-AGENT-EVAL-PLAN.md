# 37 — Agent eval suite (Gap #3)

**Status:** planning, 2026-08-08. Follows `docs/36-AGENT-LOOPS-PLAN.md` (complete).
**Source:** `docs/33-AGENT-GAP-AUDIT.md` gap #3.

---

## The audit's premise does not survive contact with the code

Gap #3 reads:

> We cannot claim quality, swap models, or safely edit the 240-line system prompt
> without measurement. The harness is already built and running in CI — guarding
> four toy cases. Convert the existing manual-audit rules into ~50 real cases
> against the live HTTP path.
> **Builds on:** `evals/runner.py` harness + `EVAL_USE_HTTP` plumbing (exists).
> **Effort:** 1–2 weeks to meaningful coverage.

Four claims, checked one at a time:

| Claim | Reality |
|---|---|
| "running in CI" | **False.** Zero references to `eval` anywhere under `.github/`. The only Python job runs `pytest tests/ -v --tb=short \|\| true` (`ci.yml:161`) — and `apps/agents/tests/` does not exist. Its own comment admits it: *"tests/ does not exist yet — this step reports nothing today."* |
| "guarding four toy cases" | **False twice over.** It guards nothing, and the four cases are not merely toys — they are tautologies. `echo_runner` (`runner.py:106-114`) is the identity function, and the case asserts the output equals the input. `synthetic_obligations_runner` (`:117-140`) is a substring matcher (`if "pay" in text ... append({"type": "payment"})`) and the case asserts the type it just hardcoded. **These cases cannot fail.** |
| "`EVAL_USE_HTTP` plumbing (exists)" | **True only for `/extract_obligations`.** One runner, one endpoint. Nothing in `evals/` references `/agent/chat` or `run_agent_chat_stream`. |
| "Builds on … 1–2 weeks" | Understated in one direction, overstated in another — see below. |

**And the audit missed the thing that matters most.** There is a *second*, far more
capable agent-eval harness already in this repo, at `scripts/persona-tests/`:
`lib.mjs:40-135` streams `POST /api/v1/agent/chat`, reassembles `token` deltas,
and joins `tool_call_start`→`tool_call_result` by id into a `tools[]` array.
`lib-multi.mjs` adds multi-turn conversations on one `sessionId`, `expectedTools`
with OR semantics, `cumulativeTools`, `contextWords` (turn N references turn N−1),
`notHallucinated`, and `maxLatencyMs`. There are **66 committed conversations** in
`conversations.mjs` plus ~86 more asks across five persona files, against a 70 KB
seeded fixture (`apps/api/scripts/seed-personas.ts`, 800 contracts / ~470
counterparties / 20 users / 5 orgs).

So Gap #3 is **not** "build an eval suite." It is:

> **Consolidate two half-harnesses, make the result observable, and put it behind
> a gate that can fail.**

The Python package has the schema, the baseline, and the regression check but no
agent-loop capability. The JS harness has the agent loop, the SSE parser, the
multi-turn model and real coverage — but no schema, no baseline, no CI, and no
record of what it measured. Neither can currently tell you whether a change made
the agent better or worse.

---

## E1 — Nothing runs, and the step that would run it cannot fail

**Severity: Critical.** This is the whole gap in one line.

`ci.yml:155-161`:

```yaml
- name: Run agent tests
  working-directory: apps/agents
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  # Still non-blocking, and tests/ does not exist yet — this step reports
  # nothing today. The two steps above are what actually guard this job.
  run: pytest tests/ -v --tb=short || true
```

Three independent reasons this measures nothing: the directory does not exist,
nothing invokes `evals/`, and `|| true` forces exit 0 regardless. **Any eval
suite added to this step inherits a step that cannot fail the build.**

Adding ~50 cases before fixing this produces fifty more dead controls — the exact
defect class `docs/36` spent four waves removing. **E1 ships first, alone, with a
deliberately failing case to prove the gate bites.**

**The fix.** Invoke the suite directly, blocking, in its default no-LLM mode:

```yaml
- name: Agent evals (synthetic — no model calls)
  working-directory: apps/agents
  run: python -m evals.cli --check-baseline
```

Measured cost of the default mode: **no services, no API key, $0, well under a
second.** The synthetic runners exist precisely so this is free. There is no
argument for leaving it out of CI.

**How we check it** — `scripts/evals/e1-gate-bites.mjs`
1. Introduce a case that must fail; assert `python -m evals.cli` exits non-zero.
   **Before:** exit 0. Revert-verify by restoring `|| true` and watching it pass.
2. Assert the CI workflow contains no `|| true` on the eval step, scoped to that
   step's own block — not a file-wide grep, which would match other jobs.
3. Assert the step's `run:` names `evals`, so renaming the module breaks loudly.

**Effort:** half a day.

---

## E2 — Nothing records which model answered

**Severity: Critical.** Ship immediately after E1; everything downstream depends on it.

`orchestrator.py`'s `done` frame carries only `session_id`. `agents.ts:236-240`
states the problem in its own comment: *"the SSE stream doesn't echo the resolved
pair back."* So when a case flips, **you cannot distinguish a prompt regression
from a model swap from a key rotation.** A baseline without this is uninterpretable,
and a "model swap" eval — the audit's own stated motivation — is impossible.

It is worse than unrecorded; it is *unstable*. `router.py:113-124` `_platform_resolve`
returns the **first provider in the tier list that has an env key**, order
anthropic → openai → google → openrouter. The identical case resolves to
`claude-sonnet-4-6` in CI and `gpt-4.1` on a dev box with only `OPENAI_API_KEY`.
**Adding a secret to the repo silently changes every eval result.** And when
`orgId` is passed, the model comes from an `OrgAiSettings` row in Postgres, so
results become a function of seeded DB state.

`orchestrator.py:735-741` compounds it: `model_id` → tier is decided by substring
sniffing (`"mini"`/`"haiku"`/`"flash"` → fast). Pinning `gpt-4.1-mini` silently
selects the *fast* tier, which then resolves to whatever that tier's key order
picks — possibly not that model at all.

**The fix.** Put `provider`, `model`, `tier` and `source` (`byok` | `platform`) on
the `done` frame and in every stored eval result. `/extract_obligations` already
returns `model` and `provider` (`obligations.py:151-152`); the chat path does not,
and `evals/cli.py:73-76` discards the ones it does get.

**How we check it** — `scripts/evals/e2-model-observability.mjs`
1. Drive a real turn; assert the `done` frame carries all four fields and that
   `model` is a non-empty string that appears in the provider catalog.
2. Force a different tier and assert the recorded model changes accordingly —
   a field that always reports the same string is not observability.
3. Assert a stored result round-trips the pair into `baseline.json`.

**Effort:** 1 day.

---

## E3 — The persona suite has never run on the model it reports

**Severity: High.** A live bug, found while scouting.

`lib-multi.mjs:55-61` calls:

```js
const r = await askAgent({
  token, sessionId, message: turn.ask, agentMode: true,
  provider: 'openai',
  modelId: 'gpt-4.1-mini',
})
```

`askAgent`'s destructured signature (`lib.mjs:40-48`) is
`{token, sessionId, message, agentMode, contractId, pageContext, timeoutMs}`.
**`provider` and `modelId` are not parameters and are silently discarded**, and
the request body (`:53-66`) never includes them. Verified directly.

So the 66-conversation suite has been running on the Python defaults
(`chat.py:26-27` → anthropic / `claude-sonnet-4-6` → tier `default` → org config)
the entire time, while `docs/research/persona-test-report.md` implies
`gpt-4.1-mini`. **Every cost and latency number in that report is attributed to
the wrong model.**

This is the same defect class as `docs/36` L6: a control that looks wired, is not,
and reports success. It is worth fixing before any of those numbers are used to
justify a decision.

**The fix.** Accept `provider`/`modelId` in `askAgent` and forward them; then
re-run the suite and correct the report — or delete the pin and state plainly
that the suite runs on org defaults. Either is honest; the current state is not.

**How we check it** — extend `scripts/evals/e2-model-observability.mjs`
1. Pin a provider through `askAgent` and assert the `done` frame (E2) reports it.
   **Before:** the pin is discarded and the frame reports the default.
2. Assert the report's stated model matches what a run actually records.

**Effort:** half a day, plus a re-run.

---

## E4 — A case with no assertions passes

**Severity: High.**

`runner.py:222-226`:

```python
if not checks:
    ...
    return True, 0.0, [], "WARNING: case has no expectations"
```

Verified by execution: such a case reports `passed=True`, and the warning reaches
neither the failure count nor the exit code. In a suite of fifty hand-written
YAML cases, someone will omit an `expected` block, and it will **inflate the pass
rate rather than fail**.

Compounding it, the schema has **no required fields at all** — `name`, `input`,
`expected` and `metadata` each have a silent default (`runner.py:168`, `:266`,
`:195`). Any new field an agent-chat case needs (`turns`, `expected_tool_calls`,
`denied_tools`) can be added to YAML today and will be **silently ignored rather
than rejected**. That is how a case ends up asserting nothing while looking
thorough.

**The fix.** Invert the empty-expectations default to a failure, and validate the
case schema strictly — unknown keys are an error, not a shrug.

**How we check it**
1. A case with no `expected` block fails, and the suite exits non-zero.
2. A case with a misspelled key (`expectd:`) is rejected by name, rather than
   silently running with zero assertions.

**Effort:** half a day.

---

## E5 — Deleting a case is an undetectable way to go green

**Severity: High.**

`cli.py:161-168` compares `prev_passed & now_failed`. The regression gate works —
verified: flipping an expected value produced `REGRESSION: … PASS → FAIL` and
exit 3. But the loop iterates `_all_agents()`, which reads directories **off
disk**. Verified: deleting the entire `obligations` cases directory produced
`no regressions (checked 2 agents)` and **exit 0**. Deleting one of two cases: same.

So the gate protects against a case flipping to fail, and against nothing else.
Coverage loss reports as success.

**The fix.** Record case *names and count* in the baseline, and fail when a
previously-present case disappears without an explicit `--accept-removal`.

**How we check it**
1. Delete a case; assert non-zero exit naming the missing case.
   **Before:** exit 0, "no regressions".
2. Rename a case; assert it is reported as removed+added rather than silently
   swapped.

**Effort:** half a day.

---

## E6 — The graders cannot express the assertions the suite needs

**Severity: High.**

Only two graders exist, and they are **not pluggable** despite the registry:
`GRADERS` (`graders/__init__.py:74-77`) is shadowed by a hardcoded `if/elif`
dispatch in `runner.py:207-212` that raises `AssertionError` on anything else.
Every new grader is two edits, and the second is easy to forget.

`contains` is narrower than its name suggests. It requires **exact string
equality** on an item's `type`/`kind`/`category` (`graders/__init__.py:60-63`).
Probed live: `contains("payment", [{"type":"payment"}])` → True, but
`contains("pay", …)` → **False**, and `contains("50k", [{"description":"pay 50k"}])`
→ **False**. `_extract_field` walks dicts only, so `obligations.0.type` → `None`.

Consequently the only proposition currently assertable about the obligations agent
is *"an obligation whose `type` equals exactly X exists."* You cannot assert on
description, grounding quote, due date, owner, severity or section reference; you
cannot assert a **count**; and with no negation grader you **cannot write a single
hallucination test** — which is the assertion that matters most for an agent.

**The fix.** Delete the `if/elif` and dispatch through the registry, then add:
`not_contains` (hallucination), `json_subset`, `regex`, `tool_call` (E7),
`count`, and a `model_graded` judge reserved for the few cases where wording
genuinely varies. Support list indexing in field paths.

**How we check it**
1. Each new grader has a positive and a negative fixture — a grader that always
   returns True passes half of any test suite.
2. A grader registered in `GRADERS` but absent from any dispatch chain is
   reachable — assert by registering a probe grader and invoking it.
3. `not_contains` fails on a known hallucination fixture and passes on a grounded
   one.

**Effort:** 2 days.

---

## E7 — Two harnesses, and no decision about which survives

**Severity: High (decision, not code).**

| | Python `apps/agents/evals/` | JS `scripts/persona-tests/` |
|---|---|---|
| Case schema + YAML | ✅ (unvalidated — E4) | ❌ cases are JS literals |
| Baseline / regression | ✅ (blind to deletion — E5) | ❌ none |
| CI | ❌ | ❌ |
| Agent-loop / SSE | ❌ protocol is sync `(dict)->(dict,float,float)` | ✅ `lib.mjs:40-135` |
| Multi-turn | ❌ | ✅ `lib-multi.mjs:41-57` |
| Tool-call assertions | ❌ | ✅ `expectedTools`, `cumulativeTools` |
| Negative assertions | ❌ | ✅ `notHallucinated`, `shouldNotMention` |
| Latency gate | ❌ | ✅ `maxLatencyMs` |
| Seeded fixtures | ❌ | ✅ `seed-personas.ts`, 800 contracts |
| Real coverage | 4 tautologies | 66 conversations + ~86 asks |

**Recommendation: keep the JS harness as the agent-loop runner, and give it the
Python package's three missing pieces** (declarative cases, a baseline, a CI gate).
Rebuilding the SSE parser, multi-turn model, tool assertions and 800-contract
fixture in Python to preserve a package whose only real asset is `cli.py`'s
150-line baseline diff would be the more expensive direction by a wide margin.

Keep `evals/` for **single-shot endpoint** evals (`/extract_obligations` and
siblings), where it already works and costs nothing to run.

This is the first decision to make, and it is reversible only expensively. It
should be made explicitly rather than by accretion.

---

## E8 — An eval run has no identity, and would spend real money

**Severity: Critical for anything that makes real model calls.**

Confirmed against `router.py`, `costCap.ts` and `internal-ai.ts`:

- **The daily cost cap would block an eval run, and now fails closed.** `/resolve`
  answers 429 on breach; `router.py` raises a dedicated `CostCapExceeded` that
  bypasses the blanket fallback (this was `docs/36` L11 — deliberate). A breach
  **kills the run mid-suite**, and every case after that point fails as "runner
  raised" rather than as a model regression. Failures after the first would be
  misattributed.
- **The default is the cap.** An org with no `OrgAiSettings` row gets **$50/day,
  policy `block`**. Creating a fresh eval org does not opt out — it opts in.
- **Running under a real customer org spends that customer's BYOK key**, and the
  cap cannot stop it: BYOK is returned *before* `assertCostCapNotExceeded` is
  reached. Worse, no caller passes `isByok`, so `recordUsage` still increments
  the **platform** counter — the eval gets the customer's bill *and* fills the
  platform budget.
- **There is no eval identity at any layer.** The one HTTP runner sends no
  `orgId`, and `obligations.py:39` defaults it to `None`. A suite that starts
  passing a real `orgId` inherits cap enforcement, BYOK consumption and
  org-scoped tool results all at once — none of which this harness has exercised.

**The fix.** A dedicated eval org, seeded, with an explicit `OrgAiSettings` row
(raised cap or `capPolicy: 'warn'`), a platform key, and **no `OrgAiKey`** so it
can never reach a customer's provider account. Pass `isByok` correctly at the
recording site so the platform counter means what it says.

**How we check it** — `scripts/evals/e8-eval-identity.mjs`
1. The eval org resolves `source: 'platform'`, never `'byok'`.
2. With the cap set below the run's cost, the suite reports **"halted: cost cap"**
   as a distinct outcome rather than N spurious case failures.
3. Assert no `OrgAiKey` row exists for the eval org — the guard that stops a
   future misconfiguration billing a customer.

**Effort:** 1 day. **Do not run any real-LLM eval before this lands.**

---

## E9 — There is no model key in CI, and the repo is public

**Severity: Medium, but it bounds the whole design.**

`ci.yml:158` references `secrets.ANTHROPIC_API_KEY`. **That secret does not exist**
— the repository has exactly five secrets and it is not among them, there are no
environments, and the org-secrets API returns 422 (user-owned repo). It
interpolates to an empty string today.

And the repository is **public**, so secrets are unavailable to `pull_request`
runs from forks. A real-LLM eval gated on a secret would be green-but-meaningless
for every outside contributor.

**Consequence for the design, and it is a good one:** the **blocking** CI gate must
be the **synthetic, $0, no-service** suite. Real-LLM evals run **nightly on
`main`** (or on a `push` to a maintainer branch), where secrets exist and a fork
cannot see them. This is the right split anyway — a suite that costs money and
varies run-to-run does not belong in the path of every PR.

**Effort:** none (a design constraint), plus whatever it takes for a human to add
a key for the nightly job.

---

## E10 — Cost is structurally zero, so cost cannot be gated

**Severity: Medium.**

`runner.py:13` documents `"total_cost_usd": 0.0042`, but every runner returns
`0.0` — including the real HTTP one (`cli.py:76`) — and `baseline.json` shows
`0.0`. The endpoint returns `model` and `provider` but no token counts, and the
runner discards even those.

`score` has the same shape of problem: it is computed (`runner.py:228-229`) and
reported, and **never compared to anything**. There is no threshold, no minimum
pass-rate gate, no latency gate. Anything the plan says about "quality above 0.8"
is net-new logic, not configuration.

**The fix.** Return usage from the chat path (it is already recorded for the cost
cap — `recordUsage` has the numbers), thread it into the result, and add
threshold/latency gates that read it.

**Effort:** 1 day, after E2.

---

## E11 — Nothing controls sampling, and that is a product decision

**Severity: Medium.**

`grep -rn "temperature\|top_p\|seed"` across `apps/agents` (excluding `.venv`)
returns **zero matches**. `build_llm()` (`providers.py:187-232`) takes
`(provider, model_id, streaming, api_key)` and passes **no sampling parameters**.
Every LLM call in this system runs at the provider default — 1.0 for Anthropic
and OpenAI chat.

This is not "unconfigured", it is "not plumbed": adding it is a signature change
to the provider factory that ~25 routes and the orchestrator inherit. And you
probably do **not** want `temperature=0` in production drafting, so evals need a
**per-call override**, not a global default.

**The counter-argument, which I think wins for most cases:** the persona harness
already encodes a cheaper answer to nondeterminism — write assertions loose enough
that a correct-but-differently-worded answer passes (`mustMentionAny` for
synonyms, `gracefulEmptyOk` defaulting true, `notHallucinated` requiring both a
claim *and* zero tool calls). Its own comment is the rationale: *"LLM variance
means search-precision drops in/out across runs; the rubric should accept honest
empty answers as correct rather than penalising for word-choice differences."*

**Recommendation:** do E11 last, and only for the subset of cases where loose
assertions genuinely cannot discriminate. Sampling control is the expensive
answer to a problem good assertions mostly solve.

**Effort:** 1–2 days if pursued.

---

## Ordering

**Wave A — make it able to fail (2 days).** E1 gate, E4 empty-expectations,
E5 deletion blindness. No new cases. Ends with a deliberately-failing case
turning CI red, then removed.

**Wave B — make it interpretable (2 days).** E2 model observability on the `done`
frame, E3 the discarded persona pin, E10 cost + thresholds.

**Wave C — decide and consolidate (1 day + build).** E7. Then give the surviving
harness declarative cases and a baseline.

**Wave D — make it safe to run for real (1 day).** E8 eval identity, E9 nightly
split. **Nothing hits a real model before this.**

**Wave E — coverage.** Only now do the ~50 cases the audit asks for, drawn from
the A1–A13 prompt rules and the 16 `scripts/agent-loops/` checks. E6 graders land
alongside, driven by what the cases actually need rather than speculatively.

**Revised effort: 3–4 weeks**, against the audit's 1–2. The difference is entirely
Waves A–D, which the audit assumed were already done.

---

## The through-line

`docs/36` ended with thirty-eight assertions that passed against broken code —
about one in seven of everything written, none caught by review or CI. Gap #3 is
the structural answer to that, and it deserves the same discipline applied to
itself: **every eval case must be shown to fail before it is trusted**, and the
suite must be able to fail the build, or it is one more control that looks wired
and is not.
