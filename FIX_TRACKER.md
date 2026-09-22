# Fix Tracker — defects found in the 2026-09-22 code audit

> **Single queue for the remediation run.** Work top to bottom, one task at a time.
> This file is the source of truth for progress. If context is lost or compacted,
> re-read this file and resume at the first task that is not `DONE`, `BLOCKED` or
> `NOT-REPRODUCIBLE`.

Created: 2026-09-22. Source: a read-only, five-pass audit of this repo (repository &
document intelligence, drafting & negotiation, approvals/execution/post-signature,
AI agent layer, platform/admin/integrations) plus follow-up traces of how the agent
answers portfolio questions. Every task below cites the evidence found at audit time.

## Status values

| Status | Meaning |
|---|---|
| `TODO` | Not started |
| `IN-PROGRESS` | Being worked on right now (only one at a time) |
| `DONE` | Fixed, verified, tracker updated, committed |
| `VERIFY-PENDING` | Code fixed and committed, but full verification needs infrastructure that was unavailable (say exactly what is missing) |
| `NOT-REPRODUCIBLE` | The defect does not exist in the current code — record the evidence that disproves it |
| `BLOCKED` | Cannot proceed — record precisely why and what would unblock it |

## The cycle for every task

1. **PLAN** — read the cited code first and confirm the defect still exists. Write the plan into the task's Worklog: root cause, files to change, approach, acceptance criteria, blast radius, tests to add.
2. **REVIEW (pre)** — critique the plan before writing code. Wrong layer? Other callers of the same function? Multi-tenant or permission implications? Does a repo skill cover this pattern (`.claude/skills/clm-permissions-rbac`, `clm-debug-multilayer`, `clm-hybrid-retrieval`, `clm-agent-tool-dev`)? Adjust the plan.
3. **EXECUTE** — make the smallest correct change, matching surrounding style. Add or extend a test that fails before the fix and passes after.
4. **REVIEW (post)** — re-read the whole diff. Run the checks. Confirm each acceptance criterion. Look for regressions in other callers.
5. **UPDATE TRACKER** — set the status, fill in the Worklog (what changed, evidence of verification, anything deliberately left out), then commit.

## Verification commands

```bash
pnpm --filter api db:generate      # required before typecheck (CI does this)
pnpm typecheck                     # all packages
pnpm lint                          # all packages
pnpm --filter api test             # API unit tests (vitest)
pnpm --filter web test             # web tests
pnpm --filter api test:integration # needs Postgres + Redis (docker compose up -d)
```

Integration tests and anything needing a live stack require `docker compose up -d`.
If Docker cannot run, do **not** block: finish the code and unit tests, mark the task
`VERIFY-PENDING`, state what still needs checking, and move on.

## Ground rules

- One task at a time, in order. Do not batch unrelated fixes into one commit.
- Only what is listed here. No refactors, no new features, no dependency upgrades.
- If a task turns out to be wrong or already fixed, mark it `NOT-REPRODUCIBLE` with evidence and move on.
- If a fix would balloon (touching many files or needing a redesign), implement the smallest safe part, mark the task `VERIFY-PENDING` or `BLOCKED` with a precise note, and move on rather than stalling.
- Work on a branch. Commit after each verified fix, with a message that says what broke and why the fix is right. **Do not add `Co-Authored-By` trailers** (user preference). Do not push, do not open PRs, do not merge to `main`.
- Never weaken a test or delete an assertion to make a check pass.

---

## S1 — Slack signing secret and bot token exposed to every org member

- **Status:** DONE
- **Severity:** Critical (privilege escalation inside an org)
- **Evidence:** `apps/api/src/routes/organization.ts:25` — `GET /api/v1/organization` has `preHandler: requireAuth` only and returns `settings: org.settings` wholesale. `apps/api/src/routes/integrations.ts:306-322` stores `slack.signingSecret` and `slack.botToken` in plaintext inside `organization.settings`. `apps/api/src/lib/slack.ts:50-66` reads them back. `apps/web/src/App.tsx:54` fetches `/organization` for every logged-in user.
- **Why it matters:** with the signing secret, any member (including the lowest-privilege role) can forge signed Slack interactivity payloads — including the Approve/Reject buttons handled in `apps/api/src/routes/slack.ts` — and the bot token lets them act as the workspace bot.
- **Acceptance criteria:**
  - `GET /organization` never returns `signingSecret` or `botToken`. Return a non-secret summary instead, mirroring the admin shape at `integrations.ts:281-289` (`teamId`, `configuredAt`, `hasSigningSecret`, `hasBotToken`).
  - Other secrets in `settings` (webhook, inbound-email, anything similar) are audited and redacted the same way.
  - `PATCH /organization`'s shallow settings merge (`organization.ts:45-60`) cannot overwrite or blank reserved keys such as `slack`.
  - An integration test proves a non-admin's `GET /organization` response contains neither secret (patterns: `apps/api/src/routes/rbac.integration.test.ts`, `apps/api/src/test-support/helpers.ts`).
  - The pages that read `/organization` still work: `apps/web/src/components/onboarding/WelcomeChecklist.tsx`, `OnboardingWizard.tsx`, `apps/web/src/pages/AdminOrgPage.tsx`.
- **Consider:** encrypting the Slack secrets at rest with `apps/api/src/lib/encryption.ts`, as per-org AI keys already are.
- **Worklog:**
  - **Plan (confirmed defect):** `organization.ts` GET returns `settings: org.settings` to any authenticated user; `settings.slack` holds `signingSecret`/`botToken` in plaintext. Audit of every `organization.settings` reader/writer in `apps/api/src`: keys are `slack` (secret), `piiRedactionMode`, `installedIndustryPacks`, `onboardingCompleted`, `welcomeChecklistDismissed` — no other secrets (inbound-email uses an env secret, webhooks store their secret on the `Webhook` table, AI keys on `OrgAiKey`). Fix at the route layer in `organization.ts`: (1) a `publicSettings()` serializer replacing `slack` with the admin summary shape (`connected`, `teamId`, `configuredAt`, `hasSigningSecret`, `hasBotToken`) and, as belt-and-braces, dropping any key at any depth whose name looks like a credential (`secret|token|password|apikey|privatekey`); used by GET and by the PATCH response. (2) PATCH strips server-managed keys (`slack`) from the incoming `settings` before the shallow merge, so neither a forged payload nor a client echoing back the redacted summary can overwrite or blank the real config. Acceptance: non-admin GET has no secret; PATCH with `slack` in body leaves stored slack untouched; onboarding/checklist flags still persist. Blast radius: web reads only `settings.onboardingCompleted`, `welcomeChecklistDismissed`, `installedIndustryPacks` — unaffected. `WelcomeChecklist.tsx:88` echoes the whole settings object back into PATCH; that is exactly the case (2) guards. Test: new `routes/organization.integration.test.ts`.
  - **Plan review:** right layer — the secret must never leave the server, and `integrations.ts` keeps the only admin read/write path for Slack (`configure:organization`). `lib/slack.ts` reads the DB directly, unaffected. Tenancy: routes already scope by `req.user.orgId`. Encrypting at rest is deferred (see follow-ups) — it needs a data migration for existing plaintext rows and makes Slack depend on `AI_KEY_ENCRYPTION_KEY`; out of scope for a leak fix.
  - **Changed:** `apps/api/src/routes/organization.ts` — `publicSettings()` (GET and the PATCH response) replaces `slack` with the admin summary shape and drops credential-looking keys at any depth; PATCH filters `SERVER_MANAGED_SETTINGS` (`slack`) out of the incoming settings before merging. `apps/web/src/components/onboarding/WelcomeChecklist.tsx` now PATCHes only `{ welcomeChecklistDismissed: true }` instead of echoing the fetched (now redacted) settings back, which would otherwise have re-saved the redacted view over stored keys. New `apps/api/src/routes/organization.integration.test.ts` (5 cases).
  - **Verified:** new test failed 4/4 before the fix (secret in body; forged `teamId: TEVIL` overwrote config) and passes after. Full suite: db:generate, typecheck, lint (0 errors; warnings unchanged from baseline), api unit 156/156, web 6/6, api integration 20/20 (Docker up, `clm_test` DB on :5433). Acceptance: (1) GET never returns `signingSecret`/`botToken` — tested for SALES_REP and ADMIN; (2) other settings secrets audited — none exist (keys listed in plan), plus generic credential-key stripping; (3) PATCH cannot overwrite or blank `slack` — tested with forged/null/{} from ADMIN and LEGAL_OPS, and with the echo pattern; (4) integration test present; (5) web readers only use `onboardingCompleted`, `welcomeChecklistDismissed`, `installedIndustryPacks`, all preserved; AdminOrgPage never sends `settings`. Not browser-checked (UI behaviour unchanged by design).
  - **Adversarial review (subagent):** no other route returns `settings` or the full org row to clients; casing/`__proto__`/nested-path tricks can't reach `slack`; web depends on no stripped field. Acted on: the checklist echo (fixed above), added LEGAL_OPS + PATCH-response assertions.
  - **Left out / follow-ups:** encryption at rest for Slack secrets (needs a data migration + makes Slack depend on `AI_KEY_ENCRYPTION_KEY`). **Operational:** secrets were readable by every member and every API key before this fix — rotate the Slack signing secret and bot token for every org with Slack connected. Pre-existing issues found and added to Stretch as X4–X6.


## S2 — Agent tools ignore the `own` permission scope

- **Status:** VERIFY-PENDING
- **Severity:** Critical (authorization bypass inside an org)
- **Evidence:** `apps/api/src/lib/permissions.ts:57-61` gives SALES_REP `p(A.VIEW, R.CONTRACT, S.OWN)`. REST enforces it at `apps/api/src/routes/contracts.ts:116-118` (`where.ownerId = req.user.sub` when `req.permissionScope === 'own'`). The agent's internal tool routes do not: `apps/api/src/routes/internal-ai.ts:841` builds `where = { orgId, deletedAt: null }`. Retrieval filters only by org: `apps/api/src/lib/embeddings.ts:343-381`, `apps/api/src/lib/elasticsearch.ts:158`.
- **Why it matters:** an own-scope user asking the assistant gets org-wide contract data, including contracts they cannot open in the UI.
- **Acceptance criteria:**
  - The caller's effective scope for `VIEW:CONTRACT` (and `VIEW:REQUEST`) is resolved **server-side** from their roles. A scope claimed by the agent request body is never trusted.
  - Scope is applied in every internal-ai read route that returns contract or request data (`contract_search`, `contract_get`, `contract_summarize`, `contract_cite`, `counterparty_memory`, `portfolio_compare`, `org_memory`, `obligations_list`, `request_list`, `renewal_advice`, and any other that reaches contracts).
  - Scope is pushed **into** the vector and Elasticsearch queries, not applied after top-k, so results are not silently thinned.
  - An integration test proves a SALES_REP cannot reach another user's contract through the internal tool routes, while an ADMIN can.
- **Worklog:**
  - **Plan (confirmed defect):** every `/internal/ai/tools/*` read route scopes by `body.orgId` only; none knows the caller. Python has the JWT's `user_id` in chat state (`orchestrator.py:719` → `get_read_tools(org_id, user_id)`) but passes it to only the write tools and `approval_list`/`matter_list`. `searchClauses` (pgvector) and `buildESQuery` filter only on org. Approach: (1) new `apps/api/src/lib/agent-scope.ts` — `resolveCallerScope(orgId, userId, resource)` looks up the user's roles from the DB (or an `apikey:<id>` principal's scopes) and runs the same `getPermissionsForRoles`/`evaluatePermission` as `requirePermission`, returning `org | own | none`. Mirrors REST exactly: only `own` narrows (team/department fall through to org, as in `contracts.ts:116`). No scope field is ever read from the body. (2) Every read route that returns contract or request data gains `userId` in its schema and applies the scope: `ownerId = userId` on contract queries (or `contract: { ownerId }` on relation queries), `requestedById = userId` on requests (same field REST uses in `requests.ts:66`), 403 when the caller lacks the view permission. Routes: contract_get, contract_search (+ semantic fallback), contract_cite, contract_validate, counterparty_memory, portfolio_search, contract_summarize, clause_search, playbook_check, redline_propose, redline_propose_batch, obligations_list, renewal_advice, org_memory (past-deal excerpts), approval_list, counterparty_get/list (contract counts/values), compliance_get, portfolio_compare, request_list. (3) Push scope into retrieval: `searchClauses(..., ownerId)` adds `AND c."ownerId" = …` to both SQL branches; ES gets an `ids` filter built from the caller's own contract ids (ES docs carry no `ownerId`; adding one needs every index path + reindex + reindex on owner change, so ids-from-Postgres is the correct-by-construction option). (4) Python: every read tool builder takes `user_id` and always sends `"userId"`; `get_read_tools` passes it through. Identity convention: **absent** `userId` key = service call (e.g. `agent.worker.ts` playbook_check) → org scope; **present** `userId` (including `null`/`"anonymous"`) must resolve to an active user or live API key of that org, else 403 — so the chat path fails closed. Acceptance per tracker. Test: `routes/agent-scope.integration.test.ts` — SALES_REP owner A cannot reach owner B's contract via contract_get/search/summarize/cite/compliance/obligations/renewal/compare/counterparty_memory/request_list; ADMIN can; unknown userId 403s; absent userId (service) sees org.
  - **Plan review:** right layer — the internal routes are the single choke point every agent read passes through, and they already own tenant scoping. Trusting a scope in the body would let a prompt-injected or buggy caller widen it; resolving from `userId` keeps the trust boundary identical to write tools (`agent-threads.ts` injects `userId` from the JWT). DB roles rather than JWT roles: slightly fresher than REST, never broader. Skill `clm-permissions-rbac` confirms `p(A.X,R.Y,S)` + `evaluatePermission` is the one evaluator to reuse. `clm-hybrid-retrieval`: scope must be applied before top-k (done in SQL/ES, not post-filter). `matter_list` returns only per-matter counts, not contract data — left as is (noted). Writes are out of scope: they go through `checkToolPermission` in `agent-threads.ts`, and SALES_REP holds no edit permission.
  - **Changed:** new `apps/api/src/lib/agent-scope.ts` (`resolveCallerScope`, `contractScopeWhere`, `scopeOwnerId`). `apps/api/src/routes/internal-ai.ts`: `scopeOr403` helper; optional `userId` on 19 read-tool schemas; scope applied in contract_get, contract_search (incl. semantic fallback + `totalMatching`), contract_cite, contract_validate, contract_summarize, clause_search, playbook_check, compliance_get, counterparty_memory, portfolio_search (dense + ES + Prisma join), portfolio_compare, redline_propose(+_batch) (visibility pre-check), obligations_list, renewal_advice, org_memory (past-deal excerpts), approval_list (step→instance→contract), counterparty_get/list (contract counts/sums), request_list (`requestedById`, VIEW:REQUEST). `lib/embeddings.ts` `searchClauses(..., ownerId)` adds `AND c."ownerId" = …` in both SQL branches. `lib/elasticsearch.ts` `SearchFilters.ids` → `{ ids: { values } }` filter; portfolio_search fills it with the caller's owned ids (most recent 10k). Python: 18 read-tool builders take `user_id` and always send `"userId"`; `tools/__init__.py` passes it.
  - **Verified:** new `routes/agent-scope.integration.test.ts` (11 cases) — **7 fail on the pre-fix code, 11 pass after** (the 4 that passed before are positive controls: own contract, ADMIN, owner, service call). It exercises the real pgvector SQL (clause rows with a fixed 1536-d vector; only the OpenAI embeddings HTTP call is stubbed). New `lib/elasticsearch.test.ts` (3) covers the ES ids filter. Full suite: db:generate, typecheck, lint (0 errors), api unit 159/159, api integration 31/31. Python: all tool files compile; an AST check confirms all 19 read tools put `"userId": user_id` in their payload and `get_read_tools` passes `user_id` to each. Acceptance: (1) scope resolved server-side from DB roles / API-key scopes, body scope ignored — tested (`scope:'org'` in body still returns 1); (2) applied in every listed route; (3) pushed into pgvector and ES before top-k; (4) SALES_REP blocked, ADMIN allowed — tested.
  - **Adversarial review (subagent):** no bypass found. All 20 scoped routes filter every query feeding the response; the LLM cannot influence `userId` (closure-bound; zod strips extra args); write/undo routes untouched; relation filters type-check as real `WhereInput`s; resolver consistent with REST (and stricter on deactivated users). Acted on: ES owned-id subset made deterministic (`orderBy updatedAt desc`).
  - **Why VERIFY-PENDING:** the Python→Node chat path was not run end to end. The agents service's Python deps aren't installed on this machine and no LLM key is configured. **Remaining check:** start the agents service and, as a SALES_REP, ask the assistant "list all contracts" and "summarise <another rep's contract id>". Expect only own contracts, and a not-found for the other. As ADMIN, expect org-wide results.
  - **Rollout note:** safe in either deploy order. Old Python + new Node sends no `userId`, so calls get org scope, which is today's behaviour. New Python + old Node: zod strips the unknown `userId`.
  - **Left out / follow-ups:** `matter_list` returns per-matter counts/metadata only (unscoped; Python doesn't send userId). `agent.worker.ts:468` calls playbook_check without the triggering user's id (harmless: REST trigger needs edit:contract). "Absent userId = org" fails open for any future Node caller that forgets it — consider an explicit service marker. Test gaps: approval_list, org_memory, counterparty_get/list, redline_propose_batch not individually asserted. Pre-existing REST/agent issues found by the review → Stretch X7–X10. **X7 (REST own-scope leak) is the most important of them.**


## S3 — Externally reachable uploads trust the client-declared MIME type

- **Status:** DONE
- **Severity:** High
- **Evidence:** the authenticated upload path sniffs magic bytes (`apps/api/src/routes/contracts.ts:393`, which comments "trust the bytes, not the client"), but portal, requests, diligence and obligations uploads do not. New-version upload (`contracts.ts:668`) and attachments (`contracts.ts:1665`) also skip the check.
- **Acceptance criteria:** every upload path validates file content the same way, reusing the existing detector from `routes/contracts.ts`; the externally reachable portal path is covered by a test; rejection messages stay user-friendly (as the existing `.doc` refusal is).
- **Worklog:**
  - **Plan (confirmed defect):** only `POST /contracts/upload` sniffs bytes (inline `detectBinaryType`, `contracts.ts:430`). These paths store the client's `part.mimetype` as the S3 `ContentType` (served back by presigned download URLs) and/or as `mimeType` on the row: `POST /contracts/:id/versions` (`contracts.ts:686`), `POST /contracts/:id/attachments` (`:1686`), `POST /portal/:token/versions` (external, checks only the declared type), `POST /requests` (declared-type allowlist), `POST /diligence/:id/upload` (none), `POST /obligations/:id/complete` evidence (none), and `POST /inbound-email` (external; picks the attachment by declared type). A declared `text/html` or `image/svg+xml` (or a PDF-labelled HTML file) is stored XSS on the storage origin, and mislabelled bytes reach the parse pipeline. Approach: move the detector into `apps/api/src/lib/file-type.ts` — `detectFileType(buf)` (PDF, DOCX = zip containing `word/`, XLSX = zip containing `xl/`, legacy DOC/OLE, PNG, JPEG, GIF, WEBP) and `checkUpload(buf, declared, allowed, label)`. Rules: a detected type must be in the path's allowlist and **replaces** the declared type; legacy .doc keeps its existing friendly refusal where it isn't allowed; content with no signature is accepted only as `text/plain`/`text/csv`, only where the path allows text, only when declared as text (or empty), and only with no NUL bytes; everything else gets a 415 naming the allowed types. Allowlists match what each path already accepted or its UI offers: contract upload, new version and diligence: PDF/DOCX/TXT (the parse pipeline's formats). Portal, requests and inbound email: PDF/DOCX. Attachments: PDF/DOCX/DOC/XLSX/TXT/CSV (`ContractDetailPage.tsx:2470`). Evidence: those plus PNG/JPEG/GIF/WEBP (modal says "PDF, image, CSV…"). Tests: unit `lib/file-type.test.ts` (signatures, spoofs, text rules) and integration `routes/portal-upload.integration.test.ts` — an HTML body declared `application/pdf` is refused with 415 by the external portal path; a real PDF gets past the type gate.
  - **Plan review:** right layer — validation at each route boundary, before any S3 write, via one shared function so paths cannot drift again. The `/upload` behaviour is preserved: same formats, same messages, same `.doc` refusal. One deliberate tightening: DOCX now needs `word/` inside the zip, so a bare zip no longer passes as DOCX (it would have failed extraction anyway). Diligence validates all files before storing any, so a bad file can't leave a half-imported batch. Inbound email now chooses the attachment by sniffed type and stores the sniffed type. No tenancy or permission change.
  - **Changed:** new `apps/api/src/lib/file-type.ts`: `detectFileType` and `checkUpload`, plus per-path allowlists and `servableContentType`. It replaces the inline detector in `contracts.ts /upload`, whose behaviour, formats and `.doc` message are unchanged. Wired into `POST /contracts/:id/versions`, `/contracts/:id/attach`, `/portal/:token/versions`, `/requests`, `/diligence/:id/upload`, `/obligations/:id/complete` (evidence) and `/inbound-email`, which now chooses the attachment by content. On every path the detected type is what is stored. `lib/document.ts`: the stored (detected) type decides which parser runs; the client filename is only a fallback for legacy rows with an unknown type. Presigned downloads (`/contracts/:id/download`, attachments, evidence) now set `ResponseContentType` to the stored type only if it is allowlisted, else `application/octet-stream`. That neutralises objects stored before this fix with a client-declared `text/html`/SVG type. Web: the diligence page lists skipped files and reasons; attachment upload failures now toast the server's reason (they previously failed silently); the new-request modal shows the server's reason.
  - **Verified:** `lib/file-type.test.ts` (12) covers signatures (real zip structures, via an in-test zip builder), spoofed HTML/SVG under every declared type, allowlist refusals, the `.doc` message, text/CSV rules, Windows CSV types and the servable-type mapping. `routes/portal-upload.integration.test.ts` (3) **failed 3/3 before the fix**: HTML declared `application/pdf` reached the storage write. After the fix all 3 pass, with MinIO reachable (201; object confirmed in the bucket; stored `mimeType` is `application/pdf` for a PDF declared `octet-stream`). A real deflate-compressed DOCX from the app's own exporter is detected as DOCX. Full suite: typecheck, lint (0 errors), api unit 171/171, web 6/6, api integration 34/34. Acceptance: every upload path validates content with one shared detector; the external portal path is tested; messages stay specific and user-facing (`Allowed: PDF, DOCX.`, the `.doc` fix-it message, per-file reasons in diligence).
  - **Adversarial review (subagent):** no way found to store HTML or SVG as a servable type on any path, and all 11 `PutObjectCommand` sites use a detected or fixed type. It found regressions in my first cut, all fixed before commit: one `.doc` failed a whole diligence batch (now skipped and reported); Windows CSV (`vnd.ms-excel`) and `octet-stream` text were refused, silently for attachments (now accepted as CSV/text where allowed, and failures toast); the zip check matched compressed bytes (now reads the central directory); PDFs with leading bytes were refused (now tolerated within 1KB, as readers do); TIFF/HEIC evidence photos were refused (now accepted); pre-fix objects were still served with their old type (presign override); the portal "real PDF" test was too loose (now asserts 201/502 and the stored type).
  - **Deliberately left out / follow-ups:** the download filename keeps the client's extension (Low). OLE containers (`.xls`, password-protected DOCX) get the `.doc` message where OLE isn't allowed (Low). Macro-enabled `.docm` passes as DOCX. Pre-existing defects found by the review and **confirmed here** → Stretch X11–X14. **X12 (all DOCX parsing broken) and X11 (Gotenberg SSRF) are high priority.**


## C1 — API keys created in the UI have no scopes and fail every request

- **Status:** VERIFY-PENDING
- **Severity:** High (advertised feature does not work at all)
- **Evidence:** the create dialog sends only `{name}` (`apps/web/src/pages/AdminIntegrationsPage.tsx:300`). A key with no scopes maps to no permissions, so every permission-gated route returns 403. 11 scopes exist server-side.
- **Acceptance criteria:** the dialog lets an admin choose scopes (and an optional expiry) and sends them; a key created through the UI can call a route its scopes allow and is refused where they do not; the one-time-reveal behaviour is unchanged.
- **Worklog:**
  - **Plan (confirmed defect):** `CreateApiKeyDialog` (`AdminIntegrationsPage.tsx:300`) posts `{ name }` only. The server stores `scopes: []`, `resolveApiScopePermissions([])` grants nothing, and every gated route 403s. The server side is otherwise correct: it validates scopes against `VALID_API_SCOPES` and supports `expiresInDays`. Approach: (1) API `GET /admin/integrations/api-key-scopes` returns `{ scopes: VALID_API_SCOPES }`, mirroring `GET /events` for webhooks, so the UI never drifts from the server vocabulary. (2) `CreateApiKeySchema.scopes` requires at least one scope, with a message that says why: an empty key is always a mistake and was the root of this bug. (3) Dialog: scope checkboxes (same pattern as the webhook event picker) and an expiry select (never / 30 / 90 / 365 days). Create stays disabled until at least one scope is chosen. The request body comes from a pure `buildCreateApiKeyBody()` in `apps/web/src/lib/api-keys.ts` (unit-tested, since web has no DOM test harness). (4) The keys table gains a Scopes column, so keys created before the fix (no scopes) are visible as such. One-time reveal untouched. Tests: `routes/api-keys.integration.test.ts` — a `contracts:read` key can `GET /contracts` and gets 403 on `PATCH /contracts/:id`; empty scopes → 400; the list never returns the key. Plus the web unit test and a browser check of the dialog if the dev stack runs.
  - **Plan review:** right layer — the server model is sound; the defect is the client not sending scopes. Requiring ≥1 scope is a tightening of a public admin endpoint; no caller in the repo (scripts, tests, web) creates keys without scopes except the broken dialog. Permissions: the endpoint sits behind `configure:organization` like its siblings. No tenancy change.
  - **Changed:** `apps/api/src/routes/integrations.ts`: new `GET /api-key-scopes`; `scopes` now requires at least one (empty or omitted → 400). `apps/web/src/lib/api-keys.ts`: `buildCreateApiKeyBody` and the expiry options. `AdminIntegrationsPage.tsx`: the dialog gains a scope picker (checkboxes, fetched from the server), an expiry select (never / 30 / 90 / 365 days), and Create is disabled until a name and at least one scope are chosen. The keys table gains a Scopes column that flags scope-less keys ("none — can't call any endpoint"). One-time reveal unchanged.
  - **Verified:** `routes/api-keys.integration.test.ts` (4) fails 2/4 before the fix (no vocabulary endpoint; the scope-less key was accepted). The 2 that passed are the pre-existing server model: a `contracts:read` key reads (200) and is refused on PATCH (403). All 4 pass after. `apps/web/src/lib/api-keys.test.ts` (4) covers the request body, including scopes, expiry and refusal without scopes. Full suite: typecheck, lint (0 errors), api unit 171/171, web 10/10, api integration 38/38.
  - **Why VERIFY-PENDING:** the dialog was not checked in a browser. There is no local `.env` for the dev API (only production `env.api.yaml`), and signing in would mean entering a password, which this run does not do. **Remaining check (≈1 min):** Admin → Integrations → New API key. The scope checkboxes list 11 scopes, the expiry select works, Create is disabled until a scope is ticked, the created key shows its scopes in the table, and the reveal modal still shows the full key once.
  - **Follow-up:** existing scope-less keys created through the old dialog still exist. The new Scopes column makes them visible; admins should revoke and re-issue them.


## C2 — Approvals can be stranded, undercounted and hidden from oversight

- **Status:** TODO
- **Severity:** High
- **Evidence:** three related defects.
  1. If a step escalates and no `escalateTo` user is set (the builder's default), the step becomes `ESCALATED`: it leaves every queue, `/decide` returns 403, and there is no withdraw path, so the contract is stuck in `PENDING_APPROVAL` (`apps/api/src/workers/notification.worker.ts`).
  2. First-step approvals are undercounted — the dashboard uses `GREATEST(currentStepOrder,1)` and `/approvals/all` assumes steps start at 1, but the builder and seed data number steps from 0.
  3. `ESCALATED` instances are excluded from `/approvals/all` and the analytics pending count.
- **Acceptance criteria:** an escalation with no target has a defined, tested behaviour (keep the original approver in the queue and notify an admin, rather than orphaning the instance); step numbering is consistent end to end and counts match reality; escalated instances appear in admin oversight views; tests cover an escalation with no `escalateTo` and a step-0 workflow. Related tests live in `apps/api/src/routes/approvals.integration.test.ts` and `apps/api/src/lib/workflow-engine.test.ts`.
- **Worklog:**

## C3 — `/agent` hard-codes a model and overrides the org's AI config

- **Status:** TODO
- **Severity:** High (the "bring your own model" promise silently fails, and it bills the wrong model)
- **Evidence:** `apps/web/src/pages/AgentHomePage.tsx` pins `openai/gpt-4.1-mini`, outranking Admin → Org → AI Config. A related fix already landed for unpinned chat requests; the full-page assistant still pins.
- **Acceptance criteria:** with no explicit user choice, `/agent` turns run on the org's configured provider/model for the tier; an explicit in-session pin (if the UI offers one) is still honoured; the "which model answered" readout shows the model actually used.
- **Worklog:**

## C4 — Re-analysis wipes the contract's stored reports

- **Status:** TODO
- **Severity:** High (silent data loss)
- **Evidence:** re-analysis replaces the whole `metadata` blob (`apps/agents/app/routes/review.py:237-238` → `apps/api/src/routes/contracts.ts:1086`), erasing the compliance report, renewal advice and binder-split markers.
- **Acceptance criteria:** re-extraction merges into `metadata` instead of replacing it, preserving every `_`-prefixed report; a test proves a compliance report survives a re-analyze; the reports still refresh when their own job re-runs.
- **Worklog:**

## C5 — The review queue is unreachable, and its corrections don't stick

- **Status:** TODO
- **Severity:** High (this is the human-verification loop for AI data)
- **Evidence:** `apps/web/src/pages/ReviewQueuePage.tsx` is routed at `/review-queue` but nothing in the app links to it. "Correct" updates only the key-terms record, so the `effectiveDate`, `expiryDate` and `value` that the contracts list and renewals read keep the wrong value. "Reject" is labelled "clear the value" but only sets confidence to 0.
- **Acceptance criteria:** the queue is reachable from the navigation (and ideally from a low-confidence badge on the contract); a correction writes through to the canonical contract fields, so the list and renewals show the corrected value; the reject action matches its label or the label matches the behaviour; a test covers write-through.
- **Worklog:**

## C6 — Renewal alerts miss notice periods longer than 90 days

- **Status:** TODO
- **Severity:** High (this is the failure mode CLM buyers care most about)
- **Evidence:** the auto-renew notice deadline is computed only in the browser (`apps/web/src/pages/RenewalsPage.tsx`), and the daily scan alerts on expiry within a 90-day window, so a contract with a 120-day notice period is flagged after the opt-out date has passed.
- **Acceptance criteria:** the notice deadline is computed server-side from `expiryDate` and `noticePeriodDays` and stored or derived consistently; the scan alerts on the **notice deadline**, not just expiry; a contract with a 120-day notice period produces an alert before its deadline; a test covers it.
- **Worklog:**

## C7 — Clause-flag filters are dead in the contracts list

- **Status:** TODO
- **Severity:** Medium-High
- **Evidence:** `ContractVersion.clauseFlags` exists and Elasticsearch supports filtering on it (`apps/api/src/lib/elasticsearch.ts:208`), but the flags are never written to the index, so every count is 0 and the UI hides the filters (`apps/web/src/pages/ContractsPage.tsx:531`).
- **Acceptance criteria:** flags are indexed on every path that indexes a contract (see the `clm-hybrid-retrieval` skill for the list of create paths and the `indexContract` contract); the filters appear with real counts; the existing backfill script re-indexes historical contracts; the index-on-create tripwire test still passes.
- **Worklog:**

## C8 — The Negotiate tab's AI redline analysis is broken

- **Status:** TODO
- **Severity:** Medium-High
- **Evidence:** `apps/agents/app/routes/redline.py:41-75` calls the API without an `x-org-id` header, so auth resolves the org to `'system'` and the org-scoped diff route (`apps/api/src/routes/contracts.ts:1884`) returns 404. It also fetches `GET /api/v1/playbook`, a route that does not exist, so it would score against an empty playbook. `apps/agents/app/routes/approval.py` documents the same header bug and fixes it correctly — copy that pattern.
- **Acceptance criteria:** the analysis returns real per-change advice on a contract with two versions; headers follow the internal-service convention (`x-internal-secret`, `x-internal-service`, `x-org-id` — see the `clm-debug-multilayer` skill); the playbook fetch hits a route that exists; failures surface as structured errors instead of empty successes.
- **Worklog:**

## C9 — `redline_apply` sends a variant name the API rejects

- **Status:** TODO
- **Severity:** Medium
- **Evidence:** `apps/agents/app/tools/redline_apply.py` tells the model to pass `'conservative'`, but the Node schema accepts only `least | moderate | aggressive`, so the call 400s. The UI labels the same tier "least".
- **Acceptance criteria:** one vocabulary across the Python tool, the Node schema and the UI labels; a test or probe covers applying each variant.
- **Worklog:**

## C10 — Binder re-split duplicates children, and DOCX binders fail opaquely

- **Status:** TODO
- **Severity:** Medium
- **Evidence:** re-splitting never deletes the first set of children (`apps/api/src/workers/parse.worker.ts:218`), so they accumulate. A DOCX flagged as a binder fails because splitting is PDF-only. Detection reads only the first 10,000 characters (`apps/agents/app/routes/detect_binder.py`), so later agreements are missed.
- **Acceptance criteria:** re-splitting replaces the previous children (or refuses with a clear message) and never duplicates; a DOCX binder either splits or reports a clear, actionable message instead of failing; widening the detection window is optional — if skipped, note it as a follow-up rather than silently leaving it.
- **Worklog:**

## C11 — Agent retrieval returns superseded versions and diligence-room documents

- **Status:** TODO
- **Severity:** Medium-High (wrong answers that look right)
- **Evidence:** clause vectors are matched across all versions with no current-version filter (`apps/api/src/lib/embeddings.ts:343-381`), and diligence-room contracts are hidden only from the contracts list and export, not from search or agent answers.
- **Acceptance criteria:** retrieval returns only the current version's clauses by default; diligence-room documents are excluded from ordinary search and agent answers (room-scoped access stays possible); a test covers a contract with three versions returning only the latest.
- **Worklog:**

## C12 — Chat drafting ignores what the user asked for

- **Status:** TODO
- **Severity:** Medium
- **Evidence:** `contract_create_from_template` does not use the drafting pipeline. `apps/api/src/routes/internal-ai.ts:~3863-3920` guesses the contract type from keywords, takes the newest published template of that type (so untyped templates are never used) and hardcodes California law, a 2-year term and today's date whatever the user asked. It also creates the contract inline, with no confirmation card and no undo, unlike the other six write tools.
- **Acceptance criteria:** the tool either routes through `draft_agent` (which fills variables from intent) or passes the user's stated terms through instead of hardcoded defaults; it goes behind the same confirm-and-undo card as other write tools; the tool description matches what it does.
- **Worklog:**

## C13 — A lost parse job leaves a contract PENDING forever

- **Status:** TODO
- **Severity:** Medium
- **Evidence:** `IN_PROGRESS_STATUSES` in `apps/api/src/workers/index.ts` omits `PENDING`, so the stuck-job sweep never recovers a job that was never enqueued. The known-gaps note explains why it was left out: at the current 5-minute threshold, a queue backlog would mark healthy contracts FAILED.
- **Acceptance criteria:** PENDING is swept with its own, longer threshold (choose one and write down the reasoning), so a lost job surfaces as FAILED with a retry path; a backlog of freshly queued contracts is not marked FAILED; a test covers both.
- **Worklog:**

## V1 — Render the playbook review that already runs on every contract

- **Status:** TODO
- **Severity:** High value, low effort
- **Evidence:** after extraction, a job scores every clause against the org's playbook and writes findings, severity, alignment and a human-gate flag to `metadata._playbookReview` (`apps/api/src/workers/parse.worker.ts:211` → `agent.worker.ts:563` → `apps/agents/app/agents/playbook_review_agent.py`). `GET /contracts/:id/playbook-review` exists. Nothing in `apps/web` references it.
- **Acceptance criteria:** a rail section on the contract page renders the stored review in document order, mirroring `ComplianceRailSection.tsx`, which already reads a `metadata._*` report in this shape; each finding shows severity and links to its clause; an empty state explains when no playbook positions exist.
- **Worklog:**

## V2 — Stop answers overstating their own completeness

- **Status:** TODO
- **Severity:** High (this is the product's core promise)
- **Evidence:** `portfolio_search` returns at most 30 fused hits with no total; `renewal_advice` truncates at 50 rows, sorted oldest first, with no total; `contract_search` has no date-range or value-range filter (`apps/api/src/routes/internal-ai.ts`, tool contracts around `:255-268`, `:484-493`, `:857-889`, `:3318-3365`). So "which contracts…" answers are samples presented as if complete.
- **Acceptance criteria:**
  - `portfolio_search` and `renewal_advice` return a total matching count alongside the returned rows.
  - The assistant states coverage in the answer ("showing the top 30 of 214 matches" or "this is a sample, not a complete list") — enforce it in the system prompt **and** make the tool output carry the numbers so the model cannot omit them.
  - `contract_search` accepts date-range and value-range filters (the fields are already on the model) so "expiring in the next 90 days" is answered by a filter rather than a sample.
  - An eval or probe covers one set question and asserts the coverage statement appears.
- **Note:** this is the smallest step toward complete portfolio answers. It does **not** attempt the full per-document scan; do not expand scope here.
- **Worklog:**

## H1 — Marketing site claims things the product does not do

- **Status:** TODO
- **Severity:** High (public, and a trust/credibility risk)
- **Evidence:** the Security page claims JWT **RS256** (the code uses HS256), "matter-scoped" permissions and "composable roles" (neither exists), an "append-only" audit log (it is hash-chained, with no DB-level append-only guarantee and no viewer) and GDPR data-export/deletion endpoints (none exist). Elsewhere the site claims Salesforce/HubSpot/SAP/NetSuite sync (no code), "Slack and Teams approvals" (Teams is outbound links only) and capturing requests from Slack (the Slack command only searches). The EmailCapture form posts to the wrong path, omits required fields and reports success on failure. The contact form saves submissions but emails no one.
- **Acceptance criteria:** every claim on the marketing site is true of the current code, or is clearly marked as planned; the EmailCapture form either works against the real endpoint or is removed; the contact form's behaviour matches what users are told. Keep the edit surgical — this is a truth pass, not a redesign.
- **Worklog:**

## H2 — Half the advertised webhook events never fire

- **Status:** TODO
- **Severity:** Medium
- **Evidence:** subscribers can choose 16 events; 8 never fire — `contract.updated`, `contract.expired`, `signature.voided`, `approval.decided`, `obligation.extracted`, `obligation.overdue`, `invoice.created`, `amendment.created`. The matching Slack/Teams cards never fire either.
- **Acceptance criteria:** either each event is emitted at its real trigger point (preferred where the trigger already exists in code) or it is removed from the subscribable list; the list a user sees matches what can actually arrive; a test asserts the advertised set equals the emitted set.
- **Worklog:**

## H3 — README, CHANGELOG and BUILD_TRACKER describe a different product

- **Status:** TODO
- **Severity:** Medium
- **Evidence:** README says "seven specialist agents … on a LangGraph orchestrator" (there are 8; chat is a single hand-written tool loop that never routes to them; 3 have no UI); "every clause, date, and dollar is … cited to the source page" (citations are section-level, with no page jump); portfolio "pricing benchmarks" (no benchmarking logic exists). CHANGELOG claims "durable Yjs collab persistence" (state is stored, but the editor is not connected). BUILD_TRACKER marks as done: an admin UI to create roles (the page is read-only), an admin settings panel (3 of 5 tabs say "Coming soon"), an "Ask AI tab" (deleted), and still lists PAdES signing as deferred although it shipped. `scripts/evals/README.md` says tier 2 blocks every PR; CI runs tier 1 only.
- **Acceptance criteria:** these documents describe what the code does today; where something is aspirational, it is labelled as such. Do not delete history from CHANGELOG — correct it in place with a note.
- **Worklog:**

---

## Stretch (only if everything above is `DONE`, `VERIFY-PENDING` or `NOT-REPRODUCIBLE`)

- **X1 — Page-jump citations.** Citation pills open the original PDF at the stored page and highlight the stored bounding box, instead of scrolling to a matching heading. The page and bbox are already stored and unused (`apps/web/src/components/agent/CitationPills.tsx`).
- **X2 — Custom-field backfill.** Adding a field only affects future uploads; there is no bulk re-extract (`apps/api/src/routes/field-definitions.ts:56-76`). Add a resumable backfill job, and stop dropping confidence and quotes for custom fields (`apps/agents/app/routes/review.py:231`).
- **X3 — Empty stubs.** `apps/api/src/routes/admin-audit.ts`, `routes/metrics.ts` and `lib/error-reporter.ts` are explicit stubs, so there is no audit viewer, no metrics endpoint and no error reporting. Implement the minimum useful version of each, or remove them and the docs that promise them.

- **X4 — Lost-update race on `organization.settings`.** `PATCH /organization` and `POST /organization/install-industry-pack` (which awaits the multi-query `seedOrgDefaults` between read and write) read the whole settings blob and write it back, so they can silently undo a concurrent Slack secret rotation/disconnect in `integrations.ts`. Merge atomically in SQL (`settings || $1::jsonb`, `jsonb_set`) or move Slack credentials out of `settings`. (Found in S1 review.)
- **X5 — `PATCH /organization` lets `configure:integration` (LEGAL_OPS) set `piiRedactionMode`**, turning off PII redaction org-wide, and writes no audit event. Gate security-relevant keys behind `configure:organization` and audit the change. (Found in S1 review.)
- **X6 — Slack `teamId` is not unique across orgs.** `PUT /integrations/slack` does not check collisions and `lib/slack.ts` `findOrgBySlackTeam` uses `findFirst` with no ordering, so one org can claim another's team id and break its Slack integration (DoS, no data crossing). (Found in S1 review.)
- **X7 — REST ignores `own` scope outside the contract list (High).** A SALES_REP gets org-wide data from `POST /search/ask` (`search.ts:213`, verbatim clause text — now a one-line fix: pass `ownerId` to `searchClauses`), `/search`, `/search/advanced`, `/search/facets`, `GET /contracts/:id` (all versions' `plainText`), `/contracts/:id/ask`, `GET /contracts/export` (CSV, 5k rows), `GET /counterparties/:id` and `GET /matters/:id`. Only `GET /contracts` and the requests list honour it. The UI therefore exposes what S2 closed in the agent. Apply `req.permissionScope === 'own'` (reuse `contractScopeWhere` / ES `ids` from S2) on each. (Found in S2 review.)
- **X8 — Agent chat session history is not bound to user/org.** `agents.ts:179` forwards the client's `sessionId` unchecked; Python keys history as `session:{id}` (`memory.py:27`) and replays prior tool results, and `GET /matters/:id` exposes other users' thread ids — so a user can replay another user's (incl. org-scope, cross-org) tool output. Bind the session key to `orgId:userId`, and purge `session:*` after deploying S2 (pre-fix sessions hold org-wide results for 24h). (Found in S2 review.)
- **X9 — Agent tools check `view:contract` where REST checks a different permission.** `org_memory` / `playbook_check` return playbook positions (walkaway language) to roles without `view:playbook`; `approval_list scope:'all'` returns the org approval queue (incl. `aiSummary`) to roles without `view:workflow`. (Found in S2 review.)
- **X10 — Write tools ignore permission scope.** `checkToolPermission` (`agent-threads.ts:63-89`) checks grant only, so a custom role with own-scope `edit:contract` can `contract_update`/`approval_route`/`comment_add`/`redline_apply` any org contract. No default role affected. (Found in S2 review.)
- **X11 — Text→HTML conversion does not escape, and Gotenberg renders it server-side (High).** `lib/document.ts` builds `<pre>${text}</pre>` (TXT) and `<p>${block}</p>` (PDF) unescaped, and `apps/agents/app/routes/extract.py:282-287` does the same for headings. So `<img src=x onerror=…>` in an uploaded TXT lands verbatim in `htmlContent`. The web app sanitizes (DOMPurify/TipTap), but Gotenberg renders `htmlContent` with JavaScript enabled (`seal-contract.ts:96` for file-less versions, `contracts.ts:774` `/:id/html-version`). That is SSRF from the render container; in self-host, Elasticsearch (security disabled) sits on the same network. Escape in the builders; consider disabling JS / network in Gotenberg renders. (Found in S3 review.)
- **X12 — DOCX extraction is broken app-wide (High).** `mammoth@1.12.0` + `@xmldom/xmldom@0.9.10` (root override `>=0.8.13` resolves to 0.9.x): every `extractDocx` throws `DOMParser.parseFromString: the provided mimeType "undefined" is not valid.` Reproduced here with a DOCX generated by the app's own `generatePlainDocx`. Every DOCX upload fails parsing, and `/templates/upload` always 422s. The fix is a dependency constraint (cap the override below 0.9, or move mammoth to a release compatible with xmldom 0.9), so it needs a lockfile change. (Found in S3 review; verified.)
- **X13 — DOCX zip bomb.** A 714KB DOCX passes the content check and inflates to about 960MB in JSZip before erroring: a memory DoS on the parse worker, reachable from the external portal. It is currently masked by X12. Cap the total uncompressed size (central-directory sizes) before handing the file to mammoth. (Found in S3 review.)
- **X14 — Inbound email edge cases (Low).** `inbound-email.ts:92` sets `limits.files`, so a sixth file part throws `FilesLimitError` (413) and the `continue` at `:96` is dead code: emails with many inline images are rejected. The 25MB check runs after the attachment is chosen, so an oversized first document 413s instead of trying the next. (Found in S3 review.)

---

## Run log

Append one line per task as it completes: `<task id> — <status> — <one-line summary> — <commit sha>`.
S1 — DONE — GET /organization redacts Slack secrets; PATCH can't overwrite server-managed keys; checklist stops echoing settings — cca7b19
S2 — VERIFY-PENDING — agent read tools resolve the caller's view scope server-side and push it into Prisma, pgvector and ES; needs a live SALES_REP chat probe — 701b0b5
S3 — DONE — every upload path validates bytes via lib/file-type.ts; detected type stored; presigned downloads serve only allowlisted types — 4b91cbc
C1 — VERIFY-PENDING — create-key dialog sends chosen scopes + expiry; server refuses scope-less keys; needs a visual check of the dialog — (sha: C1)
