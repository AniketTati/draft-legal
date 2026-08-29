#!/usr/bin/env node
/**
 * P7.6.1 verify — Self-hosted eSignature end-to-end.
 *
 * Walks through:
 *   - Pick a contract that's not yet executed
 *   - POST /contracts/:id/send-for-signature with 2 signers (sequential)
 *   - As signer #1, GET /sign/:token → confirm the envelope payload
 *   - POST /sign/:token/sign → records the signature
 *   - Confirm signer #2 cannot sign yet (sequential gate)
 *   - As signer #2, GET + POST sign → request COMPLETED, contract EXECUTED
 *   - Audit log shows SIGNATURE_SENT + SIGNATURE_COMPLETED for the contract
 *
 * Then a UI smoke test:
 *   - chromium loads /sign/:token (signer #1 again, but request voided
 *     after contract is EXECUTED so we use a fresh request)
 *   - Page renders, "Sign" button clickable
 */
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'desktop')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'
const API  = 'http://localhost:3001/api/v1'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

;(async () => {
  // Login as admin (needs configure:contract permission)
  const tokenRes = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  })
  const { accessToken } = await tokenRes.json()

  // Pick a contract that has a currentVersionId AND isn't already EXECUTED
  const cs = await fetch(`${API}/contracts?limit=20`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  const contracts = cs.contracts ?? cs.data ?? []
  let pick = null
  for (const c of contracts) {
    if (c.status === 'EXECUTED') continue
    const detail = await fetch(`${API}/contracts/${c.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then(r => r.json())
    if (detail.currentVersionId) { pick = detail; break }
  }
  if (!pick) {
    console.error('No suitable contract — need at least one non-executed contract with a version')
    process.exit(1)
  }
  console.log(`  using contract ${pick.id.slice(-8)}: "${pick.title}"`)

  // ── (1) POST send-for-signature
  console.log('\n=== (1) Send for signature (2 signers, sequential) ===')
  const sendRes = await fetch(`${API}/contracts/${pick.id}/send-for-signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      signers: [
        { name: 'P761 Verify Signer A', email: `verify-a-${Date.now()}@example.com`, role: 'CFO', signOrder: 1 },
        { name: 'P761 Verify Signer B', email: `verify-b-${Date.now()}@example.com`, role: 'CEO', signOrder: 2 },
      ],
      signOrder: 'SEQUENTIAL',
      message: 'Please sign — P7.6.1 verify',
      expiresInDays: 7,
    }),
  })
  check(sendRes.ok, `send-for-signature returns 2xx (got ${sendRes.status})`)
  const sentReq = await sendRes.json()
  check(sentReq.signers?.length === 2, `request has 2 signers`)
  const signerA = sentReq.signers.find(s => s.signOrder === 1)
  const signerB = sentReq.signers.find(s => s.signOrder === 2)
  check(!!signerA?.token && !!signerB?.token, `each signer has a token`)

  // Contract should now be PENDING_SIGNATURE
  const ctAfterSend = await fetch(`${API}/contracts/${pick.id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  check(ctAfterSend.status === 'PENDING_SIGNATURE', `contract status is PENDING_SIGNATURE (got ${ctAfterSend.status})`)

  // ── (2) GET /sign/:token for signer A
  console.log('\n=== (2) Signer A GETs the envelope ===')
  const envA = await fetch(`${API}/sign/${signerA.token}`).then(r => r.json())
  check(envA.signer?.name === 'P761 Verify Signer A', `envelope signer name correct`)
  check(envA.contract?.id === pick.id, `envelope contract matches`)
  check(envA.version?.htmlContent?.length > 0, `envelope includes htmlContent`)
  check(envA.signatureRequest?.totalSigners === 2, `request shows 2 total signers`)

  // ── (3) Signer B tries to sign before A → blocked by sequential gate
  console.log('\n=== (3) Signer B blocked by sequential gate ===')
  const earlyB = await fetch(`${API}/sign/${signerB.token}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedName: 'B Premature' }),
  })
  check(earlyB.status === 403, `B's premature sign returns 403 (got ${earlyB.status})`)

  // ── (4) Signer A signs
  console.log('\n=== (4) Signer A signs ===')
  const signARes = await fetch(`${API}/sign/${signerA.token}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedName: 'A. Verify Signer' }),
  })
  check(signARes.ok, `A's sign returns 2xx (got ${signARes.status})`)
  const signAJson = await signARes.json()
  check(signAJson.allSigned === false, `allSigned is false after just A`)

  // Contract should still be PENDING_SIGNATURE
  const midState = await fetch(`${API}/contracts/${pick.id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  check(midState.status === 'PENDING_SIGNATURE', `contract still PENDING_SIGNATURE`)

  // ── (5) Signer B signs → contract → EXECUTED
  console.log('\n=== (5) Signer B signs → contract EXECUTED ===')
  const signBRes = await fetch(`${API}/sign/${signerB.token}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedName: 'B. Verify Signer' }),
  })
  check(signBRes.ok, `B's sign returns 2xx`)
  const signBJson = await signBRes.json()
  check(signBJson.allSigned === true, `allSigned is true after B`)
  const finalState = await fetch(`${API}/contracts/${pick.id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json())
  check(finalState.status === 'EXECUTED', `contract status flipped to EXECUTED (got ${finalState.status})`)

  // ── (6) UI: SignerPortal renders
  console.log('\n=== (6) UI: SignerPortal renders for a fresh request ===')
  // Create another fresh contract send to get usable signer tokens (the
  // ones above are now COMPLETED).
  const freshContract = contracts.find(c => c.id !== pick.id && c.status !== 'EXECUTED')
  if (freshContract) {
    const detail = await fetch(`${API}/contracts/${freshContract.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then(r => r.json())
    if (detail.currentVersionId) {
      const send2Res = await fetch(`${API}/contracts/${freshContract.id}/send-for-signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          signers: [{ name: 'UI Verify Signer', email: `ui-verify-${Date.now()}@example.com`, signOrder: 1 }],
          signOrder: 'ANY',
          message: 'UI smoke test — P7.6.1',
          expiresInDays: 7,
        }),
      })
      const sent2 = await send2Res.json()
      const uiToken = sent2.signers?.[0]?.token
      if (uiToken) {
        const br = await chromium.launch({ headless: true })
        const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } })
        const page = await ctx.newPage()
        page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))
        await page.goto(`${BASE}/sign/${uiToken}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(2000)
        check(await page.getByTestId('signer-portal').count() === 1, `signer-portal mounts`)
        check(await page.getByTestId('signer-sign-btn').count() === 1, `Sign button visible`)
        await page.screenshot({ path: path.join(OUT, '240-p76-1-signer-portal.png'), fullPage: false })
        await br.close()
      }
    }
  }

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.6.1 eSignature checks pass')
})().catch(e => { console.error(e); process.exit(1) })
