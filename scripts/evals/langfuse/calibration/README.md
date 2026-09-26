# Calibration examples

Human-corrected cases, injected into the judge's prompt as worked examples.

`examples.json` is **generated**, not hand-written:

```bash
pnpm evals annotate -- --emit-examples
```

It reads the traces where a human labelled a case AND the judge disagreed, and
writes each one out as a short example: the input, the answer, the correct
verdict, and the human's reason.

`scorers.mjs` and `evaluators.mjs` both load this file and append the examples to
the rubric, so the same corrections reach the script-run judge and Langfuse's
in-platform one.

## Why examples rather than a longer rubric

You cannot train an LLM judge from labels — there is no gradient, no fine-tune,
nothing that learns. The only lever is the prompt. Adding *"here is a case you
got wrong and here is the right answer"* is the standard way to move a judge,
and it works because the failure is usually not a missing rule but an ambiguous
one that a concrete case resolves.

## Keep it small

Every example is tokens on every judgement, forever. A dozen well-chosen
corrections beat fifty. Prefer the ones where the judge was confidently wrong in
a way that would recur, and drop examples whose behaviour the rubric now covers
outright.
