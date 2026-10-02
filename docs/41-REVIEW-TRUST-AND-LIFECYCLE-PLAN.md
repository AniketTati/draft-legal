# 41 — Review trust, lawyer workflow and lifecycle (a plan to review, not to build yet)

**Status:** for review. Nothing in this plan is built. Nothing gets built until the
plan is approved.
**Written:** 2026-10-01.
**Branch:** `docs/review-gap-plan`.

**What the findings rest on**
- **Code:** production code at `cdcaa91`. Production has served this since
  2026-09-30 12:47 UTC, so it is exactly the code that created the reported request
  and contract today. `A/` means `apps/api/src`, `G/` means `apps/agents/app`, and
  `W/` means `apps/web/src`.
- **Ironclad:** the screenshots you supplied, the two transcripts, and Ironclad's
  public help centre (article ids are given as `[IC 123…]`).
- **Unmerged work:** the `feat/field-capture` worktree (docs/39), which has
  uncommitted changes, is noted where it changes the picture.

**What I could not do.** Reading the production database was blocked, and so was
reading the local database's credentials. So I could not open
`cmup8rdo00006vytfpnxzqomg` or `cmupg9r220004yadhsl24rtyi`. Every diagnosis below
is traced from the code. Where a record would settle the question, the item says
which field to check. In most cases the code leaves only one path that can produce
what you saw.

---

## 1. Executive diagnosis: eight problems at the root

The 20 items are not 20 bugs. Most of them are symptoms of these eight problems.

1. **Analysis depends on how a contract was created, not on its versions.**
   - **Today:** full clause, risk and term extraction runs only when an uploaded
     file is parsed.
   - **Paths that skip it:**
     - drafting from a request (`A/workers/agent.worker.ts:736-797`);
     - drafting from a template in the assistant (`A/routes/internal-ai.ts:3505`);
     - adding a draft as a new version.
   - **The status is wrong.** These paths still set `analysisStatus = DONE`.
   - **Edits** only carry the old clauses forward by word diff. Risk score, key
     terms, summary, compliance and the approval summary are never redone.
   - **Result:** a contract can look "analysed and clean" when nothing was ever
     analysed. That is the case for your NDA.
   - **Symptoms it explains:** items 2, 3, 5, 7 and 11.

2. **Nothing to compare against, so a missing clause is invisible.**
   - Every check loops over the clauses that exist.
   - There is no list of clauses required per contract type, and no "required"
     flag on a playbook position.
   - The contract does not record which template or clause versions produced it.
   - The approval recommendation never looks at the previous version.
   - **Result:** delete Governing Law and there is simply nothing left to flag.
   - **Symptoms:** items 2 and 7, and the "Missing" gap in item 15.

3. **The verdicts users see are unanchored model opinions.**
   - **"Approve":** an LLM reads a risk score that is `null` and treated as `0`
     (`G/agents/approval_agent.py:185,218`), plus a summary of the first 8,000
     characters.
   - **"MARKET" / "WEAK" badges:** come from a fast model rating one paragraph,
     with no org, no contract type (hard-coded `'general commercial'`), no playbook,
     and no knowledge that the text came from our own template.
   - **Compliance applicability:** decided by one LLM call.
   - **Unused rules engine:** the deterministic engine (`A/lib/playbook-rules.ts`)
     feeds only the Playbook Redline button and the chat tool.
   - **Symptoms:** items 2, 5, 7 and 9.

4. **Drafting decisions come from prompt defaults, not recorded rules.**
   - **Where Delaware comes from:** `G/agents/draft_agent.py:132`, *"default to
     'Delaware' if not specified"*, together with the seeded variable defaults.
   - **Lost request data:** the governing law the intake classifier extracted is
     thrown away when the request is converted (`A/routes/requests.ts:272-279`).
   - **Clause library unused:** no code ever picks between the approved
     alternatives in the library.
   - **Nothing recorded:** neither the choice nor the template is stored.
   - **Symptom:** item 1.

5. **"Reject" means nine different things, and approval state can't be seen on
   the contract.**
   - **The page that shows approvals is broken.** It asks `GET /approvals?contractId=`,
     a route that does not exist (`W/pages/ContractDetailPage.tsx:839`;
     `A/routes/approvals.ts` has only `/my-queue`, `/all` and `/:instanceId`).
     So every place that should show the approval history is always empty: the
     timeline, the rail and the "waiting on" strip.
   - **The rejection reason is stored but shown nowhere.**
   - **The message you saw belongs to something else.** It came from the Compare
     overlay's Accept/Reject buttons for changes in the text.
   - **Symptoms:** items 4, 6 and 12.

6. **The lifecycle is implied, not modelled.**
   - **What is missing:** no stored stages, no stored turn, no status history
     table.
   - **Dead ends:** there is no way out of `PENDING_SIGNATURE` once an envelope is
     voided.
   - **No gates:** signing does not require approval, and an approval pending
     during edits is not reset.
   - **Binder banner bug:** every child contract shows "Split from binder"
     (`ContractDetailPage.tsx:2122` never checks the relationship type).
   - **Shallow follow-on work:** amendments and renewals create empty drafts that
     nothing rolls up.
   - **Symptoms:** items 13, 14 and 18.

7. **Surfaces have multiplied and the labels mislead.**
   - **Duplicated engines and views:**
     - two playbook engines with two UIs;
     - three views of version changes;
     - four places showing approval status;
     - the Versions tab, History rail and Overview list the same versions.
   - **Misleading labels:**
     - "Sync on" only means a websocket is connected;
     - "MARKET" means nothing about the customer's market;
     - CompareMode's per-change "Reject" looks exactly like the approval Reject.
   - **Symptoms:** items 8, 10, 12, 15 and 16.

8. **Failures are silent.**
   - **Errors are not displayed:** several actions have no error display at all,
     including the Playbook Redline start, DecisionStrip decide, and request
     reject.
   - **Zero results look like success:**
     - chunking with zero clauses ends as DONE;
     - a failed agent callback is only logged;
     - Playbook Redline on a contract with no clauses reports "No clause deviated
       from the playbook".
   - **Symptoms:** items 3 and 11, and the general feeling that a button "did
     nothing".

**The single most important fix.** Make the **version** the unit of analysis. Every
version that a person will rely on is analysed, and every piece of analysis is
stamped with the version it describes. "Not analysed" becomes a visible state,
never `DONE`.

Most trust bugs disappear once two more things exist:
- **Presence rules** for clauses (required / not allowed / optional).
- **A recorded origin**: which template, version and clause each part came from.

---

## 2. Issue-by-issue

Each item uses the same headings. Effort is S/M/L/XL. Priority is P0 (it can make
us give a wrong legal answer), P1 (the core workflow), or P2.

### Part 1: Template generation and clause selection

**Observation.** A request with no document was classified as an NDA and drafted
from the standard NDA template. The draft says Delaware, even though the clause
library has several governing-law clauses.

**Current behaviour** (the request path, which differs from the assistant's)
1. **Classify.** `classify-request` stores `_aiClassification`, including
   `extractedTerms.governingLaw` (`G/routes/intake.py:44`).
2. **Convert.** It builds `_draftContext` from five fields: title, description,
   type, counterparty and value. **The extracted terms are dropped**
   (`A/routes/requests.ts:272-279`).
3. **Draft worker.** It sends one sentence to `/draft`. No template id is sent.
4. **Draft agent** (`G/agents/draft_agent.py`):
   - It works out the contract type again with an LLM.
   - It lists the org's published templates of that type, newest edit first. The
     seed has three NDA templates.
   - With more than one, an LLM picks from their names. If its reply can't be
     parsed, the newest template is used (`:281`).
   - There is **no "standard" flag**.
   - The assistant's own path (`A/lib/draft-plan.ts:161`) takes the newest
     template without any LLM, so the **two paths can choose different
     templates**.
5. **Fill variables.** An LLM fills the variables. The prompt says to default
   governing law to Delaware, and the seeded variable defaults say `'Delaware'` and
   `'Wilmington, Delaware'` (`A/lib/org-seed/universal/templates.ts:55-58`).
6. **Save.** The template engine only substitutes values. The worker keeps only
   the HTML and drops `usedTemplateId`, `variableValues`, `missingFields` and
   `reviewNotes`. It does not set `currentVersionId`, and writes no audit event.
7. **Clause library.** Never read. All seeded sections have `clauseRefs: []`.

**Root cause.** Delaware is a deterministic default in two places, the prompt and
the seed data, not a hallucination. Any governing law the requester mentioned is
lost at the convert step. Nothing in the product can choose between approved
variants, and nothing records the choice.

**To confirm:**
- v1 `htmlContent` (look for `data-template-id`);
- the request's `metadata._aiClassification.extractedTerms`;
- the Langfuse traces `draft.select_template` and `draft.fill_variables`.

**Expected behaviour** (what a lawyer expects)
- The draft follows the company's rules for choosing a clause. For example: our
  standard governing law is New York unless the counterparty is in the EU or UK,
  in which case English law.
- If a rule can't decide, the draft asks rather than guessing.
- Afterwards, anyone can see *why* the draft says what it says.

**Competitive insight** (verified)
- In Ironclad, alternatives are chosen **deterministically from launch-form
  answers**, through conditions set on the template ("IF property IS …"). A clause
  library clause is tagged into a template with a display condition [IC
  30659495044759, 12250550045463].
- Documents are regenerated when the properties change, unless someone has edited
  them by hand.
- AI does not choose between approved variants.

**Should AI ever silently choose between approved variants?** **No.** AI may
*propose* a variant, quoting the request text it relied on ("counterparty is
Berlin-based, so EU rule"). The choice is then made by a rule, or confirmed by the
person.

**Recommendation: deterministic clause selection**
- **Clause slots.** A template section can hold a *clause slot* that points to a
  clause-library **family** (for example Governing Law) instead of literal text.
- **Variants.** Each family has approved variants. Each variant has a version and
  a *selection condition* written in terms of request or contract variables
  (`counterparty.country in [EU…]`, `value > 250000`, `type = NDA`). Exactly one
  variant is marked the family's **default**.
- **Resolution order at draft time.** The first step that yields a variant wins:
  1. An explicit choice by the user on the request form.
  2. A **value** with evidence in the request (`governingLaw: "New York"`, from
     the classifier). It is matched to a variant by exact jurisdiction, not by
     similarity.
  3. The first variant whose condition is true.
  4. The family default.
  5. Otherwise the draft is **not silently filled**. It shows an unresolved slot
     ("Choose governing law: New York · England & Wales · Delaware"). The request
     shows "1 choice needed", and the draft can't be sent until it is chosen.
- **Pin at publish.** Publishing a template snapshots it (template version plus
  the variant versions in each slot). The draft records that snapshot. Later
  edits to the library don't change past drafts, but a template can be
  republished to pick them up.
- **Audit.** For each draft, record `metadata._origin` as `{templateId,
  templateVersion, slots:[{family, variantId, variantVersion, decidedBy: user|
  request_value|rule|default, ruleId?, evidence?}], variables:[{key, value,
  source}]}`, and write a `CONTRACT_DRAFTED` audit event.
- **Remove LLM defaults.** Drop the "default to Delaware" line from the prompt and
  stop the LLM filling legal choices from defaults. The LLM only *extracts* values
  from the request text, with quotes. Defaults come from the template rules.
- **One drafting path.** The request path uses the same deterministic planner as
  the assistant (`draft-plan.ts`) to pick the template, and the agent is only used
  to extract variables. Picking a template becomes deterministic: the org's
  **default template per contract type** (a new flag); otherwise the user picks
  when more than one is published.

**Implementation**
- **Frontend:**
  - template builder: insert a clause slot, and edit variants and conditions on
    the clause-library family;
  - request form: show resolved and unresolved choices before drafting;
  - draft: an "Origin" panel listing slot decisions and their sources.
- **Backend:**
  - `generateDocument` resolves slots;
  - `handleDraftContract` passes the classifier terms, saves `_origin`, sets
    `currentVersionId`, writes the audit event, and **queues analysis** (see Part
    11);
  - add a per-type template default.
- **Data model:**
  - `ClauseLibraryItem` gets `familyId`, `condition` (JSON), `isFamilyDefault` and
    `version`;
  - `TemplateSection` gets `slotFamilyId`;
  - new table `TemplateVersion` (snapshot);
  - `Template` gets `isDefaultForType`.
- **AI/LLM:** the draft agent becomes a variable extractor that returns
  `{key, value, quote}`. Remove default-filling from the prompt.
- **Migration:**
  - The current governing-law section text becomes a slot over the seeded
    Delaware, New York and other library entries. Delaware stays the default only
    where an org chooses it.
  - Existing templates keep working, because literal sections stay valid.
- **Testing:**
  - unit tests of the resolution order;
  - a request mentioning New York produces a New York draft;
  - a request with no law and no default produces an unresolved slot, and sending
    is blocked.
- **Acceptance:**
  - *Given* a request saying "governed by New York law", *when* it is drafted,
    *then* the draft uses the New York variant and `_origin` records
    `decidedBy: request_value` with the quote.
  - *Given* no rule and no default, *then* the draft shows an unresolved slot and
    "Send" is disabled with the reason given.
  - *Given* the same request drafted twice, *then* both drafts have the same
    template and variants.

**Priority / effort / dependencies**
- **P0:** stop silent defaults and keep the request's terms. Effort S.
- **P1:** slots, variants and pinning. Effort L.
- Depends on Part 11 (analysis after drafting) and field-capture H2 (variables in
  drafts).

### Part 2: An untouched Purpose clause flagged as weak

**Observation.** An NDA generated from our template, with Purpose unchanged, is
called weak.

**Current behaviour**
- The only source of "weak" is the **editor margin classifier**
  (`W/components/editor/ClauseClassifier.ts`, enabled in
  `W/components/contracts/DocumentCanvas.tsx:129-134`). It sends the first 12
  paragraphs of at least 80 characters to `/agent/classify-clause` →
  `G/routes/assist.py:131-202` (fast model).
- The prompt: rate the paragraph *"relative to common market practice"*; *weak*
  means weaker than market.
- **What it is not given:** org, contract type (hard-coded `'general
  commercial'`), playbook, and the fact that the text came from our template.
- **Nothing is saved.** "Accept as-is" only closes the popover, so the flag
  returns on every load. Results also vary between runs.
- The seeded Purpose sentence ("…in connection with {{purpose}} (the
  "Purpose")") is broad by design. A context-free model reads it as weak.
- **The full pipeline never ran on this contract** (Part 11). So no playbook
  verdict exists; the badge is the only verdict on screen.

**Root cause.** Two things combine:
- an AI opinion with no grounding, shown as if it were a review result;
- the absence of any rule saying "text identical to the approved source is
  standard".

PR #55 changed the *assistant's* contract-type inference. It did not touch this
code path.

**A related bug the fix must handle.** The seeded NDA template uses a 3-year
confidentiality term, which is the playbook's *fallback* position (preferred is 5
years, `org-seed/.../playbook.ts:50-53`). Once real analysis runs, our own template
will be flagged against our own playbook.

**Expected behaviour.** A clause that is byte-for-byte (after normalisation) the
approved template or variant text, with variables filled from allowed values, is
**Standard**. It is labelled "From template NDA v3, unchanged". It isn't sent to
an LLM for a quality opinion, and it isn't flagged.

If a template contradicts the org's own playbook, that is a **template problem**,
shown to the template owner and admin once. It is not a per-contract warning to
every lawyer.

**Competitive insight** (verified)
- **First step is exact text matching.** Ironclad Playbooks first look for the
  **exact text of each preferred and fallback position**; a match is "deemed
  acceptable". Only then does the AI look for the clause [IC 12275685560215].
- **Your screenshot** shows Fees and Governing Law as "Accepted · Uses custom
  language". "Accepted" is the bucket for positions that matched.

**Recommendation**
- **Fingerprint at generation.** Generation stamps each section or slot with a
  content hash of its normalised text (variables replaced by typed placeholders).
- **Check at review.** Analysis compares each clause span with the fingerprints
  in `_origin`. If they match, the clause's status is `standard` with source
  `template` or `library variant`, and that is final unless a playbook rule
  covers a *variable value* (for example a term below the minimum). Only clauses
  that changed, or are not in the template, go to the LLM.
- **Hide the margin classifier** until it is grounded in the org's playbook and
  the contract type. Its job then becomes "how this paragraph compares with your
  positions", so the badge reads "Matches your preferred position" and not
  "MARKET". Badges for template-identical text are not shown.
- **Template lint** (admin): when a template is published, check its sections
  against the playbook and show any conflicts ("Confidentiality term 3 years is
  your fallback position, not your preferred one").

**Implementation**
- **Frontend:** a "Standard: from template" chip on clauses; the classifier gated
  behind a flag; template lint results in the template builder.
- **Backend:** fingerprints in `generateDocument`; a matching step in clause carry
  and extraction; a lint endpoint.
- **Data model:** `ContractClause.provenance` (`template|library|counterparty|
  internal_edit|unknown`) and `sourceRef`.
- **AI/LLM:** fewer calls, because standard clauses are skipped.
- **Testing:**
  - a contract generated and left unchanged has 0 findings on template clauses;
  - one word changed in Purpose sends Purpose to review as `modified`.
- **Acceptance:**
  - *Given* a contract generated from template v3 and not edited, *when* it is
    analysed, *then* every clause from the template is "Standard" and none is
    labelled weak or non-standard.
  - *Given* a template whose text is a fallback position, *when* it is published,
    *then* the admin sees a lint warning.

**Priority / effort / dependencies**
- **P0:** hide or ground the badge. Effort S.
- **P1:** fingerprints. Effort M.
- Depends on Parts 1 and 11.

### Part 3: "Fetch Playbook" failed

**Observation.** On the same contract, fetching the playbook failed with a generic
message.

**Current behaviour.** No UI element is labelled "Fetch Playbook". These are the
surfaces it could be, most likely first.
1. **Playbook redline → "Redline against playbook"**
   (`W/components/contracts/PlaybookRedlineRailSection.tsx:142-150`), which calls
   `POST /contracts/:id/redline-against-playbook`.
   - Because the draft worker never set `currentVersionId`, the route answers
     **400 "Contract has no current version to redline"**
     (`A/routes/contracts.ts:2344`).
   - The action has no error display, so the button just resets.
   - If the user had saved an edit first (which sets the version), the job would
     run over **0 clauses** and report "No clause deviated from the playbook". That
     is a false all-clear.
2. **The assistant's `playbook_check` tool** (the "Compare to playbook" chip). It
   reads the clause rows, finds none, returns `checks: []`, and any 400 or above
   shows as "playbook check failed".
3. **The Playbook review rail** shows "Not reviewed yet" or "could not be loaded".
   The review is only ever queued after parsing a file.

**How a playbook is chosen.** There is no Playbook object. The playbook is the
org's `PlaybookPosition` rows, filtered by `contractTypes` (an empty list means
all types) and matched to clause categories by name. Several playbooks for one
type can't exist, and "none apply" yields `no_positions` or `not_covered`.

**Root cause:** the missing `currentVersionId` and missing analysis (Part 11),
plus the absent error display. It is not a playbook-selection bug.

**Expected behaviour.** "Review against playbook" never fails silently. The user
always sees one of these:
- "This draft hasn't been analysed yet — Analyse now" (with the reason);
- "No playbook covers NDAs — Set one up" (for admins) or "Ask an admin";
- "2 playbooks apply — using *Sales NDA playbook* (default for NDAs)";
- a real error, with a reference id.

**Recommendation**
- **Playbook object.** Introduce a light **Playbook** entity: a name, the contract
  types it covers, a default per type, a version, and positions as children.
  Selection is deterministic: an explicit choice on the contract, otherwise the
  default for the type, otherwise ask.
- **Gate and empty states.** The action checks that analysis is complete. Every
  empty state is spelled out.
- **API errors.** Responses carry `{code, message, action}`, and the web app shows
  them through one global toast.

**Implementation**
- **Frontend:** a global error toast in the API client; explicit states in the
  rail.
- **Backend:** a `Playbook` model with existing positions moved under one "Default
  playbook" per org; `GET /contracts/:id/playbook` returns the playbook chosen and
  why.
- **Observability:** log `playbook.resolve` with the outcome.
- **Testing:** the four states above.
- **Acceptance:** *Given* a draft with no analysis, *when* the user runs the
  playbook review, *then* they see "Not analysed yet" with an Analyse button, and
  no false all-clear.

**Priority / effort / dependencies**
- **P0:** error display and the analysed gate. Effort S.
- **P1:** the Playbook entity. Effort M.
- Depends on Part 11.

### Part 4: Reject in the approval flow did nothing meaningful

**Observation.** You clicked Reject. The only visible result was "Redline merge:
12 accepted, 0 rejected vs v4".

**Current behaviour**
- **The message is not from approvals.** "Redline merge: N accepted, M rejected"
  is the **change note of a new version** written by the Compare overlay's "Apply
  as new version" (`W/components/contracts/CompareMode.tsx:112`). Its per-change
  "Reject" only changes browser state until Apply is clicked. "Accept all"
  overwrites earlier choices, and clicking the same button twice undoes it. So
  "0 rejected" means no Reject was recorded at the moment Apply was clicked.
- **The real approval Reject** (DecisionStrip, ApprovalCard, bulk, Slack) calls
  `POST /approvals/:id/decide`:
  - the step, the other pending steps and the instance become REJECTED;
  - the contract returns to DRAFT, but only if it was PENDING_APPROVAL;
  - the audit events are written on approval resources, not on the contract;
  - the submitter is notified **without the reason**.
- **Why it looked like nothing happened:**
  - the contract page's approval history call goes to a **route that doesn't
    exist** (verified: `ContractDetailPage.tsx:839` calls
    `/approvals?contractId=`, and no `GET /` is registered), so the timeline, the
    rail section and the strip are always empty;
  - the Activity tab only shows contract-resource events;
  - after the decision, the DecisionStrip disappears and the newest thing on
    screen is the version note.
- **Silent failures:** DecisionStrip has no error state, and the cache keys it
  clears don't match the ones the page uses.
- **Nine meanings of "Reject"** in the product: approval step, bulk approvals,
  Slack, the agent tool, a diff span in Compare, a clause in the review drawer
  (`reviewState=rejected`, no audit), a Review Queue field, a request, and a
  signer's decline.

**Root cause.** The word is overloaded. The approval outcome can't be seen because
of the 404. The reason is not shown anywhere.

**Expected behaviour: what Reject means.** An approver's Reject is a decision on
**the approval request for a specific version**. It means "not approved as is".
It is not a decision about the whole contract, or about any one clause or change.

The flow:
1. The reviewer gives a reason, which is required. Optionally they point at
   clauses or findings, and choose "changes needed" or "do not proceed".
2. The approval request becomes *Returned*.
3. The contract goes back to its previous working stage (Negotiate if it was
   negotiating, otherwise Draft) with the turn set to the owner.
4. The owner and submitter are notified, **with the reason**.
5. A banner on the contract reads "Returned by Priya: 'Liability cap must be 1×
   fees' — Fix and resubmit".
6. The event appears in Activity.
7. Resubmitting creates a new approval request on the new version. The history
   keeps both.

**Competitive insight**
- **Verified:** Ironclad documents **no formal approver Reject**. The approval
  statuses are Requested, Pending and Approved. Moving backwards is "Revert to
  Review", or an approval reset when the document changes [IC 12285717702167,
  40675997675031].
- **Assumed:** pushback happens through comments plus a revert.

Our explicit "Return with reason" is clearer than this, and worth keeping.

**Recommendation**
- **Rename by object:**
  - approval: "Return for changes" / "Decline";
  - Compare: "Keep original" / "Accept change", in neutral styling;
  - clause review drawer: "Not acceptable" (and it writes an audit event);
  - request: "Decline request", with a stored reason.
- **Make approval visible:** add `GET /contracts/:id/approval` (the newest
  instance plus history) and fix the four displays to use it.
- **Write the decision into the contract's activity**, with the reason.

**Implementation**
- **Frontend:**
  - new labels;
  - a "Returned" banner;
  - error states on all decision buttons;
  - one cache-key helper for approvals.
- **Backend:**
  - the contract-scoped approval route;
  - the notification body includes the reason;
  - an audit event on `contract`;
  - outcome `RETURNED` vs `DECLINED`.
- **Data model:**
  - `ApprovalInstance.versionId` (which version was approved or returned);
  - the `outcome` enum;
  - `ContractRequest.rejectionReason`.
- **Workflow:** a return goes to the previous working stage (see Part 18).
- **Testing:** the end-to-end reject journey; the reason appears in three places
  (banner, notification, activity).
- **Acceptance:**
  - *Given* a pending approval, *when* the approver clicks Return with a reason,
    *then* within one refresh the owner sees the banner with the reason, gets a
    notification containing it, the Activity tab shows it, and the contract is in
    Draft or Negotiate with the turn set to the owner.
  - *Given* Compare mode, *then* no button there is labelled "Reject".

**Priority / effort / dependencies**
- **P0:** the 404, the reason, and error states. Effort S–M.
- **P1:** the renames and versioned approvals. Effort M.
- Depends on Part 18 for "previous stage".

### Part 5: Junk in the Miscellaneous clause still shows "Aligned with Market"

**Observation.** Junk text was inserted and saved; the label stayed "Aligned with
Market".

**Current behaviour**
- **The label isn't in the code.** The exact text "Aligned with Market" appears
  nowhere in the web app, API or agents (verified with grep). The nearest
  candidates are:
  - the margin badge **MARKET**, "In line with common market practice"
    (`ClauseClassifier.ts:62-68`), and its popover "In line with market practice";
  - free LLM wording in the Negotiate redline analysis, which scores changes on
    "general market practice" when no playbook applies (`G/routes/redline.py:94-97`);
  - assistant chat text.
- **Badge results are cached in the browser** by a hash of the paragraph's text.
  New paragraphs under 80 characters, or past the first 12, are never classified.
  Junk added as its own short paragraph leaves the original paragraph's MARKET
  badge in place.
- **Junk inside the paragraph** is re-classified, but a model can still call
  "boilerplate + junk" market. Nothing checks whether the text makes sense.
- **Saving creates a version and only carries clauses over.** Risk, key terms,
  summary, compliance and the approval summary are not redone. The playbook review
  re-runs two minutes later, and only if a clause *changed*. A deleted clause does
  not count as changed.

**Root cause:**
- "Market" has no definition.
- The badge has no grounding, is cached in the browser, and is limited to 12
  paragraphs.
- No re-analysis follows an edit.

**Expected behaviour.** Every verdict label has a written definition and a source:
- **Matches your position:** `Preferred` / `Fallback` / `Needs approval`, from the
  org's playbook.
- **Standard:** unchanged from the template or library (Part 2).
- **Changed since vN:** a deterministic diff.
- **Not covered by your playbook:** with an explicit note that nothing was checked.

"Market" is only shown if we ever build a real benchmark dataset, and then it
names its source ("in line with 72% of 1,200 NDAs in our benchmark"). Until then
it doesn't appear.

**Re-analysis after an edit:**
- the edited clause spans are re-classified and re-reviewed;
- deleted spans produce "removed" findings;
- every analysis result shows the version it describes;
- the UI shows "Analysis is for v4 — v5 has changes. Re-analysing…".

**Competitive insight** (verified)
- Ironclad's status vocabulary is tied to the playbook: Needs review, Not
  detected, Acceptable / Detected, and "Non-standard language" for text that
  matches no position [IC 24948981301143].
- A clause approval resets when that clause's text changes [IC 12274990683543].
- Your screenshots show "Fix non-standard language" and "Uses custom language".

**Recommendation**
- **Remove "market" from all UI and prompts that lack a benchmark.** Replace it
  with playbook-relative statuses.
- **Version-bound analysis.** Every analysis artefact carries `versionId`
  (Workstream A).
- **Incremental re-analysis on checkpoint versions** (see Part 7 and the critique
  in §6 about saving a version on every keystroke).
- **Sense check.** A deterministic check that flags edited text that doesn't read
  as language (for example a high ratio of non-dictionary tokens, or no verb).
  It reports "unreadable text added in §12" as a drafting issue.

**Implementation**
- **Frontend:** a "Stale" indicator; remove the "market" copy; a playbook-relative
  badge.
- **Backend:** `afterEdit` queues `reanalyse(versionId, changedSpans)` once a
  checkpoint is reached; deleted clauses count as changes.
- **AI:** the classifier receives org positions, the contract type and the clause
  type.
- **Testing:** edit with junk → finding; delete a clause → finding; the badge
  updates within one analysis cycle.
- **Acceptance:**
  - *Given* a clause edited with nonsense text, *when* the version is
    checkpointed, *then* within 2 minutes that clause shows "Changed since v4 —
    needs review" (and "unreadable text" if applicable). No "aligned" label
    remains.
  - *Given* any status label, *then* hovering it shows its definition and source.

**Priority / effort / dependencies**
- **P0:** remove "market" and add the stale indicator. Effort S.
- **P1:** incremental re-analysis. Effort L.
- Depends on Workstream A.
- **To confirm:** a screenshot of where "Aligned with Market" appeared (badge
  popover, Negotiate panel, or chat).

### Part 6: Queue counts (My Queue 2, All Approvals 4, Bulk 4)

**Current behaviour** (verified in `W/pages/ApprovalsPage.tsx` and
`A/routes/approvals.ts`)
- **My Queue** = approval **steps** where the approver is me, the status is
  PENDING, and the step is the current step of its workflow. The header calls
  them "contracts".
- **All approvals** = approval **instances** (one per contract workflow) that are
  PENDING, IN_PROGRESS or ESCALATED, **whoever is the approver**:
  - it includes workflows waiting on other people, and "unrouted" ones stuck when
    no approver was found for the next step;
  - it includes deleted and diligence-room contracts;
  - the tab is shown by role name, while the API checks a permission.
- **Bulk decision** gets the same `items` array as My Queue. Within one render it
  can't differ from My Queue's list, though it can differ from the badge if the
  badge's `total` and the list are fetched at different times.
- **Likely explanation.** Your 4 was probably the All count, or a My Queue count
  taken earlier and later refreshed. Cache keys are wrong after a decision: the
  DecisionStrip clears `['approvals','my-queue']`, which nothing uses, and
  `approval-all` is never refreshed.
- **Other defects:**
  - a sequential role step is assigned to **the first user holding the role**
    (`A/lib/workflow-engine.ts:400`), so other holders never see it;
  - if step numbers in a definition skip a value, the workflow is approved early
    (`:225`).

**Root cause.** Two different things are counted (steps for me versus every open
workflow) under labels that don't say so, and the cache is not refreshed
correctly. It is mostly a definitional mismatch, plus real staleness bugs.

**Expected behaviour.** The lawyer sees one number that answers "what needs **my**
action now": **contracts** waiting on me, not steps.

**Recommendation: information architecture**
- **"Needs my action"**, counted by contract. It combines:
  - approvals waiting on me;
  - returned contracts I own;
  - contracts where the turn is internal and I'm the owner;
  - clause exception requests assigned to me.
  Each row shows the action needed ("Approve", "Fix and resubmit", "Respond to
  counterparty").
- **"Waiting on others"**, for things I own or submitted, showing who has them and
  for how long.
- **"Team" / "All in flight"** (Legal Ops), with filters: stuck (no approver),
  aging over N days, by stage.
- **Bulk actions** act only on the current filtered list, and the dialog says so.
- **Role approvals** go to a **pool**: every holder of the role sees the step, and
  the first to decide claims it.

**Implementation**
- **Frontend:**
  - a new inbox page replaces the tabs;
  - one count, computed on the server, shared by the badge and the list;
  - shared query keys.
- **Backend:**
  - `GET /inbox` returns rows already deduplicated by contract;
  - the `/all` filter excludes deleted contracts;
  - pooled role assignment (`ApprovalStep.approverRoleId`, with the claimer set on
    decision);
  - `advanceWorkflow` moves to the *next existing* step order.
- **Testing:**
  - a contract with 2 of my steps counts once;
  - a role step is visible to every holder;
  - the badge equals the list length after a decision.
- **Acceptance:** *Given* any moment, *then* the sidebar badge equals the number
  of rows in "Needs my action". *Given* a decision, *then* both update with no
  reload.

**Priority / effort / dependencies**
- **P1:** cache fixes and labels. Effort S.
- **P1:** the inbox. Effort M.
- Depends on Parts 4 and 18 (turn).

### Part 7: The AI recommends Approve after material deletions

**Observation.** Governing Law was deleted and half of Exclusions removed, yet the
recommendation was **Approve**. This is the most serious trust issue.

**Current behaviour**
- `submit-approval` calls the approval agent once (`A/routes/contracts.ts:2690`).
- The agent's recommend prompt (`G/agents/approval_agent.py:96-113`) gets only:
  - the risk score, as `state['risk_score'] or 0`, so a **null becomes 0**;
  - the key risks, taken from existing clauses;
  - a summary of the first 8,000 characters.
- On a contract that was never analysed there are no clauses and the score is
  null. So the input is "risk 0, no risks", and the rule "risk < 0.35 and no high
  risks" gives **approve**.
- On an analysed contract the score and the governing law still come from the
  last extraction, because edits don't re-score.
- **No absence check anywhere:**
  - the playbook review tells the model to "omit any clause that already
    matches", and only looks at clauses that exist;
  - `playbook_check` loops over the clauses that exist;
  - the review agent's `REQUIRED` set only triggers a second extraction attempt.
- **No diff against the previous version or the template.**

**Root cause:**
- the inputs are empty or stale, and "unknown" is treated as "safe";
- the recommendation is generated by an LLM rather than derived from findings;
- there is no model of required clauses.

**Expected behaviour.** Whenever either side changes the contract, review works
from:
- the **previous version** we relied on (the last one sent, approved or
  analysed);
- the **origin** (template or variant fingerprints);
- the **playbook**;
- the **current version**.

It produces **findings**: added, modified, deleted or moved clauses; missing
required clauses; prohibited clauses present; positions not met. The
recommendation is a **policy over the findings, never a free model opinion**.

**Detecting absence**
1. Each playbook clause gets a **presence rule**: `required`, `not_allowed` or
   `optional`, per contract type. Seed `required` for Governing Law,
   Confidentiality, Term and Limitation of Liability where it fits the type.
2. After extraction, compute for each required clause type: was it found in this
   version, at what confidence, and was it present in the previous version or the
   origin?
3. If it was present before and is gone now, the finding is **"Deleted since v4"**
   (from the diff, so certain).
4. If it was never found, the finding is **"Not detected — find it or confirm it's
   missing"**, the same model as Ironclad's. If the user tags the clause, the
   finding is resolved. If they confirm it is missing, an exception approval is
   needed.
5. A clause cut by more than X% (for example "half of Exclusions") is a
   **material modification** finding, even if what is left still reads fine.

**Recommendation policy**
The labels are derived, not chosen by an LLM.

| Recommendation | Allowed only when |
|---|---|
| **Ready to approve** | Analysis is complete **for this version**. No required clause is missing or deleted. No `not_allowed` clause is present. Every modified clause matches a pre-approved position, or has an approved exception. No unresolved high or critical findings. No unanalysed changes since the last analysis. |
| **Review** | Anything not covered by the other rows. This is the default. |
| **Needs exception** | A position needing approval is used, or a required clause is confirmed missing. Routes to the clause approver. |
| **Escalate / do not proceed** | A critical finding (for example unlimited liability, a walk-away position breached), or a `not_allowed` clause with no approver. |

**Hard guardrails** (code that never calls a model). The system **never** shows
"Ready to approve" when:
- analysis is missing, failed, or stale for the current version;
- a required clause is missing or deleted;
- a clause was deleted or cut by more than 30% since the last version a person
  relied on and nobody has reviewed it;
- the document has zero extracted clauses;
- the risk score is unknown (null means unknown, never 0);
- a counterparty version arrived after the last analysis.

The LLM may write the *explanation* of the findings, quoting clause text. It never
writes the label.

**Competitive insight** (verified)
- Ironclad shows "Not detected"; it becomes an issue only under the "required"
  presence rule.
- Exceptions need a named clause approver.
- Open clause approvals block the workflow from moving to the next stage [IC
  24948981301143, 24732157970327].
- Your screenshot shows "Not detected (2) — Find this clause or confirm that it's
  missing".

**Implementation**
- **Backend:**
  - a `review-findings` service (deterministic) that combines the clause diff,
    presence rules, the rules engine and the LLM position checks;
  - `recommendation = policy(findings)`;
  - the approval summary is generated after the findings and references them.
- **Data model:**
  - `PlaybookClause.presence`;
  - a `ReviewFinding` table: `contractId, versionId, kind, clauseType, severity,
    evidence, baselineVersionId, status, resolvedBy`.
- **AI/LLM:** only judges whether *modified or added* text meets a position, and
  returns a quote. It no longer produces approve/reject.
- **Workflow:** submitting for approval needs fresh analysis. If it is stale, it
  is re-run first.
- **Testing** (golden cases in the eval program):
  - delete Governing Law → "Deleted since vN" plus Escalate or Review;
  - cut Exclusions in half → material modification;
  - an unanalysed draft → never Ready;
  - a template draft left unchanged → Ready.
- **Acceptance:**
  - *Given* v5 with Governing Law deleted, *when* it is submitted, *then* the
    recommendation is not "Ready to approve" and the first finding is "Governing
    law — deleted since v4 (required)" with the deleted text shown.
  - *Given* null analysis, *then* the recommendation is "Can't recommend —
    analysis missing".

**Priority / effort / dependencies**
- **P0:** the guardrails and the null fix. Effort S.
- **P0:** presence rules and the deleted-clause finding. Effort M.
- **P1:** the full findings model. Effort L.
- Depends on Part 11 and Workstream A.

### Part 8: Playbook Redline vs Playbook Review

**Current behaviour**
- **Playbook review** (rail): the automatic LLM review after extraction, against
  the prose positions. Added 2026-07-20 (647e3e7) because redline analysis needed
  two versions. Its result was written but never shown until 2026-09-23.
- **Playbook redline** (rail): an on-demand rewrite. It runs the deterministic
  `playbook_check` rules, then an LLM rewrite of each failing clause, then staged
  proposals, then Apply to create a new version. Added 2026-08-07 (docs/35
  Phase 3).
- **Two engines judge the same `PlaybookPosition` rows**, with different severity
  words and different coverage rules, so they can disagree. docs/35 already says
  so.

**Lawyer's view.** These are one job: *find what isn't acceptable, then fix it*.
Splitting "see issues" from "fix issues" across two panels with two engines
creates contradictions.

**Recommendation.** One **Review** panel, fed by one findings engine (Part 7).
- Each finding offers actions in place:
  - **Insert standard language** (the preferred position);
  - **Redline to position…** (the AI drafts a fix, as tracked changes);
  - **Accept as is** (if allowed);
  - **Request exception**.
- The "redline all" action becomes "Fix all fixable issues (N)": a batch of the
  same per-finding fixes, previewed before applying.
- Delete both rail sections.

**Competitive insight** (verified)
- Ironclad offers one Playbook list per document, with Insert/Swap, Skip, Approve
  and Redline per clause, plus "Review suggested redlines for # clauses" → "Accept
  all changes" [IC 12275585451159, 13740722454935].
- Your screenshot shows the same.

**Implementation**
- **Frontend:** a `ReviewPanel` replaces two sections.
- **Backend:** one engine. The rules engine and the LLM position check become
  stages that write `ReviewFinding`s. Redline proposals attach to a finding.
- **Migration:** keep `_playbookRedline` readable for a release.
- **Acceptance:** *Given* any contract, *then* exactly one panel lists playbook
  issues, and no two surfaces show conflicting verdicts for the same clause.

**Priority / effort / dependencies:** P1 · L · depends on Part 7.

### Part 9: Choosing compliance frameworks

**Current behaviour**
- Four fixed frameworks: GDPR, HIPAA, SOX and CCPA (`G/routes/compliance.py:32`).
- The rail sends none, so all four are checked.
- One LLM call decides whether each applies, from the first 60,000 characters.
- It runs only when a person clicks.
- The result has no `versionId`.

**Expected behaviour.** Users shouldn't have to know which framework applies. The
product works it out from **facts**, explains why, and asks only when unsure.

**Recommendation**
- **Facts:** the AI extracts **facts**, each with a quote:
  - the data involved (personal data, health data, payment data, financial
    reporting);
  - the parties' locations and the data subjects' locations;
  - the processing role (controller or processor);
  - the industry;
  - cross-border transfer.
- **Org policy:** maps facts to frameworks. A default set is shipped, for example:
  - personal data with EU/UK subjects → GDPR / UK GDPR;
  - health data with a US covered entity → HIPAA;
  - personal data of California residents → CCPA/CPRA;
  - a public company affecting financial reporting → SOX.
- **Applicability is deterministic.** It comes from facts plus policy, shown as
  "GDPR applies because: 'Supplier will process Customer's employee personal
  data' (§4.2) and Customer is in Germany".
- **Unsure facts** (low confidence, or none found) produce "Does this agreement
  involve personal data? Yes / No / Not sure", asked once and stored on the
  contract.
- **Runs automatically** as part of analysis for the frameworks that apply. The
  results become findings in the same Review panel.
- **Org policy is set once by an admin.** A lawyer never picks frameworks by hand,
  though they can add one.

**Implementation**
- **Data model:** `ContractFact` (key, value, quote, confidence, confirmedBy) and
  `CompliancePolicy` (per org).
- **Backend:** a facts step in analysis; a policy evaluator; framework catalogues
  stay in Python.
- **Frontend:** a "Why this applies" view; the one-question prompt.
- **Acceptance:** *Given* an NDA with no personal data, *then* no framework runs
  and the panel says "No compliance frameworks apply (no personal or regulated
  data found)", with an override.

**Priority / effort / dependencies:** P2 · M · depends on Workstream A.

### Part 10: Defined terms

**Current behaviour**
- A regex runs in the browser (`W/components/editor/DefinedTermGuard.ts`). It
  matches **straight quotes only**, so it misses the curly quotes in DOCX files.
- Its only check is a capitalisation mismatch.
- Nothing is saved.
- The chat-only `contract_validate` tool checks blanks and dangling section
  references.

**What problem it should solve.** Drafting accuracy:
- a capitalised term used but never defined (ambiguity a court may read against
  the drafter);
- a term defined twice, or in conflicting ways;
- a term defined but never used (clutter, often a sign that a clause was deleted:
  "Exclusions" defined but its clause removed);
- a term used before it is defined;
- inconsistent capitalisation.

The people who use it are the drafting lawyer, and the reviewer of counterparty
paper.

**Does it deserve its own section?** No. A glossary is reference material. Its
*problems* are review findings.

**Recommendation**
- **Deterministic checks**, with curly-quote aware patterns, run as part of
  analysis on each version. They produce findings in the Review panel under
  "Drafting".
- **Hover in the editor:** hovering a defined term shows its definition, and
  clicking jumps to it.
- **Remove the separate Defined Terms rail.**
- **Ties to Part 7:** a defined term that is now unused after a deletion supports
  the "deleted since vN" finding.

**Implementation**
- **Backend:** a `defined-terms.ts` module (definitions, uses, conflicts), with
  findings written per version.
- **Frontend:** hover and jump; findings.
- **Testing:** a fixture with all five problems.
- **Acceptance:** *Given* a contract where "Exclusions" is defined but its clause
  was removed, *then* the Review panel shows "'Exclusions' is defined but not
  used" under Drafting.

**Priority / effort / dependencies:** P2 · S–M.

### Part 11: Clauses and obligations not extracted

**Current behaviour** (verified: `A/workers/agent.worker.ts:777-794` creates v1,
sets `analysisStatus: 'DONE'`, and queues nothing)

| Path | Extraction queued? |
|---|---|
| Upload, new version, portal, inbound email, binder, external edit | Yes |
| `/agent/draft` with a new title | Yes |
| `/agent/draft` adding a version to an existing contract | **No** |
| **Request → convert → draft worker** (this contract) | **No**; it is also marked DONE, and `currentVersionId` is not set |
| Assistant `contract_create_from_template` | **No** ("user will kick off analyse") |
| Editor saves | Carry only |

- **Obligations** are only extracted on a manual click or when signing completes,
  so "no obligations" on any unsigned draft is expected.
- **Other places it fails silently:**
  - chunking with 0 clauses ends as DONE with only a warning;
  - a failed review callback is only logged;
  - `run_review` returning None ends quietly;
  - classify skips a job with no text.
- **field-capture** (H3) fixes only the assistant path, not this one.

**Root cause.** Analysis is triggered by file parsing. Analysis status is a single
field that doesn't say *which version* was analysed, so "DONE" is written by code
that never analysed anything.

**Expected behaviour.**
- Every version a person relies on is analysed, however it was created.
- Status always tells the truth: *Not analysed · Queued · Analysing (step 3 of 5)
  · Done for v4 · Failed at step X · Retry*.

**Recommendation**
- **One trigger:** `onVersionCreated(version, reason)`.
  - Generated or uploaded versions get a full analysis.
  - Edit checkpoints get incremental analysis.
  - Every create path calls it.
- **Analysis runs are tracked:** an `AnalysisRun` row per version, with each step,
  its status, timings, model, error and counts (clauses, obligations, findings).
- **Zero clauses** on a document over N words is a **failure** ("No clauses found
  — the document may not be a contract or parsing failed"), not DONE.
- **Obligations** are extracted for drafts in "preview" mode (shown as
  *proposed*), and confirmed at signing. A lawyer can then see what their draft
  commits them to before signing it.
- **Observability:**
  - each step logs `{runId, contractId, versionId, step, ms, outcome}`;
  - an admin "Analysis health" page shows runs that are failed or stuck, grouped
    by step;
  - an alert when any create path finishes without a run.

**Implementation**
- **Backend:**
  - `handleDraftContract` sets `currentVersionId`, writes `_origin`, and calls the
    trigger;
  - the same for the assistant path and the add-version path;
  - the `AnalysisRun` model and worker wiring;
  - fix the swallowed callbacks (field-capture A1 already moved extraction into
    the queued job; build on it).
- **Migration/backfill:** find contracts with versions but no clauses and
  `analysisStatus=DONE`, and queue analysis for them, rate-limited and under the
  org's AI budget.
- **Testing:** an integration test per create path asserting that a run exists
  and clauses are more than 0 for the NDA fixture.
- **Acceptance:** *Given* a request converted with no attachment, *when* the draft
  is created, *then* within 3 minutes it has clauses, a playbook review and
  findings for v1, and the status says "Done for v1". *Given* an analysis step
  fails, *then* the contract says which step and offers Retry.

**Priority / effort / dependencies:** P0 · M · first in the plan, since everything
else depends on it. Merge field-capture first, since it rewrote the extraction job.

### Part 12: Approval history, Activity and Comments

**Current behaviour**
- There are six tabs: Overview, Clauses, Versions, Negotiate, Comments, Approval,
  Activity.
- The rail has seven sections: Key Terms, Risks, Clauses, History, Approval,
  Comments, Activity.
- **Duplication:**
  - Versions tab, History rail and Overview show the same versions;
  - the Activity tab and rail show the same events;
  - Comments has two queries, and the rail count shows "9+" for any 2 or more
    comments;
  - approval state appears in four places, all broken by the 404.
- **Missing from the history:** approval decisions, clause review decisions and
  redline-merge decisions are absent from Activity.

**Your hypothesis**
- *Read-only history lives in a side panel, and actions happen in context.*
- **I agree, with one change.** Comments aren't read-only. They are work, tied to
  text, so they belong **in the document margin** (as in Word or Ironclad), not
  in a tab.

**Recommended information architecture**
- **Main area = the document** (Part 16).
- **Right panel**, with three switchable views:
  - **Review:** findings and actions;
  - **Comments:** threads anchored to text, internal or external;
  - **Details:** key terms (editable), parties, dates, family, documents.
- **Status banner** at the top: stage, whose turn, the next action, and progress
  on approvals and signatures (Part 18).
- **"History" drawer:** one merged, filterable timeline:
  - versions with diff links;
  - approvals with reasons;
  - comments resolved;
  - signatures;
  - status changes;
  - AI actions applied or undone.
  Filters: All · Negotiation · Approvals · Signatures · System.
- **Removed:**
  - the Activity, Comments, Versions and Approval tabs;
  - the duplicate rail sections;
  - the Overview's version list.

**Competitive insight** (verified)
- Ironclad's April 2026 redesign moved turn tracking and stage progress into a
  banner.
- Documents, Properties and the Activity feed are grouped, and the activity feed
  is filterable [IC 39163761776791].
- The workflow transcript says the same.

**Implementation**
- **Backend:** a `GET /contracts/:id/history` that merges `audit_events` (widened
  to approval resources, as `dashboard.ts` already does), `signature_events` and
  versions.
- **Frontend:** the page restructure.
- **Data model:** none needed beyond Parts 4 and 18.
- **Acceptance:** *Given* any contract, *then* an approval decision, its reason, a
  counterparty upload and a signature each appear exactly once in History, and no
  tab duplicates another.

**Priority / effort / dependencies:** P1 · M · depends on Parts 4, 16 and 18.

### Part 13: Amendments, and "Split from binder"

**Current behaviour**
- **Create Amendment** (`POST /contracts/:id/amendments`) makes an empty DRAFT
  child with `parentContractId` and a free-text `relationshipType`. It has:
  - no numbering;
  - no copy of the parent's text;
  - no effective-terms roll-up (only the renewal notice deadline and the
    assistant's prompt read amendments).
- **The binder banner shows on every child.** `ContractDetailPage.tsx:2122` checks
  only `parentContractId`. The banner is meant only for children auto-split from a
  scanned bundle (`exhibit_only` plus the split marker). **This is a bug.**
- A "binder" is a single PDF holding several agreements, which an LLM detects and
  splits. That is useful at **upload**, but means nothing to someone drafting an
  amendment.

**Expected behaviour.** A lawyer thinks of a **contract family**:

> Master Agreement (effective 1 Jan 2024)
> ├─ Amendment No. 1 (effective 1 Jul 2024) — changes §5 Fees
> ├─ Amendment No. 2 (draft) — extends term
> └─ SOW #3
>
> Current effective terms: Fees as amended by A1 · Term as of the original ·
> Governing law original.

**Recommendation**
- **Fix the banner.** Show "Split from scanned bundle *X*" only for split
  children. For an amendment, show "Amendment No. 2 to *Master Agreement* ·
  View family".
- **Amendment numbering** is automatic per parent (counting executed and draft
  amendments of that type). It can be edited.
- **Create Amendment flow:**
  1. Choose what changes: pick parent clauses or key terms.
  2. Choose a template: the org's amendment template, or "Draft from changes".
  3. The AI drafts amendment language ("Section 5.1 is deleted and replaced with
     …") from the chosen clauses. The lawyer edits.
  4. Effective date.
- **An amendment-specific redline** shows the parent's current effective text
  against the proposed text, for review and approval.
- **Roll-up on execution.** When an amendment is executed, show a side-by-side of
  the key terms it changes. The lawyer confirms which values roll up to the
  parent's **effective terms**. Original values stay visible. Obligations from
  replaced clauses are marked *superseded*.
- **Effective view** on the parent: the original text with amended sections
  marked "Amended by A1 (§5)". This is a **consolidated reading view**, not a new
  legal document.
- **Approvals and signatures** run on the amendment as on any contract. The
  playbook applies to the amended text.
- **The family view** replaces "binder" language everywhere except the upload
  split.

**Competitive insight** (verified)
- Ironclad has Parent/Amendment relationships.
- Linking shows a side-by-side, and the user chooses which property values **roll
  up** to the parent. "Show Amended Values" shows the originals.
- Only properties roll up, not clauses [IC 12402562074775, 40823003051287].

We can go further, with clause-level effective text, because we hold the text and
the diff. But the **property roll-up is the MVP**.

**Implementation**
- **Data model:**
  - `relationshipType` becomes an enum;
  - `amendmentNumber`;
  - `ContractTermValue` (key, value, sourceContractId, effectiveFrom,
    supersededBy);
  - `Obligation.supersededById`.
- **Backend:** the amendment draft endpoint; a roll-up endpoint; effective terms
  read everywhere key terms are read (renewals, analytics, assistant).
- **Frontend:** family view; roll-up dialog; effective view.
- **Migration:** existing children have `relationshipType` normalised, and
  numbers assigned by date.
- **Acceptance:**
  - *Given* an amendment, *then* no "binder" text appears.
  - *Given* Amendment 1 executed that changes Fees, *when* the user confirms the
    roll-up, *then* the parent's key terms show the new fee with "Amended by A1",
    and the old value is one click away.

**Priority / effort / dependencies**
- **P1:** the banner fix. Effort S.
- **P2:** amendment workflow and roll-up. Effort L.
- Depends on Part 18.

### Part 14: Renewal

**Current behaviour**
- **"Create Renewal"** exists only as the Renewal type inside the Create Amendment
  dialog. It makes an empty draft.
- **Renewals page:** a 365-day list with notice deadlines that account for
  amendments.
- **Renewal decision:** stored, but it triggers nothing.
- **AI renewal advice:** exists.
- **Reminders:** a daily scan sends them, to the owner only.
- **Data:** notice days and auto-renew live only in AI-extracted `keyTerms`.
- **Status:** nothing ever sets EXPIRED.
- **Not available:** calendar export and escalation.

**Expected behaviour.** A lawyer can answer these straight away:
- What renews in the next 90 days?
- When is my last day to give notice?
- Do we renew, renegotiate or let it lapse?

They can then start the right action in one click.

**Recommendation**
- **Renewal fields become first-class:** `renewalType` (auto, manual, evergreen,
  none), `renewalTermMonths`, `noticeDays`, `noticeDeadline` (computed),
  `optOutWindowStart`, `priceUpliftCap`. They are extracted with evidence and
  confirmed by people (field-capture's trust model).
- **The decision drives the action:**

  | Decision | What happens |
  |---|---|
  | **Renew as is** | Auto-renewing: record it and do nothing, with a calendar note. Manual: generate a short renewal letter or amendment extending the term (from a template), then approval and signature. |
  | **Renegotiate** | Create a renewal draft from the **parent's effective text** (or the latest template). Opens a negotiation with the parent linked, and its playbook findings compared against the current terms. |
  | **Let it lapse / terminate** | Generate the non-renewal notice from a template. Track that it was sent before the deadline. Set the status to Expiring, then Expired or Terminated. |

- **Renewal vs amendment vs new contract:**
  - a **renewal** continues the same relationship for another term, as a child of
    type `renewal`;
  - an **amendment** changes terms within the term;
  - a **new contract** replaces the old one (the old one is marked *superseded*).
- **Reminders** go to the owner and watchers, and escalate to Legal Ops if no
  decision is made within N days of the deadline. Add an `.ics` feed per user.
- **Automatic statuses:** Active → Expiring (within the notice window) → Expired
  (after expiry with no renewal), or Auto-renewed (expiry moved forward by the
  renewal term, and logged).
- **Obligations:** renewal-linked obligations (such as the notice) appear in the
  obligations calendar.

**Competitive insight** (verified)
- Ironclad derives contract status from dates and renewal type (Active, Expiring,
  Auto-Renewing, Expired, Terminated, Superseded).
- It has a renewal dashboard, and "Start renewal workflow" pre-fills the parent
  record [IC 17438784927127, 40074088867863].

**Implementation**
- **Data model:** the columns above; a `RenewalDecision` row (decision, decidedBy,
  actionContractId).
- **Backend:** the decision-to-action endpoint; a daily status job; the `.ics`
  feed; escalation.
- **Frontend:** a "Start renewal" button on the contract and the Renewals page; a
  decision dialog.
- **Acceptance:** *Given* a manual-renewal contract 60 days before its notice
  deadline, *when* the owner chooses Renegotiate, *then* a draft linked to the
  parent opens with the parent's effective text and a playbook review comparing it
  with the current terms.

**Priority / effort / dependencies:** P2 · L · depends on Parts 13 and 18.

### Part 15: Redline vs Compare, and what "Missing" means

**Current behaviour.** Three views of the same diff:

| View | What it does |
|---|---|
| Negotiate tab "Version diff" | Deterministic diff |
| Negotiate tab RedlinePanel | LLM scores each change accept / counter / reject |
| Header "Compare" (CompareMode) | Same diff, plus accept or reject per change, apply as a new version, download as Word |

Each has its own version picker. Only Compare can apply changes. Only RedlinePanel
has AI. Your screenshot shows the Negotiate tab with two pickers and two panels
for one job.

**What "Missing" means in Ironclad** (verified)
- "Not detected" means a playbook clause found neither by exact position text nor
  by its AI clause model.
- It blocks only when the clause's presence rule is "required in documents and
  will need approval to be excluded". The user then tags the clause, or requests
  an exception.
- "Not accepted" corresponds to the presence rule "not accepted in documents and
  will need approval to be included" [IC 24948981301143].
- **Your screenshot's labels** ("Not detected", "Accepted · Uses custom language",
  "Find this clause or confirm that it's missing") show these states in the UI.
  Their exact wording is not in the help centre and may come from another version
  of the product.

**Expected behaviour.** One **review workspace** answers four questions, in this
order:
1. **What changed?** The diff against a baseline. The default baseline is the last
   version we sent or approved. It can be switched to the template or any version.
2. **What is risky?** Findings on the changed and non-standard text.
3. **What is missing?** Required clauses not detected, or deleted.
4. **What should I do?** An action on each finding, plus the derived
   recommendation.

**Recommendation**
- **Merge** Negotiate, Compare and RedlinePanel into the editor's **Changes**
  mode (Part 16). The diff is shown inline as tracked changes against the chosen
  baseline.
- Each change carries its finding (if any) and the actions **Accept change**,
  **Keep original**, **Counter…** (AI drafts a counter with a rationale) and
  **Comment**.
- Keep the Word download.
- AI scoring happens automatically when a counterparty version arrives. There is
  no "Analyzing redlines" button.

**Implementation**
- **Frontend:** remove CompareMode and the Negotiate tab, and add Changes mode.
- **Backend:** redline analysis becomes a findings stage keyed by
  `(versionId, baselineVersionId)`.
- **Acceptance:** *Given* a counterparty upload, *when* the lawyer opens the
  contract, *then* the banner says "Counterparty sent v5 — 12 changes, 3 need
  attention, 1 required clause missing". Opening it shows those, in place, with
  actions.

**Priority / effort / dependencies:** P1 · L · depends on Parts 7, 8 and 16.

### Part 16: A full-screen contract editor

**Current behaviour**
- The contract page uses `DocumentCanvas` (TipTap) with an inline edit toggle.
- **Every debounced save creates a new version** ("Edited in browser").
- **Missing:**
  - full-screen editing;
  - track changes inside the editor (an "Edit in Google Docs" round trip produces
    them in Word);
  - attribution below the version level;
  - internal vs external comments (there is no flag; external comments are those
    whose author is `portal:`);
  - a comment action in the selection menu (it has bold, italic, underline, H2,
    and "Ask AI" with rewrite chips);
  - exception requests;
  - a stored "whose turn" (it is worked out in the browser).
- **"Sync on"** only means the collaboration websocket is connected. Live
  co-editing is not wired up.

**The lawyer's workflow, designed as one place**

1. **Open the contract.** It opens in a full-screen workspace. The banner shows
   "*Your turn* · Review · Counterparty sent v5 2h ago · 3 issues need attention
   · Approvals 0/2", with one primary button: **Review changes**.
2. **Understand the status.** The banner progress shows Create → Review → Approve
   → Sign → Active. Click it for the history drawer.
3. **Review issues.** The right panel's Review list is grouped as Needs attention,
   Not detected, Standard/accepted. Clicking an issue scrolls to the clause and
   highlights it.
4. **Inspect the clause.** The issue card shows our position (preferred and
   fallbacks), what the text says, what changed since the baseline, and the
   evidence.
5. **Edit.** Editing happens in **suggestion mode** (tracked, attributed to the
   user) once negotiation has started, or direct mode for a first draft.
   Selecting text opens: *Comment · Ask AI · Tag clause · Make variable · Request
   exception*.
6. **AI assist.** Free-text instruction, then several drafts (paged), then *Insert
   as tracked change*. The rationale is shown. Every AI insertion is logged.
7. **Comment.** In the margin. Choose Internal (default) or External. A
   "Suggested note to counterparty" can be taken from the playbook position (as
   in your Ironclad screenshot).
8. **Request an exception.** From a finding: choose the approver (defaulting to
   the clause approver), give a reason, and the finding becomes "Exception
   requested". It shows in the approver's "Needs my action".
9. **Compare.** The Changes mode toggle inside the editor, with a baseline picker.
10. **Send.** **Save as version**, with a note. Options: *Send to counterparty*
    (the turn changes, share link or email, with a Word file with tracked changes
    or a PDF) and *Reset approvals* (following the reset rules, visible to people
    allowed to change it).
11. **Counterparty review.** The banner says "Counterparty's turn · sent 2d ago".
    Their upload or email reply creates v6, the turn comes back, analysis runs
    automatically (Part 11), and the banner announces it.
12. **Approve.** When the findings allow it, the banner offers *Submit for
    approval*. The approvers see the same workspace, read-only, with Approve or
    Return.
13. **Sign.** *Send for signature* is enabled only when approved (or when the
    policy allows). Signing progress shows in the banner.

**Key architecture decision: working copy vs version.** Stop creating a version on
every keystroke save.
- **Typing autosaves to a working copy**, the Y.Doc or a draft row.
- **A version is created** on "Save as version", on send, on submit, or on
  leaving the editor with changes.
- **Why:**
  - analysis, approval reset rules and the history all become meaningful;
  - the change counts behind "12 accepted" become reliable;
  - the cost of re-analysis is bounded.

**Competitive insight** (verified)
- Ironclad Editor: track changes with accept and reject; the Save comment logged
  in Activity; the publish dialog with "Change turn to [Counterparty]" and "Allow
  approvals to reset".
- Internal and external comment threads.
- Draft Redlines with paged suggestions, and Summarize.
- "Merge updates" for concurrent edits.
- Tag clause.
- [IC 12274871100055, 12275523838743, 36111289361943, 13740722454935]

**Not verified:** a "full-screen" mode as such.

**Implementation**
- **Frontend:**
  - a workspace route `/contracts/:id/edit`;
  - TipTap suggestion-mode marks (insert and delete with author and time). There
    are open-source TipTap track-changes extensions; evaluate them against our
    collaboration plans;
  - margin comments;
  - the selection menu;
  - the save-as-version dialog.
- **Backend:**
  - working-copy storage;
  - the version-creation rules;
  - `ContractComment.visibility` (internal or external) with the portal filtering
    on it;
  - an `ExceptionRequest` model tied to a finding;
  - a stored turn (Part 18).
- **Data model:** the above, plus suggestion marks stored in the version HTML so
  that the Word export carries them as `w:ins` / `w:del` (`revision-author.ts`
  exists).
- **Testing:** the end-to-end workflow above, scripted as a QA case in docs/40
  style.
- **Acceptance:**
  - *Given* a negotiation, *when* the user types, *then* their insertions show as
    tracked and attributed, and no new version exists until they save.
  - *Given* Save with "Send to counterparty", *then* the turn changes and the
    banner says so.

**As built (C4, suggestion mode)**
- Our own small TipTap extension (`components/editor/TrackChanges.ts`); no
  maintained free one was available. Marks `insertion`/`deletion` stored as
  `<ins|del data-change-id data-author-id data-author data-time>`. On by itself
  at stage negotiate; a "Suggesting" toggle otherwise. Not tracked: formatting,
  paragraph splits and joins, tables.
- **Decision: analysis reads the document as if every pending suggestion were
  accepted** (`apps/api/src/lib/suggestions.ts`): the version's plain text,
  Changes mode and the text written into their Word paper. The banner and
  Changes mode show how many are pending; Keep original and Counter wait until
  they are decided (they rewrite the document from that reading).
- Word: pending suggestions export as w:ins/w:del with each one's author and
  time. A returned .docx's tracked changes come back as suggestions with
  Word's authors where mammoth's paragraph text matches Word's exactly;
  otherwise accepted, as before (known limit). Into their own paper
  ("download for counterparty" on their Word file) the suggestions go as
  tracked changes by the person downloading, not each author (known limit).

**Priority / effort / dependencies**
- **P1:** workspace, banner, panel, and working copy. Effort L.
- **P1:** suggestion mode. Effort XL; can come later in the phase.
- Depends on Parts 7, 8, 12, 15 and 18.

### Part 17: Salesforce integration

**Current behaviour.** There is **no Salesforce integration**. There is a
`Counterparty.crmId`, a "Salesforce sync" placeholder on the admin page, and a
`crm_trigger` request source mentioned only in a comment. We do have the pieces it
needs:
- a public API with scoped `clm_live_` keys;
- signed webhooks with retries (15 events);
- inbound email;
- self-hosted e-signature.

**Goal.** Sales starts and tracks contracting without leaving Salesforce. Legal
works in draftLegal.

**What Ironclad does** (verified [IC 12285720910103, 12285599508119,
12285645617047, 12285884117911, 12285717702167, 25029020049175, 12285776829591])
- **Three parts:**
  - **Workflow Launch** pulls Salesforce data into the launch form;
  - **Workflow Sync** shows status on an *Ironclad Workflow* custom object (needs
    the AppExchange managed package);
  - **Record Sync** pushes archived metadata and the signed PDF to an *Ironclad
    Contract* object and can update the Opportunity.
- **Auth:** OAuth through a Salesforce service account plus individual users. A
  token is stored in Salesforce. Data moves server to server; only ids pass
  through the browser.
- **Lightning web components:**
  - Next Steps (approve, revert to review, pause or cancel);
  - Messages (chat synced both ways with the activity feed);
  - Documents.
  They are **embedded Ironclad UI or calls into it**, and Ironclad must be on
  Trusted URLs.
- **Field mapping:** typed, per field, "from Salesforce" or "both ways".
- **Refresh from source:** re-pulls the data, but not once the contract is in
  Sign.
- **CPQ:** a record-triggered Flow syncs on approval of the primary quote, and
  line items fill dynamic tables. The transcript says updating the quote
  "creates a version two" and can add Legal as an approver.

**Recommended Salesforce experience**

| Entry point | What the rep does | Native or embedded |
|---|---|---|
| **Opportunity** (main), **Quote** (CPQ orgs) | "New contract": choose type (NDA, MSA, Order Form). The form is pre-filled from mapped fields, some locked. Optional pre-approved options (special terms). Submit creates a draftLegal **request**, or generates directly for self-serve types such as an NDA on standard paper. | **Native LWC** form, built from the type's field map fetched from our API. It keeps the Salesforce look and avoids iframe login problems. |
| **Account** | Related list of contracts: status, stage, whose turn, renewal date, value | **Native** (a related list on our custom object) |
| **Contract record** (custom object `draftLegal Contract`) | Stage path; "Waiting on: Legal (Priya) · 2d"; approvals x/y; key terms; obligations summary; signed PDF; **Open in draftLegal** | Native fields plus a native LWC for status. **Embedded (iframe)** only for the document preview and the comment thread, where rebuilding our UI would duplicate it. |
| **Messages** | @mention Legal; messages appear in draftLegal History as "From Salesforce" | LWC that calls our API (comments with `source: salesforce`) |
| **Renewals** | Upcoming renewals on the Account and Opportunity; "Start renewal" | Native |

**Iframe or native?** Ironclad mostly embeds. We should use **native LWCs for
status, forms and lists**, and embed only the document viewer. Reasons:
- an iframe needs Trusted URLs, third-party cookie or session handling, and a
  second login, which Safari and Chrome's cookie policies make fragile;
- native components respect Salesforce field-level security and page layouts;
- the document viewer is the only piece too heavy to rebuild. It can use a
  short-lived signed URL (`/embed/contracts/:id?token=…`, scoped and expiring),
  so no draftLegal session is needed.

**Source of truth and sync direction**

| Data | Source of truth | Direction | Conflicts |
|---|---|---|---|
| Account | Salesforce | SF → DL (as Counterparty; `crmId`) | Salesforce wins. DL edits to the counterparty name aren't pushed. |
| Opportunity (amount, close date, products) | Salesforce | SF → DL until the contract enters Sign. After that, frozen in DL. | A Salesforce change after Sign raises "Salesforce changed: amount 40k → 45k — update contract?" in DL. It never rewrites silently. |
| Quote / line items (CPQ) | Salesforce | SF → DL on primary-quote approval. Creates a new version if the draft is unedited, otherwise raises a reconcile task. | As above |
| Counterparty legal entity / signer | DL (once Legal confirms) | DL → SF on execution | — |
| Contract value (executed) | DL | DL → SF (contract object, optionally the Opportunity amount by mapping) | — |
| Dates (effective, expiry, notice deadline) | DL | DL → SF | — |
| Status / stage / turn | DL | DL → SF (near real time) | — |
| Signed document | DL | DL → SF Files, on execution | — |
| Key terms, obligations | DL | DL → SF (summary fields; obligations as a related list, read-only) | — |

The rule: **Salesforce owns the commercial deal up to signing. draftLegal owns the
contract.** The direction is set per field, as in Ironclad. Conflicts become tasks,
never silent overwrites.

**Technical plan**
- **Packaging:** a **second-generation managed package** containing the custom
  objects `DL_Contract__c` (lookups to Account, Opportunity and Quote) and
  `DL_Request__c`, the LWCs, permission sets, a Named Credential and External
  Credential, and a remote site / CSP entry. It needs AppExchange security review
  for listing (allow 6–10 weeks).
- **Auth:**
  - org-level: an **OAuth 2.0 Connected App** (or the newer External Client App),
    web-server flow with a refresh token, issued by a Salesforce integration user
    and stored encrypted per draftLegal org;
  - Salesforce → draftLegal: a **Named Credential** using a per-org draftLegal API
    key (our scoped `clm_live_` keys; add a `salesforce` scope);
  - end-user actions pass the Salesforce user's email or federation id and map it
    to a draftLegal user. Unmapped users act as "requester (via Salesforce)",
    with limited permissions.
- **Mapping:** a `CrmFieldMapping` table per org and contract type: SF object.field
  ↔ DL field or template variable, with type, direction and locked flag. An admin
  UI picks fields through the Salesforce describe API. Field-capture's field
  registry (`packages/types` fields) is the DL side of the map.
- **Events:**
  - DL → SF: our existing **webhook** events feed a small **sync worker** that
    calls the Salesforce REST/Composite API (upsert by external id
    `DL_Contract_Id__c`). Batch changes; respect API limits; back off on 429 or
    `REQUEST_LIMIT_EXCEEDED`.
  - SF → DL: a **record-triggered Flow** or Apex calls our API on create/update
    of mapped records (Opportunity stage, primary quote approved). Optionally
    subscribe to **Change Data Capture** through the Pub/Sub API for high-volume
    orgs.
- **Background sync:** a nightly reconcile job compares the
  `DL_Contract__c` rows with ours and fixes any drift.
- **Retries and audit:** every sync attempt is a row (`IntegrationSyncLog`:
  direction, object, id, payload hash, status, error, attempt). Retries follow
  the webhook worker's policy. The admin "Integration health" page already exists
  and gains a Salesforce section. Contract History shows "Synced to Salesforce"
  events.
- **Security / tenant isolation:**
  - tokens are encrypted per org;
  - every inbound call is checked against the org of the API key and the
    Salesforce org id stored at connect time (rejected on mismatch);
  - one Salesforce org connects to one draftLegal org (several Salesforce orgs per
    draftLegal org allowed later, as Ironclad does);
  - the existing row-level security (`clm_tenant_access`) applies to all sync
    reads.
  - least privilege: the integration user's permission set covers only our
    objects and the mapped fields.

**Phases**
1. **S1, status visibility (M):** Connected App auth; the `DL_Contract__c` object;
   DL → SF status, stage, turn, dates, value and signed PDF; a native status LWC;
   "Open in draftLegal". No launch yet. This gets value with the least risk.
2. **S2, launch from Opportunity (L):** the field map; a native launch LWC; SF → DL
   request creation; an NDA self-serve generate path.
3. **S3, CPQ and messages (L):** quote and line-item sync with reconcile; messages
   synced both ways; the embedded document viewer.
4. **S4, AppExchange listing (M, mostly elapsed time):** security review,
   packaging hardening.

**Acceptance (S1):** *Given* a connected org, *when* a contract linked to
Opportunity X changes stage in draftLegal, *then* within 60 seconds the Salesforce
contract record shows the new stage and turn, and a failed sync appears in
Integration health with a retry button.

**Priority / effort / dependencies:** P2 overall (Phase 3). Depends on Part 18
(stage and turn must exist to sync) and the field registry (field-capture A3).

### Part 18: The contract lifecycle

**Current behaviour**
- **Contract statuses:** 10, plus REJECTED, which is never written.
- **Manual transition table** (`A/lib/contract-status.ts`).
- **Dead ends:** there is no way out of PENDING_SIGNATURE or TERMINATED.
- **No gate before signing:** signing can be sent from any status except EXECUTED.
- **Lost history:** there is no status history table; changes are scattered
  across audit events.
- **Turn:** worked out in the browser only.
- **Approval:** a reject goes to DRAFT; an approval pending during edits is not
  reset.

**Recommended model.** Separate the **stage** (where the contract is) from the
**state within the stage** (what is happening), and from the **turn** (who must
act).

| Stage | States | Turn | Leaves by |
|---|---|---|---|
| **Request** | submitted · in triage · more info needed · declined | requester / legal | accepted → Draft |
| **Draft** | drafting · ready | internal | send, or submit for approval |
| **Negotiate** | with us · with counterparty | internal / counterparty (stored) | agreed text → Approve |
| **Approve** | pending (n of m) · returned · approved | approvers | approved → Sign; returned → Negotiate or Draft |
| **Sign** | out for signature (x of y) · declined · voided | signers | all signed → Active; voided or declined → Approve or Negotiate (revert) |
| **Active** | active · expiring · auto-renewed | owner | expiry, termination, supersession |
| **Closed** | expired · terminated · superseded · cancelled | — | — |

Cancelled can happen from any stage before Active. It is reversible only by an
admin, with a reason.

**Transitions**
- **Automatic:**
  - a counterparty upload sets the Negotiate turn to "with us";
  - the last approval moves to Sign-ready;
  - the last signature moves to Active;
  - date-based moves to Expiring and Expired;
  - an amendment's execution updates effective terms (not the stage).
- **Manual:** any other move is an explicit action with a permission check
  (`edit:contract`, or `approve:workflow` for decisions), and the reason is
  required when going backwards.

**Can a contract move backwards? Yes, as a "revert", which never deletes
anything.**
- **Sign → Approve or Negotiate:** voids the open signature request (signed
  copies are kept as history). Approvals reset according to their reset rules.
  If none would reset, the owner becomes the approver, as Ironclad does.
- **Approve → Negotiate:** this is "Return" (Part 4).
- **Active → Negotiate:** **not allowed.** Changes after execution happen through
  an amendment.
- **Every transition writes a `ContractStageEvent`** (from, to, by, reason, at, and
  the version id), from which analytics compute stage durations.

**Approval reset rules** (per workflow step, as Ironclad's are configurable):
- reset when the text of covered clauses changes;
- reset when any document changes;
- reset when the listed fields change;
- never reset.

Clause exception approvals reset only when that clause's text changes.

**UI.** The banner progress bar `Request → Draft → Negotiate → Approve → Sign →
Active`, with the current state and turn shown in words: "Negotiate · Counterparty's
turn · 2 days". Clicking it opens the stage history.

**Competitive insight** (verified)
- Ironclad's steps are Create, Review, Sign and Archive, plus Paused and
  Cancelled.
- "Cancel all signatures and return to review" resets approvers.
- There are configurable approval reset triggers.
- Turn tracking is stored, with turn counts and time per side.
- [IC 12274796145303, 40675997675031, 12286331403543]

**Implementation**
- **Data model:**
  - `Contract.stage`, `Contract.stageState`, `Contract.turn`, `turnSince`;
  - a `ContractStageEvent` table;
  - migrate `status` to the new stages (a one-to-one mapping table; keep `status`
    as a derived column for a release).
- **Backend:**
  - one `transition(contract, to, actor, reason)` service. All routes, workers and
    agent tools use it;
  - signature start checks for Approved (or a policy exemption);
  - void or decline offers the revert.
- **Frontend:** the banner, the stage history, and revert dialogs.
- **Testing:** a property test that every allowed transition is reachable and no
  state is a dead end; a guard test that signing needs approval.
- **Acceptance:**
  - *Given* a voided envelope, *then* the user can revert to Approve or Negotiate
    with a reason, and the history shows both the void and the revert.
  - *Given* any contract, *then* the banner names the stage, the state and whose
    turn it is.

**Priority / effort / dependencies**
- **P0:** the signature gate and a way out of PENDING_SIGNATURE. Effort S.
- **P1:** the stage model and turn. Effort L.

### Part 19: Analytics, organised by decision

**Current behaviour**
- An Analytics page with totals, distributions, monthly volume, top counterparties
  and a cycle-time figure.
- Cycle time is measured as `updatedAt − createdAt`, which is wrong after any edit.
  There is no `executedAt`.
- The data exists for approval time, version turns and clause ratings, but nothing
  computes them.
- The outcome of AI suggestions is mostly not logged: the bubble Replace or
  Dismiss and the editor assist results are not recorded at all.
- Contracts don't store their template, so template usage can't be linked to
  outcomes.

**Prerequisites.** These are captured in Phase 0 and 1 even though the dashboards
come later: `ContractStageEvent`, the stored turn, `executedAt`, `_origin`,
`ReviewFinding` resolution, and `AiSuggestionEvent` (shown, accepted, edited,
dismissed).

| Metric | User | Decision it enables | Calculation | Data | Priority |
|---|---|---|---|---|---|
| Cycle time (request → executed), median and p90 | GC, Legal Ops | Where to invest: self-serve, templates, headcount | executed − request created, by type and paper source | stage events, `executedAt` | MVP |
| Time in stage / bottleneck | Legal Ops | Which stage to fix | Σ durations per stage | stage events | MVP |
| Needs my action, aging | Lawyer, manager | Who is overloaded; what is stuck | open action items by age | inbox | MVP |
| Approval time per approver / step | Legal Ops | Re-route approvals, change thresholds | decidedAt − active-since | approval steps | MVP |
| Counterparty turnaround and turns | Lawyer, Sales | Chase or escalate; forecast signature date | turn durations, count | stored turn | MVP |
| Upcoming renewals and missed notice deadlines | Legal, Finance, Procurement | Decide in time; avoid unwanted auto-renewals | deadlines in window; decisions made in time | renewal fields | MVP |
| Most-negotiated clauses / deviation rate by clause | GC, playbook owner | Change templates or positions that always get pushed back | findings by clause type, resolved as counter or exception | ReviewFinding | Next |
| Exceptions granted (by clause, approver, value) | GC | Tighten or loosen the playbook | exception requests by outcome | ExceptionRequest | Next |
| Template usage → cycle time and turns | Legal Ops | Retire or fix templates | join `_origin` | origin | Next |
| Playbook adherence at signature | GC, risk | Measure risk accepted | % executed contracts with all required clauses at preferred or fallback | findings at execution | Next |
| AI acceptance by feature | Product, Legal Ops | Trust and ROI; tune prompts | accepted ÷ shown; edits after accept | AiSuggestionEvent | Next |
| AI accuracy (extraction corrections) | Product | Model quality | corrections ÷ values (field-capture records the source) | field audit | Next |
| Contract value by stage / counterparty | Finance, Sales | Revenue at risk in legal | Σ value | value | Later |
| Obligations due / missed | Ops owners | Compliance with commitments | obligations by status | obligations | Later |
| Adoption (active users, self-serve share) | Admin | Rollout and training | events per user | telemetry (move it from logs into a table) | Later |

**Priority / effort / dependencies:** P2 · M for the MVP dashboards. Depends on
the data captured in Parts 11, 16 and 18. Capture starts in Phase 0/1.

### Part 20: Integration strategy

**Inventory.** "Have" describes draftLegal today. "Mentioned" means it appears in
the Ironclad transcripts or help centre.

| Integration | User | Job to be done | In | Out | Trigger | Auth | DL objects | Value | Complexity | Priority |
|---|---|---|---|---|---|---|---|---|---|---|
| **Salesforce** (mentioned; we don't have it) | Sales, RevOps | Start and track contracts from the deal | Opportunity, Quote, Account | status, terms, signed PDF | record events, our webhooks | OAuth Connected App + API key | Request, Contract, Counterparty | Very high for sell-side | L–XL | **P1 of Phase 3** |
| E-signature, DocuSign or Adobe (mentioned; we have our own) | Legal, counterparty | Sign on the counterparty's preferred tool | signed PDF, events | packet | send for signature | OAuth | SignatureRequest | High for enterprise buyers who mandate DocuSign | M | Next |
| Email inbound (we have it) | Legal | Capture counterparty replies as versions | attachments | — | email | per-org secret | Version | High, already built | — | Harden: SPF/DKIM (FIX known gap) |
| Microsoft Word add-in (mentioned) | Lawyers | Edit in Word without losing tracking or links | versions | versions, variables | save | OAuth / Office SSO | Version | High: lawyers live in Word | L | Next |
| Google Docs / Drive (hand-off only today) | Lawyers | Edit in Docs | — | — | manual | — | Version | Medium | M | Later |
| Slack / Teams (we have them) | Everyone | Notifications, approve from chat | decisions | alerts | events | signing secret / webhook | Approval | Medium | S | Add reason prompts to Slack Reject |
| SSO / SCIM: Okta, Entra (stub today) | IT | Security review and provisioning | users, groups | — | IdP | SAML/OIDC, SCIM | User, Role | **Blocks enterprise deals** | M | **Phase 1–2** |
| Storage: Box, OneDrive, Drive (mentioned) | Legal Ops | Signed copies in the company system of record | — | signed PDFs | execution | OAuth | Contract | Medium | M | Later |
| Coupa, Ariba (mentioned) | Procurement | Contract from a requisition; block the PO until signature | requisition, supplier | status, terms | approval threshold | OAuth | Request | High for buy-side customers | L | Later (by demand) |
| NetSuite / ERP (we have in-app invoices) | Finance | Invoice ↔ obligation reconciliation | invoices | terms, obligations | sync | OAuth M2M | Invoice, Obligation | Medium–high (the Databricks demo story) | L | Later |
| OneTrust (mentioned) | Privacy | Vendor risk before approval | assessment status | vendor | approval gate | API | Approval | Medium | M | Later |
| Zapier / Make (mentioned) | Ops | Long-tail automations | triggers | actions | our webhooks + API | API key | All | Medium, cheap since webhooks and API exist | S | Next |
| Snowflake / BI export (mentioned) | Data team | Join contract data with business data | — | tables | schedule | key pair | All | Medium | M | Later |
| HubSpot (partner only at Ironclad) | Sales (SMB) | Same as Salesforce | deals | status | events | OAuth | as SF | Medium | M | After SF, reusing its sync layer |

**The roadmap rule.** Rank by stage of the lifecycle and by what blocks a sale, not
by what competitors list.
1. **SSO/SCIM:** a security and procurement blocker.
2. **Salesforce S1–S2:** where sell-side requests start.
3. **Zapier:** cheap, because we have the webhooks and API.
4. **DocuSign:** enterprise buyers who require it.
5. **Word add-in:** where lawyers draft.
6. Procurement, ERP and storage, by customer demand.

Build a common **integration layer** once, used by all of these:
- connections with encrypted tokens;
- field mappings;
- sync logs;
- retries;
- health checks.

---

## 3. Target experience

| Stage | What the user sees | What they do | What the system does |
|---|---|---|---|
| **Request** | A short form (or Salesforce, Slack, email), with type suggested and terms pre-filled from text, and "1 choice needed: governing law" when rules can't decide | Submit | Classifies, extracts terms with quotes, routes to Legal or self-serve |
| **Draft** | The full-screen workspace opens on the draft. Banner: "Draft · your turn". Review panel: "All clauses standard (from NDA template v3)" or the few findings | Fill the remaining choices, edit, add internal comments | Deterministic template, variants and fingerprints; analysis of v1; `_origin` recorded |
| **Review / Negotiate** | Banner: "Counterparty sent v5 · 12 changes · 3 need attention · Governing law deleted". Changes mode shows tracked changes against v4, each with its finding | Accept, keep, counter (AI drafts), comment (internal or external), request exception, tag missing clause | Analyses every version; findings keyed by (version, baseline); turn stored |
| **Approve** | Approver's "Needs my action" → the same workspace, read-only. Derived recommendation with the findings behind it | Approve, or Return with a reason | Guardrails; versioned approval; reset rules; reason sent to the owner and recorded in History |
| **Sign** | Banner: "Sign · 1 of 2 signed" | Send, remind, void → revert | Gate on Approved; signing; seal |
| **Manage** | Active contract: effective terms, obligations (confirmed), renewal card with notice deadline | Confirm terms, assign obligations | Reminders, status by date, sync to Salesforce |
| **Amend / Renew / Terminate** | Family view; "Start renewal" with three choices | Pick an action | Draft from effective text; roll-up on execution; notices |

---

## 4. Target architecture

```
                 ┌───────────────── create paths (upload · template · request · assistant · portal · email · Salesforce) ─────────────────┐
                 ▼
        ContractVersion (immutable; working copy separate) ──► onVersionCreated(version, reason)
                 │                                                      │
                 │                                                      ▼
                 │                                     AnalysisRun (per version, steps, status, errors)
                 │      ┌──────────────────────────────────────────────┼──────────────────────────────────────────────┐
                 │      ▼ deterministic                                 ▼ LLM (bounded, cites quotes)                  ▼ deterministic
                 │  parse → structure → clause spans          clause typing for unmatched spans ·             defined-terms checks ·
                 │  origin fingerprint match (_origin)        position match for modified/added text ·        clause diff vs baseline ·
                 │  presence rules (required/not allowed)     facts for compliance · obligations (proposed) · presence / deletion ·
                 │                                            explanations                                    rules engine (bounds, must_have)
                 │      └───────────────────────────────┬──────────────────────────────────────────────────────┘
                 │                                      ▼
                 │                     ReviewFinding (versionId, baselineVersionId, kind, severity, evidence, status)
                 │                                      ▼
                 │                     Recommendation = policy(findings)  ← hard guardrails (no LLM)
                 ▼                                      ▼
   Stage machine (stage · state · turn) ◄── transitions ── Approval (versioned, reset rules, clause exceptions)
                 │                                      │
                 ▼                                      ▼
   ContractStageEvent / audit_events (hash-chained) ──► History drawer · Analytics · Webhooks ──► Integration layer (SF, Zapier, DocuSign…)
```

**Deterministic vs LLM**

| Must be deterministic | LLM is appropriate (with quotes and confidence, never final on its own) |
|---|---|
| Template and variant selection, variable defaults | Pulling values out of free-text requests |
| Whether text matches the template, library or a position (fingerprints, exact match) | Classifying clause types of non-standard text |
| Version diff; added, deleted, modified; materiality thresholds | Whether modified text meets a playbook position, and why |
| Presence rules (missing, prohibited) | Drafting counters, redlines and amendment language |
| Rules engine (numeric bounds, must-have phrases) | Summaries and explanations of findings |
| Recommendation label and guardrails | Facts for compliance (data types, roles), confirmed when uncertain |
| Stage transitions, approval resets, turn | Proposed obligations |
| Compliance applicability from facts and policy | Renewal advice text |
| Defined-terms checks | — |

---

## 5. Workstreams and phases

### Workstreams

**A. Contract intelligence reliability** (Parts 2, 5, 7, 11, plus the base for 8, 9
and 10)
- **Problem:** analysis is not per version; there is no baseline; verdicts lack
  grounding; failures are silent.
- **Scope:**
  - the single trigger `onVersionCreated`;
  - `AnalysisRun`;
  - truthful statuses;
  - every create path wired up;
  - origin fingerprints;
  - presence rules;
  - clause diff findings;
  - `ReviewFinding`;
  - the recommendation policy and guardrails;
  - version stamps on all analysis;
  - the backfill;
  - observability.
- **Order:**
  1. Trigger plus statuses, and wire the request and assistant paths. Merge
     field-capture first.
  2. Guardrails (null ≠ 0, stale analysis, zero clauses).
  3. Presence rules plus deletion findings.
  4. Fingerprints.
  5. The findings table and policy.
  6. Incremental re-analysis on checkpoints.
- **Done when:** the Part 7 and Part 11 acceptance tests pass; every contract
  shows "Done for vN" or a truthful failure; the eval program has golden cases for
  deletion, junk, template-unchanged and never-analysed contracts.
- **Complexity:** L.

**B. Drafting determinism** (Part 1)
- **Scope:**
  - remove the prompt defaults;
  - pass request terms through;
  - one drafting planner;
  - a default template per type;
  - clause slots and variants with conditions;
  - template version snapshots;
  - `_origin`;
  - template lint.
- **Order:** remove defaults and pass terms → `_origin` → the default template
  flag → slots and variants → snapshots → lint.
- **Complexity:** L.

**C. Review and redlining workspace** (Parts 8, 10, 15, 16)
- **Scope:**
  - the full-screen workspace;
  - one Review panel;
  - Changes mode (merging Negotiate, Compare and RedlinePanel);
  - working copy vs version;
  - margin comments with internal/external;
  - the selection menu;
  - exception requests;
  - defined-terms findings and hover;
  - suggestion mode.
- **Order:** working copy → workspace shell and banner → Review panel on findings
  → Changes mode → comments → exceptions → suggestion mode.
- **Complexity:** XL.

**D. Approval and workflow** (Parts 4, 6, 12, 18)
- **Scope:**
  - fix the approval lookup 404;
  - Return with a reason;
  - error states;
  - one set of cache keys;
  - versioned approvals;
  - reset rules;
  - pooled role approvals;
  - the inbox;
  - the stage, state and turn model;
  - `ContractStageEvent`;
  - the signature gate and revert;
  - the History drawer.
- **Complexity:** L.

**E. Lifecycle** (Parts 13, 14)
- **Scope:** the banner fix; family view; amendment numbering and drafting; roll-up
  to effective terms; first-class renewal fields; decision → action; automatic
  statuses; `.ics`; escalation.
- **Complexity:** L.

**F. Ecosystem** (Parts 9, 17, 19, 20)
- **Scope:** compliance facts and policy; analytics; the integration layer;
  Salesforce S1–S4; SSO/SCIM; Zapier; DocuSign.
- **Complexity:** XL.

### Phases (revised after the critique in §6)

**Phase 0: Trust bugs that can produce a wrong legal answer** (about 2–3 weeks)
1. Every create path queues analysis, sets `currentVersionId`, and stops writing
   DONE without analysing. Add the "Not analysed / failed at step" states.
   Backfill existing drafts. *(A)*
2. Recommendation guardrails: null ≠ 0, stale or missing analysis, zero clauses,
   and recent deletions all block "Approve". The label becomes "Can't recommend —
   …" in those cases. *(A)*
3. Presence rules for a small seeded set of required clauses per type, and a
   "Deleted since vN" finding from the clause carry (`dropped`). *(A)*
4. Remove "default to Delaware". Pass the classifier's terms through. If governing
   law isn't known, show an unresolved choice. *(B)*
5. Hide the "market" margin classifier. Remove "market" wording from the redline
   analysis when no playbook applies; say "Not covered by your playbook". *(A)*
6. Approval visibility: a contract-scoped approval route; the reason in the
   banner, the notification and Activity; error states on decision buttons; cache
   keys. *(D)*
7. A global error toast for API failures; the Playbook redline gated on analysis;
   no false "No clause deviated". *(A/D)*
8. A signing gate (approval required unless a policy exemption applies), and a
   revert out of PENDING_SIGNATURE after a void or decline. *(D)*
9. Fix the binder banner condition. *(E, S)*
10. **Start capturing data:** `executedAt`, and stage events written from the
    existing status changes. *(F prerequisite)*

**Phase 1: A coherent core workflow for lawyers** (about 8–12 weeks)
- **A:** fingerprints; the `ReviewFinding` table and policy; incremental
  re-analysis on checkpoints.
- **B:** `_origin`; default template per type; clause slots and variants; template
  lint.
- **C:** working copy vs version; the workspace with banner and Review panel;
  Changes mode; margin comments (internal/external); exception requests.
  Suggestion mode at the end of the phase, or early in Phase 2.
- **D:** the stage, state and turn model; versioned approvals with reset rules;
  pooled role steps; the inbox; the History drawer.
- **F:** SSO/SCIM. This was moved forward because it blocks enterprise pilots.

**Phase 2: Lifecycle** (about 6–8 weeks)
- **E:** family view, amendment drafting and roll-up; renewal fields, decision →
  action, automatic statuses, reminders and escalation, `.ics`.
- **A/C:** defined-terms findings; obligations proposed on drafts.
- **F:** compliance facts and policy.

**Phase 3: Ecosystem** (ongoing)
- Salesforce S1 → S4.
- MVP analytics dashboards (the data has been collected since Phase 0).
- Zapier.
- DocuSign.
- Word add-in.
- Procurement and ERP by demand.

---

## 6. Critique of this plan, and what changed because of it

1. **Am I fixing symptoms?** The first draft listed six analysis bugs. They are now
   one workstream (A) built on a single trigger and a per-version record of runs,
   so the "Approve" problem is fixed by the policy rather than by prompt tweaks.
   The MARKET badge is *hidden*, not re-prompted.
2. **Am I copying Ironclad?**
   - **Borrowed on purpose:** presence rules, a stored turn, approval reset rules,
     property roll-up.
   - **Deliberately different:**
     - an explicit **Return with reason** (Ironclad has no reject);
     - **native** Salesforce LWCs instead of mainly iframes;
     - clause-level **effective text** later (Ironclad rolls up only properties);
     - **deterministic recommendations** (Ironclad's AI is advisory too, but we
       state the guardrails in the product).
   - **Not borrowed:** Ironclad's separate Clause Library vs Playbook. Theirs are
     "not currently connected". Ours should be one model, with positions and
     library variants being the same entries. That avoids the template-vs-playbook
     contradiction found in Part 2.
3. **Did I add duplicate concepts?**
   - One near-duplicate is `ExceptionRequest` vs clause-level approval steps.
     **Revised:** an exception is an `ApprovalStep` of kind `clause_exception`
     linked to a finding. There is one approval engine, not two.
   - `ContractStageEvent` vs `audit_events`. **Revised:** stage events are audit
     events of type `STAGE_CHANGED` with a typed payload, plus an index. This
     avoids a second log.
4. **Can screens be removed?** Yes, and the plan removes them:
   - six contract tabs collapse into the workspace;
   - two playbook rail sections become one panel;
   - three diff surfaces become one mode;
   - the Defined Terms rail goes;
   - four approval displays become one banner and one panel;
   - the Approvals page tabs become one inbox.
   The net change in surfaces is negative.
5. **Are AI recommendations guarded enough?** The hard guardrails are code, and
   are tested in the eval program. One gap was found and **added**: a counterparty
   version arriving *after* submission must withdraw "Ready" and notify the
   approvers. That is part of the reset rules.
6. **Can deleted or missing clauses be detected reliably?**
   - **Deleted:** yes, because of the version diff plus the clause carry
     (`dropped`), which needs no LLM.
   - **Never present:** only as reliably as clause detection. So the honest state
     is "Not detected — find it or confirm it's missing", not "Missing". It can be
     resolved by tagging the clause (field-capture E1 already supports tagging a
     clause from a highlight).
   - **Risk:** a badly split document produces false "not detected" findings.
     **Mitigation:** a "Not detected" finding never blocks on its own; it routes
     to Review.
7. **Is the document version the source of truth?** It is only if versions stay
   meaningful. **This forced a change in order.** Today every debounced save makes
   a version. If re-analysis is triggered per version without first adding the
   working copy, we would analyse every keystroke burst (cost, and the local
   Postgres already struggles under AI load). **Revised:** Phase 0 re-analysis
   runs only on *generated or uploaded* versions plus a 2-minute idle checkpoint.
   The real working copy lands at the **start** of Phase 1, before incremental
   re-analysis.
8. **Is every AI conclusion traceable to evidence?** Findings carry quotes and
   version ids. Explanations come only from findings. Compliance applicability
   comes from facts with quotes. Not yet covered: the assistant chat's free-text
   claims (outside this plan; the eval program covers groundedness).
9. **Would a lawyer know the next action without training?** The banner always
   names one primary action. The risk is jargon. Never show "binder", "carry",
   "MARKET" or "playbook redline" in the UI.
10. **Does the Salesforce integration keep a clear source of truth?** Yes: field
    ownership plus the freeze at Sign. Conflicts become tasks. The remaining risk
    is CPQ quote edits after the lawyer has edited the draft. **Rule:** we never
    regenerate an edited draft; we raise a reconcile task.
11. **Is the order realistic?**
    - Salesforce needs stage and turn (Phase 1), so it can't come earlier.
    - Analytics needs data collected from Phase 0, so that capture was added to
      Phase 0 (item 10).
    - The Review panel needs `ReviewFinding`, so A comes before C.
    - **field-capture** (docs/39, uncommitted) rewrote extraction, added
      `_template`, and supports tagging clauses. It must be **merged first**, or
      A will conflict with it. That is now a Phase 0 prerequisite.
    - Workstream A's guardrails (P0) don't need the findings table, because they
      use the existing clause carry results.
12. **What could break?**
    - **Backfilled analysis** of old drafts costs AI budget and can overload
      local and prod Postgres. Rate-limit it per org, under `costCap`.
    - **Approvals in flight** when the versioned-approval migration lands: attach
      them to the current version; don't reset them.
    - **Removing the Delaware default** means drafts with an unresolved choice;
      demos that relied on a filled draft (GSK, CBRE) need a default set in their
      seed orgs.
    - **Moving from `status` to `stage`:** keep `status` as a derived column for a
      release, because webhooks (`contract.*` events), analytics and the API
      clients read it.
    - **Hiding the MARKET badge** removes a demo moment; replace it with the
      playbook-relative badge in Phase 1.
    - **Pooled role approvals** change who sees what. Announce it to admins.

---

## 7. Summary table

| Problem | Root cause | Proposed change | Priority | Effort | Dependency | Phase |
|---|---|---|---|---|---|---|
| Template drafts have no clauses or obligations; "Fetch playbook" fails | Analysis tied to file parsing; draft worker sets DONE, no `currentVersionId` | `onVersionCreated` trigger on every path; `AnalysisRun`; truthful status; backfill | P0 | M | Merge field-capture | 0 |
| AI says Approve after deletions | LLM label; null risk → 0; no absence or diff check | Guardrails in code; presence rules; deletion findings; `policy(findings)` | P0 | S → L | Above | 0 → 1 |
| Delaware chosen silently | Prompt default plus seed default; request terms dropped; no variant logic | Remove defaults; pass terms; unresolved-choice state; later slots, variants, `_origin` | P0 / P1 | S / L | Analysis trigger | 0 / 1 |
| Template text called weak; junk still "market" | Context-free paragraph classifier; "market" undefined; no re-analysis | Hide badge; define labels; fingerprints; incremental re-analysis on checkpoints | P0 / P1 | S / M–L | A, working copy | 0 / 1 |
| Reject shows only a merge note | Approval lookup 404; reason not shown; "reject" overloaded | Contract approval route; Return with reason everywhere; renames; error states | P0 / P1 | S / M | — | 0 / 1 |
| Queue counts disagree | Steps vs instances; wrong cache keys; first-holder role assignment | "Needs my action" inbox by contract; shared counts; pooled roles | P1 | M | Stage and turn | 1 |
| Two playbook panels | Two engines added at different times | One findings engine; one Review panel with actions | P1 | L | `ReviewFinding` | 1 |
| Redline vs Compare vs diff | Three surfaces for one job | Changes mode in the workspace; automatic scoring on counterparty versions | P1 | L | Workspace, findings | 1 |
| Editor gaps (turn, exceptions, comments, tracking) | Version per save; no visibility flag; turn not stored | Working copy; workspace; margin comments internal/external; exceptions as approval steps; suggestion mode | P1 | L–XL | D, findings | 1 (–2) |
| Lifecycle unclear, dead ends | Status enum without stages, turn or history; no signature gate | Stage, state, turn; transition service; revert; signature gate | P0 (gate) / P1 | S / L | — | 0 / 1 |
| History, Activity, Comments sprawl | Duplicated tabs; narrow audit query | One History drawer; comments in the margin; banner | P1 | M | D | 1 |
| "Split from binder" on an amendment | Banner condition ignores the relationship type | Fix the condition; family view; amendment numbering, drafting, roll-up | P1 / P2 | S / L | Stage model | 0 / 2 |
| No real renewal | Decision triggers nothing; renewal fields only in AI terms | Renewal fields; decision → action; automatic statuses; reminders and `.ics` | P2 | L | Amendments | 2 |
| Defined Terms of unclear value | Browser regex only, straight quotes, case check only | Deterministic checks as review findings; hover; remove the rail | P2 | S–M | A | 2 |
| Compliance needs the user to know frameworks | One LLM call; fixed four; runs only on click | Facts with quotes + org policy → applicability; automatic; one-question confirm | P2 | M | A | 2 |
| No Salesforce | Not built | Phased: S1 status sync → S2 launch → S3 CPQ and messages → S4 AppExchange; native LWC plus embedded viewer | P2 | L–XL | Stage, turn, field registry | 3 |
| Analytics untrustworthy | No `executedAt` or stage events; AI outcomes not logged | Capture from Phase 0; decision-based MVP dashboards | P2 | M | Stage events | 0 (capture) / 3 |
| Integrations unprioritised | — | Common integration layer; SSO/SCIM → Salesforce → Zapier → DocuSign → Word | P1 (SSO) / P2 | M–XL | — | 1 / 3 |

---

## Open questions (answers would change the plan)

1. **Where did "Aligned with Market" appear?** On a badge popover, in the
   Negotiate panel, or in chat? (A screenshot settles it.)
2. **Which button did you press for "Fetch Playbook", and what text did the
   failure show?** The code has no element with that label.
3. **For the queue counts:** was the 4 the "All approvals" tab badge? Were all
   three numbers seen at the same moment?
4. **Default governing law:** should each org choose its own default per template
   (as recommended), or should drafting always ask when the request doesn't say?
5. **Salesforce first customer:** sell-side with CPQ, or without? That decides
   whether S3 (CPQ) moves before S2.
