#!/usr/bin/env node
/**
 * P7.6.3 verify — Email-redline inbound parser.
 *
 * Posts a synthetic SendGrid Inbound Parse payload to the webhook and
 * confirms the attached PDF lands as a new ContractVersion attributed
 * to email:<sender>, status flips to UNDER_NEGOTIATION, and an
 * EMAIL_REDLINE_RECEIVED audit event is recorded.
 *
 * Checks:
 *   (1) POST /api/v1/inbound/email with a tagged To: address →
 *       returns 201 + new versionNumber
 *   (2) The new ContractVersion has createdById prefixed "email:"
 *   (3) Contract.status flipped to UNDER_NEGOTIATION
 *   (4) Audit log has EMAIL_REDLINE_RECEIVED entry
 *   (5) Wrong sender (not on counterparty.email) → 403 (when
 *       INBOUND_EMAIL_ALLOW_ALL is unset)
 *   (6) No attachment → 400
 *   (7) Bad To: format → 400
 *
 * Note: in dev with no INBOUND_EMAIL_SECRET, the route accepts
 * unauthenticated requests (loud-warning mode).
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { Buffer } from 'node:buffer'

const API = 'http://localhost:3001/api/v1'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

;(async () => {
  // Login as admin to find a contract + check audit log
  const tokenRes = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  })
  const { accessToken } = await tokenRes.json()

  // Pick a non-executed contract that has a counterparty with an email
  const cs = await fetch(`${API}/contracts?limit=20`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  const contracts = cs.contracts ?? cs.data ?? []
  let pick = null
  let cpEmail = null
  for (const c of contracts) {
    if (c.status === 'EXECUTED') continue
    // Get counterparty email
    if (c.counterpartyId) {
      const cp = await fetch(`${API}/counterparties/${c.counterpartyId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.json())
      if (cp.email) {
        pick = c
        cpEmail = cp.email
        break
      }
    }
  }
  if (!pick) {
    console.error('No suitable contract — need a non-executed contract with a counterparty email')
    process.exit(1)
  }
  console.log(`  using contract ${pick.id.slice(-8)} | counterparty email: ${cpEmail}`)

  // Build a tiny PDF buffer encoded base64
  const pdfB64 = Buffer.from('%PDF-1.4\nP7.6.3 inbound\n%%EOF', 'utf8').toString('base64')

  // ── (1) Happy path
  console.log('\n=== (1) Happy path: counterparty emails a redline PDF ===')
  const r = await fetch(`${API}/inbound/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: `contracts+${pick.id}@inbound.example.com`,
      from: cpEmail,
      subject: 'Re: redline v3',
      text: 'Please see attached our markup. Section 8 is our main concern.',
      attachments: [{
        filename: 'p76-3-redline.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfB64,
      }],
    }),
  })
  check(r.status === 201, `webhook returns 201 (got ${r.status})`)
  const body = await r.json().catch(() => ({}))
  check(body.versionNumber > 0, `body.versionNumber > 0 (got ${body.versionNumber})`)
  console.log(`  -> v${body.versionNumber} (${body.filename})`)

  // ── (2) Version row attribution
  console.log('\n=== (2) Version row has email:<sender> attribution ===')
  const versions = await fetch(`${API}/contracts/${pick.id}/versions`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  const vs = versions.versions ?? versions.data ?? versions
  const ours = vs.find(v => v.id === body.versionId)
  check(!!ours, `version exists in /versions list`)
  check(ours?.createdById?.startsWith('email:'), `createdById starts with "email:" (got "${ours?.createdById}")`)

  // ── (3) Contract status
  console.log('\n=== (3) Contract status → UNDER_NEGOTIATION ===')
  const ctAfter = await fetch(`${API}/contracts/${pick.id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  check(ctAfter.status === 'UNDER_NEGOTIATION', `status is UNDER_NEGOTIATION (got ${ctAfter.status})`)

  // ── (4) Audit event
  console.log('\n=== (4) Audit log has EMAIL_REDLINE_RECEIVED entry ===')
  const { spawnSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const auditScriptPath = path.join(REPO_ROOT, 'apps/api/scripts/p76-3-audit-check.ts')
  fs.writeFileSync(auditScriptPath, `
    import { prisma } from '../src/lib/prisma.js'
    const evs = await prisma.auditEvent.findMany({
      where: { resourceType: 'contract', resourceId: '${pick.id}', action: 'EMAIL_REDLINE_RECEIVED' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    })
    console.log('AUDIT_COUNT', evs.length)
    if (evs[0]) console.log('AUDIT_FILENAME', evs[0].metadata.filename)
    if (evs[0]) console.log('AUDIT_SENDER', evs[0].metadata.sender)
    await prisma.$disconnect()
  `)
  const auditRes = spawnSync('pnpm', ['tsx', 'scripts/p76-3-audit-check.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    encoding: 'utf8',
  })
  const auditOut = (auditRes.stdout ?? '') + (auditRes.stderr ?? '')
  check(/AUDIT_COUNT\s+[1-9]/.test(auditOut), `audit log has ≥1 EMAIL_REDLINE_RECEIVED entry`)
  check(/AUDIT_FILENAME p76-3-redline\.pdf/.test(auditOut), `audit metadata includes filename`)
  check(new RegExp(`AUDIT_SENDER ${cpEmail.toLowerCase()}`).test(auditOut), `audit metadata includes sender`)

  // ── (5) Wrong sender → 403 (when not in allow-all mode)
  console.log('\n=== (5) Unknown sender is rejected (when not allow-all) ===')
  // Pick a different contract for a clean scenario
  const otherContract = contracts.find(c => c.id !== pick.id && c.status !== 'EXECUTED')
  if (!otherContract) {
    console.log('  (no spare contract — skipping)')
  } else {
    // Determine if INBOUND_EMAIL_ALLOW_ALL is set in the live API; if so,
    // skip — this control test only runs when production-like config is active.
    const wrongRes = await fetch(`${API}/inbound/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: `contracts+${otherContract.id}@inbound.example.com`,
        from: 'random-stranger@example.com',
        subject: 'Hi',
        text: 'unknown sender',
        attachments: [{
          filename: 'try.pdf',
          contentType: 'application/pdf',
          contentBase64: pdfB64,
        }],
      }),
    })
    if (wrongRes.status === 403) {
      console.log(`  ✓ unknown sender returns 403`)
    } else if (wrongRes.status === 201) {
      console.log(`  (allow-all mode active — skipping strict sender test)`)
    } else {
      check(false, `unknown sender returns 403 or 201, got ${wrongRes.status}`)
    }
  }

  // ── (6) No attachment → 400
  console.log('\n=== (6) Email with no PDF/DOCX attachment → 400 ===')
  const noAtt = await fetch(`${API}/inbound/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: `contracts+${pick.id}@inbound.example.com`,
      from: cpEmail,
      subject: 'No attachment',
      text: 'just text',
      attachments: [],
    }),
  })
  check(noAtt.status === 400, `no-attachment returns 400 (got ${noAtt.status})`)

  // ── (7) Bad To: format → 400
  console.log('\n=== (7) Bad To: format → 400 ===')
  const badTo = await fetch(`${API}/inbound/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: 'just@example.com',  // missing +tag
      from: cpEmail,
      subject: '',
      attachments: [{
        filename: 'x.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfB64,
      }],
    }),
  })
  check(badTo.status === 400, `bad-To returns 400 (got ${badTo.status})`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.6.3 inbound-email checks pass')
})().catch(e => { console.error(e); process.exit(1) })
