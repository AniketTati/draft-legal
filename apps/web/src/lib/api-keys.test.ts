/**
 * C1 — the create-key request must carry the chosen scopes (and expiry).
 * Before the fix the dialog sent `{ name }` only, producing a key with no
 * permissions at all.
 */
import { describe, it, expect } from 'vitest'
import { buildCreateApiKeyBody } from './api-keys'

describe('buildCreateApiKeyBody', () => {
  it('sends the chosen scopes and expiry', () => {
    expect(buildCreateApiKeyBody('  Salesforce sync ', ['contracts:read', 'requests:read'], 90)).toEqual({
      name: 'Salesforce sync',
      scopes: ['contracts:read', 'requests:read'],
      expiresInDays: 90,
    })
  })

  it('omits expiry for a key that never expires', () => {
    expect(buildCreateApiKeyBody('CI', ['contracts:read'], null)).toEqual({ name: 'CI', scopes: ['contracts:read'] })
  })

  it('refuses to build a key with no scopes or no name', () => {
    expect(buildCreateApiKeyBody('CI', [], null)).toBeNull()
    expect(buildCreateApiKeyBody('   ', ['contracts:read'], null)).toBeNull()
  })

  it('de-duplicates scopes', () => {
    expect(buildCreateApiKeyBody('CI', ['contracts:read', 'contracts:read'], null)?.scopes).toEqual(['contracts:read'])
  })
})
