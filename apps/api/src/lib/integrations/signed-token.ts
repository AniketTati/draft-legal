/**
 * docs/41 Parts 17 and 20 — small signed tokens the integrations hand out:
 * the OAuth `state` of a Salesforce connect or an SSO sign-in, and the
 * short-lived link that lets Salesforce show a contract's document without a
 * draftLegal session (`/embed/contracts/:id?token=`).
 *
 * A token is `base64url(JSON claims).base64url(HMAC-SHA256)`. The HMAC key is
 * derived from JWT_SECRET and the token's purpose, so a state can never pass
 * as an embed link (or a session) and the other way round. Every token
 * expires; the verifier checks the purpose, the signature (in constant time)
 * and the expiry, and returns the claims or null — never why it failed, which
 * would only help someone forging one.
 */
import crypto from 'node:crypto'
import { resolveSecret } from '../secrets.js'

export type TokenPurpose = 'salesforce-oauth-state' | 'sso-oidc-state' | 'contract-embed'

function keyFor(purpose: TokenPurpose): Buffer {
  return crypto.createHmac('sha256', resolveSecret('JWT_SECRET')).update(`clm-signed-token:${purpose}`).digest()
}

function mac(purpose: TokenPurpose, body: string): string {
  return crypto.createHmac('sha256', keyFor(purpose)).update(body).digest('base64url')
}

export interface SignedClaims {
  /** Expiry, seconds since the epoch. */
  exp: number
  [claim: string]: unknown
}

/** Sign `claims` for `purpose`, valid for `ttlSeconds`. */
export function signToken(purpose: TokenPurpose, claims: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...claims, p: purpose, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url')
  return `${body}.${mac(purpose, body)}`
}

/** The claims of a token signed for `purpose` that hasn't expired, else null. */
export function verifyToken<T extends SignedClaims = SignedClaims>(purpose: TokenPurpose, token: string | undefined | null, now = Date.now()): T | null {
  if (typeof token !== 'string' || token.length > 4096) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
  const body = token.slice(0, dot)
  const given = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(mac(purpose, body))
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null
  let claims: T & { p?: string }
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) }
  catch { return null }
  if (!claims || claims.p !== purpose || typeof claims.exp !== 'number') return null
  if (claims.exp * 1000 <= now) return null
  return claims
}

/** PKCE (RFC 7636): a random verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}
