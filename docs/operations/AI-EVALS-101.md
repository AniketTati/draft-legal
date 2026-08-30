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

> **groundedness** — Is every factual claim in the ANSWER supported by the SOURCE
> material or the conversation input? Score 0 if the answer states a contract
> term, party, date, or figure that does not appear in the source. An answer that
> correctly says it does not know scores 1. Fluent invention is the failure this
> catches.

**Why the rubric is written that way** — three deliberate properties, and an
interviewer may well probe them:

1. **One property per rubric.** "Is this a good answer?" produces a number that
   drifts with the model and correlates with nothing. Each rubric asks exactly
   one question.
2. **It names what a 0 looks like.** Vague rubrics get vague scores.
3. **It resolves the ambiguous case explicitly** — "an answer that correctly
   says it does not know scores 1." Without that line, a judge penalises the
   agent for the *correct* refusal, which is the opposite of what you want.

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

**"What's your biggest gap?"**
No human review cadence, so the judge has no baseline. Everything downstream of
it is an untested assumption.

---

*Hands-on next: `LANGFUSE-HANDBOOK.md` — reading a real trace, and setting up a
judge yourself.*
