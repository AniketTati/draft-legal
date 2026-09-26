/**
 * Centralised error handler.
 *
 * Production goals:
 *   1. Every unhandled error gets a STRUCTURED log with enough context
 *      that an on-call engineer can reproduce it (route, method, user,
 *      org, request id, error name + stack).
 *   2. Zod / Fastify validation errors get clean 4xx responses; only
 *      true unknowns become 500s.
 *   3. 5xx errors also go to lib/error-reporter.ts, which on Cloud Run
 *      writes them as Cloud Error Reporting events (X3); elsewhere the
 *      log line below is the record.
 *   4. The 5xx response body never leaks stack traces or internal
 *      detail to the client; the request id IS surfaced so users can
 *      report it and we can correlate.
 */
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'
import { reportError } from '../lib/error-reporter.js'
import { maskTokenPaths } from '../lib/log-redact.js'

export function errorHandler(
  error: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply
) {
  // Build a richer log payload than the previous bare error pass.
  // Pino picks up `err` specially (renders the stack); we add request
  // metadata so the log line on its own is enough to reproduce.
  const userContext = (req as FastifyRequest & { user?: { sub?: string; orgId?: string } }).user
  const ctx = {
    err: error,
    reqId:    req.id,
    method:   req.method,
    // X3 — this line skips the request serializer, so mask credentials here.
    url:      maskTokenPaths(req.url),
    routeUrl: req.routeOptions?.url,
    statusCode: error.statusCode ?? 500,
    userId:   userContext?.sub,
    orgId:    userContext?.orgId,
    ip:       req.ip,
  }

  // Validation errors: 4xx, log at warn (expected user input shape).
  if (error instanceof ZodError) {
    req.log.warn(ctx, 'request validation failed (zod)')
    return reply.status(422).send({
      type:   'https://httpstatuses.com/422',
      title:  'Validation Error',
      status: 422,
      detail: 'Request body failed validation',
      errors: error.errors,
      reqId:  req.id,
    })
  }
  // Y1 — "record not found" from Prisma: an update or delete of a row that
  // doesn't exist, or that the tenant guard kept to the caller's org. A 404,
  // not a 500 (which also hides whether the id exists elsewhere).
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    req.log.warn(ctx, 'record not found (P2025)')
    return reply.status(404).send({
      type:   'https://httpstatuses.com/404',
      title:  'Not Found',
      status: 404,
      detail: 'Not found',
      reqId:  req.id,
    })
  }
  // Y1 — a write Postgres's row-level security refused: it named another
  // tenant's row. A 403, not a 500.
  if (/violates row-level security policy/.test(error.message ?? '')) {
    req.log.warn(ctx, 'row-level security refused a write')
    return reply.status(403).send({
      type:   'https://httpstatuses.com/403',
      title:  'Forbidden',
      status: 403,
      detail: 'Forbidden',
      reqId:  req.id,
    })
  }
  // A unique constraint (a name already taken, say): 409, not a 500.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    req.log.warn(ctx, 'unique constraint (P2002)')
    return reply.status(409).send({
      type:   'https://httpstatuses.com/409',
      title:  'Conflict',
      status: 409,
      detail: 'A record with these details already exists',
      reqId:  req.id,
    })
  }
  if (error.validation) {
    req.log.warn(ctx, 'request validation failed (fastify)')
    return reply.status(400).send({
      type:   'https://httpstatuses.com/400',
      title:  'Bad Request',
      status: 400,
      detail: error.message,
      reqId:  req.id,
    })
  }

  const status = error.statusCode ?? 500
  // Anything 4xx is an expected client problem. Only 5xx is reported —
  // nobody needs an alert every time someone fat-fingers a contract id
  // and we 404.
  if (status >= 500) {
    req.log.error(ctx, error.message ?? 'unhandled error')
    reportError(error, {
      // The route pattern, not the URL: ids and query strings stay out of it.
      reqId: req.id, method: req.method, url: req.routeOptions?.url ?? maskTokenPaths(req.url),
      userId: userContext?.sub, orgId: userContext?.orgId,
    })
  } else {
    req.log.warn(ctx, error.message ?? `${status} response`)
  }

  return reply.status(status).send({
    type:   `https://httpstatuses.com/${status}`,
    title:  status === 500 ? 'Internal Server Error' : error.name,
    status,
    detail: status === 500
      // Never leak stack traces / internal messages on 500.
      ? 'An unexpected error occurred. Reference the request id when reporting.'
      : error.message,
    reqId:  req.id,
  })
}
