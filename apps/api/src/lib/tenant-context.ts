/**
 * Y1 — the tenant a request acts for.
 *
 * Every request runs inside a store created by the app's first preHandler
 * hook (app.ts). Authentication writes the tenant into it once it knows who is
 * calling: a user's JWT, an API key, the agents service with `x-org-id`, or an
 * internal tool call's `orgId` (middleware/auth.ts, routes/internal-ai.ts).
 * The Prisma tenant guard (lib/tenant-guard.ts) reads it for every query.
 *
 * No store, or no tenant in it, means no limit: sign-in, public token routes
 * (signing, share portal), webhooks from other services, and background jobs.
 *
 * The AsyncLocalStorage instance lives on globalThis: the Prisma client is a
 * process-wide singleton (lib/prisma.ts), so every copy of this module must
 * share the one storage the guard reads, including in the test runner, which
 * loads modules again per file.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface TenantStore {
  orgId?: string
  /** withoutTenantGuard() — code that must cross orgs, explicitly. */
  bypass?: boolean
}

const g = globalThis as unknown as { __clmTenantStorage?: AsyncLocalStorage<TenantStore> }
const storage = (g.__clmTenantStorage ??= new AsyncLocalStorage<TenantStore>())

/** Run `fn` in a fresh store, to be given its tenant once auth succeeds. */
export function runInTenantStore<T>(fn: () => T): T {
  return storage.run({}, fn)
}

/**
 * Record the tenant of the current request. The legacy `system` org (the
 * agents service without `x-org-id`) is no tenant: those calls scope by the
 * org their body names, which the internal routes set here in turn.
 */
export function setTenant(orgId: string | undefined | null): void {
  const store = storage.getStore()
  if (store && orgId && orgId !== 'system') store.orgId = orgId
}

/** The tenant to limit queries to, if any. */
export function currentTenant(): string | undefined {
  const store = storage.getStore()
  return store && !store.bypass ? store.orgId : undefined
}

/**
 * Run `fn` for `orgId`: for jobs and tests that act for one org outside a
 * request. Awaited inside the context, because a Prisma query runs only when
 * awaited: `() => prisma.contract.findMany()` handed back unawaited would
 * otherwise run later, outside it.
 */
export function withTenant<T>(orgId: string, fn: () => T | PromiseLike<T>): Promise<T> {
  return storage.run({ orgId }, async () => await fn())
}

/**
 * Run `fn` with the guard off. For the rare code that must read or write
 * across orgs inside a request; every use is a reviewed exception.
 */
export function withoutTenantGuard<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  const store = storage.getStore()
  return storage.run({ ...store, bypass: true }, async () => await fn())
}
