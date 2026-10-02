/**
 * docs/41 Part 20 — every webhook event a REST-hook subscriber can choose has
 * a sample delivery for Zapier's test step.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hookSample, SAMPLE_DATA } from './hook-samples.js'

describe('REST hook samples', () => {
  it('has one for every webhook event a subscriber can choose', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'routes', 'integrations.ts'), 'utf8')
    const list = src.slice(src.indexOf('export const WEBHOOK_EVENTS'))
    const events = [...list.slice(0, list.indexOf('] as const')).matchAll(/^\s*'([a-z_.]+)',/gm)].map(m => m[1])
    expect(events.length).toBeGreaterThan(10)
    expect(Object.keys(SAMPLE_DATA).sort()).toEqual([...events].sort())
    expect(hookSample('contract.executed')).toMatchObject({ event: 'contract.executed', data: { contractId: expect.any(String) } })
    expect(hookSample('nope')).toBeNull()
  })

  it('docs/42 lists every event with the same sample', () => {
    const doc = readFileSync(join(process.cwd(), '..', '..', 'docs', '42-ZAPIER-REST-HOOKS.md'), 'utf8')
    expect(doc).toContain(`signed webhooks for ${Object.keys(SAMPLE_DATA).length} events`)
    for (const [event, data] of Object.entries(SAMPLE_DATA)) {
      const row = doc.split('\n').find(l => l.startsWith(`| \`${event}\` |`))
      expect(row, event).toBeTruthy()
      const sample = /\| `(\{.*\})` \|$/.exec(row!)?.[1]
      expect(JSON.parse(sample!), event).toEqual(data)
    }
  })
})
