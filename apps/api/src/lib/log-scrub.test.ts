/**
 * Y4 — every line the API prints passes one scrubber. Secrets reached the
 * logs four times (X3, X18, X69, X77), each fixed in one line or one logger,
 * while about 146 console calls masked nothing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Console } from 'node:console'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import Fastify from 'fastify'
import { scrub, scrubWrites, devPrint } from './log-scrub.js'
import { devLogger, moduleLogger, productionLoggerOptions } from './logger.js'
import { reportError } from './error-reporter.js'

const INTERNAL = 'internal-secret-value-4471'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLXNpZw'
const API_KEY = 'clm_live_Qw3rTy8uIoPaSdFgHjKlZxCvBnM1234567890abcd'
const GOOGLE = 'AIzaSyD4f8Kq2mXz7Lp0Rt5Wv9Bn3Jh6Yc1Ue2G'
/** One secret of each kind, and the part of it that must never be printed. */
const SECRETS: Array<[string, string]> = [
  ['signing link', 'https://app.example.com/sign/tok-sign-7731'],
  ['share link', 'https://app.example.com/portal/tok-portal-5521/review'],
  ['invitation', 'https://app.example.com/auth/invites/inv-tok-3390'],
  ['query credential', '/api/v1/callback?token=qtok-8812&state=ok&code=otp-4417'],
  ['bearer value', 'Authorization: Bearer opaque-bearer-6620'],
  ['JWT', JWT],
  ['API key', API_KEY],
  ['provider keys', `sk-proj-abcdefghijklmnop1234 ${GOOGLE} xoxb-1234567890-abcdefghij`],
  ['password in a URL', 'postgresql://clm:pg-pass-9921@db.internal:5432/clm'],
  ['private key', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----'],
  ['internal service secret', `x-internal-secret: ${INTERNAL}`],
]
const NEVER = ['tok-sign-7731', 'tok-portal-5521', 'inv-tok-3390', 'qtok-8812', 'otp-4417', 'opaque-bearer-6620', JWT, API_KEY,
  'sk-proj-abcdefghijklmnop1234', GOOGLE, 'xoxb-1234567890-abcdefghij', 'pg-pass-9921', 'MIIEvQIBADANBgkqhkiG9w0', INTERNAL]
const LINE = SECRETS.map(([kind, secret]) => `${kind}: ${secret}`).join(' | ')

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** What reaches stdout and stderr, through the scrubber, printing nothing. */
function captured() {
  const printed: string[] = []
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      printed.push(String(chunk))
      const done = rest.find(r => typeof r === 'function') as (() => void) | undefined
      done?.()
      return true
    }) as never)
  }
  const undo = [scrubWrites(process.stdout), scrubWrites(process.stderr)]
  return { printed, undo: () => undo.forEach(u => u()) }
}

describe('the scrubber', () => {
  it('masks one secret of each kind', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', INTERNAL)
    const masked = scrub(LINE)
    for (const secret of NEVER) expect(masked, secret).not.toContain(secret)
    for (const [kind] of SECRETS) expect(masked).toContain(`${kind}:`)
    expect(masked).toContain('/sign/[REDACTED]')
    expect(masked).toContain('state=ok')
  })

  it('leaves ordinary text alone, and a masked line as it is', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', INTERNAL)
    const ordinary = 'Contract "Acme MSA v2" (cmsl8z3ba002mpiwrysshxlgj) was signed by jane.doe@acme.com on 2026-09-24T10:00:00.000Z; GET /api/v1/contracts/cm123/signature-requests?page=2 took 41ms'
    expect(scrub(ordinary)).toBe(ordinary)
    const masked = scrub(LINE)
    expect(scrub(masked)).toBe(masked)
  })
})

describe('every channel the API prints through', () => {
  it('passes the scrubber: pino as JSON and pretty, console, and the error reporter', async () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', INTERNAL)
    vi.stubEnv('K_SERVICE', 'clm-api-test')
    const { printed, undo } = captured()
    try {
      moduleLogger('y4-module').warn({ detail: LINE }, LINE)
      const app = Fastify({ logger: productionLoggerOptions() })
      app.get('/api/v1/sign/:token', async () => ({ ok: true }))
      await app.inject({ url: '/api/v1/sign/tok-sign-7731?code=otp-4417', headers: { authorization: 'Bearer opaque-bearer-6620' } })
      app.log.error({ detail: LINE }, LINE)
      await app.close()
      devLogger().info(`pretty ${LINE}`)
      const stdio = new Console(process.stdout, process.stderr)
      stdio.log(`console.log ${LINE}`)
      stdio.info(`console.info ${LINE}`)
      stdio.warn(`console.warn ${LINE}`)
      stdio.error(`console.error ${LINE}`)
      reportError(new Error(LINE), { method: 'GET', url: '/api/v1/portal/tok-portal-5521' })
      await new Promise(resolve => setTimeout(resolve, 50))   // pino-pretty's transform
    } finally {
      undo()
    }
    const out = printed.join('')
    // Each channel printed…
    for (const mark of ['"name":"y4-module"', '"service":"clm-api"', 'pretty ', 'console.log ', 'console.info ', 'console.warn ', 'console.error ', 'clouderrorreporting']) {
      expect(out, mark).toContain(mark)
    }
    // …and none printed a secret.
    for (const secret of NEVER) expect(out, secret).not.toContain(secret)
  })
})

describe('devPrint, the one way past it', () => {
  const link = 'https://app.example.com/sign/tok-sign-7731'
  const printedBy = (nodeEnv: string) => {
    vi.stubEnv('NODE_ENV', nodeEnv)
    const { printed, undo } = captured()
    const console = globalThis.console
    globalThis.console = new Console(process.stdout, process.stderr)
    try {
      devPrint(`[signing] ✉  signer@example.com  →  ${link}`)
    } finally {
      globalThis.console = console
      undo()
    }
    return printed.join('')
  }

  it('prints a delivery link whole in development, where the console is how it is found', () => {
    expect(printedBy('development')).toContain(link)
  })

  it('masks it in any other mode', () => {
    for (const mode of ['production', 'test', 'staging']) {
      const out = printedBy(mode)
      expect(out, mode).toContain('/sign/[REDACTED]')
      expect(out, mode).not.toContain('tok-sign-7731')
    }
  })
})

describe('the logger tripwire', () => {
  // pino's default destination writes to the file descriptor, past the scrubber.
  it('makes every pino logger in lib/logger.ts, which writes through process.stdout', () => {
    const SRC = join(__dirname, '..')
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : [])
    const makers = files(SRC).filter(f => /(?<![\w.])pino\s*\(/.test(readFileSync(f, 'utf8'))).map(f => relative(SRC, f))
    expect(makers).toEqual(['lib/logger.ts'])
  })
})
