/**
 * X77 — the share-link email logged the portal link on every send, in every
 * environment. The link carries the portal token, a credential that opens the
 * contract (and, with upload rights, accepts a new version) for up to 30 days.
 * X18 masked the signing link the same way; this one was missed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendShareLinkEmail } from './share-email.js'

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.portal-token-x77.sig'
const send = () => sendShareLinkEmail({
  to: 'counsel@cp.example', portalUrl: `https://app.example.com/portal/${TOKEN}`, orgName: 'Acme',
  contractTitle: 'MSA', contractType: 'MSA', senderName: 'Pat', message: null, canUpload: false, expiresAt: new Date('2026-10-01'),
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('the share-link email\'s log line', () => {
  it('masks the portal token outside development', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SMTP_HOST', '')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    send()
    const logged = info.mock.calls.flat().join(' ')
    expect(logged).toContain('/portal/[REDACTED]')
    expect(logged).not.toContain(TOKEN)
  })

  it('prints the link whole in development, where the console is how it is found', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('SMTP_HOST', '')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    send()
    expect(info.mock.calls.flat().join(' ')).toContain(TOKEN)
  })
})
