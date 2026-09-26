/**
 * Error reporting (X3). The stub dropped every error.
 *
 * On Cloud Run (the deploy target; K_SERVICE is set there), or anywhere with
 * ERROR_REPORTING=gcp, each unhandled 5xx is written to stderr as a Cloud
 * Error Reporting event. Error Reporting picks those up from the logs, groups
 * them by stack and can alert, with no SDK and no key to manage. Elsewhere the
 * structured request log line (middleware/error-handler.ts) is the record.
 */
import { inspect } from 'node:util'
import { maskTokenPaths } from './log-redact.js'

/** Cloud Logging rejects entries over 256 KB. */
const MAX_MESSAGE = 64 * 1024

export function reportError(error: unknown, context: Record<string, unknown>): void {
  if (!process.env.K_SERVICE && process.env.ERROR_REPORTING !== 'gcp') return
  try {
    write(error, context)
  } catch {
    // The error path must never throw.
  }
}

function write(error: unknown, context: Record<string, unknown>): void {
  // A thrown non-Error (even one String() can't convert) is described, not rethrown.
  const message = error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : `Error: non-Error thrown: ${inspect(error, { depth: 2, breakLength: Infinity })}`
  const url = typeof context.url === 'string' ? maskTokenPaths(context.url) : undefined
  const event = {
    severity: 'ERROR',
    '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
    message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
    serviceContext: {
      service: process.env.K_SERVICE ?? 'clm-api',
      ...(process.env.K_REVISION ? { version: process.env.K_REVISION } : {}),
    },
    context: {
      ...(context.method || url ? { httpRequest: { method: context.method, url } } : {}),
      ...(context.userId ? { user: String(context.userId) } : {}),
    },
    reqId: context.reqId,
    orgId: context.orgId,
  }
  process.stderr.write(JSON.stringify(event) + '\n')
}
