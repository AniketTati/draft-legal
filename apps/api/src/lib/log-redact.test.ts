/** X18 — request logs must not carry signing or share-portal tokens. */
import { describe, it, expect } from 'vitest'
import { maskTokenPaths } from './log-redact.js'

describe('maskTokenPaths', () => {
  it('masks the token in signing and portal URLs, keeping the route readable', () => {
    expect(maskTokenPaths('/api/v1/sign/abc123def456')).toBe('/api/v1/sign/[REDACTED]')
    expect(maskTokenPaths('/api/v1/sign/abc123/sign?x=1')).toBe('/api/v1/sign/[REDACTED]/sign?x=1')
    expect(maskTokenPaths('/api/v1/portal/tok_9/comments')).toBe('/api/v1/portal/[REDACTED]/comments')
  })

  it('masks invitation links and credentials in the query string too (X3)', () => {
    expect(maskTokenPaths('/api/v1/auth/invites/inv_secret')).toBe('/api/v1/auth/invites/[REDACTED]')
    expect(maskTokenPaths('/api/v1/x?token=abc&email=a@b.c&code=9')).toBe('/api/v1/x?token=[REDACTED]&email=a@b.c&code=[REDACTED]')
  })

  it('leaves every other URL alone', () => {
    expect(maskTokenPaths('/api/v1/contracts/cm123/signature-requests')).toBe('/api/v1/contracts/cm123/signature-requests')
    expect(maskTokenPaths(undefined)).toBeUndefined()
  })
})

// X69 — the development logger masked nothing: request lines printed signing,
// portal and invite tokens, and any logged authorization header or password
// appeared in full. It now masks what the production logger does.
describe('the development logger', () => {
  it('masks tokens, credentials and secrets as production does', async () => {
    const { Writable } = await import('node:stream')
    const { devLogger } = await import('./logger.js')
    let out = ''
    const sink = new Writable({ write(chunk, _enc, done) { out += String(chunk); done() } })
    const log = devLogger(sink)
    log.info({ req: { method: 'GET', url: '/api/v1/sign/tok-live-4821?code=otp-7731', headers: { authorization: 'Bearer eyJhbGciOi' } } }, 'incoming request')
    log.info({ body: { password: 'hunter2-hunter2', refreshToken: 'rt-5509' } }, 'login')
    expect(out).toContain('/api/v1/sign/[REDACTED]')
    for (const secret of ['tok-live-4821', 'otp-7731', 'eyJhbGciOi', 'hunter2-hunter2', 'rt-5509']) expect(out).not.toContain(secret)
  })
})

describe('the development logger inside Fastify', () => {
  it('keeps its masking: Fastify\'s own request serializer does not replace it', async () => {
    const { Writable } = await import('node:stream')
    const { default: Fastify } = await import('fastify')
    const { devLogger } = await import('./logger.js')
    let out = ''
    const sink = new Writable({ write(chunk, _enc, done) { out += String(chunk); done() } })
    const app = Fastify({ logger: devLogger(sink) })
    app.get('/api/v1/sign/:token', async () => ({ ok: true }))
    await app.inject({ method: 'GET', url: '/api/v1/sign/tok-live-9917', headers: { authorization: 'Bearer eyJzZWNyZXQ' } })
    await app.close()
    expect(out).toContain('/api/v1/sign/[REDACTED]')
    expect(out).not.toContain('tok-live-9917')
    expect(out).not.toContain('eyJzZWNyZXQ')
  })
})
