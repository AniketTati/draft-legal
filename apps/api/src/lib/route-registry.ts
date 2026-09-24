/**
 * Every route the app registers, recorded as it is added (app.ts registers the
 * hook before any route). Y1's route crawl walks it to call every endpoint
 * across orgs; it is the one list of what the API serves.
 */
export interface RegisteredRoute {
  method: string
  url: string
}

declare module 'fastify' {
  interface FastifyInstance {
    registeredRoutes: RegisteredRoute[]
  }
}

export function recordRoute(routes: RegisteredRoute[], route: { method: string | string[]; url: string }): void {
  for (const method of [route.method].flat()) {
    // Fastify adds HEAD for every GET; OPTIONS comes from CORS.
    if (method === 'HEAD' || method === 'OPTIONS') continue
    routes.push({ method, url: route.url })
  }
}
