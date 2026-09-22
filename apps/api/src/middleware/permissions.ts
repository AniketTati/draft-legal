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

/**
 * Fastify preHandler that checks the current user has the required permission.
 * On success, attaches `req.permissionScope` for route handlers to use in query filtering.
 *
 * Usage:
 *   { preHandler: [requirePermission('view', 'contract')] }
 *   { preHandler: [requirePermission('configure', 'user')] }
 */
export function requirePermission(action: string, resource: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
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
  }
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
