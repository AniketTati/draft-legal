/**
 * Permission engine — constants, default role permissions, evaluator, cache.
 * Aligned with 06-SECURITY-GOVERNANCE.md permission model:
 *   Permission = { action, resource, scope }
 */

import type { Permission } from '@clm/types'
import { PermissionAction as A, PermissionResource as R, PermissionScope as S, SystemRole } from '@clm/types'
import { prisma } from './prisma.js'

// ─── Default Permission Sets per System Role ─────────────────────────────────
// Per 06-SECURITY-GOVERNANCE.md:28-38

function p(action: Permission['action'], resource: Permission['resource'], scope: Permission['scope'] = S.ORG): Permission {
  return { action, resource, scope }
}

export const DEFAULT_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  [SystemRole.ADMIN]: [
    p('*', '*', S.ORG),
  ],
  [SystemRole.LEGAL_COUNSEL]: [
    p(A.VIEW, R.CONTRACT), p(A.EDIT, R.CONTRACT), p(A.CREATE, R.CONTRACT), p(A.DELETE, R.CONTRACT),
    p(A.SIGN, R.CONTRACT),    // P30 audit (2026-05-01): legal counsel sends contracts for signature
    p(A.APPROVE, R.WORKFLOW),
    p(A.VIEW, R.TEMPLATE), p(A.EDIT, R.TEMPLATE), p(A.CREATE, R.TEMPLATE),
    p(A.VIEW, R.CLAUSE), p(A.EDIT, R.CLAUSE), p(A.CREATE, R.CLAUSE),
    p(A.VIEW, R.PLAYBOOK), p(A.EDIT, R.PLAYBOOK), p(A.CREATE, R.PLAYBOOK),
    p(A.VIEW, R.REQUEST), p(A.EDIT, R.REQUEST), p(A.CREATE, R.REQUEST),
    p(A.VIEW, R.WORKFLOW),
    p(A.VIEW, R.REPORT),
    p(A.EXPORT, R.CONTRACT),
  ],
  [SystemRole.LEGAL_OPS]: [
    p(A.VIEW, R.CONTRACT), p(A.EDIT, R.CONTRACT), p(A.CREATE, R.CONTRACT), p(A.DELETE, R.CONTRACT),
    p(A.SIGN, R.CONTRACT),    // P30 audit (2026-05-01): legal ops sends contracts for signature
    p(A.APPROVE, R.WORKFLOW),
    p(A.VIEW, R.TEMPLATE), p(A.EDIT, R.TEMPLATE), p(A.CREATE, R.TEMPLATE), p(A.DELETE, R.TEMPLATE),
    p(A.VIEW, R.CLAUSE), p(A.EDIT, R.CLAUSE), p(A.CREATE, R.CLAUSE), p(A.DELETE, R.CLAUSE),
    p(A.VIEW, R.PLAYBOOK), p(A.EDIT, R.PLAYBOOK), p(A.CREATE, R.PLAYBOOK),
    p(A.VIEW, R.REQUEST), p(A.EDIT, R.REQUEST), p(A.CREATE, R.REQUEST),
    p(A.VIEW, R.WORKFLOW), p(A.CONFIGURE, R.WORKFLOW),
    p(A.VIEW, R.REPORT), p(A.EXPORT, R.REPORT),
    p(A.CONFIGURE, R.INTEGRATION),
    p(A.EXPORT, R.CONTRACT),
  ],
  [SystemRole.CONTRACT_MANAGER]: [
    p(A.VIEW, R.CONTRACT), p(A.EDIT, R.CONTRACT), p(A.CREATE, R.CONTRACT),
    p(A.SIGN, R.CONTRACT),    // P30 audit (2026-05-01): contract managers send contracts for signature
    p(A.VIEW, R.TEMPLATE), p(A.EDIT, R.TEMPLATE),
    p(A.VIEW, R.CLAUSE),
    p(A.VIEW, R.PLAYBOOK),
    p(A.VIEW, R.REQUEST), p(A.EDIT, R.REQUEST), p(A.CREATE, R.REQUEST),
    p(A.VIEW, R.WORKFLOW),
    p(A.EXPORT, R.CONTRACT),
  ],
  [SystemRole.SALES_REP]: [
    p(A.VIEW, R.CONTRACT, S.OWN), p(A.CREATE, R.CONTRACT, S.OWN),
    p(A.VIEW, R.TEMPLATE),
    p(A.VIEW, R.CLAUSE),
    p(A.CREATE, R.REQUEST), p(A.VIEW, R.REQUEST, S.OWN),
  ],
  [SystemRole.PROCUREMENT]: [
    p(A.VIEW, R.CONTRACT), p(A.EDIT, R.CONTRACT), p(A.CREATE, R.CONTRACT),
    p(A.VIEW, R.TEMPLATE),
    p(A.VIEW, R.CLAUSE),
    p(A.CREATE, R.REQUEST), p(A.VIEW, R.REQUEST),
    p(A.EXPORT, R.CONTRACT),
  ],
  [SystemRole.FINANCE]: [
    p(A.VIEW, R.CONTRACT),
    p(A.VIEW, R.REPORT), p(A.EXPORT, R.REPORT),
    // P7.1.2 fix — APPROVE alone wasn't enough: the /approvals/my-queue
    // endpoint is gated on VIEW workflow (you can't act on something you
    // can't see). Without VIEW, finance approvers got 403s and an empty
    // queue — which then cascaded into the "Approver Mode decision strip
    // never appears" symptom (F-41 + F-66 in docs/audit-2026-04-25.md).
    p(A.VIEW, R.WORKFLOW), p(A.APPROVE, R.WORKFLOW),
    p(A.EXPORT, R.CONTRACT),
  ],
  [SystemRole.APPROVER]: [
    p(A.VIEW, R.CONTRACT),
    // P7.1.2 fix — same as FINANCE: APPROVE without VIEW means the user
    // can't load /approvals/my-queue. The role's whole purpose is the
    // approval queue, so VIEW is implied.
    p(A.VIEW, R.WORKFLOW), p(A.APPROVE, R.WORKFLOW),
    p(A.VIEW, R.REPORT),
  ],
  [SystemRole.VIEWER]: [
    p(A.VIEW, R.CONTRACT),
    p(A.VIEW, R.TEMPLATE),
    p(A.VIEW, R.CLAUSE),
    p(A.VIEW, R.PLAYBOOK),
    p(A.VIEW, R.REPORT),
  ],
}

// ─── Role Description Map ────────────────────────────────────────────────────

export const DEFAULT_ROLE_DESCRIPTIONS: Record<string, string> = {
  [SystemRole.ADMIN]: 'Full system access — all actions, all resources, org-wide',
  [SystemRole.LEGAL_COUNSEL]: 'Legal team member — view/edit/create/approve contracts; manage clauses/playbook',
  [SystemRole.LEGAL_OPS]: 'Legal operations manager — all legal permissions + workflows + integrations + analytics',
  [SystemRole.CONTRACT_MANAGER]: 'Manage contract lifecycle — view/edit/create contracts; manage templates',
  [SystemRole.SALES_REP]: 'Request and track contracts — create requests; view own contracts',
  [SystemRole.PROCUREMENT]: 'Vendor contract management — full contract access for vendor/procurement types',
  [SystemRole.FINANCE]: 'Financial visibility — view contracts; view obligations; approve',
  [SystemRole.APPROVER]: 'Approve contracts — view + approve only (no edit)',
  [SystemRole.VIEWER]: 'Read-only access — view contracts, templates, and clauses',
}

// ─── API-key scopes → permissions (Wave 1.2, 2026-07) ───────────────────────
// Public-API keys carry `scopes` (strings), NOT role names. Before this,
// middleware/auth.ts did `roles: key.scopes.length ? key.scopes : ['ADMIN']`,
// which meant: an empty-scope key silently became org ADMIN, and a scoped key's
// strings were looked up as role names → resolved to nothing → every call 403'd.
// Now each scope maps to a concrete permission set, an empty scope list grants
// NOTHING, and unknown scopes are rejected at key creation (integrations.ts).
export const API_SCOPE_PERMISSIONS: Record<string, Permission[]> = {
  'contracts:read':   [p(A.VIEW, R.CONTRACT), p(A.VIEW, R.TEMPLATE), p(A.VIEW, R.CLAUSE)],
  'contracts:write':  [p(A.VIEW, R.CONTRACT), p(A.CREATE, R.CONTRACT), p(A.EDIT, R.CONTRACT)],
  'contracts:delete': [p(A.DELETE, R.CONTRACT)],
  'contracts:sign':   [p(A.SIGN, R.CONTRACT)],
  'contracts:export': [p(A.EXPORT, R.CONTRACT)],
  'requests:read':    [p(A.VIEW, R.REQUEST)],
  'requests:write':   [p(A.VIEW, R.REQUEST), p(A.CREATE, R.REQUEST), p(A.EDIT, R.REQUEST)],
  'templates:read':   [p(A.VIEW, R.TEMPLATE)],
  'templates:write':  [p(A.VIEW, R.TEMPLATE), p(A.CREATE, R.TEMPLATE), p(A.EDIT, R.TEMPLATE)],
  'reports:read':     [p(A.VIEW, R.REPORT)],
  // Explicit full access — opt-in only. Empty scopes no longer grant this.
  'admin':            [p('*', '*', S.ORG)],
}

/** Scope strings a public-API key is allowed to request (validated at creation). */
export const VALID_API_SCOPES: string[] = Object.keys(API_SCOPE_PERMISSIONS)

/**
 * Resolve an API key's scope strings into a merged permission set.
 * Unknown scopes contribute nothing; an empty list yields no permissions.
 */
export function resolveApiScopePermissions(scopes: string[]): Permission[] {
  const merged: Permission[] = []
  for (const scope of scopes) {
    const perms = API_SCOPE_PERMISSIONS[scope]
    if (perms) merged.push(...perms)
  }
  return merged
}

// ─── Permission Evaluator ────────────────────────────────────────────────────

/**
 * Check if a set of permissions grants access for the given action+resource.
 * Supports wildcard '*' matching on both action and resource.
 * Returns the most permissive scope found, or null if no match.
 */
export function evaluatePermission(
  permissions: Permission[],
  action: string,
  resource: string,
): { granted: boolean; scope: Permission['scope'] | null } {
  const SCOPE_RANK: Record<string, number> = { own: 0, team: 1, department: 2, org: 3 }
  let bestScope: Permission['scope'] | null = null
  let bestRank = -1

  for (const perm of permissions) {
    const actionMatch = perm.action === '*' || perm.action === action
    const resourceMatch = perm.resource === '*' || perm.resource === resource
    if (actionMatch && resourceMatch) {
      const rank = SCOPE_RANK[perm.scope] ?? 0
      if (rank > bestRank) {
        bestRank = rank
        bestScope = perm.scope
      }
    }
  }

  return { granted: bestScope !== null, scope: bestScope }
}

// ─── Permission Cache ────────────────────────────────────────────────────────
// In-memory cache: orgId → { permissions per roleName, fetchedAt }
// TTL: 5 minutes — balances freshness with DB load

interface CacheEntry {
  roles: Map<string, Permission[]>
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Get merged permissions for a set of role names within an org.
 * Uses in-memory cache with 5-min TTL.
 */
export async function getPermissionsForRoles(orgId: string, roleNames: string[]): Promise<Permission[]> {
  const now = Date.now()
  let entry = cache.get(orgId)

  if (!entry || now - entry.fetchedAt > CACHE_TTL_MS) {
    // Fetch all roles for this org (system roles have orgId null)
    const roles = await prisma.role.findMany({
      where: {
        OR: [{ orgId }, { orgId: null, isSystem: true }],
      },
      select: { name: true, permissions: true },
    })

    const rolesMap = new Map<string, Permission[]>()
    for (const role of roles) {
      const perms = (role.permissions as unknown as Permission[]) ?? []
      // If DB permissions are empty, fall back to defaults
      const effective = perms.length > 0 ? perms : (DEFAULT_ROLE_PERMISSIONS[role.name] ?? [])
      rolesMap.set(role.name, effective)
    }
    entry = { roles: rolesMap, fetchedAt: now }
    cache.set(orgId, entry)
  }

  // Merge permissions from all user's roles
  const merged: Permission[] = []
  for (const roleName of roleNames) {
    const rolePerms = entry.roles.get(roleName) ?? DEFAULT_ROLE_PERMISSIONS[roleName] ?? []
    merged.push(...rolePerms)
  }
  return merged
}

/**
 * Invalidate cache for an org (call after role permission changes).
 */
export function invalidatePermissionCache(orgId: string): void {
  cache.delete(orgId)
}

/**
 * Clear entire cache (for testing).
 */
export function clearPermissionCache(): void {
  cache.clear()
}

/**
 * The org's active people who may do action:resource, as their roles grant it
 * — who to tell when something needs someone with that right (docs/39 C3:
 * a suggested field, for whoever can add fields).
 */
export async function usersWhoCan(
  orgId: string, action: string, resource: string,
  opts: { exclude?: string; take?: number } = {},
): Promise<Array<{ id: string; email: string; name: string }>> {
  const users = await prisma.user.findMany({
    where: { orgId, deletedAt: null, status: 'ACTIVE', ...(opts.exclude ? { id: { not: opts.exclude } } : {}) },
    select: { id: true, email: true, name: true, userRoles: { select: { role: { select: { name: true } } } } },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })
  const out: Array<{ id: string; email: string; name: string }> = []
  for (const u of users) {
    const perms = await getPermissionsForRoles(orgId, u.userRoles.map(r => r.role.name))
    if (evaluatePermission(perms, action, resource).granted) out.push({ id: u.id, email: u.email, name: u.name })
    if (out.length >= (opts.take ?? 20)) break
  }
  return out
}
