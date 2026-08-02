/**
 * Signing email helper (Phase 07).
 *
 * Reuses the same nodemailer pattern as notification.worker.ts but
 * targets EXTERNAL signers — people who don't have a User row in our
 * DB and so can't get an in-app Notification.
 *
 * Behaviour:
 *   • Always logs the link to console — invaluable in dev where SMTP
 *     isn't set, so devs can copy/paste from the log into the browser.
 *   • If SMTP_HOST is set, also fires off a real email asynchronously.
 *     Email failure is non-fatal (link is in the DB regardless via the
 *     SignatureRequest record + Signer.token).
 *   • Idempotent — caller may call once per signer per send; we don't
 *     deduplicate (the route is the dedup boundary).
 */
import type { Signer } from '@prisma/client'
import { sendEmail } from './mailer.js'

interface SendSigningEmailArgs {
  to: string
  signerName: string
  senderName: string | null
  orgName: string
  contractTitle: string
  contractType: string
  signingUrl: string
  message: string | null
  expiresAt: Date | null
}

export function sendSigningEmail(args: SendSigningEmailArgs): void {
  // 1. Always console-log the link. In dev (and in tests) this is the
  // primary delivery channel — without it, signers have no way to find
  // the link before SMTP gets configured.
  const expiresStr = args.expiresAt
    ? ` · expires ${args.expiresAt.toISOString().slice(0, 10)}`
    : ''
  console.info(
    `[signing] ✉  ${args.to}  →  ${args.signingUrl}` +
    `  (${args.contractType} "${args.contractTitle}", signer "${args.signerName}"${expiresStr})`,
  )

  // 2. Send via the unified mailer — SendGrid HTTPS API on Cloud Run (where
  // outbound SMTP is blocked), nodemailer SMTP for self-host. Fire-and-forget:
  // the SignatureRequest + Signer.token are already in the DB, so a delivery
  // failure is non-fatal and only logged (with the provider's reason, e.g. an
  // unverified sender).
  const subject = `[${args.orgName}] Signature requested: ${args.contractTitle}`
  sendEmail({
    to: args.to,
    subject,
    text: renderTextBody(args),
    html: renderHtmlBody(args),
  })
    .then((r) => {
      if (r.sent) console.info(`[signing] delivered via ${r.via} → ${args.to}`)
      else console.warn(`[signing] email send failed for ${args.to}: ${r.reason}`)
    })
    .catch((err) => console.warn(`[signing] email send error for ${args.to}: ${(err as Error).message}`))
}

/** Plain-text email body — falls back when HTML isn't rendered. */
function renderTextBody(a: SendSigningEmailArgs): string {
  const lines: string[] = []
  lines.push(`Hi ${a.signerName},`)
  lines.push('')
  lines.push(
    `${a.senderName ?? a.orgName} is requesting your signature on a ${a.contractType.toLowerCase().replace(/_/g, ' ')}: "${a.contractTitle}".`,
  )
  if (a.message) {
    lines.push('')
    lines.push(`Their note: ${a.message}`)
  }
  lines.push('')
  lines.push(`Open the document and sign here:`)
  lines.push(a.signingUrl)
  if (a.expiresAt) {
    lines.push('')
    lines.push(`This link expires on ${a.expiresAt.toISOString().slice(0, 10)}.`)
  }
  lines.push('')
  lines.push(`If you weren't expecting this, you can safely ignore the email.`)
  lines.push(`— Sent securely by ${a.orgName} via the CLM platform.`)
  return lines.join('\n')
}

/** Minimal HTML email body — better-than-text, no heavy templates. */
function renderHtmlBody(a: SendSigningEmailArgs): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const expiry = a.expiresAt
    ? `<p style="color:#888;font-size:12px;margin-top:24px">This link expires on ${a.expiresAt.toISOString().slice(0, 10)}.</p>`
    : ''
  const noteBlock = a.message
    ? `<div style="background:#f5f7fa;border-left:3px solid #2563eb;padding:12px 16px;margin:18px 0;border-radius:4px;font-size:14px;color:#1f2937">
         <strong>Message from ${escape(a.senderName ?? a.orgName)}:</strong><br/>
         ${escape(a.message)}
       </div>`
    : ''

  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;margin:0;padding:24px;color:#1f2937">
    <div style="max-width:560px;margin:0 auto;background:white;padding:32px 28px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
      <h1 style="font-size:18px;font-weight:600;margin:0 0 6px 0;color:#111827">Signature requested</h1>
      <p style="color:#6b7280;font-size:14px;margin:0 0 18px 0">${escape(a.orgName)} · ${escape(a.contractType.replace(/_/g, ' '))}</p>
      <p style="font-size:15px;line-height:1.55;margin:0">Hi ${escape(a.signerName)},<br/><br/>
      ${escape(a.senderName ?? a.orgName)} has requested your signature on
      <strong>${escape(a.contractTitle)}</strong>.</p>
      ${noteBlock}
      <p style="margin:24px 0">
        <a href="${a.signingUrl}" style="display:inline-block;background:#10b981;color:white;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:8px;font-size:15px">Review &amp; sign &rarr;</a>
      </p>
      <p style="color:#9ca3af;font-size:12px;margin:18px 0 0 0">If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all">${a.signingUrl}</span>
      </p>
      ${expiry}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
      <p style="color:#9ca3af;font-size:11px;margin:0">If you weren't expecting this, you can ignore this email — your link is single-use and tied to a unique signing token.</p>
    </div>
  </body></html>`
}

/** Helper for callers that have a Signer row + contract context — keeps the call site small. */
export function sendSigningEmailForSigner({
  signer,
  baseUrl,
  senderName,
  orgName,
  contractTitle,
  contractType,
  message,
  expiresAt,
}: {
  signer: Pick<Signer, 'email' | 'name' | 'token'>
  baseUrl: string
  senderName: string | null
  orgName: string
  contractTitle: string
  contractType: string
  message: string | null
  expiresAt: Date | null
}): void {
  const trimmedBase = baseUrl.replace(/\/$/, '')
  sendSigningEmail({
    to: signer.email,
    signerName: signer.name,
    senderName,
    orgName,
    contractTitle,
    contractType,
    signingUrl: `${trimmedBase}/sign/${signer.token}`,
    message,
    expiresAt,
  })
}
