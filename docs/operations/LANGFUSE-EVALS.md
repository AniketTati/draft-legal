# LLM evaluation on Langfuse

Tracing (`LANGFUSE.md`) tells you what the model *did*. Evaluation tells you
whether it was any **good** — and, more usefully, whether it is better or worse
than last week. This is the second half.

---

## 1. How teams actually do this

The pattern is consistent across Langfuse's own guidance and the write-ups
around it, and it is worth stating before the implementation because it
explains most of our design choices.

**Two loops, not one.**

| | Offline | Online |
| --- | --- | --- |
| Runs on | A curated dataset | Live production traces |
| Answers | "Did my change break anything?" | "Is it drifting? What am I not testing?" |
| When | Before you ship | Continuously |
| Cost | Bounded — you choose the corpus | Controlled by sampling |

They feed each other: production failures become dataset cases, and the dataset
stops those failures recurring. A team with only offline evals is testing
yesterday's understanding of the problem; a team with only online evals can see
quality fall but cannot safely change anything.

**The adoption order matters, and it is not the intuitive one.**
Observability → error analysis → automated evaluators → CI gates → synthetic
coverage → experiments → production monitoring. Judges come *after* you have
looked at real failures, because until then you do not know which qualities to
grade. Writing rubrics first produces scores that correlate with nothing.

**Deterministic checks carry more than people expect.** Format validity, exact
fields, tool selection, refusal behaviour — all expressible as code, all free
and perfectly reliable. The recommended shape is a cheap code pre-screen in
front of a judge, not a judge everywhere. A judge costs roughly $0.01–0.10 per
assessment and is itself nondeterministic; spending that to answer "did it
return `NDA`" is pure waste.

**Golden datasets go stale.** The discipline is to keep adding sampled recent
traces and fresh failures, stamp an `addedAt` on each item so you can see the
age distribution, and retire cases for behaviour that no longer exists. A
corpus that never changes slowly stops describing the product.

**The named pitfalls**, all of which we have tried to design against:
defining evaluation goals late; relying on a single method; letting judges drift
without ever recalibrating against human judgement; treating evals as an
engineering-only concern; and — the one that bites agent systems hardest —
only grading the final answer while ignoring intermediate steps like retrieval
and tool selection.

Sources: [Langfuse evaluation overview](https://langfuse.com/docs/evaluation/overview),
[LLM evaluation roadmap](https://langfuse.com/blog/2025-11-12-evals),
[LLM-as-a-judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge),
[golden datasets](https://langfuse.com/resources/engineering/golden-dataset-evaluation),
[observation-level evals](https://langfuse.com/changelog/2026-02-13-observation-level-evals).

---

## 2. What we built

`scripts/evals/langfuse/` — usage in its own `README.md`.

```bash
pnpm langfuse:up          # local Langfuse, once
pnpm evals:setup          # corpora + dashboards + always-on judges (idempotent)
pnpm evals:check          # before you ship — gates on failure
pnpm evals:review         # what production did
```

Three commands is the whole day-to-day surface; `pnpm evals` lists the rest.
That collapse was deliberate — sixteen entry points in `package.json` with no
indication which three mattered read as a folder of scripts rather than a
system, and the first question anyone asked was "which of these do I run?"

### Coverage — extraction through chat

| Dataset | Surface | Seam |
| --- | --- | --- |
| `draftlegal-extraction` | `/classify`, `/extract_obligations` | agents service |
| `draftlegal-chat` | `POST /api/v1/agent/chat` | public API — RBAC, cost cap and proxy all in path |
| `draftlegal-harness-selftest` | none (`stub`) | proves the harness, not the product |

Chat goes through the public API because that is the seam the user experiences
and where most of this system's defects have actually lived (ADR-01, `docs/37`).
Extraction calls the agents service directly because that *is* its seam — Node
only forwards, and nothing about the forwarding is what an extraction eval is
asking about.

### Grading

Deterministic where there is a right answer (`field_match`, `json_subset`,
`tool_used`, `no_tool`); judged where there is not (`groundedness`,
`correctness`, `helpfulness`, `citation`). Every judged score in the corpus is
one a string comparison cannot express.

Two cases exist purely to catch the failures that silence hides:

- **`obl-none-present`** — boilerplate with no duties in it. An extractor that
  must find something will invent one here, and no positive case can detect that.
- **`chat-unknowable-refusal`** — asks about a contract that does not exist. A
  confident answer is this product's most damaging possible failure, and it is
  fluent and well-formed, so only a groundedness judge catches it.

### Linking to the *product's* trace

A dataset run item must be anchored to a trace, and the valuable trace is the
one the agents service emitted — it has the prompts, tokens and cost.

Chat already carries a thread id, which becomes the Langfuse `session_id`, so
the harness finds its trace by session. Extraction endpoints had no session
concept at all: their traces existed but were unaddressable. So
`apps/agents/main.py` now binds an inbound **`x-eval-session-id`** header to the
request's traces via a ContextVar in `app/tracing.py` — reaching all ~37 LLM
call sites without touching any of them, and useful well beyond evals (it is
how you find the trace for one customer's bad extraction). An explicit
`thread_id` always wins, so a real chat session is never overwritten.

When no product trace turns up within the timeout, the harness anchors the case
to a trace of its own and marks it `[harness]`, so a case is never silently
dropped from a run. A run that quietly contains fewer cases looks healthier
than one that reports the failure.

### What gates, and what does not

`langfuse-harness` (the self-test) is registered in `scripts/evals/manifest.mjs`
as **t2** — deterministic, free, needs no model — and gates PRs. Its `langfuse`
precondition probes that the server *answers* and all three keys are present,
so an unconfigured machine gets a loud SKIP rather than a false pass.

The graded corpora deliberately **do not** gate. Quality is read by comparing
runs in the UI, not asserted once; putting a judge score behind a pass/fail exit
code is how assertions get loosened until they stop discriminating. Use
`--threshold` for a nightly floor if you want one.

---

## 3. Reviewing production

Evals tell you about the cases you curated. The review tells you what is
actually happening. Both halves are built.

```bash
pnpm evals:review                          # the five metrics, sliced by surface
pnpm evals:review -- --score --hours 6     # judge recent traffic first
pnpm evals dashboards                      # rebuild the dashboards
```

**`analyze.mjs`** reads Langfuse's metrics API and prints the five things every
LLM-analytics guide converges on — volume, latency, cost, errors, quality —
each **grouped by surface**. The grouping is the point: "average latency" is a
number that hides the one surface at 35s. It ends with mechanical findings
(p95 over 20s, cost per call over $0.02, any errors, spend concentration over
40%) whose only job is to shorten the list a human has to open.

**`score-production.mjs`** is online evaluation without UI configuration: it
samples recent traces, judges them with the **same rubrics** the offline
scorers use, and posts the scores back. Same rubric on both sides is what makes
an offline `judge:groundedness` and an online one comparable — otherwise you
have two numbers with one name.

Langfuse can also do this in-platform, and for a standing setup it should:
**Evaluators → observation-level LLM-as-a-judge**, which needs an LLM
Connection configured in the project and then runs continuously with nothing of
ours in the loop. Two things to know before turning it on:

- **Trace-level evaluators are deprecated** and stop producing results on
  Langfuse Cloud after **16 November 2026**. Use observation-level.
- **Grade the steps, not just the answer.** The pitfall that hits agent systems
  hardest is scoring only the final reply. A confidently wrong answer built on a
  bad retrieval is two different bugs, and one score cannot tell you which you
  have.
- **Sample.** At ~$0.01–0.10 per assessment, judging everything is a real line
  item. Start at 5–10%.

**`dashboards.mjs`** creates the standing dashboard — spend, calls by surface,
cost by model, cost by surface, p95 latency by surface, errors by surface,
tokens and cost over time — through the `unstable` dashboards API, so the
widget set is reviewable in code rather than clicked together per environment.
It is idempotent: a second run finds the dashboard by name and stops.

**`traffic.mjs`** exists for development only. An observability setup you have
never looked at real traffic through is a guess, and a dashboard with nothing in
it teaches nothing. It drives realistic user journeys — a contract through
intake → classify → obligations → compliance, a multi-turn portfolio
conversation, a clause through the AI Assistant — using text from the local
corpus, plus a deliberate edge-case journey (empty document, boilerplate with no
duties, a contract that does not exist, a bare "hi"). Traffic made only of happy
paths produces a green dashboard that proves nothing.

### Three sources of quality signal

The judge is the only one that scales, which is exactly why it cannot stand
alone.

| | Catches | Blind to |
| --- | --- | --- |
| **Judge** — `score-production.mjs` | Anything a rubric anticipated, cheaply, at scale | Failures nobody wrote a rubric for; is itself sometimes confidently wrong |
| **Human** — `annotate.mjs` | Everything, including what the rubrics missed | Does not scale |
| **User** — `POST /api/v1/agent/feedback` | What actually mattered to the person who asked | Sparse, extremes-biased, unexplained |

**Step-level, not just answer-level.** `score-production.mjs` scores each
observation inside a turn: `tool_selection` and `retrieval_sufficiency` on the
tool step, `groundedness` and `helpfulness` on the generation the user read.
This exists to split one failure into two with opposite fixes — bad data in, or
good data misread. On the first run it paid for itself: `renewal_advice`
retrieval sufficiency 4/4 beside `agent.chat` groundedness 7/10 said the lookup
was fine and the reading was not, independently confirming that the expiry-count
defect lives in the tool's *description*, not its query.

Getting there needed a fix in the product, not the harness. Tools were invoked
without the trace callbacks, so a turn produced exactly one observation and the
retrieval step was invisible; and each LLM call started its own root trace, so a
turn arrived as three unrelated rows. `apps/agents/app/orchestrator.py` now
mints one trace id per turn and passes callbacks into `tool.ainvoke`, so a turn
is one trace with its steps nested. A turn went from 3 traces × 1 observation to
1 trace × 3 observations.

**Human annotation.** `annotate.mjs --seed` builds a Langfuse annotation queue
from a deliberately MIXED sample: every judge failure plus a control sample of
judge passes. Only-failures measures nothing — you cannot see a false positive
if the annotator never sees a case the judge liked, and false positives are the
failure mode we actually hit. `--calibrate` then reads the human labels back and
reports agreement per criterion, listing every disagreement.

Until someone labels a queue, **the judge has no baseline** and its numbers are
a comparison signal, not a measurement.

**User feedback.** Thumbs up/down on finished assistant turns in the rail →
`POST /api/v1/agent/feedback` → a `user_feedback` score on the turn's trace,
beside the judge scores. The browser sends only its chat session; the API
resolves the trace, because `apps/agents` sets Langfuse's `session_id` from the
thread id. It fails open — an observability outage must never surface as an
error on a thumbs-up.

### Feed failures back

A production trace that scores badly is the best dataset case there is, and
Langfuse turns one into an item directly (`sourceTraceId` on the dataset item
records where it came from). That loop — production failure becomes a permanent
regression test — is what stops the corpus ageing into a snapshot of the
problems you had in August.

## 4. What the first review actually found

Run on 2026-08-29: 13 journeys, 46 live calls across extraction / AI Assistant /
Chat Agent, driven from the local corpus. 46/46 returned 200. $1.08, 516k
tokens, 63 traces, 89 judge scores.

**One reproducible correctness defect.** Asked "how many contracts are expiring
in the next 90 days?", the agent answered **"There are 20"**. The
`renewal_advice` tool did return 20 rows — but 12 of them had negative
`daysUntilExpiry`, i.e. had already expired. Only 8 were genuinely future. The
four contracts the agent then named individually were all correct; the defect is
the headline count.

Root cause is not the model. `apps/api/src/routes/internal-ai.ts:3312` filters
`expiryDate` with `gte: now - 30 days` — a deliberate lookback so recently
lapsed renewals still surface, which is reasonable — while the tool's
description promises "every contract expiring in the next `lead_days` days". The
agent believed the description and reported the row count. Fix the description
or return split counts; do not fix the prompt.

It reproduced in **4 of 11** judged chat traces, in independent sessions. That
is the argument for online evals in one line: no curated corpus contained this
case, because nobody thought of it.

**Two smaller ones.** `obligations.extract` turned "due upon execution of this
SOW" into a hard date of `2026-01-01` (the effective date) — an event trigger
silently converted to a calendar date. `assist.simplify` dropped the defined
term `("Effective Date")` while simplifying, breaking later cross-references.

**Four deliberate edge cases all passed.** Empty document → `OTHER` at
confidence 0.1, saying it was empty. Boilerplate with no duties → `[]`, no
invented obligation. A contract id that does not exist → looked it up, then said
it could not find it, and stated no governing law. A bare "hi" → answered
directly with no tool call.

**Zero real errors.** The single ERROR observation was a cancelled generation
from a probe of ours that closed the connection mid-stream — which is the error
tracking working, since that is exactly what a user closing the tab looks like.

### The judge was wrong first, and how we knew

The first scoring pass reported the "20 contracts" answers as inventing
counterparties that were in fact present in the tool output. That verdict was
false, and the cause was ours: `score-production.mjs` truncated tool evidence to
5,000 characters, so the judge saw the first six rows of a twenty-row result and
correctly observed that the cited contracts were not in what it had been shown.

It was caught by reading the trace instead of believing the score. The fix is a
24,000-character source budget and, when even that is exceeded, telling the
judge in the prompt that the source was truncated — because "absent from the
source" is the single inference groundedness turns on, and a judge that does not
know it is looking at a fragment will call every unseen fact an invention.

Then the judge was re-run and reported a *different*, sharper failure — the
count, not the counterparties — which independent arithmetic on the tool output
confirms. **Treat a judge verdict as a pointer to a trace, not as a finding.**

## 5. Always-on, and the loop closing

Everything in §3 runs when somebody runs it. These run by themselves, or close
the loop back into the corpus.

```bash
pnpm evals:setup                                  # includes the always-on judges
pnpm evals sessions  -- --hours 6                 # grade whole conversations
pnpm evals promote   -- --hours 24 --apply        # failures → golden corpus
pnpm evals compare   -- --dataset draftlegal-extraction
```

**`evaluators.mjs`** registers our rubrics as Langfuse's own observation-level
LLM-as-a-judge rules, plus the LLM connection they need. After this, new traces
are scored with no script in the loop — verified: a chat turn produced five
`source=EVAL` scores within fifteen seconds, across both generations and the
tool step. Rules **converge** on re-run rather than skipping, so changing
`--sampling` actually changes it instead of printing a reassuring "exists" while
leaving a test-time 100% in place.

**`score-sessions.mjs`** grades a conversation instead of a turn, anchored to
the session. This is the failure people complain about and no per-turn score can
see: every answer individually defensible, the conversation still broken. First
run scored **11/15**, and the four failures were all real —

- the assistant listed contracts in turn 2, then in turn 3 answered "the first
  one" about a *different* contract
- a contract supplied in turn 1 was "not found" by a later turn
- a renewal analysis produced in turn 1 was denied to exist in the final turn

**`promote.mjs`** turns a production failure into a permanent case, ranked by
signal strength: a real user's thumbs-down outranks a human label, which
outranks a judge score. `sourceTraceId` keeps each case one click from the
conversation that produced it. `expectedOutput` is deliberately left unset —
we know the answer was wrong, not what right looks like.

**`compare.mjs`** diffs two runs of a dataset: pass rate per scorer with a
delta, *and* the per-case verdict changes. The second half matters because two
runs can post the same total with a different set of passing cases — a
regression and a fix cancelling out, which the aggregate reports as "no change".

## 6. Saying it in three sentences

The whole system, for someone who has never seen it:

> We record every AI call the product makes. We grade them two ways — against a
> fixed set of test cases before we ship, and against real traffic continuously.
> The grades come from three places: an AI judge for scale, humans for truth,
> and users for what actually mattered.

And the one piece of jargon worth teaching, because it does the most work:
**if the lookup scored well and the answer scored badly, the data was fine and
the model misread it.** That single split turns "the agent was wrong" into a
specific bug with an owner.

Our rubric names are plain English, which is right for a dashboard but does not
match what the field calls them. The mapping lives at the top of
`scripts/evals/langfuse/scorers.mjs` — `groundedness` is *faithfulness*,
`retrieval_sufficiency` is *context recall*, `tool_selection` is *tool-call
accuracy*. The names are not renamed to match because they are already attached
to recorded scores, and renaming would orphan every trend line.

## 7. Honest limits

- **The `chat` corpus has still not been run.** `extraction` has: first green
  run 2026-08-29, **9/9 assertions**, all six cases linked to the *product's*
  own trace rather than a harness stand-in, negative case included (boilerplate
  with no duties → no invented obligation). The `chat` corpus needs a seeded
  persona login as well as the stack, and has not been exercised end to end, so
  those five case expectations remain unvalidated.
- **Promoted regression cases have no expected output.** `promote.mjs` records
  what went wrong, not what right looks like — inventing one would enshrine a
  guess. Until a human writes them, those cases are graded by rubric only.
- **The judge is only lightly calibrated.** It was checked on a two-case probe
  (a correct refusal scored 1; an invented governing law scored 0 with an
  accurate reason) and its production verdicts were spot-checked against the
  traces. That is enough to trust it as a pointer, not as a measure — and §4
  shows it producing a confidently wrong verdict when its evidence was clipped.
  It also runs on `gemini-2.5-pro`, the same family as the system under test,
  because that is the only real key on this machine: expect some
  self-preference bias until a second provider key exists. Set
  `EVAL_JUDGE_MODEL` to move it.
- **Gemini judges need token headroom.** 2.5 is a thinking model, thinking
  counts against `maxOutputTokens`, and it cannot be disabled. At 512 it spent
  509 tokens thinking and returned nothing — 40 of 43 judgements failed as
  "no JSON". The budget is now 3072.
- **Fixture-dependent cases.** `chat-portfolio-count` and
  `chat-search-by-counterparty` assert on the seeded corpus. If the fixture
  changes, they need revisiting — which is exactly why they are scored on
  groundedness and tool choice rather than on the specific number returned.
- **No CI job runs the graded corpora.** `.github/workflows/nightly-evals.yml`
  is still manual-only and blocked on `docs/37` E8 (eval identity), for
  unrelated reasons that apply here too: a nightly judged run spends real money
  and needs a dedicated org with a cost cap.
