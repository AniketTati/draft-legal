#!/usr/bin/env bash
#
# draftLegal — one-command setup.
#
# Takes a clean clone to a fully running app: infra (Docker) → deps → Python
# venv → DB migrate → seed (incl. AI demo data) → search index. Idempotent;
# safe to re-run. After this finishes, `pnpm dev` starts web + api + agents.
#
# Usage:  ./scripts/setup.sh   (or: pnpm dev:setup)
#
set -euo pipefail

cyan()  { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cyan "▶ draftLegal setup"

# ── 0. Tooling preflight ─────────────────────────────────────────────────────
command -v docker  >/dev/null || { echo "✗ Docker is required — install Docker Desktop / OrbStack and start it."; exit 1; }
command -v pnpm    >/dev/null || { echo "✗ pnpm is required — 'npm i -g pnpm' (v9+)."; exit 1; }
command -v python3 >/dev/null || { echo "✗ python3 (3.11+) is required."; exit 1; }
# The agents venv targets 3.11+. Fail early with a clear message rather than
# letting `pip install -r requirements.txt` blow up further down on an old runtime.
python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)' || {
  echo "✗ Python 3.11+ is required — found $(python3 --version 2>&1 | awk '{print $2}'). Install a newer Python (e.g. \`pyenv install 3.11\` or python.org) and re-run."
  exit 1
}
docker info >/dev/null 2>&1   || { echo "✗ Docker daemon isn't running — start Docker Desktop / OrbStack first."; exit 1; }

# ── 1. Environment file ──────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  green "✓ created .env from .env.example"
  yellow "  → Add an LLM key when ready (GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)."
  yellow "    The app boots without one; AI features need at least one key."
else
  green "✓ .env already exists"
fi

# ── 2. Infrastructure (Postgres, Redis, Elasticsearch, MinIO, Gotenberg) ─────
cyan "🐳 Starting infrastructure containers..."
docker compose up -d

cyan "⏳ Waiting for Postgres to be healthy..."
until docker compose exec -T postgres pg_isready -U clm -d clm_dev >/dev/null 2>&1; do sleep 1; done
green "✓ Postgres ready"

cyan "⏳ Waiting for MinIO + Elasticsearch..."
# Give the slower services a moment; the seed/index steps below will retry.
sleep 5
green "✓ infra up"

# ── 3. Node dependencies ─────────────────────────────────────────────────────
cyan "📦 Installing Node dependencies (pnpm)..."
pnpm install

# ── 4. Python agents venv ────────────────────────────────────────────────────
cyan "🐍 Setting up the Python agents environment..."
if [ ! -d apps/agents/.venv ]; then
  ( cd apps/agents && python3 -m venv .venv )
fi
( cd apps/agents && ./.venv/bin/pip install --quiet --upgrade pip && ./.venv/bin/pip install --quiet -r requirements.txt )
green "✓ Python venv ready"

# ── 5. Database: client + migrate + seed ─────────────────────────────────────
cyan "🗄  Generating Prisma client + running migrations..."
pnpm --filter api db:generate
pnpm --filter api db:migrate

cyan "🌱 Seeding database (org, users, demo contracts)..."
pnpm --filter api db:seed
pnpm --filter api exec tsx scripts/seed-ai-demo.ts seed || yellow "  ⚠ AI-demo seed skipped (non-fatal)"

# ── 6. Search index ──────────────────────────────────────────────────────────
# Contracts are indexed into Elasticsearch on write; the AI-demo seed already
# triggers indexing for the demo set. A manual full reindex is available via
# `pnpm --filter api exec tsx scripts/reindex-personas.ts` if you load the
# large persona dataset later. Nothing to do here for the default setup.

# ── Done ─────────────────────────────────────────────────────────────────────
green ""
green "✅ Setup complete."
echo ""
echo "  Start everything:   pnpm dev"
echo ""
echo "  Then open:          http://localhost:5173"
echo "  Log in:             admin@demo.com / password123"
echo ""
