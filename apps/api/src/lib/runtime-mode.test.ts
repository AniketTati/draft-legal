/**
 * Y5 — the API relaxes a security check only in a developer's own stack or
 * the test run, never because NODE_ENV isn't `production`: staging, a
 * preview, a typo and an unset value are all strict.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runtimeMode, environmentName, devFlag, assertNoDevOnlyFlags, globalRateLimitPerMinute } from './runtime-mode.js'

const STRICT = ['production', 'staging', 'preview', 'Production', 'dev', 'prod ', '', undefined]

describe('the runtime mode', () => {
  it('is strict unless NODE_ENV is exactly development or test', () => {
    expect(runtimeMode({ NODE_ENV: 'development' })).toBe('development')
    expect(runtimeMode({ NODE_ENV: 'test' })).toBe('test')
    for (const NODE_ENV of STRICT) expect(runtimeMode({ NODE_ENV }), JSON.stringify(NODE_ENV)).toBe('strict')
  })

  it('labels logs and the health output with NODE_ENV as set', () => {
    expect(environmentName({ NODE_ENV: 'staging' })).toBe('staging')
    expect(environmentName({})).toBe('unset')
  })
})

describe('development-only relaxations', () => {
  const ON = { BULL_BOARD_OPEN: 'true', INBOUND_EMAIL_ALLOW_ALL: '1' }

  it('apply in development and tests, with their own value', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(devFlag('BULL_BOARD_OPEN', { NODE_ENV, ...ON })).toBe(true)
      expect(devFlag('INBOUND_EMAIL_ALLOW_ALL', { NODE_ENV, ...ON })).toBe(true)
      expect(devFlag('BULL_BOARD_OPEN', { NODE_ENV, BULL_BOARD_OPEN: '1' })).toBe(false)
      expect(() => assertNoDevOnlyFlags({ NODE_ENV, ...ON })).not.toThrow()
    }
  })

  it('never apply in a strict environment, and stop its boot', () => {
    for (const NODE_ENV of STRICT) {
      expect(devFlag('BULL_BOARD_OPEN', { NODE_ENV, ...ON })).toBe(false)
      expect(devFlag('INBOUND_EMAIL_ALLOW_ALL', { NODE_ENV, ...ON })).toBe(false)
      expect(() => assertNoDevOnlyFlags({ NODE_ENV, BULL_BOARD_OPEN: 'true' })).toThrow(/BULL_BOARD_OPEN/)
      expect(() => assertNoDevOnlyFlags({ NODE_ENV, INBOUND_EMAIL_ALLOW_ALL: '1' })).toThrow(/INBOUND_EMAIL_ALLOW_ALL/)
      // Set to anything but its "on" value, a flag relaxes nothing.
      expect(() => assertNoDevOnlyFlags({ NODE_ENV, BULL_BOARD_OPEN: 'false' })).not.toThrow()
    }
  })
})

describe('the global rate limit', () => {
  it('is the production one in any strict environment', () => {
    for (const NODE_ENV of STRICT) expect(globalRateLimitPerMinute({ NODE_ENV })).toBe(1000)
    expect(globalRateLimitPerMinute({ NODE_ENV: 'development' })).toBe(10_000)
  })
})

describe('the NODE_ENV tripwire', () => {
  it('finds NODE_ENV read nowhere in the API but here and in test setup', () => {
    const SRC = join(__dirname, '..')
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : [])
    const readers = files(SRC).filter(f => {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      // A read: `.NODE_ENV`, `['NODE_ENV']`, or `{ NODE_ENV } = process.env`; not a message naming it.
      return /\.NODE_ENV\b|\[\s*['"`]NODE_ENV['"`]\s*\]|\bNODE_ENV\b[^=;\n]*\}\s*=\s*process\.env/.test(code)
    }).map(f => relative(SRC, f))
    expect(readers.sort()).toEqual(['lib/runtime-mode.ts', 'test-support/setup.integration.ts'])
  })
})
