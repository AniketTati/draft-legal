/**
 * Prisma client singleton (production-tuned).
 *
 * Connection pool: Prisma defaults to `num_physical_cpus * 2 + 1`. On a
 * 4-core box that's 9 — usually fine, but under burst load (Bull
 * workers + API + audit-chain transactions) we've seen pool exhaustion.
 * Cap at 20 explicitly so Postgres doesn't get hammered + Prisma fails
 * fast with `connection_limit reached` instead of a slow timeout.
 *
 * Slow-query log: in production, every query >SLOW_QUERY_MS lands in
 * the API logs at warn level. Threshold default 250ms (the p99 of a
 * healthy contracts-list page). Cheap to maintain and saves us from
 * "everything is slow but we don't know why" tickets.
 */
import { PrismaClient } from '@prisma/client'
import pino from 'pino'
import { tenantGuardExtension } from './tenant-guard.js'
import { tenantRlsExtension, tenantTransaction } from './tenant-rls.js'

const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 250)
const POOL_LIMIT    = Number(process.env.PRISMA_POOL_LIMIT ?? 20)

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', name: 'prisma' })

// Apply the pool limit by appending ?connection_limit=N to the URL if
// not already specified. This is the documented way per Prisma docs.
function withPoolLimit(url: string | undefined): string | undefined {
  if (!url) return url
  if (/[?&]connection_limit=/.test(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}connection_limit=${POOL_LIMIT}`
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaBase?: PrismaClient }

function makeClient() {
  const tunedUrl = withPoolLimit(process.env.DATABASE_URL)
  const client = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'error' },
            { emit: 'event', level: 'warn' },
          ],
    datasources: tunedUrl ? { db: { url: tunedUrl } } : undefined,
  })

  // Production: structured slow-query log + error / warn surfacing.
  // In development we keep Prisma's default raw SQL output (more
  // useful when debugging an actual query).
  if (process.env.NODE_ENV !== 'development') {
    client.$on('query', (e: { query: string; params: string; duration: number; target: string }) => {
      if (e.duration >= SLOW_QUERY_MS) {
        log.warn({
          slowQuery: true,
          durationMs: e.duration,
          query: e.query.length > 500 ? e.query.slice(0, 500) + '…' : e.query,
          target: e.target,
        }, `slow query (${e.duration}ms)`)
      }
    })
    client.$on('error', (e: { message: string; target: string }) => {
      log.error({ prisma: true, target: e.target }, e.message)
    })
    client.$on('warn', (e: { message: string; target: string }) => {
      log.warn({ prisma: true, target: e.target }, e.message)
    })
  }
  return client
}

// Y1 — tenant isolation in two layers, for every query made for a tenant:
//   - lib/tenant-guard.ts limits each Prisma query on a model with an `orgId`
//     to the tenant, whatever its `where` says;
//   - lib/tenant-rls.ts runs it as the role Postgres's row-level security
//     policies confine to the tenant's rows, raw SQL and relations included.
// The extensions leave the model API unchanged, so the client keeps its type.
function makeGuardedClient(): PrismaClient {
  const base = makeClient()
  globalForPrisma.prismaBase = base
  const guarded = base.$extends(tenantGuardExtension(base)) as unknown as PrismaClient
  const client = guarded.$extends(tenantRlsExtension(guarded)) as unknown as PrismaClient
  client.$transaction = tenantTransaction(guarded)
  return client
}

export const prisma = globalForPrisma.prisma ?? makeGuardedClient()

/**
 * Register Prisma middleware (the deprecated `$use`), which an extended client
 * no longer offers. Middleware on the base client still runs for every query
 * the guarded client makes. For tests that hold a query to stage a race.
 */
export function usePrismaMiddleware(middleware: Parameters<PrismaClient['$use']>[0]): void {
  globalForPrisma.prismaBase!.$use(middleware)
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
