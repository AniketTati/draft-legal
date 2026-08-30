# How we measure AI quality — a guide for product

**Who this is for:** anyone who needs to answer "is the AI any good, and how do
we know?" without reading code. No prior knowledge assumed.

**What it covers:** how our AI is watched and graded, how to read Langfuse
yourself, and where we stand against how the rest of the industry does it.

---

## 1. The problem, in one paragraph

Ordinary software either works or throws an error. AI features have a third
state: **confidently wrong**. The agent returns a fluent, well-formatted,
plausible answer that happens to be false — no error, no alert, no stack trace.
Nothing in normal monitoring catches it, because from the system's point of view
everything succeeded.

Everything in this document exists to catch that third state.

---

## 2. The three ideas

Learn these and the rest follows.

### A trace is a recording

Every time the AI does something, we record it: the question, what it looked up,
what it answered, how long it took, what it cost. Like a flight recorder.

A single chat turn is **three steps** in one trace:

```
User asks  →  1. AI decides which tool to use
              2. Tool reads the database        ← the source of truth
              3. AI answers from what came back
```

Recording the steps separately is the single most useful thing we do, because
"the AI was wrong" has two causes with **opposite fixes**:

- The tool returned bad data → a database or query bug
- The tool returned good data and the AI misread it → a prompt or model problem

One score on the final answer cannot tell them apart. Two scores can.

> **This is not theoretical.** Asked "how many contracts expire in the next 90
> days?", the agent answered **"20"**. The tool had returned 20 rows — but 12 had
> already expired. Only 8 were upcoming. The step scores showed the *lookup* was
> perfect and the *reading* was wrong, which pointed straight at the tool's
> description rather than the AI. Fixed; it now answers "7 expiring, 13 recently
> expired."

### A score is a judgement about a recording

Three kinds, and we use the cheapest one that can answer the question.

| | What it is | Cost | Reliability |
|---|---|---|---|
| **Code check** | "Did it say NDA?" A plain comparison | Free, instant | Perfect |
| **AI judge** | "Did it make something up?" Another AI grades the answer | ~$0.01–0.10 each | Good, occasionally wrong |
| **Human** | A person reads it and says what they think | Slow | The only real ground truth |

Today **26 of 35** checks are plain code. A contract type is either right or
wrong — paying an AI to confirm a string match buys nothing.

### Two loops

| | Before we ship | After we ship |
|---|---|---|
| Question | "Did my change break anything?" | "Is it still going smoothly?" |
| Runs against | A fixed set of known test cases | Real user traffic |
| Catches | Regressions | The things nobody thought to test |

Neither replaces the other. Only the first, and you're testing yesterday's
imagination. Only the second, and you can watch quality fall with no safe way to
change anything.

They feed each other: **a real production failure becomes a permanent test case**
(`pnpm evals promote`), so the same bug can never come back unnoticed. That loop
is what makes this compound instead of age.

---

## 3. How to read Langfuse

Langfuse is the tool that stores all this. Log in and you land on a sidebar.
Here is what each part is actually for.

### Start here: **Dashboards**

Two pages, answering different questions on different days.

**"LLM production review"** — is it working, and what does it cost?

| Widget | Read it as |
|---|---|
| Spend (total) | The bill for the selected window |
| Calls by surface | Where the volume is |
| Cost by model / by surface | Which feature is expensive. Optimise the top bar or nothing |
| p95 latency by surface | The slow features. **p95 = "95% of requests were faster than this"** — the average hides the bad tail |
| **Time to first token** | How long a user stares at a blank screen before text appears. This is what a chat UI is judged on, and it is *not* the same as total time |
| Errors by surface | Should be empty |

**"Agent quality"** — is it any good, and is that changing?

| Widget | Read it as |
|---|---|
| Overall pass rate | One number. **Never read it without the breakdown next to it** |
| Pass rate by criterion | *Which* thing is failing — making things up, or being unhelpful, or picking the wrong tool |
| Pass rate by surface | Chat and extraction fail differently and at different rates |
| Quality over time | The trend. 76% is fine or alarming depending only on last week |
| **Assessments by criterion** | *How much* each check ran. 100% across three judgements is not evidence |
| Continuous vs on-demand | "EVAL" = Langfuse grading by itself. If that slice is empty, automatic grading has stopped |
| Guardrail violations | Anything below 100% is an incident, not a metric |
| Human review labels | Empty until someone works the review queue |

> ⚠️ **Widen the time range first.** The default is often the last hour. Most of
> our data spans a day or more, and a narrow window makes a healthy system look
> dead.

### **Tracing → Sessions** — the conversations

A session is one conversation. Open it to read the actual back-and-forth,
exactly as the user saw it. **This is where you go when a number looks wrong** —
the dashboard says *what*, the session says *why*.

### **Tracing → Traces** — one turn in detail

Click any trace to see its steps. You will see the tool that ran, what it
returned, and the answer built from it — plus any scores attached to each step.

A score sitting on the *tool* step and a score sitting on the *answer* step tell
you different things. That is the whole point of section 2.

### **Scores** — every judgement made

Filter by name to see one measure over time.

| Prefix | Who made it |
|---|---|
| `judge:` | The AI judge, run by us |
| `draftlegal … — live` | Langfuse's own judge, running automatically |
| `guard:` | Deterministic safety checks (see §4) |
| `human_` | A person, via the review queue |
| `user_feedback` | A real user's thumbs up/down in the app |

**The most interesting row you can find** is a trace where the judge said "good"
and the user said "bad". That gap is a rubric that is measuring the wrong thing.

### **Datasets → Runs** — did a change help?

Our fixed test cases live here. Each time we run them, the result is a "run".
**Compare two runs side by side** to see whether a change improved things.

Read it as a **delta, not an absolute**. "80%" means little; "down from 95% last
release" is a decision.

### **Annotation Queues** — where a human reviews

A short list of conversations waiting for a person. Four fields per item: did it
make anything up, was it useful, what should happen, and **a free-text box for
why**. That last one is the valuable part — *"not grounded"* is a number,
*"it cited clause 9.2 but the cap is in 9.4"* is a fix.

---

## 4. Guardrails — the checks that never sleep

Separate from quality. The judge asks "was this good?"; guardrails ask **"did it
do something it must never do?"**

| Check | Fires when |
|---|---|
| `guard:secret_leak` | An API key or password appears in an answer |
| `guard:payment_data` | A card number or bank account appears |
| `guard:schema_valid` | A feature that must return structured data returned prose instead |
| `guard:empty` | The user got nothing back |
| `guard:refusal` | *(a rate, not a failure — see below)* |

**These run on every single request, not a sample.** Everything else is graded on
5% of traffic because AI judgements cost money. Guardrails are simple pattern
matching, so checking the other 95% costs nothing — and a leak found in one
request out of twenty is a leak missed in the other nineteen.

**Zero tolerance, deliberately not configurable.** One leaked credential is an
incident, not a dip in a metric.

**What we deliberately do NOT flag:** emails, phone numbers, addresses, names.
This is a contract product — the documents are full of them and surfacing them is
the job. A privacy rule firing on every counterparty email would be noise on
nearly every request, and *a guardrail that cries wolf gets switched off within a
week*, after which it protects nothing.

`guard:refusal` is a **rate, not a failure.** The AI declining to invent a
contract it cannot find is exactly right. What matters is a *spike*: retrieval
broke or a prompt changed, and answers went from useful to apologetic without
anything erroring.

---

## 5. What runs automatically

| | When | What happens if it fails |
|---|---|---|
| **Health check** | Twice daily | The job fails → GitHub notifies. Eight checks: traffic, errors, latency, time-to-first-token, quality, coverage, guardrails, spend |
| **Continuous grading** | Always on | Langfuse grades 5% of new traffic by itself, no one involved |
| **Release gate** | Before promoting a build | Runs the fixed test cases against the deployment; blocks if the pass rate drops below 80% |

One detail worth understanding: **"no traffic" counts as unhealthy.** A silent
system scores 100% on every other check — tracing breaking looks exactly like a
quiet night. So the first thing the health check asks is "did anything run at
all?"

### What a human still has to do

Automation reports; it does not decide.

1. **Review the queue** — 20 minutes, ideally weekly. Without human labels the
   quality number is an untested assumption.
2. **Read the sessions behind a failed check.** The alert says *which* threshold
   broke, never *why*.
3. **Promote real failures into the test set.** This is the step that makes the
   system compound rather than age.

---

## 6. Are we industry standard?

Short answer: **the hard parts are at or above standard; the gaps are the cheap
parts, and two of three are now closed.**

| | Industry practice (2026) | Us | |
|---|---|---|---|
| Judge sampling | 1–5% of traffic | 5% | ✅ |
| Grading off the request path | Always async | Async | ✅ |
| Cost as a first-class metric | Per request | Per surface, model and call | ✅ |
| Latency percentiles | p50/p90/p99 | p50/p95/max | ⚠️ no p99 |
| Time to first token | Tracked | Tracked | ✅ |
| Step-level grading | Recommended | Yes | ✅ |
| Production failures → test cases | Recommended | `evals promote` | ✅ |
| Guardrails (secrets, schema, refusal) | Standard | Yes | ✅ |
| Number of judge metrics | **Few, high-signal** | 8 rubrics | ⚠️ more than advised |
| Human review | **Weekly minimum** | No cadence set | ❌ |
| Implicit signals (retries, abandonment) | Standard | Thumbs only | ❌ |

**Two things worth knowing about the sampling number.** Guidance is 1–5%. We
were at 20%, and a local rehearsal showed why that matters: **the AI judges
reached 48% of total model spend** — the graders costing about as much as the
product they grade. Now at 5%.

**And a win that only appeared because we added a metric:** pinning to a faster
model cut time-to-first-token from **23.7 seconds to 1.9 seconds** — a 12×
improvement in how long a user waits before seeing anything. That was invisible
until the metric existed.

---

## 7. Current state, and what is not true yet

Measured over the last 36 hours on the local environment:

- **248 traces**, $2.38, 1.5M tokens
- **Groundedness 77%**, helpfulness 86% — the two headline quality numbers
- **186 guardrail checks, zero violations**
- Both fixed test sets green: extraction **9/9**, chat **10/10**

**Be careful with these numbers.** They come from traffic we generated
ourselves to exercise the system, not from real users. They prove the machinery
works. They do not yet tell you how the product behaves in the wild.

Three honest gaps:

1. **Production is not traced yet.** Everything above runs locally. Cloud needs
   two credentials added before any of it sees real users.
2. **Nobody has reviewed the queue.** Zero human labels so far, which means the
   AI judge has no baseline and its numbers are a signal rather than a
   measurement. It has already been confidently wrong twice.
3. **The judge grades its own family.** It runs on the same model family as the
   system under test, which tends to be generous. A second provider key fixes it.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **Trace** | The recording of one thing the AI did |
| **Observation / step** | One stage inside a trace — a lookup, or an answer |
| **Session** | A whole conversation, several traces |
| **Score** | A judgement attached to a trace or a step |
| **Grounded** | Every claim traceable to a real source. Ungrounded = made up |
| **LLM-as-a-judge** | Using an AI to grade another AI's output |
| **p95** | 95% of requests were faster than this. The tail users complain about |
| **TTFT** | Time to first token — the wait before *any* text appears |
| **Sampling** | Grading a fraction of traffic, because AI grading costs money |
| **Golden dataset** | The fixed set of test cases with known-good answers |
| **Guardrail** | A cheap always-on check for things that must never happen |

---

*Detail and method: `docs/operations/LANGFUSE-EVALS.md`. Commands: `pnpm evals`.*
