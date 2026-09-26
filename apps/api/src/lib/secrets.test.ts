import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSecret, assertSecretsConfigured } from './secrets.js'

// Wave 1.1 — the security-critical behaviour is: production must NEVER fall
// back to a hardcoded/weak secret. These tests lock that in.
const SAVED = { ...process.env }
afterEach(() => {
  process.env = { ...SAVED }
})

describe('resolveSecret (Wave 1.1 fail-closed secrets)', () => {
  it('throws in production when the secret is unset', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.JWT_SECRET
    expect(() => resolveSecret('JWT_SECRET')).toThrow(/not set/i)
  })

  it('throws in production for a known-insecure placeholder (change-me…)', () => {
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = 'change-me-please-min-32-characters-long!!'
    expect(() => resolveSecret('JWT_SECRET')).toThrow(/placeholder/i)
  })

  it('throws in production for a too-short secret', () => {
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = 'short'
    expect(() => resolveSecret('JWT_SECRET')).toThrow(/too short/i)
  })

  it('accepts a strong, non-placeholder secret in production', () => {
    process.env.NODE_ENV = 'production'
    const strong = 'Zk9' + 'x'.repeat(45)
    process.env.JWT_SECRET = strong
    expect(resolveSecret('JWT_SECRET')).toBe(strong)
  })

  it('generates a usable dev secret when unset outside production', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.PORTAL_JWT_SECRET
    const s = resolveSecret('PORTAL_JWT_SECRET')
    expect(s.length).toBeGreaterThanOrEqual(32)
  })
})

describe('X38 — placeholders and the internal service secret', () => {
  const strongJwt = () => {
    process.env.JWT_SECRET = 'Zk9' + 'x'.repeat(45)
    process.env.PORTAL_JWT_SECRET = 'Pq7' + 'y'.repeat(45)
  }

  it('refuses the self-host placeholders (CHANGE_ME_…) in production, not just change-me', () => {
    process.env.NODE_ENV = 'production'
    for (const v of ['CHANGE_ME_at_least_32_characters_long_secret', 'CHANGE_ME_another_32_plus_char_secret', 'changeme-0123456789-0123456789-0123']) {
      process.env.JWT_SECRET = v
      expect(() => resolveSecret('JWT_SECRET'), v).toThrow(/placeholder/i)
    }
  })

  it('refuses to boot in production with the internal secret set to an example placeholder', () => {
    process.env.NODE_ENV = 'production'
    strongJwt()
    for (const v of ['change-me-internal-secret-min-32-chars', 'CHANGE_ME_shared_api_agents_secret']) {
      process.env.INTERNAL_SERVICE_SECRET = v
      expect(() => assertSecretsConfigured(), v).toThrow(/INTERNAL_SERVICE_SECRET.*placeholder/i)
    }
    process.env.INTERNAL_SERVICE_SECRET = 'Rt5' + 'z'.repeat(45)
    expect(() => assertSecretsConfigured()).not.toThrow()
  })

  it('only warns when the internal secret is unset: every internal check then refuses rather than opens', () => {
    process.env.NODE_ENV = 'production'
    strongJwt()
    delete process.env.INTERNAL_SERVICE_SECRET
    expect(() => assertSecretsConfigured()).not.toThrow()
    expect(process.env.INTERNAL_SERVICE_SECRET).toBeUndefined()   // never generated: the agents service holds it too
  })

  it('refuses a short internal secret in production, as it does a short JWT secret', () => {
    process.env.NODE_ENV = 'production'
    strongJwt()
    process.env.INTERNAL_SERVICE_SECRET = 'short-but-random-9f3k'
    expect(() => assertSecretsConfigured()).toThrow(/INTERNAL_SERVICE_SECRET.*too short/i)
  })

  it('refuses every secret value that is public in the repo, however it is written', () => {
    process.env.NODE_ENV = 'production'
    strongJwt()
    for (const v of [
      'clm-internal-dev-secret-2026', 'ci-integration-internal-secret', 'integration-internal-service-secret',
      '"CHANGE_ME_shared_api_agents_secret"', '  change me internal secret, at least 32 chars', 'REPLACE_ME_with_a_long_random_internal_secret',
    ]) {
      process.env.INTERNAL_SERVICE_SECRET = v
      expect(() => assertSecretsConfigured(), v).toThrow(/INTERNAL_SERVICE_SECRET/)
    }
    for (const v of ['ci-integration-jwt-secret-32chars-minimum', 'integration-test-jwt-secret-32chars-minimum']) {
      process.env.JWT_SECRET = v
      expect(() => resolveSecret('JWT_SECRET'), v).toThrow(/placeholder/i)
    }
  })

  it('refuses, in production, every secret the example env files ship', () => {
    process.env.NODE_ENV = 'production'
    for (const file of ['.env.example', '.env.selfhost.example']) {
      const values = Object.fromEntries(readFileSync(join(process.cwd(), '..', '..', file), 'utf8').split('\n')
        .map(line => line.match(/^(JWT_SECRET|PORTAL_JWT_SECRET|INTERNAL_SERVICE_SECRET)=(.*)$/))
        .filter((m): m is RegExpMatchArray => !!m).map(m => [m[1], m[2]]))
      expect(Object.keys(values).sort(), file).toEqual(['INTERNAL_SERVICE_SECRET', 'JWT_SECRET', 'PORTAL_JWT_SECRET'])
      for (const name of ['JWT_SECRET', 'PORTAL_JWT_SECRET']) {
        process.env[name] = values[name]
        expect(() => resolveSecret(name), `${file} ${name}`).toThrow()
      }
      strongJwt()
      process.env.INTERNAL_SERVICE_SECRET = values.INTERNAL_SERVICE_SECRET
      expect(() => assertSecretsConfigured(), `${file} INTERNAL_SERVICE_SECRET`).toThrow()
    }
  })

  it('the agents service refuses the same values on Cloud Run (source tripwire)', () => {
    const main = readFileSync(join(process.cwd(), '..', 'agents', 'main.py'), 'utf8')
    expect(main).toMatch(/^_check_internal_secret\(\)$/m)
    expect(main).toContain('os.environ.get("K_SERVICE")')
    for (const v of ['clm-internal-dev-secret-2026', 'ci-integration-internal-secret', 'integration-internal-service-secret']) {
      expect(main, v).toContain(`"${v}"`)
    }
  })

  it('outside production a placeholder only warns', () => {
    process.env.NODE_ENV = 'development'
    strongJwt()
    process.env.INTERNAL_SERVICE_SECRET = 'change-me-internal-secret-min-32-chars'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => assertSecretsConfigured()).not.toThrow()
    expect(warn.mock.calls.flat().join(' ')).toMatch(/INTERNAL_SERVICE_SECRET is a placeholder/)
    warn.mockRestore()
  })
})
