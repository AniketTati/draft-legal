/**
 * X41 — the seed gave its demo users the password `password123`, which it
 * prints and the README repeats, and the self-host guide runs that seed to
 * create an install's first admin.
 */
import { describe, it, expect } from 'vitest'
import { seedPassword } from './seed-password.js'

describe('seedPassword', () => {
  it('keeps password123 on a developer machine', () => {
    expect(seedPassword({ NODE_ENV: 'development' })).toEqual({ password: 'password123', generated: false })
  })

  it('never uses password123 in production: a random one is generated, and said to be', () => {
    const a = seedPassword({ NODE_ENV: 'production' })
    const b = seedPassword({ NODE_ENV: 'production' })
    expect(a.generated).toBe(true)
    expect(a.password).not.toBe('password123')
    expect(a.password.length).toBeGreaterThanOrEqual(16)
    expect(a.password).not.toBe(b.password)
  })

  it('takes SEED_ADMIN_PASSWORD, refusing a weak one in production', () => {
    expect(seedPassword({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'a-long-chosen-passphrase' })).toEqual({ password: 'a-long-chosen-passphrase', generated: false })
    // X64 — the demo password is named as such. The length rule used to
    // refuse it first, so this message never showed, and `Password123!`
    // (12 characters) passed both rules.
    expect(() => seedPassword({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'password123' })).toThrow(/must not contain password123/)
    expect(() => seedPassword({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'Password123!' })).toThrow(/must not contain password123/)
    expect(() => seedPassword({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'short' })).toThrow(/12 characters/)
    expect(seedPassword({ NODE_ENV: 'development', SEED_ADMIN_PASSWORD: 'short' }).password).toBe('short')
  })
})
