# AI evaluation, from zero

**Who this is for:** you need to hold your own in a technical conversation about
how we evaluate AI. No prior knowledge assumed — not of machine learning, not of
Langfuse, not of our codebase.

**Companion document:** `LANGFUSE-HANDBOOK.md` is the hands-on half — reading a
real trace line by line, and setting up a judge yourself.

---

## Part 1 — Why evaluation exists at all

### The third state

Normal software has two outcomes. It works, or it throws an error you can catch,
log and alert on.

AI features have a third: **confidently wrong.**

The agent returns a fluent, well-formatted, entirely plausible answer that is
false. No exception. No 500. No stack trace. Latency normal, cost normal, HTTP
200. Every dashboard you already own says everything is fine.

Ask our agent *"how many contracts expire in the next 90 days?"* and it once
answered **"There are 20."** The underlying tool had returned 20 rows — but 12
of them had already expired. The true answer was 8. Nothing in the system
registered a problem, because nothing *had* gone wrong in the way software
normally goes wrong.

Evaluation is the discipline of catching that. That is the whole subject.

### Why you cannot just write tests

The instinct is: write unit tests. It fails for a specific reason.

A unit test asserts `f(x) === y`. But an LLM given the same input twice can
return two different, both-correct answers:

> "You have 8 contracts expiring in the next 90 days."
> "There are 8 upcoming expirations over the next quarter."

An equality assertion fails the second one. So you loosen it to a substring
match, then to a fuzzy match, and each loosening removes discriminating power
until the test passes for everything and means nothing.

**The resolution is to split the question in two:**

| Question | How to check it |
|---|---|
| Did my *code* do the right thing given what the model said? | Deterministic. Replay a recorded model response and assert on tool dispatch, permissions, error handling. Free and exact. |
| Was the *answer* any good? | Not deterministic. Needs a judge, a human, or a real user. |

Almost every confusion about evals comes from mixing these two. Our repo splits
them explicitly, and it is the single most useful idea here.

---

## Part 2 — Vocabulary

Learn these eleven words and you can follow any conversation on the topic.

| Term | Meaning | Why it matters |
|---|---|---|
| **Trace** | The full recording of one thing the AI did | The unit of everything. No trace, no evaluation |
| **Observation / span** | One step *inside* a trace — a model call, a database lookup | Lets you find *which* step failed |
| **Generation** | An observation that is specifically a model call | Carries tokens, cost, model name |
| **Session** | Several traces belonging to one conversation | Multi-turn quality lives here |
| **Score** | A judgement attached to a trace or a step | The output of all evaluation |
| **Grounded** | Every claim traceable to a real source | Ungrounded = made up = the dangerous failure |
| **Hallucination** | A confident, fluent, false statement | The thing evaluation exists to catch |
| **LLM-as-a-judge** | Using a model to grade another model's output | Scales; costs money; sometimes wrong |
| **Golden dataset** | A fixed set of test cases with known-good answers | Regression testing for AI |
| **Offline eval** | Run the golden dataset before shipping | "Did I break it?" |
| **Online eval** | Grade real production traffic | "Is it still good?" |

Two more that separate people who have done this from people who have read
about it:

- **p95** — 95% of requests were faster than this. The average is a lie: one
  surface at 40 seconds disappears into a mean of 8. Percentiles are how latency
  is discussed.
- **Sampling** — grading only a fraction of traffic, because AI grading costs
  real money per judgement.

---

## Part 3 — The three ways to grade

Ordered cheapest first, which is also the order you should reach for them.

### 3.1 Code checks — free, instant, exact

A plain comparison. Did it return `NDA`? Did it call `contract_search`? Is the
field non-empty? Does the JSON parse?

**Use these wherever a right answer exists.** A contract type is either right or
wrong. Paying a model to confirm a string match buys nondeterminism, latency and
a bill, in exchange for nothing.

In our repo, **26 of 35 checks are code**. That ratio is the point, not an
accident.

```
field_match:contractType      "did it return NDA?"        free
tool_used:contract_search     "did it call the right tool?"  free
json_subset                   "do the expected fields match?" free
no_tool                       "did it answer 'hi' without a database query?"  free
```

That last one is worth dwelling on. An agent that runs a portfolio search on
"hi" costs money and seconds on the most common message there is. No judge is
needed to catch it — but nothing catches it unless something asserts on it.

### 3.2 LLM-as-a-judge — for questions with no right answer

Some questions genuinely cannot be a string comparison:

- *Is every claim in this answer supported by the document?*
- *Would a busy contracts lawyer find this useful?*
- *Did this conversation go anywhere?*

For these you give a second model the question, the source material, the answer,
and a **rubric** — and ask it to score. That is all "LLM-as-a-judge" means.

Ours looks like this (real, from `scorers.mjs`):

> **groundedness** (NUMERIC) — Is every factual claim in the ANSWER supported by
> the SOURCE material or the conversation input?
>
> - `1.0` — every claim traceable to the source, OR a correct "I could not find that"
> - `0.7` — substantively grounded; one peripheral detail unsupported
> - `0.3` — a CENTRAL claim is unsupported
> - `0.0` — invented: contract terms, parties, dates or figures not in the source

**Why the rubric is written that way** — four deliberate properties, and an
interviewer may well probe them:

1. **One property per rubric.** "Is this a good answer?" produces a number that
   drifts with the model and correlates with nothing. Each rubric asks exactly
   one question.
2. **It names what a 0 looks like.** Vague rubrics get vague scores.
3. **It resolves the ambiguous case explicitly** — a correct "I don't know"
   scores 1.0. Without that line, a judge penalises the agent for the *correct*
   refusal, which is the opposite of what you want.
4. **Every level is anchored.** "Score 0 to 1 for groundedness" gets a different
   number every run, because the judge invents its own scale each time. Naming
   what 0.7 and 0.3 *mean* is what makes the number reproducible enough to
   trend. This is the same reason human annotation guidelines carry anchors, and
   it is the standard answer to "how do you get inter-rater reliability from an
   LLM judge?"

### 3.2.1 Pick the score TYPE to match the question

A rubric is not automatically pass/fail. Langfuse supports three types and using
only one is a common, costly mistake:

| Type | Answers | Ours |
|---|---|---|
| `BOOLEAN` (0/1) | *Did it do the right thing?* | `tool_selection` |
| `NUMERIC` (0.0–1.0) | *How well?* | `groundedness`, `helpfulness`, `correctness`, `citation`, `retrieval_sufficiency`, `trajectory`, `session_coherence`, `session_goal_progress` |
| `CATEGORICAL` (a label) | *What kind of failure?* | `failure_mode`: `hallucinated`, `misread_data`, `wrong_tool`, `incomplete`, `refused_wrongly`, `malformed`, `fine` |

**Boolean-only hides where the failure is.** A real run from this repo:

```
contract_search · tool_selection            3/3   100%
portfolio_compare · tool_selection          1/1   100%
contract_search · retrieval_sufficiency     mean 0.20
portfolio_compare · retrieval_sufficiency   mean 0.00
agent.chat · groundedness                   mean 1.00
agent.chat · trajectory (2 calls)           mean 0.67
agent.chat · failure_mode                   fine ×2, wrong_tool ×1
```

The agent picks the right tools (100%) and invents nothing (1.00) — but what the
tools *return* is useless (0.20, 0.00). **The model is fine; retrieval is broken.**
With only the boolean we would have read `100%` and shipped.

That distinction decides what you go and fix: a prompt, or a database query.

**Categorical is not a number.** `failure_mode` has no average — you read it as a
breakdown ("9 of 12 failures are `misread_data`"). A numeric score tells you to
worry; a label tells you what to fix. They also land in *different* Langfuse
metric views (`scores-boolean`, `scores-numeric`, `scores-categorical`), which is
a real trap when building dashboards.

### 3.2.2 `trajectory` — the score a per-call judge cannot produce

`tool_selection` grades each call **in isolation**. An agent that calls
`contract_search` four times with the same query scores 1.0 four times: every
individual call was defensible. The failure exists only in the **sequence**.

So `trajectory` is judged once per turn over the *ordered* tool list — catching
looping, re-fetching what it already had, and stopping one lookup short of the
question. It runs only when a turn used more than one tool; on a single-tool turn
it asks the same question as `tool_selection`, and paying a judge twice for one
answer is waste.

This is the eval-design point worth being able to state: **the unit you score has
to match the unit that can fail.** Multi-step agents fail at the sequence level,
so something has to score the sequence.

### 3.3 Humans — slow, and the only ground truth

A person reads the transcript and says what they think.

Its real job is not grading the AI. **It is grading the judge.** Without human
labels, every quality number rests on the untested assumption that the judge is
right — and judges are wrong in ways that look exactly like being right.

---

## Part 4 — How the judge fails (interview gold)

Anyone can say "we use LLM-as-a-judge". The follow-up question is *"and how do
you know the judge is right?"* Here are three real failures from this project.

### Failure 1 — Judging against evidence it was never shown

Our first scoring pass reported that the agent had **invented counterparties**.
It named them, quoted them, sounded certain.

It was wrong. The contracts were right there in the tool output. The cause was
ours: the harness truncated tool results to 5,000 characters, so the judge saw
the first six rows of a twenty-row result and correctly observed that the cited
contracts were not in what it had been shown.

**The lesson:** a judge given partial evidence does not say "I'm not sure". It
confidently reports invention. "Absent from the source" is the one inference
groundedness turns on, so a judge that does not know it is holding a fragment
calls every unseen fact a hallucination.

**The fix:** a much larger evidence budget, and when it still has to truncate,
the prompt *says so* — so the judge knows absence is not proof.

### Failure 2 — Silence that looked like malfunction

We pointed the judge at Gemini 2.5 with a 512-token budget. **40 of 43
judgements failed** with an empty response.

The cause: Gemini 2.5 is a *thinking* model. Its internal reasoning draws from
the same output budget as the answer. It spent 509 tokens thinking and had
nothing left to say. The failure surfaced as "returned no JSON" — a message that
diagnoses nothing.

**The lesson:** the judge is a model with its own failure modes, and they will
not resemble your application's failure modes.

### Failure 3 — A newer model that was worse

We cross-checked the judge with a *different, newer* model (Gemini 3.7 Flash) on
the same traces. **12 of 18 agreed.** On the "20 contracts" trace, the newer
model scored it **grounded**, reasoning:

> "The answer accurately states there are 20 contracts expiring in the
> timeframe, directly matching the `total: 20` field from the tool output."

That is the newer model **reproducing the product's own bug inside its grading**
— treating `total` as "expiring", exactly as the agent had. The older model
caught it. Every one of the six disagreements went the same way: the newer model
was more lenient.

**Two lessons.** A newer model is not automatically a better judge. And
agreement between two models is not proof — two models can share a blind spot.

### So how do you know the judge is right?

You do not, until a human checks it. That is what a **calibration set** is: a
mixed sample of traces the judge passed *and* failed, labelled by a person, so
you can measure agreement.

Mixed is essential. A queue of only-failures cannot reveal **false positives** —
you never show the annotator a case the judge liked — and false positives were
exactly our failure mode.

---

## Part 5 — Offline and online

Two loops. Different questions, different economics, and they feed each other.

### Offline — before you ship

Run a **fixed** set of cases with known-good answers. Bounded, repeatable, safe
to block a release on.

Our two corpora:

| Corpus | Cases | Covers |
|---|---|---|
| `draftlegal-extraction` | 6 | Document classification, obligation extraction |
| `draftlegal-chat` | 5 | The conversational agent through the real API |

Two of those eleven cases exist to catch what silence hides — worth
understanding, because they are the non-obvious part of corpus design:

- **`obl-none-present`** — a document with *no obligations in it*. An extractor
  that feels obliged to find something will invent one here. **No positive case
  can ever detect that.**
- **`chat-unknowable-refusal`** — asks about a contract that does not exist. A
  confident "Delaware" is this product's most damaging possible failure, and it
  is fluent, well-formed and completely wrong — only a groundedness judge
  catches it.

**The general principle: a corpus of only happy paths tells you what your system
does when nothing is wrong, which you already knew.**

### Online — after you ship

Grade real traffic. Catches what nobody thought to test — which is most of it,
because real users ask things you did not imagine.

The expiry-count bug was found this way. **No curated corpus contained it,
because nobody thought of it.** That is the argument for online evaluation in one
sentence.

### The loop that makes it compound

```
   OFFLINE                                    ONLINE
   fixed cases                                real traffic
   "did I break it?"                          "is it still good?"
        ▲                                          │
        │                                          │
        └──────── a production failure ────────────┘
                  becomes a permanent test case
```

`pnpm evals promote` does that last step. Without it, the corpus is a snapshot
that slowly ages into irrelevance; with it, every bug you find once can never
come back unnoticed.

---

## Part 6 — Where the industry is, and where we are

Published 2026 guidance, what we do, and *why* — because "we match the
benchmark" is a weaker answer than "here is the reasoning and here is our
number."

### Sampling: 1–5% of traffic

**Industry:** grade a small fraction of live traffic with a judge; raise it for
high-risk or low-volume flows.

**Reasoning:** each judgement costs roughly $0.01–0.10. At scale, grading
everything means the graders rival the product's own cost.

**Us: 5%.** We were at 20%, and a local rehearsal showed exactly why that is
wrong: **the judges reached 48% of total model spend.** We were spending almost
as much grading as answering. That number is the argument, not the guideline.

> **Note the asymmetry.** Guardrails (§7) run on **100%** of traffic, because
> they are regular expressions and cost nothing. Sampling is a response to cost,
> not a principle — so it applies only to the expensive checks.

### Grading never on the request path

**Industry:** scoring runs asynchronously; the user already has their answer.

**Reasoning:** a judge takes seconds. Blocking a response on it would double
latency to grade something the user cannot see.

**Us:** async, always. ✅

### Latency: percentiles, and time-to-first-token

**Industry:** track p50/p90/p99 separately, plus **time to first token**.

**Reasoning:** averages hide tails. And for a streaming UI, total time is the
wrong metric — what the user experiences is *how long the screen stayed blank*.

**Us:** p50/p95/max, plus TTFT. We do not track p99. ⚠️

This one paid for itself immediately. When we added TTFT we measured:

| Model | Time to first token (p95) |
|---|---|
| gemini-2.5-pro | **23,748 ms** |
| gemini-2.5-flash | **1,940 ms** |

A **12× difference** in how long a user stares at nothing. It had been invisible
because total latency — 24s vs 24s — looked identical. **The metric you do not
have is a problem you cannot see.**

### A small number of high-signal metrics

**Industry:** few, well-chosen judge metrics.

**Reasoning:** every extra rubric costs money per call and adds a number someone
must interpret. Ten mediocre metrics are worse than three good ones.

**Us: 8 rubrics.** More than advised. ⚠️ A fair interview answer: *"more than the
guidance, and we would consolidate before scaling traffic."*

### Human review, weekly minimum

**Industry:** at least weekly; more during active development.

**Reasoning:** it is the only check on the judge, and judges drift as models and
prompts change.

**Us: no cadence set, zero labels so far.** ❌ Our biggest honest gap.

### Guardrails

**Industry:** deterministic checks for secrets, PII, schema validity, refusal
rate.

**Us:** yes, on 100% of traffic. ✅ See §7.

### Production failures become test cases

**Industry:** the core improvement loop.

**Us:** `pnpm evals promote`. ✅

### Summary

| | Industry | Us | |
|---|---|---|---|
| Judge sampling | 1–5% | 5% | ✅ |
| Async grading | always | always | ✅ |
| Cost per request | first-class | per surface/model/call | ✅ |
| Time to first token | tracked | tracked | ✅ |
| Step-level grading | recommended | yes | ✅ |
| Guardrails | standard | 100% of traffic | ✅ |
| Failures → test cases | core loop | `evals promote` | ✅ |
| Latency percentiles | p50/p90/p99 | p50/p95/max | ⚠️ |
| Judge metric count | few | 8 | ⚠️ |
| Human review | weekly | none yet | ❌ |
| Implicit signals | standard | thumbs only | ❌ |

**The honest summary: the expensive, structural parts are at or above standard.
The gaps are cheap — a calendar slot, and recording retries.**

---

## Part 7 — Guardrails

Different question from quality. The judge asks *"was this good?"*; a guardrail
asks *"did it do something it must never do?"*

| Check | Fires when |
|---|---|
| `guard:secret_leak` | An API key, token or private key appears in output |
| `guard:payment_data` | A Luhn-valid card number or IBAN appears |
| `guard:schema_valid` | A JSON-returning feature returned prose |
| `guard:empty` | The user got nothing back |
| `guard:refusal` | *a rate, never a failure* |

**Three design decisions worth being able to defend:**

**1. 100% of traffic, never sampled.** They are regex. Checking the other 95%
costs nothing, and a leak found in one request out of twenty is a leak missed in
nineteen. *Sampling a free check is all downside.*

**2. Zero tolerance, not configurable.** One leaked credential is an incident,
not a dip in a metric. Any non-zero number someone chose is a number someone
will argue about during an incident.

**3. We deliberately do NOT flag emails, phone numbers, addresses or names.**
This is a contract product — the documents are full of them and surfacing them
is the job. A privacy rule firing on every counterparty email would be noise on
nearly every request, and **a guardrail that cries wolf gets switched off within
a week**, after which it protects nothing.

That last one is the most interview-worthy point here: the hard part of a
guardrail is not detection, it is **avoiding false positives well enough that
people leave it switched on.** Our card check requires card-shaped **and**
Luhn-valid **and** grouped formatting — so `4539148803436467` written as a
contract value passes clean, while `4539 1488 0343 6467` is flagged.

---

## Part 8 — Likely interview questions

**"How do you evaluate an LLM feature?"**
Two loops. Offline against a fixed corpus before shipping — catches regressions.
Online against real traffic continuously — catches what nobody thought to test.
Three grading sources: deterministic code wherever a right answer exists, an LLM
judge where it does not, humans as ground truth. Cheapest check that can answer
the question wins.

**"How do you know your judge is right?"**
You do not, until a human checks it. We queue a *mixed* sample — traces the judge
passed and failed — because only-failures cannot reveal false positives. Then we
measure agreement. Ours has been confidently wrong twice, both times because of
what it was *not* shown.

**"Why not just use accuracy?"**
Because most of these questions have no single right answer, and because one
number cannot tell you *which step* failed. A wrong answer from a good lookup and
a wrong answer from a bad lookup need opposite fixes.

**"How do you handle non-determinism?"**
Split the question. Replay recorded model responses to test the code
deterministically; judge the answer quality separately, and read it as a trend
across runs rather than a pass/fail on one run.

**"What do you sample, and why?"**
Judge-based checks at 5%, because they cost $0.01–0.10 each and at 20% ours were
48% of total model spend. Guardrails at 100%, because they are free.

**"Why not just score everything pass/fail?"**
Because a boolean forces a cliff edge, and it hides *where* the failure is. An
answer missing one caveat and an answer inventing a liability cap both score 0;
over a week both read as "83% pass". And in a real run of ours, `tool_selection`
was 100% while `retrieval_sufficiency` averaged 0.20 — the agent chose correctly
and got back nothing useful. Boolean-only would have shown 100% and we would have
shipped a broken lookup. Numeric answers *how well*, categorical answers *what
kind of failure*, boolean answers *did it do the right thing*.

**"How do you stop an LLM judge drifting between runs?"**
Anchor every level of the scale. "Score 0–1 for groundedness" makes the judge
invent a scale each time; defining what 0.7 and 0.3 mean makes the number
reproducible enough to trend. Then check the judge against human labels — anchors
make it consistent, not correct.

**"How do you evaluate a multi-step agent?"**
Score at the level that can fail. Per-call scores miss sequence failures entirely
— four identical `contract_search` calls each score "right tool", while the turn
is obviously looping. So we score the ordered tool list once per turn
(`trajectory`) alongside the per-call scores, and only when a turn used more than
one tool.

**"What's your biggest gap?"**
No human review cadence, so the judge has no baseline. Everything downstream of
it is an untested assumption.

---

*Hands-on next: `LANGFUSE-HANDBOOK.md` — reading a real trace, and setting up a
judge yourself.*
