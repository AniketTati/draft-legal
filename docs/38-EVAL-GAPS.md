# 38 — AI quality: what we measure, what we don't, and what to build next

Companion to `docs/37`, which is the build log for the eval suite. This document
is about whether its numbers mean what they look like, and about the much larger
question underneath: **can we tell whether production users are getting correct
answers from ~200 AI surfaces?**

Sources: an eval-methodology review run against `main` (`f6f57a9`), and a
13-agent audit of every model call site in the repo, with three adversarial
passes over its zero-coverage claims. Every file:line in this document was
re-checked directly before being written down.

---

## The one-paragraph version

`docs/37` built an unusually good suite for *does our code do the right thing
given what the model said*. It is not a suite for *is the answer correct*, and
the two get confused because both produce a percentage. Separately, the product
has roughly 200 AI surfaces and the eval suite looks at a handful of them. And in
production we record what the AI **did** thoroughly and what **happened next**
almost not at all — so today we cannot answer "are users getting the right
outcome" for most of the product.

---

## Part 1 — Three different instruments

| | Answers | Where | State |
|---|---|---|---|
| **Integrity suite** | Does the plumbing work — tool dispatch, confirm gate, RBAC, error surfacing? | `scripts/evals`, 22 checks | Strong |
| **Behavioural corpus** | Does the agent say plausible things across 152 asks? | `scripts/persona-tests` | Exists; **runs nowhere automatically** |
| **Answer quality** | Is the answer *true*, *complete*, and *for this user*? | — | **Does not exist** |

The third row is what customers experience.

### Maturity, honestly

| Level | | Us |
|---|---|---|
| 0 | Ship on vibes | |
| 1 | A folder of prompts someone eyeballs | ← what we measure |
| 2 | Automated regression, deterministic assertions, CI-gated | ← our harness |
| 3 | Calibrated judges, per-dimension rubrics, real statistics | |
| 4 | Production sampling + human labelling + outcome metrics | |

**The harness is at 2 going on 3. What runs inside it is at 1.** That split is
worth understanding: the harness — tiers by cost and determinism, preconditions
probed as facts, skip ≠ pass, a baseline that fails on *coverage loss*, and the
rule that every assertion is watched failing before it is trusted — is better
than most teams ever build, and it cannot be retrofitted cheaply. Content is
additive. We are behind in the cheap place.

### Against the bar for a CLM product specifically

| Requirement | Status |
|---|---|
| **Groundedness** — every quoted term traceable to real contract text | **None.** Nothing reads an answer against a source. |
| **Permission containment** — the correct answer depends on who asks | **Write side only.** No read-side test, no leaked-into-prose check. |
| **Injection resistance** — documents are counterparty-supplied | **Suite exists (`w0-4-injection.mjs`), in no tier, runs nowhere.** |
| **Numeric correctness** — totals, exposure, averages | **None.** Aggregations graded by substring. |
| **Amendment / precedence** — which document controls | **None.** |

Two of those five are security properties wearing quality clothes.

---

## Part 2 — The scale nobody had counted

The audit found **145 distinct AI surfaces**. The completeness critic then found
the sweep itself had undercounted: `apps/api/src/routes/internal-ai.ts` registers
**41 POST handlers** (verified) of which the sweep captured 14, and **every
model-initiated write tool was missed** — `contract_update`, `approval_decide`,
`redline_apply`, `contract_create_from_template`, `request_create`,
`approval_route`. Realistic count is ~200.

| Kind | Count |
|---|---|
| LLM call | 95 |
| Deterministic post-process | 32 |
| Classifier | 10 |
| Embedding | 5 |
| OCR | 2 |
| Rerank | 1 |

**144 of 145 put output in front of a user.**

"Our AI" is not the search agent. It is ~200 places, and the eval suite looks at
a few dozen.

---

## Part 3 — Eval coverage

| Coverage | Surfaces |
|---|---|
| Gated in CI | 24 |
| Behavioural (persona suites only) | 44 |
| Smoke | 39 |
| **None** | **36** |
| Deterministic golden | 2 |

**39 of 145 execute on a pull request.**

### The suites that exist and run nowhere

This is the dominant pattern, and it is worse than missing coverage because it
reads as covered:

| Suite | What it does | Why it never runs |
|---|---|---|
| **Persona suites** (152 asks) | The only behavioural coverage for 44 surfaces | Tier 3; `nightly-evals.yml` has `schedule:` commented out (verified `:19-21`) |
| **`audit-contract-ai.mjs`** | **12 regression gates** with hard floors, `process.exit(1)` under `--regress` (verified `:484-518`) | In no tier, in no workflow (verified: 0 references in `manifest.mjs` and `ci.yml`) |
| **`w0-4-injection.mjs`** | Unit + structural + behavioural injection resistance | In no tier |
| **All `scripts/p*-verify.mjs`** | Per-feature probes | In no tier |
| **`apps/web` vitest** | e.g. `artifact-from-tool.test.ts` | **No web test job exists in `ci.yml`** (verified) |

Three adversarial passes tried to refute the zero-coverage claims and knocked out
44 of them — almost entirely by finding `audit-contract-ai.mjs`. So the true
picture is *less* "we never wrote tests" and *more* **"we wrote them and never
wired them"**.

### Grader defects in the corpus that does exist

- **A refusal passes most rows.** `gracefulEmptyOk` defaults true and **0 of 152**
  asks set it false; 53 of 91 `mustMentionAny` lists carry a phrase only a
  refusal matches. Now *visible* — the runner prints shrug passes — but not fixed.
- **Both negation graders are unused.** `forbiddenTools` 0/152,
  `shouldNotMention` 0/152.
- **Tool arguments are captured and never asserted on.** `lib.mjs` stores
  `t.args`; no grader reads it.
- **No noise floor.** Nobody has run the corpus twice unchanged, so no delta can
  be called real.
- **Ground truth moves.** The corpus is re-anchored to today (`c9978cd`), so
  date-dependent asks have no stable answer.

---

## Part 4 — Production: what is recorded

**There is no per-call AI record in the schema.** Chat has `AgentMessage` and
`ToolCall`. Everything else stores only the *artifact* — a summary, a risk score,
an obligation row — with no model, cost, latency, run id, or error.

### Metering covers 5 of ~200 surfaces

`recordUsage` has exactly **5 call sites** (verified): `agent.worker.ts:54`,
`agents.ts:234`, `contracts.ts:2577`, `obligation-extract.ts:166`,
`compliance-check.ts:145`.

Everything below calls a model and records **nothing** — no cap check, no usage
row, no provenance:

- `/assist-stream`, `/classify-clause`, `/complete`, `/assist`, `/compare` —
  inline editor AI. `/classify-clause` fires per paragraph and `/complete` per
  keystroke-pause, making these **the highest-volume model calls in the product**.
- `/ask`, `/portfolio-query`, `/contracts/:id/ask` — RAG answers, returned and
  discarded. **Search persists no query text at all.**
- `playbook_judge` — `JUDGE_CONCURRENCY = 6` (verified `internal-ai.ts:2145`)
  over up to 500 clauses: one request, hundreds of model calls, zero rows.
- Every embedding and rerank call, on every upload.
- `clause-propose` — and `agent.worker.ts:498` bypasses its own metering wrapper.
- `/draft` interactive (the worker's draft path *is* metered — same agent, metered
  in background, unmetered in foreground).

### Four instrumentation defects

1. **The model field is fabricated, not sparse.** `SideAgentRail.tsx:772-775`
   sends the literal `provider: 'openai', model: 'gpt-4.1-mini', tier: 'default'`
   regardless of what ran; `AgentHomePage.tsx:965` sends no model at all. On dev
   data only 9 of 107 turns carry a model, and those 9 are a hardcoded string.
   **This is `docs/37` E3 reappearing one layer down, in production.**
2. **BYOK spend hits the platform cap.** No caller passes `isByok`, so
   `costCap.ts:159` defaults it false — the bypass it documents never engages.
   Verified: `isByok` appears nowhere outside `costCap.ts`.
3. **Cost is an estimate presented as a number.** Tokens are `chars/4`, cost a
   hardcoded blend rate. No real provider usage is read anywhere.
4. **`traceId` is never written.** Verified: 0 references in `apps/web`. The
   Langfuse traces and the database cannot be joined.

### Correlation

`ToolCall.entityType` / `entityId` are **never written** (verified: 0 in
`agent-threads.ts`) — there is an index on them and it is empty. So you can go
from a thread to a tool call, but never from a contract back to the AI calls that
touched it. No `Contract`, `ContractVersion`, `Obligation`, `ContractClause` or
`ApprovalInstance` row carries a thread, message, tool-call or trace id.

---

## Part 5 — Outcome signals

### Four that already exist and can be read today

| Signal | Where | What it gives you |
|---|---|---|
| **Review-queue verify / reject** | `review-queue.ts:177,219` — writes `confidence: 1` or `0` with `verifiedBy`/`rejectedBy` | A confidence-calibration dataset: is the extractor right when it says it is confident? |
| **Playbook-redline accept ledger** | `contracts.ts:2076` — `acceptedClauseIds` against the staged proposals | Per-clause accept/discard on AI rewrites |
| **Approval recommendation vs decision** | `ApprovalInstance.approvalRecommendation` × `ApprovalStep.decision` | An agreement matrix, plus free text on every disagreement |
| **Invoice match vs reconcile / dispute** | `Invoice.matchScore` × reconcile/dispute | Clean score-vs-truth pairing — heuristic, not LLM, but structurally the one thing done right |

Each has one small flaw: the redline ledger is overwritten wholesale on re-run;
`approvalRecommendation` is mutable so a re-run invalidates the pairing (fix: add
it to the `APPROVAL_DECIDED` audit metadata, two lines); verify-with-correction
overwrites the extracted value, so "accepted as-is" and "accepted after fixing
it" are indistinguishable; and `review-queue.ts` writes **no audit event**
(verified: 0 `createAuditEvent`), so a re-extraction takes the human verdict with it.

### Five that are generated and thrown away

| Signal | What happens now | Fix size |
|---|---|---|
| **Clause deviation Accept / Dismiss** | Both handlers are `setDetail(null)`. The highest-volume AI judgement in the product, zero feedback | Add a POST |
| **Agent action Cancel** | Local state only. `ToolCall.status` has a `'cancelled'` value **nothing ever writes** (verified). A user refusing a proposed AI write is not recorded | Write the status |
| **Inline editor accept** | Tab-accept and Replace land in a version with `changeNote: 'Edited in browser'`. Nothing marks it AI-authored — the most frequent accept event, untraceable by construction | Tag the changeNote |
| **Reject vs "glanced at it"** | `onReject` and `onMarkReviewed` **both send `state: 'reviewed'`** (verified `ContractDetailPage.tsx:3009-3017`) — disagreeing with a risk flag and skimming it are the same row | One enum value |
| **Citation clicks** | Plain `<a>` tags, no handler | `onClick` → `track()` |

`telemetry.ts` exists but writes to a log file, and all **10** `track()` sites
(verified) are navigation events. Not one is an AI outcome.

Also: `Obligation` has **no PATCH route** (verified: 0 update handlers). A user
who thinks the extractor got a due date wrong has no way to say so, and
re-extraction hard-deletes and recreates, destroying history.

---

## Part 6 — How to monitor, by surface class

One dashboard will not work. Different surfaces admit different evidence:

| Class | Examples | How you know it's working |
|---|---|---|
| **A human confirms it** | Extraction fields, playbook flags, approval recommendations, invoice matches | **Agreement rate.** The human verdict is already stored — join it. Cheapest and strongest. |
| **A human accepts or edits it** | Redlines, clause proposals, ghost completions | **Accept rate + edit distance.** Needs the hooks in Part 5. |
| **Nobody confirms it** | Chat, RAG, search | **Behavioural proxies** — reformulation, decline rate, confident-on-empty. `scripts/production-health.mjs` does this today. Eventually needs sampling + human labelling. |
| **Nobody sees it** | Embeddings, chunking, classification | **Deterministic golden tests.** No user signal will ever exist. |

`scripts/production-health.mjs` covers class 3 today:

```bash
node scripts/production-health.mjs --days 30
node scripts/production-health.mjs --org <orgId> --json
```

It reports decline rate, empty turns, confident-on-empty, turns per conversation,
reformulation rate, per-tool error and empty-result rates, truncated result sets,
and attribution coverage — then prints what it does *not* measure, so the output
cannot be read as a clean bill of health. On dev data it immediately surfaced a
**12% reformulation rate** and `clause_search` returning zero results on **3 of 3**
calls.

---

## Part 7 — What has landed

| Change | Where |
|---|---|
| **Tier 2 in CI** — full stack, replay mode asserted, `--strict` | `.github/workflows/ci.yml` |
| **First Python tests in the repo**, wired in without `\|\| true` | `ci.yml`, `apps/agents/tests/` |
| Obligation extractor: deterministic half extracted to a pure `parse_obligations_response`, 21 golden tests | `apps/agents/app/routes/obligations.py` |
| Obligation persistence: pure `toObligationRows`, 19 golden tests | `apps/api/src/lib/obligation-extract.*` |
| Clause-category matching: 17 golden tests | `apps/api/src/lib/clause-category.test.ts` |
| Grader reports **how** a turn passed (`shrugPass`, `suppressed`, `nullAnswerOnly`) | `scripts/persona-tests/lib-multi.mjs` |
| `e14-grader-truth` — 39 assertions over the grader itself, mutation-proven | `scripts/agent-loops/e14-grader-truth.mjs` |
| `e1-gate-bites` extended to gate the t2 job and the Python tests | `scripts/agent-loops/e1-gate-bites.mjs` |
| Production counters over existing tables | `scripts/production-health.mjs` |

t1 went from 5 checks / 58 assertions to 6 / 108. Every new assertion was watched
failing against a real mutation before being trusted.

**One defect found by the golden tests:** `parse_obligations_response` strips code
fences before a parser that already strips them. Disabling it changes nothing —
except on one input, where a ``` inside a quoted string makes the split cut
mid-value, the parse throws, and the route's `except` turns it into
`{"obligations": []}`. A contract with obligations reports as having none,
silently. `test_fence_inside_a_string_value_should_survive` is a strict `xfail`
waiting to confirm the fix.

---

## Part 8 — What to build next

> **Superseded by `docs/39-EVAL-PROGRAM.md`.** That document sequences this work
> against the real constraints — a ~1.1-engineer team and a self-hosted product —
> and corrects two recommendations below. In short: the agreement dashboard cannot
> be internal (the data is on customers' servers; ship it as a product feature
> instead), and the noise floor must be measured *after* the grader is repaired and
> the corpus clock frozen, not alongside. It also promotes two security defects
> above all of this. Read 39 for the plan; this section remains for the reasoning.

Ordered by *unblocks-the-most-per-day-spent*, not by size.

### Tier 1 — this week. Nothing works without these.

**1. Stop lying about which model answered.** Send the real provider/model from
the rail and home page; the API already accepts them. Until this is fixed every
cost, quality and regression number is unattributable — and currently *wrong*,
not merely missing. *~1 day.*

**2. Meter every AI call.** One helper, called at all ~200 sites, writing model,
tokens, latency, error and a run id. Start with the 13 unmetered surfaces named
in Part 4. Also fix `isByok` and read real provider usage instead of `chars/4`.
*~3 days.*

**3. Wire the suites that already exist.** `audit-contract-ai.mjs` (12 gates),
`w0-4-injection.mjs`, `apps/web` vitest, and the persona suites. This is pure
wiring — the tests are written. *~2 days.*

### Tier 2 — next two weeks. First real answers.

**4. The agreement dashboard.** Join the four signals in Part 5 into one view:
extraction confidence vs human verdict, redline accept rate, approval agreement,
invoice match accuracy. **No product changes required** — the data is already in
the database. This is the first thing that answers "are users getting the right
outcome", and it answers it for the four highest-stakes surfaces. *~3 days.*

**5. Add the five discarded hooks.** Each is 1–20 lines and each creates a signal
that does not currently exist. Start with the `reviewState` enum split — one
value, and it separates "I disagree" from "I looked". *~2 days.*

**6. Measure the noise floor.** Run the persona corpus twice unchanged, publish
the verdict flip rate. One night's spend, and until it exists no experiment is
interpretable. *~1 day.*

### Tier 3 — the quarter. The things that need judgement, not just code.

**7. A pinned golden set** — 20–30 queries with expected record IDs against a
frozen corpus snapshot. The only route to a retrieval ceiling, and the only way
to catch under-retrieval. Needs someone to write down correct answers. *~1 week.*

**8. Read-permission containment tests** — the same query as two identities,
including a leaked-into-prose check. Highest-severity dimension, zero coverage.
*~3 days.*

**9. A calibrated judge for groundedness** — with human labels to check it
against, and the agreement rate published beside every number it produces. Cannot
be skipped to; needs (10). *~2 weeks.*

**10. Sampling + a human labelling stream** — 30–50 traces a week, weighted to
the suspicious strata, a fifth drawn at random. This is the slow, unavoidable
part that everything judge-based rests on. *Ongoing, ~4 hrs/week.*

### Deliberately not on this list

Buying an eval platform, building a composite quality score, or adding more
persona cases. The bottleneck is not case count — `docs/37` already learned that
the expensive work was making the suite able to run and able to fail. That lesson
generalises: **we have more tests than we run, and more data than we read.**

---

## Part 9 — How to read the numbers

| You see | It means | It does not mean |
|---|---|---|
| `t1: 108 assertions` | The layers reference real things | Anything about answer quality |
| `t2 green` | Given a recorded model reply, the code did the right thing | The prompt is fine — t2 replays a recording made *before* your edit |
| `52/66 passed` | 52 turns matched their substring rubric | 52 answers were correct |
| `passed on a shrug: 14` | 14 of those were the agent declining | 14 failures — declining is often right |
| `SKIP` | The environment could not run it | It passed |
| `declined 9.3%` | 1 in 11 turns was a "couldn't find" | The other 91% were right |
| `confident-on-empty: 0` | Nothing asserted over an all-empty result | Retrieval was complete — zero rows ≠ too few rows |
| `$0 cost` | Nothing recorded a cost | It was free |

**Three rules before quoting anything.**

1. **Never quote a rate without its denominator.** Below n≈15 supports no claim;
   below 30 gates no release.
2. **Read pass rate and shrug rate together.** They move in opposite directions
   when the agent gets evasive, and the pass rate alone cannot see it.
3. **A delta smaller than the test-retest flip rate is not a result.** That rate
   is unmeasured, so today "did this change help?" honestly answers "cannot tell".

**Which gate to trust for what you changed.**

| Changed | Trust | Why |
|---|---|---|
| Extractor parsing / persistence | The golden tests | Deterministic; a diff is exact and attributable |
| Clause-category matching | `clause-category.test.ts` | A miss is silent — the rewriter invents language with `hasPlaybook: false` |
| API / Node code around the agent | t1 + t2 | Exactly what they cover |
| A prompt, or the model | **Nothing yet** | t2 replays a recording; there is no noise floor |
| Retrieval, chunking, indexing | **Nothing** | No expected record sets exist |
| Any of the other ~160 AI surfaces | **Probably nothing** | Check Part 3 before assuming |
