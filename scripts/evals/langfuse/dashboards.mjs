#!/usr/bin/env node
/**
 * Create the standing production dashboard in Langfuse.
 *
 *   node scripts/evals/langfuse/dashboards.mjs            # create/refresh
 *   node scripts/evals/langfuse/dashboards.mjs --dry-run
 *
 * `analyze.mjs` answers "how did last night look" on demand. This is the thing
 * you leave open: the same slices, always current, for people who are not going
 * to run a CLI. Both exist because the audiences differ — an engineer chasing a
 * regression wants the script, everyone else wants the page.
 *
 * The widget set is the one teams converge on — cost, latency, usage, errors —
 * with a deliberate bias toward BREAKDOWNS over totals. "Average latency" is
 * a number that hides the one surface at 35s; "p95 by surface" is the number
 * that finds it.
 *
 * Widgets are defined in code so they are reviewable and reproducible across
 * projects. The endpoints are Langfuse's `unstable` API — the shape can change
 * under us, so failures here are reported and skipped rather than thrown: a
 * dashboard is a convenience, and it must not take a review down with it.
 */
import { requireConfig, LANGFUSE_HOST } from './lf.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')
const dryRun = process.argv.includes('--dry-run')

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

const count = { measure: 'count', agg: 'count' }
const cost  = { measure: 'totalCost', agg: 'sum' }

/**
 * Widget views are observation-scoped (the API's enum has no `traces` view), so
 * every breakdown groups by `traceName` — which is our call-site name
 * (`classify.detect`, `assist.rewrite`, `agent.chat`) and therefore reads as
 * "by product surface" exactly as intended.
 */
const WIDGETS = [
  {
    name: 'Spend (total)',
    description: 'Total model spend in the selected window.',
    view: 'observations', chartType: 'NUMBER',
    dimensions: [], metrics: [cost], filters: [],
  },
  {
    name: 'Calls by surface',
    description: 'Where the volume is. Traffic mix across extraction, assistant and chat.',
    view: 'observations', chartType: 'HORIZONTAL_BAR',
    dimensions: [{ field: 'traceName' }], metrics: [count], filters: [],
    chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 },
  },
  {
    name: 'Cost by model',
    description: 'Which model is actually spending the budget.',
    view: 'observations', chartType: 'PIE',
    dimensions: [{ field: 'providedModelName' }], metrics: [cost], filters: [],
    chartConfig: { type: 'PIE', row_limit: 10 },
  },
  {
    name: 'Cost by surface',
    description: 'Spend concentration. Optimise the top bar or nothing.',
    view: 'observations', chartType: 'HORIZONTAL_BAR',
    dimensions: [{ field: 'traceName' }], metrics: [cost], filters: [],
    chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 },
  },
  {
    name: 'p95 latency by surface',
    description: 'p95, not average — the average is what hides the slow surface.',
    view: 'observations', chartType: 'HORIZONTAL_BAR',
    dimensions: [{ field: 'traceName' }],
    metrics: [{ measure: 'latency', agg: 'p95' }], filters: [],
    chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 },
  },
  {
    name: 'Errors by surface',
    description: 'Error-level observations grouped by surface. Empty is the goal.',
    view: 'observations', chartType: 'HORIZONTAL_BAR',
    dimensions: [{ field: 'traceName' }], metrics: [count],
    filters: [{ column: 'level', operator: '=', value: 'ERROR', type: 'string' }],
    chartConfig: { type: 'HORIZONTAL_BAR', row_limit: 20 },
  },
  {
    name: 'Tokens over time',
    description: 'Throughput trend — a step change here usually precedes a cost surprise.',
    view: 'observations', chartType: 'LINE_TIME_SERIES',
    dimensions: [], metrics: [{ measure: 'totalTokens', agg: 'sum' }], filters: [],
  },
  {
    name: 'Cost over time',
    description: 'Spend trend in the window.',
    view: 'observations', chartType: 'LINE_TIME_SERIES',
    dimensions: [], metrics: [cost], filters: [],
  },
]

const DASHBOARD_NAME = 'draftLegal — LLM production review'

console.log(`\ndashboards → ${LANGFUSE_HOST}`)
console.log(`  "${DASHBOARD_NAME}" · ${WIDGETS.length} widgets\n`)

if (dryRun) {
  for (const w of WIDGETS) console.log(`  [dry-run] ${w.chartType.padEnd(18)} ${w.name}`)
  console.log()
  process.exit(0)
}

// Neither widgets nor dashboards are keyed on name, so a second run would
// silently create a second identical dashboard and eight more orphan widgets.
// Check first — "run it again" is the most likely next thing anyone does.
const force = process.argv.includes('--force')
const existing = await api('GET', '/api/public/unstable/dashboards?limit=100').catch(() => null)
const already = (existing?.data ?? []).find((d) => d.name === DASHBOARD_NAME)
if (already && !force) {
  console.log(`  already exists (${already.id}) — nothing to do.`)
  console.log(`  --force creates a second copy; edit widgets in the UI, or delete it there first.\n`)
  console.log(`  open: ${await dashboardUrl(already.id)}\n`)
  process.exit(0)
}

/** Resolve the project id so the printed link is actually clickable. */
async function dashboardUrl(id) {
  const projects = await api('GET', '/api/public/projects').catch(() => null)
  const pid = projects?.data?.[0]?.id
  return pid ? `${LANGFUSE_HOST}/project/${pid}/dashboards/${id}` : `${LANGFUSE_HOST} → Dashboards`
}

// Widgets first — a placement needs a widgetId.
const created = []
for (const w of WIDGETS) {
  try {
    const res = await api('POST', '/api/public/unstable/dashboard-widgets', {
      name: w.name,
      description: w.description,
      view: w.view,
      dimensions: w.dimensions,
      metrics: w.metrics,
      filters: w.filters,
      chartType: w.chartType,
      ...(w.chartConfig ? { chartConfig: w.chartConfig } : {}),
    })
    const id = res?.id ?? res?.widgetId
    created.push({ ...w, id })
    console.log(`  ✓ ${w.chartType.padEnd(18)} ${w.name}`)
  } catch (e) {
    // Keep going: one rejected widget should not cost you the other seven.
    console.log(`  ✗ ${w.chartType.padEnd(18)} ${w.name}\n      ${e.message.slice(0, 200)}`)
  }
}

if (!created.length) {
  console.error('\n✗ no widgets were created — nothing to place.\n')
  process.exit(1)
}

const dash = await api('POST', '/api/public/unstable/dashboards', {
  name: DASHBOARD_NAME,
  description: 'Volume, cost, latency and errors across every LLM surface. Created by scripts/evals/langfuse/dashboards.mjs.',
})
const dashboardId = dash?.id ?? dash?.dashboardId
console.log(`\n  dashboard ${dashboardId}`)

// 12-column grid, two widgets per row; the NUMBER tile gets a short one.
let x = 0, y = 0
let placed = 0
for (const w of created) {
  const width = w.chartType === 'NUMBER' ? 4 : 6
  const height = w.chartType === 'NUMBER' ? 3 : 6
  if (x + width > 12) { x = 0; y += 6 }
  try {
    await api('POST', `/api/public/unstable/dashboards/${dashboardId}/placements`, {
      type: 'widget', widgetId: w.id, x, y, width, height,
    })
    placed++
  } catch (e) {
    console.log(`  ✗ place ${w.name}: ${e.message.slice(0, 160)}`)
  }
  x += width
}

console.log(`  ${placed}/${created.length} widgets placed`)
console.log(`\n  open: ${await dashboardUrl(dashboardId)}\n`)
