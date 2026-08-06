# 35 — Full-document playbook redlining, with a sendable Word file

**Goal:** upload the other side's paper, get back a complete first-pass markup
against our playbook, review it change by change, and send a `.docx` the
counterparty can open in Word with real tracked changes.

This is gap #1 from the agent audit — the capability every serious competitor
ships and the one in-house teams name first. Estimated 4–6 weeks.

**Status:** Phases 0 and 1 complete and verified. Phases 2–4 not started.

---

## What the scouting found

Four agents mapped every piece this builds on. The short version: **more of the
UI exists than expected, less of the foundation does, and the Word half is
genuinely from scratch.**

### Better than the roadmap assumed

**Per-change accept/reject already works.** The audit said it was a disabled
"Coming in v1.1" stub. That was true of `DiffViewer`; it is not true of
`CompareMode`, which since Wave 2.1 has a real `ChangesList` sidebar with
per-item accept/reject, filter chips, accept-all/reject-all, and an
"Apply as new version" that resolves decisions to merged HTML. Crucially
`apps/web/src/lib/redline.ts` holds `extractChanges()` and
`resolveDiff(diffHtml, decisions)` — a complete decision→HTML resolver, already
tested by use. **The review UI is a wiring job, not a build.**

The long-job pattern is also settled: `202` + a status key in
`contract.metadata`, worker PATCHes the result, page polls at 4s
(`ContractDetailPage.tsx:569`). `queuePlaybookReview` already solved
version-scoped job dedupe.

### Worse than the roadmap assumed

**There are two playbook systems that do not talk to each other.**

| | Structured rules | LLM review |
|---|---|---|
| Entry | `POST /internal/ai/tools/playbook_check` | `playbook-review` BullMQ job |
| Evidence | deterministic `must_have`/`must_not`/`bounds` | one LLM call over all clauses |
| Severity | `low\|medium\|high\|walkaway` | `low\|medium\|high\|critical` |
| Reads `PlaybookPosition.rules` | yes | **no — the worker's select omits the column** |
| Result goes | to the caller | to `metadata._playbookReview`, **read nowhere** |

So the pipeline that actually runs on received contracts ignores the entire
structured-rules engine, and its output terminates in a dead metadata field.

**Three things block chaining check → propose → apply outright:**

1. **`playbook_check` never returns a clause `id`.** It selects one
   (`internal-ai.ts:1829`) and never emits it (`:1893`). Both `redline_propose`
   and `redline_apply` key on `clauseId`.
2. **Its `excerpt` is truncated to 800 chars and PII-redacted in place**, so it
   cannot serve as the splice anchor either — you would splice a `[REDACTED]`
   token into a contract.
3. **`preferredText` / `fallbackText` do not exist.** One `content` column per
   row, discriminated by `positionType`, so preferred/acceptable/fallback/
   walkaway are *separate rows*.

**Nothing batches.** `proposeClauseAlternatives` is one clause per call →
one reasoning-tier LLM call → three variants, of which we would keep one.
`applyClauseProposal` creates a **new ContractVersion per clause**. Twelve
deviations today = 12 LLM calls and 12 versions.

**The Word half is 100% new.** No OOXML writer, no zip library, nothing that
opens a `.docx` for writing. `mammoth` is import-only. `jszip` and `xmldom`
appear in the lockfile solely as `mammoth` transitives and are not importable
under pnpm's strict layout. The current `format=docx` export is a LibreOffice
HTML→DOCX conversion with no revision marks at all.

### Correctness bugs found while scouting

These are not blockers; they are wrong answers the feature would inherit.

| Bug | Effect |
|---|---|
| Clause matches a category but has no positions → `continue` (`internal-ai.ts:1887`) | Dropped silently. Not in `checks[]`, not in `unmapped[]`. A half-covered contract reads as fully covered. |
| Position with prose but no `rules` JSON → empty violations | Reads identically to "passed". |
| `passed` is `violations.filter(...).length` | A **count**, not a boolean. Truthy for one passing rule. |
| `SEVERITY_ORDER` has no `critical`; `indexOf` → −1 | Any later `low` violation **overwrites** a `critical`. Silent severity inversion. |
| `maxClauses` capped at 30, `totalClauses` reports the *capped* count | Callers cannot detect truncation. |
| `bounds` violations always carry `passed: null` unless judged | Numeric caps contribute **zero** severity on the default path. |
| Three different clauseType→category matchers that disagree | `limitation-of-liability` matches in `playbook_check`, misses in `redline_propose`. |
| `redline_propose` only ever loads the `preferred` position | Fallback language never reaches the rewriter. |
| `versionNumber = current + 1` computed outside the transaction | Two concurrent applies collide on `@@unique([contractId, versionNumber])`. |

---

## Plan

Five phases. Each lands something demonstrable; nothing is merged without the
check beside it passing.

### Phase 0 — Repair the foundation ✅ **done** (2026-08-06)

Not glamorous, and skipping it means building the flagship feature on a checker
that silently under-reports.

- Emit `clauseId` from `playbook_check`, and a **raw** (un-truncated,
  un-redacted) anchor for splicing — or better, have the pipeline re-read clause
  text server-side and never round-trip it through the tool response at all.
- Add a document-level rollup: `worstSeverity`, `deviationCount`,
  `coveredClauses`, `uncoveredClauses`, `truncated: boolean`.
- Report clauses dropped for having no positions, instead of `continue`.
- Add `critical` to `SEVERITY_ORDER`, or normalise the LLM path onto
  `walkaway`. One vocabulary, not two.
- Unify the three category matchers on `normalisedKey`.
- Raise/paginate `maxClauses` and make truncation visible.
- Compute `versionNumber` inside the transaction.

**Check:** `scripts/redline/p0-playbook-check.mjs` — one fixture contract
exercising every defect: a clause whose category has no positions, a `critical`
rule followed by a `low` one, a hyphenated clause type, and 43 clauses total.

**Result: 3/16 → 25/25** (the check grew after the first pass — see below). Every failure was real on the code as merged:

| | Before | After |
|---|---|---|
| Whole document checkable | `400` at 30 clauses | 43 requested, 43 examined |
| `clauseId` on each check | absent | present, resolves to the real row |
| Document rollup | none | `worstSeverity`, `deviationCount`, coverage |
| `totalClauses` | 30 (the cap) | 43 (the truth) |
| Clause with category, no positions | vanished | `uncovered[]` with a reason |
| `critical` + later `low` | `worstSeverity: low` | `worstSeverity: critical` |
| Hyphenated type → rewriter | `hasPlaybook: false` | `hasPlaybook: true` |
| `passed` | `0` (a count) | `false` (a verdict) |

Two things worth recording:

- **The fixture was vacuous on first run.** It used `Indemnification` as the
  "category with no positions" case — but the org seed ships four positions for
  it, so that assertion passed without testing anything. It now creates a
  category it fully controls. A check that passes for the wrong reason is worse
  than one that fails.
- **`severityRank` ranks unknown values HIGH, not low.** `indexOf` returning
  `-1` is what caused the inversion; making unknowns rank at the bottom would
  have preserved the bug in a new form. If we cannot interpret how serious
  something is, the safe reading is "serious".

Also fixed here, ahead of Phase 2: `versionNumber` is now derived inside the
transaction from the contract's true high-water mark. It was computed outside
against a `@@unique([contractId, versionNumber])` constraint — fine for
one-clause-at-a-time, a routine collision once a batch applies several.

#### Re-audit of Phase 0 (the first pass was incomplete)

The 16/16 above was a green result on a check that did not cover everything the
change touched. Re-examining it found two defects **introduced by the fix
itself**:

1. **Raising `maxClauses` 30 → 500 armed an unbounded fan-out.** The judge
   branch ran `Promise.all(checks.map(…))` with one LLM round-trip per check.
   Safe at 30; at 500 it would have opened 500 simultaneous model calls and
   taken the request down with the provider's rate limit. Now a fixed pool of 6,
   writing results back by index so order is preserved.
2. **The judge branch silently reverted the field-semantics fix.** It builds its
   own result objects and still set `passed` as a *count* and never set
   `failedCount` — so `judge: true` undid the boolean verdict AND made
   `summary.deviationCount` read zero. Both paths now emit the same shape.

Neither was visible from the original check, because it never exercised
`judge: true`. Three sections were added: judge-mode field parity, an
unrecognised severity ranking above a later `low`, and the
`positions_have_no_rules` case. **25/25.**

The lesson worth keeping: the check was written against the *symptoms listed in
the plan*, not against the *surface the change touched*. A second code path
building the same response shape was exactly where the regression hid.

#### UI verification (it was missing entirely)

Phase 0 changed a response shape the browser consumes, and the first pass only
**typechecked** the renderer. That proves nothing here: `Number(someBoolean)`
compiles perfectly and would have rendered "0 passed" or "1 passed" for every
clause in the document regardless of its rules.

`artifact-from-tool.ts` is the only UI consumer of `playbook_check` (verified by
grep, not assumed). It now has unit coverage against real response fixtures —
including a **pre-Phase-0 payload**, because an agent turn can replay a tool
result recorded before the change and a stale tab can receive one mid-deploy.
Degrading is fine; throwing is not. 6/6.

Two things the screenshot caught that no assertion had:

- **The probe was polluting the product.** Its categories are org-scoped and the
  Playbook page lists every category, so "P0 Probe — Unknown Severity" was
  sitting in front of a real user. A check that dirties the thing it checks is
  not finished.
- **Its cleanup was failing silently.** `contract.deleteMany(...).catch(() => {})`
  cannot delete a contract that still has versions and clauses, and the `catch`
  turned that into silence — ten probe contracts had accumulated. Cleanup is now
  leaf-first and unconditional. Swallowing an error is only acceptable when the
  failure genuinely does not matter.

Verified after: 25/25 API, 6/6 renderer, 15/15 Playwright, Playbook page free of
probe data, and re-running the probe twice leaves nothing behind.

### Phase 1 — Batch propose ✅ **done** (2026-08-07)

A new Python `POST /redline_propose_batch` taking N clauses in one request,
returning one variant per clause at a chosen aggression (not three — we discard
two today). Node-side concurrency cap so a 40-clause contract doesn't fan out
40 simultaneous reasoning calls.

Grounding must improve at the same time: pass **all** position types, not just
`preferred`, so the model can aim at `acceptable` when `preferred` is
unreachable — which is what a negotiator actually does.

**Check:** `scripts/redline/p1-batch-propose.mjs`. **Result: 0/5 → 13/13**,
stable across three consecutive runs.

Two clause types with deliberately distinct playbook positions (a 2x liability
cap; Delaware governing law), so a batch that grounds every clause in one shared
playbook produces a liability rewrite talking about Delaware — the failure that
would otherwise look completely plausible in the output.

| Assertion | Result |
|---|---|
| One call rewrites N clauses | one HTTP call, one proposal each |
| Each clause hits **its own** position | liability → "two times (2x) the fees"; governing law → Delaware |
| No cross-contamination between clauses | neither borrowed the other's marker |
| One variant per clause, not three | confirmed |
| A bad clause doesn't discard the batch | 2 usable of 3, the empty one returned `error: empty_clause_text` |
| Fan-out is bounded | `asyncio.Semaphore(6)` in the Python route |
| All position types reach the rewriter | `preferred` + `fallback` both sent |

**What shipped**

- `POST /redline_propose_batch` (Python) — N clauses, one variant each at a
  chosen posture, `asyncio.Semaphore(6)`. Each clause is an independent model
  call so one failure cannot take the others with it, and every requested
  clause gets an entry — a *missing* entry is indistinguishable from "no change
  needed", which is the silent miss this feature exists to remove.
- `lib/clause-propose-batch.ts` — loads each clause's own category and
  positions, and back-fills an explicit `no_response` entry for anything the
  service didn't answer on.
- The single-clause path now sends **all** position types too. It had only ever
  loaded `preferred`, so its "least aggressive" variant had nothing of ours to
  anchor on but the counterparty's text.

**A brittle assertion, caught and fixed.** The grounding check first demanded
the literal token `2x` and failed on a run where the model wrote "two times"
instead. Inspecting the output showed the grounding was *working perfectly* —
the rationale even named the position. The check now accepts any faithful
phrasing of the same position while still catching a rewrite that ignored it
entirely. Asserting on exact model wording tests the model's vocabulary, not the
code.

### Phase 2 — Multi-clause apply in ONE version (~1 week)

The scout was explicit that looping `applyClauseProposal` is unsafe: each call
creates a version, and `findNormalizedSpan` **refuses on ambiguity** — if
splice #1's text happens to contain clause #2's language, splice #2 sees two
occurrences and returns `null`.

So: compute **all** spans against one immutable in-memory body **before** any
mutation, then apply **back-to-front by offset**. One new version, one audit
event, one undo target. `metadata.redline` becomes an array.

**Check:** `p2-batch-apply.mjs` — apply 8 clauses at once. Assert exactly one
new version (not 8), every clause replaced, html and plainText agree, undo
returns to the single pre-batch version, and the deliberate ambiguity case
(clause B's text appearing inside clause A's replacement) still refuses rather
than splicing the wrong span.

### Phase 3 — The pipeline + review UI (~1 week)

`POST /contracts/:id/redline-against-playbook` → `202` + `_playbookRedlineStatus`,
following the established polling pattern. Worker: check → batch propose →
stage. Staged, **not applied** — the user reviews first.

The UI is mostly wiring: `CompareMode`'s `ChangesList` and
`lib/redline.ts`'s `resolveDiff` already do per-change review and
decision→HTML resolution. Feed staged proposals into that shape rather than
inventing a second review surface. And **finally read `_playbookReview`** —
today it is written and rendered nowhere.

**Check:** `p3-pipeline.mjs` — end-to-end on a seeded contract with known
playbook deviations. Assert status transitions, that the staged set matches the
deviations found, that accepting a subset applies exactly that subset, and that
a page reload mid-run recovers the state. Plus Playwright over the review
screen.

### Phase 4 — Tracked-changes DOCX (~2 weeks)

The part with no foundation to build on.

- Add a real dependency — `docx` (has `TrackedChanges` support) or
  `jszip` + hand-written WordprocessingML. Decide by spike, not by preference.
- HTML→WordprocessingML mapper covering what TipTap actually emits:
  `p`, `h1-3`, `ul/ol/li`, `blockquote`, `pre/code`, `table`, `strong/em/s/u`,
  `mark`, `span[style]`, and block `text-align`.
- Wrap changed spans in `<w:ins>` / `<w:del>` + `<w:delText>` with `w:author`
  and `w:date`.
- **Source of truth is a re-diff**, not stored metadata. `metadata.redline`
  exists only for versions created by `redline_apply` — never for editor saves,
  uploads, or template output. `htmldiff(prev.htmlContent, cur.htmlContent)` is
  the honest input, with `metadata.redline` as optional author/rationale
  enrichment.
- Resolve `createdById` to a display name for `w:author`; nothing does today.

**Check:** `p4-docx.mjs` — generate, then **unzip and assert on
`document.xml`**: `<w:ins>` and `<w:del>` present, every `w:id` unique and
numeric (Word silently drops duplicates), `w:date` ISO-8601 with `Z`, and
`<w:delText>` used inside deletions. Then the check no script can do: **open it
in Word and in Google Docs** and confirm Accept/Reject All behaves. A DOCX that
validates but renders wrong is still a failure.

---

## How this is verified

Same discipline as Week 0 (`docs/34-AGENT-HARDENING-PLAN.md`): one runnable
check per phase in `scripts/redline/`, each stating its **before** and **after**
expectation so it is meaningful to run before the fix. API first, Playwright
second, and a manual Word/Google-Docs open for Phase 4 because no assertion
substitutes for it.

A check that has never failed hasn't proven anything — Phase 0's check should be
written first and should fail on today's code.

---

## Deliberately not in scope

- **Autonomous negotiation** (Luminance/Spellbook ACM). This ships a first-pass
  markup a human reviews, not a loop that answers the counterparty.
- **An interactive Word add-in.** Track-Changes *export* is in Phase 4; a live
  add-in is a separate platform surface and a quarter-scale bet.
- **Rewriting the LLM review path.** Phase 0 reconciles the two systems' output;
  merging them into one engine is follow-up work.

## Open questions for the founder

1. **One aggression or three?** Batch proposing three variants per clause triples
   cost for output we mostly discard. Recommendation: batch at a single
   configurable aggression, keep three-variant on the single-clause drawer path.
2. **Auto-run on receipt, or on demand?** `647e3e7` already auto-runs a playbook
   review on freshly received contracts. Chaining a redline onto that is a
   meaningful spend increase per uploaded document.
3. **Does an unresolved `walkaway` deviation block the DOCX export?** Sending
   counterparty paper with a known walkaway term unaddressed is a real risk;
   blocking it is a product decision, not a technical one.
