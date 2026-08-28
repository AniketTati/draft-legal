#!/usr/bin/env node
/**
 * L16 — a BYOK resolution failure refuses instead of billing the platform key.
 *
 * `resolve_llm` caught a bare `except Exception` from the Node resolve and fell
 * through to `_platform_resolve(tier)`. That helper reads the AGENTS SERVICE's
 * own env: it cannot see OrgAiSettings (the tier override) or OrgAiKey (the
 * BYOK key). So by construction it picked a provider the org did not choose and
 * paid with a key the org did not supply — and logged a warning.
 *
 * For a self-hosted product whose pitch is "your contracts never leave your
 * servers", and where a customer DPA may name one specific subprocessor, that
 * is a disclosure path that records itself as a log line.
 *
 * Two things made it wider than the error path suggests:
 *   - /classify-clause and /complete never forwarded orgId at all, so the two
 *     highest-volume model calls in the product took the platform key with no
 *     exception involved.
 *   - ~11 downstream handlers caught the refusal into a confident wrong answer
 *     (classify returning contractType OTHER, which is a VALID type nothing
 *     gates on), and review's BackgroundTask dropped it entirely, leaving the
 *     contract in ANALYZING forever.
 *
 * Run BEFORE: a poisoned tier override still answers 200 on a platform provider.
 * Run AFTER:  it answers 503, and a review marks the contract FAILED.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, report, section, AGENTS, INTERNAL_SECRET, db } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const read = p => { try { return fs.readFileSync(`${REPO}/${p}`, 'utf8') } catch { return '' } }

const routerPy = read('apps/agents/app/router.py')

// ─── 1. The router has no fall-through left ─────────────────────────────────

section('1. Every handler in the org branch raises')
{
  // Assert the INVARIANT, not a class name. Grepping for the new exception only
  // proves someone typed it; slicing the function and requiring every `except`
  // body to raise is the property that actually matters, and it survives the
  // clauses being reordered or renamed.
  const start = routerPy.indexOf('    if org_id and settings.api_url')
  const end   = routerPy.indexOf('    # Platform path', start)
  const branch = start >= 0 && end > start ? routerPy.slice(start, end) : ''
  check('the org branch was located', branch.length > 0,
    'the slice anchors moved — fix them, do not delete the assertion')

  const clauses = branch.split(/\n        except /).slice(1)
  check('it has at least three except clauses', clauses.length >= 3,
    `found ${clauses.length}`)
  const nonRaising = clauses.filter(c => !/\braise\b/.test(c.split('\n').slice(0, 24).join('\n')))
  check('every except clause raises', nonRaising.length === 0,
    nonRaising.length ? `these fall through: ${nonRaising.map(c => c.split(':')[0]).join(', ')}` : 'no fall-through')

  check('the platform fallback comment no longer claims to catch org failures',
    !/falling back to platform/.test(routerPy),
    'that string was the bypass describing itself')

  // l11-cost-cap.mjs greps for this literal. Keeping it is what stops a correct
  // refactor turning that check red.
  check('the literal `except CostCapExceeded:` clause survives for l11',
    /except CostCapExceeded:[\s\S]{0,600}?raise\b/.test(routerPy),
    'l11-cost-cap.mjs:71 greps this exact shape')
}

section('2. The refusal family and its status mapping')
{
  check('RouterRefusal is the base class', /class RouterRefusal\(RuntimeError\)/.test(routerPy))
  for (const sub of ['CostCapExceeded', 'ModelOverrideUnavailable', 'ProviderResolutionFailed']) {
    check(`${sub} extends RouterRefusal`, new RegExp(`class ${sub}\\(RouterRefusal\\)`).test(routerPy),
      'a sibling would be missed by every `except RouterRefusal` downstream')
  }
  const mainPy = read('apps/agents/main.py')
  check('a handler maps RouterRefusal to a status', /exception_handler\(RouterRefusal\)/.test(mainPy),
    'without it every refusal surfaces as an opaque 500')
  check('…429 for a cap breach, 503 otherwise',
    /CostCapExceeded[\s\S]{0,200}?429/.test(mainPy) && /status_code=503/.test(mainPy))
}

section('3. The swallowing handlers re-raise')
{
  for (const f of [
    'apps/agents/app/routes/classify.py',
    'apps/agents/app/routes/intake.py',
    'apps/agents/app/routes/detect_binder.py',
    'apps/agents/app/routes/assist.py',
    'apps/agents/app/agents/approval_agent.py',
    'apps/agents/app/agents/review_agent.py',
  ]) {
    const src = read(f)
    const guards = (src.match(/except RouterRefusal:/g) ?? []).length
    const blankets = (src.match(/except Exception/g) ?? []).length
    check(`${f.split('/').pop()} guards every blanket handler`, guards >= blankets && guards > 0,
      `${guards} guard(s) for ${blankets} blanket handler(s) — an unguarded one turns a refusal into a confident wrong answer`)
  }
  check('review.py records FAILED rather than stalling in ANALYZING',
    /except RouterRefusal[\s\S]{0,900}?analysisStatus["']?\s*:\s*["']FAILED/.test(read('apps/agents/app/routes/review.py')),
    'the FAILED write lives past the raise, so without this the contract never leaves ANALYZING')
}

section('4. The hot paths forward orgId')
{
  const agentsTs = read('apps/api/src/routes/agents.ts')
  // Slice each route so a match from a neighbour cannot satisfy the assertion.
  const slice = (name) => {
    const i = agentsTs.indexOf(`app.post('/${name}'`)
    return i < 0 ? '' : agentsTs.slice(i, i + 2200)
  }
  for (const route of ['classify-clause', 'complete']) {
    check(`/${route} sends orgId`, /orgId:\s*req\.user\.orgId/.test(slice(route)),
      'without it the agents service resolves org_id=None and takes the platform key with NO exception involved')
  }
  for (const route of ['assist-stream', 'assist']) {
    check(`/${route} still sends orgId`, /orgId:\s*req\.user\.orgId/.test(slice(route)),
      'regression guard — these two were always correct')
  }
}

// ─── 5. Behavioural — the part that must be watchable failing ───────────────

section('5. A poisoned tier override is refused, not silently answered')
{
  const prisma = db()
  const POISON = 'bogus-provider/bogus-model-1'
  let org = null, prior = null, restored = false
  try {
    org = await prisma.organization.findFirst({ select: { id: true } })
    check('an org exists to test with', !!org)
    if (org) {
      prior = await prisma.orgAiSettings.findUnique({ where: { orgId: org.id } })

      // Anti-fail-always control FIRST, while config is clean: if the service
      // refuses even without a poisoned override, "fails closed" has silently
      // become "fails always" and every assertion below would still pass.
      const clean = await fetch(`${AGENTS}/classify_clause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
        body: JSON.stringify({ clauseText: 'The Supplier shall indemnify the Customer against all third-party claims arising from negligence.', orgId: org.id }),
      }).then(r => r.status).catch(() => 0)
      check('a clean org still gets a real answer (not fail-always)', clean === 200,
        `got ${clean} with no override — fail-closed must not become fail-always`)

      // With a tier override present, aiRouter makes it the ONLY candidate, so
      // an unknown provider guarantees NoProviderAvailable. No env manipulation
      // and no Redis cache to clear, unlike the cost cap.
      await prisma.orgAiSettings.upsert({
        where:  { orgId: org.id },
        update: { fastModel: POISON },
        create: { orgId: org.id, fastModel: POISON },
      })

      const status = await fetch(`${AGENTS}/classify_clause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
        body: JSON.stringify({ clauseText: 'The Supplier shall indemnify the Customer against all third-party claims arising from negligence.', orgId: org.id }),
      }).then(r => r.status).catch(() => 0)

      // THE MONEY CHECK. Before the fix this is 200 with a real platform
      // provider echoed back — the bypass, printed.
      check('a poisoned override is refused, not answered on the platform key',
        status === 503,
        `got ${status}; a 200 here means the org pinned "${POISON}" and we answered anyway`)
    }
  } finally {
    if (org) {
      if (prior) {
        await prisma.orgAiSettings.update({ where: { orgId: org.id }, data: { fastModel: prior.fastModel } })
      } else {
        await prisma.orgAiSettings.deleteMany({ where: { orgId: org.id } })
      }
      restored = true
    }
    await prisma.$disconnect()
  }
  check('the fixture was restored', restored,
    'an interrupted probe must not leave an org pinned to a bogus provider')
}

report('L16 BYOK fail-closed')
