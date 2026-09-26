import { describe, it, expect, vi } from 'vitest'

// X39 follow-up: a webhook host that resolves to an internal address.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '10.1.2.3', family: 4 }]) }))

import { isPrivateIp, assertUrlShape, assertPublicUrl, ssrfGuardEnabled } from './ssrf-guard.js'

// Wave 1.5 — SSRF guard for user-supplied webhook URLs.
describe('isPrivateIp', () => {
  it('flags loopback / RFC1918 / link-local / metadata', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '172.31.255.255',
                       '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateIp(ip)).toBe(true)
    }
  })
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip)).toBe(false)
    }
  })
})

describe('assertUrlShape', () => {
  it('rejects non-http(s), localhost, .internal, and private IP literals', () => {
    for (const bad of ['ftp://example.com', 'http://localhost/x', 'https://foo.internal/y',
                       'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3/hook', 'not-a-url']) {
      expect(() => assertUrlShape(bad)).toThrow()
    }
  })
  it('accepts public https URLs', () => {
    expect(() => assertUrlShape('https://hooks.example.com/abc')).not.toThrow()
    expect(() => assertUrlShape('http://api.acme.io/webhook')).not.toThrow()
  })
})

describe('ssrfGuardEnabled', () => {
  it('X35 — is on in every environment unless turned off explicitly', () => {
    const saved = { env: process.env.NODE_ENV, flag: process.env.WEBHOOK_ALLOW_PRIVATE_URLS }
    try {
      delete process.env.WEBHOOK_ALLOW_PRIVATE_URLS
      for (const env of ['development', 'test', 'staging', 'production']) {
        process.env.NODE_ENV = env
        expect(ssrfGuardEnabled(), env).toBe(true)
      }
      process.env.WEBHOOK_ALLOW_PRIVATE_URLS = 'true'
      expect(ssrfGuardEnabled()).toBe(false)
    } finally {
      process.env.NODE_ENV = saved.env
      if (saved.flag === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_URLS
      else process.env.WEBHOOK_ALLOW_PRIVATE_URLS = saved.flag
    }
  })
})

describe('X39 follow-up', () => {
  it('checks IPv6 literals, which keep their brackets in a URL', () => {
    for (const u of ['http://[::1]/hook', 'https://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/']) {
      expect(() => assertUrlShape(u), u).toThrow()
    }
    expect(() => assertUrlShape('https://[2606:4700:4700::1111]/hook')).not.toThrow()
  })

  it('does not tell the webhook owner which internal address a name resolved to', async () => {
    const err = await assertPublicUrl('https://hooks.example.com/abc').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('10.1.2.3')
  })
})
