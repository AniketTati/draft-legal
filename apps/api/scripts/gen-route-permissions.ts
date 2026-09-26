/**
 * Y3 — write the web app's route permission table
 * (apps/web/src/lib/route-permissions.gen.ts) from the routes the API
 * registers, with the permission each one's requirePermission check needs.
 * routes/route-permissions.integration.test.ts fails until it is re-run
 * after a route or its permission changes.
 *
 * Usage:
 *   pnpm --filter api gen:route-permissions
 */
import { writeFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { routePermissionsSource, WEB_ROUTE_TABLE } from '../src/lib/route-permissions.js'

const app = await buildApp()
await app.ready()
writeFileSync(WEB_ROUTE_TABLE, routePermissionsSource(app.registeredRoutes))
console.log(`wrote ${WEB_ROUTE_TABLE}: ${app.registeredRoutes.filter(r => r.url.startsWith('/api/v1/')).length} routes`)
await app.close()
process.exit(0)
