/**
 * The API's loggers, and the log masking they share.
 *
 * X69 — only the production logger (JSON, any NODE_ENV but development) had
 * it. The development logger printed signing, portal and invitation tokens
 * and query-string credentials in every request line, and any logged
 * authorization header, cookie or password in full.
 *
 * Y4 — every logger writes through process.stdout, where the entrypoints put
 * the one scrubber every line passes (lib/log-scrub.ts). pino's own default
 * writes to the file descriptor directly and would bypass it, so a logger is
 * made here or not at all (lib/log-scrub.test.ts checks).
 */
import { Writable } from 'node:stream'
import pino, { type DestinationStream } from 'pino'
import pinoPretty from 'pino-pretty'
import { maskTokenPaths } from './log-redact.js'

/** A logger's destination: each line goes through process.stdout, as console's do. */
export function stdoutStream(): Writable {
  return new Writable({
    write(chunk, _encoding, done) {
      process.stdout.write(chunk)
      done()
    },
  })
}

// Pino redacts these on every log line so headers/cookies never end up in the
// logs by accident.
export const LOG_REDACT = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-internal-secret"]',
    'res.headers["set-cookie"]',
    '*.password',
    '*.passwordHash',
    '*.refreshToken',
    '*.accessToken',
  ],
  censor: '[REDACTED]',
}

export const LOG_SERIALIZERS = {
  // Fastify's default request serializer, with the token masked.
  req: (request: { method: string; url: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) => ({
    method:        request.method,
    url:           maskTokenPaths(request.url),
    hostname:      request.hostname,
    remoteAddress: request.ip,
    remotePort:    request.socket?.remotePort,
  }),
}

/** Human-readable output for NODE_ENV=development, masked as production's is. */
export function devLogger(stream: DestinationStream = pinoPretty({ colorize: true, destination: stdoutStream() })) {
  return pino({ level: process.env.LOG_LEVEL ?? 'info', redact: LOG_REDACT, serializers: LOG_SERIALIZERS }, stream)
}

/**
 * The API's logger options outside development: pino's JSON lines, the shape
 * DataDog, Loki or CloudWatch ingest, with the commit SHA (the deploy script
 * sets GIT_COMMIT_SHA) to correlate logs to a release.
 */
export function productionLoggerOptions() {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      pid: process.pid,
      env: process.env.NODE_ENV ?? 'production',
      commit: process.env.GIT_COMMIT_SHA ?? 'unknown',
      service: 'clm-api',
    },
    redact: LOG_REDACT,
    serializers: LOG_SERIALIZERS,
    stream: stdoutStream(),
  }
}

/** A module's own logger (`name` labels its lines), JSON, masked like the API's. */
export function moduleLogger(name: string) {
  return pino({ level: process.env.LOG_LEVEL ?? 'info', name, redact: LOG_REDACT }, stdoutStream())
}
