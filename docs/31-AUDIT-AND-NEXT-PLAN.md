# 31 — Audit Findings → Next Build Plan (Phase 7)

> **Source:** `docs/audit-2026-04-25.md` (85 findings across 11 manual sweeps + 4 agentic findings) + the 6 deferred items from the post-Phase-6 gap audit (`docs/30 §0.5` deferred list).
> **Status:** ready to build. Awaiting sign-off.
> **Branch:** `feature/agent-first-clm` (continue).
> **Preceding state:** Phases P1–P6 shipped (commits `951116c` through `2a90e1e`). Cumulative coverage estimate ~95% on the docs/30 scoreboard. **But the audit revealed 9 P0 issues that block real customer use.**

## 1. The audit verdict in one paragraph

The product has **all the pieces** of a best-in-class CLM and the tool catalog is genuinely impressive — when probed via chat, the agent successfully completes 9 of 12 cross-persona JTBDs end-to-end. But **the screens hide the agent** (F-01: HeroAgent off by default), the **dashboard fails 2 of 5 personas** at JTBD orientation (F-77 + F-78), the **approval workflow gates the wrong person** (F-66), the **default LLM provider has no key** (F-82), and **multi-tenant login routes to the wrong org** (F-30). These are not "polish" issues — they're the difference between a demo and a product an enterprise can sign for.

## 2. Headline numbers from the audit

| | Count |
|---|---|
| Manual findings (Q.0 → Q.10, 11 sweeps × 28 routes × 5 personas) | 85 |
| Agentic findings (5 personas × ~3 prompts) | 4 |
| **P0 findings** | **10** (F-01, F-13, F-30, F-41, F-66, F-69, F-72, F-77, F-78, F-82) |
| **P1 findings** | 25 |
| **P2 findings** | 21 |
| **Positive findings (gold standards / wins)** | 23 |
| Routes covered | 23 of 23 protected + 5 of 5 public |
| Personas walked | 6 (admin + 5 role personas) |
| Contracts seeded | 15 across 10 types |
| Total contract value in fixture | ~$4.5M |

## 3. The new 7-phase plan

Sequenced for **make-the-product-ship-able**, not for engineering preference. Each phase has a customer-impact gate.

| Phase | Title | Days | Cumulative | Customer impact gate |
|---|---|---|---|---|
| **P7.0** | Critical correctness fixes | 1.5 | foundation | Must pass before anything else demos |
| **P7.1** | Make the agent the actual home | 2 | + dashboard JTBDs | Solves the user's #1 complaint + the 2 dashboard persona failures |
| **P7.2** | Workflow correctness (approval gating + admin oversight) | 2 | + approval JTBDs | Salesforce procurement gate: "do approvals work?" |
| **P7.3** | The premium agent home (Genspark-style `/agent` route) | 1.5 | + agent identity | Defining identity move; the Genspark-shaped surface the user asked for |
| **P7.4** | UX consistency + persona-aware empty states | 2 | + visual polish | Trust signal: every screen knows where the user is and what's next |
| **P7.5** | Production-readiness (security, billing, observability) | 3 | + enterprise gate | RBAC, PII, cost cap, Langfuse, eval harness — SOC2-able |
| **P7.6** | Lifecycle completeness (eSign, two-way portal, email-redline) | 4 | + closes the lifecycle | Removes "we're missing eSign" objection from every sales call |
| **P7.7** | Quality + RAG upgrades (voyage-law-2, Citations API, classifier rerun) | 2 | + AI quality | Measurable lift in retrieval precision; verifiable citations |

**Total: ~18 days** to a product an enterprise can sign for.

---

## 4. Phase-by-phase detail

### P7.0 — Critical correctness fixes (1.5 days)

| # | Item | Severity | Source | Days | Notes |
|---|---|---|---|---|---|
| 7.0.1 | **Fix multi-tenant login routing** | P0 | F-30 | 0.5 | Add unique constraint on `User.email` globally OR add org-picker step. Auth.ts line 99 needs orgId scoping. Pick one approach in design discussion. |
| 7.0.2 | **Fix agent provider auto-fallback** | P0 | F-82 | 0.25 | Python `active_provider()` already prefers configured key. Node `ChatMessageSchema.provider` should default to whatever the org actually has — query `OrgAiKey` or fall back to env-active provider. |
| 7.0.3 | **Default-enable HeroAgent flag for fresh orgs** | P0 | F-01 | 0.25 | Either flip the flag default in `useFeatureFlag` OR auto-set localStorage on first login OR remove the gate entirely. The "experimental" label has overstayed its welcome — it's been shipped 6 months. |
| 7.0.4 | **Friendly "agent unavailable" UI when stream is empty** | P1 | F-82 follow-up | 0.25 | Inline banner in HeroAgent + side rail when stream returns 0 tokens. "Agent isn't responding — check `/admin/org` → AI Config to set an LLM provider." |
| 7.0.5 | **Seed real RBAC permission rows for 8 roles** | P0 | F-72 | 0.25 | Per docs/06-SECURITY-GOVERNANCE. Either inline in `org-seed.ts` or a new `setup-rbac.ts` script. |

**Exit criteria:** Fresh login as any persona → lands on dashboard with a working HeroAgent → sends "What's in my queue?" → gets a streamed response with tool calls. Multi-tenant probe (two orgs with same email) shows correct isolation.

### P7.1 — Make the agent the actual home (2 days)

| # | Item | Severity | Source | Days | Notes |
|---|---|---|---|---|---|
| 7.1.1 | **Per-user "your day" surfaces — Negotiations + Renewals + Approvals** | P0 | F-77, F-78, F-79 | 1 | Dashboard's KPI cards count org-wide; we need *per-user* surfaces. New `/api/v1/dashboard/your-day` returns: `{negotiations: [{id, title, daysInUN, riskScore}], renewals: [{id, title, daysToExpiry}], approvals: [{...}], drafts: [...]}`. Render these prominently above the org-wide KPIs. |
| 7.1.2 | **Approver Mode decision strip on contract detail** | P0 | F-41 | 0.5 | When current user is the current approver on a contract, render the B.5.10 decision strip at top: AI Confidence · Risk · Recommendation · [Approve] [Reject] [Delegate] [Comment]. Already designed; needs wiring. |
| 7.1.3 | **HeroAgent chip generation extended to renewals + negotiations** | P1 | F-77, F-78 follow-up | 0.25 | Drive chips off the per-user-your-day endpoint. "1 contract you own is in negotiation: Zynga MSA". |
| 7.1.4 | **Side rail starter chips become dynamic per route** | P1 | F-17 | 0.25 | On `/contracts/:id` → "Summarise this Zynga MSA" / "Compare to playbook" / "Find similar past deals". On `/dashboard` → the queue-aware ones. Replace hardcoded "Acme Corp" generics. |

**Exit criteria:** Maya logs in → sees "Your day · 1 contract you own needs review (Zynga MSA, 5 risks, $2.4M)" + "1 approval awaiting your decision". Lisa logs in → sees "2 renewals in next 90d (Cloudwave $480K · 47d / Datadog $120K · 67d)". Marcus opens the Salesforce OF → sees decision strip with [Approve] [Reject] CTAs.

### P7.2 — Workflow correctness (2 days)

| # | Item | Severity | Source | Days | Notes |
|---|---|---|---|---|---|
| 7.2.1 | **Sequential approval gating — only the current step's approver sees the queue** | P0 | F-66, F-68 | 1 | API + sidebar count both filter by `step.stepOrder === instance.currentStepOrder`. Maya should NOT see the Salesforce approval until Marcus approves. |
| 7.2.2 | **Admin "All Approvals" tab + admin "All Matters" view** | P1 | F-11, F-52 | 0.5 | Admins need org-wide oversight. Add a third tab on /approvals + change /matters API to return all when role=ADMIN. |
| 7.2.3 | **Dashboard KPI counts ground in real queries** | P1 | F-02, F-03, F-04 | 0.5 | Pending Approvals, Expiring Soon — both reading 0 with real data. Reuse the per-user-your-day query. Drop the green "you're all caught up" banner OR have it actually compute the same thing. |

**Exit criteria:** Marcus sees Salesforce in his queue + admin sees it in "All Approvals" + Maya does NOT see it (yet). Dashboard "Pending Approvals" count = 1 for Marcus, 0 for Maya, 1 for admin. "Expiring Soon" = 2 for Lisa (renewals scoped to her), 2 org-wide for admin.

### P7.3 — Premium agent home (1.5 days)

The user's exact ask: "I am not sure if our agentic flow primary page is built — I was expecting Genspark-like primary agent."

| # | Item | Severity | Source | Days | Notes |
|---|---|---|---|---|---|
| 7.3.1 | **New `/agent` route — full-screen chat with conversation list left rail** | P1 | F-NEW | 1 | Design: chat fills the screen. Left sidebar shows past conversations + starter prompts. Right rail is collapsed. Toggle in top-right "← Back to dashboard" returns to /dashboard. Same threads as side rail (single source of truth). |
| 7.3.2 | **Sidebar nav adds "AI Assistant" item that goes to `/agent`** | P1 | F-NEW | 0.25 | Distinct from the AI Assistant button in the top-right bar. Accelerator: ⌘J. |
| 7.3.3 | **Persona starter prompts curated per role** | P2 | F-NEW | 0.25 | Maya lands on /agent → sees [Review Zynga MSA] [List my high-risk contracts] [What changed in our playbook this quarter?]. Lisa sees [What expires in 90 days?] [Decide on Cloudwave] [Show all renewal advice]. |

**Exit criteria:** User clicks "AI Assistant" in sidebar → lands on `/agent` → full-screen chat with persona-curated starter prompts. Conversation history persists across sessions. The dashboard remains untouched (per the docs/29 §3 Pattern B+E decision); `/agent` is a *complementary* surface.

### P7.4 — UX consistency + persona-aware empty states (2 days)

This is the bulk of the P1/P2 polish findings consolidated.

| # | Item | Source | Days |
|---|---|---|---|
| 7.4.1 | Status-aware OBLIGATIONS empty state (hide on UN, custom copy on EXECUTED, custom copy on Settlement type) | F-32, F-47 | 0.25 |
| 7.4.2 | Matter membership rail section on contract detail | F-42 | 0.25 |
| 7.4.3 | Contract title not truncated (collapse Compare/Back-to-Review into Actions menu) | F-38 | 0.25 |
| 7.4.4 | REVIEW PROGRESS counter expandable + bulk-mark-reviewed | F-39 | 0.5 |
| 7.4.5 | Counterparty profile detail page (`/counterparties/:id`) | F-49 | 0.5 |
| 7.4.6 | Counterparty list "Last activity" tied to real signals | F-50 | 0.1 |
| 7.4.7 | Profile email read-only + initials fix + breadcrumbs use names not IDs | F-12, F-16, F-31, F-54 | 0.25 |
| 7.4.8 | Accept-Invite token validation on mount | F-09 | 0.1 |
| 7.4.9 | Login logo + "Coming soon" badges on /analytics + /signatures sidebar items | F-06, F-14 | 0.1 |
| 7.4.10 | Recent Activity adaptive empty state | F-05 | 0.1 |
| 7.4.11 | Template card titles clickable, Most-used indicator | F-59, F-60 | 0.25 |
| 7.4.12 | Playbook hides "EXAMPLE" intro once positions exist + auto-select first category | F-63 | 0.25 |
| 7.4.13 | Test Mode promoted to primary CTA in playbook header | F-65 | 0.1 |
| 7.4.14 | Counterparty picker on New Request modal (not freetext) | F-56 | 0.1 |
| 7.4.15 | Compare button disabled when only 1 version | F-33 | 0.1 |
| 7.4.16 | Negotiation status banner tied to real share/portal state | F-31 | 0.25 |

### P7.5 — Production readiness (3 days)

| # | Item | Source | Days |
|---|---|---|---|
| 7.5.1 | PII redactor at ingest (SSN, passport, PHI) | docs/28 C.7.1 + docs/29 C.7.1 | 1 |
| 7.5.2 | Per-tenant cost cap (Redis daily counter + cap policy) | docs/28 C.0.5 | 0.5 |
| 7.5.3 | Langfuse tracing wired into the Python agent service | docs/28 C.0.4 | 0.5 |
| 7.5.4 | Audit log hash-chaining (tamper-evident append-only) | docs/29 C.7.2 | 0.5 |
| 7.5.5 | Production eval harness (regression suite for prompt + tool changes) | docs/30 cross-cutting | 0.5 |

### P7.6 — Lifecycle completeness (4 days)

| # | Item | Source | Days |
|---|---|---|---|
| 7.6.1 | Self-hosted eSignature (signature_requests + signing portal + X.509) | F-69, docs/25 A.4 | 2.5 |
| 7.6.2 | Two-way counterparty portal — POST /portal/:t/versions | docs/25 A.6 | 1 |
| 7.6.3 | Email-redline inbound parser (IMAP/SendGrid worker) | docs/25 A.7 | 0.5 |

### P7.7 — Quality + RAG upgrades (2 days)

| # | Item | Source | Days |
|---|---|---|---|
| 7.7.1 | voyage-law-2 embeddings + voyage-rerank-2.5 reranker | docs/28 C.3.1 / 3.2 | 1 |
| 7.7.2 | Native Anthropic Citations API + click-citation-to-PDF-highlight | docs/28 C.3.5/6 | 0.75 |
| 7.7.3 | Re-run classifier improvements (F-83 obligations_list bug, F-84 draft passivity) | F-83, F-84 | 0.25 |

---

## 5. The 23 positive findings — design references to preserve

These are the moments where the product is **best-in-class**. As we build P7.x, we should reuse these patterns rather than reinvent them.

| Finding | Surface | Use as reference for |
|---|---|---|
| F-10 | `/portal/:t` invalid-token error state | F-09 fix (Accept-Invite) |
| F-15 | Matters list grid | Counterparty list (F-49) |
| F-34 | KEY TERMS rail (structured data rendering) | Other structured rails |
| F-35 | Risks toggle (Off/Summary/Full) | Other 3-mode toggles |
| F-36 | Edit mode toolbar (save indicator + undo/redo) | All future editor extensions |
| F-37 | Dual-view Styled/Original PDF toggle | Pattern across the canvas |
| F-43 | Cloudwave obligations + renewal-advice rail | Every post-signature surface |
| F-44 | NDA defined-term guard with Apply-everywhere | The "agent makes it right in one click" pattern |
| F-45 | Inline pink risk decoration on auto-renewal | All inline AI markers |
| F-53 | Matter detail (5 contracts grid + tabs) | Workspace-level surfaces |
| F-58 | Templates grid | Library surfaces |
| F-61 | Clause Library 3-pane | Browse-then-preview UX |
| F-64 | Playbook 4-quadrant + Test Mode | Decision-support surfaces |
| F-67 | Approval card UX (eyebrow + meta + 3 verbs) | All workflow card surfaces |
| F-70 | Review Queue empty state | All "nothing here yet" copy |
| F-71 | User Management grid | Admin grids |
| F-75 | Team Workload (avatar + load bar) | Capacity surfaces |
| F-80 | HeroAgent context-aware chips (when triggered) | Persona-aware surfaces |
| F-85 | Agent CAN do most read JTBDs | Validates the entire D.x architecture |

## 6. Stop criteria for building P7

- Each P7.x has a verify script (`scripts/archive/p7N-verify.mjs`) that asserts the JTBD it claims to fix.
- All 10 P0 findings have a corresponding shipped fix.
- Manual re-walk of the 5 personas shows: every persona's primary JTBD is surfaced on dashboard within 2 seconds of login.
- Agentic re-walk: 12 of 12 prompts produce useful tool-backed responses (currently 9 of 12).
- `pnpm --filter web typecheck` clean.
- Zero new P0/P1 findings in re-audit.

## 7. What we are NOT doing in P7 (explicit)

- Phase 8 amendment-tracking (separate effort).
- CRDT real-time collaboration (Yjs — Phase 5.4 in original plan).
- Voice input on the agent.
- Mobile-native (`/m` web responsive is enough for now).
- Localization beyond en-US.
- Native iOS/Android apps.
- Custom-skill-builder UI for end users (admins only via API for now).

## 8. Decision: order of operations

If you want to ship a customer demo in **3 days**: P7.0 → P7.1 → P7.3. That gives a working agent on a working dashboard with a Genspark-style /agent home.

If you want to ship a **paid pilot** to one design partner in **8 days**: + P7.2 + P7.4. That makes workflow correct + every screen feels finished.

If you want to **sign an enterprise** (SOC2-required) in **18 days**: + P7.5 + P7.6 + P7.7. That removes every objection on the comparison-vs-Ironclad checklist.

---

## 9. Ready signal

`docs/audit-2026-04-25.md` is the source of truth for findings.
This file is the execution plan.
They are in sync.

**Next action after sign-off:** start P7.0.1 (multi-tenant login fix). 0.5d. Concrete diff to `apps/api/src/routes/auth.ts:99`.
