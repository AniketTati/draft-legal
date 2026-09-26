# 02 — Tech Stack

## Stack Summary

| Layer | Technology | Why |
|-------|-----------|-----|
| **Frontend** | React 18 + TypeScript + Vite | Component ecosystem, TypeScript safety, fast builds |
| **UI Framework** | Tailwind CSS + Radix UI primitives | Utility-first CSS, accessible headless components |
| **Rich Text Editor** | TipTap (ProseMirror) | Collaborative editing, extensible, schema-based documents |
| **Real-time** | WebSocket (Socket.io) + Redis Pub/Sub | Collaborative editing, live notifications, presence |
| **State Management** | Zustand + React Query | Lightweight global state + server state caching |
| **Backend** | Node.js (Fastify) + TypeScript | Fast, schema-validated APIs, same language as frontend |
| **API** | REST (resources) + WebSocket (real-time) + GraphQL (analytics) | REST for CRUD, WS for collaboration, GraphQL for flexible queries |
| **Database** | PostgreSQL 16 | JSONB for flexible metadata, RLS for multi-tenancy, mature ecosystem |
| **Cache / Queue** | Redis 7 | Caching, job queues (BullMQ), pub/sub for real-time, session store |
| **Search** | Elasticsearch 8 | Full-text search, fuzzy matching, aggregations for analytics |
| **Vector DB** | pgvector (PostgreSQL extension) | Semantic search without separate infrastructure; scales with pg |
| **Document Storage** | AWS S3 (or MinIO for self-hosted) | Durable, scalable, presigned URLs for secure access |
| **Analytics DB** | ClickHouse | Columnar storage for fast analytical queries on event data |
| **Agent Framework** | LangGraph (Python) | Graph-based agent orchestration, state persistence, human-in-the-loop |
| **LLM Provider** | Anthropic Claude · OpenAI GPT · Google Gemini | Multi-provider registry (`apps/agents/app/providers.py`). User selects provider + model per session. System agents use OmniModel routing by task complexity. |
| **OCR / Extraction** | Anthropic Claude vision + Tesseract (fallback) | Vision models for PDF/image extraction, Tesseract for bulk processing |
| **eSignature** | Internal signing module — `pdf-lib` + `node-forge` | Zero external vendor. Self-hosted. pdf-lib embeds signature fields; node-forge X.509/PAdES-B signs the PDF. Documenso (open-source) available as a drop-in if richer UI needed. |
| **Email** | SendGrid (transactional) + IMAP listener (inbound) | Reliable delivery, inbound email processing for email-to-request |
| **Auth** | Internal JWT (HS256) — Phase 01. Auth0/Clerk for enterprise SSO/SAML later (Phase 10). | Simple, no external dependency for early phases. JWT access (15 min) + refresh (7 day, rotated). |
| **Monitoring** | Prometheus-format metrics at `GET /api/v1/metrics` (behind `METRICS_TOKEN`), Cloud Error Reporting (5xx events on stderr under Cloud Run), Langfuse (LLM traces), the org audit log (Admin → Audit Log). Grafana dashboards, Sentry and PostHog are not wired up. | What exists today (X3); the rest of the stack below is the plan |
| **CI/CD** | GitHub Actions + Docker + Kubernetes (EKS) | Standard, scalable, multi-environment deployments |
| **IaC** | Terraform | Reproducible infrastructure across environments |

---

## Frontend Architecture

```
src/
├── app/                    # App shell, routing, layouts
│   ├── routes/             # File-based routing (React Router)
│   ├── layouts/            # Shell layout, sidebar, header
│   └── providers/          # Auth, theme, websocket providers
├── features/               # Feature modules (one per domain)
│   ├── contracts/          # Repository, detail, editor
│   ├── requests/           # Intake, queue, detail
│   ├── approvals/          # Approval view, tracker, mobile card
│   ├── negotiations/       # Redline, comparison, external portal
│   ├── obligations/        # Dashboard, alerts, renewal
│   ├── analytics/          # Dashboards, report builder, KPIs
│   ├── templates/          # Template builder, library
│   ├── clauses/            # Clause library manager
│   ├── playbook/           # Playbook editor
│   ├── workflows/          # Visual workflow builder
│   ├── settings/           # User settings, RBAC, integrations
│   └── chat/               # Agent chat panel, conversation flows
├── components/             # Shared UI components (design system)
│   ├── ui/                 # Primitives: Button, Input, Card, Badge, etc.
│   ├── data-display/       # Table, MetricCard, Timeline, StatusBadge
│   ├── editors/            # RichTextEditor, ClausePanel, VariableField
│   ├── navigation/         # Sidebar, Breadcrumb, TabBar
│   └── feedback/           # Toast, Modal, ConfirmDialog, LoadingState
├── hooks/                  # Custom hooks (useContract, useAgent, etc.)
├── lib/                    # Utilities, API client, agent client, formatters
├── stores/                 # Zustand stores (auth, ui, chat)
└── types/                  # TypeScript type definitions
```

### Key Frontend Patterns

- **Feature-based modules**: each feature (contracts, approvals, etc.) is self-contained with its own components, hooks, and API calls.
- **Server state via React Query**: all API data fetched/cached/invalidated via React Query. No manual cache management.
- **Optimistic updates**: approval actions, comment posting, status changes apply instantly with rollback on error.
- **Streaming responses**: agent chat responses stream via SSE. Token-by-token rendering with typing indicator.
- **Responsive by default**: all screens work on desktop (1200px+), tablet (768px+), and mobile (375px+). Mobile-specific screens (SCR-014) have dedicated components.

---

## Backend Architecture

```
server/
├── src/
│   ├── modules/            # Domain modules
│   │   ├── contracts/      # Contract CRUD, versioning, document management
│   │   ├── requests/       # Request intake, routing, queue management
│   │   ├── approvals/      # Approval workflow engine, routing, delegation
│   │   ├── signatures/     # eSignature orchestration, status tracking
│   │   ├── obligations/    # Obligation extraction, monitoring, alerts
│   │   ├── templates/      # Template CRUD, conditional logic engine
│   │   ├── clauses/        # Clause library CRUD, versioning
│   │   ├── playbook/       # Playbook positions, risk thresholds
│   │   ├── workflows/      # Workflow definition, execution engine
│   │   ├── analytics/      # Query engine, dashboard data, report generation
│   │   ├── search/         # Full-text + semantic search
│   │   ├── users/          # User management, roles, preferences
│   │   ├── orgs/           # Organization management, settings
│   │   ├── integrations/   # Connector management, field mapping, sync
│   │   ├── audit/          # Audit trail, event logging
│   │   └── notifications/  # Notification routing, channel delivery
│   ├── agents/             # Agent orchestration (bridge to Python agent layer)
│   │   ├── orchestrator.ts # Routes to appropriate agent
│   │   ├── client.ts       # gRPC/HTTP client to Python agent services
│   │   └── types.ts        # Agent request/response types
│   ├── middleware/          # Auth, RBAC, rate limiting, request logging
│   ├── events/             # Event bus, event handlers, event types
│   ├── lib/                # Shared utilities, DB client, S3 client
│   └── config/             # Environment config, feature flags
├── prisma/                 # Prisma schema and migrations
└── tests/                  # Unit + integration tests per module
```

---

## Agent Layer Architecture (Python)

```
agents/
├── orchestrator/           # Main orchestrator service
│   ├── planner.py          # Task decomposition and planning
│   ├── router.py           # Route to specialist agents
│   ├── state.py            # Workflow state management
│   └── replan.py           # Error handling and re-planning
├── agents/                 # Specialist agents
│   ├── intake_agent.py
│   ├── draft_agent.py
│   ├── review_agent.py
│   ├── redline_agent.py
│   ├── approval_agent.py
│   ├── signature_agent.py
│   ├── obligation_agent.py
│   ├── invoice_agent.py
│   ├── search_agent.py
│   ├── compliance_agent.py
│   ├── integration_agent.py
│   └── insight_agent.py
├── tools/                  # MCP tools available to agents
│   ├── contract_tools.py   # CRUD operations on contracts
│   ├── search_tools.py     # Search repository
│   ├── template_tools.py   # Template selection and assembly
│   ├── clause_tools.py     # Clause library access
│   ├── playbook_tools.py   # Playbook position lookup
│   ├── crm_tools.py        # CRM MCP client
│   ├── erp_tools.py        # ERP MCP client
│   ├── email_tools.py      # Email send/receive
│   ├── esign_tools.py      # eSignature API
│   └── notification_tools.py
├── memory/                 # Agent memory management
│   ├── conversation.py     # Short-term conversation context
│   ├── retrieval.py        # RAG pipeline (vector search)
│   └── knowledge_graph.py  # Entity relationship queries
├── llm/                    # LLM provider abstraction
│   ├── provider.py         # OmniModel router (pick LLM by task)
│   ├── claude.py           # Anthropic Claude client
│   ├── openai.py           # OpenAI client
│   └── prompts/            # System prompts per agent
└── config/                 # Agent configuration, autonomy boundaries
```

---

## Communication Between Layers

| From | To | Protocol | Use Case |
|------|----|----------|----------|
| Frontend → Backend | REST + WebSocket | CRUD ops, real-time updates, streaming |
| Backend → Agent Layer | BullMQ jobs (async) + HTTP (sync for chat) | Pipeline jobs queued via BullMQ; agents PATCH results back to API via internal HTTP |
| Agent → Tools/MCP | HTTP | Direct REST calls; MCP planned for Phase 10 |
| Agent → LLM | HTTPS (streaming) | Language model inference |
| Agent → Vector DB | SQL (pgvector) | Semantic search, RAG retrieval |
| Backend → Event Bus | Redis Streams *(Phase 10 — not yet built)* | Event publishing; currently handled by BullMQ queue jobs |
| Event Bus → Consumers | Redis Streams *(Phase 10 — not yet built)* | Notifications, analytics, audit, integrations |
| Frontend ← Backend | WebSocket + SSE | Real-time updates, agent streaming responses |

---

## Development Environment (Docker Compose)

```yaml
services:
  postgres:     # PostgreSQL 16 + pgvector
  redis:        # Redis 7 (cache, queue, pub/sub)
  elasticsearch: # Elasticsearch 8 (search)
  minio:        # S3-compatible storage
  clickhouse:   # Analytics DB
  api:          # Node.js backend
  agents:       # Python agent services
  web:          # React frontend (Vite dev server)
  worker:       # Background job processor (BullMQ)
```

Every developer runs the full stack locally via `docker compose up`. Seed data scripts populate sample contracts, templates, and clauses for development.
