/** X30 — req.ip resolves through the trusted proxy hop only. */
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { trustProxyHops } from './trust-proxy.js'

async function ipSeen(trustProxy: number | false, xff: string | undefined): Promise<string> {
  const app = Fastify({ trustProxy })
  app.get('/ip', async req => ({ ip: req.ip }))
  const res = await app.inject({
    method: 'GET', url: '/ip', remoteAddress: '35.191.0.10',   // the proxy's address
    headers: xff ? { 'x-forwarded-for': xff } : {},
  })
  await app.close()
  return (res.json() as { ip: string }).ip
}

describe('trustProxyHops', () => {
  it('trusts one hop on Cloud Run, none elsewhere, and honours an explicit count', () => {
    expect(trustProxyHops({ K_SERVICE: 'clm-api' })).toBe(1)
    expect(trustProxyHops({})).toBe(false)
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '2', K_SERVICE: 'clm-api' })).toBe(2)
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '0', K_SERVICE: 'clm-api' })).toBe(false)
    expect(trustProxyHops({ TRUST_PROXY_HOPS: 'yes' })).toBe(false)
  })

  it('with one hop, req.ip is the address the proxy appended, not one the client sent', async () => {
    // The client claimed 6.6.6.6; the front end appended the real 203.0.113.9.
    expect(await ipSeen(trustProxyHops({ K_SERVICE: 'x' }), '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9')
    // Before: the proxy's own address for every client.
    expect(await ipSeen(trustProxyHops({}), '6.6.6.6, 203.0.113.9')).toBe('35.191.0.10')
  })
})
