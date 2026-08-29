# 39 — The eval programme: what to build, in what order, and what to decline

Forward plan. `docs/38` is the gap analysis; this is the sequencing.

Built from: 89 state-of-the-art practices researched across benchmark design, judge
calibration, agent evaluation, production monitoring and legal-AI compliance; a
dependency analysis; and three hostile reviews (a VP of Engineering on cost, an
enterprise legal buyer on what could not be substantiated, an eval methodologist
on measurement validity). Every repo claim below was verified directly.

---

## 0. The target is not "state of the art"

Most published eval practice is built for frontier labs shipping general models to
millions of users. Copying it here produces an expensive apparatus nobody reads —
the exact failure `docs/37` already documented once.

**The target is *defensible*:** every number we publish survives a hostile question
from a customer's security reviewer, and every number we act on is one we have
shown can move for the right reasons. In places that is a lower bar than SOTA. In
others it is higher — most public benchmarks could not survive this repo's own
rule that an assertion must be watched failing before it is trusted.

### The constraint that shapes everything

`git shortlog`: **196 of 199 commits by one person**, repo 3.5 months old. This is
a ~1.1-engineer team. Any plan written for an eval team is fiction. Every item
below is costed against one person, and the largest section of this document is
**what to decline**.

### The advantage that shapes everything else

Harvey pays attorneys to grade a benchmark. **Our product is a workflow in which
lawyers and contract managers grade AI output as their job** — review-queue
verify/reject, redline accept/discard, approval agreement, invoice reconcile.
That is a continuous expert-label stream a benchmark company has to fund.

It is also **being destroyed daily by overwrite semantics.** Preservation is on
the critical path to everything judge-related, and it looks like a 20-line chore.

---

## Wave 0 — Not evals. Defects the eval work uncovered.

These outrank the entire measurement programme. Two are security findings.

### P0-1 · BYOK resolution failure must fail closed

`apps/agents/app/router.py:277-284` (verified). On **any** generic exception from
the Node resolve — unreachable, bad `INTERNAL_SERVICE_SECRET`, 503 — the router
falls through to `_platform_resolve(tier)`, abandoning the org's BYOK key and
their `OrgAiSettings` tier override, and sending counterparty contract text to
whichever provider the platform env holds a key for. It logs a `warning`.

For a product whose pitch is *"your contracts never leave your servers"*, and
where a customer DPA may name one specific subprocessor, this is a path to
unauthorised disclosure that records itself as a log line.

`ModelOverrideUnavailable` and `CostCapExceeded` are already correctly re-raised
with reasoning in the comments. **BYOK resolution failure must join them.**

*Cost: hours. Priority: highest single item in this document.*

### P0-2 · Provenance must be unwritable by the client

`apps/api/src/routes/agent-threads.ts:133-142` accepts `provider`, `model`,
`tier`, `inputTokens`, `outputTokens`, `costUsd` and `traceId` as **optional
client-supplied fields**, and `:288-297` persists all seven verbatim (verified).

`docs/38` framed this as "the model field is a hardcoded literal." That is the
symptom. The defect is that **the browser is the system of record for provenance,
and the field is unauthenticated** — any user with a session can POST an arbitrary
model name, cost or trace id onto an assistant turn.

The fix is not "populate it correctly". It is:
- the server derives provider/model/tier/tokens from the router resolution,
- the API **rejects** those keys in the request body (drop them from
  `AppendTurnSchema`, `.strict()` the object),
- a gated test asserts a forged POST is refused.

*Cost: 1–2 days.*

### P0-3 · EU AI Act Article 50(1) disclosure

Article 50(1), (2) and (5) became applicable **2 August 2026** (verified against
the Commission's transparency guidance and multiple legal analyses). Today is
later than that. Providers of AI systems that interact directly with natural
persons — chatbots, assistants, agents — must ensure users are informed they are
interacting with an AI system unless it is obvious from context, and compliance is
expected to be built into the system rather than disclosed in terms.

If we have or want EU customers, this is live and overdue. It is also the best
legal-risk-reduction per line of code on the entire list.

*Cost: hours. Also write the Article 4 per-feature limitations sheet (1–2 days)
and a documented high-risk classification memo (~1 day) — which will almost
certainly conclude "outside Annex III", but "documented no" and "never looked" are
different postures in procurement.*

### P0-4 · Stop destroying the expert labels

Every day of delay burns gold that cannot be recovered:

| Fix | Why |
|---|---|
| `review-queue.ts` writes an audit event | Currently zero (verified). A re-extraction takes the human verdict with it |
| Verify-with-correction records the original | "Accepted as-is" and "accepted after fixing it" are currently indistinguishable, and the correction pair — the most valuable training signal in the product — is discarded |
| `approvalRecommendation` into `APPROVAL_DECIDED` metadata | Two lines. The column is mutable, so a re-run invalidates every historical pairing |
| Redline ledger stops overwriting | `_playbookRedline` is one JSON key replaced wholesale; only the latest run's verdicts survive |
| `reviewState` enum split | `onReject` and `onMarkReviewed` both write `'reviewed'` (verified `ContractDetailPage.tsx:3009-3017`) — "I disagree with this risk flag" and "I skimmed it" are the same row |
| **Preserve `extractedConfidence`** | See below — this one is the precondition for the whole agreement programme |

### The review queue destroys the calibration dataset on write

Three defects, all verified in `apps/api/src/routes/review-queue.ts`. Together they
mean the agreement dashboard as originally scoped measures **anchoring, not accuracy**:

1. **The predictor is overwritten by the label.** Verify sets `confidence: 1`
   (`:179`), reject sets `confidence: 0` (`:221`). The extractor's *original*
   confidence — the only thing you would regress the human verdict against — is
   destroyed the instant a human touches the row. "Is the extractor right when it
   says it is confident?" is **unbuildable from this table**, retroactively and
   going forward, until this stops. Every already-reviewed row is unrecoverable.
   **Fix: store `extractedConfidence` alongside, never overwrite it. Two fields.**

2. **The obvious join key is wrong.** Reject *also* sets `verifiedBy` and
   `verifiedAt` (`:225-227`), deliberately, so the queue skips the row. Anyone
   building "agreement rate" by joining on `verifiedBy` **counts every rejection
   as an agreement** — the headline lands near 100% and is pure artifact.

3. **The sample is censored by the metric's own parameter.** `:122-124` skips
   anything at or above `q.threshold`, and defaults a missing confidence to `1`.
   So humans only ever see the extractor's least-confident output: "agreement
   rate" is really *agreement conditional on the extractor being unsure*. It
   moves when someone edits a config default, and it moves **the wrong way under
   improvement** — a better-calibrated extractor pushes easy wins above
   threshold, leaving a queue enriched in genuinely hard cases, and the dashboard
   shows quality falling. Any extraction path writing no confidence is invisible
   to review and would enter a calibration curve as maximally confident.

*Cost: 3–4 days total. Do this before anything in Wave 2 — and note that (1) is
losing data every day it waits.*

---

## Wave 1 — Make the instrument trustworthy (2–3 weeks)

Nothing measured before this is interpretable.

### 1.1 · Freeze the clock, then repair the grader, then measure the noise floor

**Order matters and the intuitive order is wrong.**

- ~~The corpus re-anchors to today, so a re-run measures date drift.~~
  **Wrong — corrected 2026-08-18.** The anchor is FIXED at 2026-04-27 and
  `SEED_TODAY` is opt-in, so a same-day re-run is stable and the noise floor is
  *not* contaminated by this. What decays is the gap between pinned data and the
  real clock: eleven time-relative asks now select against windows their data no
  longer covers. That is a comparability problem across months, not a run-to-run
  one — so it does not block the noise floor, and `run-personas.mjs` refuses
  to score a corpus in that state rather than reporting a number from it.
- On a corpus where a refusal passes 53 of 91 asks, **refusals are the stable
  outcome** — measuring flip rate before repairing the grader yields a falsely
  low number and calibrates the instrument against its own defect. **Repair
  first.**

Grader repair: set `gracefulEmptyOk: false` where a shrug is wrong, purge
refusal-matching phrases from the 53 affected `mustMentionAny` lists, use the
`forbiddenTools` grader (0/152 uses) and `shouldNotMention` (1/152), and assert
on `t.args` — already captured, never read.

**Report `strictPass` as the primary number** — the pass rate computed with
`gracefulEmptyOk` forced false — and keep the permissive rate as a diagnostic
that never appears in a summary line, because the summary line is the number
that gets quoted. Gate `shrugPass` separately, with its own direction: **it must
not rise.**

Two further grader defects, both verified:

- **`notHallucinated` is inert by construction.** `lib-multi.mjs:161-168` fails
  only when `thisTurn.size === 0`, so **any** tool call disarms it — a turn that
  runs `contract_search`, finds nothing, then says *"I've created the draft"*
  passes. This is the product's only fabrication test, it is used on 5 rows, and
  on those rows it is disabled whenever the agent does anything.
  **Fix:** scope it to the absence of a *write* tool
  (`contract_create_from_template`, `contract_update`, `redline_apply`,
  `approval_decide`, `request_create`), not the absence of any tool. One set
  intersection; converts a decorative check into a real one. `e14-grader-truth`
  is the place to prove it fails first.

- **Latency is inside the correctness pass rate.** 153 rows carry
  `maxLatencyMs` (118 at 60s) and `lib-multi.mjs:167` pushes a latency miss into
  the same `fails` array as "text missing". A slow runner or a degraded provider
  therefore fails rows **in correlated bursts**, which invalidates any binomial
  interval over the corpus, makes a latency regression indistinguishable from a
  correctness one — and, critically, **would record infrastructure variance as
  model variance during the noise-floor measurement**, producing a permanently
  inflated floor that hides real regressions.
  **Fix before measuring the floor:** latency gets its own report and its own
  gate. Correctness and latency must never share a denominator. (This is the
  same rule as `docs/38`'s "keep operational metrics out of the quality score",
  which we identified and did not act on.)

Then run the corpus twice unchanged and publish the **verdict flip rate**. This
is a **go/no-go for everything downstream**: at a 15% flip rate the Wave 2 judge
is dead on arrival, because you cannot calibrate a judge against a corpus noisier
than the effect you are trying to detect.

*Cost: 1 week. Cheapest high-value item in the plan.*

### 1.2 · Meter at the chokepoint, not at 200 call sites

**Do not edit ~200 call sites.** It will be at ~20 in six weeks and nobody will
know which 20. Also: `recordUsage` currently ends in `.catch(() => {})`, and
extending a silently-failing write to 200 sites in a repo whose culture is
"watched failing before trusted" is self-contradictory.

Instead:
- put the meter in `aiRouter.ts` (258 lines, one chokepoint) as a wrapper,
- add a **t1 static check that fails when a new model call site bypasses the
  router** — the same shape as `l13-dead-names`, which already works,
- add one t2 check that makes a call and asserts a row appeared, so metering can
  fail loudly.

Note this needs a **new per-call table**. `OrgUsageDaily` is a daily aggregate
with a 7-column unique key written by upsert-increment; metering `/complete`
(per keystroke-pause) through it would contend every call from one org on one
row. This is a migration, a retention policy and a hot-path write — not a
3-day task.

Build it once and it satisfies **EU AI Act Articles 12/19/26(6)** logging with
six-month retention as a side effect. One build, two motivations.

*Cost: 1 week.*

### 1.2b · Do not put the persona corpus behind the baseline ratchet yet

`run.mjs:323` fails the build when `now.total < was.total`. That ratchet is
correct and it is why coverage cannot silently shrink — but it cuts the wrong way
here. **The moment 152 loosely-graded asks are inside `--check-baseline`,
tightening a rubric that then fails is classified as a regression**, and the path
of least resistance becomes leaving it loose forever. You would freeze the defect
into the gate.

Wire the deterministic suites first (`w0-4-injection`, `apps/web` vitest — both
green means something). Hold the persona corpus back until its grader is repaired
and `strictPass` is the reported number.

*This also matters because the persona pass rate is currently **structurally
non-decreasing under evasion**: the cheapest way to raise it is a prompt edit that
makes the agent hedge more, which is exactly what teams do in week three of an
eval push.*

### 1.3 · Archive the dead coverage

**153 verify scripts exist; 149 have not been touched since the initial import
commit** (verified). They are one-shot probes written to confirm a fix. Wiring
them produces a permanently red job within a week.

Pick at most 5 that assert something nothing else does and add them to
`manifest.mjs` with declared `needs`. **Move the rest to `scripts/archive/`** so
they stop reading as coverage in the next audit.

*Cost: 1 day.*

---

## Wave 2 — First real quality numbers (4–6 weeks)

### 2.1 · A pinned golden set, and the retrieval ceiling

20–30 queries with **expected record IDs** against a frozen corpus snapshot. This
is the only route to knowing what the agent misses, and Ironclad gives customers
exactly this advice: label a few dozen contracts by hand and measure against them.

Then run the **oracle-context ablation** — feed the generator the correct passages
and re-score. The gap between that and the live score separates "retrieval never
found it" from "generation mangled it", which are different fixes.

Compose the set from the **real work distribution**, not from imagination: pull
the top action types from the audit log, weight by frequency × contract value at
risk. This will almost certainly show the current corpus over-weights
single-clause extraction and under-weights the multi-contract portfolio questions
procurement actually asks.

*Cost: 1 week engineering + 2–4 days of domain-expert time. The expert time is
the real constraint and cannot be substituted.*

### 2.2 · Split answer score from source score

Harvey's most transferable idea. Two orthogonal numbers, never blended:

- **Answer score** — what fraction of a correct work product did it produce?
- **Source score** — what fraction of correct statements are backed by a valid,
  specific citation?

With negative points for hallucination, justified by reviewer labour: a wrong
statement costs a human time to find and fix, so it must score *worse* than
silence, not merely no better.

We can run this at **passage-level strictness where Harvey had to fall back to
document-level**, because every CLM assertion has a canonical anchor — contract
id + clause + character span. That is a genuine structural advantage over legal
research products.

*Cost: 1 week, on top of the golden set.*

### 2.3 · The two security dimensions

- **Read-permission containment** — the same query as two identities with
  different entitlements, including a judge asking whether restricted content
  leaked into the *prose* while citations were filtered. Highest-severity
  dimension, zero coverage today.
- **Injection resistance** — `w0-4-injection.mjs` already exists and is in no
  tier. Gate it, and re-run it on every model change: injection resistance is a
  model-level property that moves between versions without warning.

*Cost: 3–4 days.*

### 2.4 · Ship the agreement view as a product feature, not an internal dashboard

**This is a correction to `docs/38`.** I recommended an internal agreement
dashboard twice. For a **self-hosted AGPL product whose pitch is "your contracts
never leave your servers"**, the four human-verdict signals live in *customers'*
Postgres instances. We cannot query them. The one instance we can query is
dev-scale — 107 agent turns, of which the audit found 9 carrying a (fabricated)
model.

The fix is a reframe, and it is better than the original:

- **Ship it to customers** as "how your AI is performing on your contracts" —
  extraction accuracy against their own verifications, redline accept rate,
  approval agreement. Every enterprise legal buyer wants this and no competitor
  hands it over. It turns the blocker into a differentiator.
- **Opt-in aggregate telemetry** gives us the cross-customer view, with no
  contract content leaving the customer's server.

Note the historical rows are **not merely sparse, they are wrong** — see the three
review-queue defects in P0-4. The naive join reports near-100% agreement because
rejections are stamped `verifiedBy`, and the sample is censored to the extractor's
least-confident output. Ship none of this before P0-4 lands, or the first number
the customer sees will be flattering and false.

*Cost: 1–2 weeks as a product feature. Prioritise against the roadmap, not
against the eval backlog.*

---

## Wave 3 — Judges, only where no human confirms (quarter+)

A judge is only worth building for surfaces where **no human verdict arrives on
its own**: chat, RAG, search. Everywhere else the label stream is free and a judge
is a worse, more expensive approximation of it.

When we do build one:
- **binary pass/fail with FAIL as the positive class**, reporting TPR and TNR —
  never "alignment %", which is dominated by the majority class,
- **chance-corrected agreement** (Cohen's κ; quadratic-weighted for ordinal
  rubrics) as the headline, with the **human–human agreement floor measured
  first** — low IAA means a broken rubric, not a broken model,
- **claim-level groundedness** via atomic decomposition, not response-level
  faithfulness, because a claim can be supported by a chunk from the *wrong
  version* — the failure that matters most in a contract product,
- **position-bias audit** — run both orderings, count only order-consistent
  verdicts,
- a **frozen human-labelled test set** the judge prompt never sees.

*Cost: 2+ weeks, and it is blocked on Wave 0's label preservation.*

---

## What we are declining, and why

Naming these so they can be refused confidently rather than re-litigated.

| Declined | Why |
|---|---|
| **Wiring `audit-contract-ai.mjs`** | Its `--regress` floors are **n/n — exact perfection on 12 of 12 fixtures** for `counterparty extracted`, `governing law`, `value`, `clauses > 0` (verified `:489-502`), on an LLM pipeline whose noise floor is unmeasured. It also needs Gotenberg, absent from CI. Gate on it and you get an unattributable weekly red build, and the human response to a flaky gate is `continue-on-error` — the `\|\| true` pattern this repo just spent a wave deleting. **Keep it as a manual diagnostic.** |
| **Wiring the 149 stale verify scripts** | Untouched since import; permanently red within a week. Archive them. |
| **Judge juries / PoLL** | 3× judge cost to diffuse a bias we have not measured. One judge calibrated against real lawyer verdicts beats three calibrated against nothing. |
| **The alt-test** | Answers "can the judge replace the annotator?" — a question we do not have, because our annotator is a user doing their job. |
| **PPI++ / Rogan-Gladen correction** | Exists to stretch a *scarce* human-label budget. Ours is a workflow byproduct. Optimising the wrong constraint. |
| **Pairwise-preference / Elo infrastructure** | Right for holistic taste, wrong for auditable surfaces. An Elo pipeline over a 5-persona corpus is theatre. |
| **50–100 runs per task** | Research budget. Five runs over a ~30-ask core buys most of the information at ~15% of the spend — and paid calls are budgeted here. |
| **1–5% production sampling** | Actively wrong for this traffic profile. Contract review is low-volume and high-value: **sample at 100%** and control cost by tiering — deterministic scorers on everything, LLM judges only on the flagged subset. |
| **OTel GenAI semconv conformance as v1** | Every `gen_ai.*` attribute is still stability level *Development*. Borrow the field names; do not chase conformance. |
| **ISO/IEC 42001 certification** | Defer until a named deal gates on it. |
| **Batch-invariant kernels / temperature-0 determinism work** | Impossible on a hosted API, and our variance is dominated by retrieval and prompt effects orders of magnitude above float reduction order. |

---

## What "done" means per wave

| Wave | Done when |
|---|---|
| **0** | BYOK fails closed; provenance is server-derived and a forged POST is refused by a gated test; the AI-interaction disclosure ships; no expert verdict is destroyed by a re-run |
| **1** | The corpus is pinned to a snapshot; the grader no longer passes a refusal on an answerable row; **a published flip rate exists**; every model call is metered through one chokepoint and a t1 check fails if a new one bypasses it |
| **2** | A retrieval ceiling number exists; answer and source scores are reported separately; a read-permission test runs; the injection suite gates |
| **3** | A judge exists for chat/RAG with its κ, TPR and TNR published beside every number it produces, against a measured human agreement floor |

---

## The honest summary

We are not one quarter from state of the art and should not aim to be. We are:

- **days** from closing two security defects that outrank every measurement
  question here,
- **weeks** from an instrument whose numbers can be interpreted at all,
- **a quarter** from being able to answer "what is your recall on obligation
  extraction?" — the question an enterprise buyer asks first and which today has
  no answer and no method to produce one.

The single largest lever is not a technique from any benchmark paper. It is that
our users are domain experts grading AI output every day, and we are throwing
their verdicts away. Stop doing that first.
