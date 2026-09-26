# 19 — Deployment Strategy

> ⚠️ **ASPIRATIONAL / TARGET ARCHITECTURE — NOT YET IMPLEMENTED.**
> This document describes a future EKS/Kubernetes multi-AZ deployment with
> staging, canary rollouts, and managed observability. **None of it is built.**
> The *actual* production deployment is single-region Google Cloud Run — see
> [20-CLOUD-RUN-LAUNCH.md](./20-CLOUD-RUN-LAUNCH.md) for the real runbook.
> Treat everything below as a roadmap, not a description of the current system.
> (Flagged during the 2026-07 "make it real" audit.)

## Environments

| Environment | Purpose | Infrastructure | Data | Deploy Trigger |
|-------------|---------|---------------|------|----------------|
| **Local** | Developer machines | Docker Compose | Seed data | Manual (`docker compose up`) |
| **CI** | Automated tests | Ephemeral containers (GitHub Actions) | Test fixtures | Every push / PR |
| **Staging** | Pre-production validation | Kubernetes (EKS) — mirrors prod | Anonymized prod subset | Merge to `develop` branch |
| **Production** | Live system | Kubernetes (EKS) — multi-AZ | Real customer data | Merge to `main` branch (after staging approval) |

---

## CI/CD Pipeline

### On Every Pull Request

```yaml
# .github/workflows/pr.yml
name: PR Checks
on: pull_request

jobs:
  lint:
    - ESLint (backend + frontend)
    - Prettier format check
    - Python ruff/black check
    - TypeScript type check (tsc --noEmit)

  unit-tests:
    - Backend unit tests (Vitest)
    - Frontend unit tests (Vitest + React Testing Library)
    - Agent unit tests (Pytest with mocked LLM)

  integration-tests:
    services: [postgres, redis, elasticsearch, minio]
    - API integration tests
    - Database migration tests (migrate up, down, up)
    - RBAC enforcement tests
    - Search indexing tests

  security:
    - Dependency vulnerability scan (npm audit, pip audit)
    - SAST scan (CodeQL or Semgrep)
    - Secrets detection (git-secrets or TruffleHog)

  build:
    - Build Docker images (backend, agents, frontend)
    - Verify images start successfully
```

### On Merge to `develop` (Deploy to Staging)

```yaml
# .github/workflows/staging.yml
name: Deploy Staging
on:
  push:
    branches: [develop]

jobs:
  build-and-push:
    - Build Docker images with commit SHA tag
    - Push to ECR (container registry)

  deploy-staging:
    - Apply Kubernetes manifests (Helm chart)
    - Run database migrations
    - Wait for health checks
    - Run E2E smoke tests against staging
    - Run agent evaluation suite against staging
    - Notify Slack channel with deploy status

  e2e-tests:
    - Full lifecycle E2E test (Playwright)
    - Per-phase E2E scenarios
    - Performance baseline check
```

### On Merge to `main` (Deploy to Production)

```yaml
# .github/workflows/production.yml
name: Deploy Production
on:
  push:
    branches: [main]

jobs:
  # Requires manual approval gate in GitHub Actions
  approve:
    environment: production  # Requires reviewer approval

  deploy-production:
    - Rolling update deployment (zero downtime)
    - Database migrations (backward compatible only)
    - Canary: route 5% traffic to new version
    - Monitor error rates for 10 minutes
    - If healthy: roll out to 100%
    - If error spike: auto-rollback

  post-deploy:
    - Run production smoke tests
    - Verify health endpoints
    - Check monitoring dashboards
    - Notify Slack with release notes
```

---

## Database Migration Strategy

### Rules

1. **Backward compatible only**: every migration must work with BOTH the old and new application versions running simultaneously (for zero-downtime deploys).
2. **Additive first**: add new columns/tables → deploy code that uses them → remove old columns later.
3. **Never rename columns** in a single migration. Instead: add new → copy data → deploy code using new → drop old.
4. **Never drop columns** in the same deploy that stops using them. Wait one deploy cycle.
5. **Always test down migration**: `prisma migrate reset` must work cleanly.
6. **Large data migrations**: run as background jobs, not in the migration itself. Migration adds column, background job populates it.

### Migration Workflow

```
1. Developer creates migration locally
2. PR includes migration file
3. CI runs: migrate up → tests → migrate down → migrate up (verify reversibility)
4. Staging: migration applied automatically on deploy
5. Production: migration applied in pre-deploy step (before new code rolls out)
```

---

## Feature Flags

Use feature flags to decouple deployment from release. Every new feature ships behind a flag.

### Flag Provider

LaunchDarkly, Unleash (self-hosted), or PostHog feature flags.

### Flag Naming Convention

```
clm.{phase}.{feature}.{variant}

Examples:
clm.phase4.ai_assist.enabled          # Phase 4: inline AI assist in editor
clm.phase5.external_portal.enabled     # Phase 5: external negotiation portal
clm.phase6.slack_approval.enabled      # Phase 6: approve via Slack
clm.phase8.invoice_reconciliation.enabled  # Phase 8: invoice matching
clm.phase10.salesforce_sync.enabled    # Phase 10: Salesforce integration
```

### Flag Lifecycle

```
1. Developer creates flag (default: OFF)
2. Feature deployed behind flag (code ships, but feature is invisible)
3. Enable for internal team on staging → test
4. Enable for beta customers on production → validate
5. Enable for all customers → GA
6. Remove flag from code after 30 days of full rollout
```

### Per-Phase Feature Flags

| Phase | Flags |
|-------|-------|
| 1 | `clm.phase1.agent_chat.enabled` |
| 2 | `clm.phase2.semantic_search.enabled`, `clm.phase2.ai_summary.enabled` |
| 3 | `clm.phase3.email_intake.enabled`, `clm.phase3.smart_routing.enabled` |
| 4 | `clm.phase4.ai_drafting.enabled`, `clm.phase4.ai_assist.enabled`, `clm.phase4.bulk_generation.enabled` |
| 5 | `clm.phase5.external_portal.enabled`, `clm.phase5.collab_editing.enabled`, `clm.phase5.auto_counter.enabled` |
| 6 | `clm.phase6.visual_workflow_builder.enabled`, `clm.phase6.slack_approval.enabled`, `clm.phase6.mobile_approval.enabled` |
| 7 | `clm.phase7.docusign_integration.enabled`, `clm.phase7.auto_filing.enabled` |
| 8 | `clm.phase8.obligation_extraction.enabled`, `clm.phase8.invoice_reconciliation.enabled`, `clm.phase8.renewal_recommendations.enabled` |
| 9 | `clm.phase9.conversational_analytics.enabled`, `clm.phase9.report_builder.enabled`, `clm.phase9.proactive_insights.enabled` |
| 10 | `clm.phase10.salesforce_sync.enabled`, `clm.phase10.slack_bot.enabled`, `clm.phase10.bulk_import.enabled` |

---

## Kubernetes Architecture

```yaml
# Namespace: clm-production
#
# Deployments:
#   clm-api          (3 replicas, Node.js backend)
#   clm-agents       (2 replicas, Python agent service)
#   clm-worker       (2 replicas, background job processor)
#   clm-web          (2 replicas, Nginx serving React build)
#   clm-ws           (2 replicas, WebSocket server)
#
# StatefulSets:
#   None (all stateful services are managed: RDS, ElastiCache, S3, etc.)
#
# Jobs:
#   clm-migrate      (pre-deploy hook: database migrations)
#   clm-seed         (optional: seed data for new environments)
#
# CronJobs:
#   clm-obligation-check   (hourly: scan for approaching deadlines)
#   clm-renewal-check      (daily: scan for approaching renewals)
#   clm-analytics-refresh  (hourly: refresh materialized views in ClickHouse)
#   clm-integration-sync   (configurable: CRM/ERP sync)
#   clm-backup             (daily: database backup verification)
```

### Resource Allocation (Production Baseline)

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit | Replicas |
|---------|------------|-----------|----------------|-------------|----------|
| clm-api | 500m | 2000m | 512Mi | 2Gi | 3 |
| clm-agents | 1000m | 4000m | 1Gi | 4Gi | 2 |
| clm-worker | 500m | 2000m | 512Mi | 2Gi | 2 |
| clm-web | 100m | 500m | 128Mi | 256Mi | 2 |
| clm-ws | 250m | 1000m | 256Mi | 1Gi | 2 |

Auto-scaling: HPA based on CPU (target 70%) and custom metrics (queue depth for workers, active connections for WebSocket).

---

## Monitoring & Observability

> **What is wired today (X3):**
> - The API serves Prometheus text at `GET /api/v1/metrics`: HTTP requests and durations by route pattern, process memory, and job-queue depths. It is off unless `METRICS_TOKEN` is set, and a scraper sends that as a bearer token.
> - Unhandled 5xx errors go to Cloud Error Reporting, written to stderr as `ReportedErrorEvent`s on Cloud Run.
> - Admins can read and verify the hash-chained org audit log (Admin → Audit Log; `GET /api/v1/admin/audit`, `/verify`).
> - Nothing else here exists yet: no scrape config, dashboards or alert rules, and no Sentry or PostHog. The sections below are the plan.

### Infrastructure Monitoring (Prometheus + Grafana)

| Metric | Alert Threshold |
|--------|----------------|
| API response time (p95) | > 500ms for 5 min |
| API error rate (5xx) | > 1% for 5 min |
| Agent response time (p95) | > 10s for 5 min |
| Agent error rate | > 5% for 5 min |
| Database connection pool usage | > 80% for 10 min |
| Redis memory usage | > 80% |
| Job queue depth | > 1000 pending for 15 min |
| WebSocket active connections | > 90% of capacity |
| Disk usage (any volume) | > 85% |
| Certificate expiry | < 14 days |

### Application Monitoring (planned: Sentry — today, Cloud Error Reporting; see above)

- All unhandled exceptions captured with full stack trace
- Agent errors include: model used, prompt hash, token count, confidence score
- Performance transactions for critical paths: contract generation, search, approval routing
- Release tracking: errors grouped by deploy version

### Product Analytics (PostHog)

| Event | Properties | Purpose |
|-------|-----------|---------|
| `contract.created` | type, source (form/chat/email), time_to_create | Track creation patterns |
| `agent.chat.message` | intent, response_time, confidence | Agent usage and quality |
| `agent.chat.action_taken` | action (view_contract, approve, etc.) | Agent effectiveness |
| `search.executed` | query_type (keyword/semantic/NL), result_count | Search quality |
| `approval.decided` | decision, time_to_decide, via (web/mobile/slack) | Approval patterns |
| `feature.used` | feature_id, screen_id | Feature adoption tracking |
| `portal.external_visit` | counterparty_id, action_taken | External engagement |

### Structured Logging

All services log in JSON format to CloudWatch / ELK:

```json
{
  "timestamp": "2026-03-17T14:30:00.123Z",
  "level": "info",
  "service": "clm-api",
  "request_id": "req_abc123",
  "org_id": "org_001",
  "user_id": "usr_456",
  "method": "POST",
  "path": "/api/v1/contracts",
  "status": 201,
  "duration_ms": 142,
  "message": "Contract created"
}
```

### Agent-Specific Logging

Every LLM call is logged (with PII redacted):

```json
{
  "timestamp": "2026-03-17T14:30:01.456Z",
  "level": "info",
  "service": "clm-agents",
  "agent": "draft_agent",
  "action": "generate_contract",
  "model": "claude-sonnet-4-6",
  "input_tokens": 4200,
  "output_tokens": 8500,
  "duration_ms": 3200,
  "confidence": 0.93,
  "template_used": "tpl_nda_standard",
  "org_id": "org_001",
  "triggered_by": "usr_456"
}
```

---

## Rollback Strategy

### Application Rollback

```bash
# Kubernetes rolling rollback (instant)
kubectl rollout undo deployment/clm-api -n clm-production
kubectl rollout undo deployment/clm-agents -n clm-production
```

Rollback is automated if canary health check fails (error rate > 2% within 10 minutes of deploy).

### Database Rollback

- **Minor schema change**: apply down migration, redeploy previous version
- **Major data change**: restore from point-in-time backup (RDS PITR, < 5 min RPO)
- **Prevention**: all migrations are backward compatible, so rollback rarely requires DB changes

### Feature Flag Rollback

Fastest rollback for feature-level issues:

```
1. Identify problematic feature
2. Disable feature flag (instant, no deploy needed)
3. Investigate and fix
4. Re-enable after fix
```

---

## Disaster Recovery

| Scenario | Recovery Strategy | RTO | RPO |
|----------|------------------|-----|-----|
| Single pod failure | Kubernetes auto-restart | < 1 min | 0 |
| AZ failure | Multi-AZ deployment, auto-failover | < 5 min | 0 |
| Database failure | RDS Multi-AZ failover | < 5 min | 0 |
| Region failure | Cross-region standby (enterprise) | < 30 min | < 5 min |
| Data corruption | Point-in-time restore from backup | < 1 hour | < 5 min |
| Full platform outage | Restore from infrastructure-as-code | < 2 hours | < 1 hour |

### Backup Schedule

| Data | Method | Frequency | Retention |
|------|--------|-----------|-----------|
| PostgreSQL | RDS automated snapshots | Continuous (PITR) | 35 days |
| Elasticsearch | Snapshot to S3 | Daily | 30 days |
| S3 documents | Cross-region replication | Continuous | Per retention policy |
| Redis | RDB snapshots | Every 15 min | 7 days |
| ClickHouse | Backup to S3 | Daily | 90 days |
| Configuration | Git repository | Every commit | Indefinite |

---

## Release Cadence

| Type | Frequency | Process |
|------|-----------|---------|
| Feature release | Biweekly (every 2 weeks) | Feature branches → develop → staging validation → main |
| Hotfix | As needed | Hotfix branch from main → fast-track testing → main |
| Security patch | Within 24 hours of disclosure | Immediate patching → emergency deploy |
| Database migration | With feature releases | Included in biweekly deploy |
| Agent model updates | Monthly | Evaluation suite → staging validation → gradual rollout |

### Release Checklist

```markdown
- [ ] All PR checks passing (lint, tests, security)
- [ ] E2E tests passing on staging
- [ ] Agent evaluation metrics within acceptable range
- [ ] Performance baseline check passed
- [ ] Feature flags configured correctly
- [ ] Release notes drafted
- [ ] Rollback plan documented
- [ ] On-call engineer identified
- [ ] Deploy during low-traffic window (if major change)
- [ ] Post-deploy smoke tests passing
- [ ] Monitoring dashboards checked (15 min post-deploy)
```
