#!/usr/bin/env node
/**
 * P7.2 verify — Workflow correctness (3 sub-items).
 *
 *   (1) Sequential approval gating: Marcus (step 1, current) sees the
 *       Salesforce approval; Maya (step 2, not yet active) does NOT
 *   (2) Admin 'All approvals' tab returns the org-wide table
 *   (3) Dashboard KPIs persona-aware: admin sees "Org Approvals 1",
 *       Marcus sees "Pending Approvals 1", Lisa sees 0 (correct — not
 *       an approver, but her renewal still surfaces in YourDayList)
 */
const API = 'http://localhost:3001'
const BASE = 'http://localhost:5173'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const login = async (email) => (await (await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  })).json()).accessToken

  // ── (1) Sequential gating
  console.log('\n=== (1) F-66 — Sequential approval gating ===')
  const marcusTok = await login('marcus@demo.com')
  const mayaTok = await login('maya@demo.com')
  const marcusQueue = (await (await fetch(`${API}/api/v1/approvals/my-queue`, { headers: { authorization: 'Bearer ' + marcusTok } })).json()).data ?? []
  const mayaQueue   = (await (await fetch(`${API}/api/v1/approvals/my-queue`, { headers: { authorization: 'Bearer ' + mayaTok } })).json()).data ?? []
  check(marcusQueue.length === 1, `Marcus (step 1) sees 1 pending approval (got ${marcusQueue.length})`)
  check(marcusQueue[0]?.stepOrder === 1, `Marcus's step is step 1 (got ${marcusQueue[0]?.stepOrder})`)
  check(mayaQueue.length === 0, `Maya (step 2, not current) sees 0 pending approvals (got ${mayaQueue.length}) — sequential gate works`)

  // ── (2) Admin All Approvals
  console.log('\n=== (2) F-11 — Admin All Approvals ===')
  const adminTok = await login('admin@demo.com')
  const allRes = await fetch(`${API}/api/v1/approvals/all`, { headers: { authorization: 'Bearer ' + adminTok } })
  check(allRes.status === 200, `/approvals/all status=${allRes.status} (admin should be granted)`)
  const allBody = await allRes.json()
  check((allBody?.data?.length ?? 0) >= 1, `org-wide list has ≥1 entry (got ${allBody?.data?.length})`)
  const sf = (allBody?.data ?? []).find(r => r.contract?.title?.includes('Salesforce'))
  check(sf, 'Salesforce approval appears in admin All-Approvals')
  check(sf?.currentApproverName === 'Marcus Reyes', `currentApproverName='Marcus Reyes' (got '${sf?.currentApproverName}')`)
  check(typeof sf?.waitingDays === 'number' && sf.waitingDays >= 0, `waitingDays present (got ${sf?.waitingDays})`)

  // Maya tries to hit /approvals/all → should 403
  const mayaAll = await fetch(`${API}/api/v1/approvals/all`, { headers: { authorization: 'Bearer ' + mayaTok } })
  check(mayaAll.status === 403, `Non-admin Maya gets 403 on /approvals/all (got ${mayaAll.status})`)

  // ── (3) Dashboard KPIs
  console.log('\n=== (3) F-02/F-03/F-04 — Dashboard KPI counts ===')
  const adminDash = await (await fetch(`${API}/api/v1/dashboard`, { headers: { authorization: 'Bearer ' + adminTok } })).json()
  const marcusDash = await (await fetch(`${API}/api/v1/dashboard`, { headers: { authorization: 'Bearer ' + marcusTok } })).json()
  const lisaTok = await login('lisa@demo.com')
  const lisaDash = await (await fetch(`${API}/api/v1/dashboard`, { headers: { authorization: 'Bearer ' + lisaTok } })).json()

  check(adminDash?.orgPendingApprovals === 1, `admin: orgPendingApprovals=1 (got ${adminDash?.orgPendingApprovals})`)
  check(marcusDash?.pendingApprovals === 1, `marcus: pendingApprovals=1 (got ${marcusDash?.pendingApprovals})`)
  check(lisaDash?.pendingApprovals === 0, `lisa: pendingApprovals=0 (got ${lisaDash?.pendingApprovals})`)
  check(adminDash?.expiringSoon === 2, `admin: expiringSoon=2 (got ${adminDash?.expiringSoon})`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.2 workflow-correctness checks pass')
})().catch(e => { console.error(e); process.exit(1) })
