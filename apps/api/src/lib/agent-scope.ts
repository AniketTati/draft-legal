/**
 * Caller scope for the agent's internal tool routes (S2).
 *
 * /internal/ai/tools/* authenticates the agents SERVICE (x-internal-secret),
 * not the person chatting, so requirePermission never runs there and
 * `req.permissionScope` is never set. Without this, a SALES_REP — whose
 * VIEW:CONTRACT is `own` — got org-wide contract data by asking the assistant.
 *
 * The scope is resolved HERE, from the caller's roles in the DB (or an API
 * key's scopes), with the same evaluator requirePermission uses. The agent
 * request body only ever supplies an identity (`userId`, injected from the JWT
 * by agents.ts / agent-threads.ts) — never a scope, which a prompt-injected or
 * buggy caller could widen.
 *
 * Identity convention:
 *   - `userId` key ABSENT  → a service call with no user in the loop (e.g. the
 *     playbook-review worker). Org scope, as for `sub === 'system'` in
 *     requirePermission.
 *   - `userId` PRESENT     → must resolve to an active user or live API key of
 *     this org. Anything else (null, "anonymous", another org's user) is
 *     denied, so the chat path fails closed.
 *
 * Mirrors REST: only `own` narrows. `team`/`department` are treated as org,
 * exactly as contracts.ts / requests.ts do today.
 */
import { prisma } from './prisma.js'
import { getPermissionsForRoles, evaluatePermission, resolveApiScopePermissions } from './permissions.js'

export type CallerScope =
  | { kind: 'org' }
  | { kind: 'own'; userId: string }
  | { kind: 'none' }

export async function resolveCallerScope(
  orgId: string,
  userId: string | null | undefined,
  resource: 'contract' | 'request',
): Promise<CallerScope> {
  if (userId === undefined) return { kind: 'org' }
  if (!userId) return { kind: 'none' }

  let permissions
  if (userId.startsWith('apikey:')) {
    const key = await prisma.apiKey.findFirst({
      where: { id: userId.slice('apikey:'.length), orgId, revokedAt: null },
      select: { scopes: true, expiresAt: true },
    })
    if (!key || (key.expiresAt && key.expiresAt < new Date())) return { kind: 'none' }
    permissions = resolveApiScopePermissions(key.scopes)
  } else {
    const user = await prisma.user.findFirst({
      where: { id: userId, orgId, deletedAt: null, status: { not: 'DEACTIVATED' } },
      select: { userRoles: { select: { role: { select: { name: true } } } } },
    })
    if (!user) return { kind: 'none' }
    permissions = await getPermissionsForRoles(orgId, user.userRoles.map(ur => ur.role.name))
  }

  const result = evaluatePermission(permissions, 'view', resource)
  if (!result.granted) return { kind: 'none' }
  return result.scope === 'own' ? { kind: 'own', userId } : { kind: 'org' }
}

/** Prisma `where` fragment for Contract rows the caller may see. */
export function contractScopeWhere(scope: CallerScope): { ownerId?: string } {
  return scope.kind === 'own' ? { ownerId: scope.userId } : {}
}

/** Owner id to push into retrieval queries (pgvector / ES), or undefined for org scope. */
export function scopeOwnerId(scope: CallerScope): string | undefined {
  return scope.kind === 'own' ? scope.userId : undefined
}
