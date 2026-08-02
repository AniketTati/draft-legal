/**
 * Unified transactional email sender.
 *
 * Cloud Run blocks outbound SMTP (ports 25 / 465 / 587), so nodemailer's
 * `connect` to any SMTP relay times out there. On GCP we therefore send via
 * SendGrid's HTTPS API (port 443, never blocked). nodemailer/SMTP is kept as a
 * fallback for self-hosted deployments that aren't behind that restriction.
 *
 * Provider precedence (first configured wins):
 *   1. SENDGRID_API_KEY → SendGrid Web API   (works on Cloud Run)
 *   2. SMTP_HOST        → nodemailer SMTP     (self-host / other relays)
 *   3. neither          → not configured; callers fall back to console logging
 *
 * `sendEmail` never throws — delivery is best-effort and must not fail the
 * caller's primary flow. It returns a small result so callers can log the
 * outcome (and surface SendGrid's rejection reason, e.g. an unverified sender).
 */

const PLACEHOLDER = new Set(['', 'REPLACE', 'placeholder', 'TODO', 'unset'])

function sendgridKey(): string | null {
  const k = (process.env.SENDGRID_API_KEY ?? '').trim()
  return PLACEHOLDER.has(k) ? null : k
}

/** True when any real email provider is configured (SendGrid API or SMTP). */
export function isEmailConfigured(): boolean {
  return sendgridKey() !== null || Boolean(process.env.SMTP_HOST)
}

export interface SendEmailArgs {
  to: string
  subject: string
  text: string
  html?: string
  /** Overrides SMTP_FROM / EMAIL_FROM. Must be a verified SendGrid sender. */
  from?: string
}

export type EmailResult =
  | { sent: true; via: 'sendgrid' | 'smtp' }
  | { sent: false; via: 'none'; reason: string }

function resolveFrom(explicit?: string): string {
  return explicit || process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@clm.app'
}

export async function sendEmail(args: SendEmailArgs): Promise<EmailResult> {
  const from = resolveFrom(args.from)

  // 1. SendGrid HTTPS API — the Cloud-Run-safe path.
  const key = sendgridKey()
  if (key) {
    const content: Array<{ type: string; value: string }> = [{ type: 'text/plain', value: args.text }]
    if (args.html) content.push({ type: 'text/html', value: args.html })
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: args.to }] }],
          from: { email: from },
          subject: args.subject,
          content,
        }),
      })
      // SendGrid returns 202 Accepted on success.
      if (res.ok) return { sent: true, via: 'sendgrid' }
      const body = await res.text().catch(() => '')
      return { sent: false, via: 'none', reason: `sendgrid ${res.status}: ${body.slice(0, 300)}` }
    } catch (err) {
      return { sent: false, via: 'none', reason: `sendgrid request failed: ${(err as Error).message}` }
    }
  }

  // 2. SMTP fallback (self-host / non-Cloud-Run). Lazy-load nodemailer so the
  // dependency isn't required when only the SendGrid path is used.
  if (process.env.SMTP_HOST) {
    try {
      const nodemailer = await import('nodemailer')
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT ?? '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
      await transporter.sendMail({ from, to: args.to, subject: args.subject, text: args.text, html: args.html })
      return { sent: true, via: 'smtp' }
    } catch (err) {
      return { sent: false, via: 'none', reason: `smtp send failed: ${(err as Error).message}` }
    }
  }

  return { sent: false, via: 'none', reason: 'no email provider configured (set SENDGRID_API_KEY or SMTP_HOST)' }
}
