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

- **Status:** DONE
- **Severity:** High (advertised feature does not work at all)
- **Evidence:** the create dialog sends only `{name}` (`apps/web/src/pages/AdminIntegrationsPage.tsx:300`). A key with no scopes maps to no permissions, so every permission-gated route returns 403. 11 scopes exist server-side.
- **Acceptance criteria:** the dialog lets an admin choose scopes (and an optional expiry) and sends them; a key created through the UI can call a route its scopes allow and is refused where they do not; the one-time-reveal behaviour is unchanged.
- **Worklog:**
  - **Plan (confirmed defect):** `CreateApiKeyDialog` (`AdminIntegrationsPage.tsx:300`) posts `{ name }` only. The server stores `scopes: []`, `resolveApiScopePermissions([])` grants nothing, and every gated route 403s. The server side is otherwise correct: it validates scopes against `VALID_API_SCOPES` and supports `expiresInDays`. Approach: (1) API `GET /admin/integrations/api-key-scopes` returns `{ scopes: VALID_API_SCOPES }`, mirroring `GET /events` for webhooks, so the UI never drifts from the server vocabulary. (2) `CreateApiKeySchema.scopes` requires at least one scope, with a message that says why: an empty key is always a mistake and was the root of this bug. (3) Dialog: scope checkboxes (same pattern as the webhook event picker) and an expiry select (never / 30 / 90 / 365 days). Create stays disabled until at least one scope is chosen. The request body comes from a pure `buildCreateApiKeyBody()` in `apps/web/src/lib/api-keys.ts` (unit-tested, since web has no DOM test harness). (4) The keys table gains a Scopes column, so keys created before the fix (no scopes) are visible as such. One-time reveal untouched. Tests: `routes/api-keys.integration.test.ts` — a `contracts:read` key can `GET /contracts` and gets 403 on `PATCH /contracts/:id`; empty scopes → 400; the list never returns the key. Plus the web unit test and a browser check of the dialog if the dev stack runs.
  - **Plan review:** right layer — the server model is sound; the defect is the client not sending scopes. Requiring ≥1 scope is a tightening of a public admin endpoint; no caller in the repo (scripts, tests, web) creates keys without scopes except the broken dialog. Permissions: the endpoint sits behind `configure:organization` like its siblings. No tenancy change.
  - **Changed:** `apps/api/src/routes/integrations.ts`: new `GET /api-key-scopes`; `scopes` now requires at least one (empty or omitted → 400). `apps/web/src/lib/api-keys.ts`: `buildCreateApiKeyBody` and the expiry options. `AdminIntegrationsPage.tsx`: the dialog gains a scope picker (checkboxes, fetched from the server), an expiry select (never / 30 / 90 / 365 days), and Create is disabled until a name and at least one scope are chosen. The keys table gains a Scopes column that flags scope-less keys ("none — can't call any endpoint"). One-time reveal unchanged.
  - **Verified:** `routes/api-keys.integration.test.ts` (4) fails 2/4 before the fix (no vocabulary endpoint; the scope-less key was accepted). The 2 that passed are the pre-existing server model: a `contracts:read` key reads (200) and is refused on PATCH (403). All 4 pass after. `apps/web/src/lib/api-keys.test.ts` (4) covers the request body, including scopes, expiry and refusal without scopes. Full suite: typecheck, lint (0 errors), api unit 171/171, web 10/10, api integration 38/38.
  - **Why VERIFY-PENDING:** the dialog was not checked in a browser. There is no local `.env` for the dev API (only production `env.api.yaml`), and signing in would mean entering a password, which this run does not do. **Remaining check (≈1 min):** Admin → Integrations → New API key. The scope checkboxes list 11 scopes, the expiry select works, Create is disabled until a scope is ticked, the created key shows its scopes in the table, and the reveal modal still shows the full key once.
  - **Live check (final sweep, signed in to the local stack):** passed.
    - The dialog offers the 11 scopes ("Choose at least one") and expiry (Never, 30 days, 90 days, 1 year). Create key stays disabled until a name and a scope are set.
    - Creating "C1 visual check" (`contracts:read`, 30 days) returned 201 and showed the one-time reveal ("This is the only time you'll see the full key…"). The list shows the name, prefix only, scope, Created by "Admin User" (X43) and Active.
    - The stored key has `{contracts:read}` and a 30-day expiry, and `API_KEY_CREATED` is audited.
    - Revoking it through the in-app confirmation turned it Revoked.
    - The key itself wasn't used to call the API, because it's a credential. `api-keys.integration.test.ts` shows a key created by this route is honoured and refused by its scopes.
  - **Follow-up:** existing scope-less keys created through the old dialog still exist. The new Scopes column makes them visible; admins should revoke and re-issue them.


## C2 — Approvals can be stranded, undercounted and hidden from oversight

- **Status:** DONE
- **Severity:** High
- **Evidence:** three related defects.
  1. If a step escalates and no `escalateTo` user is set (the builder's default), the step becomes `ESCALATED`: it leaves every queue, `/decide` returns 403, and there is no withdraw path, so the contract is stuck in `PENDING_APPROVAL` (`apps/api/src/workers/notification.worker.ts`).
  2. First-step approvals are undercounted — the dashboard uses `GREATEST(currentStepOrder,1)` and `/approvals/all` assumes steps start at 1, but the builder and seed data number steps from 0.
  3. `ESCALATED` instances are excluded from `/approvals/all` and the analytics pending count.
- **Acceptance criteria:** an escalation with no target has a defined, tested behaviour (keep the original approver in the queue and notify an admin, rather than orphaning the instance); step numbering is consistent end to end and counts match reality; escalated instances appear in admin oversight views; tests cover an escalation with no `escalateTo` and a step-0 workflow. Related tests live in `apps/api/src/routes/approvals.integration.test.ts` and `apps/api/src/lib/workflow-engine.test.ts`.
- **Worklog:**
  - **Plan (confirmed, all three):** (1) `notification.worker.ts handleEscalate`: with no `escalateTo`, the step **and** the instance become `ESCALATED`. `/my-queue` and `/decide` only accept `PENDING` steps, and nothing withdraws, so the contract sits in `PENDING_APPROVAL` forever. (2) The engine is base-agnostic: an instance starts at the definition's first `order` and advances +1, and `/my-queue` matches `stepOrder === currentStepOrder`. But `dashboard.ts:125` (`GREATEST(currentStepOrder,1)`) and `approvals.ts /all` (`cur > 0 ? cur : 1`) coerce 0→1, so every step-0 approval (the builder's and the seed's default) is missing from the approver's badge and shows no current step/approver in oversight. `/all` also returns the raw order as "step N". (3) `/all`, the dashboard org count and `analytics.ts` pending count ignore `ESCALATED` instances. Approach: move `handleEscalate` to `apps/api/src/lib/approval-escalation.ts` so it can be tested without constructing the BullMQ worker (the same pattern as `lib/notification-delivery.ts`). With no target, the step stays `PENDING` with the original approver (still in their queue and decidable), the approver is re-notified, and the org's admins are notified that it is overdue with no escalation target. Nothing is marked `ESCALATED`. Step order: exact `stepOrder = currentStepOrder` everywhere. `/all` additionally returns a 1-based `currentStepPosition` and `stepCount` from the workflow definition, and `ApprovalsPage` labels with those. `ESCALATED` is included in `/all` and both pending counts, for legacy rows. A data migration repairs instances already stranded (orphaned `ESCALATED` step → `PENDING`, instance → `PENDING`). Tests: integration tests for escalation with no target (the approver can still decide; admins are notified), step-0 workflow counts on dashboard and `/all`, and the repair SQL against a stranded fixture.
  - **Plan review:** the escalation behaviour is what the tracker asks for ("keep the original approver in the queue and notify an admin"). The escalate-with-target path is unchanged. The migration touches only rows the old no-target branch produced: an `ESCALATED` instance can only come from that branch, and its step has no later replacement at the same order. Tenancy: every query stays org-scoped; the admin lookup is `orgId`-filtered. No permission change. `/all` keeps the `totalSteps` semantics the UI's "unrouted" check depends on; the new fields are additive.
  - **Changed:** new `apps/api/src/lib/approval-escalation.ts` (`handleEscalate`, moved out of `notification.worker.ts`, which now imports it; notifier injectable for tests). With no `escalateTo`, the step stays `PENDING` with its approver; the approver is re-notified and up to 10 active org ADMINs are notified ("overdue — no escalation target; delegate or set a target"); the audit event records `adminsNotified`. Escalating to a named user is unchanged. `approvals.ts /all` includes `ESCALATED` instances, matches the current step exactly, and adds `currentStepPosition` (1-based) and `stepCount` from the workflow definition. `dashboard.ts`: approver badge matches `stepOrder = currentStepOrder` (the `GREATEST(…,1)` is gone); the org pending count includes `ESCALATED`. `analytics.ts` pending count now covers `PENDING | IN_PROGRESS | ESCALATED`, matching the dashboard. `ApprovalsPage.tsx` labels "step N of M" from the new fields. Migration `20260923000000_repair_stranded_escalations` (data only) hands already-stranded steps back to their approvers and reopens their instances. Test support: `cleanupAll` also deletes org-scoped roles.
  - **Verified:** 5 new cases in `routes/approvals.integration.test.ts`: no-target escalation (still queued, decidable to APPROVED, admin + approver notified), named-target escalation still reassigns, a step-0 approval on the dashboard and in `/all` as step 1 of 1 with approver name, escalated instance in `/all` and in analytics pending, and the repair migration un-strands a legacy fixture. With the route fixes stashed and the old no-target branch restored, **the three defect cases fail** (3 failed / 5 passed); all 8 pass with the fix. The migration is applied to the test DB via `migrate deploy`, as CI does. Full suite: typecheck, lint (0 errors), api unit 171/171 (incl. `workflow-engine.test.ts`), web 10/10, api integration 43/43.
  - **Deploy note:** the repair migration runs with `db:migrate:prod` on deploy. Local dev DBs need `pnpm db:migrate`.
  - **Left out:** `/all`'s `totalSteps` still counts only pending steps; the UI's "unrouted" check depends on it, and the label no longer uses it.


## C3 — `/agent` hard-codes a model and overrides the org's AI config

- **Status:** DONE (VERIFY-PENDING → DONE after the live check below)
- **Severity:** High (the "bring your own model" promise silently fails, and it bills the wrong model)
- **Evidence:** `apps/web/src/pages/AgentHomePage.tsx` pins `openai/gpt-4.1-mini`, outranking Admin → Org → AI Config. A related fix already landed for unpinned chat requests; the full-page assistant still pins.
- **Acceptance criteria:** with no explicit user choice, `/agent` turns run on the org's configured provider/model for the tier; an explicit in-session pin (if the UI offers one) is still honoured; the "which model answered" readout shows the model actually used.
- **Worklog:**
  - **Plan (confirmed defect):** `AgentHomePage.tsx:667-668` sends `provider: 'openai', modelId: 'gpt-4.1-mini'` on every turn. Python treats an explicit pin as outranking the org's tier ladder, so `/agent` ignores Admin → AI Config (the side rail stopped pinning in an earlier fix). There is also a readout bug: `chat.py` stamps every frame with the **requested** `provider`/`model_id`, and only the `done` frame carries the resolved `provider`/`model`/`tier`, yet the page reads `evt.model_id ?? evt.model`, preferring the request. The page also never persists which model answered, so reloaded threads show none. The UI offers no model picker, so there is no in-session pin to preserve. Approach: new `apps/web/src/lib/agent-chat.ts` with `buildAgentChatBody()` (no provider/model unless an explicit pin is passed, which keeps the door open for a future picker) and `readProvenance()` (the done frame's resolved values win over the per-frame request stamp). AgentHomePage uses both, and persists `provider`/`model`/`tier` with the turn as the side rail does. Test: `lib/agent-chat.test.ts`.
  - **Plan review:** right layer — the server already resolves unpinned turns from the org's config (the same path the side rail uses), so the fix is to stop pinning. The old comment's reason for pinning (gpt-4o's `query="*"` quirk) is handled server-side: `contract_search` treats `*`/`%`/`all` as match-all (`internal-ai.ts`). No permission or tenancy impact; the model choice stays server-side and per-org.
  - **Changed:** new `apps/web/src/lib/agent-chat.ts` (`buildAgentChatBody`, `readProvenance`). `AgentHomePage.tsx` no longer pins `openai/gpt-4.1-mini`. The provenance footer takes the `done` frame's resolved provider/model/tier over the per-frame request stamp, and the persisted turn now carries `provider`/`model`/`tier` (as the side rail's does), so reloaded threads keep the readout.
  - **Verified:** `lib/agent-chat.test.ts` (4) covers: no provider/model in the body without an explicit pin; an explicit pin passes through; the resolved model beats the requested stamp; unpinned turns end with the resolved model. These fail before the change because the module does not exist; the old page hard-coded the pin inline. No other web surface pins a model (grep). Full suite green: typecheck, lint 0 errors, web 14/14, api unit 171/171, api integration 43/43.
  - **Why VERIFY-PENDING:** a live `/agent` turn was not run (no agents service or LLM key here). **Remaining check:** set Admin → Org → AI Config default tier to a non-OpenAI model, ask `/agent` a question, and confirm the footer shows that model. Reload the thread and confirm the footer persists.
  - **Live check (2026-09-23, signed in to the local stack; agents service on :8003 running this branch, Gemini):** the org's only configured key is Google's, so an answer from the old pin (`openai/gpt-4.1-mini`) couldn't happen. A `/agent` question was answered with the footer "Machine-authored · gemini-2.5-flash", and the stored turn names provider google, model gemini-2.5-flash, tier default. Reopening the thread later still showed the footer.
  - **Assumption:** the page has no model picker, so "an explicit in-session pin is still honoured" is satisfied by `buildAgentChatBody({ pin })`, which is ready for one but has no UI.


## C4 — Re-analysis wipes the contract's stored reports

- **Status:** DONE
- **Severity:** High (silent data loss)
- **Evidence:** re-analysis replaces the whole `metadata` blob (`apps/agents/app/routes/review.py:237-238` → `apps/api/src/routes/contracts.ts:1086`), erasing the compliance report, renewal advice and binder-split markers.
- **Acceptance criteria:** re-extraction merges into `metadata` instead of replacing it, preserving every `_`-prefixed report; a test proves a compliance report survives a re-analyze; the reports still refresh when their own job re-runs.
- **Worklog:**
  - **Plan (confirmed defect):** `review.py` sends `{"metadata": metadata_update}` (only the extraction's keys) to `PATCH /contracts/:id`, which passes `body.metadata` straight to `prisma.contract.update`. JSON columns are replaced, so `_compliance`, `_playbookReview`, `_renewal…`, `_binderDetected`/`_splitInto`, `_obligations` and the redline reports are erased. The same wipe happens in `redline.py`'s failure path, which PATCHes `{"metadata": {"_redlineStatus": "FAILED", …}}`. Approach: fix the route, the layer every caller shares. `PATCH /contracts/:id` merges `metadata` into the stored object, with `null` deleting a key (JSON-merge-patch at the top level). The web never sends `metadata`; `redline.py` success already sends a merged object, which stays idempotent. So that the extraction's **own** reports still refresh, `review.py` sends `_typeFields`/`_aiFindings` as `None` when a re-run produces none (clears stale values). Other reports are untouched and refresh when their own job writes them. Test: `routes/contract-metadata.integration.test.ts` — an internal-service PATCH (the agents' headers) of an extraction-shaped metadata keeps `_compliance`, `_playbookReview`, binder markers and custom values; a `null` key is deleted; a `_redlineStatus`-only PATCH no longer wipes the blob.
  - **Plan review:** merge semantics are the only reading consistent with how every caller uses this route today; no caller relies on replace-to-delete, and `null` preserves an explicit delete. Public API clients that PATCH `metadata` now get merge semantics, which is safer (no silent data loss) — noted as a behaviour change. No tenancy or permission change: same route, same guard.
  - **Changed:** `apps/api/src/routes/contracts.ts` `PATCH /:id` shallow-merges `body.metadata` into the stored object, and a `null` value deletes its key. `apps/agents/app/routes/review.py`: on a run that produced output, sends `_typeFields`/`_aiFindings` as `None` when it didn't produce them, so the extraction's own stale outputs clear. A failed run leaves the previous ones alone.
  - **Verified:** new `routes/contract-metadata.integration.test.ts` (4) uses the agents service's exact headers (`x-internal-service: agents`, `x-internal-secret`, `x-org-id`) and an extraction-shaped body. **3 defect cases fail before the fix**: `_compliance`, `_playbookReview`, binder markers and a custom value were erased; `null` couldn't delete; the redline failure path wiped the blob. All 4 pass after. Full suite: typecheck, lint (0 errors), api unit 171/171, api integration 47/47. `review.py` compiles; the Python service itself was not run (deps not installed), so the `None`-clearing is verified only by reading the code against the API's tested `null` semantics.
  - **Behaviour change:** API clients that PATCH `metadata` now get merge semantics (send `null` to delete) instead of replacement.
  - **Follow-up (not fixed, pre-existing):** the metadata writers that bypass this route (compliance, playbook review, binder split, which use `prisma.contract.update` with read-modify-write) can still race each other. An atomic `jsonb ||` update would close it. Low; noted, not in scope.


## C5 — The review queue is unreachable, and its corrections don't stick

- **Status:** DONE
- **Severity:** High (this is the human-verification loop for AI data)
- **Evidence:** `apps/web/src/pages/ReviewQueuePage.tsx` is routed at `/review-queue` but nothing in the app links to it. "Correct" updates only the key-terms record, so the `effectiveDate`, `expiryDate` and `value` that the contracts list and renewals read keep the wrong value. "Reject" is labelled "clear the value" but only sets confidence to 0.
- **Acceptance criteria:** the queue is reachable from the navigation (and ideally from a low-confidence badge on the contract); a correction writes through to the canonical contract fields, so the list and renewals show the corrected value; the reject action matches its label or the label matches the behaviour; a test covers write-through.
- **Worklog:**
  - **Plan (confirmed, all three):** (1) nothing in `apps/web` links to `/review-queue`. The sidebar comment claims it is "surfaced contextually via Contracts list badges"; no such link exists. (2) `POST /review-queue/:id/verify` with a value writes `counterpartyName`/`jurisdiction`/`currency` to their columns, but `effectiveDate`, `expiryDate` and `value` only into `keyTerms`. The contracts list, renewals page and renewal scan read the columns, so the correction never shows. `governingLaw` is also the source of the `jurisdiction` column (`review.py:126`) and doesn't write through. (3) `reject`'s doc and label say it clears the value; it only sets confidence 0, so the wrong value keeps driving renewals and alerts. Approach, API (`review-queue.ts`): one field→column map (dates parsed to `Date`, `value` to a number; unparseable → 400 with a readable message) used by both verify and reject. Verify writes the column **and** keeps `keyTerms[field]` in step, so every reader agrees. Reject clears the column and the `keyTerms` key, keeping the rejection record. The contract is re-indexed in ES when a column changes, using the PATCH route's full-document pattern. Web: an "Extraction queue" item in the sidebar's Queues section (comment corrected); `ReviewQueuePage` honours `?contractId=`; the contract page's Key Terms card links "Review N low-confidence fields" to the queue filtered to that contract. Test: `routes/review-queue.integration.test.ts` — a corrected expiry/value/effective date shows in `GET /contracts` and on the columns; reject clears the value; a bad date is refused.
  - **Plan review:** right layer — the columns are canonical (list, renewals, the scan in C6, ES filters), and `keyTerms` is display and back-compat, so writing both is the only way every reader agrees. Clearing on reject matches the label, the route's own doc, and safety: a value a human says is wrong must not keep firing renewal alerts. Permissions unchanged (`edit:contract` for writes, `view:contract` for the queue). The nav item is visible to anyone who can see contracts, like the other queues; writes are still gated.
  - **Changed:** `apps/api/src/routes/review-queue.ts` — `COLUMN_FOR_FIELD`/`parseCorrection`. Verify writes the canonical column (`effectiveDate`/`expiryDate` as dates, `value` as a number, `governingLaw`→`jurisdiction`) and keeps `keyTerms` in step; an unparseable date or number → 400 with a readable message. Reject now clears the `keyTerms` key and the column, and keeps the rejection record. Both re-index the contract in ES when a column changes. Web: a sidebar "Extraction Queue" item under Queues (the misleading comment rewritten); `ReviewQueuePage` honours `?contractId=` (with "show all"), and correction/rejection failures toast the server's reason instead of silently closing the editor; the contract Key Terms card shows "Review N low-confidence fields", linking to the queue filtered to that contract.
  - **Verified:** new `routes/review-queue.integration.test.ts` (4). **3 defect cases fail before the fix**: a corrected expiry never reached the column, bad input was accepted, and reject left the value. All 4 pass after, including `GET /contracts` showing the corrected expiry and value. Full suite: typecheck, lint (0 errors), api unit 171/171, web 14/14, api integration 51/51.
  - **Why VERIFY-PENDING:** the nav item, the contract-page link and the toasts were not rendered in a browser (no local dev env / sign-in; see C1). **Remaining check:** the sidebar shows Queues → Extraction Queue. On a contract with low-confidence key terms, the "Review N…" link opens the queue filtered to it. Correcting an expiry date then shows the new date on Contracts and Renewals, and a bad date shows a toast.
  - **Live check (final sweep, signed in to the local stack):** passed.
    - The sidebar shows Queues → Extraction Queue. The queue lists the low-confidence fields, and `?contractId=` shows one contract ("show all" to widen).
    - A bad date ("not a date") returned 400, with the message "Correction not saved — Enter the date as YYYY-MM-DD."; nothing changed.
    - A valid date (2027-06-30) returned 200 and left the queue (14 → 13). The Contracts list filtered to type OTHER, expiring by end-2027, shows the contract with "Jun 30, 27".
    - The contract-page "Review N low-confidence fields" link wasn't seen. The one local contract with flagged fields failed analysis and has no Key Terms card, where the link lives. The acceptance criteria ask for this link only "ideally".
    - The test contract was then restored from its pre-test values: column, key term, confidence and search index.
  - **Follow-up (final-sweep live check, DONE):** the check showed that queue reviews wrote no audit event, though a correction changes the contract's terms the way a PATCH does. Verify, correct and reject now write `CONTRACT_UPDATED` with `{ source: 'review_queue', action, field }`. As in PATCH, the field is named and its value isn't. The new case in `review-queue.integration.test.ts` fails without the change.
  - **Note:** new `indexContract` call sites (`review-queue.ts reindex`) → include them in C7's "every path that indexes a contract".


## C6 — Renewal alerts miss notice periods longer than 90 days

- **Status:** DONE
- **Severity:** High (this is the failure mode CLM buyers care most about)
- **Evidence:** the auto-renew notice deadline is computed only in the browser (`apps/web/src/pages/RenewalsPage.tsx`), and the daily scan alerts on expiry within a 90-day window, so a contract with a 120-day notice period is flagged after the opt-out date has passed.
- **Acceptance criteria:** the notice deadline is computed server-side from `expiryDate` and `noticePeriodDays` and stored or derived consistently; the scan alerts on the **notice deadline**, not just expiry; a contract with a 120-day notice period produces an alert before its deadline; a test covers it.
- **Worklog:**
  - **Plan (confirmed defect):** `scanRenewals` (`lib/obligation-scanner.ts:231`) selects only EXECUTED contracts expiring within `leadDays` (90, `scan.worker.ts:71`) and alerts on expiry. The notice deadline (expiry − notice-to-terminate days, auto-renewing contracts only) exists only in the browser (`RenewalsPage.tsx noticeDeadline/noticeDaysOf`). A 120-day notice period is therefore first flagged 30 days after its opt-out date has passed. Approach: new `apps/api/src/lib/renewal-notice.ts` — `noticeDaysOf(keyTerms)` (a port of the page's logic across the four spellings: `noticeDays`, `noticePeriodDays`, `renewalNoticeDays`, `noticePeriod` as 90 or "90 days"), `isAutoRenew(keyTerms)` (real boolean parsing; the page treated the string "no" as auto-renewing) and `renewalNotice({ expiryDate, keyTerms })` → `{ autoRenew, noticeDays, deadline }`. The scan widens its candidate window to expiry ≤ now + max(leadDays, 366 + 30) days and alerts when the expiry is within `leadDays` **or** an auto-renewing contract's notice deadline is within 30 days (or has passed). Notice-driven alerts say so ("Notice deadline in 12d · … serve notice by <date>"). `GET /renewals` returns `notice` per row from the same function, and the page renders that instead of recomputing ("derived consistently"). Tests: `lib/renewal-notice.test.ts` (unit) and `lib/renewal-scan.integration.test.ts` — a 120-day-notice auto-renewing contract expiring in 140 days is alerted now (the deadline is in 20 days); a non-auto-renewing one isn't; a 120-day contract expiring in 200 days isn't yet.
  - **Plan review:** right layer: the deadline is a business date people diarise against, so one server function feeds both the alert and the display. Existing cooldown and decision rules are unchanged, as is the existing expiry alerting. Candidate volume grows (a wider window), but it is still capped and per-org scoped; the scan is a daily bulk pass. No permission change.
  - **Changed:** new `apps/api/src/lib/renewal-notice.ts` (`noticeDaysOf`, `isAutoRenew`, `renewalNotice`). `scanRenewals` widens its candidate window to 396 days of expiry and marks a contract due when it expires inside `leadDays` **or** its auto-renewal notice deadline is ≤ 30 days away or has passed (`NOTICE_LEAD_DAYS`). Notice-driven alerts are titled "Notice deadline in Nd · …" and say "auto-renews unless N days' notice is served by <date>". The cap goes from 2000 to 5000 rows, ordered by expiry. Cooldown and decision rules are unchanged. `GET /renewals` rows carry `notice: { autoRenew, days, deadline }` from the same function. `RenewalsPage.tsx` renders that instead of its own copy of the logic, which fixes the page reading `autoRenew: "no"` as auto-renewing.
  - **Verified:** `lib/renewal-notice.test.ts` (5, unit). `lib/renewal-scan.integration.test.ts` (2): **both fail before the fix**; after it, a 120-day-notice auto-renewing contract expiring in 140 days is alerted now (deadline in 20 days); a non-auto-renewing one and one whose deadline is 80 days out are not; a 45-day expiry still alerts; `GET /renewals` returns the same deadline. Full suite: typecheck, lint (0 errors), api unit 176/176, web 14/14, api integration 53/53. The Renewals page change is a data-source swap; it was not rendered in a browser.
  - **Choice recorded:** the deadline is derived, not stored. There is one function, called by the scan and the API, so there is nothing to migrate or keep in sync when a review-queue correction changes the expiry or notice period.


## C7 — Clause-flag filters are dead in the contracts list

- **Status:** DONE
- **Severity:** Medium-High
- **Evidence:** `ContractVersion.clauseFlags` exists and Elasticsearch supports filtering on it (`apps/api/src/lib/elasticsearch.ts:208`), but the flags are never written to the index, so every count is 0 and the UI hides the filters (`apps/web/src/pages/ContractsPage.tsx:531`).
- **Acceptance criteria:** flags are indexed on every path that indexes a contract (see the `clm-hybrid-retrieval` skill for the list of create paths and the `indexContract` contract); the filters appear with real counts; the existing backfill script re-indexes historical contracts; the index-on-create tripwire test still passes.
- **Worklog:**
  - **Plan (confirmed defect):** no `indexContract` call among the 13 in `apps/api` and scripts passes `clauseFlags`, and the backfill script doesn't either. The flags are produced later: the Review agent POSTs them to `/contracts/:id/versions/:versionId/clauses` (`contracts.ts:801`), after its contract PATCH, and that route stores them on the version without re-indexing. So every ES doc lacks `clauseFlags`, the facet aggregations count 0, and `ContractsPage` hides the filters. Approach (per the `clm-hybrid-retrieval` indexing contract, "every path"): (1) `indexContract` fills in `clauseFlags` from the contract's current (else latest) version when the caller doesn't pass them. That covers all existing and future paths, including the backfill script and the C5 review-queue re-index, without editing each call site; explicit flags still win. (2) New shared `reindexContract(id)` in `lib/elasticsearch.ts` builds the full document from the DB. The clauses route calls it after storing flags, and `review-queue.ts` switches to it from its local copy. (3) The backfill script needs no change: its `indexContract` calls now carry flags. Test: `lib/clause-flags-index.integration.test.ts` against the real ES — after the Review agent's flags POST, the ES doc has the flags, `/search/facets` counts it, and `/search/advanced` filters on it; a bare `indexContract` fills flags from the version. The index-on-create tripwire must still pass.
  - **Plan review:** right layer — `indexContract` is the one function every path shares, so making the document complete there is the only fix that can't be forgotten by the next create path. Cost: one indexed lookup per index call. Tenancy unchanged (the doc carries its own `orgId`). `reindexContract` carries `diligenceRoomId`, so a re-index can't drop the diligence marker C11 relies on.
  - **Changed:** `apps/api/src/lib/elasticsearch.ts`: `indexContract` fills `clauseFlags` from the contract's current (else latest) version when the caller omits them, so all 13 existing call sites, the scripts and any future path now carry them. New `reindexContract(id)` rebuilds the full doc from Postgres (keeping `diligenceRoomId`), and `ContractDoc` gains the optional `diligenceRoomId`. `contracts.ts` `POST /:id/versions/:versionId/clauses` re-indexes after storing flags. `review-queue.ts` uses the shared `reindexContract` instead of its local copy from C5.
  - **Verified:** new `lib/clause-flags-index.integration.test.ts` (3) runs against the real ES; **all 3 fail before the fix**. After it: the Review agent's flags POST re-indexes with flags (title and plainText intact); `/search/facets` counts `forceMajeure: 1, auditRights: 1, mfn: 0`; `/search/advanced` with `clauseFlags.forceMajeure` returns only the flagged contract; a bare `indexContract` (the backfill script's call shape) fills flags from the version, and adds none for a contract without flags. The index-on-create tripwire (`lib/index-on-create.test.ts`) still passes, 5/5. Full suite: typecheck, lint (0 errors), api unit 176/176, api integration 56/56.
  - **Backfill:** `scripts/backfill-es-index.ts` is unchanged and now indexes flags through `indexContract`. The script itself was not run: it needs `../../.env`, which doesn't exist locally, and running it against the dev index was not part of this task. Run it once after deploy to restore facets on historical contracts: `cd apps/api && npx tsx --env-file=../../.env scripts/backfill-es-index.ts`.


## C8 — The Negotiate tab's AI redline analysis is broken

- **Status:** DONE (VERIFY-PENDING → DONE after the live check below)
- **Severity:** Medium-High
- **Evidence:** `apps/agents/app/routes/redline.py:41-75` calls the API without an `x-org-id` header, so auth resolves the org to `'system'` and the org-scoped diff route (`apps/api/src/routes/contracts.ts:1884`) returns 404. It also fetches `GET /api/v1/playbook`, a route that does not exist, so it would score against an empty playbook. `apps/agents/app/routes/approval.py` documents the same header bug and fixes it correctly — copy that pattern.
- **Acceptance criteria:** the analysis returns real per-change advice on a contract with two versions; headers follow the internal-service convention (`x-internal-secret`, `x-internal-service`, `x-org-id` — see the `clm-debug-multilayer` skill); the playbook fetch hits a route that exists; failures surface as structured errors instead of empty successes.
- **Worklog:**
  - **Plan (confirmed, walked all five layers per `clm-debug-multilayer`):** L1: `POST /contracts/:id/redline` (validates, marks ANALYZING, queues) is fine. The worker → `agents /redline` hop is fine. L2: `run_redline` returns `changes: []` plus `error` when a step's LLM call fails, and `redline.py` records that as `_redlineStatus: DONE` with no changes: an empty success. L3: settings come from `settings.*`, fine. L4: `redline.py` sends `x-internal-secret` + `x-internal-service` but **no `x-org-id`**, so `req.user.orgId = 'system'`. L5: the diff route scopes `{ id, orgId }` → 404 → FAILED. The playbook fetch hits `GET /api/v1/playbook`, which doesn't exist (the route is `/api/v1/playbook/positions`), and a non-2xx was silently treated as "no positions". The UI has no FAILED state: `RedlinePanel` shows nothing, or a stale analysis. Approach: `redline.py` gets an `_internal_headers(org_id)` copied from `approval.py` (all three headers) and fetches `/api/v1/playbook/positions?contractType=…`. A playbook fetch failure stays non-fatal but is recorded on the analysis (`playbookNote`); an org with no positions is recorded the same way. A pipeline error with no changes → FAILED with the reason; an error after some changes → DONE with a `warning`. An identical-versions diff → FAILED with a plain message. `RedlinePanel` gets a `failure` prop (rendered from `_redlineStatus === 'FAILED'` + `_redlineError`) and shows `playbookNote`/`warning`. Test: `routes/redline-internal.integration.test.ts` replays the Python calls with the fixed headers: diff 200 with real `<ins>/<del>`, positions 200 with the org's position; without `x-org-id` the diff 404s and `/api/v1/playbook` 404s (documents both bugs).
  - **Plan review:** right layer — the bug is the caller's headers and URL; the Node routes' org scoping is correct and must not be loosened. `approval.py` is the documented, working pattern. The playbook route requires `view:playbook`; the system principal gets org scope (`requirePermission`), so no permission change. The "real per-change advice" criterion needs an LLM, so that part can only be VERIFY-PENDING here.
  - **Changed:** `apps/agents/app/routes/redline.py`: `_internal_headers(org_id)` sends all three headers, following `approval.py`. The playbook is fetched from `/api/v1/playbook/positions?contractType=…`; a failed or empty playbook is recorded as `playbookNote` on the analysis (still non-fatal, never silent) along with `playbookPositionCount`. A pipeline error with no changes → `_redlineStatus: FAILED` with the reason; an error after some changes → DONE with a `warning`; versions with no `<ins>/<del>` → FAILED "no differences". A successful run clears a previous `_redlineError` (`None` deletes, per C4). Web: `RedlinePanel` gains a `failure` prop (the red "Redline analysis failed" box) and renders `warning`/`playbookNote`; `ContractDetailPage` passes `_redlineError` when the status is FAILED.
  - **Verified:** `routes/redline-internal.integration.test.ts` (4) replays `redline.py`'s requests with its new headers and URL: diff 200 with the real `<del>twelve</del>`/`<ins>three</ins>`, positions 200 with the org's MSA position. It also pins the old failures: without `x-org-id` the diff 404s, and `/api/v1/playbook` 404s. The FAILED status and reason persist without wiping other metadata. `lib/agents-internal-headers.test.ts` (3, unit), a source tripwire since CI has no Python test runner: **2 of 3 fail on the old `redline.py`**, all pass now. `redline.py` compiles. Full suite: typecheck, lint (0 errors), api unit 179/179, web 14/14, api integration 60/60.
  - **Why VERIFY-PENDING:** "the analysis returns real per-change advice" needs the agents service and an LLM key, neither available here. **Remaining check:** on a contract with two parsed versions, Negotiate → Analyze Redlines should show per-change accept/counter/reject advice scored against the org's playbook. With identical versions, the red failure box should explain why.
  - **Found, not fixed (new defect, same class):** `apps/agents/app/agents/portfolio_agent.py:110` calls `POST /api/v1/search/advanced` without `x-org-id`, so ES filters on `orgId: 'system'` and portfolio queries return nothing. → Stretch X15.
  - **Live check (2026-09-23, local stack; agents service on :8003 running this branch):**
    - The first run failed with the old symptom, "Diff endpoint returned 404". The cause was the environment, not the code: a second API from Aug 30 (:3011, this checkout) shared Redis and the dev database, took the job, and sent it to the other checkout's agents service on :8002, which runs code from before this fix. With your OK I stopped it (see the closing summary).
    - The next run reached this branch's agents service and failed at step 1 with `KeyError: '\n    "changeId"'`. The extract prompt (`redline_agent.py` `_EXTRACT_PROMPT`) shows its JSON example with single braces and is filled with `str.format()`, which reads `{` as a field. So the pipeline has raised before calling a model since the first commit: the analysis never worked, with or without the headers. The failure did show in the panel as "Redline analysis failed" with the reason, the path this fix added.
    - **Fixed (follow-up):** the example's braces are doubled. `portfolio_agent.py`'s `_PARSE_PROMPT` had the same fault (see X15). New `lib/agents-prompt-templates.test.ts` (2), a source tripwire like `agents-internal-headers.test.ts` since CI has no Python runner: it reads every module-level prompt in `apps/agents/app` that is `.format()`ed (14 prompts in 6 files), and checks that each field is one its call supplies and literal braces are doubled. **It fails on the old two prompts, naming both,** and passes now. Both prompts were also rendered with the agents service's own Python, and an ad-hoc audit of the dict-held prompts (`assist_agent._ACTION_PROMPTS`) found nothing.
    - **Passed live:** Ironbridge Industrial Group — SOW #03, v1 → v2. The agents service fetched the diff (200) and the SOW playbook (200, 59 positions), extracted 7 changes, scored them and finished. The panel shows per-change advice: 7 changes, each with a recommendation, clause type, severity, playbook alignment and a reason. It also shows the summary ("7 acceptable, 0 need countering, 0 should be rejected") and "Legal review required", because the model rated all 7 small wording edits as outside the playbook. The contract kept its 2 versions, status and current version.
    - Reaching the Negotiate tab on this contract needed X51.


## C9 — `redline_apply` sends a variant name the API rejects

- **Status:** DONE
- **Severity:** Medium
- **Evidence:** `apps/agents/app/tools/redline_apply.py` tells the model to pass `'conservative'`, but the Node schema accepts only `least | moderate | aggressive`, so the call 400s. The UI labels the same tier "least".
- **Acceptance criteria:** one vocabulary across the Python tool, the Node schema and the UI labels; a test or probe covers applying each variant.
- **Worklog:**
  - **Plan (confirmed defect):** `apps/agents/app/tools/redline_apply.py:35` tells the model the variants are `'conservative' | 'moderate' | 'aggressive'`. The Node schema (`internal-ai.ts:590`, `z.enum(['least','moderate','aggressive'])`), `redline_propose`'s own output (`aggression: 'least'|…`), `assist.py`, `clause-propose-batch.ts`, `queue.ts` and the UI (`RedlinePreview.tsx`) all use `least`. So a model following the tool description sends `conservative` and the apply 400s. Approach: the one vocabulary is `least | moderate | aggressive`, as everything but this one description already uses. The Python tool states it and validates it at the tool boundary, normalising the obvious synonyms (`conservative`/`minimal`/`light` → `least`, `balanced`/`medium` → `moderate`) so a stale prompt still lands, and returning a clear error for anything else. Node stays strict. Tests: `routes/redline-apply.integration.test.ts` applies each variant through `/internal/ai/tools/redline_apply` (new version created, text spliced, `aggression` recorded) and shows `conservative` is refused; a source tripwire in `lib/agents-internal-headers.test.ts`'s sibling checks that the Python tool's vocabulary equals the Node enum.
  - **Plan review:** fixing the caller keeps a single, already-dominant vocabulary. Adding `conservative` to Node would create a second one. Normalising in Python costs nothing and protects against model drift. No permission or tenancy change; the apply path still goes through `checkToolPermission` and a confirmation card.
  - **Changed:** `apps/agents/app/tools/redline_apply.py`: `AGGRESSION_LEVELS = ("least", "moderate", "aggressive")`. The description now tells the model to pass the chosen variant's own `aggression` value. A pydantic `field_validator` normalises obvious synonyms (`conservative`/`minimal`/`light` → `least`, `balanced`/`medium` → `moderate`) and rejects anything else with the allowed list. The tool uses `args_schema=RedlineApplyArgs`, so LangChain runs the validator. Node and the UI were already `least|moderate|aggressive` and are unchanged.
  - **Verified:** `routes/redline-apply.integration.test.ts` (4) applies **each variant** through `/internal/ai/tools/redline_apply`: a new v2 with the proposed text spliced in and `metadata.redline.aggression` recorded. `conservative` is refused with a 400, the failure the old tool description caused. `lib/redline-vocabulary.test.ts` (3, source tripwire): **2 of 3 fail on the old `redline_apply.py`**, all pass now; it asserts the Python tuple equals the Node enum and that the UI uses the same three. Python compiles. The validator was not executed at runtime (no agent deps locally); the tripwire pins the vocabulary it enforces. Full suite: typecheck, lint (0 errors), api unit 182/182, api integration 64/64.


## C10 — Binder re-split duplicates children, and DOCX binders fail opaquely

- **Status:** DONE (VERIFY-PENDING → DONE after the live check below)
- **Severity:** Medium
- **Evidence:** re-splitting never deletes the first set of children (`apps/api/src/workers/parse.worker.ts:218`), so they accumulate. A DOCX flagged as a binder fails because splitting is PDF-only. Detection reads only the first 10,000 characters (`apps/agents/app/routes/detect_binder.py`), so later agreements are missed.
- **Acceptance criteria:** re-splitting replaces the previous children (or refuses with a clear message) and never duplicates; a DOCX binder either splits or reports a clear, actionable message instead of failing; widening the detection window is optional — if skipped, note it as a follow-up rather than silently leaving it.
- **Worklog:**
  - **Plan (confirmed):** (1) `handleSplitBinder` (`parse.worker.ts:218`) always creates new children; nothing removes the previous set, so each re-split (the "Adjust splits" flow) accumulates duplicates. A BullMQ retry after a partial failure also re-creates the children already made, because `_splitInto` is only written at the end. (2) Splitting is PDF-only (`pdf-lib`), but `handleDetectBinder` (`agent.worker.ts:125`) auto-queues a split for any flagged document. A DOCX binder therefore fails with a pdf-lib parse error after three retries ("Binder split failed: …"), and the manual `POST /:id/split` accepts DOCX too. (3) Detection sees only the first 10,000 chars (`detect_binder.py:22`). Approach: move the handler into `apps/api/src/lib/binder-split.ts` (`splitBinder`) so it is testable without constructing the BullMQ worker. Previous split children are identified by their `…/contracts/<parent>/splits/` S3 key or by `_splitInto`, never by `relationshipType` alone, since `/upload` can attach manual exhibits with the same fields. If any has moved on (status ≠ DRAFT, or more than one version), the split is refused with a clear message. Otherwise they are soft-deleted and removed from ES before the new set is created, which also makes retries idempotent. A non-PDF original is refused with an actionable message: `POST /:id/split` 422s it, and the worker throws `UnrecoverableError` so there are no pointless retries. Auto-split skips non-PDF binders: it records `_binderDetected` plus `_binderSplitUnsupported` (the fix: save as PDF and re-upload, or upload each agreement) and analyses the document as one contract. The banner shows that message instead of a "Review & Split" button that would fail, and the split modal toasts the server's reason. The detection window is left as a documented follow-up. Test: `lib/binder-split.integration.test.ts` (S3 mocked via `vi.mock`, a real 3-page PDF from pdf-lib, parse queueing mocked) covers split, re-split replacing (no duplicates), a manual exhibit surviving, refusal when a child moved on, and the DOCX refusal at the route and in the worker.
  - **Plan review:** right layer — the worker owns child creation, so dedupe lives there; the route checks the same conditions synchronously so the user sees the reason. Soft delete (not hard) keeps audit and FK integrity. Tenancy: children are looked up by `parentContractId` + org. No permission change (`edit:contract`, as before).
  - **Changed:** new `apps/api/src/lib/binder-split.ts`. `splitBinder` moved out of `parse.worker.ts` (the worker now delegates), plus `previousSplitChildren`, `resplitBlocker`, `splitPrefix` and `SPLIT_REQUIRES_PDF`. Previous split children (by `splits/` key or `_splitInto`) are soft-deleted and removed from ES once the new slices are built. If any has left DRAFT or been edited, the split is refused, and the worker records `_splitError` on the parent. The original's bytes must be a PDF, else the worker throws `UnrecoverableError(SPLIT_REQUIRES_PDF)` (no retries). `POST /contracts/:id/split` answers 422 (not a PDF) or 409 (children moved on) with the message. `agent.worker.ts` detect-binder: a non-PDF binder is not auto-split. It records `_binderDetected`, `_binderDocumentCount` and `_binderSplitUnsupported`, then proceeds to classification as one document. Web: the binder banner shows the unsupported message instead of a failing "Review & Split" button; `_splitError` shows in a banner; the split modal toasts the route's reason.
  - **Verified:** new `lib/binder-split.integration.test.ts` (5) uses real Prisma, the real route and real pdf-lib (a 3-page PDF), with S3 faked via `vi.mock` so it runs in CI. It covers: split, then re-split replaces instead of duplicating, then a same-splits retry is idempotent; a manual exhibit survives; a re-split is refused (409 + worker) when a child moved on; a DOCX is refused (422 + `UnrecoverableError`) with no children created. **With the pre-fix handler swapped back in and the route guards stashed, 4 of 5 fail.** Full suite: typecheck, lint (0 errors), api unit 182/182, web 14/14, api integration 69/69.
  - **Why VERIFY-PENDING:** the automatic path for a DOCX (detect-binder → no split → classify) needs the agents service's LLM binder detector, which isn't available here. That branch is verified only by typecheck and reading. **Remaining check:** upload a DOCX containing two agreements. The banner should say it can't be split (with the fix), and the document should be analysed as one contract, not FAILED.
  - **Live check (2026-09-23, signed in to the local stack; agents service on :8003 running this branch, Gemini):** a DOCX holding a mutual NDA and a separate distribution agreement.
    - The detector flagged it (2 documents), and the worker recorded the "PDFs only" message without splitting.
    - The document went on to classification and was analysed as one contract (NDA, summary, risk, expiry), not FAILED.
    - The contract page shows the banner "Multiple agreements detected … Save this document as a PDF and upload it again to split it, or upload each agreement separately", with no Review & Split button.
  - **Deliberately left out (follow-up, per the task):** widening the detection window beyond the first 10,000 chars (`detect_binder.py:22`) → Stretch X16.


## C11 — Agent retrieval returns superseded versions and diligence-room documents

- **Status:** DONE
- **Severity:** Medium-High (wrong answers that look right)
- **Evidence:** clause vectors are matched across all versions with no current-version filter (`apps/api/src/lib/embeddings.ts:343-381`), and diligence-room contracts are hidden only from the contracts list and export, not from search or agent answers.
- **Acceptance criteria:** retrieval returns only the current version's clauses by default; diligence-room documents are excluded from ordinary search and agent answers (room-scoped access stays possible); a test covers a contract with three versions returning only the latest.
- **Worklog:**
  - **Plan (confirmed):** (1) Versions: `searchClauses` (pgvector; used by `portfolio_search`, the `contract_search` semantic fallback, REST `/search`, `/search/ask`, `/contracts/:id/ask`) joins clauses of **every** version of a contract, so superseded clause text is cited as if current. `org_memory`'s past-deal excerpts also read every version. Other clause readers (cite, clause_search, playbook_check, counterparty_memory, portfolio_compare) already use `currentVersionId`. The ES `clauses` index is written but never queried. (2) Diligence: only `GET /contracts` (and export) filter `diligenceRoomId: null`. ES docs don't reliably carry the field (only `diligence.ts` passes it), `buildESQuery` doesn't exclude it, and neither `searchClauses` nor the agent list tools do. Approach: `searchClauses(..., opts)` restricts to the current version (`currentVersionId`, else the highest `versionNumber`) unless `allVersions`. It excludes diligence contracts unless a specific `contractId` is asked about (explicit access) or `opts.diligenceRoomId` scopes to one room. `buildESQuery` adds `must_not exists diligenceRoomId` unless `filters.diligenceRoomId` is set, and `indexContract` fills `diligenceRoomId` from the DB (the same lookup C7 added for flags) so every path carries it. REST search hydration (`search.ts`) adds `diligenceRoomId: null`, which is correct even for ES docs indexed before this change. Agent list and aggregate tools (`contract_search`, `counterparty_memory`, `portfolio_search`, `renewal_advice` list mode, `obligations_list` list mode, `org_memory`, `counterparty_get/list` counts) exclude diligence contracts. Tools given an explicit contract id keep working for room documents (room-scoped access). `org_memory` past deals are limited to current versions. Tests: `lib/retrieval-scope.integration.test.ts` — a contract with three versions returns only v3's clause (also with `currentVersionId` null → latest). A diligence contract is excluded from org-wide semantic search and `contract_search` but reachable by id and with `diligenceRoomId`. The ES filter is covered by a unit test and a real-ES check. `org_memory` returns only current-version excerpts.
  - **Plan review:** right layer — retrieval functions and the shared query builder, so every caller is covered. The single-contract exemption keeps the diligence room's own flows and explicit agent lookups working. Retrieval touches permissions (S2's owner filter must compose with these filters), so the adversarial review must check composition and that no path widens. Historical ES docs lacking `diligenceRoomId` are covered by the Prisma hydration guard now, and by the backfill (which auto-fills) for ES-side counts.
  - **Changed:** `lib/embeddings.ts`: `searchClauses(..., opts)` joins one **effective version** per contract: its current version if it has clauses, else the latest version that does (the B.5.6 rule, computed once per query in a `DISTINCT ON` derived table, not per row). Diligence contracts are excluded unless a `contractId` is given or `opts.diligenceRoomId` scopes to a room; `opts.allVersions` opens history explicitly. New `effectiveClauseVersionIds()`. `lib/elasticsearch.ts`: `buildESQuery` adds `must_not exists diligenceRoomId` unless `filters.diligenceRoomId`; `indexContract` fills `diligenceRoomId` (with the flags, one lookup) and fails closed if that lookup fails; the mapping declares it `keyword` for new indexes. `routes/search.ts`: hydration filters `diligenceRoomId: null`, and highlights, clause matches and RRF scores come only from returned rows, so a stale ES doc leaks nothing. `routes/internal-ai.ts`: `contract_search` (+ fallback), `counterparty_memory`, `portfolio_search`, `renewal_advice`/`obligations_list` (list mode), `counterparty_get/list` exclude diligence contracts; `org_memory` reads effective versions of non-diligence deals (deterministic 5000 cap). `routes/slack.ts`: `/contract search` excludes them. `lib/binder-split.ts` and the amendment route: children and amendments inherit the parent's `diligenceRoomId`.
  - **Verified:** new `lib/retrieval-scope.integration.test.ts` (10). **With the source fixes stashed, 6 of the first 8 cases fail** (the other 2 are positive controls: explicit all-versions history, and by-id access). After the fix all 10 pass: a three-version contract returns only v3; no current pointer → latest; a clause-less current version (seal / redline_apply) → the latest extracted version; a diligence doc is excluded org-wide, found room-scoped and by id; `contract_search` and its fallback, `org_memory`, `portfolio_search` exclude it; real-ES ordinary vs room-scoped search; and a stale ES doc without the field leaks nothing through `/search`. The ES cases skip when ES is down (CI). `lib/elasticsearch.test.ts` +2 unit cases cover the builder. `binder-split` +1 case: children stay in the room. Full suite: typecheck, lint (0 errors), api unit 184/184, api integration 80/80.
  - **Adversarial review (subagent):** SQL correct and composes with S2's owner filter (no spread overwrites it); facets/`searchContracts`/`advancedSearch` all go through `buildESQuery`. Acted on every in-scope finding before commit: a **High regression** in my first cut (a clause-less current version dropped the contract from all clause retrieval; 86 such contracts in the dev DB), fixed with the effective-version rule; binder children and amendments leaving the room; REST highlights/scores leaking from stale ES docs; `org_memory` dropping contracts without a current pointer, with an unordered cap; indexing failing open; Slack search.
  - **Deploy step:** run `scripts/backfill-es-index.ts` after deploy. Until then, ES docs indexed before this change lack `diligenceRoomId`, so ES-side totals and facet counts still include diligence docs. Content is already guarded by the DB filter.
  - **Out of scope (other surfaces), noted:** dashboards, analytics, renewals, obligations, counterparties pages and `/contracts/:id/precedents` don't exclude diligence contracts → Stretch X17. Pre-existing: HNSW post-filtering can return short top-k for filtered queries (`hnsw.iterative_scan` would help), noted there too.


## C12 — Chat drafting ignores what the user asked for

- **Status:** DONE (VERIFY-PENDING → DONE after the live check below)
- **Severity:** Medium
- **Evidence:** `contract_create_from_template` does not use the drafting pipeline. `apps/api/src/routes/internal-ai.ts:~3863-3920` guesses the contract type from keywords, takes the newest published template of that type (so untyped templates are never used) and hardcodes California law, a 2-year term and today's date whatever the user asked. It also creates the contract inline, with no confirmation card and no undo, unlike the other six write tools.
- **Acceptance criteria:** the tool either routes through `draft_agent` (which fills variables from intent) or passes the user's stated terms through instead of hardcoded defaults; it goes behind the same confirm-and-undo card as other write tools; the tool description matches what it does.
- **Worklog:**
  - **Plan (confirmed):** the chat tool `contract_create_from_template` (Python) POSTs `/tools/contract_draft`, which **persists** a contract mid-stream. It infers the type from keywords, picks the newest published template **of that type** (`contractType: null` templates are unreachable), and fills `governing_law: 'California'`, `term: '2 years'`, `effective_date: today` whatever the user said. It never returns `awaitingConfirmation`, so there is no ActionPreview, no `checkToolPermission`, and no undo. Meanwhile a complete confirm-and-undo path for this exact tool name already exists and is unused: `agent-threads.ts` WRITE_TOOLS → `/tools/contract_create_from_template` (explicit `templateId` + `variables`) → ToolCall `reversible` → `/undo`. Approach (the tracker makes the choice `scripts/agent-loops/l4-draft-gate.mjs` left open, and `orchestrator.py`'s "draft-first, already persisted" wording changes with it): (1) new `apps/api/src/lib/draft-plan.ts` `planDraft()`, and `/tools/contract_draft` becomes a **read-only planner**. Template: an explicit `templateId`, else the newest published template of the type, else an untyped published template whose name/description names the type; otherwise `NO_TEMPLATE_MATCH` listing the published templates so the model can pass one. Variables: the user's stated terms (`counterpartyName`, `governingLaw`, `term`, `effectiveDate`, plus a free `terms` map), mapped onto the template's own `{{keys}}` via alias groups, then the template's declared `defaultValue`s, and the org's name for our-party keys. **No hard-coded values**; anything else stays visibly blank and is reported as `unfilledVariables`. Returns `{ templateId, templateName, contractType, title, counterpartyName, variables, html, unfilledVariables }` and writes nothing. (2) The Python tool returns `awaitingConfirmation` with `args = { templateId, variables, title, counterpartyName }` and a preview summary naming the template and the blank terms; Apply goes through the existing apply → create → undo path. (3) The create route gains the `CONTRACT_CREATED` audit (moved from `contract_draft`) and returns `html`/`subtitle` so the Doc artifact still renders after Apply (AgentHomePage builds it from the Apply result). Undo also removes the ES doc. (4) Tool description and orchestrator drafting rules describe the confirm step and the blank terms. `agents.ts` keeps withholding the tool from callers without `create:contract`, with a corrected comment. The l4 probe drives plan → create. Tests: `routes/draft-plan.integration.test.ts` — stated terms (New York, 3 years, a date) land in the right keys; nothing is persisted by planning; an untyped template is chosen by name; an explicit `templateId` wins; template defaults are used and no California/2-year value appears; apply → create (owner = caller, audit) → undo via the real `/agent/threads/:id/actions/apply` path.
  - **Plan review:** right layer — reuse the existing, permission-checked confirm and undo path instead of inventing a second one, and keep the planner deterministic and in Node (the Python `draft_agent` pipeline's template fetch was the reason drafting moved to Node, per the route comment). A VIEWER still can't draft: the tool is withheld, and `checkToolPermission` now runs on Apply. The planner reads only the org's templates, clauses and name, org-scoped. No schema change.
  - **Changed:** new `apps/api/src/lib/draft-plan.ts` (`planDraft`, `inferContractType`). `/tools/contract_draft` is now a read-only planner (`persisted: false`). Its schema adds `templateId`, `governingLaw`, `term`, `effectiveDate` and a `terms` map. `/tools/contract_create_from_template` (the Apply target) accepts the planned `contractType`, writes the `CONTRACT_CREATED` audit (moved from the planner) and returns `html`/`subtitle`; its undo also drops the ES doc. `apps/agents/app/tools/contract_create_from_template.py`: plans, then returns `awaitingConfirmation` with the create args and a preview summary naming the template and the blank terms. The description says it prepares, the user applies, and terms are never invented. `orchestrator.py` drafting rules changed to match (no more "already persisted"; offer listed templates on NO_TEMPLATE_MATCH). `agents.ts` comments corrected; the tool is still withheld without `create:contract`. Web: `AgentHomePage` builds the Doc artifact from the Apply result. `scripts/agent-loops/l4-draft-gate.mjs` drives plan → create and records the decision it had left open.
  - **Verified:** new `routes/draft-plan.integration.test.ts` (6). **All 6 fail on the pre-fix routes.** After the fix: stated terms (New York / 3 years / 2026-10-01 / Initech) land in the template's keys with the template's own `defaultValue` (net 30) and the org name; nothing is persisted by planning; unstated terms are reported blank and California / "2 years" / today never appear; an untyped template is chosen by name; an explicit `templateId` wins, with aliases mapped onto that template's variable names; NO_TEMPLATE_MATCH lists the org's templates. The **real** `/agent/threads/:id/actions/apply` → create → `/undo` path runs end to end (the apply RPC's internal HTTP call is forwarded in-process): owner = caller, type NDA, `CONTRACT_CREATED` audit by the caller, and undo soft-deletes. `lib/agents-drafting-tool.test.ts` (2, source tripwire): both fail on the old Python tool. Python compiles; the l4 probe passes `node --check`. Full suite: typecheck, lint (0 errors), api unit 186/186, web 14/14, api integration 86/86.
  - **Why VERIFY-PENDING:** a live chat turn was not run (no agents service or LLM). **Remaining check:** ask `/agent` to "draft an NDA with Initech, New York law, 3 years". Expect a confirm card naming the template and any blank terms, and no contract before Apply. After Apply, the draft opens as a Doc with New York / 3 years; Undo removes it. Also run `scripts/agent-loops/l4-draft-gate.mjs` against the live stack.
  - **Live check (2026-09-23, signed in to the local stack; agents service on :8003 running this branch, Gemini):** "draft an NDA with Initech, New York law, 3 years".
    - The answer came as a confirm card: "About to run contract_create_from_template · UNDOABLE", naming the "Mutual Non-Disclosure Agreement" template and the 6 terms left blank. No contract existed before Apply (count unchanged).
    - Apply created "Initech — NDA" (DRAFT, NDA), owned by you, with a `CONTRACT_CREATED` audit by you. Its text reads "governed by the laws of New York" and "continue for 3 years", with no California or 2-year terms.
    - Undo soft-deleted it and removed it from the search index (404). Apply and Undo are audited as `AGENT_TOOL_APPLIED` and `AGENT_TOOL_UNDONE`.
    - Not run: `scripts/agent-loops/l4-draft-gate.mjs`. It signs in with a password and creates a VIEWER account, which I leave to you, and it pins an OpenAI model this stack has no key for.
    - Seen in passing, left as is: reopening a thread doesn't bring back a card still waiting for Apply, because the server doesn't keep the proposal's Apply arguments. The user asks again.
  - **Product note:** this settles the open question the l4 probe recorded ("draft-first vs behind the confirmation gate", docs/36) in favour of the gate, as this tracker specified. Drafting now needs one click to commit.


## C13 — A lost parse job leaves a contract PENDING forever

- **Status:** DONE
- **Severity:** Medium
- **Evidence:** `IN_PROGRESS_STATUSES` in `apps/api/src/workers/index.ts` omits `PENDING`, so the stuck-job sweep never recovers a job that was never enqueued. The known-gaps note explains why it was left out: at the current 5-minute threshold, a queue backlog would mark healthy contracts FAILED.
- **Acceptance criteria:** PENDING is swept with its own, longer threshold (choose one and write down the reasoning), so a lost job surfaces as FAILED with a retry path; a backlog of freshly queued contracts is not marked FAILED; a test covers both.
- **Worklog:**
  - **Plan (confirmed):** `workers/index.ts` sweeps only `PARSING…ANALYZING` older than 5 minutes. A contract whose parse job was never enqueued (`queueParseDocument` swallows enqueue errors) or was lost (e.g. a Redis flush) stays `PENDING` forever. Complication: `PENDING` is also the column **default** (`schema.prisma`), so template drafts, request intakes, imports and agent drafts sit at `PENDING` by design with nothing to parse. A time threshold alone would mark all of those FAILED, which is why PENDING was left out. Approach: move the sweep into `apps/api/src/lib/stuck-contracts.ts` (testable without starting the workers). A PENDING contract is declared lost only when **all** hold: (a) its current (else latest) version has an uploaded file that was never parsed (`s3Key` set, `plainText` empty); (b) it has been PENDING longer than **`PENDING_LOST_THRESHOLD_MS` = 30 minutes**; (c) **no parse job for it is waiting, active, delayed or prioritized in the document queue**. Then it becomes FAILED with "never picked up for processing — click Re-analyze" (the existing re-analyze route re-queues it). Threshold reasoning: (c) is what makes a backlog safe, since a queued job, however deep the backlog, is found. So the time bound only needs to cover the gap between the row being written and the job being enqueued, plus a sweep racing a job the moment it moves between queue states. 30 minutes is a generous margin for both, while still surfacing a lost upload within the hour instead of never. If the queue can't be listed (Redis down), PENDING contracts are left alone: fail safe, never FAILED on a guess. Tests: `lib/stuck-contracts.integration.test.ts` (Postgres + Redis) covers a lost upload → FAILED; the same upload with a real queued job → untouched; a recent upload → untouched; an old template-drafted PENDING contract (nothing to parse) → untouched; queue unreachable → untouched; and the existing in-progress sweep still works.
  - **Plan review:** right layer — the recovery job owns "stuck"; making it queue-aware is the only way to tell "lost" from "waiting". No schema change. It keeps the existing 5-minute cadence and in-progress behaviour. Tenancy: global sweep as before (no org data crosses).
  - **Changed:** new `apps/api/src/lib/stuck-contracts.ts` (`recoverStuckContracts`, `queuedParseContractIds`, thresholds). `workers/index.ts` now only schedules it (same 5-minute cadence, and same in-progress behaviour and message). A PENDING contract becomes FAILED ("never picked up for processing … Click Re-analyze") only if its current version is an unparsed upload, it has been PENDING more than 30 minutes, and no `parse-document` job for it is waiting, active, delayed, prioritized, waiting-children or paused. The status is re-checked in the update, so a job that starts mid-sweep wins. If the queue can't be read, PENDING is left alone. Capped at 1000 candidates per sweep.
  - **Threshold chosen: 30 minutes.** The queue-membership check is what protects a backlog, of any depth, so the time bound only has to cover the gap between the row being written and the job being enqueued, plus a sweep racing a job between queue states. 30 minutes is a wide margin for both and still surfaces a lost upload within about 35 minutes, instead of never.
  - **Verified:** new `lib/stuck-contracts.integration.test.ts` (7) runs against real Postgres and a real Redis queue: a lost upload → FAILED with the retry message; an upload three hours old whose job is still (delayed-)queued → untouched; a 5-minute-old upload → untouched; template-drafted and bare PENDING-by-default contracts three days old → untouched; queue unreachable → untouched; the in-progress sweep still fails a crashed PARSING job. **With the old sweep logic swapped in, the lost-upload case fails** (and the queue-down case only on the new report field); the backlog and PENDING-by-default cases pass either way, which is what they guard. Full suite: typecheck, lint (0 errors), api unit 186/186, api integration 93/93.


## V1 — Render the playbook review that already runs on every contract

- **Status:** DONE (VERIFY-PENDING → DONE after the live check below)
- **Severity:** High value, low effort
- **Evidence:** after extraction, a job scores every clause against the org's playbook and writes findings, severity, alignment and a human-gate flag to `metadata._playbookReview` (`apps/api/src/workers/parse.worker.ts:211` → `agent.worker.ts:563` → `apps/agents/app/agents/playbook_review_agent.py`). `GET /contracts/:id/playbook-review` exists. Nothing in `apps/web` references it.
- **Acceptance criteria:** a rail section on the contract page renders the stored review in document order, mirroring `ComplianceRailSection.tsx`, which already reads a `metadata._*` report in this shape; each finding shows severity and links to its clause; an empty state explains when no playbook positions exist.
- **Worklog:**
  - **Plan (confirmed):** `handlePlaybookReview` (`agent.worker.ts`) writes `metadata._playbookReview = { findings[{clauseId, clauseType, playbookAlignment, severity, recommendation, reasoning, requiresHumanReview}], summary, requiresHumanGate, clausesReviewed, playbookPositions, reviewedAt, versionId }`. It **skips without writing** when the org has no playbook position for the contract's type (or no clauses). `GET /contracts/:id/playbook-review` returns the blob, or a bare 404 in both "not run" and "no positions" cases, and nothing in `apps/web` reads it. Approach: API: the GET returns findings in **document order**, joined to their clauses' `sortOrder`/`sectionRef`/excerpt (the stored findings are in model order); the 404 carries `reason: 'no_positions' | 'not_run'` plus `playbookPositionCount`, computed with the same type filter as the job, so the UI can explain itself. Web: new `components/contracts/PlaybookReviewRailSection.tsx` mirroring `ComplianceRailSection`: a human-gate banner, summary, then each finding with severity, alignment and recommendation, linking to its clause through the same jump handler `DecisionStrip` uses (scroll to `[data-clause-id]`, else open the focused-review drawer). Empty states: "No playbook positions for <type> — add them in Playbook" versus "Not reviewed yet — runs after extraction". Mounted above Compliance on the contract rail. Test: `routes/playbook-review.integration.test.ts` covers ordering + enrichment, the `no_positions` vs `not_run` reasons, and org scoping.
  - **Plan review:** read-only, and the route keeps `view:contract`. Position counts are org-scoped and reveal no position content, so a user without `view:playbook` learns only that positions exist. No change to how the review is produced.
  - **Changed:** `contracts.ts GET /:id/playbook-review` returns findings sorted by their clause's `sortOrder`, each with `sectionRef`, `excerpt` and `sortOrder` (clauses looked up within this contract's versions only). With no review, the 404 body adds `reason` (`no_positions` | `not_run`), `playbookPositionCount` and `contractType`. New `apps/web/src/components/contracts/PlaybookReviewRailSection.tsx`: gate banner, summary, ordered findings with a severity chip, alignment, recommendation and reasoning, each a button that jumps to the clause, plus the two explained empty states (with a Playbook link for `no_positions`). `ContractDetailPage.tsx` mounts it above Compliance and shares one `jumpToClause` with the approver `DecisionStrip`, whose inline handler it replaces with identical behaviour.
  - **Verified:** new `routes/playbook-review.integration.test.ts` (3). The first 2 **fail on the pre-fix route**: model order was returned with no section or excerpt, and the 404s carried no reason. After the fix: document order + enrichment; `no_positions` → `not_run` once an NDA position exists; org scoping holds. Full suite: typecheck, lint (0 errors), api unit 186/186, web 14/14, api integration 96/96.
  - **Why VERIFY-PENDING:** the rail section was not rendered in a browser (no local dev env / sign-in). **Remaining check:** on an analysed contract whose type has playbook positions, the "Playbook review" section lists findings in document order, and clicking one scrolls to (or opens) that clause. On a type with no positions it explains that and links to Playbook.
  - **Live check (2026-09-23, signed in to the local stack; agents service on :8003 running this branch, Gemini):** a freshly uploaded 10-section services agreement (the PII fixture below, X23).
    - Its automatic playbook review scored 11 clauses, and the rail's "Playbook review" section lists its 6 findings in document order (§3, §6, §7, §8, §9, §10). Each has a severity, recommendation, playbook position and a reason quoting the contract.
    - Left as is: the section's summary says "6 of 11 clause(s) deviate from the playbook" although 4 of the 6 are "accept · preferred/acceptable". It counts findings, not deviations.
  - **Live check (final sweep, signed in to the local stack):** the empty state renders: "Not reviewed yet. The playbook review runs automatically once the contract has been analysed." No local contract has a playbook review (`metadata._playbookReview`), and producing one needs the agents service and an LLM key, so the ordered findings are still unchecked.


## V2 — Stop answers overstating their own completeness

- **Status:** DONE (VERIFY-PENDING → DONE after the live check below)
- **Severity:** High (this is the product's core promise)
- **Evidence:** `portfolio_search` returns at most 30 fused hits with no total; `renewal_advice` truncates at 50 rows, sorted oldest first, with no total; `contract_search` has no date-range or value-range filter (`apps/api/src/routes/internal-ai.ts`, tool contracts around `:255-268`, `:484-493`, `:857-889`, `:3318-3365`). So "which contracts…" answers are samples presented as if complete.
- **Acceptance criteria:**
  - `portfolio_search` and `renewal_advice` return a total matching count alongside the returned rows.
  - The assistant states coverage in the answer ("showing the top 30 of 214 matches" or "this is a sample, not a complete list") — enforce it in the system prompt **and** make the tool output carry the numbers so the model cannot omit them.
  - `contract_search` accepts date-range and value-range filters (the fields are already on the model) so "expiring in the next 90 days" is answered by a filter rather than a sample.
  - An eval or probe covers one set question and asserts the coverage statement appears.
- **Note:** this is the smallest step toward complete portfolio answers. It does **not** attempt the full per-document scan; do not expand scope here.
- **Worklog:**
  - **Plan (confirmed):** `portfolio_search` returns ≤ `topK` (max 30) fused hits with `total: hits.length` and no count of what matched. `renewal_advice` fetches `min(limit×3, 300)` rows by `expiryDate asc` over a window that starts 30 days in the past, so lapsed contracts fill the page before upcoming ones. It then slices to `limit` (≤ 50) and reports `total`/`expiringSoon`/`recentlyExpired` as counts **of the page**. `contract_search` has no date-range or value-range filter, so "expiring in the next 90 days" is answered from a sorted sample. Approach: every list tool returns a **`coverage` block**: `{ returned, totalMatching, complete, note }`, where `note` is a ready-to-say sentence ("Showing 10 of 214 matching contracts." / "This is a ranked sample, not a complete list."), so the numbers travel with the rows. `contract_search` gains `expiryDateFrom/To`, `effectiveDateFrom/To`, `valueMin/valueMax` (applied to the semantic fallback too), plus `coverage`. `portfolio_search`: `totalMatching` is ES's hit count for the keyword+filter query (the countable half); the semantic half is ranked, not countable, and is labelled a sample; with ES down, `totalMatching` is null and the note says "sample". `renewal_advice`: upcoming contracts first (soonest first), then recently lapsed (most recent first). `expiringSoon`/`recentlyExpired`/`totalMatching` become real DB counts, plus `coverage`. Python: `contract_search` exposes the new filters (description: use them for date/value questions). `orchestrator.py` gets rule **A13 — COVERAGE**: when `coverage.complete` is false the answer must state it. Probe: `scripts/agent-loops/v2-coverage.mjs` asks one set question through `/agent/chat` and asserts a coverage statement appears. Tests: `routes/coverage.integration.test.ts` (filters, coverage numbers and notes, renewal ordering and counts) and a source tripwire for A13.
  - **Plan review:** additive fields only; existing fields keep their meaning (`total` stays the page size, per A11's contract). Filters and counts reuse S2's owner scope and C11's diligence exclusion, so a count is never over data the caller can't see. Explicitly not a full per-document scan, per the task's note.
  - **Changed:** `internal-ai.ts`: exported `coverageOf()` / `Coverage` and a `dateRange()` helper. `contract_search` gains `expiryDateFrom/To`, `effectiveDateFrom/To` (validated; a bare `to` date is inclusive) and `valueMin/valueMax`, applied to the semantic fallback too, plus `coverage`. `portfolio_search` keeps ES's keyword-match total and returns `coverage`: "Showing the N most relevant; M match the keywords", or "a ranked sample" when ES is unavailable. `renewal_advice` queries upcoming (soonest first) and recently lapsed (most recent first) separately; `expiringSoon`/`recentlyExpired`/`totalMatching` are true DB counts, `windowNote` says "Only N of the M are listed", and `coverage` is added. Python `contract_search.py` exposes the six filters. `orchestrator.py` adds rule **A13 — COVERAGE**. New probe `scripts/agent-loops/v2-coverage.mjs`.
  - **Verified:** new `routes/coverage.integration.test.ts` (6). **All 6 fail on the pre-fix route**. After the fix: page coverage "Showing 5 of 12"; the next-90-days filter = exactly the 4 upcoming; value ≥ $1M = 7, and combined with the date range = 2; a malformed date → 400; renewals list the 3 soonest upcoming (not lapsed ones) with true counts 4 / 3 / 7; portfolio_search always carries coverage. `lib/agents-coverage-rule.test.ts` (2, source tripwire for A13) fails without the rule. The probe passes `node --check`. Python compiles. Full suite: typecheck, lint (0 errors), api unit 188/188, api integration 102/102.
  - **Why VERIFY-PENDING:** "the assistant states coverage in the answer" can only be observed with the agents service and an LLM. **Remaining check:** run `node scripts/agent-loops/v2-coverage.mjs` against the live stack on the demo org.
  - **Not attempted (per the task's note):** a full per-document scan for complete portfolio answers.
  - **Live check (2026-09-23, signed in to the local stack):** the probe script signs in with the seed admin's password, so I asked its question in `/agent` under your session instead: "Which of our contracts mention limitation of liability? List them."
    - The tool result carried `coverage: {returned: 7, totalMatching: 104, complete: false}` with its note.
    - The answer said "Since 104 contracts match, this is not a complete list."
    - **Found and fixed (follow-up):** the "Search results" artifact showed "10 matching contracts", one row per clause hit, so the same contract appeared up to four times. That contradicted the answer's 7 and the coverage block. The table now lists each contract once, and its count says "7 of 104 matching contracts" when the tool reports partial coverage. `components/agent/artifact-from-tool.test.ts` +2: the dedupe/partial case fails on the old code.


## H1 — Marketing site claims things the product does not do

- **Status:** DONE
- **Severity:** High (public, and a trust/credibility risk)
- **Evidence:** the Security page claims JWT **RS256** (the code uses HS256), "matter-scoped" permissions and "composable roles" (neither exists), an "append-only" audit log (it is hash-chained, with no DB-level append-only guarantee and no viewer) and GDPR data-export/deletion endpoints (none exist). Elsewhere the site claims Salesforce/HubSpot/SAP/NetSuite sync (no code), "Slack and Teams approvals" (Teams is outbound links only) and capturing requests from Slack (the Slack command only searches). The EmailCapture form posts to the wrong path, omits required fields and reports success on failure. The contact form saves submissions but emails no one.
- **Acceptance criteria:** every claim on the marketing site is true of the current code, or is clearly marked as planned; the EmailCapture form either works against the real endpoint or is removed; the contact form's behaviour matches what users are told. Keep the edit surgical — this is a truth pass, not a redesign.
- **Worklog:**
  - **Plan (each claim checked against code):** false as stated. JWT "RS256": `lib/jwt.ts` signs with a shared secret and no algorithm, so HS256. "Optional SAML SSO": no SAML/OIDC code in `apps/api`. "Matter-scoped" permissions: scopes are `own | team | department | org` (`packages/types enums.ts`). "Composable roles": users can hold several of the built-in roles and their permissions merge, but roles can't be created or edited. "Append-only and exportable" audit log: hash-chained (`lib/audit.ts`), with no DB-level append-only guarantee and no viewer or export (`routes/admin-audit.ts` is a stub). GDPR data-export/deletion endpoints: none. Salesforce/HubSpot pull and SAP/Oracle/NetSuite sync: no code. "Slack and Teams approvals": Slack Approve/Reject exists (`routes/slack.ts`); Teams is outbound notification cards only. "Capture requests from email, Slack, or a portal": Slack only searches, and email/portal attach versions to existing contracts; requests come from the intake form or the API (`requests:write` keys). EmailCapture posts to `/api/marketing/contact` (the route is `/api/v1/marketing/contact` on the API origin), omits the required `name`/`message`, shows "Check your inbox — we sent it" even on failure, and nothing ever emails a template. The contact form saves to `MarketingContact` and logs, emailing no one, while promising a reply "within one business day". True and kept: role changes are audited (`ROLE_CHANGED`); authorization is enforced server-side. Approach: surgical copy edits that make each claim true or mark it planned. Remove EmailCapture from the template page (the direct download becomes the action) and delete the component. Contact: the API emails `MARKETING_CONTACT_EMAIL` (new, documented in `env.api.example.yaml`) through the existing mailer when email is configured, so a human is told; the page stops promising an SLA the code can't guarantee. Test: extend or add `routes/marketing.integration.test.ts` for the notification; a copy tripwire (`apps/marketing`) asserts the false phrases are gone.
  - **Plan review:** a truth pass, not a redesign; wording changes only, plus one small server behaviour (the notify) needed to make the contact form honest. No auth or tenancy impact: the public endpoint and its rate limit are unchanged.
  - **Changed (copy):** `TrustStrip.tsx`: "JWT (HS256) sessions · SSO on the roadmap". `Security.tsx`: HS256; SSO "on the roadmap — not available yet"; RBAC is "one or more built-in roles, combined permissions, org-wide or own-records scope; role changes audited; custom roles and matter-level scopes planned"; audit log is "chained hash so altering a past entry is detectable; viewer, export and DB-level append-only planned"; GDPR endpoints "planned; self-hosting keeps residency and deletion in your hands". `lifecycle.ts`: requests come "through an intake form or the API"; CRM pull is "Planned"; "Approve from Slack (Teams gets notification cards)". `industries/index.ts`: Salesforce/HubSpot and SAP/Oracle/NetSuite marked "Planned". `Product.tsx`: approvals copy likewise. **Forms:** `EmailCapture.tsx` deleted; the template page now leads with "Download the .docx" and "No email required" instead of promising an emailed .docx and newsletter nobody sends. Contact page: "we've got your message. We'll reply by email" (the "one business day" SLA is dropped); `routes/marketing.ts` emails `MARKETING_CONTACT_EMAIL` via the existing mailer when configured, and logs a warning when nobody can be told. The new var is documented in `env.api.example.yaml`.
  - **Verified:** `lib/marketing-claims.test.ts` (10, copy tripwire over `apps/marketing/src`): **all 10 fail on the pre-fix site**, all pass now. `routes/marketing.integration.test.ts` (2): the submission is saved **and** the inbox emailed (fails pre-fix), and the old email-capture body is refused (400). Each run uses its own client IP, since the route's 5/hour limiter is Redis-backed and outlives a run; stable across 4 back-to-back runs. `pnpm --filter marketing build` succeeds (sitemap regeneration reverted, not committed). Full suite: typecheck, lint (0 errors), api unit 198/198, api integration 104/104.
  - **Deploy note:** set `MARKETING_CONTACT_EMAIL` (plus an email provider) in production, or contact submissions still only land in the `MarketingContact` table (now with a warning log).


## H2 — Half the advertised webhook events never fire

- **Status:** DONE
- **Severity:** Medium
- **Evidence:** subscribers can choose 16 events; 8 never fire — `contract.updated`, `contract.expired`, `signature.voided`, `approval.decided`, `obligation.extracted`, `obligation.overdue`, `invoice.created`, `amendment.created`. The matching Slack/Teams cards never fire either.
- **Acceptance criteria:** either each event is emitted at its real trigger point (preferred where the trigger already exists in code) or it is removed from the subscribable list; the list a user sees matches what can actually arrive; a test asserts the advertised set equals the emitted set.
- **Worklog:**
  - **Plan (confirmed; recorded after implementation — I wrote this entry late, the analysis came first):** `WEBHOOK_EVENTS` (`integrations.ts`) lists 16 events; `fireWebhook` literals exist for 8. For each missing event I looked for its real trigger: `contract.updated` → `PATCH /contracts/:id`; `approval.decided` → `POST /approvals/:id/decide` and the agent's `/tools/approval_decide`; `signature.voided` → signer decline and sender void (`signatures.ts`); `obligation.extracted` → `lib/obligation-extract.ts` after `createMany`; `obligation.overdue` → `scanObligations` at its existing once-per-obligation OBLIGATION_OVERDUE audit; `invoice.created` → `POST /invoices`; `amendment.created` → `POST /contracts/:id/amendments`. `contract.expired` has **no** trigger: nothing moves a contract to EXPIRED (`VALID_TRANSITIONS` has no edge into it; the only automatic EXPIRED is on signature requests), so it is removed from the subscribable list rather than inventing a status job. Payloads use the fields the Slack/Teams formatters already expect (`decision`, `contractId`, `daysOverdue`, `description`, `dueDate`, `reason`), so those cards now render too.
  - **Changed:** emitters added in `routes/contracts.ts` (PATCH → `contract.updated` with `changes` and `source: user|system`; amendments route → `amendment.created` with `relationshipType`), `routes/approvals.ts` + `routes/internal-ai.ts` (`approval.decided`, with `instanceStatus`, `decidedBy`, `via: 'agent'`), `routes/signatures.ts` (`signature.voided` ×2), `lib/obligation-extract.ts` (`obligation.extracted` with count), `lib/obligation-scanner.ts` (`obligation.overdue`, once per obligation), `routes/invoices.ts` (`invoice.created`). `integrations.ts`: `contract.expired` removed from `WEBHOOK_EVENTS` with the reason. The web list reads `/admin/integrations/events`, so it updates automatically.
  - **Verified:** `lib/webhook-events-coverage.test.ts` (unit) asserts **the advertised set equals the emitted set**, from source. It fails with the emitters removed and passes now. `routes/webhook-emit.integration.test.ts` (5) drives the real routes and the scanner with deliveries captured at the queue: `contract.updated`, `amendment.created`, `invoice.created`, `approval.decided` (APPROVED) and `obligation.overdue` (exactly once across two scans). **All 5 fail without the emitters.** Full suite: typecheck, lint (0 errors), api unit 199/199, api integration 109/109.
  - **Notes:** existing webhooks that subscribed to `contract.expired` keep it in their stored list; it never fired before and still won't. `teams-formatter.ts` keeps its unused `contract.expired` case for when an expiry transition exists. `signature.voided` and `obligation.extracted` are covered by the source-level set test only, since a behavioural test would need a signing flow or an LLM extraction.


## H3 — README, CHANGELOG and BUILD_TRACKER describe a different product

- **Status:** DONE
- **Severity:** Medium
- **Evidence:** README says "seven specialist agents … on a LangGraph orchestrator" (there are 8; chat is a single hand-written tool loop that never routes to them; 3 have no UI); "every clause, date, and dollar is … cited to the source page" (citations are section-level, with no page jump); portfolio "pricing benchmarks" (no benchmarking logic exists). CHANGELOG claims "durable Yjs collab persistence" (state is stored, but the editor is not connected). BUILD_TRACKER marks as done: an admin UI to create roles (the page is read-only), an admin settings panel (3 of 5 tabs say "Coming soon"), an "Ask AI tab" (deleted), and still lists PAdES signing as deferred although it shipped. `scripts/evals/README.md` says tier 2 blocks every PR; CI runs tier 1 only.
- **Acceptance criteria:** these documents describe what the code does today; where something is aspirational, it is labelled as such. Do not delete history from CHANGELOG — correct it in place with a note.
- **Worklog:**
  - **Plan (each claim checked):** README: "Seven specialist agents … on a LangGraph orchestrator". There are 8 agent modules (`apps/agents/app/agents/`: approval, ask, assist, draft, playbook_review, portfolio, redline, review). Agent-mode chat is a hand-written tool-calling loop (`orchestrator.py run_agent_chat_stream`) that never hands off to them, and the ask and portfolio agents have no UI (`/search/ask`, `/search/portfolio-query` have no web callers). "Cited to the source page": citations link to the clause/section; there is no page jump (X1). "Pricing benchmarks": no such logic. CHANGELOG: "durable Yjs collab persistence". State persists (`collab_states`), but the editor isn't bound to it, so there's no live co-editing (the BUILD_TRACKER W2 row says so). BUILD_TRACKER: `[x]` RBAC manager "admin UI to create roles", but `AdminRolesPage.tsx` is read-only (view and toggle only; role *assignment* works via admin-users). `[x]` admin settings panel: Alert Rules / System Dashboard / Data Management are `PlaceholderTab` "Coming soon" (`AdminOrgPage.tsx`). `[x]` ContractDetailPage "Ask AI" tab: no such tab exists now. `[ ] X.509 / PAdES … deferred to V1.5`: shipped 2026-07-07 (W2 2.7 in the same file's session log). `scripts/evals/README.md` says t2 is "blocking, every PR", but `ci.yml` runs `--tier t1` only (with a TODO to add t2); `llm-release-gate.yml`'s header says the same. Approach: correct each statement to what the code does, marking aspirational items as planned. CHANGELOG corrected **in place with a dated note** (no history deleted). BUILD_TRACKER checkboxes changed to `[~]`/`[x]` with a one-line reason and a pointer to this tracker. Test: a doc tripwire asserting the corrected statements (so they can't silently regress).
  - **Plan review:** documentation only (plus one YAML comment); no behaviour change. Keeps history intact as the task requires.
  - **Changed:** `README.md`: the three "Why" rows now say "a chat assistant with 30 tools, every write proposed on a confirm card first, and most undoable", "eight specialist agents run as background jobs and endpoints; the ask and portfolio agents have no UI yet", "cited to the clause and section (jump-to-page planned)", and describe portfolio search without "pricing benchmarks" (it mentions coverage statements instead). `CHANGELOG.md`: the Yjs line is kept and followed by a dated *Correction* note. `BUILD_TRACKER.md`: RBAC manager, admin settings panel and "Ask AI" tab changed `[x]`→`[~]` with the reason; PAdES changed `[ ]`→`[x]` (shipped 2026-07-07), with an update note on the "deferred to V1.5" design principle. `scripts/evals/README.md`: t2 marked "not yet in CI — run locally", and the fork-PR paragraph says only t1 blocks today. `.github/workflows/llm-release-gate.yml` header comment likewise (comment-only).
  - **Verified:** tool count (30) from `get_read_tools` by AST; write tools' confirm/undo flags read from source (`approval_decide` is not reversible, hence "most undoable"); agent-to-UI mapping by grepping web for each endpoint; placeholder tabs and the read-only roles page read from source; the CI eval step read from `ci.yml`. `lib/docs-claims.test.ts` (4, doc tripwire): **all 4 fail on the old docs**, all pass now. Full suite: typecheck, lint (0 errors), api unit 203/203, api integration 109/109.
  - **Left as history:** BUILD_TRACKER session-log rows are records of what was believed at the time (e.g. the 2026-07-20 row's "`_playbookReview` has no UI yet", true then and fixed by V1). They were not rewritten.


---

## Stretch (only if everything above is `DONE`, `VERIFY-PENDING` or `NOT-REPRODUCIBLE`)

- **X1 — Page-jump citations. — DONE.**
  - **Plan:**
    - Confirmed: `contract_cite` returns each passage's `page` and `bbox`. The extractor records a 1-based page and the paragraph's union box in PDF points from the top-left (PyMuPDF, `extract.py`). `CitationPills` linked only to `?section=`, which scrolls the styled view to a heading that merely matches.
    - The Original view is `@react-pdf-viewer`, which takes `initialPage` and a `renderPage` hook, so no new dependency is needed.
    - Fix:
      - `lib/citation-target.ts` builds the pill link, now `?section=` plus `&page=&bbox=` when known.
      - It parses them back, ignoring malformed values.
      - It scales the box to the rendered page.
      - `ContractDetailPage` opens the document tab in the Original view at that page and outlines the passage with an ink ring, the same "you landed here" treatment as the TOC flash. The viewer re-mounts per citation, so `initialPage` applies. It keeps the three default layers and adds the overlay.
      - A citation's switch to Original doesn't overwrite the user's saved view preference.
      - Without a source PDF, `?section=` scrolls the styled view as before.
  - **Verification:**
    - `lib/citation-target.test.ts` has 4 cases: link with section, page and box, round-tripped; section-only fallback; malformed page or box ignored; box scaled to the page.
    - web typecheck 0, lint 0 errors (warnings unchanged at 22), web unit 18/18.
  - **Why VERIFY-PENDING:** needs a live click-through, which this environment can't run. Open a contract with a source PDF, ask the agent to cite a clause, and click the pill. The Original PDF should open at the cited page with the paragraph outlined. With no source file, the pill should still scroll the styled view.
  - **Live check (final sweep, signed in to the local stack):** the first attempt failed. The page never left the styled view, because the Original view had never worked (X49).
    - With X49 fixed, the link a pill produces (`/contracts/<Globex NDA>?page=1&bbox=72,90,540,180`) switches to Original, renders the PDF at page 1, and draws the outline at the box's scaled position, with no console errors.
    - The pill itself wasn't clicked from a live chat answer, which needs the agents service and an LLM key. Its link is built by `citationHref`, which `lib/citation-target.test.ts` covers.
  - **Left as is:** the outline is drawn only on unrotated pages, and it assumes the CropBox starts at the page origin (true for almost every PDF; PyMuPDF and pdf.js then agree). Scanned (OCR) pages carry no box, so they land on the page without an outline.
  - Original note: Citation pills open the original PDF at the stored page and highlight the stored bounding box, instead of scrolling to a matching heading. The page and bbox are already stored and unused (`apps/web/src/components/agent/CitationPills.tsx`).
- **X2 — Custom-field backfill. — DONE** (VERIFY-PENDING → DONE after the live check below).
  - **Plan:**
    - Confirmed: extraction reads the org's field definitions at upload (`agent.worker.ts` `/review`), and nothing ever goes back, so a field added later stays empty on every existing contract. `review.py` also stored only each custom field's value, dropping the confidence and quote the model returned (unlike `_typeFields`).
    - Evidence: the value stays flat in `metadata[fieldKey]`, which search and the UI read, and the confidence and quote go beside it in `metadata._customFieldEvidence[fieldKey]` (cleared on a run that produced output, like `_typeFields`). The contract page shows the confidence icon and, on hover, the source quote.
    - Backfill:
      - Re-running the full `/review` per contract is the wrong tool: it replaces every clause row (new ids) and re-embeds.
      - Instead, a new agents endpoint, `POST /extract-fields`, asks for only the named fields, chunk by chunk, and stops once each has a value. It uses the same untrusted-document framing and PII token rule.
      - `lib/custom-field-backfill.ts` walks the org's own analysed contracts of the field's type (no diligence rooms), in id order, 20 at a time.
      - It skips contracts that already hold a value or have no text.
      - It writes value plus evidence in one SQL statement, only if the field is still empty, so a value that landed meanwhile wins and concurrent metadata keys survive.
      - It saves `{status, cursor, processed, filled, failed, total, error}` on the definition after every contract (new nullable `backfill` column, migration `20260923040000_custom_field_backfill`).
      - A failing contract is counted and skipped. The cost cap pauses it. A crash leaves the cursor for BullMQ's retry, or the admin's next press, to resume from.
      - The worker runs it through `callAgents`, so the PII policy and cost cap apply.
      - `POST /field-definitions/:id/backfill` (configure:contract) queues it. There is one job per field; a failed or finished job is cleared, so a new press resumes or re-scans.
      - Settings → Custom fields gets a "Fill in existing contracts" button per field, plus a progress line that polls while it runs.
  - **Verification:**
    - `lib/custom-field-backfill.integration.test.ts` has 4 cases:
      - only the org's own analysed contracts of the type that lack a value are asked about (not an NDA, a room contract, an unanalysed or empty one), with value and evidence stored, an existing value kept, and status saved;
      - a cost-cap pause mid-run, then a resume that picks up after the last processed contract, with a failing contract counted and skipped;
      - a value that lands during extraction is never overwritten;
      - the route queues for ADMIN and refuses VIEWER.
    - `lib/custom-field-agents.test.ts`: Python tripwires (evidence kept and cleared; `/extract-fields` mounted with the token rule and untrusted framing). `py_compile` passes for the Python files.
    - Suite:
      - db:generate 0, typecheck 0, lint 0 errors (web warnings unchanged);
      - api unit 270/270, web 18/18;
      - api integration green, except a probe file another review had open at the time (not part of this change).
  - **Why VERIFY-PENDING:** `/extract-fields` is new Python that only compiles here; there is no Python environment with its dependencies. Live check: add a custom field to an org with analysed contracts, press "Fill in existing contracts", and watch values with confidence and quote arrive and the progress line reach "Filled in on N of M".
  - **Live check (2026-09-23, signed in to the local stack; agents service on :8003 running this branch, Gemini):** two text fields scoped to OTHER, the type with the fewest analysed contracts (3), to keep the run small.
    - "Governing law (X2 check)" ended "Filled in on 0 of 3 existing contracts". That's right: none of the three states a governing law.
    - "Customer name (X2 check)" ended "Filled in on 3 of 3", with values "Contoso Logistics Inc." (×2) and "Massive Dynamic", each with confidence 0.99 and its quote (`Contoso Logistics Inc. ("Customer")`).
    - The progress line stops updating while the browser tab is hidden (React Query pauses polling then) and catches up when the tab is shown. Both fields are still in Settings → Custom Fields.
  - **Deploy:** run the migration (`20260923040000_custom_field_backfill`), and deploy the agents service with the new route before the API's worker.
  - Original note: Adding a field only affects future uploads; there is no bulk re-extract (`apps/api/src/routes/field-definitions.ts:56-76`). Add a resumable backfill job, and stop dropping confidence and quotes for custom fields (`apps/agents/app/routes/review.py:231`).
- **X3 — Empty stubs. — DONE.**
  - **Plan:**
    - Confirmed: `routes/admin-audit.ts` and `routes/metrics.ts` register no routes, and `lib/error-reporter.ts` drops every error. That is despite `middleware/error-handler.ts` promising Sentry forwarding and the docs promising Prometheus/Grafana and Sentry.
    - The audit data itself exists: hash-chained `AuditEvent`s for every write, and `verifyAuditChain`. Only the AI-settings slice could be read back (`GET /admin/ai/audit`).
    - Decision: implement the minimum useful version of each, with no new dependency, rather than delete them:
      - **Audit log API:** `GET /api/v1/admin/audit` returns the org's events newest first. It filters by action, resource type/id, user and dates, and pages by keyset cursor (offsets drift while events land). `GET /api/v1/admin/audit/verify` re-walks the hash chain. Both require `configure:organization` (ADMIN), like the AI audit: the log holds IPs and every resource id.
      - **Viewer:** an "Audit Log" tab on the org admin page: filters, load more, metadata per row, and "Verify integrity".
      - **Metrics:** `GET /api/v1/metrics` serves Prometheus text:
        - HTTP requests and durations by route pattern; unmatched URLs share one label, so the series count stays bounded;
        - process memory and uptime;
        - BullMQ job counts per queue and state, with a 2 s cap so a scrape can't hang on Redis.
        - It is 404 unless `METRICS_TOKEN` is set, and then needs it as a bearer token (constant-time compare). There is no client library, just a counter map in `lib/metrics.ts` and an `onResponse` hook in `app.ts`.
      - **Error reporting:** 5xx errors are written to stderr as Cloud Error Reporting `ReportedErrorEvent`s on Cloud Run (`K_SERVICE`) or with `ERROR_REPORTING=gcp`, with signing and portal tokens masked in the URL. Error Reporting groups and alerts on them with no SDK or key; elsewhere the structured log line remains the record. Sentry, which isn't installed, is no longer promised in the handler.
      - **Docs:** `02-TECH-STACK.md` and `19-DEPLOYMENT-STRATEGY.md` now say what is wired and what is still a plan (Grafana, Sentry, PostHog). `.env.example` documents `METRICS_TOKEN` and `ERROR_REPORTING`.
  - **Verification:**
    - `routes/admin-audit.integration.test.ts` has 6 cases:
      - newest first with the actor, and no other org's rows;
      - action filter plus cursor paging without overlap;
      - LEGAL_OPS gets 403;
      - the chain verifies, then a tampered row is found (`hash_mismatch`);
      - metrics are 404 without a token and 401 with none or a wrong one;
      - with the token, text/plain with a route-pattern counter, `unmatched` for junk URLs (never the URL itself), process memory and queue gauges.
    - `lib/error-reporter.test.ts` has 3 cases: silent off Cloud Run; one Error Reporting event with the token masked; never throws.
    - Against the stubs, 6 of the 9 fail. The other 3 pass against the stubs by design: 404 without a token, silent off Cloud Run, never throws.
    - Suite:
      - db:generate 0, typecheck 0, lint 0 errors;
      - api unit 268/268, web 14/14, api integration 234/234.
  - **Left as is:** no scrape config, dashboards or alert rules. Counters are per process and reset on deploy, which Prometheus' `rate()` handles. The viewer has no export.
  - **Follow-up (adversarial review of 6345ee2):** a fresh subagent confirmed there's no auth bypass or cross-org read. Every system role but ADMIN gets 403, the cursor is org-scoped, and filters are parameterized. Fixed:
    - `/verify` loaded up to 50k full rows and hashed them synchronously: about 0.5 GB and seconds of blocked event loop per call on a 1 GiB, 1-CPU instance. The list returned full metadata, and one agent-apply audit row can hold about 1 MB of tool arguments (a 50-row page was 48 MB).
      - `verifyAuditChain` now walks in 1,000-row batches, yielding between them (ties on `createdAt` ordered by id).
      - The route runs one verify per org at a time (a second request shares the run), checks up to 200k rows, and reports `truncated` only when rows were actually left over. It used to say `true` at exactly 50k.
      - The list inlines metadata only up to 4 KB serialized; larger metadata comes from a new `GET /admin/audit/:id` when a row is opened.
    - The viewer's "Load more" refetched page 1 fresh but reused old cursors, so events landing meanwhile hid rows. It now uses TanStack's infinite query, which re-derives each cursor.
    - Masking:
      - The 5xx log line bypassed the request serializer and logged the raw URL. It now masks.
      - Invite links (`/auth/invites/:token`, which sets a password) and credential query parameters (`token`, `code`, `key`, `secret`, `signature`, `password`) are masked everywhere `maskTokenPaths` runs.
      - Error Reporting gets the route pattern, not the URL.
    - A NUL byte in a filter or the cursor failed the query with a 500. Filters are now capped and checked, and the cursor must be id-shaped.
    - `/metrics` sat behind the global rate limiter, which keeps its counters in Redis, so it hung during a Redis outage. It opts out; the token is its gate.
    - Every sample now carries an `instance_id`, so series from different Cloud Run instances don't interleave as counter resets.
    - `reportError` could throw (`String()` on an object without a prototype). Now nothing escapes it, a thrown non-Error is described, and messages are capped at 64 KB (Cloud Logging's limit is 256 KB).
    - The viewer no longer says entries "can't be edited". It says verification finds a stored entry that was altered: the chain has no key, and deleting the newest rows isn't detectable.
    - Tests:
      - `admin-audit.integration.test.ts` now has 9 cases, adding bad filter/cursor → 400, large metadata by reference plus per event (404 cross-org), a 1,501-row chain verified in batches, and `instance_id` labels.
      - `error-reporter.test.ts` has 4 cases, adding a non-Error and a message cap.
      - `log-redact.test.ts` covers invites and query tokens.
      - Against the pre-follow-up code, 3 integration and 2 unit cases fail. The batch case passes before too: it guards the rewrite.
    - Suite: typecheck 0, lint 0 errors; api unit 272/272, web 18/18, api integration 250/250.
    - **Left as is:**
      - `createEvent` and verify both order by `createdAt`, so a same-millisecond tie can read as a break. That code is older and rare (no ties in 400 sequential and 8 concurrent writes); fixing it needs a per-org sequence column.
      - Metadata size isn't capped at write time.
      - Requests the client aborts aren't counted.
      - `trustProxy` is filed as X30.
  - Original note: `apps/api/src/routes/admin-audit.ts`, `routes/metrics.ts` and `lib/error-reporter.ts` are explicit stubs, so there is no audit viewer, no metrics endpoint and no error reporting. Implement the minimum useful version of each, or remove them and the docs that promise them.

- **X4 — Lost-update race on `organization.settings`. — DONE.**
  - **Plan:**
    - Confirmed, and reproduced by the X5 review: `install-industry-pack` read the settings and wrote the whole blob back about 0.5s later (after `seedOrgDefaults`), which undid an ADMIN's `piiRedactionMode` change while the audit log said otherwise.
    - The four writers each read the whole JSON blob and write it all back: `PATCH /organization`, `install-industry-pack`, and Slack `PUT`/`DELETE` in `integrations.ts`.
    - Fix: new `lib/org-settings.ts` with atomic SQL: merge the touched top-level keys (`settings || $1::jsonb`), remove a key (`settings - key`), and add to a list (`installedIndustryPacks`) without a stale read. All four writers use it; the PATCH still runs inside X5's audit transaction.
    - Acceptance: writes racing a slow install, and writes to different keys, don't undo each other.
    - Test: `routes/org-settings-race.integration.test.ts`.
  - **What changed:**
    - `lib/org-settings.ts` does single-statement SQL updates: `mergeOrgSettings` (`settings || patch`), `removeOrgSetting` (`settings - key`) and `addToOrgSettingsList` (a de-duplicated append).
    - `PATCH /organization` merges only the keys it was sent, still inside X5's audit transaction. `install-industry-pack` appends its pack id instead of writing back the copy it read before seeding. Slack `PUT`/`DELETE` set or remove only `slack`.
  - **Verification:**
    - `routes/org-settings-race.integration.test.ts` (3 cases; `seedOrgDefaults` mocked with a 400ms delay):
      - An install in flight no longer reverts an ADMIN's `piiRedactionMode` change (the X5 review's repro).
      - 12 parallel PATCHes of different keys all land.
      - A second pack keeps the first.
    - Against the pre-fix routes, the first two fail: the mode is reverted to `off`, and keys are lost.
    - The org, Slack and API-key suites pass (21/21).
  - **Left out:** same-key writes are still last-writer-wins, as intended.
  - Original note: `PATCH /organization` and `POST /organization/install-industry-pack` (which awaits the multi-query `seedOrgDefaults` between read and write) read the whole settings blob and write it back, so they can silently undo a concurrent Slack secret rotation/disconnect in `integrations.ts`. Merge atomically in SQL (`settings || $1::jsonb`, `jsonb_set`) or move Slack credentials out of `settings`. (Found in S1 review.)
- **X5 — `PATCH /organization` lets `configure:integration` (LEGAL_OPS) set `piiRedactionMode`. — DONE.**
  - **Plan:**
    - Confirmed: the PATCH merges any settings key for a `configure:integration` holder, validates no value, and audits nothing. `piiRedactionMode` is the only protection setting in `org.settings`; the cost cap and AI keys already sit behind `configure:organization` in `admin-ai.ts`. The web never sets it.
    - Fix (`routes/organization.ts`):
      - A change to `piiRedactionMode` needs `configure:organization` (ADMIN by default, as for the AI config), and the value must be `redact | tokenize | off`.
      - A real change writes an `AI_SETTINGS_UPDATED` audit event with the old and new values.
      - `lib/pii-policy.ts` drops this process's cached mode.
    - Acceptance: LEGAL_OPS gets 403 and the mode is unchanged; ADMIN changes it with an audit row; a bad value gets 400; LEGAL_OPS still saves unprotected keys.
    - Test: extend `routes/organization.integration.test.ts`.
  - **What changed:**
    - `routes/organization.ts`: changing `piiRedactionMode` requires `configure:organization`. The value must be `redact | tokenize | off`, and the protected-key check uses `Object.hasOwn`, so `constructor` and similar names are ordinary keys.
    - A real change writes an `AI_SETTINGS_UPDATED` audit row (old and new values) in the same transaction as the settings write. If the audit can't be written, nothing changes.
    - The cached mode is cleared in this process.
    - `lib/audit.ts`: `createAuditEvent` takes an optional `within(tx)` write that commits with the audit row.
  - **Verification:**
    - `routes/organization.integration.test.ts` now has 11 cases:
      - LEGAL_OPS is refused; ordinary keys still save; an invalid value gets 400; ADMIN's change is audited once.
      - An audit failure leaves the mode unchanged.
      - Built-in object names are treated as ordinary keys.
    - Against the pre-fix code, 4 fail: refusal, validation, audit, and audit-failure atomicity. The built-in-names case passes either way.
    - A fresh subagent reviewed this adversarially. It tried key tricks, value tricks, prototype keys and every other writer of `settings`, and found no way to set the mode directly. Its findings are fixed above: audit after commit, prototype-name keys, and a duplicated cache helper.
    - One finding stays open for X4: LEGAL_OPS can undo an ADMIN's change through the settings read-modify-write race (e.g. `install-industry-pack` writing a stale copy of the settings back). X4 is the next commit.
  - **Left out:**
    - Other API replicas keep the old mode for up to 60s (per-process cache).
    - The PII gaps outside this route are filed as X23.
  - Original note: , turning off PII redaction org-wide, and writes no audit event. Gate security-relevant keys behind `configure:organization` and audit the change. (Found in S1 review.)
- **X6 — Slack `teamId` is not unique across orgs. — DONE.**
  - **Plan:**
    - Confirmed: `findOrgBySlackTeam` takes the first org (unordered) listing the team id. The inbound routes then check Slack's signature against that org's secret. A second org that saves the same team id makes the first org's Slack requests fail verification.
    - Not fixed by refusing duplicates: two orgs can legitimately share one Slack workspace, with separate Slack apps and separate signing secrets.
    - Fix: `findOrgsBySlackTeam` returns every candidate (oldest first, capped), and `routes/slack.ts` authenticates as the org whose signing secret verifies the request. A squatter can't displace the real org, a shared workspace works, and an unverifiable request stays 401.
    - Test: `routes/slack-team.integration.test.ts`, with a squatting org holding a different secret, in both creation orders.
  - **What changed:**
    - `lib/slack.ts` `findOrgsBySlackTeam` returns every org naming the team, and `routes/slack.ts` authenticates as the one whose signing secret verifies the request. A shared workspace (separate apps and secrets) keeps working.
    - Candidates are tried in order: verified claims first, then oldest, 20 at most (raw SQL). Any cap can be filled by squatters (the first review showed 20 older orgs doing it), so a claim can be verified. When an admin saves a bot token, Slack's `auth.test` must confirm it belongs to that team. A mismatch or a rejected token gets 400. If Slack can't be reached, the claim is saved unverified.
    - A squatter can't verify a workspace it isn't in. The admin page shows "Workspace ownership: verified / unverified — add the bot token".
    - Hardening:
      - Only string secrets count, and one bad row can't fail a request for the others.
      - Requests without the urlencoded raw body are refused (previously checked against an empty body).
      - The Slack routes take at most 256KB, which bounds the HMAC work per candidate.
  - **Verification:**
    - `routes/slack-team.integration.test.ts` has 8 cases:
      - a squatter claiming first, a shared workspace, an unsigned request, a non-urlencoded request;
      - 20 older squatters against a verified owner;
      - a malformed secret row;
      - bot-token verification (match, other workspace, rejected), against a mocked `auth.test`.
    - Against the pre-fix code, 7 fail.
    - Suite: typecheck (api and web) 0, lint 0 errors.
    - A fresh subagent reviewed the first cut. Its three findings (cap fill, malformed-secret 500, HMAC amplification) and one info item (empty raw body) are fixed above. It confirmed a squatter can never receive another org's traffic, and that interactions are scoped to the resolved org.
    - A second pass on the verification design (follow-up commit):
      - Configs saved before X6 had no flag, and SQL `NULLS LAST` put them behind every new claim. Twenty fresh orgs could knock any existing install offline. They now rank as unverified, by age, and only a JSON `true` counts.
      - A non-string `team.id` in `/interactions` (a 500 that reached error tracking) is refused.
      - `scripts/backfill-slack-verification.ts` verifies configs that already hold a bot token.
      - The admin hint says to reconnect with the bot token, because the connected view has no edit form.
      - Tests 10/10; the two new cases fail before the follow-up.
  - **Deploy:** run `scripts/backfill-slack-verification.ts --fix` once, so existing installs with a bot token are verified.
  - **Left as is:**
    - An org without a bot token stays displaceable by 20 older unverified claims. The admin page now says so and how to fix it.
    - Any bot token for a workspace verifies claims on it. A member of the victim's own Slack workspace who can install apps could therefore create verified claims. That is insider-level, and still no data crosses.
    - Per-org request URLs would remove the team-id lookup entirely, but that is a Slack-app configuration change for every existing install.
  - Original note: `PUT /integrations/slack` does not check collisions and `lib/slack.ts` `findOrgBySlackTeam` uses `findFirst` with no ordering, so one org can claim another's team id and break its Slack integration (DoS, no data crossing). (Found in S1 review.)
- **X7 — REST ignores `own` scope outside the contract list (High). — DONE.**
  - **Plan:** a shared `lib/own-scope-guard.ts`. An `onRoute` hook appends an ownership check (`ownerId = req.user.sub`, else 404) after each route's own `requirePermission`, which is what sets `req.permissionScope`. It is registered in every plugin whose routes take a contract `:id`: contracts (38 routes), comments, share, and signatures (`/contracts/:id/...` only). That covers today's and future sub-routes in one place instead of 45 hand edits. List/search surfaces get explicit filters: `GET /contracts/export`; `/search` (ES `ids` filter from owned contracts, pgvector `ownerId`, Postgres fallback, hydration); `/search/advanced` and `/search/facets` (ES `ids`); `/search/ask` (`searchClauses` ownerId); `/search/portfolio-query` refused for own-scope callers, since its agent searches org-wide as the service; `GET /counterparties/:id` and `GET /matters/:id` (contract lists, plus the matter's thread ids limited to the caller's own). Test: `routes/own-scope-rest.integration.test.ts` — a SALES_REP gets 404 on another rep's contract and its sub-routes and doesn't see it in export/search/counterparty/matter views; ADMIN and the owner are unaffected.
  - **What changed:**
    - `lib/own-scope-guard.ts`: `ownScopeGuard(owns, detail, param)` and `guardOwnScopeRoutes(app, pattern, guard)`, an `onRoute` hook that appends an ownership check after each route's own `requirePermission`. It 404s (and `return`s the reply, so Fastify stops even when a later hook awaits). Registered in contracts, comments, share, signatures (`/contracts/:id…` only), review-queue (`:contractId`), obligations (owner of the obligation's contract), invoices (on an owned contract, or unlinked and entered by the caller), diligence (room creator) and requests (`requestedById`).
    - Lists and aggregates now filter for own scope: contract export; search `/`, `/advanced`, `/facets`, `/ask` (ES `ids`, pgvector `ownerId`, Postgres fallback, hydration); counterparty and matter detail (contracts, chat threads, and the matter's requests by the caller's `view:request` scope, none without it); review queue; obligations list/export/stats; renewals list/export/stats; diligence rooms; invoices list/stats; `/contracts/:id/precedents` (peers from owned contracts only); `/contracts/:id/family`; analytics (summary, distributions, timeseries, top counterparties); the counterparty and matter list counts; the dashboard (a caller without org-wide view counts and sees only the contracts it owns and the requests it raised; the feed is filtered inside its 40-event query, so a busy org can't crowd out the caller's own activity); the org-wide signature list (own contracts plus requests the caller signs, matched by signer `userId` or email ignoring case). `/search/portfolio-query` answers 403 for own scope, because its agent searches the whole org as the service.
    - Both signature GET routes had no permission check at all (`requireAuth`). They now need `view:contract`, so the guard applies.
    - Writes whose record isn't named `:id` check ownership in the handler: `PATCH /contracts/clauses/:clauseId/review-state` and `POST /matters/:id/attach` (the attached contract, request or thread must be the caller's).
    - `middleware/permissions.ts`: `permissionScopeFor(req, action, resource)`, evaluated as `requirePermission` does. Used for the requireAuth-only dashboard and for the matter's requests.
  - **Verification:**
    - `routes/own-scope-rest.integration.test.ts` has 16 cases, including a custom own-scope editor role for the write routes. Against HEAD's code 15 fail. The one that passes, "still opens their own contract", is a positive control. The two ADMIN controls fail pre-fix only because the pre-fix editor's `DELETE` really soft-deleted the other rep's contract (204).
    - `lib/own-scope-guard.test.ts` (unit) fails without `return reply`: the DELETE handler runs after the 404 has gone out. It passes with the return.
    - The integration test grew to 17 cases for the second pass. Against the first cut, its three new checks fail: the feed after 41 newer events by another rep, analytics and list counts, and the clause and matter-attach writes.
    - Suite: db:generate 0, typecheck 0, lint 0 errors (warnings unchanged: api 11, web 22), api unit 211/211 (206 for X7, plus 5 from X11's sanitizer test, which is in the tree but not in this commit), web 14/14, api integration 126/126.
    - A fresh subagent reviewed the first cut adversarially. It found the guard's missing `return reply`, eleven more surfaces that leaked (review queue, obligations, renewals, diligence, invoices, requests by id, a matter's requests, precedents, family, the dashboard feed) and the signer email case. All are fixed above.
    - A second fresh subagent reviewed the delta. It confirmed guard coverage route by route and the Prisma semantics against the database (`AND: []`, `contract: { is }`, the null-parameter SQL). It found the dashboard feed emptying after 40 newer events, analytics and list counts still org-wide, inconsistent null-scope counts, and two unguarded custom-role writes; all are fixed above. Its invoice finding (auto-match and an unchecked `contractId` show another rep's contract, custom own-scope editors only) is the same code as the cross-org X19, so it is fixed there, in the next commit.
  - **Behaviour changes to know about:**
    - An own-scope signer who doesn't own the contract now gets 404 from the Signatures page's "Open" link. The emailed signing link still works.
    - `POST /contracts/:id/amendments` requires owning the parent.
    - An API key needs `contracts:read` (or `contracts:write`) to list signature requests. A sign-only key (`contracts:sign`) can still send, remind and void.
    - FINANCE, APPROVER and VIEWER (no `view:request`), and API keys without `requests:read`, no longer see a matter's requests, request entries in the dashboard feed, or the org's open-request count. Their dashboard counts only requests they raised.
  - **Left out:** listed under X21. Found in review and filed separately: X18, X19 (which also covers the own-scope invoice auto-match) and X20.
  - Original note: A SALES_REP gets org-wide data from `POST /search/ask` (`search.ts:213`, verbatim clause text — now a one-line fix: pass `ownerId` to `searchClauses`), `/search`, `/search/advanced`, `/search/facets`, `GET /contracts/:id` (all versions' `plainText`), `/contracts/:id/ask`, `GET /contracts/export` (CSV, 5k rows), `GET /counterparties/:id` and `GET /matters/:id`. Only `GET /contracts` and the requests list honour it. The UI therefore exposes what S2 closed in the agent. Apply `req.permissionScope === 'own'` (reuse `contractScopeWhere` / ES `ids` from S2) on each. (Found in S2 review.)
- **X8 — Agent chat session history is not bound to user/org. — DONE.**
  - **Plan:**
    - Confirmed: `memory.py` keys Redis history by the client's `session_id` alone, and the orchestrator replays tool calls and results from it on the next turn. `/agent/chat` echoes `session_id` back in every event, so namespacing it in the API would leak into the client. Bind it at the memory layer instead.
    - Fix: `get_session_history` and `append_to_session` take keyword-only `org_id`/`user_id`. These come from the verified JWT via `agents.ts`. The key becomes `session:{org}:{user}:{session_id}`. The five orchestrator call sites pass them, and the four `scripts/agent-loops` probes that read memory directly are updated.
    - Pre-fix keys are never read again and expire within 24h, so no purge is needed.
    - Acceptance: the same `session_id` used by another user, or in another org, starts empty; the owner's multi-turn history still works.
    - Tests:
      - A TS tripwire on `memory.py` and `orchestrator.py` (no Python runner in CI).
      - A local behavioural check against the dev Redis.
  - **What changed:**
    - `apps/agents/app/memory.py`: history is stored under `session:{org_id}:{user_id}:{session_id}`, and `get_session_history` / `append_to_session` require `org_id` / `user_id` as keyword-only arguments. The five orchestrator call sites pass the caller from the request; `agents.ts` already fills that from the JWT.
    - The four `scripts/agent-loops` probes that read memory directly pass the same org and user they chat as.
    - Old unbound keys are never read again and expire within 24h. On deploy, chats already in progress start fresh.
  - **Verification:**
    - Local run of `memory.py` against a fake Redis: the owner sees the history; the same session id from another user, or the same user in another org, gets `[]`.
    - Tripwire `lib/agents-session-binding.test.ts` (4 cases) checks the key shape, the required owner, that every Redis read and write goes through the bound key, and that every orchestrator call passes the owner. All four fail on the pre-fix Python.
    - `routes/agent-chat-identity.integration.test.ts` checks the forwarded `user_id` / `org_id` are the JWT's even when the body names someone else. The API already did this; it is now pinned.
    - The api unit suite passes (221/221, run on a tree that also held other stretch work in progress). The X8 integration test passes.
    - A fresh subagent reviewed this adversarially. Nothing got through: the identity can't be influenced, and no other store keys conversation content by the client id alone. It found that the tripwire covered only the Python half, now fixed as above, and the feedback-route issue filed as X22.
  - **Left out:**
    - `:` isn't escaped in the key. Org and user ids are cuids, and the client controls only the last segment, so no collision is reachable.
    - `ChatRequest` still defaults `user_id` / `org_id` (only trusted callers reach it).
    - The agents service compares its secret with `!=` rather than `hmac.compare_digest`.
  - Original note: `agents.ts:179` forwards the client's `sessionId` unchecked; Python keys history as `session:{id}` (`memory.py:27`) and replays prior tool results, and `GET /matters/:id` exposes other users' thread ids — so a user can replay another user's (incl. org-scope, cross-org) tool output. Bind the session key to `orgId:userId`, and purge `session:*` after deploying S2 (pre-fix sessions hold org-wide results for 24h). (Found in S2 review.)
- **X9 — Agent tools check `view:contract` where REST checks a different permission. — DONE.**
  - **Plan:**
    - Confirmed, and one more pair: `redline_propose` and `redline_propose_batch` check `view:contract`, where REST's `/contracts/:id/clauses/:clauseId/suggest` needs `edit:contract`. Their variants are built from the org's playbook positions, walkaway and fallback language included.
    - Fix: `resolveCallerScope` (S2) takes any resource and action. Each tool then checks what REST checks:
      - `playbook_check`: also `view:playbook`.
      - `org_memory`: playbook positions only with `view:playbook`, clause-library items only with `view:clause`. Anything withheld is named, so the model says "not available to you", not "none exist".
      - `approval_list`: `view:workflow` for my-queue, `configure:workflow` for all (REST's `/approvals/all`).
      - `redline_propose(_batch)`: `edit:contract`, at that scope.
    - Test: `routes/agent-tool-permissions.integration.test.ts`, with real DB roles as in the S2 test.
  - **What changed:**
    - `lib/agent-scope.ts`: `resolveCallerScope(orgId, userId, resource, action)` covers `contract | request | playbook | clause | workflow | template`.
    - `internal-ai.ts`, each tool now checks what REST checks:
      - `playbook_check`: `view:playbook`.
      - `org_memory`: positions need `view:playbook`, library items `view:clause`. What's withheld is named first in the response (so it survives memory truncation), and the category is withheld when both are.
      - `approval_list`: `view:workflow` for my-queue, which now holds only the approver's current steps as REST's does; `configure:workflow` for all.
      - `redline_propose(_batch)`: `edit:contract`.
      - `template_list`: `view:template`.
      - `matter_list`: `view:contract`, with counts narrowed like REST's `/matters`.
    - `agents.ts`: REST `POST /agent/compare` needs `view:playbook`. It returned every playbook position, walkaway text included, to any `view:contract` role; the web never calls it. The chat proxy withholds the tools the caller can never use.
    - Python: `template_list` and `matter_list` send `userId`. Five tools pass a 403's reason on to the model instead of a generic error.
  - **Verification:**
    - `routes/agent-tool-permissions.integration.test.ts` has 11 cases, with real DB roles and a custom own-scope reviewer that keeps S2's own-scope 404 for these tools.
    - S2's `agent-scope` test now expects 403 for SALES_REP on `playbook_check` / `redline_propose` (refused by permission before ownership), with the ownership 404 moved to the new test.
    - Tripwire `lib/agent-tool-identity.test.ts` (27 cases): every tool whose handler checks the caller must send `userId` from its Python builder, and the 403 pass-through must be there.
    - Suite: typecheck 0, lint 0 errors, api unit 256/256, api integration 183/183.
    - A fresh subagent reviewed this adversarially, going through every tool against its REST twin. It found `/agent/compare` (High), `template_list`, `matter_list`, `org_memory`'s category, my-queue's step gate, `withheld` ordering and the lost 403 reasons, all fixed above. It confirmed the write-tool permission map matches REST, and that service calls with no user still work.
  - **Left out:**
    - `contract_draft` (the planner) has no caller check. It is reachable only through `contract_create_from_template`, which is withheld without `create:contract`, and REST `/agent/draft` is itself as open.
    - The tool chip still shows green when a tool returns an error payload.
    - `redline_propose` returns clause text without PII redaction (added to X23).
  - Original note: `org_memory` / `playbook_check` return playbook positions (walkaway language) to roles without `view:playbook`; `approval_list scope:'all'` returns the org approval queue (incl. `aiSummary`) to roles without `view:workflow`. (Found in S2 review.)
- **X10 — Write tools ignore permission scope. — DONE.**
  - **Plan:**
    - Confirmed: `checkToolPermission` (`agent-threads.ts`) checks that the permission is granted and ignores its scope. The internal tool endpoints authenticate the service, not the user.
    - The X18 review showed the consequence: a custom role with own-scope edit+sign can Apply `contract_update` / `assign_owner` on any contract, become its owner, and then read its signing tokens.
    - Fix: at `own` scope, the tools that act on an existing contract (`comment_add`, `contract_update`, `approval_route`, `redline_apply`) need `args.contractId` to be a contract the caller owns; else 404, as REST's own-scope guard answers. The same check runs on Undo, against the arguments stored on the ToolCall.
    - Unchanged: `contract_create_from_template` and `request_create` create the caller's own records, and `approval_decide` already only acts on the caller's own step.
    - Test: `routes/agent-write-scope.integration.test.ts`, with a custom own-scope editor.
  - **What changed:**
    - `agent-threads.ts` `checkToolPermission` takes the record a call acts on. At `own` scope:
      - `comment_add` / `contract_update` / `approval_route` / `redline_apply` need `args.contractId` to be a contract the caller owns (404 otherwise).
      - Undo re-checks the current owner of the record it acts on: the targeted contract, or for `contract_create_from_template` / `request_create` the contract or request the call created.
    - `internal-ai.ts` `comment_add`: a `parentId` must be a comment on the same contract, as REST requires. Otherwise a reply could be filed into another contract's thread, even another org's, at any scope.
    - `comments.ts`: the thread list only inlines replies filed on its own contract.
  - **Verification:**
    - `routes/agent-write-scope.integration.test.ts` has 6 cases:
      - `assign_owner` to itself on another rep's contract;
      - commenting there;
      - own edit plus undo after reassignment;
      - a misfiled reply, with a pre-fix misfiled row not showing;
      - undo of a drafted contract after reassignment;
      - an org-scope positive.
    - Against the pre-fix code, 5 fail; the org-scope case is the control.
    - A fresh subagent reviewed this adversarially. Its two findings (the `parentId` cross-thread write, and undo of create tools) are fixed above. It confirmed that ids in `payload`, clause and version ids, workflow ids and undo ids can't redirect a call.
  - **Found, filed separately:** X24.
  - **Left as is:** `assign_owner` is the only way to reassign a contract anywhere; REST has none. It stays behind `edit:contract` and, at own scope, ownership.
  - Original note: `checkToolPermission` (`agent-threads.ts:63-89`) checks grant only, so a custom role with own-scope `edit:contract` can `contract_update`/`approval_route`/`comment_add`/`redline_apply` any org contract. No default role affected. (Found in S2 review.)
- **X11 — Text→HTML conversion does not escape, and Gotenberg renders it server-side (High). — DONE.**
  - **Plan:**
    - Reproduced, and worse than the note says. The local Gotenberg fetched every internal URL in the HTML: `<img>`, `<iframe>`, `<link>`, `<object>`, CSS `url()`/`@import`, SVG `<image>`, `<meta http-equiv=refresh>`, and a script's `fetch()`. An iframe or a refresh printed the internal page's text into the PDF ("INTERNAL SECRET PAGE" came back out of `pdftotext`). `POST /contracts/export` renders any HTML in its body and returns the PDF, so every role with `view:contract` has a full-read SSRF. The `html-version` save does the same through the canonical PDF. The extraction builders are one source of such HTML; the editor, the export body and AI drafts are others.
    - Root cause: nothing between user HTML and the renderer. Every render must be made unable to load anything.
    - Fix:
      - New `lib/render-html.ts`, `renderableHtml()`: parse5 (already a dependency) parses the HTML. It drops elements that load or navigate, event handlers, and URL attributes other than inline `data:` images and `<a>` links; neutralises CSS `url()`/`@import`; and drops CSS with escapes. It rebuilds the document with a strict CSP `<meta>` first in `<head>`, as a backstop.
      - `lib/gotenberg.ts`: one `renderHtmlToPdf()` that always sanitises. It is used by `renderHtmlToPdfAndStore` (the html-version save and sealing) and by `/contracts/export`. `/export` had its own fetch, which also skipped the Cloud Run auth header and defaulted to the API's own port.
      - Escape text in the builders: `lib/document.ts` (TXT, pdf-parse fallback) and `apps/agents/app/routes/extract.py` (spans, headings, OCR lines; the section-tree reader unescapes).
      - Self-host compose: Gotenberg with JavaScript disabled, if a throwaway container proves inline images still render.
    - Acceptance:
      - The live probe gets zero hits from `/contracts/export` and from the canonical render. Before the fix the same test fails.
      - Contract formatting, tables, links and inline images survive.
      - Uploaded text is stored escaped, and the section tree reads the same text as before.
    - Blast radius: every Gotenberg HTML render. PDFs lose external images and scripts, which contract HTML never needs; the editor has no image extension.
    - Tests:
      - `lib/render-html.test.ts` (unit).
      - `routes/render-ssrf.integration.test.ts`, gated on a live Gotenberg like the ES tests.
      - An escaping unit test for `document.ts`.
      - A tripwire on `extract.py`.
  - **What changed:**
    - New `lib/render-html.ts`, `renderableHtml()`. parse5 parses the HTML through a tree adapter that stops past 128 levels of nesting or 200k elements (input capped at 5M characters). It then:
      - drops elements that load, embed or navigate, and comments;
      - unwraps elements with mangled names (a NUL in the tag);
      - drops event handlers, and URL attributes except inline `data:` images and `<a>` links;
      - neutralises CSS `url()`, `@import` and image functions, and drops CSS containing escapes;
      - rebuilds the document with the CSP `<meta>` first in `<head>`.
      - Refused input throws `RenderRefusedError`, which `/export` turns into a 422 with the reason.
    - `lib/gotenberg.ts`: `renderHtmlToPdf()` is the only way HTML reaches Gotenberg. It backs `renderHtmlToPdfAndStore` (html-version, sealing) and `/contracts/export`, whose own fetch is gone; that fetch had also skipped the Cloud Run auth header and defaulted to the API's port.
    - Text is escaped where HTML is built: `lib/document.ts` (TXT, pdf-parse fallback) and `apps/agents/app/routes/extract.py` (span text, headings, OCR lines). The Python section-tree reader decodes it back.
    - Gotenberg runs with `--chromium-disable-javascript=true --chromium-allow-list=^file:///tmp/.*` in `docker-compose.yml`, `docker-compose.selfhost.yml` and `scripts/deploy.sh`. A throwaway container showed inline images still render and even raw hostile HTML fetches nothing.
  - **Verification:**
    - `routes/render-ssrf.integration.test.ts`, which uses a probe server and skips without a live Gotenberg:
      - Before the fix, `/export`'s renderer fetched `/img`, `/script`, `/css`, `/iframe` and `/refresh` from the probe, and an iframe or refresh printed "INTERNAL SECRET PAGE" into the PDF.
      - After the fix, nothing is fetched from `/export` or the canonical render, and 50,000 nested `<div>`s get a 422 in milliseconds.
    - Unit tests (all fail pre-fix):
      - `lib/render-html.test.ts` (8 cases: hostile elements and attributes, legitimate content kept, CSP first, the depth guard, mangled tags, CSS);
      - `lib/document-escape.test.ts` and the `lib/extract-escaping.test.ts` tripwire.
    - Python behaviour checked locally with FastAPI stubbed: span HTML is escaped, and the section tree reads the text back unchanged.
    - Suite: typecheck 0, lint 0 errors, api unit 226/226, api integration 163/163.
    - A fresh subagent reviewed this adversarially against the live Gotenberg and found no SSRF bypass: parser differentials, foreign content, CSS tricks and entity-encoded schemes were all blocked, and legitimate contracts render. It found a DoS: `renderableHtml` overflowed the stack at about 2,000 nested elements, and deep nesting blocked the event loop for 44s. That is fixed by the bounded parse above. Its other notes, mangled tag names and CSS image functions, are fixed too.
  - **Deploy:**
    - Recreate Gotenberg so the new flags apply (`docker compose up -d gotenberg`, or `deploy.sh gotenberg`). The local dev container was left as it was during this run.
    - Production Gotenberg is still public on Cloud Run (`--allow-unauthenticated`). Making it private is the hardening `deploy.sh` already documents as deferred.
  - **Left as is:** a CSP can't block a `<meta http-equiv=refresh>` navigation. That vector is closed by the sanitiser dropping every `<meta>`, with the Gotenberg allow-list as the backstop.
  - **Test follow-up (final sweep):** `render-ssrf.integration.test.ts` skipped its two Gotenberg cases whenever the `/health` probe took over 2 s. Under the full suite's load it did, once, so the cases silently didn't run. The probe now waits up to 15 s; a stack without Gotenberg still refuses at once.
  - Original note: `lib/document.ts` builds `<pre>${text}</pre>` (TXT) and `<p>${block}</p>` (PDF) unescaped, and `apps/agents/app/routes/extract.py:282-287` does the same for headings. So `<img src=x onerror=…>` in an uploaded TXT lands verbatim in `htmlContent`. The web app sanitizes (DOMPurify/TipTap), but Gotenberg renders `htmlContent` with JavaScript enabled (`seal-contract.ts:96` for file-less versions, `contracts.ts:774` `/:id/html-version`). That is SSRF from the render container; in self-host, Elasticsearch (security disabled) sits on the same network. Escape in the builders; consider disabling JS / network in Gotenberg renders. (Found in S3 review.)
- **X12 — DOCX extraction is broken app-wide (High). — DONE.**
  - **Plan:**
    - Confirmed: the root `pnpm.overrides` pins `@xmldom/xmldom` to `>=0.8.13`, which resolves to 0.9.10. mammoth 1.12.0, its only dependent, declares `^0.8.6` and calls the 0.8 `parseFromString` without a MIME type, which 0.9 rejects. Every DOCX parse throws.
    - Fix: narrow the override to `^0.8.13`. That keeps the floor the override exists for, and stays in mammoth's declared range. Then `pnpm install` updates the lockfile.
    - This is a lockfile change, but a correction to an over-broad override, not an upgrade. It is flagged for review in the summary.
    - Test: `lib/document-docx.test.ts`. A DOCX made by the app's own `generatePlainDocx` must extract; it fails with 0.9.
  - **What changed:**
    - `package.json` `pnpm.overrides`: `@xmldom/xmldom` goes from `>=0.8.13` to `^0.8.13`. The lockfile moves 0.9.10 to 0.8.15; nothing else changes (12 lines, mammoth is the only dependent).
    - Review this lockfile change. It narrows an over-broad override back into mammoth's own declared range (`^0.8.6`) and keeps the `>=0.8.13` floor the override exists for. It is not an upgrade.
  - **Verification:**
    - `lib/document-docx.test.ts`: a DOCX written by the app's own `generatePlainDocx` extracts, text and headings. Before the change it fails with the exact error: `DOMParser.parseFromString: the provided mimeType "undefined" is not valid`.
    - Full suite after the install: db:generate 0, typecheck 0, lint 0 errors, api unit 260/260, web 14/14, api integration 190/190.
  - **Deploy:** reinstall dependencies (`pnpm install`) and restart the API and workers. The local dev servers running during this run still have 0.9 loaded.
  - Original note: `mammoth@1.12.0` + `@xmldom/xmldom@0.9.10` (root override `>=0.8.13` resolves to 0.9.x): every `extractDocx` throws `DOMParser.parseFromString: the provided mimeType "undefined" is not valid.` Reproduced here with a DOCX generated by the app's own `generatePlainDocx`. Every DOCX upload fails parsing, and `/templates/upload` always 422s. The fix is a dependency constraint (cap the override below 0.9, or move mammoth to a release compatible with xmldom 0.9), so it needs a lockfile change. (Found in S3 review; verified.)
- **X13 — DOCX zip bomb. — DONE.**
  - **Plan:**
    - Confirmed by the S3 review: a 714KB DOCX passes the content check and inflates to about 960MB inside mammoth's JSZip. That is a memory DoS on the parse worker, reachable from the external portal. X12 masked it until now.
    - Fix, in `lib/file-type.ts`: `zipInflatedSize(buf, limit)` inflates each entry with Node's zlib `maxOutputLength`, so it measures the real size without allocating past the limit. Sizes declared in the central directory can lie.
      - `checkUpload` refuses a DOCX/XLSX that inflates past 100MB (413).
      - `extractDocx` refuses before mammoth, for files stored before this check.
    - Tests: unit tests with a synthetic bomb, plus the app's own DOCX as the positive.
  - **What changed:**
    - `lib/file-type.ts` `zipInflatedSize(buf, limit)` inflates each entry with zlib's `maxOutputLength`, so it measures the real size and stops at the cap. A DOCX/XLSX over 100MB inflated (or unreadable) gets 413 from `checkUpload`, which covers every upload path from S3.
    - `lib/document.ts` `extractDocx` refuses the same before mammoth. That covers files stored before this check.
  - **Verification:**
    - `lib/docx-bomb.test.ts` (3 cases): a 122KB DOCX that inflates to 120MB is refused at upload in milliseconds and refused by extraction, and the app's own DOCX passes.
    - The pre-fix `checkUpload` accepted the same bomb (`{"ok":true,…}`, checked directly against HEAD's `file-type.ts`).
    - Suite: api unit 260/260.
  - Original note: A 714KB DOCX passes the content check and inflates to about 960MB in JSZip before erroring: a memory DoS on the parse worker, reachable from the external portal. It is currently masked by X12. Cap the total uncompressed size (central-directory sizes) before handing the file to mammoth. (Found in S3 review.)
- **X14 — Inbound email edge cases (Low). — DONE.**
  - **Plan:**
    - Confirmed:
      - `parts({ limits: { files: 5 } })` makes busboy reject the sixth file part, so an email with several inline images before the PDF gets 413, and the `continue` for extra parts never runs.
      - The 25MB check runs after the first PDF/DOCX is chosen, so an oversized first document returns 413 instead of trying the next.
    - Fix, in `readInboundBody`:
      - Read up to 50 file parts. Keep (buffer) only parts whose bytes are a PDF/DOCX, at most 5, and drain the others unbuffered. Their names are still listed in the "no usable attachment" reply.
      - A part over 25MB is read with `throwFileSizeLimit: false` and skipped, so the next candidate gets its turn.
    - Test: `routes/inbound-email-attachments.integration.test.ts` (S3 and queue mocked).
  - **What changed** (`routes/inbound-email.ts`):
    - Up to 50 file parts are read. Only parts whose bytes are a PDF/DOCX are buffered (at most 5); the rest are drained unbuffered and listed by name.
    - A part over 25MB is skipped (read with `throwFileSizeLimit: false`) rather than failing the email.
    - Attachment selection skips an oversized candidate and moves to the next. It answers 413 only when nothing usable is left.
  - **Verification:** `routes/inbound-email-attachments.integration.test.ts` has 3 cases: 7 inline images before the PDF, an oversized first PDF, and a reply for no usable document. The first two fail pre-fix with 413. The third is a control.
  - Original note: `inbound-email.ts:92` sets `limits.files`, so a sixth file part throws `FilesLimitError` (413) and the `continue` at `:96` is dead code: emails with many inline images are rejected. The 25MB check runs after the attachment is chosen, so an oversized first document 413s instead of trying the next. (Found in S3 review.)
- **X15 — `portfolio_agent.py` queries as org `system` (Medium). — DONE.** Added `x-org-id: org_id` to the portfolio agent's `/api/v1/search/advanced` call and put the file in the `lib/agents-internal-headers.test.ts` tripwire (fails without the header, passes with it). The portfolio agent has no web UI (H3), so no live check applies.
  - **Follow-up (C8's live check):** the portfolio agent never got as far as searching. `_PARSE_PROMPT`'s JSON example used single braces, so `str.format()` raised and every portfolio query answered "Could not parse question: …". It also has an API route (`POST /api/v1/search/portfolio-query`), so "no live check applies" was wrong. Fixed with C8's follow-up and covered by the same tripwire. Live: "How many SOWs do we have with Ironbridge Industrial Group?" parsed to `{q: "Ironbridge Industrial Group", type: "SOW"}` and answered from the 2 contracts the search returned. One of them is Stark Industries, a loose keyword match: that is search ranking, not this bug.
  - Original note: `apps/agents/app/agents/portfolio_agent.py:110` sends `x-internal-secret` + `x-internal-service` but no `x-org-id` to `POST /api/v1/search/advanced`, so `requireAuth` resolves the org to `'system'` and the ES query matches nothing. That is the same defect as C8, in the `/agent/portfolio` path (`routes/agent.py`). Add `x-org-id: org_id` and extend `lib/agents-internal-headers.test.ts` to cover it. (Found in C8.)
- **X16 — Binder detection sees only the first 10,000 characters (Low). — DONE** (VERIFY-PENDING → DONE after the live check and follow-up below).
  - **Plan:**
    - Confirmed: `detect_binder.py` sends `plainText[:10_000]`. An agreement that starts later in a long binder is never seen, so the binder is analysed as one document.
    - Fix: for long text, send the first 6,000 characters, then up to 8 excerpts (1,200 characters each) around likely agreement boundaries. Candidates are ALL-CAPS titles ending in AGREEMENT / ADDENDUM / AMENDMENT / ORDER FORM / STATEMENT OF WORK / EXHIBIT / SCHEDULE / LICENSE, and "IN WITNESS WHEREOF". Evenly spaced excerpts fill any remaining slots.
    - Each excerpt is prefixed with its absolute character offset. The prompt says so, so `charStart` refers to the whole document. The payload stays under about 16k characters.
    - Tests:
      - A TS tripwire (no Python runner in CI).
      - A local check of the sampler on a synthetic 200k-character binder.
    - Live LLM behaviour can't be verified here, so it will end VERIFY-PENDING.
  - **What changed** (`apps/agents/app/routes/detect_binder.py`):
    - `_sample()` sends texts up to 10k characters whole. Longer texts become the first 6k characters plus up to 8 excerpts of 1.2k.
    - The excerpts sit around likely agreement boundaries: ALL-CAPS agreement titles and "IN WITNESS WHEREOF", topped up with evenly spaced windows. Each is prefixed `[[EXCERPT starting at character N of M (about P% …)]]`, and the prompt says `charStart` must be the offset in the full document.
  - **Verification:**
    - Locally, with FastAPI stubbed, on a synthetic 194k-character binder with the second agreement at 146k: the 16k sample contains the MSA title (excerpt at 146,271) and the preceding signature block (143,826). Short text is unchanged.
    - Tripwire `lib/detect-binder-sampling.test.ts` (3 cases) fails pre-fix and passes after.
  - **Still to verify:** a live run with an LLM key on a real long binder, checking that the second agreement is detected and that `charStart` and the resulting page ranges land on it. This environment has no platform LLM key.
  - Original note: `apps/agents/app/routes/detect_binder.py:22` truncates the text, so agreements that start later in a long binder are never detected. Send head + evenly spaced windows (or page-boundary heading candidates) instead of widening the prompt linearly. (Deferred from C10.)
  - **Live check (2026-09-23, local stack):** a 13-page PDF binder with its second agreement (a SOW) starting at character 42,837 of 43,570, on the last page.
    - Detection works: the agents service sampled 16,234 of 43,570 characters and found 2 agreements (confidence 0.90), and the binder was split automatically.
    - **But the split was wrong:** MSA pages 1–6, SOW pages 7–13. The worker turned detection into pages using only the model's "~page N" hints and ignored `charStart`. A text sample carries no page numbers (the prompt never gives the page count), so the hints were guesses, and the worker fell back to spacing the agreements evenly. Half the MSA went into the "SOW" child, which was then typed SLA.
  - **Follow-up fix:** `docsToSplitSpecs` moved to `lib/binder-pages.ts` (the worker module starts a BullMQ worker on import). It now places each agreement by its `charStart` in proportion to the text, which the detector reports as an absolute offset since this fix. It falls back to the hints only when the offsets are missing, out of range, out of order, or the first isn't near the start. Two agreements whose offsets fall on one page start on consecutive pages. The worker passes the text length.
    - The placement is approximate where page densities differ, since the extracted text keeps no page boundaries. The split can be adjusted after, as before.
    - `lib/binder-pages.test.ts` (3): the live binder's offsets give MSA 1–12 and SOW 13; agreements sharing a page; the hint fallback. **The first two fail on the hint-only mapping.**
    - **Passed live after the fix:** the same binder, uploaded again, split into MSA pages 1–12 (all 130 sections, no SOW text) and SOW page 13 (752 characters, typed SOW).
    - The first, wrongly split upload is still in the local data: "Contoso / Fabrikam — MSA + SOW No. 1 (long binder check)".
- **X17 — Diligence-room contracts still count on org dashboards (Medium-Low). — DONE.**
  - **Plan:**
    - Confirmed: analytics (summary, distributions, timeseries, top counterparties), the dashboard KPIs, renewals (list, export, stats), obligations (list, export, stats) and counterparty counts and detail filter by org, and for own scope by owner, but never by `diligenceRoomId`. A target's contracts in a room therefore inflate the org's figures.
    - `/contracts/:id/precedents` compares the contract with peers from rooms too, and averages every version's clauses, superseded text included.
    - Fix:
      - One helper, `portfolioWhere(req)` in `lib/own-scope-guard.ts`: `diligenceRoomId: null` plus own scope, used by analytics, renewals and counterparties. The dashboard KPIs and "my …" cards get the same filter.
      - Obligations exclude room contracts except when one contract is named. A room contract's own obligations rail still lists its obligations, as C11 lets a room or a named contract through.
      - Precedents average the effective version only (C11's `effectiveVersionsSql`, now exported), for the contract and each peer, and skip rooms.
      - The HNSW index covers every org's clauses, and the org, version and room filters apply after it. A plain index scan can therefore return fewer than top-k rows: its `ef_search` candidates, mostly other orgs'. On pgvector 0.8+ (checked once), `searchClauses` runs with `SET LOCAL hnsw.iterative_scan = relaxed_order` in a transaction and re-sorts by similarity.
    - Decision:
      - Matter views are left as they are. A room contract only joins a matter by explicit attach, and REST and `matter_list` now count the same rows (X25 follow-up).
      - The dashboard's activity feed still titles room contracts' events: it is a log of what happened, not a figure.
  - **Verification:**
    - `routes/diligence-portfolio.integration.test.ts`:
      - Snapshots analytics summary, distributions and top counterparties, renewal and obligation stats, the counterparty list and detail, and the dashboard. It then adds a room contract (same type, counterparty, value, expiry, an obligation, embeddings) and requires every snapshot to be identical.
      - The room contract is absent from the renewals and obligations lists, while `?contractId=` still lists its obligation.
      - Precedents: the room contract is not a peer, and a peer whose current text matches scores >0.99. Averaging the superseded version made it ~0.71.
    - Against the pre-fix code both cases fail.
    - The retrieval suites (`retrieval-scope`, `agent-scope`, `own-scope-rest`, `clause-flags-index`) pass on the iterative-scan path, since the test DB has pgvector 0.8.2.
    - Suite:
      - typecheck 0, lint 0 errors;
      - api unit 268/268, api integration 236/236.
  - **Left as is:** the test DB is too small for the planner to choose the HNSW index, so the iterative scan's effect can't be shown there, only that the path works. Production needs pgvector ≥ 0.8 for it; older versions keep the previous behaviour.
  - **Follow-up (adversarial review of c82ca73):** a fresh subagent reviewed the commit and confirmed each miss against the test DB. Fixed:
    - **Scanners.** The daily obligation and renewal scanners still emailed the uploader about a target's obligations and renewals, and fired the org's `obligation.overdue` webhook for them. Both now skip room contracts. The obligation scan also skips deleted contracts, which kept sending reminders after a delete; that bug is older.
    - **Invoice auto-match** could match a target's payment obligation, and reconciling would then close it. It no longer can; an explicit contract link still may name a room contract.
    - **Team workload** counted every room upload (DRAFT, owned by the uploader) as the uploader's active contracts. The dashboard's org-wide approval count counted room approvals for org-scope callers.
    - **Extraction review queue:** a freshly analysed room could push the org's own contracts out of its 500 most recent. It excludes rooms unless `?diligenceRoomId=` asks for one room's queue (or `?contractId=` names a contract).
    - **Precedents:** the `effectiveVersionsSql` DISTINCT ON ranked every version in the org on every call (≈55 ms at 5k contracts vs 0.2 ms). It now takes the candidate filter inside (type, status, live, no room).
    - **Clause search** under pool pressure: the interactive transaction failed at Prisma's 2 s `maxWait` where a plain query waits up to 10 s. It now waits 10 s. A search within one contract skips the transaction (it scans exactly), and a failed pgvector version check is retried instead of cached.
    - Tests: `diligence-portfolio.integration.test.ts` now has 5 cases, adding scanners, invoice matching, and workload with the approval count and review queue. Against the pre-follow-up code, the 3 new cases fail.
    - Suite: typecheck 0, lint 0 errors; api unit 270/270, integration 247/247.
    - **Left as is:**
      - The counterparty detail no longer lists a counterparty's room contracts. Listing them separately as diligence information would be a feature.
      - The retrieval skill doc still says IVFFlat; the index is HNSW.
  - Original note: `analytics.ts:70-93,180-193,230,265`, `dashboard.ts:109-160,178,196,249,281`, `renewals.ts:70,184,236-241`, `obligations.ts:107-118,159,201-208`, `counterparties.ts:56,189`, `/contracts/:id/precedents` (`contracts.ts:1346-1400`, which also averages across all versions) and `matter_list` counts don't filter `diligenceRoomId: null`, so a target's contracts inflate the org's KPIs, renewals and obligations. Also consider `SET LOCAL hnsw.iterative_scan = relaxed_order` for filtered pgvector queries (post-filtering can return fewer than top-k). (Found in C11 review.)
- **X18 — Signing tokens go to anyone who can view the contract (High). — DONE.**
  - **Plan:**
    - Confirmed: `GET /contracts/:id/signature-requests` includes whole signer rows, so the response carries `token`. No other route returns tokens: the org-wide list selects fields without it, `/sign/:token` shows the other signers without theirs, compliance export and sealing don't return them, and no agent tool reads them.
    - Fix: in that route, only a caller holding `sign:contract` gets tokens (org scope, or own scope on a contract it owns). Everyone else gets the signer rows without `token`.
    - Web: `SignatureStatus` shows "Copy link" only when a token is present.
    - Acceptance: a VIEWER sees signers and their status but no token; LEGAL_OPS (can send for signature) still gets the link.
    - Blast radius: one read route plus a UI conditional. Sending, reminding and signing are unchanged.
    - Test: `routes/signing-tokens.integration.test.ts`.
  - **What changed:**
    - `GET /contracts/:id/signature-requests` returns signer tokens only to a caller holding `sign:contract`: org scope, or own scope on a contract it owns. Everyone else gets the signer rows without `token`, except their own row (matched by linked user or email, ignoring case), so an internal signer can still open their signing page.
    - Web: `SignatureStatus` shows "Copy link" only when the API sent the token.
    - Logs:
      - The signing-email console line prints the whole link only in development, where the console is the delivery channel.
      - The production request logger masks `/sign/:token` and `/portal/:token` (new `lib/log-redact.ts`).
  - **Verification:**
    - `routes/signing-tokens.integration.test.ts` has 6 cases: a VIEWER, an internal signer's own link, a sender, own-scope sign on an owned contract and on someone else's, a `contracts:read` API key, and the email log line. Against the pre-fix code, 5 fail; the sender case is the positive control.
    - `lib/log-redact.test.ts` (unit).
    - Suite: typecheck 0, lint 0 errors, web 14/14.
    - A fresh subagent reviewed this adversarially with 9 live probes. It found no other route, worker, webhook, audit row, notification, export, agent tool, portal or ES document that carries a token. Its findings on log exposure, internal signers and test gaps are fixed above.
  - **Deploy step:** tokens that viewers or `contracts:read` keys could already read stay valid until their request completes or expires (up to 180 days). To close that, re-issue the tokens of pending signers and re-send the emails; otherwise accept that risk explicitly.
  - **Depends on X10:** a custom role with own-scope edit and sign could make itself owner of any contract through the agent's `contract_update` (`assign_owner`) and then read its tokens. No default role can. Fixed in X10.
  - **Left as is:**
    - The seed scripts create predictable demo tokens (`prisma/seed.ts`). This only matters for a shared, seeded demo database.
    - Remind and Void still show for viewers and answer 403, as before.
  - Original note: `GET /contracts/:id/signature-requests` (`signatures.ts`, `include: { signers: true }`) returns each signer's `token`. The token is the only credential `POST /sign/:token/sign` needs, so a VIEWER (or any org-scope role, or a `contracts:read` API key) can sign as the counterparty. The sender does need the link (`SignatureStatus.tsx` "copy link"), so return tokens only to callers holding `sign:contract`. (Found in X7 review; confirmed with a VIEWER.)
- **X19 — `POST /invoices` links a contract from another org (Medium). — DONE.**
  - **Plan:**
    - Root cause: `invoices.ts` create stores `body.contractId` unchecked. `autoMatchInvoice` scores every open payment obligation in the org whatever the caller's scope, and create and `/:id/rematch` return the matched contract's title and counterparty and the obligation's description.
    - Fix, in `routes/invoices.ts` only: a supplied `contractId` must be a live contract of the caller's org (and owned, for own scope), else 404 and nothing is created. For own scope, the matcher considers only obligations on the caller's contracts, in both create and rematch.
    - Acceptance:
      - Another org's contract id gets 404 and no row.
      - An own-scope editor can't link or auto-match another rep's contract, on create or rematch.
      - An org-scope caller's auto-match and a same-org `contractId` still work.
    - Blast radius: invoice create and rematch only; list and read were scoped in X7. Test: `routes/invoice-link.integration.test.ts`.
  - **What changed** (`routes/invoices.ts`):
    - A supplied `contractId` must be a non-empty id of a live contract in the caller's org (owned, for own scope). Otherwise the create returns 404 and writes nothing; an empty string now gets 400 instead of 500.
    - The auto-matcher only considers obligations on live contracts, and for own scope only on contracts the caller owns. This applies to create and rematch.
    - Reconcile closes the matched obligation only within the org and on the invoice's own contract.
    - Repair migration `20260923010000_unlink_cross_org_invoices` unlinks invoices created before the fix that point at another org's contract (or obligation). Until it runs, the list and detail still show such a contract.
  - **Verification:**
    - `routes/invoice-link.integration.test.ts` has 9 cases: cross-org link, other-rep link, own-scope auto-match on create and rematch, own-scope positive, deleted contract, empty id, reconcile, the migration SQL on a pre-fix row, and org-scope positives. Against the pre-fix `invoices.ts`, 5 fail. The other 4 are positive controls.
    - Suite: typecheck 0, lint 0 errors, api integration 139/139.
    - A fresh subagent reviewed this adversarially. Nothing leaked. It also confirmed that `matchedObligationId` is never client-controlled and that a pre-fix row can't make reconcile close another rep's obligation. Its Low findings are fixed above: deleted contracts, pre-fix links, the empty-id 500, the reconcile bound, and the test gaps.
  - **Left as is:**
    - A misconfigured custom role with own-scope view but org-scope edit gets matches org-wide on create and rematch, because the scope comes from `edit:contract`.
    - An own-scope rematch that finds nothing unlinks the invoice, as rematch always has. That loses a link but exposes nothing.
  - Original note: The create route stores `body.contractId` without checking its org, and the 201 response includes that contract's title and counterparty. Validate the contract against the caller's org (and ownership for own scope). For own scope, limit the auto-matcher to the caller's contracts, in both create and `/:id/rematch`. (Found in X7 review; confirmed.)
- **X20 — Upload accepts any `parentContractId` (Medium). — DONE.**
  - **Plan:**
    - Confirmed: `POST /contracts/upload` stores the form's `parentContractId` unchecked. It is the only client-supplied parent id; binder splits and `/amendments` set it server-side.
    - `/contracts/:id/family`'s children and parent aren't filtered by org, so a cross-org link shows the other org's contract.
    - Fix:
      - The upload's parent must be a live contract of the caller's org, and owned for own scope, as the X7 guard requires for `/amendments`. Otherwise 404 and nothing is stored.
      - The family view filters children and parent by org.
      - Repair migration `20260923020000_unlink_cross_org_parents` clears existing cross-org parent links.
    - Test: `routes/contract-parent-link.integration.test.ts`, with S3 mocked as in the upload tests.
  - **What changed:**
    - `POST /contracts/upload` accepts a parent only when it is a live contract of the caller's org, owned for own scope (else 404 and nothing is stored). Form fields must be text: a part sent as JSON arrived as an object, which a Prisma `where` reads as a filter.
    - `/contracts/:id/family` filters children and parent by org, and hides a deleted parent.
    - Migration `20260923020000_unlink_cross_org_parents` clears cross-org parent links, and their `relationshipType`.
  - **Verification:**
    - `routes/contract-parent-link.integration.test.ts` has 7 cases: cross-org, other rep, JSON-typed field, own-scope positive, same-org positive, deleted parent, and cross-org child and parent in family plus the migration SQL. Against the pre-fix code, 5 fail; the two positives are the controls.
    - A fresh subagent reviewed this adversarially with 14 probes. No other path sets a parent from client input, and `/:id/family` is the only reader that follows the link. Its findings are fixed above (JSON-typed field, deleted parent, `relationshipType`), and it found X25 and X26.
  - Original note: `POST /contracts/upload` stores the form's `parentContractId` unchecked. A user in org B can file an upload as an amendment of an org-A contract; org A's `/contracts/:id/family` then lists org B's contract (title, type, status), because the relation isn't org-filtered. Validate the parent against the caller's org (and ownership for own scope, as the guard now does for `/amendments`), and filter the family query by `orgId`. (Found while fixing X7.)
- **X21 — Own-scope follow-ups (Low). — DONE.**
  - **Plan (each part confirmed in the code):**
    - The dashboard's `orgPendingApprovals` counted every approval in the org. Narrow it like the rest of the KPI strip: an own-scope caller counts the approvals on their own contracts.
    - `/team/workload` (requireAuth) returned every member's active-contract and pending-approval counts. The member directory and out-of-office status are deliberately visible to everyone (P14).
      - Decision: keep the rows, but show a count only where the caller could see what it counts: other people's contracts need `view:contract` beyond `own`, their approval queues `view:workflow` beyond `own`. The caller's own counts are always shown.
      - A hidden count is `null` and renders as "—", not as a misleading 0.
    - Signatures page: for an own-scope signer who doesn't own the contract, "Open" goes to a contract page that 404s. The org list now says whether the caller can open each contract, and gives a pending signer the path to their own signing page. The page links "Sign" there. Signer tokens stay out of the list (X18); only the caller's own appears, as that path.
    - Request conversion. Decision: the contract belongs to whoever asked for it, the requester, falling back to the converter when the requester is no longer an active member. It used to go to the converter, so a requester with own scope could never open the contract their request became. Legal, who converts, keeps access through org scope.
    - Collaboration server: `onAuthenticate` checked only that the contract is in the user's org. It now decides as REST does: `view:contract` (own scope means the owner), and a caller without `edit:contract` gets a read-only connection (Hocuspocus `connectionConfig.readOnly`). The hook is exported as `authenticateCollab` so it can be tested without a socket.
  - **What changed:** `routes/dashboard.ts`, `routes/team.ts`, `routes/signatures.ts`, `routes/requests.ts`, `lib/collab-server.ts`, and on the web `pages/TeamPage.tsx` (null counts) and `pages/SignaturesPage.tsx` (the Sign link).
  - **Verification:**
    - `routes/own-scope-followups.integration.test.ts` has 6 cases:
      - dashboard count for SALES_REP vs LEGAL_OPS;
      - workload: own count shown, others null, all shown to LEGAL_OPS;
      - Signatures row: `canOpenContract: false`, the rep's own sign path, no tokens, owned row openable;
      - conversion: owned by the requester, and the requester can open it;
      - collab: own-scope members refused on others' contracts; editor read-write; VIEWER and SALES_REP (no `edit:contract`) read-only.
    - Against the pre-fix code all 6 fail.
    - Typecheck (api, web) 0, lint 0 errors, web unit 14/14.
  - **Left as is:**
    - Contracts converted before this keep the converter as owner. Reassigning them is a business decision, not a migration.
    - The editor does not yet bind to the collaboration document, so the collab check can't be exercised live.
  - **Follow-up (review findings):**
    - A fresh subagent reviewed the commit adversarially and confirmed each finding against the test DB. Fixed:
      - **Sign link.**
        - A signer row's `userId` was never checked, so a row naming one person's address and another's id handed the same signing token to both.
        - `send-for-signature` now requires a linked user to be an active member whose address is the signer's.
        - Both lists that give a signer their own link match on the linked id when there is one, else on the address.
      - **Turn.** The link was given before a sequential signer's turn and after expiry; now it is only while their group is being asked and the request is live.
      - **Convert.** It was gated on `edit:request` only. An API key with just request scope could create contracts (and queue AI drafts) that `POST /contracts` refuses it. Before X21 the key id failed the owner foreign key, so this was newly reachable. It now needs `create:contract` too, and records the converter as `createdBy`.
      - **Email wildcard.** The own-scope signature list matched the caller's email with Prisma's insensitive `equals`, which runs as ILIKE, so `_` was a wildcard (`j_doe@` saw `j.doe@`'s requests; from X7). The value is now escaped.
      - **Web.**
        - The title on a signature row no longer links to a contract the caller can't open.
        - Team workload bars are hidden when counts are, since there is no peak to compare with.
      - **Dashboard.** The own-scope approval count skips deleted contracts.
    - Tests: `own-scope-followups.integration.test.ts` now has 11 cases, adding:
      - a mislinked signer refused at send;
      - a mixed row only the linked user's;
      - sequential turn and expiry;
      - `_` doesn't match `.`, while the exact address in any case does;
      - convert without `create:contract` refused, with the request untouched.
    - Against the pre-follow-up code, the 5 new cases fail.
    - Behaviour that comes with the requester owning a converted contract, noted for review:
      - obligation reminders go to the requester;
      - the contract leaves the converter's "my drafts" / "negotiations";
      - custom own-scope roles get edit/sign rights over contracts legal drafted for them;
      - a converter with own-scope view lands on a 404 after Accept.
    - Filed from the review: X28 (the signer portal lets a later sequential signer view and decline early) and X29 (the collab session is checked once per socket).
  - Original note: Two aggregates still count the whole org for own-scope callers: the dashboard's `orgPendingApprovals` and `/team/workload`. The Signatures page's "Open" link 404s for an own-scope signer who doesn't own the contract; it should go to their signing page. A request converted by someone else becomes the converter's contract, so the requester can't open it (`requests.ts` convert); decide whether the requester should own it. `collab-server.ts` accepts any org member for any contract; this is latent until the editor binds to the shared document. (From X7 review.)

- **X22 — Agent feedback trusts a client-supplied trace or session id (Low). — DONE.**
  - **Plan:**
    - Confirmed: `POST /agent/feedback` scores `body.traceId` as given, or the latest trace of `body.sessionId`. Neither is checked against the caller, and `recorded` vs `trace_not_found` answers whether a session exists.
    - The agents service sets a chat turn's trace `userId` to the user (`user_id or org_id`) and its metadata `org_id` (`apps/agents/app/tracing.py`). User ids are unique across orgs.
    - Fix: `lib/langfuse.ts` checks ownership:
      - a named trace must have `userId` equal to the caller, and a metadata `org_id`, when present, equal to the caller's org;
      - a session lookup asks Langfuse for the caller's traces only (`userId` filter) and applies the same check to the rows.
      - Anything else answers `trace_not_found`, as a missing trace does.
    - Test: `routes/agent-feedback.integration.test.ts` against a fake Langfuse that applies its public API's `userId` filter.
  - **What changed:** `lib/langfuse.ts` adds `traceOwnedBy()` and an owner-scoped `findTraceBySession()`. `routes/agents.ts` feedback uses both with `{ orgId, userId }` from the token.
  - **Verification:**
    - 4 cases:
      - another org's trace id is not scored and answers like a missing one;
      - a colleague's trace or session is not scored;
      - a session id shared with another user resolves to the caller's own turn, not the other user's newer one;
      - the caller's own trace is scored.
    - Against the pre-fix code, 3 fail; the positive case passes.
    - Typecheck 0, lint 0 errors.
  - **Left as is:**
    - Langfuse still groups traces by the client's thread id, so in the Langfuse UI a reused thread id shows two users' turns in one session. That is visible only to operators. Namespacing the session id in `tracing.py` would orphan every existing session's feedback lookup.
    - A trace counts as the caller's only when the agents service stamped it with the caller's id. That holds for their chat turns, and for drafts, which forward the requester's id. Traces stamped with an org id (other background work) can't be scored by anyone.
  - **Follow-up (review findings):**
    - A fresh subagent reviewed the commit adversarially. It found no way to get another user's or org's trace scored, and confirmed that real chat traces carry the user's id.
    - It found three things, now fixed:
      - A named `traceId` was fetched by id. A foreign trace (a large response) and a missing one (a fast 404) answered alike but took different times. `"."` also collapsed the URL onto the list endpoint.
      - A trace without a `userId` would pass an `undefined === undefined` check.
      - The docstring said "oldest" for the newest.
    - Now a named trace is resolved within the caller's own session list (`userId` filter, `fields=core,io`), so it is never fetched by id, and ownership needs a string `userId`.
    - Test: a fifth case asserts the only Langfuse lookup is the caller's own list. It fails before the follow-up.
  - Original note: `POST /agent/feedback` (`agents.ts:60-85`, `lib/langfuse.ts:91-108`) scores whichever Langfuse trace a raw `traceId` or `sessionId` names, with no org or owner check. So any user can score another org's traces, and the `recorded` / `trace_not_found` answer reveals whether a session exists. Langfuse also groups traces by the client's session id, so a reused thread id mixes users' traces. Scope the lookup to traces tagged with the caller's org and user. (Found in X8 review.)
- **X23 — PII redaction has gaps outside the chat tools (Medium). — DONE** (VERIFY-PENDING → DONE after the live check below).
  - **Plan (first cut):**
    - Background jobs: every agents-service call from the worker goes through `callAgents`. It applies the org's policy to every text field of the outgoing JSON (`applyPiiPolicyBatch`, one audit row per call). Ids can't match the PII patterns. Contract mode keeps emails and phones, so notice clauses survive.
    - Embeddings: clause texts are redacted before they go to the embedding provider.
    - `tokenize`: pseudonyms become an HMAC under a server secret (`PII_TOKEN_SECRET`, else `INTERNAL_SERVICE_SECRET`), so they can't be reversed by brute force.
    - `contract_validate` / `contract_summarize` / `portfolio_compare` fail closed if redaction throws.
    - `redline_propose` redacts the clause text it sends to the model and returns.
  - **Plan review (revised before any commit):**
    - Plain redaction on the worker path would corrupt stored contract data. The default mode is `redact` for every org.
      - The `/review` extraction's `clauseSegments` are verbatim quotes. They become `ContractClause.content`, and `applyClauseProposal` must later find them in the document. A clause stored as `…SSN [REDACTED:SSN]…` can't be found, so redlines on it 409.
      - A draft and redline proposals are text spliced into the contract, so `[REDACTED:…]` would replace the real value.
    - Fix: round-trip tokens. Where the model's output is stored, values go out as `[PII:KIND:<hmac>]`, keyed (the model can't reverse it) and scoped to the contract or request id (it doesn't link one contract's values to another's). `restorePii` rebuilds the map from the source text and puts the values back. `redact` vs `tokenize` makes no difference on these paths; `off` sends the text as is.
  - **What changed:**
    - `lib/pii-redactor.ts`:
      - `pseudonym()` is an HMAC.
      - `redactPii` takes a `token` replacement. For DOB and passport matches, only the value becomes the token and the keyword stays.
    - `lib/pii-policy.ts`:
      - `redactJson(value, { roundTrip, valuesFrom })` finds the values in a source text (the whole document where the payload holds only parts of it). It then replaces exactly those values in one pass, wherever they appear, with one policy read and one audit row. Matching each string on its own missed a card number whose "card" sat in another sentence.
      - `restorePii` treats a token two values share as ambiguous and leaves it.
      - `unresolvedPiiTokens`.
    - `workers/agent.worker.ts` `callAgents`, for every job, scoped to the contract or request, with the contract id on the audit row:
      - it redacts the body with round-trip tokens, using the version text as context for the playbook review;
      - it restores the reply, so the draft HTML, findings and intake classification are stored with real values;
      - it warns about tokens left unresolved;
      - an empty or 204 reply passes through, and a restore error fails the job instead of being swallowed;
      - redaction failing fails the job.
    - The extraction's callbacks (`routes/contracts.ts`) restore before storing:
      - `POST /:id/versions/:versionId/clauses` restores against that version;
      - `PATCH /:id` from the agents service restores against the version the extraction read. `review.py` now sends `?versionId=`; the fallback is the current version, then the latest. Before, a newer upload or an undo during extraction left tokens in the summary.
    - Clause proposers (`lib/clause-propose(-batch).ts`) send the clauses tokenized, judged against the current version, and restore the variants and proposals. That covers the review drawer and the playbook redline's staged proposals.
    - Chat tools `redline_propose(_batch)` (`routes/internal-ai.ts`):
      - Their result goes to the chat model, so every value found in the contract text or the named clauses is tokenized wherever it appears in the result: proposal, change list, rationale.
      - A value the document doesn't hold (one the user asked for, or one the model wrote) is left as written. It is nobody's data from this contract, and a token for it could never be restored.
      - The first cut restored the values and then re-detected them per string. That leaked card numbers and IBANs, and it made new values unrestorable tokens that `redline_apply` spliced into the contract.
    - `lib/clause-apply.ts`: apply and batch apply restore each proposal against its clause and the current version. A token that still doesn't resolve is refused (409 `PII_TOKEN_UNRESOLVED`, or `pii_token_unresolved` for that clause in a batch) instead of being written into the document.
    - `lib/embeddings.ts`: clause texts go to the embedding provider redacted, judged against the whole document. Without the version's org it fails instead of sending.
    - `contract_validate`, `contract_summarize` and `portfolio_compare` fail closed: 503, no text, if redaction throws.
    - Agents service:
      - `app/pii_tokens.py` `PII_TOKEN_RULE` ("copy the placeholder exactly…") is appended to every prompt whose output is stored: extraction, redline propose and batch, playbook review, and the draft agent's two prompts.
  - **Verification:**
    - `lib/pii-outbound.integration.test.ts` has 10 cases:
      - a worker-style body: no SSN, card or DOB; the schedule's card number caught without its own "card"; ids untouched; emails kept; `date of birth:` readable; restored only for its own scope;
      - an `off` org sends as is;
      - embeddings get no SSN or context-less card, and the stored clauses are intact;
      - extraction callbacks store the real text;
      - PATCH restores against the version read after a newer one became current;
      - `redline_propose`: the agents service and the chat model see no SSN, the drawer shows the real text, and a context-less card number never reaches the chat model;
      - a chat redline applies with the real values, and a new SSN the user asked for stays as written;
      - an unresolvable token is refused with 409;
      - fail closed returns 503.
    - `lib/pii-pseudonym.test.ts` has 5 cases:
      - the keyed pseudonym;
      - the `callAgents` tripwire;
      - Python tripwires for the prompt rule and `review.py`'s `versionId`.
    - Against the pre-fix code every case fails.
    - Suite:
      - db:generate 0, typecheck 0, lint 0 errors;
      - api unit 265/265;
      - api integration: everything but the X25 follow-up's new cases, which were written ahead of their code.
    - A fresh subagent reviewed the first cut adversarially. Its findings shaped the rework above:
      - (1) the chat path leaks, and new values become unrestorable tokens;
      - (3) PATCH restored against the wrong version;
      - (4) no guard against unresolved tokens;
      - (5) context words were judged per string;
      - (7) DOB and passport keywords;
      - (8) the `callAgents` edge cases;
      - (10) Dates in the walk, token collisions, and embeddings without an org.
      - It confirmed that no restore can reveal a value to anyone who couldn't read it, and that fail-closed and ids are clean.
  - **Why VERIFY-PENDING:** the round trip relies on the model copying `[PII:KIND:xxxxxxxx]` tokens verbatim, which the prompts now ask for, and only a live stack can show it. Upload a contract with an SSN and a card number. Check that the agents-service request carries tokens, and that the stored clauses, summary and key terms carry the real values. Then run a chat redline on that clause and apply it.
  - **Live check (2026-09-23, signed in to the local stack; agents service on :8003 running this branch, Gemini):** a services agreement PDF with an SSN (219-09-9999) and a Visa card number, uploaded under your session. The org's PII mode is redact. A logging proxy between the API and the agents service recorded, per call, only counts of tokens and of the fixture's raw values.
    - **Found and fixed (X52):** the PDF's line wrap split the card number across two lines, and the detector didn't join groups across a line break, so it would have reached the models whole.
    - With X52, `/detect-binder`, `/classify` and `/review` each received two tokens (SSN, card) and no raw value. `/extract` receives the PDF itself: that's local parsing (PyMuPDF and on-device OCR), not a model.
    - Stored results read with the real values and no token anywhere: summary, key terms, metadata, the 11 clauses, the version text.
    - **Found and fixed (X53):** a chat redline of "section 4" couldn't find the clause. Once fixed, the rewriter (`/redline_propose`) received 1 SSN token and returned 7 (kept verbatim), and the chat stream carried 8 tokens and no raw values. Applying the moderate variant made v2 with the real SSN, no tokens, and the requested sentence.
    - As already noted, the chat's redline preview shows the tokens themselves.
  - **Left as is:**
    - Contract text that other paths still send raw is filed as X27 (found in this review).
    - In the chat rail, a redline preview shows the contract's own values as tokens. The applied version has the real values. Showing them would mean restoring on the `/agent/chat` relay.
    - A token the model mangles in extraction output is stored as a visible token, with a warning in the log. Refusing would drop the whole extraction.
    - Cost: redacting or restoring takes about 140 ms per MB of text on the API event loop (callbacks, applies). Typical contracts are under 0.3 MB.
  - **Deploy:** `PII_TOKEN_SECRET` is optional. If you set it, set the same value on the API and the worker services: tokens are made in one and restored in the other. The fallback, `INTERNAL_SERVICE_SECRET`, is already shared. Rotating it changes pseudonyms; no tokens are stored.
  - **Follow-up (second adversarial review of f4f9d57):** it found these; all are now fixed.
    - The apply guard only knew exact tokens. In the default redact mode, a chat model copying `(SSN [REDACTED:SSN])` from `contract_get` into `redline_apply` wrote the marker over the real SSN (200). So did a token with upper-case hex, a lost bracket or escaped brackets.
      - Apply and batch apply now refuse any placeholder-shaped text: a mangled round-trip token, a tokenize-mode pseudonym, or `[REDACTED:KIND]`. The exception is text the clause or document itself contains.
      - Restore reads hex case-insensitively.
    - 32-bit tokens collided at census scale (two SSNs shared one token around 86k values). Round-trip tokens are now 64-bit, and the Python rule's example is updated.
    - A proposal failed with 409 once the word that made its value PII ("card") was edited out of the current version. Apply now also restores against the clause's own version.
    - The extraction's recall, validate and score passes, whose output is stored, lacked the token rule. They have it now.
    - The PATCH callback validated before restoring, so a tokenized date failed the schema and dropped the whole update. It now restores first. A restored date-only value is made full ISO, as `review.py` does for dates it can read.
    - The worker scanned org configuration (org name, custom-field options, playbook text) for values the callbacks could never restore. Values now come from the document (`/review`) or the request's own joined text (`classify_request`, which also fixes a per-string context miss).
    - Batch apply rebuilt the document's value map for every change. It is built once now (`piiRestorer`).
    - A lone rationale token refused a single apply but not a batch. The rationale is a note in both now.
    - Tokenize mode's pseudonyms used one global key, so the same SSN was the same token in every org's prompts. They are scoped to the org now.
    - A missing key now logs a warning; the old comment wrongly said a per-process key was enough.
    - Not changed:
      - Replacement inside longer numbers (e.g. a passport number inside an invoice number) stays. Restore is lossless, and leaving the digits would show them.
      - A value split across two sub-chunk windows for embeddings: the overlapping window carries it whole.
    - Tests: `pii-outbound.integration.test.ts` now has 14 cases, adding:
      - four placeholder shapes refused;
      - upper-cased hex resolved;
      - the edited-context proposal applied;
      - a tokenized date restored before validation;
      - per-org pseudonyms.
    - Against the pre-follow-up code, 6 fail. The full suite is green.
  - Original note:
    - The upload pipeline ignores the org's mode: `agent.worker.ts` sends raw `plainText` to detect-binder, classify and `/review`, and `embeddings.ts` sends raw chunks to the embedding provider.
    - `tokenize` is reversible: an unsalted SHA-256 cut to 32 bits (`pii-redactor.ts`), so SSNs, dates of birth and phone numbers can be brute-forced by whoever receives the text.
    - `contract_validate`, `contract_summarize` and `portfolio_compare` send unredacted text if redaction throws. They should fail closed.
    - `redline_propose` returns the clause text without redaction (`clause-propose.ts`). (From X9 review.)
- **X24 — `edit:contract` can mark a contract APPROVED without an approval (Medium). — DONE.**
  - **Plan:**
    - Confirmed: `PATCH /contracts/:id` and the agent's `set_status` share a transition table (two copies) that allows `PENDING_APPROVAL → APPROVED/REJECTED` and moves into `PENDING_APPROVAL` by hand. The web offers none of these (A.3 removed them as a workflow bypass). Only `/submit-approval` and `approval_route` enter PENDING_APPROVAL, and they also open the approval instance; only a decision or the workflow's auto-approve rule sets APPROVED / REJECTED.
    - Fix: one `lib/contract-status.ts` table without those targets, used by both paths. An attempt gets a 409 that points to submitting for approval.
    - Test: `routes/contract-status-approval.integration.test.ts` (REST and agent).
  - **What changed:**
    - `lib/contract-status.ts` is one manual-transition table for `PATCH /contracts/:id` and the agent's `set_status` (previously two copies). It has no transitions into PENDING_APPROVAL, APPROVED or REJECTED; `/submit-approval` / `approval_route` and the approval decision own those.
    - A refused move answers 409 with "…is set by the approval workflow… submit the contract for approval instead".
    - The workflow's own paths are untouched: submission, decisions, auto-approve, and the undo of `approval_route`.
  - **Verification:**
    - `routes/contract-status-approval.integration.test.ts` has 4 cases: REST APPROVED/REJECTED refused, REST into PENDING_APPROVAL refused, agent APPROVED refused, and ordinary moves still work. Against the pre-fix code, 3 fail.
    - Existing tests and verify scripts use only transitions that remain (DRAFT → PENDING_REVIEW).
  - Original note: `PATCH /contracts/:id` (`contracts.ts`, status change) and the agent's `contract_update` `set_status` let any role with `edit:contract` move a contract from `PENDING_APPROVAL` (or anywhere) to `APPROVED`. That bypasses the approval workflow: no approver, no decision recorded. Restrict transitions into `APPROVED` to the workflow engine (or to `approve:workflow`), and keep manual transitions to the ones a workflow doesn't own. (Found in X10 review.)
  - **Follow-up (final-sweep review, DONE):** REST and the agent's `set_status` hold, case variants included. The review found three other ways an approval status was set by hand:
    - **The CSV import (High).** It upper-cased the `status` column and accepted APPROVED and PENDING_APPROVAL with only create permission. A row `Acme MSA,approved` became an approved contract with no approval, feeding precedent search and past-deal memory. A PENDING_APPROVAL row could never leave that status. Now such a row is refused with a message saying to import it as DRAFT (or EXECUTED if signed) and submit it; the other rows import. The dialog shows the per-row error.
    - **The agent's status undo** wrote back the saved status with no check. After a portal upload, a resubmission and a rejection, an undo within the window put APPROVED back. The action now records the status it set (`snapshot.after`), and the undo applies only while the contract still has it (409 otherwise). Older snapshots fall back to the manual transition table, which refuses restoring an approval status.
    - **Late approval decisions** overwrote the contract's status: a contract signed while its approval stayed open was set back to APPROVED, or to DRAFT on a rejection. The engine now sets APPROVED or DRAFT only while the contract is still PENDING_APPROVAL; the instance is still decided.
    - **Verification (`contract-status-approval.integration.test.ts`, 3 new cases):**
      - the import refuses the approved and pending rows and imports the executed one;
      - an exact undo works, an undo after the status moved on gets 409, and an old snapshot can't restore APPROVED;
      - an approve and a reject on a contract signed meanwhile leave it EXECUTED and decide the instance.
      - Against the pre-fix code all 3 fail.
    - **Filed as X42** (not introduced by X24): an approval isn't tied to what was approved. Type, value and document can change after approval while the contract stays APPROVED.
- **X25 — Matters take other orgs' ids (Medium). — DONE.**
  - **Plan:**
    - Fix:
      - `PATCH /contracts/:id` accepts a `matterId` only for a live matter of the contract's own org.
      - `POST` / `PATCH /matters` accept `counterpartyId` / `ownerId` only when they belong to the caller's org.
      - The matter detail's contracts, requests and threads, and the list's counts, are filtered by org.
      - A repair migration clears cross-org links already stored (contracts, requests and threads to matters; matter counterparties). A foreign owner falls back to the matter's creator.
    - Test: `routes/matter-org-links.integration.test.ts`.
  - **What changed:**
    - `PATCH /contracts/:id`: a `matterId` must be a live matter of the contract's own org. This also covers internal `system` calls.
    - `POST` / `PATCH /matters`: `counterpartyId` / `ownerId` must be this org's (404 otherwise).
    - `GET /matters/:id`: contracts, requests and threads are filtered by org, and a foreign owner or counterparty stored earlier is shown as null. The list's counts are org-filtered too.
    - Migration `20260923030000_repair_cross_org_matter_links` clears cross-org matter links on contracts, requests and threads and on matter counterparties, and resets a foreign owner to the creator.
  - **Verification:**
    - `routes/matter-org-links.integration.test.ts` (4 cases):
      - a contract into another org's matter;
      - foreign counterparty or owner on create and patch;
      - same-org positives;
      - pre-fix rows hidden from the detail and count, then cleared by the migration SQL.
    - Against the pre-fix routes, 3 fail; the positives pass.
    - A fresh subagent reviewed the commit adversarially. It confirmed that every new cross-org link is refused. Its findings landed as a follow-up commit.
  - **Follow-up (review findings):**
    - The matters list still named a foreign counterparty and owner stored before the fix (only the detail view hid them). It now shows null for both, as the detail does.
    - The agent's `matter_list` counts weren't org- or delete-filtered (2/1/1 against REST's 1/0/0). They now match REST. REST's list counts also skip deleted contracts and requests now, as its detail view does.
    - An amendment copied its parent's matter unchecked, creating a new cross-org row after the fix. It now inherits only a live matter of its own org.
    - An empty `matterId` / `counterpartyId` / `ownerId` skipped the checks and hit the foreign key with a 500. It is now a validation error (`.min(1)`).
    - The migration's owner fallback now uses the creator only when the creator belongs to the matter's org. A foreign or deleted creator (only possible via seed data or SQL) would have kept a foreign owner, or failed the migration on the foreign key.
    - Test: `matter-org-links.integration.test.ts` now has 5 cases (list names, `matter_list` counts, amendment, empty ids, orphan owners). Against the pre-follow-up code, 2 fail at their first assertion: a 500 on the empty id, and the foreign counterparty's name in the list.
  - Original note:
    - `PATCH /contracts/:id` accepts any `matterId` (`schemas.ts:92`, `contracts.ts`). `GET /matters/:id` then lists the contract without an org filter, and the list's count includes it. `/:id/amendments` copies the foreign `matterId` onto new amendments.
    - `POST` / `PATCH /matters` accept another org's `counterpartyId` or `ownerId` (`matters.ts:37,43,170,203`). The matter view then returns that org's counterparty name and website, and the user's name, email and avatar.
    - Check each id against the caller's org, and filter the matter's includes by org. (Found in X20 review; both confirmed.)
- **X26 — Binder re-split deletes whatever `metadata._splitInto` names (Low). — DONE.**
  - **Plan:** `_`-prefixed metadata keys hold server state: analysis reports and the binder split's `_splitInto`. Users never write them; the web doesn't, and only the agents service (as `system`) does, for its own reports. `PATCH /contracts/:id` will refuse `_` keys from anyone else (400). Test: `routes/metadata-reserved.integration.test.ts`.
  - **What changed:** `PATCH /contracts/:id` refuses (400) metadata keys starting with `_` from anyone but the internal agents service. Ordinary keys merge as before (C4).
  - **Verification:**
    - `routes/metadata-reserved.integration.test.ts` has 3 cases: a user's `_splitInto` refused, ordinary keys saved, and the agents service still writes `_redlineStatus`. The first fails pre-fix.
    - C4's `contract-metadata` test had written `_redlineStatus` as an ADMIN user, standing in for the redline failure path. It now uses the agents service headers, which is that path's real caller; its merge assertion is unchanged.
  - Original note: `PATCH /contracts/:id` lets a client write any metadata key, and re-split replaces the contracts listed in `_splitInto` (`binder-split.ts:36-53`). A CONTRACT_MANAGER who gets 403 deleting another user's amendment can list it there and re-split, and it is soft-deleted. This is same-org only, and only for single-version drafts under a contract the attacker can edit. Treat `_`-prefixed metadata as server-owned in `PATCH`. (Found in X20 review.)

  - **Follow-up (final-sweep review, DONE):** the PATCH check holds (nested, look-alike and escaped keys are harmless; re-split stays in the org and parent). The review found:
    - **The one writer allowed `_` keys copied keys the model chose (Low-Medium).**
      - `review.py` copied every key of the model's `customFields` into top-level metadata, as the agents service.
      - A document that tells the extractor to return `customFields: {"_splitInto": …}` could set it, and the next re-split would soft-delete the named contracts. It could also forge a `_compliance` or `_playbookReview` report.
      - Now `review.py` keeps only the org's own field keys, as `extract_fields.py` does.
      - PATCH also refuses any change to `_splitInto` from every caller, the agents service included, since only `lib/binder-split.ts` writes it. Writing the stored value back unchanged (`redline.py` merges and sends the whole metadata) still passes.
    - **`POST /contracts` accepted `_` keys (Low),** so a user could create a contract with a forged report showing on the rail. It now refuses them as PATCH does.
    - **Verification (`metadata-reserved.integration.test.ts`, 3 new cases):**
      - the agents service's changed `_splitInto` gets 400, and the stored value written back gets 200;
      - a create with `_compliance` gets 400;
      - a tripwire checks `review.py`'s field filter.
      - Against the pre-fix code all 3 fail.
      - The C4 metadata-merge and binder-split tests still pass.
    - **Residual:** `review.py` still PATCHes without `x-org-id`. That works because those routes look contracts up by id for the `system` org, and the ids come from the server.
- **X27 — Contract text still reaches models raw on paths outside X23 (Medium). — DONE** (VERIFY-PENDING → DONE after the live check below).
  - **Plan (each surface confirmed in the code):** apply the org's policy with X23's round-trip helpers wherever the model's output is shown back or stored, and the plain policy where it only goes to a model.
    - **Q&A:**
      - `/search/ask` and `/contracts/:id/ask`: the retrieved clauses go to Voyage's reranker and `/agent/ask` as tokens, and the answer comes back to the user with the values.
      - Scope: the org for the portfolio ask, whose matches span contracts; the contract for a single contract.
    - **Editor AI:**
      - `assist`, `complete`, `classify-clause` and `compare` send tokens (scoped to the org, since the editor sends no contract id) and restore the reply.
      - `assist-stream` rewrites the NDJSON stream. Deltas go through `streamRestorer` (new in `pii-policy.ts`), which holds back a tail that could still become a token split across chunks.
    - **Chat tools:** `contract_get` and `contract_summarize` return `keyTerms` under the plain policy, as their text already was.
    - **Text the agents service fetches itself:**
      - For the agents service only, the version diff that `/redline` reads is tokenized. Its analysis is stored through `PATCH /contracts/:id`, which X23 already restores.
      - The clauses `/approval-summary` reads are tokenized too, and `PATCH /approvals/:id/summary` now restores against the contract's text and clauses.
      - Users reading the same endpoints see the text as before.
  - **Not reproducible:** `playbook_judge` already sends `playbook_check`'s excerpt, which is redacted before the judge call.
  - **Verification:**
    - `routes/pii-surfaces.integration.test.ts` has 6 cases:
      - both ask routes: the agent gets no SSN and the answer has it;
      - assist, complete and classify send tokens and return values;
      - the stream restores a token split across two deltas;
      - `contract_get` key terms carry no SSN;
      - the diff and clauses read by the agents service are tokenized, while users still see the text;
      - an approval summary with a token is stored with the value.
    - Against the pre-fix code all 6 fail.
    - Suite: typecheck 0, lint 0 errors; api unit 272/272, integration 256/256.
  - **Why VERIFY-PENDING:** the redline analysis and approval summary need a live run to confirm the models keep the tokens and the stored text reads right.
  - **Left as is:**
    - `GET /contracts/:id` (summary, key terms) stays raw for the agents service. `redline.py` reads the contract's metadata there and PATCHes it back merged, so tokenizing it could write tokens over metadata values that aren't in the document. Moving that read-modify-write to a server-side merge is a separate change. *(Superseded: the follow-up below tokenizes key terms and summary, which no agent writes back, and leaves `metadata` raw.)*
    - The redline analysis quotes removed text from the older version. A value that exists only there stays a token in the stored analysis, a display-only artifact with a warning in the log, because `PATCH /contracts/:id` restores against the current version. *(Superseded: the follow-up restores against both compared versions.)*
  - **Follow-up (adversarial review of 0dea2dd) — DONE** (verified live, below). The review found paths that still sent values, or fragments of them, to a model, and outputs that could put a placeholder into a document. Each finding and what changed:
    1. **The agents' redline diff leaked a value changed between versions (Medium-High).**
       - Tokenizing the finished diff missed values htmldiff had split at `-` and `.` (`123-45-<del>6789</del><ins>6780</ins>`). The same happened to an SSN split by `<strong>` and to a card number written with non-breaking spaces.
       - Now each version is tokenized BEFORE diffing:
         - values are found in its plain text, its HTML, and its HTML's visible text (`htmlTextForms`: tags dropped, and tags as spaces);
         - the HTML's space entities and whitespace runs become one plain space (`plainSpacesHtml`), as the extractors do for `plainText`;
         - `withWholeTokens` (new in `pii-policy.ts`) keeps each token one word for htmldiff, which otherwise splits it at `:`;
         - when the markup itself still splits a value (`valueLeftInMarkup`), the plain texts are diffed instead.
       - The agents' diff is not cached, and a version still being extracted gets the same 409 users get.
       - `PATCH /contracts/:id` restores a redline analysis against the same forms of both compared versions (`_redlineAnalysis.v1Id`/`v2Id`). A value that exists only in the older version now comes back too.
    2. **The approval summary sent raw key terms (Medium).** `GET /contracts/:id` now tokenizes `keyTerms` and `summary` for the agents service (contract scope).
       - `metadata` stays raw: `redline.py` merges it back, and it goes to no model.
       - `PATCH /approvals/:id/summary` restores against the text the agents service was given:
         - the clauses of the version `/clauses` picks (a shared `clauseVersionId()`, in sort order);
         - that version's text;
         - the current version's text;
         - the key terms and summary.
    3. **The playbook tester the UI uses was missed (Medium).** `POST /playbook/test` now sends the clause as tokens and restores the comparison.
    4. **Nothing stopped a mangled placeholder from reaching the document (Medium).**
       - `PII_TOKEN_RULE` is added to every prompt these paths send tokens to:
         - `assist.py` ×4, `assist_agent.py` ×2, `ask_agent.py`;
         - `redline_agent.py` ×3 and `approval_agent.py` ×3.
       - After restoring:
         - `/assist` answers 502;
         - `/complete` returns no ghost text;
         - `/assist-stream` ends with an `error` event instead of `done`.
       - A stream that stops without `done` or `error` also ends with an error, since its held-back tail may be half a token.
       - The popover no longer offers Replace or Insert after an error.
    5. **Values were found per slice (Low-Medium).**
       - `complete` and `classify-clause` cut the text to size before redacting, which sent `3-45-6789…` and `SSN 123-45-6`. They now redact all the text they were given, then cut without splitting a token (`sliceOutsideTokens`).
       - Both ask routes find values against the whole version text, so a card whose "credit card" is elsewhere in the contract is caught. For the portfolio ask, that means every matched version.
    6. **The approval restore read different text from the clause read (Low).** Covered by 2.
    7. **Org-wide token scope (Low).** The editor and Q&A round trips happen within one request, so each now uses a random scope, and tokens can't be linked across requests.
    8. **Output truncation could cut a token (Low).** `dropPartialToken` drops a token cut off at the end of a classify or complete reply.
    9. **Test hygiene (Nit).** The test now deletes its `versionDiffCache` rows (no foreign key). The dead `orgOf()` branch in `/clauses` is removed.
    10. **Adjacent surfaces.** `obligations_list` (description, quote) and `approval_list` (AI summary) now go through the policy, like the other chat tools.
  - **A second adversarial review of this follow-up found, and this commit also fixes:**
    - **High: the diff could still send a card number that the HTML spaced differently from `plainText`** (double, thin or figure spaces, or a tab). The HTML's whitespace is now normalized as above, and so is the text `valueLeftInMarkup` reads.
      - At the detector (`pii-redactor.ts`), a card's digit groups may be separated by any single space character, not just U+0020. Word and the editor write no-break and thin spaces, so those card numbers went out whole on every plain-text surface. Groups on separate lines still don't join.
    - **`approval_list` cut the summary to 400 characters before redacting it,** so a value across the cut went out as a fragment. It now redacts the whole summary, then cuts.
      - The older chat tools do the same (filed as X36).
    - **The completion's cursor is a cut too.**
      - Values are now also found across it: a date of birth whose keyword is before the cursor is caught.
      - When a value spans the cursor (`123-45-|6789`), nothing is sent (`valueAcross`), since each half matches no pattern.
    - **`/assist` receives HTML.** A label and its value in separate tags (`<strong>Date of birth:</strong> 1980-05-12`, `<td>Passport No.</td><td>A1234567</td>`) went out raw.
      - Values are now found in the HTML's text forms, and the HTML is sent with its spaces normalized.
      - A value its formatting splits can't be tokenized, so the request is refused with a 422 that says why. The editor now shows the server's reason instead of a generic "try again".
    - **`/contracts/:id/ask` found values in the current version,** while its clauses can come from an older one after an editor save. It now uses the matched clauses' own versions, as `/search/ask` does.
    - **`/assist-stream`:**
      - An upstream connection reset ended the handler with a throw after the headers were sent. It now ends with the cut-off error.
      - The selection is cut to the agents service's 6,000 characters here, without splitting a token. So are `/compare` and `/playbook/test` at 2,000.
    - **Mangled placeholders the check missed:** `[PII:SSN]`, `[PII:SSN:1a2]` and `[REDACTED]` now count as unresolved.
    - **The approval summary restore:**
      - it logs unresolved placeholders, like `PATCH /contracts/:id`;
      - it includes the latest version's text, which is what `GET /contracts/:id` reads when there is no current version.
  - **Verification:**
    - `routes/pii-surfaces.integration.test.ts` has 9 new cases (15 in the file):
      - **The redline diff:**
        - the agents' diff of a changed SSN has no digits and a whole token on each side;
        - it stays that way with markup splitting the value, with a Word card number written with `&nbsp;` or U+00A0, and with double, thin or figure spaces or a tab;
        - a pending version gets 409.
      - **Playbook tester:** it sends tokens and restores.
      - **Windows and the cursor:**
        - neither the complete window nor the classify window carries any part of a value that straddles the cut;
        - with the cursor inside a value nothing is sent;
        - a date of birth whose keyword is before the cursor doesn't go out.
      - **The editor's HTML:** labelled values in other tags go out as tokens and come back, and a value split by formatting gets 422.
      - **Per-contract ask:** it finds a card number through its older clause version's text.
      - **Mangled or cut-off replies:**
        - a mangled placeholder gets 502 from `/assist`, and an `error` event rather than `done` from the stream;
        - a cut-off stream and a reset one both end in an error, without the half token.
      - **Approval summary:**
        - `GET /contracts/:id` for the agents tokenizes key terms and summary, and a summary quoting a value found only there is stored with the value;
        - so is one tokenized against the latest version when there is no current one.
      - **Chat lists:** `obligations_list` and `approval_list` carry no SSN, even across the 400-character cut.
    - **Unit tests:**
      - `lib/pii-token-boundaries.test.ts` has 16 cases for the new helpers and the widened placeholder check;
      - `lib/pii-redactor.test.ts` has 2 for card spacing;
      - `lib/pii-pseudonym.test.ts` has a tripwire for each new `PII_TOKEN_RULE`.
    - **Pre-fix check:** against the pre-fix code, all 9 new integration cases, the card-spacing case and the tripwire fail. Without the non-breaking-space step, the card diff case fails too.
    - `redline-internal.integration.test.ts` (C8) still passes unchanged: the agents get an HTML diff, as before.
    - **Suite:** typecheck 0, lint 0 errors (warnings unchanged), api unit 293/293, web 18/18, integration 267/267 (43 files).
  - **Why VERIFY-PENDING:** as before, a live redline analysis and approval summary, to confirm the models keep the tokens.
  - **Live check (2026-09-23, signed in to the local stack; agents service on :8003 running this branch, Gemini):** the X23 contract, v1 against its chat-redlined v2.
    - **Redline analysis:** the diff the agents service reads (fetched with its own headers) had 3 tokens and no raw value. The stored analysis found the one change (§4) with the real SSN restored in both texts, and no tokens.
    - **Approval submission** (default 3-step workflow; the contract is now pending approval): the approval route's `/versions` and `/clauses` reads were tokenized (4 and 2 tokens, no raw values). The stored executive summary reads the contract and has no tokens (X33).
    - `GET /contracts/:id` returns raw versions and metadata to the agents service, as the entry above says. The approval route uses only its key terms, risk factors and header fields, which carry no value.
  - **Left as is:**
    - `spanStart`/`spanEnd` in ask answers are offsets into the tokenized clause text, off by about 15 characters per value before them. Only API callers read them; the web app doesn't.
    - `dropPartialToken` also drops an ordinary trailing `[` or `[P` from a completion or classifier reason. That is harmless and simpler than telling it from a cut token.
    - `/search/ask` finds values once to redact and again to restore (about 160 ms for 60 versions of about 100 KB each). The answer takes seconds anyway.
    - The question text goes to embeddings, Voyage and `/agent/ask` as typed, as in chat.
    - For the agents service, `riskFactors` and the `versions` array of `GET /contracts/:id` stay raw. `riskFactors` are metadata the chat tools also leave raw (P21). No agent sends the version texts to a model.
    - Filed from this work:
      - X32: htmldiff blocks the event loop on large version pairs, and the agents' diff is now computed on every read;
      - X33: the approval summary never gets the contract text;
      - X34: audit rows are lost under concurrent writes;
      - X35: two more internal checks are open outside production or when the secret is unset;
      - X36: the older chat tools cut text before redacting it;
      - X37: IBANs written in groups aren't recognized.
- **X28 — The signer portal lets a later sequential signer act before their turn (Low). — DONE.** Found in the X21 review.
  - **Plan:** confirmed in `routes/signatures.ts`. `POST /sign/:token/sign` checks that every earlier group of a SEQUENTIAL request has signed, but `GET /sign/:token` returns the full contract HTML and `POST /sign/:token/decline` voids the whole request, with no such check. A later signer's link, forwarded or copied, can read the contract or void the request before the first signer acts. Fix: one `waitingForEarlier()` check, used by all three routes.
  - **What changed:**
    - `waitingForEarlier()` and one message.
    - View and decline answer 403 "Earlier signers have not yet signed. You will be notified when it is your turn." before the signer's turn. The view does so before recording a VIEWED event.
    - Signing uses the same check.
    - The signer portal already shows a GET's `detail` as the page message, so the waiting signer sees that sentence.
  - **Verification:**
    - `routes/signing-turn.integration.test.ts`: the second signer gets 403 on view (no contract text) and on decline (the request stays PENDING). The first signer views normally. Once the first has signed, the second sees the contract.
    - Against the pre-fix code it fails. The 5 signature-related integration files pass (45 tests). Typecheck 0, lint 0 errors.
  - (This entry was lost from the tracker when X27's entry was written, and is restored here.)
  - Original note:
    - `GET /sign/:token` shows the full contract, and `POST /sign/:token/decline` voids the whole request, for a signer whose sequential group hasn't been asked yet. Only signing itself returns 403.
    - A later signer's link can reach them early (forwarded, or copied from a list), so they can read the contract or void the request before the first signer acts.
    - Gate view and decline the way sign is gated.
  - **Follow-up (final-sweep review, DONE):** the turn gate holds. The review found:
    - **Signing and declining ignored the request's expiry.** Only viewing the link marked a request EXPIRED, so a stale or leaked link could still sign (and, as last signer, complete the request and execute the contract) or void it. The X18 deploy note assumes tokens stop at expiry. Now one `expired()` check marks it and answers 410 for view, sign and decline alike.
    - **Racing state changes:** the status was checked on a snapshot and written unconditionally. So a sender's void racing the last signature ended COMPLETED/EXECUTED after `signature.voided` had fired, and two final signers at once wrote the COMPLETED event, audit row, webhooks and obligation extraction twice.
      - A signature now lands only on a signer and request still PENDING.
      - Completion, a decline and a sender's void each flip the request only from PENDING, in a transaction. Exactly one wins, and only the winner executes the contract and fires events. The others get 409.
    - **Verification (`signing-turn.integration.test.ts`, 2 new cases):**
      - an expired link's sign and decline get 410 and leave the request EXPIRED with the signer pending;
      - two final signatures sent at once both succeed, with one COMPLETED event.
      - Against the pre-fix code both fail on every run: 200 for the expired link, 2 COMPLETED events.
      - The signature-related integration files pass (26 tests).
    - Not reproduced deterministically: a void landing between a sign request's checks and its write. It goes through the same conditional updates as the tested race.
- **X29 — The collaboration server checks permissions once per socket (Low, latent). — DONE.** Found in the X21 review.
  - **Plan:** confirmed. `authenticateCollab` ran only in Hocuspocus' `onAuthenticate`, so an open socket kept its rights after its token expired, the user was deactivated, or the contract was deleted or reassigned. A throw from `beforeHandleMessage` closes the connection (Hocuspocus v4), so check there.
  - **What changed (`lib/collab-server.ts`):**
    - `authenticateCollab` returns a context with the user, roles, contract, the token's `exp`, whether the connection is read-only, and when it was checked. Admission now also requires the user to be a live, non-deactivated member.
    - `checkCollabMessage`, called from `beforeHandleMessage`:
      - it refuses every message once the token has expired;
      - at most once a minute, it re-checks the same rights as admission (user live, contract live in the org, own-scope ownership, edit for a writable connection);
      - a change closes the connection with 4403, and the client's reconnect is judged afresh.
  - **Verification:**
    - A new case in `routes/own-scope-followups.integration.test.ts`:
      - an admitted own-scope editor's connection is refused after its token's expiry;
      - once the contract is reassigned it is still fine within the minute, then refused;
      - it is refused while the user is deactivated, and allowed again once they're reactivated.
    - Against the pre-fix code it fails. The file has 12/12. Typecheck 0, lint 0 errors.
  - **Left as is (for when the editor binds to the shared document):**
    - Read-only connections can still send awareness (presence) and stateless messages, both unused today.
    - `collab_states` rows written before X21 (when any org member could write) should be cleared before binding.
  - **Follow-up (final-sweep review, DONE):** the per-message checks hold: read-only connections can't write, and login, presence, stateless and queued messages all pass through them. The review found the gap between messages.
    - Hocuspocus sends every document update to every open connection with no hook, and its idle timeout resets on a message sent for any document.
    - So a connection that stayed silent on a contract, while sending an occasional message for another document, kept receiving edits after its token expired or its access was revoked.
    - The stock web client renews presence every 15 s, so it was covered.
    - Production runs with `COLLAB_DISABLED=1`, so this was latent.
    - **What changed:** `watchCollabConnection()` re-runs the same check every 15 s for each connection (from the `connected` hook until `onDisconnect`), and closes the connection with 4403 once it fails.
    - **Verification:** `lib/collab-watch.test.ts` (fake timers) checks that a silent connection closes once its token expires, is closed only once, and that a stopped watcher never fires. `own-scope-followups.integration.test.ts` still passes.
    - **Left as is (review notes):**
      - Roles come from the token, as in REST, so a demotion applies at token expiry.
      - The 4403 close detaches the document without closing the socket. Server state is cleared, so a rejoin needs a new login.
      - The web client's fixed token means rejoining after 15 minutes needs a reload.
      - Presence entries and broadcast stateless messages aren't write-checked.
      - Hocuspocus queues unauthenticated messages without a limit.
- **X30 — `req.ip` is probably the proxy's address on Cloud Run (Low). — VERIFY-PENDING.** Found in the X3 review.
  - **Plan:** Fastify ran without `trustProxy`, so behind Cloud Run's front end `req.ip` was the front end's address. The per-IP rate limit then put every client in one bucket, and the audit log recorded Google's IPs. Trusting the whole `X-Forwarded-For` would let a client choose its own address, so trust only the nearest hop(s).
  - **What changed:**
    - `lib/trust-proxy.ts` `trustProxyHops()` returns 1 hop on Cloud Run (`K_SERVICE`) and no trust elsewhere. `TRUST_PROXY_HOPS` overrides it, e.g. 2 behind an external load balancer.
    - `app.ts` passes it as Fastify's `trustProxy`. Only the request logger reads the forwarded hostname; nothing builds URLs from `req.protocol` or `req.hostname`.
    - `.env.example` documents it.
  - **Verification:** `lib/trust-proxy.test.ts` has 2 cases:
    - the env rules;
    - on a Fastify instance with the resulting setting, a client that sends `X-Forwarded-For: 6.6.6.6` behind a proxy appending its real `203.0.113.9` is seen as `203.0.113.9`, where the old setting saw the proxy's own address.
  - **Why VERIFY-PENDING:** the hop count must be confirmed on a deployed revision (request an endpoint and compare the audit IP with the client's), since an external load balancer adds a hop.
- **X31 — `PATCH /approvals/:instanceId/summary` is open outside production (Low-Medium). — DONE.** Found while doing X27.
  - **Plan:** confirmed in `routes/approvals.ts`.
    - The route has no auth preHandler, and its secret check returned 401 only when `NODE_ENV === 'production'`. Everywhere else every caller got through, with no org check on the instance.
    - Its one caller, `approval.py`, sends the internal secret, `x-internal-service: agents` and `x-org-id`.
    - Fix:
      - require the secret in every environment, as the internal-ai guard does, with an unset secret refusing everything;
      - look the instance up in the org the caller names.
  - **What changed:**
    - The check now applies in every environment.
    - The instance lookup is scoped to `x-org-id` when that header is sent, so another org's instance is a 404.
    - A secret-holder that names no org still works.
  - **Verification:** a new case in `routes/approvals.integration.test.ts`, run under `NODE_ENV=test`:
    - Each of these gets 401:
      - no header;
      - a wrong secret;
      - a user's bearer token;
      - an empty header with no secret configured.
    - The secret with another org's `x-org-id` gets 404, and the summary is unchanged.
    - `approval.py`'s headers get 200, and the summary is stored.
    - Against the pre-fix code it fails: the unauthenticated PATCH got 200.
    - Suite:
      - typecheck 0;
      - lint 0 errors;
      - api unit 293/293;
      - integration 268/268 (43 files).
  - **Adversarial review:** it found no way around the check and no caller that breaks. It found one gap in the test:
    - With the secret unset, the test sent an empty header, which fails even without the unset-secret guard (`'' !== undefined`).
    - It now also sends no header, which is the `undefined === undefined` hole. Against a check without the guard, that case gets 200 and the test fails.
    - The review also found three existing issues, now filed:
      - no placeholder check for the internal secret, and one that misses the self-host placeholders (X38);
      - inbound email and the SSRF guard keyed on `NODE_ENV` (added to X35).
    - Comparisons with `!==` aren't constant-time here, nor in `auth.ts` or the internal-ai guard; `metrics.ts` uses `timingSafeEqual`. Left as is, as a known nit.
- **X32 — htmldiff blocks the event loop on large version pairs (Medium). — DONE.** Found in the X27 review.
  - `GET /contracts/:id/versions/:v1/diff/:v2` runs `node-htmldiff` synchronously on the request thread. On a large pair the review measured the event loop blocked for more than 5 minutes, so one request stalls every other request on that instance.
  - Users' diffs are cached after the first run. Since the X27 follow-up, the agents service's tokenized diff is computed on every read.
  - Measured on synthetic contract text: 45 KB takes 0.2 s, 178 KB 1.7 s, 354 KB 5.6 s. The review saw 17 s at 60k words of low-vocabulary text.
  - Bound the work (refuse or degrade above a size, or diff paragraph by paragraph), or move it off the request thread.
  - **Plan:** confirmed. `node-htmldiff` is synchronous, and it runs on the request thread in three places:
    - the diff route: users on a cache miss, the agents service on every read;
    - the DOCX redline export (`lib/diff.ts` `computeVersionDiff`).
    - A size cap alone would stop large contracts from being compared at all. Instead, run the diff on a worker thread, which keeps the event loop free, with:
      - a time limit (30 s) past which the worker is stopped and the caller told why;
      - at most two diffs at a time per process, so a burst can't take every core.
    - The production start command (`node --import tsx src/index.ts`) and vitest both run an eval'd CommonJS worker that requires `node-htmldiff` by resolved path. Startup is about 25 ms.
  - **What changed:**
    - `lib/diff.ts`:
      - `htmlDiff(a, b)` runs htmldiff on a worker thread;
      - it rejects with `DiffTooLargeError` past the limit, terminating the worker, and reports a worker failure as an error;
      - a small slot queue hands a finishing diff's slot straight to the next waiter;
      - `computeVersionDiff` is now async on top of it.
    - Both paths of the diff route use it, and so does the DOCX export. Past the limit, both answer 422 with the reason, and nothing is cached. `withWholeTokens` (X27) now accepts an async function.
    - The agents service's redline analysis already records a non-200 diff as a failed analysis with the reason. Its HTTP timeout is 60 s, so the 30 s limit fits.
    - Web:
      - the compare view shows the reason instead of "No diff available";
      - the negotiate tab shows any diff error instead of "Select two versions";
      - neither retries a 422.
  - **Verification:**
    - `lib/diff.test.ts` has 4 cases:
      - the same output and counts as htmldiff;
      - during a diff of about 110 KB (about 0.8 s), a 5 ms timer keeps firing (before: 0 ticks);
      - a 100 ms limit rejects with `DiffTooLargeError` within a second;
      - a failure inside the diff rejects rather than hangs.
    - `routes/version-diff-limit.integration.test.ts` forces the limit. The user diff, the agents' diff and the DOCX export each get 422 with the reason, and no cache row is written.
    - Against the pre-fix code both files fail: 0 ticks, no `htmlDiff`, and a 200 where 422 is expected.
    - Suite: typecheck 0, lint 0 errors, api unit 297/297, integration 269/269 (44 files).
    - The two web messages are typechecked but not seen in a browser; they need a pair past the limit.
  - **Left as is:** the agents' tokenized diff is still computed on every read, now off the request thread. It is read once per redline analysis.
  - **Test follow-up (final sweep):** the event-loop case in `diff.test.ts` timed out once at vitest's 5 s default under the parallel unit suite. Alone it passes 3/3. It now has the diff's own 30 s limit; its assertion, that the loop kept turning, is unchanged.
- **X33 — The approval summary never gets the contract text (Low-Medium). — DONE** (VERIFY-PENDING → DONE after the live check below). Found in the X27 follow-up.
  - `approval.py` reads `plainText` from `GET /contracts/:id/versions`, which has never returned it (it lists metadata only). The executive-summary prompt's `text_excerpt` is therefore always empty, and the summary is written from key terms and clauses alone.
  - Any fix has to hand the text over tokenized with the contract scope, as `/clauses` does, so `PATCH /approvals/:id/summary` can restore it.
  - **Plan:** confirmed.
    - `approval.py` picks the approval's version (the latest, as `queueApprovalSummary` names it) from `GET /contracts/:id/versions` and reads its `plainText`.
    - The route selects metadata only, so `approval_agent`'s `text_excerpt` (`[:8000]`) was always empty.
    - The Python side already expects the text, so the fix belongs in the API: give the agents service the text there, tokenized like `/clauses`.
  - **What changed:**
    - For the agents service only, `GET /contracts/:id/versions` now carries each version's `plainText`:
      - tokenized in one pass with the contract scope, so values found in any version take the same token;
      - cut to 20,000 characters without splitting a token, which bounds the payload.
    - Users' list is unchanged.
    - `PATCH /approvals/:id/summary` already restores against the latest and current versions' text (X27 follow-up).
  - **Verification:**
    - A new case in `routes/pii-surfaces.integration.test.ts`:
      - the agents' list has the version text with a token and no SSN;
      - users' list has no `plainText`;
      - a summary quoting the excerpt's token is stored with the value.
    - Against the pre-fix code it fails (no `plainText`).
    - Suite: typecheck 0, lint 0 errors, api unit 297/297, integration 270/270.
  - **Why VERIFY-PENDING:** a live approval submission is needed to see the executive summary now reading the contract, and its stored text reading right.
  - **Live check (2026-09-23, signed in to the local stack; agents service on :8003 running this branch, Gemini):** submitting the X23 contract for approval produced an executive summary that reads the contract: the parties, $12,500 a month for twelve months, 30-day payment, IP ownership and 30 days' termination notice. It came with a "review_required" recommendation and a high-severity risk (no indemnification clause). It has no tokens.
- **X34 — Audit events are lost under bursts of concurrent writes for one org (Low-Medium). — DONE.** Found in the X27 follow-up.
  - The integration suite logs `[pii-policy] failed to write audit event: … P2034`. `createAuditEvent` appends to the org's hash chain in a SERIALIZABLE transaction, with 5 attempts on a fixed 10–160 ms backoff and no jitter.
  - With six or more writers at once, as parallel chat tool calls produce, retries collide again and some writers run out of attempts. Fire-and-forget callers (PII redaction, tool calls) then drop the event with a console line. The chain stays valid but incomplete.
  - Serialize appends per org, or retry with jitter until a deadline.
  - **Plan:** reproduced. 16 appends at once for one org lost 4 to 8 events on every run.
    - A per-org lock was considered and rejected. The chain is verified in `createdAt` order, and `createdAt` is the transaction's start time. A writer that waited on a lock would take an earlier `createdAt` than the row it links to, and the chain would read as broken.
    - SERIALIZABLE plus retry keeps that order, because a retried transaction starts afresh after the row that beat it. So keep it, and fix the retry: random sleeps (full jitter) so that colliding writers spread out, until a time budget is spent rather than for a fixed 5 attempts.
  - **What changed (`lib/audit.ts`):**
    - A retry now sleeps a random part of 10, 20, 40… ms, capped at 250 ms.
    - It keeps retrying serialization failures for up to 5 s, then throws as before.
    - The `within` callback (X5) was already required to be idempotent, since it re-runs on each retry.
  - **Verification:**
    - `lib/audit-burst.integration.test.ts`: 16 concurrent appends all land, and `verifyAuditChain` passes. It fails on the pre-fix code, 3 runs of 3, and passes 5 runs of 5 after the fix (about 0.4 s). A throwaway run with 64 writers landed them all in about 1.1 s.
    - The full integration suite no longer logs a single lost audit write (`[pii-policy] failed to write audit event`), where it used to log several.
    - Suite:
      - typecheck 0;
      - lint 0 errors;
      - api unit 297/297;
      - integration 271/271 (45 files).
  - **Left as is:** under a burst, a request that awaits its audit write can now wait up to about 5 s instead of failing after 0.3 s.
- **X35 — Two more internal-only checks are open outside production, or when the secret is unset (Low-Medium; Critical once reviewed). — DONE.** Found while planning X31.
  - Bull Board (`/admin/queues`, `app.ts`) is open whenever `NODE_ENV !== 'production'`. It shows job payloads and can retry or remove jobs.
  - `POST /contracts/:id/versions/:versionId/chunk` compares `secret !== INTERNAL_SERVICE_SECRET`. With the variable unset and no header, that is `undefined !== undefined`, so the request passes, for any org's contract.
  - Require the secret in every environment, and treat an unset secret as "refuse".
  - Found in the X31 review, the same class:
    - `routes/inbound-email.ts` skips its signature check when `INBOUND_EMAIL_SECRET` is unset and `NODE_ENV` isn't production. `.env.example` ships that secret empty. The sender check trusts the payload's `from`, so anyone who knows a contract id and the counterparty's address can add a version to that contract.
    - `lib/ssrf-guard.ts` is off outside production, so on staging an org admin can point a webhook at the cloud metadata address. Key the exemption on an explicit development flag, not on `NODE_ENV`.
  - **Plan:** all four confirmed and reproduced (see the verification below). Each check either skipped itself when `NODE_ENV` wasn't `production`, or compared against a secret that could be unset. A shared stack that isn't production is open in either case. Fix:
    - Every internal secret check requires a configured secret and treats an unset one as "refuse".
    - The two developer conveniences become explicit opt-ins:
      - `BULL_BOARD_OPEN=true`, ignored in production;
      - the existing `WEBHOOK_ALLOW_PRIVATE_URLS=true`.
  - **What changed:**
    - `app.ts`: Bull Board needs `x-internal-secret` everywhere unless `BULL_BOARD_OPEN=true` outside production.
    - `routes/contracts.ts`: the chunk-and-index callback refuses while `INTERNAL_SERVICE_SECRET` is unset.
    - `routes/inbound-email.ts`: with `INBOUND_EMAIL_SECRET` unset, the webhook answers 503 in every environment.
    - `lib/ssrf-guard.ts`: on unless `WEBHOOK_ALLOW_PRIVATE_URLS=true`.
    - `.env.example` documents both flags and says the inbound secret is required everywhere.
  - **Verification:**
    - `routes/internal-checks.integration.test.ts` has 3 cases, run under `NODE_ENV=test`:
      - Bull Board: no header or a wrong secret gets 401 and the secret gets 200. With `BULL_BOARD_OPEN=true` it gets 200, but 401 under production.
      - The chunk callback gets 401 with the secret unset and queues nothing; with the secret, 202.
      - Inbound mail gets 503 with its secret unset.
    - `lib/ssrf-guard.test.ts`: the guard is on under development, test, staging and production, and off only with the flag.
    - Against the pre-fix code every case fails: 200, 202, 400 (auth skipped), and the guard off in development.
    - `inbound-email-attachments.integration.test.ts` still passes (it sets the secret).
    - Suite: typecheck 0, lint 0 errors, api unit 298/298, integration 274/274 (46 files).
  - **For developers:**
    - to open Bull Board in a browser on your own machine, set `BULL_BOARD_OPEN=true`;
    - to test webhooks against a local receiver, set `WEBHOOK_ALLOW_PRIVATE_URLS=true`;
    - to post mail to the inbound webhook locally, set `INBOUND_EMAIL_SECRET` and send it as `x-inbound-secret`.
  - **Adversarial review:** it found the fix incomplete, and a critical hole that was already there.
    - **Critical, now fixed:** both prefix hooks tested `req.url`, the raw request line. The router decodes percent-encoding and drops an absolute-form `http://host`, so these reached their handlers without a secret, in every environment including production:
      - `GET /%61dmin/queues/api/queues` (and the job API: read payloads, add, retry, clean);
      - `POST /api/v1/%69nbound/email`.
    - The Bull Board check now lives in a plugin that registers Bull Board itself, so it covers exactly those routes whatever the URL. The inbound hook drops its URL test, since it was already scoped to its plugin.
    - The test now sends the encoded paths too. Against the prefix-check version it gets 200 and 400 where it expects 401 and 503.
    - Also fixed from the review:
      - `scripts/p76-3-verify.mjs` now sends `x-inbound-secret`;
      - the webhook worker's comments are current;
      - the event-loop assertion in X32's `diff.test.ts` flaked under heavy load and now asks only that the loop kept turning (≥5 ticks; 0 on the request thread).
    - Filed: X39, webhook deliveries follow redirects past the SSRF guard. The internal-secret placeholder is already X38.
  - **Reviewed and left as is:**
    - `INBOUND_EMAIL_ALLOW_ALL` stays an explicit opt-in that production ignores, and the route now needs its secret anyway.
    - The API image sets `NODE_ENV=production` (Dockerfile, self-host compose), so these NODE_ENV-keyed dev conveniences only affect stacks run outside it:
      - the logger's token masking, off in development;
      - the signing link printed in development;
      - the self-signed signing certificate outside production;
      - auth rate limits, off under test;
      - the 10× global rate limit outside production.
- **X36 — The older chat tools cut contract text before redacting it (Low-Medium). — DONE.** Found in the X27 follow-up review.
  - Several chat tools slice text to a window and then redact each window on its own:
    - `contract_get`, `contract_cite`, `counterparty_memory` (twice) and `portfolio_search`;
    - `contract_summarize`, `playbook_check` and `org_memory`;
    - `clause_search`, whose before, match and after windows are each redacted separately.
  - A value that crosses a cut matches no pattern, so a fragment (`123-45-6`, `4111 1111 1111`) goes to the chat model. A card number whose "card" falls outside the window goes out whole.
  - Redact the whole text (or find values against it), then cut without splitting a placeholder, as X27 does for the editor routes.
  - **Plan:** confirmed, and wider than filed. Every excerpt the chat tools build is cut before it is redacted. These cut first N characters:
    - `contract_get` (maxChars);
    - `contract_summarize` (1,500);
    - `contract_cite` (397 + "...");
    - `counterparty_memory` (400; summary 280);
    - `portfolio_search` (500);
    - `playbook_check` (800);
    - `org_memory` (500).
  - These cut windows around a match:
    - `clause_search` (before, match and after, each redacted on its own);
    - `contract_validate` (three kinds of issue excerpts);
    - `portfolio_compare` (one cell per topic and contract).
  - A value across a cut went out as a fragment, and a card number whose keyword was outside the excerpt went out whole. `redactPii` judges the keyword against its whole input.
  - Fix at one place: `cutAndRedact` in `pii-policy.ts`.
    - It finds the values in the whole text and locates their occurrences.
    - A cut point strictly inside one moves to its start, so a piece ends before the value or starts with all of it.
    - Each piece is redacted by exact value with the policy's placeholder.
  - **What changed:**
    - `lib/pii-policy.ts`:
      - `cutAndRedact` (pure);
      - `redactCuts`, which does the policy read and writes one audit row, like `applyPiiPolicyBatch`, and returns mode and counts.
    - `routes/internal-ai.ts`:
      - `redactCutExcerpts`: fail-closed like `redactExcerpts` (retried as force-redact, then withheld);
      - the ten tools above keep each excerpt's source text and offsets, and redact through it. The three that answered 503 on a redaction failure still do.
      - Response shapes are unchanged. A piece can be a few characters shorter than before where a cut moved back to a value's start.
    - `lib/pii-outbound.integration.test.ts`: the X23 fail-closed test's failure injection now also covers `redactCuts`, the redaction `contract_summarize` now uses. The assertion is unchanged: a 503 with no SSN in the body.
  - **Verification:**
    - `lib/pii-cuts.test.ts` has 4 cases for `cutAndRedact`:
      - a cut inside a value moves to its start;
      - adjacent windows split around a value stay adjacent;
      - a card is found by a keyword outside the piece;
      - counts, and text without values.
    - `routes/chat-tool-cuts.integration.test.ts` has 5 cases:
      - `contract_get`, with a maxChars cut inside an SSN and a card whose "credit card" comes after the cut;
      - `contract_summarize`'s 1,500 cut;
      - the window edges of `clause_search` and `portfolio_compare`;
      - a `contract_validate` window starting inside an SSN;
      - `counterparty_memory`'s 400 cut.
      - The fixtures have no other digits, so each excerpt must have none. Against the pre-fix code all 5 fail.
    - Suite: typecheck 0, lint 0 errors, api unit 305/305, integration 279/279 (47 files).
  - **Adversarial review:** no cut split a detected value. It found these, all fixed in this commit:
    - **Too slow with many values.** The first version scanned the whole text once per value: 5,000 SSNs in 2 MB took 6.4 s, on the request thread. Now one lookahead scan finds every occurrence, and a binary search snaps the cuts. A new unit case runs 5,000 SSNs in about 1 MB, with 50 cuts, in well under its 2 s bound (the file takes about 70 ms).
    - **Overlapping values left a tail** (`[REDACTED:CC]9999`). Overlapping occurrences now merge into one run, replaced whole (unit case).
    - **A card followed by another digit group was never recognized** (`4111 1111 1111 1111\t12/27`, a table row). It fails Luhn as a whole, and X27's any-space separator made tab-separated rows fail too. Now the detector tries the longest leading run of whole groups that passes (`pii-redactor.ts` `luhnHead`), with 2 unit cases.
    - **Shape nits:**
      - an empty `counterparty_memory` summary stays `null`;
      - a withheld `contract_cite` quote gets no "...".
    - **Filed as X40:** five tools cut clauses or paragraphs, and look for values only within that clause or paragraph, not the whole document:
      - `contract_cite`, `counterparty_memory`, `portfolio_search`, `playbook_check` and `org_memory`;
      - the same goes for `keyTerms` in `contract_get` and `contract_summarize`.
  - **Left as is:**
    - A `clause_search` match that falls inside a value comes back as an empty `match`, with the value redacted in `afterContext`.
    - Redact mode now keeps a "DOB:" or "Passport No." label and replaces only the value, as tokens already did.
- **X37 — IBANs written in groups are not recognized (Low-Medium). — DONE.** Found in the X27 follow-up.
  - The IBAN pattern (`\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b`) only matches the unspaced form. Contracts usually print an IBAN in groups of four (`GB29 NWBK 6016 1331 9268 19`), which goes to every model surface as written.
  - Allow single spaces between the groups, keeping the banking-word anchor.
  - **Plan:** confirmed. `GB29 NWBK 6016 1331 9268 19` next to "IBAN" came back unredacted.
    - Let each group of four be preceded by an optional single space, so the unspaced form still matches, and keep the banking-word anchor.
    - Allowing spaces also admits all-caps text that looks like an IBAN once a document mentions a bank ("US10 YEAR NOTE"). So also check the IBAN's own mod-97 checksum, as cards are checked with Luhn.
    - A word right after the last full group ("… 7034 BANK") fails the check as part of the match. So the X36 fallback that drops trailing groups now serves IBANs too.
  - **What changed (`lib/pii-redactor.ts`):**
    - The IBAN pattern: `[A-Z]{2}\d{2}`, then 2–7 groups of four, each optionally after a space, then an optional last group of 1–3.
    - The `ibanValid` checksum.
    - X36's `luhnHead` generalized to `validHead` (card: Luhn; IBAN: mod 97).
  - **Verification (`lib/pii-redactor.test.ts`, 2 cases):**
    - The UK, German and Norwegian examples in groups, the last the shortest at 15 characters, are redacted.
    - A Belgian IBAN followed by "BANK" is redacted without the word.
    - "US10 YEAR NOTE" next to "bank" is left alone.
    - The grouped cases fail against the pre-fix pattern.
    - The existing unspaced IBAN, German IBAN and invoice-code cases still pass. Every IBAN in the test fixtures is a checksum-valid example.
    - Suite:
      - typecheck 0;
      - lint 0 errors;
      - api unit 307/307;
      - integration 279/279.
  - **Left as is:** an IBAN-shaped string that fails its checksum (a typo, a made-up number) is no longer redacted, like a card that fails Luhn.
- **X38 — Placeholder secrets pass the production boot check (High). — DONE.** Found in the X31 review.
  - `lib/secrets.ts` `assertSecretsConfigured` checks only `JWT_SECRET` and `PORTAL_JWT_SECRET`. `looksInsecure` recognizes only a `change-me` prefix, while `.env.selfhost.example` ships `CHANGE_ME_…` values of 37–44 characters, which pass.
  - `INTERNAL_SERVICE_SECRET` is never checked, so a production API starts with the example value from either env file. Anyone who has read the repo then passes the internal routes' check and `requireAuth`'s internal bypass, which is ADMIN in any org they name. With the self-host JWT placeholders, they can forge tokens too.
  - Fix: check `INTERNAL_SERVICE_SECRET` at boot like the JWT secrets, and treat any value that starts with `change-me` or `change_me` (in any case) or equals an example-file value as a placeholder.
  - **Plan:** confirmed.
    - `looksInsecure` matched only a `change-me` prefix, so the self-host example's `CHANGE_ME_…` JWT secrets (37–44 characters) booted in production.
    - Nothing checked `INTERNAL_SERVICE_SECRET` at all. It is the key to `requireAuth`'s internal bypass (ADMIN in any named org) and to `/internal/ai/resolve` (the model keys).
    - Fix at boot:
      - recognize every public value;
      - check the internal secret like the JWT ones;
      - warn only when it is unset, because every internal check then refuses.
  - **What changed:**
    - `lib/secrets.ts`:
      - placeholders are recognized in any spelling (`change-me`, `CHANGE_ME_`, `replace me`), quoted or padded;
      - every secret value public in the repo is refused: the CI and integration-test values, and the dev value the skill docs name.
      - `assertSecretsConfigured` now checks `INTERNAL_SERVICE_SECRET`. Production refuses to boot on a placeholder or on fewer than 32 characters (on Cloud Run the previous revision keeps serving). Unset only warns. The secret is never generated, since the agents service must hold the same value.
    - `apps/agents/main.py`: on Cloud Run (`K_SERVICE`), where the service is public, it refuses to start with a missing, short or public secret. Local runs are unchanged.
    - `deploy/selfhost/nginx.conf`: the edge drops `X-Internal-Secret`, `X-Internal-Service` and `X-Org-Id`. The agents service calls the API directly on the compose network, and the web app never sends them. Checked with `nginx -t`.
    - `.env.selfhost.example` and `SELF-HOSTING.md`:
      - the internal secret's rules;
      - an upgrade note: installs on placeholders won't start, rotate the internal secret on all three services together, and a new JWT secret signs everyone out.
  - **Verification:** `lib/secrets.test.ts` has 8 new cases:
    - the self-host placeholders are refused;
    - the internal placeholder is refused, and a strong value accepted;
    - an unset internal secret only warns;
    - a short one is refused in production;
    - every public value is refused however it is written;
    - a test reads `.env.example` and `.env.selfhost.example` and asserts all three secrets in each are refused, so renaming a placeholder can't quietly reopen this;
    - outside production a placeholder only warns;
    - a tripwire checks the agents-side check.
    - The Python check was exercised directly, since there is no Python env here: it allows a local run, refuses a placeholder, a CI value or a short secret on Cloud Run, and accepts a strong one. `py_compile` passes.
    - The placeholder cases fail against the pre-fix code.
    - Suite: typecheck 0, lint 0 errors, api unit 315/315, integration 279/279.
  - **Adversarial review:**
    - It confirmed the placeholder fix, and every internal check refuses when the secret is unset.
    - It found that public non-`change-me` values (CI, tests, docs), short secrets, the public Cloud Run agents service and the self-host edge were still open. All are fixed above.
    - Filed from it: X41 (the seeded demo admin's public password).
  - **Left as is:**
    - The worker runs no boot check. It trusts no inbound calls, and its only use of the secret is as the fallback PII token key.
    - The `CHANGE_ME_` database and MinIO passwords, and `storage.ts`'s `minioadmin` fallback, protect internal-only services.
  - **Deploy check:** before deploying, confirm production's `INTERNAL_SERVICE_SECRET` (Secret Manager) is random, 32+ characters and not the dev value. Otherwise the new API and agents revisions will refuse to start.
- **X39 — Webhook deliveries follow redirects past the SSRF guard (Medium). — DONE.** Found in the X35 review.
  - `workers/webhook.worker.ts` checks the webhook URL with `assertPublicUrl`, then calls `fetch` with the default `redirect: 'follow'`.
  - A public URL that answers 302 or 307 with `Location: http://169.254.169.254/…`, or an internal host, sends the delivery there. 307 and 308 keep the POST and its body. The stored status code then tells the org admin what the internal endpoint answered.
  - Fix: `redirect: 'manual'`, treating a redirect as a failed delivery. Or re-check each hop.
  - **Plan:** confirmed. `handleWebhookDelivery` runs `assertPublicUrl` on the webhook's own URL, then calls `fetch` with no `redirect` option, so redirects are followed.
    - Don't follow redirects; report one as a failed delivery that says so. Re-checking each hop was rejected: a webhook's URL should be its endpoint, and following adds DNS-rebinding windows for nothing.
    - Slack and Teams webhooks answer directly (200/202).
  - **What changed (`workers/webhook.worker.ts`):**
    - `fetch` gets `redirect: 'manual'`.
    - A 3xx is a failed delivery whose error says the redirect wasn't followed. BullMQ retries, then gives up, as for any non-2xx.
    - The handler is exported for the test.
  - **Verification:** `workers/webhook-redirect.integration.test.ts` stubs BullMQ's `Worker` and mocks `fetch` to answer 307 toward `169.254.169.254`. The test checks that:
    - `fetch` is called once, with `redirect: 'manual'`;
    - the delivery row records status 307 and a redirect error;
    - the job throws for retry.
    - Against the pre-fix handler it fails: no `redirect` option, and the error was only "Non-2xx response: 307".
    - Suite: typecheck 0, lint 0 errors, api unit 315/315, integration 280/280 (48 files).
  - **Follow-up (final-sweep review, DONE):** the redirect fix is correct. No other fetch in the API goes to a URL a tenant controls. Two small leaks next to it:
    - **The resolved internal address was in the error.** It is stored on the delivery and shown to the webhook's owner, so pointing a webhook at a single-word host mapped the internal network. The message no longer names the address.
    - **IPv6 literals kept their brackets in `URL.hostname`,** so the private-literal check never saw `[::1]` or `[fd00::…]`; they were stopped only because resolving the bracketed name failed. The host is now checked without brackets.
    - **Verification (`lib/ssrf-guard.test.ts`, 2 new cases):**
      - `::1`, `fd00::1`, `fe80::1` and `::ffff:127.0.0.1` literals are refused, and a public IPv6 literal passes;
      - with DNS mocked to an internal address, the error doesn't contain it.
      - Both fail against the pre-fix guard.
    - **Left as is:** DNS rebinding between the check and the fetch. Closing it needs connect-time address checks (an `https.request` with a guarded `lookup`), since `fetch` has no hook; noted in `ssrf-guard.ts` since Wave 1.5.
- **X40 — Clause-level chat excerpts find values without the document's context (Low-Medium). — DONE.** Found in the X36 review.
  - Five chat tools look for values only within the clause or paragraph they excerpt, not the whole document:
    - `contract_cite` (the paragraph, though the handler has the plain text);
    - `counterparty_memory`, `portfolio_search`, `playbook_check` and `org_memory` (`clause.content`).
  - Card numbers and IBANs are only recognized near a payment word. So "…pays by corporate credit card. 4.2 Billing. Charges go to 4111 1111 1111 1111 monthly." sends the card raw when clause 4.2 is the source.
  - The same holds for `keyTerms` in `contract_get` and `contract_summarize`: each string is checked on its own.
  - `embeddings.ts` already finds values against the version's text (`valuesFrom`). Give `cutAndRedact` a separate text to find values in, and pass each clause's document. The multi-contract tools need the matched versions' text loaded.
  - **Plan:** confirmed. The redactor recognizes a card or IBAN only when a payment or banking word appears in its input, and these excerpts were redacted with only their clause, paragraph or string as input:
    - `contract_cite`: the paragraph, though its handler already has the version's text;
    - `counterparty_memory`, `portfolio_search`, `playbook_check` and `org_memory`: `clause.content`;
    - key terms in `contract_get` and `contract_summarize`: each string on its own.
    - Fix: let the X36 helper find values in the document as well, and give each piece its document.
  - **What changed:**
    - `lib/pii-policy.ts`:
      - `CutText.valuesFrom` (the document);
      - `cutAndRedact` also replaces values found in the document that occur in the piece;
      - `redactCuts` searches each distinct document once per call;
      - new `redactJsonAgainst(orgId, value, document)` for key terms.
    - `routes/internal-ai.ts`: each tool passes the piece's document:
      - `contract_cite` passes the version text it already had;
      - `playbook_check` makes one extra query for its version;
      - `counterparty_memory`, `portfolio_search` and `org_memory` load the text of the versions their excerpts come from (the clause select gains `versionId`);
      - `contract_get` and `contract_summarize` redact key terms with `redactJsonAgainst`.
  - **Verification:**
    - `lib/pii-cuts.test.ts`: the clause alone isn't a card, and with its document it is.
    - `routes/chat-tool-cuts.integration.test.ts` has 4 new cases, each with a card that is a card only because the contract says "credit card" elsewhere:
      - key terms and the summary in `contract_get` and `contract_summarize`;
      - an `obligations_list` description and quote;
      - a `contract_cite` paragraph;
      - the clause excerpts of `counterparty_memory` (its summary too), `playbook_check` and `org_memory`.
      - Against the pre-fix code all 4 fail, and the 5 X36 cases still pass.
    - `portfolio_search` needs Elasticsearch, which the integration stack doesn't run. It uses the same helper, and its document lookup is by the hit clause's `versionId`.
    - Suite: typecheck 0, lint 0 errors, api unit 319/319, integration 284/284 (48 files).
  - **Adversarial review:** no tenancy or leak regression. Every new version load takes its ids from an org- and own-scope-filtered query in the same handler, and the text is used only to find values. It found these, fixed here:
    - **Missing from the first version:** summaries in `contract_get` and `contract_summarize`, and `obligations_list`'s description and quote, still had no document. They now have one (`obligations_list` loads each obligation's contract's current version).
    - **Slow:** each document value was checked against each piece, up to 23 s with a 20,000-IP annex.
      - Only the kinds that need a keyword now come from the document: card, IBAN, passport, DOB. SSNs, IPs and the rest are found by the piece's own scan.
      - Each document's values are compiled once, into one regex per document and call.
      - A unit case runs 500 clauses against a document with 20,000 IPs and 1,000 dates of birth, well under its bound.
    - **Values replaced inside longer numbers** (`9[REDACTED:PASSPORT]`, `1[REDACTED:DOB]`). A value's occurrence no longer counts where a digit at its edge touches another digit. Letters may touch, so a value right after its keyword still counts. This is checked in code rather than with regex lookarounds, which cost V8 its fast literal matching (tried: 3.4 s instead of 50 ms).
      - This changes one X36 unit expectation: a 20-digit reference holding a card's digits is now left whole, as the detector itself reads it, instead of becoming one merged `[REDACTED:CC]`. The case still asserts no tail, and that the values themselves are redacted.
    - **Smaller fixes:**
      - `redactJsonAgainst` withholds rather than falling back to the raw string;
      - `counterparty_memory` looks documents up by version, not contract.
  - **Left as is:**
    - With the whole contract as context, the keyword gate nearly always passes ("service credit", "bank"). About one in ten 13–19 digit reference numbers passes Luhn, so it will now be redacted in these excerpts, as `contract_get`'s text already was.
    - A piece that holds only part of a value, such as a stored quote the review agent capped at 800 characters, still carries that fragment; it is not an exact match.
    - Card numbers stored as JSON numbers in key terms are not strings, and are not looked at.
    - Some documents are read twice per call (`counterparty_memory`'s two surfaces; `portfolio_search` loads versions for metadata and again for text), and texts are loaded even when the org's mode is off.
- **X41 — The seeded demo admin has a public password, and the self-host guide seeds it (High). — DONE.** Found in the X38 review.
  - `prisma/seed.ts` creates `admin@demo.com` and `legal@demo.com` with the password `password123`, which the seed prints and the README repeats.
  - `docs/operations/SELF-HOSTING.md` tells operators to run that seed to create their first org and admin, and says nothing about changing the password. So every self-host install that follows the guide has an admin login anyone can look up.
  - `.github/workflows/deploy.yml` names the same account and password as production's smoke-test login.
  - Fix:
    - have the seed take the admin's password from the environment (or generate and print one), and refuse `password123` in production;
    - have the guide say to change it.
  - Check whether production's admin still uses it.
  - **Plan:** confirmed. `prisma/seed.ts` hashes `'password123'` for both demo users and prints it, and the guide runs the seed inside the production container.
    - `password123` stays for development, since the README relies on it.
    - In production:
      - take `SEED_ADMIN_PASSWORD`, refusing fewer than 12 characters or `password123`;
      - otherwise generate a random password and print it once.
    - The seed script runs on import, so the rule lives in an importable helper.
  - **What changed:**
    - `src/lib/seed-password.ts` `seedPassword()`.
    - `prisma/seed.ts` uses it, and prints the generated password once, or says it came from `SEED_ADMIN_PASSWORD`. Its upserts never changed an existing user's password, and still don't: it says so.
    - `SELF-HOSTING.md`: the seed command passes `SEED_ADMIN_PASSWORD`; keep the printed password if it generates one; change it after first sign-in, and replace the demo addresses.
    - `deploy.yml`'s comment no longer suggests `password123` for the smoke-test admin.
  - **Verification:** `lib/seed-password.test.ts` has 3 cases:
    - development keeps `password123`;
    - production generates a different random password each time and says so;
    - `SEED_ADMIN_PASSWORD` is used, and refused in production when short or `password123`.
    - The seed has no test run of its own. Running it against the test database would leave a demo org behind.
    - The seed compiles against the project's types. A throwaway config that includes `prisma/` shows two type errors in its role-permission code (lines 129/136 before this change), which predate it; the project typecheck covers only `src`, and tsx runs the seed without typechecking.
    - Suite: typecheck 0, lint 0 errors, api unit 322/322, integration 284/284.
  - **Deploy check:** sign in to production with `admin@demo.com` / `password123`. If that works, change the password now: re-running the seed doesn't.
- **X42 — An approval isn't tied to what was approved (High). — DONE.** Found in the final-sweep review of X24.
  - Auto-approval checks type and value only at submission, and an APPROVED contract's type, value or document can change afterwards (PATCH `/contracts/:id`, version uploads) while it stays APPROVED. Moving APPROVED to EXECUTED by hand is allowed.
  - The org's rule is "NDAs up to $10k auto-approve", so a $2M MSA retyped as an NDA worth 1 and submitted is approved at once. It can then be set back to MSA at $2M, with the real document uploaded.
  - Fix: a change to the terms that approval judged (type, value, currency, a new document version) takes an APPROVED or PENDING_APPROVAL contract back to DRAFT, closing its open approval.
  - **Plan:** confirmed.
    - **Narrowed to APPROVED contracts.** There is no approval status for "withdrawn", and adding one is a design change.
    - **PENDING_APPROVAL left alone:** a human approver decides on the contract as it stands at decision time, and since the X24 follow-up a late decision can't overwrite a contract that has moved on.
    - **Portal and inbound-email versions** already move the contract to UNDER_NEGOTIATION.
  - **What changed:**
    - `lib/contract-status.ts` `statusAfterTermsChange()`: APPROVED goes to DRAFT.
    - `PATCH /contracts/:id`:
      - applies it when a user actually changes type, value or currency (sending the same values changes nothing);
      - answers 409 when a status change comes in the same request;
      - leaves the agents service's extraction writes alone, since document changes reset the approval where the version is saved.
    - A new document version resets it too:
      - document upload;
      - editor save (`html-version`);
      - clause apply, single and batch.
  - **Verification (`contract-status-approval.integration.test.ts`, 4 new cases):**
    - each of value, type and currency returns an approved contract to DRAFT;
    - a rename, and the same terms sent again, leave it APPROVED;
    - a value change with `status: EXECUTED` gets 409;
    - an editor save returns it to DRAFT.
    - Against the pre-fix code the 3 reset cases fail.
    - The full integration suite passes (296).
  - **Left as is:** an open approval on a contract changed while PENDING_APPROVAL stays open until decided. The approver sees the current terms.
  - **Follow-up (after the summary, DONE):** the review of the live-check fixes found that the Extraction Queue could change `value` or `currency` on an approved contract without X42's reset, by a correction or by a reject that clears the value.
    - The queue now resets it the same way, only when the value actually changes. An expiry or another term approval doesn't judge leaves the approval alone.
    - The review's audit event records `statusFrom`/`statusTo`.
    - `review-queue.integration.test.ts` has 2 new cases, which fail without the change.
- **X43 — `admin`-scope API keys outlive their creator, and keys aren't audited (Medium). — DONE.** Found in the final-sweep review of C1.
  - Since C1 made UI keys work, the dialog offers `admin` (full access) with no expiry by default.
  - The key check never looks at who created the key, and deactivating a user doesn't touch their keys, so an admin's key keeps full org access after they leave.
  - Creating or revoking a key writes no audit event, and the list doesn't show who created each key.
  - Fix:
    - revoke a user's keys when they are deactivated;
    - audit key creation and revocation;
    - show the creator.
  - **Plan:** confirmed.
    - `auth.ts` never looks at a key's creator, and deactivation cleared only the refresh token.
    - `POST` and `DELETE /api-keys` wrote no audit event.
    - The list selected no creator.
  - **What changed:**
    - `routes/admin-users.ts`: deactivating a user revokes every key they made, and the audit event records how many.
    - `routes/integrations.ts`: key creation and revocation write `API_KEY_CREATED` and `API_KEY_REVOKED` (new values in `@clm/types`; the action column is a string, so no migration). The list returns each key's `createdBy`.
    - The web keys table shows a "Created by" column.
  - **Verification (`api-keys.integration.test.ts`, 2 new cases):**
    - create and revoke each write their audit event, and the list names the creator;
    - a key made by a user who is then deactivated goes from 200 to 401.
    - Against the pre-fix code both fail.
  - **Left as is:**
    - A creator demoted but still active keeps their keys, whose scopes don't shrink with their role. Checking each request against the creator's current permissions would be a design change.
    - Existing users already deactivated before this change keep their keys: revoke them from the list.
- **X44 — Routes that only check sign-in ignore API key scopes (Low). — DONE.** Found in the final-sweep review of C1.
  - Any API key, scope-less legacy keys included, can read `GET /users` (every member's email, roles and status), `/team/workload`, `/organization`, `/admin/roles` and `/skills`: these routes check only `requireAuth`.
  - Fix: give each a permission check, or refuse API keys on routes that don't declare one.
  - **Plan:** confirmed. 14 routes had `{ preHandler: requireAuth }` and nothing else, and agent threads added `requireAuth` as a hook. A key's scopes are evaluated only by `requirePermission`, so on these routes any key passed:
    - the member list (`GET /users`);
    - `GET /organization` (the org's settings) and `/organization/industry-packs`;
    - roles, skills (×2), the dashboard, team workload, the model list;
    - a person's own things: `/users/me` (read, edit, password), notifications (×2), agent threads.
      - For a key these found no user (it authenticates as `apikey:<id>`). Reads returned 404 or nothing, and an admin key's profile edit or new thread was a 500. So a key could never change anyone's profile or password: only the org's data was exposed.
    - Keys have no roles, so `requireRole` (and skills' own admin check) already refused them.
    - **Approach:** refuse keys on these routes rather than invent a scope for each. They serve the signed-in app, and the public API's scopes (`contracts:*`, `requests:*`, `templates:*`, `reports:read`, `admin`) name none of them.
  - **What changed (`middleware/auth.ts`):**
    - `requireUserOrAdminKey` guards the org's shared data (the member list, org settings and industry packs, roles, skills ×2, dashboard, team workload, model list). It refuses a key without the `admin` scope; the admin scope grants every permission, so `requirePermission` would pass it anywhere.
    - `requireUser` guards a person's own things (`/users/me` ×3, notifications ×2, the agent-threads hook). It refuses every key.
    - `isLimitedApiKey()` is the check they share. Users and the agents service carry no key permissions and pass both. The 403 has the same shape as `requirePermission`'s.
    - `/agent/chat` withholds the `user_search` tool from a limited key. That tool returns names, emails and roles from the member directory; without this, a `contracts:read` key could list members through chat.
    - Three comments that named the old guard now say "checks sign-in only".
  - **Adversarial review (fresh subagent)** confirmed the guard for every kind of caller: user, agents service, admin, narrow, scope-less, expired and revoked keys. No scope other than `admin` resolves to `*`/`*`. It parsed every route registration and found no other route a key reaches without its scopes being checked. The web app and the agents service don't call these routes with a key. It found:
    - *Medium:* a narrow key reached the member directory through agent chat's `user_search`. Fixed as above. The orchestrator drops denied tools from the model's catalogue and refuses a call to one, so the tool is unreachable from that key.
    - *Low:* an admin key passed person-only routes, and its profile edit and thread create were 500s. Fixed by the split into two guards.
    - *Low:* the test only asserted "not 403" for the admin key and didn't check that the key was created. Tightened, as below.
    - *Info:* the 403 body shape now matches `requirePermission`'s.
    - The tracker's deploy note wrongly claimed documented public-API routes were unaffected, since the repo has no public-API docs, and named `obligations:*` scopes, which don't exist. Corrected below.
  - **Verification (`api-keys.integration.test.ts`, 3 cases):**
    - Org data (7 routes):
      - a `contracts:read` key and a scope-less legacy key get 403;
      - an admin key, an ADMIN user and a VIEWER user get 200;
      - the model list: 403 for the narrow key, and past the guard (502, since the test stack runs no agents service) for the others;
      - the agents service reads `/organization`;
      - the narrow key still reads `/contracts`.
    - Person routes: an admin key gets 403 on `/users/me`, notifications, threads, `PATCH /users/me` and thread create, while the user gets 200.
    - Chat: a narrow key's turn goes out with `user_search` denied; an admin key's and a user's turns don't.
    - Against the pre-fix code the org-data case fails (`/users`: 200 where 403 was expected). Without the review fixes the person-routes case (`/users/me` 404 for an admin key) and the chat case both fail.
    - Suite (X44 alone): db:generate ok, typecheck 0, lint 0 errors, api unit 326/326, integration 301/301 (48 files).
  - **Deploy note:** an integration that reads any of these routes with a key needs the `admin` scope now, and no key can use a person's routes. There is no narrower scope for reading the member list; add a `users:read` scope if a customer needs one.
- **X45 — `contracts:write` API keys can't create contracts (Low, functional). — DONE.** Found in the final-sweep review of C1.
  - `POST /contracts` stores the caller's id as the owner. For a key that is `apikey:<id>`, not a user, so the insert fails with a 500.
  - Fix: own the contract as the key's creator.
  - **Plan:** confirmed (the insert fails on `contracts_ownerId_fkey`, 500).
    - **Widened at review to the whole class.** Wherever a key's `apikey:<id>` lands in a column that is a foreign key to `User`, the write fails.
    - **Every contract create path a `create:contract` key reaches:**
      - `POST /contracts`, `/upload`, `/bulk-import`, `/:id/amendments`;
      - `/diligence/:id/upload`;
      - a binder split (the worker owns the children as the job's user);
      - `/agent/draft` with `saveAs.title`, whose try/catch swallowed the failure and answered 200 with no contract;
      - request conversion, where the owner falls back from the requester to the converter.
    - **Also:**
      - `POST /matters` (`Matter.ownerId`);
      - obligation completion, directly or by reconciling its invoice (`Obligation.completedById`, needs only `edit:contract`);
      - an admin key setting the org's AI key (`OrgAiKey.createdById`);
      - the skill-invocation telemetry row in `/agent/chat`, dropped silently.
    - `AgentThread` is closed to keys by X44.
    - Plain-string attribution columns keep the key; it's who acted: version `createdById`, `Contract.createdBy`, `Matter.createdById`, invoice `reconciledById`, request `requestedById`, and audit events.
  - **What changed:**
    - `lib/acting-user.ts` `actingUserId()`:
      - a user or the agents service is itself;
      - a key acts as the user who made it, or, for a key made through keys, the user at the root, through unrevoked keys;
      - that user must be in the key's org, not deleted or deactivated, and still able to manage the org's API keys (`configure:organization`). Anyone who can do that can make a key that reads and edits every contract, so owning what the key creates gives them nothing new.
      - Otherwise the route answers 422 `{ error: 'NO_ACTING_USER', detail }`, before any upload, write or paid agent call.
    - Owners (foreign keys) for a key's writes:
      - the key's maker for contract creates (`POST /contracts`, upload, CSV import, amendments, diligence upload, `/agent/draft`), matters, a request conversion's fallback owner, a new org AI key row (a rotation keeps the row's creator and needs no one), and the skill-invocation row (skipped when there is no one);
      - a split: the binder's owner, as the automatic split does. The job carries `ownerId`, and a job queued by a key before this change falls back to the binder's owner instead of failing after retiring the previous children;
      - obligation completion, direct or by reconciling its invoice: no user (`completedById` is nullable), so a key needs no maker to complete one.
    - Attribution names the key: CSV-import rows now set `createdBy`; split children's `createdBy` and version `createdById`; audit events as before.
    - Permissions are unchanged: the key's scopes still decide what it may do; this decides only whose name goes in an owner column.
  - **Adversarial review (fresh subagent):** no High findings.
    - Confirmed:
      - no cross-org owner (both lookups are scoped to the key's org);
      - no other `User` foreign-key write a key reaches (threads are closed by X44; skill creation checks roles);
      - no change for users or the agents service;
      - every 422 comes before storage writes and the agent call.
    - Fixed:
      - *Medium:* a maker demoted to an own-scope role but still active would own the key's contracts and see them, with their invoices and reminders. Now they must still hold `configure:organization`.
      - *Low:* completions, CSV rows and split children credited the maker rather than the key. Now handled as above.
      - *Low:* a 422 was raised where no user is written (invoice reconcile, AI-key rotation). Removed.
      - *Low:* a key's split took the children from an own-scope binder owner, and old queued jobs would fail after retiring the previous children. Fixed as above.
      - *Info:* the 422 now carries a machine-readable `error` code. Keys made through keys resolve to the root user.
    - Moved to X46: keys whose maker is gone (deactivated before X43, or made through a key) still authenticate for everything else.
  - **Verification:**
    - `routes/api-key-create.integration.test.ts` (9 cases):
      - every create path above owns the contract as the key's maker, and the audit and `createdBy` name the key;
      - a key made through a key acts as its root user;
      - a split queues the binder's owner and the key as creator, while a user's split is unchanged;
      - converting keeps a human requester as owner, and a key's own request goes to its maker;
      - a matter is the maker's; a key's completion and reconcile record no user, even for a key without a maker, while a user's completion is theirs;
      - the AI key and skill invocation name the maker, and a key without one still chats, unrecorded;
      - keys whose maker was deactivated, demoted, deleted or is in another org get the 422, with nothing stored, no S3 write on upload or diligence upload, and no draft requested.
      - Against the pre-fix code all 9 fail.
    - `lib/binder-split.integration.test.ts` (2 new cases, real worker and pdf-lib): a job's `ownerId` is honoured with the key as creator, and an old key job goes to the binder's owner. Both fail against the pre-fix worker.
    - Suite: db:generate ok, typecheck 0, lint 0 errors, integration 310 passed (49 files).
      - `render-ssrf`'s 2 Gotenberg cases skipped under the full run's load: the 2-second health probe timed out. Run alone they pass.
      - api unit 325/326: `diff.test.ts`'s event-loop case hit vitest's 5-second default under load. It passes alone, 3/3. Both are timing problems in tests from earlier in this run (X11, X32), fixed in their own commit next.
- **X46 — An API key can mint API keys that outlive the user behind it (Medium). — DONE.** Found while fixing X45.
  - Key management (`/admin/integrations/api-keys`: create, list, revoke) checks `configure:organization`. An `admin`-scope key has that, so a key can create keys, and the new key records `createdById: apikey:<id>`.
  - X43 revokes a deactivated user's keys by `createdById = <user>`, so keys minted through their keys survive it. A leaked admin key can also mint replacements that outlive its own revocation.
  - Fix: key management for signed-in users only, refusing every API key. Deactivation also revokes the keys minted by the keys it revokes, so chains made before the fix are caught.
  - **Plan:** confirmed. `POST /api-keys` records `createdById: req.user.sub`, which for a key is `apikey:<id>`.
    - **Widened at X45's review:** a key whose maker was deactivated before X43, or deleted, kept authenticating everywhere, and so did every key made through a key. Nothing at request time looked at who made a key.
  - **What changed:**
    - `lib/acting-user.ts` `keyMaker()`: the user behind a key, while they could still make it:
      - it follows `apikey:` links (at most 5) through keys that are unrevoked, unexpired and in the key's org, to the root user;
      - it returns that user only while they are an active member of the org who can manage its API keys (`configure:organization`, read from their roles in the database).
      - X45's `actingUserId` now reads the result from the request instead of resolving it again.
    - `middleware/auth.ts`: a key authenticates only while `keyMaker` finds its user. Otherwise it gets 401 "API key invalid or revoked", the same answer as a revoked key, with the reason in the server log. The user's id rides on `req.user.keyMakerId`.
      - This switches off, with no further step, the keys of users who left before X43, were deleted, or were moved to a role that can't make keys, and every key made through a key whose chain is broken.
      - Cost: the key lookup plus the user and their roles on each key request (the org's role permissions are cached). The chain walk adds one query per link, for legacy chains only.
    - `routes/integrations.ts`:
      - key management (scope list, create, list, revoke) takes `requireUser` before its permission check, so no API key can manage keys;
      - creating a key also needs `keyMaker` to accept the creator, which refuses a deactivated user's still-valid access token and the agents service.
    - `routes/admin-users.ts`:
      - giving someone access (invite, bulk import, role change, reactivate) takes `requireUser`, so an admin key can't invite a new admin or restore its demoted maker's role. Deactivation stays open to admin keys, for offboarding automation.
      - Deactivation revokes the whole tree of keys the user made and keys made through them, including through an already-revoked key, and the audit records how many.
    - Migration `20260923050000_revoke_orphaned_api_keys` (a data repair) revokes keys whose maker is deactivated, deleted or missing, keys made through a revoked or expired key, and everything made through those. The list then shows them revoked, and reactivating a user doesn't bring them back.
    - An admin key keeps its other admin rights: webhooks, settings, reading members, and deactivation.
  - **Adversarial review (fresh subagent)**, which probed the running code in a separate org:
    - Confirmed:
      - no other code creates `ApiKey` rows;
      - `requireAuth` is the only place keys are authenticated;
      - chains can't cycle, and a link into another org is refused;
      - the deactivation walk terminates and counts correctly;
      - there is no other way a user leaves an org;
      - the web UI manages keys with the user's token.
    - Fixed:
      - *Medium:* an admin key could invite a new admin, accept the invite through the public route, and mint a replacement key that survived the original's revocation. Fixed by the admin-users guard.
      - *Medium:* sign-in checked membership, not authority, so a demoted admin's key could restore their role. Now the maker must still hold `configure:organization`, and role changes need a signed-in user.
      - *Low:* keys of pre-X43 leavers were blocked but not revoked, so reactivating the user revived them. Fixed by the migration.
      - *Low:* key creation trusted the token, letting a deactivated admin's still-valid token or the agents service create a key. Fixed by the creation check.
      - *Low:* expiry didn't pass down a chain. Now every link must be unexpired.
      - *Low:* the 401 detail told a leaked key's holder the key was real. It now says what a revoked key does.
      - *Low:* the chain limit counted differently at sign-in and in `actingUserId`, which also repeated the lookups. It is now resolved once, at sign-in.
      - *Tests:* nothing covered revoking a parent while the root user is active; that case is added, along with the others below.
  - **Verification:**
    - `api-keys.integration.test.ts`, 6 X46 cases:
      - an admin key gets 403 on key create, list, scope list and revoke, and on invite, bulk import, role change and reactivate, and still 200 on webhooks;
      - a pre-X43 leaver's key, a key made through their key, and a demoted admin's key go from 200 to 401, with the revoked-key wording;
      - a key made through a key goes from 200 to 401 when that key is revoked while its user stays active; so does a child of an expired key, and a link into another org; chains are followed through 5 keys and no further;
      - a deactivated admin's still-valid token and the agents service can't create a key, while an active admin can;
      - deactivation revokes the user's key and the keys made through it (the audit counts 4), and they stay revoked after reactivation;
      - the migration revokes the keys of a deactivated user, a deleted one and a missing one, children of revoked and expired keys, and a grandchild, and leaves a healthy chain working.
    - The X45 tests follow the new rule: keys whose maker left, was deleted, is in another org or was demoted get 401 before anything is stored, uploaded or drafted. The route guard's helper is checked directly.
    - Test makers now hold an ADMIN role in the database, as real key makers do, via a shared `grantRole` test helper. The signing-tokens test's key has such a maker.
    - Against the pre-fix code all 9 new or changed cases fail.
    - Migration applied to the test database (40 migrations, up to date).
    - Suite: db:generate ok, typecheck 0, lint 0 errors (warnings at the baseline, web 22 and api 11), api unit 326/326, web 18/18, integration 319/319 (49 files).
  - **Deploy note:** on deploy, keys whose maker is gone or can no longer manage API keys stop working, and the migration revokes those of makers who left.
    - Re-issue any still in use: Admin → Integrations → API keys, where the "Created by" column is empty for keys made by keys or by users who are gone.
    - Automations that created keys, invited users, changed roles or reactivated users with an admin key must move to a signed-in admin.
  - **Left as is:**
    - Webhooks, Slack settings and share links an admin key configured keep working after the key is revoked. An admin key is full access by design; review them after revoking a leaked one.
    - A demoted maker's keys are refused while they are demoted, not revoked; re-promoting them brings the keys back. The list shows them live.
    - The agent tools' scope check (`lib/agent-scope.ts`) re-reads a key's scopes per tool call but not its maker; the chat turn that calls them was authenticated with the maker check moments before.


- **X47 — Opening a contract saves a new version of it (High). — DONE.** Found during the live checks of C1, C5, V1 and X1, after the closing summary.
  - Opening a contract page in the web app saves an "Edited in-place" version 5–20 s later, though nobody edited it.
    - Cause: TipTap 3's `setEditable` emits an `update` event unless told not to. `DocumentCanvas` calls it whenever an editor mounts, and the contract page autosaves every update it hears about.
    - When the saved HTML comes back re-serialized, the editor re-mounts and saves again.
  - Each view:
    - adds a version, with no audit event;
    - moves the current version off the uploaded PDF, so the Original view, and X1's PDF citations, stop working;
    - renders a PDF into object storage;
    - since X42, would send an APPROVED contract back to DRAFT because someone looked at it.
  - The autosave wiring dates from the first commit; X42 made it serious.
  - **What changed:**
    - `apps/web/src/components/contracts/DocumentCanvas.tsx` syncs the editable flag with `setEditable(editable, false)`, the root cause. It reports an update only when its transaction changed the document (`lib/canvas-update.ts`), which `setEditable`'s synthetic update never does.
    - `POST /contracts/:id/html-version`: a save whose HTML is the current version's returns that version with no new version, render or status change. Line breaks between tags are ignored, since the extractor writes them and the editor doesn't. Any other difference is an edit, a single space included.
  - **Verification:**
    - `routes/html-version-noop.integration.test.ts`:
      - an approved uploaded contract, saved back as the editor serializes it, gets 200 and the same version, stays APPROVED, and renders nothing;
      - a one-space edit gets 201 and a new current version, and the contract goes back to DRAFT (X42).
      - Against the pre-fix route the first case fails (201). X42's 11 cases still pass.
    - `apps/web/src/lib/canvas-update.test.ts`: a read-only canvas reports no edit.
    - Web 22/22, typecheck clean, lint 0 errors (warnings at the baseline).
  - **Local data the checks touched:** the phantom save created the Unanalyzed Document's v5 and the Globex NDA's v2 and v3 while I opened them.
    - All three were backed up (session scratchpad, `x47-phantom-versions-backup.json`) and removed. Both contracts point at their earlier current version again (Globex, its uploaded PDF), and their statuses never changed (DRAFT, EXECUTED).
    - The Unanalyzed Document's older "Edited in-place" versions (June, August) are probably earlier phantom saves, so I left them.
  - **Adversarial review (fresh subagent, after the summary):** these findings were fixed.
    - *Medium:* the first guard, which reported only while the canvas was editable, also dropped real edits made from view mode by commands, such as "apply defined term everywhere" and the AI rewrite on a deviation badge, which used to be autosaved. The guard is now `transaction.docChanged`.
    - *Low:* the no-op check compared against the latest version. After a redline undo the contract stands on an older one, and saving the latest again was dropped. It now compares against the current version.
    - *Low:* the edit audit recorded a `statusFrom` on every draft edit. Only a real reset is recorded now.
    - *Info:* the API check absorbs only line breaks between tags. TipTap re-serializes extractor HTML in other ways (list items, comments, `<pre>`, `&nbsp;`), so a tab still running the old bundle keeps saving phantom versions until it's reloaded. The client fix is what stops it.
    - New cases fail against the previous route: a draft edit records no status change, and after an undo, saving the latest again makes a version while saving it once more doesn't.
  - **Follow-up (DONE):** in-place document edits wrote no audit event, though since X42 one can undo an approval. A real edit now records `CONTRACT_UPDATED` `{ action: 'document_edited', versionNumber }`, adding `statusFrom`/`statusTo` when the approval was reset. A no-op save records nothing. `html-version-noop.integration.test.ts` checks both, and the edit case fails without the change.

- **X48 — Concurrent token refreshes log the user out (Medium). — DONE.** Found during the same live checks.
  - When the 15-minute access token expires while several requests are in flight, each request's 401 handler calls `refresh()` with the same refresh token.
  - The server rotates the refresh token on use and refuses the old one ("Refresh token revoked"). So every refresh after the first failed, and the client logged the user out.
  - During the checks the network log showed exactly that: 2 refreshes answered 200, then 5 answered 401, then a logout.
  - This run didn't change either side of the refresh flow; it predates the run.
  - **What changed:** `apps/web/src/lib/single-flight.ts`. The auth store's `refresh` now runs once for all concurrent callers, and the first call after it settles starts a new one.
  - **Verification:** `apps/web/src/lib/single-flight.test.ts`:
    - three concurrent callers share one run and its result;
    - after a failure, both callers see it and the next call runs again.
    - Web suite and typecheck pass.
    - Live, after the fix: a dashboard load with an expired token sent six requests that got 401 together. They made exactly one refresh (200), each retried and got 200, and the session stayed signed in.
  - **Left as is:** each tab of the same user holds its own copy of the refresh token, and the server keeps only the latest. A second tab's next refresh is refused and that tab signs out, as before.
  - **Adversarial review (fresh subagent, after the summary):**
    - *Low, fixed:* the shared refresh had no time limit, so a hung one held up every later request. A refresh that finished after a sign-out and a new sign-in also wrote the old session's tokens over the new ones. It now times out after 15 s and leaves a changed session alone. `apps/web/src/store/auth.test.ts` fails without the change.
    - *Medium, existing, not done:* in the multi-tab case above, the signing-out tab also clears the tokens the other tabs share. The fix would be a cross-tab lock (`navigator.locks`) with a re-read of the stored token, plus an atomic rotation on the server.
    - Checked: retried requests carry the new token, and on failure every waiter signs out but only one sign-out request is sent.

- **X49 — The contract page's Original (PDF) view never works (Medium). — DONE.** Found during X1's live check.
  - Two causes, both from the first commit:
    - `GET /contracts/:id/versions` never returned `s3Key`, but the page enables the Original toggle only when the latest version has one. The toggle was disabled on every contract as soon as the version list loaded ("No original file").
    - The viewer (`@react-pdf-viewer/core` 3.12) loaded its worker from unpkg, pinned to pdf.js 3.11.174. The root `package.json`'s pnpm override, `pdfjs-dist >=4.2.67` (the fix for CVE-2024-4367), installs 5.7.284, so every render failed with "The API version 5.7.284 does not match the Worker version 3.11.174".
  - X1 needs both, so it couldn't work live.
  - **What changed:**
    - `/versions` returns each version's `s3Key`; `GET /contracts/:id` already returned it for every version.
    - The viewer's worker is now the installed package's (`pdfjs-dist/build/pdf.worker.min.mjs?url`), bundled by Vite rather than fetched from a CDN, with a `*?url` type declaration.
  - **Verification:**
    - `routes/contract-versions.integration.test.ts`: the list says which versions have a stored file. It fails against the pre-fix route.
    - Live: the Globex NDA's Original view renders, and a citation lands on its page, outlined (see X1).
    - Web typecheck clean. The production build emits the worker as a hashed asset.
  - **Left as is:** `@react-pdf-viewer` 3.12 predates pdf.js 4's text-layer API, so pages render without selectable text. Fixing that means replacing the viewer, a dependency change. Keep the override: dropping it would reopen CVE-2024-4367.
  - **Adversarial review (fresh subagent, after the summary):**
    - *High, fixed:* the production build ships the worker as a hashed `.mjs` asset. The self-host nginx, whose default `mime.types` has no `mjs`, served it as `application/octet-stream`, and browsers won't run a module of that type. So the Original view, and X1, would never have rendered in self-hosted installs. The dev server serves it correctly, which is why the live check passed.
      - `deploy/selfhost/nginx.conf` now serves `.mjs` as JavaScript. Checked with `nginx:alpine` against a production build: `application/octet-stream` before, `application/javascript` after.
      - Firebase Hosting, used in production, maps `.mjs` to JavaScript itself.
    - *Medium, fixed:* with the key now in the version list, a DOCX or TXT latest version would have opened the PDF viewer on a file it can't read, bringing back the "Invalid PDF structure" error U.1.2 had fixed. The Original view is now for PDFs only. The local data has no contract whose latest file isn't a PDF; the PDF case still renders live.
    - *Low, left:* the viewer calls `renderTextLayer`, which pdf.js 5 doesn't have. That's one unhandled rejection per page render, with no text selection or search (as above). pdf.js 5 has no `isEvalSupported` setting to harden.
    - Checked: `/versions` is org-scoped and behind the own-scope guard, `GET /:id` already returned `s3Key`, and the repo sets no Content-Security-Policy.
  - **Follow-up (C10's live check):** a DOCX upload opened in the Original view (the view is a per-browser preference) on "No original file — this contract was created from text or a template", which is wrong: it was uploaded, as a Word file. That copy predates X49, but X49's PDF-only rule is what now sends every non-PDF upload to it. Such contracts now say "The original isn't a PDF — only PDFs open in this view; download the original from Actions, or read it in the Styled view", and the Original toggle's tooltip says the same. Web typecheck clean; there's no component-test setup for the page.

- **X50 — A second tab of the same user signs out on its next refresh (Medium). — DONE.** Left from X48, fixed after the summary at your request.
  - Tabs share the tokens in localStorage, but each keeps its own copy in memory, and the server keeps only the newest refresh token.
  - When one tab refreshed, another later refreshed with its stale copy and was refused, then signed out, clearing the tokens every tab shares.
  - The server also looked the token up and replaced it in two steps, so two refreshes racing with one token could both answer 200. When the new tokens differed, which needs a second boundary between them since `iat` is in whole seconds, the loser's were already dead.
  - **What changed:**
    - `apps/web/src/store/auth.ts`: before refreshing, a tab takes newer tokens another tab stored, only the same user's (compared by the token's `sub`). If a refresh is refused because another tab won a simultaneous one, it looks for the winner's tokens for up to 2 s before giving up. Another user's session is never taken, and when localStorage is unavailable nothing changes.
    - `POST /auth/refresh` rotates only while the token is still the current one: an atomic conditional update, `deletedAt: null` included. This also stops a refresh reviving a session that a sign-out or deactivation just ended.
  - **Adversarial review (fresh subagent)** of a first version:
    - That version kept tabs in step through a `storage` listener and refreshed under a cross-tab `navigator.locks` lock.
    - Its findings:
      - *Medium:* the listener could switch a tab to another user mid-request, so a request made as X was retried as Y.
      - *Medium:* one tab's failed refresh, even a network error, signed out every tab.
      - *Medium:* tabs without the lock (plain-http LAN hosts, older browsers, tabs on the old bundle) always lost a simultaneous refresh against the new atomic server check.
      - Smaller: an adopted token could be expired; blocked storage broke refresh; the lock wait had no limit.
    - All are met by the narrower design above: no listener, no lock, same-user adoption only, expiry checked, and storage read defensively.
    - The review confirmed the atomic update, a single `UPDATE … WHERE id AND refreshToken`, lets exactly one racing refresh win.
  - **Verification:**
    - `apps/web/src/store/auth.test.ts`, 4 new cases:
      - a tab takes the same user's newer stored tokens without a POST;
      - it never takes another user's;
      - after losing a race it takes the winner's tokens;
      - a refused refresh with nothing newer still fails, so the tab signs out as before.
      - The first and third fail without the change.
    - `routes/auth-refresh.integration.test.ts`:
      - two refreshes held until both have read the same token: one gets 200, the other 401, and the stored token is the winner's. Before the fix both got 200.
      - The old token stops working after a refresh.
  - **Left as is:**
    - Signing in as a different user in another tab still leaves each tab on its own session, as before.
  - **Second adversarial review (fresh subagent) of `3307df0`**, and what changed:
    - *Medium:* "newer" meant "different". A tab took any same-user pair from storage, even an older, dead one that a tab with a stale copy had written back, then failed and signed out. Now it takes only a pair issued later (`iat`) whose access token is also the same user's.
    - The storage poll skipped the session-changed check.
    - The 401 interceptor could send a request made as one user again as another, after a sign-in during the refresh.
    - A failed refresh called the server's sign-out, which could end the session every tab shares.
    - Fixed: the poll checks the session, the interceptor re-sends a request only as the user who made it, and a failed refresh signs out this tab only.
    - *Low:* the atomic rotation refused a harmless same-second race, in which both racers mint identical tokens. Now both get the current pair.
    - The validity margin is 60 seconds, against clock skew. New tests cover a late winner, a session change and an older pair.
  - **Third review (combined with X52 and X53, fresh subagent)** found no High or Medium issues. Fixed:
    - **Same-second sign-in:** a refresh could be handed a newer sign-in's tokens when a sign-out and a sign-in fell in the same second, because the tokens were then identical.
      - Tokens now carry a session id (`sid`) from sign-in through every refresh.
      - A token from before this change gets one derived from the token itself, so sessions in flight continue.
    - **Expired pair:** the storage poll adopted a pair whose access token had expired.
    - **Stale write-back:** a stale tab's state change (a profile save) wrote its older tokens over the newer ones in storage. Storage now keeps the same user's newer tokens.
    - **Network errors:** a network error or timeout during a refresh signed the tab out. Now only a refused refresh does.
    - **Sign-out after a pause:** signing out after 15 idle minutes ended nothing on the server, since only the expired access token was sent. The refresh token now goes with it, and only the user's current one counts.
    - **Left as is:**
      - `iat` can't order two tokens issued in the same second, or by servers whose clocks differ.
      - The sign-in page doesn't pick up a session another tab kept.
  - **Verification after both reviews:**
    - `store/auth.test.ts` has 17 cases, `lib/api.test.ts` 7 and `routes/auth-refresh.integration.test.ts` 7. Each fix's test fails on the version before it.
    - Live: an expired session in the running app refreshed onto `sid` tokens, with no sign-out.


- **X51 — The Negotiate tab can't be opened on a contract with no extracted clauses (Low). — DONE.** Found during C8's live check.
  - The contract page shows its tab bar only outside the document view. From the document view, the only ways out were the rail's Clauses "View all", shown only when the contract has clauses, and "Review & Decide", shown only during an approval.
  - So on a contract whose extraction found no clauses, Overview, Versions and Negotiate couldn't be opened at all, and its redlines couldn't be analysed. Ironbridge SOW #03 is one: two versions, no clauses.
  - In the local data, 8 of the 94 contracts with two or more versions have no clauses. The gap dates from the first commit.
  - **What changed:** the rail's History section has a "Negotiate" link when the contract has two or more versions. It opens the Negotiate tab, and with it the tab bar. It isn't called "Compare" because the header's Compare button opens a different view (CompareMode).
  - **Verification:**
    - Live on Ironbridge SOW #03: before, the rail offered only its section toggles and analysis actions. Now "Negotiate" opens the tab, where C8's check ran.
    - apps/web has no component-test setup (no testing library or DOM environment), so there's no automated test. Web typecheck and lint clean.

- **X52 — A card number, IBAN or SSN wrapped across a line in a PDF escapes redaction (Medium). — DONE.** Found during X23's live check.
  - Text extracted from a PDF breaks lines wherever the layout wrapped. A card number printed as "4111 1111 1111 1111" came out as "4111 1111\n1111 1111". The detector joins digit groups only across spaces or dashes: X27 deliberately kept line breaks out, so that a column of numbers isn't read as a card. So the number went to the models whole. The same happened to an IBAN wrapped between groups and an SSN wrapped after a hyphen.
  - **What changed** (`lib/pii-redactor.ts`):
    - The single-line patterns are unchanged and run first.
    - New cross-line patterns for cards and IBANs accept only value-shaped groups: for a card, a first group of 4 digits, then groups of 4–6, the last 3–6; for an IBAN, groups of four. Exactly one line break is allowed. A card or banking word must appear on the match's own lines or the line before.
    - A match that fails its check lets the scan resume after its line break, since the value may start on the next line.
    - SSN and ITIN accept one line break after a hyphen.
    - Values restore byte for byte, line break included.
  - **Verification:** `lib/pii-redactor.test.ts` +7 cases:
    - wrapped cards (several break positions, CRLF, Amex);
    - a wrapped IBAN and a wrapped SSN;
    - the review's regressions below.
    - Live: the X23 fixture's wrapped card reached the models as a token.
  - **Adversarial review (fresh subagent)** of the first cut, which let the break sit between any digits:
    - *High, fixed:* a number ending the line before a card ("Page 3 of 12", "Invoice 2024", "Expiry 12/27") was joined to it, the pair failed Luhn, and the card leaked. That happened in 81% of "Ref <n>\n<card>" samples, where the old detector caught every one. IBANs the same.
    - *Medium, fixed:* whenever a card word such as "credit" appeared anywhere, dates, phone numbers and amounts on consecutive lines were read as cards (about 18%, 18% and 9%).
    - **After the redesign:**
      - 0 of 2,000 glued samples leak.
      - None of 800 date pairs, 500 amount pairs and 1,000 phone pairs is taken for a card.
      - Adversarial inputs of 100,000–150,000 characters run in under 30 ms.
      - The review's three repros are pinned as tests, and they fail on the first cut.

- **X53 — The chat can't redline a clause the user names by its section (Medium). — DONE.** Found during X23's live check.
  - `redline_propose` targets a clause by its id, which the chat model can't see, or by its type. Its own description offers "propose changes to §X".
  - "Redline section 4" made the model guess a type ("contractor_information"), and the tool answered only "Clause not found". The model then asked for a section number or a unique phrase, neither of which the tool takes.
  - **What changed:**
    - The tool takes `section_ref` ("4", "§4", "Section 4.2"). Section references are normalised, including spacing and leading zeros.
    - A miss answers with the contract's clauses: id, type, section and opening words, so the model can retry by id.
      - Neighbours of the section asked for come first.
      - At most 60 are listed, with a note when the contract has more.
      - The openings are contract text going to a model, so they're cut and redacted under the org's PII policy the way X36's excerpts are. A value that crosses the cut isn't sent.
    - A section that misses falls back to a clause type given with it. A reference with no number ("§") names nothing.
  - **Verification:**
    - `routes/redline-propose-target.integration.test.ts` (6) covers:
      - the section forms;
      - the miss list, with a redacted SSN in an opening and a retry by id;
      - a section the contract lacks;
      - an empty reference;
      - the type fallback;
      - a 73-clause contract whose list puts 90.x first and says it's cut.
    - `lib/agents-redline-propose-tool.test.ts` (2) is a source tripwire for the Python tool.
    - All of these fail without the change.
    - Live: "Redline section 4 …" produced three variants for §4, and applying one wrote the real SSN (X23).
  - **Adversarial review (combined, fresh subagent):**
    - Tenancy and PII hold. The list is scoped to the contract's current version after the org and own-scope checks, and the openings follow the org's mode and fail closed.
    - Fixed from its findings:
      - an empty key matched an unnumbered clause;
      - "Sections 4", "sect. 4", "04" and "4 (a)" didn't normalise;
      - a missed section ignored a type given with it;
      - the list's cap was invisible to the model;
      - a long `section_ref` got a 400 instead of the list (Python now clamps it).
    - Left as is: "Article IV" doesn't match "Article 4". It falls through to the list.

- **X54 — Chat turns barely count toward usage or the daily cost cap (Medium). — BLOCKED (needs a decision).** Found while tallying the live checks' spend.
  - `POST /agent/chat` records a turn's usage as the user's message plus the streamed reply, priced at a flat estimate (`routes/agents.ts:294`, `lib/costCap.ts` `estimateCostUsd`). It leaves out what the agents service actually sends each model call: the system prompt, history, tool definitions and tool results, often tens of thousands of tokens a turn.
    - Today's local tally recorded 7 chat turns as 178 input tokens under provider/model `requested-default`. The same tally priced background jobs at $1.04 for 164k input tokens, a conservative flat rate.
  - **Effects:**
    - The platform's daily cost cap (`PLATFORM_DAILY_COST_CAP_USD`, default $50) barely sees chat, the heaviest user of models.
    - The admin usage panel under-reports chat by one to two orders of magnitude.
    - A chat turn on an org's own key (BYOK) is recorded as platform spend (`isByok` is never set on this path), so it counts against the platform cap.
  - **Fix I'd make:**
    - The orchestrator adds up `usage_metadata` from each model call in the turn and puts it on the `done` frame, which already names the resolved provider, model, tier and key source.
    - The relay (which forwards bytes undecoded) keeps the stream's tail, reads the `done` frame, and records real tokens, the resolved model, `isByok` from the key source, and a per-model price.
  - **Why it isn't done:** counting chat properly makes it count far more against the daily cap. Orgs that never hit the cap could start getting 429s. The cap value, and whether chat should count toward it at all, is a product decision. A narrower first step that changes no gate is to fix only the recorded numbers and `isByok` in `org_usage_daily`, and keep the cap counter as it is.

- **X55 — The per-contract Q&A never reached the model (Medium). — DONE.** Found while writing the QA test cases (`docs/38-QA-TEST-CASES-fix-audit-2026-09-22.md`).
  - `POST /contracts/:id/ask` called the agents service's `/agent/ask` without the `x-internal-secret` header. The agents service refuses every call without it (401), so every question answered "Agent unavailable — showing relevant clauses". The portfolio-level `/search/ask` sends the header and worked.
  - The integration test's fetch mock answered any call, which is why this passed. An audit of every API call to the agents service found no other call missing the header.
  - **What changed:** the route sends the header. The mock in `routes/pii-surfaces.integration.test.ts` now refuses calls without the secret, as the real service does, so every agents call that file exercises is checked.
  - **Verification:** with the old route, both per-contract ask tests fail (the answer comes back null). All 16 pass now.

- **X56 — Retyping an approved contract kept it Approved (Medium). — DONE.** A gap in X42, found while writing the QA test cases (TC-WF-04 N6).
  - X42 sends an approved contract back to DRAFT when its type, value, currency or document changes. It applied on PATCH, uploads, editor saves, clause applies and Extraction Queue corrections, but not on the two retype paths:
    - the contract page's type chip, `POST /contracts/:id/retype`;
    - the agent's `contract_update` `retype` action.
  - Both changed the type with no reset. The REST route also wrote no audit event.
  - **What changed:**
    - Both paths apply `statusAfterTermsChange` when the type actually changes.
    - Both write a `CONTRACT_UPDATED` audit row: `{action: 'retype', typeFrom, typeTo}`, plus `statusFrom`/`statusTo` when the approval is reset. The agent's row adds `source: 'agent'`.
    - The agent's diff lists the status change, so the confirm card shows it.
    - Retyping to the same type changes and records nothing.
  - **Verification:** `routes/contract-status-approval.integration.test.ts` +2 cases: page and agent retype reset an approval, with its audit row; the same type changes nothing; a retyped draft stays a draft, with its row. Both fail on the old routes; 13/13 pass.

- **X57 — A failed redline job left the Negotiate panel spinning and marked the contract's analysis failed (Medium). — DONE.** Found while writing the QA test cases (TC-AI-02).
  - When the redline-analysis job itself failed (agents service unreachable, cost cap reached), the worker's failure handler did two things wrong:
    - It marked the contract's whole analysis FAILED, although extraction had succeeded.
    - It left `_redlineStatus` on ANALYZING, so the panel showed "Analyzing redlines…" forever.
  - A failed approval summary also marked the analysis failed. Only playbook review was exempt.
  - **What changed:**
    - The handler moved to `lib/agent-job-failure.ts` (`onAgentJobFailed`) so it can be tested without starting the worker.
    - Follow-on jobs (playbook review and redline, redline analysis, approval summary) no longer touch the analysis status.
    - A failed redline analysis records `_redlineStatus: FAILED` and `_redlineError` ("The redline analysis could not run: …"), which the panel's failure box shows. Other metadata stays.
    - Analysis stages still mark the analysis FAILED. Nothing changes while retries remain.
  - **Verification:** `lib/agent-job-failure.integration.test.ts` (4). The redline and follow-on cases fail on the old handler's logic; all pass now.

---

## Run log

Append one line per task as it completes: `<task id> — <status> — <one-line summary> — <commit sha>`.
S1 — DONE — GET /organization redacts Slack secrets; PATCH can't overwrite server-managed keys; checklist stops echoing settings — cca7b19
S2 — VERIFY-PENDING — agent read tools resolve the caller's view scope server-side and push it into Prisma, pgvector and ES; needs a live SALES_REP chat probe — 701b0b5
S3 — DONE — every upload path validates bytes via lib/file-type.ts; detected type stored; presigned downloads serve only allowlisted types — 4b91cbc
C1 — VERIFY-PENDING — create-key dialog sends chosen scopes + expiry; server refuses scope-less keys; needs a visual check of the dialog — cc1965b
C2 — DONE — no-target escalation keeps the step with its approver + notifies admins; exact step-order matching; escalated visible; repair migration — 45861da
C3 — VERIFY-PENDING — /agent stops pinning gpt-4.1-mini; readout + persisted turn use the resolved model; needs a live turn — 9234726
C4 — DONE — PATCH /contracts/:id merges metadata (null deletes); re-analysis keeps _-reports; extraction clears only its own stale keys — 9057681
C5 — VERIFY-PENDING — corrections write through to columns (+ES); reject clears; queue in nav + linked from contract; needs a visual check — 39a3f2a
C6 — DONE — renewal scan alerts on the auto-renewal notice deadline (server-derived); /renewals and the page use the same function — d415565
C7 — DONE — indexContract fills clauseFlags from the version on every path; flags POST re-indexes; facets + filters verified on real ES — 88e8d17
C8 — VERIFY-PENDING — redline.py sends x-org-id + fetches /playbook/positions; empty successes become FAILED with a reason the panel shows; needs a live LLM run — 31816bb
C9 — DONE — redline_apply uses least|moderate|aggressive (synonyms normalised); each variant applies; vocabulary tripwire — 2dc343b
C10 — VERIFY-PENDING — binder re-split replaces children (or refuses with a reason); non-PDF binders refused / not auto-split; needs a live DOCX-binder detection run — 4b6063e
C11 — DONE — retrieval reads each contract's effective (current, else latest extracted) version; diligence docs out of ordinary search + agent answers, room/by-id access kept — b3f1535
C12 — VERIFY-PENDING — drafting plans from the user's stated terms (no hard-coded defaults, untyped templates reachable) and creates only on the confirm card (undoable); needs a live chat run — 56d5710
C13 — DONE — lost parse jobs (unparsed upload, PENDING >30 min, no queued job) surface as FAILED with a retry path; backlogs and PENDING-by-default contracts untouched — 5bd2482
V1 — VERIFY-PENDING — playbook review rendered on the contract rail in document order, findings link to clauses, explained empty states; needs a visual check — b4d4da1
V2 — VERIFY-PENDING — list tools carry coverage (N of M / sample); contract_search date+value filters; renewals upcoming-first with true counts; rule A13; needs the live probe — 9dc95ed
H1 — DONE — marketing claims made true or marked planned; broken email capture removed; contact submissions now notify a configured inbox — 576474c
H2 — DONE — the 7 never-fired webhook events now emit at their real triggers; contract.expired (no trigger exists) removed from the list; advertised == emitted test — 109db9d
H3 — DONE — README/CHANGELOG/BUILD_TRACKER/evals README corrected to match the code (history kept, corrections noted); doc tripwire — fc0039f
X15 — DONE — portfolio_agent sends x-org-id; header tripwire extended — 16082b1
X7 — DONE — own scope enforced across REST: by-id guard on every contract/obligation/invoice/room/request route, lists + aggregates filtered, signature GETs gated; two adversarial passes — ba78c65
X19 — DONE — invoice contract links must be a live contract of the caller's org (owned, for own scope); auto-match scoped the same way; reconcile bounded; repair migration for pre-fix cross-org links — 6c01291
X8 — DONE — agent chat history keyed by (org, user, session) from the verified caller; probes updated; API-side identity pinned by a test — 42bbfe2
X18 — DONE — signer tokens only to callers who can send for signature (plus a signer's own row); tokens masked in logs — 46209e4
X5 — DONE — piiRedactionMode needs configure:organization, a valid value and an audit row committed with the change — c41eb70
X4 — DONE — organization.settings writers merge/remove/append only their own keys in SQL; no more lost updates — 7f2de2c
X11 — DONE — every Gotenberg render goes through one sanitiser (bounded parse, CSP, no loads/navigation); extracted text escaped; Gotenberg JS/network off in compose + deploy — 922352d
X6 — DONE — Slack requests resolve to the org whose secret verifies them, verified (bot-token) claims first; malformed rows and non-urlencoded bodies can't break or bypass it — 6079b64
X14 — DONE — inbound email reads every part, buffers only PDF/DOCX candidates, skips oversized ones instead of refusing the email — 4e7a90e
X9 — DONE — agent read tools (and REST /agent/compare) check the permission REST checks: playbook, clause, workflow, template, edit; 403 reasons reach the model — 6412597
X10 — DONE — agent write tools respect own scope on apply and undo (incl. created records); replies can't be filed under another contract's comment — f5964ec
X6 (follow-up) — DONE — pre-X6 Slack configs rank as unverified by age (not last); non-string team ids refused; backfill script for existing bot tokens — 69d23eb
X20 — DONE — upload parent must be a live, visible same-org contract (text field only); family view org-filtered, deleted parent hidden; repair migration — d00884c
X16 — VERIFY-PENDING — long binders sampled at likely agreement boundaries with absolute-offset markers instead of the first 10k chars; needs a live LLM run — 7b7a0ea
X12 — DONE — xmldom override narrowed to mammoth's range (^0.8.13 → 0.8.15); DOCX extraction works again; lockfile change flagged for review — 35a217f
X13 — DONE — DOCX/XLSX real inflated size bounded (100MB) at upload and before mammoth; zip bombs refused without expanding — bb55aaa
X25 — DONE — matter links (contract matterId, matter counterparty/owner) must be same-org; matter views org-filtered; repair migration — b661002
X24 — DONE — approval statuses (PENDING_APPROVAL/APPROVED/REJECTED) can't be set by hand via REST or the agent; one shared transition table — b4484a6
X26 — DONE — `_` contract metadata (analysis reports, _splitInto) writable only by the agents service — d6d6fb9
X22 — DONE — agent feedback scores only the caller's own Langfuse traces (named trace or session lookup); others answer trace_not_found like missing ones — ec82388
X21 — DONE — own-scope follow-ups: dashboard org approvals + team workload counts narrowed (hidden, not zeroed); signers without the contract get their signing link; converted requests owned by the requester; collab server checks view/edit like REST — 7732fb7 (+ 4d94d1f)
X23 — VERIFY-PENDING — the org's PII policy now covers background jobs, embeddings and redline proposals via contract-scoped round-trip tokens restored wherever output is stored; unresolved tokens refused on apply; tokenize keyed; 3 tools fail closed; needs a live upload + chat redline — f4f9d57
X25 (follow-up) — DONE — matters list hides foreign names; matter_list counts org/delete-filtered like REST; amendments inherit only a same-org matter; empty ids are validation errors; migration owner fallback needs a same-org creator — 072b262
X22 (follow-up) — DONE — a named trace resolves only within the caller's own session list (no fetch by id, no timing tell); userId must be a string — d13ba90
X21 (follow-up) — DONE — Sign link bound to one verified signer, only on their turn and before expiry; convert needs create:contract; `_` no longer a wildcard in signer email matching; web title/bars; X28, X29 filed — d1bb4b9
X3 — DONE — audit log API (list/filter/cursor + chain verify, admin-only) with an admin viewer; token-gated Prometheus /metrics with bounded labels; 5xx → Cloud Error Reporting on Cloud Run; docs say what's wired — 6345ee2
X17 — DONE — diligence-room contracts out of analytics/dashboard/renewals/obligations/counterparty figures (a named contract still sees its own); precedents on effective versions, no rooms; iterative HNSW scans on pgvector 0.8+ — c82ca73
X1 — VERIFY-PENDING — citation pills open the original PDF at the cited page with the passage outlined (styled-view section scroll kept as the fallback); needs a live click-through — f319ab4
X2 — VERIFY-PENDING — resumable per-field backfill (cursor on the definition, cost-cap pause, never overwrites) via a new /extract-fields agents route; custom-field confidence + quotes kept and shown; needs a live run — 0862183
X23 (follow-up) — VERIFY-PENDING — apply refuses any placeholder not in the source text ([REDACTED:*], mangled tokens); 64-bit tokens; restore also from the clause's version; token rule on all stored extraction passes; restore before PATCH validation; values only from the document; org-scoped tokenize pseudonyms — d4e4eac
X17 (follow-up) — DONE — reminders/overdue webhooks, invoice auto-match, team workload, org approval count and the extraction queue leave diligence rooms out; precedents subquery narrowed; clause search waits for the pool like a plain query — 431fe6f
X3 (follow-up) — DONE — verify batched + one per org + honest truncation; large audit metadata by reference; viewer paging fixed; tokens masked in error logs, invites and query strings; audit filters validated; /metrics off the Redis-backed limiter with instance labels; reporter can't throw; X30 filed — 1c6bdc1
X27 — VERIFY-PENDING — Q&A (and its reranker), the editor's AI (streaming restore across chunks), chat key terms, and the text the agents service reads for redline/approval summaries now follow the org's PII policy; X31 filed; needs a live redline/approval run — 0dea2dd
X30 — VERIFY-PENDING — req.ip through the trusted proxy hop (1 on Cloud Run, TRUST_PROXY_HOPS to override); needs a deployed check of the hop count — 11f6a7f
X28 — DONE — a later sequential signer can't view the contract or void the request before earlier signers have signed (same check as signing) — af5048a
X29 — DONE — collab connections refused after token expiry and re-checked each minute (user live, contract live, ownership, edit); a change closes the socket — f005316
X27 (follow-up) — VERIFY-PENDING — two adversarial reviews: agents' redline diff tokenized before diffing (whole tokens, HTML spacing/markup), GET /contracts/:id key terms + approval restore sources, playbook tester, cursor/window cuts, HTML labels, placeholder guards (502/422/stream error), card spaces at the detector, per-request scopes, chat lists; X32–X37 filed — 91901bf
X31 — DONE — the approval summary PATCH needs the internal secret in every environment (unset secret refuses) and stays in the caller's x-org-id org; X38 filed, X35 widened — 8638d24
X32 — DONE — version diffs (review UI, agents' redline diff, DOCX export) run on a worker thread with a 30 s limit and two at a time; past it a 422 says why and nothing is cached; the web shows the reason — 3c28689
X33 — VERIFY-PENDING — the approval summary's version text (approval.py reads it from /versions, which never had it) is now there for the agents service, tokenized with the contract scope and restored on store; needs a live approval run — 5ea086e
X34 — DONE — audit appends retry serialization failures with full jitter for up to 5 s instead of 5 lockstep attempts: a 16-writer burst lost 4–8 events, now none, chain verified — 3d8fe95
X35 — DONE — Bull Board, the chunk callback and inbound email need their secrets in every environment (unset refuses), with explicit dev opt-ins; SSRF guard on everywhere; review found /%61dmin/queues and /api/v1/%69nbound skipped the prefix hooks even in production — now scoped by plugin; X39 filed — 982c289
X36 — DONE — chat-tool excerpts (10 tools) are redacted against the whole text and never cut through a value (cutAndRedact: one scan, merged runs); the card detector finds a card followed by another digit group; X40 filed — 4a41d23
X37 — DONE — IBANs are recognized in groups of four as contracts print them, checked by their mod-97 checksum (so all-caps look-alikes stay), with the trailing-group fallback — d4805d3
X38 — DONE — production refuses to boot with placeholder, public (CI/test/dev) or short secrets, now including INTERNAL_SERVICE_SECRET; the Cloud Run agents service does the same; the self-host edge drops internal headers; X41 filed — c6ec141
X39 — DONE — webhook deliveries no longer follow redirects (redirect: 'manual'); a 3xx is a failed delivery that says why — 4802124
X40 — DONE — chat excerpts, summaries, key terms and obligations find values against their whole contract (card/IBAN/passport/DOB), once per document, never inside a longer number — 85bf0d9
X41 — DONE — the seed no longer gives production users password123: SEED_ADMIN_PASSWORD (12+, refused if password123) or a random one printed once; the self-host guide and deploy workflow say so; production's admin needs a manual check — d0f4d79
X28 (follow-up) — DONE — signing and declining honour expiry (not only viewing); sign, completion, decline and void change state only from PENDING, so racing requests can't complete twice or overwrite a void — 8d5419d
X29 (follow-up) — DONE — open collab connections are re-checked every 15 s even when silent, closing at token expiry or revoked access (latent: production runs with collab disabled) — 49bed5b
X24 (follow-up) — DONE — the CSV import refuses approval statuses; the agent's status undo applies only while the contract still has the status it set; late approval decisions no longer overwrite a contract that moved on; X42 filed — 67d9557
X26 (follow-up) — DONE — review.py writes only the org's own custom fields; _splitInto can't be changed through PATCH by anyone (an unchanged write-back passes); creating a contract refuses _ keys — 3ed62a3
X39 (follow-up) — DONE — SSRF errors no longer name the internal address; IPv6 literals are checked without their brackets — 54f2987
X42 — DONE — changing an approved contract's type, value, currency or document returns it to DRAFT for approval again (REST edits, uploads, editor saves, clause applies) — 10771af
X43 — DONE — deactivating a user revokes their API keys; key creation and revocation are audited; the key list shows who made each key — 8f76574
X44 — DONE — the 15 routes that checked only sign-in now refuse API keys: the org's shared data (member list, settings, roles, skills, dashboard, workload, models) without the admin scope, a person's own things (profile, notifications, threads) always; agent chat withholds the member search from them; adversarial review — e733768
X45 — DONE — a key's writes that need a user act as the key's maker while they can still manage API keys (contract creates on every path, matters, request conversion, org AI keys, skill telemetry); a key's split keeps the binder's owner; a key's obligation completions name no one; otherwise 422 NO_ACTING_USER before anything is stored; adversarial review — e5eb4e6
X11/X32 (test follow-up) — DONE — the Gotenberg SSRF cases no longer skip silently when the health probe is slow under load, and the event-loop diff case gets the diff's own time limit — 854a620
X46 — DONE — key management and giving anyone access (invite, roles, reactivate) are for signed-in users; a key authenticates only while the user behind it could still make it (active, configure:organization, through unrevoked unexpired links); deactivation revokes whole key trees; repair migration revokes keys orphaned before; adversarial review — c029ba8

X47 — DONE — opening a contract no longer saves a version: the editor's mount-time update isn't an edit, and an HTML save identical to the latest version makes nothing (so a view can't reset an approval since X42); the checks' three phantom versions removed — 6ea5bd8
X48 — DONE — concurrent requests that meet an expired access token share one refresh instead of racing the rotating refresh token into a logout — 39a6557
X49 — DONE — the Original (PDF) view works: the version list says which versions have a file, and the viewer's worker matches the installed pdf.js; X1 verified live on it (VERIFY-PENDING → DONE) — d2ab47a
C1, C5 (live checks) — DONE — both verified in the browser against the local stack (C1: create, reveal, list, audit, revoke; C5: nav, filter, bad-date refusal, write-through to the Contracts list); C5 follow-up: queue reviews are audited; V1's empty state checked, its findings still need a reviewed contract — 96c41de
X47 (follow-up) — DONE — in-place document edits are audited (with the approval reset they cause), no-op saves aren't — 34a1e79
X47 (review) — DONE — adversarial review: a view-mode command's edit is saved again (guard on docChanged), no-op judged against the current version, no phantom status in the edit audit — 5730eed
X48 (review) — DONE — the shared refresh times out and doesn't overwrite a session that changed while it ran — 3d58292
X49 (review) — DONE — self-hosted nginx serves the PDF worker (.mjs) as JavaScript; the Original view is for PDFs only — 036b278
X42 (follow-up) — DONE — Extraction Queue corrections and rejects of value or currency reset an approval as PATCH does, on the record — 4d2638c
X50 — DONE — a tab takes the same user's newer tokens another tab stored (before refreshing, and after losing a simultaneous refresh) instead of signing out; the server rotates a refresh token atomically — 3307df0
C8, X15 (live check + follow-up) — DONE — the redline and portfolio prompts' JSON examples broke `str.format()`, so neither agent ever reached a model; braces escaped, prompt tripwire added; C8 verified live (per-change advice on a two-version SOW), VERIFY-PENDING → DONE — 2a5a18d
X51 — DONE — the contract rail's History section links to Negotiate when there are two versions, so a contract without extracted clauses can reach its redline analysis — eb2e202
X16 (live check + follow-up) — DONE — detection finds a late second agreement live, but the split used the model's page guesses and cut a 13-page binder at page 7; pages now come from each agreement's character offset; verified live (MSA 1–12, SOW 13), VERIFY-PENDING → DONE — 415dbab
X49 (follow-up) — DONE — a Word or text upload's Original view says its original isn't a PDF, not that the contract was created from text — 9014c45
V2 (live check + follow-up) — DONE — a set question's answer states it's partial (7 of 104) and the tool carries the coverage block; the search-results table no longer repeats a contract per clause hit or counts hits as contracts, VERIFY-PENDING → DONE — 0ac8f89
X52 — DONE — a card number, IBAN or SSN wrapped across a PDF line is redacted; single-line detection unchanged, cross-line only for value-shaped groups near a card or bank word; adversarial review — b34d749
X53 — DONE — the chat's redline tool takes the section the user names, and a miss lists the contract's clauses (openings redacted) to retry with; adversarial review — 0060bae
X50 (reviews) — DONE — two more adversarial reviews: tabs take only the same user's later tokens, never resend a request as another user, and sign out only on a refused refresh; storage keeps the newer session; tokens carry a session id; same-second refreshes both succeed; sign-out ends the session after an idle pause — 0bdad37
C3, C10, C12, V1, X2, X23, X27, X33 (live checks) — DONE — verified with the agents service and Gemini on the local stack; the PII round trip through a counting proxy (models saw tokens only); VERIFY-PENDING → DONE — this commit
X54 — BLOCKED — chat usage is recorded from the message and reply only, so the daily cost cap barely counts chat; the fix changes what the cap counts, a product decision — this commit
X55 — DONE — the per-contract Q&A sends the agents service's secret (it answered "Agent unavailable" every time); the test mock now refuses calls without it — (sha: pending)
X56 — DONE — retyping an approved contract (the page's type chip, the agent's retype) returns it to DRAFT like X42's other paths; type changes are audited — (sha: pending)
X57 — DONE — a failed redline job records its own failure and reason (the panel stopped spinning) and follow-on jobs no longer mark the contract's analysis FAILED — (sha: pending)

---

## Closing summary (2026-09-23)

Every task in the main list and in Stretch has a terminal status. None turned out NOT-REPRODUCIBLE as a whole; one sub-claim of X27 did (`playbook_judge` already receives a redacted excerpt).

- **Main list (21):** 20 DONE, 1 VERIFY-PENDING (S2).
- **Stretch (54):** 52 DONE, 1 VERIFY-PENDING (X30), and 1 BLOCKED on your decision (X54, chat usage and the daily cost cap).
- **Two rounds of live checks came after this summary was first written:**
  - **First, in the browser.** They passed C1, C5 and X1 and found X47–X49.
  - **Second, with the agents service and a model, with your OK.** They passed C3, C8, C10, C12, V1, V2, X2, X16, X23, X27 and X33. They also found and fixed the C8/X15 prompts, X51–X53, and follow-ups to X16, V2 and X49. Two more reviews of X50 led to further fixes. See below.

The work is on branch `fix/audit-2026-09-22`: 107 commits from this run (from `cca7b19`), one per task or per review follow-up, plus this summary.
- **Note:** the branch was cut from `feat/langfuse-integration`, so it also carries that branch's 18 commits (28 Aug to 1 Sep) that aren't on `main`. A PR from this branch to `main` would include them.
  - The fixes can't simply be rebased onto `main`: X22 (`ec82388`, `d13ba90`) fixes a defect in `lib/langfuse.ts`'s feedback scoring, which exists only on that branch, and H3 corrected its docs.
  - Merge `feat/langfuse-integration` first, or together with this branch.
- Nothing is pushed, no PR is open, nothing is merged.

**Final verification on the branch** (run on `0bdad37`, the code this summary describes; the summary commit changes only this file):
- `db:generate` succeeds, and the test database is up to date with all 40 migrations. This round added none.
- Typecheck: 0 errors.
- Lint: 0 errors (warnings unchanged from the baseline: web 22, api 11).
- api unit: 340/340 (48 files). web unit: 48/48 (8 files).
- api integration: 340/340 (53 files, Docker stack up), none skipped.
- The tracker cites 119 distinct test files. Every one exists and ran in those suites, so the acceptance criteria they encode still hold.
- No audit event was lost (X34). Prisma logged 86 serialization conflicts during the integration run; each was retried to success and none surfaced as an error.
- **Adversarial subagent reviews:**
  - They ran on S1, S2, S3, C11, X3, X5–X11, X17–X23, X25, X27, X31, X35, X36, X38, X40 and X44–X46.
  - One combined review covered the first post-summary fixes (X47–X49, the C5 follow-up).
  - X50 had three rounds, the last combined with X52 and X53.
  - Their findings were fixed or filed.
- **The final sweep also re-reviewed C1, X15, X24, X26, X28, X29 and X39.** These touch auth, tenancy or SSRF and had no review on record; see below.

### Final sweep reviews

Three fresh subagents re-read those commits against the branch:
- **C1 and X24:**
  - C1's scope model holds. The review filed:
    - X43: admin keys outlive their creator, and keys aren't audited;
    - X44: sign-in-only routes ignore key scopes;
    - X45: keys can't create contracts.
  - X24's REST and agent checks hold. Three other ways set an approval status by hand (CSV import, the agent's undo, a late decision); fixed in `67d9557`. It also filed X42 (an approval isn't tied to what was approved), fixed in `10771af`.
- **X26, X15 and X39:**
  - X15 is clean.
  - X26: `review.py` copied model-chosen keys into `_` metadata, and `POST /contracts` accepted `_` keys. Fixed in `3ed62a3`.
  - X39: SSRF errors named internal addresses, and IPv6 literals kept their brackets. Fixed in `54f2987`.
- **X28 and X29:**
  - X28's turn gate holds, but signing and declining ignored expiry, and racing requests could complete a request twice or overwrite a void. Fixed in `8d5419d`.
  - X29's per-message checks hold, but a silent connection kept receiving edits after its token expired. Fixed in `49bed5b`.
- **What the filed items' own reviews found:**
  - X44's: the member directory was still reachable through agent chat.
  - X45's: a demoted key maker would own the key's contracts.
  - X46's: an admin key could invite a new admin, or restore its demoted maker's role, to outlive its own revocation.
  - All three are fixed. X45's review also led to X46's widening: keys whose maker had gone still worked.
- **Full-run test timing:** two test-timing problems, from tests written earlier in this run, showed up in the sweep's full runs and are fixed in `854a620`.

### After the summary: live checks in the browser

I started the web app (`localhost:5173`) against this checkout's API (:3001) and you signed in to the browser pane. What that showed:

- **Passed live:**
  - C1: the key dialog's scopes and expiry reach the stored key, the reveal is one-time, the list shows who made the key, and revoke works.
  - C5: the queue is in the sidebar, filters to one contract, and refuses a malformed date; a correction reaches the Contracts list.
  - X1: a citation link opens the PDF at its page, outlined.
  - X48: six requests met an expired token together and shared one refresh.
  - V1: only the empty state; no local contract has a playbook review.
- **Found and fixed:**
  - **X47 (High):** opening a contract saved a new version of it, and since X42 that would have sent an approved contract back to DRAFT because someone looked at it. The cause was TipTap 3's `setEditable` emitting an update, which the contract page autosaves. Now the web app doesn't report it, the API ignores a save that changes nothing, and real document edits are audited.
  - **X48 (Medium):** requests that met an expired token together each refreshed with the same one-time refresh token, and the losers logged the user out. Refreshes are now shared.
  - **X49 (Medium):** the Original (PDF) view had never worked. The version list didn't say which versions have a file, and the viewer's worker (pdf.js 3.11 from a CDN) didn't match the installed pdf.js 5.7. This is what blocked X1.
  - **C5 follow-up:** extraction-queue corrections changed contract terms with no audit event; they're audited now.
- **The combined review of those fixes** found more, all fixed except where noted:
  - **High, X49:** the self-host nginx served the new `.mjs` worker as `application/octet-stream`, so self-hosted installs would never render PDFs. Fixed in the nginx config.
  - **Medium, X47:** my first canvas guard also dropped real edits made from view mode by commands. The guard is now "the document changed".
  - **Medium, X49:** a DOCX or TXT latest version would have opened the PDF viewer. The Original view is now for PDFs only.
  - **Medium, X42 gap:** the Extraction Queue could change an approved contract's value or currency without resetting the approval. It resets now.
  - **Smaller:** X47's no-op check is judged against the current version and its audit records no phantom status change. X48's refresh has a timeout and a session check.
  - **Pre-existing, then:** multi-tab sign-out (X48). It was fixed afterwards as X50.
- **What I changed in your local environment:**
  - The dev database (`clm_dev`) lacked this branch's six migrations, and the running API already uses them (`/field-definitions` answered 500). I applied them after a full backup: `clm_dev-before-migrations.dump` in this session's scratchpad.
  - I removed the three phantom versions my browsing created before X47 was fixed, after a backup (`x47-phantom-versions-backup.json`). Both contracts point at their earlier current version again, and their statuses never changed.
  - A test key, "C1 visual check", was created and revoked; it stays in the list as Revoked.
  - The C5 test correction was put back in the database and the search index.
  - The web dev server started for the checks is still running.

### Second round: live checks with the agents service and a model

You approved running the checks that needed a model, on the only key configured (Google), with a $5 limit. I ran this branch's agents service on :8003 and pointed the dev API at it.

- **Passed live:** C3, C8, C10, C12, V1, V2, X2, X16, X23, X27 and X33, each recorded in its entry.
  - The PII checks ran through a logging proxy that counted tokens and raw values in every API → agents call: models received tokens only, and stored text came back with the real values.
- **Found and fixed:**
  - **C8 and X15:** the redline analysis and the portfolio query had never reached a model. Their prompts' JSON examples broke `str.format()`. Now a CI tripwire checks every formatted prompt.
  - **X51:** the Negotiate tab couldn't be opened on a contract with no extracted clauses.
  - **X52:** a card number or IBAN wrapped across a PDF line, or an SSN wrapped after a hyphen, escaped PII redaction.
  - **X53:** the chat couldn't redline "section 4": its tool took only clause ids or types, and a miss told the model nothing.
  - **X16 follow-up:** a long binder was detected but split at the wrong page. Pages now come from each agreement's text offset.
  - **V2 follow-up:** the chat's search-results table repeated a contract once per clause hit and counted hits as contracts.
  - **X49 follow-up:** a Word upload said it had been "created from text".
  - **X50, two more reviews:**
    - A tab no longer takes an older or foreign stored session.
    - A local sign-out keeps another tab's newer session.
    - The interceptor never retries a request as another user and doesn't refresh needlessly.
    - Tokens carry a session id, so a refresh can't be handed a later sign-in's tokens.
    - Same-second refreshes of one session both succeed again.
- **Filed, needs your decision:** X54, chat usage and the daily cost cap (below).
- **Not run:** S2 needs you signed in as a SALES_REP. X30 needs a deployed revision. The `l4-draft-gate` and `v2-coverage` scripts sign in with a password, so I ran V2's question in the browser instead.
- **Spend:** the usage table recorded $1.10 for the day, but it isn't reliable (X54): it undercounts chat and prices background jobs at a flat, conservative rate. My estimate of actual Google spend is $0.50–1.50.
- **What I changed in your local environment, this round:**
  - Restarted this checkout's agents service on :8003 (twice more, to load fixes) and the dev API on :3001 pointed at it, as you approved.
  - **Stopped the Aug 30 API on :3011** and its idle twin watcher, with your OK. They shared Redis and the dev database, took about half the background jobs, and sent them to the old agents service on :8002. The command to start it again is in this session's scratchpad (`spare-api-restore.md`).
  - Ran a logging proxy on :8004 for the PII checks, then stopped it and pointed the API back at :8003.
  - **Test data in the dev database:**
    - "Northwind … Data Engineering SOW": fake SSN and card number; two versions; pending approval in the standard workflow.
    - "Tailspin / Wide World — NDA + Distribution (DOCX binder check)".
    - Two "Contoso / Fabrikam" long binders with their split children. The first was split wrongly, before the fix.
    - "Initech — NDA": created and undone.
    - Two custom fields, "Governing law (X2 check)" and "Customer name (X2 check)", with their filled-in values.
    - Chat threads from the checks.
  - Delete any of these whenever you like.

### What landed (DONE)

- **Main list (20):** S1, S3, C1–C13, V1, V2, H1, H2, H3.
- **Stretch (52), by theme:**
  - **Found in the live checks:**
    - First round: X47 (a view no longer saves a version or resets an approval), X48 (no logout on concurrent refreshes), X49 (the Original PDF view works), and X1 (citations open the PDF at their page), verified live on X49.
    - X50: tabs share one session, after three review rounds.
    - Second round: X51 (Negotiate reachable without clauses), X52 (PII wrapped across a PDF line is redacted), X53 (the chat redlines a clause by its section number).
  - **Access, scope and tenancy:** X5, X7, X9, X10, X15, X17–X22, X24–X26, X28, X29, X31, X42.
  - **API keys:**
    - X43: revoked on deactivation, and audited;
    - X44: scopes honoured on sign-in-only routes;
    - X45: a key's writes act as its maker;
    - X46: keys can't make keys or grant access, and a key works only while its maker could still make it.
  - **Secrets and internal endpoints:** X6, X35, X38, X41.
    - X35's review found Bull Board's check and the inbound-email check skipped by `/%61dmin/queues/...` and `/api/v1/%69nbound/...` **in production too**. Now fixed.
  - **Untrusted content and uploads:** X11, X12, X13, X14, X39.
  - **PII to models:** X23, X27, X33, X36, X37, X40, X52. The round trip was verified live: models saw tokens only, and stored text reads with the real values.
  - **Agent features verified live:** X2 (custom-field backfill), X16 (a long binder is split where its agreements start).
  - **Reliability and data:** X3, X4, X8, X32 (version diffs off the request thread), X34 (audit events no longer lost in bursts).

### What's left

- **VERIFY-PENDING:**
  - **S2:** a chat turn as a SALES_REP only sees their own contracts through the agent's tools. The stack is ready (agents service and model running); it needs you signed in as a SALES_REP in the browser, since I don't sign in with passwords.
  - **X30:** on a deployed revision, the audit log's IP equals the client's (adjust `TRUST_PROXY_HOPS` if a load balancer adds a hop).
- **BLOCKED on your decision:** X54. Chat usage is recorded from the message and the reply only, so the daily cost cap and the usage panel barely see chat, and own-key chat counts as platform spend. Counting it properly makes chat count against the cap. The entry proposes the fix and a narrower first step that changes no gate.

### What to review first

1. **The PII round-trip and redaction design** (X23 → X27 → X36 → X37 → X40 → X52, all in `lib/pii-policy.ts` and `lib/pii-redactor.ts`). It is the largest and subtlest change, and it touches every path where contract text reaches a model. X52's cross-line patterns are the newest part. Check their shapes against your real contracts' card and IBAN formats.
2. **API key identity** (X43–X46, `middleware/auth.ts` and `lib/acting-user.ts`).
   - Every key request now checks the user behind the key: an active member who can still manage API keys. This switches off existing keys of people who have left or been demoted.
   - Key management and giving anyone access need a signed-in admin.
   - What a key creates is owned by its maker.
3. **Boot and secret checks** (X38) and **internal-endpoint checks** (X31, X35). Production now refuses to start on placeholder, public or short secrets, so check the deploy steps below before rolling out.
4. **Permission and scope changes** (X7, X9, X10, X21, X44, including the decision that a converted request is owned by its requester) and C11/X17's retrieval filters.
5. **X42's approval reset:** changing an approved contract's type, value, currency or document sends it back to DRAFT.
6. **The X11 HTML sanitizer and the Gotenberg flags**, and X12's `mammoth` lockfile override.
7. **X6's Slack `teamId` uniqueness** and its verification backfill.
8. **The six migrations** (below): all are repairs or additive columns.
9. **X47's no-op rule** (`sameDocumentHtml` in `routes/contracts.ts`): a save equal to the latest version, apart from line breaks between tags, creates nothing. Check that no real edit can look like that.
10. **Sessions across tabs** (X48, X50; `store/auth.ts`, `lib/api.ts`, `routes/auth.ts` refresh and sign-out).
    - Tabs share the newest tokens of the same user.
    - Storage keeps the newer session.
    - Tokens carry a session id from sign-in.
    - Only a refused refresh signs a tab out.
    - A refresh rotates atomically.
11. **X53's clause list** (`lib/clause-propose.ts`, `routes/internal-ai.ts` `redline_propose`): a miss sends the contract's clause openings to the model, cut and redacted.

### Deploy checklist

1. **Before deploying:**
   - Confirm production's `INTERNAL_SERVICE_SECRET`, `JWT_SECRET` and `PORTAL_JWT_SECRET` are random, 32+ characters, and none of the values public in the repo. Otherwise the new API and agents revisions refuse to start (X38); on Cloud Run the old revision keeps serving.
   - Change the internal secret on the API, worker and agents together.
   - **API keys** (X44–X46):
     - Keys whose maker has left, was deleted, can no longer manage API keys, or is another key, stop working on deploy. The migration revokes those of makers who left.
     - Check Admin → Integrations → API keys (the "Created by" column is empty for the affected ones) and re-issue any an integration still uses.
     - Integrations that read the member list, org settings, roles, skills, dashboard, team workload or model list need an `admin`-scope key. No key can use a person's own routes (profile, notifications, threads).
     - Creating keys, inviting users, changing roles and reactivating users need a signed-in admin.
2. **Deploy order:** the agents service before the API and worker, then the API and worker straight after.
   - The API and worker need the agents service's `/extract-fields` (X2), the PII token prompt rules (X23/X27) and `review.py`'s changes (C4, X2, X23, X26).
   - The agents service also brings the prompt fixes without which redline analysis and portfolio queries never run (C8, X15).
   - Until the API follows, a chat redline that names a section number gets a 400, because the old API doesn't know `sectionRef` (X53).
3. **Migrations** (run by `db:migrate:prod`):
   - `20260923000000_repair_stranded_escalations` (C2);
   - `…010000_unlink_cross_org_invoices` (X19);
   - `…020000_unlink_cross_org_parents` (X20);
   - `…030000_repair_cross_org_matter_links` (X25);
   - `…040000_custom_field_backfill` (X2);
   - `…050000_revoke_orphaned_api_keys` (X46).
   - X43's new audit actions (`API_KEY_CREATED`, `API_KEY_REVOKED`) need no migration: the column is a string.
4. **After deploying:**
   - `pnpm install` and restart API and workers (X12's lockfile).
   - Recreate Gotenberg with the new flags (X11). Production Gotenberg is still public on Cloud Run, a hardening `deploy.sh` already defers.
   - Run `apps/api/scripts/backfill-es-index.ts` (C7/C11).
   - Run `apps/api/scripts/backfill-slack-verification.ts --fix` (X6).
5. **Operational:**
   - Rotate every org's Slack signing secret and bot token (S1).
   - Revoke and re-issue scope-less API keys (C1).
   - Re-issue pending signer tokens (X18).
   - Sign in to production as `admin@demo.com` / `password123`; if that works, change the password (X41).
   - Clear `collab_states` before binding the editor to the shared document (X29).
   - Tell users that editing an approved contract's type, value, currency or document sends it back for approval (X42).
   - The PDF viewer's worker now ships in the app bundle instead of loading from unpkg (X49). If a Content-Security-Policy is added, allow workers from `'self'`. Self-hosted installs need the updated `deploy/selfhost/nginx.conf`, which serves `.mjs` as JavaScript.
   - Ask users to reload open tabs (X47). A tab still running the old bundle saves a phantom version whenever it opens a contract, and the API ignores only saves identical to the current version.
   - Sessions need nothing (X50). Tokens issued before the deploy keep working and gain a session id at their next refresh, so nobody is signed out. Reloaded tabs also get the new multi-tab behaviour.
6. **Configuration:**
   - `MARKETING_CONTACT_EMAIL` plus an email provider (H1).
   - Optional: `PII_TOKEN_SECRET`, the same on API and worker (X23); `METRICS_TOKEN` (X3).
   - Check `TRUST_PROXY_HOPS` (X30).
   - Inbound email needs `INBOUND_EMAIL_SECRET` in every environment (X35); without it the webhook answers 503, as production already did.
   - For local development: `BULL_BOARD_OPEN=true` and `WEBHOOK_ALLOW_PRIVATE_URLS=true` are the explicit opt-ins (X35), and the seed takes `SEED_ADMIN_PASSWORD` (X41).

### Known leftovers, not filed as tasks

- **Model-dependent PII risk:** the PII round trip depends on models copying tokens verbatim. Where one doesn't, the result is refused (502, a stream error, 409 on apply) or logged, never stored raw.
- **PII detection limits:**
  - excerpts that hold only part of a value;
  - card numbers stored as JSON numbers;
  - IBANs or cards that fail their checksum;
  - a typo'd value.
- **What an admin key configured outlives it** (X46): webhooks, Slack settings, share links. An admin key is full access by design; review them after revoking a leaked one.
- **A demoted maker's keys are refused, not revoked** (X46): re-promoting the maker brings them back, and the key list shows them as live.
- **No narrower scope than `admin` for reading the member list** (X44): add `users:read` if a customer needs it.
- **Dev conveniences keyed on `NODE_ENV`** (logger masking, printed signing links, the self-signed signing certificate, relaxed rate limits). They only affect stacks run outside the production image.
- **Pre-existing:** two type errors in `prisma/seed.ts`'s role-permission code; the seed runs through tsx and isn't in the project typecheck.
- **The Original PDF view has no selectable text** (X49): `@react-pdf-viewer` 3.12 predates pdf.js 4's text-layer API. Fixing it means replacing the viewer. Keep the pdf.js ≥4.2.67 override, the fix for CVE-2024-4367.
- **Sessions, left as is:**
  - Two different users signed in in one browser each keep their own tab's session, as before.
  - `iat` can't order two tokens from the same second, or from servers whose clocks differ (X50).
  - The sign-in page doesn't pick up a session another tab kept.
- **Chat, left as is:**
  - A card waiting for Apply isn't restored when its thread is reopened: the server doesn't keep the proposal's Apply arguments, so the user asks again (C12).
  - A chat redline's preview shows the PII tokens themselves; the applied text has the real values (X23).
  - The portfolio query's search is a keyword ranking and can return near matches: "Stark Industries" for "Ironbridge Industrial Group" (X15).
- **Small wording issues seen in the checks:** the Playbook review summary counts findings as deviations (V1). The contract header says "Edited just now" after an analysis writes its results.
- **Audit volume:** every `GET /contracts/:id` writes a `CONTRACT_VIEWED` event, so the page's polling during an analysis wrote 33 in 40 minutes for one contract. Worth a look before the audit log grows.
- **Audit writes follow their change outside its transaction**, as PATCH's already did. If the audit store fails, the change stands and the client gets a 500. X5 moved the org-settings audit inside its transaction; the others weren't.
- **Earlier phantom versions:** contracts opened before X47 carry "Edited in-place" versions that changed nothing. The local Unanalyzed Document has three from June and August. They're harmless duplicates and were left in place.
- **Deferred hardening:** encryption at rest for Slack secrets (S1), and private Gotenberg on Cloud Run (X11).
