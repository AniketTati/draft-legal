# CLM Platform — Project Index

## What This Is

This is the complete engineering specification for a **New Age, Agent-First Contract Lifecycle Management (CLM) platform**. The platform combines LLM-powered agents that execute contract workflows with contextual visual UI surfaces for oversight, configuration, and collaboration.

These docs complement the `CLM_Complete_Product_Specification.xlsx` which contains the feature registry (75+ features), screen specifications (20+ screens), agent conversation flows, and navigation structure. **This doc set is the engineering blueprint for building it.**

---

## How To Use These Docs

**Read in order for the first time.** Then reference individual files as you build each phase.

1. Start with **Architecture** docs (01–07) to understand the system design, tech stack, data model, agent framework, and design system.
2. Build **Phase by Phase** (08–17). Each phase is self-contained and testable. Don't skip phases — each builds on the previous.
3. Reference **Operations** docs (18–19) for testing and deployment at each phase.

---

## Document Map

### Architecture (read first, build foundations)

| # | File | What It Covers |
|---|------|----------------|
| 01 | `architecture/01-SYSTEM-ARCHITECTURE.md` | High-level system design, layer model, design principles, component map |
| 02 | `architecture/02-TECH-STACK.md` | Technology choices with rationale for every layer |
| 03 | `architecture/03-DATA-MODEL.md` | Complete database schema — every table, every field, every relationship |
| 04 | `architecture/04-API-DESIGN.md` | REST + WebSocket API conventions, endpoint catalog, auth patterns |
| 05 | `architecture/05-AGENT-ARCHITECTURE.md` | Agent framework, orchestration, MCP integration, memory, tools |
| 06 | `architecture/06-SECURITY-GOVERNANCE.md` | Auth, RBAC, audit trail, encryption, compliance, data residency |
| 07 | `architecture/07-UI-DESIGN-SYSTEM.md` | Component library, design tokens, layout patterns, accessibility |
| 20 | `architecture/20-WORKFLOW-EVENTS-ASYNC.md` | Workflow engine, event bus, job queues, scheduled tasks, async architecture |
| 21 | `architecture/21-GAP-FILL.md` | Status state machine, collab editing (Yjs/CRDT), prompt mgmt, portal security, search indexing, notifications, file pipeline, i18n, caching, webhooks, feature flags, tenant provisioning |

### Build Phases (build in sequence, test each phase)

| # | File | Phase | What You Build | What You Can Test |
|---|------|-------|----------------|-------------------|
| 08 | `phases/08-PHASE-01-FOUNDATION.md` | Foundation | Auth, DB, API shell, agent framework, UI shell, nav | Login, empty dashboard, agent responds to hello |
| 09 | `phases/09-PHASE-02-REPOSITORY.md` | Repository & Search | Contract storage, upload, search, detail view | Upload a contract, search for it, view details |
| 10 | `phases/10-PHASE-03-INTAKE.md` | Intake & Requests | Request forms, queue, routing, triage | Submit a contract request, see it in queue, assign it |
| 11 | `phases/11-PHASE-04-DRAFTING.md` | Drafting & Templates | Template engine, clause library, editor, AI drafting | Create template, draft a contract from it, edit in browser |
| 12 | `phases/12-PHASE-05-NEGOTIATION.md` | Negotiation | Redlining, comparison, collaboration, external portal | Upload counterparty doc, see deviations, generate counter-proposals |
| 13 | `phases/13-PHASE-06-APPROVAL.md` | Approval Workflows | Workflow builder, routing engine, approval UX, mobile | Build a workflow, route a contract for approval, approve on mobile |
| 14 | `phases/14-PHASE-07-EXECUTION.md` | Execution & Signing | eSignature integration, signing UX, auto-filing | Send for signature, sign externally, see filed in repository |
| 15 | `phases/15-PHASE-08-POST-SIGNATURE.md` | Post-Signature | Obligations, renewals, amendments, invoice reconciliation | Track obligations, get renewal alerts, create amendment |
| 16 | `phases/16-PHASE-09-ANALYTICS.md` | Analytics & Reporting | Dashboards, report builder, KPIs, compliance packages | View portfolio dashboard, build custom report, export audit package |
| 17 | `phases/17-PHASE-10-INTEGRATIONS.md` | Integrations & Scale | CRM/ERP connectors, Slack/Teams, mobile app, bulk ops | Sync with Salesforce, approve in Slack, bulk import legacy contracts |

### Operations

| # | File | What It Covers |
|---|------|----------------|
| 18 | `operations/18-TESTING-STRATEGY.md` | Test approach per phase, E2E scenarios, agent testing, load testing |
| 19 | `operations/19-DEPLOYMENT-STRATEGY.md` | CI/CD, environments, feature flags, rollout plan, monitoring |
| — | `operations/LANGFUSE.md` | LLM observability — self-hosted Langfuse for local dev, Langfuse Cloud for Cloud Run, what a trace contains, why traces go missing |
| 22 | `22-VIBE-CODING-GUIDE.md` | Practical guide to building this with AI-assisted coding — tool setup, session patterns, prompting patterns, pitfalls, day-by-day plan |

---

## Cross-Reference System

Every feature, screen, and flow has a unique ID that is consistent across the Excel spec and these docs:

- **Features**: `IN-001` (Intake), `DR-001` (Draft), `NG-001` (Negotiate), `AP-001` (Approve), `EX-001` (Execute), `PS-001` (Post-Sig), `SR-001` (Search), `AN-001` (Analytics), `CL-001` (Collab), `CFG-001` (Config), `AD-001` (Admin), `INT-001` (Integration)
- **Screens**: `SCR-001` through `SCR-045`
- **Agent Flows**: `CHAT-001` through `CHAT-010`
- **Agents**: Intake Agent, Draft Agent, Review Agent, Redline Agent, Approval Agent, Signature Agent, Obligation Agent, Invoice Agent, Search Agent, Compliance Agent, Integration Agent, Insight Agent

---

## Phase Dependencies

```
Phase 1 (Foundation) ──────────────────────────────────┐
    │                                                    │
Phase 2 (Repository & Search) ──── Phase 3 (Intake) ───┤
    │                                  │                 │
    └──────── Phase 4 (Drafting) ──────┘                 │
                   │                                     │
              Phase 5 (Negotiation)                      │
                   │                                     │
              Phase 6 (Approval)                         │
                   │                                     │
              Phase 7 (Execution)                        │
                   │                                     │
              Phase 8 (Post-Signature)                   │
                   │                                     │
              Phase 9 (Analytics) ───────────────────────┘
                   │
              Phase 10 (Integrations & Scale)
```

---

## Naming Conventions

| Entity | Pattern | Example |
|--------|---------|---------|
| Database tables | `snake_case`, plural | `contracts`, `clause_library_items` |
| API endpoints | `kebab-case`, resource-based | `/api/v1/contracts`, `/api/v1/clause-library` |
| React components | `PascalCase` | `ContractEditor`, `ApprovalCard` |
| Agent names | `PascalCase` + "Agent" | `DraftAgent`, `RedlineAgent` |
| Feature IDs | `XX-NNN` | `DR-004`, `AP-001` |
| Screen IDs | `SCR-NNN` | `SCR-006`, `SCR-013` |
| Config keys | `UPPER_SNAKE_CASE` | `APPROVAL_TIMEOUT_DAYS`, `MAX_UPLOAD_SIZE_MB` |
| Event names | `entity.action` | `contract.created`, `approval.completed` |
