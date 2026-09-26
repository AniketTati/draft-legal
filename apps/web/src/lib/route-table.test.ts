/**
 * Y3 — every write the web app sends is to a route the server has. The route
 * table the client judges permissions by then covers what it calls, and a
 * mistyped or stale path fails here rather than as a 404 in front of a user.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { routeFor } from './can-request'

const SRC = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : []
  })
}

/** Each `api.post|put|patch|delete(…)` call whose path is written out: its method, and the path with each `${…}` as one segment's value. */
function writes(code: string): Array<{ method: string; path: string }> {
  return [...code.matchAll(/\bapi\.(post|put|patch|delete)(?:<[^>]*>)?\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)]
    .map(m => ({ method: m[1].toUpperCase(), path: m[2].slice(1, -1).replace(/\$\{[^}]*\}/g, 'x') }))
}

describe('the web app\'s writes', () => {
  const found = sources(SRC).flatMap(file => writes(readFileSync(file, 'utf8')).map(w => ({ file: relative(SRC, file), ...w })))

  it('are all to routes the server has', () => {
    expect(found.filter(w => !routeFor(w.method, w.path)).map(w => `${w.file}: ${w.method} ${w.path}`)).toEqual([])
    expect(found.length).toBeGreaterThan(100)
  })

  it('are read however the call is written', () => {
    expect(writes('api.post<Row>(`/contracts/${id}/share?days=${n}`, body)')).toEqual([{ method: 'POST', path: '/contracts/x/share?days=x' }])
    expect(writes('api.delete(\'/admin/integrations/slack\')')).toEqual([{ method: 'DELETE', path: '/admin/integrations/slack' }])
  })
})
