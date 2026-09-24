/**
 * Y3 — which permission an API call needs, read from the server's own routes
 * (route-permissions.gen.ts, generated from requirePermission on each route),
 * and whether the signed-in user holds it.
 *
 * The web app used to decide what to offer button by button, with its own
 * idea of each action's permission (X61, then X75 three times), and each miss
 * sent a request the server refused. Now a gate names the request it guards
 * (`<Can request="POST /contracts/:id/share">`), and the API client refuses a
 * write the user can't make before sending it (lib/api.ts).
 */
import { ROUTE_PERMISSIONS } from './route-permissions.gen'

export interface Permission { action: string; resource: string; scope?: string }
export interface RolePermissions { name: string; permissions: Permission[] }
type Needed = { action: string; resource: string }

interface Route { method: string; segments: string[]; permission: Needed | null }

const ROUTES: Route[] = Object.entries(ROUTE_PERMISSIONS).map(([key, permission]) => {
  const [method, path] = key.split(' ')
  return { method, segments: path.split('/').filter(Boolean), permission }
})

/**
 * The route a call reaches, as the server's router picks it: a static segment
 * beats a parameter. `url` is as the client has it (with or without /api/v1,
 * with a query); a path pattern (`/contracts/:id/share`) works too. None when
 * no route matches.
 */
export function routeFor(method: string, url: string): Route | undefined {
  const segments = url.replace(/^(https?:\/\/[^/]+)?\/api\/v1(?=\/)/, '').split(/[?#]/)[0].split('/').filter(Boolean)
  let best: Route | undefined
  let bestStatic = -1
  for (const route of ROUTES) {
    if (route.method !== method.toUpperCase()) continue
    const rest = route.segments[route.segments.length - 1] === '*'
    const fixed = rest ? route.segments.length - 1 : route.segments.length
    if (rest ? segments.length < fixed : segments.length !== fixed) continue
    let statics = 0
    let matches = true
    for (let i = 0; i < fixed; i++) {
      const s = route.segments[i]
      if (s.startsWith(':')) continue
      if (s !== segments[i]) { matches = false; break }
      statics++
    }
    if (matches && statics > bestStatic) { best = route; bestStatic = statics }
  }
  return best
}

/**
 * The permissions a user holds, from their role names and the org's role
 * catalogue: every permission (ADMIN), or none known yet (no catalogue).
 */
export function heldPermissions(roleNames: string[], roles: RolePermissions[] | undefined): Permission[] | 'all' | null {
  if (roleNames.includes('ADMIN')) return 'all'
  if (!roles) return null
  return roles.filter(r => roleNames.includes(r.name)).flatMap(r => r.permissions)
}

/** The permission a call needs that `held` lacks, if any. A route that needs none, or that isn't known, needs nothing here: the server decides. */
export function missingPermission(held: Permission[] | 'all', method: string, url: string): Needed | null {
  const needed = routeFor(method, url)?.permission
  if (!needed || held === 'all') return null
  const has = held.some(p => (p.action === '*' || p.action === needed.action) && (p.resource === '*' || p.resource === needed.resource))
  return has ? null : needed
}

export function canRequest(held: Permission[] | 'all', method: string, url: string): boolean {
  return missingPermission(held, method, url) === null
}

const PLURAL: Record<string, string> = { organization: 'organization settings', matter: 'matters', playbook: 'playbooks', workflow: 'workflows' }

/** What the user is told when the client refuses a call for them. */
export function refusalMessage({ action, resource }: Needed): string {
  return `You don't have permission to ${action} ${PLURAL[resource] ?? `${resource}s`}.`
}

// The org's role catalogue, as lib/permissions.ts last fetched it: the API
// client reads it outside React. Until it arrives, nothing is refused here.
let catalogue: RolePermissions[] | undefined
export function rememberRoles(roles: RolePermissions[] | undefined): void { catalogue = roles }
export function knownRoles(): RolePermissions[] | undefined { return catalogue }
