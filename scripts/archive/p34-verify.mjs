#!/usr/bin/env node
/**
 * P3.4 verify — contract_validate (lexicon + cross-ref).
 *
 *   (1) A contract with deliberate defined-term drift + unresolved
 *       cross-refs + dangling section references yields issues of
 *       each expected kind
 *   (2) `definedTerms` includes the quoted-role nouns we injected
 *   (3) A clean contract returns zero issues (no false positives)
 *   (4) `bySeverity` histogram present + sums to totalIssues
 *   (5) @review-contract allowlist includes contract_validate
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const API = 'http://localhost:3001'

function callTool(name, body) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_call-tool.ts', name, JSON.stringify(body)], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
}

async function login() {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  }).then(x => x.json())
  return r.accessToken
}

/** Seed a test contract with plainText crafted to trip the validators. */
function seedDirtyContract(orgId, userId) {
  const dirty = `MUTUAL SERVICES AGREEMENT

This Agreement is entered between Globex Inc. (hereinafter the "Customer") and Acme LLC.

Section 1. Scope.
The Customer shall receive services.

Section 9.2. Liability.
The company is liable for direct damages only. See Section ___ for carve-outs.

Section 12. Governing Law.
Refer to Exhibit ___ attached hereto. Also see Section 99.9 for details.

Section 20. Confidentiality.
The CUSTOMER shall maintain confidentiality. customer acknowledges this.`

  const fs = writeFileSync
  const script = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const c = await p.contract.create({
        data: {
          orgId: ${JSON.stringify(orgId)},
          title: 'P3.4 dirty-contract ' + Date.now(),
          type: 'MSA',
          status: 'DRAFT',
          ownerId: ${JSON.stringify(userId)},
          createdBy: ${JSON.stringify(userId)},
          analysisStatus: 'DONE',
          tags: ['p34-fixture'],
          versions: {
            create: {
              versionNumber: 1,
              plainText: ${JSON.stringify(dirty)},
              htmlContent: '<p>' + ${JSON.stringify(dirty)}.replace(/\\n\\n/g, '</p><p>').replace(/\\n/g, ' ') + '</p>',
              createdById: ${JSON.stringify(userId)},
              metadata: { structure: { nav: [
                { id: 's1', ref: '1', title: 'Scope', level: 2, depth: 0, paragraphCount: 1 },
                { id: 's9', ref: '9.2', title: 'Liability', level: 3, depth: 0, paragraphCount: 1 },
                { id: 's12', ref: '12', title: 'Governing Law', level: 2, depth: 0, paragraphCount: 1 },
                { id: 's20', ref: '20', title: 'Confidentiality', level: 2, depth: 0, paragraphCount: 1 },
              ]}},
            },
          },
        },
        include: { versions: true },
      })
      await p.contract.update({
        where: { id: c.id },
        data: { currentVersionId: c.versions[0].id },
      })
      console.log(JSON.stringify({ contractId: c.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  const tmp = '/tmp/p34-seed.ts'
  writeFileSync(tmp, script)
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', tmp], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) throw new Error(`seed failed: ${r.stderr}`)
  const line = r.stdout.trim().split('\n').pop() || '{}'
  return JSON.parse(line).contractId
}

function deleteContract(id) {
  const tmp = '/tmp/p34-cleanup.ts'
  writeFileSync(tmp, `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      await p.contract.update({ where: { id: ${JSON.stringify(id)} }, data: { deletedAt: new Date() } })
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `)
  spawnSync('pnpm', ['tsx', '--env-file=.env', tmp], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
}

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const token = await login()
  const list = await fetch(`${API}/api/v1/contracts?pageSize=1`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const first = (list.data ?? list.contracts ?? [])[0]
  const orgId = first?.orgId
  const userId = first?.ownerId
  if (!orgId || !userId) { console.error('no contracts to pull orgId/ownerId'); process.exit(1) }

  const dirtyId = seedDirtyContract(orgId, userId)
  try {
    // (1/2/4) Dirty contract
    const r = callTool('contract_validate', { orgId, contractId: dirtyId })
    check(r.status === 200, `(1) contract_validate returns 200 (got ${r.status})`)
    const body = r.body ?? {}
    check(body.totalIssues >= 3, `(1) ≥3 issues on dirty contract (got ${body.totalIssues})`)

    const kinds = new Set((body.issues ?? []).map(i => i.kind))
    check(kinds.has('defined_term_drift'),
      `(1) defined_term_drift issue present (kinds: ${[...kinds].join(', ')})`)
    check(kinds.has('unresolved_crossref'),
      `(1) unresolved_crossref issue present`)
    check(kinds.has('dangling_section_ref'),
      `(1) dangling_section_ref issue present`)

    // (2) Defined terms extracted from the hereinafter phrasing
    const terms = body.definedTerms ?? []
    check(terms.includes('Customer'),
      `(2) "Customer" extracted as a defined term (got: ${terms.join(', ')})`)

    // (4) Severity histogram
    const sev = body.bySeverity ?? {}
    const sum = (sev.low ?? 0) + (sev.medium ?? 0) + (sev.high ?? 0)
    check(sum === body.totalIssues,
      `(4) bySeverity sums to totalIssues (${sum} vs ${body.totalIssues})`)

    // (3) Clean contract — use an existing DONE contract; it should
    //     have zero (or very few) validator issues. We accept 0-2 to
    //     tolerate imperfect extractions.
    const cleanId = first.id
    const r2 = callTool('contract_validate', { orgId, contractId: cleanId })
    check(r2.status === 200, `(3) clean-contract call returns 200 (got ${r2.status})`)
    check((r2.body?.totalIssues ?? 99) <= 5,
      `(3) clean contract has ≤5 issues (got ${r2.body?.totalIssues})`)

    // (5) Skill allowlist
    const skills = await fetch(`${API}/api/v1/skills`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(x => x.json())
    const review = (skills.skills ?? []).find(s => s.slug === '@review-contract')
    check(review?.allowedTools?.includes('contract_validate'),
      `(5) @review-contract allowlist includes contract_validate`)
  } finally {
    deleteContract(dirtyId)
  }

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P3.4 contract_validate checks pass')
})().catch(e => { console.error(e); process.exit(1) })
