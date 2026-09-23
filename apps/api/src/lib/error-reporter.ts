/**
 * Error reporting (X3). The stub dropped every error.
 *
 * On Cloud Run (the deploy target; K_SERVICE is set there), or anywhere with
 * ERROR_REPORTING=gcp, each unhandled 5xx is written to stderr as a Cloud
 * Error Reporting event. Error Reporting picks those up from the logs, groups
 * them by stack and can alert, with no SDK and no key to manage. Elsewhere the
 * structured request log line (middleware/error-handler.ts) is the record.
 */
import { maskTokenPaths } from './log-redact.js'

export function reportError(error: unknown, context: Record<string, unknown>): void {
  if (!process.env.K_SERVICE && process.env.ERROR_REPORTING !== 'gcp') return
  const err = error instanceof Error ? error : new Error(String(error))
  const url = typeof context.url === 'string' ? maskTokenPaths(context.url) : undefined
  const event = {
    severity: 'ERROR',
    '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
    message: err.stack ?? `${err.name}: ${err.message}`,
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
  try {
    process.stderr.write(JSON.stringify(event) + '\n')
  } catch {
    // The error path must never throw.
  }
}
