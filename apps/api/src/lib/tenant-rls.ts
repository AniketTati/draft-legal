/**
 * Y1 — Postgres row-level security, the database's half of tenant isolation.
 *
 * The migration `20260924100000_tenant_row_level_security` gives every table
 * that holds tenant data a policy confining the role `clm_tenant_access` to
 * the rows of the tenant named by `app.tenant_id`. This extension runs every
 * query made for a tenant (lib/tenant-context.ts) as that role, with that
 * setting, for the query's own transaction:
 *
 *   - a query on its own becomes a two-statement transaction: set the role and
 *     the tenant, then the query (Prisma's documented pattern for RLS);
 *   - `$transaction(fn)` sets them once, first thing in the transaction;
 *   - `$transaction([...])` gets them as the batch's first statement.
 *
 * Settings made with `set_config(…, true)` end with their transaction, so a
 * pooled connection never carries a tenant into the next query.
 *
 * Where lib/tenant-guard.ts rewrites Prisma queries, this holds for what it
 * can't see: raw SQL, rows reached through relations, and any query whose
 * `where` was built somewhere the guard's rewrite doesn't reach. Outside a
 * tenant context nothing changes: queries run as the application's login,
 * which the policies leave alone.
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import { currentTenant } from './tenant-context.js'

/** The role tenant queries run as. It holds no rights beyond its policies. */
export const TENANT_ROLE = 'clm_tenant_access'

const g = globalThis as unknown as { __clmTenantRls?: { enabled: boolean } }
const state = (g.__clmTenantRls ??= { enabled: true })

/** Tests only: the route crawl's first pass checks the routes' own scoping. */
export function setTenantRlsEnabled(on: boolean): void {
  state.enabled = on
}

function tenantForQuery(): string | undefined {
  return state.enabled ? currentTenant() : undefined
}

type Transaction = (arg: unknown, options?: unknown) => Promise<unknown>

const enter = (client: PrismaClient, tenant: string) =>
  client.$executeRaw`SELECT set_config('role', ${TENANT_ROLE}, true), set_config('app.tenant_id', ${tenant}, true)`

export function tenantRlsExtension(client: PrismaClient) {
  return Prisma.defineExtension({
    name: 'tenant-rls',
    query: {
      async $allOperations({ args, query, ...rest }) {
        const tenant = tenantForQuery()
        // Inside a transaction the role and tenant were set when it began.
        const inTransaction = (rest as { __internalParams?: { transaction?: unknown } }).__internalParams?.transaction
        if (!tenant || inTransaction) return query(args)
        const [, result] = await client.$transaction([enter(client, tenant), query(args) as never])
        return result
      },
    },
  })
}

/**
 * The client's `$transaction`, setting the role and tenant first thing in the
 * transaction. lib/prisma.ts installs it as the client's own property rather
 * than through a client extension: Prisma describes a property an extension
 * adds without its value, so a test that stubs `$transaction` and restores it
 * would put back `undefined`.
 */
export function tenantTransaction(client: PrismaClient): PrismaClient['$transaction'] {
  const transaction = client.$transaction.bind(client) as unknown as Transaction
  return ((arg: unknown, options?: unknown) => {
    const tenant = tenantForQuery()
    if (!tenant) return transaction(arg, options)
    if (Array.isArray(arg)) {
      return transaction([enter(client, tenant), ...arg], options).then(results => (results as unknown[]).slice(1))
    }
    return transaction(async (tx: PrismaClient) => {
      await enter(tx, tenant)
      return (arg as (tx: PrismaClient) => unknown)(tx)
    }, options)
  }) as unknown as PrismaClient['$transaction']
}
