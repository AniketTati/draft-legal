/**
 * Tests for the unified mailer. Pure-ish — fetch is stubbed so no network.
 * Focus: provider selection + the exact SendGrid v3 request shape (the part
 * most likely to be subtly wrong), and that failures never throw.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sendEmail, isEmailConfigured } from './mailer.js'

const ENV = { ...process.env }
beforeEach(() => {
  for (const k of ['SENDGRID_API_KEY', 'SMTP_HOST', 'SMTP_FROM', 'EMAIL_FROM', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k]
})
afterEach(() => { process.env = { ...ENV }; vi.restoreAllMocks() })

describe('isEmailConfigured', () => {
  it('is false when neither provider is set', () => {
    expect(isEmailConfigured()).toBe(false)
  })
  it('is true when SENDGRID_API_KEY is a real key', () => {
    process.env.SENDGRID_API_KEY = 'SG.real'
    expect(isEmailConfigured()).toBe(true)
  })
  it('treats a placeholder key as unset', () => {
    process.env.SENDGRID_API_KEY = 'REPLACE'
    expect(isEmailConfigured()).toBe(false)
  })
  it('is true when SMTP_HOST is set', () => {
    process.env.SMTP_HOST = 'smtp.example.com'
    expect(isEmailConfigured()).toBe(true)
  })
})

/**
 * What mailer.ts actually passes to fetch. Typing the mock to this rather than
 * the general `RequestInit` is what lets the assertions below read `headers`
 * and `body` directly — under `RequestInit` those are union types (`HeadersInit`,
 * `BodyInit | null`) that no amount of casting makes pleasant, and the cast that
 * used to be here (`as [string, any]`) did not compile at all because the mock
 * declared no parameters, so `mock.calls[0]` inferred as `[]`.
 */
interface SentRequest {
  method:  string
  headers: Record<string, string>
  body:    string
}

describe('sendEmail — SendGrid HTTPS path', () => {
  it('POSTs the correct SendGrid v3 payload and returns via=sendgrid on 202', async () => {
    process.env.SENDGRID_API_KEY = 'SG.testkey'
    process.env.SMTP_FROM = 'noreply@example.com'
    const fetchMock = vi.fn(async (_url: string, _init: SentRequest) => new Response('', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await sendEmail({ to: 'user@example.com', subject: 'Hi', text: 'plain', html: '<b>hi</b>' })
    expect(r).toEqual({ sent: true, via: 'sendgrid' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect(opts.method).toBe('POST')
    expect(opts.headers.authorization).toBe('Bearer SG.testkey')
    const body = JSON.parse(opts.body)
    expect(body.from.email).toBe('noreply@example.com')
    expect(body.personalizations[0].to[0].email).toBe('user@example.com')
    expect(body.subject).toBe('Hi')
    // SendGrid requires text/plain BEFORE text/html.
    expect(body.content[0]).toEqual({ type: 'text/plain', value: 'plain' })
    expect(body.content[1]).toEqual({ type: 'text/html', value: '<b>hi</b>' })
  })

  it('surfaces the rejection reason on a non-2xx response (does not throw)', async () => {
    process.env.SENDGRID_API_KEY = 'SG.testkey'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('The from address does not match a verified Sender Identity', { status: 403 })))
    const r = await sendEmail({ to: 'u@e.com', subject: 's', text: 't' })
    expect(r.sent).toBe(false)
    if (!r.sent) {
      expect(r.reason).toContain('sendgrid 403')
      expect(r.reason).toContain('verified Sender')
    }
  })

  it('omits the html part when not provided', async () => {
    process.env.SENDGRID_API_KEY = 'SG.k'
    const fetchMock = vi.fn(async (_url: string, _init: SentRequest) => new Response('', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await sendEmail({ to: 'u@e.com', subject: 's', text: 'only text' })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.content).toHaveLength(1)
    expect(body.content[0].type).toBe('text/plain')
  })
})

describe('sendEmail — no provider', () => {
  it('returns sent:false without throwing when nothing is configured', async () => {
    const r = await sendEmail({ to: 'u@e.com', subject: 's', text: 't' })
    expect(r.sent).toBe(false)
    if (!r.sent) expect(r.reason).toContain('no email provider')
  })
})
