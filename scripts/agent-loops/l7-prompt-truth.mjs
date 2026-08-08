#!/usr/bin/env node
/**
 * L7 — the system prompt describes a product that changed under it.
 *
 * `AGENT_SYSTEM_PROMPT` has no test and no reviewer, so nothing forces it to be
 * edited alongside the behaviour it describes. Ten of the 26 registered tools
 * appear in it exactly zero times, and several of its concrete claims are now
 * false — it promises UI buttons deleted in June, a citation marker syntax
 * nothing parses, a `portfolio_search` ceiling and field that do not exist, and
 * a CSV export no tool provides.
 *
 * This check is deliberately STATIC. The prompt's effect on tool selection is
 * probabilistic and belongs in the eval suite (gap #3); what is checkable here
 * is whether the prompt tells the model true things about the system it is
 * driving. A prompt that describes a product that no longer exists is a
 * hallucination generator regardless of how the model behaves on any one run.
 *
 * The one runtime assertion is the `totalMatching` fix, because that is an API
 * change and a prompt rule that must agree with each other.
 *
 * Run BEFORE: ten tools unmentioned, five false claims present, and the
 *             semantic fallback reports a page count as a database count.
 * Run AFTER:  every tool named, the false claims gone, and the fallback count
 *             marked as the lower bound it is.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { login, internal, db, check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const AGENTS = `${REPO}/apps/agents`

const src = fs.readFileSync(`${AGENTS}/app/orchestrator.py`, 'utf8')
const promptMatch = /AGENT_SYSTEM_PROMPT\s*=\s*(?:f)?"""([\s\S]*?)"""/.exec(src)
const PROMPT = promptMatch?.[1] ?? ''

const TOOLS = fs.readdirSync(`${AGENTS}/app/tools`)
  .filter(f => f.endsWith('.py') && f !== '__init__.py')
  .map(f => f.slice(0, -3))
  .sort()

// ─── 1. Every tool the agent has is a tool the prompt knows about ───────────

section('1. The prompt names every registered tool')
{
  check('the system prompt was located', PROMPT.length > 1000, `${PROMPT.length} chars`)

  const missing = TOOLS.filter(t => !PROMPT.includes(t))
  check('no registered tool is absent from the prompt', missing.length === 0,
    missing.length
      ? `${missing.length} of ${TOOLS.length} unmentioned: ${missing.join(', ')} — the prompt outranks tool descriptions, so an unnamed tool is one the model rarely selects`
      : `all ${TOOLS.length} named`)
}

// ─── 2. Claims the code contradicts ─────────────────────────────────────────

section('2. The prompt does not promise things that no longer exist')
{
  // artifact-from-tool.ts records dropping these on 2026-06-10 and now emits
  // exactly one action, 'open'.
  check('no "Save as draft" / "Send for review" buttons are promised',
    !/Save as draft|Send for review/i.test(PROMPT),
    'those buttons were deleted in June 2026; the Doc artifact emits only "Open in Contracts"')

  // grep -rn 'cite:' apps/web/src returns nothing — any marker the model writes
  // reaches the user as literal bracket text.
  const webHasCiteParser = fs.readdirSync(`${REPO}/apps/web/src`, { recursive: true })
    .filter(f => typeof f === 'string' && /\.(ts|tsx)$/.test(f))
    .some(f => {
      try { return /\[cite:/.test(fs.readFileSync(`${REPO}/apps/web/src/${f}`, 'utf8')) } catch { return false }
    })
  check('no [cite:...] marker syntax is instructed unless something parses it',
    !/\[cite:/.test(PROMPT) || webHasCiteParser,
    webHasCiteParser ? 'a parser exists' : 'nothing in apps/web parses [cite:...] — the model would emit literal bracket text at the user')

  check('no CSV export is offered as a worked example',
    !/Export this list to CSV/i.test(PROMPT),
    'no registered tool exports CSV — the prompt suggests a chip that is one tap to a dead end')
}

// ─── 3. portfolio_search is described as it actually behaves ────────────────

section('3. portfolio_search: the stated ceiling and fields are real')
{
  const psSrc = fs.readFileSync(`${AGENTS}/app/tools/portfolio_search.py`, 'utf8')
  const ceiling = /le=(\d+)/.exec(psSrc)?.[1]

  // The prompt claimed "up to 50 hits". The tool caps top_k at 30.
  const claims50 = /portfolio_search[\s\S]{0,400}?up to 50/i.test(PROMPT)
  check(`no false ceiling is claimed (tool caps at ${ceiling})`, !claims50,
    claims50 ? 'the prompt promises 50; the model will plan around a limit it cannot get' : `consistent with le=${ceiling}`)

  // The hit object has no expiryDate; contract_search's does.
  //
  // Assert the precise false claim rather than proximity. Two cleverer
  // versions of this failed: a plain substring match cannot tell a CLAIM from
  // the corrected prompt's DENIAL, and a sentence-level negation check matched
  // the legitimate `sort_by=expiryDate` line that belongs to contract_search.
  // The defect was one specific list of fields; assert on that.
  const FALSE_FIELD_LIST = /\(title,\s*value,\s*status,\s*expiryDate,\s*counterparty\)/
  check('expiryDate is not listed among portfolio_search\'s returned fields',
    !FALSE_FIELD_LIST.test(PROMPT),
    FALSE_FIELD_LIST.test(PROMPT)
      ? 'the hit object has no expiryDate — "which contracts expire this quarter" finds no dates and the model invents them or gives up'
      : 'the field list matches internal-ai.ts')
}

// ─── 4. Write tools are listed completely ───────────────────────────────────

section('4. The WRITE TOOLS list matches the confirm-gated tools')
{
  // A tool is confirm-gated iff it returns awaitingConfirmation.
  const gated = TOOLS.filter(t => {
    try { return /awaitingConfirmation/.test(fs.readFileSync(`${AGENTS}/app/tools/${t}.py`, 'utf8')) }
    catch { return false }
  })
  const undocumented = gated.filter(t => !PROMPT.includes(t))
  check('every confirm-gated write tool appears in the prompt', undocumented.length === 0,
    undocumented.length
      ? `missing: ${undocumented.join(', ')} — a live write tool with an apply allowlist entry, actor mapping and undo branch that the model is never told about`
      : `all ${gated.length} gated tools documented: ${gated.join(', ')}`)

  check('the write-tool list does not trail off with "(more coming)"',
    !/\(more coming\)/i.test(PROMPT),
    'it has been "more coming" long enough that a live tool went undocumented behind it')
}

// ─── 5. The model is told the limits it must plan around ────────────────────

section('5. The runtime caps are stated, not just enforced')
{
  const caps = {
    MAX_TOOL_ITERATIONS: /MAX_TOOL_ITERATIONS\s*=\s*(\d+)/.exec(src)?.[1],
    TOTAL_TOOLS_PER_TURN: /TOTAL_TOOLS_PER_TURN\s*=\s*(\d+)/.exec(src)?.[1],
  }
  for (const [name, value] of Object.entries(caps)) {
    if (!value) continue
    check(`the ${name} cap (${value}) is stated in the prompt`,
      PROMPT.includes(value) || PROMPT.toLowerCase().includes(name.toLowerCase().replace(/_/g, ' ')),
      `the model cannot plan around a budget it was never told about`)
  }
}

// ─── 6. The semantic fallback stops reporting a page count as a total ───────

section('6. semantic-fallback reports a lower bound, not a database count')
{
  const prisma = db()
  const admin = await login()
  const orgId = admin.user.orgId

  // Static first, because the runtime probe below only fires when this
  // corpus actually misses on keywords — and a soft-pass would leave the fix
  // unverified while reporting green.
  const apiSrc = fs.readFileSync(`${REPO}/apps/api/src/routes/internal-ai.ts`, 'utf8')
  check('the fallback branch returns totalMatching: null',
    /totalMatching:\s*usedFallback\s*\?\s*null/.test(apiSrc),
    /totalMatching:\s*usedFallback\s*\?\s*fallbackResults\.length/.test(apiSrc)
      ? 'it returns fallbackResults.length, which equals the page size by construction — A11 then tells the model to report it as a database count'
      : 'null under fallback')

  check('the prompt tells the model what searchMode=semantic-fallback means',
    /semantic-fallback/.test(PROMPT),
    'internal-ai.ts says the flag exists so the agent can announce it broadened the search; without a rule the model never does')

  // A query no keyword match can satisfy forces the pgvector fallback, whose
  // count is built by breaking at `orderedIds.length >= body.limit` — so it
  // equals results.length by construction, not the number of matching rows.
  const res = await internal('/tools/contract_search', {
    orgId, query: 'zzqx unlikely phrase steel tariffs quantum', limit: 3,
  }, orgId)

  if (res.status === 200 && res.body?.searchMode === 'semantic-fallback') {
    check('totalMatching is not presented as a DB count under semantic fallback',
      res.body.totalMatching === null || res.body.totalMatching === undefined,
      `totalMatching=${JSON.stringify(res.body.totalMatching)}, results=${res.body.results?.length} — A11 tells the model this is "the DB count of rows satisfying the filter", so it answers "you have N" with total confidence`)
    check('the prompt tells the model what searchMode=semantic-fallback means',
      /semantic-fallback/.test(PROMPT),
      'internal-ai.ts says the flag exists so the agent can say it broadened the search; no prompt rule mentions it')
  } else {
    check('semantic fallback probe ran', true,
      `searchMode=${res.body?.searchMode ?? 'n/a'} (status ${res.status}) — soft-pass: this corpus did not trigger the fallback`)
  }
  await prisma.$disconnect()
}

report('L7 prompt truth')
