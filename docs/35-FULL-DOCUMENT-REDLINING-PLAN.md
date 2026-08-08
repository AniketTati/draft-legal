# 35 — Full-document playbook redlining, with a sendable Word file

**Goal:** upload the other side's paper, get back a complete first-pass markup
against our playbook, review it change by change, and send a `.docx` the
counterparty can open in Word with real tracked changes.

This is gap #1 from the agent audit — the capability every serious competitor
ships and the one in-house teams name first. Estimated 4–6 weeks.

**Status:** All five phases built and verified. Phases 0–3 are deployed to
production (2026-08-08 — the first successful deploy since 2026-08-02, unblocked
by W0-7 in `docs/34`). Phase 4 is on `feat/redline-phase4`.

**The one check nobody has run:** opening the generated `.docx` in Microsoft Word
and in Google Docs and driving Accept All / Reject All by hand. Neither
application exists on the development machine, so every Phase 4 assertion is
structural — XML validity, byte-level checks, and simulated resolution. That is a
proxy for the question that actually decides whether this feature works. It is
~20 minutes on a machine with Word and it should happen before a generated file
goes to a real counterparty.

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

**Check:** `scripts/redline/p1-batch-propose.mjs`. **Result: 0/5 → 23/23.**

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

#### A real quality defect, found by measuring rather than asserting

The grounding assertion failed intermittently. Rather than widen it, the hit
rate was measured — and the model was **substituting a different figure for the
playbook's** in roughly 1 in 6 rewrites:

| | Capped at all | Capped at **our 2x** |
|---|---|---|
| Before hardening | 12/12 | **10/12** |
| After hardening | 16/16 | **16/16** |

A cap at some other number is a perfectly good clause and a **wrong redline** —
it quietly substitutes another position for the org's, and reads entirely
convincingly while doing it. A reviewer skimming twelve clauses approves it.
That is exactly the silent failure this feature exists to remove, and it would
have shipped as "working".

One run produced something worse: `SHALL BE LIMITED TO [MUTUALLY AGREED…` — an
unfilled **placeholder** in contract text. It does not read as wrong; it reads
as finished.

Two fixes, because a prompt rule is a request and this needed a guarantee:

- **Both** prompts (batch and single-clause) now state that carrying the
  playbook's figures through exactly is non-negotiable, and say why: a cap of a
  different size is a different position, applied to a real contract as though
  it were ours.
- A **deterministic guard** refuses any rewrite containing a fill-in-the-blank.
  Verified it catches `[MUTUALLY AGREED AMOUNT]`, `[insert date here]`, `____`
  and `TBD` while leaving legitimate citations like `[Exhibit A]` alone.

Both are permanent assertions now, not one-off measurements.

**A brittle assertion, caught and fixed.** The grounding check first demanded
the literal token `2x` and failed on a run where the model wrote "two times"
instead. Inspecting the output showed the grounding was *working perfectly* —
the rationale even named the position. The check now accepts any faithful
phrasing of the same position while still catching a rewrite that ignored it
entirely. Asserting on exact model wording tests the model's vocabulary, not the
code.

### Phase 2 — Multi-clause apply in ONE version ✅ **done** (2026-08-07)

The scout was explicit that looping `applyClauseProposal` is unsafe: each call
creates a version, and `findNormalizedSpan` **refuses on ambiguity** — if
splice #1's text happens to contain clause #2's language, splice #2 sees two
occurrences and returns `null`.

So: compute **all** spans against one immutable in-memory body **before** any
mutation, then apply **back-to-front by offset**. One new version, one audit
event, one undo target. `metadata.redline` becomes an array.

**Check:** `scripts/redline/p2-batch-apply.mjs`. **Result: 0/5 → 16/16.**

#### The ambiguity trap was real, and worse than the plan assumed

The plan predicted sequential apply would *refuse* on the second clause. It was
verified before building, and what it actually does is worse — it **edits the
wrong clause and reports success**:

```
apply A -> 200 spliced
apply B -> 200 spliced  matchMode=exact

FINAL BODY:
  Liability is capped at 2x fees. This Agreement shall be governed by
  the laws of the State of Delaware.          <- clause A, corrupted
  This Agreement shall be governed by the laws of the State of New York
  without regard to conflicts.                <- clause B, unchanged
```

The user accepted "change governing law to Delaware". They got a liability
clause with a governing-law sentence spliced into it, and a governing-law clause
still saying New York — reported as `spliced: true, matchMode: 'exact'`.

**Root cause:** the ambiguity guard existed only on the *normalized* tier.
`exact` and `escaped` took the first `indexOf` hit blindly. Clauses quote each
other routinely, so once A's replacement contained B's wording, B's text
appeared twice and the splice took the copy inside A.

That is a live defect in the **single-clause** path, not just a batch concern —
so the guard now covers every tier. A duplicated clause refuses with the same
`409 CLAUSE_TEXT_NOT_FOUND` the review drawer already renders, with its
"add as an amendment instead" escape hatch (Week 0).

#### What shipped

`applyClauseBatch` locates every span against **one immutable snapshot** of the
body, then splices **back-to-front by offset** so later edits cannot disturb
earlier ones. Eight clauses land as **one** version with one undo target, and
`metadata.redline` became an array so a batch version records every clause it
changed — a single object could only record one, which would have left a future
OOXML serializer able to reconstruct just one change in twelve.

Clauses that cannot be located are reported and skipped; the rest still land.

### Phase 3 — The pipeline + review UI ✅ **done** (2026-08-07)

`POST /contracts/:id/redline-against-playbook` → `202` + `_playbookRedlineStatus`,
following the established polling pattern. Worker: check → batch propose →
stage. Staged, **not applied** — the user reviews first.

The UI is mostly wiring: `CompareMode`'s `ChangesList` and
`lib/redline.ts`'s `resolveDiff` already do per-change review and
decision→HTML resolution. Feed staged proposals into that shape rather than
inventing a second review surface. And **finally read `_playbookReview`** —
today it is written and rendered nowhere.

**Check:** `scripts/redline/p3-pipeline.mjs` (**0/1 → 22/22**) and
`scripts/redline/p3-ui-verify.mjs` (**12/12**).

`POST /contracts/:id/redline-against-playbook` → `202` + `_playbookRedlineStatus`
in contract metadata, which the detail page polls at 4s. The worker chains
check → batch propose → **stage**. Accepting a subset applies exactly that
subset as one version (Phase 2).

The API check's control is a **compliant** clause: a pipeline that stages all
three is rewriting everything rather than reading the checker.

#### The UI test earned its place — two bugs the API layer could not see

**1. The page stopped polling.** `ContractDetailPage`'s `refetchInterval`
enumerates which in-flight conditions keep it fetching, and
`_playbookRedlineStatus` was not among them. It fetched once, returned `false`,
and stopped — so the rail sat on "Reviewing every clause…" forever on a job
that had already finished, with nothing telling the user to refresh. Worse, the
rail carried a comment asserting the opposite; both are fixed.

**2. Opening the contract made accepting impossible.** Loading the page
triggers the editor's autosave, which creates versions **without re-running
clause extraction**:

```
v1  clauses=2
v2  clauses=0   note="Edited in-place"
v3  clauses=0   note="Edited in-place"   <- CURRENT
```

The staged proposals referenced clause ids on v1, so by the time the reviewer
pressed Apply the batch looked on v3, found nothing, and returned *"None of the
requested clauses could be located in the current version"* — while those
clauses were visibly on screen. **Any reviewer who opened the document could
not accept anything**, which is everyone.

`applyClauseProposal` already solved this and documents it (P1.6). Phase 2 wrote
`applyClauseBatch` fresh and did not carry it over — and the batch is *more*
exposed, since staging happens minutes before the accept. It now resolves by
`(clauseType, sectionRef)` on the current version, falling back to the prior
clause's text, scoped to the contract. It still runs through `locateSpan`, so a
clause genuinely edited away is reported rather than force-applied.

Both are permanent assertions now: section 6 of the API check creates an
autosave-shaped version directly, and asserts not just that the apply returns
200 but that **the clause actually changed** — resolving it is not enough if the
splice does not land.

#### Also: a dead write finally has a reader

`metadata._playbookReview` had been written by the auto-review worker since
`647e3e7` and read nowhere. Now exposed at `GET /contracts/:id/playbook-review`.

#### What the rail says out loud

Coverage honesty, carried through from Phase 0: clauses with **no playbook
position** are surfaced as *"not reviewed, not approved"*, truncated runs say
so, and clauses the rewriter failed on are named individually. An omitted clause
reads as "no change needed", which is the silent miss this feature exists to
remove.

### Phase 4 — Tracked-changes DOCX ✅ built

The part with no foundation to build on. Shipped as `docx` + `parse5`:
`lib/diff.ts`, `lib/html-to-docx.ts`, `lib/revision-author.ts`,
`lib/docx-export.ts`, `GET /contracts/:id/versions/:v1Id/redline-docx/:v2Id`,
and a "Word (tracked)" action in `CompareMode`.

Checks: `scripts/redline/p4-docx.mjs` **24/24** (0/4 before) and
`scripts/redline/p4-ui-verify.mjs` **12/12**, the latter intercepting the real
browser download and unzipping what arrived — a missing auth header, a wrong
MIME type and an anchor that never fires all look identical in the DOM.

Estimated at ~2 weeks; took roughly a day, because the spike settled the library
question up front and the htmldiff work it was thought to depend on turned out
not to be a blocker (measured below).

The original plan for it follows.

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

#### Library decision (2026-08-08) — `docx` + `parse5`, decided by spike

The plan said "decide by spike, not by preference." Both approaches were built
for real: each produced an actual `.docx` containing `w:ins`/`w:del`, was
unzipped, and had its `word/document.xml` read. Three judges then weighed
correctness, maintenance cost and repo fit independently. **3–0 for `docx`.**

Both work. This was a genuine choice, not a forced one.

**The deciding argument is about what cannot be tested here.** The largest risk
on this feature is "does Word accept the file," and there is no Word and no
LibreOffice on this machine — everything so far is structural proxy (well-
formedness, python-docx, mammoth, hand-written accept/reject simulators). Word
is strict about `w:rPr`/`w:pPr` child order in a way that none of those proxies
are. The hand-rolled spike derived that order from the ECMA-376 `CT_RPr`
sequence and **got it wrong twice** — `w:rStyle` emitted last where the schema
requires it first, and `w:shd` before `w:u` where the order is `u, effect, bdr,
shd`. Both paths are reachable here (StarterKit v3 ships Link with autolink;
the editor emits `<mark>`), the author had named rPr ordering as his own top
residual risk, and **all twelve of his assertions still passed green**, because
the fixture happened to contain neither a hyperlink nor a mark. `docx` gets that
sequence right by construction, and its ordering has been debugged by other
people's users. When the deciding risk is untestable locally, prefer the option
where someone else already paid for it.

Supporting evidence: on an identical fixture, Accept All through `docx` yielded
four correct blocks, while the hand-rolled output left a stray empty paragraph
where a deleted `<li>` had been — an orphan bullet that shifts list numbering in
the accepted contract. The hand-rolled mapper also never emitted a single
`trPr/w:del` row revision; the code path exists but never fires.

The one criterion hand-rolling wins is dependency weight, and it is immaterial:
`jszip` is already in the lockfile via `mammoth`, and `apps/api` already sets
`skipLibCheck`.

**This is not unconditional.** The correctness judge stated it would switch given
a revised hand-rolled spike that fixes the two `CT_RPr` violations, replaces the
regex-based `<th>` bold, adds paragraph-mark/row inference, and actually emits
`trPr/w:del`. Nobody should read this as "libraries always win."

#### The htmldiff defect is real but narrow — measured, not assumed

The correctness judge called this the critical path: `node-htmldiff` emits
mis-nested HTML when block structure changes, `parse5` error-recovers it into
*structurally valid* OOXML, and so **"Reject All does not restore v1 whenever
block structure changes"** — ~2–3 days, gating the mapper.

That claim was written into this document and then measured. **It is wrong as
stated**, and the correction matters enough to record.

The property that actually matters is not "is the HTML well nested" — that is a
proxy. It is: *Accept All must reproduce v2, Reject All must reproduce v1.*
Resolving both ways on the parse5 tree and comparing block-text sequences gives
a direct answer.

Against **69 consecutive changed version pairs** in the dev corpus (184 versions
with HTML):

| | Accept All wrong | Reject All wrong |
|---|---|---|
| All 69 real pairs | **0** | **1** |
| Excluding the `W0-2 escape` test fixture | **0** | **0** |

The single failure is a Week 0 fixture built specifically to carry unescaped
markup. On genuine contract data the round trip is clean 68/68.

Block structure changing is *not* sufficient to trigger it. Paragraph removed,
list item removed, table row removed, and heading-renumbered-plus-paragraph-added
all round-trip faithfully. The spike's fixture fails because htmldiff aligns
`Item beta **is** removed.` with `…paragraph **is** added.` across the
`</li></ul>` boundary — it needs a block structural change *and* token
similarity spanning the boundary. That did not occur once in 69 real pairs.

Two earlier detector results were also false positives, worth noting so nobody
re-derives them: comparing block text without stripping whitespace flagged two
real SOWs, whose only difference was inter-tag whitespace that htmldiff
normalises away — same block count, same rendered text, no damage.

**So this does not gate the mapper.** Keep the block-boundary case as a
permanent regression assertion, fix it when it is cheap, and do not spend 2–3
days ahead of the deliverable on a defect with zero observed incidence.

One genuine finding does come out of it. Unescaped `<` or `&` in `htmlContent`
is tokenised by htmldiff as *markup*, so it passes through the diff wrapped in
neither `<ins>` nor `<del>`: Accept All happens to look right, while **Reject All
leaves fragments of the rejected text in the document**. Reject the
counterparty's figures and `< $50,000 & costs >` stays in your contract. Only
1 of 184 versions carries unescaped markup and it is that test fixture — but the
DOCX check should assert on it, because the failure is silent and lands in the
executable document.

#### Three defects found by scouting, each verified by hand

1. **DOCX export already ships PDF bytes.** `contracts.ts:1811` (`format=docx`)
   and `portal.ts:173` both POST HTML to Gotenberg's
   `/forms/libreoffice/convert` and label the response
   `application/vnd.openxmlformats-…wordprocessingml.document`. That route
   outputs **PDF** — this repo's own `gotenberg.ts` uses the chromium route and
   treats the result as `application/pdf`. Users get PDF bytes in a `.docx` file
   Word refuses to open. The portal one hands broken files to **counterparties**.
   There is no working behaviour to preserve; Phase 4 should fix or delete both.
   Adjacent: `contracts.ts:1777` defaults `GOTENBERG_URL` to port 3001 — the
   API's own port — while `gotenberg.ts` and `portal.ts` both use 3002.

2. **`apps/web/src/lib/redline.ts` cannot be reused server-side.** Its `parse()`
   returns `null` when `typeof window === 'undefined'`, so `extractChanges()`
   returns `[]` and `resolveDiff()` returns its input **unchanged, with no
   error**. Importing it into `apps/api` would ship a DOCX with zero tracked
   changes that looks like a successful export. Re-diff with `htmldiff` instead.

3. **`ContractVersion.createdById` is a bare `String` with no relation** — the
   model has only `contract` and `clauses` relations, so `include: { createdBy }`
   will not compile. Worse, it is not always a user id: `portal.ts` writes
   `portal:<id>` and `inbound-email.ts` writes `email:<addr>`. A naive
   `user.findUnique` returns null for exactly the counterparty-authored versions
   a redline is most about. `w:author` needs a resolution ladder.

**Effort:** ~7–10 engineer-days, of which 2–3 is the htmldiff fix — work that is
identical under either approach, which is why this choice buys almost nothing on
the delivery date and everything on year-two cost.

**Unretired, in priority order:** open the generated file in real Word and Google
Docs and drive Accept/Reject by hand (~20 minutes on a machine that has Word, and
the only observation that can invert the pick); run it through a real ECMA-376
XSD, since nothing has validated beyond well-formedness; confirm `docx` can anchor
a comment range across a `w:ins` if `rationale` is v1 scope.

#### Two claims from the spike that did not survive contact

Both were written into this document as fact and are corrected here.

**`docx` does not emit a bogus `<w:externalHyperlink/>`.** The spike reported
that nesting a hyperlink inside an inserted run silently emits a non-existent
element and drops the link text, and called it "confirmed by all three judges."
Reproduced against docx 9.7.1 by deliberately inverting the nesting: no such
element appears. The damage is real but different — the *deletion* is dropped,
so the old link target never makes it into the file and rejecting the change
cannot restore it.

This mattered practically. The check first asserted `!includes('externalHyperlink')`,
which **passed while the bug was present** — a dead assertion giving false
confidence. It now asserts that both link targets survive and that the replaced
one sits inside a `w:del`; deliberately re-introducing the inversion turns three
assertions red. Test the test, or it is decoration.

**htmldiff is blind to link text.** Measured across four shapes:

| edit | tracked |
|---|---|
| link **text** changed, same href | **no — silent** |
| link href changed | yes |
| link added | yes |
| bold text changed | yes |

Changing the visible label of an existing hyperlink produces a diff containing no
change markers at all. This is upstream of the exporter and equally invisible in
`DiffViewer` and `CompareMode`, which consume the same diff — so it is a
pre-existing review gap, not something the DOCX work introduced. The check's link
fixture deliberately changes the *href*, because a text-change fixture would
assert nothing and pass forever.

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
