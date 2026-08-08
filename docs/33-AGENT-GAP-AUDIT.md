# 33 — Agent gap audit: where we stand against what buyers expect

**The question this answers:** do we have a state-of-the-art agent for in-house
legal teams — one that can actually automate contract work across the whole app
surface, not just answer questions about it?

**Short version:** the tool layer is unusually good and the loops on top of it
are unfinished. Most gaps below are assembly, not invention.

This audit was produced on 2026-08-06 and previously lived only in a published
artifact. It is recorded here because it is the roadmap, and a roadmap that
exists only in a chat transcript is not a roadmap. Status columns are kept
current; the ranking itself is preserved as written.

---

## The eight gaps, ranked

Ranked by buyer consequence per unit of effort, not by technical interest.

### #1 — Full-document playbook redlining, with a sendable Word file ✅ SHIPPED

*"Upload third-party paper, get a complete first-pass markup"* is the use case
in-house teams cite first, and every serious competitor ships it. We had every
part — the playbook checker finds deviating clauses, the redline proposer
rewrites them, the versioning engine applies them behind confirmation. Nobody
had assembled the loop. The output must include real Track-Changes DOCX,
because counterparty exchange happens in Word; without it this ships as a demo
that cannot produce a sendable document.

**Effort:** 4–6 weeks incl. DOCX out.
**Status:** complete across all five phases — see
`docs/35-FULL-DOCUMENT-REDLINING-PLAN.md`. In production 2026-08-08. Took
substantially less than the estimate.

### #2 — Close the broken loops the agent already 90% has ← NEXT

Register the missing tools: the redline-apply tool the agent's own instructions
reference but that was never registered; template list; user search so "assign
to Alice" can work; approve/reject. Wire the dead export buttons to the
PDF/DOCX/CSV backend that already exists. Put drafting behind the confirmation
gate. Real token streaming.

**Builds on:** existing endpoints — these are thin wrappers.
**Effort:** ~1–2 weeks total.
**Status:** in planning — `docs/36-AGENT-LOOPS-PLAN.md`. Sharpened by #1
shipping: the batch redline endpoints and the tracked-changes DOCX export are
all unreachable from the agent.

### #3 — Eval suite for the agents

We cannot claim quality, swap models, or safely edit the 240-line system prompt
without measurement. The harness is already built and running in CI — guarding
four toy cases. Convert the existing manual-audit rules into ~50 real cases
against the live HTTP path.

**Builds on:** `evals/runner.py` harness + `EVAL_USE_HTTP` plumbing (exists).
**Effort:** 1–2 weeks to meaningful coverage.

### #4 — Email-native intake triage

*"Lawyers wake up to a queue that's already been handled."* The hard part
exists: inbound email already ingests counterparty documents with sender auth,
and parse/classify/extract runs automatically. Add: after ingest, run review +
playbook check + the #1 redline pipeline, route it, and notify through the
existing Slack/webhook worker.

**Builds on:** `inbound-email.ts` + the `agent.worker.ts` pattern.
**Effort:** 2–3 weeks, after #1.

### #5 — Let the agent act on obligations and renewals, then come to you

Today the agent reads cached analysis and tells users to click UI buttons. Make
the pipelines agent-triggerable, add obligation create/complete, then ship the
proactive renewal brief: daily scan → agent prepares terms, spend, counterparty
history, negotiation points → delivered to Slack/email with a deep link. The
cheapest path to a genuinely agentic "it came to me" moment.

**Builds on:** `scan.worker.ts` + renewal-advice pipeline + webhook delivery.
**Effort:** 3–4 weeks combined.

### #6 — Bulk tabular review, and artifacts that persist

The Legora Tabular Review / Harvey Vault bar: ask one question across 50
contracts, get a grid, export it to XLSX. Diligence rooms already bulk-ingest 50
files; the compare matrix exists but is capped at 10×10 and artifacts vanish on
refresh (ephemeral React state). Persist artifacts, raise limits with batching,
wire XLSX export.

**Builds on:** `diligence.ts` + `portfolio_compare` + `ArtifactPane`.
**Effort:** 3–4 weeks.

### #7 — Agent memory that writes, toward self-maintaining playbooks

Org and counterparty memory exist but are read-only; the agent never learns. Add
write tools and negotiation-outcome capture, feeding playbook generation from
history — the path from "playbook checker" to "playbooks that maintain
themselves."

**Builds on:** memory tables + the playbook rules engine.
**Effort:** 4+ weeks, staged.

### #8 — Word add-in (and MCP) — sequenced, not skipped

The single widest buyer-bar gap, but a new platform surface — and Microsoft now
ships a free Legal Agent in Word, so it cannot be deferred forever.
Track-Changes *export* is covered by #1; the interactive add-in is a
quarter-scale bet for after the above. An MCP server (~2–3 weeks; our tool layer
is unusually MCP-ready) matters once we are fielding enterprise RFPs — not
before first revenue.

**Effort:** add-in quarter-scale · MCP 2–3 weeks, deferred until RFP pressure is
real.

---

## What buyers expect an agent to do in 2026

The checklist, with our status.

| Expectation | Status | Covered by |
|---|---|---|
| Answer questions across all contracts, with citations | Have it | Ship as-is; render citations on `/agent` |
| Draft a contract from a template or plain English | Have it | Rough edges in #2 |
| Redline third-party paper against our playbook, end to end | **Shipped** | #1 — complete |
| Deliver work as files — Word redlines, Excel trackers, reports | Partly — Word redline shipped, other buttons still dead | #1 done · #2, #6 |
| Custom PPT / board decks | None | Genuine market whitespace — nobody has productized it. A differentiator bet for *after* first revenue |
| Take uploads / email attachments and triage them unprompted | Ingests, doesn't act | #4 |
| Create and maintain templates and playbooks | Manual only | #7 |
| Chase renewals/approvals proactively with prepared briefs | Alarms, no agent | #5 |
| Work where lawyers work — Word, email, Slack | Chat-only | #4, #8 |
| Prove it's safe: previews, undo, audit, permissions, evals | Rails yes, evals no | Week zero (`docs/34`) + #3 |

---

## The through-line

The recurring pattern is not missing capability — it is **capability that exists
and is unreachable**. The redline engine existed in pieces and was never
assembled (#1). The tools exist and are not registered (#2). The eval harness
exists and guards four toy cases (#3). Ingest exists and does not act (#4). The
pipelines exist and are not agent-triggerable (#5). Artifacts exist and do not
persist (#6). Memory exists and is read-only (#7).

That is a good problem to have — assembly is cheaper than invention — but it
means the honest measure of progress is never "does the code exist," it is
**can a user reach it**. Every plan under this audit is written to that
standard.
