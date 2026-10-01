/**
 * docs/41 Part 17 (S3) — the short-lived link Salesforce's document preview
 * (the dlDocumentPreview LWC) frames: `/embed/contracts/:id?token=…`.
 *
 * The token names one contract of one org and one thing it allows
 * (`document:read`), and expires in minutes. No draftLegal session is needed,
 * so no third-party cookie or second login inside Salesforce. The page it
 * opens is read-only.
 */
import { signToken, verifyToken, type SignedClaims } from './signed-token.js'

export const EMBED_SCOPE = 'document:read'
export const EMBED_TTL_SECONDS = 10 * 60

interface EmbedClaims extends SignedClaims { o: string; c: string; s: string }

export function signEmbedToken(orgId: string, contractId: string, ttlSeconds = EMBED_TTL_SECONDS): string {
  return signToken('contract-embed', { o: orgId, c: contractId, s: EMBED_SCOPE }, Math.min(ttlSeconds, 60 * 60))
}

/** The org and contract a token allows reading, or null (bad, expired, or for another contract). */
export function verifyEmbedToken(token: string | undefined | null, contractId: string, now = Date.now()): { orgId: string; contractId: string; expiresAt: Date } | null {
  const claims = verifyToken<EmbedClaims>('contract-embed', token, now)
  if (!claims || claims.s !== EMBED_SCOPE || claims.c !== contractId || typeof claims.o !== 'string') return null
  return { orgId: claims.o, contractId: claims.c, expiresAt: new Date(claims.exp * 1000) }
}

export function embedUrl(contractId: string, token: string): string {
  const base = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')
  return `${base}/embed/contracts/${encodeURIComponent(contractId)}?token=${encodeURIComponent(token)}`
}
