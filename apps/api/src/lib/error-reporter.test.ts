/**
 * X3 — error-reporter.ts was a no-op. On Cloud Run (K_SERVICE) or with
 * ERROR_REPORTING=gcp, a 5xx goes to stderr as a Cloud Error Reporting event.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { reportError } from './error-reporter.js'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.ERROR_REPORTING
  delete process.env.K_SERVICE
})

describe('reportError', () => {
  it('writes nothing outside Cloud Run unless asked to', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    reportError(new Error('boom'), { url: '/x' })
    expect(write).not.toHaveBeenCalled()
  })

  it('writes one Error Reporting event, with signing tokens masked', () => {
    process.env.K_SERVICE = 'clm-api'
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    reportError(new Error('boom'), { method: 'GET', url: '/api/v1/sign/abc123secret', userId: 'u1', reqId: 'r1', orgId: 'o1' })
    expect(write).toHaveBeenCalledTimes(1)
    const event = JSON.parse(String(write.mock.calls[0][0]))
    expect(event).toMatchObject({
      severity: 'ERROR',
      '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
      serviceContext: { service: 'clm-api' },
      context: { httpRequest: { method: 'GET', url: '/api/v1/sign/[REDACTED]' }, user: 'u1' },
      reqId: 'r1',
    })
    expect(event.message).toMatch(/^Error: boom\n\s+at /)
    expect(JSON.stringify(event)).not.toContain('abc123secret')
  })

  it('never throws from the error path', () => {
    process.env.ERROR_REPORTING = 'gcp'
    vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('closed') })
    expect(() => reportError('not an error', {})).not.toThrow()
  })
})
