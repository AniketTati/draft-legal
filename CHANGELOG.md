# Changelog

All notable changes to draftLegal are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project uses semantic
versioning once it reaches 1.0. Until then, minor bumps (0.x) may include
breaking changes — each is called out below with its migration note.

**Release process:** tag a release commit `vX.Y.Z`, update this file, and set
the matching version in the workspace `package.json` files. Self-hosters read
the entry for their target version before upgrading (see
`docs/operations/SELF-HOSTING.md`); upgrades apply forward Prisma migrations
automatically and never reset data.

## [Unreleased] — Agent eval suite (Wave E), and four bugs it found

The eval suite (`docs/37`) could not run and several of its assertions could not
fail. Fixing both surfaced four defects in the product itself, three of which
only manifest in a real deployment — which is precisely why nothing had caught
them.

### Fixed
- **Agent chat failed on a fresh checkout.** The agents service binds port 8002,
  but `.env.example` and every caller in `apps/api` dialled 8000. Both services
  reported healthy and every agent turn returned 500 (ECONNREFUSED). If you
  copied `.env.example` before this release, set
  `AGENTS_URL=http://localhost:8002`.
- **Playbook clause comparison silently returned no AI result in production.**
  It read `AGENT_SERVICE_URL`, a variable set by no env file or deploy manifest,
  so it fell back to localhost; its own error handler then turned that into a
  success response with `comparison: null`.
- **Slack and Teams notification links pointed at `localhost:5173`.** They were
  built from `PUBLIC_APP_URL`, which is defined nowhere. Now `FRONTEND_URL`,
  which deployments already set.
- **Agent write-tool execution and every undo link were broken in production.**
  They resolved through `API_URL ?? AGENTS_API_URL ?? localhost:3001`; neither
  name is set on the API container, which listens on `PORT=8080`. Now derived
  from the service's own port, so no deploy config is required.
- **Organisation AI model settings were ignored for chat.** Every request
  carried a default `provider`/`modelId` pin the caller never sent, which
  outranked Admin → AI Config — so an org that selected a cheaper model still
  ran every turn on the expensive one. Unpinned requests now honour org
  settings; an explicit pin is still respected.
- **Some agent replies came back completely blank.** A model response that is
  empty but otherwise normal produced a successful stream with no answer, no
  tool activity and no error, so the assistant bubble rendered empty with
  nothing to explain it. These now surface a clear error the UI can show. Two
  related cases are fixed with it: a turn that ran a tool and then returned no
  text, and one where internal reasoning content was written into the
  conversation as if the assistant had said it.

### Changed
- The seeded demo organisation now includes signature requests across all four
  statuses, so the signatures page filters have data to filter.
- The persona corpus can be re-anchored to the current date with
  `SEED_TODAY=YYYY-MM-DD`; it stays deterministic at its pinned default.

## [Unreleased] — Counterparty loop, template upload, playbook review

Closes the external negotiation round-trip (it was roughly 70% built but severed
in three independent places), adds template creation from an uploaded document,
and gives a freshly received contract its first automatic playbook pass. A
review of the branch before merge found five further defects — four of them
introduced by this work — listed under Fixed/Security rather than folded in
quietly.

### Added
- **Counterparty round-trip works end to end.** Share links can now grant
  `upload`, so a counterparty downloads the DOCX, redlines it offline and
  uploads it back as a real version. The backend already honoured `upload`, but
  no UI could produce that permission — the loop was reachable only by
  hand-crafted API call.
- **Share links are emailed** (optional `recipientEmail` + note) instead of
  copy-pasted from a clipboard, and the invited address is recorded on the link.
- **Template creation from an uploaded `.docx`** — `POST /templates/upload`,
  split into sections along the document's heading outline, landing as an
  unpublished draft for review.
- **Automatic playbook review** of a received contract (`playbook-review` job →
  agents `/playbook-review`), scoring extracted clauses against the org's
  positions and reporting only deviations. Redline analysis diffs two versions,
  so it could never run on a document that has just arrived with one.
- **Alternative clause language in the review drawer**, with one-click **Apply
  to document** that splices the text and lands a new version. Both capabilities
  existed already but were reachable only when the chat agent chose to call them.
- **Inbound email is usable by a real provider** — multipart payloads and
  display-name addresses are accepted, and the per-contract reply address is
  surfaced as Reply-To on share emails.

### Fixed
- **Returned counterparty documents were never parsed.** Portal upload and
  inbound email were the only 2 of 11 version-creation paths that created an
  empty version and skipped the parse job; their comments promised an "analyze
  tick" that exists nowhere in the repo, so the document stayed blank and
  undiffable permanently.
- **The owner was never notified** when a revision arrived, although both
  endpoints told the counterparty "the owner has been notified".
- **Diff-cache poisoning.** Diffing against an unparsed version rendered the
  entire other version as one giant deletion and cached it; `VersionDiffCache`
  had no eviction anywhere, so that garbage was served forever — even after
  extraction later succeeded. Now refused with a 409 and evicted when parsing
  fills a version.
- **Signed-PDF sealing is retryable.** It ran as a fire-and-forget block with
  swallowed errors, so a transient S3/Gotenberg/cert failure left a contract
  `EXECUTED` with no sealed PDF and no recovery path.
- **Legacy `.doc` is rejected at upload** with guidance to save as `.docx`: it
  passed magic-byte sniffing but the extractor has no OLE reader, so it uploaded
  cleanly and then failed analysis opaquely.
- Template editor no longer breaks on a long pasted clause, and an amendment
  with no body renders an empty state instead of a blank white page.

### Security
- **Inbound-email sender and recipient spoofing.** Address parsing took the
  first `<…>`, but a display name may legally contain a full address, so
  `"Trusted <counterparty@victim.com>" <attacker@evil.com>` resolved to the
  victim and passed the sender allow-list while the message genuinely
  originated from — and passed SPF/DKIM for — the attacker's domain. The same
  trick on `To:` rerouted mail to an arbitrary contract id. Now strips quoted
  display-names, takes the last bracket pair, and prefers the provider's SMTP
  envelope. Regression tests in `apps/api/src/lib/email-address.test.ts`.
- **`INBOUND_EMAIL_ALLOW_ALL` is now ignored in production.** It disables sender
  validation entirely and was documented dev-only but enforced nowhere.
- **A counterparty could overwrite an EXECUTED contract** — portal upload had no
  status guard, and share links are not revoked on execution (they live up to
  30 days).
- **Read-only share links could act as an upload channel by email** — the
  invited-sender match now requires `upload`/`edit` on the link.
- **Cross-org clause text leak** through the apply fallback's unscoped clause
  lookup, which this work made reachable by ordinary authenticated users.
- **Cross-org cached diff read** — the diff-cache hit path returned before
  confirming both versions belonged to the requested contract.
- Share-link permissions are validated against a whitelist before being
  persisted and signed into the portal JWT; multipart buffering is bounded.

### Migration notes
- One new migration `20260720000000_share_link_invited_email` (adds a nullable
  `invitedEmail` column to `contract_share_links`; applied automatically).
- Optional new env vars: `INBOUND_EMAIL_DOMAIN` (turns on the "reply with your
  redline" invitation — leave unset while nothing is listening on that address),
  `INBOUND_EMAIL_SECRET`, and `INBOUND_EMAIL_ALLOW_ALL` (dev only, ignored in
  production).

### Operator action
- **Email still sends nothing until SMTP is configured.** `SMTP_HOST` is the
  gate for signature requests, approval notifications and the new share emails.
  Set `WEB_BASE_URL` too, or links point at `localhost:5173`. The code reads
  `SMTP_FROM` and falls back to `EMAIL_FROM`.
- Inbound email additionally needs a provider inbound-parse webhook pointed at
  `POST /api/v1/inbound/email`, MX records for `INBOUND_EMAIL_DOMAIN`, and
  `INBOUND_EMAIL_SECRET` on the service.
- **Not yet verified end-to-end against a live stack** — see the Known Gaps
  table in `BUILD_TRACKER.md`.

---

## [Unreleased] — "Make it real" (Waves 0–5)

The program that took the app from demo-shaped to runnable, secure, honest,
deployable, and regression-guarded. CI is green on GitHub Actions for the first
time, and now gates merges.

### Added
- **Real features:** per-change redline accept/reject, playbook comparison,
  inline approval, PAdES/X.509 e-signature (tamper-evident), durable Yjs collab
  persistence.
- **Parallel approvals:** N-of-M with short-circuit + deadlock-safe clamping.
- **BYOK:** per-org API keys are actually used at inference time.
- **Prompt-injection defenses** on untrusted contract text.
- **Ops:** migrations run in the deploy pipeline; dedicated always-on worker
  service; private Gotenberg with OIDC; Linux OCR (tesseract); pgvector HNSW
  ANN index; secure self-host stack (`docker-compose.selfhost.yml`) + runbook;
  web bundle-size CI gate.
- **Regression net (Wave 5):** integration suite that boots the real app against
  Postgres+Redis and exercises routes (cross-org isolation, RBAC per role,
  approval state machine); index-on-create source tripwire; real ESLint
  (installed + green). CI runs typecheck + lint + unit + integration on every PR.

### Fixed
- **Security (fail-closed):** JWT/portal secrets at boot, API-key scope→perm
  map, cross-org matter leak, spoofable rate-limit key, webhook SSRF, null-value
  auto-approve, RBAC gaps, upload magic-byte validation, XSS sinks.
- **Backend/engine:** BM25 full-text indexing (+ every create-path indexes to
  ES), intake description drop, invoice amount matching, chat cost recording,
  sequential e-sign next-signer notification, status/enum bugs.
- **Runs/builds:** CI pnpm-version conflict, 39 API type errors, keyless boot,
  missing `check-bundle-size.mjs`, missing `prisma generate` in CI.

### Migration notes
- New env vars for prod/self-host: `WORKERS_ENABLED` (set `false` on the API
  when a dedicated worker service runs), `GOTENBERG_REQUIRE_AUTH` (`true` in
  prod). Deploy now runs `prisma migrate deploy` before services start.
- One new migration `20260707180000_pgvector_hnsw_index` (adds an HNSW index;
  applied automatically).
- After restoring from backup, rebuild the ES index:
  `pnpm --filter api backfill-es-index`.

### Operator action
- Make CI a **required** status check on `main` (branch protection) so red PRs
  can't merge — the checks are green and ready to gate. See
  `docs/operations/SELF-HOSTING.md` §Release process / the PR description.
