/**
 * Langfuse client for the eval harness — the public HTTP API, over plain fetch.
 *
 * Why not the @langfuse/client SDK. The SDK's `runExperiment()` traces the task
 * function *in this process*. Our task function is an HTTP call to a service
 * that produces its own trace (apps/agents traces every LLM call via
 * app/tracing.py). Using the SDK would give us two traces per case — a hollow
 * JS wrapper and the real agent trace — and score the wrong one. What we
 * actually need is to run the product, find the trace IT produced, and attach
 * the dataset run + scores to that. The SDK has no seam for it, and the four
 * endpoints that do are trivial over fetch. No new dependency either, which
 * matters for a suite that gates PRs on forks.
 *
 * Endpoint contracts verified against the running instance's own OpenAPI
 * (GET /generated/api/openapi.yml on a self-hosted server), not the docs:
 *   POST /api/public/v2/datasets        {name*, description, metadata}
 *   POST /api/public/dataset-items      {datasetName*, id, input, expectedOutput, metadata}
 *   POST /api/public/dataset-run-items  {runName*, datasetItemId*, traceId, metadata}
 *   POST /api/public/scores             {name*, value*, traceId, datasetRunId, comment, dataType}
 *   GET  /api/public/traces             ?sessionId=&name=&limit=
 */
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** Read one key out of the repo-root .env — same convention as week-zero/lib/harness.mjs. */
function envValue(key) {
  try {
    const raw = fs.readFileSync(fileURLToPath(new URL('../../../.env', import.meta.url)), 'utf8')
    return raw.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '')
  } catch { return undefined }
}

const cfg = {
  host:      process.env.LANGFUSE_HOST       ?? envValue('LANGFUSE_HOST')       ?? '',
  publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? envValue('LANGFUSE_PUBLIC_KEY') ?? '',
  secretKey: process.env.LANGFUSE_SECRET_KEY ?? envValue('LANGFUSE_SECRET_KEY') ?? '',
}

export const LANGFUSE_HOST = cfg.host

/**
 * All three or nothing — the same fail-closed rule as apps/agents/app/tracing.py.
 * A half-configured harness that "works" against a default cloud host is how
 * contract text ends up somewhere nobody intended.
 */
export function configured() {
  return Boolean(cfg.host && cfg.publicKey && cfg.secretKey)
}

export function requireConfig() {
  if (configured()) return cfg
  const missing = Object.entries({
    LANGFUSE_HOST: cfg.host,
    LANGFUSE_PUBLIC_KEY: cfg.publicKey,
    LANGFUSE_SECRET_KEY: cfg.secretKey,
  }).filter(([, v]) => !v).map(([k]) => k)
  throw new Error(
    `Langfuse is not configured (missing: ${missing.join(', ')}).\n` +
    `  Local:  pnpm langfuse:up, then set the three LANGFUSE_* values in .env\n` +
    `  Cloud:  export them from your Langfuse Cloud project\n` +
    `  See docs/operations/LANGFUSE.md`,
  )
}

const auth = () => 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

async function lf(method, path, body) {
  requireConfig()
  const url = `${cfg.host.replace(/\/$/, '')}${path}`
  let res
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: auth() },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    // A connection error here is nearly always "the stack isn't up" — say that
    // rather than surfacing a bare ECONNREFUSED from deep in a scorer.
    throw new Error(`Langfuse unreachable at ${cfg.host} (${e.message}). Is it running? \`pnpm langfuse:up\``)
  }
  const text = await res.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  if (!res.ok) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
    throw new Error(`Langfuse ${method} ${path} → ${res.status}: ${String(detail).slice(0, 400)}`)
  }
  return parsed
}

export const health = () => lf('GET', '/api/public/health')

/**
 * Create the dataset if absent. Langfuse's v2 datasets POST is already an
 * upsert keyed on name, so this is safe to run on every push.
 */
export async function ensureDataset(name, description, metadata) {
  return lf('POST', '/api/public/v2/datasets', { name, description, metadata })
}

/**
 * Upsert one dataset item. `id` is OURS (from the case file), not generated —
 * that is what makes a re-push idempotent instead of duplicating the corpus on
 * every run, and what lets a case keep its identity (and its score history)
 * across edits.
 */
export async function upsertItem({ datasetName, id, input, expectedOutput, metadata }) {
  return lf('POST', '/api/public/dataset-items', {
    datasetName, id, input, expectedOutput, metadata, status: 'ACTIVE',
  })
}

export async function getDataset(name) {
  return lf('GET', `/api/public/v2/datasets/${encodeURIComponent(name)}`)
}

export async function getDatasetItems(datasetName, limit = 100) {
  const q = new URLSearchParams({ datasetName, limit: String(limit) })
  return lf('GET', `/api/public/dataset-items?${q}`)
}

/**
 * Attach one executed case to a named run. Creating a run item is what creates
 * the run itself — there is no separate "create run" call.
 */
export async function linkRunItem({ runName, runDescription, datasetItemId, traceId, observationId, metadata }) {
  return lf('POST', '/api/public/dataset-run-items', {
    runName, runDescription, datasetItemId, traceId, observationId, metadata,
  })
}

export async function getRun(datasetName, runName) {
  return lf('GET', `/api/public/datasets/${encodeURIComponent(datasetName)}/runs/${encodeURIComponent(runName)}`)
}

/**
 * Post a score.
 *
 * The API takes EXACTLY ONE anchor — traceId (optionally with observationId),
 * sessionId, or datasetRunId. Sending traceId *and* datasetRunId together is a
 * 400, which is easy to write by accident because attaching a score to "the run
 * and the trace" is what you actually mean.
 *
 * Anchor on the trace. A dataset run item points at a trace, and the run view
 * resolves that trace's scores, so a trace-anchored score shows up in both
 * places — the trace timeline AND the run comparison table. A run-anchored
 * score only shows in the run, and is invisible when someone opens the trace
 * to ask why it scored badly, which is exactly when they need it.
 *
 * dataType must match the value: NUMERIC takes a number, BOOLEAN takes 0|1,
 * CATEGORICAL takes a string. A string under NUMERIC is accepted and then
 * renders as an empty column, which reads as "the scorer didn't run".
 */
export async function postScore({ traceId, datasetRunId, sessionId, observationId, name, value, comment, dataType, metadata }) {
  const type = dataType ?? (typeof value === 'string' ? 'CATEGORICAL' : 'NUMERIC')
  const anchor =
    traceId      ? { traceId, observationId } :
    sessionId    ? { sessionId } :
    datasetRunId ? { datasetRunId } : null
  if (!anchor) throw new Error(`postScore("${name}") needs one of traceId, sessionId or datasetRunId`)
  return lf('POST', '/api/public/scores', {
    ...anchor,
    name,
    value: type === 'CATEGORICAL' ? String(value) : Number(value),
    comment, dataType: type, metadata,
  })
}

/**
 * A Langfuse trace id — 32 lowercase hex, the OpenTelemetry trace-id shape that
 * v3+ stores natively. A UUID-with-dashes is accepted by the ingestion endpoint
 * and then does not resolve in the UI.
 */
export function newTraceId() {
  return randomBytes(16).toString('hex')
}

/**
 * Create a trace directly, and return its id.
 *
 * Used as the FALLBACK anchor for a dataset run item. A run item requires a
 * traceId or observationId — the API rejects it otherwise — so without this a
 * case whose product trace we could not find would vanish from the run
 * entirely, and a partial run reads as a smaller, healthier suite than it is.
 * A harness trace keeps the case visible and carries
 * `metadata.traceSource='harness'` so the two are never confused.
 *
 * This is Langfuse's legacy batch endpoint. It is deprecated in favour of the
 * OTel endpoint, but still supported on v3, and hand-rolling OTel protobuf for
 * one flat trace would be a lot of machinery for no gain. The real traces —
 * the ones with prompts, tokens and cost — come from the product via the
 * Python SDK regardless; this only records the harness's own view of a case.
 */
export async function createTrace({ id, name, input, output, sessionId, userId, metadata, tags, timestamp }) {
  const traceId = id ?? newTraceId()
  const ts = timestamp ?? new Date().toISOString()
  await lf('POST', '/api/public/ingestion', {
    batch: [{
      id: randomBytes(16).toString('hex'),   // event id, distinct from the trace id
      type: 'trace-create',
      timestamp: ts,
      body: { id: traceId, timestamp: ts, name, input, output, sessionId, userId, metadata, tags },
    }],
  })
  return traceId
}

export async function listTraces({ sessionId, name, limit = 20 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) })
  if (sessionId) q.set('sessionId', sessionId)
  if (name) q.set('name', name)
  return lf('GET', `/api/public/traces?${q}`)
}

/**
 * Find the trace the product produced for this case, by the session id we
 * passed in.
 *
 * Polling is not optional. Langfuse ingestion is asynchronous by design — the
 * SDK batches, the server writes the event to S3, and a worker folds it into
 * ClickHouse. A trace is routinely not queryable for a second or two after the
 * HTTP call that produced it returned. Reading once and giving up attributes
 * every fast case to "no trace found".
 *
 * Returns null on timeout rather than throwing: a missing trace should degrade
 * the run to unlinked scores, not abort a suite that otherwise has results.
 */
export async function waitForTrace(sessionId, { timeoutMs = 20000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await listTraces({ sessionId, limit: 50 }).catch(() => null)
    const rows = res?.data ?? []
    if (rows.length) {
      // Oldest first: the root turn, not a follow-up observation.
      return rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0]
    }
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** Stable, readable run name: <prefix>-<YYYYMMDD-HHMM>. */
export function runName(prefix = 'local') {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${prefix}-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
}
