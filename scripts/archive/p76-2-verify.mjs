#!/usr/bin/env node
/**
 * P7.6.2 verify — Two-way counterparty portal upload.
 *
 * Existing infra from B.5.14 already had POST /portal/:t/versions and the
 * ExternalPortalPage UI. P7.6.2 hardens it by:
 *   - Persisting the file bytes to S3/MinIO (was only DB row before)
 *   - Adding PORTAL_UPLOADED_VERSION audit action (was generic VIEWED)
 *
 * Checks:
 *   (1) Create a share link with 'edit' permissions
 *   (2) POST /portal/:token/versions with a sample PDF buffer
 *   (3) Confirm a new ContractVersion appears with createdById prefixed 'portal:'
 *   (4) Confirm the audit log includes a PORTAL_UPLOADED_VERSION entry
 *   (5) Confirm contract.status flipped to UNDER_NEGOTIATION
 *   (6) Try POST without 'edit' permission → 403
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { Buffer } from 'node:buffer'

const API = 'http://localhost:3001/api/v1'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

;(async () => {
  // Login as admin to be able to create a share link
  const tokenRes = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  })
  const { accessToken } = await tokenRes.json()

  // Pick any contract
  const cs = await fetch(`${API}/contracts?limit=20`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  const contracts = cs.contracts ?? cs.data ?? []
  const ct = contracts.find(c => c.status !== 'EXECUTED') ?? contracts[0]
  if (!ct) { console.error('no contracts available'); process.exit(1) }
  console.log(`  using contract ${ct.id.slice(-8)}`)

  // ── (1) Create a share link with 'edit' permission
  console.log('\n=== (1) Create share link with edit permission ===')
  const shareRes = await fetch(`${API}/contracts/${ct.id}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ permissions: ['read', 'comment', 'edit'], expiresInHours: 24 }),
  })
  check(shareRes.status === 201, `share link create returns 201 (got ${shareRes.status})`)
  const shareData = await shareRes.json()
  const portalUrl = shareData.portalUrl
  // Extract the JWT from /portal/<jwt>
  const portalJwt = portalUrl?.split('/portal/')[1]
  check(!!portalJwt, `portalUrl has a jwt`)

  // ── (2) Read-only baseline: try uploading without 'edit' first
  console.log('\n=== (2) Read-only link rejects upload (control test) ===')
  const readOnlyShare = await fetch(`${API}/contracts/${ct.id}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ permissions: ['read'], expiresInHours: 24 }),
  }).then(r => r.json())
  const readOnlyJwt = readOnlyShare.portalUrl.split('/portal/')[1]
  // Multipart upload via Node's built-in FormData
  const fd = new FormData()
  const dummyPdf = new Blob([Buffer.from('%PDF-1.4\nP7.6.2 verify\n', 'utf8')], { type: 'application/pdf' })
  fd.set('file', dummyPdf, 'redline-attempt.pdf')
  const readOnlyAttempt = await fetch(`${API}/portal/${readOnlyJwt}/versions`, {
    method: 'POST', body: fd,
  })
  check(readOnlyAttempt.status === 403, `read-only upload returns 403 (got ${readOnlyAttempt.status})`)

  // ── (3) Upload via the edit-permission link
  console.log('\n=== (3) Upload via edit link succeeds ===')
  const fd2 = new FormData()
  const realPdf = new Blob([Buffer.from('%PDF-1.4\nP7.6.2 verify upload\n%%EOF', 'utf8')], { type: 'application/pdf' })
  fd2.set('file', realPdf, 'p76-2-counter-revision.pdf')
  const uploadRes = await fetch(`${API}/portal/${portalJwt}/versions`, {
    method: 'POST', body: fd2,
  })
  check(uploadRes.status === 201, `upload returns 201 (got ${uploadRes.status})`)
  const uploadJson = await uploadRes.json()
  check(uploadJson.versionNumber > 0, `versionNumber > 0 (got ${uploadJson.versionNumber})`)

  // ── (4) Confirm version row + createdById prefix
  console.log('\n=== (4) Version row has portal:<linkId> attribution ===')
  const versions = await fetch(`${API}/contracts/${ct.id}/versions`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  const vs = versions.versions ?? versions.data ?? versions
  const ours = vs.find(v => v.id === uploadJson.id)
  check(!!ours, `our version exists in /versions list`)
  check(ours?.createdById?.startsWith('portal:'), `createdById starts with "portal:" (got "${ours?.createdById}")`)

  // ── (5) Contract.status flipped to UNDER_NEGOTIATION
  console.log('\n=== (5) Contract status flipped to UNDER_NEGOTIATION ===')
  const ctAfter = await fetch(`${API}/contracts/${ct.id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  check(ctAfter.status === 'UNDER_NEGOTIATION', `status is UNDER_NEGOTIATION (got ${ctAfter.status})`)

  // ── (6) Audit event PORTAL_UPLOADED_VERSION present
  console.log('\n=== (6) Audit log records PORTAL_UPLOADED_VERSION ===')
  // No public audit endpoint; do a raw DB query via a temp script
  const { spawnSync } = await import('node:child_process')
  const auditScript = `
    import { prisma } from '../src/lib/prisma.js'
    const evs = await prisma.auditEvent.findMany({
      where: { resourceType: 'contract', resourceId: '${ct.id}', action: 'PORTAL_UPLOADED_VERSION' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    })
    console.log('AUDIT_COUNT', evs.length)
    if (evs[0]) console.log('LATEST_FILENAME', evs[0].metadata.filename)
    await prisma.$disconnect()
  `
  const auditScriptPath = path.join(REPO_ROOT, 'apps/api/scripts/p76-2-audit-check.ts')
  await import('node:fs').then(fs => fs.writeFileSync(auditScriptPath, auditScript))
  const auditRes = spawnSync('pnpm', ['tsx', 'scripts/p76-2-audit-check.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    encoding: 'utf8',
  })
  const auditOut = (auditRes.stdout ?? '') + (auditRes.stderr ?? '')
  const m = auditOut.match(/AUDIT_COUNT\s+(\d+)/)
  check(m && parseInt(m[1], 10) >= 1, `audit log has ≥1 PORTAL_UPLOADED_VERSION entry`)
  check(/p76-2-counter-revision\.pdf/.test(auditOut), `audit metadata includes the filename`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.6.2 portal-upload checks pass')
})().catch(e => { console.error(e); process.exit(1) })
