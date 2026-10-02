# 44 — QA test plan: review trust, lawyer workflow and lifecycle

This is the test plan for the work on branch `feat/review-trust`, which implements
`docs/41-REVIEW-TRUST-AND-LIFECYCLE-PLAN.md`. It covers what that plan changed: drafting decided by rules instead of a
model, an analysis that runs on every version and says which one it describes, one Review panel with findings a lawyer
can trust, compliance frameworks and defined terms, approvals of one version with return and decline, the stage, state
and turn of every contract, the inbox, the full-screen contract workspace with Changes mode, comments and suggestions,
amendments and the contract family, renewals as decisions, analytics by decision, and the Salesforce, single sign-on,
SCIM and REST hook integrations. It assumes no prior knowledge of the product.

It has **75 journeys**. 26 of them call a real AI model (some for one step only).

**How it relates to docs/40**

`docs/40-QA-END-TO-END.md` is the test plan for the whole product. This plan reuses its §0 setup unchanged: the
local stack, the accounts (admin-a, counsel-a, legalops-a, contracts-a, rep-a, approver-a, viewer-a, finance-a,
procurement-a, admin-b), `$API` / `$WEB` / `$AGENTS`, the tokens `$ADMIN_A`, `$COUNSEL_A` and so on, the sample
documents and the bug report template. This plan's §0 lists only what this branch adds on top. Where a journey here
and one in docs/40 describe the same screen differently, this plan is current: each section's introduction names the
docs/40 journeys it supersedes.

**How it is organised**

- **§0 Extra setup**: this branch's migrations, seeds, backfill scripts, environment variables and org settings.
- **§1 The twenty reported problems**: each problem the user reported, what must happen now, and the journeys that
  prove it.
- **§2–§6 are journeys**, grouped by what a customer does:
  2. Drafting, analysis and review (E2E-DRF, E2E-PIPE, E2E-REV, E2E-CMP)
  3. Approvals, stages and the inbox (E2E-LIF, E2E-APR, E2E-INB)
  4. The contract workspace: editing, changes, comments and AI (E2E-WSP, E2E-CHG, E2E-CMT, E2E-SUG)
  5. After signature: amendments, renewals and analytics (E2E-AMD, E2E-RNW, E2E-ANA)
  6. Integrations: Salesforce, single sign-on, SCIM and REST hooks (E2E-SF, E2E-SSO, E2E-HOOK)
- **Each journey** (`E2E-<AREA>-NN`) has, as in docs/40:
  - a **Covers** line naming the pages, routes, jobs and tools it tests
  - the roles it uses, what it needs and how long it takes
  - preconditions
  - numbered steps, each with its expected result
  - **Also check** items for permissions, the other organization and edge cases
  - **Known limits**, which are not bugs
- **§7 Automated suites**: the commands, and the totals they give on this branch.
- **§8 Coverage** maps every page, API route, job, agents service endpoint and data model this branch touches to the
  journeys that test it.
- **Appendix A** is the checklist before this branch goes to production. **Appendix B** is the bug report template.
  **Appendix C** records the browser run of 2 October 2026: its scenarios, the bugs it found and their fixes.

**How to run it**

- Run docs/40 §0, then this plan's §0, once.
- Run §7 first. If an automated suite fails, stop and report: manual testing on a red build wastes time.
- Then run §2 to §6 in order, because later sections use data earlier ones create. Within a section, run the journeys
  in the order written. Each section starts with its own setup: paste its helpers into the shell you test from. A
  helper of the same name from an earlier section is replaced; that is intended.
- A full pass takes about three working days (the journeys add up to about 25 hours). A regression pass, running
  only the journeys whose Covers line names something that changed, takes a few hours. §1 is the short list for a
  check that the reported problems stay fixed.
- Journeys marked **Needs: agents service + model key** call a real AI model. Each costs a few cents, and the model's
  wording varies from run to run: judge those steps by the facts they must contain, not the exact words.
- Expected texts in quotes are the product's own strings, copied from the code. A different word is a finding.

**Related documents**

- `docs/41-REVIEW-TRUST-AND-LIFECYCLE-PLAN.md`: the plan this branch implements. Each section says which Parts it
  tests. Where the code differs from docs/41, the journey follows the code and says so under Known limits.
- `docs/42-ZAPIER-REST-HOOKS.md`, `docs/43-SSO-AND-SCIM.md`, `docs/47-STAGE-STATE-TURN.md` and
  `integrations/salesforce/README.md`: the designs §3 and §6 test.
- `docs/40-QA-END-TO-END.md`: the whole-product plan, whose §0 this plan builds on.

---

## 0. Extra setup

Do docs/40 §0 first (0.1 to 0.10). Everything below is in addition to it.

### 0.1 Migrations

This branch adds 36 migrations (Appendix A lists them with their purpose). On the local stack:

```bash
cd apps/api
pnpm exec prisma migrate deploy          # applies the branch's migrations to the database in DATABASE_URL
pnpm exec prisma migrate status          # must say "Database schema is up to date!"
```

Never pass `clm_dev` or `clm_test` as `--shadow-database-url` to `prisma migrate diff`: it wipes that database. For a
drift check, create a throwaway database (`docker exec clm_postgres createdb -U clm clm_shadow_tmp`), use it, and drop
it afterwards.

Some migrations carry data across for organizations that existed before them, so an org seeded before this branch
keeps working without a re-seed:

- every finished analysis gets the version stamp it lacked (`analysis_stamp`), so old contracts don't all turn
  "Not analysed";
- the small seeded set of required clauses (`clause_presence`): Confidentiality for NDAs; Limitation of Liability for
  MSA, VENDOR_AGREEMENT and LICENSE; Term & Termination and Dispute Resolution for the stand-alone types;
- every org's positions move under one **Default playbook**, the default for every type (`playbooks`);
- renewal decisions kept in contract metadata move to their own table (`renewal_decisions_from_metadata`);
- unresolved portal comments keep their typed author name (`portal_comment_author_name`).

### 0.2 What a fresh seed now holds

`pnpm dev:setup` (docs/40 §0.2) seeds Org A from the org seed, which this branch extends. A workspace created at
`$WEB/register` (Org B) gets the same. Check them before §2:

- **Clause families** (Clauses → **Families**): **Governing Law** (Delaware, New York, England and Wales; no default,
  so a draft that names no law asks), **Confidentiality Term**, **Liability Cap** and **Payment Terms**, each made of
  the org's own library clauses.
- **One default template per type** for NDA, MSA, SOW and Termination, each published with a snapshot drafts pin.
  Their governing-law section is a clause slot over the Governing Law family. The Mutual Non-Disclosure Agreement,
  One-Way Non-Disclosure Agreement (Inbound) and Mutual Idea Submission Agreement have a **Term and Termination** section (the agreement runs until either party gives thirty days'
  written notice), and the section that says how long confidentiality lasts is called **Period of Confidentiality**
  (9c0f2fc). An org seeded before that commit keeps its old NDA templates; see E2E-DRF-04 Known limits.
- **Renewal letter** and **Notice of non-renewal** templates (types `RENEWAL_LETTER` and `NON_RENEWAL_NOTICE`), which a
  renewal decision drafts from (E2E-RNW-02, -04). An org seeded before them gets the seed's own words, so the decision
  still drafts.
- **Default playbook**, the default for all contract types, holding the seeded positions (E2E-REV-15).
- **Presence rules** on clause categories: Term & Termination and Dispute Resolution required for the stand-alone types
  (NDA, MSA, VENDOR_AGREEMENT, LICENSE, PARTNERSHIP, SLA, EMPLOYMENT, DATA_PROCESSING), Confidentiality for NDA,
  Limitation of Liability for MSA, VENDOR_AGREEMENT and LICENSE (E2E-REV-16). They are shown, and can be changed, on
  **Playbook** → a category → **Rules for this clause**.
- **Compliance rules** (Admin → Organization → **Compliance**): when each of GDPR, UK GDPR, HIPAA, CCPA / CPRA, SOX and
  PCI DSS applies (E2E-CMP-11).

```bash
curl -s "$API/clauses/categories" -H "Authorization: Bearer $COUNSEL_A" \
  | jq '[.. | objects | select(.presence? == "required") | {name, presenceContractTypes}]'
curl -s "$API/playbook/playbooks" -H "Authorization: Bearer $COUNSEL_A" | jq -c '.data[] | {name, version}'
```

The first prints the four required categories above. The second prints "Default playbook".

### 0.3 Backfill scripts, and when to run them

The migrations carry over what a fresh seed needs, except the items below. The first three scripts print what they
would do and change nothing until `--apply`; the others write at once. All are safe to run twice. Run them from
`apps/api`, with the repo's `.env`:

| Script | What it does | When to run it |
|---|---|---|
| `npx tsx --env-file=../../.env scripts/backfill-clause-families.ts --org=$ORG_A --apply` | Makes the seeded clause families from the org's own library clauses, turns each untouched seeded template's governing-law section into a clause slot, renames each seeded NDA's "Term" section to "Period of Confidentiality" (5 years where it is still the seed's 3) and adds its "Term and Termination" section, adds a default template for NDA, MSA, SOW and Termination where there is none, and publishes every template again so drafts pin a snapshot. | Once per organization seeded **before** this branch (the local Org A if your database predates it; every customer org in production). §2's setup checks for it: `$GL` is empty without it. |
| `npx tsx --env-file=../../.env scripts/backfill-unanalysed.ts --org=$ORG_A --per-org=20` (add `--apply` to queue) | Finds contracts marked analysed that never were (a draft made from a request, a draft added as a version, a blank contract) and queues their analysis through the one analysis trigger. At most `--per-org` per org per run; an org whose AI budget for the day is used up is skipped and found again next run. | After the migrations, once, then again until it finds nothing. **Each contract queued is a paid model run**: never with `--apply` on the hosted demo or production without the owner's go-ahead. E2E-PIPE-04 tests it. |
| `npx tsx --env-file=../../.env scripts/set-template-org-default.ts --org=<orgId> --key=governingLaw --value=Delaware --apply` | Marks a template variable's default as the org's own, so drafts fill it instead of asking. | Only for a demo org whose drafts must come out filled (the GSK and CBRE demos). **Do not run it on Org A** before §2: E2E-DRF-04 needs the question asked. |
| `npx tsx --env-file=../../.env scripts/backfill-renewal-terms.ts [orgId]` | Works out the renewal columns (type, term, notice days, notice deadline, opt-out window, uplift cap, confirmed) for contracts whose values were set before the columns existed. Writes directly; idempotent. | Once after the migrations, before §5. E2E-RNW-01 step 9 tests it. |
| `scripts/backfill-field-values.ts`, `scripts/link-counterparties.ts` | The field store and counterparty links of the docs/39 field-capture work this branch contains. | Once after the migrations, as docs/39 says. |

Order: migrations → `backfill-field-values` → `link-counterparties` → `backfill-renewal-terms` →
`backfill-clause-families` → `backfill-unanalysed` (last, because it spends AI budget) → `set-template-org-default`
for demo orgs only.

### 0.4 Environment variables

Set these in the repo's root `.env` and restart the API (and the web app for `VITE_…`):

| Variable | Default | What it does | Used by |
|---|---|---|---|
| `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` | unset | The Salesforce connected app's consumer key and secret. Unset, Admin → Integrations → **Salesforce** says the server has no Salesforce app yet, and Connect answers `503`. | E2E-SF-01 to -05 |
| `API_PUBLIC_URL` | `FRONTEND_URL`, else `http://localhost:5173` | The public address of the API. The Salesforce callback, the SSO callback, the SCIM base URL and the calendar feed link are built from it. Set it to an ngrok URL to test with a real Salesforce org or identity provider. | E2E-SF-01, E2E-SSO-01, E2E-RNW-06 |
| `SSO_REDIRECT_URI` | `<API_PUBLIC_URL>/api/v1/auth/sso/callback` | The OIDC callback, when it must differ from the default. | E2E-SSO-01 |
| `ANALYSIS_CHECKPOINT_MS` | `120000` (2 minutes) | How long an edited contract is left alone before its analysis runs again. `0` turns checkpoints off: a saved edit then only asks for a fresh playbook review. | E2E-PIPE-02, E2E-CHG-02, E2E-SUG-02 |
| `VITE_MARGIN_CLASSIFIER` | unset (off) | `on` shows the editor's old margin badges (MARKET / WEAK / AGGRESSIVE). They are hidden because they judged text without the org's playbook (reported problems 2 and 5). Leave it unset. | E2E-REV-10, E2E-REV-12 |

docs/40 §8's `WEBHOOK_ALLOW_PRIVATE_URLS=true` is also needed for E2E-HOOK-01.

### 0.5 Organization settings

Both are in Org A's settings, changed with `PATCH /organization` by an admin (`configure:integration`):

- **`allowSignWithoutApproval`** (default off). Off, a contract is sent for signature only once it is approved on the
  version being signed. It has a screen: Admin → Organization → **Approval before signing**, box **Require approval
  before a contract is sent for signature**. E2E-LIF-04 turns it off and back on.
- **`renewalEscalationDays`** (default 14). How many days before an undecided renewal's notice deadline Legal Ops is
  told. No screen; set it by API. A value outside 0–365 falls back to 14. E2E-RNW-05 changes it and puts it back.

```bash
curl -s $API/organization -H "Authorization: Bearer $ADMIN_A" | jq '.settings | {allowSignWithoutApproval, renewalEscalationDays}'
```

Both print `null` (the defaults) on a fresh seed.

---

## 1. The twenty reported problems

These are the problems the user reported, in their words, and what the product must do now. Each row names the
journeys that prove the fix; the first one listed is the regression journey, which says what was wrong before. Run
these journeys as a short check that the problems stay fixed.

| # | What was reported | What must happen now | Journeys that prove it |
|---|---|---|---|
| 1 | Delaware chosen silently for an NDA drafted from a request. | Drafting is decided by rules, not a model. A request that names no governing law gets no law: the request page says "Choice needed", the draft leaves "[[Choose governing law: …]]" and an amber chip "1 choice needed", and it can't be shared or sent for signature until a person picks one; while it is open the recommendation is **Review**, never "Ready to approve". "No law", "not specified" or "TBD" in a request is no choice, and our side of the draft is always our org. A request that names New York gets the New York clause, with the request's words quoted. | E2E-DRF-04, E2E-DRF-05, E2E-DRF-06, E2E-DRF-01 |
| 2 | An untouched Purpose clause called weak. | A clause still as our template wrote it is "Standard", and only a clause whose words changed is judged again. The ungrounded margin badges are gone. | E2E-REV-13 |
| 3 | "Fetch playbook" failing with a generic error. | The Review panel names the playbook the contract is reviewed against, chosen by rule per contract type; it never fails with a generic error, and a contract type no playbook covers says so, with **Set one up**. | E2E-REV-15 |
| 4 | Reject showing only "Redline merge: N accepted…". | An approver returns a contract for changes, with a reason, or declines it. The owner sees the return, its reason and who returned it in the banner, the bell, the inbox and History; nothing is written as a version note. | E2E-APR-01, E2E-APR-02, E2E-APR-08 |
| 5 | Junk text still "Aligned with Market". | Words typed into a clause that don't read as language are a high-severity finding, "Doesn't read as text", and no label says "Aligned with market" anywhere. | E2E-REV-12, E2E-REV-10 |
| 6 | Queue counts 2 vs 4 vs 4. | The inbox is counted by contract, once each. The sidebar badge, the page's sentence, the tab and `GET /inbox/count` always give the same number, and they change together after a decision. | E2E-INB-01, E2E-INB-02 |
| 7 | AI says Approve after Governing Law was deleted and Exclusions halved. | A deleted required clause or a material cut makes the recommendation **Escalate** or **Review**, never "Ready to approve", whatever the model says; the reasons name the deletion and the cut (a deleted clause that was still a blank says "<clause> — was not filled in"). | E2E-REV-11, E2E-APR-04 |
| 8 | Two playbook panels. | One Review panel, on the contract page and in the workspace: the recommendation and why, which playbook, each finding with its evidence and what you can do about it. | E2E-REV-10, E2E-REV-15, E2E-REV-14 |
| 9 | Choosing compliance frameworks. | Which frameworks apply is worked out from facts quoted from the contract, by rules an admin sets once; when a fact is unsure, the contract asks one question. Gaps are review findings. | E2E-CMP-10, E2E-CMP-11 |
| 10 | Defined terms. | Defined-term problems (used but not defined, defined twice, defined and never used, used before being defined, capitalised differently) are review findings under Drafting, and hovering a term shows its definition. | E2E-CMP-12 |
| 11 | No clauses or obligations on a contract drafted from a request. | Saving a draft starts its analysis like any other version: its clauses, findings and analysis run are there, the page says "Analysed · v1", and its obligations are listed as "Proposed — confirmed at signing" until it is signed. A failed analysis says at which step and why, in words, with **Retry**. | E2E-PIPE-01, E2E-PIPE-02, E2E-PIPE-04 |
| 12 | Tabs for Approval history, Activity and Comments. | One **History** drawer, filterable, replaces the Activity, Versions and Approval tabs. Comments sit beside their words in the margin and follow them into later versions. | E2E-LIF-05, E2E-CMT-02, E2E-CMT-01 |
| 13 | "Split from binder" on an amendment. | The band says what a child is: "Amendment No. 1 to <agreement>", "SOW #1 under …", "Linked to …", with **View family**. Only a part the binder split cut out of a scanned file says "Split from scanned file". | E2E-AMD-05, E2E-AMD-01 |
| 14 | Renewal. | Renewal is a decision with an action: renew, renegotiate (a renewal draft), let it lapse or end it (a notice of non-renewal). Renewal terms are columns; reminders reach watchers and are worded by how the contract renews; undecided renewals escalate; a calendar feed carries the deadlines; the date job moves contracts by their dates, and an automatic renewal moves the expiry on. | E2E-RNW-08, E2E-RNW-01 to E2E-RNW-07 |
| 15 | Redline vs Compare. | One Changes mode in the workspace, against a baseline you pick, with the Word redline. Compare, the rail, the menu and History's **Compare with vN** all open it; each change can be accepted, kept, countered (as a tracked suggestion) or commented on. | E2E-CHG-01, E2E-CHG-02, E2E-CHG-03 |
| 16 | Editor. | A full-screen workspace. Typing autosaves to draft changes, not to a version; **Save as version** needs a note and can send to the counterparty; two editors can't overwrite each other unawares; suggestion mode tracks each edit by its author. | E2E-WSP-01 to E2E-WSP-06, E2E-SUG-02 |
| 17 | Salesforce. | An admin connects one Salesforce org per workspace by OAuth with PKCE (another org only after disconnecting); each contract's stage and turn reach its Salesforce record; Salesforce raises requests through its own key; a deal change after signing waits for the owner, who sees it on the contract with **Apply** and **Dismiss**. | E2E-SF-01 to E2E-SF-05 |
| 18 | Lifecycle. | Every contract has a stage, a state and a turn, shown in one status banner with the one next action. Backward moves need a reason, forbidden moves are refused with the rule, and a declined approval can't go to signature or be marked signed. | E2E-LIF-01 to E2E-LIF-04, E2E-APR-02 |
| 19 | Analytics. | The page answers decisions in seven sections under one filter bar, each bar opens its contracts, each section downloads as CSV, and cycle time runs from the request to signature. The AI section shows how often suggestions are taken. | E2E-ANA-01, E2E-ANA-02, E2E-ANA-03 |
| 20 | Integrations. | Single sign-on by email domain (OIDC), SCIM 2.0 provisioning, REST hooks for Zapier and Make with signed stage and turn events, and the Salesforce connector. | E2E-SSO-01, E2E-SSO-02, E2E-HOOK-01, E2E-SF-01 |

---

## 2. Drafting, analysis and review

This section tests docs/41 Part 1 (deterministic drafting), Part 11 (analysis on every version), Parts 2, 3, 5, 7 and 8
(findings and the one Review panel) and Parts 9 and 10 (compliance applicability and defined terms).

What changed, in one paragraph each:

- **Drafting is decided by rules, not a model.** A clause library item can belong to a **clause family** (for example
  Governing Law) as one approved **option**, with an optional **rule** ("Use it when Contract value is more than
  250000") and at most one **default**. A template section can be a **clause slot** over a family. Publishing a
  template saves a numbered **snapshot** with the options pinned, and lints it against the playbook. Each contract type
  has at most one **default template**. A draft resolves each slot in a fixed order: a person's choice, the value the
  request names (with its words quoted), the first rule that holds, the default. If nothing decides it, the draft keeps
  a blank, the contract says "1 choice needed" and it can't be shared or sent for signature until someone chooses in
  the **Origin** panel. The request path and the assistant's planner use the same code (`lib/draft-plan.ts`).
- **Every version is analysed, and says so.** Every place a version is made calls one trigger
  (`lib/analysis-trigger.ts onVersionCreated`). Each analysis is an **AnalysisRun** with steps. A saved edit is
  re-analysed two minutes later (a checkpoint), from the version analysed before when most of the text is unchanged.
  A long document with no clauses fails instead of ending "done". Admins see failed and stuck runs on
  **Admin → Analysis health**.
- **One Review panel, fed by findings.** Each analysed version gets **review findings**: deleted, cut, changed or added
  clauses (against the version relied on), required clauses not detected, clauses not allowed, text that doesn't read
  as words, playbook positions not met, defined-term problems and compliance gaps. The **recommendation** (Ready to
  approve, Review, Needs exception, Escalate, Can't recommend) is worked out from the findings by fixed rules, never by
  a model. Text still exactly as the template wrote it is **Standard** and is not sent to a model. Each contract is
  reviewed against one named **playbook**, chosen by rule. The margin badges (MARKET / WEAK) are off.
- **Compliance works itself out.** The model reads **facts** with quotes (personal data, where the people are, health
  data…). The org's **compliance rules** (Admin → Organization → Compliance) turn facts into frameworks. When a fact
  is unsure, the contract asks one question.

Codes: **E2E-DRF** (drafting), **E2E-PIPE** (the analysis pipeline), **E2E-REV** (findings and review), **E2E-CMP**
(compliance and defined terms). docs/40 already has E2E-REV-01…06 and E2E-CMP-01…03, so the REV and CMP journeys here
are numbered from 10. (docs/40's E2E-ANL means analytics, hence PIPE here.) Run them in the order written: E2E-DRF-04
makes the contract E2E-PIPE-01 reads, E2E-PIPE-02 makes the contract E2E-REV-12 edits, and E2E-REV-10 uploads the NDA
that E2E-REV-11 edits.

Where this section and docs/40 differ, this section is current. In particular:
- docs/40 E2E-REV-02 ("the rail lists the findings in document order") describes the old **Playbook review** rail. It is
  gone; E2E-REV-10 describes the Review panel that replaces it.
- docs/40 E2E-DRAFT-05 says the assistant drafts "from the newest template of that type". It now drafts from the type's
  default template, or asks (E2E-DRF-03).

### Before you start: section 2 setup

- docs/40 §0 is done and the §0.5 lines are pasted. The agents service runs with a model key for journeys that say
  **Needs: agents service + model key**.
- A fresh seed (`pnpm dev:setup`) gives Org A what these journeys expect: a **Governing Law** clause family with three
  options (Delaware, New York, England and Wales) and **no default**; the **Mutual Non-Disclosure Agreement** published
  as version 1 and marked the default NDA template, with Governing Law as a clause slot; a **Default playbook** covering
  all types; and the **Dispute Resolution** category marked required for NDAs. If your database was seeded before
  these changes, run the backfill once (from `apps/api`):
  `npx tsx --env-file=../../.env scripts/backfill-clause-families.ts --org=$ORG_A --apply`.
- Do **not** run `scripts/set-template-org-default.ts` on Org A: it gives Governing Law a default, and E2E-DRF-04 then
  can't show an open choice.
- Optional, to shorten waits: add `ANALYSIS_CHECKPOINT_MS=20000` to `.env` and restart `pnpm dev`. An edited contract is
  then re-analysed 20 s after its last save instead of two minutes. The journeys say "two minutes"; with this set, read
  it as 20 s.

Paste these helpers. They replace any helper of the same name from an earlier section.

```bash
export AGENTS=http://localhost:8002 INT=${API%/v1}/internal/ai
tj()  { curl -s -X POST "$INT/tools/$1" -H "x-internal-secret: $INTERNAL_SECRET" -H "x-internal-service: agents" \
  -H 'content-type: application/json' -d "$2"; }
sql() { docker exec -i clm_postgres psql -U clm -d clm_dev -At -c "$1"; }
# Upload a file as a new contract; prints its id.  upload <file> <mime type> <title> <counterparty> [token]
upload() { curl -s -X POST "$API/contracts/upload" -H "Authorization: Bearer ${5:-$COUNSEL_A}" \
  -F "file=@$1;type=$2" -F "title=$3" -F "counterpartyName=$4" | jq -r .id; }
# Wait until a contract's analysis ends; prints DONE or FAILED (polls every 10 s, up to 10 min)
waitdone() { for i in $(seq 1 60); do s=$(curl -s "$API/contracts/$1" -H "Authorization: Bearer $ADMIN_A" | jq -r .analysisStatus)
  case $s in DONE|FAILED) echo "$s"; return;; esac; sleep 10; done; echo "still $s"; }
# Raise a request; prints its id.  newreq <token> <title> <type> <description> [counterparty] [value]
newreq() { curl -s -X POST "$API/requests" -H "Authorization: Bearer $1" -H 'content-type: application/json' \
  -d "$(jq -n --arg t "$2" --arg ty "$3" --arg d "$4" --arg c "${5:-}" --arg v "${6:-}" \
  '{title:$t,type:$ty,description:$d} + (if $c=="" then {} else {counterpartyName:$c} end) + (if $v=="" then {} else {estimatedValue:($v|tonumber)} end)')" | jq -r .id; }
# What drafting a request would use (no model is called)
plan() { curl -s "$API/requests/$1/draft-plan" -H "Authorization: Bearer ${2:-$COUNSEL_A}"; }
# Accept a request and draft it; prints the new contract id, or the refusal
convert() { curl -s -X POST "$API/requests/$1/convert" -H "Authorization: Bearer ${2:-$COUNSEL_A}" | jq -r '.contractId // .'; }
# A contract's origin, Review panel data, deterministic checks and analysis runs
origin() { curl -s "$API/contracts/$1/origin" -H "Authorization: Bearer ${2:-$COUNSEL_A}"; }
rv()     { curl -s "$API/contracts/$1/review" -H "Authorization: Bearer ${2:-$COUNSEL_A}"; }
chk()    { curl -s "$API/contracts/$1/checks" -H "Authorization: Bearer ${2:-$COUNSEL_A}"; }
runs()   { curl -s "$API/contracts/$1/analysis-runs" -H "Authorization: Bearer ${2:-$COUNSEL_A}" \
  | jq -c '.data[] | {v:.versionNumber, reason, mode, status, failedStepLabel, error}'; }
# Ids used throughout
export GL=$(curl -s "$API/clause-families" -H "Authorization: Bearer $COUNSEL_A" | jq -r '.data[] | select(.name=="Governing Law") | .id')
export NDA_T=$(curl -s "$API/templates?contractType=NDA&published=true" -H "Authorization: Bearer $COUNSEL_A" \
  | jq -r '.data[] | select(.name=="Mutual Non-Disclosure Agreement") | .id')
export ADMIN_A_ID COUNSEL_A_ID
```

`echo $GL $NDA_T` prints two ids. If `$GL` is empty, the backfill above was not run.

**Fixtures.** Make these text files once, in `~/qa-docs`. Copy each block exactly; the journeys quote their words.

`QA-NDA.txt`, a mutual NDA with a Governing Law clause and a long Exclusions clause (E2E-REV-10, -11, -12, E2E-CMP-10):

```
MUTUAL NON-DISCLOSURE AGREEMENT

This Mutual Non-Disclosure Agreement (the "Agreement") is entered into on 1 October 2026 between Acme Analytics Inc., a Delaware corporation ("Acme"), and Initech Solutions LLC ("Initech") (each a "Party" and together the "Parties").

1. Purpose. The Parties wish to exchange information to evaluate a possible data-sharing pilot (the "Purpose").

2. Definitions. "Confidential Information" means any non-public business, technical or financial information that a Party discloses to the other Party in connection with the Purpose, whether disclosed orally, in writing or electronically.

3. Exclusions. Confidential Information does not include information that (a) is or becomes publicly available through no fault of the receiving Party; (b) was lawfully known to the receiving Party before disclosure without any duty of confidentiality; (c) is independently developed by the receiving Party without use of or reference to the disclosing Party's Confidential Information; or (d) is rightfully received from a third party who is not under any obligation of confidentiality to the disclosing Party.

4. Obligations. Each Party will use the other Party's Confidential Information only for the Purpose, will protect it with at least the degree of care it uses for its own confidential information and no less than reasonable care, and will limit access to its employees and advisers who need to know it and are bound by obligations of confidentiality at least as protective as this Agreement.

5. Term. This Agreement lasts for two years from the date above. The obligations in Section 4 survive for five years after this Agreement ends, and for trade secrets for as long as they remain trade secrets.

6. Return of Information. On written request, each Party will promptly return or destroy the other Party's Confidential Information and confirm in writing that it has done so.

7. Governing Law. This Agreement is governed by the laws of the State of New York, without regard to its conflict-of-laws rules, and the courts of New York County have exclusive jurisdiction over any dispute arising out of it.

8. Miscellaneous. This Agreement is the entire agreement between the Parties about its subject matter. It may be amended only in writing signed by both Parties. Neither Party may assign it without the other Party's prior written consent.

Signed for Acme Analytics Inc.: ____________     Signed for Initech Solutions LLC: ____________
```

`QA-NDA-NOLAW.txt`: the same file with section **7. Governing Law** removed and this section added after section 8
(E2E-REV-16):

```
9. Fees. Initech will pay Acme a fee of USD 5,000 for access to the data room, due within 30 days of Acme's invoice.
```

`QA-TERMS.txt`, a services agreement with each of the five defined-term problems once, with curly quotes as a Word file
has them (E2E-CMP-12). It is the fixture of `apps/api/src/lib/defined-terms.test.ts`:

```
MASTER SERVICES AGREEMENT

This Master Services Agreement (the “Agreement”) is made on 4 January 2026 between Acme Corporation, a Delaware corporation (“Supplier”), and Beta Retail Ltd (“Customer”) (each a “Party” and together the “Parties”). Customer wishes to buy the Services.

1. Definitions
“Affiliate” means any entity that controls, is controlled by or is under common control with a Party.
“Confidential Information” means all non-public information disclosed by a Party.
“Exclusions” means the matters listed in Schedule 2.
“Fees” means the charges set out in Schedule 1.
“Services” means the services described in Schedule 1.

2. Services
Supplier shall provide the Services to Customer and its Affiliates. Supplier shall deliver the Deliverables by the agreed date.

3. Fees
Customer shall pay the Fees within thirty days, in accordance with the laws of the United States and the Data Protection Act 2018.
“Fees” means the charges set out in the order form, excluding taxes.

4. Confidentiality
Each Party shall protect the Confidential Information with reasonable care, and shall not disclose the other Party’s confidential information to anyone.

LIMITATION OF LIABILITY
Neither Party is liable to the other in any month of March for losses under Section 4 of this Agreement.
```

`QA-DPA-EU.txt`, a processing agreement that names EU employees' personal data (E2E-CMP-10):

```
DATA PROCESSING AGREEMENT

This Data Processing Agreement is made on 1 October 2026 between Helios Retail GmbH, Friedrichstrasse 10, 10117 Berlin, Germany ("Customer"), and Payroll Cloud Ltd ("Supplier").

1. Processing. Supplier will process Customer's employee personal data, namely names, home addresses, bank account numbers and salary details of Customer's employees in Germany and France, solely to run Customer's monthly payroll.

2. Instructions. Supplier will process the personal data only on Customer's documented instructions and will tell Customer at once if an instruction appears to break the law.

3. Security. Supplier will keep the personal data secure with appropriate technical and organisational measures, including encryption at rest and in transit and access limited to named staff.

4. Breaches. Supplier will notify Customer of any personal data breach without undue delay.

5. Term. This Agreement lasts as long as Supplier provides payroll services to Customer. At the end, Supplier will delete the personal data unless the law requires it to keep a copy.

6. Governing Law. This Agreement is governed by the laws of Germany.
```

`QA-DPA-NOWHERE.txt`, personal data with no word on where the people are (E2E-CMP-10):

```
NEWSLETTER SERVICES AGREEMENT

This Newsletter Services Agreement is made on 1 October 2026 between Brightside Media ("Customer") and Mailwise ("Supplier").

1. Services. Supplier will send Customer's monthly newsletter to the subscribers on Customer's mailing list, using the names and email addresses of those subscribers that Customer uploads to Supplier's platform.

2. Use of data. Supplier will use the subscriber names and email addresses only to send Customer's newsletter and will not sell, rent or share them with anyone.

3. Unsubscribing. Supplier will include an unsubscribe link in every newsletter and will remove a subscriber within two business days of a request.

4. Fees. Customer will pay Supplier USD 300 a month, invoiced monthly and due within 30 days.

5. Term. This Agreement runs for one year and renews for one year at a time unless either party gives 30 days' notice before the end of a year.
```

`QA-NOTACONTRACT.txt`, more than 150 words that are not a contract (E2E-PIPE-03). Any prose of that length works; for
example, paste three paragraphs of a cake recipe: ingredients in a sentence, then the mixing, then the baking, about
200 words in all, with no headings, no parties and no obligations.

---

### E2E-DRF-01 · Clause families: approved options of one clause, each with a rule, one default and its versions

**Covers:** /clauses (Families view) · `GET /clause-families` · `GET /clause-families/:id` · `POST /clause-families` · `PATCH /clause-families/:id` · `DELETE /clause-families/:id` · `POST /clause-families/:id/variants` · `PATCH /clause-families/:id/variants/:itemId` · `PUT /clause-families/:id/default` · `POST /clause-families/:id/preview` · `GET /clauses/:id/versions`
**Roles:** legalops-a, counsel-a, contracts-a, viewer-a, admin-b · **Needs:** nothing extra · **Time:** ~25 min

**Preconditions**
- Section 2 setup done; `$GL` is set. Signed in to `$WEB` as legalops-a.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Left rail → **Clauses**. Above the categories, click the **Families** tab. | The left column reads "Clauses with approved alternatives" with a **New family** button. It lists **Governing Law** "3 options · no default · in N templates" (N is the number of seeded templates with a Governing Law slot), then **Confidentiality Term**, **Liability Cap** and **Payment Terms**, each "2 options · no default". |
| 2 | Click **Governing Law**. | Heading **Governing Law**, then "Which law governs the agreement. In Dispute Resolution. Drafting uses, in order: the option a person picks, the one the request names, the first whose rule holds, the default. Otherwise the draft asks." Three cards: **Delaware**, **New York**, **England and Wales**, each with "v1", the line "No rule · A request may call it …" (Delaware: "Delaware, DE"; New York: "New York, NY"; England and Wales: "England and Wales, England & Wales, England, English") and its wording. Each has **Make default**, **History** and **Edit**. Under the cards: the box "Try it: which option would a draft use?" and "No default: a draft no rule decides asks someone to choose." |
| 3 | In **Try it**, type `NY` in "The request asks for… (e.g. New York)" and click **Check**. Then clear it, type `California`, **Check**. Then clear it and **Check** with every box empty. | 1st: "Drafts would use **New York** — named in the request." 2nd: "The draft would ask: The request asks for California, and no approved governing law clause is for it." 3rd: "The draft would ask: No rule decided it and there is no default." |
| 4 | Click **Add an option**. Name `New York (large deals)`, "A request may also call it" left empty, Wording `This Agreement is governed by the laws of the State of New York. The courts of New York County have exclusive jurisdiction.` Under **Use it when**, click **Add a test**, choose **Contract value**, **is more than**, `250000`. Leave **Approved for drafting** ticked. Click **Add option**. | The editor closes. A fourth card **New York (large deals)** "v1", "Used when: Contract value is more than 250000". The family row reads "4 options · no default …". With no test added, the builder says "No rule: used only when someone picks it, the request names it, or it is the default." |
| 5 | **Try it** again: "Contract value" `300000`, **Check**; then `100000`, **Check**. | "Drafts would use **New York (large deals)** — picked by your rule (Contract value is more than 250000)." Then "The draft would ask: No rule decided it and there is no default." |
| 6 | On **Delaware**, click **Make default**, then **Try it** with every box empty. | Delaware shows a **Default** chip and a **No default** button; the row reads "· default Delaware". Try it: "Drafts would use **Delaware** — your default." The "No default: …" line is gone. |
| 7 | Click **No default** on Delaware. | Back to "· no default". **Leave Governing Law with no default** (E2E-DRF-04 needs it). |
| 8 | On **New York (large deals)** click **Edit**. Change the wording's last sentence to `The state and federal courts in New York County have exclusive jurisdiction.`, type `Federal courts too` in "What changed (kept with the new version)" and click **Save as a new version**. Then click **History**. | The card shows "v2". History lists "Version 2 (current) · <today> · Federal courts too" with the new wording, then "Version 1 · <today> · Initial version". |
| 9 | `curl -s $API/clause-families/$GL -H "Authorization: Bearer $LEGALOPS_A" \| jq '{name, requestKey, templateCount, variants: [.variants[] \| {variantLabel, version, isFamilyDefault, isApproved, condition, matchValues}]}'` | `requestKey` "governingLaw"; four variants; the large-deals one has `version` 2 and `condition` `{"op":"gt","key":"value","value":250000}`; none has `isFamilyDefault` true. Save its id: `export NY_BIG=$(curl -s $API/clause-families/$GL -H "Authorization: Bearer $LEGALOPS_A" \| jq -r '.variants[] \| select(.variantLabel=="New York (large deals)") \| .id')`. |
| 10 | Try to make an unapproved option the default: `curl -s -X PATCH $API/clause-families/$GL/variants/$NY_BIG -H "Authorization: Bearer $LEGALOPS_A" -H 'content-type: application/json' -d '{"isApproved":false}' >/dev/null; curl -s -X PUT $API/clause-families/$GL/default -H "Authorization: Bearer $LEGALOPS_A" -H 'content-type: application/json' -d "{\"variantId\":\"$NY_BIG\"}"` | `422` `{"detail":"Approve this wording before making it the default."}`. On the page the card shows "Not approved — drafting won’t use it". Approve it again: the same PATCH with `{"isApproved":true}`. |
| 11 | **New family** → name `Governing Law` → **Create family**. Then name `QA Notice Period`, category "Term & Termination", **Create family**. | 1st: in red under the form, `There is already a clause family called “Governing Law”.` (`409`). 2nd: the new family is selected, with no options, only the **Add an option** button. |
| 12 | Delete families: `curl -s -X DELETE $API/clause-families/$GL -H "Authorization: Bearer $ADMIN_A"`, then the same for QA Notice Period's id. | Governing Law: `409` "N template sections use this family. Replace those clause slots first." QA Notice Period: deleted (`204`); it leaves the list. |

**Also check**
- Roles: counsel-a can create families and options (create/edit:clause) but `DELETE /clause-families/:id` answers `403` "Missing permission: delete:clause". contracts-a and viewer-a can read the Families view; `POST /clause-families` as either answers `403` "Missing permission: create:clause", and `PUT /clause-families/$GL/default` answers `403` "Missing permission: edit:clause".
- Another org: `curl -s $API/clause-families/$GL -H "Authorization: Bearer $ADMIN_B"` → `404` "Clause family not found". admin-b's list does not show Org A's families.
- A malformed rule is refused: `POST /clause-families/$GL/variants` with `"variantLabel":"x","content":"<p>x</p>","condition":{"op":"gt","key":"value","value":"lots"}` → `422` "Request body failed validation", nothing created.
- Audit (admin-a, Admin → Organization → Audit Log): `CLAUSE_FAMILY_CHANGED` on resource type `clause_family` for the option added, changed and the default.

**Known limits**
- A request matches an option by its name and "may also call it" names only (case, "the State of" and punctuation aside). "Big Apple" never matches New York.
- A rule can only test the five facts in the builder: Counterparty country, Governing law asked for, Contract value, Contract type and Whose paper. Contract value comes from the request's Estimated value.
- Options are ordered by when they were added; the first rule that holds wins. There is no drag to reorder.

### E2E-DRF-02 · A template's clause slot, its published snapshot, its playbook warnings and the notice to publish again

**Covers:** /templates (builder) · `POST /templates` · `PATCH /templates/:id` · `PUT /templates/:id/sections` · `POST /templates/:id/publish` · `GET /templates/:id/versions` · `GET /templates/:id/lint` · `POST /templates/:id/slot-preview` · `PUT /templates/:id/default-for-type` · `GET /templates/:id`
**Roles:** legalops-a, counsel-a, viewer-a, admin-b · **Needs:** nothing extra · **Time:** ~25 min

**Preconditions**
- E2E-DRF-01 done: Governing Law has a fourth option, **New York (large deals)**, added after the Mutual NDA was published.
- Signed in as legalops-a.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Left rail → **Templates**. Find **Mutual Non-Disclosure Agreement** and click its pencil (**Edit**). | The builder opens, titled **Edit Template**. In the sections list, **Governing Law** has a small layers icon (a clause slot). On the right of the header: **Save changes** (hover: "Saves your changes; drafts keep using the published version until you publish") and **Publish**. Under the header, **Drafts use**: "Version 1, published <date>." Then an amber box "The clause library changed since this was published. Publish again to use:" with the bullet "Governing Law: New York (large deals) was added." and the link **Publish again**. A ticked box "Default NDA template — used when a request or the assistant doesn’t name one". **Against your playbook**: "Agrees with your playbook." |
| 2 | Click the **Governing Law** section. | The right panel reads "Clause slot — the words come from" with **Governing Law** chosen and an **Edit families** link. It lists the approved options with "No rule" or "Used when: Contract value is more than 250000", and the box **Which option would a draft get?** |
| 3 | In that box type `English` in "The request asks for… (e.g. New York)" and click **Check**. Clear it, type `250001` in **Contract value**, **Check**. | "**England and Wales** — named in the request". Then "**New York (large deals)** — picked by your rule (Contract value is more than 250000)". |
| 4 | API, the same as the template's working copy: `curl -s -X POST $API/templates/$NDA_T/slot-preview -H "Authorization: Bearer $LEGALOPS_A" -H 'content-type: application/json' -d '{"requestValues":{"governingLaw":"Delaware"}}' \| jq '.data[] \| {sectionTitle, decidedBy, variantLabel}'` | One slot: `sectionTitle` "Governing Law", `decidedBy` "request_value", `variantLabel` "Delaware". |
| 5 | Click **Publish again**. | Toast "Published as version 2". The builder closes. Reopen it: **Drafts use** reads "Version 2, published <today>."; the amber library box is gone. |
| 6 | `curl -s $API/templates/$NDA_T/versions -H "Authorization: Bearer $LEGALOPS_A" \| jq '.data[] \| {version, current, warnings: (.lint\|length)}'` | Version 2 with `current` true and 0 warnings, then version 1 with `current` false. |
| 7 | Make a template that disagrees with the playbook. **New Template**: Template Name `QA Lint NDA`, Contract Type `NDA`. Click **+ Text**, title `Confidentiality Period`, body `The confidentiality obligations in this Agreement last for 3 years.` Click **Publish**. | Toast "Published as version 1, with 1 thing to look at" with "Confidentiality term of 3 years is your fallback position, not your preferred one (5 years)." The builder stays open. **Against your playbook** shows that sentence in an amber row. The default box "Default NDA template — …" is not ticked. |
| 8 | Change the body to `The confidentiality obligations in this Agreement last for 5 years.` and click **Save changes**. Reopen QA Lint NDA. | The card on the Templates page carries **Changes not published** beside **Published**. In the builder: "You have changes drafts don’t use yet. Publish to use them." and **Against your playbook** "Agrees with your playbook." (the lint reads the working copy). |
| 9 | `curl -s $API/templates/<QA Lint NDA id>/lint -H "Authorization: Bearer $LEGALOPS_A" \| jq '.data'` then `curl -s $API/templates/<id>/versions -H "Authorization: Bearer $LEGALOPS_A" \| jq '.data[0].lint[0].message'` | `[]` for the working copy. Version 1 keeps the warning it was published with: "Confidentiality term of 3 years is your fallback position, not your preferred one (5 years)." |
| 10 | Unpublish QA Lint NDA so it doesn't change later journeys: `curl -s -X PATCH $API/templates/<id> -H "Authorization: Bearer $LEGALOPS_A" -H 'content-type: application/json' -d '{"isPublished":false}' \| jq '{isPublished, isDefaultForType}'` | `isPublished` false, `isDefaultForType` false. |

**Also check**
- A clause slot over a family with no approved option: create a family `QA Empty` with no options, add a **+ Clause slot** to QA Lint NDA, choose **QA Empty** in "Clause slot — the words come from", type `QA Empty` in its "Section title..." box and publish → the warning "“QA Empty” has no approved wording yet, so every draft will ask for it." and, in the slot panel, "This family has no approved option yet, so every draft will ask." Unpublish QA Lint NDA again afterwards.
- A slot naming another org's family or a made-up id: `PUT /templates/$NDA_T/sections` with `"slotFamilyId":"nope"` → `404` "Clause family not found".
- `PUT /templates/<unpublished id>/default-for-type` with `{"isDefault":true}` → `422` "Publish the template before making it the default." A template with no contract type → `422` "Set the template’s contract type before making it the default for that type."
- Roles: counsel-a can edit and publish (edit:template). viewer-a: `POST /templates/$NDA_T/publish` → `403` "Missing permission: edit:template". Another org: admin-b `GET /templates/$NDA_T` → `404` "Template not found".
- Audit: `TEMPLATE_PUBLISHED` with `metadata.version` 2 and `warnings` 0 for the NDA, and 1 for QA Lint NDA; `TEMPLATE_DEFAULT_CHANGED` when a default changes.

**Known limits**
- docs/41 Part 2 asks for a lint "shown to the template owner and admin once". It is shown in the builder only; nobody is notified.
- The lint recognises a term in years against positions on the same subject, a playbook rule with a bound in years, and wording identical to a position. Other conflicts (a liability cap in fees, payment days) are not linted.
- The builder can't remove a section. Unpublish a test template instead of trying to strip it back.

### E2E-DRF-03 · One default template per type: the request page and the assistant pick the same one, and ask when there is no default

**Covers:** /requests (request panel, "Drafting will use") · /templates (default box) · `GET /requests/:id/draft-plan` · `PUT /requests/:id/draft-choices` · `POST /requests/:id/convert` (409 TEMPLATE_CHOICE_NEEDED) · `PUT /templates/:id/default-for-type` · `POST /internal/ai/tools/contract_draft`
**Roles:** rep-a, counsel-a, legalops-a, admin-b · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- E2E-DRF-02 done (Mutual NDA published as version 2; QA Lint NDA unpublished).
- A request to look at, raised by rep-a: `export REQ_T=$(newreq $REP_A "QA NDA template check" NDA "We need a mutual NDA with Initech Solutions to evaluate a data-sharing pilot." "Initech Solutions")`
- Signed in as counsel-a.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | The assistant's planner, as the agents service calls it (no model): `tj contract_draft "{\"orgId\":\"$ORG_A\",\"userId\":\"$COUNSEL_A_ID\",\"userMessage\":\"Draft an NDA with Initech Solutions\",\"contractType\":\"NDA\",\"counterpartyName\":\"Initech Solutions\"}" \| jq '{templateName, by: .origin.templateDecidedBy, v: .origin.templateVersion, slots: [.slots[] \| {familyName, decidedBy, reason}], persisted}'` | `templateName` "Mutual Non-Disclosure Agreement", `by` "default_for_type", `v` 2, one slot `{familyName:"Governing Law", decidedBy:"unresolved", reason:"No rule decided it and there is no default."}`, `persisted` false. |
| 2 | Left rail → **Requests**, open **QA NDA template check**. | Under **Description**, the block **Drafting will use** with a template picker showing "Mutual Non-Disclosure Agreement (default)" and, below it, "Your default for this type". A **Governing Law** picker showing "Choose…" (amber border) and the line "Choice needed — No rule decided it and there is no default. The draft will ask until someone chooses." The heading carries the count "1 to choose". |
| 3 | `plan $REQ_T \| jq '{drafted, template, templateProblem, openChoices}'` | `drafted` true, `template` `{name:"Mutual Non-Disclosure Agreement", decidedBy:"default_for_type", …}`, `templateProblem` null, `openChoices` 1. |
| 4 | Templates → edit **Mutual Non-Disclosure Agreement** → untick "Default NDA template — used when a request or the assistant doesn’t name one". Close the builder. | The box unticks at once (it saves on its own, `PUT /templates/:id/default-for-type`). |
| 5 | Back on the request, reopen it. Then repeat step 1's `tj` call with `\| jq '{error, detail, templates: [.templates[].name]}'`. | The template picker shows "Pick a template…" and, in amber, "Your organization has 2 published NDA templates and none is marked as the default. Pick one, or mark one as the default for NDA in Templates." (the number counts every published NDA template). The planner: `error` "TEMPLATE_CHOICE_NEEDED", the same `detail`, and `templates` listing Mutual Non-Disclosure Agreement and One-Way Non-Disclosure Agreement (Inbound), by name. |
| 6 | Click **Accept & Create Contract**. Then `curl -s -X POST $API/requests/$REQ_T/convert -H "Authorization: Bearer $COUNSEL_A" \| jq '{code, detail}'` | A red box above the buttons with the same sentence; the panel stays open and no contract is made. API: `409` `code` "TEMPLATE_CHOICE_NEEDED", the same `detail`. The request is still **Submitted**. |
| 7 | In the template picker choose **One-Way Non-Disclosure Agreement (Inbound)**. | The line under it reads "Picked for this request". `plan $REQ_T \| jq '.choices'` → `{"templateId":"<one-way id>","slots":{}}`. |
| 8 | Back in Templates, tick the default box on **Mutual Non-Disclosure Agreement** again. Then tick it on **One-Way Non-Disclosure Agreement (Inbound)**. Then `curl -s "$API/templates?contractType=NDA&published=true" -H "Authorization: Bearer $COUNSEL_A" \| jq '[.data[] \| {name, isDefaultForType}]'` | Only One-Way is the default: making one the default took it from the other. |
| 9 | Tick the box on **Mutual Non-Disclosure Agreement** again, and check the same list. | Only Mutual is the default. **Leave it so.** On the request, the picker still shows One-Way with "Picked for this request": a person's pick beats the default. |
| 10 | Decline the request so it doesn't linger: **Decline request**, reason `QA template check only`, confirm **Decline request**. | Its pill reads **Declined**, and the panel "Declined: QA template check only". |

**Also check**
- `PUT /requests/$REQ_T/draft-choices` with `{"templateId":"nope"}` → `404` "Template not found". With a clause choice the template doesn't offer, `{"slots":{"$GL":"nope"}}` → `422` "That clause option isn’t one this template offers." On a request already drafted → `409` "This request has already been drafted."
- A request with an attachment is read, not drafted: its panel shows no **Drafting will use** block, and `plan` returns `drafted` false.
- The planner with a type no published template has, `"contractType":"QA_NONE"`: `422` `error` "NO_TEMPLATE_MATCH", `detail` "No published QA_NONE template. Pick one of the org's published templates by id, or create a QA_NONE template in Templates first." A type with exactly one published template is drafted from it with `decidedBy` "only_one" (the request page says "Your only template for this type").
- Another org: admin-b `plan $REQ_T $ADMIN_B` → `404` "Request not found".
- Audit: the pick is `REQUEST_STATUS_CHANGED` on the request with `metadata.draftChoices`; the default changes are `TEMPLATE_DEFAULT_CHANGED`.

**Known limits**
- The editable pickers show on any request still open, to anyone who can open it. Someone without `edit:request` sees them, but a change is refused with a red toast "Not changed" and the server's reason.
- Ties among non-default templates are never broken by "newest". docs/40 E2E-DRAFT-05 still says the assistant drafts "from the newest template of that type"; that is no longer so.

### E2E-DRF-04 · Regression: an NDA drafted from a request that names no law is not silently Delaware; it asks, and can't be sent until someone chooses

Bug report 1: "Delaware chosen silently for an NDA drafted from a request." Before: the draft agent's prompt and the
seeded variable defaults filled Delaware and "Wilmington, Delaware". Now: the law is a clause slot; with no rule and no
default it stays a blank, the contract says so, and sharing and signing are refused until someone chooses.
The browser run of 2 October 2026 (Appendix C) added four regressions checked here: the title's "no law" was read as
the law asked for (cfe7b8c), both parties were named after the counterparty (ff9ece0), the purpose read "in connection
with evaluate …" (c66e521), and the open choice still let the recommendation say "Ready to approve" (d914067).

**Covers:** /requests · /contracts/:id (open-choices chip, Actions → Share, Origin panel) · `GET /requests/:id/draft-plan` · `POST /requests/:id/convert` · draft-contract job · `POST /draft/extract-variables` (agents) · `GET /contracts/:id/checks` · `POST /contracts/:id/share` and `POST /contracts/:id/send-for-signature` (409 OPEN_CHOICES) · `GET /contracts/:id/origin` · `POST /contracts/:id/origin/slots/:familyId`
**Roles:** rep-a, counsel-a, admin-a · **Needs:** agents service + model key · **Time:** ~20 min

**Preconditions**
- E2E-DRF-03 done: Mutual NDA is the default NDA template (version 2); Governing Law has no default.
- rep-a signed in to `$WEB`; counsel-a in a second browser.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As rep-a: **Requests → New Request**. Title `QA NDA no law`, Contract type "Non-Disclosure Agreement (NDA)", Counterparty **Initech Solutions**, Description `We need a mutual NDA with Initech Solutions to evaluate a 12-month data-sharing pilot starting in November.` **Submit Request**. Save the id from the panel's URL as `$REQ_NOLAW`. | The row appears with **Classifying**, which clears within about 30 s (docs/40 E2E-REQ-01). |
| 2 | As counsel-a, open the request. | **Drafting will use**: "Mutual Non-Disclosure Agreement (default)", "Your default for this type"; **Governing Law** "Choose…", "Choice needed — No rule decided it and there is no default. The draft will ask until someone chooses." Nothing quotes the title: no "Choice needed: “no law”" (a value that says there is none, such as "no law", "not specified" or "TBD", is no value). `plan $REQ_NOLAW \| jq '.slots[0] \| {decidedBy, evidence}'` → `decidedBy` "unresolved", `evidence` null. The request card may show **Duration** "12 months" (see Known limits). |
| 3 | Click **Accept & Create Contract**. Save the contract id from the URL as `$C_NOLAW`. | "Creating contract…", then the contract page opens. Within about a minute the document appears (the draft job extracts values from the request's words with the agents service). |
| 4 | Read the draft: `curl -s $API/contracts/$C_NOLAW -H "Authorization: Bearer $COUNSEL_A" \| jq -r '.versions[0].htmlContent' \| grep -o '\[\[Choose[^]]*\]\]'`, then the same piped to `grep -ciE 'laws of (the State of )?Delaware\|Wilmington'`. | `[[Choose governing law: Delaware · New York · England and Wales · New York (large deals)]]`, then `0`: nowhere does the draft say it is governed by Delaware law or name Wilmington courts. ("a Delaware corporation" may appear in the preamble: that is the template's default for your own entity type, not a legal choice.) On the page the blank shows as an unfilled field. Also read the parties and the purpose: `… \| jq -r '.versions[0].htmlContent' \| grep -oE 'by and between [^(]{0,120}\|in connection with [a-z]+ [^.<]{0,60}'`. Our side is Org A's own name (the seed's "Demo Org, Inc."), never Initech Solutions, which is named once as the other party; the purpose reads "in connection with evaluating a 12-month data-sharing pilot…", not "evaluate". |
| 5 | Look at the row under the title. Hover the amber chip. | Beside the status pill, an amber chip **1 choice needed** or **N choices needed** (other terms the request didn't give, such as Venue Location, are blanks too). Its tooltip: "N choices still open in the draft (Governing Law, …). Choose them before sending." (or "1 choice still open in the draft (Governing Law). Choose it before sending."). Clicking it opens the rail at the first blank. |
| 6 | `chk $C_NOLAW \| jq '{ready, openChoices, open: [.reasons[] \| select(.code=="open_choices") \| .text]}'`, after the draft's analysis is `DONE` (`waitdone $C_NOLAW`). Then open the **Review** panel. | `openChoices` includes `{"key":"slot_<$GL>","label":"Governing Law","slot":"<$GL>"}`; other entries (no `slot`) are template variables left blank. `ready` false and `open` is `["N choices are still open in the draft (Governing Law, … and K more)"]` (three names, then "and K more"; with only the law open, "1 choice is still open in the draft (Governing Law)"). The recommendation box reads **Review** with that line among its bullets, never **Ready to approve** (regression d914067: the clean draft said "Ready to approve" while it could not even be sent). No "Term & Termination — not detected" finding (the seeded NDA now has a "Term and Termination" section, 9c0f2fc). |
| 7 | As admin-a (who may share): **Actions ▾** on the contract. Then `curl -s -X POST $API/contracts/$C_NOLAW/share -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{}' \| jq '{code, detail}'` | **Share** is greyed out with "choose terms first" beside it. API: `409` `code` "OPEN_CHOICES", `detail` "N choices are still open in the draft (Governing Law, …). Choose them in the Variables and Origin panels before sending it to the counterparty." (only Governing Law open: "1 choice is still open in the draft (Governing Law). Choose it in the Origin panel before sending it to the counterparty."). |
| 8 | In the right rail, find the **Origin** section (open, count "1 to choose"). | "Made from Mutual Non-Disclosure Agreement version 2 (the default for its type)." Under **Governing Law**: "Choice needed" in amber, a picker "Choose…" with the four options, and a **Use** button. |
| 9 | Choose **New York**, click **Use**. | Toast "Governing Law: New York" / "Saved as a new version of the draft." The blank becomes the New York clause's words. Origin now shows "New York v1" and "Chosen by a person". The chip loses Governing Law (it disappears when nothing else is open). The new version's note is "Chose New York for governing law". |
| 10 | `origin $C_NOLAW \| jq '.origin.slots[0] \| {decidedBy, variantLabel, variantVersion}'`, then `chk $C_NOLAW \| jq '[.openChoices[].label]'` | `{"decidedBy":"user","variantLabel":"New York","variantVersion":1}`; the list no longer has "Governing Law". |
| 11 | Choose again by API: `curl -s -X POST $API/contracts/$C_NOLAW/origin/slots/$GL -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d "{\"variantId\":\"$NY_BIG\"}" \| jq .detail` | `409` "This choice has already been made in the draft (its blank is gone). Edit the clause in the document instead." |

**Also check**
- The workspace (`$WEB/contracts/$C_NOLAW/workspace`, **Details** tab) shows the same **Origin** panel, with the same picker.
- Sending for signature (`POST /contracts/$C_NOLAW/send-for-signature`) is refused the same way while a choice is open: `409` `code` "OPEN_CHOICES" with "… before sending it for signature." (the approval gate, if not approved yet, answers first with its own 409).
- `POST /contracts/$C_NOLAW/origin/slots/<a made-up family>` → `404` "This draft has no such clause choice."; a variant of another family → `422` "That option isn’t one this clause offers."
- rep-a owns the contract (the request was theirs) and can open it, but may not edit it: the Origin panel shows the reason in amber ("No rule decided it and there is no default.") with no picker, and `POST /contracts/$C_NOLAW/origin/slots/$GL` as rep-a → `403` "Missing permission: edit:contract".
- The open blank is never a value. Before the choice (after the draft's analysis is `DONE`):
  `curl -s $API/contracts/$C_NOLAW -H "Authorization: Bearer $COUNSEL_A" | jq .governingLaw` → `null`, and Details /
  Key terms show no "[[Choose governing law: …]]" as the governing law (regression found in browser QA: the blank was stored as the value).
- Audit: `CONTRACT_DRAFTED` (with `metadata.origin`) when the draft is saved, and `CLAUSE_CHOICE_MADE` with `familyName` "Governing Law", `variantLabel` "New York" and `versionNumber` 2.

**Known limits**
- The chip and the share refusal count every blank in the draft, not only legal choices: party addresses and dates the request didn't give count too. So does the recommendation's "N choices are still open" line, so a draft stays **Review** until every blank is filled.
- The intake classifier may read the pilot's "12-month" as the NDA's duration: the request card shows **Duration** "12 months". Drafting does not use it (the confidentiality period stays the template's), but the card is misleading.
- The NDA's "Term and Termination" section comes from the org seed. An org seeded before 9c0f2fc keeps its old Mutual NDA (a "Term" section that reads as confidentiality), so its drafts show "Term & Termination — not detected" until someone edits the template: add a "Term and Termination" section (the seed's words are in `apps/api/src/lib/org-seed/universal/templates.ts`), rename "Term" to "Period of Confidentiality", and publish. Seed template changes never reach existing orgs on their own: `backfill-clause-families.ts --apply` adds the section and renames "Term" (Appendix A).
- An org that wants Delaware filled can still make it the family's default (Clauses → Families → **Make default**) or run `scripts/set-template-org-default.ts`; drafts then say "Your default".

### E2E-DRF-05 · A request that names New York gets the New York clause, with the request's words quoted, every time

**Covers:** /requests · /contracts/:id (Origin panel) · intake classify-request job · `GET /requests/:id/draft-plan` · `POST /requests/:id/convert` · draft-contract job · `POST /draft/extract-variables` (agents) · `GET /contracts/:id/origin` · audit `CONTRACT_DRAFTED`
**Roles:** rep-a, counsel-a, admin-a · **Needs:** agents service + model key · **Time:** ~20 min

**Preconditions**
- E2E-DRF-04 done. counsel-a signed in.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Raise two identical requests and a third naming a law the library lacks: `D='We need a mutual NDA with Initech Solutions for a 12-month data-sharing pilot. It must be governed by New York law.'; export REQ_NY1=$(newreq $REP_A "QA NDA New York 1" NDA "$D" "Initech Solutions") REQ_NY2=$(newreq $REP_A "QA NDA New York 2" NDA "$D" "Initech Solutions") REQ_CA=$(newreq $REP_A "QA NDA California" NDA "We need a mutual NDA with Initech Solutions. It must be governed by California law." "Initech Solutions")`. Wait about 30 s for classification. | Three ids. |
| 2 | `plan $REQ_NY1 \| jq '.slots[0] \| {decidedBy, variantLabel, evidence}'` | `decidedBy` "request_value", `variantLabel` "New York", `evidence` `{key:"governingLaw", value:"New York", quote:"It must be governed by New York law."}`. (Before the classifier finishes it is still "unresolved"; ask again.) |
| 3 | Open **QA NDA New York 1** in the browser. | **Governing Law** picker shows "New York"; the line under it: "Named in the request: “It must be governed by New York law.”" The heading has no "to choose" count. |
| 4 | Open **QA NDA California**, and `plan $REQ_CA \| jq '.slots[0] \| {decidedBy, reason, quote: .evidence.quote}'` | The line reads "Choice needed: “It must be governed by California law.” — The request asks for California, and no approved governing law clause is for it. The draft will ask until someone chooses." API: `decidedBy` "unresolved", that `reason`, that `quote`. |
| 5 | Convert both New York requests: `export C_NY1=$(convert $REQ_NY1) C_NY2=$(convert $REQ_NY2)`; wait a minute. | Two contract ids. |
| 6 | `for c in $C_NY1 $C_NY2; do origin $c \| jq -c '.origin \| {templateId, templateVersion, templateDecidedBy, slot: (.slots[0] \| {decidedBy, variantId, variantVersion, quote: .evidence.quote})}'; done` | The two lines are identical: the same `templateId` (Mutual NDA), `templateVersion` 2, `templateDecidedBy` "default_for_type", and the same slot `{decidedBy:"request_value", variantId:<New York's id>, variantVersion:1, quote:"It must be governed by New York law."}`. |
| 7 | Open `$WEB/contracts/$C_NY1`. Look at the Origin section and the document. | Origin: "Made from Mutual Non-Disclosure Agreement version 2 (the default for its type)." **Governing Law**: "New York v1", "Named in the request: “It must be governed by New York law.”" If the extractor read other values from the request's words, a **Read from the request** list shows each with its quote. The document's governing-law section is the New York option's words ("…governed by and construed in accordance with the laws of the State of New York…"): `curl -s $API/contracts/$C_NY1 -H "Authorization: Bearer $COUNSEL_A" \| jq -r '.versions[0].htmlContent' \| grep -ciE 'laws of (the State of )?Delaware\|Wilmington'` prints 0. |
| 8 | As admin-a: Admin → Organization → **Audit Log**, filter on `CONTRACT_DRAFTED`, open the row for `$C_NY1`. | `metadata.source` "request", `templateName` "Mutual Non-Disclosure Agreement", and `metadata.origin.slots[0].decidedBy` "request_value" with the quote. |
| 9 | Convert **QA NDA California** and open it. | The draft keeps the governing-law blank; the Origin panel shows "Choice needed: “It must be governed by California law.”" with the picker. Nothing made California up, and nothing fell back to Delaware. |

**Also check**
- A value the request's words don't contain is not used. The intake classifier's terms count only with a sentence that names them; the extractor's values are dropped unless their quote is in the request's text.
- "governed by the laws of the State of New York", "NY law" and "New York State law" all resolve to New York (the comparison drops "the State of", "law" and punctuation, and "NY" is one of the option's names).
- A request that denies a law is no choice (cfe7b8c): `plan $(newreq $REP_A "QA NDA TBD" NDA "Mutual NDA with Initech Solutions. Governing law TBD." "Initech Solutions") | jq '.slots[0].decidedBy'` (after classification) → "unresolved". "Governed by New York law, not Delaware law" still names New York; "no Delaware law" names nothing.
- Venue: a request that names a law other than the template variable's old default leaves **Venue Location** blank rather than pairing New York law with Wilmington courts; it shows in the open choices (E2E-DRF-04 step 5).

**Known limits**
- The quote is the whole sentence that names the law, up to 500 characters.
- Classification is a model call: if it hasn't run (agents service down), the request page shows "Choice needed" for a law the request names. The draft job reads the request again with the extractor, so the draft itself can still be decided by the request's words.

### E2E-DRF-06 · A rule picks a clause option, a person's pick beats the rule, and the request's words beat both

**Covers:** /requests ("Drafting will use") · `GET /requests/:id/draft-plan` · `PUT /requests/:id/draft-choices` · `POST /requests/:id/convert` · `GET /contracts/:id/origin`
**Roles:** counsel-a · **Needs:** nothing extra (step 7: agents service + model key) · **Time:** ~15 min

**Preconditions**
- E2E-DRF-01 and -02 done: the published Mutual NDA (version 2) carries **New York (large deals)** with the rule "Contract value is more than 250000".

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `export REQ_BIG=$(newreq $COUNSEL_A "QA NDA large deal" NDA "We need a mutual NDA with Initech Solutions before a large services deal." "Initech Solutions" 300000); plan $REQ_BIG \| jq '.slots[0] \| {decidedBy, variantLabel, rule}'` | `decidedBy` "rule", `variantLabel` "New York (large deals)", `rule` "Contract value is more than 250000". |
| 2 | Open the request in the browser. | Governing Law picker "New York (large deals)"; "Picked by your rule: Contract value is more than 250000". |
| 3 | `export REQ_SMALL=$(newreq $COUNSEL_A "QA NDA small deal" NDA "We need a mutual NDA with Initech Solutions before a small services deal." "Initech Solutions" 100000); plan $REQ_SMALL \| jq '.slots[0].decidedBy'` | "unresolved": no rule holds and there is no default. |
| 4 | On **QA NDA large deal**, choose **England and Wales** in the Governing Law picker. | The line reads "Chosen by a person". The picker now also offers "Decide by the rules". `plan $REQ_BIG \| jq '{choices, d: .slots[0].decidedBy}'` → `choices.slots` maps `$GL` to England and Wales' id; `d` "user". |
| 5 | Choose **Decide by the rules**. | Back to "Picked by your rule: Contract value is more than 250000". |
| 6 | `export REQ_BIGNY=$(newreq $COUNSEL_A "QA NDA large deal NY" NDA "Mutual NDA with Initech Solutions before a large deal. Governed by New York law." "Initech Solutions" 300000)`; wait 30 s; `plan $REQ_BIGNY \| jq '.slots[0] \| {decidedBy, variantLabel}'` | `{"decidedBy":"request_value","variantLabel":"New York"}`: the law the request names comes before any rule. |
| 7 | Pick **England and Wales** on **QA NDA large deal** again, then `export C_EW=$(convert $REQ_BIG)`, wait a minute, `origin $C_EW \| jq '.origin.slots[0] \| {decidedBy, variantLabel}'` | `{"decidedBy":"user","variantLabel":"England and Wales"}`; the Origin panel says "England and Wales v1", "Chosen by a person". |

**Also check**
- A rule never holds on a missing fact: a request with no Estimated value is never "large".
- Decline the requests you didn't convert (`REQ_SMALL`, `REQ_BIGNY`) when done.

**Known limits**
- Contract value is the request's **Estimated value**, a number with no currency.
- Counterparty country is read from the request's words by the extractor during drafting only, so the request page can't show a country rule deciding; the draft can.

### E2E-PIPE-01 · Regression: a contract drafted from a request is analysed, and its clauses, findings and run are there

Bug report 11: "No clauses or obligations on a contract drafted from a request." Before: the draft worker wrote v1,
marked the contract `DONE`, set no current version and queued nothing, so the page looked analysed and every check found
nothing. Now: saving a draft calls the one analysis trigger, which records a run and analyses v1.
The browser run (Appendix C) found three more ways a drafted contract ended up "Not analysed", each checked here: the
clause step's bodiless request was sent as JSON and refused with 400, so every run stopped after Extract (20216d2); the
extractor read a draft's empty blank "[[effectiveDate]]" as a date, the save failed the date check and the whole
extraction with it (236e3fd, 61afa43); and the obligations step wrote back metadata read a minute earlier, erasing the
analysis stamp (2b8ceae).

**Covers:** /contracts/:id (Overview, Review panel) · draft-contract job · extract-ai, chunk-and-index, playbook-review and compliance-review jobs · `GET /contracts/:id` · `GET /contracts/:id/clauses` · `GET /contracts/:id/analysis-runs` · `GET /contracts/:id/review` · `GET /obligations?contractId=` (PROPOSED) · `POST /obligations/:id/complete` (refused) · ObligationsRailSection
**Roles:** counsel-a · **Needs:** agents service + model key · **Time:** ~10 min

**Preconditions**
- E2E-DRF-04 and E2E-DRF-05 done: `$C_NY1` (drafted from a request) and `$C_NOLAW` (drafted, then a clause chosen in Origin).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `waitdone $C_NY1` | `DONE` within about three minutes of the draft. |
| 2 | `curl -s $API/contracts/$C_NY1 -H "Authorization: Bearer $COUNSEL_A" \| jq '{analysisStatus, current: .currentVersionId, v1: .versions[-1].id, stamp: .metadata._analysis \| {versionNumber, clauses}}'` | `analysisStatus` "DONE"; `current` equals `v1` (the draft worker sets it); `stamp.versionNumber` 1 and `stamp.clauses` more than 0. |
| 3 | `curl -s $API/contracts/$C_NY1/clauses -H "Authorization: Bearer $COUNSEL_A" \| jq '.data \| length'` | More than 0 (an NDA from the seeded template has about eight). |
| 4 | `runs $C_NY1` | One line `{"v":1,"reason":"generated","mode":"full","status":"done","failedStepLabel":null,"error":null}`. |
| 5 | Open `$WEB/contracts/$C_NY1`. Look at the **Overview** rail section and the **Review** section. | Overview: "Analysed · v1". No amber "Not analysed" banner. The Review section shows a recommendation box and the groups (E2E-REV-10 describes them); **Standard and accepted (N)** lists the clauses still as the template wrote them. |
| 6 | `runs $C_NOLAW` | Two lines, newest first: `{"v":2,"reason":"added",…,"status":"done"}` (the version the Origin choice made) and `{"v":1,"reason":"generated",…}`. |
| 7 | Obligations (bug 11's other half). Wait a minute after `DONE`, then `curl -s "$API/obligations?contractId=$C_NY1" -H "Authorization: Bearer $COUNSEL_A" \| jq '[.data[] \| {status, description}]'` | At least one obligation (an NDA's duty to keep information confidential, to return or destroy it), each `status` "PROPOSED". |
| 8 | On `$WEB/contracts/$C_NY1`, open the rail's **Obligations** section. | A note "**Proposed — confirmed at signing.** What this draft would commit you to. They become obligations to track when it is signed." Each row has the chip "Proposed — confirmed at signing", a grey due date and no **Complete** button. |
| 9 | They are not owed yet: `curl -s "$API/obligations?limit=100" -H "Authorization: Bearer $COUNSEL_A" \| jq --arg c $C_NY1 '[.data[] \| select(.contractId==$c)] \| length'`; then complete one: `O=$(curl -s "$API/obligations?contractId=$C_NY1" -H "Authorization: Bearer $COUNSEL_A" \| jq -r '.data[0].id'); curl -s -X POST $API/obligations/$O/complete -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{}' \| jq` | `0`: the Obligations page and its counts leave proposed ones out. The complete: `409` `{"detail":"This obligation is proposed: it is owed once the contract is signed."}` |
| 10 | After the obligations of step 7 appear, run step 2's command again and reload the page. Then `curl -s $API/contracts/$C_NOLAW -H "Authorization: Bearer $COUNSEL_A" \| jq '{effectiveDate}'` and `runs $C_NOLAW \| head -1`. | Still `stamp.versionNumber` 1 and "Analysed · v1" (regression 2b8ceae: reading obligations erased the stamp and the page said "Not analysed"). `$C_NOLAW`'s open blanks are no values: `effectiveDate` null while its "[[effectiveDate]]" blank is open (governing law was null too until step 9 of E2E-DRF-04 chose it), and its newest run is "done" with `failedStepLabel` null (regressions 236e3fd, 61afa43, 273e23d). No run stops after Extract with a 400 from the clause step (20216d2). |

**Also check**
- The assistant's path: apply a drafting plan from the assistant (docs/40 E2E-DRAFT-04). The new contract gets a run with reason "generated" in the same way (`runs <id>`).
- A request converted with an attachment is parsed and analysed from its file: its run's reason is "uploaded" and its steps start with "reading the document".

- A new version replaces the proposals: save an edit as a version and let its full analysis finish; the proposed list is
  read again from the new version, keeping any a person confirmed or dismissed.
- At signing they become owed: send `$C_NY1` for approval and signature (E2E-LIF-04) or mark it signed. The proposals
  read from the signed version (and any a person confirmed) turn `OPEN`; ones read from an older version are dropped
  and the signed version is read instead, once. The rail loses the "Proposed" note.
- The empty rail on a draft that has none yet reads "This draft’s obligations are read when it is analysed, and shown
  as proposed until it is signed."

**Known limits**
- Proposals are read after a **full** analysis only (generated, uploaded, added version, retry), never after an edit
  checkpoint. A draft edited in place shows the proposals of its last full analysis.
- Reading obligations is a separate model call queued after the analysis, so they can appear a minute after `DONE`.

### E2E-PIPE-02 · The page always says which version the analysis describes: Analysing, Analysed · vN, stale after a saved edit, and re-analysed from the last one

**Covers:** /contracts/:id (analysis banner, Overview, Review run line) · /contracts/:id/workspace (Save as version) · `POST /contracts/upload` · analysis-checkpoint job · incremental analysis · `GET /contracts/:id/analysis-runs` · `GET /contracts/:id/review` · `POST /contracts/:id/analyze`
**Roles:** counsel-a · **Needs:** agents service + model key · **Time:** ~20 min

**Preconditions**
- `~/qa-docs/QA-NDA.txt` made. Signed in as counsel-a.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `export C_ST=$(upload ~/qa-docs/QA-NDA.txt text/plain "QA Analysis states NDA" "Initech Solutions")`, then at once open `$WEB/contracts/$C_ST` and watch the **Review** section. | While it runs, the Review section's grey line reads "Analysing — step n of m, <step>…" with a spinner, the step being one of "reading the document", "working out its type", "reading its fields and clauses", "finding and indexing its clauses", "checking it against the playbook and the last version", "checking its defined terms", "checking the compliance rules that apply", "checking changed clauses against your positions". It refreshes every 4 s. The recommendation, if shown, is "Can't recommend" with "its analysis is still running". |
| 2 | `waitdone $C_ST`; reload. | `DONE`. Overview: "Analysed · v1". The grey run line is gone. |
| 3 | Click **Open workspace**. In section 5 change `two years` to `three years`. Watch the header. | The workspace opens full screen. Beside the title, "Saving…" then "Draft changes saved · not a version yet". |
| 4 | Click **Save as version**. In **What changed** type `Term three years`, click **Save version**. Click **Back**. | The dialog "Save as version" ("Your draft changes become a new version, with a note saying what changed.") closes; v2 exists. On the contract page an amber banner: "Analysis is for v1 — v2 has changes" and "It is analysed again two minutes after the last edit." with **Analyse now**. |
| 5 | Within the two minutes: `rv $C_ST \| jq '{analysis, rec: .recommendation \| {text, reasons: [.reasons[].text]}}'` | `analysis.kind` "stale", `analysedVersionNumber` 1. `rec.text` "Can't recommend" with a reason "the document changed after it was analysed (analysis is for v1)". The Review section's grey line: "Analysis is for v1 — v2 has changes." (with " Re-analysing…" once the checkpoint job has started). |
| 6 | Wait two minutes and about a minute more; `runs $C_ST` | Newest first: `{"v":2,"reason":"checkpoint","mode":"incremental","status":"done",…}` then the v1 run. Overview: "Analysed · v2". |
| 7 | `rv $C_ST \| jq '{baseline, needs: [.groups.needsAttention[] \| {title, label}]}'` | `baseline.versionNumber` 1. A finding titled "<clause name> — changed since v1" (the clause name as analysis typed it, e.g. "Term") with `label` "Changed since v1". Hover its chip in the panel: "The words of this clause differ from v1, the version this one is compared with." The panel says "Compared with v1 …". |
| 8 | Ask for a full analysis again, as **Re-analyze** does: `curl -s -X POST "$API/contracts/$C_ST/analyze?full=true" -H "Authorization: Bearer $COUNSEL_A" \| jq '{status, mode}'`, then `waitdone $C_ST` and `runs $C_ST`. | `{"status":"queued","mode":"full"}`; `DONE`; a new run for v2 with `reason` "retry" and `mode` "full" at the top. |

**Also check**
- Two quick saves within two minutes make one checkpoint run, not two: the second save pushes the first's timer back.
- An edit that rewrites most of the document (less than 60% of the words kept) is analysed in full: its checkpoint run has `mode` "full".
- An edit that changes nothing in the text (an undo back to v1's words) is not analysed again: the stamp moves to the new version.
- The approval guard reads the same state: `chk $C_ST \| jq '{ready, reasons}'` during step 5 gives `ready` false with the stale reason.

**Known limits**
- The contract page says "Analysed · vN"; docs/41 wrote "Done for vN". The failed state reads "Analysis failed while <step>." with the reason in words and **Retry**.
- An incremental run carries the clauses and re-checks only what changed; the summary, risk score and key terms are read again only on the next full analysis.
- With `ANALYSIS_CHECKPOINT_MS=0` checkpoints are off: a saved edit then only asks for a fresh playbook review.

### E2E-PIPE-03 · A failed analysis says at which step, a long document with no clauses fails, and admins retry from Analysis health

**Covers:** /admin/analysis · /contracts/:id (failed banner) · `GET /admin/analysis/runs` · `POST /admin/analysis/runs/:id/retry` · `GET /contracts/:id/analysis-runs` · parse-document, extract-ai and chunk-and-index jobs
**Roles:** admin-a, counsel-a, legalops-a, admin-b · **Needs:** agents service + model key (stopped for part of the journey) · **Time:** ~30 min

**Preconditions**
- `~/qa-docs/QA-NOTACONTRACT.txt` and `QA-NDA.txt` made. admin-a signed in.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Left rail → Admin → **Analysis health**. | Page **Analysis health**, "Contract analyses that failed or stopped moving in the last 14 days, grouped by the step they stopped at." A picker "Failed and stuck" (also "Failed", "Stuck"), four counts **Finished**, **Failed**, **Stuck**, **Running now**, and, with no problems, "No analysis failed or got stuck in this period." |
| 2 | `export C_JUNK=$(upload ~/qa-docs/QA-NOTACONTRACT.txt text/plain "QA Not a contract" "Nobody")`; `waitdone $C_JUNK` | Usually `FAILED`: the model finds no clause in a cake recipe. (If it finds one, the contract ends `DONE`; note it and go on to step 5.) |
| 3 | Open `$WEB/contracts/$C_JUNK`. | A red band: "Analysis failed while finding and indexing its clauses." then "No clauses were found in the document." and a **Retry** button (regression 0b15b77: the band used to show the stored error as it was, JSON and HTTP codes included, with **Re-analyze**). The Review panel says "The analysis failed while finding and indexing its clauses. No clauses were found in the document." |
| 4 | Reload Analysis health. | A group "Stopped while finding and indexing its clauses (1)": the row **QA Not a contract** "· v1 · uploaded · started N min ago", the error in red, and **Retry**. **Failed** counts it. |
| 5 | Stop the agents service (Ctrl-C its process in the `pnpm dev` output, or `lsof -ti tcp:8002 \| xargs kill`). `export C_DOWN=$(upload ~/qa-docs/QA-NDA.txt text/plain "QA Agents down NDA" "Initech Solutions")`; `waitdone $C_DOWN` (the jobs retry with back-off, so this takes a few minutes). | `FAILED`. The contract page's red band reads "Analysis failed while <step>." (the step a model was first needed in, e.g. "reading its fields and clauses", taken from the run) followed by the reason in words, such as "The AI service couldn’t be reached." or "The AI service took too long to answer.", never a status code or JSON; then **Retry**. `runs $C_DOWN` shows `status` "failed" with that `failedStepLabel` and an `error` naming the agents service. |
| 6 | Reload Analysis health. | A group "Stopped while <that step> (1)" with **QA Agents down NDA**. Groups are in the order the steps run. |
| 7 | Start the agents service again. Click **Retry** on QA Agents down NDA. | The button starts a new run (`202` `{"retried":"queued_parse"}` or similar in the network tab). The failed row stays: it records what happened. `runs $C_DOWN` gains a run with `reason` "retry" above the failed one; `waitdone $C_DOWN` → `DONE`. Audit: `CONTRACT_UPDATED` with `metadata.via` "analysis-health.retry". |
| 8 | Retry a run that finished: `R=$(curl -s $API/contracts/$C_DOWN/analysis-runs -H "Authorization: Bearer $ADMIN_A" \| jq -r '.data[0].id'); curl -s -X POST $API/admin/analysis/runs/$R/retry -H "Authorization: Bearer $ADMIN_A" \| jq` | `409` `{"code":"NOT_FAILED","detail":"This analysis finished; there is nothing to retry."}` |
| 9 | `curl -s "$API/admin/analysis/runs?status=failed&days=1" -H "Authorization: Bearer $ADMIN_A" \| jq '{days, totals, groups: [.groups[] \| {step, label, count}]}'` | `days` 1; `totals` with `done`, `failed`, `running`, `stuck`; the group for `QA Not a contract` (step "index") is there; failed runs stay listed for the period asked (up to 90 days) unless the contract is archived. `?status=bogus` → `400` "Invalid query". |

**Also check**
- Roles: counsel-a and legalops-a: `GET /admin/analysis/runs` → `403` "Missing permission: configure:organization"; opening `$WEB/admin/analysis` as either shows "Analysis health could not be loaded." Any role that can open a contract can read its own `GET /contracts/:id/analysis-runs`.
- Another org: admin-b's Analysis health never lists Org A's runs; `POST /admin/analysis/runs/<Org A run id>/retry` as admin-b → `404` "Analysis run not found".
- A row whose contract has a newer version says "The contract has a newer version; a retry analyses that one."
- A short text (under 150 words) with no clauses ends `DONE` with "No clauses were found in this short document." under "Analysed · v1".
- A failure in a later step (defined terms, compliance, the model's position check) fails the run but leaves the contract analysed; Retry re-runs only that step.
- The banner's reasons, from the stored error: a save refused with a status code → "What it read couldn’t be saved."; no text → "The document has no text to read yet."; the model returned nothing → "The AI read nothing from the document."; anything with JSON, codes or a stack → "Something went wrong on our side." A contract whose draft itself failed (no version) says "Draft generation failed" with **Retry draft**.

**Known limits**
- "Stuck" means a run that has not moved for 15 minutes. There is no way to make one on purpose short of killing the API mid-run.
- Nothing alerts anyone when a run fails; the page is the only place it shows.
- A retried failure stays on the page as a failed run beside the retry's own run; the page does not show that it was retried.

### E2E-PIPE-04 · The backfill finds contracts marked analysed that never were, and analyses them within the AI budget

**Covers:** `apps/api/scripts/backfill-unanalysed.ts` · analysis trigger (reason "backfill") · /admin/analysis (reason "catch-up")
**Roles:** an operator with a shell · **Needs:** agents service + model key (for `--apply`) · **Time:** ~15 min

**Preconditions**
- `$C_NY1` from E2E-DRF-05, analysed. A shell in `apps/api`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Make `$C_NY1` look like a contract from before the trigger existed: `sql "DELETE FROM contract_clauses WHERE \"versionId\" = (SELECT \"currentVersionId\" FROM contracts WHERE id='$C_NY1')"; sql "UPDATE contracts SET \"analysisStatus\"='DONE', metadata = metadata - '_analysis' WHERE id='$C_NY1'"`. Then open `$WEB/contracts/$C_NY1` and `rv $C_NY1 \| jq '{a: .analysis.kind, rec: .recommendation.text, reasons: [.recommendation.reasons[].text]}'` | `DELETE n` and `UPDATE 1`. The page now tells the truth about it: an amber banner "Not analysed" with "Nothing has read this document yet, so no clause, risk or playbook check has been made." and **Analyse**; the Review section's grey line "This version hasn't been analysed yet." with **Analyse now**. API: `a` "not_analysed", `rec` "Can't recommend", `reasons` including "this contract has not been analysed". |
| 2 | Dry run: `npx tsx --env-file=../../.env scripts/backfill-unanalysed.ts --org=$ORG_A` | "N contracts marked analysed with no clauses, in 1 orgs (dry run — pass --apply to queue)", then "org <id>: N found, M this run" and "  would queue $C_NY1 — QA NDA New York 1" among them, ending "Nothing queued (dry run)." Nothing changes. |
| 3 | `npx tsx --env-file=../../.env scripts/backfill-unanalysed.ts --org=$ORG_A --per-org=1 --apply` | One contract queued ("  <id> — <title>: queued_extract" or similar), ending "Queued 1." Run it until `$C_NY1` is the one queued, or pass `--per-org` large enough. |
| 4 | `waitdone $C_NY1`; `runs $C_NY1 \| head -1`; `curl -s $API/contracts/$C_NY1/clauses -H "Authorization: Bearer $COUNSEL_A" \| jq '.data \| length'` | `DONE`; a run with `reason` "backfill"; clauses back above 0. If that run had failed, Analysis health would show it as "catch-up". |

**Also check**
- With the org's daily AI budget used up, the script prints "  org <id>: today's AI budget is used up — the rest wait for the next run" and stops queuing for that org.
- `--every-ms` spaces the queuing (default 3000 ms); `--per-org` caps it (default 20).

**Known limits**
- Every contract the script queues is a paid model run. Never run `--apply` against the hosted demo or production without the owner's go-ahead.
- A short document legitimately "analysed with no clauses" is listed too; the analysis it gets ends `DONE` again.

### E2E-REV-10 · One Review panel: the recommendation and why, which playbook, each finding with its evidence, and what every label means

**Covers:** /contracts/:id (Review section) · /contracts/:id/workspace (Review tab) · `GET /contracts/:id/review` · `GET /contracts/:id/checks` · review-findings service · playbook-review job (position check)
**Roles:** counsel-a, viewer-a, admin-b · **Needs:** agents service + model key · **Time:** ~20 min

**Preconditions**
- `~/qa-docs/QA-NDA.txt` made. Signed in as counsel-a. `VITE_MARGIN_CLASSIFIER` is not set in `.env` (the default).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `export C_NDA=$(upload ~/qa-docs/QA-NDA.txt text/plain "QA Review NDA" "Initech Solutions"); waitdone $C_NDA` | `DONE`. |
| 2 | Open `$WEB/contracts/$C_NDA`; find the **Review** section in the right rail. | Exactly one section about the playbook: **Review**, open, with a count when anything is open. There is no "Playbook review", "Playbook redline" or "Drafting" section. |
| 3 | Look at the top box and hover its first line. | A tinted box whose first line is one of **Ready to approve**, **Review**, **Needs exception**, **Escalate** or **Can't recommend**. Hovering shows its definition (for Review: "Something in this version needs a person to look at it before it is approved: see the findings."). Up to three reasons as bullets ("and N more below" past three). Last line: "Worked out from the findings below by fixed rules, not by AI." |
| 4 | Read the grey line under it. | "Using Default playbook, the default for NDA contracts." (A first analysis has no "Compared with v…" line.) |
| 5 | Read the groups. | **Needs attention (n)** with one card per finding, or "Nothing needs attention."; **Not detected**, **Compliance** and **Drafting** only when they have something (Drafting may say "No problems with defined terms." above its **Defined terms (N)** list); **Standard and accepted (N)**, collapsed; and, when any, "N clause(s) not covered by your playbook." |
| 6 | On a finding card: hover the status chip, hover the small **AI** mark if present, click the title. | The chip's hover is its definition, e.g. "Compared with your playbook: this clause meets none of your positions for it, or a rule your playbook sets." for **Doesn't meet your positions**. The AI mark's hover: "Judged by AI against your playbook's positions, with the words it relied on." The card quotes the clause's words. The title's hover is "Go to this clause"; clicking scrolls the document to it. |
| 7 | Hover "N clause(s) not covered by your playbook." Then open **Standard and accepted** and hover a chip. | "Your playbook has no position for these kinds of clause, so nothing was checked against it." Each row is a chip and the clause's name; e.g. **Matches preferred**: "Compared with your playbook: this clause gives you what your preferred position asks for."; **Fallback**: "Compared with your playbook: this clause reaches only your fallback position. Your playbook allows it, but it is not what you open with." |
| 8 | `rv $C_NDA \| jq '{versionNumber, isCurrent, analysis: .analysis.kind, playbook: .playbook \| {name, why, explanation}, rec: .recommendation \| {label, text, reasons: [.reasons[].text]}, counts}'` | `versionNumber` 1, `isCurrent` true, `analysis` "done", `playbook.why` "default_for_type", `rec.text` matching the box, and `counts` matching the group sizes on screen. |
| 9 | `chk $C_NDA \| jq '{ready, reasons: [.reasons[].text]}'` | `ready` true only when `rec.label` is "ready_to_approve"; otherwise the reasons the label can't be Ready. |
| 10 | Search the page for the word "market" (Cmd-F / Ctrl-F), then `rv $C_NDA \| grep -ci market`. Look at the document's left margin. | No match on the page's Review section; the API prints 0. No MARKET or WEAK badges beside paragraphs. |
| 11 | Click **Open workspace** → the **Review** tab on the right. Click a finding's title. | The same panel. The document scrolls to the clause and outlines it for a moment. If its words changed since the analysis: a toast "Not found in the document" / "Its words may have changed since it was analysed." |

**Also check**
- viewer-a sees the panel with no action links and no **Fix all fixable** button.
- An older version: `curl -s "$API/contracts/$C_NDA/review?versionId=<an older version id>"` returns that version's findings with `isCurrent` false and every finding's `actions` empty.
- Another org: `rv $C_NDA $ADMIN_B` → `404` "Contract not found".
- A drafted contract with blanks still open is never **Ready to approve**, however clean its findings: the box is **Review** with "1 choice is still open in the draft (Governing Law)" or "N choices are still open in the draft (A, B, C and K more)", and `chk` has the reason code "open_choices" (d914067, E2E-DRF-04 step 6). An uploaded contract has no blanks, so this never applies to `$C_NDA`.

**Known limits**
- The status words are fixed (lib `REVIEW_STATUS_TEXT`): there is no "Aligned with market" or "Market" label anywhere. "Not covered by your playbook" means nothing was checked; it is not a pass.
- Findings judged by the model (the **AI** mark) can differ between runs; the deterministic ones (deleted, cut, not detected, unreadable, drafting) cannot.

### E2E-REV-11 · Regression: with Governing Law deleted and Exclusions cut, the recommendation is never "Ready to approve"

Bug report 7: "AI says Approve after Governing Law was deleted and Exclusions halved." Before: the approval agent got
"risk 0, no risks" from a contract nothing re-read, and the model chose Approve. Now: the analysed version is compared
with the one analysed before it; a deleted or cut clause is a finding with its words, and the label comes from rules.

**Covers:** /contracts/:id/workspace (edit, Save as version) · /contracts/:id (Review section, decision strip) · /approvals (inbox card) · analysis-checkpoint job · `GET /contracts/:id/review` · `GET /contracts/:id/checks` · `POST /contracts/:id/submit-approval` · `GET /contracts/:id/approval` · `POST /contracts/:id/findings/:findingId/insert-standard`
**Roles:** counsel-a · **Needs:** agents service + model key · **Time:** ~25 min

**Preconditions**
- E2E-REV-10 done: `$C_NDA` is v1 of `QA-NDA.txt`, analysed. The seed marks **Dispute Resolution** (which holds governing law) required for NDAs.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$C_NDA/workspace`. Select the whole of section **7. Governing Law** (from "7. Governing Law." to "…arising out of it.") and delete it. | The header says "Draft changes saved · not a version yet". |
| 2 | In section **3. Exclusions**, replace everything after "3. Exclusions." with `Confidential Information does not include information that is publicly available.` | Section 3 now has 11 words after its heading, down from about 75. |
| 3 | **Save as version**, What changed `Removed governing law, shortened exclusions`, **Save version**. Go **Back** to the contract page. | v2 exists. The amber banner "Analysis is for v1 — v2 has changes". The Review box: **Can't recommend**, reason "the document changed after it was analysed (analysis is for v1)". Never "Ready to approve". |
| 4 | Wait for the checkpoint (two minutes) and its analysis; reload. | Overview "Analysed · v2". The Review line "Compared with v1 (the version analysed before this one)." |
| 5 | Read **Needs attention**. | The first card: high severity, chip **Deleted since v1**, title "Governing Law — deleted since v1 (required)", "This clause was in v1 and is not in this version. Your playbook requires it for this type of contract." and an open **Deleted text** box with section 7's words struck through. Another card: chip **Changed since v1**, title "<clause name> — cut by NN% since v1" (NN about 80; the clause name is how analysis typed section 3, e.g. "Confidentiality"), "More than 30% of this clause's words were removed since v1. What is left may still read well; check what was taken out.", the new words quoted and a **Before** box with the old ones. |
| 6 | Read the recommendation box. | **Review** (or **Escalate** / **Needs exception** if other findings call for them), with bullets including "Governing Law — deleted since v1 (required)" and "<clause name> — cut by NN% since v1". Not "Ready to approve". |
| 7 | `chk $C_NDA \| jq '{ready, codes: [.reasons[].code], reasons: [.reasons[].text]}'` | `ready` false; `codes` include "required_deleted" and "clause_cut". |
| 8 | Send it for approval: `curl -s -X POST $API/contracts/$C_NDA/submit-approval -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{}' \| jq '{status, instanceId}'`, then `curl -s $API/contracts/$C_NDA/approval -H "Authorization: Bearer $COUNSEL_A" \| jq '.current \| {approvalRecommendation, recommendationReasons}'` | `201` with `status` "PENDING". `approvalRecommendation` is not "ready_to_approve" (expect "review"); `recommendationReasons` contains "Governing Law — deleted since v1 (required)". |
| 9 | Left rail → **Inbox** (/approvals), view **Needs my action**. Find the card for **QA Review NDA**. | The card reads "AI: Review — <first reason>". On the contract page, the decision strip above the document reads the same, and its hover lists every reason. Neither ever says "Ready to approve". |
| 10 | Back on the contract, on the **Governing Law — deleted…** card click **Insert standard language**. | A new version (v3) with your playbook's preferred Dispute Resolution wording ("Delaware or New York governing law. Exclusive jurisdiction in same state. …") added; the page reloads it. Two minutes later the deleted finding is gone and the recommendation's reasons no longer name Governing Law. |

**Also check**
- A clause that loses less than 30% of its words (or had under 20 words) is "<clause name> — changed since v1", not "cut".
- A deletion stays a finding on later versions while the clause stays gone: save v3 without restoring it (skip step 10) and the "deleted since" finding is carried forward.
- `POST /contracts/$C_NDA/findings/<deleted finding id>/insert-standard` on a version that is no longer current → `409` `code` "NOT_CURRENT", "This finding is not open on the version the contract stands on."
- A deleted clause that was still a blank in v1 (browser run, 7e085a9 and 8e6837e). Draft an NDA from a request that names no law (as E2E-DRF-04 steps 1–3), and without choosing in Origin delete the whole Governing Law section in the workspace; **Save as version**, wait for the analysis. One high card "Governing Law — deleted since v1 (required)" whose **Deleted text** box reads, in italics and not struck through, "Governing Law — was not filled in" (never the "[[Choose governing law: …]]" markup). A blank inside other words shows as "(not filled in)". No second card "Part of Governing Law deleted since v1" beside it, on this version or carried to later ones. The recommendation is **Review**; while other blanks remain it also says "N choices are still open in the draft (…)" (Governing Law is no longer among them: its blank is gone).

**Known limits**
- "Insert standard language" inserts the preferred position's text as the playbook states it. The seeded positions are written as guidance ("Delaware or New York governing law. …"), not as clause wording; edit it after inserting.
- The recommendation's first reason may be a guard such as "its risk score is unknown" when the analysis set no risk score; the deletion is still among the reasons.

### E2E-REV-12 · Regression: junk typed into a clause is flagged as text that doesn't read as language, and nothing says "Aligned with Market"

Bug report 5: "Junk text still 'Aligned with Market'." Before: a margin badge from a model that saw only the paragraph,
cached in the browser by its text, judged "boilerplate + junk" as market. Now: the badges are off, text added since the
version relied on is checked letter by letter (no model), and "market" is not a word the product uses.

**Covers:** /contracts/:id/workspace · /contracts/:id (Review section) · analysis-checkpoint job · `lib/unreadable-text.ts` · `GET /contracts/:id/review` · `GET /contracts/:id/checks` · `VITE_MARGIN_CLASSIFIER`
**Roles:** counsel-a · **Needs:** agents service + model key · **Time:** ~15 min

**Preconditions**
- E2E-PIPE-02 done: `$C_ST` stands on v2, analysed ("Analysed · v2").

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$C_ST/workspace`. At the end of section 8 (after "…prior written consent.") type ` asdfgh qwerty zxcvbn lkjhgf`. Then press Enter after section 8 and type a paragraph of its own: `qwerty asdfgh`. | "Draft changes saved · not a version yet". |
| 2 | **Save as version**, What changed `Typing test`, **Save version**; **Back**. Wait for the checkpoint and its analysis (about three minutes). | "Analysed · v3". |
| 3 | Read **Needs attention**. | A high-severity card, chip **Doesn't read as text**, title "Text that doesn't read as language in <clause name>" (section 8's clause as analysis typed it), "Text added since v2 doesn't read as words (“asdfgh”, “qwerty”, “zxcvbn”, “lkjhgf”). Remove it or rewrite it before this goes anywhere.", quoting the junk. A second such card titled "Text that doesn't read as language" (the paragraph outside any clause). Section 8 is also "<clause name> — changed since v2". |
| 4 | Hover the **Doesn't read as text** chip. | "Text added since v2 is not made of words (a check on the letters, not AI). It may be typing by mistake." There is no **AI** mark on these cards. |
| 5 | `chk $C_ST \| jq '[.reasons[].code]'`; read the recommendation box. | Codes include "unreadable_text"; the box is **Review** (or worse) with "Text that doesn't read as language in <clause name>" among the bullets. Never "Ready to approve". |
| 6 | Search the contract page for "market" and "aligned"; `rv $C_ST \| grep -ciE 'market\|aligned'`. Look at the document margins in the workspace and on the contract page. | Nothing on the page; the API prints 0. No MARKET, WEAK or other badges beside paragraphs. |
| 7 | Remove both junk runs, save as version `Remove typing`, wait for the analysis. | "Analysed · v4". The unreadable cards are gone. Section 8 shows "<clause name> — changed since v3" (the junk was taken out of it). |

**Also check**
- Real words aren't flagged: add `The Parties may sign this Agreement in counterparts.` instead, and the finding is "New text added since vN" or a changed clause, never "doesn't read as language". Acronyms (GDPR, HIPAA), numbers and section references are never junk.
- With `VITE_MARGIN_CLASSIFIER=on` in `.env` and the web app restarted, the old margin badges come back (MARKET "In line with common market practice"). That is the only way to see them; leave it off.

**Known limits**
- The check reads only text added since the version relied on: junk already in v1 of an upload is not flagged.
- Text is junk when at least two of its words can't be words and they are 30% of it, or it is eight words or more with none of the small words every sentence has and some junk. A single long mashed word (six letters or more) on its own counts too.

### E2E-REV-13 · Regression: an untouched clause from our template is "Standard", and changing one word sends only that clause to review

Bug report 2: "An untouched Purpose clause called weak." Before: the only verdict was a margin badge from a model that
didn't know the text was ours. Now: drafting stamps each section with a fingerprint; analysis matches the clauses to it,
and a clause still as the template wrote it is **Standard** and is not sent to a model.

**Covers:** /contracts/:id (Review → Standard and accepted) · /contracts/:id/workspace · `lib/fingerprint.ts` · review-findings service · `GET /contracts/:id/review` · `GET /templates/:id/lint`
**Roles:** counsel-a · **Needs:** agents service + model key · **Time:** ~15 min

**Preconditions**
- `$C_NY1` (E2E-DRF-05, re-analysed in E2E-PIPE-04) is a Mutual NDA draft, unedited, "Analysed · v1".

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$C_NY1`; in **Review** click **Standard and accepted (N)**. Hover the chip on the Purpose clause's row. | The rows list the template's clauses with the chip **Standard**. The hover: "From template Mutual Non-Disclosure Agreement v2, unchanged. Text identical to your approved template or clause library is not sent to AI for an opinion." The Governing Law row's hover begins "From your clause library (v1), unchanged." |
| 2 | Read **Needs attention**. | No card about Purpose. Nothing labelled weak, market or non-standard. No **Not detected** card "Term & Termination — not detected": the seeded Mutual NDA's "Term and Termination" section is read as that clause, and "Period of Confidentiality" as confidentiality (9c0f2fc; on an org seeded before it, see E2E-DRF-04 Known limits). |
| 3 | `rv $C_NY1 \| jq '[.clauses[] \| {clauseLabel, reviewStatus, provenance}]'` | The template's clauses have `reviewStatus` "standard" and `provenance` "template" (the governing-law clause: "library"). |
| 4 | Open the workspace. In the Purpose section change "wish to share certain" to `wish to exchange certain`. **Save as version** (`Purpose wording`), **Back**, wait for the checkpoint and its analysis. | "Analysed · v2". |
| 5 | Read the Review section and `rv $C_NY1 \| jq '{baseline: .baseline.versionNumber, needs: [.groups.needsAttention[].title], std: [.clauses[] \| select(.reviewStatus=="standard") \| .clauseLabel]}'` | One new card, "<Purpose clause name> — changed since v1", chip **Changed since v1**, with the new words and a **Before** box. Every other template clause is still **Standard**. `baseline` 1. |
| 6 | Templates → edit **Mutual Non-Disclosure Agreement**. | **Against your playbook**: "Agrees with your playbook." (its confidentiality term is 5 years, the playbook's preferred; E2E-DRF-02 shows a template that disagrees). |

**Also check**
- A clause from the template with a variable filled (the parties' names, the purpose) is still Standard: variables are compared as placeholders.
- An uploaded contract (no template) never shows "Standard"; its clauses are judged against the playbook (E2E-REV-10).
- A filled-in blank is not a deletion. On `$C_NOLAW` (E2E-DRF-04, Governing Law chosen in Origin, so v2): no card "Part of Governing Law deleted since v1" (regression 0e83fdd: choosing New York for the blank showed as deleted text); the Governing Law row is under **Standard and accepted**.
- The purpose filled into the template ("in connection with evaluating a 12-month data-sharing pilot…") is a variable, so Purpose stays **Standard**: the change from "evaluate" to "evaluating" (c66e521) is made before the draft is written, not by an edit.

**Known limits**
- A template whose own text is a fallback position is flagged once, in the template builder (E2E-DRF-02), not on every contract drafted from it. A contract drafted from it shows those clauses as Standard.
- Reformatting a section (new paragraph breaks) without changing words keeps it Standard; moving a sentence to another section does not.

### E2E-REV-14 · Acting on a finding: accept as is, mark resolved, reopen, redline to your position, and fix all fixable with a preview

**Covers:** /contracts/:id (Review section) · `POST /contracts/:id/findings/:findingId/accept` · `…/resolve` · `…/reopen` · `…/redline` · `…/redline/apply` · `POST /contracts/:id/review/fix-all` · playbook-redline job · FixPreview apply
**Roles:** counsel-a, contracts-a, viewer-a, admin-b · **Needs:** agents service + model key · **Time:** ~25 min

**Preconditions**
- `QA-NDA.txt` made. A version whose confidentiality survives only one year (your playbook's walk-away is two years or less):
  `sed 's/survive for five years after this Agreement ends, and for trade secrets for as long as they remain trade secrets/survive for one year after this Agreement ends/' ~/qa-docs/QA-NDA.txt > ~/qa-docs/QA-NDA-WEAK.txt`
- `export C_WEAK=$(upload ~/qa-docs/QA-NDA-WEAK.txt text/plain "QA Weak NDA" "Initech Solutions"); waitdone $C_WEAK` → `DONE`. Signed in as counsel-a.
- Save a finding id that offers a rewrite: `export F_RL=$(rv $C_WEAK \| jq -r '[.groups.needsAttention[] \| select(.actions \| index("redline"))][0].id')`. If it prints `null`, the model judged every clause acceptable this run: upload again, or use E2E-REV-11's v2 cut finding.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$C_WEAK` → **Review**. | **Needs attention** lists the model's verdicts (marked **AI**), among them the confidentiality/term clause with a chip such as **Doesn't meet your positions** or **Needs approval**. Above the groups: **Fix all fixable (N)** and "AI drafts a rewrite for each; you see every change before anything is applied." |
| 2 | On the card for `$F_RL`, click **Redline to your position**. | After a few seconds a box "Proposed rewrite" (AI mark) with the rewritten clause and the reason, and **Apply as a new version** / **Discard**. Nothing has changed in the document yet. |
| 3 | Click **Apply as a new version**. | v2 is created with the rewrite; the document shows it. Two minutes later v2 is analysed and that clause's card is gone or changed. |
| 4 | Apply the same rewrite again by API: `curl -s -X POST $API/contracts/$C_WEAK/findings/$F_RL/redline/apply -H "Authorization: Bearer $COUNSEL_A" \| jq` | `409`, one of: "The document changed after this rewrite was drafted. Ask for a new one." (`STALE_REDLINE`), or, once v2 is analysed, "There is no rewrite for this finding to apply. Ask for one first." (`NOT_STAGED`) or "This finding is about an older version. Decide on the version the contract stands on." (`NOT_CURRENT`). |
| 5 | After v2 is analysed, click **Fix all fixable (N)**. | The button reads "Drafting fixes…". Then a preview: "N change(s) drafted. Accept the ones you want; nothing changes until you apply them.", each with **Current** and **Proposed** text, a tick per change ("Accept this change"), **Accept all** and **Apply 0 changes**. Clauses that couldn't be rewritten are listed: "1 clause could not be rewritten (…). Fix it by hand." |
| 6 | Tick one change, then click **Apply 1 change**. | A new version with only that change. The preview disappears; the review re-runs on the new version after the checkpoint. |
| 7 | On another open card, click **Accept as is**, type `QA: acceptable for a pilot` in "Why it's acceptable (optional)", click **Accept as is**. | The card leaves **Needs attention**. Under **Standard and accepted** it shows the chip **Accepted as is** (hover: "A person looked at this and accepted it as it is."), its title and "— QA: acceptable for a pilot", with **Reopen**. The recommendation is worked out again without it. |
| 8 | Click **Reopen** on it. Then on another card click **Mark resolved**. | The first card is back in **Needs attention**. The second moves to **Standard and accepted** with the chip **Resolved** ("This was dealt with."). |
| 9 | Decide the resolved finding again: `F=$(rv $C_WEAK \| jq -r '.groups.accepted[0].id'); curl -s -X POST $API/contracts/$C_WEAK/findings/$F/resolve -H "Authorization: Bearer $COUNSEL_A" \| jq; curl -s -X POST $API/contracts/$C_WEAK/findings/$(rv $C_WEAK \| jq -r '.groups.needsAttention[0].id')/reopen -H "Authorization: Bearer $COUNSEL_A" \| jq` | `409` `{"code":"ALREADY_DECIDED","detail":"This finding was already dealt with."}`; then `409` `{"code":"ALREADY_OPEN","detail":"This finding is open."}`. |

**Also check**
- Roles: accepting as is needs `edit:playbook`. contracts-a (Contract Manager) gets `403` "Missing permission: edit:playbook" from `…/accept` but may **Mark resolved** (edit:contract). viewer-a sees no action links; `…/resolve` → `403` "Missing permission: edit:contract".
- `POST /contracts/$C_WEAK/review/fix-all` while fixes are being drafted → `409` "Fixes are already being drafted for this contract."; on a contract with nothing to rewrite → `409` `code` "NOTHING_TO_FIX", "No open finding here can be fixed by a rewrite."
- Another org: admin-b on any of these routes → `404` "Contract not found" (or "Finding not found").
- Audit: each accept, resolve and reopen writes `REVIEW_FINDING_DECIDED` on the contract.
- **Request exception** on a finding sends it to the category's clause approver; E2E-APR (docs/44 §3) tests it.

**Known limits**
- A rewrite is drafted by a model and judged by a person before it applies; nothing here applies a rewrite unseen.
- Accept, resolve and reopen act only on the version the contract stands on; findings of older versions are read-only.

### E2E-REV-15 · Regressions: the playbook a contract is reviewed against is named, chosen by rule, never "fails to fetch", and there is one panel

Bug report 3: "'Fetch playbook' failing with a generic error." Before: "Redline against playbook" answered 400 "Contract
has no current version to redline" on a request draft, the button just reset, and on a contract with no clauses it said
"No clause deviated from the playbook". Bug report 8: "Two playbook panels" (Playbook review and Playbook redline, two
engines that could disagree). Now: one Review panel over one set of findings, a named **Playbook** chosen by rule, and a
panel that says when there is no analysis to judge.

**Covers:** /playbook (playbook picker, Manage playbooks) · /contracts/:id (Review section) · `GET /contracts/:id/playbook` · `PUT /contracts/:id/playbook` · `GET /playbook/playbooks` · `POST /playbook/playbooks` · `PATCH /playbook/playbooks/:id` · `DELETE /playbook/playbooks/:id` · `GET /contracts/:id/review` · `GET /contracts/:id/checks`
**Roles:** legalops-a, counsel-a, viewer-a, admin-b · **Needs:** nothing extra (the contracts were analysed earlier) · **Time:** ~20 min

**Preconditions**
- `$C_NDA` (E2E-REV-10/11) analysed; `$C_JUNK` (E2E-PIPE-03) failed with no clauses. legalops-a signed in.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `curl -s $API/contracts/$C_NDA/playbook -H "Authorization: Bearer $COUNSEL_A" \| jq '{name: .playbook.name, why, explanation, positionCount, contractType}'` | `name` "Default playbook", `why` "default_for_type", `explanation` "Using Default playbook, the default for NDA contracts.", `positionCount` more than 0, `contractType` "NDA". |
| 2 | Left rail → **Playbook**. Under the heading, the playbook picker, then click its gear (**Manage playbooks**). | Picker "Default playbook" and the line "Default for all contract types · version N". The dialog **Playbooks**: "A contract is checked against the playbook chosen on it, otherwise the default for its type, otherwise the only playbook that covers its type. If several could apply and none is the default, the contract asks which to use." |
| 3 | **New playbook**: name `QA Sales NDA playbook`, click the **NDA** type chip, leave "Default for these types" unticked, **Create**, **Done**. Then step 1's call again. | `explanation` "2 playbooks apply — using Default playbook (the default for NDA contracts)." The Review panel on `$C_NDA` shows the same line. |
| 4 | Manage playbooks → on **Default playbook** untick "Default for all types", **Save**. Reload `$WEB/contracts/$C_NDA`. | The Review panel's playbook line: "2 playbooks cover NDA contracts and none is the default. Choose one for this contract." with a picker "Choose…" listing both. `GET …/playbook` → `why` "ambiguous". |
| 5 | Choose **QA Sales NDA playbook** in that picker. | The line becomes "Using QA Sales NDA playbook, chosen for this contract." That playbook has no positions, so the clause rows count as "not covered by your playbook". Audit: `PLAYBOOK_CHANGED` with `from` null and `to` its id. |
| 6 | Put things back: `curl -s -X PUT $API/contracts/$C_NDA/playbook -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{"playbookId":null}' \| jq .why`; tick "Default for all types" on Default playbook again; delete QA Sales NDA playbook (`DELETE /playbook/playbooks/<id>` as admin-a). | "ambiguous" (until the default is back); then step 1 reads as at first; the delete answers `204`. |
| 7 | Open `$WEB/contracts/$C_JUNK` → **Review**. | The grey line "The analysis failed while finding and indexing its clauses. No clauses were found in the document." with **Analyse now** (the stored error is no longer shown as it was, 0b15b77). The box **Can't recommend**, reason "its analysis failed". No "Nothing needs attention.", no **Fix all fixable** and no false all-clear anywhere. |
| 8 | `rv $C_JUNK \| jq '{analysis: .analysis.kind, rec: .recommendation.text, reasons: [.recommendation.reasons[].text], playbook: .playbook.explanation}'` | `analysis` "failed", `rec` "Can't recommend", `reasons` including "its analysis failed", and the playbook line answered normally ("Using Default playbook, the default for OTHER contracts." or the type it was given). |
| 9 | One panel: on `$C_NDA` list the rail's section titles (or `document.querySelectorAll('[data-testid=review-panel]').length` in the console). Then compare the two read paths: `chk $C_NDA \| jq -r '.findings[].title' \| sort` and `rv $C_NDA \| jq -r '[.groups.needsAttention[], .groups.notDetected[], .groups.accepted[]][] \| select(.kind != "drafting" and .kind != "compliance") \| .title' \| sort` | Exactly one **Review** section (and one `review-panel`); no "Playbook review" or "Playbook redline". The two lists are the same: the checks and the panel read the same findings. |

**Also check**
- A failed action in the panel shows the server's words in red under its card, never a bare "failed" (e.g. the 409s of E2E-REV-14). Through the API, `POST …/findings/<id>/insert-standard` on a finding whose category has no preferred or acceptable position → `409` `code` "NO_STANDARD_LANGUAGE", "Your playbook has no preferred wording for this clause to insert." (the panel doesn't offer the link then). A failed action with no handler of its own shows the server's `detail` in a red toast.
- `PUT /contracts/$C_NDA/playbook` with `{"playbookId":"nope"}` → `404` "Playbook not found". As viewer-a → `403` "Missing permission: edit:contract".
- `DELETE /playbook/playbooks/<Default playbook id>` → `409` `code` "HAS_POSITIONS", "Move or delete this playbook’s positions first."
- Another org: admin-b `GET /contracts/$C_NDA/playbook` → `404` "Contract not found"; admin-b's playbook list has only Org B's.
- The API log has one `playbook.resolve` line per resolution with the contract, the type and `why`.

**Known limits**
- "No playbook covers NDA contracts" (with **Set one up**) can only happen when no all-types playbook exists; a seeded org always has Default playbook.
- Choosing another playbook changes what the panel counts as covered at once, but the findings judged by the model are those of the last analysis; analyse again to have them judged against the new playbook.

### E2E-REV-16 · Presence rules: set on the Playbook page, a required clause not detected, a clause not allowed, and tagging the clause the analysis missed

**Covers:** /playbook (Rules for this clause) · /contracts/:id (Review → Not detected, Needs attention) · `PATCH /playbook/categories/:id/rules` · `PATCH /clauses/categories/:id` (presence) · `GET /clauses/categories` · `POST /contracts/:id/findings/:findingId/tag` · `POST /contracts/:id/findings/:findingId/accept` (refused) · `GET /contracts/:id/checks`
**Roles:** legalops-a, counsel-a, contracts-a · **Needs:** agents service + model key · **Time:** ~20 min

**Preconditions**
- `~/qa-docs/QA-NDA-NOLAW.txt` made (no Governing Law; a fee clause added). counsel-a signed in.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As legalops-a: left rail → **Playbook**. In the category list click **Fees & Payment**. Read the box **Rules for this clause** above its positions. | Radios **Required**, **Not allowed**, **Optional** (Optional chosen, "Don’t flag it either way."), and "Decides exceptions" with its current choice. **Save rule** is disabled until something changes. |
| 2 | Click **Not allowed**. Under "Contract types it applies to (none picked: all types)" click **NDA**. **Save rule**. | Help line "Flag a contract that has this clause." Toast "Rule saved", "Open contracts are checked against it the next time their review is opened." Check: `export FEES_CAT=$(curl -s $API/clauses/categories -H "Authorization: Bearer $LEGALOPS_A" \| jq -r '.. \| objects \| select(.name?=="Fees & Payment") \| .id' \| head -1); curl -s $API/clauses/categories -H "Authorization: Bearer $LEGALOPS_A" \| jq '.. \| objects \| select(.id?=="'$FEES_CAT'") \| {name, presence, presenceContractTypes}' \| head -5` → `"presence":"not_allowed"`, `"presenceContractTypes":["NDA"]`. |
| 3 | `curl -s $API/clauses/categories -H "Authorization: Bearer $LEGALOPS_A" \| jq '[.data[] \| select(.presence=="required") \| {name, presenceContractTypes}]'` | The seeded rules: **Term & Termination** and **Dispute Resolution** for the stand-alone types (NDA, MSA, VENDOR_AGREEMENT, LICENSE, PARTNERSHIP, SLA, EMPLOYMENT, DATA_PROCESSING), **Confidentiality** for NDA, **Limitation of Liability** for MSA, VENDOR_AGREEMENT and LICENSE. |
| 4 | `export C_NOLAW_UP=$(upload ~/qa-docs/QA-NDA-NOLAW.txt text/plain "QA NDA without law" "Initech Solutions"); waitdone $C_NOLAW_UP`; open it. | `DONE`. |
| 5 | Read **Not detected**. Hover the chip. | **Not detected (1)**: chip **Not detected**, title "Dispute Resolution — not detected", "Your playbook requires this clause in this type of contract, and none was found. Find it in the document and tag it, or confirm it's missing." Links: **Find it in the document**, **Insert standard language**, **Request exception**, **Mark resolved**; no **Accept as is**. Hover: "Your playbook requires this clause and none was found. It may be there under another heading: find it and tag it, or confirm it is missing." |
| 6 | Read **Needs attention** and the recommendation. | A high-severity card, chip **Not allowed** (hover "Your playbook does not allow this clause in this type of contract."), title "<the fee clause's name> — not allowed in this type of contract", quoting "Initech will pay Acme a fee of USD 5,000 …". The box: **Escalate** (hover: "A clause goes past a position your playbook says you walk away from, or one it does not allow. Do not proceed without escalating.") with that title among the reasons. |
| 7 | `chk $C_NOLAW_UP \| jq '{ready, codes: [.reasons[].code], texts: [.reasons[].text]}'` | `ready` false; `codes` include "required_missing" and "not_allowed_present"; `texts` include "Dispute Resolution was not detected (required)". |
| 8 | Try to accept the missing clause as is: `F=$(rv $C_NOLAW_UP \| jq -r '.groups.notDetected[0].id'); curl -s -X POST $API/contracts/$C_NOLAW_UP/findings/$F/accept -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{}' \| jq` | `409` `{"code":"NEEDS_EXCEPTION","detail":"A required clause can’t be accepted as missing: tag it if it is there, or ask for an exception."}` |
| 9 | Tag it. In the panel click **Find it in the document**; in "Paste the clause's words from the document" paste `Neither Party may assign it without the other Party's prior written consent.` (any words of the document work for this test; in real use, the clause the analysis missed); click **Tag as this clause**. | The **Not detected** group disappears; the recommendation is worked out again without "Dispute Resolution was not detected (required)". Audit: `CONTRACT_UPDATED` with `metadata.source` "clause_tag" and the clause type. |
| 10 | Tag again by API: `curl -s -X POST $API/contracts/$C_NOLAW_UP/findings/$F/tag -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{"text":"anything"}' \| jq` | `409` `{"code":"NOT_TAGGABLE","detail":"Only a required clause that was not detected is found by tagging it."}` |
| 11 | Put the rule back on the Playbook page: **Fees & Payment** → **Optional** → **Save rule**. Then, without analysing again, reload `$C_NOLAW_UP`'s **Review**. | Toast "Rule saved". The review is worked out again on this read: the **Not allowed** card is gone and the recommendation no longer escalates for it (`chk $C_NOLAW_UP \| jq '[.reasons[].code]'` has no "not_allowed_present"). |

**Also check**
- Rules apply only to the types they name: an SOW (not in the stand-alone list) without a governing-law clause has no "not detected" finding.
- An amendment or exhibit linked to its agreement is never asked for the agreement's required clauses, whatever its type (browser run, a1b300f: a one-line amendment to an MSA had "Term & Termination — not detected", "Limitation of Liability — not detected" and "Dispute Resolution — not detected"). After E2E-AMD-02, `rv $AMD \| jq '[.groups.needsAttention[].title, .groups.notDetected[]?.title] \| map(select(test("not detected")))'` prints `[]`.
- A required clause that was in the version relied on and is now gone is "deleted since vN (required)" instead of "not detected" (E2E-REV-11); the two never show for the same category.
- `PATCH /clauses/categories/$FEES_CAT` with `"presence":"forbidden"` → `422` "Request body failed validation". As contracts-a → `403` "Missing permission: edit:clause".
- contracts-a (view only) on **Playbook** → **Fees & Payment**: the box shows one line, e.g. "Optional — contracts are
  not checked for it." or "Not allowed in NDA.", with no buttons. `curl -s -X PATCH $API/playbook/categories/$FEES_CAT/rules -H "Authorization: Bearer $CONTRACTS_A" -H 'content-type: application/json' -d '{"presence":"required"}'` → `403` "Missing permission: edit:playbook".
- `-d '{"presence":"forbidden"}'` as legalops-a → `400` "Presence is required, not allowed or optional; contract types are a list of names." Naming both a person and a role → `400` "Name a person or a role to decide exceptions, not both." Another org's category id → `404` "Category not found".
- A signed contract keeps the findings it was signed with: a rule change does not re-review it.
- Audit: `PLAYBOOK_CHANGED` on the `clause_category` with `metadata.presence` and `metadata.presenceContractTypes`.

**Known limits**
- A rule is per clause category, with the contract types it applies to; it is not per playbook. Open contracts pick a
  change up only when their review is next read, not all at once.
- "Not detected" is only as good as clause detection, so it is worded as not detected, and on its own it makes the recommendation **Review**, never **Escalate**.
- Tagging takes any words you paste as the clause; it doesn't check that they are a governing-law clause.

### E2E-CMP-10 · Which compliance frameworks apply is worked out from quoted facts, asked once when unsure, and its gaps are review findings

Bug report 9: "Choosing compliance frameworks." Before: the rail checked all four of GDPR, HIPAA, SOX and CCPA on a
click, and a lawyer had to know which applied. Now: the analysis reads facts with quotes; the org's rules decide what
applies and say why; an unsure fact is asked once; the checks of what applies run as part of the analysis.

**Covers:** /contracts/:id (Compliance section, Review → Compliance) · compliance-review job · `GET /contracts/:id/compliance/applicability` · `POST /contracts/:id/compliance/facts/extract` · `POST /contracts/:id/compliance/facts/confirm` · `POST /contracts/:id/compliance/frameworks` · agents compliance facts and checks
**Roles:** counsel-a, viewer-a, admin-b · **Needs:** agents service + model key · **Time:** ~25 min

**Preconditions**
- `$C_NDA` analysed (E2E-REV-10). `QA-DPA-EU.txt` and `QA-DPA-NOWHERE.txt` made. Org A on the default compliance rules (E2E-CMP-11 changes them; run it after this one).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$C_NDA`; find the **Compliance** section in the rail. | "No compliance frameworks apply (no personal or regulated data found)." Below, a collapsed "Doesn’t apply: GDPR, UK GDPR, HIPAA, CCPA / CPRA, SOX, PCI DSS"; opened, each lists the facts that rule it out (e.g. "Personal data: no (not found in the text)", or a quote). An **Add a framework…** picker with **Add**. No question box. |
| 2 | `curl -s $API/contracts/$C_NDA/compliance/applicability -H "Authorization: Bearer $COUNSEL_A" \| jq '{factsReadAt, question, applies: [.frameworks[] \| {framework, applies}]}'` | `factsReadAt` set (the analysis read the facts), `question` null, every framework `applies` "no". |
| 3 | `export C_DPA=$(upload ~/qa-docs/QA-DPA-EU.txt text/plain "QA DPA Payroll Cloud" "Payroll Cloud Ltd"); waitdone $C_DPA`; give the compliance step a minute more; open it. | The Compliance section: **GDPR** "applies because:" with quoted words from the contract, such as “Supplier will process Customer's employee personal data, namely names, home addresses, bank account numbers and salary details of Customer's employees in Germany and France…”. Under it, a badge (**compliant**, **gaps** or **non-compliant**) and "N to fix" or "all requirements met"; click it to see each requirement with a dot and its finding. **UK GDPR** and **CCPA / CPRA** are under "Doesn’t apply". |
| 4 | In **Review**, open the **Compliance** group (present when a check found a gap). Hover a card's chip and its **AI** mark; open **Why it applies**. | Cards titled "GDPR: <requirement> — missing", "— partly met" or "— at risk". Chip **Compliance gap**: "A requirement of a compliance framework that applies to this contract (see Compliance), which AI found missing, partly met or at risk in the words it read. A high one needs a person to look before approval." AI mark: "Checked by AI against the framework’s requirements, with the words it relied on." **Why it applies** quotes the fact. A high one is among the recommendation's reasons; medium and low ones are not. |
| 5 | `export C_NEWS=$(upload ~/qa-docs/QA-DPA-NOWHERE.txt text/plain "QA Newsletter Mailwise" "Mailwise"); waitdone $C_NEWS`; a minute more; open it. | An amber question box, one of: "Where are the people whose personal data is involved?" with choices **EU / EEA**, **United Kingdom**, **California**, **Elsewhere in the US**, **Elsewhere**, then **Save** and **Not sure**; or "Where are the parties based?" with the same choices. GDPR, UK GDPR and CCPA / CPRA are listed "may apply" with "Not known yet: …". |
| 6 | If the question is about the people: click **California**, then **Save**. (About the parties: answer **Elsewhere in the US** and **Save**; the next question is then about the people. Answer it the same way.) | The box goes. **CCPA / CPRA** "applies because:" with "Personal data" quoted and "Where the people in the data are: California (you answered)". Its checks start ("Checking…") and show a result within a minute. GDPR and UK GDPR move to "Doesn’t apply". |
| 7 | `curl -s $API/contracts/$C_NEWS/compliance/applicability -H "Authorization: Bearer $COUNSEL_A" \| jq '[.frameworks[] \| select(.applies=="yes") \| {framework, because: [.because[] \| {key, confirmed}]}]'` | CCPA with a `data_subject_regions` fact whose `confirmed` is true. Audit: `COMPLIANCE_FACT_CONFIRMED` with `key` "data_subject_regions". |
| 8 | Back on `$C_NDA`: **Add a framework…** → **GDPR** → **Add**. | "Checking…", then **GDPR** "added by hand" in the applying list with its check results. The **Doesn’t apply** list no longer has GDPR. |
| 9 | Change `$C_NDA`'s text (save a version with one word changed) and reopen before the checkpoint analysis runs. | "The text changed since this was worked out." with **Update**. After the checkpoint analysis it reads again on its own. |

**Also check**
- An answer of the wrong shape is refused: `POST /contracts/$C_NEWS/compliance/facts/confirm` with `{"key":"personal_data","value":"maybe"}` → `422` with the reason in `detail`. An unknown key → `422` "Request body failed validation".
- viewer-a sees the section with no question box, no **Add** and no **Work out what applies**; `POST …/compliance/frameworks` → `403` "Missing permission: edit:contract".
- A contract whose facts were never read (a contract analysed before this change) shows "Not worked out yet. The AI reads the contract for personal, health, payment card and financial-reporting data, quotes what it finds, and checks the rules that apply." with **Work out what applies**.
- Another org: admin-b `GET /contracts/$C_DPA/compliance/applicability` → `404` "Contract not found".
- A failed check never loses the answer: with the agents service stopped, answering still saves (the framework shows "Not checked yet." with **Check now**).

**Known limits**
- The facts are read by a model; the quote shows what it relied on. The rules that turn facts into frameworks are not a model's (E2E-CMP-11).
- The question asks one fact at a time, the one a rule needs first.
- There are six frameworks: GDPR, UK GDPR, HIPAA, CCPA / CPRA, SOX and PCI DSS.

### E2E-CMP-11 · Admins set once when each framework applies, in Admin → Organization → Compliance

**Covers:** /admin/org (Compliance tab) · `GET /compliance-policy` · `PUT /compliance-policy` · `DELETE /compliance-policy` · `GET /contracts/:id/compliance/applicability` · `POST /contracts/:id/compliance/facts/confirm`
**Roles:** admin-a, counsel-a, legalops-a, admin-b · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- E2E-CMP-10 done (`$C_NEWS`: personal data quoted; where the people are answered "California"). admin-a signed in.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Admin → **Organization** → tab **Compliance**. | **When compliance frameworks apply**: "The AI reads each contract for facts (personal data, where the people are, health data, card data, financial reporting) and quotes them. These rules turn the facts into the frameworks a contract is checked against. A framework applies when every fact in one of its rules holds. These are the default rules." A table **Framework** / **Applies when** with a switch and a remove button per row: GDPR "Personal data and Where the people in the data are: EU / EEA"; GDPR "Personal data and Where the parties are: EU / EEA"; the same two for UK GDPR with "United Kingdom"; HIPAA "Health information and US healthcare provider, plan or their business associate"; CCPA / CPRA "Personal data and Where the people in the data are: California"; SOX "Affects financial reporting and A party is a public company"; PCI DSS "Payment card data". |
| 2 | Under **Add a rule**: Framework **GDPR**, "applies when" Fact **Personal data**, **+ Condition**; Fact (now "and…") **Where the parties are**, tick **Elsewhere in the US**, **+ Condition**; **Add rule**. Then **Save rules**. | A new row "GDPR · Personal data and Where the parties are: Elsewhere in the US". Toast "Compliance rules saved". The sentence "These are the default rules." is gone. |
| 3 | Answer the parties' place on the newsletter contract: `curl -s -X POST $API/contracts/$C_NEWS/compliance/facts/confirm -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{"key":"party_jurisdictions","value":["US"]}' >/dev/null; curl -s $API/contracts/$C_NEWS/compliance/applicability -H "Authorization: Bearer $COUNSEL_A" \| jq '[.frameworks[] \| select(.applies=="yes") \| .framework]'` | `["GDPR","CCPA"]` (order aside): GDPR now applies under the org's own rule. On the contract's Compliance section GDPR shows "applies because:" with the personal-data quote and "Where the parties are: the US (you answered)". |
| 4 | Back in the Compliance tab, switch the new rule off (its switch: "Rule for GDPR on"), **Save rules**. Repeat step 3's second call. | `["CCPA"]` only. |
| 5 | Click **Default rules**. | Toast "Back to the default rules"; the table is the eight defaults and "These are the default rules." is back; **Default rules** is greyed out. |
| 6 | `curl -s $API/compliance-policy -H "Authorization: Bearer $ADMIN_A" \| jq '{isDefault, rules: (.rules \| length), frameworks: [.frameworks[].id]}'` | `isDefault` true, `rules` 8, the six framework ids. |
| 7 | Refusals: `curl -s -X PUT $API/compliance-policy -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"rules":[{"id":"a","framework":"GDPR","enabled":true,"when":[{"fact":"personal_data","op":"is_true"}]},{"id":"a","framework":"SOX","enabled":true,"when":[{"fact":"public_company","op":"is_true"}]}]}' \| jq .detail`; then with `"op":"includes_any"` and no `values`. | `422` "Each rule needs its own id"; then `422` "Invalid rules". |

**Also check**
- Roles: counsel-a and legalops-a can read the rules (`GET /compliance-policy`) but `PUT` and `DELETE` answer `403` "Missing permission: configure:contract".
- Another org: admin-b's rules are Org B's own (`isDefault` true) whatever Org A saved.
- Audit: saving and resetting the rules write `COMPLIANCE_POLICY_UPDATED`.

**Known limits**
- A rule's facts are all "and"; a framework with several rules applies when any one holds. There is no "or" inside a rule.
- Changing the rules changes what applies the next time a contract's applicability is read; checks for a framework that newly applies run when someone opens the contract's Compliance section and clicks **Check now** or **Update**, or at its next analysis.

### E2E-CMP-12 · Regression: defined-term problems are review findings under Drafting, and hovering a term shows its definition

Bug report 10: "Defined terms." Before: a browser regex that matched straight quotes only (so most Word files showed
nothing), checked only capitalisation, saved nothing and had its own rail. Now: five deterministic checks run on each
analysed version and are findings under **Drafting** in the Review panel, with the glossary beneath and the definition on
hover in the document.

**Covers:** /contracts/:id (Review → Drafting, Defined terms list, document hover) · `GET /contracts/:id/defined-terms` · analysis `drafting` step · `lib/defined-terms.ts` · `GET /contracts/:id/review` · `GET /contracts/:id/checks`
**Roles:** counsel-a, viewer-a, admin-b · **Needs:** agents service + model key (steps 3–7; steps 1–2 need nothing) · **Time:** ~15 min

**Preconditions**
- `~/qa-docs/QA-TERMS.txt` made (curly quotes, as copied). counsel-a signed in.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `export C_TERMS=$(upload ~/qa-docs/QA-TERMS.txt text/plain "QA Defined terms MSA" "Beta Retail Ltd")`; wait 10 s for the text to be read. | An id. |
| 2 | `curl -s $API/contracts/$C_TERMS/defined-terms -H "Authorization: Bearer $COUNSEL_A" \| jq '{terms: [.glossary[].term], issues: [.issues[] \| {kind, term, message}]}'` | `terms` include Affiliate, Confidential Information, Exclusions, Fees and Services (curly quotes read). `issues`, five: `unused_definition` "“Exclusions” is defined but not used."; `duplicate_definition` "“Fees” is defined twice, in different ways."; `used_before_defined` "“Services” is used before it is defined."; `capitalisation_drift` "“confidential information” should be written “Confidential Information”, its defined form."; `undefined_term` "“Deliverables” is capitalised like a defined term but is never defined." Nothing about Agreement, Schedule, Section, Delaware, Acme Corporation, United States, Data Protection Act, March, Definitions, LIMITATION OF LIABILITY or Neither. |
| 3 | `waitdone $C_TERMS`; open it; in **Review** find **Drafting**. | **Drafting (5)** with one card per problem, each with the chip **Drafting** and the sentence above as its title, quoting where it is. The **Fees** card has **Its definition** (the other definition); the **Exclusions** card quotes its definition. |
| 4 | Hover a **Drafting** chip; read the recommendation box. | "How the contract is written: a term used but never defined, defined twice or not used, used before its definition, or written in another case. Found by a check on the words, not AI. It does not hold back approval." The recommendation's reasons don't mention any of the five; the Review section's count doesn't include them. |
| 5 | Click the title of "“Services” is used before it is defined." | Its hover is "Show in the document"; the document scrolls to "Customer wishes to buy the Services." and highlights it. |
| 6 | Under the Drafting cards, click **Defined terms (N)**. Click **Fees**. | A list of terms, each "<term> · used N×" with the start of its definition; hover "Show the definition in the document"; clicking scrolls to "“Fees” means the charges set out in Schedule 1." |
| 7 | In the document, hover a use of "Services" (in section 2); then, while reading (not editing), click it. Look for **Apply defined term everywhere** under Drafting. | The tooltip reads "Services: “Services” means the services described in Schedule 1." (or its start). The click jumps to the definition. The button **Apply defined term everywhere** shows for someone who can edit while "confidential information" is written in lower case; clicking it rewrites that use as "Confidential Information". |

**Also check**
- `rv $C_TERMS \| jq '.counts.drafting'` → 5; `chk $C_TERMS \| jq '[.findings[].kind]'` contains no "drafting" (the checks list leaves them to the panel).
- Straight quotes work too: replace every “ ” with " in a copy and upload it; the same five issues.
- viewer-a sees the findings and the list but no **Apply defined term everywhere**. Another org: admin-b `GET /contracts/$C_TERMS/defined-terms` → `404` "Contract or version not found".
- The drafting step is recorded on the analysis run (`runs $C_TERMS` shows the run done; `GET /contracts/:id/analysis-runs` lists a `drafting` step with its count of findings).

**Known limits**
- Drafting findings never change the recommendation; they are listed, not counted.
- A lower-case single word is flagged only when "the" points at it ("the services"); "other services" is left alone.
- `GET /contracts/:id/defined-terms` works on the text at once; the Drafting findings appear only after the version's analysis reaches its `drafting` step.

---

## 3. Approvals, stages and the inbox

This section tests docs/41 Parts 4, 6, 12 and 18, and the model in docs/47-STAGE-STATE-TURN.md. A contract now has
three stored values: a **stage** (Request, Draft, Negotiate, Approve, Sign, Active, Closed), a **state** within it
(e.g. "Returned for changes") and a **turn** (Our turn, Counterparty's turn, Approvers' turn, Signers' turn). The
**status banner** at the top of the contract page and the workspace shows all three, with the one next action. Every
move goes through one service (`apps/api/src/lib/lifecycle.ts transition()`). Each move writes a `STAGE_CHANGED`
audit event and fires the `contract.stage_changed` / `contract.turn_changed` webhooks.

Approvals are now of **one version**. An approver may **Approve**, **Return for changes** (back to the stage the
contract was worked in, the owner's turn) or **Decline** (it stays in Approve, "Declined", and can't go to signature
or be marked signed until it is reworked). A return or decline needs a
reason. Each workflow step has a **reset rule** that decides whether its approval is asked for again after a change.
A role step is **pooled**: every holder of the role sees it, the first to decide claims it, and a reset returns it to
the pool. **Approvals**
in the left rail is now the **Inbox**, counted by contract. It has three views: **Needs my action**, **Waiting on
others** and **Team**. The contract's Activity, Versions and Approval tabs are replaced by one **History** drawer.

Codes: **E2E-LIF** (stages, banner, moves, dates, signing gate, history), **E2E-APR** (decisions, resets, pools,
exceptions, renames), **E2E-INB** (the inbox). Run them in the order written. The §5 journeys of docs/40 that test
"Reject" (E2E-APPR-06, -09, -12) describe the old behaviour. Where they differ, these journeys are current.

### Before you start: section 3 setup

- docs/40 §0 is done. Paste the §0.5 lines, then the **docs/40 §5 helpers** (`mk`, `st`, `wfid`, `submit`, `qstep`,
  `decide`, `inst`, `notes`, `audit`, `mail`, `sql`, `sfs`, `srq`, `tok`, `sign`, `decline`). Create `$W_QUICK` as §5
  says (or get it back with `W_QUICK=$(wfid "QA quick approval")`).
- The seeded **Standard approval** workflow is the default. Its one step, "Legal review", is for the **role**
  LEGAL_COUNSEL. That step is now **pooled**: every LEGAL_COUNSEL holder sees it. In a fresh seed counsel-a is the only
  holder.
- `decide … REJECTED` (docs/40's helper) still works: the API reads REJECTED as RETURNED. Use `RETURNED` and
  `DECLINED` in this section.
- Two browsers: one for the contract owner (contracts-a), one for the approver (counsel-a). Use a private window for
  the second.

Paste these extra helpers after the §5 ones:

```bash
# ── Section 3 helpers ─────────────────────────────────────────────────
# stage <contractId> [token] → what the status banner reads (GET /contracts/:id/stage)
stage() { curl -s "$API/contracts/$1/stage" -H "Authorization: Bearer ${2:-$ADMIN_A}" \
  | jq '{stage, stageState, turn, line, next, approvals: (.approvals|if .==null then null else {approved,total,status,outcome} end),
         signatures, exceptions, returned: (.returned|if .==null then null else {outcome, by: .by.name, reason} end),
         moves: [.moves[].label], canCancel, canUndoCancel}'; }
# hist <contractId> [all|negotiation|approvals|signatures|system] → newest 10 History items
hist() { curl -s "$API/contracts/$1/history?filter=${2:-all}" -H "Authorization: Bearer $ADMIN_A" \
  | jq '{counts, items: [.data[0:10][] | {group, kind, title, detail}]}'; }
# move <token> <contractId> <stage> <state> [reason] → POST /contracts/:id/stage, with the HTTP code
move() { curl -s -w '  HTTP %{http_code}\n' -X POST "$API/contracts/$2/stage" -H "Authorization: Bearer $1" \
  -H 'content-type: application/json' -d "$(jq -nc --arg s "$3" --arg t "$4" --arg r "${5:-}" '{stage:$s,state:$t} + (if $r != "" then {reason:$r} else {} end)')"; }
# dec <token> <instanceId> <stepId> APPROVED|RETURNED|DECLINED [reason] → POST /approvals/:id/decide
dec() { curl -s -w '  HTTP %{http_code}\n' -X POST "$API/approvals/$2/decide" -H "Authorization: Bearer $1" \
  -H 'content-type: application/json' -d "$(jq -nc --arg s "$3" --arg d "$4" --arg c "${5:-}" '{stepId:$s,decision:$d} + (if $c != "" then {comment:$c} else {} end)')"; }
# inbox <token> [mine|waiting|team] [extra query] → the rows, counted
inbox() { curl -s "$API/inbox?view=${2:-mine}${3:+&$3}" -H "Authorization: Bearer $1" \
  | jq '{view, total, counts, rows: [.data[] | {title, line, primary: .primary.label, detail: .primary.detail, actions: [.actions[].label], stuck}]}'; }
# html <token> <contractId> <html> [note] → a new version from HTML (what the editor's Save as version does)
html() { curl -s -w '  HTTP %{http_code}\n' -X POST "$API/contracts/$2/html-version" -H "Authorization: Bearer $1" \
  -H 'content-type: application/json' -d "$(jq -nc --arg h "$3" --arg n "${4:-QA edit}" '{htmlContent:$h, changeNote:$n}')" | jq -c '{versionNumber}? // .'; }
# clauses <contractId> → store two clauses on the current version, as the agents service does after analysis
clauses() { local V=$(curl -s "$API/contracts/$1" -H "Authorization: Bearer $ADMIN_A" | jq -r .currentVersionId)
  curl -s -X POST "$API/contracts/$1/versions/$V/clauses" -H "x-internal-secret: $INTERNAL_SECRET" -H 'x-internal-service: agents' \
    -H 'content-type: application/json' -d '{"clauseSegments":[
      {"clauseType":"payment","content":"Fees. 1,000 per month, payable within 30 days of invoice.","sortOrder":0,"riskRating":"neutral","sectionRef":"2"},
      {"clauseType":"limitation_of_liability","content":"Liability. The liability of each party is capped at the fees paid in the prior 12 months.","sortOrder":1,"riskRating":"neutral","sectionRef":"4"}]}'; echo; }
# capp <contractId> → the contract's approval: the current request (status, outcome, reason, who returned it, who it waits on) and the history
capp() { curl -s $API/contracts/$1/approval -H "Authorization: Bearer $ADMIN_A" | jq '{current: (.current|if .==null then null else {status,outcome,reason,returnedBy:.returnedBy.name,waitingOn:[.waitingOn[].name]} end), history: [.history[]|{status,outcome,reason}]}'; }
# val <contractId> <json body> → PATCH the contract as contracts-a (value, currency, type, dates); prints the HTTP code
val() { curl -s -o /dev/null -w "%{http_code}\n" -X PATCH $API/contracts/$1 -H "Authorization: Bearer $CONTRACTS_A" -H 'content-type: application/json' -d "$2"; }
```

**Fixture text.** `mk` (docs/40 §5) makes a four-clause services contract. Several journeys edit it through `html`.
These are its two HTML versions:

```bash
# The text as mk wrote it (an HTML version of it changes no clause):
H_SAME='<p>1. Services. The Supplier shall provide the services in Schedule 1.</p><p>2. Fees. 1,000 per month, payable within 30 days of invoice.</p><p>3. Term. 12 months, renewing automatically unless either party gives 60 days notice.</p><p>4. Liability. The liability of each party is capped at the fees paid in the prior 12 months.</p>'
# The same with the liability cap halved (clause 4 changes, the others don't):
H_CAP='<p>1. Services. The Supplier shall provide the services in Schedule 1.</p><p>2. Fees. 1,000 per month, payable within 30 days of invoice.</p><p>3. Term. 12 months, renewing automatically unless either party gives 60 days notice.</p><p>4. Liability. The liability of each party is capped at 50% of the fees paid in the prior 6 months.</p>'
```

---

### E2E-LIF-01 · The status banner names the stage, the state and whose turn it is, with the one next action, from Draft to Active

**Covers:** /contracts/:id · /contracts/:id/workspace · `GET /contracts/:id/stage` · `POST /contracts/:id/stage` · `POST /contracts/:id/submit-approval` · `POST /approvals/:id/decide` · `POST /contracts/:id/send-for-signature` · `POST /sign/:token/sign` · StatusBanner · regression 18 (Lifecycle)
**Roles:** contracts-a, counsel-a, viewer-a, admin-b · **Needs:** Mailpit · **Time:** ~25 min

**Preconditions**
- Section 3 setup pasted. Signed in to `$WEB` as contracts-a (browser 1) and counsel-a (browser 2).
- `C1=$(mk "$CONTRACTS_A" "QA LIF banner" SOW 20000); echo $C1`

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Browser 1: open `$WEB/contracts/$C1`. | Under the header, the **status banner**. On the left a progress line **Draft › Negotiate › Approve › Sign › Active** ("Request" is shown only for a contract that began as a request). **Draft** is filled dark (current); the rest are grey. Next to it the line **Draft · Drafting · Our turn (you)**: contracts-a owns it, so "(you)" is added and the line is amber. On the right: the primary button **Submit for approval**, a ghost button **History** (tooltip "Everything that happened to this contract") and a "⋯" button (aria-label "More stage actions"). |
| 2 | `stage $C1 "$CONTRACTS_A"` | `stage` "draft", `stageState` "drafting", `turn` "internal", `line` "Draft · Drafting · Our turn", `next` `{kind:"submit", label:"Submit for approval", enabled:true}`, `moves` `["Mark as sent to the counterparty","Start negotiating"]`, `canCancel` true, `canUndoCancel` false, `approvals` null. |
| 3 | Click "⋯". | Menu: **Mark as sent to the counterparty**, **Start negotiating**, a separator, **Cancel contract…**. |
| 4 | Click **Mark as sent to the counterparty**. | Toast "Moved". Line: **Negotiate · Counterparty's turn** (no "(you)"; the turn time appears once it is at least 2 minutes old, e.g. "· 5 minutes"). **Draft** has a tick; **Negotiate** is current. No primary button: nothing is ours to do. "⋯" now lists **It’s our turn** and **Back to drafting…**. |
| 5 | "⋯" → **Back to drafting…**. | A row opens under the banner: "Back to drafting.", an input with placeholder "Why (recorded on the contract)…", the confirm button **Back to drafting** (disabled until the reason has 3 characters) and **Not now**. Type `QA scope changed` and confirm → toast "Moved", line **Draft · Drafting · Our turn (you)**. |
| 6 | "⋯" → **Start negotiating**. Then click **Submit for approval**. | After Start negotiating: line **Negotiate · Our turn (you)**, primary **Submit for approval**. The button opens the **Send for review** dialog: **Workflow** "Standard approval", first reviewer "Legal review". Click **Send**. |
| 7 | Look at the banner again (it refreshes after the dialog closes). | Progress: Draft ✓, Negotiate ✓, **Approve** current. Line **Approve · Waiting for approval · Approvers' turn**, then **Approvals 0 of 1**. No primary button for contracts-a (it isn't their step). |
| 8 | Browser 2 (counsel-a): open the same contract. | The same line. Primary button **Approve or return** (amber line: it waits on counsel-a). Clicking it scrolls to the decision strip below the banner, which has **Approve**, **Return for changes**, **Decline** and **Delegate**. |
| 9 | In the strip click **Approve**, then **Confirm approval**. | Line **Approve · Approved · Our turn**, **Approvals 1 of 1**. Browser 1 (after a reload): primary **Send for signature** (enabled for contracts-a), "⋯" lists **Mark as signed outside draftLegal**. |
| 10 | Browser 1: **Send for signature** with one signer `signer1@example.test`. Or by API: `sfs "$CONTRACTS_A" $C1 '[{"name":"Signer One","email":"signer1@example.test"}]'` | Line **Sign · Out for signature · Signers' turn**, **Approvals 1 of 1**, **Signatures 0 of 1**. No primary button for contracts-a. |
| 11 | Sign it: `sign "$(tok $C1 signer1@example.test)" "Signer One"`. Reload browser 1. | Line **Active** alone (the state says nothing the stage doesn't, and the turn is none). Progress all ticked to **Active**. No primary button; "⋯" lists **Terminate…** and **Archive** and no Cancel. `stage $C1` → `stage` "active", `stageState` "active", `turn` "none". `curl -s $API/contracts/$C1 -H "Authorization: Bearer $ADMIN_A" \| jq '{status, executedAt}'` → `status` "EXECUTED" and `executedAt` set. |
| 12 | Open `$WEB/contracts/$C1/workspace`. | The full-screen workspace shows the same banner with the same line and buttons. |

**Also check**
- viewer-a opens `$C1` in step 7: the same line and progress, no primary button and no "⋯" (no `edit:contract`).
  `stage $C1 "$VIEWER_A"` → `next` null, `moves` [], `canCancel` false.
- admin-b: `curl -s -w '%{http_code}\n' $API/contracts/$C1/stage -H "Authorization: Bearer $ADMIN_B"` → `404`
  `{"detail":"Contract not found"}`.
- The derived `status` follows each step: DRAFT → UNDER_NEGOTIATION → PENDING_APPROVAL → APPROVED →
  PENDING_SIGNATURE → EXECUTED (`st $C1` after each).
- The banner never shows the old negotiation strip ("guessed" turn) or the header's status buttons. The turn is
  stored; `sql "select stage, \"stageState\", turn, \"turnSince\", \"turnOwnerId\" from contracts where id='$C1'"`
  matches what the banner says.

**Known limits**
- The banner hides itself if `GET /stage` fails. It shows no error state.
- A contract made before the migration has its turn worked out once, from its last share or version (docs/47
  "Migration"). A negotiation with no recorded share shows "Our turn".

### E2E-LIF-02 · Backward moves need a reason, forbidden moves are refused with the rule, and cancelling is reversible only by an admin

**Covers:** /contracts/:id · `POST /contracts/:id/stage` · `POST /contracts/:id/cancel` · `POST /contracts/:id/uncancel` · `PATCH /contracts/:id` (status) · `lib/contract-status.ts manualRefusal` · `transitionRefusal`
**Roles:** contracts-a, admin-a, viewer-a, admin-b · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- E2E-LIF-01 done (`$C1` is Active). `C2=$(mk "$CONTRACTS_A" "QA LIF moves" SOW 20000)`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `move "$CONTRACTS_A" $C2 approve pending` | `409` `{"detail":"Approval is set by the approval workflow, not by hand. Submit the contract for approval instead."}` |
| 2 | `move "$CONTRACTS_A" $C2 sign out_for_signature` | `409` "A contract goes to signature by sending it for signature." |
| 3 | `move "$CONTRACTS_A" $C2 draft returned` | `409` "A contract is returned by an approver, through the approval workflow." |
| 4 | `move "$CONTRACTS_A" $C2 negotiate with_us`, then `move "$CONTRACTS_A" $C2 draft drafting` (no reason). | First: `200` `{"ok":true,"changed":true,"stage":"negotiate","stageState":"with_us","turn":"internal","status":"UNDER_NEGOTIATION"}`. Second: `409` "Say why it goes back to Draft." |
| 5 | `move "$CONTRACTS_A" $C2 draft drafting "QA rework"` | `200`, stage draft. `hist $C2` → a `stage` item "Moved to Draft · Drafting" with `detail` "QA rework". |
| 6 | `move "$CONTRACTS_A" $C2 draft nonsense` and `move "$CONTRACTS_A" $C2 closed cancelled "x"` | `400` "“draft/nonsense” is not a stage and state a contract can be in." · `400` "Cancel a contract with POST /contracts/:id/cancel." |
| 7 | On the Active contract: `move "$ADMIN_A" $C1 negotiate with_us "QA reopen"` and `move "$ADMIN_A" $C1 draft drafting "QA reopen"`. | Both `409` "A signed contract is not reopened. Changes after signature are made with an amendment." |
| 8 | Submit `$C2` (`submit "$CONTRACTS_A" $C2`), then `move "$CONTRACTS_A" $C2 draft drafting "QA pull back"`. | `409` "A contract waiting for approval moves when the approval workflow decides it, not by hand. An approver approves, returns or declines it." |
| 9 | Browser (contracts-a) on `$C2`: "⋯" → **Cancel contract…**. | A row: "Cancel this contract. It is kept, closed; an admin can bring it back.", the reason input and a red **Cancel contract** button (enabled from 3 characters). Type `QA deal lost` and confirm. Toast "Contract cancelled". Line **Closed · Cancelled**. No primary button. |
| 10 | `stage $C2` and `inst $INST` | `stage` "closed", `stageState` "cancelled", `turn` "none". The approval request in flight was stopped: `status` "CANCELLED", its pending step "SKIPPED". `st $C2` → "ARCHIVED" (cancelled reads as archived for older clients). |
| 11 | contracts-a: `curl -s -X POST $API/contracts/$C2/uncancel -H "Authorization: Bearer $CONTRACTS_A" -H 'content-type: application/json' -d '{"reason":"QA back"}'` | `403` `{"detail":"Only an admin can bring a cancelled contract back."}` |
| 12 | Browser as admin-a on `$C2`: "⋯" → **Bring it back…**. | "Bring this contract back to where it was cancelled from." Reason `QA deal revived`, confirm **Bring it back**. Toast "Contract brought back". It was cancelled while waiting for approval, so it comes back to **Draft · Drafting** (an approval or signature stopped by the cancel is not restored). |
| 13 | `curl -s -X POST $API/contracts/$C2/uncancel -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"reason":"again"}'` | `409` "This contract is not cancelled." |

**Also check**
- Cancel needs a reason: `-d '{"reason":"x"}'` → `400` "Say why the contract is cancelled (at least 3 characters)."
  Uncancel with a short reason → `400` "Say why the contract is brought back (at least 3 characters)."
- Cancel with a signature request open (send `$C2` for signature first, as in E2E-LIF-04) → `409`
  `{"code":"SIGNATURE_PENDING","detail":"Its signature request is still open. Void it first, then cancel the contract."}`
- An Active contract can't be cancelled: `curl -s -X POST $API/contracts/$C1/cancel -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"reason":"QA no"}'`
  → `409` "A contract can only be cancelled before it is signed (this one is Active)."
- An archived contract stays closed: archive `$C1` ("⋯" → **Archive**), then `move "$ADMIN_A" $C1 active active "x"`
  → `409` "A archived contract stays closed; only an expired one comes back when its dates change."
- Clients that still send a status: `curl -s -X PATCH $API/contracts/$C2 -H "Authorization: Bearer $CONTRACTS_A" -H 'content-type: application/json' -d '{"status":"APPROVED"}'`
  is refused with the same approval rule as step 1.
- viewer-a: `move "$VIEWER_A" $C2 negotiate with_us` → `403` "Missing permission: edit:contract". admin-b → `404`
  "Contract not found".
- History (`hist $C2`) has one `stage` item per move. Each refused move added nothing.

**Known limits**
- "A archived contract…" is the code's grammar (the state label is put after "A").
- Cancel stops an approval in flight and pending clause exceptions. Bringing it back does not restore them; the
  contract is submitted again.

### E2E-LIF-03 · The daily date job moves contracts to Expiring, Expired or Renewed automatically, and back to Active on a new date

**Covers:** `POST /cron/renewals` · `lib/lifecycle-dates.ts scanStageDates` · scan.worker (daily) · `GET /contracts/:id/stage` · webhook `contract.stage_changed` (source "dates") · regression 18 (Lifecycle)
**Roles:** admin-a · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- Three executed contracts. Make them with `approve_now` and a signature, or set them by SQL on the local database
  only:

```bash
L1=$(mk "$ADMIN_A" "QA LIF expiring" SOW); L2=$(mk "$ADMIN_A" "QA LIF expired" SOW); L3=$(mk "$ADMIN_A" "QA LIF autorenew" SOW)
for c in $L1 $L2 $L3; do sql "update contracts set stage='active', \"stageState\"='active', turn='none', status='EXECUTED' where id='$c'"; done
sql "update contracts set \"expiryDate\"=now()+interval '10 days' where id='$L1'"
sql "update contracts set \"expiryDate\"=now()-interval '1 day', \"keyTerms\"='{\"autoRenew\":false}' where id='$L2'"
sql "update contracts set \"expiryDate\"=now()-interval '1 day', \"keyTerms\"='{\"autoRenew\":true}' where id='$L3'"
```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Run the date job by hand: `curl -s -X POST $API/cron/renewals -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{}' \| jq .stageDates` | `{scanned: ≥3, moved: {expiring: ≥1, expired: ≥1, auto_renewed: ≥1, reactivated: 0}, errors: []}`. |
| 2 | `stage $L1`, `stage $L2`, `stage $L3` | `$L1`: active / expiring, line **Active · Expiring soon**. `$L2`: closed / expired; the banner reads **Closed · Expired**. `$L3`: active / auto_renewed, **Active · Renewed automatically**. |
| 3 | `hist $L1 system`, `hist $L2 system`, `hist $L3 system` | One `stage` item each, group "system": "Moved to Active · Expiring soon" with detail "it expires on <yyyy-mm-dd>"; "Moved to Closed · Expired" with "it expired on <date>"; "Moved to Active · Renewed automatically" with "it renewed on its own at its expiry date". |
| 4 | Run step 1 again. | Nothing moves a second time (`moved` all 0 for these three). |
| 5 | Extend `$L2`: `sql "update contracts set \"expiryDate\"=now()+interval '200 days' where id='$L2'"`, then step 1. | `moved.reactivated` ≥ 1. `stage $L2` → active / active. History: "Moved to Active" with detail "its expiry date is <date> now". |
| 6 | In the browser open `$L1`, then click the progress line. | The History drawer opens (see E2E-LIF-05) with the date move at the top. |

**Also check**
- `$L3` has no renewal term (nor initial term), so its expiry date stays. A contract with one has its expiry moved on
  by that term and its notice deadline recomputed (E2E-RNW-07 steps 8–10). A decision to renew moves a contract to
  **Active · Renewing** instead of Expiring soon (E2E-RNW-04 step 11); the banner's stage line changes as soon as the
  decision is recorded, without a reload (fa711b9, E2E-RNW-02 step 4).
- An amendment or exhibit (`relationshipType` amendment or exhibit_only) is never moved by its own dates: set one up
  like `$L1` and run step 1; it is not counted.
- `curl -s -X POST $API/cron/renewals -H "Authorization: Bearer $VIEWER_A"` → `403` (needs `configure:user`).
- With a webhook on `contract.stage_changed` (E2E-HOOK-01), step 1 delivers one event per move with `source` "dates".

**Known limits**
- "Expiring" is fixed at 30 days before expiry (`EXPIRING_DAYS`); it is not an org setting.
- Terminated and superseded are never set by dates.

### E2E-LIF-04 · A contract is signed only after it is approved, on that version; a voided signature can be taken back

**Covers:** /contracts/:id · /admin/organization (Approval before signing) · `POST /contracts/:id/send-for-signature` (signingGate) · `POST /contracts/:id/signature-requests/:srId/void` · `POST /contracts/:id/revert-signature` · `PATCH /organization` (`allowSignWithoutApproval`) · SigningPolicySection · StatusBanner (Take it back)
**Roles:** contracts-a, counsel-a, admin-a, signer (Mailpit) · **Needs:** Mailpit · **Time:** ~25 min

**Preconditions**
- Section 3 setup. `S1=$(mk "$CONTRACTS_A" "QA LIF gate" SOW 20000)`.
- Org A's signing policy is the default (approval required). Check: `curl -s $API/organization -H "Authorization: Bearer $ADMIN_A" | jq .settings.allowSignWithoutApproval` → null or false.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `sfs "$CONTRACTS_A" $S1 '[{"name":"Signer One","email":"signer1@example.test"}]'` | `409` `{"code":"APPROVAL_REQUIRED","detail":"This contract needs approval before it can be sent for signature. Send it for approval first."}`. No signature request is made (`srq $S1` → null). |
| 2 | In the browser (contracts-a) try the same from the contract's **Send for signature** dialog (header or "⋯"). | The dialog shows the same sentence in red and stays open. |
| 3 | `submit "$CONTRACTS_A" $S1`, then the step 1 call again. | `409` `{"code":"APPROVAL_REQUIRED","detail":"This contract is still waiting for approval. It can be sent for signature once it is approved."}` |
| 4 | Approve it: `qstep "$COUNSEL_A" $S1; dec "$COUNSEL_A" $INST $STEP APPROVED`. Then edit it: `html "$CONTRACTS_A" $S1 "$H_SAME" "QA after approval"`. | The default step rule is "always" (E2E-APR-03), so the new version asks again: `stage $S1` → approve / pending, **Approvals 0 of 1**. Sending now → `409` "This contract is still waiting for approval…". |
| 5 | Approve again (`qstep "$COUNSEL_A" $S1; dec "$COUNSEL_A" $INST $STEP APPROVED`), then send (step 1's call). | `201`. `stage $S1` → sign / out_for_signature. Signer1 has the signing email in Mailpit. |
| 6 | Void it: `SR=$(srq $S1 \| jq -r .id); curl -s -X POST $API/contracts/$S1/signature-requests/$SR/void -H "Authorization: Bearer $CONTRACTS_A" \| jq` and reload the contract (contracts-a). | Line **Sign · Signature voided · Our turn (you)**. An amber row under the banner: "The signature request was voided." and "Nothing is out for signature. Take the contract back to change it, or send it again." Primary button **Take it back** (with an undo icon). |
| 7 | Click **Take it back**. | A row: "Take the contract back from signature. The voided request stays in the history.", radio group "Where it goes back to" with **Where it was worked on** (default), **Approved, to send again**, **Negotiate**, **Draft**, and the reason input. |
| 8 | Pick **Approved, to send again**, reason `QA wrong signer`, confirm **Take it back**. | Toast "Taken back from signature". Line **Approve · Approved · Our turn (you)**. Primary **Send for signature**. The approval still stands on this version, so no new approval is needed. |
| 9 | Send again to `signer2@example.test`, void it as in step 6, then edit: `html "$CONTRACTS_A" $S1 "$H_CAP" "QA cap"`. Now take it back to Approve by API: `curl -s -X POST $API/contracts/$S1/revert-signature -H "Authorization: Bearer $CONTRACTS_A" -H 'content-type: application/json' -d '{"reason":"QA retry","to":"approve"}' \| jq` | `409` `{"code":"NO_STANDING_APPROVAL","detail":"Its approval no longer stands for this version. Take it back to Negotiate or Draft and submit it again."}` |
| 10 | The same with `"to":"draft"`. | `200` `{ok:true, status:"DRAFT", stage:"draft", stageState:"drafting"}`. Banner **Draft · Drafting · Our turn (you)**, primary **Submit for approval**. |
| 11 | `hist $S1 signatures` and `hist $S1 approvals` | Signatures: "Sent for signature" (twice), "Signature request voided" (twice). Stage items for the reverts carry the reasons "QA wrong signer" and "QA retry". Nothing is deleted: the voided requests are still listed by `curl -s $API/contracts/$S1/signature-requests -H "Authorization: Bearer $COUNSEL_A" \| jq '[.data[].status]'` (`["VOIDED","VOIDED",…]`). |
| 12 | Admin-a: Admin → Organization → section **Approval before signing**. | Text "A contract is sent for signature only once it has been approved. Turn this off only if your team approves contracts outside this app." and a ticked box **Require approval before a contract is sent for signature**. |
| 13 | Untick it. Then make `S2=$(mk "$CONTRACTS_A" "QA LIF no approval" SOW 20000)` and send it for signature at once (step 1's call with `$S2`). | Toast "Contracts can be signed without approval". The send gives `201`: Draft goes straight to **Sign · Out for signature**. Tick the box again (toast "Approval is required before signing"). |

**Also check**
- Revert while the envelope is still open: with `$S2` out for signature (step 13), call revert-signature on it without voiding → `409`
  `{"code":"SIGNATURE_PENDING","detail":"Its signature request is still open. Void it first, then take the contract back."}`.
  On a contract not in Sign → `409` "Only a contract out for signature can be taken back." No reason → `400` "Say why it
  goes back (a reason of at least 3 characters)."
- A signer declines (`decline "$(tok …)" "QA wrong entity"`): line **Sign · Declined · Our turn (you)**, the amber row
  "The signature request was declined." and the same **Take it back**.
- Active and closed contracts: sending → `409` `{"code":"NOT_SIGNABLE","detail":"Contract already executed"}` /
  "A closed contract is not sent for signature."
- An open clause exception blocks signing even when approved (E2E-APR-07): `409` `{"code":"OPEN_EXCEPTIONS",…}`.
- A draft with an unchosen governing law still answers `409` `OPEN_CHOICES` after the gate (docs/41 P0.4, tested in §1 of
  this plan).
- Who may revert: `sign:contract`. viewer-a → `403` "Missing permission: sign:contract". The **Take it back** button is
  disabled for users without it.

**Known limits**
- The policy is one org-wide switch. There is no per-type or per-value exemption.
- A revert to Negotiate or Draft does not cancel the old approval record; the next submit makes a new request.

### E2E-LIF-05 · One History drawer, filterable, replaces the Activity, Versions and Approval tabs

**Covers:** /contracts/:id · /contracts/:id/workspace · `GET /contracts/:id/history?filter=` · HistoryDrawer · regression 12 (Tabs for Approval history, Activity and Comments)
**Roles:** contracts-a, viewer-a, admin-b · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- E2E-LIF-04 done (`$S1` has versions, an approval, two signature requests and reverts). E2E-APR-01 done gives a
  return with a reason too; run this journey again after it if you want to see one.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$S1` (contracts-a). Look at the tab row. | Tabs **Overview**, **Clauses**, **Comments** (with a count when there are threads) and the document. There is no **Activity**, **Versions**, **Approval** or **Negotiate** tab. The right rail has no Activity, Approval or History section. |
| 2 | Click **History** on the banner. | A drawer **History**, "Everything that happened to this contract, newest first." Filter chips **All**, **Negotiation**, **Approvals**, **Signatures**, **System**. Items are grouped by day ("Today", "Yesterday", then dates). |
| 3 | Read the **All** list. | Each event once: "Casey Contracts saved v2" (and the other versions, each with a compare link to the one before), "Casey Contracts submitted it for approval", "Legal Counsel approved (Legal review)", "Approvals asked for again" with detail "v2 changed the document" (or the clause names), "Moved to Sign · Out for signature", "Sent for signature", "Signature request voided", the revert moves with their reasons, "Casey Contracts created it". |
| 4 | Click each filter. | **Approvals**: only submissions, decisions, resets, exceptions. **Signatures**: only signature events and moves made by signing. **Negotiation**: versions, shares, redlines, comments resolved, clause and finding decisions. **System**: creation, edits of fields, date moves, assistant actions, sync. Same counts as `hist $S1 <filter>`. |
| 5 | `hist $S1` | `counts` has `all`, `negotiation`, `approvals`, `signatures`, `system`, and `all` equals the sum of the other four. |
| 6 | Click the progress line in the banner. | The same drawer opens. |
| 7 | Open `$WEB/contracts/$S1/workspace` and click **History**. | The same drawer and list. |

**Also check**
- An unknown filter (`?filter=foo`) answers the **All** list.
- A contract with no events beyond creation: the drawer shows only "… created it". If the history call fails, the
  drawer shows "The history could not be loaded." in red.
- viewer-a sees the same history. admin-b: `curl -s -w '%{http_code}\n' $API/contracts/$S1/history -H "Authorization: Bearer $ADMIN_B"` → `404`.
- Regression 12: the comment count on the **Comments** tab is the real number of threads, not "9+" for any two.
- Viewing a contract (`CONTRACT_VIEWED`, `PORTAL_VIEWED`) is not listed.
- Field changes read in words (browser run, 442728c). Under **System**, an edit of fields reads "<person> updated <fields in words>" (for example "Casey Contracts updated value, currency"), a change no person made is the analysis's ("The analysis updated title, type, counterparty, summary, key terms, risk score, governing law"), and a field filled from a template or the document reads "<person> filled in counterparty" / "… filled in from the document …"; a document edit is "<person> edited the document". Nowhere: stored names such as `set_from_template`, `metadata`, `fieldConfidence`, `analysisStatus` or `currentVersionId`. Check: `hist $S1 system \| grep -cE 'set_from|metadata|fieldConfidence|analysisStatus|currentVersionId'` prints 0.

**Known limits**
- History reads up to the newest 50 sync-log rows and the audit events of the contract; very old contracts may show
  older status changes as "Moved to <status in words>".

### E2E-APR-01 · An approver returns a contract for changes with a reason; the owner sees why in the banner, the bell, the inbox and the history, and resubmits as a new request

**Covers:** /approvals (Inbox) · /contracts/:id · `POST /approvals/:id/decide` (RETURNED) · `GET /contracts/:id/approval` · `GET /contracts/:id/stage` · `GET /contracts/:id/history` · `POST /contracts/:id/submit-approval` · `GET /approvals/notifications` · ApprovalCard · DecisionStrip · DecisionReason · notification.worker · regression 4 (Reject showed only "Redline merge: N accepted…")
**Roles:** contracts-a (owner), counsel-a (approver), viewer-a · **Needs:** Mailpit · **Time:** ~20 min

**Preconditions**
- Section 3 setup. Browser 1 contracts-a, browser 2 counsel-a.
- `R1=$(mk "$CONTRACTS_A" "QA APR return" SOW 20000); move "$CONTRACTS_A" $R1 negotiate with_us; submit "$CONTRACTS_A" $R1`
  (it goes to **Standard approval**, step "Legal review" for the LEGAL_COUNSEL role).
- `capp` (section 3 setup) prints the contract's current approval request and its history.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `capp $R1` | `current.status` "PENDING", `outcome` null, `waitingOn` ["Anyone with the LEGAL_COUNSEL role"] (a pooled step names the role; it shows a person's name once one is named). `history` []. |
| 2 | Browser 2: left rail **Inbox** (it has an amber count). Tab **Needs my action**. | A row "QA APR return", "SOW · USD 20,000 · Approve · Waiting for approval · Approvers' turn", the step name "Legal review", an age dot and **Review and decide**. |
| 3 | Click **Review and decide**. Click **Return for changes**. | The card opens under the row. **Return for changes** is pressed, and a box with placeholder "What needs to change (required). The owner sees this on the contract and in their notification." appears. The confirm button **Return for changes** stays disabled while the box is empty. If the contract has open findings, "Point at what it is about (optional)" lists them with tick boxes. |
| 4 | Type `Liability cap must be 1× fees` and confirm. | The row leaves **Needs my action**. The Inbox count drops by one (the sidebar badge too, with no reload). |
| 5 | `capp $R1` | `current.status` "REJECTED", `outcome` "returned", `reason` "Liability cap must be 1× fees", `returnedBy` "Legal Counsel". |
| 6 | Browser 1: open `$WEB/contracts/$R1`. | Banner line **Negotiate · Returned for changes · Our turn (you)**. Primary **Fix and resubmit**. Under it an amber row: **Returned by Legal Counsel:** “Liability cap must be 1× fees” — fix it and submit it for approval again. It went back to **Negotiate**, where it was worked, not to Draft. |
| 7 | `notes "$CONTRACTS_A"` (and the bell icon in browser 1). | Newest: `type` "APPROVAL_DECIDED", `title` "Contract returned for changes", `body` `Legal Counsel returned "QA APR return" for changes: “Liability cap must be 1× fees” It is back in Negotiate to fix and resubmit.` `mail contracts@demo.com` shows the same title when contracts-a's notification settings send email at once (otherwise it comes in the daily digest). |
| 8 | Browser 1: **Inbox** → **Needs my action**. | A row "QA APR return" with the line "… Negotiate · Returned for changes · Our turn", "Reason: “Liability cap must be 1× fees”" and the button **Fix and resubmit →** (opens the contract). |
| 9 | Banner → **History** → **Approvals**. | "Casey Contracts submitted it for approval", then "Legal Counsel returned it for changes (Legal review)" with the reason under it, and a stage item "Moved to Negotiate · Returned for changes" with the same reason. Each once. |
| 10 | Click **Fix and resubmit**. In **Send for review** click **Send**. | Banner **Approve · Waiting for approval · Approvers' turn**. The returned row is gone. |
| 11 | `capp $R1` | `current.status` "PENDING" (a new request, with a new id); `history` has the earlier one: `{status:"REJECTED", outcome:"returned", reason:"Liability cap must be 1× fees"}`. |
| 12 | Regression 4: open the contract's versions in History and the document. | No version note "Redline merge: N accepted, M rejected vs vN" exists anywhere. A return is shown as the return, with its reason, never as a version note. |

**Also check**
- A reason is required: `qstep "$COUNSEL_A" $R1; dec "$COUNSEL_A" $INST $STEP RETURNED` → `400` `{"error":"Say what needs to change (a reason is required to return it)."}`.
  `dec … MAYBE "x"` → `400` "decision must be APPROVED, RETURNED, DECLINED or DELEGATED". Older clients' `REJECTED` with a
  reason is taken as a return.
- Someone not on the step: `dec "$CONTRACTS_A" $INST $STEP APPROVED` → `403` (contracts-a lacks `approve:workflow`); approver-a
  → `403` `{"error":"Step not found or not assigned to you"}`. Deciding twice → `409` "Workflow is already closed".
- The decision strip on the contract page (counsel-a, while pending): **Approve**, **Return for changes**, **Decline**,
  **Delegate**. A failed decision shows "The decision wasn’t recorded: <server reason>" in red; it never fails silently.
- A contract returned from Draft (not negotiated) goes back to **Draft · Returned for changes**.
- Slack (docs/40 E2E-NOTIF-04 receiver): the approval card's second button reads "↩️ Return with a reason" and opens the
  contract; Slack can't collect a reason.
- The audit log (Admin → Audit Log) has `APPROVAL_DECIDED` on resource type `contract` with `decision` "RETURNED" and the
  reason.

**Known limits**
- The returned banner shows the reason of the newest return only. Earlier rounds are in History.

### E2E-APR-02 · An approver declines a contract (do not proceed); the owner chooses to rework it or cancel it

**Covers:** /contracts/:id · /approvals · `POST /approvals/:id/decide` (DECLINED) · `POST /contracts/:id/submit-approval` (after a decline) · `POST /contracts/:id/cancel` · StatusBanner (Decide: rework or cancel)
**Roles:** contracts-a, counsel-a · **Needs:** nothing extra · **Time:** ~10 min

**Preconditions**
- `D1=$(mk "$CONTRACTS_A" "QA APR decline" SOW 20000); submit "$CONTRACTS_A" $D1; qstep "$COUNSEL_A" $D1`

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `dec "$COUNSEL_A" $INST $STEP DECLINED` | `400` `{"error":"Say why it should not go ahead."}` |
| 2 | Browser (counsel-a) → Inbox → **Review and decide** → **Decline**. | Placeholder "Why it should not go ahead (required). The owner decides whether to cancel it." Type `Customer is on the sanctions watch list` and click the red **Decline**. |
| 3 | `stage $D1 "$CONTRACTS_A"` | `stage` "approve", `stageState` "declined", `turn` "internal", `line` "Approve · Declined · Our turn", `next` `{kind:"declined", label:"Decide: rework or cancel"}`, `returned.outcome` "declined". `st $D1` → "DRAFT" (as a rejected approval always read). |
| 4 | Browser (contracts-a) on `$D1`. | Amber row: **Declined by Legal Counsel:** “Customer is on the sanctions watch list” — rework it and submit again, or cancel it. Primary **Decide: rework or cancel**. |
| 5 | Click it. | A row: "An approver said it should not go ahead as it is." with **Rework and resubmit**, a red **Cancel contract…** and **Not now**. |
| 6 | `notes "$CONTRACTS_A"` | `title` "Contract declined", `body` `Legal Counsel declined "QA APR decline": “Customer is on the sanctions watch list” It should not go ahead as it is: decide whether to cancel it or rework it and resubmit.` |
| 7 | Inbox (contracts-a) → **Needs my action**. | The row's action reads **Declined — decide what next**, with "Reason: “Customer is on the sanctions watch list”". |
| 8 | Before deciding, try to take it on anyway. `move "$CONTRACTS_A" $D1 active active "signed on paper"` | `409` `{"detail":"The approval was declined, so this contract can’t go to signature or be marked signed. Change it and submit it for approval again, or cancel it."}`. `stage $D1` still reads approve / declined. |
| 9 | `move "$CONTRACTS_A" $D1 sign out_for_signature`, then `sfs "$CONTRACTS_A" $D1 '[{"name":"Signer One","email":"signer1@example.test"}]'` | The move: `409` with the same "The approval was declined…" sentence. The send: `409` `{"code":"APPROVAL_REQUIRED","detail":"This contract needs approval before it can be sent for signature. Send it for approval first."}`. No signature request exists. The banner offers no "Mark as signed outside draftLegal". |
| 10 | **Rework and resubmit** → **Send**. | A new request: **Approve · Waiting for approval**. `capp $D1` → `history[0]` `{status:"REJECTED", outcome:"declined", reason:"Customer is on the sanctions watch list"}`. |

**Also check**
- Instead of step 10, **Cancel contract…** with a reason ends it in **Closed · Cancelled** (E2E-LIF-02).
- The refusal holds for every flow, not only by hand: with **Require approval** unticked (E2E-LIF-04 step 13), step 9's send is still `409` APPROVAL_REQUIRED; and asking the assistant to mark it as signed gets the tool's refusal with the same "The approval was declined…" sentence (judge by the fact: the stage stays approve / declined).
- History → Approvals: "Legal Counsel declined (Legal review)" with the reason.

**Known limits**
- Declined keeps the contract in Approve. Only a resubmission, a move back to Draft or a cancel moves it on.

### E2E-APR-03 · An admin sets, per workflow step, when an approval is asked for again after a change

**Covers:** /approvals → Manage workflows · `POST /approvals/workflows` · `PATCH /approvals/workflows/:id` · WorkflowBuilder (ResetOnField) · `lib/reset-rule-form.ts`
**Roles:** admin-a, legalops-a, counsel-a · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- Section 3 setup. Signed in as admin-a.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Left rail **Inbox** → tab **Manage workflows**. | "Workflows decide who approves a contract, in what order, and when an approval is asked for again after a change." and the workflow list. |
| 2 | **New Workflow**: name `QA reset rules`, **Add First Step**, step name `Legal`, **Specific approver** counsel-a. | Under the step a select **Ask again after a change**, set to **After any change** (the default). Options: **After any change**, **When the document changes**, **When these clauses change**, **When these fields change**, **Never**. |
| 3 | Choose **When these fields change**. | Chips **Value**, **Currency**, **Contract type**, **Expiry date**, **Effective date**, none pressed, and a red line "Pick at least one field." |
| 4 | Press **Value** and **Expiry date**. | The line reads "2 picked." |
| 5 | Add a second step `Risk`, approver legalops-a, rule **When these clauses change**, no chip pressed. | Chips list the clause types (e.g. **Limitation of Liability**, **Payment Terms**, **Governing Law**). With none pressed: "None picked: a change to any clause asks again." Press **Limitation of Liability** → "1 picked." |
| 6 | **Create Workflow**, then reopen it with the pencil. | Both rules are kept as set. `curl -s $API/approvals/workflows -H "Authorization: Bearer $ADMIN_A" \| jq '.[] \| select(.name=="QA reset rules") \| [.steps[] \| {name, resetOn}]'` → `[{"name":"Legal","resetOn":{"mode":"fields","fields":["value","expiryDate"]}},{"name":"Risk","resetOn":{"mode":"clause_text_changes","clauseTypes":["limitation_of_liability"]}}]`. |

**Also check**
- API validation, each `400` with the step named: a step with `"resetOn":"sometimes"` → `Step 1 ("Legal"): resetOn must be one of always, any_document_change, clause_text_changes, fields, never.`;
  `"resetOn":{"mode":"fields","fields":[]}` → `Step 1 ("Legal"): name the fields whose change asks for the approval again.`
- A workflow saved before this change, with no `resetOn`, reads as **After any change**.
- Who may: admin-a and legalops-a (`configure:workflow`). counsel-a creating one by API → `403` "Missing permission:
  configure:workflow".

**Known limits**
- The fields offered are five. A custom field can be named by API (`"fields":["<key>"]`) but not picked in the builder.

### E2E-APR-04 · A change while in Approve asks again only the steps whose rule it meets, tells those approvers what changed, and carries the rest

**Covers:** `lib/approval-reset.ts onApprovalChange` · `POST /contracts/:id/html-version` · `PATCH /contracts/:id` (value, currency) · `POST /contracts/:id/versions/:versionId/clauses` (internal) · `GET /contracts/:id/history` · `GET /approvals/notifications` · `GET /contracts/:id/stage` · resetOn always / any_document_change / clause_text_changes / fields / never
**Roles:** contracts-a (owner), counsel-a (approver) · **Needs:** nothing extra (the clause step is seeded, not analysed) · **Time:** ~30 min

**Preconditions**
- Section 3 setup, fixture `$H_SAME` and `$H_CAP` set.
- One one-step workflow per rule, all approved by counsel-a (a named person, so the notification goes to one inbox):

```bash
wf() { curl -s -X POST "$API/approvals/workflows" -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' \
  -d "$(jq -nc --arg n "$1" --arg a "$COUNSEL_A_ID" --argjson r "$2" '{name:$n, steps:[{order:0,name:"Legal",approverId:$a,executionMode:"sequential",requiredApprovals:1,dueSoonHours:48,resetOn:$r}]}')" | jq -r .id; }
W_ALW=$(wf "QA reset always" '"always"'); W_DOC=$(wf "QA reset document" '"any_document_change"')
W_CLA=$(wf "QA reset liability" '{"mode":"clause_text_changes","clauseTypes":["limitation_of_liability"]}')
W_FLD=$(wf "QA reset value" '{"mode":"fields","fields":["value"]}'); W_NEV=$(wf "QA reset never" '"never"')
# approved <title> <workflowId> → a contract by contracts-a, approved by counsel-a through that workflow
approved() { local c=$(mk "$CONTRACTS_A" "$1" SOW 20000); [ -n "$3" ] && clauses $c > /dev/null
  submit "$CONTRACTS_A" $c "$2" > /dev/null; dec "$COUNSEL_A" $INST $STEP APPROVED > /dev/null; echo $c; }
A_ALW=$(approved "QA reset always" $W_ALW); A_DOC=$(approved "QA reset document" $W_DOC)
A_CLA=$(approved "QA reset liability" $W_CLA seed); A_FLD=$(approved "QA reset value" $W_FLD); A_NEV=$(approved "QA reset never" $W_NEV)
```

- Each of the five: `stage <id>` → approve / approved, **Approvals 1 of 1**.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | **always**: `val $A_ALW '{"value":25000}'` then `stage $A_ALW` and `notes "$COUNSEL_A"` | `200`. Back to approve / pending, **Approvals 0 of 1**. counsel-a's newest notification: `title` "Your approval was reset", `body` `The value changed — your approval of "QA reset always" was reset. Please review it again.` counsel-a's Inbox has the contract again under **Needs my action**. |
| 2 | `hist $A_ALW approvals` | "Approvals asked for again" with detail "the value"; a stage item "Moved to Approve · Waiting for approval" with detail "the value changed after it was approved". The earlier approval stays listed ("Legal Counsel approved (Legal)"). |
| 3 | **any_document_change**: `val $A_DOC '{"value":25000}'` then `stage $A_DOC` | Still approve / approved: a field change is not a document change. Nothing new in History. |
| 4 | `html "$CONTRACTS_A" $A_DOC "$H_SAME"` then `stage $A_DOC`, `notes "$COUNSEL_A"` | A new version (v2). approve / pending. Notification `v2 changed the document — your approval of "QA reset document" was reset. Please review it again.` |
| 5 | **clause_text_changes (Limitation of Liability)**: `html "$CONTRACTS_A" $A_CLA "$H_SAME"` then `stage $A_CLA`, `hist $A_CLA approvals` | Still approve / approved. The text of each clause is unchanged, so the approval carries: History "Approvals carried to the new version" with detail "v2 changed the document". No notification to counsel-a. |
| 6 | `html "$CONTRACTS_A" $A_CLA "$H_CAP"` then `stage $A_CLA`, `notes "$COUNSEL_A"` | approve / pending. Notification body starts `v3 changed` and names Limitation of Liability (with its section when the clause has one: `§4 Limitation of Liability`), then `— your approval of "QA reset liability" was reset. Please review it again.` |
| 7 | **fields (value)**: `val $A_FLD '{"currency":"EUR"}'`, `stage $A_FLD`; then `val $A_FLD '{"value":30000}'`, `stage $A_FLD` | Currency: still approved. Value: approve / pending, notification "The value changed — your approval of "QA reset value" was reset. Please review it again." |
| 8 | **never**: `html "$CONTRACTS_A" $A_NEV "$H_CAP"` and `val $A_NEV '{"value":99000}'`, then `stage $A_NEV`, `hist $A_NEV approvals` | Still approved. History "Approvals carried to the new version" (detail "v2 changed the document"). No notification. |
| 9 | On the version an approval carries to, send for signature: `sfs "$CONTRACTS_A" $A_NEV '[{"name":"Signer One","email":"signer1@example.test"}]'` | `201`: the approval is on the version the contract stands on, so the signing gate passes. |
| 10 | Open `$A_CLA` in the browser as counsel-a. | The banner shows **Approve or return**. The decision strip's recommendation does not say "Ready to approve" for the new version until the review runs again (a recommendation written for the old version is withdrawn). |

**Also check**
- A multi-step workflow: the steps that reset are asked again from the earliest of them; a later step that was still
  pending waits again ("… will be asked again after the earlier step." in that approver's notification).
- An auto-approved contract (docs/40 E2E-APPR-03: an NDA under USD 10,000 on Standard approval) that changes value or
  document is withdrawn and goes back to Draft: History "Request for approval withdrawn" with "… changed after it was
  approved automatically".
- An approved contract with no approval on record (set by SQL or imported) still goes back to be submitted again on a
  new document or a change of type, value or currency.
- The Save as version dialog in the editor offers "Reset approvals" to users with `configure:workflow` (`reset_all` or
  `keep`), which overrides the rules for approval steps (E2E for the editor covers the dialog).
- A role (pooled) step that resets goes back to the role's pool, and the rest of the pool is told: E2E-APR-06 steps 8–11.

**Known limits**
- When a new version has no clauses stored yet (an uploaded file not yet analysed), a clause rule can't compare
  clauses and resets as if they changed. The same happens in step 5 if the edit could not carry the seeded clauses to
  v2: check the Clauses tab of v2 lists Payment Terms and Limitation of Liability before you file step 5 as a bug.
- The `fields` names are the API's (`value`, `currency`, `type`, `expiryDate`, `effectiveDate`), and notifications use
  them as they are ("the value").

### E2E-APR-05 · A counterparty's new version during approval withdraws the request and hands the turn back to us

**Covers:** /portal/:token · `POST /contracts/:id/share` · `POST /portal/:token/versions` · `lib/approval-reset.ts` (counterparty) · `lib/lifecycle.ts onCounterpartyVersion` · /approvals (Inbox) · StatusBanner (Review changes)
**Roles:** contracts-a, counsel-a, admin-a (makes the portal link), counterparty (no account) · **Needs:** `D-MARKUP.docx` (docs/40 §0.7) · **Time:** ~15 min

**Preconditions**
- `P1=$(mk "$CONTRACTS_A" "QA APR withdraw" SOW 20000); submit "$CONTRACTS_A" $P1` (pending with counsel-a).
- A portal link that allows uploads, made by an admin (share links need `configure:contract`, which only ADMIN holds;
  with `$CONTRACTS_A` this call is `403` "Missing permission: configure:contract"): `TOKEN=$(curl -s -X POST $API/contracts/$P1/share -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"permissions":["upload"]}' | jq -r .portalUrl | sed 's#.*/portal/##')`

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `stage $P1` | approve / pending. Making the link did not move it: a copy sent during approval doesn't hand it over. |
| 2 | Upload their version: `curl -s -X POST $API/portal/$TOKEN/versions -F "file=@D-MARKUP.docx" \| jq '{versionNumber, message}'` | A new version (v2). |
| 3 | `stage $P1 "$CONTRACTS_A"` and `inst $INST` | Contract: negotiate / with_us, turn internal, `line` "Negotiate · Our turn", `next.label` "Review changes". Request: `status` "CANCELLED"; its pending step "SKIPPED"; `approvalRecommendation` null. `capp $P1` → `current.status` "CANCELLED", `current.outcome` "withdrawn". |
| 4 | `notes "$COUNSEL_A"` | `title` "Approval request withdrawn", `body` `The counterparty sent v2 of "QA APR withdraw" after it was submitted, so the request for your approval was withdrawn. It will be submitted again once the new version is reviewed.` counsel-a's **Needs my action** no longer lists it. |
| 5 | Browser (contracts-a) on `$P1`. | Banner **Negotiate · Our turn (you)**, a line "Counterparty sent v2 — …" (its changes, how many need attention, required clauses missing) and the primary **Review changes**, which opens the workspace's Changes mode. contracts-a's Inbox lists it with **Respond to counterparty**. |
| 6 | `hist $P1` | "The counterparty sent v2" (negotiation), "Request for approval withdrawn" with detail "the counterparty sent a new version", and "Moved to Negotiate · With us" with the same reason. |
| 7 | Submit again (`submit "$CONTRACTS_A" $P1`). | A new request on v2; `capp $P1` → `current.status` "PENDING", the withdrawn one in `history`. |

**Also check**
- The same after approval (approve / approved): a counterparty version still withdraws it, and the approvers who had
  approved are told.
- Out for signature with the envelope open, a counterparty version is recorded but the contract stays in Sign; the
  owner decides (void, then take it back).
- The emailed-reply path (`inbound-email`, docs/40 §4) does the same with `via` "email".

**Known limits**
- The withdrawn request is not resubmitted by itself. The owner reviews the changes and submits again.

### E2E-APR-06 · A role's approval goes to everyone who holds the role, and the first to decide claims it

**Covers:** /approvals (Inbox) · `POST /approvals/workflows` (roleRequired) · `POST /contracts/:id/submit-approval` · `POST /approvals/:id/decide` · `GET /contracts/:id/approval` · `PATCH /admin/users/:id/roles` · `lib/workflow-engine.ts` (pooled steps) · notification.worker
**Roles:** admin-a, approver-a, legalops-a, counsel-a, contracts-a · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- Give legalops-a the Approver role as well, so the role has two holders:
  `curl -s -X PATCH $API/admin/users/$LEGALOPS_A_ID/roles -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"roles":["LEGAL_OPS","APPROVER"]}' | jq .roles`
  (undo at the end with `{"roles":["LEGAL_OPS"]}`). Re-run `export LEGALOPS_A=$(login legalops@qa.test $QA)` so the token carries the role.
- A two-step workflow: the role first, then counsel-a:
  `W_POOL=$(curl -s -X POST "$API/approvals/workflows" -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d "{\"name\":\"QA pooled\",\"steps\":[{\"order\":0,\"name\":\"Approver pool\",\"roleRequired\":\"APPROVER\",\"executionMode\":\"sequential\",\"requiredApprovals\":1},{\"order\":1,\"name\":\"Legal\",\"approverId\":\"$COUNSEL_A_ID\",\"executionMode\":\"sequential\",\"requiredApprovals\":1}]}" | jq -r .id)`
- `Q1=$(mk "$CONTRACTS_A" "QA APR pooled" SOW 20000)`

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `submit "$CONTRACTS_A" $Q1 $W_POOL` | `201`. `steps` has **one** step with `approverId` null and `approverRoleId` set: a pool, not one row per holder. |
| 2 | `notes "$APPROVER_A"` and `notes "$LEGALOPS_A"` | Both have "Contract awaiting your approval" with body `"QA APR pooled" has been submitted for approval (Approver pool) — any one of your role can decide.` |
| 3 | `inbox "$APPROVER_A"` and `inbox "$LEGALOPS_A"` | Both list "QA APR pooled" once, primary "Approve", detail "Approver pool". `capp $Q1` → `waitingOn` ["Anyone with the APPROVER role"]. |
| 4 | Browser as approver-a → Inbox → **Review and decide** → **Approve** → **Confirm approval**. | The row leaves approver-a's inbox. The contract moves to step 2: `capp $Q1` → `waitingOn` ["Legal Counsel"]. |
| 5 | `inbox "$LEGALOPS_A"` | The contract is gone from legalops-a's **Needs my action** too: the step was claimed. |
| 6 | legalops-a decides the old step by API: `dec "$LEGALOPS_A" $INST $STEP APPROVED` (`$STEP` is still step 1's id from `submit`). | `403` `{"error":"Step not found or not assigned to you"}`: the step is approver-a's now. |
| 7 | `hist $Q1 approvals` | "<approver-a's name> approved (Approver pool)". Nobody else is named on that step. |
| 8 | Finish it: `qstep "$COUNSEL_A" $Q1; dec "$COUNSEL_A" $INST $STEP APPROVED`. Then change the value (the steps' reset rule is the default, "always"): `val $Q1 '{"value":25000}'` | `200`. `stage $Q1` → approve / pending. |
| 9 | `capp $Q1` and `inbox "$LEGALOPS_A"` | `waitingOn` ["Anyone with the APPROVER role"]: the reset step went back to the **pool**, not to approver-a. legalops-a's **Needs my action** lists "QA APR pooled" again with **Approve**. |
| 10 | `notes "$APPROVER_A"` and `notes "$LEGALOPS_A"` | approver-a (who claimed it): "Your approval was reset", `The value changed — your approval of "QA APR pooled" was reset. Please review it again.` legalops-a (the rest of the pool): "Approval needed again", `The value changed — "QA APR pooled" needs approval again. Any one of your role can decide.` |
| 11 | legalops-a approves it this time (Inbox → **Review and decide** → **Approve**). | `200`. approver-a's inbox no longer lists it: the first to decide claims it again. |

**Also check**
- At the same moment: submit another contract to `$W_POOL`, then run both decisions together:
  `(dec "$APPROVER_A" $INST $STEP APPROVED & dec "$LEGALOPS_A" $INST $STEP APPROVED & wait)`. One gets `200`; the other
  `409` `{"error":"This step was decided meanwhile. Reload the page."}`. Never two decisions on one step.
- A one-step pooled workflow: the second holder deciding after the first → `409` "Workflow is already closed".
- A role with no active holder: submit → `422` "Cannot resolve approver for step "…". Check the workflow
  configuration."; a role whose holders all leave after submission shows in the Team view as stuck (E2E-INB-02).
- The seeded **Standard approval** ("Legal review", role LEGAL_COUNSEL) is pooled the same way: give another user the
  LEGAL_COUNSEL role and both see new SOW submissions.

**Known limits**
- Pooling changes who sees what (every holder, not the first one). docs/47 asks for this to be announced to admins;
  nothing in the product announces it (Appendix A lists it as an open decision).

### E2E-APR-07 · An exception to a playbook position goes to the clause's named approver, and an open exception blocks signing

**Covers:** /contracts/:id (Review panel) · /playbook (Rules for this clause → Decides exceptions) · /clauses (category approver) · `GET /contracts/:id/findings/:findingId/exception-approver` · `PATCH /playbook/categories/:id/rules` · /approvals (Inbox) · `PATCH /clauses/categories/:id` · `GET /contracts/:id/review` · `POST /contracts/:id/findings/:findingId/exception` · `POST /approvals/steps/:stepId/decide` · `GET /contracts/:id/approval` (exceptions) · `POST /contracts/:id/send-for-signature` (OPEN_EXCEPTIONS) · ReasonDialog · CategoryApproverField
**Roles:** admin-a, contracts-a, counsel-a, admin-b · **Needs:** agents service + model key (the contract is analysed) · **Time:** ~25 min

**Preconditions**
- contracts-a uploads `D-MSA.pdf` (Contracts → **Upload**), type MSA, and waits for the analysis to finish. Save its id as `$X1`.
- `curl -s $API/contracts/$X1/review -H "Authorization: Bearer $CONTRACTS_A" | jq '[.groups.needsAttention[], .groups.notDetected[] | select(.actions|index("request_exception")) | {id, kind, title, categoryId}]'`
  lists at least one finding. Save the first as `$F1` and its `categoryId` as `$CAT1`. Kinds that allow an exception:
  a position not met, one that needs approval, a required clause missing or deleted, a clause not allowed, a material
  cut, a modified clause.
- That category has no clause approver yet: `curl -s -X PATCH $API/clauses/categories/$CAT1 -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"approverUserId":null,"approverRoleId":null}'`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Browser (contracts-a) on `$X1` → **Review** panel. Find the finding `$F1` and click **Request exception**. | A dialog **Request exception**. With no one named it says so at once, in red: "No one is named to decide exceptions for “<category name>”. An admin can name a clause approver on the Playbook page." contracts-a (no `edit:playbook` or `edit:clause`) gets no link. Label "Why should this be allowed?", placeholder "For example: the customer is a public body and can't accept a cap above fees." |
| 2 | Type `Customer is a public body; cap above fees not allowed by statute` and confirm. | The dialog stays open with the same red message. API: `curl -s $API/contracts/$X1/findings/$F1/exception-approver -H "Authorization: Bearer $CONTRACTS_A" \| jq` and the POST of the request both give `422` with `code` "NO_CLAUSE_APPROVER" and that sentence. |
| 3 | Admin-a opens the same dialog on `$X1`. | The same red sentence, followed by the link **Name a clause approver**, which opens **Playbook**. |
| 4 | On **Playbook**, click that category in the list. In **Rules for this clause**: "Decides exceptions: **No one yet**" → **Change** → the select **Decides exceptions** (groups "A person" and "Anyone with a role") → under **A person** pick **Legal Counsel** (counsel-a) → **Save**. | "Decides exceptions: Legal Counsel". On **Clauses** the same category shows the same; a child category with none of its own shows "Legal Counsel (from the parent category)". |
| 5 | As contracts-a, open **Request exception** on `$F1` again, give the reason and confirm. | Before confirming, the dialog reads: “<finding title>” goes to **Legal Counsel**, who decides exceptions for <category name>. They see your reason. After: toast "Exception requested". Under the finding: "Exception requested — waiting for Legal Counsel". The banner shows "1 exception to decide". |
| 6 | Approve the contract itself: `approve_now $X1` (admin-a through `$W_QUICK`). Reload. | Line **Approve · Approved · Our turn (you)**. **Send for signature** is disabled, tooltip "1 exception still to decide". |
| 7 | `sfs "$CONTRACTS_A" $X1 '[{"name":"Signer One","email":"signer1@example.test"}]'` | `409` `{"code":"OPEN_EXCEPTIONS","detail":"An exception is still waiting for a decision (<finding title>). It can be sent for signature once it is decided."}` |
| 8 | counsel-a: **Inbox** → **Needs my action**. | A row for the MSA with the action **Decide exception** and the finding's title. The button **Decide exception** opens "Exception asked for: <title> by Casey Contracts — “Customer is a public body; …”" with **Approve exception** and **Decline**. |
| 9 | Click **Decline** with an empty note. | The confirm **Decline exception** stays disabled; the placeholder reads "Why not (required). The person who asked sees this." |
| 10 | Click **Approve exception**, then confirm **Approve exception**. | The row leaves counsel-a's inbox. contracts-a's bell: "Exception approved", `<title> on "<contract title>" was approved.` The finding reads "Exception approved by Legal Counsel". The banner's exception count is gone and **Send for signature** is enabled. |
| 11 | Step 7 again. | `201`. |
| 12 | `capp $X1 ; curl -s $API/contracts/$X1/approval -H "Authorization: Bearer $ADMIN_A" \| jq '.exceptions[] \| {title, status, requestedBy, reason, decidedBy, waitingFor}'` and `hist $X1 approvals` | The exception: `status` "APPROVED", `requestedBy` "Casey Contracts", `decidedBy` "Legal Counsel", `waitingFor` null. History: "Casey Contracts asked for an exception: <title>" and "Legal Counsel approved the exception: <title>". |

**Also check**
- No reason: `curl -s -X POST $API/contracts/$X1/findings/$F1/exception -H "Authorization: Bearer $CONTRACTS_A" -H 'content-type: application/json' -d '{}'`
  → `400` "Say why an exception is needed (at least 3 characters)." Asking twice → `409` `ALREADY_DECIDED` "An exception was
  already asked for.". A finding of an older version → `409` `NOT_CURRENT`.
- A declined exception: the requester is told "Exception declined" with the reason, the finding reads "Exception declined
  by …: “…”", and the button becomes **Request exception again**.
- A role as approver: pick "Anyone with a role" → APPROVER. The dialog reads "… goes to anyone with the APPROVER role,
  who decides exceptions for <category>. They see your reason."; the pending line reads "waiting for anyone with the
  APPROVER role", and every holder sees **Decide exception**. A role with no holders → `422` `NO_CLAUSE_APPROVER` "No one holds the
  role that decides exceptions for “<category>”."
- Category API: both a person and a role → `400` "Name a person or a role to decide exceptions, not both."; admin-b's user
  id → `400` "That person is not a member of this organization."
- An exception resets only when its own clause's text changes. Edit that clause in a new version: the requester gets
  "Exception reset" ("vN changed <clause> on "<title>" — the exception approved on the old words was reset. Ask again if
  it is still needed."). Editing another clause leaves it.
- An exception is decided, not delegated: `POST /approvals/steps/<stepId>/decide` with `DELEGATED` → `400` "An exception is
  decided, not delegated."

**Known limits**
- The category must have a clause approver before anyone can ask; there is no fallback to the contract's approvers.
  The dialog says so before a reason is written (steps 1–3).

### E2E-APR-08 · Nothing says "Reject" any more: each object's verb says what it does

**Covers:** /contracts/:id (decision strip, review drawer) · /contracts/:id/workspace (Changes mode) · /approvals (bulk) · /requests · `PATCH /requests/:id` · `PATCH /contracts/clauses/:id/review-state` (review drawer) · Slack card · FocusedReviewDrawer · ChangesView · RequestDetailPanel · /admin/integrations (Slack tab)
**Roles:** counsel-a, contracts-a, rep-a · **Needs:** a contract with a counterparty's version (E2E-APR-05's `$P1`); an analysed contract with flagged clauses (`$X1`) · **Time:** ~15 min

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | counsel-a on a pending approval (any from E2E-APR-01/02). | Decision strip and Inbox card: **Approve**, **Return for changes**, **Decline**, **Delegate**. No "Reject". |
| 2 | Inbox with two or more of counsel-a's approvals → **Decide N approvals at once…**. | Dialog **Decide several approvals**: "This applies to the N approvals in your list — only the ones ticked below. Nothing else in your inbox changes." (with "as it is filtered now" when the filter box has text). Choices **Approve the ticked ones** and **Return the ticked ones for changes**; the second needs **What needs to change** (placeholder "Sent to each owner with their contract"). Button **Return N for changes**. No bulk decline. |
| 3 | contracts-a: open `$P1` → banner **Review changes** (or `$WEB/contracts/$P1/workspace` → Changes). | Each change of theirs has **Accept change** and **Keep original** (plus Counter and Comment). No "Reject". |
| 4 | contracts-a on `$X1` → **Clauses** tab → open a flagged clause's review. | The drawer's red button reads **Not acceptable** (tooltip "The clause can't stay as written. It leaves the queue marked not acceptable."). Click it: it reads **Marked not acceptable**. History → Negotiation: "Casey Contracts marked <clause type in words> not acceptable". |
| 5 | rep-a raises a request (docs/40 E2E-REQ-01). counsel-a opens it on **Requests** → **Decline request**. | Dialog **Decline request**: “<title>” closes and leaves the queue. The requester is told why. Label "Why are you declining it?", placeholder "For example: we already have an NDA with this company.", button **Decline request** ("Declining…"). |
| 6 | Reason `We already have an NDA with Initech` → confirm. | The request is **Declined** (tab **Declined**, not "Rejected"); the row shows "Declined: We already have an NDA with Initech"; the panel "Declined: We already have an NDA with Initech" and **Reopen request**. rep-a's bell: "Request declined", `Your request "<title>" was declined: “We already have an NDA with Initech”`. |
| 7 | API: `curl -s -X PATCH $API/requests/<id> -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{"status":"REJECTED"}'` on another submitted request; then `-d '{"status":"ACCEPTED"}'`. | `409` "Say why the request is declined." · `409` "A request is accepted by drafting the contract from it." |
| 8 | **Reopen request** on the declined one. | Back to Submitted; the reason is cleared. |

**Also check**
- Slack approval card: "↩️ Return with a reason" (opens the contract); Approve still decides in Slack.
- Admin → Integrations → **Slack** (regression: it said "Approve / Reject buttons"). The setup text reads "Approval
  requests post Approve / Return with a reason buttons via your …", and the webhook help says "… to get actionable
  Approve / Return with a reason cards in the channel." The word "Reject" appears nowhere on the tab.
- The assistant's approval tool and History use "returned it for changes" and "declined", never "rejected".
- A signer still **declines** to sign (signer portal), which is a separate act.

**Known limits**
- The contract status pill for the old `REJECTED` status still reads "Rejected"; no new contract is given that status.
- A tracked-change suggestion in the document keeps Word's verbs, **Accept** / **Reject** and **Accept all** / **Reject
  all** (E2E-SUG-02): that is about words in the text, not a decision on the contract.

### E2E-INB-01 · "Needs my action" lists each contract once with what I must do, and the sidebar badge always equals the list

**Covers:** /approvals (Inbox, tab Needs my action) · sidebar Inbox badge · `GET /inbox?view=mine` · `GET /inbox/count` · `POST /approvals/:id/decide` · BulkDecisionDialog · `lib/inbox.ts needsMyAction` · regression 6 (Queue counts 2 vs 4 vs 4)
**Roles:** counsel-a, contracts-a, admin-a · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- Section 3 setup. Start from a clean inbox for counsel-a: decide or cancel what `inbox "$COUNSEL_A"` lists, or note its `total` as N0.
- Build four kinds of work for counsel-a:

```bash
I1=$(mk "$CONTRACTS_A" "QA INB approve one" SOW 20000); submit "$CONTRACTS_A" $I1 > /dev/null   # counsel-a's pooled step
I2=$(mk "$CONTRACTS_A" "QA INB approve two" SOW 30000); submit "$CONTRACTS_A" $I2 > /dev/null   # another
I3=$(mk "$COUNSEL_A" "QA INB returned" SOW 5000); submit "$COUNSEL_A" $I3 $W_QUICK > /dev/null
dec "$ADMIN_A" $INST $STEP RETURNED "Add the data processing schedule"                         # counsel-a owns it: Fix and resubmit
I4=$(mk "$COUNSEL_A" "QA INB negotiating" SOW 5000); move "$COUNSEL_A" $I4 negotiate with_us   # our turn, counsel-a's: Respond
```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `inbox "$COUNSEL_A"` | `total` = N0 + 4 and `counts.mine` the same. Rows, oldest first: "QA INB approve one" (primary "Approve", detail "Legal review"), "QA INB approve two" ("Approve"), "QA INB returned" ("Fix and resubmit", detail "Add the data processing schedule"), "QA INB negotiating" ("Respond to counterparty"). |
| 2 | `curl -s $API/inbox/count -H "Authorization: Bearer $COUNSEL_A"` | `{"mine": N0+4}`. |
| 3 | Browser (counsel-a): look at the left rail and open **Inbox**. | Rail item **Inbox** with an amber badge N0+4. Page **Inbox**: "N0+4 contracts need something from you." Tab **Needs my action** with the same number. Each row: title (link), "SOW · USD 20,000 · Approve · Waiting for approval · Approvers' turn" and so on, the reason "Reason: “Add the data processing schedule”" on the returned one, an age dot, and the action button: **Review and decide** for approvals, **Fix and resubmit →** and **Respond to counterparty →** (links to the contract). Each approval row also has a grey line with the AI's recommendation and its first reason, as the decision strip says it, e.g. "AI: Can't recommend — this contract has not been analysed" (`mk` contracts are never analysed); hover shows every reason (browser run, cf29987). The other rows have no "AI:" line. |
| 4 | The bulk button. | **Decide 2 approvals at once…** (only rows whose action is Approve count; with N0 = 0). The header counts contracts that need anything; the bulk button counts the approvals among them. Both come from the one list. |
| 5 | Type `two` in **Filter by title, counterparty or type**. | Only "QA INB approve two" stays. The bulk button disappears (it shows from two approvals up). Clear the filter. |
| 6 | Open **Decide 2 approvals at once…**, keep both ticked, **Approve the ticked ones**, **Approve 2**. | Both rows leave. Without a reload, the tab badge, the header sentence and the rail badge all read N0+2. `curl -s $API/inbox/count …` → N0+2. |
| 7 | Regression 6: compare the three places one more time after any decision (decide `$I3` by resubmitting it as counsel-a: open it, **Fix and resubmit** → **Send**). | Header, tab badge and rail badge always show the same number, and it equals the number of rows. `$I3` leaves Needs my action (it now waits on admin-a) and appears under **Waiting on others**. |
| 8 | A contract with two things for me. Request an exception on an analysed contract whose clause approver is counsel-a (E2E-APR-07) and submit that contract to Standard approval. | One row for the contract: primary **Approve**, and a chip **Also: Decide exception**. It counts once. |

**Also check**
- A deleted contract leaves every list: delete `$I4` (contract page → Delete) → gone from Needs my action and the count.
  Contracts in a diligence room are never listed.
- rep-a, viewer-a: the Inbox opens with "All clear" / "No contract needs anything from you right now." and the rail
  badge is absent.
- If the inbox call fails, the page shows "The inbox could not be loaded." in red; it never shows a stale count.
- An org with no active workflow shows "No approval workflows yet." / "Contracts can't be submitted for approval until
  one exists." with **Create workflow →**.
- Bulk with a partial failure (decide one of the two in another tab first): the dialog lists the one that failed with
  the server's reason; the rest go through.
- The dashboard says the same number in the same words (browser run, 0584c1e). As counsel-a open `$WEB/dashboard`
  (**Dashboard** in the rail): the line "N0+4 contracts need your action in Inbox" ("1 contract needs your action in
  Inbox" for one), and the tile **Needs my action** (admins see **Org Approvals**). It never says "approvals waiting on
  your decision" or "Pending Approvals": a returned contract to fix is in the count too. The header's
  "N items need you" adds the requests assigned to you.

**Known limits**
- Rows are ordered by how long they have waited; there is no other sort.
- **Respond to counterparty** appears for any negotiation that is our turn and yours, including one you moved there by
  hand.

### E2E-INB-02 · "Waiting on others" shows who has my contracts and since when; "Team" shows everything in flight, with stuck, aging and stage filters

**Covers:** /approvals (tabs Waiting on others, Team) · `GET /inbox?view=waiting` · `GET /inbox?view=team&stuck=&agingDays=&stage=` · `lib/inbox.ts waitingOnOthers, teamInFlight`
**Roles:** contracts-a, legalops-a, admin-a, counsel-a · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- E2E-INB-01 done (contracts-a submitted `$I1`, `$I2`; both are approved now). Make two more:

```bash
W1=$(mk "$CONTRACTS_A" "QA INB waiting" SOW 20000); submit "$CONTRACTS_A" $W1 > /dev/null          # with the LEGAL_COUNSEL pool
W2=$(mk "$CONTRACTS_A" "QA INB with them" SOW 20000); move "$CONTRACTS_A" $W2 negotiate with_counterparty
W3=$(mk "$CONTRACTS_A" "QA INB stuck" SOW 20000)
sql "update contracts set stage='approve', \"stageState\"='pending', turn='approvers', status='PENDING_APPROVAL', \"turnSince\"=now()-interval '10 days' where id='$W3'"
```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `inbox "$CONTRACTS_A" waiting` | Rows for "QA INB waiting" (`line` "Approve · Waiting for approval · Approvers' turn"), "QA INB with them" ("Negotiate · Counterparty's turn") and "QA INB stuck". None of contracts-a's own-turn contracts. |
| 2 | Browser (contracts-a) → Inbox → **Waiting on others**. | A table with columns **Contract**, **Where it is**, **Who has it**, **Since**. "QA INB waiting": "Approvers: anyone with the LEGAL_COUNSEL role". "QA INB with them": the counterparty's name, or "Counterparty" when it has none. "QA INB stuck": "Stuck: Waiting for approval, but no request for approval is open. Submit it again." in red. |
| 3 | As counsel-a (no `configure:workflow`): the tabs. `inbox "$COUNSEL_A" team` | No **Team** tab. The API: `403` `{"title":"Forbidden","status":403,"detail":"Missing permission: configure:workflow"}`. |
| 4 | As legalops-a → Inbox → **Team**. | Every contract in flight in Org A (Request to Sign), each with where it is and who has it. Filters: **Stuck (no one can approve)**, an age select (**Any age**, **Waiting 3+ days**, **Waiting 7+ days**, **Waiting 14+ days**, **Waiting 30+ days**) and a stage select (**Every stage**, Request, Draft, Negotiate, Approve, Sign). |
| 5 | Tick **Stuck (no one can approve)**. Or `inbox "$LEGALOPS_A" team stuck=1` | Only stuck ones: "QA INB stuck" with its reason. |
| 6 | Age **Waiting 7+ days** (`agingDays=7`). | "QA INB stuck" (turn 10 days old); the new ones are not listed. |
| 7 | Stage **Negotiate** (`stage=negotiate`). | "QA INB with them" and other negotiations only. The response echoes `filters` `{stuck, agingDays, stage}`. |
| 8 | Fix the stuck one: `sql "update contracts set stage='draft', \"stageState\"='drafting', turn='internal', status='DRAFT' where id='$W3'"`, then submit it. | It leaves the Stuck filter. |

**Also check**
- Another stuck kind: deactivate approver-a while a contract waits on approver-a's named step → Team row "Stuck: The
  current approval step’s approver can’t act (no longer active, or nobody holds the role)." Reactivate afterwards.
- `agingDays` is clamped to 1–365; an unknown `stage` is ignored.
- admin-b sees none of Org A's contracts in any view.

**Known limits**
- Team has no bulk actions. It lists, and the filters narrow, but decisions are made from Needs my action.

---

## 4. The contract workspace: editing, changes, comments and AI

This section tests docs/41 Part 15 (Redline vs Compare) and Part 16 (a full-screen contract editor), in four
steps: the working copy, the workspace and Changes mode, comments and the selection menu, and suggestion mode.

What changed, in one paragraph each:

- **Typing is not a version.** The editor autosaves to the contract's **draft changes** (one working copy per
  contract, `PUT /contracts/:id/working-copy`). A version is made only by **Save as version** (with a note), by
  submitting for approval or sending to the counterparty with draft changes unsaved, or by an idle checkpoint after
  30 minutes without a save. Two editors can't silently overwrite each other: a save on an old revision is refused
  and the editor asks whose text wins.
- **One full-screen workspace.** A contract in stage Draft, Negotiate or Approve opens at
  `/contracts/:id/workspace`: the status banner, the document, and **Review**, **Details** or **Comments** on the
  right. **Changes** mode replaces the Compare overlay, the Negotiate tab and the redline panel: the diff against a
  baseline, in the document, each change with its finding and **Accept change**, **Keep original**, **Counter…** or
  **Comment**; a counter goes into the document as a tracked suggestion. History's **Compare with vN** opens Changes
  mode on that pair of saved versions, read-only. A counterparty's version is advised on automatically and the banner
  says what they sent.
- **Comments have a side.** Threads are **Internal** (the default, a lock) or **External** (a globe). The portal
  reads and writes external threads only. A thread remembers its words and is found again in later versions, or says
  "Text no longer in the document". **Document discussion** groups comments and suggestions by person, and
  **Only this person** hides everyone else's.
- **Selecting words offers actions.** Comment · Ask AI (three drafts, each with why) · Tag clause · Make variable ·
  Request exception.
- **Suggestion mode.** While negotiating (or with **Suggesting** on), typing and deleting become tracked suggestions
  with the person's name, colour and time. They export to Word as `w:ins`/`w:del` by their authors, a returned
  Word file's tracked changes come back as suggestions, and the analysis reads the document as if every pending
  suggestion were accepted.
- **AI suggestions are logged**: shown, accepted, edited or dismissed, per feature (`ai_suggestion_events`).

Codes: **E2E-WSP** (workspace and working copy), **E2E-CHG** (Changes mode), **E2E-CMT** (comments), **E2E-SUG**
(selection menu, AI and suggestion mode). Run them in order: E2E-WSP-01 uploads the contract most later journeys use.

Where this section and docs/40 differ, this section is current. In particular:
- docs/40 E2E-NEG-03 (Compare overlay, merge change by change) and E2E-NEG-04 ("Analyze Redlines") describe screens
  that are gone. E2E-CHG-01…03 replace them.
- docs/40 journeys that say an edit in the browser makes a version "Edited in browser" five seconds after typing are
  out of date: typing now makes draft changes only (E2E-WSP-02).
- Only admins can make share links (`configure:contract`), so every "send to the counterparty by link" step here
  is done as admin-a.

### Before you start: section 4 setup

- docs/40 §0 is done and the §0.5 lines are pasted. Section 2's fixture `~/qa-docs/QA-NDA.txt` exists (copy it from
  §2's setup if not). E2E-DRF-05 (§2) made `$C_NY2`, an NDA drafted from the **Mutual Non-Disclosure Agreement**
  template; if you skipped it, run E2E-DRF-05 steps 1 and 5 first.
- Mailpit is running (§0.2). Microsoft Word (or LibreOffice) is installed for E2E-SUG-03.
- Two browsers: one signed in as counsel-a (main), one private window for admin-a, the portal or a second editor.
- Optional, to shorten waits: add `ANALYSIS_CHECKPOINT_MS=20000` to `.env` and restart `pnpm dev` (as in §2).

Paste these helpers. They replace any helper of the same name from an earlier section.

```bash
# ── Section 4 helpers ──────────────────────────────────────────────────────────
sql() { docker exec -i clm_postgres psql -U clm -d clm_dev -At -c "$1"; }
# upload <file> <mime type> <title> <counterparty> [token] → new contract id
upload() { curl -s -X POST "$API/contracts/upload" -H "Authorization: Bearer ${5:-$COUNSEL_A}" \
  -F "file=@$1;type=$2" -F "title=$3" -F "counterpartyName=$4" | jq -r .id; }
# waitdone <contractId> → DONE or FAILED once the analysis ends (polls every 10 s, up to 10 min)
waitdone() { for i in $(seq 1 60); do s=$(curl -s "$API/contracts/$1" -H "Authorization: Bearer $ADMIN_A" | jq -r .analysisStatus)
  case $s in DONE|FAILED) echo "$s"; return;; esac; sleep 10; done; echo "still $s"; }
rv()    { curl -s "$API/contracts/$1/review" -H "Authorization: Bearer ${2:-$COUNSEL_A}"; }
# stage <contractId> [token] → what the banner reads
stage() { curl -s "$API/contracts/$1/stage" -H "Authorization: Bearer ${2:-$ADMIN_A}" \
  | jq '{stage, stageState, turn, line, next, counterparty, latestVersion}'; }
# vers <contractId> → each version: number, note, who made it
vers()  { curl -s "$API/contracts/$1" -H "Authorization: Bearer ${2:-$ADMIN_A}" \
  | jq -c '.versions | sort_by(.versionNumber)[] | {v: .versionNumber, note: .changeNote, by: .createdById}'; }
# wcopy <contractId> [token] → the draft changes, or null
wcopy() { curl -s "$API/contracts/$1/working-copy" -H "Authorization: Bearer ${2:-$ADMIN_A}" \
  | jq '.workingCopy | if . == null then null else {revision, baseVersionNumber, stale, by: .updatedBy.name, chars: (.html|length)} end'; }
# savev <token> <contractId> <json body> → POST …/versions/from-working-copy: a summary, then the HTTP code
savev() { local o=$(mktemp) c; c=$(curl -s -o "$o" -w '%{http_code}' -X POST "$API/contracts/$2/versions/from-working-copy" \
  -H "Authorization: Bearer $1" -H 'content-type: application/json' -d "$3")
  jq -c '{v: .version.versionNumber, created, approvals, send, contract: (.contract | if . == null then null else {stage, stageState, turn} end), code, detail}' "$o"; echo "HTTP $c"; }
# putwc <token> <contractId> <sed expression> → autosave the newest version's HTML with the edit applied, as the editor
#   would (on the current revision); prints the new revision, or the refusal, and the HTTP code
putwc() { local h r o=$(mktemp) c
  h=$(curl -s "$API/contracts/$2" -H "Authorization: Bearer $1" | jq -r '.versions | max_by(.versionNumber).htmlContent' | sed "$3")
  r=$(curl -s "$API/contracts/$2/working-copy" -H "Authorization: Bearer $1" | jq '.workingCopy.revision // 0')
  c=$(curl -s -o "$o" -w '%{http_code}' -X PUT "$API/contracts/$2/working-copy" -H "Authorization: Bearer $1" \
    -H 'content-type: application/json' -d "$(jq -n --arg h "$h" --argjson r "$r" '{html: $h, revision: $r}')")
  jq -c '{revision: .workingCopy.revision, code, detail}' "$o"; echo "HTTP $c"; }
# chg <contractId> [baseline] [token] → Changes mode's data, without the HTML
chg()   { curl -s "$API/contracts/$1/changes${2:+?baseline=$2}" -H "Authorization: Bearer ${3:-$COUNSEL_A}" \
  | jq '{baseline, against, stats, pendingSuggestions, origin: .options.originVersionId,
         versions: [.options.versions[] | "v\(.versionNumber)\(if .fromCounterparty then " (theirs)" else "" end)"]}'; }
# threads <contractId> [query] [token] → one line per thread
threads() { curl -s "$API/contracts/$1/comments${2:+?$2}" -H "Authorization: Bearer ${3:-$COUNSEL_A}" \
  | jq -c '.data[] | {id, visibility, authorName, resolved, anchorState, quote: .anchor.quote, replies: (.replies|length)}'; }
# aiev <contractId> → AI suggestion outcomes logged for it, by feature and outcome
aiev()  { sql "SELECT feature, outcome, count(*) FROM ai_suggestion_events WHERE \"contractId\"='$1' GROUP BY 1,2 ORDER BY 1,2"; }
```

---

### E2E-WSP-01 · A contract being worked on opens full screen in the workspace, with the banner, its one action, Review, Details, Comments and the History drawer

**Covers:** /contracts (row click) · /contracts/:id/workspace · /contracts/:id ("Open workspace") · `lib/workspace.ts openPathFor` · `GET /contracts/:id` · `GET /contracts/:id/stage` · `GET /contracts/:id/review` · `GET /contracts/:id/clauses` · StatusBanner · HistoryDrawer · ReviewPanel (jump to clause)
**Roles:** counsel-a, approver-a, viewer-a, rep-a, admin-b · **Needs:** agents service + model key (the analysis) · **Time:** ~20 min

**Preconditions**
- Signed in as counsel-a. Upload the section's main contract and wait for its analysis:
  `export C_WS=$(upload ~/qa-docs/QA-NDA.txt text/plain "QA Workspace NDA" "Initech Solutions LLC"); waitdone $C_WS` → DONE.
- An active contract to compare with: any seeded contract whose banner reads **Active** (e.g. from **Contracts**,
  filter Status = Active). Save its id as `$C_ACTIVE`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `stage $C_WS \| jq -c '{stage, next}'` | `{"stage":"draft","next":{"kind":"submit","label":"Submit for approval","enabled":true}}`. |
| 2 | Left rail → **Contracts**. Click the row "QA Workspace NDA". | The URL is `$WEB/contracts/$C_WS/workspace`. The page is full screen: no left rail. Header: **Back**, the title, then on the right **Suggesting** (a toggle, off), **Changes**, **Save as version** (disabled) and **History**. Under it the status banner: the progress Draft › Negotiate › Approve › Sign › Active with **Draft** current, the line "Draft · Drafting · Our turn" (followed by "(you)" when the turn is counsel-a's), the primary button **Submit for approval**, **History**, and **⋯** ("More stage actions"). |
| 3 | Look at the right panel. | Three tabs: **Review** (selected), **Details**, **Comments**. Review shows the same Review panel as the contract page: the recommendation, the playbook, groups **Needs attention** / **Not detected** / Standard and accepted. |
| 4 | In **Review**, click the title of a finding that names a clause (hover shows "Go to this clause"). | The document scrolls the clause into the middle and outlines it for about 1.5 s (or selects its words). If the words changed since the analysis: toast "Not found in the document", "Its words may have changed since it was analysed." |
| 5 | Click **Details**, then **Comments**. | Details: the contract's fields and Origin panel. Comments: a composer and "No comments yet. Select words in the document to comment on them." |
| 6 | Click **History** (header or banner), then the progress bar in the banner. | Both open the drawer **History** on the right with the version 1 entry. Close it with ×. |
| 7 | Click **Back**. | `$WEB/contracts/$C_WS` (the contract page). Nothing asked: there are no draft changes. The header has **Open workspace** (title "Work on this contract full screen: the document, its review and its changes"). Click it: back in the workspace. |
| 8 | **Contracts** → click the row of `$C_ACTIVE`. | It opens `$WEB/contracts/$C_ACTIVE` (the contract page), not the workspace. **Open workspace** is still offered there. |
| 9 | Banner **⋯** → **Start negotiating**. Reload. | The banner reads "Negotiate · Our turn". Header: the **Suggesting** toggle is replaced by a plain label **Suggesting** (title "While negotiating, your edits are suggestions the other side can accept or reject"). Undo it: **⋯** → **Back to drafting…**, reason `QA`. The toggle is back. |

**Also check**
- Read-only: as approver-a or viewer-a, open `$WEB/contracts/$C_WS/workspace`. The document can't be typed in; no
  draft-state text, no **Save as version**, no **Suggesting**; **Changes** and **History** work; the Comments tab
  has no composer.
- Own scope: as rep-a (not the owner) and as admin-b, open `$WEB/contracts/$C_WS/workspace` → "This contract could
  not be opened. Back to contracts". `curl -s $API/contracts/$C_WS/working-copy -H "Authorization: Bearer $ADMIN_B"`
  → `404` `{"detail":"Contract not found"}`.
- A wrong id: `$WEB/contracts/nope/workspace` → the same "could not be opened" text, not a blank page.

**Known limits**
- Only the **Contracts** list uses the stage rule. Links from the inbox, search, notifications and the assistant still
  open the contract page, which offers **Open workspace**.
- The workspace has no app rail; **Back** is the only way out besides the browser.
- On screens narrower than 1280 px the margin threads are hidden; threads are in the Comments tab only.

### E2E-WSP-02 · Regression (16, Editor): typing autosaves to draft changes, not to a version; the banner says there are unsaved draft changes; there is no "Sync on" chip

**Covers:** /contracts/:id/workspace · /contracts/:id (Edit) · `GET/PUT /contracts/:id/working-copy` · `contract_working_copies` · StatusBanner draft chip · useWorkingCopy (1.5 s autosave, ⌘S)
**Roles:** counsel-a, admin-a · **Needs:** nothing extra · **Time:** ~10 min

**Preconditions**
- E2E-WSP-01 done; `$C_WS` is in Draft with one version.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `vers $C_WS; wcopy $C_WS` | One line `{"v":1,…}`; `null`. |
| 2 | Open the workspace. In section 5 change `two years` to `three years`. Watch the text beside the title. | "Unsaved" while typing, then "Saving…", then **Draft changes saved · not a version yet** (about 1.5 s after the last key). **Save as version** becomes enabled. |
| 3 | `vers $C_WS; wcopy $C_WS` | Still one version. The working copy: `revision` 1, `baseVersionNumber` 1, `stale` false, `by` counsel-a's name. |
| 4 | Type a few more words in section 8, then press ⌘S (Ctrl+S) at once. | It saves now, without waiting. `wcopy $C_WS` → `revision` 2. Still one version. |
| 5 | Look at the banner. Hover the chip. | An amber chip **Unsaved draft changes**, tooltip "Saved by <counsel-a's name> just now. Not a version yet: open Edit to save them as one, or discard them." |
| 6 | Look for a "Sync on" (or "Sync off") chip anywhere in the workspace and on the contract page. | There is none. |
| 7 | Close the tab while typing (within 1.5 s of a key). | The browser asks to leave the page (its own dialog). Stay; the typing is saved. |
| 8 | Open the contract page `$WEB/contracts/$C_WS` in another tab. | Its banner shows **Unsaved draft changes** too. **Edit** opens the editor on the draft changes (with "three years"), not on version 1. Its header shows "Draft changes saved · not a version yet" after you type, **Save as version** and **Done**. |
| 9 | `sql "SELECT count(*) FROM contract_versions WHERE \"contractId\"='$C_WS'"` | `1`. |

**Also check**
- `curl -s -X PUT $API/contracts/$C_WS/working-copy -H "Authorization: Bearer $VIEWER_A" -H 'content-type: application/json' -d '{"html":"<p>x</p>","revision":2}'`
  → `403` "Missing permission: edit:contract". Org B's admin → `404` "Contract not found".
- An empty save: `-d '{"html":"","revision":2}'` as counsel-a → `400` `{"detail":"html is required"}`.
- While a Google Docs copy is out (docs/40 E2E-NEG-06), typing is refused: toast "Not saved: this contract is being
  edited in Google Docs".

**Known limits**
- Draft changes are one row per contract, saved whole: two people typing at once don't merge (E2E-WSP-05). Live
  co-editing is not wired up.
- The chip's tooltip says "open Edit"; in the workspace the editor is already open.

### E2E-WSP-03 · Save as version: a note is required; send it to the counterparty by share link, email, Word or PDF; only workflow owners may reset approvals

**Covers:** /contracts/:id/workspace (Save as version) · /contracts/:id (Edit → Save as version) · `POST /contracts/:id/versions/from-working-copy` · `POST /contracts/:id/share` (inside it) · `GET /contracts/:id/redline/counterparty` · `GET /contracts/:id/download` · lifecycle `onSentToCounterparty` · Mailpit
**Roles:** counsel-a, admin-a, legalops-a · **Needs:** Mailpit · **Time:** ~25 min

**Preconditions**
- E2E-WSP-02 done: `$C_WS` has draft changes ("three years").
- A second contract for sending, owned by counsel-a:
  `export C_SEND=$(upload ~/qa-docs/QA-NDA.txt text/plain "QA Send NDA" "Initech Solutions LLC"); waitdone $C_SEND` → DONE.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As counsel-a, in `$C_WS`'s workspace click **Save as version**. | Dialog **Save as version**, "Your draft changes become a new version, with a note saying what changed." Field **What changed** (placeholder "e.g. Extended the term to two years"), a box **Send to counterparty**, buttons **Cancel** and **Save version** (disabled). No **Reset approvals** box (counsel-a lacks `configure:workflow`). |
| 2 | Type `ok` in the note. Hover **Save version**. Then tick **Send to counterparty**. | Still disabled, tooltip "Say what changed in this version." The send options show only **Word (tracked changes)** (selected) and **PDF**: counsel-a can't make share links. Under them: "Downloads their Word file with your changes as tracked changes, for you to send." Untick the box. |
| 3 | Note `Term to three years`. **Save version**. | Toast "Saved as v2" with the note under it. The draft text beside the title clears, **Save as version** is disabled, the **Unsaved draft changes** chip is gone. `vers $C_WS` → `{"v":2,"note":"Term to three years",…}`; `wcopy $C_WS` → `null`. |
| 4 | API refusals: `savev $COUNSEL_A $C_WS '{"note":"ok"}'`, then `savev $COUNSEL_A $C_WS '{"note":"Nothing here"}'`. | First: `code` "NOTE_REQUIRED", `detail` "Say what changed in this version (at least 3 characters).", HTTP 400. Second (no draft changes): `code` "NO_WORKING_COPY", "There are no draft changes to save.", HTTP 409. |
| 5 | `putwc $COUNSEL_A $C_WS 's/three years/four years/'` then `savev $COUNSEL_A $C_WS '{"note":"Term to four years","sendToCounterparty":{"method":"share_link"}}'`, then `vers $C_WS`. | `putwc` → revision 1, HTTP 200. `savev` → `detail` "Missing permission: configure:contract", HTTP 403, and **no** v3: the send is checked before anything is saved. |
| 6 | `savev $COUNSEL_A $C_WS '{"note":"Term to four years","resetApprovals":true}'` | HTTP 201, `v` 3, `approvals` "rules": the box is ignored from someone without `configure:workflow`. |
| 7 | As legalops-a: `putwc $LEGALOPS_A $C_WS 's/four years/three years/'` then `savev $LEGALOPS_A $C_WS '{"note":"Back to three years","resetApprovals":true}'`. In the browser as legalops-a, type in the workspace and open **Save as version**. | `approvals` "reset_all", `v` 4. The dialog shows **Reset approvals**, "Every approver is asked again, whatever the workflow's rules say for this change." Its send options are Word and PDF only. Cancel, and **Back** → **Discard**. |
| 8 | As admin-a (private window), open `$C_SEND`'s workspace. In section 1 change `data-sharing pilot` to `data-sharing pilot in Q4`. **Save as version** → tick **Send to counterparty**. | Four options: **Share link**, **Email**, **Word (tracked changes)**, **PDF**, and **Reset approvals**. Share link's hint: "A link they can open to read, comment on and upload their reply." |
| 9 | Pick **Email** and leave the address empty. Hover the button. | It reads **Save and send** and is disabled: "Enter the email address to send it to." Hint: "The link is emailed to them." |
| 10 | Address `counterparty@example.test`, message `QA: our first draft`, note `Pilot in Q4`. **Save and send**. | Toasts "Saved as v2" and "Emailed to counterparty@example.test" (with email not set up: "Link made, but the email was not sent", "Email isn't set up. Copy the link and send it yourself: <portal URL>"). Mailpit: an email to counterparty@example.test with the link and the message. The banner reads "Negotiate · Counterparty's turn". `vers $C_SEND` shows v2 "Pilot in Q4". Save the link: `export PORTAL=<the URL> TOKEN=${PORTAL##*/portal/}`. |
| 11 | As counsel-a on `$C_WS`'s **contract page**: **Edit**, change `three years` to `two years`, **Save as version**, tick **Send to counterparty**, **Word (tracked changes)**, note `Back to two years`, **Save and send**. | Toast "Saved as v5". Then a red notice: "There is no Word file of theirs to mark up: this contract came as a PDF, or was drafted here. Use Export › Word (tracked) to send a comparison between two versions instead." The banner still reads Draft: a Word send changes the turn only once the file is made. |
| 12 | Same page: **Edit**, change `two years` to `three years`, **Save as version** → **Send to counterparty** → **PDF**, note `PDF for Initech`, **Save and send**. | Toast "Saved as v6"; the version's PDF opens in a new tab (if Gotenberg hasn't rendered it yet: toast "The PDF could not be downloaded", "No file stored for this version"; the version and the turn change stand). The banner reads "Negotiate · Counterparty's turn". Put it back: banner **⋯** → **Back to drafting…**, reason `QA`. |
| 13 | Now the same from the **workspace** (regression: it used to download nothing). As counsel-a, `$C_WS`'s workspace: change `three years` to `two years`, **Save as version** → **Send to counterparty** → **Word (tracked changes)**, note `Word from workspace`, **Save and send**. | Toast "Saved as v7", then a red toast "The Word file could not be made" with "There is no Word file of theirs to mark up: this contract came as a PDF, or was drafted here. Use Export › Word (tracked) to send a comparison between two versions instead." Where the counterparty has sent a Word file (`$C_SEND` after E2E-SUG-03) the file downloads instead, with the toast "Downloaded <file name>" and "Their Word file, with your changes as tracked changes. Open it in Word to check, then send it." |
| 14 | Same workspace: change `two years` back to `three years`, **Save as version** → **Send to counterparty** → **PDF**, note `PDF from workspace`, **Save and send**. | Toast "Saved as v8"; the version's PDF opens in a new tab, or a red toast "The PDF could not be downloaded" with the server's reason (Gotenberg not done). Never silence. Put it back to drafting as in step 12. |

**Also check**
- `savev $ADMIN_B $C_WS '{"note":"x y z"}'` → `404` "Contract not found" (not "no draft changes").
- Bad method: `-d '{"note":"abc","sendToCounterparty":{"method":"fax"}}'` → `400` "sendToCounterparty.method must be one of
  share_link, email, word, pdf". Email without address → `400` "An email address is needed to send it by email."
- A note over 2,000 characters → `400` "Keep the note under 2,000 characters."
- The same words as the version (type a letter, delete it, save) → toast "No changes to save", no new version.
- Audit (admin-a, Admin → Organization → **Audit Log**): `CONTRACT_UPDATED` on each version with `metadata.action`
  "document_edited", `via` "working_copy", the `changeNote`, and `approvals` when it was overridden.

- A send the server could not complete after saving (for example the link refused) shows a red toast
  "Saved as v<n>, but not sent" with the reason; the version stands. The contract page and the workspace share this
  code (`sendAfterSave.ts`), so both behave the same.

**Known limits**
- Only admins can share by link or email (`configure:contract`, by design: Appendix A), so for everyone else the send
  options are Word and PDF.
- "Reset approvals" only matters while the contract is in Approve; elsewhere the answer just echoes it.

### E2E-WSP-04 · Leaving with draft changes asks first: save them as a version, keep them for later, or discard them

**Covers:** /contracts/:id/workspace (Back) · /contracts/:id (Edit → Done, Esc, links) · `DELETE /contracts/:id/working-copy` · LeaveDraftPrompt · audit `draft_changes_discarded`
**Roles:** counsel-a · **Needs:** nothing extra · **Time:** ~10 min

**Preconditions**
- `$C_WS` is in Draft with no draft changes (`wcopy $C_WS` → `null`).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$C_WS`'s workspace. In section 8 add `QA leave test.` at the end. Wait for "Draft changes saved · not a version yet". Click **Back**. | Dialog **Your changes aren't a version yet**: "They're saved as draft changes. Save them as a version now, keep them as draft changes to finish later, or discard them." Buttons **Discard**, **Keep as draft changes**, **Save as version**. × or a click outside closes it and stays. |
| 2 | **Keep as draft changes**. | The contract page opens; its banner shows **Unsaved draft changes**. `wcopy $C_WS` is not null. |
| 3 | **Open workspace** again. | The document opens on the draft changes ("QA leave test." is there). |
| 4 | **Back** → **Discard**. | The contract page; no chip. `wcopy $C_WS` → `null`. Audit: `CONTRACT_UPDATED` with `metadata.action` "draft_changes_discarded". |
| 5 | Workspace again: type `QA save on leave.` in section 8, **Back** → **Save as version**. | The Save as version dialog opens. Note `Leave test`, **Save version** → toast "Saved as v7" (or the next number) and the contract page opens. |
| 6 | Contract page: **Edit**, type a word, then click **Done**. Repeat with Esc, then with a click on **Contracts** in the left rail. | Each time the same dialog. **Keep as draft changes** after the link click goes on to the Contracts list. Then discard them from the workspace (**Back** → **Discard**). |

**Also check**
- With no draft changes, **Back**, **Done** and Esc leave at once.
- `curl -s -X DELETE $API/contracts/$C_WS/working-copy -H "Authorization: Bearer $COUNSEL_A"` with nothing to discard →
  `{"discarded":false}`; as viewer-a → `403` "Missing permission: edit:contract".

**Known limits**
- The browser's back button and closing the tab don't show this dialog; the draft changes are kept (closing during
  typing shows the browser's own "Leave site?").

### E2E-WSP-05 · Two editors: a save on an old revision is refused, and the editor offers to reload their changes or overwrite them; draft changes made on an older version can't silently undo a newer one

**Covers:** /contracts/:id/workspace · `PUT /contracts/:id/working-copy` (409 WORKING_COPY_CONFLICT) · `POST /contracts/:id/versions/from-working-copy` (409 BASE_CHANGED, `overwriteNewer`) · `POST /contracts/:id/html-version` · WorkingCopyConflictDialog
**Roles:** counsel-a, admin-a · **Needs:** two browsers · **Time:** ~15 min

**Preconditions**
- `$C_WS` in Draft, no draft changes. Browser A: counsel-a. Browser B (private window): admin-a. Both open
  `$WEB/contracts/$C_WS/workspace` **before** either types.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | A: add `Editor A.` at the end of section 8. Wait for "Draft changes saved · not a version yet". | `wcopy $C_WS` → `revision` 1, `by` counsel-a. |
| 2 | B: add `Editor B.` at the end of section 6. | B's save is refused. Dialog titled "<counsel-a's name> saved changes just now.", "Your latest typing isn't saved. Load their changes (yours since are lost), or overwrite theirs with yours." Buttons **Reload their changes** and **Overwrite**. |
| 3 | B: **Reload their changes**. | B's document now has "Editor A." and not "Editor B.". |
| 4 | B: add `Editor B again.` to section 6 and wait for the save. Then A: type a word anywhere. | B saves (revision 2). A gets the dialog, naming admin-a. |
| 5 | A: **Overwrite**. | A's text is saved over B's: `wcopy $C_WS` → `revision` 3, `by` counsel-a; the document has A's words, not "Editor B again." |
| 6 | API: `curl -s -X PUT $API/contracts/$C_WS/working-copy -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"html":"<p>stale</p>","revision":1}' \| jq '{code, detail, current: .current.revision}'` | `409`, `code` "WORKING_COPY_CONFLICT", "<counsel-a's name> saved changes to this draft since you loaded it.", `current` 3. Nothing changed. |
| 7 | A: **Back** → **Keep as draft changes**. Now make a version another way, as admin-a: `H=$(curl -s $API/contracts/$C_WS -H "Authorization: Bearer $ADMIN_A" \| jq -r '.versions \| max_by(.versionNumber).htmlContent' \| sed 's/three years/five years/'); curl -s -X POST $API/contracts/$C_WS/html-version -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d "$(jq -n --arg h "$H" '{htmlContent:$h, changeNote:"Five years (admin)"}')" \| jq .versionNumber` | A new version number (call it vN). |
| 8 | A: **Open workspace**. | Toast "These draft changes were started on an older version", "They were made on v<N-1>; a newer version was saved since." `wcopy $C_WS` → `stale` true. |
| 9 | A: **Save as version**, note `Editor A's words`, **Save version**. | The dialog stays open with the red message "These changes were made on v<N-1>, and v<N> was saved since by <admin-a's name>. Saving them as they are would undo v<N>'s changes." No version is made. |
| 10 | Decide by API, as the dialog can't: `savev $COUNSEL_A $C_WS '{"note":"Editor A over v<N>","overwriteNewer":true}'`. Then in A, **Cancel** and reload. | HTTP 201, a new version; `wcopy` → `null`. The document reads "three years" again (A's draft undid v<N>, as asked). |

**Also check**
- B, still open on the old revision after step 10, types: dialog "These draft changes were saved as a version or
  discarded since you loaded them." with **Reload** and **Overwrite**.
- Two first saves at the same moment (both on revision 0): one wins, the other gets the 409 dialog.

**Known limits**
- There is no merge: one person's typing replaces the other's. "Reload their changes" loses yours since the last save.
- After a BASE_CHANGED refusal the dialog offers no "save anyway"; only the API's `overwriteNewer` does. The way out
  in the browser is to discard and redo the edit on the newer version.

### E2E-WSP-06 · Draft changes become a version on their own: before submitting for approval, before sending, and after 30 minutes untouched

**Covers:** `lib/working-copy.ts saveDraftChangesBefore` · `POST /contracts/:id/submit-approval` · `POST /contracts/:id/share` · agent.worker `working-copy-idle` job · `PATCH /organization` (`settings.workingCopyIdleMinutes`) · `WORKING_COPY_IDLE_MINUTES`
**Roles:** counsel-a, admin-a · **Needs:** an approval workflow that applies to NDAs (§5 / the seeded default) · **Time:** ~15 min

**Preconditions**
- A third contract: `export C_AUTO=$(upload ~/qa-docs/QA-NDA.txt text/plain "QA Auto NDA" "Initech Solutions LLC"); waitdone $C_AUTO`.
- As admin-a, idle after one minute: `curl -s -X PATCH $API/organization -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"settings":{"workingCopyIdleMinutes":1}}' | jq .settings.workingCopyIdleMinutes` → `1`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$C_AUTO`'s workspace as counsel-a. Add `Idle test.` to section 8. Close the tab after the save. Wait 70 s. | API log: `[agent-worker] working-copy-idle contractId=<C_AUTO> saved as v2`. `vers $C_AUTO` → v2 "Auto-saved after inactivity", made by counsel-a's id. `wcopy $C_AUTO` → `null`. |
| 2 | Workspace again: add `Typed again.`, wait for the save, then within the minute add `And again.`. Wait 70 s after the last save. | One version only (v3, "Auto-saved after inactivity"), holding both edits: each save pushes the checkpoint back. |
| 3 | Add `Before sending.` and, as soon as it's saved, as admin-a: `curl -s -X POST $API/contracts/$C_AUTO/share -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"permissions":["read","comment"]}' \| jq -r .portalUrl` | A portal URL. `vers $C_AUTO` → a new version "Saved before sending to the counterparty"; `wcopy` → `null`. Open the URL in a private window: the document has "Before sending." |
| 4 | Banner **⋯** → **It’s our turn**. Add `Before submitting.`, wait for the save, then the banner's **Submit for approval** → choose the workflow → send. | The approval request is made. `vers $C_AUTO` → a new version "Saved before submitting for approval"; the approval (`curl -s $API/contracts/$C_AUTO/approval -H "Authorization: Bearer $ADMIN_A" \| jq .current.versionId`) is that version's id (compare with `curl -s $API/contracts/$C_AUTO -H "Authorization: Bearer $ADMIN_A" \| jq .currentVersionId`). |
| 5 | Put the setting back: `-d '{"settings":{"workingCopyIdleMinutes":30}}'`. | `30`. |

**Also check**
- Typed and undone (the text equals the version) before a submit: no version is made and the draft changes are cleared.
- `workingCopyIdleMinutes: 0` (or `WORKING_COPY_IDLE_MINUTES=0` in `.env`) turns the idle checkpoint off.
- Draft changes started on an older version (E2E-WSP-05 step 8) block a submit: `409`, the BASE_CHANGED message
  followed by "Open the editor and save or discard the draft changes first."; the idle job leaves them alone
  (log "kept as draft changes: BASE_CHANGED").

**Known limits**
- The idle version is made in the name of whoever saved last, with a fixed note; it is analysed like any other.
- The delay is read at each save: changing the setting affects saves made after it.

### E2E-CHG-01 · Regression (15, Redline vs Compare): one Changes mode in the workspace, against a baseline you pick, with the Word redline; Compare, the history and the rail all open it

**Covers:** /contracts/:id/workspace?mode=changes · /contracts/:id (Compare, Actions → Compare versions, rail "Changes", History → "Compare with vN") · `GET /contracts/:id/changes` · `GET /contracts/:id/versions/:v1Id/redline-docx/:v2Id` · ChangesView · `lib/review-findings.ts resolveBaseline` · scripts/p74-15-verify.mjs · scripts/redline/p4-ui-verify.mjs
**Roles:** counsel-a, viewer-a · **Needs:** Word or LibreOffice · **Time:** ~20 min

**Preconditions**
- `$C_NY2` (drafted from the Mutual NDA template in E2E-DRF-05) is analysed, with one version.
- `$C_WS` from the journeys above (several versions, no draft changes).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$C_NY2`. Hover **Compare** in the header. | It is disabled: "Upload a second version to compare. Until then there is nothing to diff." |
| 2 | **Open workspace**. In the term section change one number (e.g. `12` → `18` months, or any word in the term). **Save as version**, note `Term change`. **Back**, then click **Compare**. | **Compare** is now enabled (title "Compare two versions with redline attribution"). It opens `$WEB/contracts/$C_NY2/workspace?mode=changes`; the header's **Changes** button is pressed. No overlay, no "Negotiate" tab, no "Analyze Redlines" button anywhere. |
| 3 | Read the bar above the document. | "Changes since" and a picker whose first entry reads "v1 · the version generated from the template". Then "1 change to decide" (or the number you made). Right: **Word with tracked changes** (title "A Word file with tracked changes from v1 to v2"). |
| 4 | Open the picker. | Entries: the first (the review's baseline), **The template’s first draft**, then each version: "v2 · Term change", "v1". |
| 5 | Look at the document and the list beside it. Click a change in the list. | The document shows the diff in place: removed words struck through, added words underlined. Each list card: the old words struck → the new words, then (when the review has a finding for that change) its title; buttons **Accept change**, **Keep original**, **Counter…**, **Comment**. Clicking a card scrolls the document to that change and outlines the card. |
| 6 | Pick "v2 · Term change". | "No changes since v2." |
| 7 | Pick the first entry again. Click **Word with tracked changes**. Open the file. | A download `redline-v1-to-v2.docx`. Word shows the change as a tracked insertion and deletion. |
| 8 | Toggle **Changes** off. Type `Draft words.` in the last section, wait for the save, toggle **Changes** on. | "Shown with your draft changes"; the new words are a change in the list. The Word button's title adds "(saved versions only, not your draft changes)". **Back** → **Discard**. |
| 9 | `chg $C_NY2` then `chg $C_NY2 origin`, `chg $C_WS origin`, `chg $C_WS nope`. | First: `baseline` `{versionNumber:1, reason:"origin", words:"the version generated from the template"}`, `against.kind` "version", `stats` with insertions/deletions, `origin` = v1's id. Second: the same baseline. `$C_WS` origin: `404` "This contract was not generated from a template." `nope`: `404` "Version not found". |
| 10 | On `$C_WS`'s contract page: in the rail's **Related documents** section click **Changes**; then (window under 1280 px) **Actions** → **Compare versions**. | Each opens `$C_WS`'s workspace in Changes mode. |
| 11 | Back on the contract page: **History** → on an older version (say v3), **Compare with v2**. | The workspace opens in Changes mode on **that pair**: the URL carries `mode=changes&baseline=<v2's id>&current=<v3's id>`, the bar reads "to v3" and "<n> changes" (no "to decide"), and a note "Comparing two saved versions. To accept or counter a change, compare with the document as it stands." with **Compare with the document**. The cards have no **Accept change**, **Keep original** or **Counter…**. |
| 12 | Click **Compare with the document**. API: `curl -s "$API/contracts/$C_WS/changes?baseline=<v2's id>&current=<v3's id>" -H "Authorization: Bearer $COUNSEL_A" \| jq '.against'` | The bar goes back to "<n> changes to decide" against the document as it stands. API: `{kind:"version", versionNumber:3, latest:false, …}`. `current=nope` → `404` "Version not found". |
| 13 | From the repo root: `node scripts/p74-15-verify.mjs` and `node scripts/redline/p4-ui-verify.mjs`. | Both end without a failed check (p74-15 opens the workspace's Changes mode from Compare; p4-ui downloads a real .docx from it). |

**Also check**
- viewer-a: Changes mode works and downloads the Word file; the cards have no buttons.
- A contract with one version: Changes mode says "There is no earlier version to compare with."
- `curl -s $API/contracts/$C_WS/changes -H "Authorization: Bearer $ADMIN_B"` → `404` "Contract not found".

**Known limits**
- A very large diff answers `422` with the "too large" message instead of a view.
- The Word redline compares saved versions; draft changes are not in it.

### E2E-CHG-02 · Decide each change in place: Accept change, Keep original, Counter… (AI drafts it with why) or Comment; decisions go to the draft changes, not to a version

**Covers:** /contracts/:id/workspace?mode=changes · `GET /contracts/:id/changes` · `POST /contracts/:id/changes/counter` (agents `/redline/counter`) · `POST /contracts/:id/findings/:findingId/accept` · `POST /contracts/:id/findings/:findingId/resolve` · `PUT /contracts/:id/working-copy` · `lib/changes.ts applyDecisions`
**Roles:** counsel-a, viewer-a · **Needs:** agents service + model key · **Time:** ~20 min

**Preconditions**
- `$C_WS` in Draft, no draft changes, analysed. Make a version with three changes and wait for its analysis:
  `putwc $COUNSEL_A $C_WS 's/three years/one year/; s/ and no less than reasonable care//; s/State of New York/State of Delaware/'`
  then `savev $COUNSEL_A $C_WS '{"note":"Three changes"}'` (note its `v`), then wait two minutes (the checkpoint) and `waitdone $C_WS`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$C_WS`'s workspace → **Changes**. In the picker choose the version before "Three changes". | "3 changes to decide", or a few more: the diff is word by word, so a replacement can show as two cards. The cards: "three years → one year" (or "three → one" and "years → year"), the struck words "and no less than reasonable care", "New York → Delaware". Cards with a review finding show its title. |
| 2 | On "three years → one year": **Accept change**. | The card fades and reads "Accepted". The count: "2 changes to decide · 1 accepted". The document text is unchanged and no draft changes appear (`wcopy $C_WS` → `null`). If the card had a finding, it is accepted in the Review tab ("Accepted their change"). |
| 3 | On "New York → Delaware": **Keep original**. | Beside the title "Saving…" then "Draft changes saved · not a version yet". The list refreshes without that change; the document reads "State of New York" again. `wcopy $C_WS` → revision 1. Its finding, if any, is resolved. |
| 4 | On the struck "and no less than reasonable care": **Counter…**. | The button spins. Changes mode closes and the document shows the counter wording **as a suggestion** (underlined in your colour, by you) at the place their words were removed, not as plain text. Toast "Counter put in as a suggestion" with the model's one-line reason and "Their words were: “…”". Facts: it restores a standard of care in section 4; the wording varies. The suggestion can be accepted or rejected like any other (E2E-SUG-02). `aiev $C_WS` lists `counter\|shown\|1` and `counter\|accepted\|1`. |
| 5 | Turn **Changes** back on. On any remaining card: **Comment**. | The right panel switches to **Comments** with the composer filled with “<the change's words>” and a space. Cancel it (clear the box). |
| 6 | `vers $C_WS` | No version was made by any decision. **Save as version**, note `Decided their changes` → toast "Saved as v<n>". |

**Also check**
- `curl -s -X POST $API/contracts/$C_WS/changes/counter -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{}'`
  → `400` "Send the original words and theirs."; as viewer-a → `403` "Missing permission: edit:contract".
- Agents service stopped: **Counter…** → toast "No counter drafted", "The counter could not be drafted. Try again." (`502`).
- Over the day's AI budget: `429` "Today's AI budget is used up. Try again tomorrow."
- Their words no longer in the document (edit them away in another tab first): toast "Counter not put in", "Their words
  weren't found in the document. Put the counter in yourself: “<the counter>”".

**Known limits**
- **Accept change** is remembered only on the page: after a reload the change is listed again (its finding stays accepted).
- A comment started from a change is not anchored to its words.
- **Keep original** and **Counter…** are disabled while suggestions are pending (E2E-SUG-02).

### E2E-CHG-03 · The counterparty sends a version: its changes are advised on automatically, and the banner says what they sent, with Review changes

**Covers:** /portal/:token (Download .docx, Upload revised) · `POST /portal/:token/versions` · parse worker · findings · agent.worker `change-advice` job (agents `/redline/score`) · `lib/change-advice.ts` (counterpartySummary) · `GET /contracts/:id/stage` (`counterparty`, `next.kind` review_changes) · StatusBanner · ReviewPanel advice · ChangesView advice · `review_findings.advice`
**Roles:** counsel-a, counterparty (portal) · **Needs:** agents service + model key, Word · **Time:** ~25 min

**Preconditions**
- E2E-WSP-03 done: `$C_SEND` is "Negotiate · Counterparty's turn", and `$PORTAL` / `$TOKEN` hold its link.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Private window: open `$PORTAL`. Click **Download .docx**. Open it in Word with Track Changes **off**. Make these edits: in section 5 `two years` → `one year`; delete the whole of section 7 (Governing Law); at the end of section 8 add `Either Party may assign this Agreement to an affiliate without consent.` Save as `QA-SEND-THEIRS.docx`. | A Word file of v2. |
| 2 | In the portal click **Upload revised** and choose the file. | The upload is accepted. As counsel-a: `vers $C_SEND` → v3 with `by` "portal:<link id>". |
| 3 | `waitdone $C_SEND`, then `stage $C_SEND` every 30 s until `counterparty.advised` is true. | `stage` "negotiate", `turn` "internal", `next` `{kind:"review_changes", label:"Review changes"}`, `counterparty` `{versionNumber:3, changes, needAttention, missingRequired, advised}`. API log: `[worker:agents] ✓ job done name=change-advice`. |
| 4 | Check the counts: `V=$(curl -s $API/contracts/$C_SEND -H "Authorization: Bearer $ADMIN_A" \| jq -r .currentVersionId); sql "SELECT kind, status FROM review_findings WHERE \"versionId\"='$V' ORDER BY kind"` | `changes` = rows whose kind is modified, added, deleted or material_cut. `needAttention` = open rows other than missing_required, drafting and compliance. `missingRequired` = open missing_required rows. The deleted Governing Law is a `deleted` row. |
| 5 | As counsel-a open `$C_SEND` (the Contracts row opens the workspace). Read the banner. | "Negotiate · Our turn", then "Counterparty sent v3 — <changes> changes, <n> need attention" (", <m> required clause(s) missing" only when m > 0; "1 needs attention" in the singular), and the primary button **Review changes**. While the advice is still being worked out, the line's tooltip is "AI advice on their changes is still being worked out." |
| 6 | Click **Review changes**. | Changes mode, baseline "v2 · the last version sent to the counterparty". Cards for the term, the deleted section 7 and the new assignment sentence. Under a card with advice: "AI: Accept.", "AI: Counter." or "AI: Push back." and the model's reason. |
| 7 | **Review** tab. Find the Governing Law finding. | Under it, in the AI colour: "AI suggests accepting.", "AI suggests a counter." or "AI suggests pushing back." with the reason, and, when the model gave one, "Suggested counter: “…”". Judge the facts: deleting governing law should not be advised as a plain accept. |
| 8 | `sql "SELECT kind, advice->>'recommendation', left(advice->>'reasoning',80) FROM review_findings WHERE \"versionId\"='$V' AND advice IS NOT NULL"` and `curl -s $API/contracts/$C_SEND/analysis-runs -H "Authorization: Bearer $COUNSEL_A" \| jq -c '.data[0].steps[]? \| {name, status}'` | Advice rows for the change findings, `recommendation` accept, counter or reject. The newest run has a `change_advice` step, done. |

**Also check**
- Nothing to click: there is no "Analyze Redlines" or "Analyse redlines" button on either page.
- A version we make ourselves (not portal or email) gets no advice: `sql "SELECT metadata->'_changeAdvice' FROM contract_versions WHERE id='<our version>'"` → empty.
- A counterparty reply by email (docs/40's inbound email journey) makes a version by `email:<…>` and gets the same banner.
- The advice is worked out once per version and baseline; re-analysing the same version keeps it.

**Known limits**
- The banner line appears only once the version's findings exist, and only while the next action is **Review changes**.
- Advice is matched to a finding by shared words; a change the model scores that matches no finding shows no advice.

### E2E-CMT-01 · Threads are internal unless marked external; the portal sees and writes only external threads; a thread the counterparty started stays external and keeps their name

**Covers:** /contracts/:id/workspace (Comments) · /portal/:token (Comments) · `GET/POST /contracts/:id/comments` · `PATCH /contracts/:id/comments/:commentId` · `GET/POST /portal/:token/comments` · `contract_comments.visibility`, `authorName` · audit COMMENT_ADDED, COMMENT_VISIBILITY_CHANGED
**Roles:** counsel-a, counterparty (portal), admin-a · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- E2E-CHG-03 done: `$C_SEND` is "Negotiate · Our turn"; `$PORTAL` / `$TOKEN` hold its link (read, comment, upload).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As counsel-a, `$C_SEND`'s workspace → **Comments**. | A composer: placeholder "Write a comment for your side…", a choice **Internal** (lock, selected) / **External** (globe), button **Comment**. |
| 2 | Type `QA internal: check the term with finance.` → **Comment**. | Toast "Comment added". A thread with a grey lock **Internal** (title "Only your side can see this thread"), counsel-a's name and the time. |
| 3 | Choose **External**. | Placeholder "Write a comment the counterparty will see…". Type `QA external: why one year?` → **Comment** → toast "Comment shared with the counterparty". The thread is tinted, with a globe **External** (title "The counterparty can see this thread"). |
| 4 | `threads $C_SEND` and `curl -s $API/portal/$TOKEN/comments \| jq -c '.data[] \| {visibility, authorName, body, fromCounterparty}'` | Ours: two threads, `internal` and `external`, `authorName` counsel-a's name. The portal: only the external one, `authorName` counsel-a's name, `fromCounterparty` false. |
| 5 | Portal (private window) → **Comments** tab. | Only "QA external: why one year?". Reply to it with name `Priya (Initech)` and `Because of the pilot.`; then add a new comment: name `Priya (Initech)`, `Section 8 must stay as we wrote it.` → **Post comment**. |
| 6 | Workspace → Comments (reload if needed). | Under the external thread a reply by "Priya (Initech)". A new External thread by "Priya (Initech)" with **Reply** and **Resolve** but no "Mark thread as internal". |
| 7 | On the internal thread: **Reply** (placeholder "Reply…") `Finance agrees.` → **Reply**. Then **Mark thread as external**. | Toast "The counterparty can see this thread now". The portal's Comments now shows it with its reply. |
| 8 | **Mark thread as internal** on it. | Toast "Thread is internal now". The portal no longer shows it (or its reply). |
| 9 | API checks, with `T_INT=<the internal thread id>` and `T_THEIRS=<Priya's thread id>` from `threads $C_SEND`: (a) `curl -s -X POST $API/portal/$TOKEN/comments -H 'content-type: application/json' -d "{\"body\":\"sneak\",\"parentId\":\"$T_INT\"}"`; (b) `curl -s -X PATCH $API/contracts/$C_SEND/comments/$T_THEIRS -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{"visibility":"internal"}'`; (c) the same PATCH with `"visibility":"secret"`. | (a) `404` `{"error":"Comment not found"}`. (b) `409` "The counterparty started this thread, so it stays external." (c) `400` "visibility must be internal or external". |
| 10 | Workspace: **Resolve** Priya's thread. Use the filters **Open** / **Resolved** / **All** and **Everyone** / **Internal** / **External**. | It shows "Resolved" and leaves the Open list. It is still by "Priya (Initech)" (not by counsel-a): `threads $C_SEND visibility=external` → that thread `resolved` true, `authorName` "Priya (Initech)". |

**Also check**
- A reply posted on a thread takes the thread's visibility, whatever the body says; PATCH `visibility` on a reply →
  `400` "A reply follows its thread. Mark the thread instead."
- viewer-a sees the threads but no composer, Reply, Resolve or Mark buttons; `POST …/comments` as viewer-a → `403`.
- An expired or revoked link: `GET /portal/<token>/comments` → `401` "Invalid or expired share link".
- Audit: `COMMENT_ADDED` with `metadata.visibility`; `COMMENT_VISIBILITY_CHANGED` with `from` and `to`.

**Known limits**
- The portal's Comments tab lists threads; it does not place them beside the words.
- Comments made before this branch became internal, except threads the counterparty started in the portal (and their replies),
  which became external.

### E2E-CMT-02 · Regression (12, Comments tab): a thread sits beside its words in the margin, is found again in later versions or says "Text no longer in the document", and the contract page lists threads to read

**Covers:** /contracts/:id/workspace (margin, Comments, selection → Comment) · /contracts/:id (Comments tab, rail "Comments", selection → Comment) · `GET /contracts/:id/comments?versionId=` · `lib/comment-anchors.ts` · `@clm/types resolveCommentAnchor` · MarginComments
**Roles:** counsel-a · **Needs:** a window at least 1280 px wide · **Time:** ~15 min

**Preconditions**
- `$C_WS` in Draft, no draft changes, section 6 reading "…return or destroy the other Party's Confidential
  Information…".

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `$C_WS`'s workspace. Select `return or destroy the other Party's Confidential Information` in section 6. In the bubble menu click **Comment**. | The right panel opens **Comments**; the composer shows the quote “return or destroy…” with an × ("Comment on the whole document instead"). |
| 2 | Type `QA anchored note` → **Comment**. | The thread lists the quote. A compact card appears in the right margin level with section 6. |
| 3 | Click the margin card; then in the list click **Show in document**. | The Comments tab marks the thread (a ring); the document scrolls to the words and selects them. |
| 4 | Add a new first paragraph `QA preamble paragraph.` above section 1. **Save as version**, note `Moved words`. `threads $C_WS` | The margin card moves down with its words. The thread: `anchorState` "moved" (or "anchored"), `quote` unchanged. |
| 5 | Delete the whole sentence of section 6. **Save as version**, note `Removed return clause`. | The margin card is gone. The thread reads, in grey italics, "Text no longer in the document: “return or destroy the other Party's Confidential Information…”" and has no **Show in document**. `threads $C_WS` → `anchorState` "orphaned". |
| 6 | Read it against the earlier version: `threads $C_WS "versionId=<id of the version before 'Removed return clause'>"` | `anchorState` "anchored" or "moved" again. |
| 7 | **Back**. On the contract page's rail, section **Comments**: "N comments. Open the thread" → click **Open the thread**. | The **Comments** tab: "N threads", a link **Comment in the workspace**, and each thread read-only (no Reply, Resolve or Mark buttons). There are no **Activity**, **Versions** or **Approval history** tabs (E2E-LIF-05). |
| 8 | Click **Comment in the workspace**. | The workspace opens. |
| 9 | Back on the contract page (not editing), select a few words of the document. In the menu click **Comment**. Then switch to the original file view and do the same over the PDF text. | A small **Comment** box opens over the words, with the composer and the quote. The comment is saved with that quote. |

**Also check**
- `curl -s -X POST $API/contracts/$C_WS/comments -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d "{\"body\":\"x\",\"anchor\":{\"quote\":\"abc\",\"start\":0,\"end\":3,\"versionId\":\"<a version id of \$C_SEND>\"}}"`
  → `400` "The anchor names a version of another contract".
- Words that occur twice: the thread goes to the occurrence nearest its old place.
- A window under 1280 px: no margin; threads are in the Comments tab only.

**Known limits**
- Threads are placed against the newest **saved** version: deleting their words in draft changes hides the margin
  card but the thread is marked orphaned only once a version is saved.
- A comment over the PDF is anchored to its words, not to a place on the page.

### E2E-CMT-03 · "Document discussion" by person covers comments and suggestions, and a finding offers the playbook's suggested note to the counterparty

**Covers:** /contracts/:id/workspace (Comments → Document discussion, Review → Suggested note to counterparty) · /playbook (position editor) · `PATCH /playbook/positions/:id` (`counterpartyNote`) · `GET /contracts/:id/review` (`counterpartyNote`) · `POST /contracts/:id/comments` (external, anchored)
**Roles:** counsel-a, admin-a · **Needs:** E2E-CMT-01 and E2E-CHG-03 done · **Time:** ~15 min

**Preconditions**
- `$C_SEND` in Negotiate (so edits are suggestions, E2E-SUG-02), with E2E-CMT-01's threads, and the Governing Law
  finding from the counterparty's deletion in its Review tab.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As counsel-a, workspace: add `QA counsel words.` in section 8. Wait for the save. **Back** → **Keep as draft changes**. As admin-a: open the workspace (it loads the draft changes), add `QA admin words.` in section 4, wait for the save. | Each insertion is underlined in its author's colour (two different colours). |
| 2 | As admin-a → **Comments** → **Document discussion**. | A picker "Everyone", then each person with a count: counsel-a (their comments and suggestion), "Counterparty" (Priya's comments), admin-a (1). |
| 3 | Choose admin-a. Then "Counterparty". Then "Everyone". | admin-a: their suggestion is boxed in yellow in the document; their comments (none) highlighted; every thread still listed. Counterparty: Priya's comments and reply are highlighted amber. Everyone: no highlight. |
| 4 | Choose counsel-a, then tick **Only this person** (under the picker: "· hides everyone else’s comments and suggestions"). | Only threads counsel-a started or replied in are listed; Priya's are gone from the list. In the document admin-a's "QA admin words." reads as plain text (no colour, no underline), while counsel-a's "QA counsel words." keeps its colour. Untick it: every thread is back and both suggestions are coloured again. With "Everyone" chosen the box is not shown. |
| 5 | As counsel-a: left rail → **Playbook**. Open the **Governing Law** preferred position (✎). In **Suggested note to counterparty** type `We need New York law, as in our standard NDA.` (helper: "Offered as a comment the counterparty can see, on a finding against this position.") → **Save Position**. | The position card shows "To the counterparty: We need New York law, as in our standard NDA." If there is no Governing Law position, add one (**Add Position**, preferred) with that note. |
| 6 | `rv $C_SEND \| jq -c '[.groups[][] \| select(.counterpartyNote) \| {title, counterpartyNote}]'` | The Governing Law finding with the note. |
| 7 | Workspace → **Review** → that finding: click **Suggested note to counterparty** (tooltip = the note). | The **Comments** tab opens with the composer on **External**, the note as its text, and the finding's quote above it. **Comment** → "Comment shared with the counterparty"; the portal shows it. |

**Also check**
- viewer-a and approver-a don't see **Suggested note to counterparty** (it needs edit rights).
- A finding whose position has no note, and whose clause type's preferred position has none, has no link.
- Saving only the note doesn't re-judge contracts: `curl -s $API/playbook/playbooks -H "Authorization: Bearer $COUNSEL_A" | jq -c '.data[] | {name, version}'`
  shows the same `version` before and after step 5. Changing the position's text bumps it.

**Known limits**
- Picking a person only highlights; hiding the others is the **Only this person** box, and it is not remembered after
  a reload.
- All counterparty authors count as one "Counterparty"; Word authors of imported suggestions are listed by name.

### E2E-SUG-01 · Selected words offer Comment · Ask AI · Tag clause · Make variable · Request exception; Ask AI pages three drafts, each with why, to insert as a tracked change, replace or copy

**Covers:** /contracts/:id/workspace (bubble menu, SelectionMenu) · `POST /contracts/:id/ask-ai` (agents `/redline_propose`, PII redaction) · AskAiDrafts · `GET /contracts/:id/variables` · `POST /contracts/:id/clauses/tag` · `POST /contracts/:id/findings/:findingId/exception` · `lib/tracked-insert.ts`
**Roles:** counsel-a, viewer-a · **Needs:** agents service + model key · **Time:** ~20 min

**Preconditions**
- `$C_NY2` (drafted from our template) in Draft, no draft changes. `$C_WS` (an upload).
- A clause with an open finding that offers an exception:
  `rv $C_SEND | jq -c '[.groups[][] | select(.actions | index("request_exception")) | {title, clauseId}]'` lists at least
  one (else try `$C_WS`). Note its title and find its clause in the document.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `$C_NY2`'s workspace. Select a whole sentence of the confidentiality obligations. | A bubble menu: Bold, Italic, Underline, Heading 2, then **Comment**, **Ask AI** (title "Ask AI to rewrite these words"), **Tag clause**, **Make variable** (title "Mark these words as one of the template’s variables"). No **Request exception** (no finding here offers one). |
| 2 | **Ask AI**. | A popover with the selection, an input "What should change? e.g. make it mutual" and **Draft** (disabled while the input is empty). |
| 3 | Type `make it stricter on the receiving party` → **Draft**. | The button spins, then a draft card: "1 of 3" with ‹ › arrows, the draft's text, "Why: <one line>", and **Insert as tracked change**, **Replace**, **Copy**. Fewer than three only when the model repeated itself or returned the original. |
| 4 | Page with › to "2 of 3", "3 of 3", and back to "1 of 3". **Copy**. | Each page has its own text and "Why:". **Copy** reads "Copied" for a moment; the clipboard holds that draft. |
| 5 | **Insert as tracked change**. | The popover closes. The original sentence stays, struck through; the draft follows it, underlined, both in counsel-a's colour, even though Suggesting is off (Draft stage). The header shows the suggestions' count with **Accept all** / **Reject all**; click the new words → popover "<counsel-a's name>", the time, "Suggested adding: “…”", **Accept** / **Reject**. Then **Accept all**. |
| 6 | Select another sentence → **Ask AI** → `shorter` → **Draft** → **Replace**. | The sentence is replaced directly (no marks), since Suggesting is off. |
| 7 | Select the counterparty's name in the opening paragraph → **Make variable**. | A box **Make variable** with "Find a variable" and the template's variables. Pick the counterparty's. The words are marked as that variable. |
| 8 | Select words → **Tag clause**. | The clause tag picker opens (as in E2E-REV-16). Close it. |
| 9 | `$C_WS`'s workspace: select a sentence. | The menu has no **Make variable** (not drafted from our template). |
| 10 | Open the contract from the preconditions with the exception finding. Select a few words inside that finding's clause. | **Request exception** (title "Ask for an exception: <finding title>"). Click it: dialog **Request exception**, "“<title>” goes to the person who decides exceptions for this kind of clause. They see your reason.", **Why should this be allowed?** (placeholder "For example: the customer is a public body and can't accept a cap above fees."). Reason `QA: pilot only`, **Request exception** → toast "Exception requested". The finding reads "Exception requested — waiting for <approver>"; the banner adds "1 exception to decide". Words outside that clause don't offer it. |
| 11 | **Back** → **Discard** on `$C_NY2` (keep it clean for later), or **Save as version** `Ask AI test`. | — |

**Also check**
- `curl -s -X POST $API/contracts/$C_NY2/ask-ai -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json'`
  with `-d '{"selectedText":"","instruction":"x"}'` → `400` "Select the words to rewrite."; with text and
  `"instruction":""` → `400` "Say what to do with the words."; a 7,000-character selection → `400` "Select at most
  6,000 characters."; no body → `400` "Send the selected words and an instruction."; as viewer-a → `403`.
- Agents service stopped: the popover shows "No drafts could be made. Try again." (`502`).
- viewer-a and approver-a: selecting words in the workspace offers nothing (each action needs edit rights).
- The selected words go to the model under the org's PII mode (§0.6): with "redact", names and amounts are masked on
  the way out and restored in the drafts.

**Known limits**
- **Copy** is not logged as an outcome (E2E-SUG-04).
- The Ask AI drafts come from the clause rewriter; an instruction it can't follow gives fewer than three drafts.

### E2E-SUG-02 · Suggestion mode: on by itself while negotiating, a toggle otherwise; each edit is a suggestion with its author's name, colour and time; accept or reject one or all; the analysis reads the document as if they were accepted

**Covers:** /contracts/:id/workspace (Suggesting, SuggestionsBar, SuggestionPopover, banner "N suggestions pending") · `components/editor/TrackChanges.ts` · `lib/suggestions.ts acceptedHtml` · `lib/version-create.ts` (plainText) · `GET /contracts/:id/changes` (`pendingSuggestions`) · findings
**Roles:** counsel-a, admin-a, viewer-a · **Needs:** agents service + model key (re-analysis) · **Time:** ~25 min

**Preconditions**
- `$C_WS` in Draft, no draft changes, section 7 "Governing Law" present.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `$C_WS`'s workspace. Click **Suggesting** (title "Make your edits suggestions"). | The button is pressed. |
| 2 | In section 5 type ` QA added words` after "two years" / the term. | The new words are underlined and coloured (counsel-a's colour). Header: "1 suggestion", **Accept all**, **Reject all**. Banner: "1 suggestion pending" (title "Findings read the document as if they were accepted"). |
| 3 | Select `prior written` in section 8 and press Delete. | The words stay, struck through in the same colour. "2 suggestions". |
| 4 | Select `entire agreement` in section 8 and type `whole agreement`. | Both: "entire agreement" struck, "whole agreement" underlined after it. |
| 5 | Put the cursor in your own inserted words "QA added words" and delete two letters. | They simply go (your own suggestion is edited, not struck). |
| 6 | Click the struck "prior written". | Popover: counsel-a's name, the time, "Suggested removing: “prior written”", **Accept** and **Reject**. **Reject** → the words are back as plain text. |
| 7 | Bold a word. | It is bold at once: formatting is not tracked. Undo it. |
| 8 | Select the whole of section 7 and delete it (a suggested deletion). **Save as version**, note `Suggest dropping law`. | Toast "Saved as v<n>". The struck section is still visible with its marks after the save. |
| 9 | `curl -s $API/contracts/$C_WS -H "Authorization: Bearer $COUNSEL_A" \| jq -r '.versions \| max_by(.versionNumber) \| .htmlContent' \| grep -o '<del[^>]*data-change-id[^>]*>' \| head -2`, then `curl -s $API/contracts/$C_WS -H "Authorization: Bearer $COUNSEL_A" \| jq '.versions \| max_by(.versionNumber) \| .plainText \| test("Governing Law")'` | The stored HTML keeps the suggestions: `<del …>` tags carrying `data-change-id`, `data-author-id` (counsel-a's id), `data-color`, `data-author` (the name) and `data-time`. The second prints `false`: the version's text reads as if the suggestions were accepted. |
| 10 | Wait for the checkpoint and the analysis (`waitdone $C_WS`). **Review** tab. | A finding that Governing Law was deleted (Needs attention), although the words are still visible struck through. |
| 11 | **Changes**. | A note "<n> suggestions are still pending in the document. The changes here read as if they were accepted; decide them in the document before keeping the original or countering a change." **Keep original** and **Counter…** are disabled with the title "Accept or reject the <n> pending suggestions in the document first". `chg $C_WS` → `pendingSuggestions` n. |
| 12 | Leave Changes. **Reject all**. **Save as version** `Keep the law`. Wait for the analysis. | No suggestions; the banner's pending count is gone. The Governing Law finding is gone from the new version's review. |
| 13 | Banner **⋯** → **Start negotiating**. | Header shows the label **Suggesting** (no toggle). Typing is tracked without pressing anything. |
| 14 | As admin-a, type in the same contract (after counsel-a's save, so no conflict). | admin-a's words take another colour; their popover names admin-a. **Accept all** as admin-a clears every suggestion. |
| 15 | As viewer-a open the workspace while a suggestion is pending. | The header shows "<n> suggestion(s)" without Accept all / Reject all; clicking a suggestion shows who and when, without buttons. |

**Also check**
- Ask AI's **Insert as tracked change** and the playbook's inserted standard wording go in as suggestions too, by the
  person who chose them, whether Suggesting is on or not (E2E-SUG-01 step 5).
- Search and the clause list read the accepted text: search for a word you only suggested deleting; this contract
  should not be a hit for it once the version is indexed.
- Back to drafting (banner **⋯** → **Back to drafting…**, reason `QA`) puts the toggle back.

**Known limits**
- Not tracked: formatting, splitting or joining paragraphs (Enter at the end of a line), tables. Those apply directly.
- Suggestion marks live in the version's HTML; Word export and import are E2E-SUG-03.
- A suggestion can't be commented on as such; select its words and use **Comment**.

### E2E-SUG-03 · Pending suggestions go to Word as tracked changes by their authors, and a returned Word file's tracked changes come back as suggestions

**Covers:** /contracts/:id/workspace · /portal/:token (Download .docx, Upload revised) · `GET /portal/:token/download/docx` · `POST /contracts/export` (docx) · `lib/html-to-docx.ts` (per-suggestion author and date) · `lib/ooxml/docx-suggestions.ts` · parse worker (`suggestions: true`) · `GET /contracts/:id/redline/counterparty`
**Roles:** admin-a, counsel-a, counterparty (portal) · **Needs:** Word (or LibreOffice), agents service + model key · **Time:** ~25 min

**Preconditions**
- E2E-CMT-03 done: `$C_SEND` is in Negotiate with draft changes holding a suggestion by counsel-a ("QA counsel words.")
  and one by admin-a ("QA admin words.").

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As admin-a, `$C_SEND`'s workspace. Select the sentence `Either Party may assign this Agreement to an affiliate without consent.` and delete it. | It is struck in admin-a's colour (Suggesting is on in Negotiate). |
| 2 | **Save as version**, note `Our suggestions`, **Send to counterparty** → **Share link** → **Save and send**. | "Saved as v<n>", "Share link copied". Save the new link as `PORTAL2`. The suggestions are still pending in the document. |
| 3 | Private window: open `$PORTAL2` → **Download .docx**. From a terminal: `unzip -p ~/Downloads/<that file>.docx word/document.xml \| grep -oE '<w:(ins\|del) [^>]*>' \| grep -oE 'w:author="[^"]*"' \| sort \| uniq -c` | Two authors: counsel-a's name (the insertion) and admin-a's (an insertion and the deletion), not one author for all. In Word, **Review → Reviewing Pane** lists each change by that person, dated when it was made. |
| 4 | In Word set your user name to `Initech Legal` (Word → Preferences/Options → User Information). With **Track Changes on**, accept nothing, and: add `QA Word insert.` at the end of section 2; delete the word `promptly` in section 6. Save as `QA-SEND-TRACKED.docx`. In the portal, **Upload revised** that file. | The upload is accepted. |
| 5 | `waitdone $C_SEND`. As counsel-a open the workspace. | New version from the portal. The document shows suggestions: "QA Word insert." underlined and "promptly" struck in a new colour; click one → popover "Initech Legal", Word's date, "Suggested adding: “QA Word insert.”" (or removing). The earlier suggestions come back too, under counsel-a's and admin-a's names as Word recorded them. Banner: "<n> suggestions pending". |
| 6 | `curl -s $API/contracts/$C_SEND -H "Authorization: Bearer $COUNSEL_A" \| jq -r '.versions \| max_by(.versionNumber) \| .htmlContent' \| grep -oE 'data-author-id="word:[^"]*"' \| sort -u` | `data-author-id="word:Initech Legal"` (and `word:<counsel-a's name>`, `word:<admin-a's name>`). |
| 7 | **Comments** → **Document discussion**. | "Initech Legal" is listed with a count. |
| 8 | Accept "QA Word insert.", reject the deletion of "promptly" (popover buttons). **Save as version**, note `Decided Word changes`. | Saved; those two suggestions are gone, the others remain pending. |
| 9 | Contract page: **Edit**, type `QA after Word.` in section 8, **Save as version** → **Send to counterparty** → **Word (tracked changes)** → **Save and send**. | A Word file downloads and a notice "Downloaded <file name>." with the change counts. It is their file (QA-SEND-TRACKED) with our changes since it as tracked changes. The banner reads "Negotiate · Counterparty's turn". |
| 10 | API export of any HTML with suggestions: `H=$(curl -s $API/contracts/$C_SEND -H "Authorization: Bearer $COUNSEL_A" \| jq -r '.versions \| max_by(.versionNumber) \| .htmlContent'); curl -s -X POST $API/contracts/export -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d "$(jq -n --arg h "$H" '{html:$h, format:"docx", filename:"qa-sugg"}')" -o qa-sugg.docx; unzip -p qa-sugg.docx word/document.xml \| grep -oE 'w:author="[^"]*"' \| sort \| uniq -c` | The pending suggestions as `w:ins`/`w:del` with their own authors. |

**Also check**
- Upload a Word file with tracked changes inside a bulleted list or a table cell: those paragraphs come in with the
  changes already accepted (plain text); the others as suggestions.
- A Word file with no tracked changes reads as before (no suggestion marks).
- The new version's findings and Changes mode read it as if its suggestions were accepted (E2E-SUG-02).

**Known limits**
- Tracked changes come back as suggestions only where mammoth's paragraph text matches Word's exactly; elsewhere
  (lists re-read from "•" text, line breaks, footnote markers, table cells) they are accepted, as before suggestion mode.
- Imported suggestions are by Word author names (`word:<name>`), not linked to our users.
- Into their own paper (step 9, "download for counterparty") pending suggestions go as tracked changes by the person
  downloading, not by each author.

### E2E-SUG-04 · What becomes of each AI suggestion is logged: shown, accepted, edited or dismissed, per feature

**Covers:** `POST /ai-suggestion-events` · `ai_suggestion_events` · `lib/ai-events.ts` (2 s batches, pagehide) · `lib/tracked-insert.ts aiEditsAtSave` · server-side logging in `POST /contracts/:id/changes/counter`, `POST /contracts/:id/findings/:findingId/insert-standard`, `…/findings/:findingId/redline` and `…/redline/apply`, `POST /contracts/:id/redline-against-playbook/apply` (fix all)
**Roles:** counsel-a, rep-a, admin-b · **Needs:** agents service + model key, psql · **Time:** ~15 min

**Preconditions**
- `$C_NY2` in Draft, no draft changes. Note the current count: `aiev $C_NY2`.
- The browser's network tab open, filtered on `ai-suggestion-events`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Workspace: select a sentence → **Ask AI** → `make it mutual` → **Draft**. Wait 3 s. | A `POST /api/v1/ai-suggestion-events` with `{events:[{contractId, versionId, feature:"ask_ai", outcome:"shown", suggestionId}]}` → `201` `{"recorded":1}`. |
| 2 | **Insert as tracked change**. Change one word inside the inserted words. **Save as version**, note `AI edited`. | Events `accepted`, then at the save `edited`, all with the same `suggestionId`. |
| 3 | Select another sentence → **Ask AI** → `shorter` → **Draft** → close the popover with ×. | `shown`, then `dismissed`. |
| 4 | Select a sentence → **Ask AI** → `shorter` → **Draft**, then change the instruction to `longer` → **Draft** again → **Replace**. | `shown`, `dismissed` (for the first drafts), `shown`, `accepted`. |
| 5 | `aiev $C_NY2` and `sql "SELECT outcome, \"suggestionId\" FROM ai_suggestion_events WHERE \"contractId\"='$C_NY2' ORDER BY at"` | Since the start: ask_ai shown 4, accepted 2, edited 1, dismissed 2. The outcomes of one set of drafts share a `suggestionId`. |
| 6 | `aiev $C_WS` (after E2E-CHG-02). | `counter\|shown\|…` (logged by the server when it drafts) and `counter\|accepted\|…` (by the page when it goes in). |
| 7 | Org-wide: `sql "SELECT feature, outcome, count(*) FROM ai_suggestion_events WHERE \"orgId\"='$ORG_A' GROUP BY 1,2 ORDER BY 1,2"` | Besides ask_ai and counter: `insert_standard\|accepted`, `redline_to_position\|shown/accepted`, `fix_all\|shown` for whatever §2's E2E-REV-14 did. |
| 8 | API checks: `E(){ curl -s -w '  HTTP %{http_code}\n' -X POST $API/ai-suggestion-events -H "Authorization: Bearer ${2:-$COUNSEL_A}" -H 'content-type: application/json' -d "$1"; }` then `E "{\"events\":[{\"contractId\":\"$C_NY2\",\"feature\":\"ask_ai\",\"outcome\":\"shown\"}]}"`, `E '{"events":[]}'`, `E "{\"events\":[{\"contractId\":\"$C_NY2\",\"feature\":\"magic\",\"outcome\":\"shown\"}]}"`, `E "{\"events\":[{\"contractId\":\"$C_NY2\",\"versionId\":\"<a version id of \$C_WS>\",\"feature\":\"ask_ai\",\"outcome\":\"shown\"}]}"`, and the first again with `$ADMIN_B` and with `$REP_A`. | `{"recorded":1}` HTTP 201; then `400` "Send 1 to 100 events, each with a contract, a feature and an outcome." twice; `400` "A version is not of its contract."; Org B and rep-a (not the owner) `404` "Contract not found", nothing recorded. |

**Also check**
- Closing the tab within 2 s of an outcome still sends it (the batch goes on `pagehide`).
- A logging failure never blocks the action (the API logs "[ai-suggestion-events] not recorded").

**Known limits**
- **Copy** is not an outcome. "Edited" is worked out only for **Insert as tracked change** wording, and only when
  the workspace's **Save as version** is used (not the contract page, an auto-save or the idle checkpoint).
- The report on these events is Analytics → **AI suggestions** (E2E-ANA-01 step 11); it shows rates by feature, not single
  events. Read single events with SQL.

---

## 5. After signature: amendments, renewals and analytics

This section tests docs/41 Parts 13, 14 and 19, with the fixes made after them (a roll-up only once signed, replaced
obligations, automatic renewal dates, reminder wording, Active · Renewing). It covers three things a customer does
once a contract is signed:

- **Amendments and the contract family.** A child contract hangs off its parent by one of a fixed set of
  relationships: `amendment`, `renewal`, `sow`, `order_form`, `exhibit`, `split_part`, `nda` or `other`. A database
  CHECK constraint holds the column to this set. The old `exhibit_only` value is read as `exhibit`. Amendments,
  renewals, SOWs and order forms are **numbered per parent**: "Amendment No. 2", "Renewal No. 1", "SOW #3",
  "Order form #1". A person can correct a number. **Create amendment** now asks what changes: the parent's sections
  (replace or delete, with AI-drafted new words that quote the parent) and its key terms. It also asks which template
  to use, when the amendment takes effect and its number. An amendment has a **redline** against the parent's
  effective words. Once it is signed (not before), a person **rolls up** its terms to the parent ("Confirm on the
  agreement") and marks the parent's obligations from the replaced sections as no longer owed; those then read
  "Replaced by Amendment No. N" everywhere and leave the owed counts. The roll-up can be undone. The parent
  gets an **effective view** ("As amended") with "Amended by A1 (§5)" and **Show amended values**. A **Contract family**
  rail panel lists the whole family. The banner says "Amendment No. 2 to …", with **View family**. Only a part the binder split carved out
  of a scanned file says "Split from scanned file".
- **Renewals.** A contract's renewal terms are now **columns of their own**: renewal type, renewal term, notice days,
  notice deadline, earliest notice and price cap. They are worked out from its values and its signed amendments. A
  renewal is started from the contract's **Renewal** rail section or from the **Renewals** page, in one dialog. There
  are three choices, and each drafts something:
  - **Renew as is** drafts a renewal letter, unless the contract renews on its own.
  - **Renegotiate** drafts a renewal from the agreement as it stands, reviewed against it.
  - **Let it lapse or end it** drafts a notice of non-renewal, tracked until it is marked sent.

  Reminders go to the owner **and watchers**. An undecided renewal **escalates to Legal Ops** a set number of days
  before the deadline (an org setting, 14 by default), once per deadline. Each person can subscribe to a
  **calendar feed** (`.ics`) of notice deadlines, end dates and obligation due dates. A decision to renew moves the
  contract to **Active · Renewing**. The daily date job closes a contract as Expired or Terminated at its end date once
  a notice went out, and an automatic renewal moves the expiry date on by the renewal term.
- **Analytics by decision.** The Analytics page now opens with seven sections: **Speed**, **Bottlenecks**,
  **Workload**, **Negotiation**, **Risk and playbook**, **Renewals** and **AI suggestions**. One filter bar (period,
  type, whose paper, only mine) governs all seven. Each chart says what it helps decide. Each bar opens its contracts
  in the contract list, and each section downloads as CSV. Cycle time is measured to `executedAt`, not `updatedAt`.

Codes: **E2E-AMD** (amendments and the family), **E2E-RNW** (renewals), **E2E-ANA** (analytics). Run them in the
order written: later journeys reuse records made by earlier ones. These journeys supersede docs/40 where they differ:
E2E-DOC-12 (family), E2E-REN-03 (its `amend … exhibit_only` now stores `exhibit`), E2E-REN-04 (the decision values are
now `renew`, `renegotiate`, `let_lapse` and `terminate`; `let_expire` is read as `let_lapse`; `pause` is refused) and
E2E-ANL-01 (the page now leads with the sections).

### Before you start: section 5 setup

- docs/40 §0 is done, and the accounts exist. Paste the §0.5 lines.
- Paste the **docs/40 §6.0 helpers**: `day`, `ADMIN_B_ID`, `AGENTS`, `INT`, `tj`, `sql`, `upload`, `waitdone`,
  `bulk`, `qverify`, `amend`, `$W6` and `execute`. `execute <id>` takes a draft through approval (`$W6`) to EXECUTED
  and sets its `executedAt`. Then paste these:

```bash
export LEGALOPS_A_ID=$(uid legalops@qa.test)
# A contract as the API returns it.  cget <id> [token]
cget() { curl -s "$API/contracts/$1" -H "Authorization: Bearer ${2:-$COUNSEL_A}"; }
# Set a contract's confirmed renewal type and non-renewal notice.  rterms <id> <Automatic|"By agreement"|…> <days>
rterms() { qverify $1 "{\"field\":\"renewalType\",\"value\":\"$2\"}"; qverify $1 "{\"field\":\"nonRenewalNotice\",\"value\":{\"value\":$3,\"unit\":\"days\"}}"; }
# A child of a contract.  child <parent> '<json body>' [token]  → prints the whole response
child() { curl -s -X POST "$API/contracts/$1/amendments" -H "Authorization: Bearer ${3:-$COUNSEL_A}" \
  -H 'content-type: application/json' -d "$2"; }
# A contract's renewal as its page reads it.  ren <id> [token]
ren() { curl -s "$API/contracts/$1/renewal" -H "Authorization: Bearer ${2:-$COUNSEL_A}"; }
# Decide a renewal.  rdecide <id> <renew|renegotiate|let_lapse|terminate> [token]
rdecide() { curl -s -X POST "$API/contracts/$1/renewal-decision" -H "Authorization: Bearer ${3:-$COUNSEL_A}" \
  -H 'content-type: application/json' -d "{\"decision\":\"$2\",\"reason\":\"QA\"}"; }
# Mark the notice of non-renewal sent.  rsent <id> [YYYY-MM-DD] [token]
rsent() { local b='{}'; [ -n "$2" ] && b="{\"sentAt\":\"$2\"}"
  curl -s -X POST "$API/contracts/$1/renewal-decision/notice-sent" -H "Authorization: Bearer ${3:-$COUNSEL_A}" \
  -H 'content-type: application/json' -d "$b"; }
# One analytics section.  ana <section> [query] [token]
ana() { curl -s "$API/analytics/$1?${2:-}" -H "Authorization: Bearer ${3:-$COUNSEL_A}"; }
# The newest bell notifications of a user, and the newest audit events (as admin-a)
notes() { curl -s "$API/approvals/notifications?limit=8" -H "Authorization: Bearer $1" \
  | jq '[.data[] | {type, title, body}]'; }
audit() { curl -s "$API/admin/audit?action=$1&limit=5${2:+&resourceId=$2}" -H "Authorization: Bearer $ADMIN_A" \
  | jq '[.events[] | {action, resourceId, actor: .actor.name, metadata}]'; }
# Unfold an .ics file (RFC 5545 wraps long lines at 75 bytes with CRLF + space)
unfold() { perl -0pe 's/\r\n //g; s/\r//g'; }
```

- **The amendment fixture.** Make it in your test folder on the day you test, because its dates are relative to
  today. Section 5 holds the payment term and an obligation an amendment will replace:

```bash
cat > QA-AMD-MSA.txt <<TXT
MASTER SERVICES AGREEMENT

This Master Services Agreement is made on $(day -200) between QA Lakeside Buyer Inc. ("Customer") and QA Ridge Analytics Ltd ("Supplier").

1. Term and renewal. This Agreement begins on $(day -200) and ends on $(day +165). It then renews automatically for successive twelve (12) month terms unless either party gives written notice of non-renewal at least sixty (60) days before the end of the then-current term.
2. Services. Supplier shall provide the analytics services described in each order form.
5. Fees and payment. Customer shall pay each undisputed invoice within thirty (30) days of receipt. Supplier shall deliver a quarterly fee statement to Customer on or before $(day +5).
6. Security. Supplier shall deliver an annual penetration test summary to Customer on or before $(day +40).
7. Limitation of liability. Each party's total liability is capped at the fees paid in the twelve (12) months before the claim.
9. Governing law. This Agreement is governed by the laws of the State of New York.
TXT
```

- **Who can do what here.**

| What | Permission | Allowed | Refused |
|---|---|---|---|
| Read the family, effective view, term history, amendment redline, renewal state, watchers, analytics and drill-down | `view:contract` | every seeded role; rep-a sees only contracts rep-a owns (others answer 404 "Contract not found") | — |
| Create an amendment or other child | `create:contract` | admin-a, counsel-a, contracts-a, legalops-a, procurement-a, rep-a (own parents only) | finance-a, approver-a, viewer-a |
| Draft amendment language, renumber, link a parent, roll up, decide a renewal, mark a notice sent, add or remove a watcher | `edit:contract` | admin-a, counsel-a, contracts-a, legalops-a, procurement-a | rep-a, finance-a, approver-a, viewer-a |
| See **Team** workload in Analytics, receive renewal escalations | `configure:workflow` at org scope | admin-a, legalops-a | everyone else |
| Set `renewalEscalationDays` (`PATCH /organization`) | `configure:integration` | admin-a, legalops-a | everyone else |
| Make, copy or turn off one's own calendar feed | signed in | everyone | — |
| Run the renewal or obligation scan by hand (`POST /cron/…`) | `configure:user` | admin-a | everyone else |

---

### E2E-AMD-01 · Children are numbered per agreement by relationship, a number can be corrected, and old spellings are read as the relationship they meant

**Covers:** `POST /contracts/:id/amendments` · `PUT /contracts/:id/amendment-number` · `PUT /contracts/:id/parent` · `GET /contracts/:id/family` · `GET /contracts/:id/family-tree` · /contracts/:id (**Create amendment** dialog) · migration `lifecycle_family_renewals` (CHECK constraint, normalising trigger, numbering)
**Roles:** counsel-a, rep-a, viewer-a, admin-b · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- Section 5 setup pasted. A signed parent with no children, owned by counsel-a:
  ```bash
  printf 'title,type,status,counterpartyname,expirydate\nQA AMD Numbering MSA,MSA,executed,QA Numbering Co,%s\n' "$(day +300)" > qa-amd-n.csv
  bulk qa-amd-n.csv AN      # sets AN_2
  ```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$AN_2`. Header **⋯** menu → **Create amendment**. | Dialog **Create amendment**, "Linked to **QA AMD Numbering MSA**". **Relationship type** has five tiles: **Amendment** (selected), **Statement of Work**, **Order Form**, **Renewal**, **Exhibit**. Under them: "Modifies a clause, term, or value of the parent." With Amendment selected: **Sections that change**, which reads "The agreement's sections haven't been read yet. You can still change its key terms." because this parent has no document. **Key terms that change** has the **Add a key term…** picker. Then **Drafted from** (default "The changes on their own"), **Takes effect** (a date) and **Number** (placeholder "Next"). Last: **Title** (optional), with placeholder "QA AMD Numbering MSA — Amendment", and **Description** (optional). Buttons: **Cancel** and **Create draft**. |
| 2 | Click **Statement of Work**, then **Exhibit**. | The help line changes to "Project-specific scope under an MSA.", then "Schedule, exhibit, or appendix." The change pickers, **Drafted from**, **Takes effect** and **Number** show only for **Amendment**. |
| 3 | Back on **Amendment**, leave every field empty and click **Create draft**. | The page opens the new contract. Its title is **Amendment No. 1 to QA AMD Numbering MSA**. Save the id from the URL as `$AN_A1`. |
| 4 | `child $AN_2 '{}' \| jq '{title,relationshipType,amendmentNumber,label}'` | `{"title":"Amendment No. 2 to QA AMD Numbering MSA","relationshipType":"amendment","amendmentNumber":2,"label":"Amendment No. 2"}`. Status 201. Save `.id` as `$AN_A2` (re-run with `\| jq -r .id`, or copy from the list). |
| 5 | One of each other numbered kind: `child $AN_2 '{"relationshipType":"sow"}' \| jq -c '{title,label}'`, then the same with `"order_form"`, `"renewal"`, and `"sow"` again. | `{"title":"SOW #1 to QA AMD Numbering MSA","label":"SOW #1"}`; then "Order form #1", "Renewal No. 1" and "SOW #2". Each relationship counts on its own. |
| 6 | Unnumbered kinds: `child $AN_2 '{"relationshipType":"exhibit"}' \| jq -c '{title,relationshipType,amendmentNumber,label}'`, and the same with `"nda"`. | `{"title":"QA AMD Numbering MSA — exhibit","relationshipType":"exhibit","amendmentNumber":null,"label":null}`, then "QA AMD Numbering MSA — nda". |
| 7 | Old and loose spellings: send `"relationshipType"` as `"exhibit_only"`, `"Statement of Work"`, `"Addendum"` and `"anything-else"`. | They are stored as `exhibit`, `sow` (SOW #3), `amendment` (Amendment No. 3) and `other` respectively. None is refused. |
| 8 | A split part cannot be made by hand: `child $AN_2 '{"relationshipType":"split_part"}'` | `400` `{"detail":"relationshipType must be one of amendment, sow, order_form, renewal, exhibit, nda, other"}`. |
| 9 | Correct a number: `curl -s -X PUT $API/contracts/$AN_A2/amendment-number -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{"amendmentNumber":7}'`, then `curl -s $API/contracts/$AN_A2/family -H "Authorization: Bearer $COUNSEL_A" \| jq '{amendmentNumber,label}'`. | `{"amendmentNumber":7}`; then `{"amendmentNumber":7,"label":"Amendment No. 7"}`. The title does not change: it still says "Amendment No. 2 …" (see Known limits). `audit CONTRACT_UPDATED $AN_A2` shows `metadata` `{"action":"renumbered","from":2,"to":7}`. |
| 10 | The next amendment: `child $AN_2 '{}' \| jq -r .label` | "Amendment No. 8". The next number is the highest + 1, not the count. |
| 11 | In the dialog: **Create amendment** on `$AN_2`, type `4` in **Number**, then **Create draft**. | The new contract is "Amendment No. 4 to QA AMD Numbering MSA": a number someone types is used as is, even if it is lower than the highest. |
| 12 | The family as a tree: `curl -s $API/contracts/$AN_A1/family-tree -H "Authorization: Bearer $COUNSEL_A" \| jq '{currentId, root: .root.title, kids: [.root.children[] \| .label // .relationshipType]}'` | `currentId` = `$AN_A1`, `root` "QA AMD Numbering MSA". The children are ordered by relationship and then by number: the amendments No. 1, 3, 4, 7 and 8, then "Renewal No. 1", "SOW #1", "SOW #2", "SOW #3", "Order form #1", the two `exhibit` children and `nda`, then `other`. |
| 13 | Link a stand-alone contract into the family: `printf 'title,status\nQA AMD Loose SOW,draft\n' > qa-loose.csv; bulk qa-loose.csv LS`, then `curl -s -X PUT $API/contracts/$LS_2/parent -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d "{\"parentContractId\":\"$AN_2\",\"relationshipType\":\"sow\"}"` and `curl -s $API/contracts/$LS_2/family -H "Authorization: Bearer $COUNSEL_A" \| jq -r .label`. | `{"parentContractId":"<$AN_2>","relationshipType":"sow"}`; then "SOW #4": a contract is numbered when it joins a family. Unlinking (`{"parentContractId":null}`) clears its relationship and number. |

**Also check**
- `PUT …/parent` refusals: the contract as its own parent → `400` "A contract can’t be its own parent". `$AN_2` made a child of `$AN_A1` → `400` "That contract belongs to this one: it can’t be its parent too". Another org's id as the parent → `404` "Parent contract not found".
- `PUT …/amendment-number` on `$AN_2` (it has no parent) → `400` "Only a contract linked to an agreement has a number". `{"amendmentNumber":0}` → `422` "Request body failed validation". `{"amendmentNumber":null}` clears it, and the label becomes `null`.
- rep-a: `child $AN_2 '{}' $REP_A` → `404` "Contract not found" (rep-a doesn't own the parent). viewer-a: `403` "Missing permission: create:contract". viewer-a's **⋯** menu has no **Create amendment**. admin-b: `404` "Contract not found" (or "Parent contract not found").
- The database holds the set: `sql "SELECT count(*) FROM contracts WHERE \"relationshipType\" NOT IN ('amendment','renewal','sow','order_form','exhibit','split_part','nda','other')"` → `0`. `sql "SELECT count(*) FROM contracts WHERE \"relationshipType\"='exhibit_only'"` → `0`. The trigger also normalises a direct write: `sql "UPDATE contracts SET \"relationshipType\"='Schedule' WHERE id='$LS_2' RETURNING \"relationshipType\""` → `exhibit`. Set it back to `sow` afterwards.

**Known limits**
- A corrected number changes the label (banner, family, effective view) but not the title, which was written when the child was made.
- A deleted child's number is not reused, and numbers are not compacted after a correction.
- The dialog offers five relationships. `nda` and `other` are reachable only through the API or the upload modal's link step.

### E2E-AMD-02 · A lawyer drafts an amendment from the sections and key terms it changes, with AI-drafted words that quote the parent

**Covers:** /contracts/:id (**Create amendment** → **Sections that change**, **Key terms that change**, **Draft**) · `GET /contracts/:id/effective` · `GET /contracts/:id/fields` · `POST /contracts/:id/amendment-language` · `POST /contracts/:id/amendments` (with `changes`, `templateId`, `effectiveDate`) · `GET /templates?contractType=AMENDMENT` · agents service `POST /amendment_language` · lib/child-contract.ts (stage on the record, analysis queued, `amendment.created`)
**Roles:** counsel-a, viewer-a, admin-b · **Needs:** agents service + model key · **Time:** ~30 min

**Preconditions**
- Section 5 setup, with `QA-AMD-MSA.txt` made today.
- The parent, uploaded, read, its terms confirmed and signed (counsel-a owns it):
  ```bash
  export P=$(upload QA-AMD-MSA.txt text/plain "QA AMD Master Services Agreement" "QA Ridge Analytics Ltd")
  waitdone $P                                  # DONE
  qverify $P '{"field":"expiryDate","value":"'$(day +165)'"}'
  qverify $P '{"field":"renewalType","value":"Automatic"}'
  qverify $P '{"field":"nonRenewalNotice","value":{"value":60,"unit":"days"}}'
  qverify $P '{"field":"paymentTermsDays","value":30}'
  qverify $P '{"field":"counterpartyName","value":"QA Ridge Analytics Ltd"}'
  execute $P                                   # EXECUTED
  curl -s -X POST $API/contracts/$P/extract-obligations -H "Authorization: Bearer $COUNSEL_A" > /dev/null
  curl -s $API/contracts/$P/obligations -H "Authorization: Bearer $COUNSEL_A" | jq -c '.data[] | {id, description, sectionRef, dueDate: .dueDate[:10]}'
  ```
  Each `qverify` prints `{"ok":true,…}`. The obligations include the quarterly fee statement (§5, due `day +5`) and
  the penetration test summary (§6, due `day +40`). Save the fee statement's id as `$OB_FEE` and the other's as
  `$OB_PEN`. verify: the model's wording of each description.
- The parent's sections: `curl -s $API/contracts/$P/effective -H "Authorization: Bearer $COUNSEL_A" | jq -c '.sections[] | {clauseId, sectionRef, text: .text[:60]}'`.
  Save the clause id whose text starts "Customer shall pay each undisputed invoice" (or "Fees and payment…") as `$CL5`,
  and the one for §9 (governing law) as `$CL9`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As counsel-a open `$WEB/contracts/$P` → **⋯** → **Create amendment**. | While the agreement loads: "Reading the agreement…". Then **Sections that change** lists one row per section, named "Section 5" and so on, or by clause type when a section has no number. Each row has a checkbox, the name, and the first two lines of its words. No row says "Amended by …" yet. |
| 2 | Tick **Section 5**. | The row opens with two buttons, **Replace the words** (selected) and **Delete the section**. Below them: an input with placeholder "What should change? e.g. payment within 45 days", a **Draft** button with the assist mark (disabled), and a text area "The section’s new words". Under the form: "Write the new words for each section you replace, and a new value for each key term." **Create draft** is disabled. |
| 3 | Type `pay within 45 days and drop the quarterly fee statement` and click **Draft**. | The button spins. Within about 20 s the text area fills with new words for §5. These must say 45 days and must not require a quarterly fee statement. They keep the agreement's defined terms ("Customer", "Supplier") and contain no "Section 5 is deleted and replaced…" sentence. Under it: "Changes: “…”", a quote of the parent's §5 that appears word for word in the parent (check it against `QA-AMD-MSA.txt`). Then one line of rationale. **Create draft** is enabled. |
| 4 | The same through the API: `curl -s -X POST $API/contracts/$P/amendment-language -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d "{\"items\":[{\"clauseId\":\"$CL5\",\"instruction\":\"pay within 45 days\"}]}" \| jq '.drafts[0] \| {sectionRef, parentText: .parentText[:50], quote, proposedText: .proposedText[:80], error}'` | `parentText` is the parent's §5 words. `proposedText` mentions 45 days. `error` is `null`. `quote` is either `null` or a phrase found verbatim in `parentText`: a quote the clause doesn't hold is dropped, never shown. |
| 5 | In **Key terms that change**, open **Add a key term…**. | It lists the parent's terms that have a value, as "<label> (<value>)", for example "Payment terms (30 days)". Pick **Payment terms**. A row appears: "Payment terms", "30 days", "→", an input "New value" and **Remove**. **Create draft** is disabled until a value is typed. |
| 6 | Type `45`. Leave **Drafted from** on "The changes on their own". Set **Takes effect** to tomorrow. Leave **Number** empty. Click **Create draft**. | The button reads "Creating…", then the new contract opens: **Amendment No. 1 to QA AMD Master Services Agreement**. Save its id as `$AMD`. |
| 7 | Read its document (the editor or **Versions**). | An `<h1>` "Amendment No. 1 to QA AMD Master Services Agreement". Then "This Amendment No. 1 (the “Amendment”) is made effective as of <tomorrow, as "October 3, 2026"> and amends the QA AMD Master Services Agreement dated <the parent's effective date> between the parties, including QA Ridge Analytics Ltd (the “Agreement”)." Then "The parties agree to amend the Agreement as follows:". Then "**1.** Section 5 of the Agreement is deleted in its entirety and replaced with the following:" and the drafted words in a quote block. Then "**2.** The Payment terms is amended to read: 45." Last: "Except as amended by this Amendment, the Agreement remains in full force and effect. …". |
| 8 | `cget $AMD \| jq '{stage, status, analysisStatus, relationshipType, amendmentNumber, spec: .metadata._amendment \| {number, effectiveDate, templateId, changes: [.changes[] \| {kind, action, source, sectionRef, key, from, to}]}}'` | `stage` "draft", `relationshipType` "amendment", `amendmentNumber` 1. `analysisStatus` moves off "NOT_ANALYSED": a drafted amendment is read like any draft. The spec has `number` 1, `effectiveDate` = tomorrow, `templateId` null, and two changes: `{kind:"clause", action:"replace", source:"ai", sectionRef:"5"…}` and `{kind:"term", key:"paymentTermsDays", from:"30 days", to:"45"}`. |
| 9 | `audit STAGE_CHANGED $AMD` and `audit CONTRACT_CREATED $AMD`. | A STAGE_CHANGED event with `metadata.created` true, `from` null, `toStage` "draft", `via` "amendment_flow" and `relationshipType` "amendment". CONTRACT_CREATED has `metadata` `{relationshipType:"amendment", parentContractId:<$P>, source:"amendment_flow"}`. A webhook subscribed to `amendment.created` receives `{contractId, parentContractId, relationshipType, title, type}`. |
| 10 | A deletion: **Create amendment** on `$P` again. Tick **Section 9**, click **Delete the section**, and **Create draft**. Save the id as `$AMD2`. | "Amendment No. 2 to …". Its operative paragraph reads "Section 9 of the Agreement is deleted in its entirety." with no quote block. `cget $AMD2 \| jq '.metadata._amendment.changes[0] \| {action,newText}'` → `{"action":"delete","newText":""}`. |

**Also check**
- Refusals (`child $P '<body>'`):
  - a replace with no words, `{"changes":[{"kind":"clause","clauseId":"'$CL5'","action":"replace"}]}` → `400` "Write the new words for each clause that is replaced";
  - a clause of another contract → `400` "A clause picked to change isn’t in the agreement";
  - `{"changes":[{"kind":"term","key":"x","label":"X"}]}` (no `to`) → `400` "Invalid changes", with `issues`;
  - `{"templateId":"nope"}` → `404` "Template not found".
- `amendment-language`: a one-letter instruction → `422` "Request body failed validation". An id that isn't the parent's clause → `{"drafts":[]}`. With the agents service stopped, each draft comes back with `error` "The drafting service didn’t answer: write the new words yourself". In the dialog the note under the text area says the same, and the person can still type the words.
- Write words by hand, then **Draft** again: the AI's words replace them. Edit the AI's words before creating: the edited words are what the amendment holds (step 8's `source` stays "ai").
- **Drafted from** lists only the org's published templates of type AMENDMENT, the default first. To test it, publish one with a `{{amendment_changes}}` variable. The changes then appear where that variable is. Without the variable, they are added at the end.
- viewer-a: the **⋯** menu has no **Create amendment**. `POST …/amendment-language` as viewer-a → `403` "Missing permission: edit:contract". admin-b: `404` "Contract not found".
- PII: with Org A in **redact** mode, the agents service log for `/amendment_language` shows placeholders, not "QA Lakeside Buyer Inc.". The draft that comes back has the real names restored.
- Money is written with its currency (browser run, 4a20305). Use another signed agreement that has a value, not `$P` (so the family counts below stay as written): the seeded "Acme Corp — Master Services Agreement" (USD 250,000) does. **⋯** → **Create amendment** → **Add a key term…** → **Contract value** → `300000` → **Create draft**. The document says "The Contract value is amended to read: USD 300,000." (never "300000."), in the agreement's currency, and `cget <new id> \| jq '.metadata._amendment.changes[0] \| {key, from, to}'` → `{"key":"value","from":"USD 250,000","to":"USD 300,000"}`.
- Dates follow the org's date order (cf9cc8f): "made effective as of October 3, 2026 … dated January 15, 2025" for a month-first org, "3 October 2026 … 15 January 2025" for a day-first one.

**Known limits**
- No AMENDMENT template is seeded, so **Drafted from** usually offers only "The changes on their own".
- A key-term change is written as typed, except money and dates ("The Payment terms is amended to read: 45."; a Contract value of `300000` becomes "USD 300,000"). The value reaches the parent only through the roll-up (E2E-AMD-04), from the value the amendment's own analysis, or a person, records.
- **Draft** works one section at a time. The API accepts up to 10.

### E2E-AMD-03 · An amendment's redline shows the parent's words in effect against the words being signed, and follows edits

**Covers:** /contracts/:id (rail **Contract family** → **What it changes**) · `GET /contracts/:id/amendment-redline` · `GET /contracts/:id/family-tree` · lib/amendments.ts `amendmentRedlineItems`
**Roles:** counsel-a, rep-a · **Needs:** nothing extra (uses `$AMD` from E2E-AMD-02) · **Time:** ~10 min

**Preconditions**
- E2E-AMD-02 done: `$P`, `$AMD` (replaces §5 and sets Payment terms) and `$AMD2` (deletes §9), all owned by counsel-a. Neither amendment is signed.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `curl -s $API/contracts/$AMD/amendment-redline -H "Authorization: Bearer $COUNSEL_A" \| jq '{parent: .parent.title, items: [.items[] \| {index, kind, name, action, current: .current[:50], proposed: .proposed[:50], ops: [.segments[].op] \| unique}]}'` | `parent` "QA AMD Master Services Agreement". Two items. The first is `{index:0, kind:"clause", name:"Section 5", action:"replace", current:<the parent's §5 words>, proposed:<the drafted words>}`, with ops including `delete` and `insert`. The second is `{index:1, kind:"term", name:"Payment terms", action:"set", current:"30 days", proposed:"45"}`. The term reads as the parent displayed it, with its unit. |
| 2 | Open `$WEB/contracts/$AMD`. Rail **Contract family** (count 3). | Two buttons, **Family** (selected) and **What it changes**. The family list: the agreement's title, then "Amendment No. 1" (bold, the one open, not a link) and "Amendment No. 2" (a link), each followed by its title in grey and its stage on the right ("draft"). |
| 3 | Click **What it changes**. | "The agreement’s words in effect, against the words this amendment signs." Then one card per change. "Section 5 replaced": the parent's words with deleted words struck through in red and new words in green. "Payment terms new value": "30 days" struck and "45" inserted. |
| 4 | Edit the amendment's text in the **editor** (Open workspace): change "45" in the §5 quote block to `60`, **Save as version** with a note. Reload and click **What it changes**. | The §5 card now inserts "60": the redline reads the amendment’s current words, edits included, even though an editor save may drop the quote block's `data-amendment-text` marker (it then finds the words after the change's own sentence, "Section 5 of the Agreement … replaced with the following:"). The term card still reads 30 days → 45, because the term change is not re-read from the text. |
| 5 | In the workspace click **Suggesting** (E2E-SUG-02), replace `60` with `90` in the §5 words, **Save as version**, and reload **What it changes**. | The §5 card inserts "90": a pending suggestion is read as accepted for the redline. |
| 6 | `curl -s $API/contracts/$AMD2/amendment-redline -H "Authorization: Bearer $COUNSEL_A" \| jq '.items[0] \| {name, action, proposed, ops: [.segments[].op] \| unique}'`, and its **What it changes** view. | `{"name":"Section 9","action":"delete","proposed":"","ops":["delete"]}`. The card is "Section 9 deleted", with the whole of §9 struck through. |
| 7 | Open the parent, `$WEB/contracts/$P`. Rail **Contract family**. | The family list only. There is no **As amended** button yet, because no amendment is signed, and no **What it changes** button: the parent has no redline. |

**Also check**
- A contract with no recorded changes (an amendment made empty, e.g. `$AN_A1` from E2E-AMD-01): `…/amendment-redline` → `{"parent":null,"items":[]}`, and its family panel has no **What it changes** button.
- rep-a: `GET $API/contracts/$AMD/amendment-redline` → `404` "Contract not found". admin-b: the same.
- A clause the parent no longer has (a new parent version was uploaded after drafting): the item falls back to the words recorded when the amendment was drafted (`parentText`).

**Known limits**
- The redline is a rail view, not the full-page Compare view.
- A term change shows the values as typed in the dialog (money and dates as the document writes them, "USD 300,000"), not the parent’s value now.
- Without the marker the words are found by the change's operative sentence. A person who deletes or rewrites that
  sentence beyond recognition (no section named, no "replaced") leaves the redline on the words as drafted, without
  saying so.

### E2E-AMD-04 · A signed amendment rolls up to the agreement: its terms with the originals one click away, its replaced obligations no longer owed or reminded, the effective view, and undo

**Covers:** /contracts/:id (rail **Changes to the agreement**, **Contract family** → **As amended**, **Show amended values**) · `GET /contracts/:id/amendment-changes` · `POST /contracts/:id/amendment-changes/apply` (`supersedeObligationIds`) · `POST /field-runs/:id/undo` · `GET /contracts/:id/term-history` · `GET /contracts/:id/effective` · `GET /contracts/:id/fields` · `POST /cron/obligations` (scan.worker obligation reminders skip superseded) · internal tool `contract_get` (`effectiveTerms`) · /obligations (Replaced by Amendment No. N) · `GET /obligations` (`bucket`, `replacedBy`)
**Roles:** counsel-a, admin-a, viewer-a, rep-a · **Needs:** nothing extra (uses E2E-AMD-02's records) · **Time:** ~25 min

**Preconditions**
- E2E-AMD-02 and -03 done: `$P` (signed, Payment terms 30 days, obligations `$OB_FEE` from §5 and `$OB_PEN` from §6), `$AMD` (unsigned, replaces §5, Payment terms → 45) and `$AMD2` (unsigned, deletes §9).
- The amendment's own value, as its analysis or a reviewer records it: `qverify $AMD '{"field":"paymentTermsDays","value":45}'` → `{"ok":true,…}`.
- Obligation reminders before the roll-up: `curl -s -X POST $API/cron/obligations -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"force":true}' | jq .result.notified`, then `notes $COUNSEL_A`. A reminder names the quarterly fee statement on "QA AMD Master Services Agreement" (due in 5 days).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `curl -s $API/contracts/$AMD/amendment-changes -H "Authorization: Bearer $COUNSEL_A" \| jq '{parent: .parent.title, relationshipType, changes: [.changes[] \| {key, label, from: .parent.display, to: .amendment.display, applied}], obligations: [.obligations[] \| {id, sectionRef, superseded}], lastRun}'` | `parent` "QA AMD Master Services Agreement", `relationshipType` "amendment". `changes` holds `{key:"paymentTermsDays", label:"Payment terms", from:"30 days", to:"45 days", applied:false}`. verify: other rows may appear if the amendment's analysis read other terms; the amendment's own date, parties and signatories never do. `obligations` holds `$OB_FEE` (`superseded` false) and not `$OB_PEN`: only obligations from a section the amendment replaces are offered. `lastRun` null. |
| 2 | Before signing, open `$WEB/contracts/$AMD`. Rail **Changes to the agreement**. Then try the roll-up by API: `curl -s -X POST $API/contracts/$AMD/amendment-changes/apply -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{"keys":["paymentTermsDays"]}' \| jq` | The rows are shown with their checkboxes disabled and, instead of **Confirm on the agreement**, the line "Roll up once Amendment No. 1 is signed. Until then the agreement keeps its own terms." The API: `409` `{"detail":"Roll up once Amendment No. 1 is signed.","code":"AMENDMENT_NOT_SIGNED"}`. `GET …/amendment-changes` carries `signed` false and `label` "Amendment No. 1". |
| 3 | Sign the amendment: `execute $AMD` → `EXECUTED`. Open `$WEB/contracts/$AMD`. Rail **Changes to the agreement** (count 1). | "This amendment changes **QA AMD Master Services Agreement**." Then a row "Payment terms" with "30 days" struck through, an arrow and **45 days**, its checkbox ticked. Then **Obligations from the sections it replaces**: the fee statement with "§5 · “<its words>”", ticked. Then "Tick what it changes. The agreement keeps them, marked as amended, and its original values stay one click away. Ticked obligations are kept on record but no longer owed." and **Confirm on the agreement**. |
| 4 | Leave both ticked. Click **Confirm on the agreement**. | The term row shows a green check and "45 days · on the agreement". The obligation row shows a grey check and "· no longer owed". A band reads "Set 1 term on the agreement <2 Oct>." with **Undo**. The API answered `{parent, applied:["paymentTermsDays"], runId:<id>, superseded:1}`. Save `runId` from `curl … /amendment-changes \| jq -r .lastRun.id` as `$RUN`. |
| 5 | The parent's value: `curl -s $API/contracts/$P/fields -H "Authorization: Bearer $COUNSEL_A" \| jq '.fields[] \| select(.key=="paymentTermsDays") \| {display, source, fromContractId}'` | `{"display":"45 days","source":"amendment","fromContractId":"<$AMD>"}`. The parent's **Key terms** show 45 days, marked as set by Amendment No. 1. |
| 6 | The history: `curl -s $API/contracts/$P/term-history -H "Authorization: Bearer $COUNSEL_A" \| jq '.terms.paymentTermsDays \| {label, values: [.values[] \| {display, by: .source.label, effectiveFrom, current}]}'` | `label` "Payment terms". Two values, in order. First `{display:"30 days", by:null, effectiveFrom:<the parent's effective date>, current:false}`, the original. Then `{display:"45 days", by:"Amendment No. 1", effectiveFrom:<tomorrow>, current:true}`. |
| 7 | Open `$WEB/contracts/$P`. Rail **Contract family** (count 3). | Buttons **Family** and **As amended**: a signed amendment now changes this agreement. **Family** lists "Amendment No. 1" with "Signed · effective <tomorrow>" and "Amendment No. 2" with "draft". |
| 8 | Click **As amended**. | "A reading view of the agreement with its signed amendments applied. The signed documents stay as they are." **Amended key terms**: "**Payment terms** 45 days", "Amended by Amendment No. 1 from <tomorrow>", where "Amendment No. 1" links to `$AMD`. **Amended sections**: one card, "Amended by A1 (§5)" (verify: the section reference as the analysis wrote it), followed by the new §5 words. §9 is not listed, because Amendment No. 2 is unsigned. |
| 9 | Click **Show amended values**, then **Show the original words** on the §5 card. | Under Payment terms, struck through: "30 days · original". The button reads **Hide amended values**. Below the §5 card, the parent's original §5 words, with the button **Hide the original words**. |
| 10 | `curl -s $API/contracts/$P/effective -H "Authorization: Bearer $COUNSEL_A" \| jq '{amended: [.sections[] \| select(.amendedBy\|length>0) \| {sectionRef, deleted, by: [.amendedBy[].short]}], amendments: [.amendments[] \| {label, signed}], unplaced: (.unplaced\|length)}'` | `amended` `[{"sectionRef":"5","deleted":false,"by":["A1"]}]`. `amendments`: Amendment No. 1 `signed` true, Amendment No. 2 `signed` false. `unplaced` 0. |
| 11 | The obligation: `sql "SELECT \"supersededById\" = '$AMD', \"supersededAt\" IS NOT NULL, status FROM obligations WHERE id IN ('$OB_FEE','$OB_PEN') ORDER BY id='$OB_FEE' DESC"` | The fee statement: `t\|t\|OPEN`, kept on record but no longer owed. The penetration test summary: `f\|f\|OPEN`. `audit CONTRACT_UPDATED $P` shows `metadata` `{source:"amendment_rollup", action:"superseded_obligations", amendmentId:<$AMD>, count:1}`. |
| 12 | Where it shows: left rail → **Obligations**; then the parent's rail **Obligations**; then `curl -s "$API/obligations?contractId=$P" -H "Authorization: Bearer $COUNSEL_A" \| jq '[.data[] \| {description, status, replacedBy}]'` and `curl -s "$API/obligations?bucket=open&limit=100" -H "Authorization: Bearer $COUNSEL_A" \| jq --arg o $OB_FEE '[.data[] \| select(.id==$o)] \| length'` | Obligations page: the fee statement's status column reads "Replaced by Amendment No. 1" (a link to `$AMD`), with no **Complete**; the Open, Due soon and Overdue views and their counts leave it out. Parent rail: the chip "Replaced by Amendment No. 1". API: `replacedBy` `{contractId:<$AMD>, label:"Amendment No. 1"}` on the fee statement, null on the penetration test summary; the open bucket → `0`. The CSV export's status column says "Replaced by Amendment No. 1". |
| 13 | Reminders skip it: run the forced obligation scan again (Preconditions), then `notes $COUNSEL_A` and Mailpit. | No new reminder for the fee statement. The penetration test summary is reminded only once it falls within 7 days. |
| 14 | The assistant reads it: `tj contract_get '{"orgId":"'$ORG_A'","userId":"'$COUNSEL_A_ID'","contractId":"'$P'"}' \| jq .effectiveTerms` | `note` "These override the key terms and text above: the amendment named made each change." `terms` `[{key:"paymentTermsDays", label:"Payment terms", value:"45 days", amendedBy:"Amendment No. 1", original:"30 days", quote}]`. `sections` holds §5 with `amendedBy` `["Amendment No. 1"]`. |
| 15 | Undo: on `$WEB/contracts/$AMD` click **Undo** in the band. | Toast "Put back 1 term on the agreement". The term row has its checkbox again (30 days → 45 days). The obligation row has its checkbox again, without "no longer owed". `POST /field-runs/$RUN/undo` answered `{ok:true, restored:1, skipped:0}`. |
| 16 | Repeat steps 5, 6, 11 and 12. | Payment terms is "30 days" again, with `source` no longer "amendment". `term-history` → `{"terms":{}}`: an undone roll-up leaves no trace. The fee statement's `supersededById` is null again, and it is listed as Open again (no "Replaced by"). On the parent, **As amended** still lists the §5 card, because the section change comes from the signed amendment itself, but no **Amended key terms**. |
| 17 | Roll it up again (step 4). | As in step 4. Leave it rolled up: E2E-RNW-06 checks that the calendar feed leaves the fee statement out. |

**Also check**
- `POST …/amendment-changes/apply` with `{"keys":[]}` → `422` "Request body failed validation" (pick a term or an obligation). On an unlinked contract → `400` "This contract isn’t linked to the agreement it changes".
- viewer-a on `$AMD`: the checkboxes are disabled and there is no **Confirm on the agreement** or **Undo**. The API answers `403` "Missing permission: edit:contract". rep-a: `404` "Contract not found". `POST /field-runs/$RUN/undo` as admin-b → `404` "Run not found".
- Change the parent's Payment terms by hand to 50 days after a roll-up, then **Undo**: toast "Put back 0 terms on the agreement", with "1 changed since, so left as they are.".
- Untick the obligation and confirm only the term: the obligation stays owed and stays offered with a checkbox.
- Supersede an obligation without any term (untick the term, keep the obligation ticked): `superseded:1`, `runId` null, and no **Undo** band (see Known limits).
- An unsigned amendment (`$AMD2`) has no term rows. Its **Obligations from the sections it replaces** lists §9's obligations, if any were extracted, with disabled checkboxes and "Roll up once Amendment No. 2 is signed. …".

**Known limits**
- Obligations superseded without a term in the same confirmation can't be undone from the screen (no **Undo** band).
- Only key terms roll up as values. A section's words change in the effective view as soon as the amendment is signed. Nobody confirms that.
- The parent's **As amended** view shows each replaced section in the amendment's words as first drafted (the change stored when the amendment was created), not as the signed document has them. If someone edits those words in the amendment before it is signed, the view still shows the first draft: compare it with the signed amendment.

### E2E-AMD-05 · Regression (13, "Split from binder" on an amendment): the banner says what a child is, the family panel shows the family, and only a split part says it was split from a scanned file

**Covers:** /contracts/:id (family banner with **View family**, rail **Contract family**) · `GET /contracts/:id/family` (`label`, `splitFromParent`) · `GET /contracts/:id/family-tree` · lib/family-banner.ts · binder split (`split_part`) · /contracts upload modal (**Link to existing contract**)
**Roles:** counsel-a · **Needs:** agents service + model key for step 7 only (the binder split, or reuse E2E-DOC-03's `$C_BINDER`) · **Time:** ~15 min

**Before.** Every child contract showed a grey band "Split from binder:" with the parent's title, an amendment
included, because the banner only checked that a parent existed. An amendment someone had just drafted read as if an AI
had cut it out of a scanned file.

**Now.** An amendment says "Amendment No. 1 to <agreement>". A numbered SOW, order form or renewal says
"SOW #1 under <agreement>". Any other link says "Linked to <agreement>". Only a part the binder split carved out of a
scanned file (`split_part`, listed in its parent's `_splitInto`) says "Split from scanned file", with how many
agreements were in it.

**Preconditions**
- E2E-AMD-01 to -04 done (`$AN_2` and its children, `$P`, `$AMD`, `$AMD2`).
- For step 7: `$C_BINDER` from docs/40 E2E-DOC-03. Or upload `D-BINDER.pdf` as `QA Binder` and wait for the split.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$AMD`. Look at the band under the header, then search the page (Cmd+F) for "binder", "Split from" and "scanned". | A grey band with a link icon: "Amendment No. 1 to" followed by the link **QA AMD Master Services Agreement**, and at the right only **View family** (no note). The page has no "binder", "Split from" or "scanned" text anywhere. Clicking the link opens `$P`. |
| 2 | Back on `$AMD`, fold the rail's **Contract family** section, scroll to the top, and click **View family** at the right of the band. Repeat in a window narrower than 1280 px (the rail is a drawer there). | The rail opens if it was closed, the **Contract family** section unfolds on its **Family** view, and the page scrolls to it. In the narrow window the rail drawer opens first. |
| 3 | `curl -s $API/contracts/$AMD/family -H "Authorization: Bearer $COUNSEL_A" \| jq '{parent: .parent.title, relationshipType, amendmentNumber, label, splitFromParent, siblings: [.siblings[].title]}'` | `{"parent":"QA AMD Master Services Agreement","relationshipType":"amendment","amendmentNumber":1,"label":"Amendment No. 1","splitFromParent":false,"siblings":["Amendment No. 2 to QA AMD Master Services Agreement"]}`. |
| 4 | Open the other children of `$AN_2` from E2E-AMD-01: SOW #1, Renewal No. 1, an `exhibit` child, the `nda` child. | "SOW #1 under QA AMD Numbering MSA", "Renewal No. 1 under QA AMD Numbering MSA", "Linked to QA AMD Numbering MSA" and "Linked to QA AMD Numbering MSA". The renumbered amendment (`$AN_A2`) reads "Amendment No. 7 to QA AMD Numbering MSA". |
| 5 | On `$AMD`, rail **Contract family**. | The whole family from the top agreement down: "QA AMD Master Services Agreement" (a link), then "Amendment No. 1" (bold, not a link, the one open) and "Amendment No. 2". Each child is followed by its title in grey and "Signed · effective <date>" or its stage. |
| 6 | A contract with no family (`$LS_2` before E2E-AMD-01 step 13, or any stand-alone contract). | No band and no **Contract family** section. |
| 7 | Open one agreement the binder split produced (from `$C_BINDER`'s **Contract family**, or `curl -s $API/contracts/$C_BINDER/family -H "Authorization: Bearer $COUNSEL_A" \| jq '.children[] \| {id, relationshipType}'`). | The children have `relationshipType` "split_part". The child's band has a scissors icon: "Split from scanned file", the link **QA Binder**, and on the right "2 agreements were in that file". `GET …/family` on the child → `splitFromParent` true, `label` null. |
| 8 | Open `$C_BINDER` itself. | The blue band "Auto-split into 2 contracts — the AI split this scanned file into its agreements. Each one is read on its own." Its **Contract family** lists both parts as "Split from scanned file". |
| 9 | Contracts → **Upload**: add any file, open **Link to existing contract**, pick `$P`, and open the relationship list. | "Amendment", "Statement of Work (SOW)", "Order Form", "Renewal", "NDA", "Exhibit / Schedule". Linking as "Exhibit / Schedule" stores `exhibit`. Its page says "Linked to …", never "Split from …". |

**Also check**
- An exhibit that a person links by hand to the binder parent (relationship `exhibit`, not in `_splitInto`) reads "Linked to QA Binder", not "Split from scanned file".
- `sql "SELECT \"relationshipType\", count(*) FROM contracts WHERE \"parentContractId\" IS NOT NULL GROUP BY 1"`: no `exhibit_only` row. Binder children made before the migration became `split_part`, and other `exhibit_only` children became `exhibit`.

**Known limits**
- **View family** opens the family in the rail; there is no separate family page.

### E2E-RNW-01 · A contract's renewal terms are columns worked out from its confirmed values and signed amendments, and every reader uses them

**Covers:** `GET /contracts/:id/renewal` · `POST /review-queue/:id/verify` (field-store commit → `syncRenewalTerms`) · lifecycle transition of a signed amendment (→ parent sync) · `GET /renewals` (`renewalType`, `inWindow`) · `scripts/backfill-renewal-terms.ts` · contract columns `renewalType`, `renewalTermMonths`, `noticeDays`, `noticeDeadline`, `optOutWindowStart`, `priceUpliftCap`, `renewalConfirmed`
**Roles:** counsel-a, viewer-a, rep-a, admin-b · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- Section 5 setup. **The renewal fixtures** for E2E-RNW-01 to -05: signed contracts owned by counsel-a, dated from today.
  ```bash
  cat > qa-rnw.csv <<CSV
  title,type,status,counterpartyname,value,currency,expirydate
  QA RNW Auto,MSA,executed,QA Renew Kilo,40000,USD,$(day +100)
  QA RNW Manual,MSA,executed,QA Renew Lima,30000,USD,$(day +150)
  QA RNW Lapse,MSA,executed,QA Renew Mike,20000,USD,$(day +100)
  QA RNW Late,MSA,executed,QA Renew November,25000,USD,$(day +20)
  QA RNW Draft,MSA,draft,QA Renew Oscar,10000,USD,$(day +100)
  QA RNW Amended,MSA,executed,QA Renew Papa,15000,USD,$(day +200)
  QA RNW Letter,MSA,executed,QA Renew Quebec,35000,USD,$(day +200)
  QA RNW Watch,MSA,executed,QA Renew Romeo,40000,USD,$(day +100)
  QA RNW Escalate later,MSA,executed,QA Renew Sierra,45000,USD,$(day +115)
  CSV
  bulk qa-rnw.csv RN     # sets RN_2 … RN_10, in the order above
  rterms $RN_2 Automatic 90; rterms $RN_3 "By agreement" 90; rterms $RN_4 Automatic 90; rterms $RN_5 Automatic 30
  rterms $RN_7 Automatic 60; rterms $RN_8 "By agreement" 60; rterms $RN_9 Automatic 90; rterms $RN_10 Automatic 90
  qverify $RN_2 '{"field":"renewalTerm","value":{"value":12,"unit":"months"}}'
  qverify $RN_2 '{"field":"priceUpliftCap","value":5}'
  qverify $RN_2 '{"field":"optOutWindow","value":{"value":120,"unit":"days"}}'
  qverify $RN_8 '{"field":"renewalTerm","value":{"value":12,"unit":"months"}}'
  ```
  Every `qverify` prints `{"ok":true,…}`. The notice deadlines: Auto, Lapse and Watch at `day +10`; Manual at `day +60`;
  Late at `day -10`, already passed; Amended and Letter at `day +140`; Escalate later at `day +25`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `ren $RN_2 \| jq '{stage, expiryDate, terms, daysToDeadline, inWindow, canDecide, decision, choices: [.choices[].label]}'` | `stage` "active", `expiryDate` `day +100`. `terms` `{"renewalType":"auto","renewalTermMonths":12,"noticeDays":90,"noticeDeadline":"<day +10>","optOutWindowStart":"<day -20>","priceUpliftCap":5,"confirmed":true}`. `daysToDeadline` 10, `inWindow` true, `canDecide` true, `decision` null. `choices` `["Renew as is","Renegotiate","Let it lapse","End it"]`. |
| 2 | The same columns in the database: `sql "SELECT \"renewalType\", \"renewalTermMonths\", \"noticeDays\", \"noticeDeadline\"::date, \"optOutWindowStart\"::date, \"priceUpliftCap\", \"renewalConfirmed\" FROM contracts WHERE id='$RN_2'"` | `auto\|12\|90\|<day +10>\|<day -20>\|5\|t`. |
| 3 | A manual renewal: `ren $RN_3 \| jq '{terms: {renewalType: .terms.renewalType, noticeDeadline: .terms.noticeDeadline}, daysToDeadline, inWindow}'`. A contract outside its window: `ren $RN_8 \| jq '{deadline: .terms.noticeDeadline, inWindow}'` | `{"terms":{"renewalType":"manual","noticeDeadline":"<day +60>"},"daysToDeadline":60,"inWindow":true}`: a contract that renews only by agreement has a deadline too, the last day to decide. `$RN_8`: deadline `day +140`, `inWindow` false. Its window opens 90 days before the deadline when the contract sets no earliest notice. |
| 4 | A value change moves the columns at once: `rterms $RN_2 Automatic 60`, then `ren $RN_2 \| jq .terms.noticeDeadline`. Put it back with `rterms $RN_2 Automatic 90`. | `<day +40>`, then `<day +10>` again. No job or reload is needed. |
| 5 | A contract that doesn't renew: `qverify $RN_2 '{"field":"renewalType","value":"None"}'` and `ren $RN_2 \| jq '{t: .terms.renewalType, d: .terms.noticeDeadline, o: .terms.optOutWindowStart}'`. Then **Evergreen**. Put back **Automatic**. | `{"t":"none","d":null,"o":null}`, then `"evergreen"` with no deadline. Only automatic and by-agreement renewals have a notice deadline. |
| 6 | An amendment changes the deadline only once signed: `export RA7=$(amend $RN_7 amendment "QA RNW Amended — Amendment No. 1")`, `qverify $RA7 '{"field":"nonRenewalNotice","value":{"value":30,"unit":"days"}}'`, then `ren $RN_7 \| jq '[.terms.noticeDays, .terms.noticeDeadline]'`. | `[60,"<day +140>"]`, unchanged: an unsigned amendment changes nothing. |
| 7 | `execute $RA7` → `EXECUTED`. Repeat the `ren $RN_7` call. | `[30,"<day +170>"]`. Signing the amendment re-worked the parent's columns. The Renewals page row for "QA RNW Amended" shows the new deadline. |
| 8 | The list reads the columns: `curl -s "$API/renewals" -H "Authorization: Bearer $COUNSEL_A" \| jq --arg a "$RN_2" --arg b "$RN_8" '.data[] \| select(.id==$a or .id==$b) \| {title, renewalType, inWindow, renewalDecision, noticeSentAt}'` | "QA RNW Auto": `renewalType` "auto", `inWindow` true, `renewalDecision` null, `noticeSentAt` null. "QA RNW Letter": "manual", `inWindow` false. |
| 9 | The backfill, for contracts set before the columns existed: `cd apps/api && npx tsx --env-file=../../.env scripts/backfill-renewal-terms.ts $ORG_A`. Run it twice. | "Working out renewal terms for <n> contracts (org=<$ORG_A>)…", then "Done: <n> contracts, <m> with a notice deadline, 0 failed.". The second run prints the same, and no contract's `updatedAt` moves (compare `cget $RN_2 \| jq .updatedAt` before and after). |

**Also check**
- `confirmed` is false when the analysis read a renewal value that no person checked: `ren $P \| jq .terms.confirmed` on E2E-AMD-02's uploaded contract, if its analysis read the renewal term. verify: it depends on what the model read. The decision dialog then says "These renewal terms were read by the AI and haven’t been checked yet."
- viewer-a can read `GET …/renewal`. rep-a: `404` "Contract not found". admin-b: `404` "Contract not found".
- A contract with no expiry date: `terms.noticeDeadline` null, `daysToDeadline` null, `inWindow` false. `canDecide` is still true while it is active.

**Known limits**
- `noticePeriodDays` ("Notice period (unconfirmed)") and `autoRenew` are still read when `nonRenewalNotice` and `renewalType` are empty. A stated renewal type wins over the old auto-renew flag.
- `renewalConfirmed` is one flag for all renewal values, not one per value.

### E2E-RNW-02 · Start renewal from the contract or the Renewals page, and renew as is: nothing drafted for an automatic renewal, a renewal letter for one that renews only by agreement

**Covers:** /contracts/:id (rail **Renewal** → **Start renewal**) · /renewals (row **Start renewal**, decision pill) · **Start renewal** dialog · `POST /contracts/:id/renewal-decision` (`renew`) · lib/renewal-decisions.ts `renewalLetter` · seeded template "Renewal letter" (`RENEWAL_LETTER`) · lib/child-contract.ts
**Roles:** counsel-a, viewer-a · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- E2E-RNW-01 done (`$RN_2` automatic, deadline `day +10`; `$RN_8` by agreement, deadline `day +140`, 12-month term).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$RN_2`. Rail **Renewal**. | "Expires in 100d · <date>". "Get renewal advice" (not tested here). Below a rule, in red because it is 14 days or less: "Last day to give notice: <d Mon yyyy> (in 10 days)". A filled button **Start renewal**. Then "Also reminded: nobody yet" and **Add someone**. |
| 2 | Click **Start renewal**. | Dialog **Start renewal**. "Renews automatically, for 12 months at a time." "Current term ends <d Mon yyyy>." The deadline line in red. Three choices, each with what it does. **Renew as is**: "It renews on its own. We record the decision and put the renewal date in your calendar. Nothing is sent." **Renegotiate**: "We open a renewal draft from the agreement as it stands today, linked to it, and review it against the current terms." **Let it lapse or end it**: "We draft a notice of non-renewal from your template. Mark it sent before the deadline. The contract shows as expiring, then expired." Then **Why (optional)**, **Cancel**, and a disabled **Choose one**. |
| 3 | Pick **Renew as is**. Type `Business wants another year` in **Why**. Click **Renew**. | "Decision recorded." "Nothing to draft: it renews on its own. The date is in your calendar feed." **Close**. |
| 4 | Close the dialog (no reload). Look at the status banner, then reload, and `cget $RN_2 \| jq '{stage, stageState}'`. | The rail reads "Decided: **Renew as is** by <counsel-a's name>". The button now reads **Change decision** (outlined). `{"stage":"active","stageState":"renewing"}`; the banner's state reads "Renewing", never "Expiring soon", as soon as the dialog closes, before any reload (regression fa711b9: it read "Active" until a reload). `audit STAGE_CHANGED $RN_2` → reason "we decided to renew it". |
| 5 | `ren $RN_2 \| jq '.decision \| {decision, label, reason, decidedInTime, actionContract}'`, and `audit RENEWAL_DECIDED $RN_2`. | `{"decision":"renew","label":"Renew as is","reason":"Business wants another year","decidedInTime":true,"actionContract":null}`. The audit `metadata` is `{decision:"renew", label:"Renew as is", decisionId, actionContractId:null, noticeDeadline:"<day +10>", decidedInTime:true}`. |
| 6 | The same decision again: `rdecide $RN_2 renew \| jq '{decision, unchanged}'` (HTTP 200). | `{"decision":"renew","unchanged":true}`. Nothing new is recorded. In the dialog this reads "That was already the decision.". |
| 7 | Sidebar → **Renewals**. Find "QA RNW Letter" (ends in about 200 days). | Its row has an outlined **Start renewal**: it is not in its renewal window yet. "QA RNW Auto" shows a pill **Renew** instead (tooltip "Change the decision"). |
| 8 | Click **Start renewal** on "QA RNW Letter". | The dialog's subtitle is "QA RNW Letter". "Renews only if both agree, for 12 months at a time." **Renew as is** now says "We draft a short renewal letter extending the term, from your template. It then goes for approval and signature." |
| 9 | Pick **Renew as is** → **Renew**. | "Decision recorded." and a link **Open Renewal No. 1 to QA RNW Letter (renewal letter)**. Save its id (from the link) as `$RLET`. |
| 10 | Open the link. | A draft, with the band "Renewal No. 1 under QA RNW Letter". The letter reads "Dear QA Renew Quebec," and "We refer to the QA RNW Letter dated … (the "Agreement"), whose current term ends on <day +200>. The parties agree to renew the Agreement for a further term of 12 months, so that it ends on <day +200 plus 12 months>." The dates are words in the org's date order ("dated March 1, 2025", "ends on April 20, 2027"), never ISO such as "dated 2025-03-01" (regression cf9cc8f). It continues "Except for its term, the Agreement continues on the same terms. …" and "Please sign below to confirm your agreement. …", signed with the org's name. |
| 11 | `cget $RLET \| jq '{type, stage, relationshipType, amendmentNumber, effectiveDate: .effectiveDate[:10], expiryDate: .expiryDate[:10], renewal: .metadata._renewal}'` | `type` "OTHER", `stage` "draft", `relationshipType` "renewal", `amendmentNumber` 1, `effectiveDate` = the parent's expiry, `expiryDate` 12 months later. `_renewal` is `{kind:"renewal_letter", decision:"renew", templateId:<the org's Renewal letter template id, or null>, newExpiryDate}`. `templateId` is null in an org seeded before the template existed, which gets the seed's words. |

**Also check**
- viewer-a sees the deadline, the decision and the **Start renewal** / **Change decision** button: `canDecide` is about the contract, not the person. Confirming shows a permission error in red in the dialog, either "You don't have permission to edit contracts." (the web app's own check) or "Missing permission: edit:contract", and records nothing. `rdecide $RN_8 renew $VIEWER_A` → `403` "Missing permission: edit:contract".
- The rail **Renewal** section shows only when the contract has an expiry date and is within 180 days of it, in its window, already decided, or has advice. "QA RNW Letter" (200 days, outside its window) has no section until decided. Use the Renewals page for it.
- The sidebar **Renewals** count and the Renewals page's "undecided" figures drop by one for each decision.

**Known limits**
- The renewal letter is drafted from the template only. It is not sent for approval or signature by itself: the owner does that as for any draft.
- The letter (and the notice of non-renewal) is not analysed when drafted: it stays "Not analysed" and its Review says **Can't recommend** until someone clicks **Analyse now**. A renegotiation draft (E2E-RNW-03) is analysed.
- "Nothing is sent" for an automatic renewal also means nothing reaches the counterparty. The decision is internal.

### E2E-RNW-03 · Renegotiate: a renewal draft opens from the agreement as it stands, linked to it and reviewed against its current terms

**Covers:** **Start renewal** dialog (**Renegotiate** → **Start the renewal draft**) · `POST /contracts/:id/renewal-decision` (`renegotiate`) · lib/renewal-decisions.ts `renegotiationDraft` (effective view → current version → type template) · lib/review-findings.ts parent baseline · `GET /contracts/:id/review` (`baseline`) · rail **Contract family**
**Roles:** counsel-a · **Needs:** agents service + model key (the draft's review) · **Time:** ~20 min

This is docs/41 Part 14's acceptance case: a contract that renews only by agreement, 60 days before its notice
deadline; the owner chooses Renegotiate; a draft linked to the parent opens with the parent's effective text and a
playbook review against the current terms.

**Preconditions**
- E2E-AMD-04 done: `$P` is signed, its Amendment No. 1 (`$AMD`, signed) replaced §5 with 45-day payment words, and Amendment No. 2 (`$AMD2`, unsigned) would delete §9.
- Make `$P` renew by agreement, 60 days before its deadline:
  ```bash
  qverify $P '{"field":"expiryDate","value":"'$(day +150)'"}'
  qverify $P '{"field":"renewalType","value":"By agreement"}'
  qverify $P '{"field":"nonRenewalNotice","value":{"value":90,"unit":"days"}}'
  ren $P | jq '{t: .terms.renewalType, d: .terms.noticeDeadline, daysToDeadline, inWindow}'   # manual, day +60, 60, true
  ```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Open `$WEB/contracts/$P` → rail **Renewal** → **Start renewal**. Pick **Renegotiate**. | The button reads **Start the renewal draft**. The header says "Renews only if both agree" and "Last day to give notice: <date> (in 60 days)", not in red. |
| 2 | Click **Start the renewal draft**. | "Decision recorded." and **Open Renewal No. 1 of QA AMD Master Services Agreement**. Save its id as `$RNEG`. |
| 3 | `cget $RNEG \| jq '{title, type, stage, relationshipType, amendmentNumber, value, parentContractId, effectiveDate: .effectiveDate[:10], expiryDate: .expiryDate[:10], renewal: .metadata._renewal}'` | `title` "Renewal No. 1 of QA AMD Master Services Agreement". `type` is the parent's type. `stage` "draft", `relationshipType` "renewal", `amendmentNumber` 1, `parentContractId` `$P`. `effectiveDate` = the parent's expiry (`day +150`), and `expiryDate` one renewal term later (12 months, unless the analysis read another term). `_renewal` is `{kind:"renegotiation", decision:"renegotiate", baselineVersionId:<$P's current version id>, from:"effective"}`. |
| 4 | Open `$RNEG` and read its text. | One paragraph per section of the agreement, each starting with its number ("1. …", "5. …"). Section 5 holds **Amendment No. 1's 45-day words**, not "thirty (30) days": the draft is the agreement as it stands. Section 9 (governing law) is still there, because Amendment No. 2 is unsigned. The band reads "Renewal No. 1 under QA AMD Master Services Agreement". |
| 5 | `waitdone $RNEG`, then `curl -s $API/contracts/$RNEG/review -H "Authorization: Bearer $COUNSEL_A" \| jq .baseline` | `{"versionId":"<$P's current version id>","versionNumber":null,"reason":"parent","words":"the agreement it renews, as it stands"}`. The first version of the renewal is reviewed against the agreement it renews, not against nothing. |
| 6 | In `$RNEG`'s editor, change §7 so the liability cap is "the fees paid in the three (3) months before the claim", and save. After the analysis (`waitdone $RNEG`), open the review panel. | The liability finding is about the cut from twelve months to three. verify: wording varies; the finding must name the cap change. Sections left as they were raise no "changed" findings. The panel shows no "Compared with v…" line, because the parent baseline has no version number (see Known limits). |
| 7 | On `$P`, rail **Contract family**, and **Renewal**. | The family lists "Renewal No. 1" after the amendments, with its stage "draft". The rail reads "Decided: **Renegotiate** by <counsel-a's name> · Renewal No. 1 of QA AMD Master Services Agreement", the last part a link. |
| 8 | `audit STAGE_CHANGED $RNEG` | The creation event: `metadata.created` true, `toStage` "draft", `via` "renewal_decision", `relationshipType` "renewal", `parentContractId` `$P`. |

**Also check**
- A contract with no clauses and no document (`$RN_3`, "QA RNW Manual", from CSV): `rdecide $RN_3 renegotiate \| jq .actionContract.title` → "Renewal No. 1 of QA RNW Manual". Its words come from the org's published template for type MSA when there is one (`_renewal.from` "template"), else it is empty (`from` "empty", `analysisStatus` "NOT_ANALYSED").
- Renegotiate after Renew as is (on `$RN_2`) supersedes the earlier decision. `ren $RN_2 \| jq '{now: .decision.decision, history: [.history[].decision]}'` → `{"now":"renegotiate","history":["renew"]}`. The audit `metadata.replaces` is "renew".

**Known limits**
- The review panel's "Compared with v{n} (…)" line needs a version number, so a renewal reviewed against its parent shows no comparison line. Only `GET …/review` says what it was compared with.
- The renewal draft is built from clause text as plain paragraphs. The parent's headings, tables and formatting are not carried over.

### E2E-RNW-04 · Let it lapse or end it: a notice of non-renewal is drafted, the contract shows as expiring, and the notice is marked sent before or after the deadline

**Covers:** **Start renewal** dialog (**Let it lapse or end it** → **At the end of the term** / **End it (terminate)** → **Draft the notice**) · rail **Mark notice sent** · /renewals decision pill "· notice not sent" · `POST /contracts/:id/renewal-decision` (`let_lapse`, `terminate`) · `POST /contracts/:id/renewal-decision/notice-sent` · seeded template "Notice of non-renewal" (`NON_RENEWAL_NOTICE`) · lifecycle transition to Active · Expiring soon, and to Active · Renewing on a decision to renew · audit `RENEWAL_DECIDED`, `RENEWAL_NOTICE_SENT`
**Roles:** counsel-a, rep-a, viewer-a · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- E2E-RNW-01's fixtures: `$RN_4` "QA RNW Lapse" (automatic, 90 days' notice, deadline `day +10`), `$RN_5` "QA RNW Late" (automatic, 30 days, deadline `day -10`), `$RN_6` "QA RNW Draft" (a draft).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `$WEB/contracts/$RN_4` → rail **Renewal** → **Start renewal**. Pick **Let it lapse or end it**. | Two sub-choices appear: **At the end of the term** (selected) and **End it (terminate)**. The text reads "We draft a notice of non-renewal from your template. Mark it sent before the deadline. The contract shows as expiring, then expired." The button reads **Draft the notice**. |
| 2 | Click **End it (terminate)**, then back to **At the end of the term**. | The text ends "… then ended." for terminate, and "… then expired." again. |
| 3 | Click **Draft the notice**. | "Decision recorded." and **Open Notice of non-renewal: QA RNW Lapse**. Save its id as `$NOT4`. |
| 4 | Close the dialog and reload. Look at the status banner, the rail, and `cget $RN_4 \| jq '{stage, stageState}'`. | `{"stage":"active","stageState":"expiring"}`, and the banner shows "Expiring soon". The rail reads "Decided: **Let it lapse** by <counsel-a's name> · Notice of non-renewal: QA RNW Lapse". Below it: a date input (today, no later day allowed) and **Mark notice sent**. |
| 5 | Open `$NOT4`. | A draft, with the band "Linked to QA RNW Lapse" (relationship `other`, unnumbered). "Dear QA Renew Mike," then "We refer to the QA RNW Lapse dated … (the "Agreement"). This letter is our written notice, given under the Agreement's renewal provisions (90 days' notice), that the Agreement will not renew and will end at the end of its current term on <day +100>." Every date is written as the org writes dates: "dated January 15, 2025" and "on March 1, 2026" (month first, the default), or "1 March 2026" when the organization’s date order is day first. Never ISO ("dated 2025-01-15"): regression cf9cc8f from the browser run. |
| 6 | Sidebar → **Renewals**, find "QA RNW Lapse". | The pill reads "Let it lapse · notice not sent". |
| 7 | Back on `$RN_4`, leave today's date and click **Mark notice sent**. | The input and button go away. The rail reads "Notice sent <d Mon yyyy>, before the deadline" in grey. The Renewals pill is now "Let it lapse". `audit RENEWAL_NOTICE_SENT $RN_4` → `metadata` `{decisionId, sentAt:"<today>", noticeDeadline:"<day +10>", inTime:true}`. |
| 8 | Late: on the Renewals page click **Start renewal** on "QA RNW Late". | The deadline line reads "Last day to give notice: <date> (10 days ago)", in red. |
| 9 | Pick **Let it lapse or end it** → **End it (terminate)** → **Draft the notice**. | "Decision recorded. It was made after the notice deadline." and **Open Notice of non-renewal: QA RNW Late**. |
| 10 | On `$WEB/contracts/$RN_5`, click **Mark notice sent** with today's date. | The rail reads "Decided: **End it** by … (after the deadline)" and, in red, "Notice sent <d Mon yyyy>, after the deadline (late)". `ren $RN_5 \| jq '.decision \| {decision, decidedInTime, noticeSentAt, noticeSentInTime}'` → `{"decision":"terminate","decidedInTime":false,"noticeSentAt":"<today>","noticeSentInTime":false}`. |
| 11 | Change the decision: on `$RN_4` click **Change decision**, pick **Renew as is** → **Renew**. Then `ren $RN_4 \| jq '{now: .decision.label, history: [.history[] \| .decision]}'` and `cget $RN_4 \| jq .stageState`. | `{"now":"Renew as is","history":["let_lapse"]}`. The earlier decision stays on the record as superseded. `stageState` is "renewing" (regression: it stayed "expiring"): the banner's state reads "Renewing", not "Expiring soon". The notice draft `$NOT4` stays as it is. |
| 12 | Run the date job (`curl -s -X POST $API/cron/renewals -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{}' \| jq .stageDates.moved`), then `cget $RN_4 \| jq .stageState`. | Still "renewing": the job does not move a renewing contract back to expiring; it acts again only at the end date. Choosing **Renegotiate** instead gives the same state, with reason "we decided to renegotiate it". |

**Also check**
- `rsent $RN_2` (its decision is to renew) → `409` "Only a decision not to renew has a notice to send.". `rsent $RN_5 $(day +3)` → `400` "The notice can’t be sent in the future.". `rsent $RN_5 03/10/2026` → `400` "Give the date the notice was sent as YYYY-MM-DD.". A past date is accepted, and decides in-time against the deadline as it was when the decision was made.
- `rdecide $RN_6 let_lapse` (a draft) → `409` "Only a signed contract that is still running can be renewed or ended. Make a new contract instead.". `rdecide $RN_4 pause` → `400` "The decision must be one of renew, renegotiate, let_lapse, terminate.". `curl -s -X POST $API/contracts/$RN_4/renewal-decision -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{}'` → `400` "Say which decision: renew, renegotiate, let_lapse or terminate.". The old value `let_expire` is accepted as `let_lapse`. The old field name `note` is accepted as `reason`.
- rep-a (doesn't own them): `rdecide $RN_4 renew $REP_A` → `403` "Missing permission: edit:contract". admin-b: `404` "Contract not found". An API key's decision drafts its notice as the key's creator.
- The CSV export (`GET /renewals/export`, docs/40 E2E-REN-05) has the standing decision in its decision column: `let_lapse`, `terminate`, `renew` or `renegotiate`.

**Known limits**
- Changing the decision from not renewing to renewing doesn't withdraw the notice draft. Archive the notice by hand.
  The date job renews it at its end date as the contract says (E2E-RNW-07).
- Marking the notice sent records a date only. Nothing is emailed or signed, and the notice draft's own stage is not changed.

### E2E-RNW-05 · Watchers get the owner's renewal reminders, and an undecided renewal escalates to Legal Ops once per deadline, at the org's lead time

**Covers:** rail **Renewal** → "Also reminded:" (**Add someone**, ×) · `GET`/`POST /contracts/:id/watchers` · `DELETE /contracts/:id/watchers/:userId` · `POST /cron/renewals` (scan.worker renewal scan: `renewalRecipients`, `escalationDue`, `legalOpsUsers`) · `PATCH /organization` (`settings.renewalEscalationDays`) · bell notifications `RENEWAL_DUE`, `ESCALATION` · Mailpit · audit `CONTRACT_WATCHER_ADDED`, `CONTRACT_WATCHER_REMOVED`
**Roles:** counsel-a (owner), contracts-a and viewer-a (watchers), legalops-a and admin-a (Legal Ops), admin-b · **Needs:** Mailpit · **Time:** ~25 min

**Preconditions**
- E2E-RNW-01's fixtures: `$RN_9` "QA RNW Watch" (automatic, deadline `day +10`, undecided) and `$RN_10` "QA RNW Escalate later" (automatic, deadline `day +25`, undecided).
- Org A's escalation lead is the default: `curl -s $API/organization -H "Authorization: Bearer $ADMIN_A" | jq .settings.renewalEscalationDays` → `null` (14 days).
- If the daily scan (09:15 UTC) has run since the fixtures were made, clear its marks: `sql "UPDATE contracts SET metadata = metadata - 'renewalEscalatedFor' - 'renewalNotifiedAt' WHERE id IN ('$RN_9','$RN_10')"`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As counsel-a open `$WEB/contracts/$RN_9`. Rail **Renewal**: "Also reminded: nobody yet". Click **Add someone**, then pick contracts-a in the user picker. | A chip with contracts-a's name and a ×. `audit CONTRACT_WATCHER_ADDED $RN_9` → `metadata` `{watcherId:<contracts-a's id>}`. |
| 2 | Add viewer-a through the API: `curl -s -X POST $API/contracts/$RN_9/watchers -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d "{\"userId\":\"$VIEWER_A_ID\"}" \| jq '[.data[].email]'` (HTTP 201) | `["contracts@demo.com","viewer@qa.test"]`, in the order added. Adding the same person again changes nothing. |
| 3 | Run the scan: `curl -s -X POST $API/cron/renewals -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"force":true}' \| jq '{result, moved: .stageDates.moved}'` | `result` has `notified`, `skippedCooldown`, `skippedNoOwner` 0, `escalated` (at least 1) and `errors` `[]`. `moved` is explained in E2E-RNW-07. |
| 4 | `notes $COUNSEL_A`, `notes $CONTRACTS_A`, `notes $VIEWER_A`, and Mailpit for legal@demo.com, contracts@demo.com and viewer@qa.test. | Each has "Notice deadline in 10d · QA RNW Watch", body "QA Renew Romeo · USD 40000 — auto-renews unless 90 days' notice is served by <day +10>.". The owner and both watchers get it. No reminder for "QA RNW Auto", "QA RNW Lapse" or "QA RNW Late": they are decided. |
| 5 | `notes $LEGALOPS_A`, `notes $ADMIN_A`, Mailpit for legalops@qa.test and admin@demo.com. | An `ESCALATION` "No renewal decision · QA RNW Watch", body "QA Renew Romeo — the last day to give notice is <day +10>, and nobody has decided whether to renew. Ask the owner, or decide on the contract.". counsel-a, contracts-a and viewer-a get no escalation: only people who may configure workflows do. Nothing is escalated for "QA RNW Escalate later", which is 25 days out against a 14-day lead. |
| 6 | `cget $RN_9 \| jq .metadata.renewalEscalatedFor` | `"<day +10>"`: the escalation is marked for this deadline. |
| 7 | Run the scan again (step 3). Check legalops-a's notes. | The reminders come again (forced), but no second escalation for "QA RNW Watch": once per deadline. `result.escalated` is 0 unless another contract became due. |
| 8 | Lengthen the lead: `curl -s -X PATCH $API/organization -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"settings":{"renewalEscalationDays":30}}' \| jq .settings.renewalEscalationDays`, then run the scan. | `30`. legalops-a now has "No renewal decision · QA RNW Escalate later". |
| 9 | On `$RN_9`, click × on contracts-a's chip (aria-label "Stop reminding <name>"). Run the scan. | The chip goes. `audit CONTRACT_WATCHER_REMOVED $RN_9` is recorded. counsel-a and viewer-a get the reminder; contracts-a doesn't. |
| 10 | Decide: `rdecide $RN_9 renew \| jq .decision`. Run the scan. | `"renew"`. No reminder and no escalation for "QA RNW Watch" any more. It is counted in `skippedCooldown`. |
| 11 | Reminder wording follows how it renews (regression: every reminder said "auto-renews"). Bring the by-agreement `$RN_3` ("QA RNW Manual", 90 days' notice) near its deadline: `qverify $RN_3 '{"field":"expiryDate","value":"'$(day +100)'"}'`, run the scan, `notes $COUNSEL_A`. | "Notice deadline in 10d · QA RNW Manual", body "QA Renew Lima · USD 30000 — renews only if both sides agree: tell them by <day +10> (90 days' notice) if you want to renew. Otherwise it ends on <day +100>." No "auto-renews". legalops-a also gets its escalation. |
| 12 | Put the setting back: the step 8 call with `14`. | `14`. |

**Also check**
- `POST …/watchers` with no body: counsel-a watches it themself. With admin-b's user id (`$ADMIN_B_ID`) → `404` "That person isn’t in your organization.". As viewer-a → `403` "Missing permission: edit:contract". As admin-b on `$RN_9` → `404` "Contract not found".
- A deactivated watcher (Admin → Users → deactivate viewer-a, then reactivate) gets no reminder while deactivated. Neither does a deactivated Legal Ops user get an escalation.
- counsel-a: `PATCH /organization` → `403` "Missing permission: configure:integration".
- A contract decided before the deadline came into the lead window is never escalated.
- Wording when no notice deadline drives the reminder (only an end date): automatic "renews automatically on <date>
  unless notice is served. Review renewal options now.", by agreement "ends on <date> unless both sides agree to renew.
  Review renewal options now.", until ended "runs until either side ends it. Review whether to keep it.", no renewal
  "ends on <date> and does not renew. Review whether to replace it." An unconfirmed notice period on a by-agreement
  contract adds " Confirm this is the notice to renew, not the notice to end early."

**Known limits**
- `renewalEscalationDays` has no screen. Set it through the API. A value outside 0–365, or not a number, falls back to 14 without an error.
- The watcher picker doesn't hide the owner. Adding the owner is harmless, because each person is reminded once.

### E2E-RNW-06 · Each person subscribes to a revocable calendar feed of notice deadlines, end dates and obligation due dates for the contracts they can see

**Covers:** /settings?tab=notifications (**Calendar feed**: **Make my link**, **Copy**, **Make a new link**, **Turn off the link**) · `GET`/`POST`/`DELETE /calendar-feed` · `GET /calendar/:token.ics` (no sign-in) · lib/calendar-feed.ts · audit `CALENDAR_FEED_CREATED`, `CALENDAR_FEED_REVOKED`
**Roles:** counsel-a, rep-a, viewer-a, admin-b · **Needs:** nothing extra · **Time:** ~20 min

**Preconditions**
- E2E-RNW-01 to -05 and E2E-AMD-04 done. Expect events for "QA RNW Auto" (notice `day +10`, ends `day +100`) and for `$P`'s penetration test summary (due `day +40`). The superseded fee statement must not appear.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As counsel-a open `$WEB/settings?tab=notifications`. Scroll to the end. | A card **Calendar feed**: "Add your contract dates to Google Calendar, Outlook or Apple Calendar: the last day to give notice, when each contract ends, and when obligations are due, for the contracts you can see. Anyone with the link can see these dates, so keep it to yourself." A filled button **Make my link**. |
| 2 | Click **Make my link**. | "Copy this link now and subscribe to it in your calendar app. It won’t be shown again." A read-only box with `http://localhost:5173/api/v1/calendar/<token>.ics` and **Copy**. Clicking **Copy** changes it to **Copied**. The buttons are now **Make a new link** (outlined) and **Turn off the link**. |
| 3 | Reload the page. | The link is gone. "Your link has been on since <d Mon yyyy>." and "A new link stops the old one working.". `curl -s $API/calendar-feed -H "Authorization: Bearer $COUNSEL_A"` → `{"active":true,"createdAt":"…","revokedAt":null}`. |
| 4 | Make a link through the API, which replaces the one in the browser: `export FEED=$(curl -s -X POST $API/calendar-feed -H "Authorization: Bearer $COUNSEL_A" \| jq -r .url); echo $FEED`. | HTTP 201, with a URL ending `.ics`. `audit CALENDAR_FEED_CREATED` shows counsel-a, `resourceType` "user". |
| 5 | Fetch it with no sign-in: `curl -s -D - "$FEED" -o feed.ics \| grep -i '^content-'; unfold < feed.ics \| grep -E '^(X-WR-CALNAME\|SUMMARY\|DTSTART)' \| head -40` | `content-type: text/calendar; charset=utf-8` and `content-disposition: inline; filename="contract-dates.ics"`. `X-WR-CALNAME:Contract dates`. Then events in date order. Look for "SUMMARY:Last day to give notice: QA RNW Auto" with `DTSTART;VALUE=DATE:<day +10 as YYYYMMDD>`, "SUMMARY:Ends: QA RNW Auto" at `day +100`, and "SUMMARY:Due: <the penetration test summary>" at `day +40`. There is no "Due:" line for the quarterly fee statement, which Amendment No. 1 superseded. |
| 6 | `unfold < feed.ics \| grep -A7 'UID:notice-'"$RN_2"` | `DESCRIPTION:The last day to give notice (90 days) on QA RNW Auto with QA Renew Kilo\, before it renews or ends.` (commas escaped). `URL:http://localhost:5173/contracts/<$RN_2>`. `UID:notice-<$RN_2>@draftlegal`. |
| 7 | Another person's view: as rep-a `curl -s -X POST $API/calendar-feed -H "Authorization: Bearer $REP_A" \| jq -r .url`, fetch it, and grep for "QA RNW". | No "QA RNW" event: rep-a sees only contracts rep-a owns. viewer-a's feed (made the same way) has them all. |
| 8 | Another org: admin-b's feed (made the same way). | No Org A contract in it. |
| 9 | Rotate: click **Make a new link** in the browser. Then `curl -s -o /dev/null -w '%{http_code}\n' "$FEED"` and `curl -s "$FEED"`. | `404`, `{"type":"https://httpstatuses.com/404","title":"Not Found","status":404,"detail":"This calendar link doesn’t work any more."}`. The new link works. |
| 10 | Click **Turn off the link**. | The card goes back to **Make my link**. `GET /calendar-feed` → `{"active":false,"createdAt":null,"revokedAt":"<now>"}`. The last link answers 404 as in step 9. `audit CALENDAR_FEED_REVOKED` is recorded. |

**Also check**
- A made-up or tampered token (change one character of a valid one): `404` with the same body. The database is not asked, because the signature fails first. A URL not ending `.ics` → `404`.
- A deactivated user's link answers 404 while they are deactivated.
- `DELETE /calendar-feed` when there is no link → `200` with `active` false, and no audit row.
- The token is stored only as a hash: `sql "SELECT \"tokenHash\" IS NOT NULL, version FROM calendar_feeds WHERE \"userId\"='$COUNSEL_A_ID'"`. Each new link raises `version`.

**Known limits**
- The link is built from `API_PUBLIC_URL` or `FRONTEND_URL` (here `localhost:5173`, through the web app's `/api` proxy). Google Calendar and Outlook on the web can't reach a local link: test the subscription in Apple Calendar on the same machine, or on a hosted environment.
- The feed lists every contract the person can see, not only those they own or watch. Watching a contract adds nothing to a feed that already holds it.
- Calendar apps cache a feed for hours. The server allows 15 minutes (`cache-control: private, max-age=900`).

### E2E-RNW-07 · The daily date job moves contracts by their dates and decisions: expiring, expired, ended as we gave notice, renewed automatically, and back to active

**Covers:** `POST /cron/renewals` (`stageDates`: lib/lifecycle-dates.ts `scanStageDates`, run before the renewal scan; scan.worker daily at 09:15 UTC) · lib/lifecycle.ts `transition` (source `dates`) · status banner states "Expiring soon", "Expired", "Terminated", "Renewed automatically" · field-store `renewExpiry` (expiry moved on, source `renewal`) · Key terms "Renewed" mark · `POST /contracts/:id/renewal-decision` on a closed contract
**Roles:** counsel-a, admin-a · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- Section 5 setup (with `rterms`). Contracts whose term ended two days ago, and one ending in 20 days:
  ```bash
  cat > qa-rnw-dates.csv <<CSV
  title,type,status,counterpartyname,expirydate
  QA RNW Gone Lapse,MSA,executed,QA Dates One,$(day -2)
  QA RNW Gone End,MSA,executed,QA Dates Two,$(day -2)
  QA RNW Gone Auto,MSA,executed,QA Dates Three,$(day -2)
  QA RNW Gone Unsent,MSA,executed,QA Dates Four,$(day -2)
  QA RNW Gone Manual,MSA,executed,QA Dates Five,$(day -2)
  QA RNW Soon,MSA,executed,QA Dates Six,$(day +20)
  CSV
  bulk qa-rnw-dates.csv RD      # RD_2 … RD_7
  for id in $RD_2 $RD_3 $RD_4 $RD_5 $RD_7; do rterms $id Automatic 30; done; rterms $RD_6 "By agreement" 30
  qverify $RD_4 '{"field":"renewalTerm","value":{"value":12,"unit":"months"}}'   # Gone Auto renews for 12 months; Unsent has no term
  rdecide $RD_2 let_lapse > /dev/null; rsent $RD_2 $(day -40)      # not renewing, notice sent in time
  rdecide $RD_3 terminate > /dev/null; rsent $RD_3 $(day -40)      # ending it, notice sent in time
  rdecide $RD_5 let_lapse > /dev/null                               # not renewing, but no notice sent
  st() { for id in "$@"; do cget $id | jq -r '"\(.title): \(.stage) · \(.stageState)"'; done; }
  st $RD_2 $RD_3 $RD_4 $RD_5 $RD_6 $RD_7
  ```
  Before the job: Lapse, End and Unsent are `active · expiring` (a decision not to renew moves a contract to
  expiring at once). Auto, Manual and Soon are `active · active`.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Run the job, as the daily worker would: `curl -s -X POST $API/cron/renewals -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{}' \| jq .stageDates` | `{"scanned":<n>,"moved":{"expiring":≥1,"expired":≥2,"terminated":≥1,"auto_renewed":≥2,"reactivated":0},"errors":[]}`. Other journeys' contracts may add to the counts. |
| 2 | `st $RD_2 $RD_3 $RD_4 $RD_5 $RD_6 $RD_7` | Gone Lapse: `closed · expired`. Gone End: `closed · terminated`. Gone Auto: `active · auto_renewed`. Gone Unsent: `active · auto_renewed`, because a decision not to renew stops an automatic renewal only once its notice is marked sent. Gone Manual: `closed · expired`, because a by-agreement contract with no decision ends. Soon: `active · expiring`. |
| 3 | Open Gone End and Gone Auto in the browser. | The status banners read "Terminated" (stage Closed) and "Renewed automatically" (stage Active). Gone Lapse reads "Expired". Soon reads "Expiring soon". |
| 4 | `audit STAGE_CHANGED $RD_3` | The newest event moves to `closed`/`terminated` with `source` "dates" and the reason "it ended on <day -2>, as we gave notice". For `$RD_4`: "it renewed on its own at its expiry date, <day -2>, for 12 months: it now runs to <day -2 plus 12 months>". For `$RD_5` (no renewal term): "it renewed on its own at its expiry date". For `$RD_7`: "it expires on <day +20>". |
| 5 | Run the job again. | None of these six moves again. |
| 6 | A closed contract can't be decided: `rdecide $RD_2 renew` | `409` "Only a signed contract that is still running can be renewed or ended. Make a new contract instead.". The rail has no **Start renewal**/**Change decision** button (`canDecide` false). |
| 7 | Back to active: `qverify $RD_6 '{"field":"expiryDate","value":"'$(day +60)'"}'`, run the job, `st $RD_6`. | `moved.reactivated` 1. "QA RNW Gone Manual: active · active": an expired contract whose end date moves into the future comes back. |
| 8 | The expiry moved on (regression: it used to stay in the past). `cget $RD_4 \| jq '{expiryDate: .expiryDate[:10], renewalTermMonths}'`, `sql "SELECT \"noticeDeadline\"::date FROM contracts WHERE id='$RD_4'"`, and `audit CONTRACT_UPDATED $RD_4` | `expiryDate` = `$(date -v-2d -v+12m +%F)` (on Linux `date -d "-2 days +12 months" +%F`), `renewalTermMonths` 12. `noticeDeadline` 30 days before the new expiry. The audit event has `metadata` `{source:"auto_renewal", action:"renewed_expiry", from:<day -2>, to:<new expiry>, months:12, renewals:1, termFrom:"renewal term"}`. `$RD_5` (no term) keeps `day -2`. |
| 9 | Open `$RD_4` → **Key terms**. Hover the mark beside Expiry date. | Expiry date shows the new date with the mark "Renewed" (tooltip "Moved on when the contract renewed automatically — a re-analysis won't change it"). The banner still reads "Renewed automatically". |
| 10 | Bring the renewed term near its end: `sql "UPDATE contracts SET \"expiryDate\" = now() + interval '20 days' WHERE id='$RD_4'"`, run the job, `st $RD_4`. | `active · expiring`: a renewed term nears its end like the first one did, and renews again at its end date. |

**Also check**
- The same job runs inside the daily renewal scan. The scan's reminders for these contracts read "Expired 2d ago · …" for the ones still active and undecided.
- An amendment, exhibit or split part never moves on its own dates: it follows its parent.
- `$RN_5` ("QA RNW Late", ends `day +20`, notice of termination sent late in E2E-RNW-04) is `active · expiring` now and will close as `terminated` at its end date. The late notice is recorded but does not change what the job does.

**Known limits**
- The term a renewal runs for is the renewal term; without one, the **initial term** ("successive periods of the same
  length"); with neither (like `$RD_5`), the contract is marked renewed once and its date stays until someone sets it.
  Falling back to the initial term is an open product decision (Appendix A).
- The job runs once a day. A notice marked sent after the end date has passed takes effect only on a contract still active.

### E2E-RNW-08 · Regression (14, "Renewal"): renewal is a decision with an action, tracked from first reminder to the contract's end

**Covers:** /renewals · /contracts/:id rail **Renewal** · `GET /contracts/:id/renewal` · `POST /contracts/:id/renewal-decision` · `…/notice-sent` · `POST /contracts/:id/watchers` · `POST /cron/renewals` · `POST /calendar-feed` · `GET /calendar/:token.ics`
**Roles:** counsel-a, contracts-a, legalops-a, admin-a · **Needs:** Mailpit · **Time:** ~15 min

**Before.** "Create Renewal" existed only as the Renewal tile in **Create amendment**, and made an empty draft. A
renewal decision was stored on the contract and triggered nothing. Notice days and auto-renewal lived only in
AI-extracted key terms. Reminders went to the owner only. Nothing ever set a contract Expired. There was no calendar
export and no escalation.

**Now.** One contract, from first reminder to its end.

**Preconditions**
- Section 5 setup and `rterms`. A contract that must give notice within 10 days:
  ```bash
  printf 'title,type,status,counterpartyname,value,currency,expirydate\nQA RNW Regression,LICENSE,executed,QA Renew Tango,12000,USD,%s\n' "$(day +70)" > qa-rnw-reg.csv
  bulk qa-rnw-reg.csv RR; rterms $RR_2 Automatic 60     # deadline day +10
  ```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `ren $RR_2 \| jq '{t: .terms.renewalType, d: .terms.noticeDays, deadline: .terms.noticeDeadline, inWindow}'` | `{"t":"auto","d":60,"deadline":"<day +10>","inWindow":true}`: the terms are columns of their own, confirmed by a person. |
| 2 | `curl -s -X POST $API/contracts/$RR_2/watchers -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d "{\"userId\":\"$CONTRACTS_A_ID\"}" \| jq '[.data[].email]'`, then the forced scan (`curl -s -X POST $API/cron/renewals -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"force":true}' \| jq .result.escalated`). | `["contracts@demo.com"]`. counsel-a **and** contracts-a get "Notice deadline in 10d · QA RNW Regression". legalops-a gets "No renewal decision · QA RNW Regression". |
| 3 | Make counsel-a's calendar link (`POST /calendar-feed`), fetch it, and look for the contract. | "SUMMARY:Last day to give notice: QA RNW Regression" on `day +10`, and "SUMMARY:Ends: QA RNW Regression" on `day +70`. |
| 4 | Sidebar → **Renewals**, row "QA RNW Regression" → **Start renewal** (filled). Choose **Let it lapse or end it** → **At the end of the term** → **Draft the notice**. | "Decision recorded." and **Open Notice of non-renewal: QA RNW Regression**: the decision started an action. The row's pill reads "Let it lapse · notice not sent". The contract is "Expiring soon". |
| 5 | On the contract, **Mark notice sent** (today). Run the forced scan again. | "Notice sent <today>, before the deadline". No new reminder or escalation for the contract: a decision stops them. |
| 6 | Move its end date into the past, `qverify $RR_2 '{"field":"expiryDate","value":"'$(day -1)'"}'`, and run the scan. `cget $RR_2 \| jq '{stage, stageState}'` | `{"stage":"closed","stageState":"expired"}`. A contract that was set to lapse, with its notice sent, ends as Expired. |

**Also check**
- **Create amendment** still offers the **Renewal** tile, for a renewal paper drafted by hand. It makes "Renewal No. <n> to …", numbered with the renewals the decisions drafted.

**Known limits**
- See E2E-RNW-04 and E2E-RNW-07.

### E2E-ANA-01 · Regression (19, "Analytics"): the page answers decisions in seven sections under one filter bar, and cycle time runs from the request to `executedAt`

**Covers:** /analytics (section nav, filter bar, **Speed**, **Bottlenecks**, **Workload**, **Negotiation**, **Risk and playbook**, **Renewals**, **AI suggestions**, "Portfolio at a glance") · `GET /analytics/{speed,bottlenecks,workload,negotiation,risk,renewals,ai}` (`from`, `to`, `type`, `ownerId`, `paperSource`) · `GET /analytics/summary` (`cycleTimeMedianDays` from `executedAt`) · internal tool `contract_create_from_template` (our paper) · lib/analytics-sections.ts, lib/analytics-metrics.ts
**Roles:** counsel-a, admin-a · **Needs:** nothing extra · **Time:** ~30 min

**Before.** The page showed totals, distributions, monthly volume and top counterparties. Its one cycle-time figure
was `updatedAt − createdAt`, so any edit after signature made a contract look slower. Approval time, turns, clause
pushback and renewals missed were in the data, but nothing worked them out.

**Now.** Seven sections, each named for a decision, each chart with one line saying what it helps decide. Cycle time
runs from creation to `executedAt`, which is set once.

**Preconditions**
- Section 5 setup. The journeys before this one done (the Renewals section reads their deadlines). Best on a stack
  without `pnpm demo:seed`: its PARTNERSHIP contracts would join the figures below.
- Four PARTNERSHIP contracts, two on our paper (drafted from a template) and two on theirs (imported):
  ```bash
  export TPL=$(curl -s "$API/templates?published=true" -H "Authorization: Bearer $COUNSEL_A" | jq -r '.data[0].id')
  export TPLNAME=$(curl -s "$API/templates/$TPL" -H "Authorization: Bearer $COUNSEL_A" | jq -r .name)
  mkours() { tj contract_create_from_template "{\"orgId\":\"$ORG_A\",\"userId\":\"$COUNSEL_A_ID\",\"templateId\":\"$TPL\",\"title\":\"$1\",\"counterpartyName\":\"QA Analytics Co\",\"contractType\":\"PARTNERSHIP\"}" | jq -r .contractId; }
  export AO1=$(mkours "QA ANA Ours 1") AO2=$(mkours "QA ANA Ours 2")
  printf 'title,type,status,counterpartyname\nQA ANA Theirs 1,PARTNERSHIP,draft,QA Analytics Co\nQA ANA Theirs 2,PARTNERSHIP,draft,QA Analytics Co\n' > qa-ana.csv
  bulk qa-ana.csv AT                      # AT_2, AT_3
  execute $AO1; execute $AT_2; execute $AT_3          # each prints EXECUTED; executedAt = now
  # requested 10, 30 and 40 days ago
  sql "UPDATE contracts SET \"createdAt\" = now() - interval '10 days' WHERE id='$AO1'"
  sql "UPDATE contracts SET \"createdAt\" = now() - interval '30 days' WHERE id='$AT_2'"
  sql "UPDATE contracts SET \"createdAt\" = now() - interval '40 days' WHERE id='$AT_3'"
  # one approval left waiting on counsel-a
  curl -s -X POST "$API/contracts/$AO2/submit-approval" -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d "{\"workflowDefinitionId\":\"$W6\"}" > /dev/null
  export Q="from=$(day -60)&type=PARTNERSHIP"
  ```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | As counsel-a open `$WEB/analytics`. | Title **Analytics**, "Organised by the decision each figure helps you make. Click any bar to open its contracts." A filter bar: **Last 6 months** (also Last 30 days, Last 90 days, Last year), **All types**, **Any paper** (Our paper, Their paper or uploaded) and **Only contracts I own**. Links to the sections: Speed, Bottlenecks, Workload, Negotiation, Risk and playbook, Renewals, AI. Then the seven sections in that order, each with a heading, a one-line question and a **CSV** button. Below them, "Portfolio at a glance": the earlier dashboard. |
| 2 | Pick **PARTNERSHIP** in the type list. Look at **Speed**. | "How long a request takes to become a signed contract — where to invest in self-serve, templates or people." Figures: **Median cycle time** "30 d" ("request to executed"), **9 in 10 signed within** "38 d" ("90th percentile") and **Executed** "3" ("in this period"). Charts: "Cycle time by contract type" (one bar, PARTNERSHIP, 30 d), "Our paper vs theirs" ("Their paper or uploaded" 35 d, "Our paper" 10 d), "Cycle time by owner" (counsel-a's name, 30 d), and "Templates in use" (<TPLNAME>, "2 drafted", "10 d to sign · 0 turns"). |
| 3 | The API: `ana speed "$Q" \| jq '{filters, cycle: .parts.cycle.headline, byPaper: [.parts.cycle.charts.byPaper[] \| {key, value, n}], tpl: .parts.templates.charts.byTemplate[0] \| {label, value, extra}}'` | `filters.type` "PARTNERSHIP". `cycle` `{"executed":3,"medianDays":30,"p90Days":38}`; days are rounded to one decimal, so allow ±0.1. `byPaper` `[{key:"theirs",value:35,n:2},{key:"ours",value:10,n:1}]`. `tpl` `{label:<TPLNAME>, value:2, extra:{executed:1, medianCycleDays:10, medianTurns:0}}`. No bar carries `ids`. |
| 4 | Edit an executed contract: `curl -s -X PATCH $API/contracts/$AT_3 -H "Authorization: Bearer $COUNSEL_A" -H 'content-type: application/json' -d '{"title":"QA ANA Theirs 2 (renamed)"}' > /dev/null`, then repeat step 3. Also compare `curl -s "$API/analytics/summary?days=90" -H "Authorization: Bearer $COUNSEL_A" \| jq '{cycleTimeAvgDays, cycleTimeMedianDays}'` before and after the edit. | The same figures: cycle time runs to `executedAt`, which an edit doesn't move. The summary's cycle time is also unchanged by the edit. Before this change, it grew with every edit. |
| 5 | Filters: `ana speed "$Q&paperSource=ours" \| jq .parts.cycle.headline.executed`, then `paperSource=theirs`, then `ana speed "from=$(day -20)&type=PARTNERSHIP" \| jq .parts.cycle.headline`. | `1`, then `2`. Then the same 3: the period counts by when a contract was executed (all today), not when it was requested. `ana speed "$Q&paperSource=mine"` → `400` "Invalid query". `from` after `to` → `400` "Invalid query". |
| 6 | **Bottlenecks**. | "Which stage holds work longest, and which approvals wait — what to fix first." **Slowest stage** "Draft", with "median <n> d": the three contracts sat in Draft from their backdated creation. verify: other PARTNERSHIP work changes the median. **Median approval** about "0.0 d" ("from the step becoming theirs"). **Approvals waiting now** "1" (AO2). Charts: "Time in each stage", "Approval time by approver" (counsel-a, with "1 waiting"), "Approval time by step" ("Counsel sign-off"). |
| 7 | **Workload** as counsel-a. | "What is waiting, on whom, and for how long — who is overloaded and what is stuck. As of now." **Waiting on me** ≥ 1 and **Mine, over 2 weeks**. Chart "Needs my action, by age": AO2 in "Under 3 days". There is no "Team in flight" figure and no team charts, because counsel-a can't configure workflows (E2E-ANA-03). |
| 8 | **Negotiation**, **Risk and playbook**. | Their questions are "How long counterparties keep a draft, how many rounds it takes, and which clauses get pushed back on." and "How much risk was accepted at signature, and where exceptions are granted — whether to tighten or loosen the playbook.". With no counterparty turns, each empty chart says "Nothing in this period." "Open at signature, by clause" says "Nothing was signed with an open required or critical issue." The imported contracts have no version, so they count as executed but not reviewed: `ana risk "$Q" \| jq .parts.adherence.headline` → `notReviewed` ≥ 2. |
| 9 | Clear the type filter (**All types**). **Renewals**. | "Which notice deadlines are coming with no decision, and which were missed — so nothing renews by accident." **Undecided, next 90 days**: at least 1, counting "QA RNW Escalate later" if still undecided. **Deadlines missed** ≥ 1 "of <n> that passed in this period". **Missed and renewing on their own** ≥ 1. Charts: "Notice deadlines ahead, undecided" (Next 30 days / 31 to 60 days / 61 to 90 days) and "Deadlines that passed" (Decided in time / Missed). |
| 10 | `ana renewals "from=$(day -60)" \| jq .parts.renewals.headline` | `{upcoming, deadlinesPassed, missed, missedAutoRenewing}`. "QA RNW Late" (`$RN_5`: decided and notice sent after its deadline) is missed. "QA RNW Gone Lapse" (notice sent in time) is not. "QA RNW Gone Auto" (never decided) is missed and auto-renewing. E2E-ANA-02 lists which contracts are behind each bar. |
| 11 | **AI suggestions** (after §4's E2E-CHG-02 and E2E-SUG-04, which log suggestion outcomes). `ana ai "$Q" \| jq '.parts.acceptance \| {available, headline, features: [.charts.byFeature[] \| {label, value, n, extra}]}'` | "How often people take what the AI suggests, by feature — where it earns trust and which prompts to tune." A figure **Accepted** (a percentage) with "<accepted> of <shown> shown", and the chart **Acceptance by feature** ("Which features to trust more, and which to improve.") with bars such as "Counter-proposal" and "Ask AI", each detailed "<n> shown · <pct> edited after". API: `available` true, `headline` `{shown, accepted, rate}` equal to the counts in `ai_suggestion_events` for org A in the window (`sql "SELECT feature, outcome, count(*) FROM ai_suggestion_events WHERE \"orgId\"='$ORG_A' GROUP BY 1,2"`). With no events in the window the figures are 0 and the chart is empty; the grey "Suggestion outcomes aren’t recorded yet" note no longer appears. |

**Also check**
- **Only contracts I own** adds `ownerId=<me>` to every section's query. As admin-a with it ticked, Speed for PARTNERSHIP shows **Executed** "0", because counsel-a owns them.
- Every period choice re-reads every section (one request per section). Hover a bar: the tooltip reads "<value> · <n> contract(s)", plus the extra figures, such as "p90 38 d".
- "Portfolio at a glance" keeps its own "Last 90 days" window, separate from the section filters.
- A template whose contracts take one counterparty turn reads "· 1 turn" on its bar, not "1 turns" (a3f5348).

**Known limits**
- Cycle time starts at the contract's creation. A request raised before the contract is not counted.
- The AI section counts only what the workspace logs (E2E-SUG-04): **Copy** is not an outcome, and "edited" is
  worked out only for wording inserted as a tracked change and saved from the workspace.
- Imported (bulk) contracts never get an `executedAt` when imported as executed, so they are left out of cycle time unless executed in the product.

### E2E-ANA-02 · Each bar opens its contracts in the contract list, and each section downloads as CSV

**Covers:** /analytics (bar click, the link list under each chart, **CSV**) · `GET /analytics/drilldown` · `GET /analytics/:section?format=csv` · /contracts (`?drill=&drillKey=&drillLabel=&dq=`, chip "Analytics: …") · `GET /contracts?ids=`
**Roles:** counsel-a · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- E2E-ANA-01 done (`$AO1`, `$AT_2`, `$AT_3`, `$Q`).

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | On /analytics with type PARTNERSHIP, in "Our paper vs theirs", click the bar "Their paper or uploaded" (or its link in the list under the chart). | The contract list opens at `/contracts?drill=speed.cycle.byPaper&drillKey=theirs&drillLabel=Their+paper+or+uploaded&dq=…`. It lists exactly "QA ANA Theirs 1" and "QA ANA Theirs 2 (renamed)", with a filter chip "Analytics: Their paper or uploaded". |
| 2 | Type `Theirs 1` in the list's search. | Only "QA ANA Theirs 1": a search inside a drill-down searches its contracts only. Clear the search. |
| 3 | Remove the chip (×). | The full list returns, and `drill`, `drillKey`, `drillLabel` and `dq` leave the URL. |
| 4 | The API: `curl -s "$API/analytics/drilldown?metric=speed.cycle.byPaper&key=theirs&$Q" -H "Authorization: Bearer $COUNSEL_A" \| jq '{metric, key, label, total, n: (.ids\|length)}'`, and check the ids are `$AT_2` and `$AT_3`. | `{"metric":"speed.cycle.byPaper","key":"theirs","label":"Their paper or uploaded","total":2,"n":2}`. |
| 5 | Renewals: `curl -s "$API/analytics/drilldown?metric=renewals.renewals.outcome&key=missed&from=$(day -60)" -H "Authorization: Bearer $COUNSEL_A" \| jq -r '.ids[]' \| while read id; do cget $id \| jq -r .title; done` | The list includes "QA RNW Late", "QA RNW Gone Auto" and "QA RNW Gone Unsent", and not "QA RNW Gone Lapse" or "QA RNW Gone End". Clicking the **Missed** bar on the page opens the same contracts. |
| 6 | The step 4 call with (a) `metric=speed.nope.byType&key=x`, (b) `metric=speed.cycle.byType` and no `key`, (c) `metric=speed.cycle.byType&key=NOT_A_TYPE`. | (a) `404` "No chart speed.nope.byType". (b) `400` "metric and key are required". (c) `200` with `total` 0 and `ids` `[]`. A drill link to an empty bar lists no contracts, never the whole list. |
| 7 | Click **CSV** on **Speed** (type PARTNERSHIP). | The button spins, then a file `analytics-speed-<from>-to-<today>.csv` downloads. |
| 8 | Open it, or `curl -s "$API/analytics/speed?$Q&format=csv" -H "Authorization: Bearer $COUNSEL_A"`. | The header is `chart,key,label,value,n,p90Days,executed,medianCycleDays,medianTurns`. Then one row per bar: `cycle.byType,PARTNERSHIP,PARTNERSHIP,30,3,38,,,`, two `cycle.byPaper` rows, `cycle.byOwner`, and `templates.byTemplate,<TPL id>,<TPLNAME>,2,2,,1,10,0`. No contract ids. |
| 9 | Each other section's **CSV**. | Each downloads `analytics-<section>-…csv` with rows named `<part>.<chart>`: `stages.byStage`, `approvals.byApprover`, `approvals.byStep` for bottlenecks; `mine.byAge`, `mine.byHolder` for workload; `renewals.upcoming` and `renewals.outcome` for renewals. The AI CSV has the header only. |

**Also check**
- A label beginning with `=`, `+`, `-` or `@` is written with a leading `'` in the CSV, so a spreadsheet doesn't run it as a formula. Try it with a counterparty named `=QA Formula Co` on a contract a counterparty has turns on.
- A drill-down caps at 300 ids (`total` says how many there were). Only the first 300 open in the list.
- The drill link carries the section's filters in `dq`, separately from the list's own filters, so the list's type filter doesn't mix with it.

**Known limits**
- The CSV is the section's bars, not its contracts. To export the contracts behind a bar, drill into it and use the contract list's export.

### E2E-ANA-03 · Analytics counts only what the viewer may see: own scope, team workload for Legal Ops, never another org

**Covers:** `GET /analytics/{section}` and `GET /analytics/drilldown` as each role · `configure:workflow` (team workload) · own scope (`portfolioWhere`) · diligence rooms left out · `view:contract` requirement
**Roles:** legalops-a, admin-a, counsel-a, viewer-a, rep-a, admin-b · **Needs:** nothing extra · **Time:** ~15 min

**Preconditions**
- E2E-ANA-01 done.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `ana workload "" $LEGALOPS_A \| jq '.parts \| keys'`, the same as admin-a, then as counsel-a. | `["mine","team"]` for legalops-a and admin-a. `["mine"]` for counsel-a. |
| 2 | As legalops-a open `$WEB/analytics` → **Workload**. | A third figure, **Team in flight**, with "<n> over 2 weeks", and two more charts: "Team work in flight, by who has it" (people by name, or **Counterparty**, **Approvers**, **Signers** when it is their turn; AO2 under **Approvers**) and "Team work in flight, by age". |
| 3 | viewer-a: `ana speed "$Q" $VIEWER_A \| jq .parts.cycle.headline.executed`, and the page. | `3`: every role with `view:contract` sees the org's figures. viewer-a's page looks like counsel-a's. |
| 4 | rep-a: `ana speed "$Q" $REP_A \| jq .parts.cycle.headline`, and `curl -s "$API/analytics/drilldown?metric=speed.cycle.byPaper&key=theirs&$Q" -H "Authorization: Bearer $REP_A" \| jq .total`. | `executed` 0, and `total` 0: rep-a counts only contracts rep-a owns. With `&ownerId=$COUNSEL_A_ID` added, still 0: an own-scope caller can't widen it. |
| 5 | admin-b: every section, and the drill-down for `theirs` with `type=PARTNERSHIP`. | No Org A contract is counted or listed. `executed` 0 and `ids` `[]`. |
| 6 | A diligence room's documents (docs/40 §6 diligence journeys): note `ana bottlenecks "from=$(day -1)" | jq "[.parts.stages.charts.byStage[].n] | add"`, upload a document into a room, and repeat. | The same number: a target company's contracts are not the org's portfolio, so no section counts them. |

**Also check**
- A custom role with no `view:contract` (Admin → Roles): every `/analytics/<section>` and `/analytics/drilldown` → `403` "Missing permission: view:contract".
- The sidebar shows **Analytics** to every role. The page loads for all of them.

**Known limits**
- Workload's "Needs my action" is always the caller's own, even for Legal Ops. There is no way to see one other person's queue except through the team chart's bar for them.

---

## 6. Integrations: Salesforce, single sign-on, SCIM and REST hooks

This section tests docs/41 Parts 17 and 20, `docs/42-ZAPIER-REST-HOOKS.md`, `docs/43-SSO-AND-SCIM.md` and
`integrations/salesforce/README.md`. Everything is under **Admin → Integrations** (`/admin/integrations`). Its tabs are
**API Keys**, **Webhooks**, **Slack**, **Salesforce**, **Single sign-on** and **Health**.

**Salesforce** has two halves. The draftLegal side (`apps/api/src/routes/salesforce.ts`, `lib/salesforce/*`, the
`integration-sync` worker) connects by OAuth with PKCE. It syncs each contract out to a `DL_Contract__c` record. It also
takes requests and deal changes in from Salesforce, through an API key with the `salesforce` scope plus the
`X-Salesforce-Org-Id` header. The Salesforce side is an SFDX package. A full test needs a Salesforce **Developer
Edition** org, which is free (E2E-SF-01, E2E-SF-03). Without one, E2E-SF-02, -04 and -05 test every draftLegal route
against a stand-in connection row.

**SSO** is OIDC sign-in by email domain. **SCIM 2.0** provisions users and groups. **REST hooks** let Zapier or Make
subscribe to events. That includes `contract.stage_changed` and `contract.turn_changed` from §3.

Codes: **E2E-SF**, **E2E-SSO**, **E2E-HOOK**. docs/40 §8 (E2E-INT-01 to -06) covers API keys, webhooks and the Health tab
in general. Run it first: it sets up the local webhook receiver (**command R**) and `WEBHOOK_ALLOW_PRIVATE_URLS=true`.

### Before you start: section 6 setup

- Section 3's setup is pasted in the same shell: the docs/40 §5 helpers (`mk`, `submit`, `qstep`, `notes`, `sql`, …)
  and section 3's own (`stage`, `move`, `dec`, …). E2E-SF-03 and -05 use them, and E2E-SF-05 reuses `$C1` from
  E2E-LIF-01.

Then paste these:

```bash
# ── Section 6 helpers ─────────────────────────────────────────────────
SFA=$API/admin/integrations/salesforce          # admin routes (configure:organization, a signed-in admin)
SFP=$API/integrations/salesforce                # what Salesforce calls (API key + X-Salesforce-Org-Id)
SF_ORG=00DQA0000000001AAA                       # the stand-in Salesforce org id (18 characters)
# key <name> <scope,scope> → a new API key's full value (shown once)
key() { curl -s -X POST $API/admin/integrations/api-keys -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' \
  -d "$(jq -nc --arg n "$1" --arg s "$2" '{name:$n, scopes:($s|split(","))}')" | jq -r .key; }
# sfc <METHOD> <path> [json] → call a Salesforce route as Salesforce does
sfc() { curl -s -w '  HTTP %{http_code}\n' -X "$1" "$SFP$2" -H "Authorization: Bearer $KEY_SF" -H "X-Salesforce-Org-Id: $SF_ORG" \
  -H 'content-type: application/json' ${3:+-d "$3"}; }
# the stand-in connection (local database only): connected, no tokens. Inbound calls work; outbound sync cannot.
sf_fake() { sql "insert into integration_connections (id, \"orgId\", provider, status, \"externalOrgId\", \"instanceUrl\", \"loginUrl\", config, \"connectedAt\", \"updatedAt\")
  values ('qa-sf-fake', '$ORG_A', 'salesforce', 'connected', '$SF_ORG', 'https://qa-fake.my.salesforce.com', 'https://login.salesforce.com', '{\"selfServeTypes\":[\"NDA\"]}', now(), now())
  on conflict (\"orgId\", provider) do update set status='connected', \"externalOrgId\"='$SF_ORG', config='{\"selfServeTypes\":[\"NDA\"]}'"; }
sf_unfake() { sql "delete from integration_connections where \"orgId\"='$ORG_A' and provider='salesforce'"; }
```

- Do not use `sf_fake` when a real org is connected (E2E-SF-01); it replaces that connection's org id.
- Salesforce app settings on the API: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` (and the existing
  `AI_KEY_ENCRYPTION_KEY`). E2E-SF-02 starts **without** them, then sets them to dummy values.

### E2E-SF-01 · An admin connects a Salesforce developer org and installs the draftLegal package there

**Covers:** /admin/integrations?tab=salesforce · `GET /admin/integrations/salesforce` · `POST /admin/integrations/salesforce/connect` · `GET /integrations/salesforce/oauth/callback` · `GET …/objects`, `GET …/objects/:name/fields` · `PATCH …/settings` · `DELETE /admin/integrations/salesforce` · SalesforceSection · integrations/salesforce (SFDX package: DL_Contract__c, DL_Request__c, DraftLegalApi, DraftLegalRequestAction, DraftLegalChangeAction, dlNewContract, dlContractStatus, dlDocumentPreview, permission sets) · regressions 17 (Salesforce) and 20 (Integrations)
**Roles:** admin-a, a Salesforce admin (you) · **Needs:** a Salesforce Developer Edition org (sign up free at developer.salesforce.com), the Salesforce CLI (`sf`), a public HTTPS address for the local API (e.g. `ngrok http 3001`) · **Time:** ~60 min the first time

**Preconditions**
- A public URL for the API, e.g. `https://<id>.ngrok-free.app`, forwarding to `localhost:3001`. In `.env`:
  `API_PUBLIC_URL=https://<id>.ngrok-free.app` (the callback and SCIM URLs use it). Restart the API.
- In the developer org: **Setup → App Manager → New Connected App** (or External Client App). Enable OAuth; callback
  `https://<id>.ngrok-free.app/api/v1/integrations/salesforce/oauth/callback`; scopes **Manage user data via APIs
  (api)** and **Perform requests at any time (refresh_token, offline_access)**; tick **Require Proof Key for Code
  Exchange (PKCE)**; refresh token policy **valid until revoked**. Copy the consumer key and secret into `.env` as
  `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET`. Restart the API (it runs the sync worker too).
- `sf org login web --alias qa-dev` signed in to the developer org.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | admin-a: Admin → **Integrations** → tab **Salesforce**. | Card **Connect Salesforce** with radios **Production**, **Sandbox**, **My Domain** (placeholder "https://yourcompany.my.salesforce.com"), "Callback URL for the connected app:" showing the ngrok callback, and **Connect Salesforce**. |
| 2 | Keep **Production**, click **Connect Salesforce**. | The button reads "Opening Salesforce…", then the browser goes to `login.salesforce.com` with `code_challenge`, `code_challenge_method=S256`, `state` and `prompt=login consent` in the URL. |
| 3 | Sign in as the developer org's admin and **Allow**. | Back on `$WEB/admin/integrations?tab=salesforce&connected=1`: a banner "Salesforce is connected. Map the fields below, then install the package in Salesforce." Card **Salesforce connected** with **Salesforce org** (00D…), **Instance**, **Connected**, **Last sync** "never", the line "Contracts update their Salesforce record within a minute of each change.", **Sync all now** and **Disconnect**. |
| 4 | `curl -s $SFA -H "Authorization: Bearer $ADMIN_A" \| jq '{status, externalOrgId, instanceUrl, appConfigured, callbackUrl, selfServeTypes}'` | `status` "connected", the 00D id, the instance URL, `appConfigured` true, `selfServeTypes` ["NDA"]. No token appears in any field. |
| 5 | Section **Generate straight from Salesforce**. | The list holds `NDA` (the default). Click **Save** without changing it: "Saved". These types are drafted at once from Salesforce; every other type goes to Legal as a request. |
| 6 | Deploy the package: `cd integrations/salesforce && sf project deploy start --source-dir force-app --target-org qa-dev` | Deploy succeeds (API 61.0+). Then `sf apex run test --class-names DraftLegalApiTest --target-org qa-dev` → all pass. |
| 7 | Create the key Salesforce will use: Admin → Integrations → **API Keys** → new key "Salesforce", scope **salesforce**. Copy it. | The full key is shown once (docs/40 E2E-INT-02). |
| 8 | In Salesforce Setup: **Named Credentials → draftLegal**: URL `https://<id>.ngrok-free.app`. **External Credentials → draftLegal → Principal ApiKeyPrincipal**: add parameter **ApiKey** = the key. **CSP Trusted Sites → draftLegal**: the same URL. Assign permission set **draftLegal Integration** to yourself (the integration user) and **draftLegal User** to a rep user (or yourself). | Saved. |
| 9 | Lightning App Builder: add **draftLegal: New contract** to the Opportunity record page; add **draftLegal: Contract status** and **draftLegal: Document preview** to the draftLegal Contract record page; add the *draftLegal Contracts* related list to Opportunity and Account. | The components are listed under Custom and save onto the pages. |
| 10 | Open an Opportunity (e.g. a demo one with Amount set). | The **draftLegal: New contract** form lists draftLegal's contract types and, for the chosen type, the fields of the field map (E2E-SF-03 makes the map). |

**Also check**
- The other workspace: admin-b connects the **same** developer org → back with "Salesforce wasn't connected: That
  Salesforce org is already connected to another draftLegal workspace."
- **Disconnect** → dialog **Disconnect Salesforce?** → **Disconnect Salesforce**: the card goes back to **Connect
  Salesforce**; `curl -s $SFA …` → `status` "disconnected"; the tokens are wiped and revoked at Salesforce (the
  developer org's **Connected Apps OAuth Usage** no longer lists the session). Connect again for E2E-SF-03.
- The admin routes refuse a non-admin: `curl -s -w '%{http_code}\n' $SFA -H "Authorization: Bearer $COUNSEL_A"` → `403`
  "Missing permission: configure:organization". `POST $SFA/connect` with an API key (even `admin` scope) is refused: only
  a signed-in admin connects.
- Revoke the session in Salesforce (Setup → Connected Apps OAuth Usage → Revoke). The next sync fails, and the card reads
  **Salesforce needs reconnecting**, with the connection's last error "Salesforce no longer accepts this connection.
  Reconnect it in Settings → Integrations." The card's footer reads "Contracts update their Salesforce record within a
  minute of each change. To connect a different Salesforce org, disconnect this one first." and offers **Sign in
  again**. Click it and sign in to the **same** developer org: back with `connected=1`, status "connected", same 00D id.
- One org per workspace (regression 17, Salesforce): click **Sign in again** and sign in to a **different** developer
  org. Back with "Salesforce wasn't connected: You signed in to a different Salesforce org than the one connected
  (00D…). To switch orgs, disconnect Salesforce first, then connect the other org." `curl -s $SFA …` still shows the
  first org's id. Only after **Disconnect** does the other org connect, and the first org's open conflicts are then
  dismissed (`status` "dismissed" in `integration_conflicts`).

**Known limits**
- The package has no namespace or managed package yet (README "Not done yet"). CPQ line items and messages both ways
  are not built.
- LWC Jest tests are not set up; the components are checked by hand here.

### E2E-SF-02 · Without a Salesforce org: the connect flow's state is signed, single-use and checked

**Covers:** `POST /admin/integrations/salesforce/connect` · `GET /integrations/salesforce/oauth/callback` · `DELETE /admin/integrations/salesforce` · `PATCH …/settings` · `PUT …/mappings` · `lib/integrations/signed-token.ts` · `lib/salesforce/oauth.ts`
**Roles:** admin-a, counsel-a · **Needs:** nothing extra (no Salesforce org) · **Time:** ~15 min

**Preconditions**
- No Salesforce connection for Org A (`sf_unfake`), and `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` **not** set.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Admin → Integrations → **Salesforce**. | **Connect Salesforce** with the line "This server has no Salesforce app yet. Your operator sets SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET (see integrations/salesforce/README.md)." |
| 2 | `curl -s -w '  HTTP %{http_code}\n' -X POST $SFA/connect -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{}'` | `503` `{"detail":"Salesforce is not set up on this server yet (SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET)."}` |
| 3 | Set dummy values in `.env` (`SALESFORCE_CLIENT_ID=qa-dummy`, `SALESFORCE_CLIENT_SECRET=qa-dummy`), restart the API, and call connect again. Save the answer: `URL=$(curl -s -X POST $SFA/connect -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{}' \| jq -r .url); echo "$URL"` | A `https://login.salesforce.com/services/oauth2/authorize?…` URL with `response_type=code`, `client_id=qa-dummy`, `redirect_uri=…/api/v1/integrations/salesforce/oauth/callback`, `scope=api+refresh_token+offline_access`, `code_challenge`, `code_challenge_method=S256`, `prompt=login consent` and `state`. |
| 4 | `-d '{"loginUrl":"https://evil.example.com"}'` | `400` "Use login.salesforce.com, test.salesforce.com or your My Domain (https://<name>.my.salesforce.com)." `{"sandbox":true}` gives a `test.salesforce.com` URL. |
| 5 | A changed state: `curl -s -o /dev/null -w '%{redirect_url}\n' "$API/integrations/salesforce/oauth/callback?code=x&state=tampered.value"` | A redirect to `$WEB/admin/integrations?tab=salesforce&error=The+sign-in+link+expired+or+was+changed.+Start+again+from+Connect.` Opened in the browser: "Salesforce wasn't connected: The sign-in link expired or was changed. Start again from Connect." |
| 6 | The real state, with Salesforce saying no: `S=$(echo "$URL" \| sed 's/.*[?&]state=\([^&]*\).*/\1/'); curl -s -o /dev/null -w '%{redirect_url}\n' "$API/integrations/salesforce/oauth/callback?state=$S&error=access_denied&error_description=end-user+denied+authorization"` | Redirect with `error=end-user+denied+authorization`. |
| 7 | The same state again (`…?state=$S&code=abc`). | Redirect with "This sign-in was already used. Start again from Connect.": the PKCE verifier went with the first callback. |
| 8 | A fresh state with a code (`URL` again, then `…?state=<new>&code=abc`). | Redirect with "Salesforce refused the sign-in. Try again." (the dummy app can't exchange the code). Nothing is stored: `curl -s $SFA … \| jq .status` → null or "disconnected". |
| 9 | Wait 11 minutes and use a fresh, unused state. | "The sign-in link expired or was changed. Start again from Connect." (state lives 10 minutes). |
| 10 | Routes that need a connection: `curl -s -X DELETE $SFA -H "Authorization: Bearer $ADMIN_A"`, `curl -s -X PATCH $SFA/settings -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"selfServeTypes":["NDA"]}'`, `curl -s $SFA/objects -H "Authorization: Bearer $ADMIN_A"` | `404` "Salesforce is not connected" · `404` "Connect Salesforce first" · `409` "Connect Salesforce first". |
| 11 | A connected workspace can't start a second connection. Keep the dummy values, run `sf_fake`, then step 3's call again: `curl -s -w '  HTTP %{http_code}\n' -X POST $SFA/connect -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{}'` | `409` `{"detail":"Salesforce is already connected (org 00DQA0000000001AAA). To connect a different Salesforce org, disconnect this one first."}` |
| 12 | The same with `-d '{"reconnect":true}'` (what **Sign in again** sends). | `200` with a `url` to Salesforce: signing in again to the same org is allowed. Run `sf_unfake` afterwards. |

**Also check**
- counsel-a: `POST $SFA/connect` → `403` "Missing permission: configure:organization".
- A state signed for another purpose (e.g. an embed token from E2E-SF-05 pasted as `state`) is refused like step 5.
- Remove the dummy values and restart when done, or keep them for E2E-SF-04 (inbound calls don't need them).

**Known limits**
- The redirect carries the error text in the URL; it is shown on the page as text.

### E2E-SF-03 · The field map is edited from the org's own fields, and each contract's stage and turn reach its Salesforce record, with a sync log, retry and health

**Covers:** /admin/integrations?tab=salesforce (Field map, Sync log) · /admin/integrations?tab=health · `GET/PUT /admin/integrations/salesforce/mappings` · `GET …/targets` · `GET …/sync-log` · `POST …/sync-log/:id/retry` · `POST …/sync-now` · `GET /admin/integrations/health` · integration-sync worker (queue `integration-sync`, job `contract`, nightly `reconcile` 03:30) · `lib/salesforce/payload.ts` · DL_Contract__c · dlContractStatus
**Roles:** admin-a, contracts-a, counsel-a · **Needs:** E2E-SF-01 done (a connected developer org) · **Time:** ~30 min

**Preconditions**
- E2E-SF-01 done; the connection is **Salesforce connected**.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | Salesforce tab → **Field map**. | Columns **Contract type** (placeholder "All types"), **Salesforce object**, **Salesforce field**, **draftLegal field**, **Direction**, **Read-only**. With nothing mapped: "No fields mapped yet. Opportunity Amount → Contract value is a good first one." |
| 2 | **Add field**: object Opportunity, field Amount (listed from the org's own fields), draftLegal field **Contract value**, Direction **Both ways**. Add a second row: Account · Name → Counterparty, **From Salesforce**, tick **Read-only**. **Save field map**. | "Saving…", then "Saved". `curl -s $SFA/mappings -H "Authorization: Bearer $ADMIN_A" \| jq '[.data[] \| {externalObject, externalField, dlField, direction, locked}]'` shows both. The draftLegal field list also offers **A template variable…** (stored as `var:<name>`). |
| 3 | Map Amount → Contract value a second time (same direction) and save. | "Could not save the field map." with the server's `400` "value is mapped twice." |
| 4 | contracts-a: `SY=$(mk "$CONTRACTS_A" "QA SF sync" SOW 20000)`. Wait about a minute. | Sync log: a row "QA SF sync", **Result** "Synced", **Open contract**. In Salesforce: a **draftLegal Contract** record "QA SF sync" with Stage **Draft**, Waiting On "Legal (Casey Contracts)", Contract Value 20,000, Open in draftLegal (a link to `$WEB/contracts/$SY`). |
| 5 | Move it: `move "$CONTRACTS_A" $SY negotiate with_counterparty`. | Within a minute the record shows Stage **Negotiate**, Waiting On "Counterparty" (or "Counterparty (<name>)"), Waiting Since today. One new sync row (several changes within 5 seconds are sent once). |
| 6 | `submit "$CONTRACTS_A" $SY` | Stage **Approve**, Waiting On starting "Approvers" and ending "(0 of 1)", Approvals "0 of 1". |
| 7 | counsel-a returns it with a reason (`qstep "$COUNSEL_A" $SY; dec "$COUNSEL_A" $INST $STEP RETURNED "QA fix fees"`). | Stage **Negotiate**, Waiting On "Legal (Casey Contracts): fix and resubmit". The draftLegal Contract page's **draftLegal: Contract status** component shows the stage path and Waiting on. |
| 8 | Click **Sync all now**. | "Sync queued". Rows whose payload didn't change are logged **No change**. |
| 9 | Make a sync fail: in Salesforce, remove the integration user's edit access to the DL_Stage__c field (Field-Level Security), then move the contract again. | A **Failed** row with Salesforce's message in **Detail** (and "attempt N" from the second attempt). **Failed only** filters to it. |
| 10 | Restore the field access and click **Retry** on the failed row. | `{ok:true, message:"Retry queued"}` (`POST $SFA/sync-log/<id>/retry`), then a **Synced** row. |
| 11 | Tab **Health**. | A Salesforce row: badge **Healthy** (or **Degraded** while failures are recent), **Last sync**, "N synced · N failed · N waiting on you" for 24 h, **Last error**, and **Retry**. |
| 12 | Execute a contract (approve, send and sign it as in E2E-LIF-01). | Stage **Signed**; the signed PDF is filed on the record (and the Opportunity, when linked) once. |

**Also check**
- Retry refusals: an unknown id → `404` "Sync not found"; an inbound row → `400` "Only a sync to Salesforce can be retried here".
- Mapping validation: `PUT $SFA/mappings` with `"dlField":"nonsense"` → `400` "Not a draftLegal field: pick one from the list,
  or var:<name> for a template variable".
- Health with the connection revoked: **Failing**, and the card **Salesforce needs reconnecting**.
- The nightly reconcile (03:30) repairs drift: delete a DL_Contract__c record in Salesforce, then `POST $SFA/sync-now`; the
  record is recreated.
- Contract stage values on the record: Request, Draft, Review (Draft · Ready), Negotiate, Approve, Sign, Signed, Closed.

**Known limits**
- A stand-in connection (`sf_fake`) has no tokens: the sync worker stops with "Salesforce is not connected" in the API log
  and writes no sync-log row. Outbound sync can only be tested with a real org.
- CPQ quote lines are not synced (README "Not done yet").

### E2E-SF-04 · Salesforce starts a request through its own key and org id; self-serve types are drafted at once

**Covers:** `GET /integrations/salesforce/launch-form` · `POST /integrations/salesforce/requests` · `GET /integrations/salesforce/contracts/:id/status` · `POST /requests/:id/convert` (generate now) · `PATCH /admin/integrations/salesforce/settings` · `salesforceCaller` · `lib/salesforce/inbound.ts createRequestFromSalesforce` · /requests
**Roles:** admin-a, rep-a, counsel-a, admin-b · **Needs:** nothing extra (a stand-in connection); with a real org, the same calls come from **draftLegal: New contract** · **Time:** ~20 min

**Preconditions**
- Section 6 setup. No real org connected; `sf_fake`.
- Keys: `export KEY_SF=$(key "QA Salesforce" salesforce) KEY_REQ=$(key "QA requests only" requests:write)`.
- A field map: `curl -s -X PUT $SFA/mappings -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"mappings":[{"externalObject":"Opportunity","externalField":"Amount","dlField":"value","direction":"both"}]}'`

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `sfc GET "/launch-form?contractType=MSA"` | `200`: the form for MSA, built from the field map (Opportunity Amount → Contract value). |
| 2 | `sfc POST /requests '{"contractType":"MSA","records":{"Opportunity":{"Id":"006QA0000000001AAA","Name":"Acme expansion","Amount":40000,"CloseDate":"2026-12-01"},"Account":{"Id":"001QA0000000001AAA","Name":"QA Acme Corp"}},"requestedBy":{"email":"sales@demo.com"}}'` | `201` `{requestId, requestNumber:"REQ-…", deepLink:"$WEB/requests?request=<id>", counterpartyId, prefilled:[…value…], issues:[]}`. Save `requestId` as `$SFREQ`. |
| 3 | rep-a opens **Requests** (or the deep link). | The request "MSA — QA Acme Corp", raised by rep-a (sales@demo.com is a member, so rep-a is the requester), source Salesforce, estimated value 40,000. **Counterparties** lists "QA Acme Corp" (made from the Account, its `crmId` the Account id). |
| 4 | Generate now for a type that isn't self-serve: the same body with `"generateNow":true`. | `201` with `generateRefused` "MSA goes to Legal: it can't be generated straight from Salesforce." and no `contractId`. |
| 5 | Generate now for NDA: `sfc POST /requests '{"contractType":"NDA","records":{"Account":{"Id":"001QA0000000002AAA","Name":"QA Initrode"}},"generateNow":true}'` | `201` with `contractId` and `contractLink` ("$WEB/contracts/<id>"). The request is accepted; the contract exists at once. Its text is drafted in the background from the default NDA template (the governing-law choice is left open, as in docs/41 P0.4). |
| 6 | `sfc GET /contracts/<contractId>/status` | The contract's stage, state, turn and approvals as the Salesforce status component reads them. |
| 7 | Make MSA self-serve: `curl -s -X PATCH $SFA/settings -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"selfServeTypes":["NDA","MSA"]}'` and repeat step 4. | `{ok:true}`; now step 4 returns a `contractId`. Put it back to `["NDA"]`. |

**Also check** — the gate, in the order the API checks it:
- A person's token: `curl -s $SFP/launch-form -H "Authorization: Bearer $ADMIN_A"` → `403` "This endpoint is for Salesforce, through an API key with the salesforce scope".
- A key without the scope: `curl -s -X POST $SFP/requests -H "Authorization: Bearer $KEY_REQ" -H "X-Salesforce-Org-Id: $SF_ORG" -H 'content-type: application/json' -d '{"contractType":"NDA"}'` → `403` "This API key lacks the salesforce scope".
- No header, or another org: `-H "X-Salesforce-Org-Id: 00DOTHER000000001AA"` → `403` "This Salesforce org is not the one connected to this workspace". The 15-character form of the right id (`00DQA0000000001`) is accepted.
- Not connected (`sf_unfake`): `409` "Salesforce is not connected to this draftLegal workspace". Run `sf_fake` again.
- Body checks: `{}` → `400` "Invalid request" with `issues`. A key from Org B with Org A's org id → `409` (Org B is not connected) — never Org A's data.
- The key can do nothing else: `curl -s $API/contracts -H "Authorization: Bearer $KEY_SF"` is allowed only as far as `view:contract`; `DELETE` or approvals → `403`.
- Audit: `REQUEST_CREATED` with `metadata.source` "salesforce" and the Opportunity id.

**Known limits**
- A rep whose email is not a member is recorded on the request (`requestedBy`) but the request is raised by the key's maker.

### E2E-SF-05 · After signing, a Salesforce change waits for the owner's decision; a rep previews the document through a 10-minute link

**Covers:** `POST /integrations/salesforce/changes` · `GET /admin/integrations/salesforce/conflicts` · `POST …/conflicts/:id/resolve` · `GET /contracts/:id/integration-conflicts` · `POST /contracts/:id/integration-conflicts/:conflictId/resolve` · `POST /integrations/salesforce/embed-token` · `GET /embed/contracts/:id?token=` · /embed/contracts/:id (EmbedContractPage) · /contracts/:id and /contracts/:id/workspace (rail and Details → **Salesforce changes**, SalesforceConflictsSection) · IntegrationConflict · notification.worker
**Roles:** admin-a, contracts-a, counsel-a · **Needs:** E2E-SF-04 preconditions (stand-in connection, `$KEY_SF`, the Amount → value map); `$C1` from E2E-LIF-01 (Active, or Archived if you ran E2E-LIF-02's "Also check"; both are frozen; owned by contracts-a) · **Time:** ~20 min

**Preconditions**
- Link two contracts to one Opportunity (what a contract made from Salesforce carries):

```bash
K1=$(mk "$CONTRACTS_A" "QA SF draft deal" SOW 40000)
for c in $K1 $C1; do sql "update contracts set metadata = coalesce(metadata,'{}'::jsonb) || '{\"salesforce\":{\"opportunityId\":\"006QA0000000009AAA\"}}'::jsonb where id='$c'"; done
curl -s -o /dev/null -X PATCH $API/contracts/$C1 -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"value":40000}'
```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `sfc POST /changes '{"object":"Opportunity","record":{"Id":"006QA0000000009AAA","Amount":45000}}'` | `200` `{contracts:[{contractId:$K1, written:["value"], conflicts:[]…}, {contractId:$C1, written:[], conflicts:["value"]…}], requests:[…]}`. |
| 2 | `curl -s $API/contracts/$K1 -H "Authorization: Bearer $ADMIN_A" \| jq .value` and the same for `$C1`. | `$K1`: 45000 (a draft follows Salesforce). `$C1`: still 40000 (signed: never written). |
| 3 | `notes "$CONTRACTS_A"` | `type` "INTEGRATION_CONFLICT", `title` "Salesforce changed Contract value: 40,000 → 45,000 — update contract?", `body` `"QA LIF banner" is out for signature or signed, so the change was not written. Open the contract to apply it or keep the contract as it is.` |
| 4 | Admin → Integrations → Salesforce. | Section **Salesforce changes waiting on you** with the conflict, **Update contract** and **Keep contract**. Sync log: an inbound row with **Result** "Needs a decision". |
| 5 | Send the same change again with Amount 47000. | Still one open conflict for the field, now 40,000 → 47,000 (a newer change replaces the pending one). |
| 6 | Note the conflict's id: `KID=$(curl -s $API/contracts/$C1/integration-conflicts -H "Authorization: Bearer $CONTRACTS_A" \| jq -r '.data[0].id')`. Browser (contracts-a) on `$WEB/contracts/$C1`. Read the rail; then open the workspace's **Details** tab. | A rail section **Salesforce changes** (count 1), "The deal changed in Salesforce after this contract went out, so the contract was left as it is.", and the item "Salesforce changed contract value 40,000 → 47,000" with **Apply** and **Dismiss**. The workspace's Details shows the same section. A contract with no open change shows no section. |
| 7 | Click **Apply**. | Toast "Contract updated from Salesforce"; the section goes away. `$C1` value is 47000, recorded as contracts-a's own edit. The conflict leaves the admin list. |
| 8 | Resolve it again by API: `curl -s -X POST $API/contracts/$C1/integration-conflicts/$KID/resolve -H "Authorization: Bearer $CONTRACTS_A" -H 'content-type: application/json' -d '{"action":"apply"}'` | `400` "This change was already decided". |
| 9 | A second conflict (Amount 50000). On the contract's rail click **Dismiss**; make a third (Amount 52000) and use **Keep contract** in the admin list. | **Dismiss**: toast "Kept the contract as it is". Both end `dismissed`; the value stays 47000. Audit `INTEGRATION_CONFLICT_RESOLVED` on the contract with `field` "value", `decision` "dismiss", `from` and `to`. |
| 10 | Preview link: `sfc POST /embed-token "{\"contractId\":\"$C1\"}"` | `{url:"$WEB/embed/contracts/$C1?token=…", expiresAt:<10 minutes from now>}`. |
| 11 | Open the `url` in a private window (signed out). | The contract's current document, a header line including "Read-only", no app rail and no sign-in. A contract with no document shows "This contract has no document yet." |
| 12 | Change one character of the token, or open it after 10 minutes. | "Preview unavailable". The API: `curl -s -w '%{http_code}\n' "$API/embed/contracts/$C1?token=bad"` → `401` "This preview link is invalid or has expired. Open it again from Salesforce."; the response has `cache-control: no-store`. |

**Also check**
- The link names one contract: the token for `$C1` used with `$K1`'s id → `401`.
- `embed-token` for another org's contract id → `404` "Contract not found".
- A request not yet converted follows Salesforce changes (its prefill and estimated value update); an accepted one doesn't.
- counsel-a (no ownership needed, `edit:contract`) can resolve; viewer-a sees the rail section without **Apply** and
  **Dismiss**, and the API answers `403`. Org B → `404` "Contract not found".

**Known limits**
- The preview link can be opened by anyone who has it during its 10 minutes.

### E2E-SSO-01 · People sign in with their company's identity provider by email domain; every unsafe return is refused with a reason

**Covers:** /login (Sign in with SSO) · /login/sso (SsoCallbackPage) · /admin/integrations?tab=sso (SsoSection) · `POST /auth/sso/discover` · `GET /auth/sso/start` · `GET /auth/sso/callback` · `POST /auth/sso/exchange` · `GET/PUT/DELETE /admin/sso` · `POST /admin/sso/test` · `lib/sso/oidc.ts`
**Roles:** admin-a, admin-b, a new person (jane@qa-sso.test) · **Needs:** a test OIDC provider: locally `docker run -d --name qa-oidc -p 8080:8080 ghcr.io/navikt/mock-oauth2-server:2.1.10` (any client id and secret are accepted; its sign-in form takes a user name and a claims JSON), or a free Okta developer org · **Time:** ~30 min

**Preconditions**
- The mock provider runs: `curl -s http://localhost:8080/default/.well-known/openid-configuration | jq .issuer` → `"http://localhost:8080/default"`.
  (An `http://localhost` issuer is accepted only on a development stack. In production an `https` issuer is required.)
- With Okta instead: create an OIDC **Web** app, sign-in redirect URI as shown in step 1, scopes `openid email profile`,
  and use `https://<your-org>.okta.com` as the issuer and your Okta user's email domain.

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | admin-a: Admin → Integrations → **Single sign-on**. | Heading **Single sign-on (OIDC)**. **Sign-in redirect URI for your provider**: `http://localhost:5173/api/v1/auth/sso/callback` (from `API_PUBLIC_URL` or `FRONTEND_URL`). Fields **Issuer URL**, **Client ID**, **Client secret**, **Email domains**; **Create an account on first sign-in**, **Role for new accounts**, **Turn on single sign-on for these domains**; buttons **Test connection**, **Save**. |
| 2 | Issuer `http://localhost:8080/default`, Client ID `draftlegal-qa`, secret `qa-secret`, domains `qa-sso.test`, tick **Create an account on first sign-in**, role **VIEWER**, tick **Turn on…**. **Save**, then **Test connection**. | Saved. The test reads "Reached http://localhost:8080/default." The secret field now reads "(saved; enter a new one to replace it)". |
| 3 | Sign out. On `$WEB/login` click **Sign in with SSO**. | A panel: **Work email** (placeholder "you@company.com"), **Cancel**, **Continue**. |
| 4 | Enter `someone@nowhere.test` → **Continue**. | "Single sign-on isn't set up for nowhere.test. Sign in with your password, or ask your admin." |
| 5 | Enter `jane@qa-sso.test` → **Continue** ("Checking…"). | The browser goes to the mock provider's sign-in form. |
| 6 | On the mock's form: user `jane`, claims `{"email":"jane@qa-sso.test","email_verified":true,"name":"Jane SSO"}` → sign in. | Back on `/login/sso`: "Signing you in…", then the app, signed in as Jane SSO. No token appears in any URL (the page traded a 60-second code). |
| 7 | admin-a: Admin → Users. | "Jane SSO", jane@qa-sso.test, **Viewer**, active. |
| 8 | Sign Jane out and in again through SSO with the same claims. | Signed in; no second account. |
| 9 | Again with claims `{"email":"jane@qa-sso.test","email_verified":true}` but user `jane-other` (a different subject). | "Couldn't sign you in": "This email is linked to another identity at your provider. Contact your admin." and **Back to sign in**. |
| 10 | Again with `"email":"jane@other.test"`. | "jane@other.test is not in a domain this workspace signs in." |
| 11 | Again with `"email_verified":false`. | "Your email address is not verified at your identity provider." |
| 12 | Again with no `email` claim. | "The identity provider did not share an email address. Ask your admin to add the email scope." |
| 13 | Untick **Create an account on first sign-in**, save, and sign in as `bob` with `"email":"bob@qa-sso.test"`. | "You have no account in this workspace yet. Ask your admin to invite you." Invite bob@qa-sso.test (Admin → Users), then try again: the invited account is activated and signed in. |
| 14 | Deactivate Jane (Admin → Users), then sign in as Jane through SSO. | "Account deactivated. Contact your admin." Reactivate her. |
| 15 | Untick **Turn on…** and save; try Jane again. | Step 4's message for qa-sso.test (no enabled connection for the domain). Password sign-in still works for everyone throughout. |

**Also check**
- API: `curl -s -X POST $API/auth/sso/discover -H 'content-type: application/json' -d '{"email":"jane@qa-sso.test"}'` →
  `{"sso":true,"startUrl":"…/api/v1/auth/sso/start?…"}`; `-d '{"email":"x"}'` → `400` "Enter your work email.";
  `POST $API/auth/sso/exchange` with `{"code":"nope"}` → `400` "Invalid sign-in code".
- Replay and CSRF: open the provider's redirect back to `/api/v1/auth/sso/callback?code=…&state=…` a second time →
  "This sign-in was already used. Try again."; open it in another browser (without the `clm_sso` cookie) → "This sign-in
  was started in another browser. Try again here."; after 10 minutes → "The sign-in link expired. Try again."
- One domain, one workspace: admin-b saves a connection with domain `qa-sso.test` → `409` "qa-sso.test already signs in to
  another workspace." The message names no workspace.
- Validation: issuer `http://idp.example.com` → `400` "Invalid request" with "The issuer must be an https URL"; a first save
  without a secret → `400` "Enter the client secret."; role `NOPE` → `400` "No role named NOPE".
- `POST $API/admin/sso/test` before any save → `404` "Save the connection first". **Remove** → dialog "Remove single
  sign-on?"; afterwards `DELETE $API/admin/sso` → `404` "Single sign-on is not set up".
- counsel-a: `GET $API/admin/sso` → `403` "Missing permission: configure:organization".
- A user of Org B whose email is in Org A's SSO domain is never signed in to Org A: "This account belongs to another
  workspace. Contact your admin."

**Known limits**
- OIDC only; no SAML. One connection per workspace.
- Password sign-in can't be turned off for SSO users (on purpose, so a broken provider can't lock admins out).

### E2E-SSO-02 · An identity provider creates, finds, updates, deactivates and groups users over SCIM 2.0

**Covers:** `/scim/v2/ServiceProviderConfig` · `/scim/v2/Users` (GET list+filter, GET, POST, PUT, PATCH, DELETE) · `/scim/v2/Groups` (GET, POST, PUT, PATCH, DELETE) · `POST/GET/DELETE /admin/sso/scim-tokens` · `GET/PATCH /admin/sso/scim-groups` · Single sign-on tab (User provisioning, Groups)
**Roles:** admin-a, admin-b · **Needs:** nothing extra (curl stands in for Okta or Entra ID) · **Time:** ~25 min

**Preconditions**

```bash
SCIM=http://localhost:3001/scim/v2
TOK=$(curl -s -X POST $API/admin/sso/scim-tokens -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"name":"QA Okta"}' | jq -r .token)
sc() { curl -s -w '  HTTP %{http_code}\n' -X "$1" "$SCIM$2" -H "Authorization: Bearer ${TK:-$TOK}" -H 'content-type: application/scim+json' ${3:+-d "$3"}; }
```

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | admin-a: Admin → Integrations → **Single sign-on**, section **User provisioning (SCIM)**. | **SCIM base URL** (`…/scim/v2`), the token "QA Okta" listed by its prefix, **New token**. Making one shows it once: "Copy this token now. It won't be shown again." |
| 2 | `sc GET /ServiceProviderConfig` | `200`, `content-type: application/scim+json`, patch and filter supported. |
| 3 | `sc POST /Users '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"lee@qa-scim.test","externalId":"00u1okta","name":{"givenName":"Lee","familyName":"Park"},"emails":[{"value":"lee@qa-scim.test","primary":true}],"active":true}'` | `201` `{id, userName:"lee@qa-scim.test", active:true, externalId:"00u1okta", name:{formatted:"Lee Park",…}}`. Save `id` as `$LEE`. Admin → Users lists Lee Park, active. |
| 4 | The same POST again. | `409` `{"schemas":["urn:ietf:params:scim:api:messages:2.0:Error"],"status":"409","detail":"A user with this userName already exists","scimType":"uniqueness"}` |
| 5 | `sc GET '/Users?filter=userName%20eq%20%22LEE@QA-SCIM.TEST%22'` and `…filter=externalId%20eq%20%2200u1okta%22` | `totalResults` 1 with `$LEE` both times (case does not matter). `filter=userName%20co%20%22l%22` → `400` "Only \`attribute eq "value"\` filters are supported" (`invalidFilter`). |
| 6 | Deactivate (Okta's form): `sc PATCH /Users/$LEE '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"Replace","value":{"active":"False"}}]}'` | `200`, `active` false. Admin → Users: Lee is deactivated. Lee's sessions and API keys are revoked. |
| 7 | `…"value":{"active":true}…` | Lee is active again. |
| 8 | Groups: `sc POST /Groups "{\"schemas\":[\"urn:ietf:params:scim:schemas:core:2.0:Group\"],\"displayName\":\"QA Legal Ops\",\"members\":[{\"value\":\"$LEE\"}]}"` | `201` with an `id` (`$GRP`). The **Groups** list on the Single sign-on tab shows "QA Legal Ops", 1 member, role "No role". |
| 9 | Map the group to a role: pick **LEGAL_OPS** for it on the tab, or `curl -s -X PATCH $API/admin/sso/scim-groups/$GRP -H "Authorization: Bearer $ADMIN_A" -H 'content-type: application/json' -d '{"roleName":"LEGAL_OPS"}'` | `{ok:true}`. Lee now has the Legal Ops role (granted by `scim:<group id>`). |
| 10 | Remove Lee from the group: `sc PATCH /Groups/$GRP "{\"schemas\":[\"urn:ietf:params:scim:api:messages:2.0:PatchOp\"],\"Operations\":[{\"op\":\"remove\",\"path\":\"members[value eq \\\"$LEE\\\"]\"}]}"` | Lee loses Legal Ops. A role an admin gave Lee by hand (give Viewer first) stays. |
| 11 | `sc DELETE /Users/$LEE` | `204`. Lee is deactivated, not erased; history stays. |
| 12 | Revoke the token on the tab ("Revoke QA Okta?"), then step 2. | `401` "SCIM token invalid or revoked". |

**Also check**
- No token / a non-SCIM bearer: `curl -s $SCIM/Users -H "Authorization: Bearer $ADMIN_A"` → `401` "A SCIM bearer token is required".
- An email that is already an Org A user (`viewer@qa.test`): POST links that user (no second account). An email of another
  workspace (`admin@orgb.test`) → `409` `uniqueness`.
- Org B's token (`TK=<Org B token> sc GET /Users/$LEE`) → `404` "User not found". Org B's admin listing Org A's groups sees none.
- Bad bodies: Users POST with `"userName":"not-an-email"` → `400` `invalidValue`; Groups without `displayName` → `400`
  "displayName is required"; PATCH without `Operations` array → `400` "Operations must be an array".
- Entra ID's PATCH form (`"op":"replace","path":"active","value":"False"`) works the same as step 6.
- `PATCH /admin/sso/scim-groups/<id>` with `{"roleName":"NOPE"}` → `400` "No role named NOPE".

**Known limits**
- Filters are only `attribute eq "value"` on userName, emails(.value), externalId (Users) and displayName, externalId (Groups).

### E2E-HOOK-01 · Zapier or Make subscribes with a hooks key, gets samples, and receives signed stage and turn events

**Covers:** `POST /hooks` · `GET /hooks` · `DELETE /hooks/:id` · `GET /hooks/samples/:event` · `GET /admin/integrations/events` · webhook.worker (queue `webhooks`, job `deliver`) · `lib/status-change.ts recordStageChange` · webhooks `contract.stage_changed`, `contract.turn_changed` · Admin → Integrations → Webhooks · regression 20 (Integrations)
**Roles:** admin-a, contracts-a, counsel-a · **Needs:** command R (docs/40 §8) and `WEBHOOK_ALLOW_PRIVATE_URLS=true` · **Time:** ~20 min

**Preconditions**
- Command R running on :8766; the API restarted with `WEBHOOK_ALLOW_PRIVATE_URLS=true`.
- `export KEY_HOOK=$(key "QA Zapier" hooks)`

**Steps**

| # | Do | Expect |
|---|----|--------|
| 1 | `curl -s $API/admin/integrations/events -H "Authorization: Bearer $ADMIN_A" \| jq '.events \| length, index("contract.stage_changed"), index("contract.turn_changed")'` | 17 events, including both. |
| 2 | `curl -s $API/hooks/samples/contract.stage_changed -H "Authorization: Bearer $KEY_HOOK" \| jq` | `[{"id":"sample-contract.stage_changed","event":"contract.stage_changed","timestamp":…,"data":{"contractId":"cmb1example0contract","from":{"stage":"negotiate","state":"with_us"},"to":{"stage":"approve","state":"pending"},"status":"PENDING_APPROVAL","turn":"approvers","source":"approval"}}]`. For `contract.turn_changed`: `data` `{contractId, from:"internal", to:"counterparty", stage:"negotiate", source:"send"}`. |
| 3 | Subscribe: `H1=$(curl -s -X POST $API/hooks -H "Authorization: Bearer $KEY_HOOK" -H 'content-type: application/json' -d '{"target_url":"http://127.0.0.1:8766/zap-stage","event":"contract.stage_changed"}'); echo $H1 \| jq` and the same for `contract.turn_changed` → `$H2`. | `201` `{id, event, target_url, name:"Zapier: contract.stage_changed", secret:"whsec_…", createdAt}`. Admin → Integrations → **Webhooks** lists both like any webhook (pause, delete, deliveries). Restart command R with `WHSEC=<the stage hook's secret>`. |
| 4 | `HK=$(mk "$CONTRACTS_A" "QA HOOK moves" SOW 20000); move "$CONTRACTS_A" $HK negotiate with_counterparty` | Command R prints two deliveries. `/zap-stage`: `x-clm-event: contract.stage_changed`, signature OK, body `{"event":"contract.stage_changed","timestamp":…,"data":{"contractId":"$HK","from":{"stage":"draft","state":"drafting"},"to":{"stage":"negotiate","state":"with_counterparty"},"status":"UNDER_NEGOTIATION","turn":"counterparty","source":"manual"}}`. `/zap-turn` (signature MISMATCH while `WHSEC` is the other hook's): `contract.turn_changed`, `{from:"internal", to:"counterparty", stage:"negotiate", source:"manual"}`. |
| 5 | A state change with the same turn: `move "$CONTRACTS_A" $HK negotiate with_us` then `move "$CONTRACTS_A" $HK draft drafting "QA"` then `move "$CONTRACTS_A" $HK draft ready`. | The last move (drafting → ready, turn stays internal) sends **only** `contract.stage_changed` (`status` "PENDING_REVIEW"). The second one includes `"reason":"QA"`. |
| 6 | `submit "$CONTRACTS_A" $HK`, then counsel-a returns it (`qstep "$COUNSEL_A" $HK; dec "$COUNSEL_A" $INST $STEP RETURNED "QA hook return"`). | Submit: stage_changed to approve/pending with `source` "approval", turn_changed internal → approvers. Return: stage_changed to `{stage:"draft",state:"returned"}` with `reason` "QA hook return", turn_changed approvers → internal. |
| 7 | A move refused (`move "$CONTRACTS_A" $HK approve approved`) and a move to where it already is. | No delivery for either. |
| 8 | `curl -s $API/hooks -H "Authorization: Bearer $KEY_HOOK" \| jq 'length'`, then unsubscribe both: `curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $API/hooks/$(echo $H1 \| jq -r .id) -H "Authorization: Bearer $KEY_HOOK"` (and `$H2`). | `204` each. Moving `$HK` again delivers nothing. A second DELETE → `404` "Subscription not found". |

**Also check**
- The doc matches the API: docs/42-ZAPIER-REST-HOOKS.md says "17 events" and its table lists each, including
  `contract.stage_changed` and `contract.turn_changed`, with a sample `data` that equals what the samples route
  returns (`hook-samples.test.ts` checks this in CI).
- `{"event":"contract.stage_changed"}` alone → `400` "target_url is required"; `"event":"contract.foo"` → `400` "Unknown event:
  contract.foo. Known: …"; `"url"` or `"hookUrl"` work in place of `target_url`.
- Without `WEBHOOK_ALLOW_PRIVATE_URLS`, a `127.0.0.1` target → `400` "target_url must be a public http(s) endpoint".
- A key without the `hooks` scope (`$KEY_SF`) → `403` "Missing permission: configure:integration". A `hooks` key can't read
  contracts (`GET /contracts` → `403`) unless it also has `contracts:read`.
- Retries: restart command R with `STATUS=500` and move a contract; the delivery is tried 5 times with growing gaps and
  logged on the webhook's deliveries (Admin → Integrations → Webhooks, and Health).
- The date job (E2E-LIF-03) and the counterparty upload (E2E-APR-05) deliver `contract.stage_changed` with `source` "dates"
  and "counterparty".
- With Salesforce connected, every stage or turn change also queues a Salesforce sync (E2E-SF-03).

**Known limits**
- There is no published Zapier app; the endpoints follow the REST Hooks pattern for one to be built.

---

## 7. Automated suites

Run these before any journey (docs/40 §0.9 says the same for the whole product). If one fails, stop and report: a
journey on a red build tests nothing.

### 7.1 Commands

From the repo root:

```bash
pnpm typecheck                      # every package: 0 errors
pnpm lint                           # 0 errors (warnings are allowed)
pnpm --filter api test              # API unit tests
pnpm --filter web test              # web unit tests
(cd apps/agents && ./.venv/bin/python -m pytest tests/ -q)    # agents service
```

The integration suite boots the real API against a real Postgres and Redis. Give it a database and a Redis db of its
own, so it never touches your data or another session's:

```bash
docker exec clm_postgres createdb -U clm clm_test_rt          # once; any unused name will do
cd apps/api
set -a && . ../../.env && set +a                              # loads the rest of the settings
export DATABASE_URL=postgresql://clm:clm@localhost:5433/clm_test_rt REDIS_URL=redis://localhost:6380/7
pnpm exec prisma migrate deploy                               # the branch's migrations, on the test database only
pnpm test:integration                                         # the whole suite, one file at a time
pnpm test:integration src/routes/category-rules.integration.test.ts    # or named files
```

- Never point `DATABASE_URL` at `clm_dev` (the demo data) or at a database another session uses, and never pass either
  as `--shadow-database-url`.
- The suite runs its files one after another (`singleFork`); a test may take up to 30 seconds before it times out.
- With a small Docker VM (4 GB), Postgres has fallen over under the full suite. If a run ends with
  connection errors, restart Postgres, check `docker ps` shows it healthy, and run the failed files again. If Gotenberg
  is unhealthy, `docker restart clm_gotenberg` and wait for its health check.
- No test calls a live model: the agents service is mocked. The live-model checks are the journeys marked
  **Needs: agents service + model key**.
- On macOS there is no `timeout`. To stop a hung run: `perl -e 'alarm shift; exec @ARGV' 1200 pnpm test:integration`.

### 7.2 What a green run looks like on this branch

| Suite | Command | Result on `d914067` (2 October 2026) |
|---|---|---|
| Typecheck | `pnpm -r typecheck` | clean, 0 errors |
| Lint | `pnpm -r lint` | 0 errors (41 warnings: API 16, web 25) |
| API unit | `pnpm --filter api test` | 119 files, 977 tests pass |
| API integration | `pnpm test:integration` (from `apps/api`, isolated database), run in 14 batches of 10 files | 134 files, 945 tests pass |
| Web unit | `pnpm --filter web test` | 58 files, 313 tests pass |
| Agents service | `pytest -q` (from `apps/agents`) | 166 pass, 1 expected failure (xfail) |

A lower count than this, with no failure, means tests were skipped or not found: check before going on.

This branch adds 59 integration test files. The ones closest to each section:

- §2: `analysis-trigger`, `analysis-runs`, `extraction-job`, `open-choices`, `request-draft`, `recommendation-guard`, `review-findings`,
  `clause-families`, `playbooks`, `review`, `category-rules`, `compliance-applicability`, `obligations-review`,
  `seed-families`.
- §3: `approval-lifecycle`, `contract-approval`, `signing-gate`, `lifecycle-views`.
- §4: `working-copy`, `workspace-changes`, `change-advice`, `comment-visibility`, `tracked-changes`, `ask-ai`,
  `ai-suggestion-events`, `edit-recheck`.
- §5: `amendments`, `contract-family`, `family-banner`, `renewal-terms`, `renewal-decisions`, `renewal-reminders`,
  `analytics-sections`.
- §6: `salesforce-connect`, `salesforce-inbound`, `integration-sync`, `sso-oidc`, `scim`, `hooks`.

---

## 8. Coverage

Every page, API route, job, agents service endpoint and data model this branch adds or changes, with the journeys that
test it. Use it as the run sheet: mark each journey pass, fail or blocked, with the date. A thing with no journey here is
covered by docs/40 §9 only.

### 8.1 Pages and screens

- /admin/analysis (Analysis health) → E2E-PIPE-03, E2E-PIPE-04
- /admin/integrations, Salesforce tab Sign in again and one org per workspace → E2E-SF-01
- /admin/integrations, Slack tab (Approve / Return with a reason) → E2E-APR-08
- /admin/integrations?tab=health → E2E-SF-03
- /admin/integrations?tab=salesforce → E2E-SF-01, E2E-SF-02, E2E-SF-03, E2E-SF-05
- /admin/integrations?tab=sso (OIDC, SCIM tokens, Groups) → E2E-SSO-01, E2E-SSO-02
- /admin/integrations?tab=webhooks (REST hook subscriptions) → E2E-HOOK-01
- /admin/org, Compliance tab → E2E-CMP-11
- /admin/organization (Approval before signing) → E2E-LIF-04
- /analytics (filter bar, section nav, seven sections, charts, **CSV**, "Portfolio at a glance") → E2E-ANA-01, E2E-ANA-02, E2E-ANA-03
- /approvals (Inbox card "AI: …") → E2E-REV-11
- /approvals (Inbox: Needs my action, Waiting on others, Team, Manage workflows) → E2E-INB-01, E2E-INB-02, E2E-APR-01, E2E-APR-03, E2E-APR-06, E2E-APR-07
- /clauses (Decides exceptions) → E2E-APR-07
- /clauses, Families view → E2E-DRF-01
- /contracts (row opens the workspace by stage) → E2E-WSP-01
- /contracts drill-down (`?drill=…`, chip "Analytics: …") → E2E-ANA-02
- /contracts upload modal **Link to existing contract** relationship list → E2E-AMD-05
- /contracts/:id (Open workspace, Edit → Save as version / Done, Compare, rail Changes, Comments tab) → E2E-WSP-01, E2E-WSP-02, E2E-WSP-03, E2E-WSP-04, E2E-CHG-01, E2E-CMT-02, E2E-SUG-03
- /contracts/:id (status banner, decision strip, History drawer, tabs) → E2E-LIF-01, E2E-LIF-02, E2E-LIF-04, E2E-LIF-05, E2E-APR-01, E2E-APR-02, E2E-APR-07, E2E-APR-08
- /contracts/:id and /contracts/:id/workspace, Request exception dialog (who decides, Name a clause approver) → E2E-APR-07
- /contracts/:id **Create amendment** dialog (relationship tiles, **Sections that change**, **Key terms that change**, **Draft**, **Drafted from**, **Takes effect**, **Number**) → E2E-AMD-01, E2E-AMD-02, E2E-RNW-08
- /contracts/:id effective view (**Amended key terms**, **Show amended values**, **Amended sections**, **Show the original words**) → E2E-AMD-04
- /contracts/:id family banner ("Amendment No. n to", "… under", "Linked to", "Split from scanned file") → E2E-AMD-05, E2E-RNW-02, E2E-RNW-03, E2E-RNW-04
- /contracts/:id rail and workspace Details, Salesforce changes (Apply / Dismiss) → E2E-SF-05
- /contracts/:id rail **Changes to the agreement** (roll-up, **Obligations from the sections it replaces**, **Confirm on the agreement**, **Undo**) → E2E-AMD-04
- /contracts/:id rail **Contract family** (**Family**, **As amended**, **What it changes**) → E2E-AMD-03, E2E-AMD-04, E2E-AMD-05, E2E-RNW-03
- /contracts/:id rail **Renewal** (deadline line, **Start renewal** / **Change decision**, standing decision, **Mark notice sent**, "Also reminded:") → E2E-RNW-02, E2E-RNW-03, E2E-RNW-04, E2E-RNW-05, E2E-RNW-07
- /contracts/:id, analysis banner and Overview "Analysed · vN" → E2E-PIPE-01, E2E-PIPE-02, E2E-PIPE-03
- /contracts/:id, Compliance section → E2E-CMP-10, E2E-CMP-11
- /contracts/:id, decision strip → E2E-REV-11
- /contracts/:id, family band View family → E2E-AMD-05
- /contracts/:id, Key terms Renewed mark on an expiry moved by auto-renewal → E2E-RNW-07
- /contracts/:id, open-choices chip and Actions → Share → E2E-DRF-04
- /contracts/:id, Origin section → E2E-DRF-04, E2E-DRF-05, E2E-DRF-06
- /contracts/:id, rail Changes to the agreement (Roll up once Amendment No. N is signed) → E2E-AMD-04
- /contracts/:id, rail Obligations (Proposed — confirmed at signing; Replaced by Amendment No. N) → E2E-PIPE-01, E2E-AMD-04
- /contracts/:id, Review section → E2E-REV-10, E2E-REV-11, E2E-REV-12, E2E-REV-13, E2E-REV-14, E2E-REV-15, E2E-REV-16, E2E-PIPE-01
- /contracts/:id, Review → Drafting, Defined terms list, term hover → E2E-CMP-12
- /contracts/:id/workspace (banner, History, Changes mode) → E2E-LIF-01, E2E-LIF-05, E2E-APR-05, E2E-APR-08
- /contracts/:id/workspace (banner, panels Review / Details / Comments, History drawer) → E2E-WSP-01, E2E-WSP-02, E2E-WSP-04, E2E-WSP-05
- /contracts/:id/workspace (Review tab, Details → Origin, Save as version) → E2E-PIPE-02, E2E-REV-10, E2E-REV-11, E2E-REV-12, E2E-REV-13, E2E-DRF-04
- /contracts/:id/workspace margin threads and Comments → E2E-CMT-01, E2E-CMT-02, E2E-CMT-03
- /contracts/:id/workspace Save as version dialog → E2E-WSP-03, E2E-WSP-04, E2E-WSP-05
- /contracts/:id/workspace selection menu (Comment, Ask AI, Tag clause, Make variable, Request exception) → E2E-SUG-01, E2E-CMT-02
- /contracts/:id/workspace suggestion mode (Suggesting, Accept all / Reject all, suggestion popover) → E2E-SUG-02, E2E-SUG-03, E2E-CMT-03
- /contracts/:id/workspace, Comments → Document discussion, Only this person → E2E-CMT-03
- /contracts/:id/workspace, Save and send by Word or PDF (download, failure toast) → E2E-WSP-03
- /contracts/:id/workspace?mode=changes (Changes mode) → E2E-CHG-01, E2E-CHG-02, E2E-CHG-03, E2E-SUG-02
- /contracts/:id/workspace?mode=changes&baseline=&current= (History's Compare with vN, read-only pair) → E2E-CHG-01
- /embed/contracts/:id → E2E-SF-05
- /login (Sign in with SSO), /login/sso → E2E-SSO-01
- /obligations, Replaced by Amendment No. N and owed-only views → E2E-AMD-04
- /playbook (position editor: Suggested note to counterparty) → E2E-CMT-03
- /playbook, playbook picker and Manage playbooks → E2E-REV-15
- /playbook, Rules for this clause (Required / Not allowed / Optional, contract types, Decides exceptions) → E2E-REV-16, E2E-APR-07
- /portal/:token (Comments, Download .docx, Upload revised) → E2E-CMT-01, E2E-CHG-03, E2E-SUG-03
- /portal/:token (upload during approval) → E2E-APR-05
- /renewals (row **Start renewal**, decision pill, "· notice not sent") → E2E-RNW-02, E2E-RNW-04, E2E-RNW-08
- /requests (Decline request, Declined tab, Reopen request) → E2E-APR-08
- /requests, request panel "Drafting will use" → E2E-DRF-03, E2E-DRF-04, E2E-DRF-05, E2E-DRF-06
- /settings?tab=notifications **Calendar feed** → E2E-RNW-06
- /templates, builder (clause slot, Drafts use, library-change notice, default box, Against your playbook) → E2E-DRF-02, E2E-DRF-03, E2E-REV-13
- Sidebar Inbox badge → E2E-INB-01
- /dashboard "N contracts need your action in Inbox" and tile **Needs my action** → E2E-INB-01
- Inbox approval row "AI: <recommendation> — <first reason>" → E2E-INB-01, E2E-REV-11
- AnalysisFailedBanner ("Analysis failed while <step>.", reason in words, **Retry** / **Retry draft**) → E2E-PIPE-03
- **Start renewal** dialog (three choices, effects, **Renew** / **Start the renewal draft** / **Draft the notice**, done state) → E2E-RNW-02, E2E-RNW-03, E2E-RNW-04, E2E-RNW-08
- status banner states "Expiring soon", "Expired", "Terminated", "Renewed automatically" → E2E-RNW-04, E2E-RNW-07, E2E-RNW-08
- StatusBanner: "Unsaved draft changes" → E2E-WSP-02; "Counterparty sent vN — …" and Review changes → E2E-CHG-03; "N suggestions pending" → E2E-SUG-02, E2E-SUG-03

### 8.2 API routes

- `GET /admin/analysis/runs`, `POST /admin/analysis/runs/:id/retry` → E2E-PIPE-03
- `POST /admin/integrations/api-keys` (scopes salesforce, hooks) → E2E-SF-01, E2E-SF-04, E2E-HOOK-01
- `GET /admin/integrations/events` → E2E-HOOK-01
- `GET /admin/integrations/health` → E2E-SF-03
- `GET /admin/integrations/salesforce`, `POST …/connect`, `DELETE …`, `PATCH …/settings` → E2E-SF-01, E2E-SF-02, E2E-SF-04
- `POST /admin/integrations/salesforce/connect` (409 when connected, `reconnect`), `GET /integrations/salesforce/oauth/callback` (different org refused) → E2E-SF-01, E2E-SF-02
- `PATCH /admin/users/:id/roles` → E2E-APR-06
- `POST /ai-suggestion-events` → E2E-SUG-04
- `GET /analytics/:section?format=csv` → E2E-ANA-02
- `GET /analytics/ai` (`available:false`) → E2E-ANA-01
- `GET /analytics/ai` (available, from ai_suggestion_events) → E2E-ANA-01
- `GET /analytics/bottlenecks` → E2E-ANA-01, E2E-ANA-02, E2E-ANA-03
- `GET /analytics/drilldown` → E2E-ANA-02, E2E-ANA-03
- `GET /analytics/negotiation` → E2E-ANA-01
- `GET /analytics/renewals` → E2E-ANA-01, E2E-ANA-02
- `GET /analytics/risk` → E2E-ANA-01
- `GET /analytics/speed` → E2E-ANA-01, E2E-ANA-02, E2E-ANA-03
- `GET /analytics/summary` (cycle time to `executedAt`) → E2E-ANA-01
- `GET /analytics/workload` → E2E-ANA-01, E2E-ANA-03
- `POST /approvals/:id/decide` (APPROVED, RETURNED, DECLINED) → E2E-APR-01, E2E-APR-02, E2E-APR-06, E2E-INB-01
- `GET /approvals/notifications` → E2E-APR-01, E2E-APR-02, E2E-APR-04, E2E-APR-05, E2E-APR-06, E2E-SF-05
- `POST /approvals/steps/:stepId/decide` → E2E-APR-07
- `POST /approvals/workflows`, `PATCH /approvals/workflows/:id` (resetOn, roleRequired) → E2E-APR-03, E2E-APR-04, E2E-APR-06
- `POST /auth/sso/discover`, `GET /auth/sso/start`, `GET /auth/sso/callback`, `POST /auth/sso/exchange` → E2E-SSO-01
- `GET /calendar/:token.ics` → E2E-RNW-06, E2E-RNW-08
- `GET /clause-families`, `GET /clause-families/:id` → E2E-DRF-01
- `POST /clause-families`, `PATCH /clause-families/:id`, `DELETE /clause-families/:id` → E2E-DRF-01
- `PUT /clause-families/:id/default`, `POST /clause-families/:id/preview` → E2E-DRF-01
- `POST /clause-families/:id/variants`, `PATCH /clause-families/:id/variants/:itemId` → E2E-DRF-01
- `GET /clauses/:id/versions` → E2E-DRF-01
- `GET /clauses/categories`, `PATCH /clauses/categories/:id` (presence) → E2E-REV-16
- `PATCH /clauses/categories/:id` (approverUserId, approverRoleId) → E2E-APR-07
- `GET /compliance-policy`, `PUT /compliance-policy`, `DELETE /compliance-policy` → E2E-CMP-11
- `PATCH /contracts/:id` (value, currency; status from older clients) → E2E-APR-04, E2E-LIF-02
- `GET /contracts/:id`, `GET /contracts/:id/clauses` → E2E-PIPE-01, E2E-PIPE-04
- `GET /contracts/:id/amendment-changes` → E2E-AMD-04
- `POST /contracts/:id/amendment-changes/apply` (`keys`, `supersedeObligationIds`) → E2E-AMD-04
- `POST /contracts/:id/amendment-changes/apply` (409 AMENDMENT_NOT_SIGNED), `GET …/amendment-changes` (`signed`, `label`) → E2E-AMD-04
- `POST /contracts/:id/amendment-language` → E2E-AMD-02
- `PUT /contracts/:id/amendment-number` → E2E-AMD-01
- `GET /contracts/:id/amendment-redline` → E2E-AMD-03
- `POST /contracts/:id/amendments` (relationship types, numbering, `changes`, `templateId`, `effectiveDate`, `amendmentNumber`) → E2E-AMD-01, E2E-AMD-02
- `GET /contracts/:id/analysis-runs` → E2E-PIPE-01, E2E-PIPE-02, E2E-PIPE-03, E2E-PIPE-04
- `POST /contracts/:id/analyze` → E2E-PIPE-02
- `GET /contracts/:id/approval` → E2E-APR-01, E2E-APR-02, E2E-APR-05, E2E-APR-06, E2E-APR-07
- `POST /contracts/:id/ask-ai` → E2E-SUG-01, E2E-SUG-04
- `POST /contracts/:id/cancel`, `POST /contracts/:id/uncancel` → E2E-LIF-02
- `GET /contracts/:id/changes` → E2E-CHG-01, E2E-CHG-02, E2E-SUG-02
- `POST /contracts/:id/changes/counter` → E2E-CHG-02, E2E-SUG-04
- `GET /contracts/:id/changes?current=<versionId>` (`against.latest`) → E2E-CHG-01
- `GET /contracts/:id/checks` → E2E-DRF-04, E2E-PIPE-02, E2E-REV-10, E2E-REV-11, E2E-REV-12, E2E-REV-15, E2E-REV-16
- `GET /contracts/:id/comments` (`visibility`, `versionId`, anchors) → E2E-CMT-01, E2E-CMT-02
- `POST /contracts/:id/comments` (visibility, anchor) → E2E-CMT-01, E2E-CMT-02, E2E-CMT-03
- `PATCH /contracts/:id/comments/:commentId` (visibility, resolve) → E2E-CMT-01
- `GET /contracts/:id/compliance/applicability` → E2E-CMP-10, E2E-CMP-11
- `POST /contracts/:id/compliance/facts/confirm` → E2E-CMP-10, E2E-CMP-11
- `POST /contracts/:id/compliance/facts/extract`, `POST /contracts/:id/compliance/frameworks` → E2E-CMP-10
- `GET /contracts/:id/defined-terms` → E2E-CMP-12
- `GET /contracts/:id/download` (PDF send) → E2E-WSP-03
- `GET /contracts/:id/effective` → E2E-AMD-02, E2E-AMD-04
- `POST /contracts/:id/extract-obligations`, `GET /contracts/:id/obligations` → E2E-AMD-02
- `GET /contracts/:id/family` (`label`, `splitFromParent`) → E2E-AMD-01, E2E-AMD-05
- `GET /contracts/:id/family-tree` → E2E-AMD-01, E2E-AMD-03, E2E-AMD-05
- `GET /contracts/:id/fields` → E2E-AMD-02, E2E-AMD-04
- `POST /contracts/:id/findings/:findingId/accept`, `/resolve`, `/reopen` → E2E-REV-14, E2E-REV-16
- `POST /contracts/:id/findings/:findingId/accept`, `…/resolve` (from Changes mode) → E2E-CHG-02
- `POST /contracts/:id/findings/:findingId/exception` → E2E-SUG-01
- `GET /contracts/:id/findings/:findingId/exception-approver` → E2E-APR-07
- `POST /contracts/:id/findings/:findingId/insert-standard` → E2E-REV-11, E2E-REV-15
- `POST /contracts/:id/findings/:findingId/redline`, `/redline/apply` → E2E-REV-14
- `POST /contracts/:id/findings/:findingId/tag` → E2E-REV-16
- `GET /contracts/:id/history` → E2E-LIF-05, E2E-LIF-03, E2E-APR-01, E2E-APR-04, E2E-APR-05
- `POST /contracts/:id/html-version` (approval reset) → E2E-APR-04, E2E-LIF-04
- `POST /contracts/:id/html-version` → E2E-WSP-05
- `GET /contracts/:id/integration-conflicts`, `POST …/integration-conflicts/:conflictId/resolve` → E2E-SF-05
- `GET /contracts/:id/integration-conflicts`, `POST /contracts/:id/integration-conflicts/:conflictId/resolve` (from the contract's rail) → E2E-SF-05
- `GET /contracts/:id/origin`, `POST /contracts/:id/origin/slots/:familyId` → E2E-DRF-04, E2E-DRF-05, E2E-DRF-06
- `PUT /contracts/:id/parent` → E2E-AMD-01
- `GET /contracts/:id/playbook`, `PUT /contracts/:id/playbook` → E2E-REV-15
- `GET /contracts/:id/redline/counterparty` → E2E-WSP-03, E2E-SUG-03
- `GET /contracts/:id/renewal` → E2E-RNW-01, E2E-RNW-02, E2E-RNW-03, E2E-RNW-04, E2E-RNW-08
- `POST /contracts/:id/renewal-decision` (`renew`, `renegotiate`, `let_lapse`, `terminate`, `let_expire`, refusals) → E2E-RNW-02, E2E-RNW-03, E2E-RNW-04, E2E-RNW-07, E2E-RNW-08
- `POST /contracts/:id/renewal-decision` (renew / renegotiate → Active · Renewing) → E2E-RNW-02, E2E-RNW-04
- `POST /contracts/:id/renewal-decision/notice-sent` → E2E-RNW-04, E2E-RNW-07, E2E-RNW-08
- `POST /contracts/:id/revert-signature` → E2E-LIF-04
- `GET /contracts/:id/review` → E2E-REV-10 to E2E-REV-16, E2E-PIPE-02, E2E-CMP-12
- `GET /contracts/:id/review` (`advice`, `counterpartyNote`) → E2E-CHG-03, E2E-CMT-03
- `GET /contracts/:id/review` (`baseline.reason` "parent") → E2E-RNW-03
- `GET /contracts/:id/review`, `POST /contracts/:id/findings/:findingId/exception` → E2E-APR-07
- `POST /contracts/:id/review/fix-all` → E2E-REV-14
- `POST /contracts/:id/send-for-signature` (409 OPEN_CHOICES) → E2E-DRF-04
- `POST /contracts/:id/send-for-signature` (APPROVAL_REQUIRED, OPEN_EXCEPTIONS, NOT_SIGNABLE) → E2E-LIF-04, E2E-APR-07, E2E-APR-04
- `POST /contracts/:id/share` (409 OPEN_CHOICES) → E2E-DRF-04
- `POST /contracts/:id/share` (with draft changes) → E2E-WSP-03, E2E-WSP-06
- `POST /contracts/:id/share`, `POST /portal/:token/versions` → E2E-APR-05
- `POST /contracts/:id/signature-requests/:srId/void` → E2E-LIF-04
- `GET /contracts/:id/stage` → E2E-LIF-01, E2E-LIF-04, E2E-APR-02, E2E-APR-04, E2E-APR-05
- `GET /contracts/:id/stage` (`counterparty`, `next`) → E2E-WSP-01, E2E-CHG-03
- `POST /contracts/:id/stage` → E2E-LIF-01, E2E-LIF-02, E2E-HOOK-01
- `POST /contracts/:id/stage` and `POST /contracts/:id/send-for-signature` on a declined approval (409) → E2E-APR-02
- `POST /contracts/:id/submit-approval` → E2E-LIF-01, E2E-APR-01, E2E-APR-02, E2E-APR-05, E2E-APR-06
- `POST /contracts/:id/submit-approval` (with draft changes) → E2E-WSP-06
- `POST /contracts/:id/submit-approval`, `GET /contracts/:id/approval` → E2E-REV-11
- `GET /contracts/:id/term-history` → E2E-AMD-04
- `GET /contracts/:id/variables` (Make variable) → E2E-SUG-01
- `GET /contracts/:id/versions/:v1Id/redline-docx/:v2Id` → E2E-CHG-01
- `POST /contracts/:id/versions/:versionId/clauses` (internal) → E2E-APR-04
- `POST /contracts/:id/versions/from-working-copy` → E2E-WSP-03, E2E-WSP-05
- `DELETE /contracts/:id/working-copy` → E2E-WSP-04
- `GET /contracts/:id/working-copy` → E2E-WSP-02, E2E-WSP-05
- `PUT /contracts/:id/working-copy` → E2E-WSP-02, E2E-WSP-03, E2E-WSP-05
- `PATCH /contracts/clauses/:id/review-state` → E2E-APR-08
- `POST /contracts/export` (docx with suggestions) → E2E-SUG-03
- `POST /contracts/upload` → E2E-PIPE-02, E2E-PIPE-03, E2E-REV-10, E2E-REV-14, E2E-REV-16, E2E-CMP-10, E2E-CMP-12
- `GET /contracts?ids=` (drill-down list) → E2E-ANA-02
- `POST /cron/obligations` (superseded obligations skipped) → E2E-AMD-04
- `POST /cron/renewals` (stage dates) → E2E-LIF-03
- `POST /cron/renewals` (`result.escalated`, `stageDates`) → E2E-RNW-05, E2E-RNW-07, E2E-RNW-08
- `POST /field-runs/:id/undo` (kind `rollup`) → E2E-AMD-04
- `POST /hooks`, `GET /hooks`, `DELETE /hooks/:id`, `GET /hooks/samples/:event` → E2E-HOOK-01
- `GET /inbox?view=mine|waiting|team`, `GET /inbox/count` → E2E-INB-01, E2E-INB-02
- `POST /integrations/salesforce/changes` → E2E-SF-05
- `POST /integrations/salesforce/embed-token`, `GET /embed/contracts/:id` → E2E-SF-05
- `GET /integrations/salesforce/launch-form`, `POST …/requests`, `GET …/contracts/:id/status` → E2E-SF-04
- `GET /integrations/salesforce/oauth/callback` → E2E-SF-01, E2E-SF-02
- `POST /internal/ai/tools/contract_draft` (assistant planner) → E2E-DRF-03
- `POST /obligations/:id/complete` (409 on a proposed obligation) → E2E-PIPE-01
- `GET /obligations?contractId=` (PROPOSED listed), `GET /obligations` (PROPOSED and replaced left out of owed views, `replacedBy`, `bucket`) → E2E-PIPE-01, E2E-AMD-04
- `PATCH /organization` (`allowSignWithoutApproval`) → E2E-LIF-04
- `PATCH /organization` (`workingCopyIdleMinutes`) → E2E-WSP-06
- `PATCH /organization` (`settings.renewalEscalationDays`) → E2E-RNW-05
- `PATCH /playbook/categories/:id/rules` → E2E-REV-16, E2E-APR-07
- `GET /playbook/playbooks`, `POST /playbook/playbooks`, `PATCH /playbook/playbooks/:id`, `DELETE /playbook/playbooks/:id` → E2E-REV-15
- `PATCH /playbook/positions/:id` (`counterpartyNote`) → E2E-CMT-03
- `GET /portal/:portalToken/comments` → E2E-CMT-01
- `POST /portal/:portalToken/comments` → E2E-CMT-01
- `GET /portal/:portalToken/download/docx` → E2E-CHG-03, E2E-SUG-03
- `POST /portal/:portalToken/versions` → E2E-CHG-03, E2E-SUG-03
- `GET /renewals` (`renewalType`, `inWindow`, `noticeSentAt`, `actionContractId`), `GET /renewals/export` → E2E-RNW-01, E2E-RNW-04
- `POST /requests` → E2E-DRF-03, E2E-DRF-04, E2E-DRF-05, E2E-DRF-06
- `PATCH /requests/:id` (REJECTED with reason, reopen) → E2E-APR-08
- `POST /requests/:id/convert` (incl. 409 TEMPLATE_CHOICE_NEEDED) → E2E-DRF-03, E2E-DRF-04, E2E-DRF-05, E2E-DRF-06
- `POST /requests/:id/convert` (generate now) → E2E-SF-04
- `PUT /requests/:id/draft-choices` → E2E-DRF-03, E2E-DRF-06
- `GET /requests/:id/draft-plan` → E2E-DRF-03, E2E-DRF-04, E2E-DRF-05, E2E-DRF-06
- `POST /review-queue/:id/verify` (renewal columns sync) → E2E-RNW-01
- `/scim/v2/ServiceProviderConfig`, `/scim/v2/Users`, `/scim/v2/Groups` → E2E-SSO-02
- `POST /templates`, `PATCH /templates/:id`, `PUT /templates/:id/sections` → E2E-DRF-02
- `PUT /templates/:id/default-for-type` → E2E-DRF-02, E2E-DRF-03
- `POST /templates/:id/publish`, `GET /templates/:id/versions`, `GET /templates/:id/lint` → E2E-DRF-02
- `POST /templates/:id/slot-preview` → E2E-DRF-02
- `GET /templates?contractType=&published=` → E2E-DRF-03
- `GET`/`POST /contracts/:id/watchers`, `DELETE /contracts/:id/watchers/:userId` → E2E-RNW-05, E2E-RNW-08
- `GET`/`POST`/`DELETE /calendar-feed` → E2E-RNW-06, E2E-RNW-08
- `GET/PUT/DELETE /admin/sso`, `POST /admin/sso/test` → E2E-SSO-01
- internal `POST /internal/ai/tools/contract_create_from_template` (our-paper fixtures) → E2E-ANA-01
- internal `POST /internal/ai/tools/contract_get` (`effectiveTerms`) → E2E-AMD-04
- `POST/GET/DELETE /admin/sso/scim-tokens`, `GET/PATCH /admin/sso/scim-groups` → E2E-SSO-02
- `GET …/conflicts`, `POST …/conflicts/:id/resolve` → E2E-SF-05
- `GET …/objects`, `GET …/objects/:name/fields`, `GET …/targets`, `GET/PUT …/mappings` → E2E-SF-01, E2E-SF-02, E2E-SF-03
- `GET …/sync-log`, `POST …/sync-log/:id/retry`, `POST …/sync-now` → E2E-SF-03

### 8.3 Jobs, workers, libraries, scripts and settings

- classify-request → E2E-DRF-05, E2E-DRF-04
- draft-contract → E2E-DRF-04, E2E-DRF-05, E2E-DRF-06, E2E-PIPE-01
- parse-document, detect-binder → E2E-PIPE-02, E2E-PIPE-03
- classify-document, extract-ai → E2E-PIPE-01, E2E-PIPE-02, E2E-PIPE-03
- chunk-and-index (incl. the no-clauses failure) → E2E-PIPE-03
- analysis-checkpoint (incremental analysis) → E2E-PIPE-02, E2E-REV-11, E2E-REV-12, E2E-REV-13
- playbook-review (position check) → E2E-REV-10, E2E-REV-14
- compliance-review → E2E-CMP-10
- playbook redline (Fix all fixable) → E2E-REV-14
- analysis `drafting` step → E2E-CMP-12
- `scripts/backfill-clause-families.ts` → section 2 setup
- `scripts/backfill-unanalysed.ts` → E2E-PIPE-04
- `scripts/set-template-org-default.ts` → E2E-DRF-04 (Known limits)
- `ANALYSIS_CHECKPOINT_MS` → E2E-PIPE-02
- `VITE_MARGIN_CLASSIFIER` → E2E-REV-10, E2E-REV-12
- `lib/lifecycle.ts transition()` (compare-and-set, STAGE_CHANGED) → E2E-LIF-01, E2E-LIF-02
- `lib/lifecycle-dates.ts` (daily date job, in the renewal scan) → E2E-LIF-03
- `lib/approval-reset.ts` (reset rules, carry, withdraw) → E2E-APR-04, E2E-APR-05, E2E-LIF-04
- `lib/workflow-engine.ts` (return/decline notifications, pooled steps) → E2E-APR-01, E2E-APR-02, E2E-APR-06
- `lib/inbox.ts` → E2E-INB-01, E2E-INB-02
- notification.worker (in-app and email) → E2E-APR-01, E2E-APR-02, E2E-APR-04, E2E-APR-05, E2E-APR-06, E2E-APR-07, E2E-SF-05
- webhook.worker (`webhooks` queue): `contract.stage_changed`, `contract.turn_changed` → E2E-HOOK-01, E2E-LIF-03
- integration-sync worker (`integration-sync` queue: `contract`, nightly `reconcile`) → E2E-SF-03
- signing gate (`signingGate`) → E2E-LIF-04, E2E-APR-07
- Slack approval card ("Return with a reason") → E2E-APR-01, E2E-APR-08
- agents service (analysis that produces review findings) → E2E-APR-07
- agent.worker `working-copy-idle` → E2E-WSP-06
- agent.worker `change-advice` (analysis step `change_advice`) → E2E-CHG-03
- analysis-checkpoint job (re-analysis after a saved version) → E2E-CHG-02, E2E-SUG-02
- parse worker, Word tracked changes read as suggestions → E2E-SUG-03
- `lib/suggestions.ts` (analysis reads suggestions as accepted) → E2E-SUG-02, E2E-SUG-03
- Mailpit (send by email) → E2E-WSP-03
- scripts/p74-15-verify.mjs, scripts/redline/p4-ui-verify.mjs → E2E-CHG-01
- scan.worker renewal scan (reminders to owner and watchers, Legal Ops escalation once per deadline) → E2E-RNW-05, E2E-RNW-08
- scan.worker / lib/lifecycle-dates.ts `scanStageDates` (expiring, expired, terminated, auto_renewed, reactivated) → E2E-RNW-07, E2E-RNW-08
- scan.worker obligation scan (skips superseded obligations) → E2E-AMD-04
- lib/renewal-terms.ts `syncRenewalTerms` (field-store commit, signed amendment) → E2E-RNW-01
- `apps/api/scripts/backfill-renewal-terms.ts` → E2E-RNW-01
- lib/child-contract.ts (stage on the record, analysis queued, `amendment.created` webhook) → E2E-AMD-02, E2E-RNW-03
- lib/review-findings.ts parent baseline → E2E-RNW-03
- lib/calendar-feed.ts (signed token, hash, revoke) → E2E-RNW-06
- migration `20261002100000_lifecycle_family_renewals` (relationship CHECK, normalising trigger, numbering) → E2E-AMD-01, E2E-AMD-05
- migration `20261002110000_renewal_decisions_from_metadata` → E2E-RNW-04 (the `let_expire` reading)
- seeded templates "Renewal letter" and "Notice of non-renewal" (or their built-in fallback) → E2E-RNW-02, E2E-RNW-04
- audit `RENEWAL_DECIDED`, `RENEWAL_NOTICE_SENT`, `CONTRACT_WATCHER_ADDED`, `CONTRACT_WATCHER_REMOVED`, `CALENDAR_FEED_CREATED`, `CALENDAR_FEED_REVOKED` → E2E-RNW-02, E2E-RNW-04, E2E-RNW-05, E2E-RNW-06
- obligation extraction after a draft's full analysis (`queueProposedObligations`), confirmed at signing (`confirmProposedObligations`) → E2E-PIPE-01
- date job: automatic renewal moves the expiry on (`renewedExpiry`, field-store `renewExpiry`, audit `renewed_expiry`) → E2E-RNW-07, E2E-LIF-03
- renewal reminders worded by renewal type (`renewalReminderAction`) → E2E-RNW-05
- approval reset of a pooled step back to its role, with "Approval needed again" to the pool (`lib/approval-reset.ts`) → E2E-APR-06
- presence-rule change re-reviews an unsigned contract on its next read (`presenceChangedAt`) → E2E-REV-16
- amendment redline without its marker (operative sentence, suggestions read as accepted) → E2E-AMD-03
- lib/request-values.ts: a value that says there is none ("no law", "TBD") is no value; a purpose as a noun phrase → E2E-DRF-04, E2E-DRF-05
- lib/draft-plan.ts: our side's party name always the org's → E2E-DRF-04
- lib/document-values.ts: money with its currency, dates in the org's date order, in drafts, amendments and renewal letters → E2E-AMD-02, E2E-RNW-02, E2E-RNW-04
- recommendation guard `open_choices` (an open choice makes it Review) → E2E-DRF-04, E2E-REV-10
- review findings: a deleted clause that was a blank ("— was not filled in"), a filled blank not a deletion, no "Part of … deleted" beside the whole deletion, no required clauses asked of an amendment or exhibit → E2E-REV-11, E2E-REV-13, E2E-REV-16
- History titles in words (`updatedTitle`) → E2E-LIF-05
- extraction save leaves a draft blank out (no value, no 422) and keeps the analysis stamp when obligations are read → E2E-PIPE-01
- seeded NDA templates' Term and Termination section → E2E-DRF-04, E2E-REV-13

### 8.4 Agents service endpoints and model calls

- intake classifier (`/intake-classify`) → E2E-DRF-05
- draft variable extractor (`/draft/extract-variables`) → E2E-DRF-04, E2E-DRF-05, E2E-DRF-06
- extraction and classification of uploads and drafts → E2E-PIPE-01, E2E-PIPE-02, E2E-PIPE-03
- position check against the playbook → E2E-REV-10, E2E-REV-14
- clause rewrite ("Redline to your position", Fix all fixable) → E2E-REV-14
- compliance facts and framework checks → E2E-CMP-10
- approval summary (its label overridden by the policy) → E2E-REV-11
- agents `/redline/score` (model) → E2E-CHG-03
- agents `/redline/counter` (model) → E2E-CHG-02
- agents `/redline_propose` for Ask AI (model) → E2E-SUG-01, E2E-SUG-04
- agents service `POST /amendment_language` → E2E-AMD-02
- analysis of uploaded and drafted contracts (clauses, fields, review) → E2E-AMD-02, E2E-RNW-03
- agents service `obligations` → E2E-AMD-02
- binder detection and split (`detect_binder`) → E2E-AMD-05
- No journey judges a model's wording. E2E-APR-07 needs an analysed contract (agents service + model key) only to have findings to ask exceptions on.

### 8.5 Data models and migrations

- `ai_suggestion_events` table → E2E-SUG-04
- `clause_categories.presenceChangedAt` → E2E-REV-16
- `obligations.status` PROPOSED and `obligations.versionId` → E2E-PIPE-01
- `obligations.supersededAt` / `supersededById` → E2E-AMD-04
- `integration_conflicts` (open / applied / dismissed; dismissed when a new org connects) → E2E-SF-01, E2E-SF-05
- `contract_field_values` source `renewal` → E2E-RNW-07
- `contracts.stageState` `renewing` → E2E-RNW-02, E2E-RNW-04
- Every migration this branch adds: Appendix A, and §0.1 for what they carry over

### 8.6 The Salesforce package (`integrations/salesforce`)

- `sf project deploy start`, `DraftLegalApiTest` → E2E-SF-01
- Named Credential / External Credential `draftLegal`, CSP Trusted Site, permission sets → E2E-SF-01
- `DL_Contract__c` (stage, waiting on, approvals) and `dlContractStatus` → E2E-SF-03
- `dlNewContract`, `DraftLegalRequestAction` → E2E-SF-01, E2E-SF-04
- `DraftLegalChangeAction` → E2E-SF-05
- `dlDocumentPreview` → E2E-SF-05

---
## Appendix A. Before production

A checklist for whoever takes `feat/review-trust` to production. Tick each line; don't skip the verifications.

### A.1 The migrations, in the order they apply

This branch adds 36 migrations that production doesn't have (`git diff --name-only origin/main --
apps/api/prisma/migrations | grep migration.sql`). Prisma applies them in this order:

| # | Migration | Purpose |
|---|---|---|
| 1 | `20260927100000_contract_field_values` | The field store: one row per contract and field, with its value, where it came from and who checked it (docs/39). |
| 2 | `20260927100100_clause_source` | Who made each clause row (re-analysis replaces only the AI's) and where it sits in its version's text. |
| 3 | `20260927100200_field_suggestions` | Fields someone asked for from a highlight, for an admin to add or decline. |
| 4 | `20260927100300_field_value_runs` | Bulk writes of field values with the values before them, for a 30-day undo (also the amendment roll-up's **Undo**). |
| 5 | `20260927100400_saved_views` | Saved views of the contracts list (filters, columns, sort). |
| 6 | `20260927100500_obligation_review_state` | An AI-found obligation is a suggestion until a person confirms or dismisses it; existing ones stay confirmed. |
| 7 | `20260927100600_counterparty_aliases` | Other names a counterparty goes by, so contracts naming one link to it. |
| 8 | `20260927100700_field_corrections` | What the AI read before a person corrected a value, for correction rates and extraction examples. |
| 9 | `20260927100800_clause_source_contract` | Wording saved to the clause library from a contract keeps where it came from. |
| 10 | `20260927100900_amendment_values` | A parent's value set from an amendment keeps which contract it came from. |
| 11 | `20260927101000_contract_exhibits` | Exhibits and schedules attached to a contract, read into its analysis and search. |
| 12 | `20260927101100_clause_type_definitions` | Clause types an organization teaches the AI. |
| 13 | `20260927101200_diligence_columns` | A diligence room's own columns and their answers. |
| 14 | `20260927101300_field_candidates` | Every differing reading of a field, for a person to choose the one that governs. |
| 15 | `20261001164838_integration_layer_sso_scim` | The integration layer (connections, field mappings, sync log, conflicts), OIDC single sign-on and SCIM provisioning. |
| 16 | `20261001165614_analysis_stamp` | Each finished analysis is stamped with the version it read; contracts analysed before the stamp get one, so they don't turn "Not analysed". |
| 17 | `20261001170726_clause_presence` | Presence rules on clause categories (required, not allowed, optional, for contract types), with the seeded required set for existing orgs. |
| 18 | `20261001172123_contract_executed_at` | When a contract was executed, backfilled approximately for those executed before. |
| 19 | `20261001174728_compliance_facts_policy` | Facts that decide which compliance frameworks apply, and the org's rules from facts to frameworks. |
| 20 | `20261001174827_analysis_runs` | One row per analysis of a version, with each step it took. |
| 21 | `20261001174844_clause_families_template_versions` | Clause families and their variants, clause slots in templates, published template snapshots, a default template per type. |
| 22 | `20261001175812_playbooks` | Named playbooks with a default per type; every org's existing positions move under "Default playbook". |
| 23 | `20261001180511_review_findings` | Review findings per version and baseline, clause provenance, and the version an approval was submitted on. |
| 24 | `20261001191349_stage_turn_approvals` | A contract's stage, state and turn; approval outcomes, role (pooled) steps and clause exceptions; category approvers; a request's decline reason. |
| 25 | `20261001191709_approval_step_request_note` | Who asked for an exception, and their reason. |
| 26 | `20261002035934_comment_visibility_anchor` | Comments are internal or external, and anchored to their words. |
| 27 | `20261002090000_contract_working_copies` | The editor's autosaved draft changes, kept apart from versions, one per contract. |
| 28 | `20261002100000_lifecycle_family_renewals` | Amendment numbers, the renewal columns (type, term, notice, deadline, opt-out, uplift, confirmed), superseded obligations, term history, renewal decisions, watchers and calendar feeds. |
| 29 | `20261002100000_review_finding_advice` | The model's advice on a counterparty's change, kept on its finding. |
| 30 | `20261002110000_playbook_counterparty_note` | A suggested note to the counterparty per playbook position. |
| 31 | `20261002110000_renewal_decisions_from_metadata` | Renewal decisions move from contract metadata to their own rows (`let_expire` read as `let_lapse`). |
| 32 | `20261002120000_ai_suggestion_events` | What became of each AI suggestion: shown, accepted, edited, dismissed. |
| 33 | `20261002120000_calendar_feed_token` | The calendar feed's token, kept only as a hash, and revocable. |
| 34 | `20261002130000_portal_comment_author_name` | A portal comment's typed author name in its own column (resolving a thread overwrote it). |
| 35 | `20261002130000_proposed_obligations` | Obligations read from a draft are PROPOSED until signing; the version they were read from decides which become OPEN. |
| 36 | `20261002140000_clause_presence_changed_at` | When a category's presence rule last changed, so unsigned contracts are reviewed again on their next read. |

Every table these migrations create enables row-level security, as `20260924100000_tenant_row_level_security` set up
for every table with an `orgId`.

### A.2 Apply and verify

- [ ] **Migrations never run from CI.** Pushing to `main` deploys the code; the database is migrated by hand,
  **before** code that needs a migration goes live. With the owner's go-ahead, from `apps/api`, against the production
  database: `pnpm exec prisma migrate deploy`.
- [ ] **Verify, don't trust "applied":** `pnpm exec prisma migrate status` must say the schema is up to date and list
  none of the 36 as pending. (On 26 Sep a run silently applied nothing and the new API failed every signed-in
  request.)
- [ ] **Prove tenant isolation still holds**, in one transaction as the tenant role, for an org that doesn't exist:

  ```sql
  BEGIN;
  SELECT set_config('role', 'clm_tenant_access', true);
  SELECT set_config('app.tenant_id', 'org-that-does-not-exist', true);
  SELECT count(*) FROM contracts;               -- must be 0
  SELECT count(*) FROM review_findings;         -- must be 0
  SELECT count(*) FROM integration_connections; -- must be 0
  ROLLBACK;
  ```

  Any count above 0 is a P1: stop the release.
- [ ] Every new table has RLS on:
  `SELECT relname FROM pg_class WHERE relname IN ('playbooks','review_findings','analysis_runs','clause_families','template_versions','clause_library_versions','contract_facts','compliance_policies','contract_working_copies','contract_term_values','renewal_decisions','contract_watchers','calendar_feeds','ai_suggestion_events','integration_connections','integration_field_mappings','integration_sync_logs','integration_conflicts','sso_connections','scim_tokens','scim_groups','identity_links') AND NOT relrowsecurity;`
  returns no rows.

### A.3 Backfills, in this order

Run from `apps/api` against production, after A.2 (§0.3 says what each does):

- [ ] `scripts/backfill-field-values.ts` (every org).
- [ ] `scripts/link-counterparties.ts` (every org).
- [ ] `scripts/backfill-renewal-terms.ts` (every org).
- [ ] `scripts/backfill-clause-families.ts --org=<id>` as a dry run for each org, read what it would do, then with
  `--apply`.
- [ ] `scripts/backfill-unanalysed.ts` as a dry run; agree the count and its model cost with the owner; then `--apply`
  with a small `--per-org`, and repeat on later days until it finds nothing.
- [ ] **Seed template changes reach existing orgs through the backfill.** The seeded NDAs gained a "Term and
  Termination" section and their "Term" section became "Period of Confidentiality" (9c0f2fc). For each seeded NDA
  (Mutual NDA, One-Way NDA (Inbound), Mutual Idea Submission Agreement), `backfill-clause-families.ts` renames a
  "Term" section to "Period of Confidentiality" (replacing the wording only when it is still the seed's 3-year text),
  adds the "Term and Termination" section when the template has none, and publishes the template again. Its dry run
  lists both lines per template. Without it, every NDA an existing org drafts from its seeded template shows
  "Term & Termination — not detected". Templates an org renamed are not matched; edit those by hand.

### A.4 Demo organizations

Drafting now uses the template marked default for its type, not the newest one, and leaves a legal choice open unless
the org marked the default as its own. Demos built on the old behaviour need, once each:

- [ ] For each demo template, tick "Default <type> template — used when a request or the assistant doesn’t name one"
  in its builder (the CBRE works template and the GSK supply template are the known ones). Two published templates of
  one type with neither default makes a request ask which to use.
- [ ] For a demo whose drafts must come out filled (GSK, CBRE):
  `scripts/set-template-org-default.ts --org=<id> --key=governingLaw --value=<the law> --apply`, and the same for any
  other legal choice the demo shows filled.
- [ ] Draft once from each demo's request and check the draft has no "[[Choose …]]" blank and no "choice needed" chip.

### A.5 Open product decisions

These behave as described in this plan, by choice. Confirm each with the product owner before release:

- [ ] **Share links are admin-only.** Creating, listing and revoking share links, and **Save and send** by Share link
  or Email, need `configure:contract`, which only ADMIN holds. Contract Managers, Legal Counsel and Legal Ops send by
  Word or PDF. If they should share, add a `share` action on contract and grant it through
  `scripts/refresh-system-role-perms.ts`, rather than granting `configure:contract` (which also unlocks field
  definitions, clause types, legal entities and compliance applicability).
- [ ] **Auto-renew falls back to the initial term.** When a contract renews automatically and states no renewal term,
  the expiry moves on by its initial term ("successive periods of the same length"); with neither, the date stays.
- [ ] **A Fallback position doesn't block Ready.** A clause at the playbook's fallback position is a finding to note,
  not one that stops "Ready to approve".
- [ ] **Accept as is needs `edit:playbook`.** Only people who may change the playbook can accept a finding as is;
  others resolve, reopen or ask for an exception.
- [ ] **Pooled role approvals change who sees what.** A role step now goes to every holder of the role, and the first
  to decide claims it. Before, it went to one person. Nothing in the product announces this to admins (docs/47 asks
  for it).

---

## Appendix B. Bug report template

```
Title:        <what is wrong, in one line>
Journey:      E2E-<AREA>-NN, step <n>        (and the reported problem # from §1, if it is one)
Environment:  local <git commit> | hosted demo <date/time>;  browser + version
Account:      <admin-a | counsel-a | …>  in Org A | Org B
Steps:        1. …  2. …  3. …
Expected:     <the plan's expected result, quoted>
Actual:       <what happened; exact message / HTTP status / screenshot>
Evidence:     screenshot; browser console errors; the failing request (DevTools → Network → Copy as cURL, token removed);
              API log lines around the time (from the `pnpm dev` terminal)
Severity:     P1 security / data loss / cross-organization / feature unusable
              P2 feature partly broken or wrong result
              P3 minor, wording, layout
Repeatable:   always | sometimes (n of m) | once
```

---

## Appendix C. Browser run, 2 October 2026

A tester drove the branch in a browser on its own stack, as counsel-a and rep-a, through six scenarios that follow the
reported problems. It found 22 bugs. All were fixed on the branch (`273e23d`..`d914067`) and the journeys above now
expect the fixed behaviour. This appendix records what was run, what it found, and how to run the stack the same way.

### C.1 The six scenarios

| # | Scenario | Journeys | Result after the fixes |
|---|---|---|---|
| 1 | An NDA request that names no law → draft → choose New York in Origin | E2E-DRF-04, E2E-PIPE-01 | Pass. No Delaware anywhere; sending blocked until the choice; the header and Fields show no blank as a value; the analysis runs every step and the page says "Analysed · v1"; choosing New York reads "New York v1 · Chosen by a person". A fresh request re-run after the follow-up fixes: our side is the org, the purpose reads "evaluating", "no law" is no choice, Term and Termination is detected. |
| 2 | The workspace: Purpose not called weak, no "market" wording, the playbook named | E2E-REV-13, E2E-REV-10, E2E-REV-15 | Pass first time. "Using Default playbook, the default for NDA contracts." |
| 3 | Edit: delete Governing Law, cut Exclusions from 59 to 22 words, type junk; Save as version; re-analysis | E2E-REV-11, E2E-REV-12 | Pass. "Governing Law — deleted since v1 (required)", "… cut by 58% since v1", "Text that doesn't read as language in General"; the recommendation **Review**, never "Ready to approve", on the page, the strip and the inbox. |
| 4 | Submit, return with a reason, the owner sees it | E2E-APR-01, E2E-INB-01, E2E-LIF-05 | Pass. Banner, bell, inbox and History all carry the reason; queue counts agree (2 = 2, then 1 = 1). Dashboard and History wording fixed. |
| 5 | Amendment on the executed Acme MSA, and renewal | E2E-AMD-02, E2E-AMD-05, E2E-RNW-02 | Pass. No "binder" or "Split from" text; the amendment has no findings for the MSA's required clauses; "USD 300,000" in the amendment; the stage line reads "Active · Renewing" without a reload. |
| 6 | Analytics | E2E-ANA-01 | Pass first time: all eight sections render, all 13 requests answer 200. |

Not re-checked in the browser after their fix (covered by unit and integration tests instead): renewal letter dates
(cf9cc8f), the failed-analysis banner (0b15b77), "was not filled in" (7e085a9) and the open-choices recommendation
(d914067). Run E2E-RNW-02 step 10, E2E-PIPE-03 steps 3 and 5, E2E-REV-11 Also check and E2E-DRF-04 step 6 for them.

### C.2 Bugs found and fixed

- `273e23d` A draft's open blank "[[Choose governing law: …]]" was stored as the contract's governing law and shown in the header.
- `9e6d57c` A field value with a blank inside it ("courts located in [[venueLocation]]") was shown as a value.
- `20216d2` The clause step's bodiless request was sent as JSON and refused with 400, so every run stopped after Extract and the page said "Not analysed".
- `236e3fd` The extractor read the blank "[[effectiveDate]]" as a date; the save failed the date check and the whole extraction with it.
- `61afa43` A blank's column is now left out of the extraction save instead of being sent as null, which the date check also refused.
- `2b8ceae` Reading obligations wrote back metadata read a minute earlier, erasing the analysis stamp: analysed drafts said "Not analysed".
- `0e83fdd` Choosing New York for the blank was reported as "Part of Governing Law deleted since v1".
- `8e6837e` A "Part of … deleted" finding was carried beside the finding that the whole clause was deleted.
- `cf29987` Inbox rows waiting for my approval did not show the AI's recommendation and its first reason.
- `0584c1e` The dashboard called a returned contract to fix "1 approval waiting on your decision" / "Pending Approvals"; now "1 contract needs your action in Inbox" / "Needs my action".
- `442728c` History showed stored names ("changed set_from_template", "metadata, fieldConfidence"); now words ("filled in counterparty", "The analysis updated …").
- `a1b300f` An amendment to an MSA was asked for the MSA's required clauses ("Term & Termination — not detected" and two more).
- `fa711b9` The stage line stayed "Active" after a renewal decision until a reload.
- `ff9ece0` Both parties of the NDA were named "Initech Solutions": our side is now always the org.
- `9c0f2fc` Every NDA drafted from the seed was "Term & Termination — not detected": the seeded NDAs got a Term and Termination section, and "Term" became "Period of Confidentiality".
- `cfe7b8c` The request titled "QA NDA no law" was read as asking for the governing law "no law"; "no law", "not specified" and "TBD" are now no value.
- `c66e521` The purpose read "in connection with evaluate a 12-month pilot"; a leading verb becomes a noun phrase ("evaluating").
- `4a20305` The amendment said "The Contract value is amended to read: 300000."; now "USD 300,000", in the contract's currency.
- `cf9cc8f` Drafted documents wrote ISO dates ("dated 2025-03-01"); now the org's style ("March 1, 2025" or "1 March 2025").
- `0b15b77` A failed analysis showed the stored error with its 422 JSON; now the step, the reason in words and **Retry**.
- `7e085a9` A deleted clause that was still a blank in v1 showed the blank's markup as its deleted text; now "Governing Law — was not filled in".
- `d914067` A draft with an open choice said "Ready to approve"; now **Review** with "1 choice is still open in the draft (Governing Law)".

`39d9064` adds the tests for the first fourteen; each later commit carries its own.

Still open, recorded as Known limits: the intake classifier may read a pilot's "12-month" as the NDA's duration on the
request card (E2E-DRF-04); existing orgs don't get seed template changes (E2E-DRF-04, Appendix A.3); the parent's
**As amended** view shows the amendment's words as first drafted (E2E-AMD-04); a renewal letter is not analysed when
it is drafted.

### C.3 How the stack was run

- The branch's own stack from the worktree `.env`: web :5195 (Vite, proxying to the API), API :3301 (`tsx watch`,
  workers on), agents service :8023, database `clm_review` already seeded (Demo Org). Built-in browser at 1440 × 900.
- **A model key is needed.** The worktree `.env` had empty `GOOGLE_API_KEY`, OpenAI and Anthropic keys, so
  `/internal/ai/resolve` answered 503 and the first request failed classification. Export a key in the shell that
  starts the API and the agents service (it was not written to any file).
- **Source the worktree `.env` before starting the agents service.** It reads `INTERNAL_SERVICE_SECRET` from the
  process environment, not only from the `.env` file; started without it, every call answered 503 "misconfigured" and
  a new request stayed "Classifying".
- Stop any API an earlier session left on the same port: a second API instance on the same Redis db takes queued jobs
  with its own (older) code and settings.
- An org seeded before `9c0f2fc` needs its Mutual NDA template brought up to the new seed (Term and Termination added,
  "Term" renamed "Period of Confidentiality", published again) before scenario 1 shows Term & Termination detected.
