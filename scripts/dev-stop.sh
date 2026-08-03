#!/usr/bin/env bash
#
# draftLegal — stop the local dev stack.
#
# Kills the app processes (web/api/agents/marketing — these run on the host,
# not in Docker) and stops the infra containers. Data is PRESERVED: Postgres,
# Redis, Elasticsearch and MinIO volumes are untouched. Resume any time with
# `pnpm dev:restart` (brings infra back up too) or plain `pnpm dev` if infra
# is already running.
#
# Usage:  ./scripts/dev-stop.sh   (or: pnpm dev:stop)
#
set -uo pipefail

cyan()  { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

APP_PORTS=(3001 3030 5173 5174 8002)

cyan "▶ Stopping app processes (web, api, agents, marketing)…"
for port in "${APP_PORTS[@]}"; do
  if lsof -ti ":${port}" >/dev/null 2>&1; then
    lsof -ti ":${port}" | xargs -r kill -9
    echo "  ✓ killed process on :${port}"
  fi
done

cyan "▶ Stopping infra containers (Postgres, Redis, Elasticsearch, MinIO, Gotenberg)…"
docker compose stop

green ""
green "✅ Stopped. All data intact."
echo ""
echo "  Resume:       pnpm dev:restart   (brings infra back up + starts the app)"
echo "  Start clean:  pnpm dev:reset     (wipes all local data)"
echo ""
