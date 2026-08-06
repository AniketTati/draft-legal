/**
 * Shared harness for the Week-0 agent-hardening checks.
 *
 * Every check in this directory hits a REAL local stack (API on :3001,
 * agents on :8002, Postgres/Redis/ES/MinIO via docker compose). Nothing is
 * mocked — a mock cannot catch "the Python agent forgot the
 * x-internal-service header", which is exactly the class of bug these
 * checks exist to find.
 *
 * Usage:
 *   import { login, api, check, report } from './lib/harness.mjs'
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '../../../apps/api/node_modules/@prisma/client/index.js'

export const API = process.env.API_BASE ?? 'http://localhost:3001'
export const AGENTS = process.env.AGENTS_BASE ?? 'http://localhost:8002'
export const INTERNAL_SECRET =
  process.env.INTERNAL_SERVICE_SECRET ?? 'clm-internal-dev-secret-2026'

/** Seeded admin — full permissions, used as the control in RBAC checks. */
export const ADMIN = { email: 'admin@demo.com', password: 'password123' }

let _prisma
/** Lazily-constructed Prisma client pointed at the dev database. */
export function db() {
  if (!_prisma) {
    _prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? readDbUrl() } },
    })
  }
  return _prisma
}

function readDbUrl() {
  // The dev stack keeps DATABASE_URL in the repo-root .env; scripts are run
  // ad hoc (not through tsx --env-file), so read it directly.
  const raw = fs.readFileSync(fileURLToPath(new URL('../../../.env', import.meta.url)), 'utf8')
  const m = raw.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not found in .env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/** Log in and return { accessToken, user }. Throws on failure. */
export async function login(email = ADMIN.email, password = ADMIN.password) {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!r.ok) throw new Error(`login ${email} → ${r.status}: ${await r.text()}`)
  return r.json()
}

/**
 * Authenticated request against the public API.
 * Returns { status, body } — never throws on a non-2xx, because most checks
 * here are specifically asserting a 403.
 */
export async function api(token, method, path, body) {
  const r = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await r.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: r.status, body: parsed }
}

/** Request against an internal-AI tool endpoint, as the agents service. */
export async function internal(path, body, orgId) {
  const r = await fetch(`${API}/api/v1/internal/ai${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-service': 'agents',
      'x-internal-secret': INTERNAL_SECRET,
      ...(orgId ? { 'x-org-id': orgId } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: r.status, body: parsed }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Ensure a user exists in `orgId` holding exactly `roleName`, and return
 * credentials for it. Idempotent — re-running a check reuses the same user.
 *
 * Created directly in the database rather than through the invite flow: the
 * point of these checks is to exercise the permission boundary, not the
 * onboarding path, and invites would need a mail round-trip.
 */
export async function ensureUser(orgId, roleName, email) {
  const bcrypt = await import('../../../apps/api/node_modules/bcryptjs/index.js')
  const prisma = db()
  const passwordHash = await bcrypt.default.hash('password123', 12)

  const role = await prisma.role.findFirst({ where: { orgId, name: roleName } })
    ?? await prisma.role.findFirst({ where: { name: roleName, isSystem: true } })
  if (!role) throw new Error(`role ${roleName} not found`)

  const user = await prisma.user.upsert({
    where: { email },
    update: { status: 'ACTIVE', passwordHash },
    create: {
      orgId, email, passwordHash,
      name: `${roleName} Test`, status: 'ACTIVE',
    },
  })
  const existing = await prisma.userRole.findFirst({ where: { userId: user.id } })
  if (!existing || existing.roleId !== role.id) {
    await prisma.userRole.deleteMany({ where: { userId: user.id } })
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } })
  }
  return { email, password: 'password123', userId: user.id, orgId, role: roleName }
}

/** Ensure a second organization exists, for cross-tenant isolation checks. */
export async function ensureSecondOrg(name = 'Isolation Test Co') {
  const prisma = db()
  const existing = await prisma.organization.findFirst({ where: { name } })
  if (existing) return existing
  return prisma.organization.create({
    data: { name, slug: 'isolation-test-co', subscriptionTier: 'FREE' },
  })
}

// ─── Reporting ───────────────────────────────────────────────────────────────

const results = []

/**
 * Record one assertion. `expected` and `actual` are printed on failure so the
 * output is self-explanatory without re-reading the script.
 */
export function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  const mark = passed ? '[32mPASS[0m' : '[31mFAIL[0m'
  console.log(`  ${mark}  ${name}${detail ? `\n        ${detail}` : ''}`)
  return passed
}

/** Print a summary and exit non-zero if anything failed. */
export function report(title) {
  const failed = results.filter(r => !r.passed)
  console.log(`\n${title}: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    console.log('\nFailures:')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  process.exitCode = failed.length ? 1 : 0
  return failed.length === 0
}

export function section(title) {
  console.log(`\n[1m${title}[0m`)
}
