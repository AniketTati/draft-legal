import jwt from 'jsonwebtoken'
import { resolveSecret } from './secrets.js'

// Resolved lazily + cached so importing this module has no side effects
// (tests, tooling). Production fails closed if JWT_SECRET is missing/weak —
// see lib/secrets.ts. The old `?? 'dev-secret-change-me'` fallback is gone.
let _secret: string | null = null
function secret(): string {
  if (_secret === null) _secret = resolveSecret('JWT_SECRET')
  return _secret
}
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES_IN ?? '15m'
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN ?? '7d'

export interface JwtPayload {
  sub: string   // userId
  orgId: string
  roles: string[]
  type: 'access' | 'refresh'
  /**
   * X50 — the sign-in this token descends from, carried on by every refresh.
   * Signing is deterministic and `iat` is whole seconds, so without it a
   * sign-in and a refresh in the same second minted the very same tokens.
   */
  sid?: string
}

export function signAccessToken(payload: Omit<JwtPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'access' }, secret(), {
    expiresIn: ACCESS_EXPIRES,
  } as jwt.SignOptions)
}

export function signRefreshToken(payload: Omit<JwtPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'refresh' }, secret(), {
    expiresIn: REFRESH_EXPIRES,
  } as jwt.SignOptions)
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secret()) as JwtPayload
}
