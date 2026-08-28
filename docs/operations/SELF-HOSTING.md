# Self-hosting draftLegal

The self-host stack keeps every contract on your own servers. It runs the full
app — API, background workers, AI agents, web — plus Postgres, Redis,
Elasticsearch, MinIO (object storage), and Gotenberg (PDF), all on a private
Docker network. Only the web tier publishes a port.

> Cloud (managed) deployment is a separate path — see
> `20-CLOUD-RUN-LAUNCH.md` and `scripts/deploy.sh`.

## 1. Prerequisites

- Docker + Docker Compose v2
- Node 20+ and pnpm 9 (to build the web bundle)
- ~4 GB RAM free (Elasticsearch alone wants 512 MB heap)

## 2. Configure

```bash
cp .env.selfhost.example .env.selfhost
# Edit .env.selfhost. At minimum set strong values for:
#   POSTGRES_PASSWORD, DATABASE_URL, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD,
#   JWT_SECRET (>=32 chars), PORTAL_JWT_SECRET, INTERNAL_SERVICE_SECRET,
#   and at least one AI provider key.
# Generate secrets with:  openssl rand -base64 48
```

The API **refuses to boot** with a missing/short/placeholder `JWT_SECRET` or
`PORTAL_JWT_SECRET` (Wave 1 fail-closed secrets) — this is deliberate.

## 3. Build the web bundle + start

```bash
# Vite bakes the API base URL at build time; /api is proxied to the API by nginx.
VITE_API_URL=/api pnpm --filter web build

docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --build
```

Startup order is enforced by health checks: Postgres → **migrate** (one-shot
`prisma migrate deploy`) → api/worker/agents → web. The app is at
`http://localhost:${WEB_PORT:-8080}`.

Seed the first org/admin:

```bash
docker compose -f docker-compose.selfhost.yml exec api-service \
  node --import tsx prisma/seed.ts
```

## 4. Upgrading

Migrations run automatically on every `up` via the one-shot `migrate` service,
so upgrading is:

```bash
git pull
VITE_API_URL=/api pnpm --filter web build
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --build
```

`prisma migrate deploy` only applies forward migrations and never resets data.
Read `CHANGELOG.md` for the notes on each release (breaking changes, new env
vars, manual steps).

## 5. Backups & disaster recovery

Two things hold all state: **Postgres** (all records + the tamper-evident audit
hash-chain) and **MinIO** (uploaded + signed PDFs). Back up both, together.

**Postgres — nightly logical dump:**

```bash
docker compose -f docker-compose.selfhost.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > backup-db-$(date +%F).sql.gz
```

**MinIO — mirror the bucket:**

```bash
docker compose -f docker-compose.selfhost.yml exec -T minio \
  mc mirror --overwrite local/clm-documents /backup/clm-documents
# or from the host with the mc client against the MinIO endpoint.
```

Automate both from cron/systemd-timer and ship the artifacts off-box (another
host, or encrypted object storage). **Test restores quarterly** — an untested
backup is a guess.

**Restore drill:**

```bash
# DB
gunzip -c backup-db-YYYY-MM-DD.sql.gz | \
  docker compose -f docker-compose.selfhost.yml exec -T postgres \
  psql -U "$POSTGRES_USER" "$POSTGRES_DB"
# Objects
mc mirror --overwrite /backup/clm-documents local/clm-documents
# Then bring services up; migrate is idempotent.
```

Retention: keep ≥30 daily + ≥3 monthly. Elasticsearch is a derived index — it
does not need backup; rebuild it after a restore with
`pnpm --filter api backfill-es-index`.

## 6. Monitoring (minimum viable)

- **Uptime**: poll `GET /health/ready` (API readiness — checks DB/Redis) and
  the web root on an external checker; alert on non-200 or latency spikes.
  `GET /health/live` is the cheap liveness probe.
- **Errors**: ship the api/worker/agents container logs to your log stack and
  alert on error-rate; the worker service logs every job failure with a stack.
- **Queues**: Bull Board is mounted in the API for a live view of queue depth
  and failures.
- **Disk**: alert before the Postgres/MinIO volumes fill.
- **LLM calls**: optional Langfuse tracing (`LANGFUSE_*` in `.env.selfhost`,
  blank by default). Traces contain contract text, so run Langfuse on your own
  infrastructure rather than a hosted SaaS — see `LANGFUSE.md`.

## 7. Security notes

- Only the `web` service exposes a host port. Postgres/Redis/ES/MinIO/Gotenberg/
  agents are internal-only — do not publish their ports.
- The documents bucket is **private**; PDFs are served via presigned URLs.
- Put the web port behind a TLS-terminating reverse proxy (Caddy/nginx/Traefik)
  before exposing to the internet.
- Rotate `INTERNAL_SERVICE_SECRET`, `JWT_SECRET`, and DB/MinIO credentials off
  the example placeholders before first real use.
