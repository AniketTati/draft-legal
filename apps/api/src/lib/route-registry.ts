/**
 * Every route the app registers, recorded as it is added (app.ts registers the
 * hook before any route), with the permission its requirePermission check
 * needs. Y1's route crawl walks it to call every endpoint across orgs; Y3
 * writes the web app's route permission table from it. It is the one list of
 * what the API serves.
 */
import type { RoutePermission } from '../middleware/permissions.js'

export interface RegisteredRoute {
  method: string
  url: string
  /** What its requirePermission check needs; null when it has none. */
  permission: RoutePermission | null
}

declare module 'fastify' {
  interface FastifyInstance {
    registeredRoutes: RegisteredRoute[]
  }
}

export function recordRoute(
  routes: RegisteredRoute[],
  route: { method: string | string[]; url: string; permission: RoutePermission | null },
): void {
  for (const method of [route.method].flat()) {
    // Fastify adds HEAD for every GET; OPTIONS comes from CORS.
    if (method === 'HEAD' || method === 'OPTIONS') continue
    routes.push({ method, url: route.url, permission: route.permission })
  }
}
