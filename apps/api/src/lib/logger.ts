/**
 * The API's log masking, shared by the production and development loggers.
 *
 * X69 — only the production logger (JSON, any NODE_ENV but development) had
 * it. The development logger printed signing, portal and invitation tokens
 * and query-string credentials in every request line, and any logged
 * authorization header, cookie or password in full.
 */
import pino, { type DestinationStream } from 'pino'
import pinoPretty from 'pino-pretty'
import { maskTokenPaths } from './log-redact.js'

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
export function devLogger(stream: DestinationStream = pinoPretty({ colorize: true })) {
  return pino({ level: process.env.LOG_LEVEL ?? 'info', redact: LOG_REDACT, serializers: LOG_SERIALIZERS }, stream)
}
