/**
 * Secret resolution + fail-closed boot validation (Wave 1.1, 2026-07).
 *
 * Before this module, JWT_SECRET and PORTAL_JWT_SECRET fell back to
 * hardcoded strings ('dev-secret-change-me' / 'portal-dev-secret') when
 * the env var was missing. Any production deploy that forgot one env var
 * silently signed every access/refresh/portal token with a publicly-known
 * constant — a full auth-forgery hole. This module removes those fallbacks
 * and refuses to boot in production without strong, non-placeholder secrets.
 *
 * Behaviour:
 *   - value set + strong        → use it
 *   - value set + weak/placeholder in production → throw at boot
 *   - value unset in production  → throw at boot (fail closed)
 *   - value unset in dev/test    → generate a random secret, persist it to
 *                                  .dev-secrets.json so tokens survive a
 *                                  restart (DX), and warn. Never a shared
 *                                  constant, so it can't leak into prod.
 *
 * Mirrors the fail-loud pattern in lib/encryption.ts (masterKey()).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { environmentName, isStrict } from './runtime-mode.js'

const MIN_LEN = 32

// Known-insecure values we must never accept in production: the old
// hardcoded fallbacks, plus the `change-me…` placeholders shipped in
// .env.example. Kept lowercase for case-insensitive comparison.
// X38 — and every other value that is public in the repo: the CI and
// integration-test secrets, and the dev internal secret the skill docs name.
const INSECURE_VALUES = new Set([
  'dev-secret-change-me',
  'portal-dev-secret',
  'change-me',
  'clm-internal-dev-secret-2026',
  'ci-integration-jwt-secret-32chars-minimum',
  'ci-integration-portal-secret-32chars-min',
  'ci-integration-internal-secret',
  'integration-test-jwt-secret-32chars-minimum',
  'integration-portal-secret-32chars-minimum',
  'integration-internal-service-secret',
])

// Y5 — "production" is any NODE_ENV but development and test: a placeholder
// passed on staging and previews (X38).
const isProd = isStrict

function looksInsecure(value: string): boolean {
  // X38 — the example files' placeholders in any spelling: `change-me…`
  // (.env.example) and `CHANGE_ME_…` (.env.selfhost.example, 37–44
  // characters, which passed), quoted or padded, and `replace-me…`.
  const v = value.trim().replace(/^['"]+|['"]+$/g, '').trim().toLowerCase()
  return INSECURE_VALUES.has(v) || /^(change|replace)[-_ ]?me/.test(v)
}

// ── Dev-only persisted secrets ───────────────────────────────────────────
// Written to <cwd>/.dev-secrets.json (gitignored). NEVER read in production.
const DEV_SECRETS_FILE = join(process.cwd(), '.dev-secrets.json')
let devCache: Record<string, string> | null = null

function loadDevSecrets(): Record<string, string> {
  if (devCache) return devCache
  try {
    if (existsSync(DEV_SECRETS_FILE)) {
      devCache = JSON.parse(readFileSync(DEV_SECRETS_FILE, 'utf8')) as Record<string, string>
      return devCache
    }
  } catch {
    /* corrupt file — regenerate below */
  }
  devCache = {}
  return devCache
}

function devSecret(name: string): string {
  const store = loadDevSecrets()
  if (!store[name]) {
    store[name] = randomBytes(48).toString('base64url')
    try {
      writeFileSync(DEV_SECRETS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
    } catch {
      /* read-only fs — secret stays in-memory for this process */
    }
    console.warn(
      `[secrets] ${name} is not set — generated a random dev secret ` +
      `(persisted to .dev-secrets.json). Set ${name} in apps/api/.env for a stable value; ` +
      `production refuses to boot without it.`
    )
  }
  return store[name]
}

/**
 * Resolve a required secret. Throws (loudly, at call time — used at boot via
 * assertSecretsConfigured) when production is misconfigured.
 */
export function resolveSecret(name: string): string {
  const value = process.env[name]

  if (value && value.length > 0) {
    if (isProd() && value.length < MIN_LEN) {
      throw new Error(
        `[secrets] ${name} is too short (${value.length} chars); require >= ${MIN_LEN} with NODE_ENV=${environmentName()}. ` +
        `Generate one: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
      )
    }
    if (isProd() && looksInsecure(value)) {
      throw new Error(
        `[secrets] ${name} is set to a known-insecure placeholder. Refusing to boot with NODE_ENV=${environmentName()}. ` +
        `Generate one: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
      )
    }
    if (!isProd() && (value.length < MIN_LEN || looksInsecure(value))) {
      console.warn(
        `[secrets] ${name} looks like a placeholder/short value — fine for dev, but production ` +
        `will refuse to boot with it. Set a strong ${name} before deploying.`
      )
    }
    return value
  }

  if (isProd()) {
    throw new Error(
      `[secrets] ${name} is not set. Refusing to boot with NODE_ENV=${environmentName()} on an insecure default. ` +
      `Generate one: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" ` +
      `and set ${name}.`
    )
  }

  return devSecret(name)
}

/**
 * Call at server boot so we crash early with a clear message rather than
 * silently signing tokens with a weak/known secret.
 */
export function assertSecretsConfigured(): void {
  resolveSecret('JWT_SECRET')
  resolveSecret('PORTAL_JWT_SECRET')
  checkInternalSecret()
}

/**
 * X38 — the agents service's shared secret admits a caller as ADMIN of any
 * org it names (requireAuth's internal bypass) and hands out the model keys
 * (/internal/ai/resolve), yet nothing checked it: a production API started
 * with an example file's placeholder, which anyone who has read the repo
 * knows. Production refuses to boot with a placeholder or a short one, as for
 * the JWT secrets (on Cloud Run a refused revision leaves the previous one
 * serving). Unset only warns: every internal check then refuses rather than
 * opens. Never generated, since the agents service must hold the same value.
 */
function checkInternalSecret(): void {
  const name = 'INTERNAL_SERVICE_SECRET'
  const value = process.env[name]
  const fix = `Generate one: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" and set it on the API, the worker and the agents service.`
  if (!value) {
    console.warn(`[secrets] ${name} is not set: the agents service can't call the API. ${fix}`)
    return
  }
  if (looksInsecure(value)) {
    if (isProd()) throw new Error(`[secrets] ${name} is set to a known-insecure placeholder. Refusing to boot with NODE_ENV=${environmentName()}. ${fix}`)
    console.warn(`[secrets] ${name} is a placeholder — fine for dev, but production will refuse to boot with it.`)
    return
  }
  if (value.length < MIN_LEN) {
    if (isProd()) throw new Error(`[secrets] ${name} is too short (${value.length} chars); require >= ${MIN_LEN} with NODE_ENV=${environmentName()}. ${fix}`)
    console.warn(`[secrets] ${name} is short (${value.length} chars) — fine for dev, but production will refuse to boot with it.`)
  }
}
