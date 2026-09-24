/**
 * Share-link email — delivers a portal link to an external counterparty.
 *
 * Follows the same shape as signing-email.ts (the other counterparty-facing
 * mailer): always log the link so it's recoverable when SMTP isn't configured,
 * then attempt a real send, with failures non-fatal because the link already
 * exists in the DB and can still be copied from the dialog.
 *
 * Before this, "send for review to the other party" was clipboard-only — the
 * user copied a URL and pasted it into their own mail client.
 */
import { devPrint } from './log-scrub.js'

interface SendShareLinkEmailArgs {
  to: string
  portalUrl: string
  contractTitle: string
  contractType: string
  orgName: string
  senderName: string | null
  /** Optional note from the sender, shown above the button. */
  message: string | null
  expiresAt: Date
  /** True when the link grants 'upload' — changes the call to action. */
  canUpload: boolean
  /**
   * Per-contract inbound address (`contracts+<id>@…`) when inbound email is
   * configured. Set as Reply-To and mentioned in the body: replying with a
   * marked-up file lands it as a new version. Without this the address exists
   * only in the codebase, so no counterparty could ever discover it.
   */
  replyToAddress?: string | null
}

export function sendShareLinkEmail(args: SendShareLinkEmailArgs): void {
  // Always log — in dev (and whenever SMTP is unset) this is the only way to
  // recover the link without reopening the dialog.
  // X77 — the link carries the portal token, a credential that opens the
  // contract for up to 30 days: whole only in development, as X18 does for
  // signing links. It was printed in every environment. Y4 — devPrint is the
  // scrubber's one exception, for exactly this.
  devPrint(
    `[share] ✉  ${args.to}  →  ${args.portalUrl}` +
    `  (${args.contractType} "${args.contractTitle}", expires ${args.expiresAt.toISOString().slice(0, 10)})`,
  )

  if (!process.env.SMTP_HOST) return

  const subject = `[${args.orgName}] ${args.canUpload ? 'Review and return' : 'Review'}: ${args.contractTitle}`
  const text = renderTextBody(args)
  const html = renderHtmlBody(args)

  import('nodemailer').then((nodemailer) => {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT ?? '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      } : undefined,
    })
    return transporter.sendMail({
      from: process.env.SMTP_FROM ?? process.env.EMAIL_FROM ?? `${args.orgName} <noreply@clm.app>`,
      to:   args.to,
      ...(args.replyToAddress ? { replyTo: args.replyToAddress } : {}),
      subject,
      text,
      html,
    })
  }).catch((err) => {
    // Non-fatal — the share link is already persisted and copyable.
    console.warn(`[share] email send failed for ${args.to}: ${(err as Error).message}`)
  })
}

function renderTextBody(a: SendShareLinkEmailArgs): string {
  const lines: string[] = []
  lines.push('Hello,')
  lines.push('')
  lines.push(
    `${a.senderName ?? a.orgName} has shared a ${a.contractType.toLowerCase().replace(/_/g, ' ')} with you for review: "${a.contractTitle}".`,
  )
  if (a.message) {
    lines.push('')
    lines.push(`Their note: ${a.message}`)
  }
  lines.push('')
  lines.push(a.canUpload
    ? 'You can read it, download a copy to mark up, and upload your revised version back:'
    : 'You can open and review it here:')
  lines.push(a.portalUrl)
  if (a.replyToAddress) {
    lines.push('')
    lines.push('You can also simply reply to this email with your marked-up copy attached (PDF or DOCX) and it will be filed against this contract automatically.')
  }
  lines.push('')
  lines.push(`This link expires on ${a.expiresAt.toISOString().slice(0, 10)}.`)
  lines.push('')
  lines.push(`If you weren't expecting this, you can safely ignore this email.`)
  lines.push(`— Sent securely by ${a.orgName} via the CLM platform.`)
  return lines.join('\n')
}

function renderHtmlBody(a: SendShareLinkEmailArgs): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const noteBlock = a.message
    ? `<div style="background:#f5f7fa;border-left:3px solid #2563eb;padding:12px 16px;margin:18px 0;border-radius:4px;font-size:14px;color:#1f2937">
         <strong>Message from ${escape(a.senderName ?? a.orgName)}:</strong><br/>
         ${escape(a.message)}
       </div>`
    : ''

  const uploadHint = a.canUpload
    ? `<p style="color:#6b7280;font-size:13px;line-height:1.5;margin:16px 0 0 0">
         You can download the document, mark it up in Word, and upload your
         revised version back through the same link.
       </p>`
    : ''

  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;margin:0;padding:24px;color:#1f2937">
    <div style="max-width:560px;margin:0 auto;background:white;padding:32px 28px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
      <h1 style="font-size:18px;font-weight:600;margin:0 0 6px 0;color:#111827">Shared for review</h1>
      <p style="color:#6b7280;font-size:14px;margin:0 0 18px 0">${escape(a.orgName)} · ${escape(a.contractType.replace(/_/g, ' '))}</p>
      <p style="font-size:15px;line-height:1.55;margin:0">Hello,<br/><br/>
      ${escape(a.senderName ?? a.orgName)} has shared
      <strong>${escape(a.contractTitle)}</strong> with you for review.</p>
      ${noteBlock}
      <p style="margin:24px 0">
        <a href="${a.portalUrl}" style="display:inline-block;background:#2563eb;color:white;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:8px;font-size:15px">Open the document &rarr;</a>
      </p>
      ${uploadHint}
      ${a.replyToAddress
        ? `<p style="color:#6b7280;font-size:13px;line-height:1.5;margin:12px 0 0 0">
             Or just <strong>reply to this email</strong> with your marked-up copy
             attached (PDF or DOCX) — it will be filed against this contract
             automatically.
           </p>`
        : ''}
      <p style="color:#9ca3af;font-size:12px;margin:18px 0 0 0">If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all">${a.portalUrl}</span>
      </p>
      <p style="color:#888;font-size:12px;margin-top:24px">This link expires on ${a.expiresAt.toISOString().slice(0, 10)}.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
      <p style="color:#9ca3af;font-size:11px;margin:0">If you weren't expecting this, you can ignore this email — the link is tied to a unique access token and will expire.</p>
    </div>
  </body></html>`
}
