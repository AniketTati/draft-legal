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

## E7 — Two harnesses ✅ DECIDED — see ADR-01 below

**Resolved 2026-08-08.** JS harness survives; Python `evals/` is retired. The
comparison that led there is kept for the record.

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

**Decided: the JS harness survives** and gains declarative cases, a baseline and
a CI gate. `evals/` is retired rather than kept for single-shot endpoints — a
second harness maintained for four tautological cases and a 150-line baseline
diff is negative value. Single-shot endpoint evals become ordinary cases in the
one suite, calling the Python endpoint over HTTP like any other.

Full reasoning in ADR-01.

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


---

## ADR-01 — One suite, three tiers, JavaScript, with record/replay

**Decision made 2026-08-08.** Superseded framing: E7 asked "which harness
survives." That was the wrong question. The right one is *what seam do we test
at, and how do we make agent behaviour deterministic enough to gate a PR on.*

### Decision

1. **One suite, in TypeScript/JavaScript, testing through the public HTTP API.**
   Retire the Python `evals/` package; port its baseline-diff concept (~150 lines).
2. **Three tiers, split by cost and determinism, not by subject.**
3. **Record/replay of model responses** is the mechanism that makes tier 2
   possible. This is the load-bearing choice.
4. `scripts/agent-loops/` and `scripts/persona-tests/` are absorbed into the
   suite. They already *are* the eval suite; nobody named them that.

### Why the public HTTP API, and not in-process Python

This is the argument that actually decided it. **Look at where the defects were.**
Of everything `docs/36` found and fixed:

| Defect | Lives at |
|---|---|
| Cross-tenant write in `/api/v1/agent/draft` (status 200, victim contract mutated) | **Node route** |
| VIEWER could create contracts by asking | **Node** — `agents.ts` `denied_tools` |
| Write-tool RBAC | **Node** — `agent-threads.ts` is the *only* layer that sees caller role |
| Cost cap failing open, BYOK bypass | **Node↔Python boundary** |
| Thread poisoning, memory growth | Python, but observable through the chat API |
| Nine dead controls | **Web UI** |

An in-process Python harness is **on the wrong side of the boundary for almost
every bug this system has actually had.** It structurally cannot see RBAC, the
cost cap, tenancy enforcement, or the proxy. A suite that cannot test the
security-critical layer is not the suite this product needs.

The HTTP API is also the seam the *user* experiences. Testing there means the
eval measures the product rather than an implementation detail, and survives the
Python service being refactored or replaced.

### Why JavaScript

Not preference — grain. **The repo has 23 JS check scripts and zero Python
tests.** The seed fixture is TypeScript. The API and web are TypeScript. Every
piece of verification culture this codebase has built over four waves is in
`.mjs`. Fighting that is a tax paid on every future check.

Cost of the choice, both directions:
- **Choosing JS:** reimplement `cli.py`'s baseline diff. ~150 lines. Once.
- **Choosing Python:** reimplement the SSE parser, the multi-turn engine, the
  tool-call assertions, and rewire an 800-contract fixture — all of which exist
  and work in JS today. Then maintain a Python test culture that currently has
  zero examples.

The counter-argument is that model-eval libraries (ragas, deepeval) are Python.
It does not bind: those consume **traces and datasets**, not your runner.
Langfuse is already wired into the orchestrator, so traces are the integration
point regardless of harness language. Keeping the case format as **YAML** also
keeps the commercial off-ramp open — promptfoo, the most likely one, is JS +
YAML natively.

### The three tiers

| | What it tests | Model | Cost | Runs |
|---|---|---|---|---|
| **T1 — Invariants** | tenancy, RBAC, gating, schema truth, dead controls, prompt-vs-reality | none | $0 | **blocking, every PR** |
| **T2 — Contract** | the agent loop: tool selection, confirm-gating, error frames, memory reuse, budget caps | **replayed** | $0 | **blocking, every PR** |
| **T3 — Behavioural** | is the answer *good*; model comparison; regression in quality | real | real | **nightly on `main`** |

**Correction to the above, made while writing this and worth keeping.** My first
draft said "T1 exists already — it is the 16 `agent-loops` checks." That is too
clean. Those checks are a *mix*: some are pure static file analysis and genuinely
free (`l13-dead-names`, `l6-dead-controls`), while others drive real chat turns
against a live stack and a real model (`l1`, `l2`, `l9`, `l10`, `l12`) — which
makes them T3 by this plan's own definition, not T1. **Classifying each existing
check into a tier is a Wave C task, not a given**, and a quick grep is not
sufficient to do it: probing `login()`/`API}` misfiles the Playwright check as
static and `l7-prompt-truth` as stack-dependent. Each has to be read.

One genuine enabler, verified: **`ci.yml` already stands up Postgres
(`pgvector/pgvector:pg16`) and Redis** as services for the `test-api` job
(`ci.yml:63-83`), with `DATABASE_URL` and `REDIS_URL` wired. So the infrastructure
for stack-dependent checks in CI is not net-new — it exists and is proven in this
workflow. What is missing is the agents service and a model key, which is exactly
the T2/T3 boundary: replayed fixtures need neither.

### Record/replay is the decision that makes this work

The central problem with agent evals is that the model is nondeterministic, so
you cannot gate a PR on it. The usual answers are both bad: `temperature=0`
(doesn't make tool-calling deterministic, and is not how production runs), or
assertions loosened until they stop discriminating.

The right answer is to **separate the two questions**:

- *"Does my code do the right thing given what the model said?"* — tool dispatch,
  the confirm gate, RBAC, error surfacing, memory replay, budget enforcement.
  **This is most of the agent, it is entirely deterministic, and it is where
  every bug in `docs/36` actually lived.**
- *"Is what the model said any good?"* — genuinely model-dependent, genuinely
  expensive, genuinely noisy.

Record real model responses once; replay them to answer the first question on
every PR for free. Reserve real calls for the second, nightly.

**This is cheap here because of a fact I checked: `build_llm` has exactly one
caller** — `router.py:345`. A single injection seam covers every LLM call in the
entire system. That same seam is what E11 wanted for sampling control, so E11
stops being "plumb temperature through 25 routes" and becomes "add one factory
override" — more valuable, and less invasive.

Recorded fixtures are committed, reviewable, and diffable. When a prompt change
alters which tool the model picks, that shows up as a **fixture diff in code
review** — which is a far better signal than a flaky nightly number.

### What this changes in the plan

- **E7 is decided.** No consolidation study; JS wins, Python `evals/` is retired.
- **New E12 — the replay seam**, promoted into Wave B. It is the highest-leverage
  item in this plan and the audit did not contemplate it.
- **E11 is reframed** from sampling control to the injection seam, and merges
  into E12.
- **E9's constraint becomes a feature.** No model key in CI and a public repo
  forced the tiering; T1+T2 need no key at all, so fork PRs get the *same*
  blocking gate as maintainers. That is strictly better than a secret-gated suite.
- **Wave E shrinks.** Many of the "~50 cases" the audit wants are T2 contract
  cases against replayed fixtures — cheaper to write and to run than the audit
  assumed, and they never flake.

### What I am accepting as risk

- **Fixture staleness.** Replayed responses drift from what models actually do.
  Mitigated by T3 nightly against real models, which is precisely the tripwire
  for "the recording no longer reflects reality," and by re-recording on a
  cadence rather than on demand.
- **Recording captures a bug as expected behaviour.** Same failure mode as a
  snapshot test. Mitigated by the `docs/36` rule: every case must be shown to
  fail before it is trusted — a fixture that cannot produce a red is not evidence.
- **T2 cannot catch prompt regressions that change model behaviour** — by
  construction, since the model is replayed. That is T3's job, and the split
  should be stated in the suite's own README so nobody mistakes a green T2 for
  "the prompt is fine."

## E13 — a client-supplied `modelId` never reaches model selection

**Severity: unknown — needs a product decision before it is a defect.**
**Found 2026-08-08 while building the E2 check.**

Probed four turns through `POST /api/v1/agent/chat` with `modelId` set to
`claude-opus-4-reasoning`, `gpt-5-turbo`, `claude-haiku-4-5-20251001`, and
omitted. **All four resolved identically**: `tier=fast`,
`model=gemini-2.5-flash`, `provider=google` — and the requested `model_id`
echoed back on every frame was the service default (`gemini-2.5-pro`) in all
four cases, including the ones where a different value was sent.

So either the pin is dropped between the Zod schema (`agents.ts:25` accepts
`modelId`, `:135` forwards it as `model_id`) and `chat.py`, or org AI settings
override it downstream. The orchestrator's own tier sniffing
(`orchestrator.py:738-744`) would map `claude-opus-4-reasoning` to `reasoning`
and `claude-haiku` to `fast`, so it is not being consulted with the requested
value.

**Why this is not filed as a bug yet.** Org-level AI settings arguably *should*
win over a client-supplied model — that is a reasonable product stance, and
letting any caller pick the model has cost and safety implications. But the
current behaviour is the worst of both: the pin is accepted, echoed back
inaccurately, and silently ignored. Whatever the intended rule is, the API
should either honour the pin or reject it.

**This matters for evals specifically.** The audit's stated motivation for gap
#3 is *"swap models"*. If a test cannot pin a model, model comparison is not
possible at all — it would compare two runs of whatever the org config says.
E13 has to be resolved before any model-swap eval means anything.

**How we check it** — once the intended rule is decided
1. If pins are honoured: a pinned model is what the `done` frame reports.
2. If pins are refused: the request 400s naming the field, rather than being
   accepted and ignored.
3. Either way: the echoed request metadata must not report a value that was
   not used.

**Partly resolved 2026-08-08.** Two distinct layers, one of which was a plain
bug and is fixed:

1. **FIXED — `chat.py` discarded valid pins.** The provider auto-fallback
   overwrote `req.model_id` *unconditionally* whenever it swapped provider.
   `DEFAULT_PROVIDER` is anthropic, so on a deployment holding a **single
   provider key** — the common case, and this workspace — **every request took
   that branch and every model pin in the product was discarded**, including
   pins perfectly valid for the provider actually in use. Because the model id
   is also what the orchestrator sniffs to pick a tier, this destroyed the
   caller's tier signal too. Now it substitutes only when the requested model
   does not belong to the resolved provider. Verified: `gemini-2.5-flash` used
   to echo back as `gemini-2.5-pro`; it now echoes correctly.

2. **OPEN — the platform tier table, not the caller, chooses the final model.**
   With the pin now arriving intact, both `gemini-2.5-pro` and
   `gemini-2.5-flash` still resolve to `gemini-2.5-flash` at tier `fast`, on an
   org with **no `OrgAiSettings` row at all** — so this is the platform tier
   default, not org config. Whether a caller should be able to override it is a
   genuine product decision: org-level cost control is a legitimate reason to
   say no. **But a model-comparison eval is impossible until it is settled**,
   which is the audit's own stated motivation for this gap.

**Effort:** the remaining half is a decision, not code.

---

## E12 — the replay seam ✅ BUILT 2026-08-08 — `e12-replay.mjs` 15/15

**Working:** `apps/agents/app/replay.py`. `AGENT_REPLAY_MODE=record` captures
real model responses to `apps/agents/evals/replay/<session>.json`;
`AGENT_REPLAY_MODE=replay` serves them back. **Verified: a recorded turn
replays identically three times in 6-8 ms with EVERY model API key unset**, and
a missing fixture fails loudly naming the expected path rather than falling
back to a live call.

**Keyed on `(session_id, call_index)`, not a hash of the messages.** Hashing was
the obvious design and is wrong here: the system prompt is in every message
list, so editing one line of a 240-line prompt would invalidate every fixture
and force a full re-record — making replay annoying enough that people stop
using it. Call-order keying means a prompt edit invalidates nothing (consistent
with ADR-01: tier 2 is deliberately blind to prompt regressions) while still
catching the code making a different NUMBER or ORDER of model calls, which is a
real behavioural change. Callers key by choosing a stable `sessionId`; nothing
else needed plumbing, because session_id already reaches the router as
`thread_id`.

**A design error worth recording.** The seam was first placed at `build_llm` —
the single chokepoint, which looked obviously right. It was too deep: with no
API key the service raises *"No LLM API key found"* before the router is
consulted at all, so replay still required a key, which defeats the entire
point of a tier that runs free and keyless on fork PRs. Caught by blanking
every key and watching a replay run 500. It now short-circuits in `resolve_llm`
above provider and key resolution, and `chat.py` skips provider validation
under replay.

**CORRECTION.** This section previously reported tool-call recording as broken,
diagnosed to `RecordingChatModel._astream`. **That was wrong, and diagnosed
from a single sample.** Probing the recording chain directly showed it captures
tool calls correctly, and re-recording end to end produced a clean two-call
fixture: call 0 with two `contract_search` invocations, call 1 with the prose
answer. The original empty fixture was simply the model declining to call a
tool for that prompt — a model response, not a defect. Diagnosing from one
observation is how the plan acquired a false claim of its own.

**Tool-call replay verified working.** A replayed turn dispatches its recorded
tools in 34 ms with no API key — and, importantly, **the tools genuinely
execute**: `contract_search` hits the real database and returns real rows. Only
the model is replaced. That is precisely the seam that makes tool dispatch, the
confirm gate and RBAC testable without a model, which is the whole point of
tier 2.

**A precondition, not an assumption.** `/health` now advertises `replayMode`,
and the runner treats it as a `needs` entry. With replay off, `e12-replay`
SKIPS — verified. A tier-2 check that silently ran against a live model would
burn quota and vary run to run while reporting as a free deterministic gate.

**One classification error surfaced by the gate itself.** `l2-redline-propose`
was filed t2 because it never calls `/agent/chat` — but it reaches a model
*indirectly*, through the `redline_propose` tool, and under replay produced a
502 from the upstream tool rather than a meaningful failure. Moved to t3.
Indirect model dependencies are the classification trap here, and the tier
gate is what found it.

**Measured:** tier 1 — 5 checks, 54 assertions, sub-second, keyless.
tier 2 — 5 checks, 75 assertions, ~35 s, keyless.

---

## Ordering

**Wave A — make it able to fail (2 days).** E1 gate, E4 empty-expectations,
E5 deletion blindness. No new cases. Ends with a deliberately-failing case
turning CI red, then removed.

**Wave B — make it interpretable (2 days).** E2 model observability on the `done`
frame, E3 the discarded persona pin, E10 cost + thresholds.

**Wave B — make it interpretable and deterministic (4 days).** E2 model
observability, E3 the discarded persona pin, **E12 the replay seam** (ADR-01),
E10 cost + thresholds.

**Wave C — consolidate (3 days).** Absorb `agent-loops` and `persona-tests` under
one runner, one YAML case format, one baseline. Retire Python `evals/`.

**Wave D — make real runs safe (1 day).** E8 eval identity, E9 nightly split.
**Nothing hits a real model before this.**

**Wave E — coverage.** The cases: T2 contract cases against replayed fixtures for
the A1–A13 rules and the write-tool gate; T3 behavioural cases from the persona
conversations. E6 graders land alongside, driven by what cases actually need.

**Revised effort: 3–4 weeks**, against the audit's 1–2. The difference is Waves
A–D, which the audit assumed were done — plus the replay seam, which it did not
contemplate and which is what makes the PR gate possible at all.

---

## The through-line

`docs/36` ended with thirty-eight assertions that passed against broken code —
about one in seven of everything written, none caught by review or CI. Gap #3 is
the structural answer to that, and it deserves the same discipline applied to
itself: **every eval case must be shown to fail before it is trusted**, and the
suite must be able to fail the build, or it is one more control that looks wired
and is not.
