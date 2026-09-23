/**
 * X18 — signing (/sign/:token) and share-portal (/portal/:token) URLs carry a
 * bearer credential, and every request log line records the URL. X3 — so do
 * invitation links (/auth/invites/:token, which sets the invitee's password),
 * and credentials passed as query parameters.
 */
const TOKEN_PATH = /\/(sign|portal|invites)\/[^/?#]+/g
const TOKEN_QUERY = /([?&](?:token|code|key|secret|signature|password)=)[^&#]*/gi

export function maskTokenPaths(url: string | undefined): string | undefined {
  return url?.replace(TOKEN_PATH, '/$1/[REDACTED]').replace(TOKEN_QUERY, '$1[REDACTED]')
}
