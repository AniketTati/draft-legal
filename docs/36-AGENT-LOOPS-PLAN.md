# 36 — Close the broken loops the agent already 90% has

**Goal:** every capability this platform has built should be reachable by asking
for it in plain English, and every agent action should either happen or say why
it didn't.

This is gap #2 from `docs/33-AGENT-GAP-AUDIT.md`. It is not a capability
programme — the capabilities exist. It is the assembly work that turns 26 tools,
37 internal endpoints and a five-phase redlining engine into something a user can
actually reach from the chat box.

**Why the agent is the product.** Buyers do not evaluate a contract database in
2026; they evaluate whether the assistant can do the work. Every surface in this
app is reachable another way — the Contracts page, the review drawer, the
approvals queue. The agent is the only surface that is *the reason to buy*, and
it is currently the least finished thing we ship. Right now the flagship feature
this repo spent five phases building — full-document playbook redlining with a
tracked-changes Word file — cannot be triggered, applied, or exported by asking
for it. That is the sharpest argument in this document.

**Estimated 3 weeks.** `docs/33` said 1–2. The scouting found roughly twice the
work, including two blockers and a tenancy failure nobody had named.

---

## How these findings were established

Six scouts mapped one surface each against the live code, then a separate
adversarial verifier re-read every claim in the file it cited before any of it
was written down. The six:

| Scout | Surface |
|---|---|
| `registry` | every registered tool, every internal endpoint, and the delta between them |
| `loop` | the orchestrator's iteration loop, SSE transport, and both web clients |
| `gate` | which writes stop and ask, and which do not |
| `buttons` | every control in the web app diffed against the 268 registered API routes |
| `prompt` | the 240-line `AGENT_SYSTEM_PROMPT` against what the tools actually return |
| `missing` | the six named capabilities from `docs/33` and what each would cost |

A seventh pass — a completeness critic instructed to find only what the six had
missed — produced seven further findings, including the one blocker in the batch
that is a tenancy boundary rather than a broken loop.

**The verification changed the list materially, which is the point of doing it.**

| Original claim | Verdict after re-check |
|---|---|
| The whole-document redline endpoints (`redline_propose_batch`, `redline_apply_batch`) are dead code with zero callers | **Dropped.** `scripts/redline/p1-batch-propose.mjs:140` and `p2-batch-apply.mjs:107` both POST them — they are the Phase 1–2 verification probes. And single-clause propose→apply *does* work in chat via `RedlinePreview.tsx:82` + `agent-threads.ts:48`. The true residue is narrower and is L5 below. |
| `redline_apply_batch` missing from `WRITE_TOOLS` means its Apply and Undo buttons both fail | **Dropped.** All four omissions are real, but nothing anywhere can produce a `redline_apply_batch` PendingAction — no Python tool, no frontend caller, no button. It is a latent to-do for L5, not a defect a user can reach. |

Eighteen further claims survived but were **rewritten**, and the corrected
wording is what appears below. The two that mattered most:

- *"The agent emits a `redline_apply` tool call that errors."* Unlikely —
  tool-calling APIs constrain names to the bound catalog. The real risk is
  **narration**: nothing stops the model from saying it applied a variant it
  never applied.
- *"Ten tools are invisible to the model."* They are not invisible — every tool
  is bound with its own routing-grade description. They are **under-weighted**
  against a routing table that names six tools repeatedly. Prompt-coverage debt
  with a likely but unmeasured selection cost, not a broken path.

---

## What the scouting found

**Better than assumed.** The tool layer is genuinely good and the confirm-gate
design is sound. Every one of the 26 registered tools has a backing endpoint —
the delta runs only in the other direction. `AGENT_SYSTEM_PROMPT` contains
**zero** phantom tool names; the class of drift that produced
`contract_create_from_template.py`'s famous docstring ("the system prompt
instructed the agent to call `template_list` + `contract_create_from_template` —
neither of which were registered") is fixed. The Week 0 permission gate at
`agent-threads.ts:59-82` works exactly as designed, and its own comment
correctly identifies itself as the only layer that can see the caller's role.
The undo machinery — 15-minute window, per-tool adapters, client timer,
audit events — is complete and correct for every tool that reaches it.

**Worse than assumed, in four ways.**

**1. The confirm gate is an emergent property, not a registry.** There is no
write-tool list on the Python side at all. Whether a tool is gated is decided
entirely by whether its own `_arun` happens to return
`{"awaitingConfirmation": True, …}` — four files do
(`comment_add.py`, `contract_update.py`, `request_create.py`,
`approval_route.py`), one does not. A tool author who forgets that one key ships
an ungated mutation with no compile-time and no review-time signal. That is
exactly how the drafting bypass happened, and
`build_contract_create_from_template` sits one line *above* the
`# Write tools` comment in `tools/__init__.py:101-102` while the file's own
docstring claims "Writes land in separate routes via the ActionPreview surface,
not through this list."

**2. The gate that exists points at the wrong endpoint.** `WRITE_TOOLS` maps
`contract_create_from_template` → `/tools/contract_create_from_template`
(`agent-threads.ts:47`, dispatched at `:383`), whose Zod schema requires
`templateId` + `variables` (`internal-ai.ts:603-613`). The Python tool of that
name posts `userMessage` / `contractType` / `counterpartyName` to a *different*
endpoint, `/tools/contract_draft` (`contract_create_from_template.py:66`,
`internal-ai.ts:3784`). Two divergent create implementations behind one tool
name. So the 15-minute undo advertised at `agent-threads.ts:409` can never fire
for an agent-drafted contract — the `ToolCall` row it keys off is never created.

**3. Every error the orchestrator can emit is swallowed by both clients.** All
four typed emitters are correct (`orchestrator.py:923,927,932`,
`routes/chat.py:104`), and both web surfaces throw from inside a frame-parse
`try` whose `catch` was written for JSON syntax errors
(`AgentHomePage.tsx:593` caught at `:596` with `// ignore parse errors`;
`SideAgentRail.tsx:533` caught at `:679` by a `console.warn` guarded on
`NODE_ENV !== 'production'`). The rail's careful friendly-error ladder at
`:737-756` — *"An admin needs to add an OpenAI or Anthropic API key…"* — is dead
code for every SSE-delivered error, because `chat.py` returns HTTP 200 and
streams the failure. There is a fifth emitter nobody noticed:
`routes/chat.py:120` emits `{"error": str(e)}` with **no `type` field**, so
`AgentHomePage`'s `evt.type === 'error'` test does not even match it.

**4. The prompt is the one file in this flow with no test and no reviewer.**
Two of the stale claims in it contradict comments written by the person who broke
them. `artifact-from-tool.ts:322` says in so many words *"Audit 2026-06-10:
dropped the save_draft / send_for_review pseudo-tool buttons"*, while
`orchestrator.py:481-484` still promises the user those buttons.
`internal-ai.ts:918` says *"Surface the fallback to the agent so it can mention
I broadened the search"*, and no prompt rule tells it to. Three of the
audit-numbered anti-hallucination rules (A3, A8, A11) are themselves inaccurate
about the data they police — A11 asserts `totalMatching` is always a DB count
when the semantic-fallback branch makes it a page count. A rule that lies about
the shape of the evidence is a hallucination generator wearing an
anti-hallucination label.

**And the through-line from `docs/33` holds exactly.** The recurring pattern is
not missing capability — it is capability that exists and is unreachable. The
last three commits on this branch (`fe07d3a`, `2fd884f`, `8432005`) built the
entire whole-document redlining capability on the user-facing REST side. **The
agent's reach did not move at all.**

---

## How this is verified

Same discipline as Week 0 (`docs/34`) and the redlining phases (`docs/35`): one
runnable check per item in `scripts/agent-loops/`, each stating its **before**
and **after** expectation, so it is meaningful to run *before* the fix — where it
must fail — and after, where it must pass. A check that has never failed hasn't
proven anything.

Reuse `scripts/week-zero/lib/harness.mjs` rather than forking it. It already
does login, authenticated requests, internal-service requests, role and org
fixtures, and pass/fail reporting against the real local stack (API `:3001`,
agents `:8002`, Postgres/Redis/ES/MinIO in Docker). Its header comment states
why nothing here is mocked: *a mock cannot catch "the Python agent forgot the
`x-internal-service` header,"* which is precisely the class of bug this document
is about.

```bash
node scripts/agent-loops/l1-session-poison.mjs
node scripts/agent-loops/l2-redline-propose.mjs
node scripts/agent-loops/l3-error-surface.mjs
node scripts/agent-loops/l4-draft-gate.mjs
node scripts/agent-loops/l5-redline-reach.mjs
node scripts/agent-loops/l6-dead-buttons.mjs      # Playwright
node scripts/agent-loops/l7-prompt-truth.mjs      # static, no stack needed
node scripts/agent-loops/l8-tool-status.mjs
node scripts/agent-loops/l9-new-verbs.mjs
node scripts/agent-loops/l10-streaming.mjs
node scripts/agent-loops/l11-cost-cap.mjs
node scripts/agent-loops/l12-memory-growth.mjs
node scripts/agent-loops/l13-dead-names.mjs       # static
```

---

## L1 — Every successful write proposal kills the thread that made it

**Severity: Blocker → corrected to High. ✅ FIXED 2026-08-08.**

**The unpaired persistence is real; the thread-killing is not.** The mechanism
below is exactly right — the awaiting-confirmation branch `continue`s before
`turn_tool_results.append(...)`, and the session stores a `tool_call` with no
matching `tool_result`. `scripts/agent-loops/l1-thread-poisoning.mjs` reproduced
it on the first run: `unanswered: comment_add(34a598d1-…)`.

But the predicted consequence did not occur. A second turn in the same thread
answered normally — clean frames, no error — including when the check pinned
`provider: 'openai'` and `modelId: 'gpt-4.1-mini'`, exactly what both web
clients send. Whatever the strict reading of the tool-calling contract says, the
provider in use tolerates an assistant message carrying an unanswered
`tool_call_id`. So this is **not** "one write per thread, then the thread is
dead," and Wave A was not blocked on it.

It is still wrong and still worth the three lines: the model loses any record
that it proposed the write, so on the next turn it cannot refer to what it just
staged, and the session is one unanswered id away from breaking on a stricter
provider or a model upgrade. Fixed by recording a result mirroring the synthetic
in-turn `ToolMessage`. Check **4/5 → 5/5**.

Two notes for whoever runs that check. It asserts the invariant across the whole
session rather than one turn, because which turn the model proposes on is not
controllable — an earlier version asserted on turn 1 and went red when the model
answered in prose first. And the agents service runs under uvicorn **without
`--reload`**, so a Python change is not live until it is restarted; the check
passed against stale code once before that was noticed.

The original finding follows.

`turn_tool_calls.append({...})` runs at `orchestrator.py:765` for *every* tool
call, before the tool executes. The awaiting-confirmation branch at `:812`
appends an in-turn `ToolMessage` and `continue`s at `:835`, so
`turn_tool_results.append(...)` at `:888` is **never reached for that call**.
End-of-turn persistence at `:943-950` fires anyway, because the guard is
`if final_text or turn_tool_calls:` — writing `tool_calls=[the write tool]` with
`tool_results=None`.

`memory.py` stores both lists verbatim with no pairing check — it is a dumb JSON
list with a 24-hour TTL (`memory.py:15`, `:44-56`). The next turn's restore at
`orchestrator.py:666-684` builds `AIMessage(content="", tool_calls=[…all
persisted…])` and then emits one `ToolMessage` per persisted **result** only.
The write tool's `tool_call_id` has no answer, and there is no pairing guard
anywhere.

Both web surfaces pin `provider: 'openai'` (`SideAgentRail.tsx:489`,
`AgentHomePage.tsx:414`). OpenAI hard-rejects an assistant message whose
`tool_call_id`s are unanswered; Anthropic rejects a `tool_use` block with no
corresponding `tool_result`. The 400 surfaces as an SSE `error` event — which L3
then swallows into a blank bubble.

Applying the action does not heal it: `/threads/:id/actions/apply`
(`agent-threads.ts:341`) never touches the Redis session.

**What a user experiences today.** They ask the agent to add a comment, change a
status, create a request, or route an approval. The Apply card appears and works
perfectly — the comment lands, the status moves. Then they type anything else in
the same chat and get a blank bubble. And the next one. The thread is dead for
24 hours; the only recovery is starting a new one. **This fires on the exact
flow the plan-then-execute surface exists to demo**, and it fires *after* the
feature appears to have worked, which is the worst possible place for it.

**The fix.** In the awaiting-confirmation branch, before `continue`, append the
same synthetic payload to `turn_tool_results` under the same `tc_id` — the
`ToolMessage` is already built at `:825-832`, so persist that same JSON. Two
lines.

Belt and braces, because this class of bug will recur: in the restore loop at
`:668`, drop any `tool_calls` entry whose id has no matching entry in the
persisted results before constructing the `AIMessage`. A session written by an
older build, or by any future code path with the same omission, then degrades
instead of 400-ing.

**How we check it** — `scripts/agent-loops/l1-session-poison.mjs`

1. Open a thread, ask for a `contract_update` (`set_status`), receive the
   awaiting-confirmation frame. Read the Redis key `session:<id>` directly and
   compare the `tool_calls` ids against the `tool_results` ids.
   **Before:** one unpaired id. **After:** every id paired.
2. Send a second message on the same `session_id`.
   **Before:** the provider 400s and the stream carries an `error` event with no
   assistant text. **After:** a normal answer.
3. Same two-sided check with the Apply *actually clicked* in between, since
   applying does not touch the session — the second turn must succeed either way.
4. Regression: a read-only turn (`contract_search` → answer) still restores its
   tool history on turn two, and turn two can still name the contract id from
   turn one. That is the P64 behaviour this persistence exists for, and the fix
   must not trade it away.
5. Backward-compatibility: hand-write a poisoned session into Redis (unpaired
   id), then send a message. **Before:** 400. **After:** answers, having dropped
   the orphan.

**Effort:** half a day including the check.

---

## L2 — `redline_propose` fails on essentially every call

**Severity: Blocker**

`apps/agents/app/tools/redline_propose.py:77-83` builds its payload
unconditionally:

```python
payload = {
    "orgId":        org_id,
    "contractId":   contract_id,
    "clauseType":   clause_type,      # None -> JSON null
    "clauseId":     clause_id,        # None -> JSON null
    "instructions": instructions,     # None -> JSON null
}
```

`RedlineProposeSchema` (`internal-ai.ts:588-597`) declares all three as
`z.string().optional()`. Zod's `.optional()` **rejects explicit null**. Run
against the repo's own zod 3.25.76,
`{orgId, contractId, clauseId: null, clauseType: 'limitation_of_liability',
instructions: null}` throws `clauseId: Expected string, received null` and
`instructions: Expected string, received null`; the handler at
`internal-ai.ts:2219-2224` turns that into `400 {detail: 'Invalid request'}`.
There is no rescue anywhere in the chain — the only hooks are `app.ts:118`
(request-id echo), `app.ts:204` (bull-board auth) and `internal-ai.ts:654` (the
internal-secret preHandler). No null-stripping, no custom content-type parser.

Every other tool in the directory obeys the conditional-payload rule.
`contract_search.py:84-92` carries the explicit comment
*"Zod's `.optional()` rejects explicit null"*. `redline_propose.py` is the only
file in `apps/agents/app/tools/` that puts an `Optional`-typed parameter into a
payload unconditionally.

The call therefore only succeeds when the model supplies all three of
`clause_id`, `clause_type` and `instructions` as non-null — and `clause_id` and
`clause_type` are documented as **alternatives to each other**
(`redline_propose.py:41-51`), so in practice the tool always fails.

**What a user experiences today.** *"Redline the liability clause in this
contract."* The model calls `redline_propose(contract_id=…,
clause_type='limitation_of_liability')`, the tool sends two nulls, and the string
that comes back is `{"error":"redline_propose_failed","status":400,…}`. The agent
reports that redlining failed. The flagship rewrite verb has a 400 floor.

The user-facing review-drawer path is unaffected — `contracts.ts:826`
(`POST /:id/clauses/:clauseId/suggest`) calls `proposeClauseAlternatives`
directly and never touches this schema. The breakage is confined to the chat
agent, where it is total.

**The fix.** Mirror `contract_search.py`:

```python
payload: dict = {"orgId": org_id, "contractId": contract_id}
if clause_type   is not None: payload["clauseType"]   = clause_type
if clause_id     is not None: payload["clauseId"]     = clause_id
if instructions  is not None: payload["instructions"] = instructions
```

That matches existing repo convention and is the smaller change. Consider *also*
loosening the three fields to `z.string().nullish()` on the Node side, which
inoculates every future tool against the same mistake — but do it as a separate,
deliberate decision, not as a substitute.

**How we check it** — `scripts/agent-loops/l2-redline-propose.mjs`

1. Direct tool invocation through the agents service with `clause_type` set and
   `clause_id` / `instructions` omitted — the realistic shape.
   **Before:** `400 Invalid request`. **After:** three variants returned.
2. The mirror case: `clause_id` set, `clause_type` omitted.
   **Before:** 400. **After:** 200.
3. All three supplied — must stay 200 both before and after (the one shape that
   works today; the fix must not break it).
4. End to end through chat: *"redline the liability cap in <contract>"* →
   assert a `tool_call_result` frame whose payload parses and carries three
   `aggression` variants, and that `RedlinePreview` has something to render.
   **Before:** the frame carries the `redline_propose_failed` string.
5. Regression on the sibling path: `POST /contracts/:id/clauses/:clauseId/suggest`
   returns variants before and after, proving the review drawer was never on this
   code path.

**Effort:** half a day including the check. The edit itself is four lines.

---

## L3 — Every agent failure renders as an empty bubble

**Severity: High**

`AgentHomePage.tsx`: the per-frame `try {` opens at `:441`; its
`catch { // ignore parse errors }` is at `:596`. The
`throw new Error(evt.error || 'agent error')` at `:593-594` therefore never
escapes to the outer catch at `:652` that holds the friendly error ladder.

`SideAgentRail.tsx`: `throw new Error(parsed.error || 'agent error')` at
`:533-535` is caught at `:679-681` by
`catch (e) { if (process.env.NODE_ENV !== 'production') console.warn(…) }` —
**dev-only, so production is entirely silent**. Its error ladder at `:737-756`
only ever fires on `!res.ok` and network errors, and `chat.py` returns HTTP 200
and streams the failure.

Downstream, both surfaces then set `streaming: false` (`AgentHomePage :599-601`,
rail `:688`), leaving an empty bubble with the cursor stopped. On
`AgentHomePage` the turn also fails the persistence guard
`if (sidToPersist && assembled.trim().length > 0)` at `:614`, so it vanishes on
refresh — the user cannot even show someone what happened.

And `routes/chat.py:120` emits `{"error": str(e)}` with **no `type` field**, so
`AgentHomePage`'s `evt.type === 'error'` test never matches it. That legacy error
is dropped without so much as a throw.

**What a user experiences today.** An expired API key, a provider 400, a
six-iteration timeout, or the L1 poisoning all look identical: the assistant
bubble appears, the cursor blinks, the cursor stops, and there is nothing in it.
No message, no retry, nothing in the console in production. On `/assistant` the
turn then disappears on reload.

**The fix.** Do not throw from inside the frame-parse `try`. Set a `streamError`
variable in the error branch and `break` out of the read loop, then handle it
after the loop — for the rail, rethrow to the outer catch at `:731` so the
existing friendly-message ladder runs at last. On `AgentHomePage`, add an
equivalent error render; it has no error UI at all today. Give
`routes/chat.py:120` a `"type": "error"` field so it is the same envelope as the
other four emitters.

Persist the failed turn too — an empty assistant message plus a visible error is
a better artifact than a turn that never existed.

**How we check it** — `scripts/agent-loops/l3-error-surface.mjs` and
`l3-ui-verify.mjs`

1. Force a resolve failure (org configured with a deliberately invalid BYOK key,
   reusing the W0-3 pattern from `docs/34`), then consume the SSE stream
   directly. Assert the transport is unchanged: HTTP 200, one `error` frame,
   typed. True before and after — this half is not the bug.
2. Playwright, both surfaces: same forced failure.
   **Before:** the assistant bubble contains zero characters and the console is
   empty in a production build. **After:** a human-readable message naming the
   cause, plus a retry affordance.
3. The untyped legacy error (`chat.py:120`, reached with `agentMode` unset):
   **before** `AgentHomePage` renders nothing at all — the frame does not even
   match the error branch. **After:** same visible message.
4. Reload after a failed turn on `/assistant`.
   **Before:** the turn is gone. **After:** it is still there, still showing the
   error.
5. Regression: a successful turn still streams, still persists, and shows no
   error chrome.

**Effort:** 1 day. Two clients, one of which needs an error component built.

**Sequencing note.** This ranks third by consequence and lands **first** in the
branch. Until it is fixed, the pass/fail signal for L1 and L2 in a browser is
"blank bubble" versus "blank bubble."

---

## L4 — Contract creation escapes every guardrail the platform has

**Severity: Blocker (tenancy) + High (RBAC)**

Two independent routes create contracts outside the rails. They share a fix
direction and are one work item.

### (a) The agent tool — no gate, no RBAC, no audit, no undo

`build_contract_create_from_template` is registered in the **read-tool** block
(`tools/__init__.py:101`, above the `# Write tools` comment at `:102`). Its
`_arun` POSTs straight to `/api/internal/ai/tools/contract_draft`
(`contract_create_from_template.py:66-87`) and returns `r.text` — never the
`awaitingConfirmation` dict that `orchestrator.py:812` short-circuits on. So:

- **No confirmation card.** The endpoint (`internal-ai.ts:3784`) runs a
  transaction at `:3874-3921` doing `contract.create` + `contractVersion.create`
  + `contract.update(currentVersionId)` + `template.update(usageCount)`, then
  `indexContract`. Mid-stream. Every other write the agent performs — even
  adding a comment — stops and asks first.
- **No RBAC.** `POST /api/v1/agent/chat` is gated only on
  `requirePermission('view','contract')` (`agents.ts:39`). No role- or
  permission-based tool filtering exists downstream; the only tool-narrowing
  input is `skill_allowed_tools` (`agents.ts:131`). `/tools/contract_draft`'s
  only guard is the blanket `x-internal-secret` preHandler
  (`internal-ai.ts:654`). Because the tool never emits an ActionPreview,
  `checkToolPermission` (`agent-threads.ts:59-79`) — documented at `:37-41` as
  *the ONLY layer where the caller's role can be checked* — never runs. VIEWER
  holds `view:contract` and not `create:contract`
  (`permissions.ts:89-94`), while `POST /api/v1/contracts` requires
  `create:contract` (`contracts.ts:309`).
- **No audit.** Grep for `createAuditEvent` across `internal-ai.ts` returns
  zero. The only agent-write audit hooks are `agent-threads.ts:427`
  (`AGENT_TOOL_APPLIED`) and `:620` (`AGENT_TOOL_UNDONE`), and the drafting path
  never enters those routes. The manual REST create does audit
  (`contracts.ts:344`).
- **No undo.** The `ToolCall` row persisted by `POST /threads/:id/turns`
  (`agent-threads.ts:291-306`) never sets `reversible`, which defaults to `false`
  (`schema.prisma:1108`), so the undo route rejects at `:507-509`. Even if it
  were flipped, that handler stores `output` as `{ preview: tc.result }` — a
  truncated SSE string (`:302`) — so the adapter's `out.contractId` lookup at
  `:574-577` resolves to `undefined` and 400s.

Direct execution is a **deliberate draft-first product choice**, not an
oversight: `orchestrator.py:471-492` (P7.7.3/F-84) instructs the model to draft
before asking, and `artifact-from-tool.ts:322-325` notes that the tool already
persists server-side. The harm is not the absence of the card per se — it is the
three gaps the absence opens.

### (b) `POST /api/v1/agent/draft` — a cross-org write with no schema ✅ FIXED 2026-08-08

**Shipped ahead of the rest of this plan, as the sequencing below advises.** The
finding was confirmed by executing it rather than by reading: a probe posting
another organisation's `contractId` returned 200, and the victim contract went
from one version to two.

The fix scopes the `saveAs.contractId` lookup to the caller's org and refuses
with 404 *before* the upstream agent call, so a request that will be rejected
does not also cost a paid LLM run. `scripts/agent-loops/l4-draft-tenancy.mjs`
2/4 → **4/4**, including a control asserting the caller's own contracts are still
accepted so the fix cannot over-reach.

The RBAC half of this finding — that the route gates on `view:contract` while
creating contracts and versions — is **not** fixed, because tightening the
preHandler could lock out the legitimate `NewContractFlow` caller. It stays in
L4(a) below. The tenancy hole was closed on its own because it crossed a tenant
boundary; the privilege question is a within-org issue and can be sequenced.

The original finding follows.

`agents.ts:275-291`, the `saveAs.contractId` branch:

```ts
const existing = await prisma.contractVersion.findFirst({
  where: { contractId },              // ← no orgId
  orderBy: { versionNumber: 'desc' },
})
const version = await prisma.contractVersion.create({
  data: { contractId, versionNumber: nextVersion, htmlContent: result.html,
          createdById: userId, … },
})
```

Nothing verifies `contractId` belongs to `req.user.orgId`. The body is a bare
TypeScript cast with no Zod schema (`agents.ts:211-223`), so there is no schema
guard either. Every sibling does the check — `internal-ai.ts:2388`
(`contract_update`), `clause-apply.ts:242,477` all filter
`{ id, orgId, deletedAt: null }`. **This is the only write path in the repo with
no org scoping.**

The same route is a second, simpler RBAC bypass: `agents.ts:210` gates on
`view:contract`, then `:295-317` runs `prisma.contract.create` + `indexContract`
+ `queueClassifyDocument`. Unlike (a), this needs no chat loop and no model
choosing a tool — one authenticated REST POST. Two lesser bugs sit in the same
block: `agents.ts:294` assigns ownership via
`prisma.user.findFirst({ where: { orgId } })` with **no `orderBy`** — an
arbitrary org member, not the caller — and `:336-337` wraps the entire save in
`catch (err) { app.log.warn(…) }`, so a failed persist still returns 200 with
the draft HTML and the user believes it saved.

**What a user experiences today.** A read-only VIEWER types *"draft an NDA for
Acme"* in chat and a real Contract row appears in the org's Contracts page,
indexed into Elasticsearch, with no Apply confirmation and no 403. The same user
hitting `POST /api/v1/contracts` directly gets a 403. A compliance reviewer
auditing who created that contract sees nothing. And a user who says *"actually,
undo that draft"* has no undo affordance and must soft-delete by hand.

Separately, an authenticated user in org A who knows a contract id in org B can
POST `{userMessage:"…", saveAs:{contractId:"<org B id>"}}` and write a
ContractVersion with LLM-generated body text onto org B's contract. Exploitation
requires knowing the target CUID, which is not enumerable — which is why this is
a tenancy-boundary failure rather than a trivially weaponizable one. The shipped
UI only ever sends the `title` branch (`NewContractFlow.tsx:41-45`), so this has
never been exercised.

**The fix.**

For (b), first and independently: `findFirst({ where: { id: contractId, orgId,
deletedAt: null } })` with a 404 if absent, a real Zod schema for the body,
`create:contract` on the route rather than `view:contract`, ownership assigned to
the caller, and the swallowed persist failure surfaced.

For (a), convert `_arun` to return
`{"awaitingConfirmation": True, "args": {...}, "preview": {"summary": …,
"target": title}, "reversible": True}` without issuing the POST, mirroring
`comment_add.py:31-38`. That routes it through `/actions/apply`, which picks up
`checkToolPermission` with the `['create','contract']` pair the `WRITE_TOOLS`
entry already declares, fires `AGENT_TOOL_APPLIED` at `agent-threads.ts:431` for
free, and computes `reversible` in the one place that computes it.

**Do not fix only the Python half.** `WRITE_TOOLS['contract_create_from_template']`
dispatches to `/tools/contract_create_from_template` (`internal-ai.ts:3001`),
whose schema requires `templateId` + `variables`. Apply would POST intent-shaped
args at a template-shaped endpoint and Zod would 400 — a draft that silently
could not be applied. Collapse the two implementations: the tool name, the
`WRITE_TOOLS` key, the endpoint path and the undo adapter must all agree on one
string, and the Doc artifact must carry a `tool` field so an Apply can be
produced (`artifact-from-tool.ts:326-329` currently emits only an `href`).

Also move the registration below the `# Write tools` comment in
`tools/__init__.py:102` and add the tool to the prompt's WRITE TOOLS block at
`orchestrator.py:424`, so the code reads the way it behaves.

If immediate drafting must stay for product reasons — see the open questions —
the minimum is an explicit `create:contract` evaluation inside
`/tools/contract_draft` using a caller role passed from the chat proxy, plus a
`createAuditEvent` call. The service secret cannot carry the caller's role, so
it has to be threaded.

**How we check it** — `scripts/agent-loops/l4-draft-gate.mjs`

1. Control, true before and after: as a VIEWER, `POST /api/v1/contracts` → 403.
2. As the same VIEWER, ask the agent to draft an NDA.
   **Before:** a Contract row exists in the DB and is ES-indexed.
   **After:** 403 (or, if drafting stays direct, 403 from the new in-endpoint
   check) and no row.
3. Regression: as CONTRACT_MANAGER, the same request still produces a draft.
   The whole point is to gate it, not to remove it.
4. Audit: after a successful agent draft, an `AuditEvent` exists naming the
   actor and the contract. **Before:** zero rows.
5. Undo: apply an agent draft, then undo within 15 minutes.
   **Before:** 400 `No undo adapter` / `missing contractId`. **After:** the
   contract is rolled back.
6. Endpoint collapse: assert exactly one create implementation is reachable
   under the tool's name, and that the args the Python tool produces validate
   against the schema the apply route dispatches to. This is the assertion that
   catches the trap in step 2's fix.
7. Tenancy: as a user in org A, `POST /agent/draft` with
   `saveAs.contractId` pointing at an org-B contract.
   **Before:** 200 and a new `ContractVersion` on org B's contract.
   **After:** 404, and org B's version count is unchanged.
8. `/agent/draft` with `saveAs.title` as a VIEWER.
   **Before:** 200 and a contract owned by an arbitrary org member.
   **After:** 403.
9. Persist-failure honesty: force the save to fail.
   **Before:** 200 with HTML. **After:** a non-2xx that says the draft was not
   saved.

**Effort:** 2 days. The tenancy fix in (b) is an hour and should land on its own
commit ahead of everything else in this document.

---

## L5 — The agent cannot reach the redlining feature that shipped last week

**Severity: High**

This repo just spent five phases building full-document playbook redlining with
a tracked-changes Word export (`docs/35`, in production 2026-08-08). None of it
is reachable by asking.

**Nothing can apply a redline from prose.** There is no
`apps/agents/app/tools/redline_apply.py` — full directory listing confirms —
and `get_read_tools()` registers no such builder (`tools/__init__.py:79-108`).
Meanwhile `redline_propose.py:105` ships this string to the model:
*"Read-only — use `redline_apply` to turn a chosen variant into a new
ContractVersion."*

The capability is not missing; it is **UI-driven**. `RedlinePreview.tsx:85`
injects `toolName: 'redline_apply'` into a PendingAction when the user clicks
"Apply variant", `agent-threads.ts:48` allowlists it, `:371` maps its user
field, `:411` marks it reversible, `:581` has its undo adapter, and
`internal-ai.ts:2835` serves it. The Apply button in `SideAgentRail` works end
to end, and picking one of three aggression variants is arguably a user decision
rather than a model one — so a missing model-invocable `redline_apply` is
consistent with the confirm-before-write design.

**The defect is narrower and is about honesty.** `redline_apply` occurs zero
times in `AGENT_SYSTEM_PROMPT`, so that stale tool description is the only place
the model is told the verb exists. The prompt's *"never claim the change was
made"* rule (`orchestrator.py:~426`) covers only `comment_add`,
`contract_update` and `request_create` — nothing stops the model from announcing
it applied a variant it never applied. That is the exact failure mode this
codebase already documents for drafting
(`contract_create_from_template.py:8-11`: *"The agent fell into a loop
hallucinating 'I created the draft' without ever calling a tool that produced
one."*).

**Three further reach gaps, all with the Node side already complete:**

| Capability | Endpoint | What's missing |
|---|---|---|
| Batch propose (N clauses, one call) | `internal-ai.ts:2245` | Python read tool |
| Batch apply (N clauses, ONE version) | `internal-ai.ts:2911` + undo `:2933` | Python write tool, `WRITE_TOOLS` entry, `userField`, `reversible`, undo adapter branch |
| Tracked-changes DOCX | `GET /contracts/:id/versions/:v1/redline-docx/:v2` (`contracts.ts:1909`) | internal twin + Python tool; the agent cannot obtain version ids at all |

`contract_get` returns `version: {number, createdAt}` — **no id**
(`internal-ai.ts:700-782`), and no internal-ai handler calls
`contractVersion.findMany`. So even with a DOCX tool, the agent has nothing to
pass it.

Also: `AgentHomePage` renders no `RedlinePreview` at all, so redline apply is
unavailable on the home chat surface even by clicking.

**What a user experiences today.** *"Redline the liability cap and apply the
moderate version."* Because of L2 they get nothing at all today; once L2 lands
they get three variants and then a claim. *"Redline this whole contract against
our playbook and give me a Word file to send"* — the thing the last five phases
built — is answerable only by navigating to the contract page and using the
rail. The agent will explain how to do that, which is the opposite of the
product.

**The fix.**

1. **Reword `redline_propose.py:105`** to point at the Apply card, not a tool:
   *"the user applies a variant from the redline card in the UI."* One line,
   ships immediately, removes the narration risk. Do this even if step 2 lands.
2. **Add `redline_apply.py`** as a write tool modelled on `approval_route.py`,
   returning `awaitingConfirmation` with args
   `{contractId, clauseId, proposedText, aggression, rationale, changes}` — the
   shape is already written down at `RedlinePreview.tsx:87-94`. Every Node layer
   is done. Handle the `409 CLAUSE_TEXT_NOT_FOUND` path in the description so
   the model re-proposes rather than retrying blindly.
3. **Add `redline_propose_batch.py`** (read) and **`redline_apply_batch.py`**
   (write). Cap `clause_ids` at ~25 in the Pydantic schema with
   `httpx.Timeout(120.0)`; the schemas allow 200, and the production path runs
   that as a BullMQ job behind a 202 poll (`contracts.ts:1982`), not inline.
   Route *"redline the whole document"* at the existing async endpoint. Add both
   names to the 20 000-char set at `orchestrator.py:858`. Add the four missing
   `redline_apply_batch` registrations in `agent-threads.ts` — `WRITE_TOOLS`,
   `userField`, `reversible`, undo adapter — which are latent today and become
   live the moment the tool exists.
4. **Add `redline_docx`** as a read tool over a new internal endpoint taking
   `{orgId, contractId, fromVersion?, toVersion?}` — resolve version *numbers*
   to ids server-side, defaulting to the two most recent, so the model can say
   "compare v3 to v5" from `contract_get`'s `version.number`. It must return
   **metadata and a download path, not bytes**: a 200 KB DOCX base64-encodes to
   ~270 KB and would blow both the stream ceiling and the context window. The
   artifact card fetches that path through the axios `api` client with
   `responseType: 'blob'`, which keeps `requirePermission('view','contract')` on
   the actual byte delivery so the agent never becomes an RBAC bypass. Copy
   `CompareMode.tsx:127-143`; do **not** copy `ContractEditor`'s bare `fetch`
   (see L6). Compute `stats` from `computeVersionDiff` and read/populate
   `prisma.versionDiffCache` rather than building the whole DOCX to count
   insertions.
5. **Mount `RedlinePreview` on `AgentHomePage`**, or state in the doc that
   redlining is a contract-page surface only.

**How we check it** — `scripts/agent-loops/l5-redline-reach.mjs`

1. Bound-catalog assertion: every tool name appearing in any shipped
   `description=` string is present in `get_read_tools()`.
   **Before:** `redline_apply` fails it. **After:** passes. This is the
   assertion that would have caught the original `template_list` incident.
2. `redline_apply` from prose: seed a contract with a deviating clause, ask the
   agent to redline and apply the moderate variant.
   **Before:** no `ContractVersion` is created and the transcript contains a
   completion claim. **After:** an awaiting-confirmation frame, then Apply
   creates exactly one new version whose clause text changed.
3. Batch propose: a 12-clause contract, one tool call, 12 proposals, each
   grounded in **its own** playbook position — reusing the cross-contamination
   assertion from `scripts/redline/p1-batch-propose.mjs`, which caught a
   liability rewrite talking about Delaware.
4. Batch apply: accepting 8 proposals produces **one** version with one undo
   target, and the undo works. **Before:** no tool, and
   `POST /actions/apply` 400s with `Tool "redline_apply_batch" is not a
   registered write tool`.
5. DOCX: ask for a Word redline between two versions.
   **Before:** the agent has no version ids and no tool. **After:** a card whose
   download path returns real `wordprocessingml` bytes containing `<w:ins>` and
   `<w:del>`, and returns **401 without a bearer token** — proving the
   permission gate survived the indirection.
6. Truncation: assert `redline_propose_batch` and `redline_apply_batch` payloads
   arrive un-truncated at the client and `JSON.parse` cleanly. The 800-char
   default has silently broken six tools' artifact rendering already; the
   allowlist comment at `orchestrator.py:843-871` reads as an incident log.

**Effort:** 3 days. Items 1–3 are a day; the DOCX tool with version resolution is
most of the rest.

---

## L6 — Twenty-five controls in the app do nothing

**Severity: High**

Not agent work, but named in gap #2 and the highest-frequency defect class a
user meets. Established by diffing all 268 registered API routes against all 266
endpoint references in `apps/web/src`, then reading every handler behind a
flagged control.

**The mechanism behind six of them is one auth fact.** `middleware/auth.ts:49-56`
accepts only `Authorization: Bearer`; there is no cookie fallback. Only the
axios client attaches the token (`lib/api.ts:9-14`), and there is no
`window.fetch` shim. So any `window.open`, bare `<a href="/api/…">`, or plain
`fetch()` against a guarded route is an automatic 401.
`CompareMode.tsx:120-143` is the correct pattern and its own comment already
names `ContractEditor` as the anti-pattern — without anyone having fixed it.

| # | Control | What actually happens |
|---|---|---|
| 1 | **Editor Export PDF / Export DOCX × 3 pages** (`ContractEditor.tsx:582-583`) | `onExport` is optional and no mount site passes it (`TemplatesPage.tsx:336`, `PlaybookPage.tsx:142`, `ClausesPage.tsx:237`); the fallback bare-`fetch`es a permission-guarded route, 401s, and `if (!resp?.ok) return` at `:463` swallows it. **Six dead buttons.** `contracts.ts:1788` also defaults `GOTENBERG_URL` to `:3001` — the API's own port. |
| 2 | **Notification bell, approval items** (`NotificationBell.tsx:124-128`) | Handles only `contract` and `approval_instance`. `workflow-engine.ts:287` and `notification.worker.ts:119` emit `approval_step` for APPROVAL_REQUEST — the most actionable notification in the product — which matches neither branch, so the row just greys out. `approval_instance` navigates to `/approvals/<id>`, which `App.tsx:129` does not register, so `AppShell.tsx:21`'s `<Outlet/>` renders null: full chrome, empty page. |
| 3 | **Settings → Notifications, 11 controls** (`SettingsPage.tsx:667-728`) | They persist (`schemas.ts:117`, `users.ts:33-37`) and nothing reads them: grep for `preferences` across `apps/api/src` returns exactly one hit, `users.ts:26`, echoing the blob back. `notification.worker.ts:22-46` emails unconditionally. The comment at `SettingsPage.tsx:621-623` claiming the worker reads these flags is factually false. |
| 4 | **Diligence Export CSV** (`DiligenceRoomDetailPage.tsx:133-135`) | `window.open` against a `requirePermission`-guarded route → a new tab of 401 JSON. `ObligationsPage.tsx:138-144` does it correctly two files over. |
| 5 | **Counterparty → New contract** (`CounterpartyDetailPage.tsx:225,289`) | Navigates to `/contracts/new`, which matches `contracts/:id` with `id='new'`, 404s, and renders "Contract not found" (`ContractDetailPage.tsx:922-926`). It is the only create CTA in the zero-contracts empty state on that page. |
| 6 | **Agent artifact Export CSV / Export memo** (`artifact-from-tool.ts:61,83,251`) | Declared with neither `href` nor `tool`, so `AgentHomePage.tsx:1100` throws *"This action has nothing to apply"* and `ArtifactPane.tsx:426-434` flashes an unlabeled red icon for 2.5s — while `:456` renders a Download icon that makes it look wired. The same file at `:313-318` documents deleting `save_draft`/`send_for_review` for exactly this reason; these three survived that cleanup. |
| 7 | **Contract Actions → Download** (`ContractDetailPage.tsx:828-833`) | No try/catch, no error state, ungated at `:1359` — while the sibling `handleViewPdf` at `:835-845` has both and is gated on `hasOriginal`. On an agent-drafted or pasted-HTML contract the route 404s (`contracts.ts:1362`) and the menu simply closes. Same unguarded call at `:2146`, `:2521`, and `downloadAttachment` at `:815`. |
| 8 | **Editor Replace All** (`ContractEditor.tsx:442-447`) | Runs `editor.getHTML().replaceAll(find, replace)` on serialized HTML. Replacing `p` with `q` rewrites every `<p>` tag. Searching `Smith & Co` never matches, because the HTML holds `Smith &amp; Co`. |
| 9 | **Portal "Download .docx"** (`portal.ts:175-190`) | POSTs HTML to Gotenberg's `/forms/libreoffice/convert` — a document→PDF route — then stamps a `.docx` name and the wordprocessingml MIME type. The route's own header comment says the point is *"download .docx → redline locally → upload back."* Word refuses to open it, and the audience is the **counterparty**. |
| 10 | **Bulk approve** (`ApprovalsPage.tsx:378-396`) | Per-item POSTs with `catch { failed++ }`, then an unconditional `setTimeout(onDone, 600)`. The failure count *is* rendered at `:483-495` — in emerald success green, for 600 ms, without naming which items failed. The server's per-step detail is discarded by the bare catch. |
| 11 | **Send reminder** (`SignatureStatus.tsx:113-117`) | No `onError`; only `voidMut.isError` is rendered (`:328-331`). `signatures.ts:631,635` return 409 for non-PENDING and all-responded. The button stays "Send reminder" and no email was sent. One mutation object is shared across every row, so `isSuccess` leaks across them. |
| 12 | **Signature filter tabs** (`SignaturesPage.tsx:68-93`) | Counts are reduced over the already-filtered response and the ALL badge is `items.length`; the query's own `total` is never read. Selecting any tab zeroes every other badge. |
| 13 | **Telemetry** (`lib/telemetry.ts:44-56`) | Posts to `/api/v1/telemetry/events`; no such route is registered (`app.ts:227-271`). Nine live call sites. `flush()` short-circuits to `console.debug` on localhost, which is why nobody noticed. Any decision made on "nobody uses Compare" is based on no data at all. |
| 14 | **No catch-all route** (`App.tsx:100-152`) | ~35 concrete children, no `path="*"`, no `NotFound` component anywhere. This is the force multiplier that turns #2's bad link into a blank page rather than a diagnosable 404. |

**What a user experiences today.** They click the Word icon in the template
editor and nothing happens. They click "Contract awaiting your approval" in the
bell and nothing happens. They turn off email notifications, see a green
"Saved", and keep getting the same emails forever. They click Export CSV on a
diligence room and get a tab of JSON. Every one of these reads as an
unresponsive app rather than a missing feature, which is worse.

**The fix.** Mostly ports of patterns that already exist in the repo.

- Route every download through the axios client with `responseType: 'blob'`
  (`CompareMode.tsx:127-143` / `ObligationsPage.tsx:138-144`).
- **Delete the two Gotenberg `.docx` liars rather than repair them.**
  `generateRedlineDocx` (`lib/docx-export.ts:40`) produces genuine DOCX; add a
  portal-token variant for single-version export. Do not ship LibreOffice-convert
  output under a `.docx` name under any circumstances.
- Map `approval_step` and `approval_instance` to `/approvals`; better, add a
  `contractId` to the Notification row and go to
  `/contracts/:id?tab=approval`. Add `<Route path="*" element={<NotFound/>}/>` as
  the last child of the protected layout — four lines that convert a whole class
  of future dead links from silent to diagnosable.
- Gate notification emails on the recipient's stored preferences in
  `handleNotify`, mapping type→pref
  (`APPROVAL_REQUEST`→`approvalRequested`, `APPROVAL_DECIDED`→`approvalDecided`,
  `OBLIGATION_DUE`/`RENEWAL_DUE`→`contractExpiringSoon`), and treat
  `digest:'off'` as suppress-all. **If daily digest is not built, remove the
  option rather than offer it.** Same for the three General prefs: thread them
  through the formatters or drop the selectors.
- Point the counterparty CTAs at `ContractsPage`'s working `NewContractFlow`
  (`ContractsPage.tsx:313`) with the counterparty prefilled, or add a real
  `contracts/new` route that reads the search params it already passes.
- Do the artifact CSV client-side — the table data is already in the browser, no
  backend needed — or delete the three actions the way `save_draft` was deleted.
  Either way, make `ActionButton` surface the thrown message instead of a bare
  icon.
- Replace-All over the ProseMirror document via `editor.state.doc.descendants`
  in one undoable transaction, not over the HTML string.
- Do not auto-close the bulk-approve dialog when `failed > 0`; list the failed
  items with the server's detail and offer Retry-failed.
- Register a telemetry sink or delete `lib/telemetry.ts` and its call sites.
  Leaving instrumentation that everyone believes is live is the worse option.

**How we check it** — `scripts/agent-loops/l6-dead-buttons.mjs` (Playwright)

The unifying assertion: **click the control, then assert the consequence** — a
downloaded file's bytes and MIME type, a URL change, an email row, a DB row.
Asserting that a click did not throw is what let all fourteen ship.

1. Each of the six editor export buttons: intercept the download.
   **Before:** no download event fires at all. **After:** bytes arrive, and the
   DOCX opens as a zip whose `[Content_Types].xml` is present — the assertion
   that distinguishes a real DOCX from PDF bytes in a `.docx` wrapper.
2. Portal `.docx`: same zip assertion against a portal token.
   **Before:** the payload begins `%PDF`.
3. Notification bell: seed an APPROVAL_REQUEST, click it.
   **Before:** the URL does not change. **After:** it lands on a page with
   content.
4. Catch-all: navigate to `/nonexistent-page`.
   **Before:** chrome with an empty `<main>`. **After:** a "Page not found" with
   a link home.
5. Preferences: set `approvalRequested: false`, trigger an approval request,
   count rows in the mail spool. **Before:** 1. **After:** 0. Then flip it back
   and assert 1 — a check that only proves suppression proves half of it.
6. Diligence CSV, contract Download on an HTML-only contract, artifact Export
   CSV, remind-on-completed, bulk approve with 8 seeded failures, signature tab
   counts: one assertion each, each stating its before.
7. Replace All: a document containing `<p>` tags and `Smith &amp; Co`; replace
   `p` → `q` and assert the tag structure is unchanged, then replace
   `Smith & Co` and assert it matched.
8. Telemetry: assert `POST /api/v1/telemetry/events` returns something other
   than 404, or that `lib/telemetry.ts` no longer exists. One or the other.

**Effort:** 3 days. Individually most are two-line ports; the count is the cost.

---

## L7 — The system prompt describes a product that changed under it

**Severity: Medium** · *cheapest high-value edit in this document*

`AGENT_SYSTEM_PROMPT` (`orchestrator.py:264-503`) has no test and no reviewer,
so nothing forces it to be edited alongside the behaviour it describes. Ten of
the 26 registered tools occur **exactly zero times** in it, verified
programmatically: `approval_list`, `approval_route`, `compliance_get`,
`contract_summarize`, `contract_validate`, `custom_field_list`, `org_memory`,
`playbook_check`, `redline_propose`, `renewal_advice`. Two more —
`obligations_list`, `request_list` — appear only in a negative rule at
`:324-326`. So on a 26-tool catalog the A12 routing table gives positive routing
guidance for six, and presents itself as the deliberate retrieval decision
procedure while doing so.

They are not unreachable — every tool is bound with its own routing-grade
description (`compliance_get.py:49-57` literally says *"Use for 'is this
contract GDPR compliant?'"*). But the system prompt outranks tool descriptions,
and a table that names `contract_search` 13 times and `contract_get` 11 times
biases selection hard.

**Nine specific inaccuracies, each verified:**

| Prompt says | Reality |
|---|---|
| `portfolio_search` "returns up to 50 hits with … expiryDate" (`:398-401`) | `top_k` is `Field(10, ge=1, le=30)` (`portfolio_search.py:50-52`), and the hit object has **no `expiryDate`** (`internal-ai.ts:1608-1626`). `contract_search` does select it (`:841`). |
| `totalMatching` "is the DB count of rows satisfying the filter" (A11, `:366-375`) | On the pgvector fallback, `internal-ai.ts:911` returns `fallbackResults.length`, built by breaking at `orderedIds.length >= body.limit` (`:863-870`). It equals `results.length` **by construction**. |
| `contract_search` "filters are exact; free-text is title/counterparty/summary ILIKE" (`:282-284`) | Omits that `internal-ai.ts:850-899` swaps in pgvector clause similarity when keyword search returns 0, and that the response then carries `searchMode:'semantic-fallback'` whose stated purpose (`:918`) is for the agent to say it broadened. `counterpartyName` is also a case-insensitive `contains` (`:798`), not exact. |
| The draft renders with "Save as draft / Send for review / Open in Contracts" (`:481-484`) | `artifact-from-tool.ts:320-329` documents dropping the first two on 2026-06-10 and emits exactly `[{id:'open', …}]`. |
| Use `contract_cite` "when you'll render `[cite:section-X.Y]` style links" (`:303-305`) | `grep -rn 'cite:' apps/web/src` returns zero. Any marker the model writes reaches the user as literal bracket text. `[chip]:` by contrast has a real parser (`action-chips.ts:28-54`). |
| "`contract_get` — pull the full body when summary is needed" (`:306`) | `contract_summarize` exists, its own docstring says to prefer it (`contract_summarize.py:7-8`), and it is named zero times. `contract_get` defaults to `max_chars=12_000` and is capped at 3/turn, so a five-contract overview hits `BUDGET_EXCEEDED` on calls 4–5. |
| "`[chip]:` Export this list to CSV" as a worked example (`:462`) | No registered tool exports CSV. The chip is one tap to a dead end, suggested by the prompt itself. |
| "WRITE TOOLS — comment_add, contract_update, request_create (more coming)" (`:424`) | `approval_route` is a live confirm-gated write tool with an apply allowlist entry, actor mapping, undo branch and endpoints — and zero prompt coverage. The blanket invariant at `:425-427` is also inaccurate while drafting mutates directly. |
| `contract_cite` results render "with PDF anchors" so users can navigate to the exact location (`:415-423`) | The pill href is `?section=…` (`CitationPills.tsx:70-72`); `page` renders as static text `p.N` and `bbox` is read nowhere. `ContractDetailPage` scrolls to a TOC heading (`:457-487`), not a PDF coordinate. |

Two documentation-only items in the same family: `orchestrator.py:539-541` and
`chat.py:31-33` both say `skill_system_prompt` *"replaces"* the base prompt,
while `:646-651` concatenates — deliberately, per the comment at `:643-645`, so
a mis-written skill cannot invite hallucination. The runtime behaviour is the
safer one; only the docs are wrong, and an admin cannot tell from them that a
skill can never override A5/A9/the write-tool playbook. And A3 documents the
`contract_get` cap while the runtime also enforces `MAX_TOOL_ITERATIONS=6`
(`:507`), `TOTAL_TOOLS_PER_TURN=25` (`:528`) and `counterparty_get=3` (`:525`) —
the model cannot plan around caps it was never told about.

Finally, `/tools/contract_draft` returns a `422 CONTRACT_TYPE_AMBIGUOUS`
(`internal-ai.ts:3803-3808`) that the prompt has no rule for, immediately after
the CRITICAL *"never claim a draft you did not create"* paragraph that biases the
model toward reporting failure. The error's own `detail` lists the valid types,
so one retry would fix it.

**What a user experiences today.** *"Is this contract GDPR compliant?"* pulls the
raw body and reasons over it, rather than calling `compliance_get` and returning
the scored per-framework report with clause-grounded findings that already
exists. *"Send this MSA for approval"* gets prose, or `contract_update(set_status)`
— which moves the status without creating the approval instance, so no approver
is ever notified and the contract sits in PENDING_REVIEW with nobody assigned.
*"Which contracts expire this quarter"* routed through `portfolio_search` finds
no dates and either invents them or gives up. *"How many contracts mention steel
tariffs?"* → keyword search misses, semantic fallback returns 10, and the agent
answers *"you have 10"* with total confidence. A11 exists to prevent exactly that
hallucination and here it causes it. *"Draft something for the Acme pilot"* →
`CONTRACT_TYPE_AMBIGUOUS` → *"I couldn't create the draft."*

**The fix.** All prompt edits, plus one API change.

- Extend the A12 table with one line each for `compliance_get`, `playbook_check`,
  `contract_validate`, `org_memory`, `renewal_advice`, `obligations_list`,
  `approval_list`, `request_list`, `custom_field_list` and
  `contract_summarize` — a trigger phrase each is enough. Add a short
  "playbook & redline" and "compliance & obligations" stanza.
- Split `:306` in two: *"`contract_summarize` — overview / metadata / key terms
  / risk for one contract. Prefer it for 'summarize' / 'what is this'.
  `contract_get` — only when you need the verbatim body."*
- Add `approval_route` to the WRITE TOOLS list with its DRAFT/PENDING_REVIEW/
  UNDER_NEGOTIATION precondition, the auto-select note, and its 15-minute
  reversibility. Drop *"(more coming)"*. Add
  `contract_create_from_template` once L4 gates it.
- Correct `portfolio_search`'s ceiling and fields, and add: *"for date/status/
  value rollups use `contract_search` with `sort_by=expiryDate`, which is not
  subject to the `contract_get` budget."*
- **Make the fallback branch return `totalMatching: null`** alongside the
  existing `searchMode` flag, and amend A11 to say that under
  `semantic-fallback` the count is a lower bound — *"at least N"* — and to
  announce the broadening out loud, which is what `internal-ai.ts:918` was built
  for.
- Reduce `:483-484` to *"…renders as a Doc artifact with an 'Open in Contracts'
  action; the draft is already persisted, so there is nothing to save."*
- Delete the `[cite:section-X.Y]` clause; replace with *"the rail renders the
  `contract_cite` result itself as citation pills — do not write citation markers
  in your prose."* Say "anchored to a section ref the contract page scrolls to"
  rather than "PDF anchors". Keep the substantive half of that rule.
- Replace the CSV chip example with something a tool can do
  (*"[chip]: Rank these by value"*).
- One paragraph after A3 stating all four caps and that `BUDGET_EXCEEDED` means
  stop calling that tool and synthesize.
- One sentence after NO_TEMPLATE_MATCH: *"If it returns
  `CONTRACT_TYPE_AMBIGUOUS`, re-call once with `contract_type` set from context;
  if you genuinely cannot tell, ask which type — that is the one case where
  asking first is right."*
- Fix the two `skill_system_prompt` docstrings to say "appended; base rules still
  apply", and surface that in the Skills UI copy.

**How we check it** — `scripts/agent-loops/l7-prompt-truth.mjs`

A **static** check — no stack, no model, runnable in CI — that reads the prompt
and the code and asserts they agree. This is the missing reviewer.

1. Every tool name in the prompt is registered. Passes today; keep it.
2. Every registered tool appears at least once. **Before:** 10 failures.
3. The caps stated in the prompt equal `PER_TOOL_BUDGET`,
   `MAX_TOOL_ITERATIONS` and `TOTAL_TOOLS_PER_TURN`. **Before:** three
   undocumented.
4. `portfolio_search`'s documented ceiling equals its Pydantic `Field` bound,
   and every field name the prompt promises exists in the handler's hit object.
   **Before:** 50 vs 30, and `expiryDate` absent.
5. The Doc-artifact actions the prompt names equal the ids
   `artifact-from-tool.ts` emits. **Before:** 3 vs 1.
6. Every prose marker syntax the prompt tells the model to write has a parser in
   `apps/web/src`. **Before:** `[cite:` has none.
7. Every tool returning `awaitingConfirmation` appears in the WRITE TOOLS block.
   **Before:** `approval_route` missing.

Then four behavioural probes against a seeded org, which are the ones that
justify the edit rather than merely pin it:

8. *"Is this GDPR compliant?"* → `compliance_get` appears in the tool trace.
   **Before:** it does not.
9. *"Send this for approval"* → an `approval_route` awaiting-confirmation frame.
   **Before:** prose, or `contract_update(set_status)`.
10. A query that forces `semantic-fallback` → the answer contains a broadening
    disclosure and no bare count. **Before:** *"you have 10."*
11. *"One-paragraph overview of these five contracts"* → five
    `contract_summarize` calls, zero `BUDGET_EXCEEDED`. **Before:** three
    `contract_get`s and two budget refusals.

**Effort:** 1 day, most of it the static check. The prompt edits are an
afternoon and carry the highest value-per-hour in this document.

---

## L8 — The rail misreports what the agent did

**Severity: Medium**

Three separate misreports, all in the same envelope.

**(a) The write-tool chip spins forever, in the rail only.**
`orchestrator.py:760-765` yields `tool_call_start` — creating the chip — before
the tool runs; `:812-835` then yields `tool_call_awaiting_confirmation` and
`continue`s, so no `tool_call_result` ever arrives for that `tc_id`.
`SideAgentRail.tsx:577-614` handles that event by appending to `pendingActions`
only. Every `toolCalls` reference in the file was checked (lines 354, 363, 367,
559, 572, 621, 699, 940, 982, 1873-1875) and nothing outside the
`tool_call_result` branch at `:621` ever mutates a chip's status — not
`applyAction`, not the stream-end handler at `:688`. The chip created at
`:550-561` renders via `ToolCallChip` (`:1897`) with `status: 'running'` for the
life of the thread. `AgentHomePage.tsx:498-508` gets this right.

**(b) A failed tool renders a green success chip, on `/assistant` only.**
`AgentHomePage.tsx:514` and `:546` both set `status: 'ok'` unconditionally with
zero inspection of `evt.result`, while `SideAgentRail.tsx:624` derives it from
`parsed.result.includes('"error"')`. The orchestrator routes
`{"error":"unknown_tool"}` (`:769`) and `{"error":"tool_raised"}` (`:803`)
through the same `tool_call_result` envelope as success (`:876-882`).

The error text *is* still delivered to the model via
`_wrap_untrusted_tool_result` at `:898`, and the model usually reports the
failure in prose — so this is misleading UI rather than silently-lost data. But
`AGENT_SYSTEM_PROMPT:269` defines everything inside `<<<UNTRUSTED_TOOL_DATA>>>`
markers as *"derived from user/counterparty documents"*. **The agent is being
instructed to distrust its own runtime's error reports.**

**(c) `unknown_tool` produces no log line at all.** `tool_raised` at `:803` at
least gets a `logger.exception`. `grep -rn "unknown_tool\|tool_raised" apps/`
returns two hits, both the `json.dumps` producers. Nothing consumes either
string anywhere in the stack.

The rail's own status derivation is also fragile: `includes('"error"')` is a raw
substring test against up to 20 KB of tool JSON, so a successful search whose
payload contains `"errors": []`, or contract text mentioning the word, renders
as a failed tool.

**What a user experiences today.** In the side rail, every `comment_add` /
`contract_update` / `request_create` / `approval_route` proposal leaves a
permanently spinning chip next to the Apply card, for the life of the thread —
so the user cannot tell whether the agent is still working or waiting on them,
which directly undercuts the affordance the card exists to present. On
`/assistant`, a tool that crashed or does not exist renders an identical green
chip to one that worked, and the trace drawer lies.

**The fix.** Emit an explicit `"ok": false` (or `"status": "error"`) field on the
`tool_call_result` envelope for the `unknown_tool` and `tool_raised` paths, and
have both clients read that field instead of substring-sniffing. Stop wrapping
platform-generated tool errors in the untrusted-data envelope — wrap only
payloads that actually came from documents. Add a `logger.warning` at `:769`.

In the rail's awaiting-confirmation branch, mirror `AgentHomePage:498-508`: map
over `toolCalls` and close out the entry whose `id === tcId` in the same
`setMessages` call that appends the PendingAction — either `status: 'ok'` or a
new `'awaiting'` status the chip renders as a pause icon rather than a spinner.
The type comment at `SideAgentRail.tsx:102-107` shows `pendingActions` were
*deliberately* kept separate from `toolCalls`; the missing piece is closing out
the originating chip, not the separation.

**How we check it** — `scripts/agent-loops/l8-tool-status.mjs`

1. Envelope: force `unknown_tool` and `tool_raised`, assert both frames carry an
   explicit failure field. **Before:** the field does not exist.
2. Assert the platform error reaches the model **without** untrusted framing,
   while a document-derived payload still has it. Both halves matter — removing
   the framing wholesale would undo W0-4.
3. Playwright, rail: propose a `comment_add`, then wait past any plausible
   timeout. **Before:** the chip's spinner is still animating. **After:** it is
   settled, and the Apply card is the only thing awaiting the user.
4. Playwright, `/assistant`: force a tool failure.
   **Before:** the chip is green. **After:** it is an error chip.
5. False-positive guard: a successful `contract_search` whose result contains
   the literal token `"error"` in contract text still renders as success. This
   must pass after the fix and is the reason for not keeping the substring test.
6. `unknown_tool` writes a log line. **Before:** zero.

**Effort:** 1 day.

---

## L9 — Three verbs the loops need and do not have

**Severity: Medium**

Named directly in `docs/33` gap #2. Each is a thin wrapper; two need a small new
internal endpoint.

**`user_search` — this is the blocker for "assign this to Alice".**
`contract_update`'s `assign_owner` action requires `payload.ownerId` as a user
CUID (`contract_update.py:21,44`); `internal-ai.ts:2435-2441` validates it exists
in the org and 404s `User not found in this org` otherwise. There is no name→id
path anywhere, so the flow dead-ends. The nearest existing route,
`GET /api/v1/users` (`users.ts:79`), is `requireAuth`-only with **no query param
and no limit**, and returns every org member's email and role list — so the
internal twin should be *narrower* than its user-facing counterpart, which is the
reverse of the usual direction. Roughly 20 lines:
`{orgId, query?, limit=20}` → `findMany` with an insensitive `contains` on name
and email → `{items: [{id, name, email, status, roles}], total}`.

**Do not route the result through `redactExcerpts`.** The redactor's email
pattern would destroy exactly the field that disambiguates two people named
Alice. This is internal-directory data, not counterparty document text.

**`template_list` — "what can I draft from?"** No endpoint exists;
`GET /api/v1/templates` (`templates.ts:65`) is JWT- and permission-gated, so the
agents service cannot reach it. Roughly 25 lines reusing the same
`template.findMany` + `count`, but **drop `sections` from the include** — they
carry full HTML and would blow the tool budget. Note this is for answering the
question, not for feeding an id: the Python
`contract_create_from_template` tool posts free text and the pipeline picks the
template.

**`approval_decide` — approve / reject / delegate.** The user-facing route is
fully built (`approvals.ts:277`, `requirePermission('approve','workflow')`) with
`{stepId, decision, comment?, delegateTo?}`, a required comment on REJECTED, a
409 on a closed workflow, `notificationQueue.remove('escalate-'+stepId)`,
`createAuditEvent`, and `advanceWorkflow`. Its authorization predicate is the
load-bearing detail: the step must satisfy
`{id, approvalInstanceId, orgId, approverId: userId, status:'PENDING'}` →
otherwise 403 *"Step not found or not assigned to you"*. **Any internal twin must
keep `approverId: body.userId` in that where-clause**, or the agent gains the
ability to approve on other people's behalf. Roughly 70 lines plus three imports
`internal-ai.ts` does not have today (`advanceWorkflow`, the notification queue,
`createAuditEvent`).

Register it as a write tool with `WRITE_TOOLS` `['approval_decide',
['approve','workflow']]` and `userField → 'userId'`, and **`reversible: false`
with no undo adapter** — `advanceWorkflow` may already have closed the instance
and fired notifications, which cannot unwind inside a 15-minute window.

Chaining already works: `approval_list` (`internal-ai.ts:3537-3555`) returns both
`stepId` and `instanceId`.

**What a user experiences today.** *"Assign the Acme MSA to Alice"* — the agent
knows the action exists, has no way to turn "Alice" into an id, and either asks
the user to paste a CUID or gives up. *"What can I draft from?"* is answered from
memory or not at all. *"Approve it"* is answered with directions to the approvals
page.

**How we check it** — `scripts/agent-loops/l9-new-verbs.mjs`

1. *"Assign the <title> contract to Alice"* end to end → a `contract_update`
   awaiting-confirmation frame whose `ownerId` is Alice's real CUID, and Apply
   changes the owner. **Before:** no tool resolves the name; assert the trace
   contains no `assign_owner` with a valid id.
2. Ambiguity: two users named Alice → the agent asks which, rather than picking.
   A name-resolution tool that guesses is worse than none.
3. `user_search` returns emails un-redacted (the PII exemption is deliberate and
   should be pinned so a future redaction sweep does not silently break it), and
   is org-scoped — a user from another org never appears.
4. *"What templates can I draft from?"* → `template_list` in the trace, and the
   response carries no `sections` HTML.
5. `approval_decide` as the assigned approver → step decided, instance advanced,
   `APPROVAL_DECIDED` audit event present, escalation job removed.
6. **`approval_decide` as a user who is not the assigned approver → 403.**
   Assert this against the internal endpoint directly, not through chat; it is
   the one assertion that stops this tool becoming an approval-forgery path.
7. REJECTED without a comment → 400, matching the REST twin.

**Effort:** 2 days.

---

## L10 — The stream is fake, and the proxy corrupts what it carries

**Severity: Medium**

`orchestrator.py:605-608` passes `streaming=False` to `resolve_llm`; `:702` is
`ai: AIMessage = await llm.ainvoke(...)`; `:710-713` then splits the finished
string on `' '` and yields one `token` event per word **with no sleep**. The
in-code admission at `:708-709` is verbatim: *"Word-by-word 'stream' to match the
existing UX. Real token streaming lands when we add `.astream_events()` in a
follow-up."* Same shape at `:918-921` (synthesis fallback) and
`routes/chat.py:126-135` (legacy). `routes/assist.py:702` is the only real
`llm.astream` in the service — **the codebase knows how to do this; the agent
chat path just doesn't.**

This is acknowledged, deliberately deferred debt with a named follow-up, not an
unnoticed regression. It exists to preserve an already-shipped UX shape. But
because there is no sleep between yields, the "typewriter" is a single burst —
the fake-streaming code buys nothing at all over sending one frame.

**Two transport defects sit on top of it.**

`apps/api/src/routes/agents.ts:158` constructs `new TextDecoder()` and `:178`
calls `decoder.decode(value)` **without `{ stream: true }`** — while `:385`, in a
different handler in the same file, gets it right, and both web clients pass the
flag (`AgentHomePage.tsx:435`, `SideAgentRail.tsx:521`). An isolated omission,
not house style. With 20 000-char tool payloads for ~20 tools
(`orchestrator.py:858-872`), frames routinely span TCP segments.

And the Node proxy writes `Content-Type` / `Cache-Control` / `Connection` but
drops the `X-Accel-Buffering: no` that Python set (`chat.py:139-146`). Behind
nginx or an ALB the whole SSE response can be buffered into one write, at which
point the tool chips and the answer all land simultaneously.

**What a user experiences today.** Multi-second to minute-long dead air, then the
whole answer at once. On a tool-using turn the only real progress signal is the
tool chips and the 4-second `tool_progress` heartbeat (`:778-799`); between the
last tool result and the answer there is a completely silent gap for the final
`ainvoke`. And where a chunk boundary falls inside a UTF-8 sequence, answers and
tool previews show `�` in place of an em-dash, ellipsis, bullet, curly quote or
currency symbol — all of which contract text is dense with. It is intermittent
and load-dependent, so it looks like a model quality problem rather than a proxy
bug.

**The fix.** Switch the terminal branch to `streaming=True` +
`async for chunk in llm.astream(messages, ...)`, yielding
`{"type":"token","delta":chunk.content}` per chunk. The tool-call iterations
still need the accumulated message, so accumulate tool-call chunks and only
stream deltas when the chunk carries text content. `routes/assist.py:700-712`
already has the exact chunk-content extraction — handling both the `str` and
block-list content shapes — to copy.

At the proxy, since that hop only forwards bytes, skip decoding entirely:
`reply.raw.write(Buffer.from(value))` with `streamedChars` tracked off
`value.byteLength`. (The `streamedChars` drift itself is negligible — a mangled
3-byte char becomes 2–3 replacement chars, a sub-percent perturbation on an
estimate `agents.ts:166-167` already documents as deliberately high-biased. The
mojibake is the whole defect.) Forward `X-Accel-Buffering: no`.

**How we check it** — `scripts/agent-loops/l10-streaming.mjs`

1. Consume the SSE stream and record the arrival timestamp of every `token`
   frame. **Before:** the spread between the first and last token frame is
   under ~50 ms after a multi-second silence. **After:** tokens spread across
   the generation window, and time-to-first-token is a small fraction of
   time-to-done.
2. Assert the *content* is byte-identical to the non-streaming path for the same
   seeded prompt. Real streaming that drops the last chunk is worse than fake
   streaming.
3. Tool-using turn: tool-call assembly still works under `astream` — a turn that
   calls three tools still calls three tools and still ends with prose.
4. UTF-8: force a response containing em-dashes and curly quotes at sizes that
   straddle chunk boundaries, read through the **Node proxy**, and assert zero
   U+FFFD. **Before:** present at some sizes. Sweep a range of lengths rather
   than testing one, since the bug is boundary-dependent.
5. Assert `X-Accel-Buffering: no` survives the proxy hop.

**Effort:** 1 day.

---

## L11 — The daily cost cap fails open on every Python-side LLM call

**Severity: High (cost)**

A four-hop chain, all verified:

1. `aiRouter.ts:193` — `assertCostCapNotExceeded(orgId)` throws
   `CostCapExceededError` when the org is over cap under `block` policy.
2. `internal-ai.ts:676-687` — `POST /resolve` catches, special-cases **only**
   `NoProviderAvailable` → 503, and sends everything else to
   `reply.status(500).send({ detail: 'Internal error' })`.
   `CostCapExceededError extends Error` (`costCap.ts:38`), so it lands in the 500
   branch.
3. `router.py:287` — `r.raise_for_status()` raises on the 500.
4. `router.py:247-256` — `except Exception as e:` logs a warning and falls
   through to `_platform_resolve(tier)`, which reads the platform key straight
   out of the agents service's own env. **The call proceeds.**

Being over the cap is indistinguishable from "Node is unreachable," and the
designed response to "Node is unreachable" is "bill the platform key anyway."
The same fallback silently defeats **BYOK**: an org with its own key that hits
any `/resolve` failure gets the *platform* key, so we pay and the org's tier
override is ignored. The docstring at `router.py:214-222` shows the author
reasoned about exactly this — *"which is precisely the BYOK bypass, wearing a
different hat"* — but guarded only the case where `api_url` /
`internal_service_secret` are unset, not the case where the call fails.

`agents.ts:50` gates `/agent/chat` at the Node proxy, which is why this has not
been noticed. But that check is per-HTTP-request, and one turn is up to seven LLM
calls (`MAX_TOOL_ITERATIONS = 6` plus synthesis).

**Three compounding facts.**

`apps/api/src/workers/agent.worker.ts` contains **zero** references to
`costCap`, `assertCostCapNotExceeded`, `recordCost` or `recordUsage`. All nine
job types — `detect-binder`, `classify-document`, `extract-ai`,
`classify-request`, `redline-analysis`, `playbook-review`, `playbook-redline`,
`approval-summary`, `draft-contract` — call the agents service directly
(`:62,199,287,313,359,558,619,656`) with no pre-check and no post-record. Their
spend never reaches `OrgUsageDaily`, so the admin usage panel W0-6 fixed
under-reports by the entire background pipeline.

Fan-out on the whole-document redline is uncapped: `agent.worker.ts:424`
requests `maxClauses: 500` (the schema permits it — `internal-ai.ts:289`),
`:451-454` passes **every** deviating clause to `proposeClauseBatch` with no
length cap, `assist.py:101` declares `clauses: list[BatchClauseItem]` with no
`max_items`, and `assist.py:800-806` resolves the LLM **once**, outside the loop,
at the `reasoning` tier (→ `claude-opus-4-7`, `router.py:73`), then `:809` fans
out at `Semaphore(6)` and `:906` gathers all of them. **One job = up to 500 Opus
calls, one cap check that fails open, zero usage rows.** The `1..200` bound at
`internal-ai.ts:580` does not apply — the worker calls the library function
directly.

And that same worker is a single `new Worker('agents', …, { concurrency: 2 })`
handling all nine job types (`:710-734`), with **no `AbortSignal` or timeout on
any of its ten `fetch()` calls**. Two concurrent whole-document redlines occupy
both slots for many minutes and block `detect-binder` → `classify-document` →
`extract-ai` for every contract uploaded org-wide, with nothing to break the jam.

Finally, `assertCostCapNotExceeded` appears exactly once in `agents.ts` (line
50). The other six LLM-invoking routes have none: `/draft` (`:210`),
`/assist-stream` (`:348`), `/classify-clause` (`:394`), `/complete` (`:426`),
`/assist` (`:456`), `/compare` (`:484`) — all gated only on `view:contract`.
`/complete` is the editor's ghost-completion endpoint
(`GhostCompletion.ts:88`), i.e. typing-frequency. The global limiter is 1000
req/min **per IP** (`app.ts:169-172`), and its own comment concedes that per-org
limits belong on a post-auth limiter that does not exist. The cost cap was the
intended per-org backstop.

**What a user experiences today.** Nothing — that is the problem. An org over
its daily cap keeps generating, and we keep paying. A BYOK customer who
configured their own key is silently billed to us on any transient `/resolve`
failure. The admin usage panel shows a number that omits the entire background
pipeline. And a portfolio-wide redline run costs whatever it costs.

**The fix.** Give `/resolve` a distinct status for cap-exceeded (429) and make
`router.py` re-raise on it rather than falling back. Falling back on 5xx and
connection errors is fine; falling back on a **policy refusal** is not.

Then: `recordUsage` at the worker call sites so background spend reaches
`OrgUsageDaily`; a real cap on batch fan-out (`max_items` on the Pydantic
schema, a length cap in `proposeClauseBatch`, and a lower `maxClauses` in the
worker); an `AbortSignal` timeout on the worker's fetches; a separate queue or
higher concurrency so long redlines cannot starve ingest; and
`assertCostCapNotExceeded` on the other six routes.

**How we check it** — `scripts/agent-loops/l11-cost-cap.mjs`

1. Set an org's daily cap to zero under `block` policy, then drive a background
   `playbook-redline` job.
   **Before:** the job completes, LLM calls are made, and `OrgUsageDaily` gains
   zero rows. **After:** the job is refused with a distinguishable reason.
2. Same org, `POST /agent/chat`: 429 at the proxy, before and after. That gate
   already works and must not regress.
3. BYOK, reusing the W0-3 invalid-key probe: make `/resolve` fail with an
   invalid org key.
   **Before:** the call succeeds on the platform key. **After:** it fails
   attributably to the org's key.
4. Metering: run a background job under cap and assert `OrgUsageDaily` moved.
   **Before:** unchanged.
5. Fan-out: submit a contract with 300 deviating clauses.
   **Before:** the batch request carries 300 items. **After:** it is capped, and
   the truncation is reported rather than silent — the coverage-honesty rule
   from `docs/35` Phase 3.
6. Starvation: enqueue two long redlines plus one `classify-document`, and
   assert the classify job starts within a bounded time. **Before:** it waits
   behind both.

**Effort:** 2 days.

---

## L12 — Session memory grows without bound, and truncates the wrong tools

**Severity: Medium**

`memory.py:52-54` trims to the last **50 messages**. What each message carries is
`preview`, capped at `20_000` chars for 18 of the 26 tools
(`orchestrator.py:858-872`, `:874`, `:888-894`), and the restore loop at
`:655-684` rebuilds *every* persisted result as a `ToolMessage` with no cap.
There is no token-based trimming anywhere in the service.

Worst case per turn is `TOTAL_TOOLS_PER_TURN = 25` × 20 KB = 500 KB. Fifty
messages ≈ 25 assistant turns ≈ **12 MB replayed into the prompt on every
subsequent message**. Long before that it exceeds the context window and 400s —
which L3 then swallows into a blank bubble. Even a realistic six-turn research
thread re-sends 1–2 MB per turn, so cost grows quadratically in turn count.

The comment at `orchestrator.py:883-887` states the persisted slice is capped
*"at the same `preview` (≤2000 chars typically) so session memory doesn't blow
up."* That was true before the 20 K allowlist was introduced immediately above
it. It is now off by 10×, which is exactly why the growth is invisible in review.

**The mirror defect: A8 truncates the tools it does not name.** A8
(`orchestrator.py:404-414`) promises the entire prior listing is in history. The
three tools it names — `contract_search`, `portfolio_search`,
`counterparty_list` — are all in the 20 K allowlist, so for them the promise
holds. The genuinely affected read tools are `clause_search`,
`contract_validate`, `request_list` and `custom_field_list`, which persist at
**800** chars while the in-turn `ToolMessage` uses the full string
(`:897-900`) — hiding the loss inside the turn where it was created.

`clause_search` defaults to `limit=5` × `windowChars=400`
(`clause_search.py:37`), so 800 chars cuts it mid-token routinely.

**What a user experiences today.** Turn 1: *"What does the Mayo MSA say about
service credits?"* — several clause matches. Turn 2: *"Quote the second one."*
The replayed `ToolMessage` is a JSON string cut mid-token at 800 chars, so the
agent either quotes a truncated clause or re-runs the search and returns a
different match, contradicting its own previous answer — which is precisely the
contradiction A8 was written to prevent. And on a long research thread, the same
question gets slower and more expensive every time it is asked, until the thread
dies.

**The fix.** Trim by **bytes**, not message count, with a budget that reflects
the model's context window — keeping the most recent turns whole and dropping the
oldest tool results first, since prose is cheap and tool payloads are not. Then
decouple the two caps: keep the 800-char SSE preview for bandwidth, but persist a
larger slice to session memory, or simply add `clause_search`,
`contract_validate`, `request_list` and `custom_field_list` to the 20 K set —
and correct the comment at `:883-887`, which is the reason nobody caught this.

**How we check it** — `scripts/agent-loops/l12-memory-growth.mjs`

1. Drive a scripted 8-turn tool-heavy thread and measure the `session:<id>` byte
   size and the reconstructed prompt size after each turn.
   **Before:** grows superlinearly with no ceiling. **After:** bounded by the
   declared budget.
2. Assert the most recent turn is never dropped, and that ids from turn N−1 are
   still resolvable at turn N — the P64 behaviour this whole mechanism exists
   for, and the thing a naive byte-trim would break.
3. The A8 contradiction, as a direct probe: `clause_search` in turn 1, *"quote
   the second match"* in turn 2. **Before:** the persisted result is truncated
   at 800 chars and the quote does not match the turn-1 result. **After:** it
   does.
4. Assert the tool-result cap the code applies equals the cap the comment claims.
   A comment that has drifted 10× is a defect; pin it.

**Effort:** 1 day.

---

## L13 — Dead names and one dead code path

**Severity: Low** · *stale-code cleanup, no runtime consequence*

**`matter_get` is phantom in three independent places.**
`PER_TOOL_BUDGET` has `"matter_get": 3` (`orchestrator.py:526`, documented at
`:518` and again in the truncation comment at `:852-856`);
`SideAgentRail.tsx:660` and `AgentHomePage.tsx:527` both branch on it. There is
no tool file, no registry entry, and no `/tools/matter_get` endpoint. All three
references are inert — the budget can never be hit and the branches never match.
Three layers agree on a capability that has never existed.

The capability claim behind it is **overstated**, though: `matter_list` already
supports `counterparty_name` and free-text filters (`matter_list.py:19-38`) and
`internal-ai.ts:3745-3765` returns each matter's name, description, status,
counterparty, owner, tags and contract/request/thread counts — so *"tell me about
the Pfizer matter"* is answerable today. What genuinely cannot be done is
**enumerating a matter's contracts**: no tool takes a `matterId`, and
`contract_search` / `portfolio_search` have no matter filter.

**`draft_clause` is phantom in one place.** `artifact-from-tool.ts:307` reads
`if (call.name === 'contract_create_from_template' || call.name ===
'draft_clause')`, and a repo-wide grep across `.ts`/`.tsx`/`.py` returns that
single occurrence. Runtime impact is nil. The cost is that it reads as a
supported capability: an engineer adding clause-level drafting will assume the
artifact path is wired. That same file carries the receipt for this exact bug
class — *"Audit 2026-06-10: dropped the save_draft / send_for_review pseudo-tool
buttons"* — and `draft_clause` survived that cleanup.

**The legacy `run_chat` path blocks the event loop, and is more broken than it
looks.** `orchestrator.py:242` is a synchronous `graph.invoke({...})` inside
`async def run_chat` (`:210`), awaited directly from `routes/chat.py:111` with no
`run_in_threadpool`, and `general_respond` (`:156-183`) is a plain `def` whose
`llm.invoke(...)` at `:181` blocks for the full model round-trip. One such
request stalls the entire uvicorn worker for 5–30 seconds — every concurrent
agent chat, tool callback and health check behind it. It is latent because both
web surfaces send `agentMode: true` (`SideAgentRail.tsx:491`,
`AgentHomePage.tsx:407`), but `agents.ts:126` defaults
`agent_mode: body.agentMode ?? false`, so any direct API caller, probe or eval
script that omits the flag trips it. Worth knowing before touching it:
`draft_node` at `:121` is `async def` on the same graph, so the draft branch of
this synchronous `graph.invoke` is likely to raise outright rather than merely
block.

**The fix.** Delete the `matter_get` budget entry, the two comments and both
frontend branches — the honest one-line fix — *or* build the tool, which is a
product decision (see the open questions). Delete the `|| call.name ===
'draft_clause'` disjunct. Delete the legacy `run_chat` path: nothing in
`apps/web` reaches it, it duplicates `run_agent_chat_stream`'s provider
resolution and memory handling, and it is the last consumer of the LangGraph
import the orchestrator's own docstring still advertises. If it must stay, make
it async end to end rather than patching only `general_respond`.

**How we check it** — `scripts/agent-loops/l13-dead-names.mjs` (static)

1. Every tool name appearing in `PER_TOOL_BUDGET`, in any frontend
   `name === '<tool>'` branch, or in any `'/tools/<name>'` string, is registered
   in `get_read_tools()`. **Before:** `matter_get` fails it in three files and
   `draft_clause` in one.
2. `apps/agents/app` contains no synchronous `graph.invoke` inside an `async
   def`. **Before:** one.
3. Run this in CI. It is a grep, it costs nothing, and it is the guard that would
   have caught the original `template_list` incident three audits ago.

**Effort:** 1 hour, plus whatever the `matter_get` product decision costs.

---

## Sequencing

Three waves. The dependencies are real and the ordering inside each wave is not
arbitrary.

**Wave A — make failure visible, then make it stop (2 days)**

1. **L3** (error surface) first, despite ranking third. Until it lands, the
   pass/fail signal for everything else in a browser is "blank bubble" versus
   "blank bubble."
2. **L1** (session poisoning) and **L2** (`redline_propose` nulls) next, in
   either order. Both are small; both are blockers; both are currently invisible
   without L3.
3. ~~**L4(b)** — the `/agent/draft` org scoping — on its own commit. It is an hour
   and it is a tenancy boundary. Do not let it queue behind a two-day item.~~
   **Done 2026-08-08**, on its own commit, before the rest of this plan was
   written to disk.

At the end of Wave A the agent is usable for more than one write per thread and
the redline verb works at all.

**Wave B — reach and truth (7 days)**

4. **L4(a)** — gate drafting. Depends on nothing above, but must land **before**
   L5's batch write tools, because it establishes the pattern (`awaitingConfirmation`
   → apply → `checkToolPermission` → audit → undo) that `redline_apply_batch`
   then follows. Doing L5 first means writing the same wiring twice.
5. **L7** — the prompt. Do it **before** L5's behavioural probes, because the
   probes ask *"did the model select the new tool?"* and a routing table that
   never mentions the tool makes that question unanswerable. The static half of
   L7's check can land on day one and gate every subsequent prompt edit.
6. **L5** — redline reach. Depends on **L2** (a `redline_apply` tool is
   pointless while `redline_propose` 400s) and on **L4(a)**. Its `redline_docx`
   half additionally needs version ids exposed, which is new work inside the item.
7. **L8** — chip truth. Independent, but do it alongside L5 while both clients
   are already open.

**Wave C — the rest (6 days)**

8. **L6** — dead buttons. Fully independent of everything else; it is the only
   item a second engineer can take in parallel from day one. One shared
   dependency worth naming: its DOCX fix and L5's `redline_docx` tool both route
   through `generateRedlineDocx`, so agree the download pattern once.
9. **L9** — the three new verbs. Depends on **L7**, or the model will not select
   them.
10. **L10** — real streaming. Independent. Do the proxy half (`TextDecoder`,
    `X-Accel-Buffering`) first; it is 15 minutes and fixes a defect that will
    otherwise be blamed on the streaming change.
11. **L11** — cost control. Independent, and the only item with no user-visible
    symptom, which is why it will slip if it is not scheduled.
12. **L12** — memory. Independent, but its check overlaps L1's, so write them
    against the same session fixture.
13. **L13** — cleanup. Last, and its static check should be wired into CI in the
    same commit.

**One cross-cutting rule.** L4(a), L5, L8 and L9 all touch
`apps/api/src/routes/internal-ai.ts` (4113 lines). `docs/34` W0-5 records what
happened when four agents edited that file in parallel: they collided and one
briefly deleted a shared helper. Sequence those four items serially through that
file, or split it first.

---

## Deliberately not in scope

- **Rewriting the orchestrator loop.** The hand-rolled
  `for iteration in range(6)` at `orchestrator.py:531-952` is fine. It has
  budgets that degrade gracefully, a heartbeat for slow tools, a forced-synthesis
  safety net, and per-call exception handling that does not abort the turn. The
  file header advertises LangGraph and the agent path never touches it — that is
  a docstring fix (L13), not a rewrite.
- **Agent-driven whole-document redline *application*.** L5 gives the agent the
  batch tools; it does not make the agent apply a whole-document markup
  unattended. `docs/35:361-380` scopes Phase 3 as a UI review surface and
  `agent.worker.ts:388-390` states that staging deliberately does not apply,
  because the markup is a proposal for a lawyer to review. Changing that is a
  product decision, not a wiring gap.
- **The eval suite** (`docs/33` gap #3). Several items here — L7 especially —
  would be far better measured than argued. That is the next document, not this
  one.
- **An MCP surface** (gap #8). The tool layer is unusually MCP-ready and this
  work makes it more so. It still waits for RFP pressure.
- **A per-org post-auth rate limiter.** L11 restores the cost cap as the
  per-org backstop it was designed to be. A real limiter reading
  `req.user.orgId` is a separate piece of infrastructure that `app.ts:169-172`
  already describes and nobody has built.
- **Merging the two contract-creation implementations into one product flow.**
  L4 collapses the endpoint so the gate, audit and undo cannot drift. Deciding
  whether template-driven and intent-driven drafting should remain two
  behaviours is a product question.
- **Opening the generated DOCX in real Microsoft Word.** Still owned by
  `docs/35` and still unrun.

---

## Open questions for the founder

1. **Should drafting stop and ask?** Today the agent drafts immediately and says
   so, by deliberate design (`orchestrator.py:471-492`, P7.7.3/F-84) — the
   contract lands in DRAFT tagged `agent-draft` with an "Open in Contracts"
   card. Routing it through the Apply gate fixes RBAC, audit and undo in one
   move, and adds a click to the flow that demos best. The alternative — keep
   immediate drafting, add an explicit permission check and audit event inside
   the endpoint — costs more code and leaves the user with no preview of the
   template chosen. Recommendation: gate it, because "every write asks first" is
   a claim we want to be able to make without an asterisk. But this changes the
   demo.

2. **Should the agent ever apply a whole-document redline on its own?** L5 gives
   it the batch propose and apply tools behind the confirmation card. A user
   could then say *"redline this against our playbook and apply everything"* and
   get one card covering twelve clauses. `docs/35` deliberately made this a
   review surface where a lawyer sees each change. One card for twelve legal
   changes may be the wrong granularity — but per-clause cards for twelve
   clauses is also unusable. This is a UX decision with a liability shape.

3. **When an org is over its cost cap, does the turn fail or does it fall
   back?** Today it falls back to our key and we pay silently. Blocking is
   correct on principle and means a customer mid-conversation gets a hard error.
   Related: should a BYOK org whose key fails transiently be served on the
   platform key at all? Today it is, and that is invisible to both sides.

4. **`matter_get`: build it or delete it?** Three files already assume it
   exists. `matter_list` can answer *"tell me about the Pfizer matter"*; what it
   cannot do is enumerate that matter's contracts, because no tool takes a
   `matterId`. If matters are a real organising primitive for your buyers, this
   is the missing verb and it is a day. If they are a filing convenience, delete
   the three dead references and stop implying otherwise.

5. **The Settings notification toggles: implement or remove?** Eleven controls
   promise behaviour nothing implements, and the panel says "All toggles persist
   immediately" — technically true, completely misleading. Implementing the
   per-type gating is half a day. Implementing the *daily digest* option is not,
   and shipping an option we do not honour is how this happened. Recommendation:
   implement the five type toggles, remove the digest option until it exists.

6. **Should the agent be able to decide approvals at all?** L9 proposes
   `approval_decide`, correctly scoped so only the assigned approver can act. But
   *"approve it"* typed into a chat box, even behind a confirmation card, is a
   meaningfully different product from *"route it for approval"*. Some buyers
   will consider a chat-driven approval a control weakness regardless of how it
   is gated. Worth deciding before it is built, not after.

7. **The model picker is decorative.** Both chat surfaces hardcode
   `provider: 'openai'` (`SideAgentRail.tsx:489`, `AgentHomePage.tsx:414`),
   overriding the org's AI configuration for the actual chat call. The comment on
   `AgentHomePage` says this was deliberate, to match the rail. If per-org model
   choice is something we sell, this is a defect; if it is not, the picker should
   come out of the UI.