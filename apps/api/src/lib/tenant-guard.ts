/**
 * Y1 — tenant isolation below the routes.
 *
 * Org scoping used to live only in each query's own `where: { orgId }`, and
 * ten cross-org defects were found and fixed one route at a time (S2, X6, X7,
 * X9, X10, X19–X21, X25, X44). This Prisma query extension limits every query
 * on a model that has an `orgId` column to the tenant of the current request
 * (lib/tenant-context.ts), whatever the route wrote:
 *
 *   - reads, counts, aggregates and groupings see only the tenant's rows;
 *   - updates, deletes and upserts, by id or in bulk, reach only the tenant's
 *     rows (another org's id becomes "not found", answered 404);
 *   - a create naming another org is refused (TenantGuardError, 403).
 *
 * Role and Skill keep built-in rows with no org; those stay visible to every
 * tenant ("the tenant's rows or built-in ones").
 *
 * A lookup by id or a unique key that the limit turned into a miss, where the
 * row exists in another org, is reported as `tenant_guard_blocked`: the route
 * relied on the guard, which is a bug to fix even though nothing leaked. The
 * route crawl (routes/tenant-isolation-crawl.integration.test.ts) fails on it.
 *
 * The models come from Prisma's schema metadata, so a new model with an
 * `orgId` is covered without touching this file. Not covered: raw SQL, rows
 * reached through nested relations, and code outside a tenant context
 * (sign-in, public token routes, background jobs).
 */
import { EventEmitter } from 'node:events'
import { moduleLogger } from './logger.js'
import { Prisma, type PrismaClient } from '@prisma/client'
import { currentTenant } from './tenant-context.js'

interface OrgModel { delegate: string; nullable: boolean }

/** Every model with an `orgId` column, by model name. */
export const ORG_MODELS: ReadonlyMap<string, OrgModel> = new Map(
  Prisma.dmmf.datamodel.models.flatMap(m => {
    const field = m.fields.find(f => f.name === 'orgId' && f.kind === 'scalar')
    return field ? [[m.name, { delegate: m.name[0].toLowerCase() + m.name.slice(1), nullable: !field.isRequired }] as const] : []
  }),
)

/** Operations whose `where` is limited to the tenant. */
const SCOPED = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
])
/** Of those, the ones that name one row, where a miss is worth explaining. */
const ONE_ROW = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'update', 'upsert', 'delete'])

export class TenantGuardError extends Error {
  statusCode = 403
  constructor(model: string) {
    super(`A ${model} can only be created in your own organization`)
    this.name = 'TenantGuardError'
  }
}

export interface TenantGuardBlock { model: string; operation: string; tenant: string }

const g = globalThis as unknown as { __clmTenantGuard?: { enabled: boolean; events: EventEmitter } }
const state = (g.__clmTenantGuard ??= { enabled: true, events: new EventEmitter() })
const log = moduleLogger('tenant-guard')

/** Tests only: the route crawl's first pass checks the routes' own scoping. */
export function setTenantGuardEnabled(on: boolean): void {
  state.enabled = on
}

/** Subscribe to blocked cross-org lookups; returns the unsubscribe function. */
export function onTenantGuardBlocked(listener: (block: TenantGuardBlock) => void): () => void {
  state.events.on('blocked', listener)
  return () => { state.events.off('blocked', listener) }
}

type Where = Record<string, unknown> | undefined

function scopeFor(tenant: string, model: OrgModel): Record<string, unknown> {
  return model.nullable ? { OR: [{ orgId: tenant }, { orgId: null }] } : { orgId: tenant }
}

function withScope(where: Where, scope: Record<string, unknown>): Record<string, unknown> {
  if (!where) return { ...scope }
  const and = where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND]
  return { ...where, AND: [...and, scope] }
}

/** Whether a `where` already limits to the tenant itself (then a miss is only a miss). */
function namesTenant(where: Where, tenant: string): boolean {
  if (!where) return false
  if (where.orgId === tenant) return true
  return Object.values(where).some(v => !!v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).orgId === tenant)
}

function refuseForeign(model: string, data: unknown, tenant: string): void {
  if (!data || typeof data !== 'object') return
  const d = data as { orgId?: unknown; org?: { connect?: { id?: unknown } } }
  if (d.orgId !== undefined && d.orgId !== tenant) throw new TenantGuardError(model)
  if (d.org?.connect?.id !== undefined && d.org.connect.id !== tenant) throw new TenantGuardError(model)
}

function isNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025'
}

export function tenantGuardExtension(base: PrismaClient) {
  async function reportIfForeign(model: string, spec: OrgModel, operation: string, where: Where, tenant: string) {
    if (!where || namesTenant(where, tenant)) return
    const delegate = (base as unknown as Record<string, { findFirst: (a: unknown) => Promise<{ orgId: string | null } | null> }>)[spec.delegate]
    const found = await delegate.findFirst({ where, select: { orgId: true } }).catch(() => null)
    if (!found || found.orgId === tenant || (spec.nullable && found.orgId === null)) return
    const block = { model, operation, tenant }
    log.warn(block, 'tenant_guard_blocked: a lookup reached another organization\'s record')
    state.events.emit('blocked', block)
  }

  return Prisma.defineExtension({
    name: 'tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const tenant = currentTenant()
          const spec = ORG_MODELS.get(model)
          if (!tenant || !spec || !state.enabled) return query(args)

          const a = { ...(args as Record<string, unknown>) }
          if (operation === 'create' || operation === 'upsert') refuseForeign(model, operation === 'create' ? a.data : a.create, tenant)
          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            for (const d of [a.data].flat()) refuseForeign(model, d, tenant)
          }
          if (!SCOPED.has(operation)) return query(a)

          const original = a.where as Where
          a.where = withScope(original, scopeFor(tenant, spec))
          try {
            const result = await query(a)
            if (result === null && ONE_ROW.has(operation)) await reportIfForeign(model, spec, operation, original, tenant)
            return result
          } catch (err) {
            if (isNotFound(err) && ONE_ROW.has(operation)) await reportIfForeign(model, spec, operation, original, tenant)
            throw err
          }
        },
      },
    },
  })
}
