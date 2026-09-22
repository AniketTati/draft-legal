/**
 * H2 — every webhook event a subscriber can choose must actually be emitted
 * somewhere, and nothing may be emitted that subscribers can't choose.
 * Half the advertised list (8 of 16) used to have no emitter at all.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : []
  })
}

// Read from source: importing the routes module would open queue/Redis connections.
const integrations = readFileSync(join(process.cwd(), 'src', 'routes', 'integrations.ts'), 'utf8')
const list = integrations.slice(integrations.indexOf('export const WEBHOOK_EVENTS'))
const WEBHOOK_EVENTS = [...list.slice(0, list.indexOf('] as const')).matchAll(/^\s*'([a-z_.]+)',/gm)].map(m => m[1])

const emitted = new Set<string>()
for (const f of files(join(process.cwd(), 'src'))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/fireWebhook\(\s*[^,]+,\s*'([a-z_.]+)'/g)) emitted.add(m[1])
}

describe('webhook events', () => {
  it('advertises exactly the events that are emitted', () => {
    expect(WEBHOOK_EVENTS.length).toBeGreaterThan(10)
    expect([...emitted].sort()).toEqual([...WEBHOOK_EVENTS].sort())
  })
})
