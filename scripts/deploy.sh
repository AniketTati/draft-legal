#!/usr/bin/env bash
# Deploy the three Cloud Run services + Firebase Hosting frontend.
#
# Prereqs (one-time, see docs/operations/20-CLOUD-RUN-LAUNCH.md):
#   - gcloud auth login + gcloud config set project <your-project>
#   - firebase login + a Firebase project linked in .firebaserc
#   - All secrets created in Secret Manager (see secrets section in the runbook)
#   - env.api.yaml and env.agents.yaml present at repo root (copy from .example,
#     fill in non-secret URLs/IDs — secrets live in Secret Manager, NOT here)
#
# Usage:
#   ./scripts/deploy.sh all          # full deploy (api + agents + gotenberg + web)
#   ./scripts/deploy.sh api
#   ./scripts/deploy.sh agents
#   ./scripts/deploy.sh gotenberg
#   ./scripts/deploy.sh web
#
# Environment overrides (sensible defaults already set):
#   GCP_PROJECT, GCP_REGION
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
GCP_REGION="${GCP_REGION:-us-central1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${GCP_PROJECT}" ]]; then
  echo "GCP_PROJECT is not set and gcloud has no default project. Run: gcloud config set project <id>" >&2
  exit 1
fi

echo "Project : ${GCP_PROJECT}"
echo "Region  : ${GCP_REGION}"
echo

cmd="${1:-all}"

# Dedicated runtime service accounts (least-privilege). Created once via
# `gcloud iam service-accounts create cr-api / cr-agents` and granted
# per-secret accessor on Secret Manager. Gotenberg needs no secrets so
# it runs as the default compute SA.
API_SA="${API_SA:-cr-api@${GCP_PROJECT}.iam.gserviceaccount.com}"
AGENTS_SA="${AGENTS_SA:-cr-agents@${GCP_PROJECT}.iam.gserviceaccount.com}"

# Comma-separated list of Secret Manager bindings used by api-service.
# Secrets must exist (gcloud secrets create ...) before first deploy.
API_SECRETS="DATABASE_URL=database-url:latest,\
REDIS_URL=redis-url:latest,\
ELASTICSEARCH_URL=elasticsearch-url:latest,\
JWT_SECRET=jwt-secret:latest,\
PORTAL_JWT_SECRET=portal-jwt-secret:latest,\
INTERNAL_SERVICE_SECRET=internal-secret:latest,\
AI_KEY_ENCRYPTION_KEY=ai-key-enc:latest,\
S3_ACCESS_KEY=gcs-hmac-access:latest,\
S3_SECRET_KEY=gcs-hmac-secret:latest,\
ANTHROPIC_API_KEY=anthropic-key:latest,\
OPENAI_API_KEY=openai-key:latest,\
GOOGLE_API_KEY=google-key:latest,\
SENDGRID_API_KEY=sendgrid-key:latest"

AGENTS_SECRETS="INTERNAL_SERVICE_SECRET=internal-secret:latest,\
REDIS_URL=redis-url:latest,\
ANTHROPIC_API_KEY=anthropic-key:latest,\
OPENAI_API_KEY=openai-key:latest,\
GOOGLE_API_KEY=google-key:latest"

# Wave 4 — apply pending Prisma migrations BEFORE any service that reads the
# new schema goes live. Requires reachability to the database (Cloud SQL public
# IP + authorized network, or run from inside the VPC / via the Cloud SQL Auth
# Proxy). The DB URL comes from Secret Manager, never from a committed file.
migrate_db() {
  echo "--- prisma migrate deploy ---"
  local db_url
  # Best-effort read of the DB URL. The deployer SA may lack secret access, or
  # the DB may be unreachable from this runner — suppress the raw gcloud error
  # and return non-zero so the caller decides whether to block (the full deploy
  # does NOT; the standalone `migrate` subcommand does).
  db_url="$(gcloud secrets versions access latest --secret=database-url --project="${GCP_PROJECT}" 2>/dev/null || true)"
  if [[ -z "${db_url}" ]]; then
    echo "⚠  could not read the database-url secret from this runner. Grant the deployer service account roles/secretmanager.secretAccessor to enable auto-migrate, or apply migrations separately (docs/operations/SELF-HOSTING.md)."
    return 1
  fi
  ( cd "${ROOT}/apps/api" && DATABASE_URL="${db_url}" pnpm exec prisma migrate deploy )
}

deploy_api() {
  echo "--- deploy api-service ---"
  [[ -f "${ROOT}/env.api.yaml" ]] || { echo "missing env.api.yaml (copy from env.api.example.yaml)" >&2; exit 1; }
  # The repo root has a symlink `Dockerfile -> apps/api/Dockerfile` because
  # the API build context is the repo root (pnpm workspace), and newer gcloud
  # no longer accepts an explicit --dockerfile flag.
  #
  # Incremental rollout note: the API keeps running the BullMQ workers in-process
  # (as it always has) and calls Gotenberg without OIDC for now, so this deploy
  # cannot regress a working one. Once the dedicated worker-service is confirmed
  # healthy and Gotenberg is verified private, flip these on (in one verified
  # step): --set-env-vars "WORKERS_ENABLED=false,GOTENBERG_REQUIRE_AUTH=true".
  gcloud run deploy api-service \
    --project "${GCP_PROJECT}" \
    --region "${GCP_REGION}" \
    --source "${ROOT}" \
    --service-account "${API_SA}" \
    --min-instances 0 --max-instances 2 \
    --memory 1Gi --cpu 1 --concurrency 80 \
    --timeout 300 \
    --port 8080 \
    --env-vars-file "${ROOT}/env.api.yaml" \
    --set-secrets "${API_SECRETS}" \
    --allow-unauthenticated
}

# Wave 4 — dedicated always-on worker service. Same image/source as the API but
# runs worker-entrypoint.ts instead of the Fastify app, with --min-instances 1
# + --no-cpu-throttling so time-based jobs (approval escalation, signature
# reminders, renewal scans) actually fire. Not publicly invocable.
deploy_workers() {
  echo "--- deploy worker-service (always-on BullMQ workers) ---"
  # return (not exit) so the non-fatal caller in `all` isn't killed.
  [[ -f "${ROOT}/env.api.yaml" ]] || { echo "missing env.api.yaml (copy from env.api.example.yaml)" >&2; return 1; }
  gcloud run deploy worker-service \
    --project "${GCP_PROJECT}" \
    --region "${GCP_REGION}" \
    --source "${ROOT}" \
    --service-account "${API_SA}" \
    --command "node" \
    --args "--import,tsx,src/worker-entrypoint.ts" \
    --min-instances 1 --max-instances 1 \
    --no-cpu-throttling \
    --memory 1Gi --cpu 1 \
    --timeout 300 \
    --port 8080 \
    --env-vars-file "${ROOT}/env.api.yaml" \
    --set-secrets "${API_SECRETS}" \
    --no-allow-unauthenticated
}

deploy_agents() {
  echo "--- deploy agents-service ---"
  [[ -f "${ROOT}/env.agents.yaml" ]] || { echo "missing env.agents.yaml (copy from env.agents.example.yaml)" >&2; exit 1; }
  gcloud run deploy agents-service \
    --project "${GCP_PROJECT}" \
    --region "${GCP_REGION}" \
    --source "${ROOT}/apps/agents" \
    --service-account "${AGENTS_SA}" \
    --min-instances 0 --max-instances 2 \
    --memory 1Gi --cpu 1 --concurrency 40 \
    --timeout 300 \
    --port 8080 \
    --env-vars-file "${ROOT}/env.agents.yaml" \
    --set-secrets "${AGENTS_SECRETS}" \
    --allow-unauthenticated
  # NOTE: --allow-unauthenticated is paired with an app-level
  # `x-internal-secret` middleware in apps/agents/main.py. The API does not
  # fetch OIDC identity tokens before calling agents, so Cloud Run IAM auth
  # is bypassed; the shared secret is what actually gates access.
}

deploy_gotenberg() {
  echo "--- deploy gotenberg ---"
  gcloud run deploy gotenberg \
    --project "${GCP_PROJECT}" \
    --region "${GCP_REGION}" \
    --image gotenberg/gotenberg:8 \
    --min-instances 0 --max-instances 1 \
    --memory 512Mi --cpu 1 \
    --port 3000 \
    --args "gotenberg,--api-port=3000" \
    --allow-unauthenticated
  # Wave 4 hardening READY BUT DEFERRED for the first rollout: Gotenberg has no
  # built-in auth, so it should be made private with only the API's SA able to
  # invoke it via OIDC (the client code already supports this — set
  # GOTENBERG_REQUIRE_AUTH=true on the API). Enable in one verified step AFTER
  # confirming PDF rendering still works, because Cloud Run's revision rollback
  # does NOT restore the public/private flag:
  #   gcloud run deploy gotenberg ... --no-allow-unauthenticated
  #   gcloud run services add-iam-policy-binding gotenberg \
  #     --member "serviceAccount:${API_SA}" --role roles/run.invoker --region "${GCP_REGION}"
}

deploy_web() {
  echo "--- build + deploy web app (Firebase Hosting target=app) ---"
  : "${VITE_API_URL:?VITE_API_URL must be set, e.g. export VITE_API_URL=https://app.draft-legal.com}"
  pushd "${ROOT}" >/dev/null
  pnpm --filter web build
  firebase deploy --only hosting:app --project "${GCP_PROJECT}"
  popd >/dev/null
}

deploy_marketing() {
  echo "--- build + deploy marketing site (Firebase Hosting target=marketing) ---"
  pushd "${ROOT}" >/dev/null
  pnpm --filter marketing build
  firebase deploy --only hosting:marketing --project "${GCP_PROJECT}"
  popd >/dev/null
}

case "${cmd}" in
  migrate)    migrate_db ;;
  api)        deploy_api ;;
  agents)     deploy_agents ;;
  gotenberg)  deploy_gotenberg ;;
  workers)    deploy_workers ;;
  web)        deploy_web ;;
  marketing)  deploy_marketing ;;
  all)
    # Apply schema changes before any service reads them. Non-fatal in the full
    # deploy: if this runner can't reach the DB (e.g. Cloud SQL private IP / not
    # in authorized networks), warn and keep deploying rather than turning a
    # working deploy into a failed one. Run `./scripts/deploy.sh migrate` from a
    # host that can reach the DB (or add the Cloud SQL Auth Proxy) to apply them.
    # The `migrate` subcommand below stays strict for intentional runs.
    migrate_db || echo "   → continuing deploy; migrations not auto-applied this run."
    deploy_gotenberg
    deploy_agents
    deploy_api
    # Additive new service. Non-fatal on the first rollout: if it fails, the API
    # still runs the workers in-process (as today), so jobs never stop; fix the
    # worker-service, then flip WORKERS_ENABLED=false on the API to de-duplicate.
    deploy_workers || echo "⚠  worker-service deploy failed — continuing; the API still runs workers in-process."
    deploy_web
    deploy_marketing
    ;;
  *)
    echo "Usage: $0 {all|migrate|api|agents|gotenberg|workers|web|marketing}" >&2
    exit 1
    ;;
esac

echo
echo "Done."
