# CLM Platform — End-to-End Build Tracker

> **Single source of truth** for all build progress. Update this file after every session.
> Last updated: 2026-07-20 (counterparty negotiation loop + template upload + playbook review; pre-merge review fixed 5 further defects — see Known Gaps for what is still outstanding)

---

## Project Overview

An agent-first Contract Lifecycle Management (CLM) platform. AI agents execute contract workflows (draft, review, negotiate, approve, sign, monitor). Humans stay in control via confidence gates, approval workflows, and full audit trails. Built for enterprise scale with multi-tenant architecture.

---

## Competitive Positioning

> As of March 2026. Market is moving fast — revisit quarterly.

### The Landscape

| Company | Valuation | What they are | What they're missing |
|---------|-----------|---------------|----------------------|
| **Harvey** | $8–11B | AI intelligence layer — analysis, research, drafting, due diligence. Elite law firms + 500 in-house. | No process automation: no approvals, routing, signatures, obligations, audit trails. Partnered with Ironclad to fill the gap. |
| **Legora** | $5.55B | Multi-agent "OS for legal work" — agentic workflows, review, research, Portal (law firm ↔ client collab). | Same gap: no CLM execution layer. No approvals, no e-signature, no obligation tracking. |
| **Ironclad** | ~$3B | CLM execution — workflow routing, approvals, signatures, audit trails. | Weak AI intelligence. Partnered WITH Harvey to get it. |
| **Ironclad + Harvey** | — | The combo: AI intelligence + CLM execution. | Partnership friction, two products, two bills. |
| **Summize** | — | Agentic CLM, multi-agent validation. Won Best SaaS Product 2025. | Smaller, less legal research depth. |

### Our Position: The Integrated Stack

**Harvey + Ironclad partnership is the market's proof that the right product is one integrated platform.** We build natively what they're patching together. This is our strategic wedge:

```
Harvey = intelligence, no execution
Ironclad = execution, no intelligence
Legora = agents + collaboration, no execution

Us = intelligence + execution + collaboration, natively integrated
```

### Feature Alignment Map

| Capability | Harvey | Legora | Ironclad | Us (Phase) |
|-----------|--------|--------|----------|------------|
| Contract review & risk scoring | ✅ (best-in-class) | ✅ | ✅ basic | ✅ Phase 02 (Review Agent) |
| AI drafting from templates | ✅ | ✅ | ✅ basic | ✅ Phase 04 (Draft Agent) |
| Due diligence / multi-doc analysis | ✅ (Vault, 10K docs) | ✅ | ❌ | Phase 09 (Diligence Rooms) |
| Legal research (case law, regulations) | ✅ deep | ✅ | ❌ | Phase 10 (LexisNexis MCP) |
| Contract Q&A / ask your contract | ✅ | ✅ | ❌ | Phase 2.1 (RAG chat) |
| Clause-level confidence + explainability | ✅ | ✅ | ❌ | Phase 2.1 (Extract→Validate pipeline) |
| Approval routing & workflows | ❌ | ❌ | ✅ | ✅ Phase 06 |
| E-signature | ❌ | ❌ | ✅ (DocuSign) | ✅ Phase 07 (internal) |
| Obligation tracking & alerts | ❌ | ❌ | ✅ basic | ✅ Phase 08 |
| Redline negotiation | ✅ | ✅ | ✅ | Phase 05 (Redline Agent) |
| Collaboration portal (firm ↔ client) | ❌ | ✅ (Portal, Nov 2025) | ❌ | Phase 05 (External Portal) |
| Post-signature analytics | ❌ | ❌ | ✅ basic | ✅ Phase 09 |
| Mid-market transparent pricing | ❌ (opaque) | ❌ (opaque) | ❌ (opaque) | ✅ Our advantage |
| Multi-provider LLM routing | ❌ (OpenAI-locked) | ❌ (Azure OpenAI) | ❌ | ✅ Built (providers.py) |
| Self-hosted / on-prem option | ❌ | ❌ | ❌ | ✅ (Docker Compose, Phase 10) |

### Key Competitive Insights from Research

1. **Harvey's weakness is our strength**: Harvey explicitly partnered with Ironclad because they couldn't do CLM execution. Our integrated stack is the product that partnership is trying to mimic.

2. **Legora Portal is the collaboration threat**: Legora's November 2025 Portal (law firm ↔ in-house workspace) is a smart move. Our Phase 05 external sharing portal + Phase 10 law firm integration must be positioned the same way. Don't underestimate this.

3. **Harvey is OpenAI-locked; we aren't**: Harvey runs exclusively on GPT-5 family. We support Anthropic + OpenAI + Google with OmniModel routing. This matters for enterprise procurement, cost optimization, and organizations with model preferences.

4. **Opaque pricing is a market gap**: Harvey and Legora both use consultative enterprise sales with no published pricing. The mid-market (SMB law firms, mid-size in-house teams) is structurally underserved. Transparent, consumption-based pricing is a wedge.

5. **"74% professional lawyer standard" is Harvey's Achilles heel**: Harvey's own accuracy is cited at ~74% — risk of fabricated citations. Our multi-step validation pipeline (Extract → Validate → Score) + per-field confidence display is a direct answer to this. Show your work; don't hide it.

6. **Contract Q&A (RAG) is table stakes**: Harvey and Legora both do "ask your contract" natively. We designed it (CHAT-002) but haven't built it yet. Phase 2.1 must include RAG-over-contracts.

7. **Diligence rooms (multi-doc analysis) is Phase 09 opportunity**: Harvey's Vault (10,000 docs) is a flagship feature for M&A/deal teams. We should design Phase 09 analytics to include diligence room capability — not just KPI dashboards.

### What to Watch
- Harvey reportedly raising at $11B (Feb 2026) — market believes in the intelligence-layer bet
- Legora tripled valuation in 5 months (to $5.55B, March 2026) — Portal + Walter AI acquisition signal aggressive consolidation
- Ironclad+Harvey partnership formalized Aug 2025 — CLM + AI combo is validated
- GPT-5 live in Harvey — frontier model competition will accelerate

---

## Stack Summary

| Layer | Tech |
|-------|------|
| **Frontend** | React 18 + TypeScript + Vite, Tailwind + Radix UI + shadcn/ui, TipTap editor, Yjs (collab), Zustand + React Query |
| **Backend** | Fastify + TypeScript, Prisma ORM, PostgreSQL 16 + pgvector, Redis 7 + BullMQ, Elasticsearch 8 |
| **Agents** | Python + FastAPI, LangGraph, Claude (Anthropic) primary / GPT fallback |
| **Infra** | Docker (local), Kubernetes/EKS (prod), Terraform, GitHub Actions CI/CD |
| **Storage** | AWS S3 / MinIO, ClickHouse (analytics), Gotenberg (doc conversion) |
| **Auth** | Auth0 or Clerk (OIDC, SAML, MFA), JWT 15min access / 7day refresh |
| **eSignature** | Internal signing module (pdf-lib + node-forge), self-hosted — no external vendor |
| **Integrations** | Salesforce, SAP/NetSuite, Slack, Teams, SendGrid — all optional, Phase 10 only |

---

## 10 Build Phases — Status Overview

| # | Phase | Status | Started | Completed |
|---|-------|--------|---------|-----------|
| 01 | Foundation | `[x] Done` | 2026-03-17 | 2026-03-17 |
| 02 | Repository & Search | `[x] Done` | 2026-03-17 | 2026-03-17 |
| 2.1 | Search Enrichment & Custom Fields | `[x] Done` | 2026-03-18 | 2026-03-18 |
| 2.2 | Queue-Based Document Pipeline | `[x] Done` | 2026-03-19 | 2026-03-19 |
| 3.1 | Contract Hierarchy + Attachments | `[x] Done` | 2026-03-19 | 2026-03-19 |
| 3.2 | Event-Driven Pipeline + LLM Binder Detection | `[x] Done` | 2026-03-19 | 2026-03-19 |
| 3.3 | Auto-Split Pipeline + Intake Document Upload | `[x] Done` | 2026-03-19 | 2026-03-19 |
| 3.4 | Type-Specific Extraction Schemas + Custom Field Display | `[x] Done` | 2026-03-19 | 2026-03-19 |
| 03 | Intake & Requests | `[x] Done` | 2026-03-19 | 2026-03-19 |
| 4.1 | Template & Clause Library (Backend + API) | `[x] Done` | 2026-03-21 | 2026-03-21 |
| 4.2 | Draft Agent + Chat Integration | `[x] Done` | 2026-03-21 | 2026-03-21 |
| 4.3 | Contract Editor + Template Builder UI | `[x] Done` | 2026-03-21 | 2026-03-21 |
| 4.4 | Playbook Editor + Advanced Features | `[x] Done` | 2026-03-21 | 2026-03-21 |
| 04 | Drafting & Templates | `[x] Done` | 2026-03-21 | 2026-03-21 |
| 05 | Negotiation | `[x] Done` | 2026-03-22 | 2026-03-22 |
| 06 | Approval Workflows | `[x] Done` | 2026-03-22 | 2026-03-22 |
| 6.5 | User Management (invites, RBAC, admin panel, workload, onboarding) | `[x] Done` | 2026-03-24 | 2026-03-24 |
| 07 | Execution & eSignature | `[x] Done` | 2026-04-22 | 2026-04-27 |
| 08 | Post-Signature | `[x] Done` | 2026-04-27 | 2026-04-28 |
| 09 | Analytics, Reporting & Diligence | `[x] Done` | 2026-04-28 | 2026-04-28 |
| 10 | Integrations & Scale (priority slice 1–5) | `[~] In progress` | 2026-04-28 | — |

---

## Phase Detail

### Phase 01 — Foundation
**Duration:** 2–3 weeks
**Status:** `[x] Done`
**Acceptance:** Login → dashboard renders → AI chat returns "hello"

#### Checklist
**Infrastructure**
- [x] Monorepo scaffold (`apps/web`, `apps/api`, `apps/agents`, `packages/types`)
- [x] Docker Compose: PostgreSQL, Redis, Elasticsearch, MinIO, Gotenberg
- [x] GitHub Actions CI: lint, typecheck, test on PR
- [x] Environment config (`.env.example`)

**Backend**
- [x] Fastify app shell with plugins (cors, helmet, rate-limit, pino logger)
- [x] Prisma schema: `organizations`, `users`, `roles`, `user_roles`, `audit_events`, `contracts`, `contract_requests`
- [x] JWT validation middleware (simple HS256, no external provider)
- [x] RBAC middleware (permission checks on routes)
- [x] Health check endpoint `/api/health`
- [x] Audit event helper (append-only writes to `audit_events`)
- [x] Redis connection + BullMQ worker scaffold
- [x] Redis Streams event bus scaffold (`publishEvent`)

**Frontend**
- [x] React + Vite + Tailwind + shadcn/ui scaffold
- [x] JWT auth: login form, register form, Zustand store, token refresh
- [x] App shell: sidebar nav, header, main content area
- [x] Protected route wrapper
- [x] React Query + Axios client setup (with auto-refresh interceptor)
- [x] Basic dashboard (KPI cards, empty state)
- [x] Chat panel component (streaming SSE, session memory)

**Agents**
- [x] FastAPI app scaffold (Python)
- [x] LangGraph orchestrator skeleton (classify → respond graph)
- [x] Claude API client (Anthropic SDK via langchain-anthropic)
- [x] `/agent/chat` streaming SSE endpoint
- [x] REST bridge to backend (Fastify proxies to Python)
- [x] Redis short-term memory (24h TTL per session, last 50 messages)

**Shared**
- [x] `packages/types`: contract status enums, shared TS interfaces (user, org, contract, request, approval, signature, obligation)
- [x] Zod schemas for API request validation (login, register, contract, request, search, chat)

**Seed**
- [x] `prisma/seed.ts`: demo org + admin user + legal counsel user

---

### Phase 02 — Repository & Search
**Duration:** 2–3 weeks
**Status:** `[x] Done`
**Acceptance:** Upload PDF → full-text search finds it → view contract detail with tabs

#### Checklist
**Backend**
- [x] Prisma: `counterparties`, `contract_versions`, `contract_embeddings` tables + migrations
- [x] S3/MinIO upload: `POST /api/v1/contracts/upload` (multipart, PDF/DOCX/TXT)
- [x] PDF text extraction (pdf-parse)
- [x] DOCX → HTML conversion (mammoth.js)
- [x] Elasticsearch index: contracts (full-text, with Postgres fallback)
- [x] pgvector schema: `contract_embeddings` table (embedding generation Phase 03+)
- [x] `GET /api/v1/contracts` (list, cursor pagination, filters, search)
- [x] `GET /api/v1/contracts/:id` (detail with versions + counterparty + owner)
- [x] `GET /api/v1/contracts/:id/download` (presigned S3 URL)
- [x] `GET /api/v1/contracts/:id/versions` (version list)
- [x] `POST /api/v1/contracts/:id/versions` (upload new version)
- [x] `GET /api/v1/contracts/:id/timeline` (audit events)
- [x] `POST /api/v1/search` (hybrid: Elasticsearch + Postgres fallback)
- [x] `POST /api/v1/search/portfolio-query` (NL query via agents)
- [x] `GET/POST/PATCH/DELETE /api/v1/counterparties`
- [x] Audit events: contract.uploaded, contract.viewed, version.created

**Frontend**
- [x] Contract list view (table, type/status filters, search bar, empty state)
- [x] File upload modal (react-dropzone, PDF/DOCX/TXT, metadata form)
- [x] Contract detail view — tabs: Overview, Document, Versions, Activity
- [x] PDF viewer (@react-pdf-viewer, pdfjs-dist v3)
- [x] AI summary + key terms display on Overview tab
- [x] Version history with download per version
- [x] Activity timeline

**Agents**
- [x] Review Agent: LangGraph graph, extracts summary / key terms / risk score / parties
- [x] `POST /review` endpoint: fire-and-forget, patches contract via internal API call
- [ ] Embed contracts on upload (pgvector — deferred to Phase 04, not blocking search)

---

---

### Phase 2.1 — Search Enrichment, Rich Metadata & Custom Fields
**Duration:** 1–1.5 weeks
**Status:** `[x] Done`
**Completed:** 2026-03-18
**Acceptance:** Query "all MSAs with auto-renewal expiring in 60 days, value > $100K" returns correct results · Admin defines a custom "Survival Period" field for NDA contracts · Portfolio query endpoint returns structured answer · Contract detail shows jurisdiction, parties, extracted payment terms

> **Why this phase exists:** Phase 02 built the ingestion pipeline and basic search. But for the platform to handle complex, filter-driven queries that legal teams actually use — and for admins to add org-specific fields without schema changes — we need richer extraction, better ES mappings, a custom field system, and a structured query builder. This is also where we lay the foundation for Phase 09 analytics.

---

#### Background: Search Strategy for Legal Documents

Three distinct query patterns, each needing a different approach:

| Query type | Example | How to handle |
|-----------|---------|---------------|
| **Structured** | "MSAs, value > $100K, expiry in 60 days" | Postgres WHERE + Elasticsearch bool query on typed fields |
| **Full-text keyword** | "indemnification unlimited liability" | Elasticsearch full-text on `plainText` |
| **Semantic / NL** | "contracts with unusual IP ownership clauses" | pgvector cosine similarity on contract embeddings |
| **Portfolio NL** | "how many vendor agreements auto-renew?" | LLM → structured query → Postgres/ES |

**Key insight:** complex structured queries must hit *properly typed* fields — not JSONB blobs. `autoRenew` needs to be a boolean in ES, `expiryDate` needs to be a date range index, `value` needs a numeric range. The Review Agent extracted these into `key_terms` JSONB but they need to be flattened into ES fields and optionally into dedicated DB columns.

**Custom fields strategy (Ironclad / Salesforce pattern):**
- `contract_field_definitions` table: org-scoped, per contract type, field_type (text/number/date/select/multi-select/boolean)
- Values stored in existing `contracts.metadata` JSONB (already in schema)
- ES dynamic mapping picks them up automatically under `metadata.*`
- Admin UI lets legal ops define e.g. "NDA contracts must capture Survival Period (number, years)"

---

#### Checklist

**Schema Migrations**
- [x] `contracts`: add `contract_number` (`CTR-2026-0001`), `parent_contract_id`, `jurisdiction`, `created_by`
- [x] `contract_requests`: add `request_number` (`REQ-2026-0001`), `source` enum (web_form/chat/email/crm_trigger/slack), `attachments` JSONB
- [x] `counterparties`: add `legal_name`, align `contacts` JSONB `[{ name, email, role, phone }]`
- [x] NEW `contract_field_definitions` table with `helpText` column
- [x] NEW `contract_clauses` table with `embedding vector(1536)`, `embeddedAt`, pgvector IVFFlat index
- [x] `contract_versions`: add `clauseFlags JSONB`
- [x] Migrations: `20260318125340_phase_2_1`, `20260318130000_add_clause_flags`, `20260318131000_add_field_def_helptext`

**Review Agent v2 — Multi-Step Pipeline (Summize pattern)**
> 3-step LangGraph pipeline replacing single-node Phase 02 agent.
- [x] **Step 1 — Extract Agent** (Haiku): segments clauseSegments + rawFields with verbatim quotes + clauseFlags
- [x] **Step 2 — Validate Agent** (Sonnet): cross-checks values, normalises types (str → int/bool/date), assigns per-field confidence 0–1
- [x] **Step 3 — Score Agent** (Sonnet): riskScore, contractType, summary, riskFactors, overallConfidence
- [x] 13 extracted fields: parties, effectiveDate, expiryDate, value, currency, governingLaw, noticePeriodDays, paymentTermsDays, autoRenew, exclusivity, liabilityCapAmount, ipOwnership, terminationRights, confidentiality
- [x] 8 clause flags: forceMajeure, mfn, changeOfControl, auditRights, assignmentRestriction, limitationOfLiability, indemnification, warrantyDisclaimer
- [x] `jurisdiction` promoted to dedicated DB column
- [x] `fieldConfidence` JSONB stores `{ confidence, quote, section, issue }` per field — shows evidence for every extraction

**Elasticsearch Mapping Enrichment**
- [x] Enriched index with `legal_english` custom analyzer (stemmer + stopwords)
- [x] Dynamic templates: `keyTerms.*` → keyword, `clauseFlags.*` → boolean, `metadata.*` → keyword
- [x] `jurisdiction` keyword, `keyTerms` + `clauseFlags` + `metadata` object fields with dynamic sub-mapping
- [x] `buildESQuery(orgId, filters)` helper: keyword multi-match + structured bool filters (type, status, jurisdiction, riskScore range, clauseFlags, date ranges)
- [x] `advancedSearch()`: keyword + hybrid RRF modes
- [x] `GET /api/v1/search/facets`: aggregations for type, status, jurisdiction, counterparty, risk ranges, expiring-soon date ranges, all 7 clause flags
- [x] `POST /api/v1/search/advanced`: mode=keyword|semantic|hybrid (RRF)

**Semantic Embeddings Pipeline**
- [x] `contract_clauses` table with `embedding vector(1536)`, IVFFlat index (`lists=100`, cosine)
- [x] `apps/api/src/lib/embeddings.ts`: `embedText()` → OpenAI text-embedding-3-large 1536 dims
- [x] `storeClauseSegments(versionId, segments)`: delete+recreate upsert pattern
- [x] `embedContractVersion(versionId)`: BullMQ job body — embeds un-embedded clauses via raw SQL UPDATE with pgvector literal
- [x] `searchClauses(query, orgId, limit, contractId?)`: cosine similarity raw SQL, org-scoped
- [x] BullMQ `embed-contract` job in `documentWorker` (concurrency=2, 3 retries, exponential backoff)
- [x] `POST /contracts/:id/versions/:versionId/clauses`: stores clause segments + flags, queues embed job
- [x] Hybrid RRF in `/search/advanced?mode=hybrid`: application-layer merge (K=60)

**Portfolio Query Agent**
- [x] `apps/agents/app/agents/portfolio_agent.py`: NL → structured ES filters via LLM → fetch contracts → synthesise answer
- [x] Intent classification: count | list | summarise | compare
- [x] `POST /agent/portfolio-query` route wired
- [x] Returns `{ answer, contracts, filters, count, intent }`

**Contract Q&A — RAG (table stakes vs Harvey/Legora)**
- [x] `POST /api/v1/contracts/:id/ask`: pgvector retrieval → Agent → grounded answer with citations
- [x] `POST /api/v1/search/ask`: portfolio-wide RAG (multi-contract)
- [x] `apps/agents/app/agents/ask_agent.py`: answer grounded in clause excerpts, [Clause N] citations
- [x] `POST /agent/ask` route: accepts question + pre-retrieved clauseMatches
- [x] Returns `{ answer, citations: [{ index, contractId, clauseId, clauseType, similarity }] }`
- [x] Fallback: returns raw clauseMatches if agent unavailable (still useful)

**Custom Fields API**
- [x] `GET /api/v1/field-definitions` — list (filterable by contractType, global fields included)
- [x] `POST /api/v1/field-definitions` — create (snake_case fieldKey validation, select requires options)
- [x] `PATCH /api/v1/field-definitions/:id` — update
- [x] `DELETE /api/v1/field-definitions/:id` — delete
- [x] `POST /api/v1/field-definitions/reorder` — bulk sortOrder update
- [x] `helpText` column for UI hints
- [x] Conflict detection on duplicate org+contractType+fieldKey (P2002)

**Frontend**
- [x] ContractsPage: facets sidebar (type, status, jurisdiction, risk band, expiring-soon, 7 clause flags), Filters button with active count badge
- [x] ContractsPage: risk score column, advanced search via `/search/advanced` when filters active
- [x] ContractDetailPage: "Ask AI" tab — chat UI with suggested questions, [Clause N] citations, streaming feel
- [x] ContractDetailPage: clause flags badges (amber) on Overview tab
- [x] ContractDetailPage: per-field confidence indicators (green/yellow/red dot), source quote tooltip on hover, issue warning
- [x] ContractDetailPage: risk badge on AI Summary card
- [x] ContractDetailPage: risk score column in contract list, jurisdiction display

---

#### Architecture Notes

```
Upload → extractDocument → [existing pipeline]
              ↓
         BullMQ: embed-contract job
              ↓
         LLM segments contract into clause types
              ↓
         voyage-law-2 / text-embedding-3-large
              ↓
         contract_clauses table (per-clause embeddings, pgvector)

Search flow — three distinct modes:

  Structured: "MSAs, value > $100K, expiring in 60 days"
    → Postgres WHERE + ES bool query on typed fields
    → No vector involved

  Keyword: "indemnification unlimited liability"
    → ES full-text on plainText (BM25)

  Semantic: "unusual IP ownership clauses"
    → pgvector cosine on contract_clauses.embedding
    → group by contract_id → rank by best clause match

  Hybrid (both q + filters):
    → ES BM25 + pgvector cosine → RRF merge → apply filters
    → Return { data[], facets{}, source, clause_snippets[] }

Faceted search (sidebar):
  GET /api/v1/search/facets
    → ES aggregations: terms(type), terms(status), terms(jurisdiction),
      range(value), date_histogram(expiryDate), terms(tags)
    → Post-filter aggregations so selecting one facet doesn't collapse others

Percolator queries (Phase 08 — alerting):
  ES Percolator: store standing queries ("auto-renewal in 60 days")
  → fire automatically on contract document update
  → emit BullMQ job → notification to contract owner
  (Deferred to Phase 08 Obligation Alerts — note here for planning)
```

**Custom fields data flow:**
```
Admin defines: NDA → "Survival Period" (number, years)
  → stored in contract_field_definitions

User creates/uploads NDA → fills Survival Period = 3
  → stored in contracts.metadata = { "survival_period": 3 }
  → ES indexes metadata.survival_period as float (dynamic mapping)

Search: "NDAs with survival_period > 2"
  → ES bool query: { must: [type=NDA], filter: [metadata.survival_period > 2] }
```

---

| 2026-03-18 | 2.1 | Phase 2.1 planned: schema gaps, Review Agent v2 richer extraction, ES mapping enrichment, embeddings pipeline, portfolio query agent, custom fields system, faceted search. | None |

---

### Phase 2.2 — Queue-Based Document Processing Pipeline
**Duration:** 1 week
**Status:** `[x] Done`
**Completed:** 2026-03-19
**Acceptance:** Upload a 40-page PDF → contract appears immediately with PENDING badge → progresses through ANALYZING → DONE. Custom fields defined in Settings appear in extraction output. Re-typing a contract triggers re-extraction with correct type context.

> **Why this phase exists:** Upload previously extracted text synchronously in the HTTP request (blocking), called agents with a direct `fetch()` (no retry), truncated text to 24K chars, and had no custom fields in prompts. This phase decouples upload from analysis via BullMQ queues, adds retry/backoff, removes char limits, and injects custom fields into LLM extraction.

---

#### Architecture

```
POST /upload
  ├─ S3 upload (sync — needed for contract row)
  ├─ prisma.contract.create (analysisStatus: PENDING)
  ├─ Reply 201 immediately
  └─ documentQueue: parse-document

parse.worker.ts [documentQueue, concurrency=3]
  parse-document: S3 download → extractDocument() (no char limit) → DB update → queueExtractAi()
  chunk-and-index: fetch clauses → legalChunkAndStore() → ES index → queueEmbedContract()
  embed-contract: pgvector embeddings

agent.worker.ts [agentQueue, concurrency=2]
  extract-ai: fetch plainText + custom fields from DB → POST /review to agents
```

#### Checklist

**Queue Infrastructure**
- [x] `apps/api/src/workers/parse.worker.ts` — NEW: parse-document, chunk-and-index, embed-contract handlers
- [x] `apps/api/src/workers/agent.worker.ts` — NEW: extract-ai handler (fetches custom fields from DB)
- [x] `apps/api/src/workers/index.ts` — barrel export, imported by API entrypoint
- [x] `apps/api/src/lib/queue.ts` — job types (ParseDocumentJob, ExtractAiJob, ChunkAndIndexJob), helpers (queueParseDocument, queueExtractAi, queueChunkAndIndex, queueEmbedContract)

**Legal Chunker**
- [x] `apps/api/src/lib/legal-chunker.ts` — NEW: `legalChunkAndStore()`: clause boundaries as primary chunks, sliding window for long clauses (>2K chars, maxLen=1800, overlap=360), `snapToSentence()`, ES `clauses` bulk index with denormalized contract metadata
- [x] DB migration `20260319010000_add_clause_chunking_metadata`: `isSubChunk`, `windowIndex`, `charStart`, `charEnd` on `contract_clauses`; index on `(versionId, isSubChunk)`

**API Changes**
- [x] `POST /upload`: removed sync extractDocument + direct fetch to agents; added queueParseDocument; status starts PENDING
- [x] `POST /:id/analyze`: replaced fetch() with queueExtractAi()
- [x] NEW `POST /:id/versions/:versionId/chunk`: internal-only, enqueues chunk-and-index, returns 202
- [x] NEW `POST /:id/retype`: updates contract.type + sets ANALYZING + queueExtractAi with corrected type

**Agents Service**
- [x] `apps/agents/app/routes/review.py`: extended ReviewRequest with contractType + customFields[]
- [x] `apps/agents/app/agents/review_agent.py`: chunked extraction (40K chars, 4K overlap), dynamic custom fields prompt injection, `_chunk_text()`, `_dedupe_segments()`, `_merge_raw_fields()`, open-ended findings extraction
- [x] After POST /clauses succeeds: POST to `/chunk` endpoint to trigger Service 3

**Frontend**
- [x] ContractDetailPage: inline type editing (pencil icon → select → POST /retype → ANALYZING banner reappears)

---

### Phase 3.1 — Contract Hierarchy + Attachments
**Duration:** 1 week
**Status:** `[x] Done`
**Completed:** 2026-03-19
**Acceptance:** Upload MSA → upload SOW linked to MSA → ContractDetail shows "Parent: [MSA title]". Attach an exhibit PDF → download works. Upload binder → amber banner appears → split modal → create N contracts each flowing through full pipeline.

> **Why this phase exists:** Real CLM usage is multi-document by default. A standard SaaS deal = MSA + SLA + DPA + SOW(s) + Order Form. Enterprise deals have 50-75+ related documents. Users' #1 complaint across all CLMs is "I can't see all documents for a client in one place." Amendment/exhibit handling is the top differentiator (G2, Gartner 2025). Binder PDFs (closing packs, M&A diligence) are common and need splitting.

---

#### Checklist

**Schema**
- [x] DB migration `20260319020000_add_contract_relationship_and_attachments`: `relationshipType TEXT` + `attachments JSONB DEFAULT '[]'` on contracts; index on `parentContractId`

**API Endpoints**
- [x] `POST /upload`: now accepts `parentContractId` + `relationshipType` form fields
- [x] NEW `GET /:id/family` — `{ parent, children, siblings }` via Prisma include
- [x] NEW `POST /:id/attach` — S3 upload, append to attachments JSON, no AI queue
- [x] NEW `DELETE /:id/attachments/:index` — remove by array index
- [x] NEW `GET /:id/attachments/:index/download` — presigned S3 URL

**Binder Detection + Splitting (heuristic, replaced by LLM in 3.2)**
- [x] `apps/api/src/lib/binder-detector.ts` — NEW: regex-based detection (AGREEMENT_HEADER_PATTERNS + SIGNATURE_PATTERNS), returns `{ isLikelyBinder, confidence, suggestedDocuments[], signatureBlockCount }`
- [x] `apps/api/src/lib/pdf-splitter.ts` — NEW: `splitPdf()` (pdf-lib page slicing) + `getPdfPageCount()`
- [x] parse.worker.ts: call detectBinder after extraction, store `_binderDetected + _suggestedSplits` in metadata
- [x] NEW `POST /:id/split` — synchronous split (moved to queued job in Phase 3.2)

**Frontend**
- [x] `UploadModal.tsx` — full rewrite: `parentContractId` + `relationshipType` per file, contract search combobox (debounced), "Link to existing contract" section
- [x] `ContractDetailPage.tsx` — Contract Family panel (parent badge, children grouped, "Add related" button), Attachments panel (list + download + delete + file picker), binder amber banner, split modal with editable page ranges + title/type

---

### Phase 3.2 — Proper Event-Driven Pipeline + LLM Binder Detection + Granular Status
**Duration:** 0.5 weeks
**Status:** `[x] Done`
**Completed:** 2026-03-19
**Acceptance:** Upload any PDF → PARSING → CLASSIFYING → EXTRACTING → INDEXING → DONE each shown in UI. Upload binder → BINDER_DETECTED amber banner → user clicks Review & Split → SPLITTING → N child contracts each flow independently through full pipeline. ContractsList shows blue AI spinner on any in-progress status.

> **Why this phase exists:** Single ANALYZING status gives users no feedback on what's happening. Binder detection via regex is inaccurate for real-world documents. Split was a synchronous API call that could time out. Classify was merged into extract (wasted tokens, no type context). This phase properly events every pipeline step.

---

#### New Pipeline

```
Upload → parse-document (PARSING)
  └─ agentQueue: detect-binder [LLM, Haiku, 10K chars]
       ├── isBinder (conf ≥ 0.7) → BINDER_DETECTED (amber banner, wait for user)
       │     └─ User confirms → POST /:id/split → documentQueue: split-binder
       │           └─ SPLITTING → N × parse-document (children flow independently)
       └── not binder → agentQueue: classify-document [LLM, Haiku, 5K chars]
             └─ CLASSIFYING → update contract.type → agentQueue: extract-ai
                   └─ EXTRACTING → agents /review → INDEXING → DONE
```

#### Status Values

| Status | UI shown |
|---|---|
| PENDING | "Queued…" (gray) |
| PARSING | "Extracting document text…" (blue spinner) |
| BINDER_DETECTED | Amber — "Multiple agreements detected — Review & Split →" |
| SPLITTING | "Splitting into separate contracts…" (blue spinner) |
| CLASSIFYING | "Identifying contract type…" (blue spinner) |
| EXTRACTING | "AI extracting key terms, clauses & risk score… (~30–60s)" (blue spinner) |
| INDEXING | "Building search index…" (blue spinner) |
| DONE | *(no banner)* |
| FAILED | Red — "Analysis failed — retry or check agents service" |

#### Checklist

**Python Agents**
- [x] `apps/agents/app/routes/detect_binder.py` — NEW: POST /detect-binder, Haiku, first 10K chars, returns `{ isBinder, confidence, documents: [{title, docType, charStart, pageHint}] }`, JSON-only response, fallback returns `isBinder=false`
- [x] `apps/agents/app/routes/classify.py` — NEW: POST /classify, Haiku, first 5K chars, returns `{ contractType, confidence, reason }`, validates against 11 known types, fallback returns OTHER
- [x] `apps/agents/main.py` — registers detect_binder.router + classify.router

**Queue**
- [x] `queue.ts`: DetectBinderJob, ClassifyDocumentJob, SplitBinderJob types + queueDetectBinder(), queueClassifyDocument(), queueSplitBinder() helpers

**Workers**
- [x] `parse.worker.ts` — parse-document: sets PARSING, queues detect-binder (removed heuristic inline call); NEW split-binder handler: sets SPLITTING, S3 download, pdf-lib slice, create N child Contract+Version records, queueParseDocument for each, set parent DONE
- [x] `agent.worker.ts` — detect-binder handler: stores _binderDetected metadata + sets BINDER_DETECTED OR queues classify-document; classify-document handler: updates contract.type, sets EXTRACTING, queues extract-ai; extract-ai: now sets EXTRACTING before calling agents; failed handler: catches all job types

**API**
- [x] `contracts.ts` — POST /:id/split now returns 202 + queueSplitBinder() (removed 80 lines of sync pdf-lib code)

**Frontend**
- [x] `ContractDetailPage.tsx` — IN_PROGRESS_STATUSES const, STATUS_BANNER map (per-status message/colour), polling on any in-progress status, Re-analyze button disabled during any in-progress status
- [x] `ContractsPage.tsx` — IN_PROGRESS_STATUSES const (includes ANALYZING for backward compat), polling + AI spinner badge on any in-progress status

---

### Phase 03 — Intake & Requests
**Duration:** 1 week
**Status:** `[x] Done`
**Completed:** 2026-03-19
**Acceptance:** Submit intake request → AI classifies type + extracts terms → legal ops assigns + accepts → contract created automatically. Counterparties page lists all known parties.

> **What was pre-built:** Prisma ContractRequest + Counterparty models, full CRUD API routes (requests.ts, counterparties.ts), CreateRequestSchema/UpdateRequestSchema, RequestStatus enum. Backend is complete; this phase is frontend + AI agent + 2 new API endpoints.

#### Checklist

**Backend (already done)**
- [x] Prisma: `contract_requests`, `counterparties` tables + migrations
- [x] `POST /api/v1/requests` — create with org-scoped audit event
- [x] `GET /api/v1/requests` — list with status filter + cursor pagination
- [x] `GET /api/v1/requests/:id` — detail
- [x] `PATCH /api/v1/requests/:id` — status transitions + assignment
- [x] `GET /api/v1/counterparties` — list with search
- [x] `POST /api/v1/counterparties` — create
- [x] `PATCH /api/v1/counterparties/:id` — update
- [x] `DELETE /api/v1/counterparties/:id` — soft delete
- [x] Audit events: request.created, request.status_changed, request.assigned

**Backend (new this session)**
- [x] `apps/agents/app/routes/intake.py` — POST /intake-classify (Haiku, 3K chars, returns contractType + priority + extractedTerms + confidence)
- [x] `apps/agents/main.py` — registers intake router
- [x] `apps/api/src/lib/queue.ts` — ClassifyRequestJob type + queueClassifyRequest()
- [x] `apps/api/src/workers/agent.worker.ts` — classify-request handler (fetches request → POST /intake-classify → updates metadata, sets type if confidence ≥ 0.75)
- [x] `apps/api/src/routes/requests.ts` — queueClassifyRequest after create + POST /:id/convert endpoint (request → Contract, ACCEPTED status)

**Frontend**
- [x] `apps/web/src/pages/RequestsPage.tsx` — full rewrite: table, status tabs (All/Submitted/Review/Accepted/Rejected), polling, New Request button
- [x] `apps/web/src/components/requests/NewRequestModal.tsx` — intake form (title, type, counterparty, description, value, priority, optional file attachment)
- [x] `apps/web/src/components/requests/RequestDetailPanel.tsx` — slide-over: AI classification card with confidence bar + extracted terms, assignee dropdown from /users, Accept/NeedMoreInfo/Reject action buttons, Accept → POST /convert → navigate to contract
- [x] `apps/web/src/pages/CounterpartiesPage.tsx` — list + debounced search + add/delete modal
- [x] `apps/web/src/App.tsx` — /counterparties route + sidebar nav

**Deferred**
- Email-to-request inbound (imapflow) → Phase 10
- Routing rules JSON config engine → post-launch
- Kanban view toggle → additive later

---

### Phase 3.3 — Auto-Split Pipeline + Intake Document Upload
**Duration:** 0.5 weeks
**Status:** `[x] Done`
**Completed:** 2026-03-19
**Acceptance:** Upload binder PDF → pipeline detects it → automatically splits into N child contracts without any user gate → blue "Split complete" banner shows in UI. Submit intake request with attached PDF → file uploaded to S3 → contract created and flows through full analysis pipeline when accepted.

> **Why this phase exists:** Phase 3.2 introduced BINDER_DETECTED as a pause state requiring the user to click "Review & Split". After building it, the better UX became clear: the LLM already knows where to split (it returns `pageHint` per document), so we should just split immediately. The user can always adjust splits after the fact. This eliminates friction for the happy path. Intake document upload was missing — users needed to be able to attach a draft contract to a request.

---

#### Pipeline Change: Auto-Split

```
Before (Phase 3.2):
  detect-binder → BINDER_DETECTED (wait for user) → user clicks → split-binder

After (Phase 3.3):
  detect-binder → SPLITTING → split-binder immediately
                 → _splitInto written to parent metadata
                 → blue banner in UI: "Split into N contracts"
```

#### Checklist

**Workers**
- [x] `apps/api/src/workers/parse.worker.ts` — parse-document: after `getPdfPageCount()`, stores `_totalPages` in contract metadata (needed by detect-binder to compute last doc's page range)
- [x] `apps/api/src/workers/parse.worker.ts` — handleSplitBinder: reads parent metadata, writes `_splitInto: childIds[]` when parent set to DONE
- [x] `apps/api/src/workers/agent.worker.ts` — handleDetectBinder: replaced BINDER_DETECTED pause with immediate `queueSplitBinder()`; added `docsToSplitSpecs()` helper converting LLM `pageHint` strings ("~page N") to concrete `{pageStart, pageEnd}` ranges; reads `_totalPages` from metadata for last-doc range

**Frontend**
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — blue auto-split banner when `_splitInto` present (N child links); amber legacy banner kept only when `_binderDetected && !autoSplitDone`; "Adjust splits →" link pre-populated from `_suggestedSplits`; "Correct type" visible text link (replaces pencil icon)
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — removed `BINDER_DETECTED` from `IN_PROGRESS_STATUSES` (no longer a pause state)
- [x] `apps/web/src/pages/ContractsPage.tsx` — removed `BINDER_DETECTED` from `IN_PROGRESS_STATUSES`

**Intake Document Upload**
- [x] `apps/api/src/routes/requests.ts` — `POST /` now handles multipart form (optional file field) OR JSON; S3 upload + `attachments` array stored on request
- [x] `apps/api/src/routes/requests.ts` — `POST /:id/convert`: creates `ContractVersion` + queues `parse-document` if `attachments.length > 0`
- [x] `apps/web/src/components/requests/NewRequestModal.tsx` — optional file attachment: Paperclip button → file picker → shows name/size/remove; submits as `FormData` with `body` JSON field + `file` when file present

---

### Phase 3.4 — Type-Specific Extraction Schemas + Custom Field Display
**Duration:** 0.5 weeks
**Status:** `[x] Done`
**Completed:** 2026-03-19
**Acceptance:** Upload an NDA → AI extracts NDA-specific fields (mutual flag, permitted use, non-compete duration, etc.) shown in "Contract-Specific Terms" section. Upload a SOW → sees deliverables, milestones, payment model. Custom fields defined in Settings appear in "Custom Fields" section. AI open-ended findings appear in collapsible "AI Findings" section.

> **Why this phase exists:** The extract pipeline had 14 generic fields for every contract type. An NDA needs completely different fields than an Employment Agreement or SLA. Power users and legal ops expect the platform to understand contract-type semantics. Additionally, custom fields defined in Settings were extracted and stored in `contract.metadata` but never surfaced in the UI.

---

#### TYPE_SCHEMAS (10 contract types × 9–16 fields each)

| Type | Fields (count) | Key unique fields |
|------|---------------|-------------------|
| NDA | 9 | mutual, permitted_use, carve_outs, residual_clause, non_compete, non_solicitation, return_of_information, injunctive_relief, standard_basis |
| MSA | 11 | sow_execution_process, change_order_process, warranty_period_days, dispute_resolution, acceptance_process, step_in_rights, key_personnel, benchmarking_rights, source_code_escrow, most_favored_nation, data_portability |
| SOW | 11 | deliverables, milestones, acceptance_criteria, payment_model, change_control, project_manager, work_location, travel_expenses, assumptions, out_of_scope, governing_msa |
| SLA | 11 | uptime_percentage, response_time_hours, resolution_time_hours, measurement_period, maintenance_exclusions, credit_formula, max_credit_percentage, reporting_frequency, escalation_procedure, remediation_plan_required, termination_for_sla_failure |
| EMPLOYMENT | 16 | job_title, base_salary, salary_currency, employment_type, at_will, probation_period_days, bonus_structure, equity_grant, vesting_schedule, non_compete_duration_months, severance_months, garden_leave, ip_assignment, remote_work_permitted, relocation_required |
| VENDOR_AGREEMENT | 13 | purchase_order_required, invoice_payment_days, late_payment_penalty, price_adjustment_mechanism, preferred_supplier_status, service_credits, acceptance_testing, audit_rights_frequency_years, subcontracting_restrictions, force_majeure_types, insurance_requirements, step_in_rights, continuous_improvement |
| PARTNERSHIP | 12 | revenue_share_percentage, profit_split, decision_making_process, deadlock_resolution, capital_contributions, partner_exit_mechanism, buyout_formula, non_compete_scope, ip_ownership_split, territory_exclusivity, brand_usage_rights, dissolution_triggers |
| LICENSE | 13 | license_scope, license_type, territory, sublicensing_permitted, royalty_rate, royalty_basis, minimum_guarantee, audit_rights, source_code_access, derivative_works_ownership, trademark_usage, version_coverage, escrow_required |
| DATA_PROCESSING | 13 | data_categories, processing_purposes, sub_processor_list, data_retention_period_days, breach_notification_hours, dpia_required, cross_border_transfer_mechanism, data_subject_rights_sla_days, deletion_on_termination, audit_rights_frequency_years, bcr_required, controller_processor_relationship, standard_contractual_clauses |
| ORDER_FORM | 11 | products_services, quantity, unit_price, total_order_value, discount_percentage, payment_schedule, delivery_date, delivery_location, acceptance_period_days, auto_renewal, governing_agreement |

#### Checklist

**Python Agents**
- [x] `apps/agents/app/agents/review_agent.py` — `TYPE_SCHEMAS` dict: 10 contract types × 9–16 fields each, each field has `key`, `label`, `type`, `hint`
- [x] `apps/agents/app/agents/review_agent.py` — `_build_custom_fields_prompt()`: injects "CONTRACT-TYPE-SPECIFIC FIELDS" section with `typeFields` JSON key alongside org custom fields
- [x] `apps/agents/app/agents/review_agent.py` — `_extract()`: merges `typeFields` from LLM response into `merged_type_fields` dict and includes in `custom_extracted`
- [x] `apps/agents/app/agents/review_agent.py` — `_VALID_TYPES` extended: added `DATA_PROCESSING` and `ORDER_FORM`

**API (review route)**
- [x] `apps/agents/app/routes/review.py` — imports `TYPE_SCHEMAS` from `review_agent`
- [x] `apps/agents/app/routes/review.py` — extracts `typeFields` from `custom_extracted`, builds `type_fields_out` with label lookup from `TYPE_SCHEMAS`
- [x] `apps/agents/app/routes/review.py` — stores as `metadata._typeFields = { fieldKey: { value, confidence, quote, label } }`

**Frontend**
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — `TypeField` interface `{ value, confidence, quote?, label }`
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — `FieldDef` + `AiFinding` interfaces
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — `typeFieldsMap` + `typeFieldEntries` derived vars from `contract.metadata._typeFields`
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — "Contract-Specific Terms" section: grid layout, `ConfidenceIcon`, quote tooltip on hover — rendered in Overview tab after Key Terms
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — `fieldDefsData` query from `GET /api/v1/field-definitions`; `relevantFieldDefs` filtered by `contractType === null || contractType === contract.type`; `populatedFields` filtered to fields with non-null values in metadata
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — "Custom Fields" section: reuses `DetailRow` + `formatTermValue()` — rendered after Contract-Specific Terms
- [x] `apps/web/src/pages/ContractDetailPage.tsx` — "AI Findings" section: collapsible (`showFindings` state), reuses `ConfidenceIcon`, shows `confidence`, quote on expand — rendered after Custom Fields

---

### Phase 04 — Drafting & Templates
**Duration:** Completed in 1 session (2026-03-21)
**Status:** `[x] Done`
**Acceptance:** Select template → draft generated → edit in TipTap editor → save version

#### Completed — Phase 4.1: Template & Clause Library (Backend + API)
- [x] Prisma: `templates`, `template_sections`, `clause_library_items`, `clause_categories`, `playbook_positions` — migrated
- [x] Template engine (`apps/api/src/lib/template-engine.ts`): variable interpolation (`{{key}}` tokens), conditional section logic, clause ref resolution, HTML assembly
- [x] `GET|POST /api/v1/templates` — list + create with sections
- [x] `GET|PATCH /api/v1/templates/:id` — get + update (bumps version)
- [x] `PUT /api/v1/templates/:id/sections` — replace all sections (transaction)
- [x] `DELETE /api/v1/templates/:id` — soft delete
- [x] `POST /api/v1/templates/:id/generate` — assemble contract HTML from variable values, increments usageCount
- [x] `POST /api/v1/templates/:id/preview` — preview with sample/auto-generated variable values
- [x] `GET /api/v1/clauses/categories` — full category tree (recursive build)
- [x] `POST|PATCH|DELETE /api/v1/clauses/categories/:id` — category CRUD (prevents deletion if items exist)
- [x] `GET|POST|PATCH|DELETE /api/v1/clauses` — clause library CRUD (with version history)
- [x] `POST /api/v1/clauses/:id/approve` — approve/unapprove clause
- [x] `GET|POST|PATCH|DELETE /api/v1/playbook/positions` — playbook position CRUD
- [x] `POST /api/v1/playbook/test` — test clause against playbook via agent service
- [x] Shared types: `packages/types/src/templates.ts` (Template, ClauseCategory, ClauseLibraryItem, PlaybookPosition, DraftResult, AssistResult, PlaybookTestResult)
- [x] Seed data: 3 templates (NDA, MSA, SOW), 3 clause categories, 7 clause items, 6 playbook positions

#### Completed — Phase 4.2: Draft Agent + Chat Integration
- [x] Draft Agent (`apps/agents/app/agents/draft_agent.py`): 5-step LangGraph pipeline
  - Step 1: Understand intent (Haiku) → contract_type, parties, key_terms
  - Step 2: Select template (Haiku) → fetch from Node API + LLM pick
  - Step 3: Fill variables (Sonnet) → populate from intent + context
  - Step 4: Assemble → call `POST /api/v1/templates/:id/generate`
  - Step 5: Review draft (Haiku) → completeness score, missing fields
- [x] Assist Agent (`apps/agents/app/agents/assist_agent.py`): single-step Sonnet for rewrite|simplify|expand|check_compliance|suggest_alternative
- [x] `POST /draft` Python route (with INTERNAL_SECRET auth)
- [x] `POST /assist` Python route (with compare endpoint)
- [x] `POST /compare` Python route: clause vs playbook positions (Haiku)
- [x] Node proxy: `POST /api/v1/agent/draft` → saves as ContractVersion if `saveAs` provided
- [x] Node proxy: `POST /api/v1/agent/assist` → inline text improvement
- [x] Node proxy: `POST /api/v1/agent/compare` → fetches playbook from DB, proxies to agent
- [x] Orchestrator updated: regex-based draft intent detection → routes to Draft Agent (CHAT-001)
- [x] Chat flow CHAT-001 complete: "Draft an NDA for Acme Corp" → full end-to-end

#### Completed — Phase 4.3: Contract Editor + Template Builder UI
- [x] `ContractEditor.tsx` (`apps/web/src/components/editor/ContractEditor.tsx`): TipTap v3 editor
  - Toolbar: H1/H2/H3, bold, italic, underline, strikethrough, text align, bullet/numbered lists, table insert
  - AI Assist strip: rewrite, simplify, expand, check compliance, suggest alternative (inline)
  - Clause library side panel: search + browse + insert at cursor
  - Find & Replace bar
  - Export: PDF + DOCX buttons
  - Word count indicator
  - Variable unfilled highlighting (amber) + clause ref styling
- [x] `TemplatesPage.tsx` (SCR-015): template grid, create/edit with section composer, variable definition panel, preview modal
- [x] `ClausesPage.tsx` (SCR-016): category tree + clause list + clause editor with version history
- [x] `TemplateSelectorModal.tsx` (SCR-004): recommended templates with type filter + usage count
- [x] Routes added: `/templates`, `/clauses`, `/playbook` in `App.tsx`
- [x] Sidebar: Templates, Clause Library, Playbook nav items added

#### Completed — Phase 4.4: Playbook Editor
- [x] `PlaybookPage.tsx` (SCR-036): clause category tree + position cards (preferred/acceptable/fallback/walkaway) + risk threshold slider
- [x] Test Mode: paste clause → agent scores against playbook → returns bestMatch + score + deviations
- [x] Position editor modal with content textarea + notes + risk threshold range input

#### Architecture Decisions (Phase 04)
- **Template engine in Node, not Python** — keeps HTML assembly close to DB, avoids cross-service latency for simple interpolation. Only complex LLM operations go to Python.
- **5-step Draft Agent vs 3-step Review Agent** — draft needs more steps (understand → select → fill → assemble → review) because it builds vs extracts.
- **TipTap v3** — installed with named exports (breaking change from v2 for Table/TextStyle). BubbleMenu removed in v3; AI assist exposed as toolbar strip instead.
- **Playbook positions by category** — mirrors how negotiators think (by clause type), not by contract type. Contract type is a filter, not the primary key.

---

### Phase 05 — Negotiation
**Duration:** 3 weeks
**Status:** `[x] Complete`
**Acceptance:** Upload counterparty redlines → view diff → AI counter-proposes → share external link

> **Competitive note:** Legora's Portal (Nov 2025, $5.55B valuation) is built around this exact flow — law firm ↔ in-house team collaboration on AI-assisted review. Our external portal + redline sharing IS our answer to Legora Portal. Build it with that ambition: counterparties and external counsel should be able to review, comment, and collaborate in the same workspace without needing a full account.

#### Checklist
**Backend**
- [x] Contract version diff computation (`node-htmldiff`)
- [x] `GET /api/v1/contracts/:id/versions/:v1/diff/:v2` (with VersionDiffCache)
- [x] `POST /api/v1/contracts/:id/redline` (trigger AI analysis, 202)
- [x] Prisma: `contract_comments` (threaded, clause-anchored)
- [x] Comment CRUD endpoints (`GET/POST/PATCH/DELETE /contracts/:id/comments`)
- [ ] Yjs + HocusPocus server (WebSocket collab) — deferred to Phase 5.4
- [x] External portal: time-limited JWT generation (24h–30d, `PORTAL_JWT_SECRET`)
- [x] `POST /api/v1/contracts/:id/share` (create external link)
- [x] Portal routes: `GET/POST /api/v1/portal/:token/contract` + `/comments`
- [x] Audit events: `COMMENT_ADDED`, `COMMENT_RESOLVED`, `LINK_SHARED`, `LINK_REVOKED`, `PORTAL_VIEWED`, `REDLINE_ANALYZED`

**Frontend**
- [x] `DiffViewer.tsx` — unified + side-by-side modes with ins/del CSS
- [x] `CommentsPanel.tsx` — threaded comments, resolve, delete, reply, portal mode
- [x] `ShareLinkDialog.tsx` — create/revoke links, copy URL, permissions
- [x] `RedlinePanel.tsx` — AI analysis results, counter-proposals, human gate banner
- [x] `ExternalPortalPage.tsx` — unauthenticated `/portal/:token` route
- [x] `ContractDetailPage.tsx` — Negotiate + Comments tabs, Share button
- [x] `App.tsx` — `/portal/:portalToken` route outside ProtectedRoute
- [ ] Real-time collab editor (Yjs integration in TipTap) — deferred to Phase 5.4

**Agents**
- [x] `redline_agent.py` — 3-step LangGraph: extract changes → score vs playbook → counter-proposals
- [x] `routes/redline.py` — FastAPI route + background task
- [x] `main.py` — registered redline router
- [x] `agent.worker.ts` — `handleRedlineAnalysis` + `RedlineAnalysisJob` queue type
- [x] Confidence gate: walkaway/outside_playbook → `requiresHumanGate = true`

**Phase 4.5 Gap Fixes (also completed this session)**
- [x] `NewContractFlow.tsx` — two-step modal wiring TemplateSelectorModal → Draft Agent
- [x] `ContractsPage.tsx` — "New Contract" button added
- [x] `ContractEditor.tsx` — Fix Find, AI Assist selection feedback, Section outline scroll, Document AI dropdown (Fix Layout + Rewrite Document)
- [x] Provider routing: all Python agents use `active_provider()` / `smart_model()` (OpenAI-first)

**Phase 4.5 Editor Polish & AI Prompt Overhaul (2026-03-22)**

*Root cause fix — Tailwind preflight CSS reset*
- [x] `apps/web/src/index.css` — Added `.ProseMirror h1/h2/h3` explicit size/weight/margin rules to counteract Tailwind preflight (`font-size: inherit` reset). This was the single root cause of headings rendering as body text AND Doc AI rewrites appearing as walls of text.
- [x] `apps/web/src/index.css` — Added `!important` text-align overrides for TipTap inline `style="text-align: X"` attributes (center/right/left/justify)

*Assist agent prompt overhaul (`apps/agents/app/agents/assist_agent.py`)*
- [x] Added `_HTML_ACTIONS = {"fix_layout", "rewrite_document"}` — branched document-level vs clause-level actions to separate system prompts
- [x] Added `_strip_markdown_fences()` — strips `\`\`\`html ... \`\`\`` fences LLMs sometimes emit; applied to all action responses
- [x] Rewrote `_SYSTEM_PROMPT` — specifies input is HTML, output must preserve inline tags (`<strong>`, `<em>`, `<u>`, `<s>`, `style=`), no block wrappers, concrete input/output example
- [x] Added `_DOCUMENT_SYSTEM_PROMPT` — explicit table preservation (`<table>/<tr>/<th>/<td>`), inline style preservation (never alter `style=`), semantic tag hierarchy (`<h1>`/`<h2>`/`<h3>`/`<p>`/`<ul>`)
- [x] Rewrote `check_compliance` prompt — improved clause is output first, compliance analysis goes in EXPLANATION (was previously dumping analysis text into document)
- [x] All 5 clause-level action prompts updated — "provided as HTML", "Preserve all inline HTML formatting tags"

*HTML formatting preservation (bold/italic survive AI rewrite)*
- [x] `ContractEditor.tsx` — replaced `editor.state.doc.textBetween()` with `DOMSerializer.fromSchema(editor.schema).serializeFragment()` — extracts selection as HTML preserving `<strong>`, `<em>`, etc. before sending to AI
- [x] `ContractEditor.tsx` — imported `DOMSerializer` from `@tiptap/pm/model`

*Stale selection bug fix*
- [x] `ContractEditor.tsx` — added `assistSelectionRef = useRef<{from,to}|null>` — captures `{from, to}` at AI call time (not apply time) to avoid stale closure on async response

*Before/after diff banner*
- [x] `ContractEditor.tsx` — added `assistOriginalText` state (plain text of original selection stored at call time)
- [x] `ContractEditor.tsx` — GitHub-style diff UI in AI suggestion banner: red `−` (original, strikethrough) / green `+` (revised) with `line-clamp-4/5` overflow

*Apply animation*
- [x] `ContractEditor.tsx` — `applyAssistResult` computes `insertedFrom/To` range, calls `setHighlight({ color: '#bbf7d0' })` + `scrollIntoView()` on inserted range, then clears highlight after 1800ms via `setTimeout`

*Error handling*
- [x] `ContractEditor.tsx` — added `assistError` state — shown as red error banner in AI strip on failed assist calls
- [x] `ContractEditor.tsx` — added `docAiDone` state — shows "unsaved changes" save reminder banner after Doc AI (fix_layout/rewrite_document) completes

*UX micro-fixes*
- [x] `ContractEditor.tsx` — 350ms debounce on clause library search (`debouncedQ` state + `useEffect` cleanup) to avoid per-keystroke API calls
- [x] `ContractEditor.tsx` — Section outline HTML entity decoding (`&amp;` → `&`, `&lt;` → `<`, etc.) so heading text renders correctly in outline panel

*Auto-seed on org registration*
- [x] `apps/api/src/lib/org-seed.ts` — new file: `seedOrgDefaults(orgId, orgSlug, adminId)` exports the base-data seeding logic (3 categories, 7 clauses, 6 playbook positions, 3 templates)
- [x] `apps/api/src/routes/auth.ts` — fires `seedOrgDefaults` as background task (non-blocking) after new org creation; seed failure never fails registration

---

### Phase 06 — Approval Workflows
**Duration:** 2.5 weeks
**Status:** `[x] Complete`
**Completed:** 2026-03-22
**Acceptance:** Build approval workflow → submit contract → approver gets notification → approves → status updates

#### Checklist
**Backend**
- [x] Prisma: `workflow_definitions`, `approval_instances`, `approval_steps`, `notifications` (JSON `steps[]` per definition — no separate node/edge tables)
- [x] Workflow engine: `workflow-engine.ts` — sequential + parallel execution modes, escalation, delegation, auto-approve rules, all state in Postgres
- [x] `POST /api/v1/contracts/:id/submit-approval` — validates status, checks auto-approve, creates instance + steps, queues notifications + escalation
- [x] `POST /api/v1/approvals/:instanceId/decide` (approve/reject/delegate) — calls `advanceWorkflow`, cancels escalation job
- [x] Escalation timer: BullMQ delayed job with deterministic `jobId: escalate-${stepId}` → cancelled on decision
- [x] Auto-approval rules (value threshold, contract type) — checked on submit
- [x] Audit events: approval.submitted, approval.approved, approval.escalated
- [x] Workflow CRUD: `GET/POST /workflows`, `PATCH/DELETE /workflows/:id`, set-default
- [x] Notification system: `Notification` DB table + `notificationQueue` worker + optional Nodemailer email
- [x] Internal callback: `PATCH /:instanceId/summary` (x-internal-secret, for agent to write AI analysis)

**Frontend**
- [x] Visual workflow builder — ordered step cards with up/down buttons (no @dnd-kit dependency), step name/approver/role/execution mode/escalation
- [x] Approval queue page — `ApprovalsPage.tsx` two tabs: My Queue + Manage Workflows
- [x] Approval detail card — `ApprovalCard.tsx`: AI summary, key risks with severity badges, non-standard terms, Approve/Reject/Delegate buttons
- [x] Delegation UI — user picker + optional comment in ApprovalCard
- [x] Workflow status timeline — `ApprovalTimeline.tsx` per step with status badges + comments
- [x] Submit for Approval button on ContractDetailPage — workflow-select dialog + `POST /contracts/:id/submit-approval`
- [x] Approval tab on ContractDetailPage — status banner, AI summary card, ApprovalCard (pending step), timeline
- [x] Notification bell in Header — `NotificationBell.tsx` with unread badge, dropdown, mark-all-read, 30s polling

**Agents**
- [x] Approval Agent: 3-step LangGraph pipeline — summarize (Haiku) → flag_risks (Sonnet) → recommend (Sonnet)
- [x] Approval Agent: flag non-standard terms + key risks with severity levels
- [x] Approval Agent: `approve | review_required | reject_advised` recommendation
- [x] `POST /approval-summary` FastAPI route → fire-and-forget BackgroundTask → PATCH result back to API

#### Architecture Decisions (Phase 06)
- **BullMQ + custom state machine (not Temporal)** — approval state lives in Postgres (SQL-queryable: "all contracts in Legal Review"). JSON `steps[]` is admin-configurable without code deploys. Temporal is overkill for CLM approval chains (≤10 steps, no distributed sagas).
- **JSON steps[] in WorkflowDefinition** — pragmatic for Phase 06. DAG tables (node/edge) can be layered in a future phase if conditional branching is needed.
- **Deterministic escalation jobId** — `escalate-${stepId}` allows clean `queue.remove()` on decision without tracking job IDs in DB separately.
- **Delegation = new step** — delegated step marked DELEGATED (terminal), new PENDING step created at same stepOrder. `advanceWorkflow` waits for the new step to resolve before advancing.

---

### Phase 07 — Execution & eSignature
**Duration:** 2 weeks (planned) — actually shipped over 5 sessions (P7.6.1 backend was first; UI + email + reminders + PDF binding closed in 2026-04-27)
**Status:** `[x] Done` (8 of 10 backend items, 6 of 7 frontend items, agents deferred to V1.5)
**Acceptance:** ✓ Send contract for signature → SignerPortal renders document → signer types name → contract auto-filed as EXECUTED with signed-PDF certificate appended.

> **Design principle (kept):** Fully self-hosted. `pdf-lib` for PDF certificate stamping. Lazy-loaded `nodemailer` for email when SMTP is set. `pdf-lib` X.509 / PAdES cryptographic signing deferred to V1.5 — current legal record is typed-name + IP + UA + timestamp anchored in audit_events. (See ADL 2026-03-17.)

#### Checklist
**Backend**
- [x] Prisma: `signature_requests`, `signers`, `signature_events` tables (P7.6.1 migration)
- [x] Per-signer signing token (32-byte hex, unique constraint, embedded in email link)
- [x] `POST /contracts/:id/send-for-signature` (creates SR + Signers + tokens + PENDING_SIGNATURE flip + audit event + email per signer)
- [x] `GET /contracts/:id/signature-requests` (per-contract admin view) **+ NEW** `GET /signature-requests` (org-wide list for /signatures admin page)
- [x] `GET /sign/:token` (public — returns contract + signer + record VIEWED event)
- [x] `POST /sign/:token/sign` (captures typed name + IP + UA + timestamp, sequential gating, auto-completes SR + flips contract → EXECUTED)
- [x] `POST /sign/:token/decline` (auto-voids SR + audit)
- [x] `POST /contracts/:id/signature-requests/:srId/void` (sender-initiated void)
- [x] **NEW** `POST /contracts/:id/signature-requests/:srId/remind` (manual sender nudge)
- [x] **PDF binding** (`apps/api/src/lib/pdf-signing.ts`): on COMPLETED, append signature certificate page (emerald header + per-signer card with name/role/email/typed-signature/timestamp/IP), store as new ContractVersion → currentVersionId. Falls back to Gotenberg HTML→PDF if no source PDF exists.
- [x] **Reminder scheduler** (BullMQ delayed jobs): T-3d "first" + T-1d "final" reminders scheduled at send time + manual reminders fire immediately. Worker rechecks SR/Signer status before sending; SEQUENTIAL flows only nudge the lowest signOrder bucket.
- [x] **Email helper** (`apps/api/src/lib/signing-email.ts`): always console-logs the link (dev-friendly), sends real email if `SMTP_HOST` is set (lazy-loaded nodemailer, async, non-fatal on failure). HTML + plain-text bodies.
- [x] Audit events: SIGNATURE_SENT, SIGNATURE_COMPLETED, SIGNATURE_VOIDED + per-event SignatureEvent rows (SENT/VIEWED/SIGNED/DECLINED/VOIDED/REMINDED/COMPLETED + auto-EXPIRED).
- [ ] X.509 / PAdES cryptographic signing (deferred to V1.5)

**Frontend**
- [ ] ~~Drag signature fields onto PDF preview~~ (V2 — current model is typed-name acceptance below the document, which is sufficient for binding under most jurisdictions)
- [x] Signer list builder (`SendForSignatureDialog` — name + email + role + sequential order, parallel/sequential toggle, expiry select, message textarea)
- [x] Signature status tracker (`SignatureStatus` — per-signer cards with pending/signed/declined pills, copy-link, void, manual reminder, audit timeline disclosure; wrapped in `SignatureStatusRailSection` for the contract detail right rail)
- [x] In-app + external signing portal (`SignerPortal` — branded header, document render, decline + sign dialog with typed-name confirmation, "you've signed" success state)
- [x] **`/signatures` admin list** (replaces "Coming Soon" stub — org-wide table with status filter tabs, signer summary, click-through to contract detail)
- [x] Sidebar: Signatures promoted out of "Coming soon" → Legal section
- [x] Executed contract view (download flow returns the signed PDF including the certificate page; visible via the Download button)
- [x] **REAL BUG FIXED**: SignerPortal `refetch()` after success caused 410 → "Link unavailable" instead of the success confirmation. Removed refetch — local `confirmation` state drives the success render.

**Agents**
- [ ] ~~Signature Agent~~ (deferred to V1.5 — manual signer roster works for v1; LLM-assisted signer detection from contract parties is a follow-up)

#### Verification (6 smokes, scripts/p7-*.mjs)
| Smoke | Pass | What it covers |
|---|---|---|
| `p7-smoke.mjs`        | 11/11 | Full e-sign cycle (send → portal → sign → EXECUTED) |
| `p7-step3-smoke.mjs`  | 6/6   | SendForSignatureDialog UI + form + submission |
| `p7-step4-smoke.mjs`  | 7/7   | Org-wide /signatures admin page + filter tabs |
| `p7-step5-smoke.mjs`  | 7/7   | SignatureStatus rail section (status pill, signers, audit timeline, copy-link) |
| `p7-step6-smoke.mjs`  | 12/12 | PDF binding (cert page generated, signed PDF stored, currentVersionId advanced, %PDF- magic verified) |
| `p7-step8-smoke.mjs`  | 7/7   | Reminders (manual + sequential gating + REMINDED audit event) |

**Total: 50/50 across 6 verification scripts.**

---

### Phase 08 — Post-Signature
**Duration:** 1 day (Apr 27–28, 2026)
**Status:** `[x] Done`
**Acceptance:** Auto-extract obligations → obligation alerts fire on due date → mark complete with evidence ✓

#### Checklist
**Backend**
- [x] Prisma: `obligations` table — promoted from `contract.metadata` JSON to first-class rows + lifecycle fields (status, completedAt, evidence)
- [x] Auto-extract obligations on `signature.completed` event (fire-and-forget; replaces manual-only)
- [x] `GET /api/v1/obligations` (list, filter by status/bucket/due date/contract; org-wide)
- [x] `POST /api/v1/obligations/:id/complete` (mark done, optional multipart file upload + note)
- [x] `POST /api/v1/obligations/:id/reopen` (admin flip-back)
- [x] `GET /api/v1/obligations/:id/evidence` (presigned S3 URL for evidence file)
- [x] `GET /api/v1/obligations/stats` (open / dueSoon / overdue / completedRecent counters)
- [x] Daily BullMQ repeatable jobs (`obligation-scan-daily` 09:00 UTC + `renewal-scan-daily` 09:15 UTC) — visible in Bull Board
- [x] `GET /api/v1/renewals` + `/stats` — month-grouped lookahead with ACV totals
- [x] `POST /api/v1/contracts/:id/amendments` — spawns linked draft (relationshipType: amendment | sow | order_form | renewal | exhibit_only)
- [x] Prisma: `invoices` table + `POST /invoices` with auto-matcher (counterparty similarity + due-date proximity + currency + description)
- [x] `POST /invoices/:id/reconcile` (closes matched obligation), `/dispute`, `/rematch`
- [x] `GET /api/v1/invoices` + `/stats`
- [x] Audit events: `OBLIGATION_EXTRACTED` / `OBLIGATION_COMPLETED` / `OBLIGATION_OVERDUE` (idempotent — fires once per obligation)

**Frontend**
- [x] `/obligations` page — bucket filters (All / Open / Due soon / Overdue / Completed) + search + sortable table
- [x] Stats strip (open / due-soon / overdue / completed-30d)
- [x] CompleteObligationModal — note + evidence upload (25 MB cap)
- [x] In-rail "Complete" button on `ObligationsRailSection` (group-hover reveal)
- [x] `/renewals` page — month-grouped timeline with AI-advice pills + decision pills + ACV totals per month
- [x] `/invoices` page — table with match-confidence badges + Reconcile / Rematch / Dispute actions
- [x] CreateInvoiceDialog — manual entry with currency picker; auto-match preview screen on success
- [x] CreateAmendmentDialog — relationship-type picker, optional title + description; redirects to new draft
- [x] Sidebar: promoted Obligations + Renewals + Invoices into Legal section

**Agents (existing infra reused)**
- [x] Obligation Agent: `/extract_obligations` LLM service with 8-type taxonomy (payment / sla / renewal / audit / report / termination / compliance / other)
- [x] Obligation Agent: severity + recurrence + dueDate extraction with verbatim contract quote
- [x] Renewal Agent: `/renewal_advice` (recommendation + confidence + rationale + negotiation points + risk flags)
- [x] Bug fix in agents/routes/obligations.py — UnboundLocalError on `model`/`provider` when `resolve_llm` happy-path was hit

**Smoke results**

| Script | Pass / Total |
|--------|--------------|
| p8-step2-smoke.mjs (auto-extract on sign) | 6 / 6 |
| p8-step4-smoke.mjs (complete + evidence + reopen) | 16 / 16 |
| check-obligation-audits.ts (Step 5) | 6 / 6 |
| check-scan-worker.ts (Step 6 BullMQ) | 5 / 5 |
| p8-step9-smoke.mjs (invoice match + reconcile) | 16 / 16 |
| **Total** | **49 / 49** |

**Out of scope, deferred**
- Email-in invoices (parser + intake queue) — V1.5
- OCR for receipt images — V1.5 (existing `/extract_obligations` operates on plaintext)
- Contract-side obligation classification fine-tune — production telemetry-driven

---

### Phase 09 — Analytics, Reporting & Diligence
**Duration:** 1 day (Apr 28, 2026)
**Status:** `[x] Done`
**Acceptance:** Executive dashboard shows portfolio KPIs ✓ → drill down to contract list ✓ → export compliance report ✓ → diligence room analyzes contracts in bulk ✓

#### Checklist
**Backend**
- [x] Analytics API endpoints — `/analytics/summary` (KPIs), `/analytics/distributions` (status/type/risk), `/analytics/timeseries` (12-month volume), `/analytics/top-counterparties` (ACV ranking)
- [x] KPI calculations — cycle time avg+median, approval acceptance rate, on-time execution %, risk score distribution, total executed value
- [x] Compliance evidence PDF export — `/contracts/:id/compliance-export` returns auditor-ready PDF (cover + signers + 22-event audit trail + signed PDF append)
- [x] **Diligence Rooms** — `POST /diligence` creates room, `POST /diligence/:id/upload` bulk-multipart accepts 50 files, each becomes a Contract (with `diligenceRoomId` set) routed through the standard parse+extract+score pipeline
- [x] Diligence results — `GET /diligence/:id/results` returns flat extracted-fields table (counterparty/value/expiry/risk/clause flags per doc)
- [x] Diligence CSV export — `GET /diligence/:id/export?format=csv`
- [x] CSV exports — `/contracts/export`, `/obligations/export`, `/renewals/export` (all mirror the list-page filter set)
- [x] Contracts main repo filter — `diligenceRoomId IS NULL` so diligence docs stay out of the main listing

**Frontend**
- [x] Executive dashboard — `/analytics` page with 5 KPI cards + 3 metric bars + 4 charts (line / bar / pie-equivalent) using recharts
- [x] KPI cards drill-down — clicking Executed → `/contracts?status=EXECUTED`, High risk → `?riskBand=high`, Expiring → `/renewals?bucket=next_90`, Pending approvals → `/approvals`
- [x] Top counterparties table — links to `/contracts?counterpartyId=...&filterLabel=...` for filtered view
- [x] **Diligence Room UI** — `/diligence` (grid list with progress chips) + `/diligence/:id` (drag-drop upload zone, progress strip, cross-document extraction table, CSV export)
- [x] Compliance package menu item on contract detail (Actions → "Compliance package (PDF)")
- [x] Export CSV buttons on Obligations, Renewals pages
- [x] Sidebar — Analytics + Diligence promoted out of "Coming soon"

**Out of scope, deferred to V1.5**
- ClickHouse pipeline — pgsql + indexes scales to 100K+ contracts; revisit when we hit ingest >1k events/sec
- GraphQL endpoint — REST is the rest of the stack
- Saved Views (per-user filter persistence) — convenience-only, not lifecycle-blocking
- Insight Agent (proactive recommendations) — covered today by `RenewalAdviceRailSection` + obligation scanner notifications
- Search Agent NL portfolio queries — existing `obligations_list` + `renewal_advice` agent tools cover the common cases
- Excel (.xlsx) export — CSV is universally importable; xlsx is a polish item

**Smoke results**

| Endpoint | Verified |
|----------|----------|
| `GET /analytics/summary` | KPIs (28 contracts, 19 executed, $1.41M ACV, 100% on-time) |
| `GET /analytics/distributions` | 3 statuses, 15 types, 5 risk buckets |
| `GET /analytics/timeseries` | 12 months returned, populated month visible |
| `GET /analytics/top-counterparties` | 10 counterparties ranked by ACV |
| `POST /diligence` + `/upload` + `/documents` + `/results` | 2 docs uploaded, table renders, CSV exports |
| `GET /contracts/:id/compliance-export` | 3-page PDF with cover + signers + 22-event audit trail |
| `GET /contracts/export` (filtered) | CSV with 19 EXECUTED rows |
| `GET /obligations/export` | CSV with 9 obligations |
| `GET /renewals/export` | CSV with 4 upcoming renewals |

---

### Phase 10 — Integrations & Scale
**Duration:** 3–4 weeks
**Status:** `[~] In Progress`
**Started:** 2026-04-28
**Acceptance:** Platform is fully usable without any of these. Phase 10 adds external reach, not core function.

> **Design principle:** Every item here is additive. Phases 01–09 are a complete, production-ready CLM. Phase 10 is pure enhancement. Build in order of business value; ship any subset independently.

> **2026-06-10 checklist audit:** several items below were already shipped during Phases 6.5–09 and earlier sessions but never checked off here. Verified against code and marked accordingly.

#### Core Admin (build first — these support the platform itself)
- [x] Bulk CSV import: upload → validate → preview → confirm → per-row results (`POST /contracts/bulk-import`, `lib/csv.ts`, `BulkImportDialog.tsx`; verified by probe P59)
- [x] RBAC manager: admin UI to create roles, assign permissions (`AdminRolesPage.tsx`, `routes/admin-users.ts`; verified by probe P60)
- [x] Onboarding setup wizard (`OnboardingWizard.tsx` — industry pack + first contract; invites via dashboard WelcomeChecklist)
- [x] Admin settings panel (`AdminOrgPage.tsx` — General / Alert Rules / AI Config / System Dashboard / Data Management; flags in `organization.settings` JSONB)
- [x] Team workload view (`TeamPage.tsx`, `GET /team/workload`)
- [~] Performance: targeted indexes (orgId+status, versionId+isSubChunk, pgvector IVFFlat) + Redis caching for cost caps & agent session memory — no systematic query-plan pass yet

#### Communication Integrations (high value, lower effort)
- [x] Slack bot: outbound notifications (`lib/slack-formatter.ts`), `/contract search` slash command (`routes/slack.ts`, signing-secret v0 HMAC + replay guard, org resolved by team_id), inline Approve/Reject buttons on `approval.submitted` cards (interactions endpoint mirrors `/approvals/:id/decide`; identity via bot token users.info → email match, web-link fallback without it)
- [x] Slack bot setup wizard — Slack tab on `AdminIntegrationsPage`: copyable app manifest (pre-wired command + interactivity URLs), connect form (team ID / signing secret / optional bot token via `GET/PUT/DELETE /admin/integrations/slack`, secrets masked), channel step via existing Slack-type webhooks
- [~] Microsoft Teams: outbound notifications shipped — `lib/teams-formatter.ts` (Adaptive Cards 1.4 for Teams Workflows webhooks), `type='teams'` on webhooks with logic.azure.com / webhook.office.com auto-detect, worker wiring, "Teams card" option in create dialog. Interactive bot (botbuilder slash commands / inline approvals) still pending — needs Azure bot registration
- [~] Email notifications: Nodemailer SMTP in `notification.worker.ts` + signing emails (`lib/signing-email.ts`) — SendGrid dynamic templates not adopted (SMTP works self-hosted; revisit only if deliverability demands it)

#### CRM / ERP Integrations (high effort — timebox 2 days each)
- [ ] Salesforce connector: OAuth 2.0, opportunity → contract request sync
- [ ] Salesforce → contract auto-creation when deal closes
- [ ] SAP/NetSuite: purchase order → contract request, invoice → obligation match
- [~] Integration settings page (`AdminIntegrationsPage.tsx` — API keys + webhooks CRUD; no per-provider OAuth connect/disconnect yet)
- [x] Integration health dashboard — `GET /admin/integrations/health` (per-webhook health state + 24h/7d delivery aggregates + API-key summary in one call), `POST …/deliveries/:id/retry`, Health tab on `AdminIntegrationsPage` (summary cards, per-webhook table, last error, one-click retry, 30s auto-refresh)

#### Email / Inbox Integrations
- [ ] Gmail add-in: create contract request from email thread
- [ ] Outlook add-in: same
- [x] Inbound email parsing: `contracts+<contractId>@…` → new version via SendGrid Inbound Parse (`routes/inbound-email.ts`; sender validation, PDF/DOCX attach, flips to UNDER_NEGOTIATION)

#### Agents (Phase 10 scope)
- [ ] Integration Agent: bidirectional CRM sync orchestration *(blocked on Salesforce connector)*
- [~] Integration Agent: ERP invoice-to-obligation matching — the matching engine already shipped in P8 Step 9 (`routes/invoices.ts`: scored auto-matcher on counterparty/amount/currency/description + reconcile/dispute/rematch + `invoice.reconciled` webhook). Missing piece is only ERP-side ingestion (SAP/NetSuite invoice pull), blocked on those connectors
- [x] Compliance Agent: regulatory clause checks (GDPR, HIPAA, SOX, CCPA) — `apps/agents/app/routes/compliance.py`, `apps/api/src/lib/compliance-check.ts`, `POST /contracts/:id/compliance-check` + `GET /:id/compliance`, `ComplianceRailSection.tsx`; report persisted to `metadata._compliance`, `COMPLIANCE_CHECKED` audit event

---

## Known Gaps to Address During Build

| Gap | Impact | Mitigation |
|-----|--------|-----------|
| No wireframes/mockups | UI interpretation risk | Use shadcn/ui defaults; standardize on first component, replicate pattern |
| No agent system prompts | Agent quality undefined | Write prompts before each agent phase; iterate with eval harness |
| No OpenAPI / shared types | Frontend-backend drift | Build `packages/types` in Phase 1; generate from Prisma schema |
| No error state designs | Broken UX silently fails | Add error/loading/empty states as part of every component |
| No seed data | Hard to develop/demo | Create 50 realistic seed contracts in Phase 2 (fixture file) |
| No actual test files | No regression safety | Write tests alongside each feature (not after) |
| Salesforce/SAP OAuth flows | Multi-day integration effort per connector | Phase 10 only; timebox 2 days each; platform works without them |
| Internal signing: PDF field placement | UX for drag-drop fields on PDF is non-trivial | Start with fixed signature block at end of doc; add drag-drop in v2 |
| **PDF → editor structured extraction** | Editor shows blob text instead of paragraphs/headings for most PDFs | PyMuPDF (`pymupdf`) installed in agents venv, extract.py written with y0-to-y0 gap paragraph detection + ALL-CAPS heading detection. Root cause: EDGAR PDFs often have zero inter-paragraph spacing (only visual numbering separates sections), making gap-based heuristics unreliable. Attempted: pdf-parse, pdfplumber, Docling (155s, OCR corruption), PyMuPDF with block/line/gap approaches. Deferred — current state is functional (text is readable, words intact, no "C HANNEL" corruption) but not paragraph-structured. Recommended next approach: use pdfplumber `extract_text_lines()` with x-tolerance grouping, or adopt `markitdown` (Microsoft) which handles legal PDF → Markdown cleanly. DOCX extraction via mammoth already works well. |
| Cryptographic signature standards | X.509 / PAdES compliance varies by jurisdiction | Use node-forge PAdES-B baseline; log hash + timestamp in audit_events as legal evidence |
| Email templates (15–20) | Notifications look broken | Use SendGrid dynamic templates; create 1 per phase as needed |
| **Playbook review has no UI** (2026-07-20) | The `playbook-review` pass runs on every upload and writes `metadata._playbookReview` (findings, severity, alignment, human-gate flag) but **nothing renders it** — the feature is real and completely invisible | Add a rail section mirroring `ComplianceRailSection.tsx`, which already reads a `metadata._*` report in exactly this shape. Highest-value follow-up from this batch |
| **`PENDING` absent from the stuck-contract sweep** | `IN_PROGRESS_STATUSES` in `workers/index.ts` omits `PENDING`, so if a parse job is lost/never enqueued the contract sits PENDING forever with no server-side recovery and no FAILED banner. Now higher-impact: portal + inbound-email versions repoint `currentVersionId`, so an existing contract's canonical text can go blank with no path back | Deliberately not added: at the current 5-minute threshold a queue backlog would mark healthy contracts FAILED. Needs a longer PENDING-specific threshold chosen against real throughput. Client-side "Retry" after 3 min (`STUCK_DETECTABLE`) partially covers it, but only if someone opens the page |
| **No SPF/DKIM verification on inbound email** | The sender allow-list is the only control on an unauthenticated webhook. Envelope is now preferred over headers, but a provider-authenticated result is never checked, so plain `From:` spoofing still defeats it | Read SendGrid's `spf`/`dkim` result fields in `readInboundBody` and refuse on fail before the allow-list runs |
| Share links not revoked on contract execution | Links stay valid up to 30 days past execution | Status guard now blocks upload against EXECUTED/ARCHIVED; revoking links on execution is still the cleaner fix |
| Portal upload trusts the client-declared mimetype | The externally-facing path is the one *not* sniffing magic bytes, while the authenticated upload comments "trust the bytes, not the client" | Reuse `detectBinaryType` from `routes/contracts.ts` |
| Diff-cache TOCTOU | A diff computed just before parsing completes can be written *after* the eviction, and nothing evicts it again | Narrow window, permanent effect. Re-check the version's `updatedAt` before the cache write |
| **Counterparty loop unverified end-to-end** (2026-07-20) | Typecheck/unit tests pass but no flow was driven against a real DB — Docker was unavailable, so the round-trip, template upload and apply button are unproven against live data | Walk the happy flow on the deployed Cloud Run app |

---

## Architecture Decisions Log

| Date | Decision | Reason |
|------|----------|--------|
| 2026-03-17 | LangGraph for all agents | State machine pattern handles multi-step agent flows with human-in-the-loop gates |
| 2026-03-17 | Redis Streams as event bus | Fan-out to multiple consumers, ordering per org, built-in retention |
| 2026-03-17 | Fastify over Express | 2–3x throughput, built-in schema validation, TypeScript-first |
| 2026-03-17 | Prisma over raw SQL | Type-safe DB access, auto-migration, multi-tenant RLS compatible |
| 2026-03-17 | Yjs + HocusPocus for collab | CRDTs handle concurrent edits without conflict; TipTap has native Yjs support |
| 2026-03-17 | ClickHouse for analytics | Columnar store handles time-series KPI queries that would kill PostgreSQL |
| 2026-03-17 | Internal signing engine (pdf-lib + node-forge), no DocuSign | Zero external vendor dependency; fully self-hosted; Documenso available as drop-in upgrade if richer UI needed |
| 2026-03-17 | All external integrations deferred to Phase 10, non-blocking | Phases 01–09 are a complete usable product; integrations are additive, not load-bearing |
| 2026-03-17 | Multi-provider LLM registry (Anthropic, OpenAI, Google) | `apps/agents/app/providers.py` is the single source of truth. Users pick provider+model in chat UI. System agents use OmniModel routing independently. Adding a provider = implement `build_llm()` branch + add model rows. |
| 2026-03-17 | Internal JWT auth (HS256), no Auth0/Clerk for Phase 01 | Avoids external dependency in early build. Auth0/Clerk SSO/SAML added in Phase 10 for enterprise. |
| 2026-03-18 | Clause-level embeddings, not document-level | Embedding a 50-page contract as a single vector is too coarse for similarity search. Embed individual clauses (256-512 tokens) by clause type → `contract_clauses` table. Enables clause similarity, playbook deviation detection, per-clause RAG answers. |
| 2026-03-18 | voyage-law-2 as embedding model (fallback: text-embedding-3-large) | Legal-domain fine-tuned models outperform general models (ada-002, text-embedding-3-small) on clause similarity and legal concept retrieval. voyage-law-2 is purpose-built for this. |
| 2026-03-18 | JSONB + field_definitions table for custom fields (not EAV, not schema-per-tenant) | JSONB is flexible and already in schema. field_definitions table gives admin UI the schema to render/validate. ES dynamic mapping indexes metadata.* automatically. EAV is legacy, schema-per-tenant doesn't scale for multi-tenant SaaS. |
| 2026-03-18 | ES Percolator queries for renewal/expiry alerting (Phase 08) | Standing queries stored in ES fire on document update — more reliable than cron polling at scale. Deferred to Phase 08 Obligation Alerts. Note here so Phase 08 uses this pattern. |
| 2026-03-18 | Structured vs. semantic query separation in portfolio agent | "Contracts expiring in 60 days value > $100K" = structured filter (Postgres/ES bool). "Unusual IP clauses" = vector search. Portfolio Agent must classify intent before routing. Never use vector search for structured filter problems. |
| 2026-03-18 | Review Agent split into 3-step pipeline (Summize pattern) | Single monolith agent = higher hallucination rate, no per-field confidence. Summize's multi-agent validation pattern (Extract → Validate → Score) won Best SaaS Product 2025 and is the market best practice for explainable extraction. |
| 2026-03-18 | MCP (Model Context Protocol) as future integration layer for Phase 10 | Anthropic donated MCP to Linux Foundation (Agentic AI Foundation) Dec 2025. Becoming the standard for agent ↔ tool access. Phase 10 integrations (Salesforce, SAP, Slack) should be implemented as MCP servers, not custom REST bridges. Cleaner, reusable, community-maintained connectors. |
| 2026-03-18 | Contract Q&A (RAG) is table stakes — must be in Phase 2.1 | Harvey and Legora both offer "ask your contract" natively. Without RAG-over-contracts our chat is a generic assistant, not a legal intelligence layer. Phase 2.1 adds RAG endpoint + multi-contract portfolio ask. |
| 2026-03-18 | Always show confidence + cited clause source in AI answers | Harvey's cited weakness is ~74% accuracy and fabricated citations. Our answer format always returns { answer, clauses: [{section, quote, confidence}] }. Legal teams trust AI that shows its work. This is a direct competitive differentiation. |
| 2026-03-18 | Phase 05 External Portal = our answer to Legora Portal | Legora's $5.55B valuation is partly built on its law firm ↔ in-house collaboration Portal (Nov 2025). Our Phase 05 external sharing and counterparty collaboration portal must be built with this level of ambition — not just a read-only link. |
| 2026-03-18 | Diligence Rooms in Phase 09 = our answer to Harvey Vault | Harvey charges premium for Vault (10K doc bulk analysis for M&A). Phase 09 adds Diligence Rooms: bulk upload → batch Review Agent → structured extraction table → Excel export. Attacks Harvey's premium feature on an integrated platform. |
| 2026-03-18 | Multi-provider LLM is a competitive moat vs Harvey and Legora | Harvey is OpenAI-locked (GPT-5 family). Legora is Azure OpenAI-locked. We support Anthropic + OpenAI + Google with OmniModel cost routing. Enterprises with model procurement preferences or data residency requirements benefit directly. |
| 2026-03-19 | Auto-split binder without user gate | The LLM already knows where to split (pageHint per document). Making the user click "Review & Split" adds friction with no benefit on the happy path. Immediately queue split-binder after detect-binder; store _splitInto in parent metadata so UI can show "Split into N contracts" banner with links. User can adjust via post-split correction. |
| 2026-03-19 | _totalPages stored in metadata during parse step | detect-binder needs total page count to compute the last document's page range (lastDoc.pageEnd = totalPages). pdf-lib getPdfPageCount() is called at parse time. Storing it in metadata passes it to the async agent.worker handler cleanly without needing a DB join or re-reading S3. Fallback to 100 if not present (handles text files). |
| 2026-03-19 | Type-specific extraction schemas separate from generic keyTerms | Generic 14-field extraction is insufficient — NDA fields are completely different from Employment or SLA fields. Separate `TYPE_SCHEMAS` dict (10 types × 9–16 fields) injected into LLM prompt at extraction time. Results stored in `metadata._typeFields` (not keyTerms) to distinguish type-system knowledge from org-defined custom fields (`metadata[fieldKey]`) and generic fields (`contract.keyTerms`). Labels included in stored values for UI rendering without needing schema lookup at display time. |
| 2026-03-19 | Extraction data is now in 4 distinct buckets | (1) `contract.keyTerms` — 14 generic fields (parties, dates, value, governing law, etc.) for all contract types; (2) `contract.metadata._typeFields` — type-specific expert fields per contract type; (3) `contract.metadata[fieldKey]` — org admin-defined custom fields; (4) `contract.metadata._aiFindings` — open-ended LLM observations outside defined schemas. UI renders all 4 separately with appropriate confidence/evidence display. |
| 2026-04-22 | **Agent-first primary surface** (Genspark/Claude-Code style); traditional UI reserved for setup/config | Product direction pivot after end-to-end flow audit. Primary workspace = agent chat that can drive every CLM action via tool calls, with rich embedded UI components (contract cards, diff viewers, status steppers). Traditional screens persist for templates, playbooks, workflows, roles, org admin — invoked via sidebar or via agent ("take me to NDA template editor"). See [docs/25-CONTRACT-FLOW-FIX-PLAN.md](docs/25-CONTRACT-FLOW-FIX-PLAN.md). |
| 2026-04-22 | **Build order: pipeline → journey UI → post-sig → agent** (not agent-first in build order) | Agent surface deferred to Phase D, after pipeline (A) + journey UI (B) + post-sig (C) are solid. Rationale: agent is only as useful as its tools; a working UI is the fallback when the agent misunderstands; iterating on pipeline bugs via clicks is faster than via NL. Product thesis is still agent-first, build order is not. |
| 2026-04-22 | **Tool registry moves to Phase D** (agent phase), not Phase A | Originally planned to declare tools alongside endpoints in Phase A. Moved because tools without an agent consuming them is dead weight. Endpoints in A/B/C stay clean REST; wrapping as tools in D is a thin layer once endpoint contracts are stable. |
| 2026-04-22 | **Hybrid canonical artifact** for ContractVersion — original PDF canonical until first edit, then Gotenberg-rendered PDF from HTML takes over; both tracked forever for diff | Preserves counterparty formatting/letterhead on unedited uploads; ensures edits made in our editor appear in the signed PDF. Diff between original and edited always available. Resolves the "source of truth flips silently" break identified in flow audit. |
| 2026-04-22 | **Plan-then-execute** pattern for agent destructive actions | Agent proposes a structured plan (JSON checklist) before any state-changing tool fires. User confirms or modifies. Read-only tools (search, get, ask) auto-execute. Trades one extra tap for full auditability and user control. Mirrors Genspark / Claude Code interaction model. |
| 2026-04-22 | **Both portal AND email-redline** inbound flows supported | Portal is the differentiated Legora-style counterparty experience; email is the realistic legacy path many counterparties will insist on. Per-org inbound address (`contracts+<contractId>@mail…`) + IMAP or SendGrid inbound parse → parse pipeline → attach as new version. |
| 2026-04-22 | **Self-hosted eSignature confirmed** (no DocuSign dependency) | Reconfirms 2026-03-17 decision after flow audit. `pdf-lib` + `node-forge` + internal signing portal supporting both JWT-authed internal signers and tokenized-link external signers. Phase 07 build goes ahead as originally scoped. |
| 2026-04-29 | **Multi-turn tool memory persisted to Redis** (`tool_calls` + `tool_results` alongside the assistant turn, restored as `AIMessage(tool_calls)` + `ToolMessage` chain) | Without this the agent forgets contract IDs between turns and re-fetches or hallucinates. LangChain's chat history alone (just role+content) drops the structured tool I/O. Persisting both halves of every tool round-trip lets us reconstruct the LLM's view of past evidence on the next turn. Cost: a few KB per turn in Redis. Trade-off accepted. |
| 2026-04-29 | **`dedupeKey` on every artifact factory** (`stableKey(toolName, fingerprint)`) | Each tool call returns its own artifact; the consumer pane was stacking duplicates because every event got a fresh id. Stable per-(tool, fingerprint) key lets the consumer replace-in-place. The factory owns the fingerprint definition (e.g. ordered contract-id list for `portfolio_compare`) so the contract is local. |
| 2026-04-29 | **COMMIT-DON'T-CONFIRM rule for write tools** in orchestrator system prompt | LLM was over-asking for confirmation on actions the user already authorised in the same turn ("shall I update the contract you just told me to update?"). New rule: if the user's last message asked for a state change and required arguments are present, fire the tool. Read-only tools (search/get/ask) auto-execute regardless. Plan-then-execute still applies for multi-step destructive plans (>1 write tool). |
| 2026-04-29 | **`totalMatching` distinct from `total`** in `contract_search` response | Old `total: results.length` made the agent claim "50 contracts" when the real count was 313 (page-1 of many). Real DB count goes in `totalMatching`; `total` becomes a paging anchor. Orchestrator rule A11 forces the agent to read `totalMatching` for "how many" answers. Cheap COUNT(*) over an indexed `orgId+status` is the right cost shape. |
| 2026-04-30 | **Hybrid-retrieval routing rule (A12)** — intent → tool: list/portfolio → `portfolio_search`; specific contract → `contract_search`; clause text → `clause_search`; "compare these N" → `portfolio_compare`; "show me where" → `contract_cite` | Without an explicit routing rule the LLM defaults to whichever tool is mentioned first in the prompt. Encoded as a system-prompt rule so changes are version-controlled with the prompt, not buried in tool descriptions. |
| 2026-04-30 | **Every contract-create path must call `indexContract`** | Discovered ~40% of contracts (blank-create, bulk-import, amendment) were invisible to portfolio_search because indexing was wired only into `/upload` and PATCH. Treat ES indexing as part of the contract-create contract, not a side effect of upload. Backfill script lives at `apps/api/scripts/backfill-es-index.ts` for one-shot recovery. |
| 2026-05-01 | **`portfolio_compare` is a structured tool, not prose synthesis** | Multi-doc compare via `portfolio_search` + LLM synthesis was unreliable — the model kept describing only the first contract and pretending the rest matched. Dedicated tool returns a topic × contract matrix with per-cell `found/quote/section` so the UI can render true side-by-side and the LLM only writes the narrative on top of structured data. Closes the Harvey-Vault / Ironclad multi-doc gap. |
| 2026-05-01 | **Long-context single-pass for review summarisation** (`_CHUNK_SIZE = 120_000`, was 40K; significantClauses passed to score step) | Sonnet's context window can take 120K tokens of clause text in one call — chunking adds latency and loses cross-clause reasoning. Bumped chunk size; pass high-signal clauses (e.g. liability, IP, termination) to the score step as a focused second view. Net: better risk scoring on long contracts, fewer LLM round-trips. |
| 2026-05-01 | **Smart Import second-pass extraction for missing required keys** | First-pass extraction occasionally misses required fields (parties, term_length, governing_law, total_value) on noisy or multi-party contracts. Second focused pass over the same text targeting only the missing keys recovers most of them at low cost. Better than retrying the whole pipeline or returning blanks. |
| 2026-05-01 | **`sign` permission distinct from `configure`** on contract.signatures (send / remind / void) | Send-for-signature was gated on `configure:contract` which conflated "configure the contract" with "act as signer admin". Split: `sign:contract` for envelope ops; `configure:contract` reserved for metadata/structural changes. Refresh-system-role-perms script syncs all 219 system roles in one shot. |
| 2026-05-02 | **`docs/33-AGENT-UPDATES-PLAN.md` is the agent backlog** *(⚠ 2026-06-10: file missing from repo — was never committed; reconstruct or re-park before next agent push)* | Park doc capturing where the agent stack is after P1–P84 + ~30 fixes, gap matrix vs Harvey/Ironclad, Tier 1/2/3 backlog, decisions queue, success metrics. Source of truth for the next agent push; deliberately scoped narrow ("doesn't promise X yet") so we don't over-commit on scheduled-reports / page-anchors / cross-encoder reranker before the simpler wins land. |
| 2026-07-20 | **Counterparty editing stays an async DOCX round-trip; no in-portal editing** | Download → redline in Word → upload back is the industry-standard CLM pattern and the scaffolding already assumed it. In-portal editing would need a portal-token path into Hocuspocus (`collab-server.ts` rejects non-`access` tokens by design) plus per-token write scoping — a large change that isn't required for a working loop. |
| 2026-07-20 | **`playbook-review` job id is keyed on versionId, not contractId** | BullMQ silently drops an `add` with a duplicate jobId (it returns the existing job rather than throwing, so a `.catch` never sees it) and retains completed jobs. A contract-scoped id therefore reviews a contract exactly once, ever, and drops every later version — including the counterparty's returned redline, which is the case the feature exists for — while the stored result still points at v1. Version-scoped id + retention limits. |
| 2026-07-20 | **Single-document playbook review is a separate agent from the Redline Agent** | Redline is a version-DIFF analyser: it requires v1Id+v2Id, aborts on an empty diff, and its prompt reads `<ins>`/`<del>` tags. A contract received from a vendor has exactly one version, so it structurally cannot go through that pipeline. The new pass scores the clause segments extraction already produced — one call, no re-read — and reports only deviations so the reviewer gets a short actionable list. |
| 2026-07-20 | **Signed-PDF sealing runs as a retryable queue job, not inline** | It was a fire-and-forget IIFE with swallowed errors, so any transient S3/Gotenberg/cert failure left the contract `EXECUTED` with no sealed PDF and no retry — a legally significant artefact silently missing. Handler re-reads state and is idempotent on a deterministic signed key; permanent-failure conditions return `skipped` rather than burning retries. Deterministic jobId prevents two concurrent seals creating duplicate versions for the same key (the unique constraint is on `[contractId, versionNumber]`, not the key). |
| 2026-07-20 | **Template import accepts `.docx` only** | mammoth is the converter and is already in the stack. A PDF-derived template loses the heading structure that makes a template worth having, so accepting PDFs would ship a path that reliably produces poor templates. The promoted heading is stripped from the section body because `template-engine` re-emits `section.title` as an `<h2>` — leaving it in renders every heading twice. |
| 2026-07-07 | **Secrets fail closed in production; API-key scopes are permissions, not roles; webhook SSRF guard on by default (self-host opt-out)** | (a) A missing/weak `JWT_SECRET` etc. must crash the boot in prod, never silently sign with a shared constant — the prior fallback was a full auth-forgery hole. Dev keeps DX by generating a per-machine secret. (b) API-key `scopes` map through `API_SCOPE_PERMISSIONS` to concrete permissions; empty = no access. Treating scope strings as role names (and empty⇒ADMIN) was broken in both directions. (c) Outbound webhook URLs are attacker-controlled; block private/metadata targets on the hosted multi-tenant deploy, but let self-hosters opt out (`WEBHOOK_ALLOW_PRIVATE_URLS`) since their own infra is legitimately private. (d) Auth-relevant checks fail closed on unknown input (null contract value does NOT auto-approve). |

---

## Session Log

| Date | Phase | Work Done | Blockers |
|------|-------|-----------|---------|
| 2026-03-17 | — | Reviewed all 23 docs. Created build tracker. | None |
| 2026-03-17 | — | Replaced DocuSign with internal signing engine. Moved all external integrations to Phase 10 as non-blocking. | None |
| 2026-03-17 | 01 | Full Phase 01 scaffold: monorepo, Docker Compose, packages/types, Fastify API (auth/contracts/requests/users/agents routes + JWT + RBAC + audit), React frontend (auth + app shell + chat panel), Python FastAPI agents (LangGraph + Claude + Redis memory), GitHub Actions CI, seed data. | None |
| 2026-03-17 | 01 | Multi-provider LLM support: Anthropic + OpenAI + Google Gemini. `providers.py` registry, model picker in chat UI, `GET /agent/models` endpoint. Updated docs/architecture/02-TECH-STACK.md and 05-AGENT-ARCHITECTURE.md. | None |
| 2026-03-17 | 02 | Phase 02 build: Prisma schema (counterparties, contract_embeddings, pgvector), upload endpoint, PDF/DOCX extraction (pdf-parse + mammoth), Elasticsearch index with Postgres fallback, hybrid search, counterparty CRUD, contract detail/versions/timeline routes, Review Agent (LangGraph), ContractsPage (table + filters + upload modal), ContractDetailPage (4 tabs + PDF viewer), 10 demo contracts seeded. | Embedding generation deferred (not blocking) |
| 2026-03-17 | 02 | Phase 02 gap fixes: internal service auth (x-internal-service header bypass), org-scoped PATCH for system calls, UpdateContractSchema extended (summary/keyTerms/riskScore), @elastic/elasticsearch downgraded v9→v8, ensureBucket() added to storage.ts, title UUID cleanup on upload, contractType enum validation + riskScore clamp in Review Agent, PDF viewer error handling (network fail + render fail), search bar wired to POST /search (ES + Postgres fallback). Phase 02 complete. | None |
| 2026-03-18 | 2.1 | Sanity check: docs vs build plan vs code. Identified schema gaps, rich metadata extraction gaps, missing custom fields system, portfolio query not implemented, embeddings not generated. Designed Phase 2.1 to cover all gaps before Phase 03. | None |
| 2026-03-18 | — | Competitive analysis: Harvey ($8B, $195M ARR), Legora ($5.55B). Added full competitive positioning section. Key finding: Harvey+Ironclad partnership validates our integrated AI+CLM thesis. Added Contract Q&A (RAG) to Phase 2.1, Diligence Rooms to Phase 09, Legora Portal context to Phase 05. 6 new Architecture Decision Log entries. | None |
| 2026-03-18 | 2.1 | **Phase 2.1 complete.** Schema: 3 migrations (contract_clauses, clauseFlags, helpText). Review Agent v2: 3-step LangGraph pipeline (Extract/Haiku → Validate/Sonnet → Score/Sonnet) with per-field confidence + verbatim quotes. Embeddings: clause-level text-embedding-3-large, BullMQ embed-contract job, searchClauses() pgvector cosine. ES: legal_english analyzer, dynamic templates, buildESQuery(), advancedSearch(), getContractFacets(). Endpoints: /search/advanced (keyword/semantic/hybrid RRF), /search/facets, /search/ask, /contracts/:id/ask, /contracts/:id/versions/:versionId/clauses, /field-definitions CRUD. Python agents: portfolio_agent.py (NL→ES query→answer), ask_agent.py (RAG with [Clause N] citations), /agent/portfolio-query + /agent/ask routes. Frontend: facets sidebar on ContractsPage, Q&A tab on ContractDetailPage, confidence dots + quote tooltip, clause flags badges, risk badge, risk score in list. | None |
| 2026-03-19 | 2.2 | **Phase 2.2 complete.** Queue-based pipeline replacing synchronous upload processing. New workers: parse.worker.ts (parse-document + chunk-and-index + embed-contract), agent.worker.ts (extract-ai with custom fields). Legal chunker: clause-boundary-first chunking with sliding window fallback + snapToSentence, ES clauses bulk index. Agents: review.py extended with contractType + customFields[], review_agent.py with 40K chunked extraction + dynamic prompt injection. API: upload now async (queueParseDocument), new /retype + /chunk endpoints. Frontend: inline contract type editing with pencil icon + retype mutation. DB migration: isSubChunk/windowIndex/charStart/charEnd on contract_clauses. | None |
| 2026-03-19 | 3.1 | **Phase 3.1 complete.** Multi-document & contract hierarchy support. Research-backed: MSA+SOW+amendments is table stakes across all CLM platforms. DB migration: relationshipType + attachments JSON on contracts. API: upload accepts parentContractId + relationshipType; GET /:id/family; POST /:id/attach; DELETE + download attachment endpoints. Binder detection: binder-detector.ts (regex heuristics, replaced in 3.2); pdf-splitter.ts (pdf-lib page slicing). Frontend: UploadModal full rewrite with parent contract search combobox + relationship type select; ContractDetailPage: Contract Family panel, Attachments panel, binder amber banner, split modal with editable page ranges. | None |
| 2026-03-19 | 03 | **Phase 03 complete.** Intake & Requests: POST /intake-classify agent (Haiku, 3K chars — classifies type, extracts counterparty/value/law, suggests priority). queue.ts: ClassifyRequestJob + queueClassifyRequest. agent.worker.ts: classify-request handler (updates request.type if confidence ≥ 0.75, stores _aiClassification in metadata). requests.ts: queueClassifyRequest after create + POST /:id/convert (request → Contract, sets ACCEPTED). Frontend: RequestsPage full rewrite (status tabs, table with type/priority/status badges, 5s polling while SUBMITTED), NewRequestModal (react-hook-form, 6 fields), RequestDetailPanel (AI classification card with confidence bar + extracted terms, assignee dropdown from /users, Accept/NeedMoreInfo/Reject action buttons, Accept → POST /convert → navigate to contract), CounterpartiesPage (table + debounced search + add/delete modal). Sidebar: Counterparties nav item added. All tested: API end-to-end verified, TypeScript 0 errors in frontend. | None |
| 2026-03-19 | 3.2 | **Phase 3.2 complete.** Proper event-driven pipeline with LLM binder detection + granular status. New pipeline: parse-document (PARSING) → detect-binder (LLM, Haiku) → BINDER_DETECTED or classify-document (CLASSIFYING) → extract-ai (EXTRACTING) → chunk/embed (INDEXING) → DONE. New Python routes: detect_binder.py (POST /detect-binder, 10K chars), classify.py (POST /classify, 5K chars, 11 contract types), both wired in main.py. Queue: 3 new job types + helpers (DetectBinderJob, ClassifyDocumentJob, SplitBinderJob). Workers: detect-binder + classify-document handlers in agent.worker.ts; split-binder handler in parse.worker.ts (S3 download → pdf-lib → N child contracts → each queued independently). API: POST /:id/split now returns 202 + queued job. Frontend: STATUS_BANNER map for all 9 statuses on ContractDetailPage, IN_PROGRESS_STATUSES array drives polling + AI badge on ContractsPage. | None |
| 2026-03-19 | 3.3 | **Phase 3.3 complete.** Auto-split pipeline — binder detected triggers immediate split with no user gate. `_totalPages` stored in contract metadata during parse-document (after getPdfPageCount) and read by detect-binder to compute last document's page range. `docsToSplitSpecs()` helper converts LLM pageHint strings ("~page N") to concrete {pageStart, pageEnd} ranges with sort+fallback. `_splitInto: childIds[]` written to parent metadata on split completion. Blue auto-split banner in ContractDetailPage (links to child contracts); amber legacy banner preserved for manual fallback. `BINDER_DETECTED` removed from IN_PROGRESS_STATUSES on ContractDetailPage + ContractsPage. Intake document upload: requests `POST /` handles multipart with optional file field → S3 upload + attachments array. `POST /:id/convert` creates ContractVersion + queues parse-document when attachments present. NewRequestModal: file attachment UI (Paperclip button, name/size/remove), FormData submission. | None |
| 2026-03-19 | 3.4 | **Phase 3.4 complete.** Type-specific extraction schemas + complete custom field display in UI. `TYPE_SCHEMAS` dict in review_agent.py: 10 contract types, 9–16 fields each (NDA/MSA/SOW/SLA/EMPLOYMENT/VENDOR/PARTNERSHIP/LICENSE/DATA_PROCESSING/ORDER_FORM). LLM prompt injection: _build_custom_fields_prompt() includes CONTRACT-TYPE-SPECIFIC FIELDS section with typeFields JSON key. Extraction result: typeFields merged into custom_extracted → review.py maps to metadata._typeFields = { fieldKey: { value, confidence, quote, label } } with label from TYPE_SCHEMAS lookup. _VALID_TYPES extended with DATA_PROCESSING and ORDER_FORM. Frontend ContractDetailPage: TypeField/FieldDef/AiFinding interfaces added; "Contract-Specific Terms" section (grid, ConfidenceIcon, quote tooltip); "Custom Fields" section (DetailRow + formatTermValue, filtered by contract type via /field-definitions); "AI Findings" collapsible section (showFindings state, ConfidenceIcon, quote on expand). End-to-end verified: predefined fields → keyTerms; type-specific fields → metadata._typeFields; org custom fields → metadata[fieldKey]; open-ended → metadata._aiFindings. | None |
| 2026-03-22 | 06 | **Phase 06 complete.** Approval Workflows: Prisma migration (WorkflowDefinition + ApprovalInstance + ApprovalStep + Notification). workflow-engine.ts state machine (sequential/parallel, escalation, delegation, auto-approve). notification.worker.ts (DB notifications + optional Nodemailer email + BullMQ escalation timer). routes/approvals.ts (my-queue, decide, workflow CRUD, notifications). contracts.ts: submit-approval endpoint. approval_agent.py 3-step LangGraph pipeline (summarize→flag_risks→recommend). Python routes/approval.py + agent.worker.ts handler. Frontend: ApprovalCard, ApprovalTimeline, WorkflowBuilder (up/down buttons, no @dnd-kit), WorkflowDefinitionList, NotificationBell. ApprovalsPage.tsx two-tab layout. ContractDetailPage approval tab + Submit for Approval button. Header.tsx: NotificationBell added. | @dnd-kit not installed → used up/down buttons instead (no functional impact) |
| 2026-04-22 | audit | End-to-end flow audit via Playwright-driven screenshot tour (`scripts/tour.mjs`). 43 screenshots across auth, dashboard, contracts list/detail (all 7 tabs), requests, templates, clauses, playbook, approvals, admin, settings, onboarding. Identified 19 distinct user-facing bugs/gaps: editor shows "No suitable template found" on uploaded contracts, two parallel DRAFT→APPROVED tracks with confusingly different semantics, `APPROVED→EXECUTED` is manual (no signature), portal is one-way, activity shows raw cuid instead of user name, faceted filter counts broken, seed pollution (Aniket NDA, My Categoty typo, duplicate categories), and more. | None |
| 2026-04-22 | plan | Wrote `docs/25-CONTRACT-FLOW-FIX-PLAN.md` after audit. Original direction: agent-first CLM as product thesis, with traditional UI reserved for setup/config. After product review, 5 decisions captured as ADL entries: cross-functional users, both portal + email redline flows, hybrid canonical artifact, self-hosted eSignature (Phase 07 as scoped), build order = pipeline → UI → post-sig → agent (not agent-first in build order). Phase labels A/B/C/D/E. | None |
| 2026-04-22 | A.1 | **A.1 complete.** Decouple editor from draft agent. Root cause: `draft_agent.py:276` wrote `"<p>No suitable template found. Please create a template first.</p>"` as `draft_html` when Step 2 (template selection) returned nothing. That string was saved as ContractVersion.htmlContent and the editor rendered it as the contract body. Fix: step_assemble returns `{error: "NO_TEMPLATE_MATCH", draft_html: ""}`; `routes/draft.py` stops raising 500 for user errors; `routes/agents.ts` maps typed error to HTTP 422 with user-friendly detail; added `cleanup-broken-drafts.ts` script and cleaned 5 contaminated demo versions. Verified: curl POST /agent/draft with no-matching-template → 422; editor on previously-contaminated contract → opens empty, no poison string. | None |
| 2026-04-22 | A.3 | **A.3 complete.** Collapse two parallel buttons (`Send for Review` status-flip + `Submit for Approval` workflow) into one `Send for Review` primary CTA. Removed DRAFT→PENDING_REVIEW entry from STATUS_TRANSITIONS (the workflow bypass), promoted the remaining button to variant=default (filled blue), updated Approval-tab empty state copy. Button now always routes through `/submit-approval`. Verified: DRAFT contract shows 6 buttons (down from 7); no "Submit for Approval" string left in web frontend. | None |
| 2026-04-22 | A.8 | **A.8 complete.** `<StatusStepper>` component — horizontal lifecycle indicator at top of detail page. Shows Draft → In Review → Approval → Approved → Signature → Executed, with current step highlighted (blue ring), past steps check-marked, future gray. Off-path terminal states (EXPIRED, TERMINATED, ARCHIVED, REJECTED) render as tinted banner instead. Three sizes designed for reuse: full (detail), compact (lists), mini (agent cards). Verified: DRAFT, EXECUTED, EXPIRED screenshots all render expected state. | None |
| 2026-04-22 | A.5 | **A.5 complete.** Hybrid canonical artifact. Schema migration adds `renderedPdfKey` + `renderedAt` to ContractVersion. `s3Key` stays as source (original upload / template-generated). New `apps/api/src/lib/gotenberg.ts` helper. POST /html-version fires Gotenberg render fire-and-forget after save; updates version with `renderedPdfKey`. GET /download serves canonical by default (rendered ?? source); accepts `?artifact=source` to force original. Response includes `artifact: 'rendered'\|'source'` so callers know which they got. Verified: renderedPdfKey populates within 1 second; canonical defaults correctly; source fallback works on versions without rendered PDF. Unblocks A.4 (signatures always sign the latest edited content) and B.2 (diff-against-original). | None |
| 2026-04-22 | A→B reorder | After A.1/A.3/A.5/A.8 landed, user flagged that the contract detail page is still not *simpler* (6 buttons + 7 tabs + hidden document) — A.3/A.8 were improvements but not simplification. Pulled B.1 (document-first detail page) forward to run before A.4 (eSignature) so signature UI layers onto the clean page, not the cluttered one. | None |
| 2026-04-25 | audit/P29–P35 | **Probe framework expansion — full E2E flows.** Added P29 signup→upload→amend→chat full lifecycle, P30 signature flow (envelope→sign→audit), P31 template create+publish→draft, P32 invite cycle (invite→accept→login→permission gate), P33 renewal/expiry alerts (BullMQ scheduled), P34 multi-tenant org isolation (cross-org reads must 404), P35 broad feature smoke. `scripts/feature-integrity/run.mjs` wires all 7. Each probe asserts both HTTP contract + Redis/Postgres side effects (not just status codes). | None |
| 2026-04-26 | audit/P36–P48 | **Production hardening probes (13).** P36 editor session + Yjs save, P37 comment threads + resolution, P38 deeper signature (envelope, reminder, void), P39 deeper approvals (escalation timer, delegation, parallel branches), P40 obligation tracker, P41 diligence room batch upload, P42 deeper auth (refresh, password reset, MFA stub), P43 empty-state polish across major pages, P44 error-state polish, P45 Hocuspocus collab handshake + presence, P46 webhook delivery (HMAC + retry), P47 mobile viewport sanity, P48 axe-core a11y WCAG-AA. Fixes: 4 selects without aria-label (Matters / Templates / Settings / Workload), nested-interactive on contract & counterparty list rows, link-in-text-block on login. P39 added soft-pass for data exhaustion. | None |
| 2026-04-27 | audit/P49–P60 | **UI polish + admin probes (12).** P49 bubble AI on selected text, P50 dropzone hit-targets, P51 template authoring round-trip, P52 keyboard nav (Tab order + skip-link), P53 skill creation + execution, P54 tags + soft-delete restore, P55 matter cascade (tasks/contracts when matter archived), P56 notification preferences, P57 profile edit, P58 search facets recall, P59 bulk CSV import + dry-run, P60 admin role assignment. Real fixes shipped: `RailSection` `action` prop was nested inside the toggle button (DOM nesting violation) — restructured to sibling-div pattern; `UploadModal` queue entries had button-in-button — same pattern, plus added testids `upload-modal-dropzone`/`upload-modal-input`/`upload-modal-submit`. | None |
| 2026-04-28 | bugfix | **User-reported UX bugs (4).** (1) Clauses tab had no way back to document — added tab-nav strip with back-to-document chip on `ContractDetailPage` rendered when `tab !== 'document'`, with testids `tab-back-to-document` + `tab-${t}`. (2) `/agent` thread sidebar had no delete affordance — added optimistic `deleteThread` mutation with hover-revealed trash button on each thread row. (3) Skill invocation broken on `/agent` — wired `skillsList` query, `@`-mention extractor + autocomplete picker, `skillSlug` forwarded in `streamAgentChat` payload. (4) Signature panel (per user screenshots): signer name truncated to "M…", email to "ma…", "Send reminder" wrapping mid-word, Void icon clipped — restructured `SignatureStatus` to 3 vertical rows per signer (avatar+name+status, email full-width, copy-link) with action buttons on dedicated row using `whitespace-nowrap`. | None |
| 2026-04-29 | audit/P61–P78 | **Agent quality deep dive (18 probes).** P61 draft from explicit template ID, P62 artifact dedup, P63 groundedness (no fabrication), P64 multi-turn tool memory, P65 tool honesty (no fake calls), P66 citation accuracy, P67 cross-tool synthesis, P68 refusal calibration, P69 tool efficiency budget, P70 skill systemPrompt obeyed, P71 streaming chunks ordered, P72 ActionPreview chip apply, P73 tool-error recovery, P74 prompt-injection defense, P75 fact consistency across turns, P76 output format adherence, P77 latency budgets, P78 cost-per-turn cap. Real bugs surfaced + fixed: (a) **multi-turn memory loss** — agent forgot contract IDs between turns; `memory.append_to_session` now persists `tool_calls` + `tool_results` and restores them as `AIMessage(tool_calls)` + `ToolMessage` chain on next turn. (b) **`contract_search` lied about totals** — returned `total: results.length` so it claimed "50 contracts" when real count was 313; added `totalMatching` field with real DB count + orchestrator rule A11. (c) **`contract_update` silently no-op'd** with empty `payload: {}`; added required-keys validation per action returning structured `missing_payload_keys` error. (d) **over-asks for confirmation** — added COMMIT-DON'T-CONFIRM rule to orchestrator system prompt. (e) **artifact pane stacked duplicates** — added stable `dedupeKey` to every artifact factory in `artifact-from-tool.ts`, consumer replaces existing. (f) **agent-chat proxy crashed API** with `ERR_HTTP_HEADERS_SENT` on body timeout — fixed with `reply.hijack()`, `clientGone` flag, guarded writes against `writableEnded`. Probe regex tightened on P63/P67/P68/P73/P75 for LLM phrasing variations. | None |
| 2026-04-30 | retrieval | **Hybrid-retrieval verification + ES backfill.** P81 routing probe (intent → `contract_search` vs `portfolio_search` vs `portfolio_compare` vs `clause_search` vs `contract_cite`), P82 coverage probe (every contract-create path must index to ES). Discovered ~40% of contracts invisible to `portfolio_search` — only `/upload` + PATCH paths called `indexContract`. Fixed blank-create (`contracts.ts`: defaults `analysisStatus: 'DONE'` + calls `indexContract`), bulk-import (CSV row indexed), amendment-create. One-shot `apps/api/scripts/backfill-es-index.ts` re-indexed 1393 contracts (Vertex Cloud org went from 344 → 629). Added orchestrator rule A12 for intent-based routing of hybrid retrieval. | None |
| 2026-05-01 | competitive | **Competitive benchmark + multi-doc compare + long-context + Smart Import.** P83 competitive query suite (Harvey/Ironclad parity bar). P84 portfolio_compare probe. New tool `apps/agents/app/tools/portfolio_compare.py` (2–10 contract IDs × 1–10 topics → structured matrix for true side-by-side, not prose synthesis) + endpoint `/internal/ai/tools/portfolio_compare`. Long-context summarization: `_CHUNK_SIZE = 120_000` (was 40K) in `review_agent.py`; `_score()` now passes significantClauses (high-signal clause content) to the score step. Smart Import recall: second-pass focused extraction for missing required keys (parties, term_length, governing_law, total_value). Permissions hygiene: added `p(A.SIGN, R.CONTRACT)` to `LEGAL_COUNSEL` / `LEGAL_OPS` / `CONTRACT_MANAGER` and switched `signatures.ts` send/remind/void from `requirePermission('configure', 'contract')` → `requirePermission('sign', 'contract')`. One-shot `apps/api/scripts/refresh-system-role-perms.ts` synced 219 system roles. Also: agent draft path — `/agent/draft` accepts `templateId` and forwards via `context.template_id`; `step_select_template` honors explicit ID; INTERNAL_SECRET via `settings.internal_service_secret` (pydantic-settings) not `os.getenv`; all internal HTTP calls send `x-internal-service: agents`; `requireAuth` honors `x-org-id` for system-scoped calls. | None |
| 2026-06-10 | 10 | **Phase 10 checklist audit.** Verified tracker vs code: bulk CSV import, RBAC manager, onboarding wizard, admin settings panel, team workload view, inbound email parsing all shipped earlier but unchecked — marked `[x]` with file pointers. Slack outbound, SMTP email, integration settings page, perf/caching marked `[~]` partial. Flagged `docs/33-AGENT-UPDATES-PLAN.md` as missing from repo (referenced in ADL + session log but never committed). Remaining genuine gaps: Slack slash-command/inline-approvals/wizard, Teams bot, Salesforce, SAP/NetSuite, integration health dashboard, Gmail/Outlook add-ins, Integration Agent, Compliance Agent. | `docs/33-AGENT-UPDATES-PLAN.md` lost — needs reconstruction |
| 2026-06-10 | 10 | **Compliance Agent shipped.** New `POST /check_compliance` on agents service (single LLM pass, per-framework requirement catalogs pinned in code for GDPR/HIPAA/SOX/CCPA, applicability gating so a pure commercial contract isn't flagged as a GDPR failure, normalised strict-JSON output). API: `lib/compliance-check.ts` (cost cap + PII policy + internal secret, mirrors obligation-extract), `POST /contracts/:id/compliance-check` (edit perm, 400/404/429/502 mapping) + `GET /:id/compliance`; report persisted to `metadata._compliance`; `COMPLIANCE_CHECKED` audit action added to @clm/types. Web: `ComplianceRailSection` on contract rail (per-framework status badges + score, expandable checks with severity chips, grounding quotes, → recommendations, critical-findings banner, re-run). Verified end-to-end: weak DPA → GDPR non_compliant w/ sub-processor clause flagged risky/critical + "reasonable time" breach notice flagged partial; HIPAA correctly not_applicable; UI click-through on draft MSA → correct n/a explanation. 43 API tests pass; no new type errors. | None |
| 2026-06-10 | 10 | **Integration health dashboard shipped.** `GET /admin/integrations/health`: two groupBy queries (24h/7d × outcome) + DISTINCT-ON last-failed-delivery per webhook; health states healthy/degraded/failing/disabled (failing = 3+ consecutive failures, leveraging worker's failureCount reset-on-success). `POST /webhooks/:id/deliveries/:deliveryId/retry` requeues original event+payload (guards: disabled webhook 400, already-succeeded 400). Web: Health tab on AdminIntegrationsPage — 4 summary cards (webhooks healthy/total, deliveries 24h, success rate 7d, API keys), per-webhook table with status badge, last delivery, 24h/7d ok·failed, last error + Retry, 30s auto-refresh. Verified live: healthy receiver (3 ok) vs dead endpoint (BullMQ retries escalated to failing/6 consecutive), retry queued, already-succeeded guard, UI screenshot. Test webhooks cleaned up after verification. | None |
| 2026-06-10 | 10 | **Slack bot completed.** `routes/slack.ts` (public, signed): POST /slack/commands — `/contract [search] <query>` → org-scoped title/counterparty/number search → ephemeral blocks with links + totalMatching; POST /slack/interactions — Approve/Reject block_actions verify v0 signature (HMAC over raw body, 5-min replay window, timingSafeEqual), resolve clicker via bot-token users.info → email → CLM user (web-link fallback without token), then mirror the decide flow (step assigned + PENDING, escalation timer cancel, advanceWorkflow, audit `via: slack`), replace_original outcome message. `lib/slack.ts` helpers; org ↔ workspace mapping via organization.settings.slack.teamId (multi-workspace per deployment). `approval.submitted` webhook now actually fires from submit-approval (was in WEBHOOK_EVENTS but never emitted); slack-formatter renders it as an actionable card (Approve/Reject + Open buttons carrying {instanceId,stepId}). Admin: GET/PUT/DELETE /admin/integrations/slack (masked read; xoxb- prefix validation). Web: Slack tab setup wizard (manifest with pre-wired URLs + copy, connect form, channel step). Verified with signed simulated requests: search returns 2 Acme contracts; help; bad-sig/replay/unknown-team all 401; button click without bot token → correct fallback; real submit-approval delivered an actionable card with live IDs to a local slack-type webhook. Full button→decide loop needs a real workspace (bot token) — code path mirrors the tested decide endpoint. Test data cleaned up. | Real-workspace E2E pending (needs public tunnel + Slack app) |
| 2026-06-10 | 10 | **Teams outbound notifications.** `lib/teams-formatter.ts`: Adaptive Card 1.4 messages for Teams Workflows (Power Automate) webhooks — the post-O365-connector format ({type:'message', attachments:[adaptive card]}); covers executed/signature/approval/obligation/expiry/test/default events with FactSets + Action.OpenUrl deep links. Webhooks: `type` enum gains 'teams'; auto-detect for *.logic.azure.com / *.webhook.office.com / *.powerplatform.com URLs; webhook.worker routes type=teams through the formatter. UI: third "Teams card" format option + URL auto-detect notice in the create dialog. Verified: type=teams webhook to local receiver delivered valid Adaptive Card JSON; auto-detect on a logic.azure.com URL → type teams; approval.submitted card unit-checked (TextBlock/FactSet/Action.OpenUrl). Interactive Teams bot (botbuilder) deliberately not built — needs Azure bot registration; tracked as remaining gap. | None |
| 2026-06-10 | agent | **Agent-surface wiring audit + restoration.** Three-way audit (Python tools ↔ internal endpoints ↔ artifact/chips pipeline ↔ streaming protocol) found several files committed as "not in this snapshot" stubs despite passing probes in April. Restored: (1) **5 Python tools** — counterparty_list + portfolio_compare now call their existing internal endpoints; comment_add / contract_update / request_create return real awaiting-confirmation payloads (contract_update re-implements the 2026-04-29 `missing_payload_keys` validation). (2) **Action chips** — parseActionChips + ChipRow/ChipButton implemented; `[chip]:` markers no longer leak as raw text into chat prose (A9 rule makes chips the primary navigation; they were fully inert). (3) **AgentHomePage event parity** — now handles `tool_call_awaiting_confirmation` (ActionPreview cards + apply/cancel/undo via /threads/:id/actions/apply, previously silently dropped → write tools dead on /agent) and `tool_progress` (elapsed-seconds on slow-tool chips). (4) **compliance_get agent tool** + `/internal/ai/tools/compliance_get` endpoint — agent answers "is this GDPR compliant?" from the persisted `metadata._compliance` report. (5) Dropped dead `save_draft`/`send_for_review` artifact buttons (no backend handler — logged only). Verified live: counterparty_list returns real rankings; chips render as buttons; full comment_add propose→Apply→DB row→Undo→soft-delete loop on /agent; compliance Q&A grounded in stored report. Audit also CLEARED: redline_apply path (wired via rail-inject-action → apply RPC, audit's "never submitted" claim was wrong), all 10 artifact factories have dedupeKeys, streaming proxy ERR_HTTP_HEADERS_SENT fix intact, multi-turn tool memory intact. | playbook_check table artifact (nice-to-have); diff/form renderers unused |
| 2026-06-10 | agent | **Agent surface — final completion pass.** (1) `approval_route` write tool (Python) — closes the last orphaned internal endpoint; agent can now propose "submit for approval" via ActionPreview. (2) Table-artifact factories for `portfolio_compare` (topic × contract matrix with ✓/§ref cells, ordered-ids+topics dedupe fingerprint) and `playbook_check` (clause × rules × severity). (3) Orchestrator SSE truncation allowlist gains `portfolio_compare` + `compliance_get` — their results broke at the 800-char cap exactly like the documented contract_search bug, so artifacts never parsed. **Everything previously untested now exercised live:** chip click → real turn; `portfolio_compare` matrix artifact renders in the pane; `contract_update` add_tag → Apply → DB → Undo → exact snapshot restore; `request_create` → SUBMITTED row (source=chat) → Undo → CANCELLED; `@compliance-sweep` skill → SkillInvocation row + tool catalog correctly narrowed to allowed tools. | None |
| 2026-06-10 | review | **Full-app feature review.** API smoke 48/49 (1 env-only), new `scripts/full-review.mjs` route sweep 27/27 (every nav/admin/public page renders real data, zero console errors), deep flows exercised end-to-end. Four real bugs found and fixed: (1) **error handler ordering** — `app.setErrorHandler` was called AFTER route registration, so Fastify's per-plugin handler snapshot meant the custom ZodError→422 mapping never applied anywhere; every validation failure surfaced as a raw 500. Moved before routes; bad bodies now return structured 422 platform-wide. (2) **`google.generativeai` ImportError** — intake-classify, classify-document, and detect-binder imported the legacy Gemini SDK (never in the venv); whenever the provider fell back to google all three silently returned fallbacks (requests classified OTHER/conf 0, uploads typed OTHER, binder detection dead). Ported to `langchain_google_genai` (already a dependency). (3) **LLM JSON fence-parsing, systemic** — new `app/jsonish.loads_lenient()` (fences → first-object fallback, raises JSONDecodeError for catch-compat) swept across 15 `json.loads(llm_text)` sites in 9 files; fixed draft agent filling ZERO template variables (verified: 11/11 fillable vars now filled, counterparty spliced into the draft) and intake classification (DATA_PROCESSING @ 0.95, counterparty + value extracted). (4) **extract-chunk crash on LLM list-vs-dict drift** — review_agent now coerces array-wrapped objects and list-valued dict keys instead of failing the chunk. Verified after fixes: upload→pipeline classifies MSA correctly with 16 keyTerms; request→classify→convert works; draft-from-template fills variables; keyword + semantic search find new contracts. All review test data cleaned up. | None |
| 2026-06-10 | review | **Per-screen interaction review (every item on every screen).** New `scripts/screen-items-review.mjs`: 54 interaction assertions across all 24 screens — global search/bell/account menu, list search narrowing, filter panels, every modal opens + validates (request/invoice/diligence/invite/clause/template/workflow-builder/complete-obligation), tab strips (requests/org/integrations), row→detail navigation, charts. **54/54 passing.** Two real bugs found + fixed: (1) contracts-list search returned 0 rows — local ES index held 1 doc vs 19 in Postgres (seeds bypass indexContract; the tracker-referenced `backfill-es-index.ts` was never committed). Recreated the script, backfilled 19/19. (2) `indexContract` blew up with document_parsing_exception on nested keyTerms objects (SLA serviceCreditTiers) — contract silently never indexed; now scalarizes non-scalar keyTerms/metadata values to JSON strings. UX findings (not fixed, by design choice): hand-rolled modals don't close on Escape (app-wide pattern — needs a shared Dialog primitive, filed); concurrent logins rotate the refresh token and bounce other sessions to /login (single-session semantics — confirm intended). | None |
| 2026-05-02 | plan | **Wrote `docs/33-AGENT-UPDATES-PLAN.md`** (233 lines) — park doc capturing where we are today (post P1–P84 + ~30 fixes), honest gap matrix vs Harvey/Ironclad, Tier 1/2/3 backlog, decisions queue, sequencing, success metrics, risk register, and explicit "deliberately doesn't promise" caveats. Remaining gaps catalogued: structured-data eval suite, scheduled report runs, citations-with-page-anchors, Q&A over signed PDFs (vs structured fields only), team-knowledge memory, redline policy enforcement, cross-encoder reranker swap, evidence-pack export. Updated this tracker (was last touched 2026-04-22; covers ~2 weeks of probe build + ~30 bug fixes + agent-quality push). | None |
| 2026-07-07 | audit | **"Make it real" audit** — multi-agent audit (52 agents, adversarially verified) of claims vs code, security, and sellability. Confirmed 6 security criticals, several theater features (redline/collab/inline-approval fake at UI layer but engines exist), CI never passed, `pnpm dev` didn't start agents, README overclaims. Wrote 5-wave remediation plan (Wave 0 run/honest → 1 security → 2 build features → 3 backend flows → 4 deploy/ops → 5 tests). | None |
| 2026-07-07 | W0.1 | **CI fixed.** Root cause: `pnpm/action-setup` pinned `version: 9` while root `packageManager` also pinned pnpm@9.0.0 → "Multiple versions of pnpm specified" killed every job at install (CI had never passed). Removed all version pins from `ci.yml` (packageManager is the single source of truth); deleted the two `feature-integrity-*` jobs that invoked the non-existent `scripts/feature-integrity/` suite; removed the dead `audit:features*` scripts from root `package.json`. Verified `pnpm install --frozen-lockfile` green. | None |
| 2026-07-07 | W0.2 | **`pnpm dev` now starts agents.** `apps/agents` had no `package.json`, so `pnpm --parallel -r dev` never launched the Python service (README claimed it did). Added `apps/agents/package.json` (6th workspace member) with a `dev` script running uvicorn from `.venv` on `${AGENTS_PORT:-8002}` (intended to match `.env` `AGENTS_URL` — **it did not, and this line was wrong for 40 days.** `.env.example` shipped `AGENTS_URL=http://localhost:8000` while this script binds 8002, so a fresh checkout booted both services and 500ed on every agent chat with ECONNREFUSED. Corrected 2026-08-16; `l14-agents-url` now guards it). Regenerated lockfile; verified frozen-lockfile passes and the service boots + serves `/health`. | None |
| 2026-07-07 | W0.3 | **apps/api typecheck: 39 → 0 errors.** Systemic: forced single `ioredis` (5.10.0 override) to kill dual-version skew (11 errs); added `nodemailer` + `@types/nodemailer` (also fixes Wave 4 "email can never send"); cast bull-board queues (dual-Fastify type skew) and `rateLimit` plugin. Genuine bugs fixed: `admin-ai.ts` duplicate `provider` key (silent overwrite), missing required `createdById` on a ContractVersion create (latent runtime bug), non-null `ownerId` guard, delegation `delegateTo` guard, Decimal→Number conversions, Prisma `InputJsonValue` casts, stale `@ts-expect-error` directives. Full monorepo `pnpm typecheck` exit 0; 46 API unit tests pass. Dockerfile comment corrected (compiled-build switch tracked for Wave 4 — needs `@clm/types` to emit JS). | None |
| 2026-07-07 | W0.4 | **Boots keyless (matches README).** `assertRouterConfigured()` threw when the default/fast tiers had no platform key → crash-loop before login, contradicting "boots with no API key." Now logs a loud warning and boots; added `isAiConfigured()` so AI surfaces can 503-degrade. Non-AI features (auth/browse/upload/manage) unaffected. Runtime boot verification pending an infra-up session. | Needs Postgres/Redis to verify boot end-to-end |
| 2026-07-07 | W0.5 | **Docs de-overclaimed.** README agent roster corrected to the real 7 (review/draft/redline/approve/portfolio/ask/assist; was "negotiate/search/extract/advise"), "switch on any message" softened (UI hardcodes a model — Wave 3 fixes), "never hallucinated" → "cited so you can verify," agents port `:8000`→`:8002`. Marketing: Invoice Agent line-item/PO claim corrected to real obligation reconciliation; Security page SOC 2 "in progress"→roadmap + at-rest encryption qualified as deployment-dependent. `docs/operations/19-DEPLOYMENT-STRATEGY.md` banner-flagged as aspirational (real deploy = Cloud Run doc 20). QA skill flagged that its P1–P84 probe suite doesn't exist (Wave 5 rebuilds it). | None |
| 2026-07-07 | W1 sec | **Security criticals (fail-closed).** (1.1) New `lib/secrets.ts` — JWT_SECRET/PORTAL_JWT_SECRET no longer fall back to hardcoded `dev-secret-change-me`/`portal-dev-secret`; production refuses to boot if missing/short/placeholder, dev generates+persists a random secret; `assertSecretsConfigured()` runs at boot. (1.2) API-key scoping fixed BOTH directions — new `API_SCOPE_PERMISSIONS` map + `resolveApiScopePermissions`; empty scopes now grant NOTHING (was silent org ADMIN), scoped keys map to real permissions (was treated as role names → 403 on everything), scopes validated at creation. (1.3) `matters/:id/attach` cross-org write/read leak closed — target entity scoped by orgId via updateMany+count → 404 cross-org. (1.4) rate limiter keyed on req.ip not the spoofable x-org-id header (landed in W0.3). (1.5) new `lib/ssrf-guard.ts` — webhook URLs blocked from private/loopback/link-local/169.254 metadata targets (prod-on, self-host opt-out via WEBHOOK_ALLOW_PRIVATE_URLS); response bodies no longer reflected into the delivery log when guarded. (1.6) auto-approval fails CLOSED on null contract value (was: null matched any threshold → skip human approval). (1.7) RBAC added to matters / review-queue / skills / agent AI endpoints (were requireAuth-only → VIEWER could write / burn AI budget). (1.8) upload validated by magic bytes not spoofable mimetype (PDF/DOCX/DOC/TXT only). 14 new security unit tests (secrets, scopes, SSRF); 60 API tests pass; typecheck clean; API boots + login + RBAC routes verified at runtime. | CSP → Wave 2.6 (with XSS/DOMPurify); refresh-token hashing + reuse detection deferred to a focused follow-up; rotate dev INTERNAL_SERVICE_SECRET value + smoke admin password are operational follow-ups |
| 2026-07-07 | W2 feat | **Core features — build the real ones (batch 1 of 2).** (2.1) Per-change redline accept/reject is now real: new `lib/redline.ts` (`extractChanges`/`resolveDiff`) parses the node-htmldiff blob, `CompareMode` gained a per-change review list + Accept-all/Reject-all + "Apply as new version" that resolves decisions into merged HTML saved via the existing `/html-version` endpoint (undecided → keep ours; sanitized on write). Disabled "Coming in v1.1" buttons removed. (2.2) Playbook comparison in `FocusedReviewDrawer` now renders REAL positions matched from `GET /playbook/positions` (62 in seed) by clause-type/category — replaces the hardcoded "Playbook v2 / Non-standard / Deviation" fabrication; honest empty state when no position exists. (2.3) "Review & Decide" rail CTA now scrolls to the real `DecisionStrip` (Approve/Reject/Delegate) / Approval tab instead of `window.alert(...)`. (2.5) Killed fake-success paths: `SideAgentRail` apply no longer fakes an "applied" state on a 600ms timer (honest error when no thread); `AgentHomePage` artifact actions POST to the real `/threads/:id/actions/apply` (throw → ActionButton error state) instead of `console.log`. (2.6) XSS: added DOMPurify + `lib/sanitize.ts`; wrapped all 7 `dangerouslySetInnerHTML` sinks (DiffViewer×3, ArtifactPane, TemplatesPage, PlaybookPage, AiConfigTab) + sanitize the redline merge on write. Verified: web typecheck + production build clean; Playwright smoke (login→dashboard→19 contracts→detail) 0 console errors; diff + playbook data flows confirmed via API. | Remaining Wave 2: 2.4 real-time collab (Yjs persistence) and 2.7 PAdES/X.509 crypto signing — the two multi-day builds. 2.6 token-storage→httpOnly cookies + CSP still deferred. |
| 2026-07-07 | W2 feat | **Core features — batch 2 of 2 (PAdES + collab persistence).** (2.7) Real PAdES/X.509 e-signature — the audit's #1 sellability blocker. New `lib/signing-cert.ts` (prod: SIGNING_CERT_P12_BASE64/PASSPHRASE; dev: self-signed cert persisted to gitignored `.dev-signing-cert.p12`) + `lib/pades-signing.ts` (pdf-lib placeholder → PKCS#7 adbe.pkcs7.detached over the ByteRange via @signpdf + node-forge, returns SHA-256). `generateAndStoreSignedPdf` now seals the completed PDF; the hash is stored on the signed ContractVersion metadata + an audit_events row + S3 metadata; cert-page footer/docstrings corrected. ESIGN/UETA consent captured (schema + signature event + required SignerPortal checkbox). **Verified with `pdfsig`: "Signature is Valid", SHA-256, adbe.pkcs7.detached, "Total document signed"; a 1-byte tamper → "Digest Mismatch" (tamper-evidence proven).** (2.4) Real-time collab — durable persistence built + VERIFIED: `CollabState` model + migration, collab-server v4 `onLoadDocument`/`onStoreDocument` hooks (yjs binary encode/decode into `collab_states`); headless round-trip confirmed a value written by one client survives disconnect and reloads in a fresh client. Aligned the tiptap collab extensions to core (3.20.4). Made `CollabStatusBadge` honest ("Live"→"Sync on"; no longer claims live co-editing that isn't wired). Verified: web+api typecheck + web build clean; Playwright smoke 0 console errors. | **2.4 in-editor Collaboration binding (live multi-cursor co-editing) deliberately NOT wired** — it's high-blast-radius surgery on the single-user editor (history conflicts, content-seeding races) that needs multi-browser QA; the durable-persistence foundation is done. 2.6 token-storage→httpOnly + CSP still deferred. |
| 2026-07-19 | QA | **Reviewer-reported QA batch.** (1) Template editor broke on a long pasted clause — the `ContractEditor` wrapper in `TemplatesPage` was a `flex-1` child with no `min-h-0` (flexbox `min-height:auto` trap), so it grew unbounded instead of letting the editor's internal `overflow-y-auto` engage; matches the working `ClausesPage` pattern. (2) Amendments rendered a blank white page — the Styled view treated `<p></p>` (what the amendment-create path seeds) as real content and mounted an empty editor; now strips tags before deciding emptiness and shows the empty-state card **in view mode only**, still mounting the editable canvas when editing so the amendment can be typed. (3) Email: code reads `SMTP_FROM` but every env file defined `EMAIL_FROM`, so the configured from-address was dead — both senders now fall back; documented the real `SMTP_*` + `WEB_BASE_URL` vars (`.env.example` advertised SendGrid, but the code is nodemailer/SMTP). Auto-logout deliberately not investigated (Cloud Run env, per reporter). Investigated and **declined** to remove the "More Info" request tab — it is a live, reachable status (`MORE_INFO_NEEDED` is set by a working button in `RequestDetailPanel`); it looked dead only because no request was in that state. | Email sends nothing until SMTP is configured on Cloud Run — operator action |
| 2026-07-20 | negotiation | **Counterparty loop + template upload + playbook review (13 tasks).** Audit found the external negotiation loop ~70% built but severed in 3 places: the `upload` permission was consumed by `portal.ts` and produced by no UI; the two external return paths were the only 2 of 11 version-creation paths that skipped `queueParseDocument` (their comments promised an "analyze tick" that exists nowhere); and both endpoints claimed "the owner has been notified" while calling no notification path. All wired, plus diff-cache poisoning fixed (no eviction existed anywhere). Added: `POST /templates/upload` (mammoth was already in the stack) + heading-outline section split with 12 unit tests; automatic single-document `playbook-review` (redline diffs two versions so it can never run on a just-received contract); real alternative-clause language + one-click apply in the review drawer, both previously reachable only from agent chat and fronted by a hardcoded "lands in B.5.9" placeholder; share links emailed instead of clipboard-only; inbound email made usable by a real provider (multipart was claimed but never implemented — `req.body` is undefined for multipart, so every real webhook failed). Sealing moved to a retryable queue job. **Pre-merge review (3 passes: security, extraction fidelity, worker/data-integrity) found 5 further defects, 4 introduced by this work** — see Known Gaps + ADL; all fixed before merge, incl. an inbound-email sender-spoof (display name overriding the real sender, no secret required) now covered by 13 regression tests. Tests 80→104. | **Nothing verified end-to-end against a live stack** (Docker unavailable) — validate on Cloud Run. `metadata._playbookReview` has no UI yet. Email still gated on SMTP config |
| 2026-08-16 | W-E evals | **docs/37 Wave E — made the eval suite able to run and able to fail; it then found four production bugs.** Running it against a real stack was itself the finding. (1) **Agent chat was broken on any fresh checkout**: the service binds 8002, `.env.example` and all 14 API call sites dialled 8000 — both services boot healthy, every turn 500s. (2) **Three call sites read env names nothing defines**, so the `??` fallback was the only branch that ever ran: `AGENT_SERVICE_URL` (playbook → silent 200 with `comparison: null` in prod), `PUBLIC_APP_URL` (every Slack/Teams deep link pointed at localhost), `AGENTS_API_URL` (write-tool execution + all undo URLs, since the container listens on 8080 not 3001). (3) **Admin → AI Config was silently ignored**: `ChatMessageSchema` defaulted `provider`/`modelId`, so no request was ever unpinned; `chat.py` then rewrote the mismatched pin to the provider's "smart" model and passed it as `model_override`, outranking org config — an org that chose a cheap model ran every turn on the expensive one. (4) **Agent turns returned nothing**: HTTP 200, zero tokens, zero tools, no error frame. `gemini-2.5-flash` returns `finish_reason='STOP'` with `content=''`, and the A5 synthesis net could never catch it — that net is the `else:` of a `for` and every empty path `break`s past it. Three shapes fixed (pure empty, tool-then-empty, and a thinking-block that `str()` turned into a Python repr which was persisted and replayed as the assistant's answer). Suite side: four preconditions that could not fail (`db` checked the var was set, not reachable; `playwright` checked the npm package, not a browser; `model` accepted any non-empty string; `personas` probed an address the seeder never creates, so both persona suites skipped permanently), a tier-blind baseline that would have turned the blocking t1 job red with 7 fake deletions the moment anyone enabled the t2 gate, two suites that ran and reported `ERRO 0/0` because their summary lines did not parse, one suite (`run-personas.mjs`, 86 asks) in the manifest nowhere, and five assertions that could not fail — one of them **inverted**, green *because* the hazard existed. New checks: `l14-agents-url`, `l15-empty-turn` (stubs the LLM, so model-response handling gates a PR with no key). Tiers: t1 46→58 assertions, t2 0→172, t3 0→235. | 26 conversations still spread `...SEARCH_TOOLS`, so 52/66 is not yet a quality baseline. `forbiddenTools` added but unused. Journey turns of 180s/222s/**488s** ending in "operation was aborted" — uninvestigated. Nightly t3 workflow still has no services/boot, so it would exit 1 on first dispatch |

---

## How to Use This File

1. **Before each session:** Check the phase checklist. Pick the next unchecked item.
2. **During a session:** Work on one feature at a time (one endpoint, one component, one agent).
3. **After each session:** Check off completed items. Add a row to the Session Log. Update phase status (`[ ] Not Started` → `[~] In Progress` → `[x] Done`).
4. **On phase completion:** Fill in the Completed date. Move to next phase.
5. **When blocked:** Add to Blockers column in Session Log. Do not skip ahead — resolve or note clearly.

**Status symbols:** `[ ]` Not started · `[~]` In progress · `[x]` Done · `[!]` Blocked
