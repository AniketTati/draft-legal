#!/usr/bin/env bash
#
# draftLegal — restart just the app processes (web/api/agents/marketing).
#
# Use this after editing .env. `tsx watch --env-file` and Python's
# pydantic-settings both read .env once at process startup — neither picks up
# a change on its own, even though tsx watch / uvicorn --reload restart on
# *source* file changes. This kills whatever is bound to the app ports and
# starts `pnpm dev` fresh so the new values actually take effect.
#
# Infra containers (Postgres, Redis, Elasticsearch, MinIO) and all data are
# left untouched — this only restarts the host-side app processes.
#
# Usage:  ./scripts/dev-restart.sh   (or: pnpm dev:restart)
#
set -uo pipefail

cyan()  { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

APP_PORTS=(3001 3030 5173 5174 8002)

cyan "▶ Killing any process on the app ports (${APP_PORTS[*]})…"
for port in "${APP_PORTS[@]}"; do
  if lsof -ti ":${port}" >/dev/null 2>&1; then
    lsof -ti ":${port}" | xargs -r kill -9
    echo "  ✓ killed process on :${port}"
  fi
done
sleep 1

cyan "▶ Making sure infra containers are up (no-op if already running)…"
docker compose up -d

green "✓ ports clear, infra up — starting pnpm dev"
echo ""
exec pnpm dev
