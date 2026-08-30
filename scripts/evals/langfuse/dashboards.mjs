#!/usr/bin/env node
/**
 * Create the standing dashboards in Langfuse.
 *
 *   node scripts/evals/langfuse/dashboards.mjs            # create/refresh both
 *   node scripts/evals/langfuse/dashboards.mjs --only quality
 *   node scripts/evals/langfuse/dashboards.mjs --dry-run
 *
 * `analyze.mjs` answers "how did last night look" on demand. These are the
 * things you leave open: the same slices, always current, for people who are
 * not going to run a CLI. Both exist because the audiences differ — an engineer
 * chasing a regression wants the script, everyone else wants the page.
 *
 * Two dashboards, because they answer different questions and get looked at by
 * different people on different days:
 *
 *   OPERATIONS  is it working, and what is it costing?   (cost, latency, errors)
 *   QUALITY     is it any good, and is that changing?    (judge, human, user scores)
 *
 * Widgets are defined in code so the set is reviewable and reproducible across
 * projects. The endpoints are Langfuse's `unstable` API — the shape can change
 * under us, so a failed widget is reported and skipped rather than thrown: a
 * dashboard is a convenience and must not take a review down with it.
 */
import { requireConfig, LANGFUSE_HOST } from './lf.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')
const dryRun = process.argv.includes('--dry-run')
const force  = process.argv.includes('--force')
const onlyIx = process.argv.indexOf('--only')
const only   = onlyIx >= 0 ? process.argv[onlyIx + 1] : null

async function api(method, path, body) {
  const res = await fetch(`${cfg.host.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${String(text).slice(0, 300)}`)
  return parsed
}

const count  = { measure: 'count', agg: 'count' }
const cost   = { measure: 'totalCost', agg: 'sum' }
const avgVal = { measure: 'value', agg: 'avg' }

/**
 * `ran` is bookkeeping — the harness posts it 1 on every scored case to record
 * that the case executed at all. It is always 1, so leaving it in drags every
 * quality average upward by however many cases ran. Excluded by EXACT name
 * ("none of"), not `does not contain`, which would also swallow any future
 * score whose name merely contains those three letters.
 */
const NOT_BOOKKEEPING = [{ column: 'name', operator: 'none of', value: ['ran'], type: 'stringOptions' }]

const OPERATIONS = {
  name: 'draftLegal — LLM production review',
  description: 'Volume, cost, latency and errors across every LLM surface. Created by scripts/evals/langfuse/dashboards.mjs.',
  widgets: [
    { name: 'Spend (total)', description: 'Total model spend in the selected window.',
      view: 'observations', chartType: 'NUMBER', dimensions: [], metrics: [cost], filters: [] },
    { name: 'Calls by surface', description: 'Where the volume is — extraction, assistant and chat.',
      view: 'observations', chartType: 'HORIZONTAL_BAR', dimensions: [{ field: 'traceName' }], metrics: [count], filters: [],
      chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 } },
    { name: 'Cost by model', description: 'Which model is actually spending the budget.',
      view: 'observations', chartType: 'PIE', dimensions: [{ field: 'providedModelName' }], metrics: [cost], filters: [],
      chartConfig: { type: 'PIE', row_limit: 10 } },
    { name: 'Cost by surface', description: 'Spend concentration. Optimise the top bar or nothing.',
      view: 'observations', chartType: 'HORIZONTAL_BAR', dimensions: [{ field: 'traceName' }], metrics: [cost], filters: [],
      chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 } },
    { name: 'p95 latency by surface', description: 'p95, not average — the average is what hides the slow surface.',
      view: 'observations', chartType: 'HORIZONTAL_BAR', dimensions: [{ field: 'traceName' }],
      metrics: [{ measure: 'latency', agg: 'p95' }], filters: [],
      chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 } },
    { name: 'Time to first token (p95)', description: 'What a streaming user actually waits through. Can be almost all of total latency — 24s total with 23s of blank screen is a different product from 24s of visible progress.',
      view: 'observations', chartType: 'HORIZONTAL_BAR', dimensions: [{ field: 'traceName' }],
      metrics: [{ measure: 'timeToFirstToken', agg: 'p95' }], filters: [],
      chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 } },
    { name: 'Errors by surface', description: 'Error-level observations by surface. Empty is the goal.',
      view: 'observations', chartType: 'HORIZONTAL_BAR', dimensions: [{ field: 'traceName' }], metrics: [count],
      filters: [{ column: 'level', operator: '=', value: 'ERROR', type: 'string' }],
      chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 } },
    { name: 'Tokens over time', description: 'Throughput trend — a step change here usually precedes a cost surprise.',
      view: 'observations', chartType: 'LINE_TIME_SERIES', dimensions: [],
      metrics: [{ measure: 'totalTokens', agg: 'sum' }], filters: [] },
    { name: 'Cost over time', description: 'Spend trend in the window.',
      view: 'observations', chartType: 'LINE_TIME_SERIES', dimensions: [], metrics: [cost], filters: [] },
  ],
}

const QUALITY = {
  name: 'draftLegal — agent quality',
  description: 'What the judge, the reviewers and real users think. Created by scripts/evals/langfuse/dashboards.mjs.',
  widgets: [
    { name: 'Overall pass rate', description: 'Every boolean quality score, averaged. The single number — but never read it without the breakdown beside it.',
      view: 'scores-boolean', chartType: 'NUMBER', dimensions: [], metrics: [avgVal], filters: NOT_BOOKKEEPING },

    { name: 'User feedback', description: 'Thumbs up/down from real people in the app. The only signal that is not a rubric.',
      view: 'scores-boolean', chartType: 'NUMBER', dimensions: [], metrics: [avgVal],
      filters: [{ column: 'name', operator: 'any of', value: ['user_feedback'], type: 'stringOptions' }] },

    { name: 'Pass rate by criterion', description: 'Groundedness, helpfulness, tool selection, retrieval sufficiency and the rest. This is where a single bad number becomes a specific problem.',
      view: 'scores-boolean', chartType: 'HORIZONTAL_BAR', dimensions: [{ field: 'name' }], metrics: [avgVal],
      filters: NOT_BOOKKEEPING, chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 25 } },

    { name: 'Pass rate by surface', description: 'Which product surface is actually weak. Chat and extraction fail in different ways and at different rates.',
      view: 'scores-boolean', chartType: 'HORIZONTAL_BAR', dimensions: [{ field: 'traceName' }], metrics: [avgVal],
      filters: NOT_BOOKKEEPING, chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 25 } },

    { name: 'Quality over time', description: 'The trend. A pass rate is nearly meaningless on its own — 70% is good or alarming depending only on last week.',
      view: 'scores-boolean', chartType: 'LINE_TIME_SERIES', dimensions: [], metrics: [avgVal], filters: NOT_BOOKKEEPING },

    { name: 'Assessments by criterion', description: 'How MUCH each rubric ran. A criterion with a great score and three assessments is not evidence of anything.',
      view: 'scores-boolean', chartType: 'HORIZONTAL_BAR', dimensions: [{ field: 'name' }], metrics: [count],
      filters: NOT_BOOKKEEPING, chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 25 } },

    { name: 'Continuous vs on-demand', description: 'EVAL is Langfuse judging by itself; API is a script someone ran. If EVAL is empty, continuous evaluation is not actually on.',
      view: 'scores-boolean', chartType: 'PIE', dimensions: [{ field: 'source' }], metrics: [count],
      filters: NOT_BOOKKEEPING, chartConfig: { type: 'PIE', row_limit: 5 } },

    // Scoped to the human_* configs specifically. Unfiltered, this picks up any
    // categorical score in the project — it was showing a stray label from an
    // old smoke test as though a reviewer had chosen it, which is exactly the
    // wrong thing for the widget whose job is to be the human baseline.
    // Expect it EMPTY until someone actually works the annotation queue; an
    // honest empty is better than a number sourced from somewhere else.
    { name: 'Human review labels', description: 'What reviewers picked in the annotation queue — the baseline the judge is checked against. Empty until someone labels.',
      view: 'scores-categorical', chartType: 'PIE', dimensions: [{ field: 'stringValue' }], metrics: [count],
      filters: [{ column: 'name', operator: 'any of', value: ['human_groundedness', 'human_helpfulness', 'human_verdict'], type: 'stringOptions' }],
      chartConfig: { type: 'PIE', row_limit: 10 } },
  ],
}

const ALL = [
  { key: 'operations', spec: OPERATIONS },
  { key: 'quality',    spec: QUALITY },
]
const selected = only ? ALL.filter((d) => d.key === only) : ALL
if (!selected.length) {
  console.error(`\n✗ unknown --only "${only}". Known: ${ALL.map((d) => d.key).join(', ')}\n`)
  process.exit(1)
}

/** Resolve the project id so the printed link is actually clickable. */
let _pid
async function dashboardUrl(id) {
  if (_pid === undefined) {
    const projects = await api('GET', '/api/public/projects').catch(() => null)
    _pid = projects?.data?.[0]?.id ?? null
  }
  return _pid ? `${LANGFUSE_HOST}/project/${_pid}/dashboards/${id}` : `${LANGFUSE_HOST} → Dashboards`
}

console.log(`\ndashboards → ${LANGFUSE_HOST}\n`)

if (dryRun) {
  for (const { spec } of selected) {
    console.log(`  ${spec.name}  (${spec.widgets.length} widgets)`)
    for (const w of spec.widgets) console.log(`    [dry-run] ${w.chartType.padEnd(18)} ${w.name}`)
    console.log()
  }
  process.exit(0)
}

const existingDash = await api('GET', '/api/public/unstable/dashboards?limit=100').catch(() => null)

for (const { spec } of selected) {
  console.log(`  ── ${spec.name}`)
  const already = (existingDash?.data ?? []).find((d) => d.name === spec.name)
  if (already && !force) {
    console.log(`     already exists (${already.id}) — nothing to do.`)
    console.log(`     ${await dashboardUrl(already.id)}\n`)
    continue
  }

  // Widgets first — a placement needs a widgetId.
  const created = []
  for (const w of spec.widgets) {
    try {
      const res = await api('POST', '/api/public/unstable/dashboard-widgets', {
        name: w.name, description: w.description, view: w.view,
        dimensions: w.dimensions, metrics: w.metrics, filters: w.filters,
        chartType: w.chartType,
        ...(w.chartConfig ? { chartConfig: w.chartConfig } : {}),
      })
      created.push({ ...w, id: res?.id ?? res?.widgetId })
      console.log(`     ✓ ${w.chartType.padEnd(18)} ${w.name}`)
    } catch (e) {
      // Keep going: one rejected widget should not cost you the other seven.
      console.log(`     ✗ ${w.chartType.padEnd(18)} ${w.name}\n         ${e.message.slice(0, 180)}`)
    }
  }
  if (!created.length) { console.log('     ✗ no widgets created — skipping dashboard.\n'); continue }

  const dash = await api('POST', '/api/public/unstable/dashboards', {
    name: spec.name, description: spec.description,
  })
  const dashboardId = dash?.id ?? dash?.dashboardId

  // 12-column grid, two widgets per row; NUMBER tiles get a short one.
  let x = 0, y = 0, placed = 0
  for (const w of created) {
    const width  = w.chartType === 'NUMBER' ? 4 : 6
    const height = w.chartType === 'NUMBER' ? 3 : 6
    if (x + width > 12) { x = 0; y += 6 }
    try {
      await api('POST', `/api/public/unstable/dashboards/${dashboardId}/placements`, {
        type: 'widget', widgetId: w.id, x, y, width, height,
      })
      placed++
    } catch (e) {
      console.log(`     ✗ place ${w.name}: ${e.message.slice(0, 140)}`)
    }
    x += width
  }
  console.log(`     ${placed}/${created.length} widgets placed`)
  console.log(`     ${await dashboardUrl(dashboardId)}\n`)
}

console.log('  Tip: widen the dashboard time range — the default hour is usually narrower than your data.\n')
