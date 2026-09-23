import { randomBytes } from 'node:crypto'

/**
 * X41 — the password prisma/seed.ts gives its demo users.
 *
 * `password123` is fine on a developer's machine (the README logs in with
 * it). But the self-host guide runs the seed to create an install's first
 * admin, and a password the seed prints and the README repeats is no
 * password. In production it comes from SEED_ADMIN_PASSWORD (12 characters or
 * more, and not password123), or a random one is generated for the seed to
 * print once.
 */
export function seedPassword(env: NodeJS.ProcessEnv = process.env): { password: string; generated: boolean } {
  const production = env.NODE_ENV === 'production'
  const given = env.SEED_ADMIN_PASSWORD
  if (given) {
    if (production && given.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters in production')
    if (production && given.toLowerCase() === 'password123') throw new Error('SEED_ADMIN_PASSWORD must not be password123 in production')
    return { password: given, generated: false }
  }
  if (production) return { password: randomBytes(18).toString('base64url'), generated: true }
  return { password: 'password123', generated: false }
}
