/** X18 — request logs must not carry signing or share-portal tokens. */
import { describe, it, expect } from 'vitest'
import { maskTokenPaths } from './log-redact.js'

describe('maskTokenPaths', () => {
  it('masks the token in signing and portal URLs, keeping the route readable', () => {
    expect(maskTokenPaths('/api/v1/sign/abc123def456')).toBe('/api/v1/sign/[REDACTED]')
    expect(maskTokenPaths('/api/v1/sign/abc123/sign?x=1')).toBe('/api/v1/sign/[REDACTED]/sign?x=1')
    expect(maskTokenPaths('/api/v1/portal/tok_9/comments')).toBe('/api/v1/portal/[REDACTED]/comments')
  })

  it('leaves every other URL alone', () => {
    expect(maskTokenPaths('/api/v1/contracts/cm123/signature-requests')).toBe('/api/v1/contracts/cm123/signature-requests')
    expect(maskTokenPaths(undefined)).toBeUndefined()
  })
})
