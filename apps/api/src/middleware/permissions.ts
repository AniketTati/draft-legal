/**
 * Permission middleware — requirePermission(action, resource).
 * Replaces the unused requireRole() as the standard RBAC enforcement.
 * Per 06-SECURITY-GOVERNANCE.md: "Every request checked against RBAC before reaching business logic"
 */

import type { FastifyRequest, FastifyReply } from 'fastify'
import { requireAuth } from './auth.js'
import { getPermissionsForRoles, evaluatePermission } from '../lib/permissions.js'

declare module 'fastify' {
  interface FastifyRequest {
    permissionScope?: string | null
  }
}

/** The permission a route's requirePermission check needs. */
export interface RoutePermission { action: string; resource: string }

/**
 * Fastify preHandler that checks the current user has the required permission.
 * On success, attaches `req.permissionScope` for route handlers to use in query filtering.
 * Y3 — the hook carries what it checks (`permission`), so the route list knows
 * each route's permission (lib/route-registry.ts), and the web app with it.
 *
 * Usage:
 *   { preHandler: [requirePermission('view', 'contract')] }
 *   { preHandler: [requirePermission('configure', 'user')] }
 */
export function requirePermission(action: string, resource: string) {
  const permission: RoutePermission = { action, resource }
  return Object.assign(async (req: FastifyRequest, reply: FastifyReply) => {
    // First ensure user is authenticated
    await requireAuth(req, reply)
    if (reply.sent) return

    // System/internal calls (agents service) are always granted org scope
    if (req.user.sub === 'system') {
      req.permissionScope = 'org'
      return
    }

    // Wave 1.2 — public-API-key requests carry pre-resolved permissions from
    // their scopes; evaluate those directly (no role lookup). Empty scopes →
    // empty permissions → denied.
    const { orgId, roles } = req.user
    const permissions = req.user.apiPermissions ?? await getPermissionsForRoles(orgId, roles)
    const result = evaluatePermission(permissions, action, resource)

    if (!result.granted) {
      return reply.status(403).send({
        type: 'https://httpstatuses.com/403',
        title: 'Forbidden',
        status: 403,
        detail: `Missing permission: ${action}:${resource}`,
      })
    }

    // Attach scope so route handlers can filter queries accordingly
    req.permissionScope = result.scope
  }, { permission })
}

/** Y3 — the permission a route's preHandler(s) check, if one is requirePermission's. */
export function routePermission(preHandler: unknown): RoutePermission | null {
  for (const hook of [preHandler].flat()) {
    const permission = (hook as { permission?: RoutePermission } | null | undefined)?.permission
    if (permission) return permission
  }
  return null
}

/**
 * The scope an already-authenticated caller holds for action:resource, or null
 * when not granted — evaluated exactly as requirePermission does. For routes
 * that return several kinds of record under one gate (the dashboard, a
 * matter's requests) and must narrow each by its own permission (X7).
 */
export async function permissionScopeFor(req: FastifyRequest, action: string, resource: string): Promise<string | null> {
  if (req.user.sub === 'system') return 'org'
  const permissions = req.user.apiPermissions ?? await getPermissionsForRoles(req.user.orgId, req.user.roles)
  return evaluatePermission(permissions, action, resource).scope
}
