/**
 * API key creation request (C1).
 *
 * A key's scopes are its permissions: the server maps each scope to a
 * permission set, and a key with none can call nothing. The create dialog
 * used to send `{ name }` alone, so every key it made 403'd on every route.
 */

/** Expiry choices offered by the dialog; `null` = never expires. */
export const API_KEY_EXPIRY_OPTIONS: Array<{ label: string; days: number | null }> = [
  { label: 'Never',   days: null },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year',  days: 365 },
]

export interface CreateApiKeyBody {
  name: string
  scopes: string[]
  expiresInDays?: number
}

/** Body for POST /admin/integrations/api-keys, or null when it can't be sent yet. */
export function buildCreateApiKeyBody(name: string, scopes: string[], expiresInDays: number | null): CreateApiKeyBody | null {
  const trimmed = name.trim()
  if (!trimmed || scopes.length === 0) return null
  return {
    name: trimmed,
    scopes: [...new Set(scopes)],
    ...(expiresInDays ? { expiresInDays } : {}),
  }
}
