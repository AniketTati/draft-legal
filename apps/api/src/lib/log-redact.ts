/**
 * X18 — signing (/sign/:token) and share-portal (/portal/:token) URLs carry a
 * bearer credential, and every request log line records the URL.
 */
const TOKEN_PATH = /\/(sign|portal)\/[^/?#]+/g

export function maskTokenPaths(url: string | undefined): string | undefined {
  return url?.replace(TOKEN_PATH, '/$1/[REDACTED]')
}
