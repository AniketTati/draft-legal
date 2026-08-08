#!/usr/bin/env node
/**
 * L4(b) — POST /api/v1/agent/draft writes across organisations.
 *
 * The route is gated on `view:contract`, takes an unvalidated body, and then
 * uses `saveAs.contractId` straight from that body:
 *
 *     const existing = await prisma.contractVersion.findFirst({
 *       where: { contractId },            // <- no orgId
 *       orderBy: { versionNumber: 'desc' },
 *     })
 *     await prisma.contractVersion.create({ data: { contractId, ... } })
 *
 * Every sibling write in this repo scopes by org — `internal-ai.ts` and
 * `clause-apply.ts` both filter `{ id, orgId, deletedAt: null }`. This one does
 * not, so an authenticated user in org A can append an attacker-controlled
 * version to a contract in org B.
 *
 * The probe deliberately sends a contractId the caller must not be able to
 * touch and asserts the request is refused BEFORE any drafting happens — a
 * request that will be rejected should not burn an LLM call either.
 *
 * Run BEFORE: the cross-org write is accepted; a new version appears on the
 *             victim contract.
 * Run AFTER:  404, and the victim's version count is unchanged.
 */
import { login, api, db, check, report, section, ensureSecondOrg } from '../week-zero/lib/harness.mjs'

const prisma = db()
const admin = await login()
const attackerOrgId = admin.user.orgId
const TITLE = 'L4 tenancy victim'

// ─── A contract in an organisation the caller has nothing to do with ────────

const victimOrg = await ensureSecondOrg()
if (victimOrg.id === attackerOrgId) throw new Error('fixture error: victim org is the caller org')

let victimOwner = await prisma.user.findFirst({ where: { orgId: victimOrg.id } })
victimOwner ??= await prisma.user.create({
  data: {
    orgId: victimOrg.id, email: `owner+${victimOrg.id}@isolation.test`,
    name: 'Isolation Owner', passwordHash: 'x',
  },
})

await prisma.contractVersion.deleteMany({ where: { contract: { orgId: victimOrg.id, title: TITLE } } })
await prisma.contract.deleteMany({ where: { orgId: victimOrg.id, title: TITLE } })

const victim = await prisma.contract.create({
  data: {
    org: { connect: { id: victimOrg.id } }, owner: { connect: { id: victimOwner.id } },
    title: TITLE, type: 'MSA', status: 'DRAFT',
  },
  select: { id: true },
})
await prisma.contractVersion.create({
  data: {
    contractId: victim.id, versionNumber: 1,
    htmlContent: '<p>Confidential terms belonging to another tenant.</p>',
    plainText: 'Confidential terms belonging to another tenant.',
    createdById: victimOwner.id,
  },
})

const before = await prisma.contractVersion.count({ where: { contractId: victim.id } })

// ─── The probe ──────────────────────────────────────────────────────────────

section('1. A caller cannot write into another organisation\'s contract')
{
  const res = await api(admin.accessToken, 'POST', '/agent/draft', {
    userMessage: 'Draft a one-line mutual NDA.',
    saveAs: { contractId: victim.id },
  })

  check('the cross-org draft is refused', res.status === 404 || res.status === 403,
    `status ${res.status} — 200 means a tenant boundary was crossed`)

  const after = await prisma.contractVersion.count({ where: { contractId: victim.id } })
  check('no version was written to the victim contract', after === before,
    `${before} version(s) before, ${after} after`)

  // Refusing after the model has already run still costs a paid LLM call for a
  // request that was never permitted, so refuse on the way in.
  check('the request is refused without drafting first',
    res.status !== 502 && res.status !== 422,
    `status ${res.status} — a 422/502 means it reached the agent before checking`)
}

// ─── The same route must still work for your own contract ───────────────────

section('2. The legitimate path is untouched')
{
  const mine = await prisma.contract.create({
    data: {
      org: { connect: { id: attackerOrgId } }, owner: { connect: { id: admin.user.id } },
      title: 'L4 own contract', type: 'NDA', status: 'DRAFT',
    },
    select: { id: true },
  })
  const res = await api(admin.accessToken, 'POST', '/agent/draft', {
    userMessage: 'Draft a one-line mutual NDA.',
    saveAs: { contractId: mine.id },
  })
  // 200 (drafted) or 422/502 (agent unavailable / no template) are all fine —
  // what must NOT happen is a 404, which would mean the fix over-reached.
  check('a contract in your own org is still accepted', res.status !== 404 && res.status !== 403,
    `status ${res.status}`)

  await prisma.contractVersion.deleteMany({ where: { contractId: mine.id } })
  await prisma.contract.delete({ where: { id: mine.id } }).catch(() => {})
}

await prisma.contractVersion.deleteMany({ where: { contractId: victim.id } })
await prisma.contract.delete({ where: { id: victim.id } }).catch(() => {})
await prisma.$disconnect()
report('L4 agent/draft tenancy')
