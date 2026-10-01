/**
 * docs/41 Part 17 (S1) — Salesforce OAuth 2.0 web-server flow with PKCE and
 * a refresh token, against draftLegal's own Connected App.
 *
 * The admin clicks Connect; we send them to `<loginUrl>/services/oauth2/authorize`
 * with a signed `state` (lib/integrations/signed-token.ts) and a PKCE challenge
 * whose verifier stays in Redis. Salesforce sends them back to our callback
 * with a code, which we exchange (with the verifier) for an access token, a
 * refresh token, the instance URL and the identity URL, whose path carries the
 * Salesforce org id (`/id/00D…/005…`) we bind the connection to.
 *
 * The login URL is per connection: login.salesforce.com for production,
 * test.salesforce.com for a sandbox, or the org's My Domain.
 *
 * Settings: SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET (the Connected
 * App's consumer key and secret) and the public URL the callback is served at
 * (SALESFORCE_REDIRECT_URI, else `<API_PUBLIC_URL | FRONTEND_URL>/api/v1/integrations/salesforce/oauth/callback`).
 */

export const DEFAULT_LOGIN_URL = 'https://login.salesforce.com'
export const SANDBOX_LOGIN_URL = 'https://test.salesforce.com'
export const SALESFORCE_SCOPES = 'api refresh_token offline_access'

export class SalesforceAuthError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = 'SalesforceAuthError' }
}

export function salesforceAppConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.SALESFORCE_CLIENT_ID
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  const base = (process.env.API_PUBLIC_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')
  return {
    clientId, clientSecret,
    redirectUri: process.env.SALESFORCE_REDIRECT_URI ?? `${base}/api/v1/integrations/salesforce/oauth/callback`,
  }
}

/**
 * A login URL an admin may choose: Salesforce's two, or an https My Domain
 * under salesforce.com. Anything else could send the code exchange (and our
 * client secret) to a host of the caller's choosing.
 */
export function normaliseLoginUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? DEFAULT_LOGIN_URL).trim().replace(/\/+$/, '')
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'https:' || url.pathname !== '/' && url.pathname !== '' || url.search || url.hash || url.username || url.port) return null
  const host = url.hostname.toLowerCase()
  const ok = host === 'login.salesforce.com' || host === 'test.salesforce.com'
    || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.my\.salesforce\.com$/.test(host)
    || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sandbox\.my\.salesforce\.com$/.test(host)
  return ok ? `https://${host}` : null
}

/**
 * An instance URL Salesforce returned, checked before we send it tokens: an
 * https host under salesforce.com (or force.com for older orgs).
 */
export function isSalesforceHost(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && /(^|\.)(salesforce\.com|force\.com|salesforce\.mil|cloudforce\.com)$/.test(url.hostname.toLowerCase())
  } catch { return false }
}

export function authorizeUrl(input: { loginUrl: string; clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: SALESFORCE_SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login consent',
  })
  return `${input.loginUrl}/services/oauth2/authorize?${q}`
}

export interface SalesforceTokenResponse {
  access_token: string
  refresh_token?: string
  instance_url: string
  id: string
  issued_at?: string
  token_type?: string
}

type Fetch = typeof fetch

async function tokenRequest(loginUrl: string, params: Record<string, string>, fetchImpl: Fetch): Promise<SalesforceTokenResponse> {
  const res = await fetchImpl(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    redirect: 'manual',
  })
  const body = await res.json().catch(() => ({})) as Record<string, string>
  if (!res.ok || !body.access_token) {
    throw new SalesforceAuthError(body.error_description ?? body.error ?? `Salesforce token request failed (${res.status})`, body.error)
  }
  if (!isSalesforceHost(body.instance_url ?? '')) throw new SalesforceAuthError('Salesforce returned an instance URL that is not a Salesforce host')
  return body as unknown as SalesforceTokenResponse
}

export function exchangeCode(input: { loginUrl: string; code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string }, fetchImpl: Fetch = fetch): Promise<SalesforceTokenResponse> {
  return tokenRequest(input.loginUrl, {
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.verifier,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  }, fetchImpl)
}

export function refreshAccessToken(input: { loginUrl: string; refreshToken: string; clientId: string; clientSecret: string }, fetchImpl: Fetch = fetch): Promise<SalesforceTokenResponse> {
  return tokenRequest(input.loginUrl, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }, fetchImpl)
}

/** Revoke a token at Salesforce (disconnect). Best effort. */
export async function revokeToken(loginUrl: string, token: string, fetchImpl: Fetch = fetch): Promise<void> {
  await fetchImpl(`${loginUrl}/services/oauth2/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  }).catch(() => undefined)
}

/** The Salesforce org id (00D…) in an identity URL: `…/id/<orgId>/<userId>`. */
export function orgIdFromIdentityUrl(idUrl: string): string | null {
  const m = /\/id\/(00D[A-Za-z0-9]{12,15})\/[A-Za-z0-9]{15,18}\/?$/.exec(idUrl)
  return m ? normaliseSalesforceId(m[1]) : null
}

/**
 * Salesforce ids come in a 15-character case-sensitive form and an
 * 18-character form with a checksum; compare them by their first 15.
 */
export function normaliseSalesforceId(id: string): string {
  return id.trim().slice(0, 15)
}

export function sameSalesforceId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normaliseSalesforceId(a) === normaliseSalesforceId(b)
}
