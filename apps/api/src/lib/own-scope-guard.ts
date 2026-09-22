/**
 * Own-scope guards for routes that take a record id (X7).
 *
 * `requirePermission` resolves the caller's scope into `req.permissionScope`,
 * but only the contracts LIST route ever read it — so a SALES_REP (view:contract
 * at `own`) could open any contract by id, with every version's text, plus its
 * comments, share links and signature requests. Rather than hand-edit ~45
 * routes (and miss the next one), each plugin whose routes take an id
 * registers a hook: it appends an ownership check after the route's own
 * preHandlers, i.e. after requirePermission has set the scope.
 *
 * Only `own` narrows (team/department fall through to org, as elsewhere).
 * Service callers and API keys resolve to `org` and are untouched.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { prisma } from './prisma.js'

/** Does the (own-scope) caller own the record with this id? */
export type Owns = (req: FastifyRequest, id: string) => Promise<boolean>

export type OwnScopeGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>

/** A preHandler that 404s an `own`-scope caller unless it owns the record named by `param`. */
export function ownScopeGuard(owns: Owns, detail: string, param = 'id'): OwnScopeGuard {
  return async (req, reply) => {
    if (req.permissionScope !== 'own') return
    const id = (req.params as Record<string, string | undefined> | undefined)?.[param]
    if (!id || await owns(req, id)) return
    // 404, not 403 — don't confirm that someone else's record exists. Return
    // the reply so Fastify stops here even if a later hook awaits.
    return reply.status(404).send({ detail })
  }
}

/** Append `guard` to every route in this plugin whose URL matches `urlPattern`. */
export function guardOwnScopeRoutes(app: FastifyInstance, urlPattern: RegExp, guard: OwnScopeGuard): void {
  app.addHook('onRoute', (route: RouteOptions) => {
    if (!urlPattern.test(route.url)) return
    const existing = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : []
    route.preHandler = [...existing, guard] as RouteOptions['preHandler']
  })
}

export const ownsContract: Owns = async (req, id) =>
  (await prisma.contract.count({ where: { id, orgId: req.user.orgId, ownerId: req.user.sub } })) > 0

export const ownScopeContractGuard = ownScopeGuard(ownsContract, 'Contract not found')

/** Guard every route in this plugin whose URL has a contract id segment (`:id` unless `param` says otherwise). */
export function guardOwnScopeContractRoutes(app: FastifyInstance, urlPattern = /\/:id(\/|$)/, param = 'id'): void {
  guardOwnScopeRoutes(app, urlPattern, param === 'id' ? ownScopeContractGuard : ownScopeGuard(ownsContract, 'Contract not found', param))
}

/** Prisma `where` fragment on Contract: own-scope callers see only the contracts they own. */
export function ownContractWhere(req: FastifyRequest): { ownerId?: string } {
  return req.permissionScope === 'own' ? { ownerId: req.user.sub } : {}
}
