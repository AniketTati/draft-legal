#!/usr/bin/env node
/**
 * W0-5 — document text sent to a third-party LLM must go through the org's PII
 * policy, on every tool that emits it.
 *
 * `applyPiiPolicy` was wired into exactly one handler (`contract_get`). Nine
 * others shipped raw stored text to the same model in the same turn.
 *
 * This check is deliberately two-sided, because here the fix is riskier than
 * the bug. The redactor over-matched: it stripped emails out of notice clauses,
 * rewrote Luhn-passing agreement references as credit cards, and mangled
 * "(415) 555-0142" into "([REDACTED:PHONE]" — leaving an orphaned bracket in
 * the contract text. Turning that on across every search path at once would
 * have degraded answers everywhere on the same day. So the over-redaction
 * guard (section 3) matters as much as the coverage check (section 2): if it
 * fails, the coverage is doing harm.
 */
import { readFileSync } from 'node:fs'
import { login, check, report, section, internal, db } from './lib/harness.mjs'

const REPO = new URL('../../', import.meta.url).pathname
const prisma = db()
const admin = await login()
const orgId = admin.user.orgId

const SSN = '123-45-6789'
const NOTICE_EMAIL = 'legal@acmecorp.com'
const REF = '4532015112830366'          // passes Luhn — an agreement reference
const BODY = [
  'SECTION 5.2 LIMITATION OF LIABILITY.',
  'Liability is capped at the fees paid in the prior twelve months.',
  `All notices shall be sent to ${NOTICE_EMAIL} with a copy to counsel.`,
  `This Agreement (Ref. No. ${REF}) supersedes all prior agreements.`,
  `Employee SSN: ${SSN} shall remain confidential.`,
  'Contact: (415) 555-0142.',
].join('\n')

// ─── Fixture: a contract whose text carries both real PII and lookalikes ─────

async function seed() {
  const title = 'W0-5 PII probe'
  await prisma.contract.deleteMany({ where: { orgId, title } }).catch(() => {})
  const created = await prisma.contract.create({
    data: {
      org:   { connect: { id: orgId } },
      owner: { connect: { id: admin.user.id } },
      title, type: 'NDA', status: 'DRAFT',
      counterpartyName: 'Acme Corporation',
      analysisStatus: 'DONE',
    },
    select: { id: true },
  })
  const v = await prisma.contractVersion.create({
    data: {
      contractId: created.id, versionNumber: 1,
      htmlContent: `<p>${BODY.replace(/\n/g, '</p><p>')}</p>`,
      plainText: BODY,
      createdById: admin.user.id,
    },
    select: { id: true },
  })
  await prisma.contract.update({ where: { id: created.id }, data: { currentVersionId: v.id } })
  await prisma.contractClause.create({
    data: {
      versionId: v.id, clauseType: 'limitation_of_liability',
      content: BODY, sectionRef: 'Section 5.2',
    },
  })
  // Force the org onto 'redact' so the probe is deterministic.
  await prisma.organization.update({
    where: { id: orgId },
    data: { settings: { piiRedactionMode: 'redact' } },
  })
  return created.id
}

const contractId = await seed()
const dump = o => JSON.stringify(o ?? {})

// ─── 1. The reference implementation still works ─────────────────────────────

section('1. contract_get redacts (the reference behaviour)')
{
  const r = await internal('/tools/contract_get', { orgId, contractId }, orgId)
  const s = dump(r.body)
  check('contract_get responds', r.status === 200, `status=${r.status}`)
  check('the SSN is redacted', !s.includes(SSN) && s.includes('REDACTED:SSN'))
}

// ─── 2. Coverage: the other excerpt-emitting tools redact too ────────────────

section('2. Every excerpt-emitting tool applies the policy')
{
  const calls = [
    ['clause_search',       { orgId, contractId, query: 'liability SSN', limit: 5 }],
    ['contract_summarize',  { orgId, contractId }],
    ['contract_cite',       { orgId, contractId, query: 'SSN' }],
    ['portfolio_search',    { orgId, query: 'SSN confidential' }],
    ['contract_validate',   { orgId, contractId }],
  ]
  let provedRedaction = 0
  for (const [tool, body] of calls) {
    const r = await internal(`/tools/${tool}`, body, orgId)
    if (r.status !== 200) {
      check(`${tool} — call succeeded`, false, `status=${r.status} ${dump(r.body).slice(0, 120)}`)
      continue
    }
    const s = dump(r.body)

    // "Doesn't contain the SSN" is trivially true of an empty result, so
    // separate the three outcomes rather than counting a vacuous pass as
    // evidence: leaked / genuinely redacted / returned nothing to redact.
    const leaked = s.includes(SSN)
    const redacted = s.includes('REDACTED:SSN')
    if (leaked) {
      check(`${tool} leaks the raw SSN`, false, s.slice(0, 160))
    } else if (redacted) {
      provedRedaction++
      check(`${tool} redacted the SSN in its excerpt`, true)
    } else {
      check(`${tool} returned no excerpt for this probe (nothing to assert)`, true, 'soft-pass')
    }
  }
  check(
    'at least one tool actually exercised redaction',
    provedRedaction > 0,
    `${provedRedaction} tool(s) returned a redacted excerpt — if this is 0, every ` +
    'pass above was vacuous and the coverage is unproven',
  )
}

// ─── 3. Over-redaction guard — the fix must not break the product ───────────

section('3. Operative contract content survives redaction')
{
  const r = await internal('/tools/contract_get', { orgId, contractId }, orgId)
  const s = dump(r.body)
  check(
    'the notice-clause email is preserved',
    s.includes(NOTICE_EMAIL),
    'a CLM that cannot answer "where do I send notice?" is broken',
  )
  check(
    'the agreement reference number is preserved',
    s.includes(REF),
    'Luhn passes 1 in 10 long numbers; contracts are full of them',
  )
  check(
    'the counterparty name is preserved',
    s.includes('Acme Corporation'),
    'party names are the contract, not incidental PII',
  )
  check(
    'no orphaned bracket left behind by phone matching',
    !s.includes('([REDACTED'),
    'the old pattern matched from the digits on and left "(" in the text',
  )
}

// ─── 4. Audit rows are batched, not one per excerpt ─────────────────────────

section('4. A multi-excerpt search writes one audit row, not one per hit')
{
  const since = new Date(Date.now() - 60_000)
  await prisma.auditEvent.deleteMany({
    where: { orgId, action: 'PII_REDACTED', createdAt: { gte: since } },
  }).catch(() => {})

  await internal('/tools/clause_search', { orgId, contractId, query: 'SSN liability notices', limit: 10 }, orgId)
  const rows = await prisma.auditEvent.count({
    where: { orgId, action: 'PII_REDACTED', createdAt: { gte: since } },
  })
  check(
    'one search produces at most one PII_REDACTED event',
    rows <= 1,
    `rows=${rows} — one row per excerpt buries the trail it exists to provide`,
  )
}

// ─── 5. The redactor's own precision, pinned in source ──────────────────────

// The behavioural probe above only exercises the tools that return an excerpt
// for THIS fixture — clause_search needs embeddings, contract_cite a structure
// tree, portfolio_search an ES index. Assert coverage at the source so the
// unexercised endpoints are still guaranteed.
section('5. Every excerpt-emitting handler is wired to the redaction helper')
{
  const src = readFileSync(REPO + 'apps/api/src/routes/internal-ai.ts', 'utf8')
  const handlers = [
    'clause_search', 'contract_summarize', 'contract_cite', 'portfolio_search',
    'counterparty_memory', 'org_memory', 'playbook_check', 'portfolio_compare',
    'contract_validate',
  ]
  for (const tool of handlers) {
    // Take the handler body up to the next route registration and look for a
    // redaction call inside it.
    const start = src.indexOf(`app.post('/tools/${tool}'`)
    if (start === -1) {
      check(`${tool} handler found`, false, 'route registration not located')
      continue
    }
    const next = src.indexOf("app.post('/tools/", start + 10)
    const bodyText = src.slice(start, next === -1 ? src.length : next)
    check(
      `${tool} redacts before returning`,
      /redactExcerpts\s*\(|applyPiiPolicyBatch\s*\(|applyPiiPolicy\s*\(/.test(bodyText),
      `surface: ${(bodyText.match(/surface:\s*'([^']+)'/) ?? [])[1] ?? 'none'}`,
    )
  }
}

section('6. Redactor defaults are the contract-text defaults')
{
  const src = readFileSync(REPO + 'apps/api/src/lib/pii-redactor.ts', 'utf8')
  check('EMAIL/PHONE are exempt by default', /CONTRACT_TEXT_EXEMPT/.test(src))
  check('CC and IBAN require nearby context', (src.match(/requiresContext/g) ?? []).length >= 3)
  check('callers can still opt in per kind', /options\.kinds/.test(src))
}

await prisma.$disconnect()
report('W0-5 PII redaction coverage')
