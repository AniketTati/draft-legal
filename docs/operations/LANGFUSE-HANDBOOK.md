# Langfuse handbook — reading traces, setting up judges

**Companion to `AI-EVALS-101.md`.** That one covers concepts; this one is
hands-on. Every example below is a **real record from our own instance**, not an
illustration.

**Log in:** http://localhost:3100 · `dev@draft-legal.local` / `langfuse-local-dev`

---

## Part 1 — The five things in Langfuse

Langfuse stores five kinds of object. Everything in the UI is a view over these.

```
Session          one conversation
  └─ Trace       one turn — one thing the AI did
       └─ Observation   one step inside that turn
            └─ Score    a judgement attached to a trace or a step

Dataset          a fixed set of test cases, run repeatedly
```

Two rules that explain most of the UI:

- **A score can attach to a trace OR to one observation inside it.** That is
  what lets you say "the lookup was fine, the answer was wrong".
- **A score can come from anywhere** — a script, Langfuse's own judge, a human,
  or a real user clicking thumbs-down. They all land in the same place, which is
  what makes them comparable.

---

## Part 2 — Reading a trace, line by line

Here is a real trace. The user asked about a contract that **does not exist** —
our deliberate hallucination trap.

### The header

```
id          f743f4c42097406399ac6159b995d08a
name        agent.chat
timestamp   2026-08-30T14:16:12.925Z
sessionId   traffic-edge-0-095403
userId      jo.okafor
tags        ["model:gemini-2.5-flash", "provider:google",
             "source:platform", "tier:default"]
latency     3.311      (seconds)
totalCost   $0.008027
```

Field by field, and why each is there:

| Field | Meaning | What you'd use it for |
|---|---|---|
| `name` | Which feature ran | Filtering: "show me all chat turns" |
| `sessionId` | The conversation it belongs to | Jump to the whole conversation |
| `userId` | Who asked | "Is one customer seeing all the failures?" |
| `tags` | Model, provider, tier, platform-vs-BYOK | "Show every call on the old model" |
| `latency` | Total seconds | Slow-surface hunting |
| `totalCost` | Dollars for this one turn | Cost attribution |

> **`name` is our call-site name**, not the model's class name. That is
> deliberate — a dashboard full of `ChatGoogleGenerativeAI` rows tells you
> nothing, while `agent.chat` and `classify.detect` tell you which product
> feature is misbehaving.

### The steps

```
STEP 1   GENERATION   agent.chat        1.927s   gemini-2.5-flash
         in 12,960 tokens · out 42 tokens · $0.003993
         output: (empty — this is a tool call, not prose)

STEP 2   TOOL         clause_search     0.208s
         output: {"error": "contract_not_found",
                  "contract_id": "ZZZ-DOES-NOT-EXIST-9999"}

STEP 3   GENERATION   agent.chat        1.144s   gemini-2.5-flash
         in 13,155 tokens · out 35 tokens · $0.004034
         output: "I couldn't find a contract with the ID
                  ZZZ-DOES-NOT-EXIST-9999. Please double-check
                  the ID and try again."
```

**Read it as a story:**

1. The model read the question and decided to search. Its text output is empty
   because the "output" of this step *is the decision to call a tool*.
2. The tool ran against the real database and found nothing. **This is the
   source of truth** — everything the answer says must be justifiable from here.
3. The model wrote the answer from that result.

**This trace is a pass, and it is worth understanding why.** The tool returned
`contract_not_found`. The model said it could not find it. It did **not** invent
a governing law. A confidently wrong "Delaware" here would be this product's most
damaging possible failure — fluent, well-formed, and completely made up.

**Notice the token counts.** 12,960 tokens in, 42 out. Almost everything is
input: the system prompt and ~30 tool definitions. That is normal for an agent
and it is why input cost dominates. If someone asks "why is chat expensive?",
this is the answer — not long replies, but a large prompt sent on every turn.

### The scores

```
guard:empty                    1   BOOLEAN   API    non-empty
guard:secret_leak              1   BOOLEAN   API    no credentials in output
guard:payment_data             1   BOOLEAN   API    no payment instruments
guard:refusal                  0   BOOLEAN   API    answered
draftlegal groundedness—live   1   BOOLEAN   EVAL   "…has not yet generated a
                                                     prose answer; it has only
                                                     made a tool call…"
```

| Column | Meaning |
|---|---|
| `value` | 1 = pass, 0 = fail (`BOOLEAN` renders as 0/1) |
| `source` | **`API`** = one of our scripts · **`EVAL`** = Langfuse's own judge, unattended |
| `comment` | The reasoning. Always read this before believing the number |

**Now spot the problem in that last row.** The judge's comment says it graded a
step that had *"not yet generated a prose answer… only made a tool call"* — so it
scored **step 1**, the tool-calling generation, not step 3, the actual answer.

It returned 1, which looks fine. It is not meaningful. Our rule fires on **every**
`GENERATION` observation, and an agent turn has two — the decide step and the
answer step. Grading the decide step produces a confident score about nothing.

**This is a real config nuance, found by reading a comment rather than a number**,
and it is exactly the habit to build: *the number tells you there is something to
look at; the comment tells you whether to believe it.*

---

## Part 3 — Setting up a judge

Two ways. Do it in the UI once to understand the shape; use the script for
anything you want reproducible.

### 3.1 In the UI

**Step 1 — give Langfuse a model to judge with.**
`Settings → LLM Connections → Add`. Pick a provider, paste an API key. Without
this, no judge can run — it is the most common reason a new evaluator does
nothing.

**Step 2 — create the evaluator.**
`Evaluations → Evaluators → New`. You provide:

- a **name**
- a **prompt** containing `{{variables}}` in double braces
- an **output type** — Numeric, Boolean or Categorical
- the **model** it should use

Ours, stored verbatim:

```
name       draftlegal groundedness
variables  ["input", "output"]
prompt     You are grading the output of a contract-lifecycle assistant.

           CRITERION (groundedness): Is every factual claim in the ANSWER
           supported by the SOURCE material or the conversation input?
           Score 0 if the answer states a contract term, party, date, or
           figure that does not appear in the source. An answer that
           correctly says it does not know scores 1. Fluent invention is
           the failure this catches.

           INPUT:
           {{input}}

           OUTPUT:
           {{output}}

           Reason briefly, then score. Score 1 if the criterion is met,
           0 if not.
```

Langfuse requires **both** a `reasoning` and a `score` field in the output
definition. That is a good constraint: a bare 1/0 with no stated reason is
unreviewable, and reviewing the reason is how you catch a judge that is
confidently wrong.

**Step 3 — create a rule: what it runs on, and how often.**

```
name       draftlegal retrieval_sufficiency — live
target     observation          ← not "trace" (see the warning below)
enabled    true
sampling   0.05                 ← 5% of matching observations
filter     [{ column: "type", operator: "any of", value: ["TOOL"] }]
mapping    [{ variable: "input",  source: "input"  },
            { variable: "output", source: "output" }]
```

- **`target: observation`** — grade a *step*, not the whole turn.
- **`filter`** — narrow it. This rule only runs on `TOOL` steps, because asking
  "did the retrieval return enough?" of a prose answer produces a meaningless
  number at full price.
- **`mapping`** — where each `{{variable}}` gets its value.
- **`sampling`** — the fraction that gets graded.

> ⚠️ **Always choose observation-level, never trace-level.** Trace-level
> evaluators are deprecated and stop producing results on Langfuse Cloud after
> **16 November 2026**.

### 3.2 In code (reproducible)

```bash
pnpm evals:setup                          # creates connection, evaluators, rules
pnpm evals evaluators -- --status         # what exists right now
pnpm evals evaluators -- --apply --sampling 0.05
```

Re-running with a different `--sampling` **updates** the existing rule rather
than skipping it — so changing your mind is one command, and you cannot end up
with a rule silently stuck at a value someone set months ago while the script
prints a reassuring "already exists".

Rubric text is imported from one file, so the in-platform judge and our scripts
grade to the *same* wording. If they ever disagree, that is a bug — not a signal.

---

## Part 4 — The pages, and what each is for

### Dashboards

**"LLM production review"** — is it working, what does it cost?
Spend, calls by surface, cost by model, p95 latency, **time to first token**,
errors.

**"Agent quality"** — is it good, and is that changing?
Overall pass rate, pass rate by criterion and by surface, quality over time,
assessment counts, continuous-vs-on-demand, guardrail violations, human labels.

> ⚠️ **Widen the time range before you conclude anything.** The default is often
> the last hour; our data spans days. A narrow window makes a healthy system look
> dead — and it is the single most common way someone misreads this tool.

### Tracing → Sessions

One conversation, end to end. **Where you go when a number looks wrong.** The
dashboard says *what*; the session says *why*. Nothing here is automatable —
reading transcripts is where the failures nobody wrote a rubric for get found.

### Tracing → Traces

One turn. Click through to the steps, as in Part 2. Filter by `name` for a
feature, by `tags` for a model, by `userId` for one customer.

### Scores

Every judgement made, filterable by name.

| Prefix | Who made it |
|---|---|
| `judge:` | Our AI judge, script-run |
| `draftlegal … — live` | Langfuse's judge, automatic |
| `guard:` | Deterministic safety checks |
| `human_` | A person, via the review queue |
| `user_feedback` | A real user's thumbs in the app |

**The most valuable row you can find** is a trace where `judge:` says good and
`user_feedback` says bad. That gap is a rubric measuring the wrong thing.

### Datasets → Runs

Our fixed test cases. Each execution is a **run**; compare two side by side.

```
dataset  draftlegal-chat
run      "final"        5 items
item     chat-cite-clause  →  trace dc16fe5e93a447d2
```

Every case links to the trace it produced, so a failure is one click from the
transcript that caused it.

**Read runs as a delta.** "80%" means little. "Down from 95% last release" is a
decision.

### Annotation Queues

Conversations waiting for a human. Four fields: did it invent anything, was it
useful, what should happen, and **free text for why**.

The free-text field is the valuable one. *"not_grounded"* is a number; *"it cited
clause 9.2 but the cap is in 9.4"* is a fix — and when a human and the judge
disagree, the note is what says which of them misread the trace.

---

## Part 5 — Recipes

**"Is anything broken right now?"**
```bash
pnpm evals health -- --hours 24
```
Eight checks, exit 0 or 1. The first one asks *did anything run at all* — because
a silent system scores 100% on everything else, and tracing breaking looks
identical to a quiet night.

**"What did production do yesterday?"**
```bash
pnpm evals:review -- --hours 24
```

**"Did my change break anything?"**
```bash
pnpm evals:check
```

**"Show me the whole thing working, locally."**
```bash
pnpm evals:rehearse
```
Generates traffic, waits for Langfuse to judge it unattended, runs the health
check, prints the review. **Nothing changes when you move to production except
three environment variables** — same scripts, same thresholds, different host.

**"A user complained about a specific answer."**
Sessions → find by `userId` or time → open the trace → read the steps. Was the
tool result wrong, or did the model misread a good result? Those need opposite
fixes, and the step view is what separates them.

**"Turn this failure into a permanent test."**
```bash
pnpm evals promote -- --hours 24 --apply
```

---

## Part 6 — Traps

| Trap | What happens | Fix |
|---|---|---|
| Time range too narrow | Healthy system looks dead | Widen to 24h+ |
| Reading the overall pass rate alone | "76%" tells you nothing actionable | Always read the by-criterion breakdown |
| Trusting a score without its comment | Judges are confidently wrong | Read the reasoning first |
| Assuming `EVAL` scores exist | If continuous grading stopped, quality looks stable because nothing is being graded | Check "Assessments" count and the continuous-vs-on-demand pie |
| Comparing runs across different corpora | Meaningless | Same dataset, different runs |
| Treating `guard:refusal` as a failure | Refusing to invent a contract is correct | It is a **rate** — watch for spikes |
| Reading average latency | One 40-second surface vanishes into a mean of 8 | Use p95, and TTFT for streaming |

---

## Part 7 — Current state

Last 36 hours, local environment:

- **248 traces** · $2.38 · 1.53M tokens
- **Groundedness 77%** (79 judgements) · **helpfulness 86%** (69)
- **186 guardrail checks, zero violations**
- Fixed corpora both green: extraction **9/9**, chat **10/10**
- Time to first token: **1,940 ms** on 2.5-flash, was 23,748 ms on 2.5-pro

**These come from traffic we generated, not real users.** They prove the
machinery works. They do not yet tell you how the product behaves in the wild —
production is not traced yet.

---

*Concepts and industry context: `AI-EVALS-101.md`. Method and history:
`LANGFUSE-EVALS.md`. Commands: `pnpm evals`.*
