#!/usr/bin/env bash
#
# draftLegal — wipe local dev state and rebuild from zero.
#
# Stops the app processes, destroys the Docker volumes (Postgres, Redis,
# Elasticsearch, MinIO — every contract, org, and user is gone), then reruns
# setup.sh (infra up, deps, Python venv, migrate, seed) and starts the app.
#
# This is the "burn it down and start over" button — use it when the local
# stack is in a state you don't trust and you'd rather start clean than
# debug it. For a quick restart that keeps your data, use dev-restart.sh
# instead.
#
# Usage:  ./scripts/dev-reset.sh   (or: pnpm dev:reset)
#
set -euo pipefail

red()   { printf "\033[31m%s\033[0m\n" "$1"; }
cyan()  { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

red "⚠  This permanently deletes ALL local data: every contract, org, user,"
red "   uploaded file, and search index. This cannot be undone."
read -r -p "Type 'reset' to continue: " confirm
if [ "$confirm" != "reset" ]; then
  echo "Aborted — nothing was touched."
  exit 1
fi

APP_PORTS=(3001 3030 5173 5174 8002)

cyan "▶ Killing app processes (${APP_PORTS[*]})…"
for port in "${APP_PORTS[@]}"; do
  if lsof -ti ":${port}" >/dev/null 2>&1; then
    lsof -ti ":${port}" | xargs -r kill -9
  fi
done

cyan "▶ Wiping infra containers + volumes (Postgres, Redis, Elasticsearch, MinIO)…"
docker compose down -v

green "✓ clean slate — rebuilding"
echo ""
"$ROOT/scripts/setup.sh"

green "✓ setup complete — starting pnpm dev"
echo ""
exec pnpm dev
